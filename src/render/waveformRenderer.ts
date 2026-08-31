/**
 * WebGL2 digital waveform canvas.
 *
 * Contract (docs/ARCHITECTURE.md): consumes `SampleStore.query` and nothing else, owns
 * the canvas and the samples<->pixels transform, exposes setViewport() and render().
 *
 * Shape of one frame:
 *
 *   plan     - turn the float viewport into an integer query range plus an affine map
 *   query    - one `store.query()` per visible channel, each O(columns)
 *   upload   - one texSubImage2D of a `columns x rows` R8UI atlas
 *   draw     - one instanced draw call, `rows` instances of a 2-triangle quad
 *
 * There is no per-sample work and no per-edge work anywhere in that list, which is the
 * single decision that makes a 100M-sample capture cost the same as a 100k one
 * Columns are classified once and drawn from that classification.
 *
 * A renderer could additionally re-blit stale pixel data through an affine transform while it
 * waits for the backend [SOURCE, the spec below]. We deliberately do not: our query is
 * synchronous and in-process, and the measured cost of a full 16-channel refresh is well
 * under one frame (see NOTES.md), so there is never stale data to re-blit. The affine
 * map is still here - it is what handles fractional zoom and the live edge - so if a
 * future store goes async the stale-blit path is a two-line change.
 */

import type { SampleStore } from '../data/types.js';
import { fillAtlas, planColumns, type ColumnPlan } from './columns.js';
import { computeLayout, type LayoutMetrics } from './layout.js';
import { FRAGMENT_SRC, MAX_ROWS, VERTEX_SRC } from './shaders.js';
import {
  DARK_THEME,
  DEFAULT_GUTTER_CSS_PX,
  DEFAULT_LINE_WIDTH_CSS_PX,
  DEFAULT_ROW_HEIGHT_CSS_PX,
  parseHexColor,
  type Theme,
} from './theme.js';
import { ViewTransform } from './transform.js';

export interface WaveformRendererOptions {
  canvas: HTMLCanvasElement;
  store: SampleStore;
  /** Visible channels, in row order. Defaults to 0..channelCount-1. Max 16 rows. */
  channels?: readonly number[];
  theme?: Theme;
  rowHeightCssPx?: number;
  /**
   * Per-row pitch in CSS px, index-aligned with `channels`. A row grows to fit
   * analyzer chips, so rows are not uniform even within one capture - see layout.ts.
   */
  rowHeightsCssPx?: readonly number[];
  gutterCssPx?: number;
  lineWidthCssPx?: number;
  /**
   * Width of a transition bar, in DEVICE pixels. Default 1: a
   * backend classifies device-pixel columns and a lone transition becomes a one-device-px
   * bar, so on a 2x display the vertical edge is half the weight of the horizontal idle
   * line. That asymmetry is inherited, not chosen; set 2 to make them match instead.
   */
  edgeWidthDevicePx?: number;
  /** Overrides window.devicePixelRatio. Tests pin it so readback is deterministic. */
  devicePixelRatio?: number;
  /**
   * Keep the drawing buffer readable after the compositor has taken it. Costs a copy
   * per frame on some drivers, so it is off by default and the self test turns it on.
   */
  preserveDrawingBuffer?: boolean;
}

export interface FrameStats {
  /** Wall clock inside render(), excluding anything the GPU does after the draw call. */
  totalMs: number;
  queryMs: number;
  uploadMs: number;
  drawMs: number;
  /** Columns actually backed by data. */
  dataBins: number;
  /** Waveform width in device px. */
  widthPx: number;
  samplesPerPixel: number;
  rows: number;
}

const UNIFORM_NAMES = [
  'u_canvas', 'u_map', 'u_dataBins', 'u_cols', 'u_lineW', 'u_edgeW',
  'u_bg', 'u_noData', 'u_noDataWash', 'u_noDataBorderA', 'u_noDataBorderH',
  'u_sepColor', 'u_sepH',
  'u_rowTop[0]', 'u_rowH[0]', 'u_band[0]', 'u_yHi[0]', 'u_yLo[0]', 'u_color[0]',
] as const;
type UniformName = (typeof UNIFORM_NAMES)[number];

export class WaveformRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly store: SampleStore;
  readonly gl: WebGL2RenderingContext;

  private theme: Theme;
  private rowHeightCssPx: number;
  private rowHeightsCssPx: number[] | undefined;
  private gutterCssPx: number;
  private lineWidthCssPx: number;
  private edgeWidthDevicePx: number;
  private dpr: number;

  private channels: number[];
  private layout: LayoutMetrics;
  private layoutDirty = true;

  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly tex: WebGLTexture;
  private readonly uniforms: Record<UniformName, WebGLUniformLocation | null>;

  private atlas = new Uint8Array(0);
  private atlasWidth = 0;
  private texWidth = 0;
  private texHeight = 0;

  // Hoisted so a 60 fps loop allocates nothing per frame.
  private readonly uTop = new Float32Array(MAX_ROWS);
  private readonly uHgt = new Float32Array(MAX_ROWS);
  private readonly uBand = new Float32Array(MAX_ROWS);
  private readonly uYhi = new Float32Array(MAX_ROWS);
  private readonly uYlo = new Float32Array(MAX_ROWS);
  private readonly uCol = new Float32Array(MAX_ROWS * 3);
  private bgRgb: [number, number, number] = [0, 0, 0];
  private sepRgb: [number, number, number] = [0, 0, 0];
  private noDataRgb: [number, number, number] = [0, 0, 0];

  private widthPx = 0;
  private heightPx = 0;

  private readonly view: ViewTransform;
  private follow = false;
  private contextLost = false;
  private rafHandle = 0;

  /** Stats for the most recent render(). */
  lastFrame: FrameStats = {
    totalMs: 0, queryMs: 0, uploadMs: 0, drawMs: 0,
    dataBins: 0, widthPx: 0, samplesPerPixel: 0, rows: 0,
  };

  constructor(opts: WaveformRendererOptions) {
    this.canvas = opts.canvas;
    this.store = opts.store;
    this.theme = opts.theme ?? DARK_THEME;
    this.rowHeightCssPx = opts.rowHeightCssPx ?? DEFAULT_ROW_HEIGHT_CSS_PX;
    this.rowHeightsCssPx = opts.rowHeightsCssPx ? [...opts.rowHeightsCssPx] : undefined;
    this.gutterCssPx = opts.gutterCssPx ?? DEFAULT_GUTTER_CSS_PX;
    this.lineWidthCssPx = opts.lineWidthCssPx ?? DEFAULT_LINE_WIDTH_CSS_PX;
    this.edgeWidthDevicePx = opts.edgeWidthDevicePx ?? 1;
    this.dpr = opts.devicePixelRatio ?? (globalThis.devicePixelRatio || 1);

    const all: number[] = [];
    for (let i = 0; i < this.store.channelCount; i++) all.push(i);
    this.channels = [...(opts.channels ?? all)];
    this.assertChannels();

    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false, // every primitive is axis-aligned; MSAA would only blur it
      depth: false,
      stencil: false,
      desynchronized: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    if (!gl) throw new Error('WebGL2 is not available on this context');
    this.gl = gl;

    this.canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
    this.uniforms = {} as Record<UniformName, WebGLUniformLocation | null>;
    for (const n of UNIFORM_NAMES) this.uniforms[n] = gl.getUniformLocation(this.program, n);
    for (const n of UNIFORM_NAMES) {
      if (this.uniforms[n] === null) throw new Error(`uniform ${n} was optimised out or is misspelled`);
    }

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;

    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed');
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.layout = computeLayout(this.layoutOptions());
    this.syncCanvasSize();

    const len = Math.max(this.store.length, 1);
    this.view = new ViewTransform(Math.max(this.widthPx, 1), 0, len);
  }

  // ------------------------------------------------------------------ config

  private layoutOptions() {
    return {
      rowCount: this.channels.length,
      rowHeightCssPx: this.rowHeightCssPx,
      ...(this.rowHeightsCssPx ? { rowHeightsCssPx: this.rowHeightsCssPx } : {}),
      gutterCssPx: this.gutterCssPx,
      lineWidthCssPx: this.lineWidthCssPx,
      edgeWidthDevicePx: this.edgeWidthDevicePx,
      noDataBorderCssPx: this.theme.noDataBorderCssPx,
      rowSeparatorCssPx: this.theme.rowSeparatorCssPx,
      dpr: this.dpr,
    };
  }

  private assertChannels(): void {
    if (this.channels.length === 0) throw new Error('at least one channel must be visible');
    if (this.channels.length > MAX_ROWS) {
      throw new Error(`at most ${MAX_ROWS} rows are supported, got ${this.channels.length}`);
    }
    for (const c of this.channels) {
      if (!Number.isInteger(c) || c < 0 || c >= this.store.channelCount) {
        throw new Error(`channel ${c} is out of range 0..${this.store.channelCount - 1}`);
      }
    }
  }

  setChannels(channels: readonly number[]): void {
    this.channels = [...channels];
    this.assertChannels();
    this.layoutDirty = true;
  }

  getChannels(): readonly number[] {
    return this.channels;
  }

  /**
   * Per-row pitch in CSS px, index-aligned with the visible channels. Pass undefined to
   * go back to a uniform pitch. The UI owns this, reading it from the capture's
   * meta.json, where a row carrying analyzer chips is taller than its neighbours.
   */
  setRowHeights(heights: readonly number[] | undefined): void {
    this.rowHeightsCssPx = heights ? [...heights] : undefined;
    this.layoutDirty = true;
  }

  setRowMetrics(m: {
    rowHeightCssPx?: number;
    gutterCssPx?: number;
    lineWidthCssPx?: number;
    edgeWidthDevicePx?: number;
  }): void {
    if (m.rowHeightCssPx !== undefined) this.rowHeightCssPx = m.rowHeightCssPx;
    if (m.gutterCssPx !== undefined) this.gutterCssPx = m.gutterCssPx;
    if (m.lineWidthCssPx !== undefined) this.lineWidthCssPx = m.lineWidthCssPx;
    if (m.edgeWidthDevicePx !== undefined) this.edgeWidthDevicePx = m.edgeWidthDevicePx;
    this.layoutDirty = true;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.layoutDirty = true;
  }

  /** Device pixels per CSS pixel currently in use. */
  get devicePixelRatio(): number {
    return this.dpr;
  }

  setDevicePixelRatio(dpr: number): void {
    if (!(dpr > 0)) throw new Error(`dpr must be positive, got ${dpr}`);
    this.dpr = dpr;
    this.layoutDirty = true;
    this.syncCanvasSize();
  }

  // ------------------------------------------------------------------ sizing

  /**
   * Make the drawing buffer match the element's CSS size times dpr. Call on resize; it
   * is cheap and idempotent, so calling it every frame is also fine.
   */
  syncCanvasSize(): boolean {
    const cssW = this.canvas.clientWidth || this.canvas.width || 1;
    const cssH = this.canvas.clientHeight || this.canvas.height || 1;
    return this.resize(cssW, cssH);
  }

  /** Explicit sizing, for offscreen and test use where there is no layout. */
  resize(cssWidth: number, cssHeight: number): boolean {
    const w = Math.max(1, Math.round(cssWidth * this.dpr));
    const h = Math.max(1, Math.round(cssHeight * this.dpr));
    if (w === this.widthPx && h === this.heightPx) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.widthPx = w;
    this.heightPx = h;
    // Zoomed all the way in, one sample is many pixels wide, so the integer sample range
    // covering the view can spill past the screen width by up to one sample on each side.
    // The atlas is sized for that worst case so the plan never has to lose resolution.
    this.atlasWidth = w + 2 * Math.ceil(w / 8) + 8;
    this.atlas = new Uint8Array(this.atlasWidth * MAX_ROWS);
    this.allocTexture();
    if (this.view) this.view.widthPx = w;
    return true;
  }

  private allocTexture(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R8UI, this.atlasWidth, MAX_ROWS, 0,
      gl.RED_INTEGER, gl.UNSIGNED_BYTE, null,
    );
    this.texWidth = this.atlasWidth;
    this.texHeight = MAX_ROWS;
  }

  get widthDevicePx(): number {
    return this.widthPx;
  }

  get heightDevicePx(): number {
    return this.heightPx;
  }

  // ------------------------------------------------------------------ viewport

  get transform(): ViewTransform {
    return this.view;
  }

  get viewport(): { start: number; end: number } {
    return { start: this.view.start, end: this.view.end };
  }

  /**
   * Set the visible sample range. Fractional bounds are supported and are honoured
   * exactly - the column grid is defined by this range, not by whatever integers the
   * store happened to be asked for.
   *
   * [CHOSEN] Follow-the-live-edge is cancelled on any pan or zoom
   * (`cancelFollowMode('latest')`). So does this.
   */
  setViewport(startSample: number, endSample: number): void {
    this.view.set(startSample, endSample);
    this.view.clampTo(this.store.length);
    this.follow = false;
  }

  /** Whole capture. */
  zoomToFit(): void {
    const len = Math.max(this.store.length, 1);
    this.view.set(0, len);
    this.view.clampTo(this.store.length);
    this.follow = false;
  }

  panPixels(dx: number): void {
    this.view.panPixels(dx);
    this.view.clampTo(this.store.length);
    this.follow = false;
  }

  zoomAt(pixelX: number, spanFactor: number): void {
    this.view.zoomAt(pixelX, spanFactor);
    this.view.clampTo(this.store.length);
    this.follow = false;
  }

  /**
   * Live mode. While on, every render() re-pins the view to the newest samples keeping
   * the current span. [SOURCE] `RenderingManager.followViewMode === LatestData`.
   */
  setFollowLatest(on: boolean): void {
    this.follow = on;
  }

  get followLatest(): boolean {
    return this.follow;
  }

  // ------------------------------------------------------------------ drawing

  /** Coalesce many requests into one frame. Returns the rAF handle. */
  requestRender(): void {
    if (this.rafHandle !== 0) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.render();
    });
  }

  render(): FrameStats {
    if (this.contextLost) throw new Error('WebGL context was lost; the renderer is dead');
    const gl = this.gl;
    const t0 = performance.now();

    // One snapshot of length per frame. During a live capture it grows underneath us and
    // half the channels would otherwise be drawn against a different capture length.
    const length = this.store.length;

    if (this.follow && length > 0) {
      // The user's chosen time span is sacred in live mode: a capture that is 3 ms old
      // must not drag a 1 s window down to 3 ms. minVisibleFraction 0 turns off the
      // zoom-out clamp and leaves only "pin the right edge to the newest sample".
      const span = this.view.span;
      this.view.set(Math.max(0, length - span), Math.max(0, length - span) + span);
      this.view.clampTo(length, { minVisibleFraction: 0 });
    }

    if (this.layoutDirty) this.rebuildLayout();

    const rows = this.channels.length;
    const plan: ColumnPlan = planColumns(
      this.view.start, this.view.end, this.widthPx, length, this.atlasWidth,
    );

    const t1 = performance.now();
    if (plan.hasData) fillAtlas(this.store, this.channels, plan, this.atlas, this.atlasWidth);
    const t2 = performance.now();

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.texWidth !== this.atlasWidth || this.texHeight !== MAX_ROWS) this.allocTexture();
    if (plan.hasData) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.atlasWidth);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, plan.dataBins, rows,
        gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.atlas,
      );
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    }
    const t3 = performance.now();

    gl.viewport(0, 0, this.widthPx, this.heightPx);
    const bg = this.bgRgb;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

    const u = this.uniforms;
    gl.uniform1i(u['u_cols'], 0);
    gl.uniform2f(u['u_canvas'], this.widthPx, this.heightPx);
    gl.uniform2f(u['u_map'], plan.scale, plan.offset);
    gl.uniform1i(u['u_dataBins'], plan.hasData ? plan.dataBins : 0);
    gl.uniform1f(u['u_lineW'], this.layout.lineWidth);
    gl.uniform1f(u['u_edgeW'], this.layout.edgeWidth);
    gl.uniform3fv(u['u_bg'], bg);
    gl.uniform3fv(u['u_noData'], this.noDataRgb);
    gl.uniform1f(u['u_noDataWash'], this.theme.noDataWashAlpha);
    gl.uniform1f(u['u_noDataBorderA'], this.theme.noDataBorderAlpha);
    gl.uniform1f(u['u_noDataBorderH'], this.layout.noDataBorder);
    gl.uniform3fv(u['u_sepColor'], this.sepRgb);
    gl.uniform1f(u['u_sepH'], this.layout.separator);
    gl.uniform1fv(u['u_rowTop[0]'], this.uTop);
    gl.uniform1fv(u['u_rowH[0]'], this.uHgt);
    gl.uniform1fv(u['u_band[0]'], this.uBand);
    gl.uniform1fv(u['u_yHi[0]'], this.uYhi);
    gl.uniform1fv(u['u_yLo[0]'], this.uYlo);
    gl.uniform3fv(u['u_color[0]'], this.uCol);

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rows);
    gl.bindVertexArray(null);
    const t4 = performance.now();

    this.lastFrame = {
      totalMs: t4 - t0,
      queryMs: t2 - t1,
      uploadMs: t3 - t2,
      drawMs: t4 - t3,
      dataBins: plan.hasData ? plan.dataBins : 0,
      widthPx: this.widthPx,
      samplesPerPixel: this.view.samplesPerPixel,
      rows,
    };
    return this.lastFrame;
  }

  /**
   * The data half of a frame - plan the columns and fill the atlas - with no GL calls.
   *
   * Exists so the bench can subtract it from a full render() and attribute frame cost
   * between the store and this module. Brave clamps performance.now() to 100 us, which
   * is the same order as the entire GL half of a frame, so this split cannot be measured
   * per frame and has to be measured as a batch difference.
   */
  queryOnly(): number {
    const plan = planColumns(this.view.start, this.view.end, this.widthPx, this.store.length, this.atlasWidth);
    if (plan.hasData) fillAtlas(this.store, this.channels, plan, this.atlas, this.atlasWidth);
    return plan.dataBins;
  }

  /** RGBA of the whole drawing buffer, top-down. For tests and for a critic's pixel diff. */
  readPixels(): { width: number; height: number; data: Uint8Array } {
    const gl = this.gl;
    const w = this.widthPx;
    const h = this.heightPx;
    const flipped = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      data.set(flipped.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    }
    return { width: w, height: h, data };
  }

  /** The row geometry the last frame used. The UI needs it to line labels up. */
  get rowGeometry(): LayoutMetrics {
    if (this.layoutDirty) this.rebuildLayout();
    return this.layout;
  }

  private rebuildLayout(): void {
    this.layout = computeLayout(this.layoutOptions());
    this.layoutDirty = false;
    this.bgRgb = parseHexColor(this.theme.background);
    this.noDataRgb = parseHexColor(this.theme.noDataColor);
    this.sepRgb = parseHexColor(this.theme.rowSeparatorColor);
    const palette = this.theme.channelColors;
    if (palette.length === 0) throw new Error('theme.channelColors is empty');
    this.uTop.fill(0);
    this.uHgt.fill(0);
    this.uBand.fill(0);
    this.uYhi.fill(0);
    this.uYlo.fill(0);
    this.uCol.fill(0);
    for (let r = 0; r < this.channels.length; r++) {
      const g = this.layout.rows[r]!;
      this.uTop[r] = g.top;
      this.uHgt[r] = g.height;
      this.uBand[r] = g.bandHeight;
      this.uYhi[r] = g.yHiTop;
      this.uYlo[r] = g.yLoTop;
      const c = parseHexColor(palette[this.channels[r]! % palette.length]!);
      this.uCol[r * 3] = c[0];
      this.uCol[r * 3 + 1] = c[1];
      this.uCol[r * 3 + 2] = c[2];
    }
  }

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  dispose(): void {
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed:\n${log}`);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram();
  if (!p) throw new Error('createProgram failed');
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed:\n${log}`);
  }
  return p;
}
