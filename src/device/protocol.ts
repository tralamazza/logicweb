// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Register-level protocol for the Sipeed SLogic16 U3 (VID 0x359f, PID 0x3031).
 *
 * Ground truth is the libsigrok driver at
 * src/hardware/sipeed-slogic-analyzer/{api.c,protocol.c}. Where docs/PROTOCOL-SLOGIC16U3.md
 * and the driver disagree, this file follows the driver; the disagreements are
 * listed in NOTES.md.
 *
 * Everything here throws on the first thing that does not look right. There is
 * no way to tell a rejected register write from an accepted one except by
 * reading the register back, so every configuration item is read back and
 * compared.
 */

export const USB_VID_SIPEED = 0x359f;
export const PID_SLOGIC16_U3 = 0x3031;

/** Vendor control requests (api.c:1129). */
const REQ_REG_READ = 0x00;
const REQ_REG_WRITE = 0x01;

/** Registers (api.c:1132). */
const R32_CTRL = 0x0004;
const R32_AUX = 0x000c;
const R32_AUX_PAYLOAD = R32_AUX + 4; // 0x0010

/** Bulk IN endpoint: 0x02 | IN. WebUSB takes the endpoint number only. */
export const EP_IN = 2;

/** aux selectors. */
export const AUX_CHANNELS = 0x01;
export const AUX_SAMPLERATE = 0x02;
export const AUX_VREF = 0x03;
export const AUX_TEST_MODE = 0x05;

export const TEST_MODE_NORMAL = 0;
export const TEST_MODE_USB_MAX_SPEED = 1;
export const TEST_MODE_EMULATION = 2;

/**
 * The aux scratch buffer is 64 bytes in the driver (union aux_buf). Word 0 is
 * the command/status word at R32_AUX; the payload lives at R32_AUX+4, so only
 * 60 bytes are addressable and the device-reported length is clamped to that
 * (api.c:1158). Without the clamp a bogus length overruns the buffer.
 */
const AUX_BUF_BYTES = 64;
const AUX_PAYLOAD_MAX = (AUX_BUF_BYTES - 4) & ~3; // 60

/** Ready-bit poll budget. The driver gives up after 6 reads (api.c:1256). */
const AUX_READY_READS = 6;

/** Samplerate base-index walk budget (api.c:1324). */
const SAMPLERATE_BASE_PASSES = 6;

/**
 * Highest base index that exists. The driver's walk is `while (u16[2] <= 1)`
 * (api.c:1325), i.e. only indices 0 and 1 are ever tried; the iteration counter
 * inside it is a second guard, not the bound. Without an index bound a device
 * on which no base divides the requested rate would have indices 2, 3, 4, ...
 * written to a live register before giving up. The driver writes index 2 once
 * before its loop condition stops it; this code refuses to write it at all.
 */
const MAX_BASE_INDEX = 1;

/** Vref DAC transfer function, measured on S/N 202512261505 (api.c:1447). */
const VREF_SLOPE = 0.005166; // volts per LSB
const VREF_OFFSET = 0.4318; // volts at code 0
const VREF_CODE_MAX = 1023;

export const SAMPLERATES_HZ = [
  5e6, 8e6, 10e6, 16e6, 20e6, 25e6, 32e6, 40e6, 50e6, 80e6, 100e6, 160e6, 200e6,
  400e6, 800e6,
];

/** Non-Windows ceiling by channel count (api.c:134). */
export const MAX_SAMPLERATE_HZ: Record<number, number> = {
  4: 800e6,
  8: 400e6,
  16: 200e6,
};

export const SUPPORTED_CHANNELS = [4, 8, 16] as const;

/**
 * Bytes backed by a plain ArrayBuffer. WebUSB will not take a view onto a
 * SharedArrayBuffer, and the generic Uint8Array in TS 5.7+ makes that explicit.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

function alignUp4(n: number): number {
  return (n + 3) & ~3;
}

export function vrefCode(volts: number): number {
  const raw = (volts - VREF_OFFSET) / VREF_SLOPE;
  const clamped = raw < 0 ? 0 : raw > VREF_CODE_MAX ? VREF_CODE_MAX : raw;
  return Math.floor(clamped + 0.5);
}

export function vrefVolts(code: number): number {
  return VREF_SLOPE * code + VREF_OFFSET;
}

/** A line of protocol traffic, for the self-test page and for bug reports. */
export interface TraceEntry {
  dir: 'wr' | 'rd' | 'info';
  addr?: number;
  bytes?: string;
  note: string;
}

export type Tracer = (e: TraceEntry) => void;

function hex(b: Bytes): string {
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Every control transfer moves exactly 4 bytes with the register address in
 * wValue, incremented by 4 per chunk (api.c:791/838). A single longer transfer
 * is not accepted by the device. Lengths are rounded *up* to a multiple of 4;
 * they are never rounded down, which matters because the device reports aux
 * payload lengths of 1 and 2 (see NOTES.md).
 */
export class RegisterBus {
  constructor(
    private readonly dev: USBDevice,
    private readonly trace: Tracer = () => {},
  ) {}

  async write(addr: number, data: Bytes): Promise<void> {
    const len = alignUp4(data.length);
    const padded: Bytes =
      len === data.length
        ? data
        : (() => {
            const p = new Uint8Array(len);
            p.set(data);
            return p;
          })();

    for (let i = 0; i < len; i += 4) {
      const chunk = padded.subarray(i, i + 4);
      const r = await this.dev.controlTransferOut(
        {
          requestType: 'vendor',
          recipient: 'device',
          request: REQ_REG_WRITE,
          value: addr + i,
          index: 0,
        },
        chunk,
      );
      // Silent rejection is the default failure mode: a stalled control
      // transfer still resolves, it just does not report 'ok'.
      if (r.status !== 'ok') {
        throw new Error(
          `control write to reg 0x${(addr + i).toString(16)} returned status "${r.status}"`,
        );
      }
      if (r.bytesWritten !== 4) {
        throw new Error(
          `control write to reg 0x${(addr + i).toString(16)} moved ${r.bytesWritten} bytes, expected 4`,
        );
      }
      this.trace({ dir: 'wr', addr: addr + i, bytes: hex(chunk), note: '' });
    }
  }

  async read(addr: number, length: number): Promise<Bytes> {
    const len = alignUp4(length);
    const out = new Uint8Array(len);

    for (let i = 0; i < len; i += 4) {
      const r = await this.dev.controlTransferIn(
        {
          requestType: 'vendor',
          recipient: 'device',
          request: REQ_REG_READ,
          value: addr + i,
          index: 0,
        },
        4,
      );
      if (r.status !== 'ok') {
        throw new Error(
          `control read of reg 0x${(addr + i).toString(16)} returned status "${r.status}"`,
        );
      }
      if (!r.data || r.data.byteLength !== 4) {
        throw new Error(
          `control read of reg 0x${(addr + i).toString(16)} returned ${r.data?.byteLength ?? 0} bytes, expected 4`,
        );
      }
      out.set(
        new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength),
        i,
      );
      this.trace({
        dir: 'rd',
        addr: addr + i,
        bytes: hex(out.subarray(i, i + 4)),
        note: '',
      });
    }

    return out.subarray(0, len);
  }

  writeCtrl(value: number): Promise<void> {
    return this.write(R32_CTRL, Uint8Array.of(value, 0, 0, 0));
  }
}

/** CTRL register values (api.c:1229/1242/1497). */
export const CTRL_STOP = 0x00;
export const CTRL_RUN = 0x01;
export const CTRL_RESET = 0x02;

/**
 * Aux transaction. The buffer mirrors the driver's union aux_buf: bytes 0..3
 * are the status word read back from R32_AUX, bytes 4.. are the payload at
 * R32_AUX+4.
 */
export class AuxTransaction {
  /** Device-reported payload length, in bytes, after clamping. */
  readonly payloadLen: number;
  private readonly buf = new Uint8Array(AUX_BUF_BYTES);
  private readonly view: DataView;

  private constructor(
    private readonly bus: RegisterBus,
    readonly selector: number,
    status: Bytes,
  ) {
    this.buf.set(status.subarray(0, 4), 0);
    this.view = new DataView(this.buf.buffer);
    const raw = this.view.getUint16(0, true) >> 9;
    if (raw > AUX_PAYLOAD_MAX) {
      // Unclamped this overruns the buffer. The driver warns and clamps.
      console.warn(
        `[slogic] aux selector 0x${selector.toString(16)} reported payload length ${raw}, clamping to ${AUX_PAYLOAD_MAX}`,
      );
      this.payloadLen = AUX_PAYLOAD_MAX;
    } else {
      this.payloadLen = raw;
    }
  }

  /**
   * Write the selector and wait for the ready bit. The status word comes back
   * as (payloadLen << 9) | selector in the first halfword, with bit 0 of byte 2
   * as the ready flag.
   */
  static async begin(
    bus: RegisterBus,
    selector: number,
    trace: Tracer = () => {},
  ): Promise<AuxTransaction> {
    await bus.write(R32_AUX, Uint8Array.of(selector, 0, 0, 0));

    let status: Bytes | null = null;
    for (let i = 0; i < AUX_READY_READS; i++) {
      status = await bus.read(R32_AUX, 4);
      if (status[2] & 0x01) break;
      status = null;
    }
    if (!status) {
      throw new Error(
        `aux selector 0x${selector.toString(16)}: ready bit never set after ${AUX_READY_READS} reads`,
      );
    }
    // The device echoes the selector in byte 0. Observed for selectors
    // 0x01/0x02/0x03/0x05 on S/N 202512261505. A mismatch means the aux engine
    // is answering about something else and everything after would be garbage.
    if (status[0] !== selector) {
      throw new Error(
        `aux selector 0x${selector.toString(16)}: device echoed 0x${status[0].toString(16)}`,
      );
    }

    const tx = new AuxTransaction(bus, selector, status);
    trace({
      dir: 'info',
      note: `aux 0x${selector.toString(16)} ready, payload ${tx.payloadLen} bytes`,
    });
    return tx;
  }

  /** Bytes actually moved for the payload: the length rounded up to 4. */
  get payloadTransferLen(): number {
    return alignUp4(this.payloadLen);
  }

  async readPayload(): Promise<void> {
    if (this.payloadLen === 0) {
      throw new Error(
        `aux selector 0x${this.selector.toString(16)}: device reported a zero-length payload`,
      );
    }
    const p = await this.bus.read(R32_AUX_PAYLOAD, this.payloadLen);
    this.buf.set(p.subarray(0, Math.min(p.length, AUX_BUF_BYTES - 4)), 4);
  }

  async writePayload(): Promise<void> {
    await this.bus.write(
      R32_AUX_PAYLOAD,
      this.buf.subarray(4, 4 + this.payloadTransferLen),
    );
  }

  /** Write only the first payload word, as the base-index walk does. */
  async writePayloadWord0(): Promise<void> {
    await this.bus.write(R32_AUX_PAYLOAD, this.buf.subarray(4, 8));
  }

  /** Payload word `i`, i.e. the driver's aux.u32[i + 1]. */
  u32(i: number): number {
    return this.view.getUint32(4 + i * 4, true);
  }

  setU32(i: number, v: number): void {
    this.assertInPayload(i * 4 + 4);
    const mask = this.wordMask(i);
    if (((v >>> 0) & ~mask) >>> 0) {
      throw new Error(
        `aux selector 0x${this.selector.toString(16)}: value 0x${(v >>> 0).toString(16)} ` +
          `does not fit the ${this.advertisedBytesInWord(i)} byte(s) the device advertised ` +
          `for payload word ${i}`,
      );
    }
    this.view.setUint32(4 + i * 4, v >>> 0, true);
  }

  /**
   * Bytes of payload word `i` the device actually claims to hold. The reported
   * length is not a multiple of 4 (1 and 2 are both real on this hardware), so
   * the trailing bytes of a word can be outside it.
   */
  advertisedBytesInWord(i: number): number {
    return Math.max(0, Math.min(4, this.payloadLen - i * 4));
  }

  /**
   * Mask covering only the advertised bytes of word `i`. Read-back comparisons
   * must use this: the device advertises 2 bytes for the channel mask and vref
   * and 1 for the test mode, so the rest of the 32-bit word it returns is
   * simply not part of the register. On this unit those bytes happen to read
   * back zero, but a unit or firmware that leaves junk there would make every
   * verification fail and no capture would be possible at all - while
   * sigrok-cli, which does not check, would work fine.
   */
  wordMask(i: number): number {
    const n = this.advertisedBytesInWord(i);
    if (n === 0) {
      throw new Error(
        `aux selector 0x${this.selector.toString(16)}: payload word ${i} is entirely outside ` +
          `the ${this.payloadLen}-byte payload the device advertised`,
      );
    }
    return n >= 4 ? 0xffffffff : (((1 << (n * 8)) >>> 0) - 1) >>> 0;
  }

  /** Read-back check, scoped to the bytes the device says the register has. */
  verifyU32(i: number, expected: number): boolean {
    const mask = this.wordMask(i);
    return ((this.u32(i) & mask) >>> 0) === (((expected >>> 0) & mask) >>> 0);
  }

  u16(i: number): number {
    return this.view.getUint16(4 + i * 2, true);
  }

  setU16(i: number, v: number): void {
    this.assertInPayload(i * 2 + 2);
    this.view.setUint16(4 + i * 2, v & 0xffff, true);
  }

  /**
   * A field past payloadTransferLen would be modified locally and then never
   * written to the device: the write-back only covers the reported length.
   * That is exactly the silent no-op this driver has to avoid.
   */
  private assertInPayload(endByte: number): void {
    if (endByte > this.payloadTransferLen) {
      throw new Error(
        `aux selector 0x${this.selector.toString(16)}: field ends at payload byte ${endByte} ` +
          `but the device only accepts ${this.payloadTransferLen} bytes`,
      );
    }
  }
}

/** aux 0x01: enabled-channel bitmask. */
export async function configureChannels(
  bus: RegisterBus,
  channels: number,
  trace: Tracer = () => {},
): Promise<void> {
  const tx = await AuxTransaction.begin(bus, AUX_CHANNELS, trace);
  await tx.readPayload();
  const mask = channels >= 32 ? 0xffffffff : ((1 << channels) - 1) >>> 0;
  tx.setU32(0, mask);
  await tx.writePayload();
  await tx.readPayload();
  if (!tx.verifyU32(0, mask)) {
    throw new Error(
      `channel mask not accepted: wrote 0x${mask.toString(16)}, read back 0x${tx.u32(0).toString(16)} ` +
        `(compared over the ${tx.advertisedBytesInWord(0)} advertised byte(s))`,
    );
  }
  trace({ dir: 'info', note: `channel mask 0x${mask.toString(16)} verified` });
}

/**
 * aux 0x02: samplerate.
 *
 * Payload layout: u16[0] base index, u16[1] base clock in MHz, u32[1] divider.
 * On S/N 202512261505 the device reports base index 0 / 800 MHz, and every rate
 * in the table divides 800 MHz exactly, so the base-index walk never runs. The
 * walk is implemented anyway, with the iteration cap the driver added: firmware
 * that keeps reporting the same base index otherwise spins forever.
 */
export async function configureSamplerate(
  bus: RegisterBus,
  samplerateHz: number,
  trace: Tracer = () => {},
): Promise<{ baseHz: number; divider: number }> {
  const tx = await AuxTransaction.begin(bus, AUX_SAMPLERATE, trace);
  // Payload word 0 is {base index, base MHz} and word 1 is the divider, so the
  // device has to accept at least 8 payload bytes. Anything shorter would let
  // the divider write fall off the end and be dropped without complaint.
  if (tx.payloadTransferLen < 8) {
    throw new Error(
      `samplerate aux payload is ${tx.payloadTransferLen} bytes, need at least 8 for the divider`,
    );
  }

  for (let pass = 0; pass < SAMPLERATE_BASE_PASSES; pass++) {
    await tx.readPayload();
    const baseIndex = tx.u16(0);
    const baseMHz = tx.u16(1);
    const baseHz = baseMHz * 1e6;
    trace({
      dir: 'info',
      note: `samplerate base[${baseIndex}] = ${baseMHz} MHz, divider reg = ${tx.u32(1)}`,
    });

    if (baseHz === 0 || baseHz % samplerateHz !== 0) {
      if (baseIndex >= MAX_BASE_INDEX) {
        throw new Error(
          `could not configure ${samplerateHz / 1e6} MHz: base[${baseIndex}] = ${baseMHz} MHz ` +
            `does not divide it and index ${MAX_BASE_INDEX} is the last one that exists`,
        );
      }
      tx.setU16(0, baseIndex + 1);
      await tx.writePayloadWord0();
      continue;
    }

    const divider = baseHz / samplerateHz;
    tx.setU32(1, divider - 1);
    await tx.writePayload();
    await tx.readPayload();
    if (!tx.verifyU32(1, divider - 1)) {
      throw new Error(
        `samplerate divider not accepted: wrote ${divider - 1}, read back ${tx.u32(1)}`,
      );
    }
    if (tx.u16(1) * 1e6 !== baseHz) {
      throw new Error(
        `samplerate base changed under us: ${tx.u16(1)} MHz after write, ${baseMHz} MHz before`,
      );
    }
    trace({
      dir: 'info',
      note: `samplerate ${samplerateHz / 1e6} MHz = ${baseMHz} MHz / ${divider} verified`,
    });
    return { baseHz, divider };
  }

  throw new Error(
    `could not configure ${samplerateHz / 1e6} MHz: no usable base clock after ${SAMPLERATE_BASE_PASSES} passes`,
  );
}

/** aux 0x03: input threshold, as a vref DAC code. */
export async function configureThreshold(
  bus: RegisterBus,
  volts: number,
  trace: Tracer = () => {},
): Promise<{ code: number; achievedVolts: number }> {
  const tx = await AuxTransaction.begin(bus, AUX_VREF, trace);
  await tx.readPayload();
  const code = vrefCode(volts);
  tx.setU32(0, code);
  await tx.writePayload();
  await tx.readPayload();
  if (!tx.verifyU32(0, code)) {
    throw new Error(
      `threshold not accepted: wrote code ${code}, read back ${tx.u32(0)} ` +
        `(compared over the ${tx.advertisedBytesInWord(0)} advertised byte(s))`,
    );
  }
  const achievedVolts = vrefVolts(code);
  trace({
    dir: 'info',
    note: `threshold ${volts.toFixed(3)} V -> code ${code} (${achievedVolts.toFixed(3)} V) verified`,
  });
  return { code, achievedVolts };
}

/** aux 0x05: built-in test pattern. */
export async function configureTestMode(
  bus: RegisterBus,
  mode: number,
  trace: Tracer = () => {},
): Promise<void> {
  const tx = await AuxTransaction.begin(bus, AUX_TEST_MODE, trace);
  await tx.readPayload();
  tx.setU32(0, mode);
  await tx.writePayload();
  await tx.readPayload();
  if (!tx.verifyU32(0, mode)) {
    throw new Error(
      `test mode not accepted: wrote ${mode}, read back ${tx.u32(0)} ` +
        `(compared over the ${tx.advertisedBytesInWord(0)} advertised byte(s))`,
    );
  }
  trace({ dir: 'info', note: `test mode ${mode} verified` });
}
