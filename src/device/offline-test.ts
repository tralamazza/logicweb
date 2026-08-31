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
  vrefCode,
} from './protocol.js';
import { Slogic16U3, expandPacked } from './slogic16u3.js';
import { PlanarSampleStore, appendLostSamples } from '../data/index.js';

let failures = 0;

/** This file runs under node, but tsconfig only pulls in the DOM/WebUSB types. */
function failExit(): void {
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (proc) proc.exitCode = 1;
}

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

interface AuxModel {
  status: number; // the 32-bit word returned from R32_AUX
  payload: number[]; // payload words at R32_AUX+4
  /** Called when the host writes payload word 0; may change the model. */
  onWord0?: (self: AuxModel, value: number) => void;
  ready?: boolean;
  echo?: number; // override the selector echo in byte 0
}

/**
 * A device that behaves the way the real one was observed to: control
 * transfers are exactly 4 bytes, and any payload byte beyond the length the
 * device advertised is dropped on the floor without complaint.
 */
class FakeSlogic {
  readonly log: string[] = [];
  private selector = 0;
  opened = true;
  configuration = {} as USBConfiguration;

  constructor(private readonly aux: Record<number, AuxModel>) {}

  private model(): AuxModel {
    const m = this.aux[this.selector];
    if (!m) throw new Error(`fake: no model for selector 0x${this.selector.toString(16)}`);
    return m;
  }

  private statusWord(m: AuxModel): number {
    const ready = m.ready === false ? 0 : 1;
    return ((m.status & 0xff00ffff) | (ready << 16)) >>> 0;
  }

  async controlTransferOut(
    s: USBControlTransferParameters,
    data: BufferSource,
  ): Promise<USBOutTransferResult> {
    const b = new Uint8Array(
      data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer,
      data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset,
      data.byteLength,
    );
    if (b.length !== 4) throw new Error(`fake: control OUT of ${b.length} bytes, device takes 4`);
    if (s.request !== 0x01) throw new Error(`fake: bad OUT request ${s.request}`);
    this.log.push(`W ${s.value.toString(16)} ${Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('')}`);

    const word = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
    if (s.value === 0x0004) {
      // CTRL
    } else if (s.value === 0x000c) {
      this.selector = word & 0xff;
    } else if (s.value >= 0x0010) {
      const m = this.model();
      const idx = (s.value - 0x0010) / 4;
      // The device only accepts as many words as it advertised; the rest of a
      // longer write is dropped silently, which is the whole trap here.
      const words = Math.max(1, Math.ceil(((m.status & 0xffff) >> 9) / 4));
      if (idx < words) {
        m.payload[idx] = word;
        if (idx === 0) m.onWord0?.(m, word);
      }
      // Beyond the advertised length: silently dropped, exactly like the device.
    }
    return { status: 'ok', bytesWritten: 4 };
  }

  async controlTransferIn(
    s: USBControlTransferParameters,
    length: number,
  ): Promise<USBInTransferResult> {
    if (length !== 4) throw new Error(`fake: control IN of ${length} bytes, device gives 4`);
    if (s.request !== 0x00) throw new Error(`fake: bad IN request ${s.request}`);
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    if (s.value === 0x000c) {
      const m = this.model();
      const w = this.statusWord(m);
      dv.setUint32(0, m.echo !== undefined ? (w & 0xffffff00) | m.echo : w, true);
    } else if (s.value >= 0x0010) {
      const m = this.model();
      dv.setUint32(0, m.payload[(s.value - 0x0010) / 4] ?? 0, true);
    }
    this.log.push(`R ${s.value.toString(16)}`);
    return { status: 'ok', data: dv };
  }
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

/** One scripted answer to a transferIn call. */
type TransferAction =
  | { kind: 'data'; bytes: number[] }
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

  constructor(
    aux: Record<number, AuxModel>,
    private readonly script: TransferAction[],
  ) {
    super(aux);
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async selectConfiguration(): Promise<void> {}
  async claimInterface(): Promise<void> {}
  async reset(): Promise<void> {}

  async releaseInterface(): Promise<void> {
    const parked = this.parked;
    this.parked = [];
    for (const p of parked) {
      if (p.action.kind === 'dataOnRelease') {
        p.resolve({ status: 'ok', data: view(p.action.bytes) });
      } else {
        p.reject(new Error('NetworkError: transfer was cancelled'));
      }
    }
  }

  transferIn(_ep: number, _len: number): Promise<USBInTransferResult> {
    const action: TransferAction = this.script[this.calls++] ?? { kind: 'hang' };
    if (action.kind === 'data') {
      return Promise.resolve({ status: 'ok', data: view(action.bytes) });
    }
    return new Promise<USBInTransferResult>((resolve, reject) => {
      this.parked.push({ action, resolve, reject });
    });
  }
}

function view(bytes: number[]): DataView {
  const b = Uint8Array.from(bytes);
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function bus(aux: Record<number, AuxModel>): { bus: RegisterBus; dev: FakeSlogic } {
  const dev = new FakeSlogic(aux);
  return { bus: new RegisterBus(dev as unknown as USBDevice), dev };
}

/** The models as recorded from the real device. */
function recorded(): Record<number, AuxModel> {
  return {
    0x01: { status: 0x00010401, payload: [0x0000ffff] },
    0x02: { status: 0x00011002, payload: [(800 << 16) | 0, 10] },
    0x03: { status: 0x00010403, payload: [0x00000136] },
    0x05: { status: 0x00010205, payload: [0] },
  };
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
      // 32 channels would need a 0xffffffff mask, but only 2 bytes are register.
      await configureChannels(bus(recorded()).bus, 32);
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
    await dev.start({ channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, (c) =>
      chunks.push(Array.from(c)),
    );
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
    // The ordinary case: the first transfer is longer than the drop.
    const fake = new FakeStreamDevice(recorded(), [
      { kind: 'data', bytes: [0xaa, 0xbb, 0xcc, 0xdd, 0x07, 0x00, 0x06, 0x00] },
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const chunks: number[][] = [];
    await dev.open();
    await dev.start({ channels: 16, samplerate: 16e6, thresholdVolts: 1.6 }, (c) =>
      chunks.push(Array.from(c)),
    );
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    check('a long first transfer loses exactly its first 4 bytes',
      chunks.flat().join(',') === '7,0,6,0', chunks.flat().join(','));
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
    await dev.start({ channels: 4, samplerate: 16e6, thresholdVolts: 1.6 }, (c) =>
      chunks.push(Array.from(c)),
    );
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    check('head drop happens before sub-8-channel expansion',
      chunks.flat().join(',') === '7,6,5,4', chunks.flat().join(','));
  }
  {
    /*
     * A mid-stream short transfer is a dropout: samples were lost, and every
     * position after it is shifted. The device must report the exact sample
     * position it reached and how many samples the shortfall covers, and the
     * normal short final transfer at stop time must NOT count.
     *
     * The position is the END of the short transfer, not its start: the short
     * transfer still delivers real samples and the shortfall is what the device
     * could not append to them.
     *
     * 16ch @ 16 MHz derives 256000-byte transfers. Script: one full transfer,
     * one short by 100 bytes, one full. Expected report: one dropout at
     * (256000 - 4 head) / 2 + 255900 / 2 = 127998 + 127950 = 255948 samples,
     * with 100 / 2 = 50 missing.
     */
    const full = new Array<number>(256000).fill(0x00);
    const short = new Array<number>(256000 - 100).fill(0x00);
    const fake = new FakeStreamDevice(recorded(), [
      { kind: 'data', bytes: full },
      { kind: 'data', bytes: short },
      { kind: 'data', bytes: full },
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const dropouts: Array<[number, number]> = [];
    await dev.open();
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 },
      () => {},
      (pos, missing) => dropouts.push([pos, missing]),
    );
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();
    check('a mid-stream short transfer reports one dropout at the right position',
      dropouts.length === 1 && dropouts[0]![0] === 255948 && dropouts[0]![1] === 50,
      JSON.stringify(dropouts));
  }

  {
    /*
     * The dropout consumer, end to end: the same scripted short transfer, but wired to a
     * real store the way src/ui/app.ts wires it. Until this existed the whole path was
     * dead - onDropout fired and app.ts's handler returned every time, so noteGap had no
     * live producer and none of the gap machinery was reachable from a capture.
     *
     * The device delivers (256000-4)/2 + 255900/2 + 256000/2 = 383948 real samples and
     * loses 50, so a store that tracks device time must end at 383998 with one gap at
     * [255948, 255998). A store that does NOT append filler ends at 383948 with no gap -
     * that is the bug this pins.
     *
     * The payload is all zeros, so every channel is low throughout and the filler (which
     * repeats the last known sample) is also low. That makes the level check below a
     * genuine test of "hold the last level" only in the low case; the high case is
     * covered separately, without hardware, right after.
     */
    const full = new Array<number>(256000).fill(0x00);
    const short = new Array<number>(256000 - 100).fill(0x00);
    const fake = new FakeStreamDevice(recorded(), [
      { kind: 'data', bytes: full },
      { kind: 'data', bytes: short },
      { kind: 'data', bytes: full },
    ]);
    const dev = new Slogic16U3(fake as unknown as USBDevice);
    const store = new PlanarSampleStore({ channelCount: 16, samplerate: 16e6 });
    const limit = 0x7fffffff - 1;
    await dev.open();
    await dev.start(
      { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 },
      (chunk) => store.append(chunk),
      (_pos, missing) => { appendLostSamples(store, missing, limit); },
    );
    await new Promise((r) => setTimeout(r, 20));
    await dev.stop();

    const gaps = store.gaps();
    check('a dropout appends filler so store time tracks device time',
      store.length === 383998,
      `store holds ${store.length} samples, expected 383998 (383948 delivered + 50 lost)`);
    check('the lost span is marked as exactly one gap at the discontinuity',
      gaps.length === 1 && gaps[0]!.startSample === 255948 && gaps[0]!.endSample === 255998,
      JSON.stringify(gaps));
    // The gap must swallow no real edges here (the payload is constant), so edges() over
    // the whole capture must still be empty on every channel - the filler must not have
    // invented one.
    let invented = 0;
    for (let c = 0; c < 16; c++) invented += store.edges(c, 0, store.length).length;
    check('filler invents no edges', invented === 0, `${invented} edges across 16 channels`);
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
