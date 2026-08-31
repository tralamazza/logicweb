/**
 * Everything drawn on top of (and, optically, underneath) the waveform canvases.
 *
 * Two canvases, not one, and the reason is a measured z-order rather than a preference.
 *
 * The waveform canvas is opaque - `src/render` creates its context with `alpha: false` and
 * clears to the background - so gridlines cannot be painted underneath it. Painting them
 * on top at full opacity would let a gridline cut a notch through a trace, which a
 * does not do: [MEASURED] where a gridline crosses a row separator the separator's
 * `#57575F` survives, and where it crosses background the gridline's `#39393D` survives.
 * That is a per-channel maximum, so the grid canvas carries `mix-blend-mode: lighten` and
 * the compositor reproduces the observed order exactly instead of approximating it.
 *
 * The second canvas is normal compositing and carries the annotation lanes, the cursors,
 * the hover measurement and the live-edge marker - all of which really are on top.
 */

import type { Bubble } from './annotationLayout.js';
import { BUBBLE, COLORS, GRID, ROWS } from './metrics.js';
import type { TickSet } from './timeAxis.js';

export interface HoverMeasurement {
  /** CSS px inside the plot area. */
  pointerX: number;
  rowTop: number;
  rowBand: number;
  color: string;
  /** Pulse under the pointer, CSS px. Null when the channel never toggles in range. */
  widthX0: number | null;
  widthX1: number | null;
  /** To the next same-edge transition, CSS px. */
  periodX0: number | null;
  periodX1: number | null;
  lines: string[];
}

/** [SOURCE] "Brackets are suppressed when the two points are closer than a minimum pixel
 *  distance, so the readout does not turn into confetti at high zoom-out." */
const MIN_BRACKET_PX = 6;
/** [SOURCE] the readout box is offset 30 px to the side away from the pointer. */
const READOUT_OFFSET = 30;

export class Overlay {
  readonly grid: HTMLCanvasElement;
  readonly top: HTMLCanvasElement;
  private gridCtx: CanvasRenderingContext2D;
  private ctx: CanvasRenderingContext2D;
  private wCss = 0;
  private hCss = 0;
  private dpr = 1;

  constructor(container: HTMLElement) {
    this.grid = document.createElement('canvas');
    this.grid.className = 'grid-canvas';
    this.top = document.createElement('canvas');
    this.top.className = 'overlay-canvas';
    container.appendChild(this.grid);
    container.appendChild(this.top);
    const g = this.grid.getContext('2d');
    const c = this.top.getContext('2d');
    if (!g || !c) throw new Error('2D canvas context is unavailable');
    this.gridCtx = g;
    this.ctx = c;
  }

  /** A context with the bubble font set, for measuring text during layout. */
  get measureCtx(): CanvasRenderingContext2D {
    this.ctx.font = BUBBLE.font;
    return this.ctx;
  }

  syncSize(wCss: number, hCss: number): void {
    const dpr = globalThis.devicePixelRatio || 1;
    if (wCss === this.wCss && hCss === this.hCss && dpr === this.dpr) return;
    this.wCss = wCss;
    this.hCss = hCss;
    this.dpr = dpr;
    for (const [el, ctx] of [[this.grid, this.gridCtx], [this.top, this.ctx]] as const) {
      el.width = Math.max(1, Math.round(wCss * dpr));
      el.height = Math.max(1, Math.round(hCss * dpr));
      el.style.width = `${wCss}px`;
      el.style.height = `${hCss}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  beginFrame(): void {
    this.gridCtx.clearRect(0, 0, this.wCss, this.hCss);
    this.ctx.clearRect(0, 0, this.wCss, this.hCss);
  }

  /**
   * [MEASURED] 1 CSS px wide, dashed 3 on / 3 off, dropped from every minor tick through
   * the whole stack. The gridline at a MAJOR tick is dimmer than at a minor one
   * (`#262629` against `#39393D`) - checked on all four majors of
   * 01-idle-empty-session.png against their neighbouring minors. That is the opposite of
   * what intuition says, and it is what the pixels say.
   */
  drawGrid(ticks: TickSet): void {
    const g = this.gridCtx;
    g.save();
    g.setLineDash([...GRID.dash]);
    g.lineWidth = GRID.width;
    for (const t of ticks.ticks) {
      g.strokeStyle = t.major ? GRID.majorColor : GRID.minorColor;
      const x = Math.round(t.x) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, this.hCss);
      g.stroke();
    }
    g.restore();
  }

  /**
   * Paint the annotation lane opaque before anything goes in it.
   *
   * The lane is a renderer row (NOTES.md section 2), so the renderer has already drawn a
   * trace and a separator in it. Covering the lane completely is what makes the row below
   * a plain base-height row with correct gutters, which is how an annotated
   * row out - lane above, band unchanged.
   */
  fillLane(top: number, height: number): void {
    this.ctx.fillStyle = COLORS.bg10;
    this.ctx.fillRect(0, top, this.wCss, height);
  }

  /**
   * [CHOSEN] The two levels of every channel row are marked with a small "H" and "L"
   * at the left edge of the plot - visible in all five screenshots, including
   * 01-idle-empty-session.png where they are the only thing in an empty row. The glyphs
   * sit at device x 220..226, i.e. 4..7 CSS px into the plot, vertically on the idle-line
   * positions.
   *
   * They come from the same gutter arithmetic `src/render/layout.ts` uses, not from a
   * separate constant, so they cannot drift away from the lines they label.
   */
  drawLevels(boxes: readonly { top: number; band: number; isChannel: boolean }[]): void {
    const c = this.ctx;
    c.save();
    c.font = '8px -apple-system, BlinkMacSystemFont, sans-serif';
    c.fillStyle = COLORS.text50;
    c.textBaseline = 'middle';
    for (const b of boxes) {
      if (!b.isChannel) continue;
      const yHi = b.top + ROWS.gutter + ROWS.lineWidth / 2;
      const yLo = b.top + b.band - ROWS.gutter - ROWS.lineWidth / 2;
      if (yLo - yHi < 10) continue;
      c.fillText('H', 4, yHi);
      c.fillText('L', 4, yLo);
    }
    c.restore();
  }

  drawBubbles(bubbles: readonly Bubble[], laneTop: number, color: string): void {
    const c = this.ctx;
    const y = laneTop + ROWS.lanePadTop;
    const h = ROWS.bubbleHeight;
    c.font = BUBBLE.font;
    c.textBaseline = 'middle';
    for (const b of bubbles) {
      const w = Math.max(1, b.x1 - b.x0);
      c.fillStyle = color;
      roundRect(c, b.x0, y, w, h, BUBBLE.radius);
      c.fill();

      // [SOURCE] a 3 px solid triangle on the overflowing side says the bubble continues.
      if (b.overflowLeft) triangle(c, b.x0, y + h / 2, -BUBBLE.overflowTriangle, color);
      if (b.overflowRight) triangle(c, b.x1, y + h / 2, BUBBLE.overflowTriangle, color);

      let tx = b.x0 + BUBBLE.padX;
      if (b.badge) {
        // [SOURCE] a 9 px, 2 px-padded, 5 px-radius chip in background-30.
        c.font = `${BUBBLE.badgeFontPx}px ${BUBBLE.font.split('px ')[1] ?? 'sans-serif'}`;
        const bw = c.measureText(b.badge).width + 2 * BUBBLE.badgePad;
        const bh = BUBBLE.badgeFontPx + 2 * BUBBLE.badgePad;
        c.fillStyle = COLORS.bg30;
        roundRect(c, tx, y + (h - bh) / 2, bw, bh, BUBBLE.badgeRadius);
        c.fill();
        c.fillStyle = COLORS.text80;
        c.fillText(b.badge, tx + BUBBLE.badgePad, y + h / 2);
        tx += bw + 3;
        c.font = BUBBLE.font;
      }
      if (b.text) {
        c.save();
        c.beginPath();
        c.rect(b.x0, y, w, h);
        c.clip();
        c.fillStyle = COLORS.bg10;
        c.fillText(b.text, tx, y + h / 2 + 0.5);
        c.restore();
      }
    }
  }

  /** A vertical cursor with a chip carrying its label at the top of the stack. */
  drawCursor(x: number, color: string, label: string): void {
    const c = this.ctx;
    if (x < -20 || x > this.wCss + 20) return;
    c.save();
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(Math.round(x) + 0.5, 0);
    c.lineTo(Math.round(x) + 0.5, this.hCss);
    c.stroke();
    c.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    c.textBaseline = 'top';
    const w = c.measureText(label).width + 8;
    c.fillStyle = color;
    roundRect(c, x - w / 2, 0, w, 14, 2);
    c.fill();
    c.fillStyle = COLORS.bg10;
    c.fillText(label, x - w / 2 + 4, 2);
    c.restore();
  }

  /** The live edge during a capture: where the newest sample is. */
  drawLiveEdge(x: number): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = COLORS.negative;
    c.lineWidth = 1;
    c.setLineDash([2, 2]);
    c.beginPath();
    c.moveTo(Math.round(x) + 0.5, 0);
    c.lineTo(Math.round(x) + 0.5, this.hCss);
    c.stroke();
    c.restore();
  }

  /**
   * [CHOSEN] : hovering a digital pulse produces measurements with no
   * clicking at all - a width bracket along the top gutter, a period bracket along the
   * bottom gutter, and a floating readout offset 30 px away from the pointer.
   */
  drawHover(h: HoverMeasurement): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = h.color;
    c.fillStyle = h.color;
    c.lineWidth = 1;

    const topY = h.rowTop + ROWS.gutter / 2;
    const botY = h.rowTop + h.rowBand - ROWS.gutter / 2;
    if (h.widthX0 !== null && h.widthX1 !== null && h.widthX1 - h.widthX0 >= MIN_BRACKET_PX) {
      bracket(c, h.widthX0, h.widthX1, topY);
    }
    if (h.periodX0 !== null && h.periodX1 !== null && h.periodX1 - h.periodX0 >= MIN_BRACKET_PX) {
      bracket(c, h.periodX0, h.periodX1, botY);
    }

    if (h.lines.length) {
      c.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      c.textBaseline = 'top';
      const w = Math.max(...h.lines.map((l) => c.measureText(l).width)) + 12;
      const boxH = h.lines.length * 14 + 8;
      // Away from the pointer, and kept inside the plot.
      let bx = h.pointerX + READOUT_OFFSET;
      if (bx + w > this.wCss) bx = h.pointerX - READOUT_OFFSET - w;
      if (bx < 0) bx = 0;
      let by = h.rowTop + h.rowBand + 2;
      if (by + boxH > this.hCss) by = h.rowTop - boxH - 2;
      if (by < 0) by = 0;
      c.fillStyle = COLORS.bg30;
      roundRect(c, bx, by, w, boxH, 3);
      c.fill();
      c.strokeStyle = COLORS.borderHigh;
      c.stroke();
      c.fillStyle = COLORS.text80;
      h.lines.forEach((l, i) => c.fillText(l, bx + 6, by + 4 + i * 14));
    }
    c.restore();
  }
}

function bracket(c: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  const a = Math.round(x0) + 0.5;
  const b = Math.round(x1) + 0.5;
  c.beginPath();
  c.moveTo(a, y - 3);
  c.lineTo(a, y + 3);
  c.moveTo(a, y);
  c.lineTo(b, y);
  c.moveTo(b, y - 3);
  c.lineTo(b, y + 3);
  c.stroke();
}

function triangle(c: CanvasRenderingContext2D, x: number, y: number, dx: number, color: string): void {
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(x + dx, y);
  c.lineTo(x, y - dx);
  c.lineTo(x, y + dx);
  c.closePath();
  c.fill();
}

function roundRect(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}
