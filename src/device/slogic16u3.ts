// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * WebUSB transport for the Sipeed SLogic16 U3.
 *
 * Start/stop sequencing follows the libsigrok driver:
 *   open:  CTRL=reset, CTRL=de-reset            (api.c:1229, called from dev_open)
 *   start: CTRL=stop                            (protocol.c:478)
 *          aux 0x05 test mode                   (api.c:1174, driver only on request)
 *          aux 0x01 channel mask                (api.c:1248)
 *          aux 0x02 samplerate                  (api.c:1297)
 *          aux 0x03 vref                        (api.c:1389)
 *          CTRL=run                             (api.c:1491)
 *   stop:  CTRL=stop                            (api.c:1497)
 */

import type { CaptureConfig, Device, DropoutSink, SampleSink } from './types.js';
import {
  AuxTransaction,
  CTRL_RESET,
  CTRL_RUN,
  CTRL_STOP,
  EP_IN,
  MAX_SAMPLERATE_HZ,
  PID_SLOGIC16_U3,
  RegisterBus,
  SAMPLERATES_HZ,
  SUPPORTED_CHANNELS,
  TEST_MODE_NORMAL,
  USB_VID_SIPEED,
  configureChannels,
  configureSamplerate,
  configureTestMode,
  configureThreshold,
  type TraceEntry,
} from './protocol.js';

export const USB_FILTERS: USBDeviceFilter[] = [
  { vendorId: USB_VID_SIPEED, productId: PID_SLOGIC16_U3 },
];

/** Bytes of junk at the head of every acquisition (protocol.c:117). */
const HEAD_DROP_BYTES = 4;

/** SuperSpeed bulk max packet size; transfer lengths stay a multiple of this. */
const PACKET_BYTES = 1024;

/** How long stop() waits for in-flight transfers before forcing a USB reset. */
const STOP_TIMEOUT_MS = 1500;

export interface StreamTuning {
  /** Outstanding transferIn calls. Fewer than ~4 and the device overruns. */
  depth: number;
  /** Bytes per transferIn. 0 = derive from the sample rate. */
  transferBytes: number;
}

export interface Stats {
  /** Bytes accepted from the endpoint, before the head drop. */
  rawBytes: number;
  /** Bytes handed to the sink, after head drop and expansion. */
  sinkBytes: number;
  transfers: number;
  /** Short transfers, i.e. actual length below the requested length. */
  shortTransfers: number;
  firstByteMs: number | null;
  elapsedMs: number;
  /** Wire rate including start-up latency, MB/s (10^6 bytes/s). */
  rawMBps: number;
  /** Wire rate measured from the first byte on, which is the honest one. */
  steadyMBps: number;
}

export interface StartOptions {
  /** Built-in pattern generator: 0 normal, 1 USB speed test, 2 emulation. */
  testMode?: number;
  tuning?: Partial<StreamTuning>;
}

function assertValidConfig(cfg: CaptureConfig): void {
  if (!(SUPPORTED_CHANNELS as readonly number[]).includes(cfg.channels)) {
    throw new Error(
      `unsupported channel count ${cfg.channels}; the device offers ${SUPPORTED_CHANNELS.join(', ')}`,
    );
  }
  if (!SAMPLERATES_HZ.includes(cfg.samplerate)) {
    throw new Error(
      `unsupported samplerate ${cfg.samplerate} Hz; the device offers ` +
        SAMPLERATES_HZ.map((r) => `${r / 1e6}M`).join(', '),
    );
  }
  const ceiling = MAX_SAMPLERATE_HZ[cfg.channels];
  if (cfg.samplerate > ceiling) {
    throw new Error(
      `${cfg.samplerate / 1e6} MHz exceeds the ${cfg.channels}-channel ceiling of ${ceiling / 1e6} MHz`,
    );
  }
  if (!Number.isFinite(cfg.thresholdVolts)) {
    throw new Error(`threshold must be a number, got ${cfg.thresholdVolts}`);
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

function deriveTuning(cfg: CaptureConfig, want: Partial<StreamTuning>): StreamTuning {
  const wireBytesPerSecond = (cfg.samplerate * cfg.channels) / 8;
  // Roughly 8 ms of data per transfer, packet aligned, kept inside a range
  // Chromium is comfortable with. Too small and the per-transfer IPC dominates;
  // too large and a single stall costs more than the queue can absorb.
  const target = Math.round((wireBytesPerSecond * 0.008) / PACKET_BYTES) * PACKET_BYTES;
  const transferBytes =
    want.transferBytes && want.transferBytes > 0
      ? want.transferBytes
      : Math.min(Math.max(target, 64 * 1024), 1024 * 1024);
  const depth = want.depth && want.depth > 0 ? want.depth : 16;
  if (transferBytes % PACKET_BYTES !== 0) {
    throw new Error(
      `transferBytes ${transferBytes} is not a multiple of the ${PACKET_BYTES}-byte packet size`,
    );
  }
  if (depth < 4) {
    throw new Error(`transfer depth ${depth} is below the 4 the device needs to not overrun`);
  }
  return { depth, transferBytes };
}

export class Slogic16U3 implements Device {
  readonly name: string;
  readonly serial: string;

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
  private cfg: CaptureConfig | null = null;
  private tuning: StreamTuning | null = null;
  private headRemaining = HEAD_DROP_BYTES;
  private sink: SampleSink | null = null;
  private onDropout: DropoutSink | null = null;
  /** Samples handed to the sink since start(), for dropout positions. */
  private samplesDelivered = 0;
  private stats: Stats = Slogic16U3.zeroStats();

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
    this.name = usb.productName ?? 'SLogic16 U3';
    this.serial = usb.serialNumber ?? '';
  }

  private static zeroStats(): Stats {
    return {
      rawBytes: 0,
      sinkBytes: 0,
      transfers: 0,
      shortTransfers: 0,
      firstByteMs: null,
      elapsedMs: 0,
      rawMBps: 0,
      steadyMBps: 0,
    };
  }

  getStats(): Stats {
    return { ...this.stats };
  }

  private trace(e: TraceEntry): void {
    this.onTrace?.(e);
  }

  /** Open, claim interface 0 and put the device in a known state. */
  async open(): Promise<void> {
    if (!this.usb.opened) await this.usb.open();
    if (this.usb.configuration === null) await this.usb.selectConfiguration(1);
    await this.usb.claimInterface(0);

    this.bus = new RegisterBus(this.usb, (e) => this.trace(e));
    // dev_open() resets before anything else; without it a device left running
    // by a previous host keeps streaming into the endpoint and the head drop
    // lands in the middle of the old stream.
    await this.bus.writeCtrl(CTRL_RESET);
    await this.bus.writeCtrl(CTRL_STOP);
    this.trace({ dir: 'info', note: 'device reset, interface 0 claimed' });
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
    cfg: CaptureConfig, sink: SampleSink, onDropout?: DropoutSink, opts: StartOptions = {},
  ): Promise<void> {
    if (this.running) throw new Error('start() called while already running');
    assertValidConfig(cfg);
    if (!this.bus) throw new Error('start() called before open()');
    const bus = this.bus;

    this.cfg = cfg;
    this.sink = sink;
    this.onDropout = onDropout ?? null;
    this.tuning = deriveTuning(cfg, opts.tuning ?? {});
    this.stats = Slogic16U3.zeroStats();
    this.samplesDelivered = 0;
    this.headRemaining = HEAD_DROP_BYTES;
    this.loopError = null;
    this.stopping = false;

    // Order matters and matches the driver.
    await bus.writeCtrl(CTRL_STOP);
    // The driver only touches the pattern register when the frontend asks for a
    // pattern, which means a device left in "Emulation" by a previous session
    // stays there. Program it explicitly so a capture is never silently fake.
    await configureTestMode(bus, opts.testMode ?? TEST_MODE_NORMAL, (e) => this.trace(e));
    await configureChannels(bus, cfg.channels, (e) => this.trace(e));
    await configureSamplerate(bus, cfg.samplerate, (e) => this.trace(e));
    await configureThreshold(bus, cfg.thresholdVolts, (e) => this.trace(e));

    const started = performance.now();
    // Only claim to be running once the device has accepted the run command.
    // Setting the flag first would leave stop() believing there is a read loop
    // to wait for when the run write is what failed.
    await bus.writeCtrl(CTRL_RUN);
    this.running = true;
    this.trace({
      dir: 'info',
      note:
        `running: ${cfg.channels}ch @ ${cfg.samplerate / 1e6} MHz, ` +
        `${this.tuning.depth} x ${this.tuning.transferBytes} B in flight`,
    });

    // readLoop() already reported the failure; keep the rejection off the
    // unhandled-rejection path and let stop() re-throw it to the caller.
    this.loopDone = this.readLoop(started).catch(() => {});
  }

  /**
   * Keep `depth` transferIn calls outstanding at all times. Bulk IN transfers
   * on one endpoint complete in submission order, so the replacement transfer
   * is queued before the oldest one is awaited: the queue never drains below
   * `depth` while running, which is what stops the device overrunning.
   */
  private async readLoop(started: number): Promise<void> {
    const { depth, transferBytes } = this.tuning!;
    const pending: Promise<USBInTransferResult>[] = [];
    let bytesAtFirstByte = 0;

    for (let i = 0; i < depth; i++) pending.push(this.usb.transferIn(EP_IN, transferBytes));

    try {
      while (this.running) {
        const oldest = pending.shift()!;
        if (this.running) pending.push(this.usb.transferIn(EP_IN, transferBytes));


        let r: USBInTransferResult;
        try {
          r = await oldest;
        } catch (e) {
          // stop() releases the interface, which cancels transfers still in
          // flight. That rejection is the normal end of a run; anything else is
          // a real failure and must propagate.
          if (this.stopping) {
            this.trace({ dir: 'info', note: `read loop ended on cancellation: ${e}` });
            break;
          }
          throw e;
        }
        if (r.status !== 'ok') {
          // 'stall' and 'babble' are hard errors; the device is out of sync and
          // nothing after this point can be trusted.
          throw new Error(`bulk IN returned status "${r.status}"`);
        }
        const data = r.data;
        if (!data) throw new Error('bulk IN returned no data with status "ok"');

        const now = performance.now();
        if (this.stats.firstByteMs === null && data.byteLength > 0) {
          this.stats.firstByteMs = now - started;
          bytesAtFirstByte = this.stats.rawBytes + data.byteLength;
        }
        this.stats.transfers += 1;
        this.stats.rawBytes += data.byteLength;
        const missingRaw = data.byteLength < transferBytes ? transferBytes - data.byteLength : 0;
        if (missingRaw > 0) this.stats.shortTransfers += 1;
        this.stats.elapsedMs = now - started;
        this.stats.rawMBps =
          this.stats.elapsedMs > 0 ? this.stats.rawBytes / this.stats.elapsedMs / 1000 : 0;
        const steadyMs = this.stats.elapsedMs - (this.stats.firstByteMs ?? 0);
        this.stats.steadyMBps =
          steadyMs > 0 ? (this.stats.rawBytes - bytesAtFirstByte) / steadyMs / 1000 : 0;

        this.deliver(data);

        // A transfer the device could not fill mid-run means samples were lost:
        // everything after it is shifted relative to device time. Reported AFTER
        // deliver() on purpose - the short transfer still carries real samples,
        // and the shortfall is at its END, so the discontinuity sits at the
        // sample position the transfer finishes on. Reporting before delivery
        // put it one whole transfer too early (up to 128k samples at 16ch).
        //
        // The final transfer of a run is also short (the device stops before the
        // host's last request) - that one is the normal end, not a dropout, so it
        // is only reported while the run is actually continuing.
        if (missingRaw > 0 && !this.stopping) {
          // Wire bytes to samples: 16ch is 2 bytes/sample, 8ch 1, 4ch packs two
          // samples per wire byte. The floor drops a possible half sample at
          // 16ch - the gap is marked untrusted either way.
          const missingSamples = Math.floor((missingRaw * 8) / this.cfg!.channels);
          this.trace({
            dir: 'info',
            note: `short transfer at sample ${this.samplesDelivered}: ${missingSamples} samples lost`,
          });
          this.onDropout?.(this.samplesDelivered, missingSamples);
        }
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
      throw e;
    } finally {
      // Every outstanding transfer has to be settled before the interface can
      // be released, and none of them may be dropped silently.
      await this.drain(pending);
    }
  }

  /**
   * Head drop, sub-8-channel expansion and hand-off to the sink. Shared by the
   * read loop and by drain(), so data that arrived in an already-submitted
   * transfer is not thrown away at stop() time.
   */
  private deliver(data: DataView): void {
    let bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    // Drop the junk head once per acquisition, carrying the remainder to the
    // next transfer if this one was shorter than the drop.
    if (this.headRemaining > 0) {
      const drop = Math.min(this.headRemaining, bytes.length);
      bytes = bytes.subarray(drop);
      this.headRemaining -= drop;
      if (bytes.length === 0) return;
    }

    const out = expandPacked(bytes, this.cfg!.channels);
    this.stats.sinkBytes += out.length;
    this.samplesDelivered += out.length / (this.cfg!.channels === 16 ? 2 : 1);
    this.sink?.(out);
  }

  /**
   * Settle every transfer that is still outstanding. Transfers that already
   * carry data are delivered - at 16 x 1 MiB in flight, discarding them would
   * silently lose up to 16 MB off the tail of every capture, which a caller
   * doing "start, wait for N samples, stop" would never see.
   */
  private async drain(pending: Promise<USBInTransferResult>[]): Promise<void> {
    const results = await Promise.allSettled(pending);
    const failures: unknown[] = [];

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { status, data } = r.value;
        if (status === 'ok' && data && data.byteLength > 0) {
          this.stats.transfers += 1;
          this.stats.rawBytes += data.byteLength;
          this.deliver(data);
        } else if (status !== 'ok') {
          failures.push(new Error(`bulk IN returned status "${status}" while draining`));
        }
      } else if (this.stopping) {
        // Expected: releaseInterface() cancels transfers still in flight.
        this.trace({ dir: 'info', note: `pending transfer cancelled on stop: ${r.reason}` });
      } else {
        failures.push(r.reason);
      }
    }

    // One unplug rejects every outstanding transfer. Report the cause once,
    // with a count, instead of firing onError `depth` times with the same
    // error.
    if (failures.length > 0) {
      console.error(
        `[slogic] ${failures.length} pending transfer(s) failed while draining:`,
        failures[0],
      );
      this.onError?.(failures[0]);
    }
  }

  async stop(): Promise<void> {
    const loopDone = this.loopDone;
    if (!loopDone) {
      // Nothing was ever started, or it already stopped. Still make sure the
      // device is not left streaming.
      this.running = false;
      if (this.bus) await this.bus.writeCtrl(CTRL_STOP);
      return;
    }
    this.running = false;
    this.stopping = true;

    /*
     * Everything from here to the teardown of the read loop runs under
     * try/finally. Unplug the device mid-capture and the CTRL_STOP write below
     * rejects with a NetworkError; without the finally, releaseInterface() would
     * never run, loopDone would never be cleared and `stopping` would stay set,
     * so the object would be permanently wedged and the caller would be handed
     * the control-write error instead of the actual cause from the read loop.
     */
    let teardownError: unknown = null;
    try {
      if (this.bus) await this.bus.writeCtrl(CTRL_STOP);
    } catch (e) {
      // Worth surfacing, but it must not pre-empt the real failure.
      console.warn('[slogic] CTRL stop write failed during stop():', e);
      teardownError = e;
    }

    try {
      // A transferIn that the device never fills would never settle - WebUSB
      // has no transfer timeout. Releasing the interface cancels them; it is
      // re-claimed below.
      try {
        await this.usb.releaseInterface(0);
      } catch (e) {
        console.warn('[slogic] releaseInterface during stop:', e);
      }

      // Belt and braces: if releasing the interface did not settle the
      // outstanding transfers, a device reset definitely will. Without this a
      // single un-settled transferIn hangs stop() forever, and silently.
      const settled = await Promise.race([
        loopDone.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), STOP_TIMEOUT_MS)),
      ]);
      if (!settled) {
        console.warn(
          `[slogic] read loop still had transfers in flight ${STOP_TIMEOUT_MS} ms after ` +
            'releaseInterface(); resetting the device to cancel them',
        );
        try {
          await this.usb.reset();
        } catch (e) {
          console.warn('[slogic] reset during stop:', e);
        }
        await loopDone;
      }

      try {
        await this.usb.claimInterface(0);
      } catch (e) {
        // A gone device cannot be re-claimed. start() would fail anyway, and
        // loudly; do not mask the read loop's error with this one.
        console.warn('[slogic] could not re-claim interface 0 after stop:', e);
      }
    } finally {
      this.loopDone = null;
      this.stopping = false;
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
    .filter((d) => d.vendorId === USB_VID_SIPEED && d.productId === PID_SLOGIC16_U3)
    .map((d) => new Slogic16U3(d));
}

export { AuxTransaction, RegisterBus };
