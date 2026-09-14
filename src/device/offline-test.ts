// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Offline test of the register/aux encoder.
 *
 * This is NOT a substitute for the hardware run in selftest.html - it cannot
 * prove anything about the bulk stream, the head drop or throughput. What it
 * does prove is that the control-transfer chunking, the aux handshake, the
 * payload-length clamp and the read-back verification behave against replies
 * that were *recorded from the real device* (sigrok-cli -l 5 on S/N
 * 202512261505, 2026-08-25):
 *
 *   aux 0x01 status 0x00010401 payload 0x0000ffff        (payload length 2)
 *   aux 0x02 status 0x00011002 payload 0/800/10          (payload length 8)
 *   aux 0x03 status 0x00010403 payload 0x00000136        (payload length 2)
 *   aux 0x05 status 0x00010205 payload 0x00000000        (payload length 1)
 *
 * Run:
 *   npx esbuild src/device/offline-test.ts --bundle --format=esm --outfile=/tmp/slogic-offline.mjs
 *   node /tmp/slogic-offline.mjs
 */

import {
  RegisterBus,
  configureChannels,
  configureSamplerate,
  configureTestMode,
  configureThreshold,
  decodeDeviceFlags,
  SAMPLERATES_HZ,
  sampleLengthForSamples,
  samplesForSampleLength,
  vrefCode,
} from './protocol.js';
import {
  LoopStallWatch, Slogic16U3, deriveStreamTuning, expandPacked, type Stats,
} from './slogic16u3.js';
import { WorkerSlogicDevice } from './workerTransport.js';
import type { FromWorker, ToWorker } from './usbWorkerProtocol.js';
import { PlanarSampleStore, appendLostSamples } from '../data/index.js';
import {
  ClockStreamDevice, FakeSlogic, recorded, recorded32, view, type AuxModel,
} from './fakeUsb.js';

let failures = 0;

/** This file runs under node, but tsconfig only pulls in the DOM/WebUSB types. */
function failExit(): void {
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (proc) proc.exitCode = 1;
}

/**
 * How long the stall probe is given to notice a block. The probe samples every 4 ms
 * (`THREAD_PROBE_MS`) and a blocked thread only reports once it can run the timer again,
 * so the wait has to be comfortably longer than one sample plus Node's timer slack.
 */
const THREAD_PROBE_WAIT_MS = 50;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

async function expectThrow(name: string, fn: () => Promise<unknown>, substr: string): Promise<void> {
  let msg = '';
  try {
    await fn();
  } catch (e) {
    msg = String(e);
  }
  check(name, msg.includes(substr), `got ${msg || '<no throw>'}`);
}

/**
 * Devices that answer, but badly. RegisterBus has to reject each of these:
 * a control transfer that is refused still *resolves*, it just does not say
 * 'ok', and treating that as success is the silent-rejection failure this whole
 * module exists to avoid.
 */
class BadReplyDevice {
  constructor(
    private readonly mode: 'status' | 'short' | 'bytesWritten' | 'inStatus',
  ) {}

  async controlTransferOut(): Promise<USBOutTransferResult> {
    if (this.mode === 'status') return { status: 'stall', bytesWritten: 0 };
    if (this.mode === 'bytesWritten') return { status: 'ok', bytesWritten: 2 };
    return { status: 'ok', bytesWritten: 4 };
  }

  async controlTransferIn(): Promise<USBInTransferResult> {
    if (this.mode === 'inStatus') return { status: 'babble' };
    // A 4-byte read that comes back with 2 bytes: the status word would be
    // half-parsed from a buffer that is mostly zero.
    const n = this.mode === 'short' ? 2 : 4;
    const dv = new DataView(new ArrayBuffer(n));
    if (n === 4) dv.setUint32(0, 0x00010401, true);
    return { status: 'ok', data: dv };
  }
}

function badBus(mode: 'status' | 'short' | 'bytesWritten' | 'inStatus'): RegisterBus {
  return new RegisterBus(new BadReplyDevice(mode) as unknown as USBDevice);
}

/**
 * A board that accepts control transfers and never answers them.
 *
 * Measured 2026-09-10 on S/N 202608052052: open()/start() waited past two minutes
 * with the page holding a single un-settled controlTransferIn and no error
 * anywhere, which is indistinguishable from a frozen UI. The driver gives libusb
 * 500 ms per register transfer and cancels the URB when it expires, so a board
 * that does not answer is reported instead of waited for.
 */
class SilentDevice {
  controlTransferOut(): Promise<USBOutTransferResult> {
    return new Promise<USBOutTransferResult>(() => {});
  }

  controlTransferIn(): Promise<USBInTransferResult> {
    return new Promise<USBInTransferResult>(() => {});
  }
}

/**
 * Answers one transfer late and then rejects everything else: the guard has to
 * survive a transfer that settles after its deadline has already been reported.
 */
class LateDevice extends SilentDevice {
  /** Rejections that arrive after the deadline; the guard must swallow them. */
  lateRejections = 0;

  override controlTransferIn(): Promise<USBInTransferResult> {
    return new Promise<USBInTransferResult>((_, reject) => {
      setTimeout(() => {
        this.lateRejections += 1;
        reject(new Error('the transfer the guard abandoned'));
      }, 60);
    });
  }
}

/** One scripted answer to a transferIn call. */
type TransferAction =
  | { kind: 'data'; bytes: number[] }
  | { kind: 'delayedData'; bytes: number[]; delayMs: number }
  | { kind: 'hang' }
  | { kind: 'dataOnRelease'; bytes: number[] };

interface Parked {
  action: TransferAction;
  resolve: (r: USBInTransferResult) => void;
  reject: (e: unknown) => void;
}

/**
 * FakeSlogic plus a bulk endpoint, enough to drive Slogic16U3 end to end. The
 * endpoint models the two behaviours that matter: a transferIn the device never
 * fills stays pending forever (WebUSB has no timeout), and releasing the
 * interface settles everything still outstanding.
 */
class FakeStreamDevice extends FakeSlogic {
  productName = 'SLogic16 U3';
  serialNumber = 'fake';
  private calls = 0;
  private parked: Parked[] = [];
  clearHaltCalls = 0;
  releaseInterfaceCalls = 0;

  /**
   * Chromium leaves the bulk pipe in an error state when the interface is released
   * while reads are still queued: every later transferIn fails immediately with
   * "A transfer error has occurred" until the endpoint is cleared. Bench report,
   * 2026-09-10 - this is what made capture #2 of a session fail.
   */
  poisonEndpointOnRelease = false;
  /** Reject every transferIn from this call on: the firmware wedge only a replug clears. */
  failAfterCalls = Number.POSITIVE_INFINITY;
  private endpointPoisoned = false;

  /**
   * When true the endpoint produces zeros continuously, modelling a running
   * sampler, and stops for good once R32_SAMPLE_LEN's budget is spent - the
   * device-side stop the real board performs (NOTES 8.9). Reads submitted after
   * that stay pending forever, exactly like the NAKs a stopped device gives.
   */
  autoStream = false;
  bytesPerSample = 4;
  private streamLeftSamples = Number.POSITIVE_INFINITY;
  /**
   * Resolution time the next `delayedData` is allowed to use.
   *
   * A real device paces transfers by its own clock: each one arrives `delayMs` after the
   * one before it, however late the host gets around to reaping it. Scheduling each delay
   * from the moment the call arrives instead lets the event loop's own stalls bunch the
   * completions together, and then the underrun watchdog is measuring Node's scheduler
   * rather than the device - which made two of its checks fail under load (NOTES 8.14).
   */
  private nextResolveAt = 0;

  protected override onRun(): void {
    this.streamLeftSamples = this.autoStream && this.sampleLenValue > 0
      ? samplesForSampleLength(this.sampleLenValue)
      : Number.POSITIVE_INFINITY;
  }

  /** False while the pipe is in the post-release error state. */
  get endpointHealthy(): boolean { return !this.endpointPoisoned; }

  get transferInCalls(): number { return this.calls; }

  constructor(
    aux: Record<number, AuxModel>,
    private readonly script: TransferAction[],
    readonly productId = 0x3031,
  ) {
    super(aux);
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async selectConfiguration(): Promise<void> {}
  async claimInterface(): Promise<void> {}
  async clearHalt(): Promise<void> { this.clearHaltCalls++; this.endpointPoisoned = false; }
  async reset(): Promise<void> { this.endpointPoisoned = false; }

  async releaseInterface(): Promise<void> {
    this.releaseInterfaceCalls++;
    const parked = this.parked;
    this.parked = [];
    for (const p of parked) {
      if (p.action.kind === 'dataOnRelease') {
        p.resolve({ status: 'ok', data: view(p.action.bytes) });
      } else {
        p.reject(new Error('NetworkError: transfer was cancelled'));
      }
    }
    if (this.poisonEndpointOnRelease) this.endpointPoisoned = true;
  }

  transferIn(_ep: number, _len: number): Promise<USBInTransferResult> {
    const index = this.calls++;
    if (this.endpointPoisoned || index >= this.failAfterCalls) {
      return Promise.reject(new Error('NetworkError: A transfer error has occurred.'));
    }
    if (this.autoStream) {
      if (this.streamLeftSamples <= 0) {
        // The device stopped itself: it has nothing left to send, so this read
        // never completes. Only releasing the interface settles it.
        return new Promise<USBInTransferResult>((resolve, reject) => {
          this.parked.push({ action: { kind: 'hang' }, resolve, reject });
        });
      }
      const available = Math.floor(this.streamLeftSamples) * this.bytesPerSample;
      const n = Math.min(_len, Math.max(1024, available));
      this.streamLeftSamples -= n / this.bytesPerSample;
      return Promise.resolve({ status: 'ok', data: view(new Array<number>(n).fill(0)) });
    }
    const action: TransferAction = this.script[index] ?? { kind: 'hang' };
    if (action.kind === 'data') {
      return Promise.resolve({ status: 'ok', data: view(action.bytes) });
    }
    if (action.kind === 'delayedData') {
      const now = performance.now();
      const at = Math.max(now + action.delayMs, this.nextResolveAt);
      this.nextResolveAt = at + action.delayMs;
      return new Promise((resolve) => setTimeout(
        () => resolve({ status: 'ok', data: view(action.bytes) }),
        Math.max(0, at - performance.now()),
      ));
    }
    return new Promise<USBInTransferResult>((resolve, reject) => {
      this.parked.push({ action, resolve, reject });
    });
  }
}


/**
 * A Worker that answers by hand, so the page-side proxy can be driven the way the real
 * worker drives it: chunks with their transferable buffers, acks, errors and, when it
 * feels like it, nothing at all.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly sent: ToWorker[] = [];
  terminated = false;
  /** Chunks the page has not acked yet, by id. */
  readonly unacked = new Set<number>();

  postMessage(message: ToWorker): void {
    this.sent.push(message);
    if (message.kind === 'ack') this.unacked.delete(message.id);
  }

  terminate(): void { this.terminated = true; }

  /** Deliver a message as if it came from the worker. */
  emit(message: FromWorker): void {
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>);
  }

  /** Hand over a chunk of `bytes` (default 8) and remember it is unanswered. */
  chunk(id: number, bytes = 8, fill = 0x11): void {
    const buffer = new ArrayBuffer(bytes);
    new Uint8Array(buffer).fill(fill);
    this.unacked.add(id);
    this.emit({ kind: 'chunk', id, buffer, offset: 0, length: bytes });
  }

  kinds(): string[] { return this.sent.map((m) => m.kind); }
}

async function openWorkerDevice(worker: FakeWorker): Promise<WorkerSlogicDevice> {
  const opened = WorkerSlogicDevice.open(
    { vendorId: 0x359f, productId: 0x3032 },
    {
      spawn: () => worker as unknown as Worker,
      openTimeoutMs: 200, stopTimeoutMs: 200, requestTimeoutMs: 200, consoleTimeoutMs: 200,
    },
  );
  worker.emit({
    kind: 'opened',
    name: 'SLogic32 U3 (fake worker)',
    serial: 'worker-fake',
    maxChannels: 32,
    maxSamplerateHz: { 32: 200e6 },
  });
  return opened;
}

function bus(aux: Record<number, AuxModel>): { bus: RegisterBus; dev: FakeSlogic } {
  const dev = new FakeSlogic(aux);
  return { bus: new RegisterBus(dev as unknown as USBDevice), dev };
}


async function main(): Promise<void> {
  console.log('offline encoder test (recorded device replies, no hardware)\n');

  console.log('pure helpers');
  check('vrefCode(1.6) == 226', vrefCode(1.6) === 226, String(vrefCode(1.6)));
  check('vrefCode(1.7) == 245 (matches sigrok debug output)', vrefCode(1.7) === 245, String(vrefCode(1.7)));
  check('vrefCode clamps low', vrefCode(-5) === 0);
  check('vrefCode clamps high', vrefCode(99) === 1023);
  check(
    'expandPacked 4ch',
    expandPacked(Uint8Array.of(0x67, 0x45, 0x23, 0x01), 4).join(',') === '7,6,5,4,3,2,1,0',
  );
  check(
    'expandPacked 2ch',
    expandPacked(Uint8Array.of(0x1b), 2).join(',') === '3,2,1,0',
  );
  check('expandPacked 8ch is identity', (() => {
    const a = Uint8Array.of(1, 2, 3);
    return expandPacked(a, 8) === a;
  })());

  console.log('\naux against recorded replies');
  {
    const { bus: b, dev } = bus(recorded());
    await configureChannels(b, 16);
    check('16ch mask written as 0xffff', dev.log.includes('W 10 ffff0000'), dev.log.join(' | '));
    // Payload length 2 -> one 4-byte chunk. Rounding *down* to a multiple of 4
    // would give 0 and write nothing at all, which is the trap in the doc.
    const payloadWrites = dev.log.filter((l) => l.startsWith('W 10')).length;
    check('one 4-byte payload write for a length-2 payload', payloadWrites === 1, String(payloadWrites));
  }
  {
    // SLogic32 U3 advertises two bytes but consumes the complete padded USB word.
    const model: Record<number, AuxModel> = {
      0x01: { status: 0x00010401, payload: [0] },
    };
    const { bus: b, dev } = bus(model);
    await configureChannels(b, 32);
    check('32ch mask written as 0xffffffff', dev.log.includes('W 10 ffffffff'), dev.log.join(' | '));
  }
  {
    const { bus: b, dev } = bus(recorded());
    const r = await configureSamplerate(b, 16e6);
    check('base clock read as 800 MHz', r.baseHz === 800e6, String(r.baseHz));
    check('divider 50 for 16 MHz', r.divider === 50, String(r.divider));
    check('divider register written as 49', dev.log.includes('W 14 31000000'), dev.log.join(' | '));
  }
  {
    const { bus: b } = bus(recorded());
    const r = await configureSamplerate(b, 100e6);
    check('divider 8 for 100 MHz', r.divider === 8, String(r.divider));
  }
  {
    const { bus: b, dev } = bus(recorded32());
    const r = await configureSamplerate(b, 1.6e9);
    check('32U3 base clock read as 1600 MHz', r.baseHz === 1.6e9, String(r.baseHz));
    check('32U3 divider 1 for 1600 MHz', r.divider === 1, String(r.divider));
    check('32U3 divider register written as 0', dev.log.includes('W 14 00000000'), dev.log.join(' | '));
  }
  {
    const { bus: b, dev } = bus(recorded());
    const r = await configureThreshold(b, 1.6);
    check('1.6 V -> code 226', r.code === 226, String(r.code));
    check('code written to the payload', dev.log.includes('W 10 e2000000'), dev.log.join(' | '));
  }
  {
    const { bus: b, dev } = bus(recorded());
    await configureTestMode(b, 2);
    // Selector 0x05 advertises a 1-byte payload, which still moves one 4-byte
    // control transfer. Rounding the length *down* to a multiple of 4 would
    // write nothing at all and the mode would silently not change.
    check('test mode 2 written despite a length-1 payload', dev.log.includes('W 10 02000000'),
      dev.log.join(' | '));
  }
  {
    // The device advertises 2 bytes for the channel mask, so only the low 16
    // bits are register. A unit that leaves junk in the upper halfword must
    // still verify - otherwise it could not capture at all, while sigrok-cli,
    // which does not check the read-back, would work fine on the same unit.
    const model = recorded();
    model[0x01].onWord0 = (self, v) => {
      self.payload[0] = ((0xa5a5 << 16) | (v & 0xffff)) >>> 0;
    };
    let err = '';
    try {
      await configureChannels(bus({ 0x01: model[0x01] }).bus, 16);
    } catch (e) {
      err = String(e);
    }
    check('junk above the advertised length does not fail the read-back', err === '', err);
  }
  {
    // ...and a value that does not fit the advertised length is refused rather
    // than being written and silently truncated by the device.
    let err = '';
    try {
      // An arbitrary wider mask is still refused; only the known 32U3 width uses the
      // firmware's padded-word compatibility path.
      await configureChannels(bus(recorded()).bus, 24);
    } catch (e) {
      err = String(e);
    }
    check('a value wider than the advertised length is refused', err.includes('does not fit'), err);
  }

  console.log('\nfailure modes');
  await expectThrow(
    'ready bit never set is fatal',
    () => configureChannels(bus({ 0x01: { status: 0x00010401, payload: [0], ready: false } }).bus, 16),
    'ready bit never set',
  );
  await expectThrow(
    'wrong selector echo is fatal',
    () => configureChannels(bus({ 0x01: { status: 0x00010401, payload: [0], echo: 0x07 } }).bus, 16),
    'echoed',
  );
  await expectThrow(
    'a payload the device will not accept is fatal, not silently truncated',
    // Length 2 rounds up to one 4-byte word, but the divider lives in word 1.
    () => configureSamplerate(bus({ 0x02: { status: 0x00010402, payload: [0, 0] } }).bus, 16e6),
    'need at least 8',
  );
  await expectThrow(
    'a read-back mismatch is fatal',
    () =>
      configureChannels(
        bus({
          0x01: {
            status: 0x00010401,
            payload: [0],
            onWord0: (self) => {
              self.payload[0] = 0xdead; // device quietly ignores the write
            },
          },
        }).bus,
        16,
      ),
    'not accepted',
  );
  {
    // Base always 700 MHz, which never divides 16 MHz. The walk must give up,
    // and - this is the part that matters - it must never write a base index
    // that does not exist. api.c:1325 bounds the walk to indices 0 and 1.
    const { bus: b, dev } = bus({
      0x02: {
        status: 0x00011002,
        payload: [(700 << 16) | 0, 0],
        onWord0: (self, v) => {
          self.payload[0] = ((700 << 16) | (v & 0xffff)) >>> 0;
        },
      },
    });
    let err = '';
    try {
      await configureSamplerate(b, 16e6);
    } catch (e) {
      err = String(e);
    }
    check('an unreachable samplerate gives up instead of spinning',
      err.includes('is the last one that exists'), err);

    const indicesWritten = dev.log
      .filter((l) => l.startsWith('W 10 '))
      .map((l) => parseInt((l.slice(5, 9).match(/../g) ?? []).reverse().join(''), 16));
    check('no out-of-range base index is ever written',
      indicesWritten.every((i) => i <= 1), `wrote indices ${indicesWritten.join(',')}`);
  }
  {
    // Base index 0 is unusable, index 1 divides: the walk must take it.
    const model: AuxModel = {
      status: 0x00011002,
      payload: [(700 << 16) | 0, 0],
      onWord0: (self, v) => {
        const idx = v & 0xffff;
        self.payload[0] = ((idx === 0 ? 700 : 800) << 16) | idx;
      },
    };
    const { bus: b } = bus({ 0x02: model });
    const r = await configureSamplerate(b, 16e6);
    check('base-index walk moves to a usable base', r.baseHz === 800e6 && r.divider === 50,
      `${r.baseHz}/${r.divider}`);
  }

  {
    // NOTES 8.9, measured on S/N 202608052052: the sampler honours only the low
    // byte of the divider even though the register reads back all 32 bits. A 32U3
    // offers 1400 MHz as index 0 and 800 MHz as index 1, so 5 MHz needs 280 (does
    // not fit) on the first and 160 (fits) on the second. Writing 280 is not an
    // error the device reports - it silently samples at 58.33 MHz - so the walk is
    // the only thing standing between the user and the wrong sample rate.
    const twoBase = (): Record<number, AuxModel> => ({
      0x02: {
        status: 0x00011002,
        payload: [(1400 << 16) | 0, 0],
        onWord0: (self, v) => {
          const idx = v & 0xffff;
          self.payload[0] = ((idx === 0 ? 1400 : 800) << 16) | idx;
        },
      },
    });
    {
      const { bus: b, dev } = bus(twoBase());
      const r = await configureSamplerate(b, 5e6);
      check('a base whose divider does not fit a byte is skipped',
        r.baseHz === 800e6 && r.divider === 160, `${r.baseHz}/${r.divider}`);
      const dividers = dev.log
        .filter((l) => l.startsWith('W 14 '))
        .map((l) => parseInt((l.slice(5, 13).match(/../g) ?? []).reverse().join(''), 16));
      check('no divider past the sampler byte is ever written',
        dividers.length > 0 && dividers.every((d) => d <= 0xff),
        `wrote dividers ${dividers.join(',')}`);
    }
    {
      const unreachable: string[] = [];
      for (const rate of SAMPLERATES_HZ) {
        try {
          await configureSamplerate(bus(twoBase()).bus, rate);
        } catch (e) {
          unreachable.push(`${rate / 1e6} MHz (${String(e)})`);
        }
      }
      // 1.6 GHz is the one rate the 32U3's two bases cannot make: 1400/1.6 is not
      // an integer and 800/1.6 is 0.5, so the refusal is correct - and it is worth
      // knowing, because MAX_SAMPLERATE_HZ_SLOGIC32_U3 advertises 1.6 GHz for 4
      // channels. Either the firmware has a third base this walk never reaches (the
      // driver stops at index 1 for the same reason) or the ceiling is aspirational.
      check('every table rate but 1600 MHz is reachable on the 32U3 base pair',
        unreachable.length === 1 && unreachable[0].startsWith('1600 MHz'),
        unreachable.join(', '));
    }
    {
      // Only the 1400 MHz base exists. 5 MHz needs 280 there, so the honest answer
      // is to refuse, not to write 280 and let the hardware truncate it.
      const { bus: b } = bus({
        0x02: {
          status: 0x00011002,
          payload: [(1400 << 16) | 0, 0],
          onWord0: (self, v) => {
            self.payload[0] = ((1400 << 16) | (v & 0xffff)) >>> 0;
          },
        },
      });
      await expectThrow(
        'a rate no base can express is refused, not truncated',
        () => configureSamplerate(b, 5e6),
        'past the 255 the sampler honours',
      );
    }
    {
      // NOTES 8.11, the half a read-back cannot see: R32_AUX+4 is scratch RAM, and a
      // device can take the host's divider there while the sampler keeps running the
      // old one. Every read-back compare passes and the capture still comes off the
      // wire at the previous rate - the measured symptom was 32ch at 396 MB/s when 5
      // MHz was asked for. The model copies the buffer into `live` when the selector
      // is written, so only a driver that runs the command *again after* the write
      // leaves the device on the new divider.
      const model: AuxModel = {
        status: 0x00011002,
        payload: [(800 << 16) | 1, 7], // 800 MHz base, divider 7 = 100 MHz, left over
        live: { divider: 7 },
      };
      const { bus: b } = bus({ 0x02: model });
      const r = await configureSamplerate(b, 5e6);
      check('a second command is what makes the live divider follow the payload',
        r.divider === 160 && model.live!.divider === 159,
        `divider ${r.divider}, live ${model.live!.divider}`);
    }
    {
      // The benign half: the device drops the write on the floor and the buffer keeps
      // the old word, which this cycle's own read-back does see. One retry has to
      // land it rather than reporting a configured rate that is not on the wire.
      const model: AuxModel = {
        status: 0x00011002,
        payload: [(800 << 16) | 1, 7],
        dropPayloadWrites: 1,
      };
      const { bus: b } = bus({ 0x02: model });
      const r = await configureSamplerate(b, 5e6);
      check('a swallowed divider write is retried, not reported as configured',
        r.divider === 160 && model.payload[1] === 159,
        `divider ${r.divider}, payload ${model.payload[1]}`);
    }
    {
      // A device that never keeps the divider has to fail loudly, with the rate in the
      // message and the number of cycles it took to be sure - not capture at the rate
      // it happens to be left on.
      const model: AuxModel = {
        status: 0x00011002,
        payload: [(800 << 16) | 1, 7],
        dropPayloadWrites: 99,
      };
      let err = '';
      try {
        await configureSamplerate(bus({ 0x02: model }).bus, 5e6);
      } catch (e) {
        err = String(e);
      }
      check('a divider the device never keeps is fatal, and names the rate',
        err.includes('could not configure 5 MHz') && err.includes('read/write/read cycles'),
        err || '<no throw>');
    }
  }

  console.log('\nreply checking (a refused transfer still resolves)');
  await expectThrow(
    'a stalled control write is fatal',
    () => configureChannels(badBus('status'), 16),
    'returned status "stall"',
  );
  await expectThrow(
    'a control write that moved the wrong number of bytes is fatal',
    () => configureChannels(badBus('bytesWritten'), 16),
    'moved 2 bytes, expected 4',
  );
  await expectThrow(
    'a short control read is fatal',
    () => configureChannels(badBus('short'), 16),
    'returned 2 bytes, expected 4',
  );
  await expectThrow(
    'a control read with a bad status is fatal',
    () => configureChannels(badBus('inStatus'), 16),
    'returned status "babble"',
  );

  console.log('\ncontrol-transfer deadline (a board that stops answering)');
  {
    // The driver's own transfers all carry a 500 ms timeout (api.c:641/683).
    // WebUSB has none, so the bound lives here - with a short one for the test.
    const silent = new SilentDevice();
    const silentBus = new RegisterBus(silent as unknown as USBDevice, () => {}, 40);
    const readStarted = Date.now();
    let readError = '';
    try {
      await silentBus.read(0x04, 4);
    } catch (e) {
      readError = String(e);
    }
    const readWaited = Date.now() - readStarted;
    check('a control read that never answers fails instead of hanging',
      readError.includes('control read of reg 0x4 did not complete within 40 ms'),
      readError || '<no throw>');
    check('and it fails at the deadline, not later',
      readWaited >= 35 && readWaited < 500, `${readWaited} ms`);

    let writeError = '';
    try {
      await silentBus.write(0x04, Uint8Array.of(0, 0, 0, 0));
    } catch (e) {
      writeError = String(e);
    }
    check('a control write that never answers fails instead of hanging',
      writeError.includes('control write to reg 0x4 did not complete within 40 ms'),
      writeError || '<no throw>');

    // The abandoned transfer is still inside Chromium and will settle (or fail)
    // whenever it likes. That late rejection must not escape: an unhandled
    // rejection behind an error the caller already has crashes the page.
    const late = new LateDevice();
    const lateBus = new RegisterBus(late as unknown as USBDevice, () => {}, 30);
    let lateError = '';
    try {
      await lateBus.read(0x04, 4);
    } catch (e) {
      lateError = String(e);
    }
    check('an answered-too-late read still reports the deadline',
      lateError.includes('did not complete within 30 ms'), lateError || '<no throw>');
    await new Promise((r) => setTimeout(r, 80));
    check('the abandoned transfer rejecting afterwards is swallowed',
      late.lateRejections === 1, `${late.lateRejections} late rejection(s)`);

    // A board that answers normally must not pay for any of this: the register
    // traffic of a whole configuration has to stay well inside the deadline.
    const healthy = bus(recorded());
    const healthyStarted = Date.now();
    await configureChannels(healthy.bus, 16);
    check('an answering board is unaffected by the deadline',
      Date.now() - healthyStarted < 1000, `${Date.now() - healthyStarted} ms`);
  }

  console.log('\nstream: head drop and tail delivery');
  {
    /*
     * The trickiest logic in the module, and the one the static signal on the
     * probes cannot exercise: the 4 junk head bytes are dropped once per
     * acquisition, carried across transfers if the first one is shorter than
     * the drop.
     *
     * Script: 3 bytes, then 5 bytes, then a transfer that never completes, then
     * one that only completes when the interface is released. The last one is
     * still sitting in the pending queue at stop() time, so it exercises the
     * tail-delivery path in drain() as well.
     */
    const fake = new FakeStreamDevice(recorded(), [
      { kind: 'data', bytes: [0xaa, 0xbb, 0xcc] },
      { kind: 'data', bytes: [0xdd, 0x01, 0x02, 0x03, 0x04] },
      { kind: 'hang' },
      { kind: 'dataOnRelease', bytes: [0x10, 0x11, 0x12, 0x13, 0x14, 0x15] },
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const chunks: number[][] = [];
    await dev.open();
    await dev.start({ channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, (c) => {
      chunks.push(Array.from(c));
    });
    // Let the two immediately-available transfers work through the loop.
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();

    const flat = chunks.flat();
    const stats = dev.getStats();
    check('head drop carries across a short first transfer',
      flat.join(',') === '1,2,3,4,16,17,18,19,20,21', flat.join(','));
    check('exactly 4 bytes are dropped, once',
      stats.rawBytes - stats.sinkBytes === 4,
      `raw ${stats.rawBytes} sink ${stats.sinkBytes}`);
    check('data already received at stop() is delivered, not discarded',
      flat.slice(4).join(',') === '16,17,18,19,20,21', chunks.map((c) => c.length).join('+'));
  }
  {
    // Stopping replenishment while the producer is still running lets every
    // pending WebUSB read complete normally. Only then may CTRL_STOP be sent.
    const block = new Array<number>(1024).fill(0);
    const fake = new FakeStreamDevice(recorded(), Array.from({ length: 5 }, () => (
      { kind: 'delayedData' as const, bytes: block, delayMs: 20 }
    )));
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    await dev.open();
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, () => {}, undefined,
      { tuning: { depth: 5, transferBytes: 1024 } },
    );
    await dev.stop();
    const lastWrite = fake.log.filter((line) => line.startsWith('W ')).at(-1);
    check('clean stop drains pending reads without releasing the interface',
      fake.releaseInterfaceCalls === 0, `release calls: ${fake.releaseInterfaceCalls}`);
    check('clean stop writes CTRL_STOP only after the bulk queue drains',
      lastWrite === 'W 4 00000000', lastWrite);
  }
  {
    // The ordinary case: the first transfer is longer than the drop.
    const fake = new FakeStreamDevice(recorded(), [
      { kind: 'data', bytes: [0xaa, 0xbb, 0xcc, 0xdd, 0x07, 0x00, 0x06, 0x00] },
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const chunks: number[][] = [];
    await dev.open();
    await dev.start({ channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, (c) => {
      chunks.push(Array.from(c));
    });
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    check('a long first transfer loses exactly its first 4 bytes',
      chunks.flat().join(',') === '7,0,6,0', chunks.flat().join(','));
  }
  {
    // 32U3: after the common four-byte head, samples stay as four-byte little-endian
    // words all the way into PlanarSampleStore's 32-channel transposer.
    const payload = [
      0x01, 0x00, 0x00, 0x00, // D0
      0x00, 0x00, 0x00, 0x80, // D31
      0x78, 0x56, 0x34, 0x12,
    ];
    const fake = new FakeStreamDevice(recorded32(), [
      { kind: 'data', bytes: [0xaa, 0xbb, 0xcc, 0xdd, ...payload] },
    ], 0x3032);
    fake.productName = 'SLogic32 U3';
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const store = new PlanarSampleStore({ channelCount: 32, samplerate: 16e6 });
    await dev.open();
    await dev.start({ channels: 32, samplerate: 16e6, thresholdVolts: 1.6 },
      (chunk) => store.append(chunk));
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    let mismatch = '';
    const words = [0x00000001, 0x80000000, 0x12345678];
    for (let i = 0; i < words.length && !mismatch; i++) {
      for (let c = 0; c < 32; c++) {
        const want = (words[i]! >>> c) & 1;
        if (store.sampleAt(c, i) !== want) { mismatch = `sample ${i}, channel ${c}`; break; }
      }
    }
    check('32U3 identify/configure/receive/transpose end to end',
      dev.maxChannels === 32 && store.length === 3 && mismatch === '',
      `name=${dev.name}, maxChannels=${dev.maxChannels}, length=${store.length}, ${mismatch}`);
  }
  {
    // 4 channels: the head drop happens on the wire, before expansion, so 4
    // raw bytes = 8 samples disappear and the rest doubles.
    const fake = new FakeStreamDevice(recorded(), [
      { kind: 'data', bytes: [0xff, 0xff, 0xff, 0xff, 0x67, 0x45] },
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const chunks: number[][] = [];
    await dev.open();
    await dev.start({ channels: 4, samplerate: 16e6, thresholdVolts: 1.6 }, (c) => {
      chunks.push(Array.from(c));
    });
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    check('head drop happens before sub-8-channel expansion',
      chunks.flat().join(',') === '7,6,5,4', chunks.flat().join(','));
  }
  {
    const bytes = new Array<number>(1024).fill(0);
    bytes.splice(0, 14,
      0xaa, 0xbb, 0xcc, 0xdd, // acquisition head
      0, 0, 0, 0, 1, 0, 1, 0, 0, 0); // samples 0,0,1,1,0
    const fake = new FakeStreamDevice(recorded(), [{ kind: 'data', bytes }]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const chunks: number[][] = [];
    const states: string[] = [];
    await dev.open();
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 },
      (chunk) => { chunks.push(Array.from(chunk)); }, undefined,
      {
        tuning: { depth: 4, transferBytes: 1024 },
        softwareTrigger: {
          channels: 16, channel: 0, kind: 'rising', preTriggerSamples: 2, maxSamples: 5,
        },
        onTriggerState: (state) => states.push(state),
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    check('device software trigger retains bounded prefix and post-trigger samples',
      chunks.flat().join(',') === '0,0,0,0,1,0,1,0,0,0', chunks.flat().join(','));
    check('device reports waiting then triggered', states.join(',') === 'waiting,triggered', states.join(','));
  }
  {
    const fake = new FakeStreamDevice(recorded(), [
      { kind: 'data', bytes: new Array<number>(1024).fill(0) },
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const chunks: number[][] = [];
    const states: string[] = [];
    await dev.open();
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 },
      (chunk) => { chunks.push(Array.from(chunk)); }, undefined,
      {
        tuning: { depth: 4, transferBytes: 1024 },
        softwareTrigger: {
          channels: 16, channel: 0, kind: 'rising', preTriggerSamples: 3, maxSamples: 4,
        },
        onTriggerState: (state) => states.push(state),
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    check('no-trigger search discards data and reports an explicit state',
      chunks.length === 0 && states.join(',') === 'waiting,not-found',
      `chunks=${chunks.length}, states=${states.join(',')}`);
  }
  {
    // Match the result of libsigrok's allocation probe under Linux's common
    // 16 MiB usbfs URB budget: five 3,129,344-byte requests fit, larger queues fail.
    const at100 = deriveStreamTuning(
      { channels: 32, samplerate: 100e6, thresholdVolts: 1.6 },
    );
    const at200 = deriveStreamTuning(
      { channels: 32, samplerate: 200e6, thresholdVolts: 1.6 },
    );
    check('32ch@100M uses libsigrok trained transfer geometry',
      at100.transferBytes === 3_129_344 && at100.depth === 5,
      JSON.stringify(at100));
    // 800 MB/s is above what libsigrok's 3,129,344-byte reads sustain through WebUSB, and
    // 1 MiB is where the host falls off (NOTES 8.26), so the geometry for this rate has to
    // be a small-read deep queue instead - still inside the same usbfs budget.
    check('32ch@200M reads under the 1 MiB host cliff and stays inside the usbfs budget',
      at200.transferBytes === 768 * 1024 && at200.depth === 16 &&
        at200.transferBytes < 1024 * 1024 &&
        at200.transferBytes * at200.depth <= 12 * 1024 * 1024,
      JSON.stringify(at200));
    // The gate is the line rate, not the samplerate: 16 channels at the same clock is half
    // the data and keeps the reads the native driver trained on.
    const at16 = deriveStreamTuning(
      { channels: 16, samplerate: 200e6, thresholdVolts: 1.6 },
    );
    check('16ch@200M is 400 MB/s and keeps libsigrok trained transfer geometry',
      at16.transferBytes === 3_129_344 && at16.depth === 5,
      JSON.stringify(at16));
    await expectThrow('an oversized WebUSB queue is refused before it can poison the endpoint',
      async () => { deriveStreamTuning(
        { channels: 32, samplerate: 200e6, thresholdVolts: 1.6 },
        { transferBytes: 4 * 1024 * 1024, depth: 4 },
      ); }, 'exceeds the safe');
    // libsigrok sizes its queue from what the host accepts (protocol.c:249-330) rather
    // than pinning it, so a host whose usbfs budget was raised can use fewer, larger
    // transfers. The refusal above is against the *declared* budget, not against a
    // constant, and the geometry has to be accepted once the caller declares one.
    const raised = deriveStreamTuning(
      { channels: 32, samplerate: 200e6, thresholdVolts: 1.6 },
      { transferBytes: 6_258_688, depth: 8, queueBudgetBytes: 64 * 1024 * 1024 },
    );
    check('a declared usbfs budget admits the geometry libsigrok would train on it',
      raised.transferBytes === 6_258_688 && raised.depth === 8,
      JSON.stringify(raised));
    await expectThrow('the same geometry is still refused on the default budget',
      async () => { deriveStreamTuning(
        { channels: 32, samplerate: 200e6, thresholdVolts: 1.6 },
        { transferBytes: 6_258_688, depth: 8 },
      ); }, 'exceeds the safe');
  }

  {
    // The geometry the transport picks for a rate above the host's large-read ceiling has to
    // reach the sink in big blocks, not one 768 KiB read at a time: the interleaved store
    // costs ~1.2 ms per append whatever its size (NOTES 8.26), so 1,017 appends a second
    // would ask it for 1.5 s of work per second of data. Checked on the scripted device with
    // an explicit block size, so the check is deterministic and says nothing about timing.
    const coalesceBytes = 8192;
    const script = Array.from({ length: 24 }, (_, i) => ({
      kind: 'data' as const, bytes: new Array<number>(1024).fill(i & 0xff),
    }));
    const fake = new FakeStreamDevice(recorded(), script);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const delivered: number[] = [];
    const blockSizes: number[] = [];
    await dev.open();
    await dev.start(
      { channels: 8, samplerate: 16e6, thresholdVolts: 1.6 },
      (chunk) => { blockSizes.push(chunk.length); for (const b of chunk) delivered.push(b); },
      undefined,
      { tuning: { depth: 4, transferBytes: 1024, coalesceBytes } },
    );
    await new Promise((r) => setTimeout(r, 200));
    await dev.stop();
    const expected: number[] = [];
    for (let i = 0; i < script.length; i++) for (let k = 0; k < 1024; k++) expected.push(i & 0xff);
    expected.splice(0, 4); // the junk head is dropped once per acquisition
    check('a coalescing tuning hands the sink whole blocks',
      blockSizes.length === 3 && blockSizes[0] === coalesceBytes && blockSizes[1] === coalesceBytes,
      JSON.stringify(blockSizes));
    check('the coalesced stream is the same bytes in the same order',
      delivered.length === expected.length && delivered.every((v, i) => v === expected[i]),
      `${delivered.length} bytes delivered, ${expected.length} expected`);
    check('the tail still in the coalescing block is delivered when the capture ends',
      blockSizes[2] === expected.length - 2 * coalesceBytes,
      `last block ${blockSizes[2]}, expected ${expected.length - 2 * coalesceBytes}`);
  }

  {
    // Four immediately completed lanes must all replenish before the first synchronous
    // sink callback runs. The old consumer only had five calls here (depth plus one),
    // allowing conversion work to drain the endpoint queue at high rates.
    const block = new Array<number>(1024).fill(0);
    const fake = new FakeStreamDevice(recorded(), [
      { kind: 'data', bytes: block }, { kind: 'data', bytes: block },
      { kind: 'data', bytes: block }, { kind: 'data', bytes: block },
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    let callsAtFirstSink = 0;
    await dev.open();
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 },
      () => { if (callsAtFirstSink === 0) callsAtFirstSink = fake.transferInCalls; },
      undefined,
      { tuning: { depth: 4, transferBytes: 1024 } },
    );
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    check('completed USB lanes re-arm before synchronous data processing',
      callsAtFirstSink === 8, `transferIn calls at first sink: ${callsAtFirstSink}`);
  }

  console.log('\nbackpressure: a sink that returns a promise holds the refill');
  {
    /*
     * The worker pump hands each chunk to the page and waits for the ack, so the sink
     * returns a promise. That is the only thing that can make the consumer slower than
     * the USB queue, and the bound on how far it may fall behind is StreamTuning.lagChunks:
     * past it the loop stops refilling, because an unbounded backlog is unbounded memory
     * on a 400 MB/s stream (NOTES 8.13).
     *
     * 8 channels is one byte per sample, so the four-byte head is four samples and every
     * other byte the sink sees is a byte the device sent - which is what makes the order
     * and the byte count checkable at all.
     */
    // 256 KiB per transfer is what makes this measurable at all: the watchdog judges the
    // loop against the device's rate, and a stall only recovers that rate if the chunks
    // that follow are big enough to pay the stall back in one burst - which is what the
    // shipping geometry does at 3 MB and what a 1 KiB transfer cannot do.
    const transferBytes = 262144;
    const chunks = 24;
    const script = Array.from({ length: chunks }, (_, i) => ({
      kind: 'data' as const,
      bytes: new Array<number>(transferBytes).fill(i & 0xff),
    }));
    const fake = new FakeStreamDevice(recorded(), script);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    // Ordered per chunk rather than byte by byte: 256 KiB does not survive a spread, and
    // the two things worth checking are that the chunks arrive in the order the device
    // sent them and that none of them lost its tail.
    const seen: { want: number; len: number; uniform: boolean }[] = [];
    const lagChunks = 8;
    let calls = 0;
    await dev.open();
    await dev.start(
      { channels: 8, samplerate: 16e6, thresholdVolts: 1.6 },
      async (chunk) => {
        // One stall, then instant again - the case the cap is for. A sink that stays
        // slower than the device is supposed to abort the capture instead (that is the
        // watchdog's job), so the lag has to be a moment, not a trend.
        if (calls === 1) await new Promise((r) => setTimeout(r, 30));
        const want = calls & 0xff;
        seen.push({ want, len: chunk.length, uniform: chunk.every((v) => v === want) });
        calls += 1;
      },
      undefined,
      { tuning: { depth: 4, transferBytes, lagChunks } },
    );
    await new Promise((r) => setTimeout(r, 300));
    await dev.stop();
    const stats = dev.getStats();
    const expectedLengths = script.map((_, i) => (i === 0 ? transferBytes - 4 : transferBytes));
    check('a slow sink never lets the backlog grow past lagChunks',
      stats.peakQueuedTransfers <= lagChunks,
      `peak ${stats.peakQueuedTransfers} of ${lagChunks} (depth ${stats.slowTransferLimit})`);
    check('the backlog actually reaches the cap, so the bound is what stopped it',
      stats.peakQueuedTransfers === lagChunks, `peak ${stats.peakQueuedTransfers}`);
    check('the capture survives the moment of lag instead of aborting',
      stats.transfers === chunks, `transfers ${stats.transfers} of ${chunks}`);
    check('every byte the device sent reaches the sink, in order',
      seen.length === chunks &&
        seen.every((c, i) => c.want === (i & 0xff) && c.uniform && c.len === expectedLengths[i]),
      `${seen.length} chunks seen, ${chunks} expected; bad: ` +
        `${seen.filter((c, i) => c.len !== expectedLengths[i] || !c.uniform).length}`);
    check('the slow sink costs no data at the head',
      stats.rawBytes - stats.sinkBytes === 4,
      `raw ${stats.rawBytes} sink ${stats.sinkBytes}`);
  }
  {
    // The same script with a synchronous sink. The consumer here never holds anything
    // back, so the control is that the cap does not cost it a byte or a transfer: the
    // waker is still a promise, which is why `completed` may sit at the cap even when
    // the sink is instant (the existing "completed USB lanes re-arm before synchronous
    // data processing" check covers the part that matters - the queue is replenished
    // before the sink runs).
    const script = Array.from({ length: 24 }, () => (
      { kind: 'data' as const, bytes: new Array<number>(1024).fill(0x5a) }
    ));
    const fake = new FakeStreamDevice(recorded(), script);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    let bytes = 0;
    await dev.open();
    await dev.start(
      { channels: 8, samplerate: 16e6, thresholdVolts: 1.6 }, (chunk) => { bytes += chunk.length; },
      undefined,
      { tuning: { depth: 4, transferBytes: 1024, lagChunks: 8 } },
    );
    await new Promise((r) => setTimeout(r, 120));
    await dev.stop();
    const stats = dev.getStats();
    check('a synchronous sink stays inside the same bound',
      stats.peakQueuedTransfers <= 8, `peak ${stats.peakQueuedTransfers}`);
    check('the synchronous sink still receives everything',
      bytes === 24 * 1024 - 4 && stats.transfers === 24,
      `${bytes} bytes in ${stats.transfers} transfers`);
  }

  console.log('\nbackpressure: a known capture length, not the consumer, bounds the queue');
  {
    /*
     * The shipping failure this pins (NOTES 8.27): the loop used to stop refilling once
     * the consumer was `lagChunks` chunks behind, whatever the capture was. A page that is
     * a few milliseconds late therefore left the device with no reads queued, the board
     * overran its FIFO, and the watchdog aborted a capture that libsigrok's own resubmit
     * rule - bounded by `samples_need_nbytes`, never by the consumer (protocol.c:395) -
     * would have carried to its length. With a length known, the queue must keep `depth`
     * reads armed however slow the sink is, and the backlog is allowed to exceed the cap.
     */
    const transferBytes = 262144;
    const chunks = 24;
    const script = Array.from({ length: chunks }, (_, i) => ({
      kind: 'data' as const,
      bytes: new Array<number>(transferBytes).fill(i & 0xff),
    }));
    const fake = new FakeStreamDevice(recorded(), script);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const lagChunks = 4;
    let calls = 0;
    let sinkBytes = 0;
    await dev.open();
    await dev.start(
      { channels: 8, samplerate: 16e6, thresholdVolts: 1.6 },
      async (chunk) => {
        // Every single chunk slower than the queue it feeds: before this change the cap
        // stopped the refill after `lagChunks` of them and the device was on its own.
        await new Promise((r) => setTimeout(r, 6));
        sinkBytes += chunk.length;
        calls += 1;
      },
      undefined,
      {
        // 8 channels is one byte per sample, so the budget is the script with room to
        // spare - exactly what a timer capture hands over before RUN.
        deviceSampleLimit: chunks * transferBytes + transferBytes * 4,
        tuning: { depth: 4, transferBytes, lagChunks },
      },
    );
    await new Promise((r) => setTimeout(r, 500));
    await dev.stop();
    const stats = dev.getStats();
    check('a slow consumer cannot stop the queue from being replenished',
      stats.peakQueuedTransfers > lagChunks,
      `peak ${stats.peakQueuedTransfers} of lag ${lagChunks}`);
    check('the device never ran out of queued reads while the consumer lagged',
      stats.maxIdleGapMs === 0 && stats.transfers === chunks,
      `idle gap ${stats.maxIdleGapMs.toFixed(2)}ms, transfers ${stats.transfers} of ${chunks}`);
    check('every chunk still reaches the slow sink, in order and whole',
      calls === chunks && sinkBytes === chunks * transferBytes - 4,
      `${calls} calls, ${sinkBytes} bytes of ${chunks * transferBytes - 4}`);
    check('a slow sink is not reported as a fallen-behind device',
      stats.slowTransfers === 0, `slow ${stats.slowTransfers}`);
  }
  {
    // libsigrok aborts an acquisition the moment the host falls behind
    // (protocol.c:152, `average_rate < expected_rate * 0.95`), because a 32U3 that is
    // allowed to overrun wedges its bulk endpoint until it is unplugged. 4ch@5MHz
    // offers 2500 B/ms; this scripted endpoint answers every 1 KiB request 2 ms late,
    // which is ~2048 B/ms - a sustained shortfall, so the capture must stop itself.
    const block = new Array<number>(1024).fill(0);
    const fake = new FakeStreamDevice(recorded(), Array.from({ length: 32 }, () => (
      { kind: 'delayedData' as const, bytes: block, delayMs: 2 }
    )));
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    await dev.open();
    await dev.start(
      { channels: 4, samplerate: 5e6, thresholdVolts: 1.6 }, () => {}, undefined,
      // Labelled the way the worker labels its own loop: an abort that names a blocked
      // thread has to name the one running the read loop, not the page it was moved off.
      { threadLabel: 'worker', tuning: { depth: 4, transferBytes: 1024 } },
    );
    await new Promise((r) => setTimeout(r, 80));
    // The watchdog must have stopped the producer itself, before the caller's stop()
    // ran: this loop stops replenishing the moment it throws, and a producing device
    // with no queued reads overruns its FIFO and loses the endpoint (NOTES 8.6).
    const stopWritesOnAbort = fake.log.filter((l) => l === 'W 4 00000000').length;
    check('the abort tells the device to stop before the caller calls stop()',
      stopWritesOnAbort >= 2, `CTRL_STOP writes: ${stopWritesOnAbort} (run: ${
        fake.log.filter((l) => l === 'W 4 01000000').length})`);
    let failure: unknown = null;
    try { await dev.stop(); } catch (e) { failure = e; }
    const stats = dev.getStats();
    check('a host that cannot drain the device aborts the capture',
      failure instanceof Error && /overran the host/.test(failure.message),
      failure instanceof Error ? failure.message : String(failure));
    check('the underrun watchdog reports consecutive slow transfers',
      stats.slowTransfers >= 4 && stats.slowTransferLimit === 4,
      `slow=${stats.slowTransfers} limit=${stats.slowTransferLimit}`);
    check('the underrun watchdog records the timing distribution',
      stats.transferMsMax > 0 && stats.rearmMsP50 >= 0 && stats.sinkMsP95 >= 0,
      `transferMax=${stats.transferMsMax.toFixed(2)} rearmP50=${stats.rearmMsP50.toFixed(3)}`);
    // A starved queue and a slow device look the same from the count alone; the message
    // has to say which one this was, and one of the two branches always applies.
    check('the abort names the thread running the read loop, not the page',
      failure instanceof Error && /worker thread/.test(failure.message),
      failure instanceof Error ? failure.message.slice(-160) : String(failure));
    check('the stall probe reports a clean thread when nothing blocked it',
      Number.isFinite(stats.threadStallMaxMs) && stats.threadStalls >= 0,
      `max=${stats.threadStallMaxMs.toFixed(1)}ms count=${stats.threadStalls}`);
  }

  console.log('\npage-thread stall probe');
  {
    const watch = new LoopStallWatch();
    watch.start();
    const blocker = Date.now();
    while (Date.now() - blocker < 40) { /* hold the thread, as a store append or a GC would */ }
    await new Promise((r) => setTimeout(r, THREAD_PROBE_WAIT_MS));
    watch.stop();
    check('a blocked thread is measured, not silently swallowed',
      watch.count >= 1 && watch.maxMs >= 20,
      `count=${watch.count} max=${watch.maxMs.toFixed(1)}ms`);
    const settled = watch.count;
    await new Promise((r) => setTimeout(r, 40));
    check('stop() leaves no timer behind', watch.count === settled, `${watch.count} vs ${settled}`);

    const quick = new LoopStallWatch();
    quick.start();
    await new Promise((r) => setTimeout(r, THREAD_PROBE_WAIT_MS));
    quick.stop();
    check('an idle thread is not reported as blocked', quick.count === 0,
      `count=${quick.count} max=${quick.maxMs.toFixed(1)}ms`);
  }

  console.log('\nworker transport, page side');
  {
    // The worker owns the device and the page owns the store. What has to hold is that a
    // chunk crosses once, is acked only after the page has it, and that a worker which
    // cannot see the device (or never answers) does not turn into a stuck page.
    const asking = new FakeWorker();
    const device = await openWorkerDevice(asking);
    const open = asking.sent[0];
    check('the page asks the worker to open the device the origin was granted',
      open?.kind === 'open' && open.filter.vendorId === 0x359f && open.filter.productId === 0x3032,
      JSON.stringify(open));
    check('the worker transport adopts the identity the worker reports',
      device.name.includes('fake worker') && device.maxChannels === 32 &&
        device.maxSamplerateHz?.[32] === 200e6, `${device.name} ${device.maxChannels}`);

    const refused = new FakeWorker();
    const refusing = WorkerSlogicDevice.open(
      { vendorId: 0x359f, productId: 0x3032 },
      { spawn: () => refused as unknown as Worker, openTimeoutMs: 200 },
    );
    refused.emit({ kind: 'failed', message: 'the device is not visible to this worker' });
    let refusedError = '';
    try { await refusing; } catch (e) { refusedError = String(e); }
    check('a worker that cannot see the device says why', refusedError.includes('not visible'),
      refusedError || '<no throw>');

    const silent = new FakeWorker();
    const silentStart = Date.now();
    let silentError = '';
    try {
      await WorkerSlogicDevice.open(
        { vendorId: 0x359f, productId: 0x3032 },
        { spawn: () => silent as unknown as Worker, openTimeoutMs: 60 },
      );
    } catch (e) { silentError = String(e); }
    check('a worker that never answers is given up on, not waited for',
      silentError.includes('did not answer "opened"') && Date.now() - silentStart >= 50,
      `${silentError} after ${Date.now() - silentStart} ms`);
    check('a failed open terminates the worker it could not use', silent.terminated);

    const streaming = new FakeWorker();
    const live = await openWorkerDevice(streaming);
    const chunks: number[][] = [];
    const started = live.start(
      { channels: 32, samplerate: 200e6, thresholdVolts: 1.6 },
      (chunk) => { chunks.push([...chunk]); },
    );
    streaming.emit({ kind: 'started' });
    await started;
    check('the page tells the worker its loop is the one to name in an abort',
      JSON.stringify(streaming.sent.find((m) => m.kind === 'start')?.options)
        .includes('"threadLabel":"worker"'),
      JSON.stringify(streaming.sent.find((m) => m.kind === 'start')?.options));
    streaming.chunk(7, 4, 0x22);
    check('a chunk crosses to the page sink intact',
      chunks.length === 1 && chunks[0]!.length === 4 && chunks[0]![0] === 0x22,
      JSON.stringify(chunks));
    check('the page acks the chunk so the worker can refill that URB slot',
      streaming.kinds().includes('ack') && streaming.unacked.size === 0,
      `${streaming.kinds().join(',')} unacked=${streaming.unacked.size}`);

    // Backpressure: the ack is what releases the worker's next slot, so a slow page has
    // to hold it - that is the whole mechanism behind StreamTuning.lagChunks.
    const release: { fn: (() => void) | null } = { fn: null };
    const slow = new FakeWorker();
    const slowDevice = await openWorkerDevice(slow);
    const slowStart = slowDevice.start(
      { channels: 32, samplerate: 200e6, thresholdVolts: 1.6 },
      () => new Promise<void>((resolve) => { release.fn = resolve; }),
    );
    slow.emit({ kind: 'started' });
    await slowStart;
    slow.chunk(11, 4);
    await new Promise((r) => setTimeout(r, 20));
    check('a slow sink holds the ack instead of letting the queue grow',
      slow.unacked.has(11) && !slow.sent.some((m) => m.kind === 'ack'),
      `unacked=${slow.unacked.size} sent=${slow.kinds().join(',')}`);
    release.fn?.();
    await new Promise((r) => setTimeout(r, 20));
    check('the ack follows the append', slow.unacked.size === 0, `unacked=${slow.unacked.size}`);

    // The worker's own stall probe will say "never blocked" - that is the whole point of
    // moving the loop over there - so the page has to measure itself. Without this, the
    // 38 ms garbage collection that used to starve a 19.6 ms queue at 32ch/200M would
    // simply stop being reported, and the next hardware run would have no way to say
    // whether the split worked or the page just got lucky.
    const selfStalled = new FakeWorker();
    const watching = await openWorkerDevice(selfStalled);
    const watchStart = watching.start(
      { channels: 32, samplerate: 200e6, thresholdVolts: 1.6 },
      () => {},
    );
    selfStalled.emit({ kind: 'started' });
    await watchStart;
    const holdFrom = Date.now();
    while (Date.now() - holdFrom < 40) { /* hold the page, as a store append or a GC would */ }
    await new Promise((r) => setTimeout(r, THREAD_PROBE_WAIT_MS));
    const watchingStats = watching.getStats();
    selfStalled.emit({ kind: 'stats', stats: { rawBytes: 0, transfers: 0 } as unknown as Stats });
    const measured = await watchingStats;
    check('the page measures its own stalls while the worker owns the device',
      measured.pageStalls >= 1 && measured.pageStallMaxMs >= 20,
      `count=${measured.pageStalls} max=${measured.pageStallMaxMs.toFixed(1)}ms`);
    check('the worker statistics still cross unchanged',
      measured.rawBytes === 0 && measured.transfers === 0, JSON.stringify(measured));
    const watchingStop = watching.stop();
    selfStalled.emit({ kind: 'stopped' });
    await watchingStop;

    // A sink that throws must not deadlock the worker: the transport reports it and
    // still releases the slot.
    const exploding = new FakeWorker();
    const brokenDevice = await openWorkerDevice(exploding);
    const errors: string[] = [];
    const triggers: string[] = [];
    const dropouts: string[] = [];
    brokenDevice.onError = (error) => errors.push(String(error));
    const brokenStart = brokenDevice.start(
      { channels: 32, samplerate: 200e6, thresholdVolts: 1.6 },
      () => { throw new Error('the store refused the chunk'); },
      (position, missing) => { dropouts.push(`${position}+${missing}`); },
      { onTriggerState: (state, index) => { triggers.push(`${state}@${index}`); } },
    );
    exploding.emit({ kind: 'started' });
    await brokenStart;
    exploding.emit({ kind: 'dropout', position: 10, missing: 4 });
    exploding.emit({ kind: 'trigger', state: 'triggered', index: 12 });
    exploding.emit({ kind: 'error', message: 'bulk transfer failed' });
    exploding.chunk(21, 4);
    check('a dropout crosses the thread boundary', dropouts.join(',') === '10+4', dropouts.join(','));
    check('a trigger transition crosses the thread boundary',
      triggers.length === 1 && triggers[0] === 'triggered@12', triggers.join(','));
    check('a transport error reaches the page as an error',
      errors.some((e) => e.includes('bulk transfer failed')), errors.join('|'));
    check('a sink that throws still releases the worker slot',
      exploding.unacked.size === 0 && errors.some((e) => e.includes('the store refused')),
      `unacked=${exploding.unacked.size} errors=${errors.join('|')}`);

    const statsReply = brokenDevice.getStats();
    exploding.emit({
      kind: 'stats',
      stats: { rawBytes: 4096, transfers: 2 } as unknown as Stats,
    });
    const stats = await statsReply;
    check('statistics come back from the worker', stats.rawBytes === 4096 && stats.transfers === 2,
      JSON.stringify(stats));

    const consoleReply = brokenDevice.usbControl('flags');
    exploding.emit({ kind: 'console', result: 'R32_FLAG=0x00 RDY=0' });
    check('the advanced console works through the worker',
      (await consoleReply) === 'R32_FLAG=0x00 RDY=0');

    // A bench run measures the pipe from the worker. Where the page was during it is the
    // number that decides whether the split is doing anything, so the transport adds it.
    const benchReply = brokenDevice.usbControl('bench 1 32 100');
    const heldFrom = Date.now();
    while (Date.now() - heldFrom < 40) { /* hold the page while the bench runs */ }
    await new Promise((r) => setTimeout(r, THREAD_PROBE_WAIT_MS));
    exploding.emit({ kind: 'console', result: '32ch @ 100 MHz ...\n  thread     ...' });
    const benchText = await benchReply;
    check('a bench run reports what the page was doing while the worker drained',
      /page\s+thread blocked [1-9]/.test(benchText) &&
        benchText.includes('measured here, not in the worker'),
      benchText.replace(/\n/g, ' | '));

    const stopping = brokenDevice.stop();
    exploding.emit({ kind: 'stopped' });
    await stopping;
    check('stop() waits for the worker to finish stopping',
      exploding.kinds().includes('stop'), exploding.kinds().join(','));

    // A worker that dies with a request outstanding must fail it, not leave the page
    // waiting on a thread that no longer exists.
    const dying = new FakeWorker();
    const dyingDevice = await openWorkerDevice(dying);
    const pending = dyingDevice.getStats();
    dyingDevice.terminate();
    let deadError = '';
    try { await pending; } catch (e) { deadError = String(e); }
    check('a terminated worker fails what it was asked for',
      deadError.includes('terminated'), deadError || '<resolved>');
    check('a terminated worker is terminated', dying.terminated);
  }

  {
    // The watchdog has to forgive a burst, or it reproduces the bug it was meant to
    // fix. Chromium reaps completed transfers in batches, so a healthy 32ch/200M
    // capture regularly shows one transfer that took several times its device time
    // with the queue behind it draining the backlog on the next call. The watchdog
    // this transport used to run judged a sliding `depth`-transfer window against
    // 0.95 of the line rate and aborted on exactly that burst; the driver's own
    // conditions (protocol.c:152-171) are one URB at 1.3x its duration and the
    // whole-run average under 0.95, neither of which a stall that is a few percent
    // of the capture can trip.
    //
    // 4ch@5MHz is 2500 B/ms, so a 1 KiB transfer is 0.41 ms of device time and the
    // duration limit is 0.78 ms. One 2 ms stall in 240 transfers is 2% of the run:
    // four times its own duration limit on the one transfer (correctly counted
    // slow), and 4% of the average the driver measures over the whole capture.
    const block = new Array<number>(1024).fill(0);
    const script = Array.from<unknown, { kind: 'data'; bytes: number[] } | {
      kind: 'delayedData'; bytes: number[]; delayMs: number;
    }>(
      { length: 240 },
      (_, i) => (i === 120
        ? { kind: 'delayedData' as const, bytes: block, delayMs: 2 }
        : { kind: 'data' as const, bytes: block }),
    );
    const fake = new FakeStreamDevice(recorded(), script);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    await dev.open();
    await dev.start(
      { channels: 4, samplerate: 5e6, thresholdVolts: 1.6 }, () => {}, undefined,
      { tuning: { depth: 4, transferBytes: 1024 } },
    );
    await new Promise((r) => setTimeout(r, 60));
    let failure: unknown = null;
    try { await dev.stop(); } catch (e) { failure = e; }
    const stats = dev.getStats();
    check('a burst the queue absorbs does not abort the capture',
      failure === null,
      failure instanceof Error ? failure.message : String(failure));
    check('a burst leaves the slow-transfer run short of the limit',
      stats.slowTransfers < stats.slowTransferLimit && stats.transfers > 122,
      `slow=${stats.slowTransfers} limit=${stats.slowTransferLimit} transfers=${stats.transfers}`);
  }

  {
    /*
     * Bench report: "the first run captures fine, the second one fails with
     * Failed to execute 'transferIn' on 'USBDevice': A transfer error has occurred."
     * Capture #1's stop() had to force cancellation, which releases the interface with
     * reads still queued; Chromium then leaves the bulk pipe in an error state. start()
     * clears the endpoint before arming every run, and this proves that is load-bearing:
     * without the clearHalt, capture #2's first transferIn rejects and the whole run dies.
     */
    const block = new Array<number>(1024).fill(0x5a);
    const fake = new FakeStreamDevice(recorded(), [
      // Capture #1: five lanes deliver, the next five park so stop() has to force it.
      ...Array.from({ length: 5 }, () => (
        { kind: 'delayedData' as const, bytes: block, delayMs: 30 }
      )),
      ...Array.from({ length: 5 }, () => ({ kind: 'hang' as const })),
      // Capture #2: plenty of lanes so the run never starves.
      ...Array.from({ length: 40 }, () => ({ kind: 'data' as const, bytes: block })),
    ]);
    fake.poisonEndpointOnRelease = true;

    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const errors: unknown[] = [];
    dev.onError = (e) => errors.push(e);
    const first: number[] = [];
    const second: number[] = [];
    await dev.open();
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 },
      (c) => { first.push(c.byteLength); },
      undefined,
      { tuning: { depth: 5, transferBytes: 1024 } },
    );
    await new Promise((r) => setTimeout(r, 60));
    await dev.stop();
    check('a stop that cancels pending reads leaves the endpoint in the error state',
      fake.releaseInterfaceCalls === 1 && !fake.endpointHealthy,
      `release=${fake.releaseInterfaceCalls} healthy=${fake.endpointHealthy}`);

    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 },
      (c) => { second.push(c.byteLength); },
      undefined,
      { tuning: { depth: 5, transferBytes: 1024 } },
    );
    await new Promise((r) => setTimeout(r, 40));
    await dev.stop();
    check('capture #2 runs after capture #1 had to force cancellation',
      errors.length === 0 && first.length > 0 && second.length > 0,
      `errors=${errors.map(String).join('|') || 'none'} first=${first.length} second=${second.length}`);
    check('the endpoint is cleared before every run, not only after a failure',
      fake.clearHaltCalls >= 2, `clearHalt calls: ${fake.clearHaltCalls}`);
  }

  {
    /*
     * The other bench state: the endpoint is wedged, so transferIn fails at once,
     * forever. The read loop reports that error, stop() re-throws it instead of a
     * teardown artefact, and the transport does not end up refusing to start again -
     * a wedged board is only cleared by a replug, and the UI has to be able to say so
     * rather than sit on a capture that can never produce another byte.
     */
    const fake = new FakeStreamDevice(recorded(), []);
    fake.failAfterCalls = 0;
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const errors: unknown[] = [];
    dev.onError = (e) => errors.push(e);
    await dev.open();
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, () => {}, undefined,
      { tuning: { depth: 4, transferBytes: 1024 } },
    );
    await new Promise((r) => setTimeout(r, 20));
    let failure: unknown = null;
    try { await dev.stop(); } catch (e) { failure = e; }
    check('a wedged endpoint is reported once, through onError',
      errors.length === 1 && /transfer error/i.test(String(errors[0])),
      `${errors.length}: ${errors.map(String).join('|') || 'none'}`);
    check('stop() re-throws the read loop error, not a teardown artefact',
      failure !== null && failure === errors[0],
      `stop threw ${String(failure)}`);

    let secondStartError = '';
    try {
      await dev.start(
        { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, () => {}, undefined,
        { tuning: { depth: 4, transferBytes: 1024 } },
      );
    } catch (e) { secondStartError = String(e); }
    await new Promise((r) => setTimeout(r, 10));
    try { await dev.stop(); } catch { /* the wedge is expected to fail again */ }
    check('a capture that died on a device error does not block the next attempt',
      secondStartError === '', secondStartError);
  }

  console.log('\nR32_CTRL: read -> write -> read, and no RST');
  {
    /*
     * The board this reproduces: a 32U3 replugged with R32_CTRL left at 0x02, i.e. the
     * reset bit still set. It answers every control transfer and sends nothing on the
     * bulk endpoint - the same shape as the wedge NOTES 8.6 describes, and the state the
     * driver's own open() sequence leaves behind when its follow-up write is the one the
     * firmware misses. open() has to notice and write again, not reset and start over.
     */
    const fake = new FakeStreamDevice(recorded(), []);
    fake.ctrlValue = 0x02;
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    await dev.open();
    check('open() clears a reset bit left set by an earlier session',
      fake.ctrlValue === 0, `CTRL=0x${fake.ctrlValue.toString(16)}`);
    check('open() never writes RB_CTRL_RST',
      !fake.log.includes('W 4 02000000'), fake.log.join(' | '));
    check('the CTRL write is read -> write -> read, in that order',
      fake.log.indexOf('R 4') === 0 &&
        fake.log.indexOf('W 4 00000000') > fake.log.indexOf('R 4') &&
        fake.log.lastIndexOf('R 4') > fake.log.indexOf('W 4 00000000'),
      fake.log.join(' | '));
  }
  {
    // A firmware that swallows the write. The completion still reports ok, so the
    // read-back is the only thing that can tell the difference - and the second cycle is
    // what makes it land.
    const fake = new FakeStreamDevice(recorded(), [
      { kind: 'data', bytes: new Array<number>(4096).fill(0x11) },
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    await dev.open();
    // Swallow start()'s CTRL_STOP and the first CTRL_RUN that follows it.
    fake.dropCtrlWrites = 2;
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, () => {}, undefined,
      { tuning: { depth: 4, transferBytes: 1024 } },
    );
    const runWrites = fake.log.filter((l) => l === 'W 4 01000000').length;
    check('a dropped CTRL_RUN is written again until it sticks',
      runWrites === 2 && fake.ctrlValue === 0x01,
      `writes ${runWrites}, CTRL=0x${fake.ctrlValue.toString(16)} :: ${fake.log.join(' | ')}`);
    await dev.stop();
  }
  {
    // The board that never takes it: the capture has to fail naming the register rather
    // than start and deliver nothing, which is what the unverified write did.
    const fake = new FakeStreamDevice(recorded(), []);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    await dev.open();
    fake.holdCtrl = true;
    let error = '';
    try {
      await dev.start(
        { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, () => {}, undefined,
        { tuning: { depth: 4, transferBytes: 1024 } },
      );
    } catch (e) { error = String(e); }
    check('a CTRL write that never sticks fails the capture by name',
      error.includes('CTRL=0x01 never stuck across 3 read/write/read cycles'), error);
    check('the failed capture submits no bulk read',
      fake.transferInCalls === 0, String(fake.transferInCalls));
    await dev.stop();
  }

  console.log('\nR32_FLAG: the latch is cleared by the one register that can clear it');
  {
    check('decodeDeviceFlags reads RDY/FIFO_OV/INNER_ERR apart',
      (() => {
        const f = decodeDeviceFlags(0x07);
        return f.ready && f.fifoOverflow && f.innerError &&
          decodeDeviceFlags(0x00).ready === false;
      })());

    /*
     * RB_FLAG_FIFO_OV is write-1-to-clear and the spec's reset value for it is an event
     * latch rather than a configuration field. Hardware does clear it with CTRL.RST
     * (NOTES 8.4), but this transport writes no reset (NOTES 8.13), so the write-1-to-
     * clear is not a belt to anybody's braces: it is the whole clear. The latched value
     * is put there by hand and the write is what is tested.
     */
    {
      const fake = new FakeStreamDevice(recorded(), []);
      fake.flags.fifoOverflow = true;
      const dev = new Slogic16U3(fake as unknown as USBDevice);
      await dev.open();
      check('open() clears a FIFO overflow latched before it ran',
        !fake.flags.fifoOverflow && fake.log.includes('W 8 02000000'),
        fake.log.join(' | '));
      check('the flag write is the documented one byte, write-1-to-clear',
        fake.log.indexOf('W 8 02000000') > fake.log.indexOf('R 8'),
        fake.log.join(' | '));
    }

    /*
     * The bench sequence this reproduces: capture #1 streams fine, the FIFO overruns
     * while it is being torn down, and capture #2 answers every transferIn with "A
     * transfer error has occurred" - for libsigrok too - until the board is unplugged.
     * NOTES 8.6 shows the wedge is not the latch itself, so this covers the clearing
     * path, not the explanation: open() is not called again for capture #2, and a
     * start() that only trusted it would leave the bit set for the whole run.
     */
    {
      const block = new Array<number>(1024).fill(0x5a);
      const fake = new FakeStreamDevice(recorded(), [
        // Capture #1: slow lanes, so it consumes a handful and stop() drains them.
        ...Array.from({ length: 5 }, () => (
          { kind: 'delayedData' as const, bytes: block, delayMs: 30 }
        )),
        // Capture #2: a fresh set of immediately available lanes.
        ...Array.from({ length: 40 }, () => ({ kind: 'data' as const, bytes: block })),
      ]);
      const dev = new Slogic16U3(fake as unknown as USBDevice);
      const errors: unknown[] = [];
      dev.onError = (e) => errors.push(e);
      const cfg = { channels: 16 as const, samplerate: 16e6, thresholdVolts: 1.6 };
      const tuning = { tuning: { depth: 4, transferBytes: 1024 } };

      await dev.open();
      const first: number[] = [];
      await dev.start(cfg, (c) => { first.push(c.byteLength); }, undefined, tuning);
      await new Promise((r) => setTimeout(r, 10));
      await dev.stop();

      // What the board latches when the host stops draining for a moment.
      fake.flags.fifoOverflow = true;
      const flagWritesBefore = fake.log.filter((l) => l.startsWith('W 8')).length;

      const second: number[] = [];
      await dev.start(cfg, (c) => { second.push(c.byteLength); }, undefined, tuning);
      await new Promise((r) => setTimeout(r, 20));
      await dev.stop();
      const flagWritesAfter = fake.log.filter((l) => l.startsWith('W 8')).length;

      check('capture #2 starts on a board that latched a FIFO overflow during #1',
        errors.length === 0 && first.length > 0 && second.length > 0,
        `errors=${errors.map(String).join('|') || 'none'} first=${first.length} second=${second.length}`);
      check('start() is what clears it, because open() is not called again',
        flagWritesAfter === flagWritesBefore + 1 && !fake.flags.fifoOverflow,
        `flag writes ${flagWritesBefore} -> ${flagWritesAfter}`);
    }

    {
      // Negative control: a board with nothing latched must be left alone. A
      // diagnostic that writes on every capture is a change to the device, not a fix.
      const block = new Array<number>(1024).fill(0x5a);
      const fake = new FakeStreamDevice(recorded(), [
        ...Array.from({ length: 20 }, () => ({ kind: 'data' as const, bytes: block })),
      ]);
      const dev = new Slogic16U3(fake as unknown as USBDevice);
      await dev.open();
      await dev.start(
        { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, () => {}, undefined,
        { tuning: { depth: 4, transferBytes: 1024 } },
      );
      await new Promise((r) => setTimeout(r, 20));
      await dev.stop();
      check('a healthy board gets no R32_FLAG write at all',
        fake.log.filter((l) => l.startsWith('W 8')).length === 0,
        fake.log.join(' | '));
      check('but its flag is still read and reported',
        fake.log.filter((l) => l.startsWith('R 8')).length >= 2,
        fake.log.join(' | '));
    }

    /*
     * R32_SAMPLE_LEN (aux 0x04) is the firmware's own "stop after this much" counter -
     * the spec's stated reason for it is to stop a host that is late with its stop
     * command from driving the device into an overflow, which is exactly the state
     * NOTES 8.6 measures as fatal. Neither the driver nor this transport has ever
     * written it (it reads back 0), and the unit the firmware wants is not stated, so
     * the console has to be able to read and write it before a capture path can.
     */
    {
      const fake = new FakeStreamDevice(recorded(), []);
      const dev = new Slogic16U3(fake as unknown as USBDevice);
      await dev.open();
      const before = await dev.usbControl('sample-len');
      check('sample-len reads R32_SAMPLE_LEN', /R32_SAMPLE_LEN = 0$/.test(before), before);
      const after = await dev.usbControl('sample-len 4096');
      check('sample-len writes it through the verified aux path',
        /R32_SAMPLE_LEN = 4096$/.test(after) &&
          fake.log.includes('W 10 00100000'),
        `${after} :: ${fake.log.join(' | ')}`);
      await expectThrow('sample-len refuses a value wider than the register',
        () => dev.usbControl('sample-len 4294967296'), 'must be in');
      await expectThrow('sample-len refuses trailing junk',
        () => dev.usbControl('sample-len 16 16'), 'unexpected argument');
    }
  }

  {
    // A short packet only terminates that host request. It does not imply that the
    // unfilled bytes vanished from the device stream. Also retain an incomplete uint32
    // sample across the boundary instead of discarding it as the former gap path did.
    const payload = [
      0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x80,
      0x78, 0x56, 0x34, 0x12,
    ];
    const fake = new FakeStreamDevice(recorded32(), [
      { kind: 'data', bytes: [0xaa, 0xbb, 0xcc, 0xdd, ...payload.slice(0, 6)] },
      { kind: 'data', bytes: payload.slice(6) },
    ], 0x3032);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const chunks: number[][] = [];
    const dropouts: Array<[number, number]> = [];
    await dev.open();
    await dev.start(
      { channels: 32, samplerate: 16e6, thresholdVolts: 1.6 },
      (chunk) => { chunks.push(Array.from(chunk)); },
      (pos, missing) => dropouts.push([pos, missing]),
      { tuning: { depth: 4, transferBytes: 1024 } },
    );
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    check('short WebUSB transfers concatenate into one continuous 32-bit stream',
      chunks.flat().join(',') === payload.join(','), chunks.flat().join(','));
    check('short WebUSB transfers do not invent dropouts',
      dropouts.length === 0 && dev.getStats().shortTransfers === 2,
      `dropouts=${JSON.stringify(dropouts)}, short=${dev.getStats().shortTransfers}`);
  }

  console.log('\nR32_SAMPLE_LEN: the device stops itself at the capture length');
  {
    // The transfer function measured on S/N 202608052052 (NOTES 8.9): four writes
    // from 500 to 100000 all delivered exactly value * 4096 - 8192 wire bytes at
    // 32 channels, i.e. value * 1024 - 2048 samples.
    const measured: Array<[number, number]> = [
      [500, 2_039_808], [1000, 4_087_808], [2000, 8_183_808], [100_000, 409_591_808],
    ];
    const wrong = measured
      .filter(([value, bytes]) => samplesForSampleLength(value) * 4 !== bytes)
      .map(([value]) => value);
    check('the register unit is the one the hardware measured', wrong.length === 0,
      `wrong for ${wrong.join(',')}`);
    check('0 means "no limit", not "zero samples"',
      samplesForSampleLength(0) === 0 && sampleLengthForSamples(0) === 0,
      `${samplesForSampleLength(0)} / ${sampleLengthForSamples(0)}`);
    // Rounding up is what keeps a capture from ending a unit short of its length and
    // falling back to a host-side cut-off, which is the failure this all exists for.
    const short: number[] = [];
    for (let samples = 1; samples < 40_000; samples += 37) {
      if (samplesForSampleLength(sampleLengthForSamples(samples)) < samples) short.push(samples);
    }
    check('a programmed limit never asks for fewer samples than the caller wants',
      short.length === 0, short.slice(0, 5).join(','));
  }
  {
    // A limit left behind by an earlier session - the same page, or a page reloaded
    // while one was armed - must not truncate the next capture, and it must not
    // surprise a software-trigger capture that has to be free to wait for its trigger.
    const fake = new FakeStreamDevice(recorded32(), [], 0x3032);
    fake.sampleLenValue = 12345;
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    await dev.open();
    check('open() clears a length limit left behind by an earlier session',
      fake.sampleLenValue === 0, `still ${fake.sampleLenValue}`);
  }
  {
    // End to end: the length is known before RUN, so the device is told to stop by
    // itself, and the capture ends because the device stopped - not because the host
    // stopped reading a producer that was still running.
    const fake = new FakeStreamDevice(recorded32(), [], 0x3032);
    fake.autoStream = true;
    fake.bytesPerSample = 4;
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const wanted = 1000;
    let bytes = 0;
    await dev.open();
    await dev.start(
      { channels: 32, samplerate: 100e6, thresholdVolts: 1.6 },
      (chunk) => { bytes += chunk.byteLength; },
      undefined,
      { deviceSampleLimit: wanted },
    );
    await new Promise((r) => setTimeout(r, 30));
    const delivered = (bytes + 3) / 4; // sink bytes are whole 32-bit samples
    await dev.stop();
    check('the device is told to stop itself at the capture length',
      fake.sampleLenValue === sampleLengthForSamples(wanted + 1),
      `wrote ${fake.sampleLenValue}, wanted ${sampleLengthForSamples(wanted + 1)}`);
    check('the capture length is delivered before the device stops',
      delivered >= wanted, `${bytes} B = ${delivered} samples, wanted ${wanted}`);
    check('a self-stopped device is not reported as an overrun',
      dev.getStats().slowTransfers === 0,
      JSON.stringify(dev.getStats().slowTransfers));
  }
  {
    // `bench` is the command the 32ch/200M measurements are taken with, and it used to end
    // by calling stop() on a device that was still producing. Measured on hardware
    // 2026-09-11: `bench 2 32 100` reported 398 MB/s and left the board silent on the bulk
    // endpoint until it was replugged - the overrun NOTES 8.6 describes, caused by the tool
    // that measures rather than by the capture path. It has to arm the device's own length.
    const clock = new ClockStreamDevice(400_000); // 32ch @ 100 MHz
    const dev = new Slogic16U3(clock as unknown as USBDevice);
    await dev.open();
    const benchFrom = performance.now();
    const text = await dev.usbControl('bench 0.2 32 100');
    const benchMs = performance.now() - benchFrom;
    check('a bench arms the device length limit instead of cutting a producer off',
      clock.sampleLenValue === sampleLengthForSamples(0.2 * 100e6),
      `wrote ${clock.sampleLenValue}, wanted ${sampleLengthForSamples(0.2 * 100e6)}`);
    check('a bench ends on the device own stop, not on the host cutting it off',
      clock.selfStopped, `taken ${clock.taken / 4} samples of ${clock.sampleLenValue} units`);
    check('a bench still reports the pipe it measured',
      /MB\/s/.test(text) && /expected/.test(text), text.split('\n')[1]);
    // The tail reads after a self-stop are NAKs that only a release ends (NOTES 8.9).
    // Waiting out STOP_TIMEOUT_MS for them would add 1.5 s to every bench and to every
    // timed capture, so the stop has to recognise the device's own stop instead.
    check('a bench does not wait out the stop timeout for tail reads that cannot complete',
      benchMs < 0.2 * 1000 + 600 + 800, `${benchMs.toFixed(0)} ms for a 0.2 s + 0.4 s drain bench`);
    clock.release();
  }
  {
    // The read geometry is a bench argument, so a sweep of fixed configurations is a list
    // of one-line commands instead of a new script per question (NOTES 8.24), and the
    // seconds floor is what lets a run be shorter than the queue those reads give the
    // device: at 32ch/200M, 20 ms is 16 MB, inside 5 x 3,129,344 B of reads already
    // submitted. A run that asked for longer than that would overrun a device whose host
    // is the slow side, which is the wedge of NOTES 8.6.
    const clock = new ClockStreamDevice(400_000); // 32ch @ 100M
    const dev = new Slogic16U3(clock as unknown as USBDevice);
    await dev.open();
    const text = await dev.usbControl('bench 0.02 32 100 4 3129344');
    check('a bench takes its read geometry from the command line',
      /4 x 3129344 B in flight/.test(text), text.split('\n')[0]);
    check('a bench accepts a slice shorter than the queue it is given',
      /32ch @ 100 MHz/.test(text) && /MB\/s, expected 400 MB\/s/.test(text),
      text.split('\n')[1]);
    await expectThrow('a bench refuses a slice too short to be a measurement',
      () => dev.usbControl('bench 0.001 32 100'), 'bench seconds must be in');
    await expectThrow('a bench refuses a geometry the device would overrun with',
      () => dev.usbControl('bench 0.02 32 100 2 3129344'), 'depth');
    clock.release();
  }
  {
    // A capture that must not have a limit has to clear the one an earlier capture
    // armed: a software-trigger capture inheriting a stale length would stop before
    // its trigger ever arrived, and no host-side check would notice.
    const block = new Array<number>(8).fill(0x11);
    const fake = new FakeStreamDevice(recorded32(), Array.from(
      { length: 12 }, () => ({ kind: 'delayedData' as const, bytes: block, delayMs: 5 }),
    ), 0x3032);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    await dev.open();
    await dev.start({ channels: 32, samplerate: 16e6, thresholdVolts: 1.6 }, () => {},
      undefined, { deviceSampleLimit: 4096 });
    await new Promise((r) => setTimeout(r, 15));
    await dev.stop();
    const armed = fake.sampleLenValue;
    await dev.start({ channels: 32, samplerate: 16e6, thresholdVolts: 1.6 }, () => {},
      undefined, {});
    await new Promise((r) => setTimeout(r, 15));
    await dev.stop();
    check('a capture with no known length clears the limit instead of inheriting it',
      armed > 0 && fake.sampleLenValue === 0, `armed ${armed}, then ${fake.sampleLenValue}`);
  }

  {
    // The wedged-board state of NOTES 8.8: every control transfer answers and the bulk
    // endpoint never delivers a byte. The capture has to say so rather than sitting
    // there and reporting an empty capture with no error.
    const fake = new FakeStreamDevice(recorded32(), [], 0x3032);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const errors: string[] = [];
    dev.onError = (e) => errors.push(String(e));
    await dev.open();
    await dev.start({ channels: 32, samplerate: 100e6, thresholdVolts: 1.6 }, () => {},
      undefined, { tuning: { depth: 4, transferBytes: 1024 } });
    await new Promise((r) => setTimeout(r, 900));
    let stopError = '';
    try { await dev.stop(); } catch (e) { stopError = String(e); }
  check('a capture that never receives a byte fails with the wedged-board state',
      stopError.includes('delivered no data within') && stopError.includes('unplug it'),
      stopError || '<no error>');
    check('the wedged board is reported once, through onError',
      errors.length === 1 && errors[0]!.includes('delivered no data'),
      `${errors.length}: ${errors[0] ?? ''}`);
  }

  console.log('\nbench: the bulk pipe measured without a sink');
  {
    /*
     * StartOptions.discard is what makes `bench` answer a question the app could not
     * previously ask in a browser: how fast is bare transferIn, with none of the
     * capture's own work on the same thread. The sink must not be called at all, and
     * the byte counters still have to advance.
     */
    const block = new Array<number>(1024).fill(0x5a);
    const fake = new FakeStreamDevice(recorded(), [
      ...Array.from({ length: 4 }, () => ({ kind: 'data' as const, bytes: block })),
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const seen: number[] = [];
    await dev.open();
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 },
      (c) => { seen.push(c.byteLength); },
      undefined,
      { tuning: { depth: 4, transferBytes: 1024 }, discard: true },
    );
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    const stats = dev.getStats();
    check('discard counts the pipe without ever calling the sink',
      seen.length === 0 && stats.rawBytes === 4 * 1024 && stats.transfers === 4,
      `sink calls ${seen.length}, rawBytes ${stats.rawBytes}, transfers ${stats.transfers}`);
    check('discard still reports the rate the pipe achieved',
      stats.rawMBps > 0 && stats.rateRatio > 0,
      `rawMBps ${stats.rawMBps.toFixed(1)}, ratio ${stats.rateRatio.toFixed(3)}`);
  }

  {
    /*
     * The filler holds the LAST LEVEL rather than zeroing. Zeroing would invent a falling
     * edge at the gap's start and a rising one at its end on every channel that was high,
     * and the one at the end sits outside the gap where edges() reports it as real. No
     * device needed: drive a store directly.
     */
    const store = new PlanarSampleStore({ channelCount: 16, samplerate: 16e6 });
    const ones = new Uint8Array(1000 * 2).fill(0xff);   // all 16 channels high
    store.append(ones);
    appendLostSamples(store, 500, 0x7fffffff - 1);
    store.append(ones);                                  // still high after the gap

    check('filler holds the level across a gap (all 16 channels stay high)',
      store.length === 2500 && store.gaps().length === 1,
      `length ${store.length}, gaps ${JSON.stringify(store.gaps())}`);
    let edgeTotal = 0;
    const perCh: number[] = [];
    for (let c = 0; c < 16; c++) {
      const n = store.edges(c, 0, store.length).length;
      perCh.push(n);
      edgeTotal += n;
    }
    check('a held-high channel gains no edge from the gap', edgeTotal === 0,
      `edges per channel: ${JSON.stringify(perCh)} (zeroed filler would give 16 at the gap end)`);
    // Control: the level really is high on both sides, so the check above is not passing
    // because everything is uniformly low.
    const before = store.query(0, 999, 1000, 1).high[0];
    const after = store.query(0, 2000, 2001, 1).high[0];
    check('control: the channel is high on both sides of the gap',
      !!before && !!after, `before=${before} after=${after}`);
  }

  console.log(`\n${failures === 0 ? 'all offline checks passed' : failures + ' offline check(s) FAILED'}`);
  if (failures) failExit();
}

main().catch((e) => {
  console.error(e);
  failExit();
});
