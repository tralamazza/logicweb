// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Scripted SLogic devices: the register/aux model, and one that streams on its own clock.
 *
 * The offline suite drives `Slogic16U3` against these because the replies are recorded from
 * the real board (see `offline-test.ts`); the browser harness drives the same class over the
 * same driver, so that a Node run and a browser run are measuring one unit and not two.
 */

import { samplesForSampleLength } from './protocol.js';

export interface AuxModel {
  status: number; // the 32-bit word returned from R32_AUX
  payload: number[]; // payload words at R32_AUX+4
  /** Called when the host writes payload word 0; may change the model. */
  onWord0?: (self: AuxModel, value: number) => void;
  /**
   * Payload writes the device swallows before it starts accepting them: the write
   * reports 'ok' and the scratch buffer keeps the word it had. This is the benign
   * half of the failure NOTES 8.11 describes - the read-back can still see it.
   */
  dropPayloadWrites?: number;
  /**
   * The device's *live* configuration, which this model copies out of the scratch
   * buffer when the host writes the selector - the aux command - and at no other
   * time. That is the half a read-back cannot see: the host's word is in the buffer
   * (so a read-back compare passes) while the sampler still runs the old value.
   */
  live?: { divider: number };
  ready?: boolean;
  echo?: number; // override the selector echo in byte 0
}

/**
 * A device that behaves the way the real one was observed to: control
 * transfers are exactly 4 bytes, and any payload byte beyond the length the
 * device advertised is dropped on the floor without complaint.
 */
export class FakeSlogic {
  readonly log: string[] = [];
  /**
   * R32_FLAG model. RB_FLAG_FIFO_OV and RB_FLAG_INNER_ERR are latches, and
   * RB_FLAG_RDY is derived from the preconditions the spec lists for it.
   */
  readonly flags = { rst: false, fifoOverflow: false, innerError: false };
  /** aux 0x04 R32_SAMPLE_LEN, as written by the host. 0 means "no limit". */
  sampleLenValue = 0;
  /** R32_CTRL as the device holds it. The real register reads this back byte for byte. */
  ctrlValue = 0;
  /**
   * Writes to R32_CTRL the firmware swallows. The register keeps its old value, which is
   * what a dropped run/stop looks like from the host: the write resolves `ok`.
   */
  dropCtrlWrites = 0;
  /** When true every R32_CTRL write is swallowed from here on. */
  holdCtrl = false;
  private selector = 0;
  opened = true;
  configuration = {} as USBConfiguration;

  /** Called when RB_CTRL_EN is set, so an endpoint model can start producing. */
  protected onRun(): void {}

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

  /**
   * R32_FLAG as the spec describes it: RDY is asserted while the reset is released
   * and neither error latch is set, FIFO_OV is cleared only by writing a 1 to it.
   */
  private flagWord(): number {
    const ready = !this.flags.rst && !this.flags.fifoOverflow && !this.flags.innerError;
    return (ready ? 0x01 : 0) | (this.flags.fifoOverflow ? 0x02 : 0) |
      (this.flags.innerError ? 0x04 : 0);
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
      const swallowed = this.holdCtrl || this.dropCtrlWrites > 0;
      if (this.dropCtrlWrites > 0) this.dropCtrlWrites -= 1;
      if (!swallowed) {
        this.ctrlValue = word >>> 0;
        // CTRL: bit 1 is RB_CTRL_RST, which the spec says clears RDY immediately.
        this.flags.rst = (word & 0x02) !== 0;
        if (word & 0x01) this.onRun();
      }
    } else if (s.value === 0x0008) {
      // FLAG: RW1. Writing 0 to a write-1-to-clear bit does nothing, and the
      // other two bits are read-only, so only bit 1 can have an effect.
      if (word & 0x02) this.flags.fifoOverflow = false;
    } else if (s.value === 0x000c) {
      this.selector = word & 0xff;
      // Running the aux command is what makes the device read its scratch buffer.
      const live = this.aux[this.selector]?.live;
      if (live) live.divider = (this.aux[this.selector]!.payload[1] ?? 0) >>> 0;
    } else if (s.value >= 0x0010) {
      const m = this.model();
      const idx = (s.value - 0x0010) / 4;
      // The device only accepts as many words as it advertised; the rest of a
      // longer write is dropped silently, which is the whole trap here.
      const words = Math.max(1, Math.ceil(((m.status & 0xffff) >> 9) / 4));
      if (idx < words) {
        if (m.dropPayloadWrites) {
          m.dropPayloadWrites -= 1;
        } else {
          m.payload[idx] = word;
          if (idx === 0) m.onWord0?.(m, word);
          if (this.selector === 0x04 && idx === 0) this.sampleLenValue = word >>> 0;
        }
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
    if (s.value === 0x0008) {
      dv.setUint32(0, this.flagWord(), true);
    } else if (s.value === 0x0004) {
      dv.setUint32(0, this.ctrlValue, true);
    } else if (s.value === 0x000c) {
      const m = this.model();
      const w = this.statusWord(m);
      dv.setUint32(0, m.echo !== undefined ? (w & 0xffffff00) | m.echo : w, true);
    } else if (s.value >= 0x0010) {
      const m = this.model();
      const idx = (s.value - 0x0010) / 4;
      dv.setUint32(0, this.selector === 0x04 && idx === 0
        ? this.sampleLenValue
        : m.payload[idx] ?? 0, true);
    }
    this.log.push(`R ${s.value.toString(16)}`);
    return { status: 'ok', data: dv };
  }
}

export function view(bytes: number[]): DataView {
  const b = Uint8Array.from(bytes);
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}
/** The models as recorded from the real device. */
export function recorded(): Record<number, AuxModel> {
  return {
    0x01: { status: 0x00010401, payload: [0x0000ffff] },
    0x02: { status: 0x00011002, payload: [(800 << 16) | 0, 10] },
    0x03: { status: 0x00010403, payload: [0x00000136] },
    0x04: { status: 0x00010804, payload: [0] },
    0x05: { status: 0x00010205, payload: [0] },
  };
}

/**
 * A device that produces at a fixed rate on its **own clock**, with a FIFO behind it.
 *
 * This is the control the whole 32ch/200M question needs, and the one thing the scripted
 * `FakeStreamDevice` in the offline suite cannot be: there, a transferIn completes when the
 * host asks for it, so a host that stops reading is never punished. Here the sampler runs
 * from RUN whether or not anyone is reading, `fifoBytes` fill up, and everything produced
 * beyond them is **lost** - which is what the real board's FIFO does, and what turns "the
 * page was blocked for 38 ms" into "the capture is missing 30 MB".
 *
 * The rate is set in bytes per millisecond, so one constructor argument describes the wire
 * for every channel count: 32ch@200M is 800 B/ms... per microsecond, i.e. 800,000 B/ms.
 */
export class ClockStreamDevice extends FakeSlogic {
  productName = 'SLogic32 U3 (scripted clock)';
  serialNumber = 'clock';
  vendorId = 0x359f;
  productId = 0x3032;
  /** Bytes the sampler produces every millisecond of wall clock. 800,000 = 32ch@200M. */
  readonly bytesPerMs: number;
  /** Bytes the device can hold before it starts dropping what the host has not read. */
  readonly fifoBytes: number;

  private running = false;
  private t0 = 0;
  /** Bytes the host has taken off the wire, in device order. */
  taken = 0;
  /** Bytes already promised to reads that have not completed yet. */
  private committed = 0;
  private pending: Array<{
    timer: ReturnType<typeof setTimeout>;
    reject: (e: unknown) => void;
  }> = [];

  /**
   * Wall-clock milliseconds during which the sampler had **no submitted read to fill**.
   *
   * This is the number the harness is built around. The board's FIFO is small next to a
   * 3,129,344-byte transfer - it has to be, or the driver would not need `depth` queued
   * reads to avoid an overrun - so a millisecond with nothing queued is a millisecond of
   * samples the device has nowhere to put. `droppedBytes` is that time converted at the
   * sample rate: an estimate of the data a capture would have lost, not a device counter.
   */
  starvedMs = 0;
  worstStarveMs = 0;
  private idleSince: number | null = null;
  /** Bytes R32_SAMPLE_LEN allows, or Infinity: the device's own stop, as the board does it. */
  private limitBytes = Number.POSITIVE_INFINITY;
  /**
   * Reads issued after the device stopped itself. On the board those are NAKs that only
   * a cancelled URB ends (NOTES 8.9), so they resolve nothing and a release has to
   * reject them - a promise that never settles is not what libusb hands the driver.
   */
  private stoppedReads: Array<(e: unknown) => void> = [];

  constructor(bytesPerMs: number, fifoBytes = 262_144) {
    super(recorded32());
    this.bytesPerMs = bytesPerMs;
    this.fifoBytes = fifoBytes;
  }

  protected override onRun(): void {
    this.running = true;
    this.t0 = performance.now();
    this.taken = 0;
    this.committed = 0;
    this.idleSince = performance.now();
    // The board stops producing on its own once the programmed length is reached
    // (NOTES 8.9), which is the only end a capture can have without overrunning the FIFO.
    this.limitBytes = this.sampleLenValue > 0
      ? samplesForSampleLength(this.sampleLenValue) * 4
      : Number.POSITIVE_INFINITY;
  }

  /** True once the device has delivered everything R32_SAMPLE_LEN allowed. */
  get selfStopped(): boolean { return this.taken >= this.limitBytes; }

  /** Called by the model when CTRL_STOP lands: the sampler stops feeding the FIFO. */
  override async controlTransferOut(
    s: USBControlTransferParameters, data: BufferSource,
  ): Promise<USBOutTransferResult> {
    const result = await super.controlTransferOut(s, data);
    if (s.value === 0x0004 && (this.ctrlValue & 0x01) === 0) this.running = false;
    return result;
  }

  /** Bytes the sampler has produced since RUN. */
  private producedAt(now: number): number {
    if (!this.running) return 0;
    return Math.min((now - this.t0) * this.bytesPerMs, this.limitBytes);
  }

  /** Close a starvation window, if one is open. */
  private resume(now: number): void {
    if (this.idleSince === null) return;
    const gap = now - this.idleSince;
    this.idleSince = null;
    if (gap <= 0) return;
    this.starvedMs += gap;
    if (gap > this.worstStarveMs) this.worstStarveMs = gap;
  }

  /** Bytes the sampler produced with nothing queued to receive them. */
  get droppedBytes(): number {
    return Math.round(this.starvedMs * this.bytesPerMs);
  }

  transferIn(_ep: number, len: number): Promise<USBInTransferResult> {
    // Past its programmed length the device is stopped, and a read with nothing behind it
    // never completes - exactly the state the driver's self-stop handling exists for.
    // A read that *extends* past the length is the same fate arriving later: the board
    // sends its last full packet at the limit with no short packet and no ZLP (measured
    // 2026-09-14), so the URB fills partially and NAKs until it is cancelled.
    if (!this.running || this.taken >= this.limitBytes ||
        this.taken + this.committed + len > this.limitBytes) {
      return new Promise<USBInTransferResult>((_resolve, reject) => {
        this.stoppedReads.push(reject);
      });
    }
    const now = performance.now();
    // This read is what ends a starvation window: whatever the FIFO managed to hold is what
    // the host gets, and the rest is gone.
    this.resume(now);
    // Reads take the next `len` bytes of the stream in order, so the read completes one
    // transfer-time after the bytes before it were due - or at once if they are already
    // due, which is the case that a late host draining a full FIFO sees.
    const at = this.t0 + (this.taken + this.committed + len) / this.bytesPerMs;
    const immediate = this.producedAt(now) >= this.taken + this.committed + len;
    this.committed += len;
    return new Promise<USBInTransferResult>((resolve, reject) => {
      const complete = (): void => {
        this.committed -= len;
        this.taken += len;
        if (this.committed === 0) this.idleSince = performance.now();
        // Full length, like the board measured on hardware: a short transfer is the FIFO
        // running dry mid-transfer, not the ordinary case.
        // A zero-filled buffer, not `view(new Array(n).fill(0))`: at 3.13 MB per transfer
        // the number array is 25 MB of boxed doubles and building it costs more than the
        // whole transfer it is standing in for (measured: 165 ms per chunk, which made the
        // harness measure its own device instead of the transport).
        resolve({ status: 'ok', data: new DataView(new ArrayBuffer(len)) });
      };
      if (immediate) {
        complete();
        return;
      }
      const entry = {
        reject,
        timer: setTimeout(() => {
          this.pending = this.pending.filter((p) => p !== entry);
          complete();
        }, Math.max(0, at - now)),
      };
      this.pending.push(entry);
    });
  }

  /** Cancel every waiting read; the driver's stop path is what does this to a real one. */
  release(): void {
    this.running = false;
    this.idleSince = null;
    const pending = this.pending;
    this.pending = [];
    // A read that was waiting on a device that had already stopped is cancelled by the
    // release too: that is the only thing that ends it, on the board and here.
    const stopped = this.stoppedReads;
    this.stoppedReads = [];
    for (const p of pending) {
      clearTimeout(p.timer);
      // libusb reports a cancelled URB as an error, not as an empty transfer, and the
      // driver treats it as teardown rather than as a failure of the capture.
      p.reject(new Error('NetworkError: transfer was cancelled'));
    }
    for (const reject of stopped) reject(new Error('NetworkError: transfer was cancelled'));
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async selectConfiguration(): Promise<void> {}
  async claimInterface(): Promise<void> {}
  async clearHalt(): Promise<void> {}
  async reset(): Promise<void> {}
  async releaseInterface(): Promise<void> { this.release(); }
}

/** SLogic32 U3 replies expected from the slogic-dev model. */
export function recorded32(): Record<number, AuxModel> {
  return {
    // Real 32U3 firmware reports length 2 here but consumes/returns the complete padded
    // four-byte transfer for the mask.
    0x01: { status: 0x00010401, payload: [0xffffffff] },
    0x02: { status: 0x00011002, payload: [(1600 << 16) | 0, 100] },
    0x03: { status: 0x00010403, payload: [0x00000136] },
    0x04: { status: 0x00010804, payload: [0] },
    0x05: { status: 0x00010205, payload: [0] },
  };
}
