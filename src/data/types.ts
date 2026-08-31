// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Public types for src/data. The SampleStore shape is fixed by docs/ARCHITECTURE.md;
 * ColumnView is left to this module to define, so it is defined here.
 */

/**
 * One entry per pixel column. All four arrays have length `bins`.
 *
 * `low[i]`  - the minimum sample value in column i (0 or 1)
 * `high[i]` - the maximum sample value in column i (0 or 1)
 * `edge[i]` - 1 if a transition happens at any position p with
 *             `colStart(i) <= p < colEnd(i)`, where "a transition at p" means
 *             `sample[p] != sample[p - 1]`.
 *
 * Equivalently, and this is how it is computed: the store asks whether the sample span
 * `[colStart(i) - 1, colEnd(i))` contains both a 0 and a 1. Reaching one sample back is
 * what makes a transition landing exactly on a column boundary belong to the column it
 * enters, instead of falling into the gap between two columns and disappearing.
 * `low != high` implies `edge`, but not the reverse: a column that is entirely 0 but was
 * preceded by a 1 has a real falling edge at its left border and reports
 * edge=1, low=0, high=0.
 *
 * `packed[i]` is the same information as one byte, laid out for direct upload as a
 * WebGL2 R8UI texture: bit0 = high, bit1 = low, bit2 = edge, bit3 = gap (the column
 * overlaps a span the store knows it has no data for). When bit3 is set the renderer
 * draws NO_DATA and the low/high/edge bits are best effort only - a store that cannot
 * express gaps never sets bit3.
 *
 * ## Two things that will bite a caller who assumes otherwise
 *
 * **1. These arrays are borrowed, not owned.** A store reuses one set of scratch buffers
 * for every query of a given `bins`, so the arrays in a view you are holding are
 * overwritten by the next `query()`. That is deliberate - a 16-channel frame at 60 fps
 * would otherwise churn megabytes per second of garbage - but it means:
 *
 * ```ts
 * const a = store.query(0, 0, n, 1000);
 * const b = store.query(1, 0, n, 1000);   // a.packed and b.packed are now the same array
 * ```
 *
 * Read or upload a view before issuing the next query, or copy it (`a.packed.slice()`).
 * The `readonly` markers stop you reassigning the fields; they do not make the bytes
 * stable. Consuming one channel at a time inside a render loop is safe.
 *
 * **2. An over-wide range is clamped silently, and only the returned view says so.**
 * Asking for `[0, 2e8)` on a 100M-sample store returns `bins` columns spanning
 * `[0, 1e8)`, each twice as wide in samples as the caller intended. Nothing throws,
 * because clamping the viewport to the data is the normal thing to do when a user drags
 * past the end of a capture. Callers converting pixels to time must read
 * `view.startSample` and `view.endSample` back rather than reusing what they passed in.
 * (Non-finite bounds are a different matter and do throw.)
 */
export interface ColumnView {
  readonly channel: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly bins: number;
  readonly low: Uint8Array;
  readonly high: Uint8Array;
  readonly edge: Uint8Array;
  readonly packed: Uint8Array;
}

/** bit3 of `ColumnView.packed`: the column overlaps a span the store has no data for. */
export const GAP_BIT = 8;

export interface SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  readonly length: number;
  append(chunk: Uint8Array): void;
  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView;
  edges(channel: number, startSample: number, endSample: number): Int32Array;
  /** Record that samples [startSample, endSample) are unknown (a transfer dropout).
   *  Gaps must not overlap; overlapping notes are merged. */
  noteGap(startSample: number, endSample: number): void;
  /** The unknown spans, sorted and non-overlapping. A store with no gaps returns []. */
  gaps(): GapSpan[];
}

/**
 * A span of samples the store has no data for. `endSample` is exclusive. Columns that
 * overlap a gap carry bit3 in `ColumnView.packed`, and `edges()` never reports a
 * transition inside a gap - unknown is not the same as idle.
 */
export interface GapSpan {
  readonly startSample: number;
  readonly endSample: number;
}

/** Breakdown of resident bytes, for the memory number in the benchmark. */
export interface MemoryReport {
  /** Base level: one bit per sample per channel. */
  baseBytes: number;
  /** All pyramid levels combined. */
  pyramidBytes: number;
  totalBytes: number;
  /** Pyramid as a fraction of base. */
  overhead: number;
  /** Bytes actually allocated but not yet used (block tail slack). */
  slackBytes: number;
}
