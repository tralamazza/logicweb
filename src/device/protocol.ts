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
/** SLogic32 U3 (the 800 MB/s-class board described by the slogic-dev driver). */
export const PID_SLOGIC32_U3 = 0x3032;

/** Vendor control requests (api.c:1129). */
const REQ_REG_READ = 0x00;
const REQ_REG_WRITE = 0x01;

/** Registers (api.c:1132). */
const R32_CTRL = 0x0004;
const R32_AUX = 0x000c;
const R32_AUX_PAYLOAD = R32_AUX + 4; // 0x0010

/**
 * Status register (0x08). Bits, from the vendor protocol spec ("USB LA 协议规范",
 * REGISTER MAP):
 *
 *   [2] RB_FLAG_INNER_ERR  RO   internal error
 *   [1] RB_FLAG_FIFO_OV    RW1  FIFO overflow, write 1 to clear, reset value NA
 *   [0] RB_FLAG_RDY        RO   module ready; a reset clears it immediately
 *
 * The spec makes RB_FLAG_RDY a precondition for RB_CTRL_EN and lists FIFO_OV == 0
 * and INNER_ERR == 0 among the conditions RDY needs. FIFO_OV has a reset value of
 * "NA" (it is an event latch, not a configuration field) and the spec makes it
 * write-1-to-clear, so the spec does not promise that the module reset in R32_CTRL
 * clears it; the same section says resetting R32_CTRL "needs R32_CTRL and every later
 * register written as well". The libsigrok driver never reads or writes this register
 * at all (api.c:906 defines SLOGIC16U3_R32_FLAG and never uses it).
 *
 * Measured on S/N 202608052052, 2026-09-10 (NOTES 8.4): CTRL.RST *does* clear the
 * latch - EN with no reader set FIFO_OV, and the reset bit alone took it back to 0 -
 * so a wedged board is not explained by a surviving overflow bit. RDY, on the other
 * hand, never asserted in any state observed, including a healthy idle board with
 * FUNC_SEL != 0 and both error bits clear, so nothing may gate on it.
 */
export const R32_FLAG = 0x0008;

/** RB_FLAG_FIFO_OV, as a write: write-1-to-clear. */
const FLAG_FIFO_OV_W1C = 0x02;

/** Bulk IN endpoint: 0x02 | IN. WebUSB takes the endpoint number only. */
export const EP_IN = 2;

/** aux selectors. */
export const AUX_CHANNELS = 0x01;
export const AUX_SAMPLERATE = 0x02;
export const AUX_VREF = 0x03;
export const AUX_SAMPLE_LEN = 0x04;
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
 * Read -> write -> read cycles a samplerate programming attempt gets before the
 * device is declared broken.
 *
 * The samplerate payload is the one register whose read-back is not proof on its
 * own (NOTES 8.11). R32_AUX+4 is the device's aux scratch buffer, so reading it back
 * says the host's word reached the buffer, not that the sampler's live divider moved
 * to it. Measured on S/N 202608052052 (32ch, 100 MHz then 5 MHz in a loop): every
 * step read back `verified`, and one capture in six still came off the wire at the
 * *previous* rate. Re-running the whole cycle is what put it right - and the cycle
 * has to include the selector write, because that write is the aux command and the
 * only thing the host can do that makes the device look at the buffer again.
 */
const SAMPLERATE_WRITE_CYCLES = 3;

/**
 * Highest base index that exists. The driver's walk is `while (u16[2] <= 1)`
 * (api.c:1325), i.e. only indices 0 and 1 are ever tried; the iteration counter
 * inside it is a second guard, not the bound. Without an index bound a device
 * on which no base divides the requested rate would have indices 2, 3, 4, ...
 * written to a live register before giving up. The driver writes index 2 once
 * before its loop condition stops it; this code refuses to write it at all.
 */
const MAX_BASE_INDEX = 1;

/**
 * Largest divider the sampler actually uses.
 *
 * The register holds 32 bits and reads back whatever was written, but the sampler
 * only honours the low byte (NOTES 8.9, measured on S/N 202608052052): writing
 * divider 279 to a 1400 MHz base delivered 58.33 MS/s, i.e. 1400 / (279 & 0xff +
 * 1) = 1400 / 24, not the 5 MHz the register says. The smallest rate a base can
 * express is therefore base / 256 - 5.47 MHz on the 32U3's 1400 MHz base and
 * 3.13 MHz on its 800 MHz one - and a base whose quotient does not fit a byte has
 * to be skipped rather than written, which is what the walk below does.
 */
const MAX_SAMPLERATE_DIVIDER = 0xff;

/** Vref DAC transfer function, measured on S/N 202512261505 (api.c:1447). */
const VREF_SLOPE = 0.005166; // volts per LSB
const VREF_OFFSET = 0.4318; // volts at code 0
const VREF_CODE_MAX = 1023;

export const SAMPLERATES_HZ = [
  5e6, 8e6, 10e6, 16e6, 20e6, 25e6, 32e6, 40e6, 50e6, 80e6, 100e6, 160e6, 200e6,
  400e6, 800e6,
  1.6e9,
];

/** Non-Windows ceiling by channel count (api.c:134). */
export const MAX_SAMPLERATE_HZ: Record<number, number> = {
  4: 800e6,
  8: 400e6,
  16: 200e6,
};

/** SLogic32 U3 ceilings from the slogic-dev libsigrok model. */
export const MAX_SAMPLERATE_HZ_SLOGIC32_U3: Record<number, number> = {
  4: 1.6e9,
  8: 800e6,
  16: 400e6,
  32: 200e6,
};

export const SUPPORTED_CHANNELS = [4, 8, 16, 32] as const;

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
 * Deadline for a single control transfer.
 *
 * The driver hands libusb 500 ms for every register read and write
 * (`api.c:641`/`api.c:683` pass 500 into `libusb_control_transfer`), and libusb
 * cancels the URB when that expires. WebUSB has no such parameter and cannot
 * cancel a request it has already submitted, so this bound cannot retry: it only
 * converts "the page waits forever" into "the page reports what happened". The
 * value is deliberately looser than the driver's because a WebUSB transfer
 * crosses two extra process hops, and a capture saturating the CPU has to be
 * allowed to delay a control transfer without being declared broken.
 *
 * Measured on S/N 202608052052: a full open() sequence (CTRL, channel mask,
 * samplerate, vref, flags) takes 5-30 ms in total, so 2 s cannot fire on a board
 * that is answering.
 */
export const CONTROL_TIMEOUT_MS = 2000;

/**
 * Resolve with `work`, or reject with a named timeout once `timeoutMs` passes.
 *
 * The abandoned transfer is left pending inside Chromium - there is no API to
 * take it back - so its eventual settlement is swallowed here rather than
 * escaping as an unhandled rejection behind an error the caller has already been
 * handed.
 */
export function withControlTimeout<T>(
  work: Promise<T>,
  what: string,
  timeoutMs: number = CONTROL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `${what} did not complete within ${timeoutMs} ms; the board stopped ` +
        'answering control transfers',
      ));
    }, timeoutMs);
  });
  work.catch(() => {});
  return Promise.race([work, expired]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
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
    private readonly timeoutMs: number = CONTROL_TIMEOUT_MS,
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
      const r = await withControlTimeout(
        this.dev.controlTransferOut(
          {
            requestType: 'vendor',
            recipient: 'device',
            request: REQ_REG_WRITE,
            value: addr + i,
            index: 0,
          },
          chunk,
        ),
        `control write to reg 0x${(addr + i).toString(16)}`,
        this.timeoutMs,
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
      const r = await withControlTimeout(
        this.dev.controlTransferIn(
          {
            requestType: 'vendor',
            recipient: 'device',
            request: REQ_REG_READ,
            value: addr + i,
            index: 0,
          },
          4,
        ),
        `control read of reg 0x${(addr + i).toString(16)}`,
        this.timeoutMs,
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

/** Decoded R32_FLAG, the device's readiness and error state. */
export interface DeviceFlags {
  /** The low byte of R32_FLAG. Bits above 2 are reserved and always 0. */
  raw: number;
  /** RB_FLAG_RDY: the device may be enabled. */
  ready: boolean;
  /** RB_FLAG_FIFO_OV: the FIFO overran. Write 1 to clear. */
  fifoOverflow: boolean;
  /** RB_FLAG_INNER_ERR: read-only; the spec documents no way to clear it. */
  innerError: boolean;
}

export function decodeDeviceFlags(raw: number): DeviceFlags {
  return {
    raw: raw & 0xff,
    ready: (raw & 0x01) !== 0,
    fifoOverflow: (raw & 0x02) !== 0,
    innerError: (raw & 0x04) !== 0,
  };
}

export function describeDeviceFlags(f: DeviceFlags): string {
  return `R32_FLAG=0x${f.raw.toString(16).padStart(2, '0')} ` +
    `RDY=${f.ready ? 1 : 0} FIFO_OV=${f.fifoOverflow ? 1 : 0} ` +
    `INNER_ERR=${f.innerError ? 1 : 0}`;
}

/** Read and decode R32_FLAG. One 4-byte control read at 0x08. */
export async function readDeviceFlags(
  bus: RegisterBus,
  trace: Tracer = () => {},
): Promise<DeviceFlags> {
  const word = await bus.read(R32_FLAG, 4);
  const flags = decodeDeviceFlags(word[0] ?? 0);
  trace({ dir: 'info', note: describeDeviceFlags(flags) });
  return flags;
}

/**
 * Clear a latched FIFO overflow, and report what the flag says afterwards.
 *
 * RB_FLAG_FIFO_OV is write-1-to-clear, so the write is a single 1 in bit 1 and
 * zero in every other bit (all of them are read-only and reserved).
 */
export async function clearFifoOverflow(
  bus: RegisterBus,
  trace: Tracer = () => {},
): Promise<DeviceFlags> {
  await bus.write(R32_FLAG, Uint8Array.of(FLAG_FIFO_OV_W1C));
  trace({ dir: 'info', note: 'wrote RB_FLAG_FIFO_OV=1 (write-1-to-clear)' });
  return readDeviceFlags(bus, trace);
}

/** CTRL register values (api.c:1229/1242/1497). */
export const CTRL_STOP = 0x00;
export const CTRL_RUN = 0x01;
/**
 * RB_CTRL_RST. Kept for the register map's sake and deliberately never written by
 * this transport (NOTES 8.13): the spec says RST resets the module and everything
 * programmed after it, and the state that makes a freshly replugged 32U3 answer
 * nothing on the bulk endpoint is exactly this bit left set. A verified de-assert
 * gets the same board back without dropping the configuration with it.
 */
export const CTRL_RESET = 0x02;

/**
 * Read -> write -> read cycles a CTRL write gets before the device is declared broken.
 * Same budget as the samplerate walk: enough for a write the aux/module logic missed
 * once, short enough that a device which is never going to take it fails instead of
 * looping.
 */
const CTRL_WRITE_CYCLES = 3;

/** Low byte of R32_CTRL as the device reports it. */
async function readCtrlByte(bus: RegisterBus): Promise<number> {
  const word = await bus.read(R32_CTRL, 4);
  return word[0] ?? 0;
}

/**
 * Program R32_CTRL and verify it by reading the register, writing it, and reading it
 * back, repeating the cycle up to `CTRL_WRITE_CYCLES` times.
 *
 * Every other register in this file is verified from its read-back; CTRL is the one
 * that was simply written and hoped for, and it is the one register whose read-back
 * mirrors the *live* state rather than the aux scratch buffer: measured on S/N
 * 202608052052, `R32_CTRL` answers the byte that was written (`00`, `01` and `02` all
 * read back byte for byte at offset 0), so a mismatch here is a real dropped write and
 * not NOTES 8.11's buffer-talking-to-itself. That is what makes this cycle worth
 * running: the firmware can miss a write, and a missed `CTRL_RUN` or a surviving
 * `CTRL_RST` both look like a dead board from everywhere else.
 *
 * A read that fails at the transport level is reported and the write is still sent:
 * the driver's own contract is one 4-byte vendor write, a firmware that cannot answer
 * a read of 0x04 is a firmware this must not refuse to talk to, and losing the
 * verification is strictly better than losing the capture. Returns the cycle the value
 * stuck on, or 0 when the register could not be read at all.
 */
export async function programCtrl(
  bus: RegisterBus,
  value: number,
  trace: Tracer = () => {},
  where = 'CTRL',
): Promise<number> {
  const wanted = value & 0xff;
  let last = 'no cycle ran';
  for (let cycle = 1; cycle <= CTRL_WRITE_CYCLES; cycle++) {
    let was: number;
    try {
      was = await readCtrlByte(bus);
    } catch (e) {
      await bus.writeCtrl(wanted);
      trace({
        dir: 'info',
        note: `${where}=0x${wanted.toString(16).padStart(2, '0')} written unverified: ` +
          `R32_CTRL is unreadable (${String(e)})`,
      });
      return 0;
    }
    await bus.writeCtrl(wanted);
    const now = await readCtrlByte(bus);
    if (now === wanted) {
      trace({
        dir: 'info',
        note: `${where}=0x${wanted.toString(16).padStart(2, '0')} verified` +
          (cycle > 1 ? ` (cycle ${cycle})` : '') +
          (was === wanted ? ' (the register already held it)' : ''),
      });
      return cycle;
    }
    last = `wrote 0x${wanted.toString(16).padStart(2, '0')}, read back ` +
      `0x${now.toString(16).padStart(2, '0')}`;
    trace({
      dir: 'info',
      note: `${where}: cycle ${cycle} did not stick (${last}, was 0x${was
        .toString(16).padStart(2, '0')}), writing it again`,
    });
  }
  throw new Error(
    `${where}=0x${wanted.toString(16).padStart(2, '0')} never stuck across ` +
      `${CTRL_WRITE_CYCLES} read/write/read cycles (${last})`,
  );
}

/**
 * aux 0x04: R32_SAMPLE_LEN, the count at which the device stops uploading by itself.
 *
 * The vendor spec gives the reason this exists: "需要采集的长度, 用于达到采集长度后停止
 * 上传, 防止停止采样命令设置前还在上传数据导致 Overflow" - the firmware stops producing
 * once it has captured this much, so a host that is late with its stop command cannot drive
 * it into an overflow. Neither the driver nor this transport has ever written it (it reads
 * back 0), and NOTES 8.6 measures what an unstopped producer costs: an overrun kills the
 * bulk endpoint until the board is replugged.
 *
 * The unit is not stated unambiguously ("k SamplesByte"), so the value is exposed raw. It
 * has to be calibrated against the wire byte count of a real capture before any capture
 * path can rely on it; the advanced console is where that happens.
 */
export async function readSampleLength(
  bus: RegisterBus,
  trace: Tracer = () => {},
): Promise<number> {
  const tx = await AuxTransaction.begin(bus, AUX_SAMPLE_LEN, trace);
  await tx.readPayload();
  return tx.u32(0);
}

/** Write R32_SAMPLE_LEN and read it back. Returns the value the device reports. */
export async function writeSampleLength(
  bus: RegisterBus,
  value: number,
  trace: Tracer = () => {},
): Promise<number> {
  const tx = await AuxTransaction.begin(bus, AUX_SAMPLE_LEN, trace);
  await tx.readPayload();
  tx.setU32(0, value);
  await tx.writePayload();
  await tx.readPayload();
  if (!tx.verifyU32(0, value)) {
    throw new Error(
      `sample length not accepted: wrote ${value}, read back ${tx.u32(0)} ` +
        `(compared over the ${tx.advertisedBytesInWord(0)} advertised byte(s))`,
    );
  }
  trace({ dir: 'info', note: `sample length ${value} verified` });
  return tx.u32(0);
}

/**
 * R32_SAMPLE_LEN has units of 1024 samples and a fixed offset, both measured on
 * S/N 202608052052 (NOTES 8.9): the device produced `value * 1024 - 2048` samples
 * for values 500, 1000, 2000 and 100000, at two different sample rates, and it
 * always stopped on a whole 1024-byte packet boundary. A value of 0 is not
 * "zero samples" - it is the reset value and means "no limit", which is what
 * every capture path here and in libsigrok relied on before this existed.
 */
export const SAMPLE_LEN_UNIT_SAMPLES = 1024;
export const SAMPLE_LEN_OFFSET_SAMPLES = 2048;

/** Register value that makes the device stop after at least `samples` samples. */
export function sampleLengthForSamples(samples: number): number {
  if (!(samples > 0)) return 0;
  // Round up: the offset and the packet granularity both make the device stop a
  // little early otherwise, and a capture that is one unit short ends on a
  // timeout instead of on the device's own stop.
  const units = Math.max(2, Math.ceil((samples + SAMPLE_LEN_OFFSET_SAMPLES) / SAMPLE_LEN_UNIT_SAMPLES));
  return Math.min(units, 0xffffffff);
}

/** Samples the device produces for a register value; 0 when the limit is off. */
export function samplesForSampleLength(value: number): number {
  if (!(value > 0)) return 0;
  return Math.max(0, value * SAMPLE_LEN_UNIT_SAMPLES - SAMPLE_LEN_OFFSET_SAMPLES);
}

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
   * Write a complete word when firmware reports a short logical payload but the USB
   * transaction is padded to four bytes. SLogic32 U3 uses this legacy encoding for its
   * 32-bit channel mask: selector 0x01 still reports length 2, while the upper 16 mask
   * bits live in the two padding bytes. The slogic-dev driver likewise assigns u32 and
   * relies on its control-write helper rounding the reported length up to four.
   */
  setPaddedU32(i: number, v: number): void {
    this.assertInPayload(i * 4 + 4);
    this.view.setUint32(4 + i * 4, v >>> 0, true);
  }

  /** Full-word counterpart of setPaddedU32(). */
  verifyPaddedU32(i: number, expected: number): boolean {
    this.assertInPayload(i * 4 + 4);
    return this.u32(i) === (expected >>> 0);
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
  // 32U3 firmware retains the 16U3 length field (2) but consumes a complete u32
  // because every control transfer is rounded up to four bytes.
  if (channels === 32) tx.setPaddedU32(0, mask);
  else tx.setU32(0, mask);
  await tx.writePayload();
  await tx.readPayload();
  const accepted = channels === 32 ? tx.verifyPaddedU32(0, mask) : tx.verifyU32(0, mask);
  if (!accepted) {
    throw new Error(
      `channel mask not accepted: wrote 0x${mask.toString(16)}, read back 0x${tx.u32(0).toString(16)} ` +
        (channels === 32
          ? '(compared over the complete four-byte padded word)'
          : `(compared over the ${tx.advertisedBytesInWord(0)} advertised byte(s))`),
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
 *
 * One read -> write -> read cycle is not enough to trust the result here (NOTES
 * 8.11): the read-back lives in the same aux scratch buffer the write just filled.
 * The exported function runs the cycle up to SAMPLERATE_WRITE_CYCLES times and
 * confirms the winner through a second, complete command, which is the read that
 * sees what the device answers *after* it has run the aux command again.
 */
export async function configureSamplerate(
  bus: RegisterBus,
  samplerateHz: number,
  trace: Tracer = () => {},
): Promise<{ baseHz: number; divider: number }> {
  let lastCycle = 'no cycle ran';
  for (let cycle = 1; cycle <= SAMPLERATE_WRITE_CYCLES; cycle++) {
    const tx = await AuxTransaction.begin(bus, AUX_SAMPLERATE, trace);
    // Payload word 0 is {base index, base MHz} and word 1 is the divider, so the
    // device has to accept at least 8 payload bytes. Anything shorter would let
    // the divider write fall off the end and be dropped without complaint.
    if (tx.payloadTransferLen < 8) {
      throw new Error(
        `samplerate aux payload is ${tx.payloadTransferLen} bytes, need at least 8 for the divider`,
      );
    }
    const outcome = await programSamplerate(tx, samplerateHz, trace);
    // A rate no base can express is deterministic: the walk answered from the
    // device's own table, so repeating it would only repeat the same refusal.
    if (outcome.kind === 'refused') throw outcome.error;
    if (outcome.kind === 'retry') {
      lastCycle = outcome.detail;
      trace({
        dir: 'info',
        note: `samplerate ${samplerateHz / 1e6} MHz: cycle ${cycle} did not stick ` +
          `(${outcome.detail}), writing it again`,
      });
      continue;
    }

    // The read inside the writing transaction cannot see a dropped live update
    // (NOTES 8.11), so ask again through a complete command of its own.
    const confirm = await AuxTransaction.begin(bus, AUX_SAMPLERATE, trace);
    await confirm.readPayload();
    const answered = `index ${confirm.u16(0)} base ${confirm.u16(1)} MHz divider ${confirm.u32(1)}`;
    if (!confirm.verifyU32(1, outcome.divider - 1) || confirm.u16(1) * 1e6 !== outcome.baseHz) {
      lastCycle = `wrote ${outcome.divider - 1} on base ${outcome.baseMHz} MHz, the device answered ${answered}`;
      trace({
        dir: 'info',
        note: `samplerate ${samplerateHz / 1e6} MHz: cycle ${cycle} read back as ${answered}, ` +
          'writing it again',
      });
      continue;
    }
    trace({
      dir: 'info',
      note: `samplerate ${samplerateHz / 1e6} MHz = ${outcome.baseMHz} MHz / ${outcome.divider} ` +
        `verified${cycle > 1 ? ` (cycle ${cycle})` : ''}`,
    });
    return { baseHz: outcome.baseHz, divider: outcome.divider };
  }
  throw new Error(
    `could not configure ${samplerateHz / 1e6} MHz: the divider never stuck ` +
      `(${lastCycle}) across ${SAMPLERATE_WRITE_CYCLES} read/write/read cycles`,
  );
}

/** Outcome of one read -> write -> read cycle of the samplerate aux command. */
type SamplerateCycle =
  /** The device kept the divider through the cycle's own read-back. */
  | { kind: 'programmed'; baseHz: number; baseMHz: number; divider: number }
  /** The read-back disagreed; a fresh command may land where this one did not. */
  | { kind: 'retry'; detail: string }
  /**
   * The device's own base table cannot express the rate. This one stays out of the
   * retry loop: repeating it would walk the same two bases again and report a wire
   * problem where the honest answer is that the rate is not offered.
   */
  | { kind: 'refused'; error: Error };

async function programSamplerate(
  tx: AuxTransaction,
  samplerateHz: number,
  trace: Tracer,
): Promise<SamplerateCycle> {
  for (let pass = 0; pass < SAMPLERATE_BASE_PASSES; pass++) {
    await tx.readPayload();
    const baseIndex = tx.u16(0);
    const baseMHz = tx.u16(1);
    const baseHz = baseMHz * 1e6;
    trace({
      dir: 'info',
      note: `samplerate base[${baseIndex}] = ${baseMHz} MHz, divider reg = ${tx.u32(1)}`,
    });

    // A base is only usable if it divides the rate *and* the quotient fits the
    // byte the sampler reads. Skipping a base for the second reason is what makes
    // 5 MHz reachable on a 32U3: 1400/5 needs 280, 800/5 needs 160.
    const fits = baseHz !== 0 && baseHz % samplerateHz === 0 &&
      baseHz / samplerateHz - 1 <= MAX_SAMPLERATE_DIVIDER;
    if (!fits) {
      if (baseIndex >= MAX_BASE_INDEX) {
        const why = baseHz === 0 || baseHz % samplerateHz !== 0
          ? 'does not divide it'
          : `needs divider ${baseHz / samplerateHz}, past the ${MAX_SAMPLERATE_DIVIDER} ` +
            'the sampler honours';
        return {
          kind: 'refused',
          error: new Error(
            `could not configure ${samplerateHz / 1e6} MHz: base[${baseIndex}] = ${baseMHz} MHz ` +
              `${why} and index ${MAX_BASE_INDEX} is the last one that exists`,
          ),
        };
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
      return {
        kind: 'retry',
        detail: `wrote divider ${divider - 1}, read back ${tx.u32(1)}`,
      };
    }
    if (tx.u16(1) * 1e6 !== baseHz) {
      return {
        kind: 'retry',
        detail: `base changed under us: ${tx.u16(1)} MHz after write, ${baseMHz} MHz before`,
      };
    }
    return { kind: 'programmed', baseHz, baseMHz, divider };
  }

  // The walk ran out of passes without the device ever reporting a usable base:
  // writes that are not landing look exactly like this, so leave it to the cycles.
  return {
    kind: 'retry',
    detail: `no usable base clock after ${SAMPLERATE_BASE_PASSES} passes`,
  };
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
