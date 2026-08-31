/**
 * The time axis: which ticks, where, and what they are called.
 *
 * [CHOSEN] . Minor spacing is the smallest power of ten that keeps ticks
 * at least `minimumHorizontalTickSpacingPx = 45` apart; major spacing is exactly 10x the
 * minor. Major ticks draw a line from half the axis height downward, minor ticks a short
 * line in the bottom 3 px, and when the nearest major is off-screen to the left a major is
 * pinned at x=0 and marked with a 4x6 px left-pointing arrow.
 *
 * [MEASURED] on 01-idle-empty-session.png: minor ticks 46.3 CSS px apart, majors at
 * 0/10/20/30 ms with 1 ms minors, minor tick marks in the bottom 3.5 CSS px, major tick
 * lines starting halfway down. The screenshot and the source agree, so both are used.
 *
 * Tick positions are integer multiples of a power of ten held in **picoseconds**, never in
 * floating-point seconds. That is what makes the labels exact - see format.ts.
 */

import { AXIS, COLORS, GRID } from './metrics.js';
import { majorLabel, minorLabel } from './format.js';

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
 */
export function computeTicks(startPs: number, endPs: number, widthCss: number): TickSet {
  if (!(endPs > startPs) || !(widthCss > 0)) {
    return { minorPs: 1, majorPs: 10, ticks: [], pinned: null };
  }
  const spanPs = endPs - startPs;
  const pxPerPs = widthCss / spanPs;

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
      label: isMajor ? majorLabel(t, minorPs) : minorLabel(t - Math.floor(t / majorPs) * majorPs, minorPs),
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
