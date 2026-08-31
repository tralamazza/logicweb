// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Deterministic UART stimulus, generated rather than checked in as a binary.
 *
 * Identical parameters to the capture used for the offline differential test
 * against sigrok-cli (8 MHz sample rate, 115200 baud, 8N1, same message), so
 * the in-browser result can be compared with the recorded golden output.
 */

export const SAMPLERATE = 8_000_000;
export const BAUDRATE = 115200;
export const MESSAGE =
  'Hello, sigrok! 0123456789 The quick brown fox jumps over the lazy dog.\r\n';

/**
 * Two-wire I2C write transaction, used to exercise a decoder *stack*
 * (i2c -> eeprom24xx) through the shipped client API. Returns SCL and SDA as
 * edge lists, the same shape SampleStore.edges() produces.
 */
export function makeI2cCapture(
  slaveAddr: number, payload: number[], sclPeriod = 80,
): {
  scl: { edges: Int32Array; initial: 0 | 1 };
  sda: { edges: Int32Array; initial: 0 | 1 };
  length: number;
} {
  const half = sclPeriod >> 1, quarter = sclPeriod >> 2;
  const sclEdges: number[] = [];
  const sdaEdges: number[] = [];
  let scl: 0 | 1 = 1, sda: 0 | 1 = 1, t = sclPeriod;

  const setScl = (v: 0 | 1) => { if (v !== scl) { sclEdges.push(t); scl = v; } };
  const setSda = (v: 0 | 1) => { if (v !== sda) { sdaEdges.push(t); sda = v; } };

  // START: SDA falls while SCL is high.
  setSda(0); t += half;
  setScl(0); t += quarter;

  const sendByte = (b: number) => {
    for (let i = 7; i >= 0; i--) {
      setSda(((b >> i) & 1) as 0 | 1); t += quarter;
      setScl(1); t += half;
      setScl(0); t += quarter;
    }
    // ACK slot: the addressed device pulls SDA low.
    setSda(0); t += quarter;
    setScl(1); t += half;
    setScl(0); t += quarter;
  };

  sendByte((slaveAddr << 1) | 0);        // address + write
  for (const b of payload) sendByte(b);

  // STOP: SDA rises while SCL is high.
  setSda(0); t += quarter;
  setScl(1); t += half;
  setSda(1); t += sclPeriod;

  return {
    scl: { edges: Int32Array.from(sclEdges), initial: 1 },
    sda: { edges: Int32Array.from(sdaEdges), initial: 1 },
    length: t + sclPeriod,
  };
}

/** Bit stream for one 8N1 frame per byte: start, 8 data LSB first, stop. */
function* uartBits(bytes: Uint8Array): Generator<0 | 1> {
  for (const b of bytes) {
    yield 0;
    for (let i = 0; i < 8; i++) yield ((b >> i) & 1) as 0 | 1;
    yield 1;
  }
}

/**
 * Render the bit stream to edge positions directly. The samples-per-bit is
 * deliberately non-integer (69.44 at 8 MHz / 115200), because a decoder that
 * only works on integer bit lengths is not being tested.
 */
export function makeUartCapture(repeats: number, idleHead = 200, idleTail = 400): {
  edges: Int32Array; initial: 0 | 1; length: number; bytes: Uint8Array;
} {
  const spb = SAMPLERATE / BAUDRATE;
  const one = new TextEncoder().encode(MESSAGE);
  const bytes = new Uint8Array(one.length * repeats);
  for (let r = 0; r < repeats; r++) bytes.set(one, r * one.length);

  const edges: number[] = [];
  let level: 0 | 1 = 1;          // idle high
  let pos = 0;
  let sample = idleHead;
  for (const bit of uartBits(bytes)) {
    pos += spb;
    const next = idleHead + Math.round(pos);
    if (bit !== level) { edges.push(sample); level = bit; }
    sample = next;
  }
  if (level !== 1) { edges.push(sample); }
  const length = sample + idleTail;
  return { edges: Int32Array.from(edges), initial: 1, length, bytes };
}
