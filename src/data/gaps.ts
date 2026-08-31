// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The gap-span algebra, shared by every SampleStore implementation.
 *
 * Both stores need the same two operations and had them written twice, with the same
 * semantics but different control flow - which is how one of them silently keeps a bug
 * the other gets fixed for. They live here instead.
 *
 * A gap list is always sorted by `startSample`, non-overlapping, and non-adjacent:
 * `mergeGap` is the only way to extend one, and it collapses touching spans so that
 * [0, 10) and [10, 20) never coexist as two entries. Callers rely on the sortedness for
 * the single monotone walk in `query()`.
 */

import type { GapSpan, SampleStore } from './types.js';

/** Finite and exactly an int32. Gap bounds are sample positions, so this is the range. */
export function isSampleIndex(v: number): boolean {
  return Number.isFinite(v) && (v | 0) === v;
}

/**
 * Validate a gap against a store of `length` samples. Throws rather than clamping: a gap
 * with bounds the caller did not mean is worse than no gap, because it renders as
 * NO_DATA over real data.
 */
export function assertGapBounds(startSample: number, endSample: number, length: number): void {
  if (!isSampleIndex(startSample) || !isSampleIndex(endSample)) {
    throw new Error(`gap must have integer bounds, got [${startSample}, ${endSample})`);
  }
  if (!(endSample > startSample)) {
    throw new Error(`gap must be non-empty, got [${startSample}, ${endSample})`);
  }
  if (startSample < 0 || endSample > length) {
    // `endSample` is exclusive, so it may equal `length` - the bound below is written
    // the way the check actually reads.
    throw new Error(`gap [${startSample}, ${endSample}) outside 0 <= start < end <= ${length}`);
  }
}

/**
 * Insert [start, end) into a sorted gap list, merging overlaps AND adjacency. Returns a
 * new list; the input is not mutated.
 */
export function mergeGap(list: readonly GapSpan[], start: number, end: number): GapSpan[] {
  const out: GapSpan[] = [];
  let lo = start, hi = end;
  let placed = false;
  for (const g of list) {
    if (!placed && g.startSample > hi) {
      // Entirely after the merged span: place the new one, then copy the rest through.
      out.push({ startSample: lo, endSample: hi });
      placed = true;
    }
    if (placed || g.endSample < lo) {
      out.push(g);
      continue;
    }
    // Overlap or adjacency (g.endSample === lo counts): widen and keep scanning.
    lo = Math.min(lo, g.startSample);
    hi = Math.max(hi, g.endSample);
  }
  if (!placed) out.push({ startSample: lo, endSample: hi });
  return out;
}

/**
 * The known-data sub-ranges of [s, e), i.e. [s, e) with every gap cut out of it. Empty
 * when the range is entirely inside a gap.
 *
 * Note what this does NOT do: a sub-range that starts at a gap's end still has the gap's
 * last sample as its predecessor, so an `edges()` scan over it can report a transition at
 * that boundary derived from unknown data. That is deliberate - the boundary sample
 * itself is known, and dropping it would hide a real level change.
 */
export function splitAroundGaps(
  gaps: readonly GapSpan[], s: number, e: number,
): Array<[number, number]> {
  if (gaps.length === 0) return [[s, e]];
  const out: Array<[number, number]> = [];
  let a = s;
  for (const g of gaps) {
    if (g.endSample <= a) continue;
    if (g.startSample >= e) break;
    if (g.startSample > a) out.push([a, g.startSample]);
    a = g.endSample;
    if (a >= e) return out;
  }
  if (a < e) out.push([a, e]);
  return out;
}

/**
 * Reconstruct one channel as (initial level, edge positions) from a store that may have
 * gaps, preserving the level on the far side of every gap.
 *
 * Why this is not just `store.edges(c, 0, len)`. `edges()` is contractually gap-filtered:
 * every transition inside a gap is dropped, because those positions are unknown. But the
 * level is a *parity* of the edges before a point, so dropping an odd number of them
 * inverts every level after the gap - not just inside it. A store rebuilt from the raw
 * filtered list therefore draws the whole remainder of the capture upside down on that
 * channel. That is real corruption the source store did not have: a live capture keeps
 * appending correct samples after a dropout, so it knows the post-gap level perfectly
 * well; only the round trip loses it.
 *
 * The interior edges are genuinely unknown. The level at the gap's end is not - the store
 * can be asked. So when the filtered list reproduces the wrong level there, one synthetic
 * edge restores the parity.
 *
 * It goes at `endSample - 1`, INSIDE the gap, not at `endSample`:
 *   - the position is already marked untrusted (bit3) and drawn under the NO_DATA wash,
 *     so it costs nothing visually and claims nothing about known data;
 *   - the gap interior is empty by construction, so it can never land on an existing edge
 *     and create a duplicate position, which would toggle twice and cancel;
 *   - it is >= startSample because gaps are non-empty, and < length because endSample
 *     <= length, so it is always a legal edge position.
 *
 * A gap running to the end of the capture is skipped: there is no sample after it, so
 * there is no level to preserve and nothing observable to correct.
 */
export function channelAcrossGaps(
  store: SampleStore, channel: number,
): { initial: 0 | 1; edges: Int32Array } {
  const len = store.length;
  if (len === 0) return { initial: 0, edges: new Int32Array(0) };

  const levelAt = (p: number): 0 | 1 => (store.query(channel, p, p + 1, 1).high[0] ? 1 : 0);
  const initial = levelAt(0);
  const src = store.edges(channel, 0, len);
  const gaps = store.gaps();
  if (gaps.length === 0) return { initial, edges: src };

  // `level(p) = initial ^ parity(edges <= p)`, so walking the gaps in order and counting
  // the edges passed gives the level the list currently reproduces at each gap's end.
  const extra: number[] = [];
  let i = 0;
  let count = 0;
  for (const g of gaps) {
    if (g.endSample >= len) continue;
    while (i < src.length && src[i]! <= g.endSample) { i++; count++; }
    const have = (initial ^ ((count + extra.length) & 1)) as 0 | 1;
    if (have !== levelAt(g.endSample)) extra.push(g.endSample - 1);
  }
  if (extra.length === 0) return { initial, edges: src };

  // Merge: every synthetic position lies strictly inside a gap, and no source edge does,
  // so a single ordered pass suffices.
  const out = new Int32Array(src.length + extra.length);
  let a = 0, b = 0, w = 0;
  while (a < src.length || b < extra.length) {
    if (b >= extra.length || (a < src.length && src[a]! <= extra[b]!)) out[w++] = src[a++]!;
    else out[w++] = extra[b++]!;
  }
  return { initial, edges: out };
}

/**
 * Record samples the device lost: append filler for them, then mark that span as a gap.
 *
 * Why filler at all. The lost samples were never delivered and never will be, so without
 * this they occupy no index and the store's time axis silently compresses at every
 * dropout - sample 1,000,000 stops meaning the same instant the device meant by it, and
 * every measurement after the dropout is wrong by the shortfall with nothing recording
 * that it happened. `noteGap` alone cannot express it either: with no samples appended the
 * span has zero width in store coordinates, so there is nothing to mark. Appending first
 * is what makes store time track device time.
 *
 * What the filler contains matters more than it looks. It repeats the LAST KNOWN SAMPLE
 * rather than zeroing. Zeros would invent a falling edge at the gap's start on every
 * channel that was high, and a matching rising edge at its end - and the one at the end
 * sits at a known position, outside the gap, so `edges()` reports it as real and the
 * renderer draws it. Holding the level means the only edge that can appear at the gap's
 * end is one the device's own next sample actually shows, which is the honest claim: the
 * level changed somewhere in the dark, and the earliest position we can prove it had
 * changed is the first sample after.
 *
 * `limitSamples` is the capture ceiling. Returns how many samples were actually appended,
 * which is 0 when the capture is already full - a dropout in the tail of a run that the
 * store has no room to represent is dropped rather than silently truncating the gap.
 */
export function appendLostSamples(
  store: SampleStore, missingSamples: number, limitSamples: number,
): number {
  const start = store.length;
  const room = limitSamples - start;
  const n = Math.min(missingSamples, Math.max(0, room));
  if (n <= 0) return 0;

  let word = 0;
  if (start > 0) {
    for (let c = 0; c < store.channelCount; c++) {
      if (store.query(c, start - 1, start, 1).high[0]) word |= 1 << c;
    }
  }

  // Little-endian, matching PlanarSampleStore.writeBase16's Uint16Array view of the chunk.
  const bytesPerSample = store.channelCount > 8 ? 2 : 1;
  const filler = new Uint8Array(n * bytesPerSample);
  if (bytesPerSample === 2) {
    const lo = word & 0xff;
    const hi = (word >> 8) & 0xff;
    for (let i = 0; i < filler.length; i += 2) { filler[i] = lo; filler[i + 1] = hi; }
  } else if (word !== 0) {
    filler.fill(word & 0xff);
  }

  store.append(filler);
  store.noteGap(start, start + n);
  return n;
}
