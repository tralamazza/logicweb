// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Turning a viewport into one byte per pixel column per channel, ready for upload.
 *
 * The one hard problem here is that the viewport is a float range over an unbounded
 * timeline while `SampleStore.query` takes an integer range that must lie inside the
 * capture. Three things can push them apart:
 *
 *   1. fractional zoom - `start` is 12345.7, not 12345;
 *   2. the view extending past the end of the data (always true during a live capture,
 *      and true whenever the user pans right off the end);
 *   3. the view starting before sample 0.
 *
 * The naive fix - clamp the range and ask for the same number of bins - silently
 * rescales the picture: the same data gets stretched to fill the screen and every edge
 * moves. That is exactly the class of bug this component is judged on, so instead the
 * plan below keeps the query on the integer range the store can answer and carries the
 * mismatch as an exact affine map from data column to screen pixel, which the shader
 * inverts per fragment.
 *
 * The map is `screenX = j * scale + offset`. When the view lies wholly inside the data
 * and starts on an integer sample, scale == 1 and offset == 0 and every screen pixel is
 * exactly one data column - the common case costs nothing.
 *
 * When they do differ, a screen pixel can straddle two data columns. The shader ORs all
 * data columns overlapping the pixel. OR is the safe direction: an edge can be reported
 * one pixel wide when it should have been half a pixel, but it can never disappear.
 */

import type { ColumnView, SampleStore } from '../data/types.js';

/**
 * Bit layout of one atlas byte, matching `ColumnView.packed`.
 *
 * Careful with bit 1. The store sets it from `lv = (state & HAS_ZERO) ? 0 : 1`, so it
 * means "this column's MINIMUM is 1", i.e. the column contains NO zero - the opposite of
 * what this comment claimed until a critic caught it. The renderer never reads it (see
 * NOTES), which is exactly why an inverted comment could survive here unnoticed; it is
 * re-exported from index.ts, so anyone outside who trusted the old wording had it
 * backwards.
 */
export const BIT_HIGH = 1; // column contains at least one 1
export const BIT_LOW = 2; // column contains NO 0, i.e. min == 1  (unused by the renderer)
export const BIT_EDGE = 4; // column contains at least one transition
export const BIT_GAP = 8; // column overlaps a noteGap span -> NO_DATA, other bits best effort

export interface ColumnPlan {
  /** False when the viewport touches no captured samples at all. */
  hasData: boolean;
  /** Integer sample range handed to `SampleStore.query`. */
  queryStart: number;
  queryEnd: number;
  /** Number of columns requested, i.e. the used width of the atlas. */
  dataBins: number;
  /** screenX = column * scale + offset, in device pixels from the left of the wave area. */
  scale: number;
  offset: number;
}

const EMPTY_PLAN: ColumnPlan = {
  hasData: false,
  queryStart: 0,
  queryEnd: 0,
  dataBins: 0,
  scale: 1,
  offset: 0,
};

/**
 * @param start   viewport start in samples (float, may be negative)
 * @param end     viewport end in samples (float)
 * @param widthPx waveform width in device pixels
 * @param length  captured samples available right now
 * @param maxBins atlas width; dataBins is capped at it
 */
export function planColumns(
  start: number,
  end: number,
  widthPx: number,
  length: number,
  maxBins: number,
): ColumnPlan {
  if (!(widthPx > 0) || !(maxBins > 0)) return EMPTY_PLAN;
  const span = end - start;
  if (!(span > 0) || !Number.isFinite(span)) return EMPTY_PLAN;
  if (length <= 0) return EMPTY_PLAN;

  const pxPerSample = widthPx / span;
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(length, Math.ceil(end));
  if (e <= s) return EMPTY_PLAN;

  // Screen width, in device px, of the sample range the store can actually answer.
  const spanScreen = (e - s) * pxPerSample;
  const dataBins = Math.max(1, Math.min(maxBins, Math.ceil(spanScreen - 1e-9)));
  return {
    hasData: true,
    queryStart: s,
    queryEnd: e,
    dataBins,
    scale: spanScreen / dataBins,
    offset: (s - start) * pxPerSample,
  };
}

/**
 * Fill `atlas` (rowStride bytes per row, one row per visible channel) from the store.
 *
 * `ColumnView.packed` is reused scratch inside the store, so it is copied out row by row
 * immediately; holding the reference across the next query would silently give every
 * channel the last channel's data.
 */
export function fillAtlas(
  store: SampleStore,
  channels: readonly number[],
  plan: ColumnPlan,
  atlas: Uint8Array,
  rowStride: number,
): void {
  if (!plan.hasData) {
    atlas.fill(0);
    return;
  }
  if (atlas.length < channels.length * rowStride) {
    throw new Error(`atlas too small: ${atlas.length} < ${channels.length} * ${rowStride}`);
  }
  if (plan.dataBins > rowStride) {
    throw new Error(`plan wants ${plan.dataBins} bins but the atlas row is ${rowStride}`);
  }
  for (let row = 0; row < channels.length; row++) {
    const ch = channels[row]!;
    const view: ColumnView = store.query(ch, plan.queryStart, plan.queryEnd, plan.dataBins);
    // Every channel in one frame must answer over the SAME sample range, or the live
    // edge gets a step in it: channel 0 drawn against a shorter capture than channel 15.
    //
    // The renderer snapshots store.length once per frame and clamps queryEnd to it, but
    // `query` silently clamps again against its own live `this.length`, so the guarantee
    // rests on that clamp being a no-op. It is a no-op only while length is monotonically
    // non-decreasing. A store that TRIMS - and "trim to last N seconds" is a real
    // feature [SOURCE] - breaks it, as does a length read from a SharedArrayBuffer that a
    // capture worker is writing. Checking the returned range costs two integer compares
    // per channel and turns a silent visual artefact into a loud failure.
    if (view.bins !== plan.dataBins) {
      throw new Error(`store returned ${view.bins} bins, asked for ${plan.dataBins}`);
    }
    if (view.startSample !== plan.queryStart || view.endSample !== plan.queryEnd) {
      throw new Error(
        `channel ${ch} answered over [${view.startSample}, ${view.endSample}) but the frame ` +
          `asked for [${plan.queryStart}, ${plan.queryEnd}) - the store's length moved mid-frame`,
      );
    }
    atlas.set(view.packed.subarray(0, plan.dataBins), row * rowStride);
  }
}
