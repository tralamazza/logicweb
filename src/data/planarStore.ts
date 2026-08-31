// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * PlanarSampleStore - the shipping SampleStore.
 *
 * Layout decision: samples are transposed on append into one bit-plane per channel
 * (channel-major, bit-packed) rather than kept in device order (sample-major, 16 bits per
 * sample). Both cost exactly 2 bytes per sample for 16 channels, so this is not a memory
 * trade - it is a speed trade, and it is settled by measurement in NOTES.md, not by
 * argument. The short version: with planes, "does this range of samples contain a 1" is
 * `word !== 0` over 32 samples at a time, and "where are the edges" is
 * `w ^ (w << 1)` plus a count-trailing-zeros loop. In device order both are per-sample.
 *
 * Pyramid: level k summarises 16^k samples per bin into two bits - "contains a 1" and
 * "contains a 0" - stored as two more bit-planes. Two bits, not one, because the pair
 * carries low, high and mixed, and because reduction is then a plain OR at every level.
 * Geometric cost is 2 * (1/16 + 1/256 + ...) = 2/15 bits per sample per channel, i.e.
 * 13.3% on top of the base, and reduction from level k-1 to k is again word-parallel.
 *
 * Bins are only published once complete (`validBins`), so append is strictly incremental:
 * nothing is ever recomputed, which is what makes this usable during a live capture.
 */

import { BitPlane, HAS_ONE, HAS_ZERO, HAS_BOTH } from './bitplane.js';
import { assertGapBounds, mergeGap, splitAroundGaps } from './gaps.js';
import { GAP_BIT } from './types.js';
import type { ColumnView, GapSpan, MemoryReport, SampleStore } from './types.js';

/** 2^24 samples per base block = 2 MiB per channel per block. */
const BASE_BLOCK_BITS_LOG = 24;
/** Reduction factor per pyramid level, as a log2. 4 => 16 samples per level-1 bin. */
const LEVEL_LOG = 4;
/**
 * Top pyramid level. Level 6 bins hold 16^6 = 16.7M samples.
 *
 * This was 7, which was dead weight: pickLevel only reaches level k when
 * 16^k * coreBins <= samplesPerBin, so level 7 at the default coreBins of 32 needs
 * 2^33 samples in a single column - four times the 2^31 sample ceiling that append
 * enforces. It was built on every capture and never once read.
 */
const MAX_LEVEL = 6;

/**
 * Default for `coreBins`: the minimum number of level-k bins a query wants inside one
 * pixel column before it accepts level k. Bigger means a shallower level, so the core is
 * a longer sequential bit range but the recursive descent at the two ends is shorter.
 *
 * Swept on the 100M capture (16-channel frame, 1000 columns, full zoom out):
 *   1 -> 1.32 ms   8 -> 1.17 ms   32 -> 0.87 ms   128 -> 0.87 ms   512 -> 1.29 ms
 * Sequential words in a small hot plane beat pointer-chasing down four levels, until the
 * core gets long enough to stop fitting. 32 is the joint optimum across zoom levels.
 */
const DEFAULT_CORE_BINS = 32;

const binSizeOf = (level: number): number => Math.pow(2, LEVEL_LOG * level);

/** Block size for a pyramid level, shrinking with the level so tiny levels stay tiny. */
function levelBlockBitsLog(level: number): number {
  return Math.max(12, BASE_BLOCK_BITS_LOG - LEVEL_LOG * level);
}

export interface PlanarStoreOptions {
  channelCount: 4 | 8 | 16;
  samplerate: number;
  /**
   * If true, query() snaps pixel column boundaries to whole level-k bins instead of
   * descending to the exact sample boundary. Faster, and each column is still an exact
   * answer for the range it covers, but the boundary can sit up to 1/CORE_BINS of a pixel
   * away from the requested one. Off by default; the bench measures both.
   */
  snapColumns?: boolean;
  coreBins?: number;
}

export class PlanarSampleStore implements SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  length = 0;

  private readonly bytesPerSample: number;
  /** Query-time only, so the bench can sweep them on an already-built store. */
  snapColumns: boolean;
  coreBins: number;

  /** base[ch]: one bit per sample. */
  private readonly base: BitPlane[] = [];
  /** hi[level][ch] / lo[level][ch] for level 1..MAX_LEVEL. Index 0 is unused. */
  private readonly hi: BitPlane[][] = [];
  private readonly lo: BitPlane[][] = [];
  /** Number of complete bins published at each level. validBins[0] === length. */
  private readonly validBins: number[] = [];
  private readonly binSize: number[] = [];

  /** Unknown spans, sorted and non-overlapping. Empty means no gaps. */
  private gapList: GapSpan[] = [];

  /** Scratch, reused by query() so the render loop does not allocate per column. */
  private scratchBins = 0;
  private scratchLow = new Uint8Array(0);
  private scratchHigh = new Uint8Array(0);
  private scratchEdge = new Uint8Array(0);
  private scratchPacked = new Uint8Array(0);

  constructor(opts: PlanarStoreOptions) {
    const { channelCount, samplerate } = opts;
    if (channelCount !== 4 && channelCount !== 8 && channelCount !== 16) {
      throw new Error(`channelCount must be 4, 8 or 16, got ${channelCount}`);
    }
    if (!(samplerate > 0)) throw new Error(`samplerate must be positive, got ${samplerate}`);
    this.channelCount = channelCount;
    this.samplerate = samplerate;
    this.bytesPerSample = channelCount === 16 ? 2 : 1;
    this.snapColumns = opts.snapColumns === true;
    this.coreBins = opts.coreBins ?? DEFAULT_CORE_BINS;

    for (let c = 0; c < channelCount; c++) this.base.push(new BitPlane(BASE_BLOCK_BITS_LOG));
    this.binSize[0] = 1;
    this.validBins[0] = 0;
    for (let k = 1; k <= MAX_LEVEL; k++) {
      const bbl = levelBlockBitsLog(k);
      const h: BitPlane[] = [];
      const l: BitPlane[] = [];
      for (let c = 0; c < channelCount; c++) {
        h.push(new BitPlane(bbl));
        l.push(new BitPlane(bbl));
      }
      this.hi[k] = h;
      this.lo[k] = l;
      this.binSize[k] = binSizeOf(k);
      this.validBins[k] = 0;
    }
  }

  // ---------------------------------------------------------------- append

  append(chunk: Uint8Array): void {
    const bps = this.bytesPerSample;
    if (chunk.byteLength % bps !== 0) {
      throw new Error(`chunk of ${chunk.byteLength} bytes is not a whole number of ${bps}-byte samples`);
    }
    const n = chunk.byteLength / bps;
    if (n === 0) return;
    const from = this.length;
    const to = from + n;
    if (to > 0x7fffffff) throw new Error(`capture would exceed the 2^31 sample ceiling (${to})`);

    for (let c = 0; c < this.channelCount; c++) this.base[c]!.extendTo(to);
    if (bps === 2) this.writeBase16(chunk, n, from);
    else this.writeBase8(chunk, n, from);

    this.length = to;
    this.validBins[0] = to;
    this.updatePyramid(from, to);
  }

  // ---------------------------------------------------------------- gaps

  /**
   * Record that samples [startSample, endSample) are unknown (a WebUSB dropout). The
   * samples are still stored and appended after - the gap is an overlay saying "do not
   * trust this range", which `query()` publishes as bit3 of `packed` and `edges()`
   * filters out. Overlapping or adjacent notes are merged.
   */
  noteGap(startSample: number, endSample: number): void {
    assertGapBounds(startSample, endSample, this.length);
    this.gapList = mergeGap(this.gapList, startSample, endSample);
  }

  gaps(): GapSpan[] {
    return this.gapList.map((g) => ({ ...g }));
  }

  /** 16 channels, 2 bytes per sample, little endian. */
  private writeBase16(chunk: Uint8Array, n: number, dstBit: number): void {
    let src: Uint16Array;
    if ((chunk.byteOffset & 1) === 0) {
      src = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    } else {
      // Odd byteOffset cannot back a Uint16Array view. Copy; correctness beats cleverness.
      src = new Uint16Array(n);
      new Uint8Array(src.buffer).set(chunk);
    }

    let si = 0;
    const head = Math.min(n, (32 - (dstBit & 31)) & 31);
    for (; si < head; si++) this.writeSample16(src[si]!, dstBit + si);

    const bodyEnd = si + (((n - si) >>> 5) << 5);
    if (bodyEnd > si) this.writeBody16(src, si, bodyEnd, dstBit + si);
    si = bodyEnd;

    for (; si < n; si++) this.writeSample16(src[si]!, dstBit + si);
  }

  /**
   * The hot loop: 32 samples -> one word in each of 16 planes.
   *
   * Four consecutive samples' low bytes are packed into L = b0 | b1<<8 | b2<<16 | b3<<24.
   * For channel c the four wanted bits are then at L bit positions c, c+8, c+16, c+24, and
   *
   *     imul((L >>> c) & 0x01010101, 0x10204080) >>> 28
   *
   * gathers them into a contiguous nibble. The multiplier has bits at 7, 14, 21 and 28, so
   * the four inputs land on bits 28..31 and every cross term lands on a distinct lower bit,
   * meaning no carry can corrupt the result. Measured 583 MSa/s versus 345 for the obvious
   * sample-major loop and 140 for the channel-major one; all three agree bit for bit.
   */
  private writeBody16(src: Uint16Array, si: number, siEnd: number, dstBit: number): void {
    const imul = Math.imul;
    const M = 0x01010101;
    const G = 0x10204080;
    const planes = this.base;
    const bbl = BASE_BLOCK_BITS_LOG;
    const blockMask = (1 << bbl) - 1;

    while (si < siEnd) {
      // Stay inside one destination block so the 16 block references can be hoisted.
      const blk = dstBit >>> bbl;
      const wordInBlock = (dstBit & blockMask) >>> 5;
      const wordsLeftInBlock = (1 << (bbl - 5)) - wordInBlock;
      const wordsWanted = (siEnd - si) >>> 5;
      const words = Math.min(wordsLeftInBlock, wordsWanted);

      const b0 = planes[0]!.blocks[blk]!, b1 = planes[1]!.blocks[blk]!;
      const b2 = planes[2]!.blocks[blk]!, b3 = planes[3]!.blocks[blk]!;
      const b4 = planes[4]!.blocks[blk]!, b5 = planes[5]!.blocks[blk]!;
      const b6 = planes[6]!.blocks[blk]!, b7 = planes[7]!.blocks[blk]!;
      const b8 = planes[8]!.blocks[blk]!, b9 = planes[9]!.blocks[blk]!;
      const ba = planes[10]!.blocks[blk]!, bb = planes[11]!.blocks[blk]!;
      const bc = planes[12]!.blocks[blk]!, bd = planes[13]!.blocks[blk]!;
      const be = planes[14]!.blocks[blk]!, bf = planes[15]!.blocks[blk]!;

      for (let w = 0; w < words; w++) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0;
        let a8 = 0, a9 = 0, aa = 0, ab = 0, ac = 0, ad = 0, ae = 0, af = 0;
        const base = si + (w << 5);
        for (let g = 0; g < 8; g++) {
          const j = base + (g << 2);
          const s0 = src[j]!, s1 = src[j + 1]!, s2 = src[j + 2]!, s3 = src[j + 3]!;
          const L = (s0 & 0xff) | ((s1 & 0xff) << 8) | ((s2 & 0xff) << 16) | ((s3 & 0xff) << 24);
          const H = (s0 >>> 8) | ((s1 >>> 8) << 8) | ((s2 >>> 8) << 16) | ((s3 >>> 8) << 24);
          const sh = g << 2;
          a0 |= (imul(L & M, G) >>> 28) << sh;
          a1 |= (imul((L >>> 1) & M, G) >>> 28) << sh;
          a2 |= (imul((L >>> 2) & M, G) >>> 28) << sh;
          a3 |= (imul((L >>> 3) & M, G) >>> 28) << sh;
          a4 |= (imul((L >>> 4) & M, G) >>> 28) << sh;
          a5 |= (imul((L >>> 5) & M, G) >>> 28) << sh;
          a6 |= (imul((L >>> 6) & M, G) >>> 28) << sh;
          a7 |= (imul((L >>> 7) & M, G) >>> 28) << sh;
          a8 |= (imul(H & M, G) >>> 28) << sh;
          a9 |= (imul((H >>> 1) & M, G) >>> 28) << sh;
          aa |= (imul((H >>> 2) & M, G) >>> 28) << sh;
          ab |= (imul((H >>> 3) & M, G) >>> 28) << sh;
          ac |= (imul((H >>> 4) & M, G) >>> 28) << sh;
          ad |= (imul((H >>> 5) & M, G) >>> 28) << sh;
          ae |= (imul((H >>> 6) & M, G) >>> 28) << sh;
          af |= (imul((H >>> 7) & M, G) >>> 28) << sh;
        }
        const o = wordInBlock + w;
        b0[o] = a0; b1[o] = a1; b2[o] = a2; b3[o] = a3;
        b4[o] = a4; b5[o] = a5; b6[o] = a6; b7[o] = a7;
        b8[o] = a8; b9[o] = a9; ba[o] = aa; bb[o] = ab;
        bc[o] = ac; bd[o] = ad; be[o] = ae; bf[o] = af;
      }
      si += words << 5;
      dstBit += words << 5;
    }
  }

  /**
   * 4 or 8 channels, already expanded by the device layer to one byte per sample. Same
   * gather trick, one accumulator per channel. Sub-16-channel modes run at lower sample
   * rates on this device, so this path is written for clarity, not for the last 20%.
   */
  private writeBase8(chunk: Uint8Array, n: number, dstBit: number): void {
    const imul = Math.imul;
    const M = 0x01010101;
    const G = 0x10204080;
    const nch = this.channelCount;
    const bbl = BASE_BLOCK_BITS_LOG;
    const blockMask = (1 << bbl) - 1;
    const acc = new Int32Array(8);

    let si = 0;
    const head = Math.min(n, (32 - (dstBit & 31)) & 31);
    for (; si < head; si++) this.writeSampleN(chunk[si]!, dstBit + si);
    dstBit += head; // from here on dstBit tracks the current write position

    const bodyEnd = si + (((n - si) >>> 5) << 5);
    while (si < bodyEnd) {
      acc.fill(0);
      for (let g = 0; g < 8; g++) {
        const j = si + (g << 2);
        const L = chunk[j]! | (chunk[j + 1]! << 8) | (chunk[j + 2]! << 16) | (chunk[j + 3]! << 24);
        const sh = g << 2;
        for (let c = 0; c < nch; c++) acc[c]! |= (imul((L >>> c) & M, G) >>> 28) << sh;
      }
      const blk = dstBit >>> bbl;
      const off = (dstBit & blockMask) >>> 5;
      for (let c = 0; c < nch; c++) this.base[c]!.blocks[blk]![off] = acc[c]!;
      si += 32;
      dstBit += 32;
    }
    for (; si < n; si++) this.writeSampleN(chunk[si]!, dstBit + (si - bodyEnd));
  }

  private writeSample16(v: number, bit: number): void {
    const planes = this.base;
    for (let c = 0; c < 16; c++) planes[c]!.setBit(bit, (v >>> c) & 1);
  }

  private writeSampleN(v: number, bit: number): void {
    const planes = this.base;
    for (let c = 0; c < this.channelCount; c++) planes[c]!.setBit(bit, (v >>> c) & 1);
  }

  // ---------------------------------------------------------------- pyramid

  private updatePyramid(from: number, to: number): void {
    for (let k = 1; k <= MAX_LEVEL; k++) {
      const B = this.binSize[k]!;
      const b0 = this.validBins[k]!;
      const b1 = Math.floor(to / B);
      if (b1 <= b0) break; // nothing complete at this level, so nothing above it either
      for (let c = 0; c < this.channelCount; c++) this.reduceRange(k, c, b0, b1);
      this.validBins[k] = b1;
    }
    void from;
  }

  /**
   * Rebuild bins [b0, b1) of level k for one channel from level k-1 (or from the base
   * plane when k === 1). Each output bin is exactly 16 source bits, which is half a word,
   * so 32 output bins consume exactly 16 source words and never straddle a source block.
   */
  private reduceRange(level: number, ch: number, b0: number, b1: number): void {
    const dstHi = this.hi[level]![ch]!;
    const dstLo = this.lo[level]![ch]!;
    dstHi.extendTo(b1);
    dstLo.extendTo(b1);
    const fromBase = level === 1;
    const srcHi = fromBase ? this.base[ch]! : this.hi[level - 1]![ch]!;
    const srcLo = fromBase ? this.base[ch]! : this.lo[level - 1]![ch]!;

    let i = b0;
    const headEnd = Math.min(b1, (b0 + 31) & ~31);
    for (; i < headEnd; i++) this.reduceOne(dstHi, dstLo, srcHi, srcLo, i, fromBase);
    const tailStart = Math.max(headEnd, b1 & ~31);
    for (; i < tailStart; i += 32) {
      if (fromBase) this.reduceGroupFromBase(dstHi, dstLo, srcHi, i);
      else this.reduceGroup(dstHi, dstLo, srcHi, srcLo, i);
    }
    for (; i < b1; i++) this.reduceOne(dstHi, dstLo, srcHi, srcLo, i, fromBase);
  }

  private reduceOne(
    dstHi: BitPlane, dstLo: BitPlane, srcHi: BitPlane, srcLo: BitPlane, i: number, fromBase: boolean,
  ): void {
    const sBit = i * 16;
    const bh = srcHi.blocks[sBit >>> srcHi.blockBitsLog]!;
    const oh = (sBit & srcHi.blockMask) >>> 5;
    const sh = bh[oh]! | 0;
    const hv = (sBit & 16) !== 0 ? sh >>> 16 : sh & 0xffff;
    dstHi.setBit(i, hv !== 0 ? 1 : 0);
    if (fromBase) {
      dstLo.setBit(i, hv !== 0xffff ? 1 : 0);
    } else {
      const bl = srcLo.blocks[sBit >>> srcLo.blockBitsLog]!;
      const ol = (sBit & srcLo.blockMask) >>> 5;
      const sl = bl[ol]! | 0;
      const lv = (sBit & 16) !== 0 ? sl >>> 16 : sl & 0xffff;
      dstLo.setBit(i, lv !== 0 ? 1 : 0);
    }
  }

  /** 32 aligned bins from the base plane: hi = any 1, lo = any 0. */
  private reduceGroupFromBase(dstHi: BitPlane, dstLo: BitPlane, src: BitPlane, i: number): void {
    const sBit = i * 16;
    const sArr = src.blocks[sBit >>> src.blockBitsLog]!;
    const sOff = (sBit & src.blockMask) >>> 5;
    let h = 0, l = 0;
    for (let j = 0; j < 16; j++) {
      const s = sArr[sOff + j]! | 0;
      const loHalf = s & 0xffff;
      const hiHalf = s >>> 16;
      const b = j << 1;
      if (loHalf !== 0) h |= 1 << b;
      if (hiHalf !== 0) h |= 2 << b;
      if (loHalf !== 0xffff) l |= 1 << b;
      if (hiHalf !== 0xffff) l |= 2 << b;
    }
    dstHi.blocks[i >>> dstHi.blockBitsLog]![(i & dstHi.blockMask) >>> 5] = h;
    dstLo.blocks[i >>> dstLo.blockBitsLog]![(i & dstLo.blockMask) >>> 5] = l;
  }

  /** 32 aligned bins from a lower pyramid level: both planes are a plain OR. */
  private reduceGroup(
    dstHi: BitPlane, dstLo: BitPlane, srcHi: BitPlane, srcLo: BitPlane, i: number,
  ): void {
    const sBit = i * 16;
    const ah = srcHi.blocks[sBit >>> srcHi.blockBitsLog]!;
    const al = srcLo.blocks[sBit >>> srcLo.blockBitsLog]!;
    const oh = (sBit & srcHi.blockMask) >>> 5;
    const ol = (sBit & srcLo.blockMask) >>> 5;
    let h = 0, l = 0;
    for (let j = 0; j < 16; j++) {
      const sh = ah[oh + j]! | 0;
      const sl = al[ol + j]! | 0;
      const b = j << 1;
      if ((sh & 0xffff) !== 0) h |= 1 << b;
      if (sh >>> 16 !== 0) h |= 2 << b;
      if ((sl & 0xffff) !== 0) l |= 1 << b;
      if (sl >>> 16 !== 0) l |= 2 << b;
    }
    dstHi.blocks[i >>> dstHi.blockBitsLog]![(i & dstHi.blockMask) >>> 5] = h;
    dstLo.blocks[i >>> dstLo.blockBitsLog]![(i & dstLo.blockMask) >>> 5] = l;
  }

  // ---------------------------------------------------------------- query

  /**
   * HAS_ONE | HAS_ZERO over samples [s0, s1), exactly - no rounding to bin boundaries.
   *
   * Uses the deepest level whose bins fit, covers the aligned core there with one
   * word-parallel scan, and recurses one level down for the at most 15 leftover bins at
   * each end. The recursion depth is bounded by the level, and the work at each level is
   * bounded by 16 bits, so this is O(1) per column with a constant of roughly one word
   * read per level per end. It returns the moment both bits are known, which is most
   * columns of any channel that is actually switching.
   */
  private rangeState(ch: number, s0: number, s1: number, level: number): number {
    while (level > 0) {
      const B = this.binSize[level]!;
      let a = Math.ceil(s0 / B);
      let b = Math.floor(s1 / B);
      const vb = this.validBins[level]!;
      if (b > vb) b = vb;
      if (a >= b) { level--; continue; }

      const coreStart = a * B;
      const coreEnd = b * B;
      // Core first: it is the largest part of the column and it lives in the smallest,
      // hottest array, so a channel that is actually switching answers from cache and
      // never touches the two recursive tails.
      let st = 0;
      if (this.hi[level]![ch]!.anyOne(a, b)) st |= HAS_ONE;
      if (this.lo[level]![ch]!.anyOne(a, b)) st |= HAS_ZERO;
      if (st !== HAS_BOTH && s0 < coreStart) st |= this.rangeState(ch, s0, coreStart, level - 1);
      if (st !== HAS_BOTH && coreEnd < s1) st |= this.rangeState(ch, coreEnd, s1, level - 1);
      return st;
    }
    return this.base[ch]!.rangeState(s0, s1);
  }

  /** Deepest level whose bins are small enough to give a column at least CORE_BINS of them. */
  private pickLevel(samplesPerBin: number): number {
    const want = this.coreBins;
    let k = 0;
    while (k < MAX_LEVEL && this.binSize[k + 1]! * want <= samplesPerBin) k++;
    return k;
  }

  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) {
      throw new Error(`channel ${channel} out of range 0..${this.channelCount - 1}`);
    }
    if (!(bins > 0) || (bins | 0) !== bins) throw new Error(`bins must be a positive integer, got ${bins}`);
    // Non-finite bounds must be rejected explicitly: `s >= e` is *false* for NaN, so a
    // NaN start slipped past the range check and produced columns with low=1 and high=0 -
    // a minimum above a maximum, which this module's own type contract says cannot
    // happen, and which a renderer draws as a clean flat idle trace on every channel.
    // Failing loudly here is the whole point of the guard.
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`query range must be finite, got [${startSample}, ${endSample})`);
    }
    if (this.length === 0) throw new Error('query on an empty store');
    const s = Math.max(0, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) throw new Error(`empty range [${startSample}, ${endSample}) against length ${this.length}`);

    const width = e - s;
    const level = this.pickLevel(width / bins);
    const base = this.base[channel]!;

    if (bins !== this.scratchBins) {
      this.scratchBins = bins;
      this.scratchLow = new Uint8Array(bins);
      this.scratchHigh = new Uint8Array(bins);
      this.scratchEdge = new Uint8Array(bins);
      this.scratchPacked = new Uint8Array(bins);
    }
    const low = this.scratchLow, high = this.scratchHigh;
    const edge = this.scratchEdge, packed = this.scratchPacked;

    // Column i covers [s + floor(i*width/bins), s + floor((i+1)*width/bins)). Both ends are
    // derived from i so the columns cannot drift, they tile [s, e) exactly while
    // width >= bins, and past 1 sample per pixel every column simply shows the sample
    // under it instead of collapsing to an empty range.
    const B = this.binSize[level]!;
    const snap = this.snapColumns && level > 0;
    const gaps = this.gapList;
    let gp = 0;
    for (let i = 0; i < bins; i++) {
      let c0 = s + Math.floor((i * width) / bins);
      let c1 = s + Math.floor(((i + 1) * width) / bins);
      if (snap) {
        if (i !== 0) c0 = Math.min(e - 1, Math.round(c0 / B) * B);
        if (i !== bins - 1) c1 = Math.min(e, Math.round(c1 / B) * B);
      }
      if (c1 <= c0) c1 = c0 + 1;
      if (c1 > e) c1 = e;

      let st = this.rangeState(channel, c0, c1, level);
      const hv = (st & HAS_ONE) !== 0 ? 1 : 0;
      const lv = (st & HAS_ZERO) !== 0 ? 0 : 1;
      // Fold in the sample immediately before the column so an edge that lands exactly on
      // a column boundary is attributed to the column it enters instead of vanishing.
      if (c0 > 0) st |= base.getBit(c0 - 1) !== 0 ? HAS_ONE : HAS_ZERO;
      const ev = st === HAS_BOTH ? 1 : 0;

      high[i] = hv;
      low[i] = lv;
      edge[i] = ev;
      // Columns ascend, gaps are sorted: one monotone walk flags every column that
      // overlaps an unknown span. The low/high/edge bits stay best-effort for it.
      while (gp < gaps.length && gaps[gp]!.endSample <= c0) gp++;
      const gapHit = gp < gaps.length && gaps[gp]!.startSample < c1;
      packed[i] = hv | (lv << 1) | (ev << 2) | (gapHit ? GAP_BIT : 0);
    }

    return {
      channel, startSample: s, endSample: e, bins,
      low, high, edge, packed,
    };
  }

  // ---------------------------------------------------------------- edges

  /**
   * Exact transition positions in [startSample, endSample). A position p is returned when
   * sample p differs from sample p-1, so an edge sitting exactly on `startSample` is
   * included - a decoder asking for a window wants the transition that enters it.
   *
   * O(range / 32 + count): whole words with no transition are rejected by a single
   * comparison, which is what makes scanning an idle channel across a 100M capture cheap.
   *
   * Two passes - count, then fill - rather than one pass into a doubling array. The
   * result can be genuinely enormous: a period-4 clock over a 100M capture has 50M edges,
   * which is a 200 MB Int32Array, and a doubling array hits that size while still holding
   * its 100 MB predecessor. Measured: the doubling version pushed node's peak RSS to
   * 770 MB on this capture. Counting first is one extra bit-plane scan and caps the
   * allocation at exactly what is returned. Callers who do not want a 200 MB answer
   * should window the request, or ask edgeCount() first.
   */
  edges(channel: number, startSample: number, endSample: number): Int32Array {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return new Int32Array(0);
    let n = 0;
    for (const [a, b] of segs) n += this.scanEdgesRange(channel, a, b, null, 0);
    if (n === 0) return new Int32Array(0);
    const out = new Int32Array(n);
    let w = 0;
    for (const [a, b] of segs) w += this.scanEdgesRange(channel, a, b, out, w);
    if (w !== n) throw new Error(`edge count changed between passes: ${n} then ${w}`);
    return out;
  }

  /** How many edges edges() would return, without materialising them. */
  edgeCount(channel: number, startSample: number, endSample: number): number {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return 0;
    let n = 0;
    for (const [a, b] of segs) n += this.scanEdgesRange(channel, a, b, null, 0);
    return n;
  }

  /** Validated, gap-filtered sub-ranges of [start, end), or null when empty. */
  private edgeSegments(
    channel: number, startSample: number, endSample: number,
  ): Array<[number, number]> | null {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) {
      throw new Error(`channel ${channel} out of range 0..${this.channelCount - 1}`);
    }
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`edges range must be finite, got [${startSample}, ${endSample})`);
    }
    const s = Math.max(1, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) return null;
    return splitAroundGaps(this.gapList, s, e);
  }

  /** Core scan over one known-data range [s, e): `out` null counts, non-null fills at
   *  `outOff`. Returns the number of edges. */
  private scanEdgesRange(
    channel: number, s: number, e: number, out: Int32Array | null, outOff: number,
  ): number {
    const plane = this.base[channel]!;
    const blockWords = plane.blockWords;
    let n = outOff;

    const wStart = s >>> 5;
    const wEnd = (e - 1) >>> 5;
    const firstMask = -1 << (s & 31);
    const lastHi = ((e - 1) & 31) + 1;
    const lastMask = lastHi === 32 ? -1 : ~(-1 << lastHi);
    // carry is the sample immediately below the first word; word 0 has no predecessor.
    let carry = wStart === 0 ? 0 : plane.getBit(wStart * 32 - 1);

    let w = wStart;
    while (w <= wEnd) {
      const blk = Math.floor((w * 32) / plane.blockBits);
      const arr = plane.blocks[blk]!;
      const wordBase = (blk * plane.blockBits) / 32;
      const stop = Math.min(wEnd, wordBase + blockWords - 1);
      for (; w <= stop; w++) {
        const v = arr[w - wordBase]! | 0;
        let x = v ^ ((v << 1) | carry);
        carry = (v >>> 31) & 1;
        if (x === 0) continue;
        if (w === wStart) x &= firstMask;
        if (w === wEnd) x &= lastMask;
        if (w === 0) x &= ~1; // sample 0 has no predecessor
        if (out === null) {
          let y = x - ((x >> 1) & 0x55555555);
          y = (y & 0x33333333) + ((y >> 2) & 0x33333333);
          y = (y + (y >> 4)) & 0x0f0f0f0f;
          n += Math.imul(y, 0x01010101) >> 24;
        } else {
          const bitBase = w * 32;
          while (x !== 0) {
            const t = x & -x;
            out[n++] = bitBase + (31 - Math.clz32(t));
            x ^= t;
          }
        }
      }
    }
    return n - outOff;
  }

  // ---------------------------------------------------------------- misc

  memory(): MemoryReport {
    let baseBytes = 0;
    for (const p of this.base) baseBytes += p.byteLength();
    let pyramidBytes = 0;
    for (let k = 1; k <= MAX_LEVEL; k++) {
      for (const p of this.hi[k]!) pyramidBytes += p.byteLength();
      for (const p of this.lo[k]!) pyramidBytes += p.byteLength();
    }
    const usedBase = Math.ceil(this.length / 8) * this.channelCount;
    return {
      baseBytes,
      pyramidBytes,
      totalBytes: baseBytes + pyramidBytes,
      overhead: baseBytes === 0 ? 0 : pyramidBytes / baseBytes,
      slackBytes: baseBytes - usedBase,
    };
  }

  /** Exposed for tests: the raw sample bit, no pyramid involved. */
  sampleAt(channel: number, index: number): number {
    if (index < 0 || index >= this.length) throw new Error(`sample ${index} out of range`);
    return this.base[channel]!.getBit(index);
  }
}
