/**
 * The channel stack: N WaveformRenderers on N canvases, driven from one viewport.
 *
 * Why more than one. `src/render`'s `MAX_ROWS` is 16 - a shader uniform array size, not
 * something the UI can raise - and a 16-channel capture with one analyzer attached needs
 * 17 rows, because an annotation lane is its own row (NOTES.md section 2). So rows are
 * chunked into groups of at most 16 and each group gets its own canvas, stacked
 * vertically with no gap.
 *
 * Two things make the seam between two canvases exact rather than approximate:
 *
 *   - every row height is a whole number of CSS px, and each canvas's CSS height is the
 *     exact sum of its rows' heights. `computeLayout` rounds the *cumulative* edge, so
 *     with integral heights and an integral group offset, `round((edge - offset) * dpr) +
 *     round(offset * dpr) === round(edge * dpr)` and the boundary lands on the same
 *     device pixel it would have in one tall canvas.
 *   - the viewport is applied to renderer 0 first, read back after its own clamp, and
 *     then pushed to the rest, so no canvas can be a frame ahead of another.
 *
 * A live capture never splits: annotations are cleared when a capture starts, so there
 * are no lanes and the row count is the channel count, at most 16. That matters because
 * in follow-the-live-edge mode each renderer snapshots `store.length` for itself, and two
 * canvases snapshotting a frame apart would put a horizontal step across the screen at
 * the live edge.
 */

import { ViewTransform, WaveformRenderer } from '../render/index.js';
import type { SampleStore } from '../data/types.js';
import { ROWS } from './metrics.js';

export interface RowSpec {
  kind: 'channel' | 'lane';
  /** Capture channel index. A lane draws the same channel and is then painted over. */
  channel: number;
  /** Whole CSS px. Non-integral heights would break the cross-canvas seam. */
  heightCss: number;
  /** For a lane, the index of the analyzer whose annotations go in it. */
  analyzer?: number;
}

/** Row geometry the overlay needs, in CSS px from the top of the stack. */
export interface RowBox {
  spec: RowSpec;
  top: number;
  height: number;
  /** Trace band, i.e. height minus the row separator. */
  band: number;
}

const MAX_ROWS_PER_CANVAS = 16;

export class WaveformStack {
  readonly view: ViewTransform;
  private renderers: WaveformRenderer[] = [];
  private canvases: HTMLCanvasElement[] = [];
  private rows: RowSpec[] = [];
  private groups: RowSpec[][] = [];
  private dpr: number;

  constructor(
    private readonly container: HTMLElement,
    private readonly store: SampleStore,
  ) {
    this.dpr = globalThis.devicePixelRatio || 1;
    this.view = new ViewTransform(1, 0, Math.max(1, store.length));
  }

  get rowSpecs(): readonly RowSpec[] {
    return this.rows;
  }

  /** Total CSS height of every row. */
  get totalHeightCss(): number {
    let h = 0;
    for (const r of this.rows) h += r.heightCss;
    return h;
  }

  /** Row boxes in CSS px from the top of the container, for the overlay. */
  boxes(): RowBox[] {
    const out: RowBox[] = [];
    let top = 0;
    for (const spec of this.rows) {
      out.push({ spec, top, height: spec.heightCss, band: spec.heightCss - ROWS.separator });
      top += spec.heightCss;
    }
    return out;
  }

  /** Waveform width in device px. 0 before the first layout. */
  get widthDevicePx(): number {
    return this.renderers[0]?.widthDevicePx ?? 0;
  }

  setRows(rows: readonly RowSpec[]): void {
    for (const r of rows) {
      if (!Number.isInteger(r.heightCss) || r.heightCss <= 0) {
        throw new Error(`row height must be a positive integer CSS px, got ${r.heightCss}`);
      }
      if (r.channel < 0 || r.channel >= this.store.channelCount) {
        throw new Error(`row channel ${r.channel} outside 0..${this.store.channelCount - 1}`);
      }
    }
    this.rows = [...rows];
    this.groups = [];
    for (let i = 0; i < this.rows.length; i += MAX_ROWS_PER_CANVAS) {
      this.groups.push(this.rows.slice(i, i + MAX_ROWS_PER_CANVAS));
    }
    this.syncCanvases();
  }

  private syncCanvases(): void {
    while (this.renderers.length < this.groups.length) {
      const canvas = document.createElement('canvas');
      canvas.className = 'wave-canvas';
      this.container.appendChild(canvas);
      this.canvases.push(canvas);
      this.renderers.push(new WaveformRenderer({
        canvas,
        store: this.store,
        channels: [0],
        rowHeightCssPx: ROWS.baseRowHeight,
        gutterCssPx: ROWS.gutter,
        lineWidthCssPx: ROWS.lineWidth,
        // [MEASURED, src/render/NOTES.md] Transition bars are exactly 1 device
        // px against 2-device-px idle lines. The asymmetry is inherited, not chosen.
        edgeWidthDevicePx: 1,
      }));
    }
    for (let i = 0; i < this.renderers.length; i++) {
      const group = this.groups[i];
      const canvas = this.canvases[i]!;
      const r = this.renderers[i]!;
      if (!group || group.length === 0) {
        canvas.style.display = 'none';
        continue;
      }
      canvas.style.display = 'block';
      let h = 0;
      for (const row of group) h += row.heightCss;
      canvas.style.height = `${h}px`;
      r.setChannels(group.map((g) => g.channel));
      r.setRowHeights(group.map((g) => g.heightCss));
    }
  }

  /** Match the drawing buffers to the elements. Idempotent and cheap; called per frame. */
  syncSize(): void {
    const dpr = globalThis.devicePixelRatio || 1;
    for (let i = 0; i < this.renderers.length; i++) {
      if (!this.groups[i]?.length) continue;
      const r = this.renderers[i]!;
      if (dpr !== this.dpr) r.setDevicePixelRatio(dpr);
      r.syncCanvasSize();
    }
    this.dpr = dpr;
    const w = this.widthDevicePx;
    if (w > 0) this.view.widthPx = w;
  }

  setViewport(start: number, end: number): void {
    if (!(end > start)) return;
    this.view.set(start, end);
    this.pushViewport();
  }

  /** Apply the master view to every renderer, then adopt renderer 0's clamped answer so
   *  the axis and the overlay use the same numbers the pixels used. */
  private pushViewport(): void {
    const active = this.activeRenderers();
    if (active.length === 0) return;
    for (const r of active) r.setViewport(this.view.start, this.view.end);
    const v = active[0]!.viewport;
    this.view.set(v.start, v.end);
  }

  private activeRenderers(): WaveformRenderer[] {
    const out: WaveformRenderer[] = [];
    for (let i = 0; i < this.renderers.length; i++) {
      if (this.groups[i]?.length) out.push(this.renderers[i]!);
    }
    return out;
  }

  panPixels(dx: number): void {
    this.view.panPixels(dx);
    this.pushViewport();
  }

  zoomAt(pixelX: number, spanFactor: number): void {
    this.view.zoomAt(pixelX, spanFactor);
    this.pushViewport();
  }

  zoomToFit(): void {
    const len = Math.max(1, this.store.length);
    this.view.set(0, len);
    this.pushViewport();
  }

  setFollowLatest(on: boolean): void {
    for (const r of this.activeRenderers()) r.setFollowLatest(on);
  }

  get followLatest(): boolean {
    return this.activeRenderers()[0]?.followLatest ?? false;
  }

  render(): void {
    const active = this.activeRenderers();
    if (active.length === 0) return;
    for (const r of active) r.render();
    // In follow mode the renderers moved the view themselves; adopt it.
    const v = active[0]!.viewport;
    this.view.set(v.start, v.end);
  }

  dispose(): void {
    for (const r of this.renderers) r.dispose();
    for (const c of this.canvases) c.remove();
    this.renderers = [];
    this.canvases = [];
  }
}
