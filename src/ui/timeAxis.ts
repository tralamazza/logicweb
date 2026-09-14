// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The time axis: which ticks, where, and what they are called.
 *
 * Minor spacing normally uses the smallest power of ten that keeps ticks at least
 * `minimumHorizontalTickSpacingPx = 45` apart. At high zoom, once individual samples
 * have that much room, ticks instead follow the exact sampling period. This preserves
 * 5 ns at 200 MS/s, 2.5 ns at 400 MS/s and 833 ps at 1.2 GS/s instead of rounding all
 * of them up to the next decimal decade. Major spacing is exactly ten minor ticks.
 *
 * [MEASURED] on 01-idle-empty-session.png: minor ticks 46.3 CSS px apart, majors at
 * 0/10/20/30 ms with 1 ms minors, minor tick marks in the bottom 3.5 CSS px, major tick
 * lines starting halfway down. The screenshot and the source agree, so both are used.
 *
 * Decimal tick positions use integer picoseconds. Sampling ticks are derived from an
 * integer sample index so repeating periods such as 1e12/1.2e9 ps do not accumulate
 * incremental floating-point drift.
 */

import { AXIS, COLORS, GRID } from './metrics.js';
import { majorLabel, minorLabel } from './format.js';
import { MIN_SAMPLES_ON_SCREEN } from '../render/transform.js';

export interface Tick {
  /** Time in picoseconds from t0. */
  ps: number;
  /** Device px from the left edge of the plot area. */
  x: number;
  major: boolean;
  label: string;
}

export interface TickSet {
  minorPs: number;
  majorPs: number;
  ticks: Tick[];
  /** A major pinned to x=0 because the real one is off-screen left. Null when the leftmost
   *  major is visible. [SOURCE] */
  pinned: Tick | null;
}

/**
 * @param startPs  time at the left edge of the plot
 * @param endPs    time at the right edge
 * @param widthCss plot width in CSS px
 * @param samplerateHz capture sampling rate; enables sample-aligned high-zoom ticks
 */
export function computeTicks(
  startPs: number,
  endPs: number,
  widthCss: number,
  samplerateHz?: number,
): TickSet {
  if (!(endPs > startPs) || !(widthCss > 0)) {
    return { minorPs: 1, majorPs: 10, ticks: [], pinned: null };
  }
  const spanPs = endPs - startPs;
  const pxPerPs = widthCss / spanPs;

  const samplePeriodPs = samplerateHz !== undefined && samplerateHz > 0
    ? 1e12 / samplerateHz : Infinity;
  const samplesVisible = spanPs / samplePeriodPs;
  if (Number.isFinite(samplePeriodPs) && (
    samplePeriodPs * pxPerPs >= AXIS.minTickSpacing ||
    samplesVisible <= MIN_SAMPLES_ON_SCREEN * (1 + 1e-9)
  )) {
    return computeSampleTicks(startPs, endPs, pxPerPs, samplePeriodPs);
  }

  // Smallest power of ten at least AXIS.minTickSpacing px wide. 1 ps is the floor: below
  // that there is nothing meaningful left to label.
  let k = Math.ceil(Math.log10(AXIS.minTickSpacing / pxPerPs));
  if (!Number.isFinite(k)) k = 0;
  if (k < 0) k = 0;
  const minorPs = Math.pow(10, k);
  const majorPs = minorPs * 10;

  const ticks: Tick[] = [];
  const first = Math.ceil(startPs / minorPs) * minorPs;
  // A guard, not a policy: at 45 px minimum spacing a 4000 px window holds under 100
  // ticks, so anything near this bound means the arithmetic went wrong upstream.
  const maxTicks = 4096;
  let n = 0;
  for (let t = first; t < endPs && n < maxTicks; t += minorPs, n++) {
    const isMajor = Math.abs(t % majorPs) < minorPs / 2 || Math.abs(Math.abs(t % majorPs) - majorPs) < minorPs / 2;
    const x = (t - startPs) * pxPerPs;
    ticks.push({
      ps: t,
      x,
      major: isMajor,
      // Relative minor labels work well to the right of t=0, but their modulo
      // remainder turns a negative pre-trigger time (e.g. -20 ms) into +80 ms.
      // Keep the sign visible on the left side of the trigger origin.
      label: isMajor ? majorLabel(t, minorPs) : t < 0
        ? majorLabel(t, minorPs)
        : minorLabel(t - Math.floor(t / majorPs) * majorPs, minorPs),
    });
  }

  // [SOURCE] pin a major at x=0 when the nearest one is off-screen left, so you always
  // know where you are.
  let pinned: Tick | null = null;
  const firstMajorVisible = ticks.find((t) => t.major);
  if (!firstMajorVisible || firstMajorVisible.x > 1) {
    const prevMajor = Math.floor(startPs / majorPs) * majorPs;
    pinned = { ps: prevMajor, x: 0, major: true, label: majorLabel(prevMajor, minorPs) };
  }
  return { minorPs, majorPs, ticks, pinned };
}

/** Sampling-period ticks, calculated from sample indices rather than repeated addition. */
function computeSampleTicks(
  startPs: number,
  endPs: number,
  pxPerPs: number,
  periodPs: number,
): TickSet {
  const majorPs = periodPs * 10;
  const ticks: Tick[] = [];
  // The tolerance only prevents an exact sample boundary represented one ulp high from
  // being skipped. It is far too small to admit the preceding sample.
  const firstSample = Math.ceil(startPs / periodPs - 1e-10);
  const lastSample = Math.ceil(endPs / periodPs - 1e-10);
  const maxTicks = 4096;
  for (let sample = firstSample; sample < lastSample && ticks.length < maxTicks; sample++) {
    const exactPs = sample * periodPs;
    const labelPs = Math.round(exactPs);
    const major = ((sample % 10) + 10) % 10 === 0;
    const withinMajor = ((sample % 10) + 10) % 10;
    ticks.push({
      ps: exactPs,
      x: (exactPs - startPs) * pxPerPs,
      major,
      label: major
        ? majorLabel(labelPs, Math.round(periodPs))
        : exactPs < 0
          ? majorLabel(labelPs, Math.round(periodPs))
          : minorLabel(Math.round(withinMajor * periodPs), Math.round(periodPs)),
    });
  }

  let pinned: Tick | null = null;
  const firstMajorVisible = ticks.find((tick) => tick.major);
  if (!firstMajorVisible || firstMajorVisible.x > 1) {
    const sample = Math.floor(startPs / majorPs) * 10;
    const exactPs = sample * periodPs;
    pinned = {
      ps: exactPs,
      x: 0,
      major: true,
      label: majorLabel(Math.round(exactPs), Math.round(periodPs)),
    };
  }
  return { minorPs: periodPs, majorPs, ticks, pinned };
}

/**
 * Paint the axis strip. `ctx` is already scaled so 1 unit is 1 CSS px; the caller owns
 * the canvas sizing.
 */
export function drawAxis(
  ctx: CanvasRenderingContext2D,
  set: TickSet,
  widthCss: number,
  heightCss: number,
): void {
  ctx.clearRect(0, 0, widthCss, heightCss);
  ctx.fillStyle = COLORS.bg10;
  ctx.fillRect(0, 0, widthCss, heightCss);

  ctx.font = AXIS.tickFont;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const majorTop = heightCss * AXIS.majorTickFraction;
  const minorTop = heightCss - AXIS.minorTickLength;

  for (const t of set.ticks) {
    const x = Math.round(t.x) + 0.5;
    ctx.strokeStyle = t.major ? GRID.majorColor : GRID.minorColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, t.major ? majorTop : minorTop);
    ctx.lineTo(x, heightCss);
    ctx.stroke();

    ctx.fillStyle = t.major ? COLORS.text : COLORS.text50;
    ctx.fillText(t.label, Math.round(t.x) + 1, t.major ? AXIS.majorBaseline : AXIS.minorBaseline);
  }

  if (set.pinned) {
    // [SOURCE] 4x6 px left-pointing arrow instead of a line.
    const { w, h } = AXIS.pinnedArrow;
    ctx.fillStyle = COLORS.text;
    ctx.beginPath();
    ctx.moveTo(0, majorTop + h / 2);
    ctx.lineTo(w, majorTop);
    ctx.lineTo(w, majorTop + h);
    ctx.closePath();
    ctx.fill();
    ctx.fillText(set.pinned.label, w + 2, AXIS.majorBaseline);
  }
}
