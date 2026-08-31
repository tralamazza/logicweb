// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Every appearance constant the shell uses, with where it came from.
 *
 * Rules, same as the rest of this project:
 *   [MEASURED] - read off rendered output on this machine,
 *                which converts through the embedded ICC profile first and which carries
 *                a control that proves it can fail.
 *   [CHOSEN]   - a design decision, with the reasoning stated inline.
 *   [CHOICE]   - ours. Not in the spec, not in a screenshot, and labelled so nobody later
 *                mistakes it for an observation.
 *
 * All lengths are CSS px. The screenshots are 3200x2000 at devicePixelRatio 2, so a
 * measurement of 96 device px is written here as 48.
 */

/** [CHOSEN] . Identical in light and dark theme except ch0. */
export const CHANNEL_COLORS: readonly string[] = [
  '#d4d4d4', '#C79579', '#FF6D7F', '#FFB45B',
  '#e8d836', '#58c667', '#53A9FD', '#AF92FB',
];

/** [CHOSEN] . */
export const COLORS = {
  /** Darkest background, used for the toolbar's inactive areas. */
  bg00: '#141415',
  /** [MEASURED] The plot background, the label column and the toolbar are all this. */
  bg10: '#1B1B1C',
  bg20: '#212224',
  /** [SOURCE] background-30. [MEASURED] also the badge background on a multi-bubble. */
  bg30: '#2C2C2E',
  /** [MEASURED] the right icon rail and the status bar. [SOURCE] calls this "hover". */
  panel: '#3A3A3E',
  borderLow: '#303136',
  borderHigh: '#57575E',
  text: '#FFFFFF',
  text80: '#E0E0E0',
  text50: '#909091',
  accent: '#775AD2',
  selection: '#26A3D9',
  negative: '#f52a66',
  warning: '#fbd86f',
  stop: '#db4c39',
} as const;

/**
 * [MEASURED] on 01-idle-empty-session.png, and identical on 02/03/04/05.
 * Device px in the comments, CSS px in the values.
 */
export const CHROME = {
  /** device y 66..125 */
  toolbarHeight: 30,
  /** device y 128..185 */
  axisHeight: 29,
  /** device y 1922..1999 */
  statusHeight: 39,
  /** device x 0..211 including the 2 device px border at 208 */
  labelColWidth: 106,
  /** device x 0..9, filled with the channel colour */
  colorStripWidth: 5,
  /** device x 3106..3199 including its 2 device px left border */
  railWidth: 47,
  /** every border between two panels is 2 device px */
  borderWidth: 1,
} as const;

/**
 * Row geometry.
 *
 * `baseRowHeight` is NOT a constant - it is derived per capture, and the app
 * fits the stack to the window. [MEASURED] 48 CSS px in 02 and 05, 49 in 04, 53 in 03,
 * and in every one of them `rows * height + lanes * 20` lands within a few px of the
 * available height. So the shell computes it the same way and this is only the fallback.
 */
export const ROWS = {
  /** [CHOICE] fallback when the stack has no height yet. */
  baseRowHeight: 48,
  /** [CHOICE] clamps on the auto-fit, so a 1-channel capture is not one 800 px row. */
  minRowHeight: 26,
  maxRowHeight: 72,
  /** [MEASURED] src/render/theme.ts, 4 device px of #57575E at every row boundary. */
  separator: 2,
  /** [MEASURED] 16 device px of clear space above the high line and below the low one. */
  gutter: 8,
  /** [SOURCE] ALWAYS_HIGH / ALWAYS_LOW are 1 px fillRects in CSS space. */
  lineWidth: 1,
  /**
   * [MEASURED] An annotated row is exactly 40 device px taller than a plain one in 02,
   * 04 and 05, and the lane sits ABOVE a trace band that keeps its plain height - see
   * NOTES.md section 2 for the idle-line offsets that establish this.
   * [SOURCE] agrees: "bubble rows are 16 px tall for low-level analyzers with 4 px top
   * padding" = 20.
   */
  laneHeight: 20,
  /** [MEASURED] device y rowTop+8 .. rowTop+40 */
  lanePadTop: 4,
  /** [MEASURED] 32 device px */
  bubbleHeight: 16,
} as const;

/**
 * Time axis.
 *
 * [SOURCE] "Minor tick spacing is chosen as the smallest power of ten that keeps ticks at
 * least 45 px apart; major spacing is exactly 10x the minor spacing."
 * [MEASURED] minor ticks 46.3 CSS px apart on 01, majors at 0/10/20/30 ms with 1 ms
 * minors - i.e. exactly that rule, at its boundary.
 */
export const AXIS = {
  /** [SOURCE] minimumHorizontalTickSpacingPx */
  minTickSpacing: 45,
  /** [SOURCE] "Tick text is 11 px bold, left-aligned, bottom baseline." */
  tickFont: 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  /** [MEASURED] major label ink at device y 136..152 -> baseline at CSS y 76 of the window,
   *  i.e. 12.5 CSS px below the top of the 29 px axis. */
  majorBaseline: 12.5,
  /** [MEASURED] minor label ink at device y 159..176. */
  minorBaseline: 24,
  /** [MEASURED] minor tick marks occupy device y 179..185 = the bottom 3.5 CSS px. */
  minorTickLength: 3.5,
  /** [SOURCE] "Major ticks draw a vertical line from half the axis height downward." */
  majorTickFraction: 0.5,
  /** [SOURCE] a 4x6 px left-pointing arrow marks a major tick pinned to x=0. */
  pinnedArrow: { w: 4, h: 6 },
} as const;

/**
 * [MEASURED] Vertical gridlines are dropped from every minor tick through the whole row
 * stack, 1 CSS px wide, dashed 3 CSS px on / 3 off.
 *
 * The surprise, and it is measured rather than assumed: the gridline at a MAJOR tick is
 * DIMMER than the one at a minor tick (#262629 against #39393D), not brighter. Checked on
 * all four majors of 01-idle-empty-session.png (device x 210, 1136, 2062, 2990) against
 * their neighbouring minors. Intuition said the opposite; the pixels did not.
 */
export const GRID = {
  minorColor: '#39393D',
  majorColor: '#262629',
  width: 1,
  dash: [3, 3] as [number, number],
} as const;

/**
 * Annotation bubbles.
 *
 * [CHOSEN] all of it: the multi-bubble count saturates at 99+, the badge
 * is a 9 px 2 px-padded 5 px-radius chip in background-30, an overflowing bubble is
 * clamped to the viewport and grows a 3 px triangle, tooltips cap at 80 characters.
 */
export const BUBBLE = {
  font: '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  /** [CHOICE] Pick the longest variant with `text.length * 6 < bubbleWidth`
   *  (CHAR_WIDTH = 6 at font-size 14). We measure the string instead, which is the same
   *  rule done exactly rather than approximately - see NOTES.md section 7. */
  padX: 4,
  radius: 2,
  /** [SOURCE] MAX_BUBBLES_COUNT */
  maxCount: 99,
  badgeFontPx: 9,
  badgePad: 2,
  badgeRadius: 5,
  /** [SOURCE] 3 px solid triangle on the overflowing side. */
  overflowTriangle: 3,
  /** [CHOICE] below this width a bubble cannot show even its shortest text, so it merges
   *  with its neighbours into a counted multi-bubble. */
  minLegibleWidth: 14,
  /** [SOURCE] tooltips cap at 80 characters. */
  tooltipChars: 80,
} as const;

/**
 * [CHOSEN] three analyzer colours -
 * I2C, Async Serial and SPI in that order - then [DRIVEN] the spec's stated default
 * #95A0B4, then [CHOICE] two more in the same register so a fourth analyzer is not black.
 */
export const ANALYZER_COLORS: readonly string[] = [
  '#D2B56F', '#F69998', '#ABA48B', '#95A0B4', '#8FBF9F', '#B5A8D8',
];

/** [SOURCE] Range measurements have their own four-colour palette. */
export const MEASURE_COLORS: readonly string[] = ['#CD427E', '#00994D', '#2683D9', '#DB4C39'];

/** [CHOSEN] Zoom-in clamps at 20 samples across the full width. Re-exported from
 *  src/render so the UI cannot drift from the renderer's own clamp. */
export { MIN_SAMPLES_ON_SCREEN } from '../render/transform.js';
