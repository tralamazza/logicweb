// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Row geometry in whole device pixels.
 *
 * Everything is snapped here rather than in the shader, because "crisp" is a property of
 * the geometry, not of the rasteriser. The same result comes from drawing at
 * `highY - 0.5` with `ctx.scale(dpr, dpr)` [SOURCE]; the arithmetic below is the same
 * idea done once, on the CPU, for any devicePixelRatio including the fractional ones
 * (1.25, 1.5) where the half-pixel trick stops working.
 *
 * Row tops are computed as `round(i * h)` rather than `i * round(h)` so 45 CSS px rows at
 * dpr 1.5 come out 67 and 68 px alternating instead of accumulating a pixel of drift per
 * row down a 16-channel stack.
 */

export interface RowGeometry {
  /** Top of the row, device px from the top of the canvas. Includes the separator. */
  top: number;
  /** Row pitch in device px, separator included. */
  height: number;
  /** Drawable trace band, i.e. `height` minus the separator. */
  bandHeight: number;
  /** Top of the 1-line-width band drawn for an all-high column. */
  yHiTop: number;
  /** Top of the 1-line-width band drawn for an all-low column. */
  yLoTop: number;
}

export interface LayoutMetrics {
  rows: RowGeometry[];
  /** Device px. Integer, >= 1. */
  lineWidth: number;
  /** Device px. Integer, >= 1. */
  edgeWidth: number;
  /** Device px height of the NO_DATA top border. */
  noDataBorder: number;
  /** Device px height of the between-rows separator. 0 disables it. */
  separator: number;
  /** Total device px consumed by all rows. */
  totalHeight: number;
}

export interface LayoutOptions {
  rowCount: number;
  /** Uniform row pitch, used for any row not covered by `rowHeightsCssPx`. */
  rowHeightCssPx: number;
  /**
   * Per-row pitch in CSS px, overriding `rowHeightCssPx` where present.
   *
   * Rows are NOT uniform, and not only across sessions. A row carrying analyzer chips
   * grows to fit them, so within one view most rows sit at the base pitch and a few are
   * taller - e.g. fourteen rows at 98 device px and two at 138.
   *
   * This module originally derived every row from one height and documented the variation
   * as a per-session property. That is wrong within a single view: rows above the
   * first tall row line up and everything below it is cumulatively 80 device px out,
   * which loses a blind A/B outright against any capture with an analyzer attached.
   *
   * The gutter rule is unchanged per row - a 138 px row has a 134 px band and its low
   * line at +116 = 134 - 16 - 2, the same arithmetic at a different height.
   */
  rowHeightsCssPx?: readonly number[];
  gutterCssPx: number;
  lineWidthCssPx: number;
  edgeWidthDevicePx: number;
  noDataBorderCssPx: number;
  rowSeparatorCssPx: number;
  dpr: number;
}

export function computeLayout(o: LayoutOptions): LayoutMetrics {
  if (o.rowCount < 0) throw new Error(`rowCount must be >= 0, got ${o.rowCount}`);
  if (!(o.dpr > 0)) throw new Error(`dpr must be positive, got ${o.dpr}`);
  if (!(o.rowHeightCssPx > 0)) throw new Error(`rowHeightCssPx must be positive`);
  const per = o.rowHeightsCssPx;
  if (per) {
    for (let i = 0; i < per.length; i++) {
      if (!(per[i]! > 0)) throw new Error(`rowHeightsCssPx[${i}] must be positive, got ${per[i]}`);
    }
  }

  const lineWidth = Math.max(1, Math.round(o.lineWidthCssPx * o.dpr));
  const edgeWidth = Math.max(1, Math.round(o.edgeWidthDevicePx));
  const noDataBorder = Math.max(1, Math.round(o.noDataBorderCssPx * o.dpr));
  const separator = Math.max(0, Math.round(o.rowSeparatorCssPx * o.dpr));
  const gutterDev = o.gutterCssPx * o.dpr;

  // Accumulate in CSS px and round the running edge, not each height. Rounding heights
  // individually would drift; rounding the cumulative edge keeps every boundary within
  // half a pixel of the true one and keeps rows exactly gapless.
  const rows: RowGeometry[] = [];
  let cssEdge = 0;
  let top = 0;
  for (let i = 0; i < o.rowCount; i++) {
    cssEdge += per && i < per.length ? per[i]! : o.rowHeightCssPx;
    const bottom = Math.round(cssEdge * o.dpr);
    const height = bottom - top;
    const bandHeight = Math.max(lineWidth * 2, height - separator);

    // [MEASURED] The gutter is clear space ABOVE the high line and BELOW the low line -
    // the line is not centred on the gutter offset. In
    // a 94-device-px band has its high line
    // occupying rows 16..17 and its low line rows 76..77, i.e. exactly
    // [band + gutter, band + gutter + lineWidth) and
    // [band + bandHeight - gutter - lineWidth, band + bandHeight - gutter).
    // The earlier centred version put both lines one pixel high.
    let gut = Math.round(gutterDev);
    if (bandHeight - 2 * gut < lineWidth * 2) {
      // A row too short for the configured gutter would put the high line below the low
      // line and invert the trace. Shrink the gutter instead of drawing nonsense.
      gut = Math.max(0, Math.floor((bandHeight - lineWidth * 2) / 2));
    }
    rows.push({
      top,
      height,
      bandHeight,
      yHiTop: top + gut,
      yLoTop: top + bandHeight - gut - lineWidth,
    });
    top = bottom;
  }

  const last = rows[rows.length - 1];
  return {
    rows,
    lineWidth,
    edgeWidth,
    noDataBorder,
    separator,
    totalHeight: last ? last.top + last.height : 0,
  };
}
