/**
 * Synthetic 16-channel capture generator.
 *
 * Random noise is the wrong test load for this module in both directions: it makes edge
 * summarisation trivially correct (every bin is mixed, so every bin has an edge and the
 * pyramid never has to be careful) and it makes memory look worse than reality (every
 * channel is maximally busy). Real captures are the opposite - a couple of dense clocks,
 * a few bursty buses, and several channels that sit still for millions of samples and
 * then move once. That mix is what this generates:
 *
 *   ch0  fast clock, period 4
 *   ch1  divided clock, period 32
 *   ch2  divided clock, period 256
 *   ch3  UART TX  - idle high, 87-sample bit period, bursts of 4..24 frames, long gaps
 *   ch4  UART RX  - idle high, 174-sample bit period, sparser
 *   ch5  SPI SCLK - idle low, 20-sample clock, only during a transaction
 *   ch6  SPI MOSI - data, changes on the clock
 *   ch7  SPI MISO - data, changes on the clock
 *   ch8  SPI CS   - idle high, low for the whole transaction
 *   ch9  I2C SCL  - idle high, 100-sample bit period
 *   ch10 I2C SDA  - idle high, start/stop conditions and 9-bit bytes
 *   ch11 PWM      - 1024-sample period, duty sweeping 12%..88%, always switching
 *   ch12 glitch   - idle high, a handful of 1..3 sample low pulses in 100M samples
 *   ch13 enable   - idle low, occasional pulses tens of thousands of samples long
 *   ch14 constant low
 *   ch15 constant high
 *
 * Content is generated one macro period (2^20 samples) at a time, and every run lives
 * inside its macro period. That makes any macro period reproducible from (seed, index)
 * alone with no carried state, so the generator is restartable and the chunk size handed
 * to append() is completely independent of the content.
 */

const MACRO_LOG = 20;
export const MACRO_SAMPLES = 1 << MACRO_LOG; // 1,048,576

const TILE = 256;

/** Channels whose idle level is high, as a mask. */
const IDLE_HIGH_MASK =
  (1 << 3) | (1 << 4) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 15);

export const CHANNEL_NAMES = [
  'CLK/1', 'CLK/8', 'CLK/64', 'UART TX', 'UART RX',
  'SPI SCLK', 'SPI MOSI', 'SPI MISO', 'SPI CS',
  'I2C SCL', 'I2C SDA', 'PWM', 'GLITCH', 'ENABLE', 'GND', 'VCC',
];

/** xorshift32. Deterministic, and good enough for waveform content. */
function makeRng(seed: number): () => number {
  let x = seed | 0;
  if (x === 0) x = 0x9e3779b9;
  return () => {
    x ^= x << 13; x |= 0;
    x ^= x >>> 17;
    x ^= x << 5; x |= 0;
    return x >>> 0;
  };
}

function mixSeed(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ b, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

function buildTileBlock(): Uint16Array {
  const tile = new Uint16Array(TILE);
  for (let i = 0; i < TILE; i++) {
    let v = IDLE_HIGH_MASK;
    if ((i >> 1) & 1) v |= 1 << 0;   // period 4
    if ((i >> 4) & 1) v |= 1 << 1;   // period 32
    if ((i >> 7) & 1) v |= 1 << 2;   // period 256
    tile[i] = v;
  }
  const block = new Uint16Array(MACRO_SAMPLES);
  for (let i = 0; i < MACRO_SAMPLES; i += TILE) block.set(tile, i);
  return block;
}

function setRun(b: Uint16Array, from: number, to: number, mask: number): void {
  const a = from < 0 ? 0 : from;
  const z = to > MACRO_SAMPLES ? MACRO_SAMPLES : to;
  for (let i = a; i < z; i++) b[i]! |= mask;
}

function clearRun(b: Uint16Array, from: number, to: number, mask: number): void {
  const a = from < 0 ? 0 : from;
  const z = to > MACRO_SAMPLES ? MACRO_SAMPLES : to;
  const m = ~mask & 0xffff;
  for (let i = a; i < z; i++) b[i]! &= m;
}

/** Idle-high line: write the low runs only. */
function uart(b: Uint16Array, seed: number, mask: number, bitPeriod: number, maxBursts: number): void {
  const rng = makeRng(seed);
  const bursts = rng() % (maxBursts + 1);
  for (let k = 0; k < bursts; k++) {
    const frames = 4 + (rng() % 21);
    const frameLen = 10 * bitPeriod;
    const span = frames * frameLen;
    if (span >= MACRO_SAMPLES) continue;
    let t = rng() % (MACRO_SAMPLES - span);
    for (let f = 0; f < frames; f++) {
      clearRun(b, t, t + bitPeriod, mask);          // start bit
      const byte = rng() & 0xff;
      for (let bit = 0; bit < 8; bit++) {
        if (((byte >>> bit) & 1) === 0) {
          const p = t + (bit + 1) * bitPeriod;
          clearRun(b, p, p + bitPeriod, mask);
        }
      }
      // stop bit is idle high, nothing to write
      t += frameLen;
    }
  }
}

const SPI_SCLK = 1 << 5;
const SPI_MOSI = 1 << 6;
const SPI_MISO = 1 << 7;
const SPI_CS = 1 << 8;

function spi(b: Uint16Array, seed: number): void {
  const rng = makeRng(seed);
  const transactions = 1 + (rng() % 4);
  const clk = 20;
  for (let k = 0; k < transactions; k++) {
    const bytes = 1 + (rng() % 16);
    const span = bytes * 8 * clk + 4 * clk;
    if (span >= MACRO_SAMPLES) continue;
    const t0 = rng() % (MACRO_SAMPLES - span);
    clearRun(b, t0, t0 + span, SPI_CS); // CS low for the whole transaction
    let t = t0 + 2 * clk;
    for (let by = 0; by < bytes; by++) {
      const mo = rng() & 0xff;
      const mi = rng() & 0xff;
      for (let bit = 7; bit >= 0; bit--) {
        // data is set on the falling edge and sampled on the rising edge
        if ((mo >>> bit) & 1) setRun(b, t, t + clk, SPI_MOSI);
        if ((mi >>> bit) & 1) setRun(b, t, t + clk, SPI_MISO);
        setRun(b, t + (clk >> 1), t + clk, SPI_SCLK); // second half high
        t += clk;
      }
    }
  }
}

const I2C_SCL = 1 << 9;
const I2C_SDA = 1 << 10;

function i2c(b: Uint16Array, seed: number): void {
  const rng = makeRng(seed);
  const transactions = rng() % 4;
  const bit = 100;
  for (let k = 0; k < transactions; k++) {
    const bytes = 2 + (rng() % 6);
    const span = (bytes * 9 + 3) * bit;
    if (span >= MACRO_SAMPLES) continue;
    let t = rng() % (MACRO_SAMPLES - span);
    // start condition: SDA falls while SCL is high
    clearRun(b, t + (bit >> 1), t + bit, I2C_SDA);
    t += bit;
    let sda = 0;
    for (let by = 0; by < bytes; by++) {
      const v = rng() & 0xff;
      for (let i = 0; i < 9; i++) {
        const wantHigh = i === 8 ? false : ((v >>> (7 - i)) & 1) === 1; // bit 8 is ACK, low
        clearRun(b, t, t + (bit >> 1), I2C_SCL); // SCL low half
        if (!wantHigh) clearRun(b, t, t + bit, I2C_SDA);
        sda = wantHigh ? 1 : 0;
        t += bit;
      }
    }
    void sda;
    // stop condition: SDA rises while SCL is high - SDA held low then released
    clearRun(b, t, t + (bit >> 1), I2C_SDA);
    t += bit;
  }
}

const PWM_MASK = 1 << 11;

function pwm(b: Uint16Array, macroIndex: number): void {
  const period = 1024;
  for (let t = 0; t < MACRO_SAMPLES; t += period) {
    const phase = (macroIndex * (MACRO_SAMPLES / period) + t / period) / 512;
    const duty = Math.round(period * (0.5 + 0.38 * Math.sin(phase)));
    setRun(b, t, t + duty, PWM_MASK);
  }
}

const GLITCH_MASK = 1 << 12;

function glitch(b: Uint16Array, seed: number): void {
  const rng = makeRng(seed);
  if (rng() % 4 !== 0) return;
  const width = 1 + (rng() % 3);
  const t = rng() % (MACRO_SAMPLES - width);
  clearRun(b, t, t + width, GLITCH_MASK);
}

const ENABLE_MASK = 1 << 13;

function enable(b: Uint16Array, seed: number): void {
  const rng = makeRng(seed);
  if (rng() % 2 !== 0) return;
  const width = 10000 + (rng() % 190000);
  if (width >= MACRO_SAMPLES) return;
  const t = rng() % (MACRO_SAMPLES - width);
  setRun(b, t, t + width, ENABLE_MASK);
}

export interface GeneratorOptions {
  totalSamples: number;
  /** Samples per yielded chunk. Capped at MACRO_SAMPLES. */
  chunkSamples?: number;
  seed?: number;
}

/**
 * Fill one macro period. Exported so tests can build a small reference buffer with the
 * exact same content the store is fed.
 */
export function fillMacro(out: Uint16Array, macroIndex: number, seed: number, tileBlock: Uint16Array): void {
  if (out.length !== MACRO_SAMPLES) throw new Error(`macro buffer must be ${MACRO_SAMPLES} samples`);
  out.set(tileBlock);
  uart(out, mixSeed(seed + 3, macroIndex), 1 << 3, 87, 3);
  uart(out, mixSeed(seed + 4, macroIndex), 1 << 4, 174, 2);
  spi(out, mixSeed(seed + 5, macroIndex));
  i2c(out, mixSeed(seed + 9, macroIndex));
  pwm(out, macroIndex);
  glitch(out, mixSeed(seed + 12, macroIndex));
  enable(out, mixSeed(seed + 13, macroIndex));
}

export function makeTileBlock(): Uint16Array {
  return buildTileBlock();
}

/**
 * Yields chunks of device-order bytes (2 bytes per sample, little endian), exactly what
 * SampleStore.append expects at 16 channels.
 *
 * The yielded Uint8Array is a view into a buffer that is reused on the next iteration.
 * append() copies, so that is safe; anything else must copy first.
 */
export function* generateCapture(opts: GeneratorOptions): Generator<Uint8Array> {
  const total = opts.totalSamples;
  if (!(total > 0)) throw new Error(`totalSamples must be positive, got ${total}`);
  const chunkSamples = Math.min(opts.chunkSamples ?? MACRO_SAMPLES, MACRO_SAMPLES);
  if (!(chunkSamples > 0)) throw new Error(`chunkSamples must be positive`);
  const seed = opts.seed ?? 0x5109c16;

  const tileBlock = buildTileBlock();
  const staging = new Uint16Array(MACRO_SAMPLES);
  const bytes = new Uint8Array(staging.buffer);

  let produced = 0;
  let macroIndex = 0;
  while (produced < total) {
    fillMacro(staging, macroIndex, seed, tileBlock);
    const inThisMacro = Math.min(MACRO_SAMPLES, total - produced);
    let off = 0;
    while (off < inThisMacro) {
      const take = Math.min(chunkSamples, inThisMacro - off);
      yield bytes.subarray(off * 2, (off + take) * 2);
      off += take;
    }
    produced += inThisMacro;
    macroIndex++;
  }
}
