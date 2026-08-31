// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Public surface of src/render.
 *
 * docs/ARCHITECTURE.md fixes the contract at "consumes SampleStore.query, owns the
 * canvas and the transform, exposes setViewport(startSample, endSample) and render()".
 * Everything else exported here exists because the UI layer will need it to line its own
 * drawing up with the waveform: the transform (so cursors and ticks land on the same
 * pixel the trace does), the row geometry (so channel labels line up with rows), and the
 * wheel arithmetic (so zoom feels the same everywhere).
 */

export { WaveformRenderer } from './waveformRenderer.js';
export type { WaveformRendererOptions, FrameStats } from './waveformRenderer.js';

export { ViewTransform, WheelIntent, wheelSpanFactor, MIN_SAMPLES_ON_SCREEN } from './transform.js';
export type { ViewportRange, WheelZoomOptions } from './transform.js';

export { computeLayout } from './layout.js';
export type { LayoutMetrics, LayoutOptions, RowGeometry } from './layout.js';

export {
  DARK_THEME,
  LOGIC2_CHANNEL_COLORS,
  LOGIC2_BACKGROUNDS,
  LOGIC2_BORDERS,
  DEFAULT_ROW_HEIGHT_CSS_PX,
  DEFAULT_GUTTER_CSS_PX,
  DEFAULT_LINE_WIDTH_CSS_PX,
  parseHexColor,
} from './theme.js';
export type { Theme } from './theme.js';

export { planColumns, fillAtlas, BIT_HIGH, BIT_LOW, BIT_EDGE, BIT_GAP } from './columns.js';
export type { ColumnPlan } from './columns.js';
