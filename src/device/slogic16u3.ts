// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * WebUSB transport for the Sipeed SLogic16 U3.
 *
 * Start/stop sequencing follows the libsigrok driver, with one deliberate
 * difference: this transport does not write CTRL.RST. The driver opens with a
 * reset pulse (api.c:1229, called from dev_open), but RST resets the module and
 * every register programmed after it, and the state that makes a freshly
 * replugged 32U3 answer nothing on the bulk endpoint is that very bit left set.
 * Every CTRL write here is verified read -> write -> read instead (NOTES 8.13).
 *
 *   open:  CTRL=stop, verified                  (driver: CTRL=reset, CTRL=de-reset)
 *   start: CTRL=stop, verified                  (protocol.c:478)
 *          aux 0x05 test mode                   (api.c:1174, driver only on request)
 *          aux 0x01 channel mask                (api.c:1248)
 *          aux 0x02 samplerate                  (api.c:1297)
 *          aux 0x03 vref                        (api.c:1389)
 *          CTRL=run, verified                   (api.c:1491)
 *   stop:  CTRL=stop                            (api.c:1497)
 */

import type { CaptureConfig, CaptureStartOptions, Device, DropoutSink, SampleSink } from './types.js';
import { SoftwareTrigger } from '../data/softwareTrigger.js';
type SoftwareTriggerState = 'waiting' | 'triggered' | 'not-found';
import { bytesPerSampleForChannels } from '../types.js';
import {
  AuxTransaction,
  CTRL_RUN,
  CTRL_STOP,
  EP_IN,
  MAX_SAMPLERATE_HZ,
  MAX_SAMPLERATE_HZ_SLOGIC32_U3,
  PID_SLOGIC16_U3,
  PID_SLOGIC32_U3,
  RegisterBus,
  SAMPLERATES_HZ,
  SUPPORTED_CHANNELS,
  TEST_MODE_EMULATION,
  TEST_MODE_NORMAL,
  TEST_MODE_USB_MAX_SPEED,
  USB_VID_SIPEED,
  configureChannels,
  configureSamplerate,
  configureTestMode,
  configureThreshold,
  clearFifoOverflow,
  describeDeviceFlags,
  readDeviceFlags,
  readSampleLength,
  programCtrl,
  sampleLengthForSamples,
  samplesForSampleLength,
  writeSampleLength,
  type TraceEntry,
  withControlTimeout,
} from './protocol.js';

export const USB_FILTERS: USBDeviceFilter[] = [
  { vendorId: USB_VID_SIPEED, productId: PID_SLOGIC16_U3 },
  { vendorId: USB_VID_SIPEED, productId: PID_SLOGIC32_U3 },
];

/** Bytes of junk at the head of every acquisition (protocol.c:117). */
const HEAD_DROP_BYTES = 4;

/** SuperSpeed bulk max packet size; transfer lengths stay a multiple of this. */
const PACKET_BYTES = 1024;

/** Chromium accepts this per call, but Linux's usbfs budget applies to all queued URBs. */
const MAX_WEBUSB_TRANSFER_BYTES = 32 * 1024 * 1024;
/** Value selected by libsigrok's allocation probe with the usual 16 MiB usbfs budget. */
const LIBSIGROK_TRANSFER_BYTES = 3_129_344;
/** Five such transfers consume 14.92 MiB and are the maximum the native probe submits. */
const LIBSIGROK_TRANSFER_DEPTH = 5;
const MAX_SAFE_QUEUED_BYTES = LIBSIGROK_TRANSFER_BYTES * LIBSIGROK_TRANSFER_DEPTH;

/**
 * The read size the browser's own bulk IN path stops keeping up at, and why it is not the
 * size libsigrok uses. Measured against the device's raw upload (`bench ... usbmax`), with
 * the queued bytes held at 12 MiB so the read size is the only variable (NOTES 8.26):
 *
 *   768 KiB x 16   1,599,602,688 B in 1649 ms = 970 MB/s, 2034 transfers, 0 short, 0 slow
 *   956 KiB x 13     199,704,576 B in  217 ms = 921 MB/s,  204 calls,   0 short, 0 slow
 *   1 MiB   x 12     aborted: 477-533 MB/s, "overran the host" (the app's own watchdog)
 *   3,129,344 B x 5  aborted: 396-530 MB/s, the geometry libsigrok trains on
 *
 * The step is exactly at 1 MiB, and both sides of it are page multiples, so it is a
 * per-allocation threshold in Chromium (the device service's buffer for the transfer, the
 * shared memory `mojo_base::BigBuffer` copies it into above its 64 KiB inline limit, and
 * the `DOMArrayBuffer` the renderer copies it into again) rather than anything the device
 * or the link does. libsigrok has none of that: it hands libusb a buffer it allocated once
 * and resubmits the same transfer, which is why it reaches 800 MB/s with the same reads.
 */
const FAST_READ_BYTES = 768 * 1024;
/** 16 x 786,432 B is 12 MiB, inside the 14.92 MiB the usbfs budget allows. */
const FAST_READ_DEPTH = 16;
/**
 * Above this line rate the large reads demonstrably stop sustaining the pipe (they were
 * measured at 396-530 MB/s against an 800 MB/s producer), so a capture that asks for more
 * than this is tuned for the host instead of for libsigrok. Below it the large reads are
 * what the native driver trained on, they sustain the rate, and they keep the number of
 * chunks the renderer and the store see four times lower.
 */
const LARGE_READ_CEILING_BYTES_PER_SEC = 500e6;

/**
 * Bytes per chunk handed to the sink, whatever the USB read size is.
 *
 * The two sides of this transport want opposite things from a chunk. The host's bulk IN path
 * wants reads under 1 MiB (FAST_READ_BYTES above), and the consumer wants as few chunks as
 * possible: the interleaved sample store costs about 1.2 ms *per append* no matter how small
 * the append is, plus 0.31 us/KiB of actual work (measured on this machine, 32 channels,
 * 2026-09-11), so 768 KiB device reads would arrive 1,017 times a second and cost the store
 * 1.5 s of work per second of data. Coalescing here is what lets both be satisfied - the
 * same split libsigrok has, where the libusb callback reaps a URB into a buffer and the
 * session thread hands the application larger blocks.
 *
 * 8 MiB is 10 ms of data at 32ch/200M: 100 flushes a second, 0.12 s of the store's per
 * append cost per second of data instead of 1.5 s, and a first-chunk delay the live view
 * cannot see. The copy happens on this thread, which is the worker's for the shipping
 * transport and the page's only for the fallback.
 */
const SINK_CHUNK_BYTES = 8 * 1024 * 1024;

/** How long stop() waits for in-flight transfers before forcing a USB reset. */
const STOP_TIMEOUT_MS = 1500;
/**
 * Extra time a `bench` gives the device to finish the length it was programmed with
 * before `stop()` runs. The bench must never be the host that cuts a producing device off.
 */
const BENCH_DRAIN_MS = 400;

/**
 * A capture that has not received a single byte this long after RUN is looking at a
 * board that will never send any: it is the state NOTES 8.8 calls W1, where every
 * control transfer still answers and the sampler delivers nothing. The first
 * transfer of a capture takes one requested-length of device time, so the deadline
 * is that, with a generous multiple plus a fixed floor. Without it the page sits on
 * a capture of zero samples and reports success.
 */
const NO_DATA_DEADLINE_FACTOR = 10;
const NO_DATA_DEADLINE_FLOOR_MS = 500;

/**
 * The driver's transfer tolerance (protocol.c:36, TRANSFERS_DURATION_TOLERANCE): one
 * URB may take 1.3x what the device needs, and run at 0.7x the expected rate, before
 * it counts as slow.
 */
const SLOW_TRANSFER_TOLERANCE = 0.3;
/** The driver's whole-run floor: `average_rate < expected_rate * 0.95` (protocol.c:155). */
const SLOW_AVERAGE_HEADROOM = 0.95;

/**
 * Scheduling allowance for one transfer, ms.
 *
 * The driver judges a URB on wall-clock time because libusb hands it a completed URB and
 * nothing else. This page adds a promise hop, an IPC round trip and a re-arm to every
 * completion, so a bare "took longer than the device needs" test also fires on a healthy
 * stream whenever one transfer's device time is smaller than that overhead: a 1 KiB lane
 * at 16ch/16 MHz is 0.03 ms of device time per transfer, and the completion path alone
 * measured 0.04 ms, which the rate comparison read as a 19% shortfall for `depth`
 * completions in a row and aborted a capture that was never behind.
 *
 * 0.25 ms is several times the observed per-completion overhead and 6% of one 3.1 MB
 * transfer at 32ch/200 MHz, so it removes the false positive without weakening the abort
 * where it matters: that configuration has to be aborted when the browser sustains
 * ~500 MB/s instead of 800, and the allowance only covers ~3% of that gap.
 */
const WATCHDOG_NOISE_ALLOWANCE_MS = 0.25;

/**
 * The same allowance when it is summed over a whole run, ms per transfer.
 *
 * Much smaller, because the two tests use it differently. On a single transfer the
 * allowance covers jitter, which can be a whole scheduling quantum. Over a run the
 * jitter cancels and what is left is the completion path's systematic cost, which is
 * bounded by a fraction of a millisecond per completion. Charging 0.25 ms per transfer
 * to the run average would swamp the driver's own 5% floor everywhere it is exercisable
 * offline: at 4ch/5 MHz a 1 KiB transfer is 0.41 ms of device time, so a quarter
 * millisecond per transfer is a 61% allowance and the abort never fires.
 */
const WATCHDOG_RATE_ALLOWANCE_MS = 0.05;

/** How many timing samples getStats() reports percentiles from. */
const TIMING_SAMPLES = 1024;

/**
 * Period of the event-loop stall probe.
 *
 * Chrome clamps nested timers to ~4 ms, which is exactly the resolution needed here:
 * the question is whether the thread was blocked for a good fraction of the 19.6 ms a
 * 32ch/200M host has before the device FIFO overruns.
 */
const THREAD_PROBE_MS = 4;
/** A stall this long is reported; below it the probe is measuring scheduler noise. */
const THREAD_STALL_THRESHOLD_MS = 8;

/**
 * Watch for the JS thread being blocked, from inside the capture.
 *
 * libsigrok never has this problem to measure: it reaps and resubmits URBs on the libusb
 * event thread (protocol.c:325), whose only job is to run that callback. In the page the
 * same callback shares a thread with the store append, the WebGL draw and the garbage
 * collector, so a stall is both invisible (transfers simply arrive late, or not at all)
 * and the most likely reason a capture that is fast enough on average still trips the
 * device's FIFO.
 */
export class LoopStallWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  count = 0;
  maxMs = 0;
  maxAtMs = 0;
  readonly samples: number[] = [];
  /** Called for every stall over the threshold, with its offset from start(). */
  onStall: ((ms: number, atMs: number) => void) | null = null;

  start(): void {
    this.stop();
    this.lastTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const stall = now - this.lastTick - THREAD_PROBE_MS;
      this.lastTick = now;
      if (stall < THREAD_STALL_THRESHOLD_MS) return;
      this.count += 1;
      this.samples.push(stall);
      if (stall > this.maxMs) {
        this.maxMs = stall;
        this.maxAtMs = now;
      }
      this.onStall?.(stall, now);
    }, THREAD_PROBE_MS);
    // The probe measures a capture; it is not a reason for one to exist. Node's offline
    // suite drives this transport without ever stopping some of its scripted captures, and
    // a browser-only timer id has no `unref` to call, so this is a no-op everywhere else.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export interface StreamTuning {
  /** Outstanding transferIn calls. Fewer than ~4 and the device overruns. */
  depth: number;
  /** Bytes per transferIn. 0 = derive from the sample rate. */
  transferBytes: number;
  /**
   * Completed transfers the consumer may fall behind by before the loop stops
   * replenishing the USB queue, **when the capture has no length of its own**.
   *
   * A capture that knows its length (timer mode - `StartOptions.deviceSampleLimit`, which
   * arms the device's own stop) bounds the queue with that length instead, exactly as the
   * driver does (protocol.c:395), and this value is ignored: the device must never be left
   * without queued reads because the consumer is late (NOTES 8.27). Software-trigger mode,
   * where the trigger position and so the capture's length are not known before RUN, has
   * nothing else to bound the memory with and keeps this cap.
   *
   * The bound is per-transfer, not per-byte: 16 chunks is 50 MB at the 3,129,344 B
   * geometry, i.e. ~125 ms of 32ch/100M. Past it the device FIFO is on its own, which is
   * the same cliff a host that never drained it would fall off, so the loop records why it
   * stopped refilling in the trace rather than letting that look like a slow device.
   */
  lagChunks?: number;
  /**
   * Total bytes of submitted URBs this host will actually accept. Linux charges every
   * submitted URB against `usbfs_memory_mb` (16 MiB unless raised) and Chromium reports
   * the kernel's refusal as a NetworkError that poisons the queue, so the transport
   * refuses a geometry above this instead of discovering it at run time. libsigrok finds
   * the same number by submitting until it fails and halving (protocol.c:249); the
   * default here is what it settles on for the usual 16 MiB budget.
   *
   * Raise it *and* `usbfs_memory_mb` together: with a bigger budget the driver gets to
   * use fewer, larger transfers, which is the one lever that changes how much work the
   * host does per byte.
   */
  queueBudgetBytes?: number;
  /**
   * Bytes of device reads to accumulate before calling the sink, or undefined to hand the
   * sink every read as it lands. The two ends of this transport want opposite chunk sizes:
   * the host's bulk IN path wants reads under 1 MiB, and the interleaved sample store costs
   * ~1.2 ms per `append` whatever its size plus 0.31 us/KiB, so a small-read capture would
   * ask the store to do 1.5 s of work per second of data. `deriveStreamTuning` sets this
   * exactly when it is the one choosing small reads for a high line rate, so a capture on
   * libsigrok's own geometry - and every explicit tuning, which is what the console and the
   * offline suite use - keeps delivering each read as it lands.
   */
  coalesceBytes?: number;
}

export interface Stats {
  /** Bytes accepted from the endpoint, before the head drop. */
  rawBytes: number;
  /** Bytes handed to the sink, after head drop and expansion. */
  sinkBytes: number;
  transfers: number;
  /** Successful WebUSB requests whose actual length was below the requested length. */
  shortTransfers: number;
  /** Largest number of completed USB blocks waiting for the data consumer. */
  peakQueuedTransfers: number;
  firstByteMs: number | null;
  elapsedMs: number;
  /** Wire rate including start-up latency, MB/s (10^6 bytes/s). */
  rawMBps: number;
  /** Wire rate measured from the first byte on, which is the honest one. */
  steadyMBps: number;
  /** Wire rate this configuration should produce, MB/s. */
  expectedMBps: number;
  /** steadyMBps / expectedMBps; 1 means the host kept up with the device. */
  rateRatio: number;
  /** libsigrok's consecutive slow-transfer counter (protocol.c:151). */
  slowTransfers: number;
  /** Consecutive slow transfers that abort the capture, as in the driver. */
  slowTransferLimit: number;
  /** Longest stretch with no transferIn outstanding, ms. 0 = never starved. */
  maxIdleGapMs: number;
  /** Completion-to-completion time per transfer, ms. */
  transferMsP50: number;
  transferMsP95: number;
  transferMsMax: number;
  /** Completion callback to the replacement transferIn being issued, ms. */
  rearmMsP50: number;
  rearmMsP95: number;
  /** Time spent inside the synchronous sink per transfer, ms. */
  sinkMsP50: number;
  sinkMsP95: number;
  /**
   * Longest stretch this JS thread spent unable to run a 4 ms timer, ms.
   *
   * The transport re-arms a completed transferIn from a promise reaction, so every
   * millisecond the thread is blocked is a millisecond no replacement URB is queued -
   * and the device's FIFO only covers `depth x transfer duration`. Without this number
   * a capture that starved the device cannot be told apart from one whose device was
   * slow, which is the difference between fixing the page and blaming the board.
   */
  threadStallMaxMs: number;
  /** Stalls over THREAD_STALL_THRESHOLD_MS, counted per acquisition. */
  threadStalls: number;
}

export interface StartOptions extends CaptureStartOptions {
  /**
   * What to call the thread this loop runs on in diagnostics. The same loop runs on
   * the page and in the USB worker, and "the page thread was blocked" means opposite
   * things in the two cases: on the page it is the reason a capture starves, in the
   * worker it is the page being busy while the device keeps producing.
   */
  threadLabel?: string;
  /** Built-in pattern generator: 0 normal, 1 USB speed test, 2 emulation. */
  testMode?: number;
  tuning?: Partial<StreamTuning>;
  /**
   * Measure the bulk pipe instead of capturing: every transfer is counted and then
   * dropped without touching the sink. This is the only way to tell a WebUSB ceiling
   * from the cost of everything downstream of it on the same thread.
   */
  discard?: boolean;
  /**
   * Samples the device should deliver before it stops itself (aux 0x04,
   * R32_SAMPLE_LEN). This is the only way to end a capture without ever stopping
   * the reader while the device is still producing, which is what overruns the
   * FIFO and wedges the board until it is unplugged (NOTES 8.2 and 8.9).
   *
   * Counted in samples delivered to the sink, so the head bytes this transport
   * discards are added here. Omit it - or pass 0 - for no limit, which is the
   * only correct choice when the capture length is not known before RUN, as in
   * software-trigger mode.
   */
  deviceSampleLimit?: number;
}

function assertValidConfig(
  cfg: CaptureConfig, maxSamplerateHz: Readonly<Record<number, number>>, maxChannels: number,
): void {
  if (!(SUPPORTED_CHANNELS as readonly number[]).includes(cfg.channels) || cfg.channels > maxChannels) {
    throw new Error(
      `unsupported channel count ${cfg.channels}; this device offers ` +
        SUPPORTED_CHANNELS.filter((n) => n <= maxChannels).join(', '),
    );
  }
  if (!SAMPLERATES_HZ.includes(cfg.samplerate)) {
    throw new Error(
      `unsupported samplerate ${cfg.samplerate} Hz; the device offers ` +
        SAMPLERATES_HZ.map((r) => `${r / 1e6}M`).join(', '),
    );
  }
  const ceiling = maxSamplerateHz[cfg.channels];
  if (cfg.samplerate > ceiling) {
    throw new Error(
      `${cfg.samplerate / 1e6} MHz exceeds the ${cfg.channels}-channel ceiling of ${ceiling / 1e6} MHz`,
    );
  }
  if (!Number.isFinite(cfg.thresholdVolts)) {
    throw new Error(`threshold must be a number, got ${cfg.thresholdVolts}`);
  }
  if (cfg.testMode !== undefined && cfg.testMode !== TEST_MODE_NORMAL &&
      cfg.testMode !== TEST_MODE_USB_MAX_SPEED && cfg.testMode !== TEST_MODE_EMULATION) {
    throw new Error(`test mode must be 0, 1 or 2, got ${cfg.testMode}`);
  }
}

/**
 * Expand sub-8-channel packing (api.c:880). With nCh channels a wire byte holds
 * 8/nCh samples, sample k in bits [k*nCh, k*nCh + nCh). At 8 and 16 channels
 * the wire format is already what the contract asks for.
 */
export function expandPacked(src: Uint8Array, channels: number): Uint8Array {
  if (channels >= 8) return src;
  const per = 8 / channels;
  const mask = (1 << channels) - 1;
  const out = new Uint8Array(src.length * per);
  let o = 0;
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    for (let k = 0; k < per; k++) out[o++] = (b >> (k * channels)) & mask;
  }
  return out;
}

export function deriveStreamTuning(cfg: CaptureConfig, want: Partial<StreamTuning> = {}): StreamTuning {
  const lineRate = (cfg.samplerate * cfg.channels) / 8;
  const fastReads = lineRate > LARGE_READ_CEILING_BYTES_PER_SEC;
  const transferBytes =
    want.transferBytes && want.transferBytes > 0
      ? want.transferBytes
      : fastReads
        ? FAST_READ_BYTES
        : LIBSIGROK_TRANSFER_BYTES;
  // This is deliberately the result of the native driver's real allocation probe,
  // not its much larger initial request. Linux commonly limits usbfs to 16 MiB per
  // process; exceeding that budget makes Chromium report every transfer as NetworkError.
  const depth = want.depth && want.depth > 0
    ? want.depth
    : fastReads
      ? FAST_READ_DEPTH
      : LIBSIGROK_TRANSFER_DEPTH;
  if (transferBytes % PACKET_BYTES !== 0) {
    throw new Error(
      `transferBytes ${transferBytes} is not a multiple of the ${PACKET_BYTES}-byte packet size`,
    );
  }
  if (depth < 4) {
    throw new Error(`transfer depth ${depth} is below the 4 the device needs to not overrun`);
  }
  if (transferBytes > MAX_WEBUSB_TRANSFER_BYTES) {
    throw new Error(
      `transferBytes ${transferBytes} exceeds Chromium WebUSB's ${MAX_WEBUSB_TRANSFER_BYTES}-byte limit`,
    );
  }
  const queuedBytes = transferBytes * depth;
  const budget = want.queueBudgetBytes && want.queueBudgetBytes > 0
    ? want.queueBudgetBytes
    : MAX_SAFE_QUEUED_BYTES;
  if (!Number.isSafeInteger(queuedBytes) || queuedBytes > budget) {
    throw new Error(
      `transfer queue ${depth} x ${transferBytes} B exceeds the safe ` +
        `${budget}-byte usbfs budget; raise usbfs_memory_mb and queueBudgetBytes together`,
    );
  }
  // Four `depth`s of unconsumed chunks: enough that a page doing real work between two
  // transfers never trips it, small enough that the pile stays well under the store it
  // is feeding.
  const lagChunks = want.lagChunks && want.lagChunks > 0 ? want.lagChunks : depth * 4;
  // Coalescing belongs to the small-read geometry the transport chose for itself: an
  // explicit tuning is a measurement or a test and gets its reads delivered one for one.
  const coalesceBytes: number | undefined = want.coalesceBytes && want.coalesceBytes > 0
    ? want.coalesceBytes
    : fastReads
      ? SINK_CHUNK_BYTES
      : undefined;
  return {
    depth, transferBytes, lagChunks,
    ...(coalesceBytes === undefined ? {} : { coalesceBytes }),
  };
}

interface CompletedTransfer {
  sequence: number;
  completedAt: number;
  result?: USBInTransferResult;
  error?: unknown;
}

export class Slogic16U3 implements Device {
  readonly name: string;
  readonly serial: string;
  readonly maxChannels: number;
  readonly maxSamplerateHz: Readonly<Record<number, number>>;

  /**
   * Fatal errors from the background read loop land here. They are also
   * reported through onError and console.error - nothing is swallowed.
   */
  onError: ((e: unknown) => void) | null = null;
  onTrace: ((e: TraceEntry) => void) | null = null;

  private bus: RegisterBus | null = null;
  private running = false;
  private stopping = false;
  private loopDone: Promise<void> | null = null;
  private loopError: unknown = null;
  /**
   * When the read loop last completed a transfer. stop() waits for a drain that is
   * still making progress and gives up only on one that has stalled (STOP_TIMEOUT_MS).
   */
  private lastCompletionAt = 0;
  /** When the current stop() began, so a silent queue still has a deadline. */
  private stoppingSince = 0;
  private cfg: CaptureConfig | null = null;
  private tuning: StreamTuning | null = null;
  private headRemaining = HEAD_DROP_BYTES;
  private sink: SampleSink | null = null;
  /** Samples handed to the sink since start(), for dropout positions. */
  private samplesDelivered = 0;
  /** Coalescing block for sink delivery; see SINK_CHUNK_BYTES. */
  private sinkBuffer = new Uint8Array(0);
  private sinkFill = 0;
  private stats: Stats = Slogic16U3.zeroStats();
  private trigger: SoftwareTrigger | null = null;
  private triggerState: ((
    state: SoftwareTriggerState | 'waiting', triggerSampleIndex?: number,
  ) => void) | null = null;
  private triggerMatched = false;
  private triggerNotFound = false;
  /** Reported once when the capture delivered everything it was ever going to. */
  private onCaptureEnd: (() => void) | null = null;
  private captureEnded = false;
  private sampleCarry = new Uint8Array(0);
  /** Set by StartOptions.discard: count bytes, never hand them to a sink. */
  private discard = false;
  /** Wire bytes the configured rate should deliver per millisecond. */
  private expectedBytesPerMs = 0;
  /** Set when the host fell behind for `depth` consecutive transfers. */
  private underrun: Error | null = null;
  private readonly transferMs = new Ring(TIMING_SAMPLES);
  /**
   * True while R32_SAMPLE_LEN holds a limit *this* object programmed, so a later
   * capture without one knows it has to clear the register instead of inheriting
   * a truncated stream. Firmware that never takes the register stays untouched.
   */
  private sampleLimitArmed = false;
  /**
   * Device samples the armed limit allows, including the head this transport drops.
   * Zero when no limit was programmed, which is also the case a stop() cannot use to
   * tell a finished capture from a stalled one.
   */
  private armedDeviceSamples = 0;
  /** Set after the first refusal, so an unsupported firmware is asked once. */
  private sampleLimitUnavailable = false;
  /** Fires if a capture never receives its first byte (a wedged board). */
  private noDataTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reports how long this thread was blocked for, per acquisition. */
  private readonly loopStalls = new LoopStallWatch();
  /** Thread name used in diagnostics; the worker overrides it through StartOptions. */
  private threadLabel = 'page';
  private noDataDeadlineMs = 0;
  private readonly rearmMs = new Ring(TIMING_SAMPLES);
  private readonly sinkMs = new Ring(TIMING_SAMPLES);

  /**
   * NOTE: this is whatever the browser chose to report, and Brave randomises
   * USBDevice.serialNumber per origin as an anti-fingerprinting measure - a
   * real run on S/N 202512261505 reported "PyZzCBfPPm6lSw3j". Treat it as an
   * opaque handle for this page session only. It is NOT a unit identifier and
   * nothing about provenance may be claimed from it. libusb-based tools see
   * the real serial; WebUSB does not.
   */
  readonly serialIsBrowserSupplied = true;

  constructor(private readonly usb: USBDevice) {
    const is32 = usb.productId === PID_SLOGIC32_U3;
    this.maxChannels = is32 ? 32 : 16;
    this.maxSamplerateHz = is32 ? MAX_SAMPLERATE_HZ_SLOGIC32_U3 : MAX_SAMPLERATE_HZ;
    this.name = usb.productName ?? (is32 ? 'SLogic32 U3' : 'SLogic16 U3');
    this.serial = usb.serialNumber ?? '';
  }

  private static zeroStats(): Stats {
    return {
      rawBytes: 0,
      sinkBytes: 0,
      transfers: 0,
      shortTransfers: 0,
      peakQueuedTransfers: 0,
      firstByteMs: null,
      elapsedMs: 0,
      rawMBps: 0,
      steadyMBps: 0,
      expectedMBps: 0,
      rateRatio: 0,
      slowTransfers: 0,
      slowTransferLimit: 0,
      maxIdleGapMs: 0,
      transferMsP50: 0,
      transferMsP95: 0,
      transferMsMax: 0,
      rearmMsP50: 0,
      rearmMsP95: 0,
      sinkMsP50: 0,
      sinkMsP95: 0,
      threadStallMaxMs: 0,
      threadStalls: 0,
    };
  }

  getStats(): Stats {
    const expectedMBps = this.expectedBytesPerMs;
    return {
      ...this.stats,
      // expectedBytesPerMs is bytes per millisecond; MB/s is that over 1000.
      expectedMBps: expectedMBps / 1000,
      rateRatio: expectedMBps > 0 ? this.stats.steadyMBps / (expectedMBps / 1000) : 0,
      transferMsP50: this.transferMs.percentile(0.5),
      transferMsP95: this.transferMs.percentile(0.95),
      rearmMsP50: this.rearmMs.percentile(0.5),
      rearmMsP95: this.rearmMs.percentile(0.95),
      sinkMsP50: this.sinkMs.percentile(0.5),
      sinkMsP95: this.sinkMs.percentile(0.95),
    };
  }

  private trace(e: TraceEntry): void {
    this.onTrace?.(e);
  }

  /**
   * Write CTRL_STOP and report rather than throw: every caller is already in
   * teardown, and a device that will not answer is a device the caller still has to
   * release.
   *
   * This is the one CTRL write that does not go through programCtrl(), on purpose:
   * verification costs two more control transfers, and a teardown path that is racing
   * the watchdog is the wrong place to add them. The next start() and open() verify CTRL
   * before anything is armed, which is where a stop that did not land matters.
   */
  private async stopProducer(where: string): Promise<void> {
    try {
      if (this.bus) await this.bus.writeCtrl(CTRL_STOP);
    } catch (e) {
      console.warn(`[slogic] CTRL stop during ${where}:`, e);
    }
  }

  /** When a drain that is still delivering transfers would be considered stalled. */
  private queuedDrainDeadlineMs(): number {
    return Math.max(this.lastCompletionAt, this.stoppingSince) + STOP_TIMEOUT_MS;
  }

  /** Wire bytes per device sample: below 8 channels the firmware packs 8/channels
   * samples into one byte, so this is fractional (0.5 at 4 channels). */
  private wireBytesPerSample(channels: number): number {
    return channels < 8 ? channels / 8 : bytesPerSampleForChannels(channels);
  }

  /** Device samples this transport has received since RUN, the dropped head included. */
  private receivedDeviceSamples(): number {
    // The head is dropped inside deliver(), which the discard path never reaches, so
    // count it back either way and compare in the device's own units. The head bytes
    // are *wire* bytes: at 4 channels the 4 dropped bytes are 8 device samples, and
    // dividing by the stored bytes-per-sample here would leave this counter short of
    // the armed limit forever - no flush, no onEnd, and stop() misses the
    // self-stopped fast path.
    const wire = this.wireBytesPerSample(this.cfg?.channels ?? 32);
    const headReceived = this.discard ? HEAD_DROP_BYTES : HEAD_DROP_BYTES - this.headRemaining;
    return this.samplesDelivered + headReceived / wire;
  }

  /**
   * True when the device has delivered everything its own length limit allowed.
   *
   * The reads still queued at that point are tail reads the device answers with NAKs
   * (NOTES 8.9) - they never complete and never carry a byte, so waiting STOP_TIMEOUT_MS
   * for them only delays the next capture, and every bench would pay it. Measured on
   * hardware: the count the device stops at lands here as a byte count that is only
   * ever reached after the last data-carrying transfer has been consumed, which is what
   * makes this safe to trust with a capture's tail.
   */
  private deviceReachedItsLimit(): boolean {
    return this.armedDeviceSamples > 0 && this.receivedDeviceSamples() >= this.armedDeviceSamples;
  }

  /**
   * Read the status register before a capture, clear a FIFO overflow an earlier
   * acquisition latched, and trace what the register says either way.
   *
   * R32_FLAG is the one piece of device state neither this transport nor libsigrok
   * ever touched: RB_FLAG_FIFO_OV is a write-1-to-clear event latch whose reset value
   * is "NA", and the driver does not even read the register. Hardware does confirm
   * that CTRL.RST clears the bit (NOTES 8.4), but this transport no longer writes RST
   * (NOTES 8.13), so the write-1-to-clear below is the only thing that clears the
   * latch: one write, only when the bit is actually set, which no healthy board ever
   * receives (there is a negative-control test for that).
   *
   * The read is diagnostic and never fatal: a device that does not answer 0x08 is left
   * exactly as it was before, because refusing to capture is worse than capturing
   * without a status report.
   */
  private async settleFifoOverflow(bus: RegisterBus, where: string): Promise<void> {
    const flags = await readDeviceFlags(bus, (e) => this.trace(e)).catch((e: unknown) => {
      this.trace({ dir: 'info', note: `${where}: R32_FLAG unreadable (${String(e)})` });
      return null;
    });
    if (!flags?.fifoOverflow) return;

    const before = describeDeviceFlags(flags);
    const after = await clearFifoOverflow(bus, (e) => this.trace(e));
    this.trace({
      dir: 'info',
      note: after.fifoOverflow
        ? `${where}: FIFO overflow still latched after clear (${before} -> ${describeDeviceFlags(after)})`
        : `${where}: cleared a FIFO overflow latched by an earlier run (${before} -> ${describeDeviceFlags(after)})`,
    });
  }

  /** Device samples inside the HEAD_DROP_BYTES the transport throws away. */
  private headDropSamples(channels: number): number {
    // Below 8 channels the firmware packs two samples per wire byte and
    // expandPacked splits them; at 8 and above one sample is ceil(channels/8)
    // bytes, so the four dropped bytes are one sample at 32 channels.
    const wireBytesPerSample = channels < 8 ? 0.5 : bytesPerSampleForChannels(channels);
    return Math.ceil(HEAD_DROP_BYTES / wireBytesPerSample);
  }

  /** Cancel the no-data deadline, if one is armed. */
  private clearNoDataWatchdog(): void {
    if (this.noDataTimer !== null) {
      clearTimeout(this.noDataTimer);
      this.noDataTimer = null;
    }
  }

  /**
   * Run the stall probe for the length of one acquisition. A stall shows up in the
   * trace next to the transfer traffic, so the log of a capture that starved the
   * device says whether this thread was the reason.
   */
  private armLoopStallWatch(started: number): void {
    this.loopStalls.start();
    this.loopStalls.onStall = (ms, at) => {
      this.trace({
        dir: 'info',
        note: `${this.threadLabel} thread blocked ${ms.toFixed(1)} ms at ` +
          `${(at - started).toFixed(0)} ms into the capture`,
      });
    };
  }

  /** Fold the probe's result into the stats and stop its timer. */
  private disarmLoopStallWatch(): void {
    this.loopStalls.stop();
    this.loopStalls.onStall = null;
    this.stats.threadStallMaxMs = this.loopStalls.maxMs;
    this.stats.threadStalls = this.loopStalls.count;
  }

  /**
   * Fail a capture that never receives a byte, naming the state the board is in.
   *
   * Measured 2026-09-10 (NOTES 8.8): a wedged 32U3 answers every control transfer,
   * reports no error bit, and delivers nothing at all on the bulk endpoint until it
   * is unplugged. The page used to sit on that until the user pressed stop, then show
   * an empty capture with no explanation - the exact "first capture fine, the second
   * one fails" report this work started from.
   */
  private armNoDataWatchdog(cfg: CaptureConfig): void {
    this.clearNoDataWatchdog();
    const firstTransferMs = this.expectedBytesPerMs > 0 && this.tuning
      ? this.tuning.transferBytes / this.expectedBytesPerMs
      : NO_DATA_DEADLINE_FLOOR_MS;
    this.noDataDeadlineMs = NO_DATA_DEADLINE_FACTOR * firstTransferMs + NO_DATA_DEADLINE_FLOOR_MS;
    this.noDataTimer = setTimeout(() => {
      this.noDataTimer = null;
      if (!this.running || this.stats.transfers > 0) return;
      const e = new Error(
        `${this.name} delivered no data within ${Math.round(this.noDataDeadlineMs)} ms of RUN ` +
          `(${cfg.channels}ch @ ${cfg.samplerate / 1e6} MHz). A board in this state answers ` +
          'every control transfer and sends nothing on the bulk endpoint: unplug it and plug it ' +
          'back in.',
      );
      this.loopError = e;
      this.underrun = e;
      console.error('[slogic]', e.message);
      void this.stopProducer('no data');
      this.onError?.(e);
    }, this.noDataDeadlineMs);
  }

  /**
   * Clear a length limit an earlier session left in R32_SAMPLE_LEN.
   *
   * The register is not part of the module reset and this transport is the only thing
   * that ever writes it, so the only state a fresh open() can find here is its own
   * leftovers - from a previous capture of this page, or from a page that was reloaded
   * while one was armed. Asking costs one control read, and not asking means a later
   * capture silently stops at another capture's length. Firmware that does not
   * implement the register answers nothing and is left alone.
   */
  private async clearSampleLimit(bus: RegisterBus): Promise<void> {
    try {
      const current = await readSampleLength(bus, (e) => this.trace(e));
      if (current === 0) return;
      await writeSampleLength(bus, 0, (e) => this.trace(e));
      this.trace({ dir: 'info', note: `cleared a stale sample limit (R32_SAMPLE_LEN was ${current})` });
    } catch (e) {
      this.sampleLimitUnavailable = true;
      this.trace({ dir: 'info', note: `R32_SAMPLE_LEN unavailable (${String(e)})` });
    }
  }

  /**
   * Program the device's own length limit (aux 0x04, R32_SAMPLE_LEN) so the device
   * stops producing on its own instead of being cut off by the host.
   *
   * This is the vendor's answer to the failure that has been killing this board all
   * along: "用于达到采集长度后停止上传, 防止停止采样命令设置前还在上传数据导致 Overflow".
   * Measured on S/N 202608052052: six consecutive 32ch/100M captures, each ending on
   * the device's own stop, 100.00% of the requested length, board healthy after all
   * six (NOTES 8.9). Without it the only end-of-capture the host has is to stop
   * reading while the device is still producing, which overruns the FIFO and wedges
   * the sampler until the board is unplugged (NOTES 8.2).
   *
   * The limit counts from RB_CTRL_EN, so the samples this transport discards as a
   * head are added before converting. A value of 0 is the device's reset value and
   * means "no limit": a capture that must not have one (software-trigger mode, where
   * the trigger position is not known before RUN) clears a limit an earlier capture
   * armed rather than inheriting a stream that stops early.
   *
   * A firmware that does not implement the register is not fatal - the 16U3 may be
   * one - but it is reported once, because a capture that silently loses its only
   * underrun protection is worth knowing about.
   */
  private async armSampleLimit(
    bus: RegisterBus,
    channels: number,
    samples: number | undefined,
  ): Promise<void> {
    const wanted = samples && samples > 0 ? samples + this.headDropSamples(channels) : 0;
    // A healthy 16U3 has no reason to see this register at all.
    if (wanted === 0 && !this.sampleLimitArmed) {
      this.armedDeviceSamples = 0;
      return;
    }
    const value = sampleLengthForSamples(wanted);
    try {
      await writeSampleLength(bus, value, (e) => this.trace(e));
      this.sampleLimitArmed = value !== 0;
      // Only a verified write counts: a limit the device did not take must not be
      // allowed to explain a silent read queue later (writeSampleLength reads back).
      this.armedDeviceSamples = this.sampleLimitArmed
        ? samplesForSampleLength(value)
        : 0;
      this.trace({
        dir: 'info',
        note: value === 0
          ? 'device sample limit cleared (R32_SAMPLE_LEN=0, no limit)'
          : `device sample limit armed: R32_SAMPLE_LEN=${value} stops the device after ` +
            `~${wanted} samples, so the host never has to cut off a producing device`,
      });
    } catch (e) {
      if (!this.sampleLimitUnavailable) {
        this.sampleLimitUnavailable = true;
        console.warn(
          '[slogic] this firmware refused R32_SAMPLE_LEN; captures run without a ' +
            'device-side length limit and the FIFO can overrun if the host falls behind:',
          e,
        );
      }
      this.trace({ dir: 'info', note: `device sample limit unavailable (${String(e)})` });
      this.armedDeviceSamples = 0;
    }
  }

  /** Open, claim interface 0 and put the device in a known state. */
  async open(): Promise<void> {
    if (!this.usb.opened) await this.usb.open();
    if (this.usb.configuration === null) await this.usb.selectConfiguration(1);
    await this.usb.claimInterface(0);

    const bus = new RegisterBus(this.usb, (e) => this.trace(e));
    this.bus = bus;
    // dev_open() opens with a reset; this transport writes CTRL_STOP and verifies it
    // instead. Both get a device left running by a previous host to stop producing for
    // the endpoint - CTRL_STOP = 0 clears EN and RST in the one register, and without it
    // the head drop lands in the middle of the old stream - but the reset pulse drops
    // the module configuration with it and, when the follow-up write is the one the
    // firmware misses, leaves RST set: measured on a freshly replugged 32U3, that is a
    // board that answers nothing on the bulk endpoint until CTRL is written again.
    // Read -> write -> read is what tells those apart, and what confirms RST is not left
    // set (NOTES 8.13).
    await programCtrl(bus, CTRL_STOP, (e) => this.trace(e), 'open: CTRL');
    // Clearing the overflow latch used to be the reset's job (NOTES 8.4); with no reset
    // in this path the write-1-to-clear below is the only thing that clears it, so ask
    // the status register instead of assuming anything.
    await this.settleFifoOverflow(bus, 'open');
    // R32_SAMPLE_LEN is not part of R32_CTRL at all, so a limit armed by an earlier
    // session - the same page, or a different one after a reload - would silently
    // truncate every later capture, including a software-trigger capture that has to
    // be free to wait as long as it likes.
    await this.clearSampleLimit(bus);
    this.trace({ dir: 'info', note: 'device stopped, interface 0 claimed' });
  }

  async close(): Promise<void> {
    if (this.running || this.loopDone) {
      try {
        await this.stop();
      } catch (e) {
        // close() still has to release the device, but a failure on the way out
        // is reported, never dropped.
        console.error('[slogic] stop() during close failed:', e);
        this.onError?.(e);
      }
    }
    if (this.usb.opened) {
      try {
        await this.usb.releaseInterface(0);
      } catch (e) {
        // Releasing a device that has already gone away is not interesting,
        // but it is still worth seeing.
        console.warn('[slogic] releaseInterface during close:', e);
      }
      await this.usb.close();
    }
    this.bus = null;
  }

  async start(
    cfg: CaptureConfig, sink: SampleSink, _onDropout?: DropoutSink, opts: StartOptions = {},
  ): Promise<void> {
    if (this.running) throw new Error('start() called while already running');
    if (this.stopping || this.loopDone) {
      throw new Error('start() called before the previous capture finished stopping');
    }
    assertValidConfig(cfg, this.maxSamplerateHz, this.maxChannels);
    if (!this.bus) throw new Error('start() called before open()');
    const bus = this.bus;

    this.cfg = cfg;
    this.sink = sink;
    this.tuning = deriveStreamTuning(cfg, opts.tuning ?? {});
    // Sticky: an instance lives on exactly one thread, and `bench` restarts the loop
    // without repeating the options, so the label set by the first capture has to hold.
    this.threadLabel = opts.threadLabel ?? this.threadLabel;
    this.stats = Slogic16U3.zeroStats();
    this.samplesDelivered = 0;
    this.headRemaining = HEAD_DROP_BYTES;
    this.loopError = null;
    this.stopping = false;
    this.sampleCarry = new Uint8Array(0);
    this.triggerMatched = false;
    this.triggerNotFound = false;
    this.discard = opts.discard ?? false;
    this.triggerState = opts.onTriggerState ?? null;
    this.onCaptureEnd = opts.onEnd ?? null;
    this.captureEnded = false;
    // The two end-of-capture mechanisms count different units: `deviceSampleLimit`
    // counts device samples, the trigger counts *emitted* samples. Combined, the
    // comparison in deviceReachedItsLimit() is meaningless and can declare a still-
    // producing device self-stopped, whose stop() path then cancels its reads - the
    // FIFO-overrun wedge (NOTES 8.2). The capture length in trigger mode belongs in
    // `softwareTrigger.maxSamples`.
    if (opts.softwareTrigger && opts.deviceSampleLimit && opts.deviceSampleLimit > 0) {
      throw new Error('softwareTrigger and deviceSampleLimit are mutually exclusive; ' +
        'bound a triggered capture with softwareTrigger.maxSamples');
    }
    // Every byte the coalescing buffer flushes - the end-of-capture tail included -
    // must end on a sample boundary; the derived default (8 MiB) always does.
    if (this.tuning.coalesceBytes !== undefined &&
        this.tuning.coalesceBytes % bytesPerSampleForChannels(cfg.channels) !== 0) {
      throw new Error(`coalesceBytes ${this.tuning.coalesceBytes} is not a multiple of ` +
        `the ${bytesPerSampleForChannels(cfg.channels)}-byte sample size`);
    }
    if (opts.softwareTrigger) {
      if (opts.softwareTrigger.channels !== cfg.channels) {
        throw new Error(`software trigger width ${opts.softwareTrigger.channels} does not match capture width ${cfg.channels}`);
      }
      this.trigger = new SoftwareTrigger({
        config: opts.softwareTrigger,
        // The sink owns whatever it is handed (types.ts) - the worker pump *transfers*
        // the chunk's ArrayBuffer to the page. The trigger, however, keeps reading the
        // transfer buffer it emitted a view of: after the trigger sample is emitted,
        // feed() goes on to emit the post-trigger range of the same buffer. Hand the
        // sink a copy unless the chunk already owns its whole buffer (the ring slices
        // do), or the rest of the fragment is read from a detached buffer and every
        // sample after the trigger in that fragment is silently dropped.
        emit: (chunk) => {
          void this.emitSamples(
            chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
              ? chunk
              : chunk.slice(),
          );
        },
      });
      this.triggerState?.('waiting');
    } else {
      this.trigger = null;
    }
    this.expectedBytesPerMs = (cfg.samplerate * cfg.channels) / 8 / 1000;
    this.underrun = null;
    this.transferMs.clear();
    this.rearmMs.clear();
    this.sinkMs.clear();

    // Order matters and matches the driver. Verified for the same reason open() is: a
    // stop the firmware missed shows up as a capture that starts mid-stream.
    await programCtrl(bus, CTRL_STOP, (e) => this.trace(e), 'start: CTRL');
    // WebUSB has no per-transfer cancellation. stop() cancels pending reads by releasing
    // and re-claiming the interface; Chromium can leave the bulk pipe in an error state
    // afterwards. Clear the endpoint before every new run so capture #2 starts with a
    // reset data toggle rather than inheriting capture #1's cancelled transfer state.
    await this.usb.clearHalt('in', EP_IN);
    // The driver only touches the pattern register when the frontend asks for a
    // pattern, which means a device left in "Emulation" by a previous session
    // stays there. Program it explicitly so a capture is never silently fake.
    await configureTestMode(
      bus, cfg.testMode ?? opts.testMode ?? TEST_MODE_NORMAL, (e) => this.trace(e),
    );
    await configureChannels(bus, cfg.channels, (e) => this.trace(e));
    await configureSamplerate(bus, cfg.samplerate, (e) => this.trace(e));
    await configureThreshold(bus, cfg.thresholdVolts, (e) => this.trace(e));

    // open() runs once per connected device; every capture after the first reaches
    // RUN through this path. An overflow latched by capture #1 keeps RDY de-asserted
    // and turns capture #2 into a stream of failed transferIn calls, so the check has
    // to be per acquisition, right before the device is told to produce.
    await this.settleFifoOverflow(bus, 'start');

    // Programme the device's own stop before RUN: from here on the capture can end
    // without the host ever having to stop reading a device that is still producing.
    await this.armSampleLimit(bus, cfg.channels, opts.deviceSampleLimit);

    const started = performance.now();
    // libusb can leave submitted URBs pending while the device is stopped, so
    // the native driver queues them before CMD_RUN. Chromium/WebUSB does not:
    // on 32U3 a transferIn submitted while stopped completes immediately with
    // NetworkError and poisons the whole queue. Arm immediately *after* RUN;
    // the device FIFO covers this sub-millisecond control-to-bulk handoff.
    //
    // RUN is the one write whose absence is indistinguishable from the wedge this
    // transport spent the day chasing: a board that did not start answers every queued
    // transferIn with nothing at all. Two extra control reads are cheap next to that,
    // and they have to happen before the read loop arms, which is the order below.
    await programCtrl(bus, CTRL_RUN, (e) => this.trace(e), 'start: CTRL');
    this.running = true;
    // The capture's own length in wire bytes, when there is one, is what bounds the read
    // loop's queue - the driver's rule (protocol.c:395), and the only bound that does not
    // depend on how quickly the consumer is draining. Zero means "not known before RUN",
    // which is software-trigger mode; the loop then falls back to the consumer bound.
    const budgetBytes = opts.deviceSampleLimit && opts.deviceSampleLimit > 0
      ? Math.ceil(opts.deviceSampleLimit * bytesPerSampleForChannels(cfg.channels)) + HEAD_DROP_BYTES
      : 0;
    this.loopDone = this.readLoop(started, budgetBytes).catch(() => {});
    this.armNoDataWatchdog(cfg);
    this.armLoopStallWatch(started);
    this.trace({
      dir: 'info',
      note:
        `running: ${cfg.channels}ch @ ${cfg.samplerate / 1e6} MHz, ` +
        `${this.tuning.depth} x ${this.tuning.transferBytes} B in flight`,
    });

    // readLoop() already reported the failure; keep the rejection off the
    // unhandled-rejection path and let stop() re-throw it to the caller.
  }

  /**
   * Keep `depth` transferIn calls outstanding and separate completion from data
   * processing, like libsigrok's receive callback plus raw_data_queue.
   *
   * Each promise reaction submits its replacement before waking the ordered consumer.
   * Planar conversion, trigger matching or rendering work therefore cannot delay the
   * re-submit until the next loop iteration. Sequence numbers retain endpoint order even
   * if the browser happens to resolve promise callbacks out of order.
   */
  private async readLoop(started: number, budgetBytes = 0): Promise<void> {
    const { depth, transferBytes } = this.tuning!;
    const completed = new Map<number, CompletedTransfer>();
    const inFlight = new Set<Promise<void>>();
    let submitted = 0;
    let nextSequence = 0;
    let wake: (() => void) | null = null;
    let bytesAtFirstByte = 0;

    /*
     * libsigrok's slow-transfer watchdog (protocol.c:149-176), reproduced so the browser
     * fails fast instead of letting the device's FIFO overflow for seconds: a 32U3 that
     * is allowed to overrun wedges its bulk endpoint, and until 8.4 nothing but a replug
     * cleared that.
     *
     * The driver's trip condition is three tests ORed, on ONE completed URB:
     *
     *   duration      > (1 + 0.3) * expected transfer duration   (protocol.c:152)
     *   actual rate   < (1 - 0.3) * expected rate                (protocol.c:154)
     *   average rate  < 0.95 * expected rate                     (protocol.c:155)
     *
     * and it aborts after `timeout_count_limit = num_transfers_used` consecutive trips.
     *
     * Two of those collapse into one here. A full-length transfer's rate and its duration
     * are the same statement (`rate < 0.7 x expected` is `duration > 1.43 x expected`,
     * which the 1.3x duration test already covers), and a short read is not evidence of
     * falling behind - the endpoint simply had less to give, and this transport already
     * treats that as successful data. So what remains is the driver's duration test per
     * transfer, and its whole-run average.
     *
     * This used to be a sliding `depth`-transfer window held to 0.95 of the line rate, which
     * is not any of the driver's three tests: it aborted on a 5% dip across five transfers,
     * where libsigrok needs a 30% dip on one URB or a sustained 5% over the whole capture.
     *
     * Both tests carry the same per-transfer scheduling allowance the driver never needs:
     * libusb measures a URB the moment the kernel reaps it, while a page measures it after
     * the browser process, the IPC and its own task queue. The allowance is what keeps a
     * small transfer from reading as slow - at 16ch/16 MHz a 1 KiB transfer is 0.03 ms of
     * device time, so one scheduler quantum is a 100% shortfall.
     */
    const expectedBytesPerMs = this.expectedBytesPerMs;
    const expectedTransferMs = expectedBytesPerMs > 0 ? transferBytes / expectedBytesPerMs : 0;
    let outstanding = 0;
    let idleSince: number | null = null;
    let lastCompletionAt: number | null = null;
    let completedCount = 0;
    let completedBytes = 0;
    let slowCount = 0;
    // Anchor for the whole-run average, set once start-up is over.
    let runBaseBytes = 0;
    let runBaseCount = 0;
    let runBaseAt: number | null = null;
    this.stats.slowTransferLimit = depth;

    const observeCompletion = (bytes: number, at: number): void => {
      const duration = lastCompletionAt === null ? expectedTransferMs : at - lastCompletionAt;
      // The device answered: whatever else happens, it is not the wedged-board state.
      this.clearNoDataWatchdog();
      lastCompletionAt = at;
      completedCount += 1;
      completedBytes += bytes;
      this.transferMs.push(duration);
      this.stats.transferMsMax = Math.max(this.stats.transferMsMax, duration);
      if (expectedBytesPerMs <= 0) return;

      // The first `2 * depth` completions are start-up, not a trend: the first transfer
      // after RUN also carries the control-to-bulk handoff latency, and the driver's own
      // average starts at RUN and is measurably harsher for it (NOTES 8.2).
      if (runBaseAt === null || completedCount <= 2 * depth) {
        runBaseAt = at;
        runBaseBytes = completedBytes;
        runBaseCount = completedCount;
        return;
      }
      const runMs = at - runBaseAt;
      const runBytes = completedBytes - runBaseBytes;
      const runRate = runMs > 0 ? runBytes / runMs : Number.POSITIVE_INFINITY;
      const slow = duration >
          (1 + SLOW_TRANSFER_TOLERANCE) * expectedTransferMs + WATCHDOG_NOISE_ALLOWANCE_MS ||
        runMs > runBytes / expectedBytesPerMs / SLOW_AVERAGE_HEADROOM +
          WATCHDOG_RATE_ALLOWANCE_MS * (completedCount - runBaseCount);
      if (slow) {
        slowCount += 1;
      } else {
        slowCount = 0;
      }
      // Once the capture is aborted, later completions are the queue draining - they are
      // not evidence about the rate that caused the abort, and a healthy one among them
      // would reset the count the caller is about to read.
      if (!this.underrun) this.stats.slowTransfers = slowCount;
      if (slowCount >= depth && !this.underrun) {
        this.underrun = new Error(
          `${this.name} overran the host: ${this.cfg!.channels}ch @ ` +
            `${this.cfg!.samplerate / 1e6} MHz offers ${(expectedBytesPerMs * 1000 / 1e6).toFixed(0)} MB/s ` +
            `for ${slowCount} consecutive transfers: ${duration.toFixed(2)} ms for ` +
            `${bytes} B (limit ${((1 + SLOW_TRANSFER_TOLERANCE) * expectedTransferMs).toFixed(2)} ms), ` +
            `${(runRate * 1000 / 1e6).toFixed(0)} MB/s average over ${runMs.toFixed(0)} ms ` +
            `(minimum ${(expectedBytesPerMs * SLOW_AVERAGE_HEADROOM * 1000 / 1e6).toFixed(0)} MB/s). ` +
            'Capture aborted before the device FIFO overflow wedged the endpoint.' +
            // A starved queue and a slow device look identical from here. The probe is
            // what tells them apart, so its worst number belongs in this message.
            (this.loopStalls.count > 0
              ? ` The ${this.threadLabel} thread was blocked ${this.loopStalls.count} time(s) during the ` +
                `capture, worst ${this.loopStalls.maxMs.toFixed(1)} ms at ` +
                `${(this.loopStalls.maxAtMs - started).toFixed(0)} ms; the queue covers ` +
                `${(depth * expectedTransferMs).toFixed(1)} ms.`
              : ` The ${this.threadLabel} thread was never blocked for more than ` +
                `${THREAD_STALL_THRESHOLD_MS} ms, so this is the device or the USB path.`),
        );
        // Tell the device to stop producing now, while this loop still has `depth`
        // reads queued, rather than waiting for the caller to get around to stop().
        // The loop stops replenishing on the next completion, and a producer with no
        // queued reads overruns its FIFO and kills the bulk endpoint until the board
        // is replugged (NOTES 8.6). The driver's abort path stops the device too, as
        // soon as its cancelled URBs are reaped (protocol.c:199-232).
      }
    };

    const notify = (): void => {
      const fn = wake;
      wake = null;
      fn?.();
    };
    /*
     * Refill rules.
     *
     * `depth` reads are what the device needs in flight to keep producing into, so the one
     * rule that must never be broken is that they stay submitted. That is exactly what the
     * native driver does: its completion callback re-submits whenever the capture's own
     * byte budget allows (`samples_got_nbytes + num_transfers_used * per_transfer_nbytes <
     * samples_need_nbytes`, protocol.c:395), and what the consumer is doing with an
     * already-completed block - a `GAsyncQueue` the session thread drains at its own pace
     * (protocol.c:225) - cannot stop the next URB from being submitted. Its memory is
     * bounded by the capture's declared length, not by how fast the consumer is.
     *
     * This transport used to bound refills by the consumer instead: `lagChunks` chunks of
     * backlog, and past that no replacement read was armed. That turns a page which is a
     * few milliseconds late into a device with an empty queue. Measured on hardware at
     * 32ch/100M (NOTES 8.27): the backlog reached 17 of its 20-chunk cap, the next
     * completion took 8.30 ms against a 7.82 ms fill, and the watchdog aborted a capture
     * the board should never have been allowed to overrun - the failure the driver's own
     * resubmit rule exists to prevent.
     *
     * So a capture whose length is known (timer mode arms `R32_SAMPLE_LEN`) arms while the
     * host has not already read that whole length, the driver's rule. A capture without one
     * - software trigger, where the trigger position is not known before RUN - keeps the
     * consumer bound, because there is nothing else to bound the memory with, and says so
     * in the trace when the cap is what stopped the refill.
     */
    const lagChunks = this.tuning!.lagChunks ?? depth * 4;
    /**
     * Chunks the host is holding: filled and waiting for the consumer, plus submitted and
     * not yet filled. Each is `transferBytes` of memory, so the bound has to be on their
     * sum. Bounding `completed` alone leaves the already-submitted lanes uncounted, and
     * every one of them still lands: measured with lagChunks 8 and depth 4, the backlog
     * grew to 12 before the cap took effect.
     */
    const outstandingChunks = (): number => completed.size + inFlight.size;
    /**
     * The capture's own length in wire bytes, plus one read, or 0 when there is none.
     *
     * The one read of slack is the driver's: it submits while `samples_got + used * per <
     * samples_need`, so the last read may carry past the budget. Without it a capture stops
     * arming one read short of its length and ends on the host's timeout instead of on the
     * device's own stop.
     */
    const captureBudgetBytes = budgetBytes > 0 ? budgetBytes + transferBytes : 0;
    let lagStoppedRefill = false;
    const withinBudget = (): boolean => captureBudgetBytes > 0
      ? this.stats.rawBytes < captureBudgetBytes
      : outstandingChunks() < lagChunks;
    const canArm = (): boolean => inFlight.size < depth && withinBudget();
    /**
     * Called once when the consumer bound is what stopped the refill. It is the one path
     * where this transport deliberately lets the device starve, so it must be visible in
     * the trace rather than looking like a slow device.
     */
    const noteLagStop = (): void => {
      if (captureBudgetBytes > 0 || lagStoppedRefill) return;
      lagStoppedRefill = true;
      this.trace({
        dir: 'info',
        note: `refill held back: the consumer is ${outstandingChunks()} chunks ` +
          `(${Math.round(outstandingChunks() * transferBytes / 1048576)} MiB) behind and this ` +
          'capture has no length to bound the queue with',
      });
    };
    const finish = (item: CompletedTransfer): void => {
      this.lastCompletionAt = performance.now();
      completed.set(item.sequence, item);
      this.stats.peakQueuedTransfers = Math.max(this.stats.peakQueuedTransfers, completed.size);
      // Refill here, with the chunk counted and before the consumer is woken. The central
      // throughput invariant is that the USB queue is replenished before a completed
      // buffer reaches any consumer work, and `notify()` only resolves a promise, so the
      // arm below still runs first.
      if (this.running && item.error === undefined && item.result?.status === 'ok' &&
          canArm()) {
        arm();
        this.rearmMs.push(performance.now() - item.completedAt);
      } else if (this.running && captureBudgetBytes === 0) {
        noteLagStop();
      }
      notify();
    };
    const arm = (): void => {
      const sequence = submitted++;
      let request: Promise<USBInTransferResult>;
      try {
        request = this.usb.transferIn(EP_IN, transferBytes);
      } catch (error) {
        finish({ sequence, completedAt: performance.now(), error });
        return;
      }
      let task!: Promise<void>;
      task = request.then(
        (result) => {
          const completedAt = performance.now();
          inFlight.delete(task);
          outstanding -= 1;
          if (outstanding === 0) idleSince = completedAt;
          if (idleSince !== null && outstanding > 0) {
            this.stats.maxIdleGapMs = Math.max(this.stats.maxIdleGapMs, performance.now() - idleSince);
            idleSince = null;
          }
          if (result.status === 'ok' && result.data) {
            observeCompletion(result.data.byteLength, completedAt);
          }
          finish({ sequence, completedAt, result });
        },
        (error) => {
          const completedAt = performance.now();
          inFlight.delete(task);
          outstanding -= 1;
          finish({ sequence, completedAt, error });
        },
      );
      inFlight.add(task);
      outstanding += 1;
    };
    const takeNext = async (): Promise<CompletedTransfer | null> => {
      while (!completed.has(nextSequence)) {
        if (inFlight.size === 0) return null;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      const item = completed.get(nextSequence)!;
      completed.delete(nextSequence++);
      // The completion callback could not refill - the consumer bound held it, or every
      // lane was already submitted - so the queue gets its depth back here. It is the only
      // other place a read is armed, and `canArm` keeps it inside the same two bounds, so a
      // synchronous sink still behaves exactly as it did before there was a cap (NOTES
      // 8.13).
      if (this.running && canArm()) arm();
      return item;
    };
    const consume = async (item: CompletedTransfer, duringStop: boolean): Promise<void> => {
      // libsigrok aborts the session the moment the host falls behind; a capture that
      // keeps running at half the device's rate is what kills the 32U3 endpoint.
      if (this.underrun && !duringStop) throw this.underrun;
      if (item.error !== undefined) {
        if (duringStop) {
          this.trace({ dir: 'info', note: `pending transfer cancelled on stop: ${item.error}` });
          return;
        }
        throw item.error;
      }
      const r = item.result!;
      if (r.status !== 'ok') {
        if (duringStop) {
          this.trace({ dir: 'info', note: `pending transfer ended with status "${r.status}" on stop` });
          return;
        }
        throw new Error(`bulk IN returned status "${r.status}"`);
      }
      const data = r.data;
      if (!data) throw new Error('bulk IN returned no data with status "ok"');

      const now = item.completedAt;
      if (this.stats.firstByteMs === null && data.byteLength > 0) {
        this.stats.firstByteMs = now - started;
        bytesAtFirstByte = this.stats.rawBytes + data.byteLength;
      }
      this.stats.transfers += 1;
      this.stats.rawBytes += data.byteLength;
      if (data.byteLength < transferBytes) this.stats.shortTransfers += 1;
      this.stats.elapsedMs = now - started;
      this.stats.rawMBps =
        this.stats.elapsedMs > 0 ? this.stats.rawBytes / this.stats.elapsedMs / 1000 : 0;
      const steadyMs = this.stats.elapsedMs - (this.stats.firstByteMs ?? 0);
      this.stats.steadyMBps =
        steadyMs > 0 ? (this.stats.rawBytes - bytesAtFirstByte) / steadyMs / 1000 : 0;

      const sinkStarted = performance.now();
      if (this.discard) {
        // Bench mode: the pipe is drained as fast as the host can, and the cost of
        // everything the sink would have done is removed from the measurement. These
        // are wire bytes, so the sub-8-channel packing divisor applies.
        this.samplesDelivered += data.byteLength / this.wireBytesPerSample(this.cfg!.channels);
      } else {
        // Awaiting the sink is the backpressure: a worker pump hands each chunk to the
        // page and waits for the ack, so `completed` grows at most to lagChunks before
        // canArm() stops the refill above (see the refill rules).
        await this.deliver(data);
        await this.maybeEndCapture();
      }
      this.sinkMs.push(performance.now() - sinkStarted);
      // A WebUSB short packet is successful data, not evidence that the unfilled part of
      // the requested buffer was lost. libsigrok likewise consumes actual_length and
      // immediately resubmits. Only the device/USB controller could report a real gap.
    };

    for (let i = 0; i < depth; i++) arm();

    try {
      while (this.running) {
        const item = await takeNext();
        if (!item) break;
        await consume(item, this.stopping);
      }
    } catch (e) {
      // Report before draining, not after. Draining waits for transfers that
      // only settle once stop() releases the interface, so deferring the report
      // until then would hide the failure for as long as the caller keeps
      // waiting for data that is never coming.
      this.running = false;
      this.loopError = e;
      console.error('[slogic] read loop failed:', e);
      this.onError?.(e);
      // Tell the device to stop producing now rather than when the caller gets
      // around to stop(): this loop is done replenishing, and a producer with no
      // queued reads overruns its FIFO, which kills the bulk endpoint until the
      // board is replugged (NOTES 8.6). The driver's abort path stops the device
      // too, as soon as its cancelled URBs are reaped (protocol.c:199-232).
      void this.stopProducer('read loop failure');
      throw e;
    } finally {
      // stop() releases the interface, settling every request. Successful tail blocks
      // already returned by Chromium are still delivered in submission order.
      await Promise.allSettled([...inFlight]);
      // The drain's consumers are asynchronous now that the sink may be, so each one is a
      // promise that has to be observed. Left unobserved, a sink that rejects while the
      // tail is being delivered becomes an unhandled rejection behind a capture that is
      // already ending - measured in the rate model: the abort path killed the process
      // instead of reporting through onError.
      const draining: Promise<void>[] = [];
      while (nextSequence < submitted) {
        const item = completed.get(nextSequence);
        if (!item) break;
        completed.delete(nextSequence++);
        draining.push(consume(item, true));
      }
      const drained = await Promise.allSettled(draining);
      const failed = drained.find((r) => r.status === 'rejected');
      if (failed) {
        const reason: unknown = failed.reason;
        console.error('[slogic] delivering the drained tail failed:', reason);
        this.onError?.(reason);
      }
      // Everything the tail put in the coalescing block is the end of this capture.
      try {
        await this.flushSink();
      } catch (reason) {
        console.error('[slogic] delivering the coalesced tail failed:', reason);
        this.onError?.(reason);
      }
    }
  }

  /**
   * Head drop, sub-8-channel expansion and hand-off to the sink. Shared by the
   * read loop and by drain(), so data that arrived in an already-submitted
   * transfer is not thrown away at stop() time.
   */
  /**
   * Returns the sink's promise when it has one, so the consumer can be held to the
   * rate the sink can actually take (StreamTuning.lagChunks). A synchronous sink -
   * every caller except the worker pump - returns undefined and costs nothing.
   */
  private deliver(data: DataView): void | Promise<void> {
    let bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    // Drop the junk head once per acquisition, carrying the remainder to the
    // next transfer if this one was shorter than the drop.
    if (this.headRemaining > 0) {
      const drop = Math.min(this.headRemaining, bytes.length);
      bytes = bytes.subarray(drop);
      this.headRemaining -= drop;
      if (bytes.length === 0) return;
    }

    const channels = this.cfg!.channels;
    let out: Uint8Array;
    if (channels < 8) {
      out = expandPacked(bytes, channels);
    } else {
      const bps = bytesPerSampleForChannels(channels);
      if (this.sampleCarry.length) {
        const joined = new Uint8Array(this.sampleCarry.length + bytes.length);
        joined.set(this.sampleCarry);
        joined.set(bytes, this.sampleCarry.length);
        bytes = joined;
        this.sampleCarry = new Uint8Array(0);
      }
      const whole = bytes.length - (bytes.length % bps);
      if (whole < bytes.length) this.sampleCarry = bytes.slice(whole);
      if (whole === 0) return;
      out = bytes.subarray(0, whole);
    }
    if (this.trigger) {
      const wasMatched = this.triggerMatched;
      this.trigger.feed(out);
      const stats = this.trigger.stats;
      this.triggerMatched = stats.matched;
      if (!wasMatched && this.triggerMatched) {
        this.triggerState?.('triggered', stats.triggerSampleIndex ?? undefined);
      }
      this.maybeFinishTrigger();
      // The trigger owns delivery in this mode and feeds the sink synchronously, so
      // there is no promise to hand back. Its stream is bounded by the capture length
      // the caller asked for, which is what keeps that from being unbounded.
      return;
    } else {
      return this.emitSamples(out);
    }
  }

  private emitSamples(out: Uint8Array): void | Promise<void> {
    const bps = bytesPerSampleForChannels(this.cfg!.channels);
    this.stats.sinkBytes += out.length;
    this.samplesDelivered += out.length / bps;
    const coalesceBytes = this.tuning?.coalesceBytes ?? 0;
    if (coalesceBytes <= 0) return this.sink?.(out) ?? undefined;
    // Coalesce into blocks of `coalesceBytes`. The accounting above is unchanged - a byte
    // counts as delivered here, the moment the transport accepts it - so a dropout position
    // keeps meaning "device samples handed to the sink", and the only difference is that the
    // sink sees them in larger pieces. A dropout report must call flushSink() first if that
    // path is ever wired to this layer: the store's own length is the anchor the caller
    // cross-checks against, and up to one block of it would still be held here.
    let pending: void | Promise<void> = undefined;
    for (let offset = 0; offset < out.length;) {
      if (this.sinkBuffer.length === 0) this.sinkBuffer = new Uint8Array(coalesceBytes);
      const take = Math.min(coalesceBytes - this.sinkFill, out.length - offset);
      this.sinkBuffer.set(out.subarray(offset, offset + take), this.sinkFill);
      this.sinkFill += take;
      offset += take;
      if (this.sinkFill === coalesceBytes) pending = this.flushSink() ?? pending;
    }
    return pending;
  }

  /**
   * Hand the coalescing block to the sink. The sink may keep the buffer - the worker pump
   * transfers it to the page - so the block is not reused: a full-size block is handed over
   * as the subarray its caller sees, and the next one starts from a fresh allocation.
   */
  private flushSink(): void | Promise<void> {
    if (this.sinkFill === 0) return;
    const block = this.sinkBuffer.subarray(0, this.sinkFill);
    this.sinkBuffer = new Uint8Array(0);
    this.sinkFill = 0;
    return this.sink?.(block) ?? undefined;
  }

  /**
   * End-of-capture, detected on the delivery path rather than left to the caller.
   *
   * Two captures know when they are done: one whose device stops itself at
   * R32_SAMPLE_LEN, and one whose software trigger has emitted its full budget. In
   * both, the bytes already delivered are all the bytes there will ever be - but up
   * to one coalescing block of them (SINK_CHUNK_BYTES, ~10 ms of 32ch/200M) is still
   * sitting in `sinkBuffer`, and nothing else would flush it until stop(). A caller
   * counting samples to decide when to stop therefore sat forever a few milliseconds
   * short of its target ("stuck at 990 ms of a 1 s capture"). Flush the tail, then
   * say so once through onEnd.
   */
  private async maybeEndCapture(): Promise<void> {
    if (this.captureEnded) return;
    // A manual stop's drain must not read as the capture ending on its own: the
    // finally-block flush already delivers the tail, and "stopped by the user" and
    // "delivered everything" are different reports.
    if (this.stopping) return;
    const trigger = this.trigger;
    const triggerDone = trigger !== null &&
      (trigger.stats.complete || trigger.stats.noTrigger);
    if (!triggerDone && !this.deviceReachedItsLimit()) return;
    this.captureEnded = true;
    await this.flushSink();
    this.trace({
      dir: 'info',
      note: trigger?.stats.noTrigger
        ? 'software trigger search ended without a match; nothing more will be delivered'
        : triggerDone
          ? 'software trigger delivered its full budget; capture complete'
          : 'device delivered its programmed length; capture complete',
    });
    this.onCaptureEnd?.();
  }

  private maybeFinishTrigger(): void {
    const trigger = this.trigger;
    if (!trigger) return;
    if (trigger.stats.noTrigger && !this.triggerNotFound) {
      this.triggerNotFound = true;
      this.triggerState?.('not-found');
      return;
    }
    if (!trigger.waiting) return;
    if (trigger.stats.inspectedSamples >= trigger.searchLimitSamples) {
      trigger.finish();
      this.triggerNotFound = true;
      this.triggerState?.('not-found');
    }
  }

  async stop(): Promise<void> {
    const loopDone = this.loopDone;
    if (!loopDone) {
      // Nothing was ever started, or it already stopped. Still make sure the
      // device is not left streaming.
      this.running = false;
      if (this.trigger?.waiting) {
        this.trigger.finish();
        this.triggerState?.('not-found');
      }
      this.trigger = null;
      this.triggerState = null;
      this.triggerMatched = false;
      this.triggerNotFound = false;
      this.onCaptureEnd = null;
      this.sampleCarry = new Uint8Array(0);
      if (this.bus) await this.bus.writeCtrl(CTRL_STOP);
      return;
    }
    this.running = false;
    this.stopping = true;
    this.stoppingSince = performance.now();
    // Ask before the producer is told to stop: this is the state the device reached on
    // its own, and a capture whose length it delivered has nothing left to drain.
    const deviceSelfStopped = this.deviceReachedItsLimit();

    /*
     * Stop the producer first and drain second, which is the opposite of what this
     * used to do. `running = false` already stops replenishing, and the device keeps
     * producing whether or not anyone reads: at 32ch/200M the FIFO holds something
     * like ten milliseconds of that stream, so a drain-then-stop order leaves the
     * device filling its FIFO while the control write is in flight, and an overrun
     * kills the bulk endpoint until the board is replugged (NOTES 8.6). Writing
     * CTRL_STOP now, while this loop still has `depth` reads queued, is what the
     * vendor's own R32_SAMPLE_LEN exists to approximate ("防止停止采样命令设置前还在
     * 上传数据导致 Overflow").
     *
     * The old order came from an observation that CTRL=0 before the queue drained left
     * the endpoint returning EIO; that observation also had releaseInterface() right
     * behind the stop write, and releasing is what cancels bulk transfers on WebUSB.
     * The release stays in the exceptional path below, where it is the only way to
     * cancel a transfer that will never complete.
     */
    let teardownError: unknown = null;
    try {
      try {
        if (this.bus) await this.bus.writeCtrl(CTRL_STOP);
      } catch (e) {
        console.warn('[slogic] CTRL stop write failed during stop():', e);
        teardownError = e;
      }
      if (deviceSelfStopped) {
        this.trace({
          dir: 'info',
          note: 'device reached its programmed length and stopped itself; the queued ' +
            'reads are tail NAKs, so they are cancelled now instead of at the timeout',
        });
      }
      // Wait for the queue to drain, but only while it is still draining: the
      // producer is already stopped, so a transfer that has not completed in
      // STOP_TIMEOUT_MS never will, and waiting longer only delays the release.
      // A device that stopped itself never will either, and the wait is skipped.
      let settled = false;
      for (; !deviceSelfStopped;) {
        const remainingMs = this.queuedDrainDeadlineMs() - performance.now();
        if (remainingMs <= 0) break;
        settled = await Promise.race([
          loopDone.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), remainingMs)),
        ]);
        if (settled) break;
      }
      if (!settled) {
        // Disconnection or a firmware fault can leave transferIn pending forever, and a
        // device that stopped itself leaves its tail reads pending on purpose. Either way
        // only releasing the interface cancels them - WebUSB has no abort on a transfer.
        if (!deviceSelfStopped) {
          console.warn(
            `[slogic] read loop still had transfers in flight ${STOP_TIMEOUT_MS} ms after ` +
              'capture stop; forcing endpoint cancellation',
          );
        }
        try {
          await this.usb.releaseInterface(0);
        } catch (e) {
          console.warn('[slogic] releaseInterface during forced cancellation:', e);
        }
        await loopDone;
        try {
          await this.usb.claimInterface(0);
        } catch (e) {
          console.warn('[slogic] could not re-claim interface 0 after forced cancellation:', e);
        }
      }

      // drain() has now processed every already-completed transfer. Only now is
      // it correct to conclude that a capture stopped without a trigger.
      if (this.trigger?.waiting) {
        this.trigger.finish();
        this.triggerState?.('not-found');
      }
    } finally {
      this.loopDone = null;
      this.stopping = false;
      this.clearNoDataWatchdog();
      this.disarmLoopStallWatch();
      // Drop closures over the completed capture's store promptly. A multi-gigabyte
      // 32-channel store must become collectible before the next capture starts.
      this.sink = null;
      this.cfg = null;
      this.tuning = null;
      this.trigger = null;
      this.triggerState = null;
      this.triggerMatched = false;
      this.triggerNotFound = false;
      this.onCaptureEnd = null;
      this.sampleCarry = new Uint8Array(0);
    }

    // The read loop's error is the interesting one: it is the cause, the
    // control-write failure is a symptom.
    if (this.loopError) {
      const e = this.loopError;
      this.loopError = null;
      throw e;
    }
    if (teardownError) throw teardownError;
  }

  /**
   * Idle-only advanced console. Commands:
   *   read <register-address> [length]
   *   write <register-address> <byte>...
   *   ctrl <value>
   *   flags
   *   clear-fifo
   *   sample-len [value]
   *   bench [seconds] [channels] [MHz] [depth] [transferBytes]
   *   in <request> <value> <index> <length>
   *   out <request> <value> <index> [byte]...
   * Numbers accept decimal or 0x-prefixed hexadecimal notation.
   */
  async usbControl(command: string): Promise<string> {
    if (this.running || this.stopping || this.loopDone) {
      throw new Error('USB console is unavailable while a capture is running or stopping');
    }
    if (!this.bus || !this.usb.opened) throw new Error('device is not open');
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    const op = tokens.shift()?.toLowerCase();
    if (!op || op === 'help') {
      return 'read <addr> [len] | write <addr> <byte>... | ctrl <value> | ' +
        'flags | clear-fifo | sample-len [value] | ' +
        'bench [seconds] [channels] [MHz] [depth] [transferBytes] [normal|usbmax|simulator] | ' +
        'in <request> <value> <index> <len> | out <request> <value> <index> [byte]...';
    }
    const take = (label: string, max: number): number => {
      const token = tokens.shift();
      if (token === undefined) throw new Error(`missing ${label}`);
      const value = parseConsoleNumber(token);
      if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new Error(`${label} must be in [0, ${max}], got ${token}`);
      }
      return value;
    };
    const noExtra = (): void => {
      if (tokens.length) throw new Error(`unexpected argument(s): ${tokens.join(' ')}`);
    };

    if (op === 'read') {
      const addr = take('register address', 0xffff);
      const length = tokens.length ? take('length', 4096) : 4;
      noExtra();
      if (length < 1) throw new Error('length must be at least 1');
      return formatConsoleBytes(await this.bus.read(addr, length));
    }
    if (op === 'write') {
      const addr = take('register address', 0xffff);
      if (!tokens.length) throw new Error('write requires at least one data byte');
      const data = Uint8Array.from(tokens.splice(0).map((token) => {
        const value = parseConsoleNumber(token);
        if (!Number.isInteger(value) || value < 0 || value > 0xff) {
          throw new Error(`data byte must be in [0, 255], got ${token}`);
        }
        return value;
      }));
      await this.bus.write(addr, data);
      return `ok, wrote ${data.length} byte(s): ${formatConsoleBytes(data)}`;
    }
    if (op === 'ctrl') {
      const value = take('CTRL value', 0xff);
      noExtra();
      await this.bus.writeCtrl(value);
      return `ok, CTRL=0x${value.toString(16).padStart(2, '0')}`;
    }
    if (op === 'flags') {
      noExtra();
      return describeDeviceFlags(await readDeviceFlags(this.bus, (e) => this.trace(e)));
    }
    if (op === 'clear-fifo') {
      noExtra();
      // The confirmation step for a board that may have latched an overflow:
      // read R32_FLAG, write 1 to RB_FLAG_FIFO_OV, read it back. RDY is not part
      // of the answer - this firmware never asserts it (NOTES 8.4).
      const before = describeDeviceFlags(await readDeviceFlags(this.bus, (e) => this.trace(e)));
      const after = describeDeviceFlags(await clearFifoOverflow(this.bus, (e) => this.trace(e)));
      return `before: ${before}\nafter:  ${after}`;
    }
    if (op === 'sample-len') {
      // R32_SAMPLE_LEN (aux 0x04): the count at which the firmware stops uploading by
      // itself. The unit is not documented, so this is read/write only - calibrate it
      // against a capture's byte count before trusting it with a capture's tail
      // (NOTES 8.6).
      if (!tokens.length) {
        return `R32_SAMPLE_LEN = ${await readSampleLength(this.bus, (e) => this.trace(e))}`;
      }
      const value = take('sample length', 0xffffffff);
      noExtra();
      const written = await writeSampleLength(this.bus, value, (e) => this.trace(e));
      return `R32_SAMPLE_LEN = ${written}`;
    }
    if (op === 'bench') {
      const seconds = tokens.length ? Number(tokens.shift()) : 3;
      const channels = tokens.length ? Number(tokens.shift()) : 32;
      const mhz = tokens.length ? Number(tokens.shift()) : 200;
      const depth = tokens.length ? Number(tokens.shift()) : undefined;
      const transferBytes = tokens.length ? Number(tokens.shift()) : undefined;
      // Optional sixth word: which of the device's three sources to measure. `usbmax` is
      // the vendor's raw upload - bytes straight into the USB engine, no sampler - which
      // is the only producer in this device that is not also 32 channels of sampling, so
      // it is how the host's own ceiling gets measured on a board whose sampler is already
      // dead (NOTES 8.26).
      const modeToken = tokens.length ? tokens.shift()!.toLowerCase() : undefined;
      noExtra();
      const testMode = modeToken === undefined || modeToken === 'normal'
        ? TEST_MODE_NORMAL
        : modeToken === 'usbmax'
          ? TEST_MODE_USB_MAX_SPEED
          : modeToken === 'simulator' || modeToken === 'emulation'
            ? TEST_MODE_EMULATION
            : (() => {
              throw new Error(
                `bench mode must be normal, usbmax or simulator, got ${modeToken}`);
            })();
      // The floor is what makes this safe to point at a rate the host cannot drain: at
      // 32ch/200M, 5 ms is 4 MB, which the reads already in flight absorb, so the device
      // stops itself at the length before its FIFO can be asked to hold anything. Longer
      // than the queue can cover and the capture overruns the device, which wedges a 32U3
      // until it is replugged (NOTES 8.6).
      if (!(seconds >= 0.005 && seconds <= 60)) {
        throw new Error(`bench seconds must be in [0.005, 60], got ${seconds}`);
      }
      if (!(SUPPORTED_CHANNELS as readonly number[]).includes(channels)) {
        throw new Error(`bench channels must be one of ${SUPPORTED_CHANNELS.join(', ')}, got ${channels}`);
      }
      const cfg: CaptureConfig = {
        channels: channels as CaptureConfig['channels'],
        samplerate: mhz * 1e6,
        thresholdVolts: 1.6,
        testMode,
      };
      assertValidConfig(cfg, this.maxSamplerateHz, this.maxChannels);
      const started = performance.now();
      // End the run the way the vendor says to end one: the device stops *itself* at the
      // length it was programmed with, so `stop()` below never has to cut off a device that
      // is still producing. Doing that is what wedges a 32U3 until it is unplugged
      // (NOTES 8.6), and it is not hypothetical: `bench 2 32 100` held the line rate at
      // 398 MB/s, cut the device off at the end of the run, and left the board answering
      // control transfers with nothing on the bulk endpoint until it was replugged
      // (measured 2026-09-11). The drain wait is the device finishing the bytes the host
      // already has queued, not padding in the measurement - `stats.elapsedMs` is the last
      // completion, so the reported rate is still the rate.
      const samples = Math.floor(seconds * cfg.samplerate);
      // Optional geometry, so a sweep is a list of one-line fixed configurations rather
      // than a new script per question: `bench 0.03 32 200 5 3129344`.
      const tuning = depth === undefined && transferBytes === undefined
        ? {}
        : {
          tuning: {
            ...(depth === undefined ? {} : { depth }),
            ...(transferBytes === undefined ? {} : { transferBytes }),
          },
        };
      await this.start(cfg, () => {}, undefined, {
        discard: true,
        deviceSampleLimit: samples,
        ...tuning,
      });
      // stop() clears the tuning, and the reply has to say which geometry it measured:
      // a sweep is only readable if each line names its own read size and depth.
      const geometry = this.tuning ?? undefined;
      await new Promise((r) => setTimeout(r, seconds * 1000 + BENCH_DRAIN_MS));
      await this.stop();
      return formatBench(this.getStats(), cfg, performance.now() - started, geometry);
    }
    if (op === 'in') {
      const request = take('request', 0xff);
      const value = take('value', 0xffff);
      const index = take('index', 0xffff);
      const length = take('length', 4096);
      noExtra();
      if (length < 1) throw new Error('length must be at least 1');
      // The console is the one place a hung transfer is the whole answer: it must
      // report the board stopped answering rather than leave the UI waiting.
      const result = await withControlTimeout(
        this.usb.controlTransferIn(
          { requestType: 'vendor', recipient: 'device', request, value, index }, length,
        ),
        `control in request 0x${request.toString(16)}`,
      );
      const data = result.data
        ? new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength)
        : new Uint8Array(0);
      return `${result.status}, ${data.length} byte(s): ${formatConsoleBytes(data)}`;
    }
    if (op === 'out') {
      const request = take('request', 0xff);
      const value = take('value', 0xffff);
      const index = take('index', 0xffff);
      const data = Uint8Array.from(tokens.splice(0).map((token) => {
        const byte = parseConsoleNumber(token);
        if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
          throw new Error(`data byte must be in [0, 255], got ${token}`);
        }
        return byte;
      }));
      const result = await withControlTimeout(
        this.usb.controlTransferOut(
          { requestType: 'vendor', recipient: 'device', request, value, index }, data,
        ),
        `control out request 0x${request.toString(16)}`,
      );
      return `${result.status}, wrote ${result.bytesWritten ?? 0} byte(s)`;
    }
    throw new Error(`unknown command ${JSON.stringify(op)}; enter help for syntax`);
  }
}

function parseConsoleNumber(token: string): number {
  if (/^0x[0-9a-f]+$/i.test(token)) return Number.parseInt(token.slice(2), 16);
  if (/^[0-9]+$/.test(token)) return Number.parseInt(token, 10);
  throw new Error(`invalid number ${JSON.stringify(token)}; use decimal or 0x-prefixed hex`);
}

/**
 * Bounded sample window for the timing percentiles in getStats(). A capture at
 * 32ch@200M completes ~260 transfers/s, so 1024 samples cover the last ~4 s and
 * the buffer can never grow with capture length.
 */
class Ring {
  private readonly values: number[] = [];

  constructor(private readonly capacity: number) {}

  push(value: number): void {
    if (this.values.length === this.capacity) this.values.shift();
    this.values.push(value);
  }

  clear(): void {
    this.values.length = 0;
  }

  percentile(p: number): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  }
}

/**
 * Report for `bench`. The point of the command is the comparison: the line rate the
 * configuration offers against what bare `transferIn` calls actually delivered, with
 * no sink in the path. A capture that runs slower than this number is being slowed
 * down by something the capture does, not by the USB path.
 *
 * A run in `usbmax` mode is the exception to the ratio's meaning: the device is pushing
 * raw bytes at whatever the link takes, so the "expected" figure is only a scale to read
 * the measured rate against, and the verdict line would be comparing two different things
 * (NOTES 8.26).
 */
function formatBench(
  stats: Stats, cfg: CaptureConfig, elapsedMs: number, tuning?: StreamTuning,
): string {
  const expectedMBps = (cfg.samplerate * cfg.channels) / 8 / 1e6;
  const ratio = expectedMBps > 0 ? stats.rawMBps / expectedMBps : 0;
  const raw = (cfg.testMode ?? TEST_MODE_NORMAL) !== TEST_MODE_NORMAL;
  const verdict = raw
    ? 'raw-upload mode: the device is not sampling, so this is the rate the host drained'
    : ratio >= 0.98
    ? 'the bulk pipe sustains the line rate; anything slower is downstream of transferIn'
    : ratio >= 0.9
      ? 'the bulk pipe is slightly short of the line rate'
      : 'the bulk pipe itself is the ceiling here';
  return [
    `${cfg.channels}ch @ ${cfg.samplerate / 1e6} MHz ` +
      `${raw ? 'in test mode ' + cfg.testMode + ' ' : ''}for ${(elapsedMs / 1000).toFixed(2)} s ` +
      `(aborts after ${stats.slowTransferLimit} slow transfers)` +
      (tuning
        ? `, ${tuning.depth} x ${tuning.transferBytes} B in flight ` +
          `(${(tuning.depth * tuning.transferBytes / 1048576).toFixed(1)} MiB)`
        : ''),
    `  bytes      ${stats.rawBytes.toLocaleString()} in ${stats.elapsedMs.toFixed(0)} ms ` +
      `= ${stats.rawMBps.toFixed(1)} MB/s, ${raw ? 'reference' : 'expected'} ` +
      `${expectedMBps.toFixed(0)} MB/s ` +
      `(ratio ${ratio.toFixed(3)})`,
    `  transfers  ${stats.transfers} calls, ${stats.shortTransfers} short, ` +
      `${stats.slowTransfers} slow windows, longest idle gap ${stats.maxIdleGapMs.toFixed(2)} ms`,
    `  transfer   p50 ${stats.transferMsP50.toFixed(3)} ms, p95 ${stats.transferMsP95.toFixed(3)} ms`,
    `  rearm      p50 ${stats.rearmMsP50.toFixed(3)} ms, p95 ${stats.rearmMsP95.toFixed(3)} ms`,
    `  thread     capture thread blocked ${stats.threadStalls} time(s), ` +
      `worst ${stats.threadStallMaxMs.toFixed(1)} ms` +
      ` (budget ${(stats.transferMsP50 * (stats.slowTransferLimit || 1)).toFixed(1)} ms of queue)`,
    `  verdict    ${verdict}`,
  ].join('\n');
}

function formatConsoleBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join(' ');
}

/** Triggers the WebUSB picker. Must be called from a user gesture. */
export async function requestDevice(): Promise<Device> {
  if (!navigator.usb) throw new Error('WebUSB is not available in this browser');
  const usb = await navigator.usb.requestDevice({ filters: USB_FILTERS });
  const dev = new Slogic16U3(usb);
  await dev.open();
  return dev;
}

/**
 * Devices this origin already has permission for. Returns them without a user
 * gesture, so a page can reconnect after the one-time grant.
 */
export async function getGrantedDevices(): Promise<Slogic16U3[]> {
  if (!navigator.usb) throw new Error('WebUSB is not available in this browser');
  const all = await navigator.usb.getDevices();
  return all
    .filter((d) => d.vendorId === USB_VID_SIPEED &&
      (d.productId === PID_SLOGIC16_U3 || d.productId === PID_SLOGIC32_U3))
    .map((d) => new Slogic16U3(d));
}

export { AuxTransaction, RegisterBus };
