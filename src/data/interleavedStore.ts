/**
 * InterleavedSampleStore - the alternative that was rejected, kept so the rejection is a
 * measurement instead of an opinion.
 *
 * Same contract, same pyramid shape, same block allocator, same query descent. The only
 * difference is the layout of the two big arrays:
 *
 *   - base: device order, one uint16 per sample, all 16 channels interleaved. This is the
 *     memcpy case - append is a straight copy with no transpose.
 *   - pyramid: per bin, a uint16 "some channel was high" mask and a uint16 "some channel
 *     was low" mask. That is 2 bits per channel per bin, exactly what the planar pyramid
 *     costs, so the memory comparison is a genuine tie and only speed separates them.
 *
 * What it cannot do is answer "is there a 1 anywhere in these 512 samples" with one
 * compare. It has to look at every sample, or every bin, one at a time.
 *
 * 16 channels only; this exists to be benchmarked against PlanarSampleStore, not shipped.
 */

import type { ColumnView, GapSpan, MemoryReport, SampleStore } from './types.js';

const BASE_BLOCK_LOG = 24; // 2^24 samples per block = 32 MiB of uint16 for 16 channels
const BASE_BLOCK = 1 << BASE_BLOCK_LOG;
const BASE_BLOCK_MASK = BASE_BLOCK - 1;
const LEVEL_LOG = 4;
const MAX_LEVEL = 6;
/**
 * Default only. This has to be tunable for the same reason planar's is: comparing a swept
 * constant against a hardcoded one is not a comparison, it is a handicap. The bench sweeps
 * both stores over the same range and quotes each at its own best.
 */
const DEFAULT_CORE_BINS = 8;

const HAS_ONE = 1;
const HAS_ZERO = 2;
const HAS_BOTH = 3;

function levelBlockLog(level: number): number {
  return Math.max(8, BASE_BLOCK_LOG - LEVEL_LOG * level);
}

class MaskLevel {
  readonly blockLog: number;
  readonly block: number;
  readonly mask: number;
  readonly hi: Uint16Array[] = [];
  readonly lo: Uint16Array[] = [];

  constructor(blockLog: number) {
    this.blockLog = blockLog;
    this.block = 1 << blockLog;
    this.mask = this.block - 1;
  }

  reserve(bins: number): void {
    const need = Math.ceil(bins / this.block);
    while (this.hi.length < need) {
      this.hi.push(new Uint16Array(this.block));
      this.lo.push(new Uint16Array(this.block));
    }
  }

  byteLength(): number {
    return (this.hi.length + this.lo.length) * this.block * 2;
  }
}

export class InterleavedSampleStore implements SampleStore {
  readonly channelCount = 16;
  readonly samplerate: number;
  length = 0;
  /** Query-time only, so the bench can sweep it on an already-built store. */
  coreBins: number = DEFAULT_CORE_BINS;

  private readonly base: Uint16Array[] = [];
  private readonly levels: MaskLevel[] = [];
  private readonly validBins: number[] = [];
  private readonly binSize: number[] = [];

  private scratchBins = 0;
  private scratchLow = new Uint8Array(0);
  private scratchHigh = new Uint8Array(0);
  private scratchEdge = new Uint8Array(0);
  private scratchPacked = new Uint8Array(0);

  constructor(samplerate: number) {
    if (!(samplerate > 0)) throw new Error(`samplerate must be positive, got ${samplerate}`);
    this.samplerate = samplerate;
    this.binSize[0] = 1;
    this.validBins[0] = 0;
    for (let k = 1; k <= MAX_LEVEL; k++) {
      this.levels[k] = new MaskLevel(levelBlockLog(k));
      this.binSize[k] = Math.pow(2, LEVEL_LOG * k);
      this.validBins[k] = 0;
    }
  }

  append(chunk: Uint8Array): void {
    if (chunk.byteLength % 2 !== 0) throw new Error(`chunk of ${chunk.byteLength} bytes is not whole samples`);
    const n = chunk.byteLength / 2;
    if (n === 0) return;
    const from = this.length;
    const to = from + n;
    if (to > 0x7fffffff) throw new Error(`capture would exceed the 2^31 sample ceiling (${to})`);

    while (this.base.length * BASE_BLOCK < to) this.base.push(new Uint16Array(BASE_BLOCK));

    const src = (chunk.byteOffset & 1) === 0
      ? new Uint16Array(chunk.buffer, chunk.byteOffset, n)
      : (() => { const t = new Uint16Array(n); new Uint8Array(t.buffer).set(chunk); return t; })();

    let si = 0;
    let dst = from;
    while (si < n) {
      const blk = dst >>> BASE_BLOCK_LOG;
      const off = dst & BASE_BLOCK_MASK;
      const take = Math.min(n - si, BASE_BLOCK - off);
      this.base[blk]!.set(src.subarray(si, si + take), off);
      si += take;
      dst += take;
    }

    this.length = to;
    this.validBins[0] = to;
    this.updatePyramid(to);
  }

  private updatePyramid(to: number): void {
    for (let k = 1; k <= MAX_LEVEL; k++) {
      const B = this.binSize[k]!;
      const b0 = this.validBins[k]!;
      const b1 = Math.floor(to / B);
      if (b1 <= b0) break;
      const lv = this.levels[k]!;
      lv.reserve(b1);
      if (k === 1) {
        for (let i = b0; i < b1; i++) {
          const s0 = i * 16;
          const blk = s0 >>> BASE_BLOCK_LOG;
          const arr = this.base[blk]!;
          const off = s0 & BASE_BLOCK_MASK;
          let h = 0, l = 0;
          for (let j = 0; j < 16; j++) { const v = arr[off + j]!; h |= v; l |= ~v; }
          lv.hi[i >>> lv.blockLog]![i & lv.mask] = h;
          lv.lo[i >>> lv.blockLog]![i & lv.mask] = l & 0xffff;
        }
      } else {
        const src = this.levels[k - 1]!;
        for (let i = b0; i < b1; i++) {
          const s0 = i * 16;
          const sBlk = s0 >>> src.blockLog;
          const sh = src.hi[sBlk]!, sl = src.lo[sBlk]!;
          const off = s0 & src.mask;
          let h = 0, l = 0;
          for (let j = 0; j < 16; j++) { h |= sh[off + j]!; l |= sl[off + j]!; }
          lv.hi[i >>> lv.blockLog]![i & lv.mask] = h;
          lv.lo[i >>> lv.blockLog]![i & lv.mask] = l;
        }
      }
      this.validBins[k] = b1;
    }
  }

  private sampleBit(ch: number, i: number): number {
    return (this.base[i >>> BASE_BLOCK_LOG]![i & BASE_BLOCK_MASK]! >>> ch) & 1;
  }

  private baseState(ch: number, s0: number, s1: number): number {
    let st = 0;
    let i = s0;
    while (i < s1) {
      const blk = i >>> BASE_BLOCK_LOG;
      const arr = this.base[blk]!;
      const stop = Math.min(s1, (blk + 1) * BASE_BLOCK);
      let j = i & BASE_BLOCK_MASK;
      for (; i < stop; i++, j++) {
        st |= ((arr[j]! >>> ch) & 1) !== 0 ? HAS_ONE : HAS_ZERO;
        if (st === HAS_BOTH) return HAS_BOTH;
      }
    }
    return st;
  }

  private levelState(level: number, ch: number, a: number, b: number): number {
    const lv = this.levels[level]!;
    let st = 0;
    for (let i = a; i < b; i++) {
      const blk = i >>> lv.blockLog;
      const off = i & lv.mask;
      if ((lv.hi[blk]![off]! >>> ch) & 1) st |= HAS_ONE;
      if ((lv.lo[blk]![off]! >>> ch) & 1) st |= HAS_ZERO;
      if (st === HAS_BOTH) return HAS_BOTH;
    }
    return st;
  }

  private rangeState(ch: number, s0: number, s1: number, level: number): number {
    while (level > 0) {
      const B = this.binSize[level]!;
      const a = Math.ceil(s0 / B);
      let b = Math.floor(s1 / B);
      const vb = this.validBins[level]!;
      if (b > vb) b = vb;
      if (a >= b) { level--; continue; }
      const coreStart = a * B;
      const coreEnd = b * B;
      let st = this.levelState(level, ch, a, b);
      if (st !== HAS_BOTH && s0 < coreStart) st |= this.rangeState(ch, s0, coreStart, level - 1);
      if (st !== HAS_BOTH && coreEnd < s1) st |= this.rangeState(ch, coreEnd, s1, level - 1);
      return st;
    }
    return this.baseState(ch, s0, s1);
  }

  private pickLevel(samplesPerBin: number): number {
    const want = this.coreBins;
    let k = 0;
    while (k < MAX_LEVEL && this.binSize[k + 1]! * want <= samplesPerBin) k++;
    return k;
  }

  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView {
    if (channel < 0 || channel >= 16 || (channel | 0) !== channel) throw new Error(`channel ${channel} out of range`);
    if (!(bins > 0) || (bins | 0) !== bins) throw new Error(`bins must be a positive integer, got ${bins}`);
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`query range must be finite, got [${startSample}, ${endSample})`);
    }
    if (this.length === 0) throw new Error('query on an empty store');
    const s = Math.max(0, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) throw new Error(`empty range [${startSample}, ${endSample})`);

    const width = e - s;
    const level = this.pickLevel(width / bins);

    if (bins !== this.scratchBins) {
      this.scratchBins = bins;
      this.scratchLow = new Uint8Array(bins);
      this.scratchHigh = new Uint8Array(bins);
      this.scratchEdge = new Uint8Array(bins);
      this.scratchPacked = new Uint8Array(bins);
    }
    const low = this.scratchLow, high = this.scratchHigh;
    const edge = this.scratchEdge, packed = this.scratchPacked;

    for (let i = 0; i < bins; i++) {
      const c0 = s + Math.floor((i * width) / bins);
      let c1 = s + Math.floor(((i + 1) * width) / bins);
      if (c1 <= c0) c1 = c0 + 1;
      if (c1 > e) c1 = e;
      let st = this.rangeState(channel, c0, c1, level);
      const hv = (st & HAS_ONE) !== 0 ? 1 : 0;
      const lv = (st & HAS_ZERO) !== 0 ? 0 : 1;
      if (c0 > 0) st |= this.sampleBit(channel, c0 - 1) !== 0 ? HAS_ONE : HAS_ZERO;
      const ev = st === HAS_BOTH ? 1 : 0;
      high[i] = hv; low[i] = lv; edge[i] = ev;
      packed[i] = hv | (lv << 1) | (ev << 2);
    }
    return { channel, startSample: s, endSample: e, bins, low, high, edge, packed };
  }

  edges(channel: number, startSample: number, endSample: number): Int32Array {
    if (channel < 0 || channel >= 16 || (channel | 0) !== channel) throw new Error(`channel ${channel} out of range`);
    const s = Math.max(1, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) return new Int32Array(0);
    let out = new Int32Array(1024);
    let n = 0;
    let prev = this.sampleBit(channel, s - 1);
    let i = s;
    while (i < e) {
      const blk = i >>> BASE_BLOCK_LOG;
      const arr = this.base[blk]!;
      const stop = Math.min(e, (blk + 1) * BASE_BLOCK);
      let j = i & BASE_BLOCK_MASK;
      for (; i < stop; i++, j++) {
        const v = (arr[j]! >>> channel) & 1;
        if (v !== prev) {
          if (n === out.length) { const bigger = new Int32Array(out.length * 2); bigger.set(out); out = bigger; }
          out[n++] = i;
          prev = v;
        }
      }
    }
    return out.subarray(0, n);
  }

  /**
   * This store exists to be benchmarked against PlanarSampleStore, not shipped, so gaps
   * are refused loudly rather than half-implemented. It is deliberately not part of the
   * gap tests.
   */
  noteGap(startSample: number, endSample: number): void {
    throw new Error(`InterleavedSampleStore does not support gaps (got [${startSample}, ${endSample}))`);
  }

  gaps(): GapSpan[] {
    return [];
  }

  memory(): MemoryReport {
    const baseBytes = this.base.length * BASE_BLOCK * 2;
    let pyramidBytes = 0;
    for (let k = 1; k <= MAX_LEVEL; k++) pyramidBytes += this.levels[k]!.byteLength();
    return {
      baseBytes,
      pyramidBytes,
      totalBytes: baseBytes + pyramidBytes,
      overhead: baseBytes === 0 ? 0 : pyramidBytes / baseBytes,
      slackBytes: baseBytes - this.length * 2,
    };
  }

  sampleAt(channel: number, index: number): number {
    if (index < 0 || index >= this.length) throw new Error(`sample ${index} out of range`);
    return this.sampleBit(channel, index);
  }
}
