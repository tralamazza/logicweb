// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The samples <-> pixels transform, and the pan/zoom arithmetic that drives it.
 *
 * Kept free of WebGL and of the DOM so it can be unit tested without a canvas, and so the
 * UI layer can reuse the exact same mapping for cursors, ticks and annotations. If the UI
 * computed its own mapping the two would drift by a pixel and every measurement readout
 * would be subtly wrong.
 *
 * All pixel coordinates in this file are DEVICE pixels measured from the left edge of the
 * waveform area. The viewport is held in floating point samples on purpose: at maximum
 * zoom one sample is ~100 px wide, and an integer-only viewport would make a drag jump in
 * 100 px steps.
 */

/** [CHOSEN] Zoom-in clamps at 20 samples across the full width. */
export const MIN_SAMPLES_ON_SCREEN = 20;

export interface ViewportRange {
  /** First visible sample position, may be fractional and may be < 0. */
  readonly start: number;
  /** One past the last visible sample position, may be fractional. */
  readonly end: number;
}

export class ViewTransform {
  /** Width of the waveform area in device pixels. */
  widthPx: number;
  start: number;
  end: number;

  constructor(widthPx: number, start: number, end: number) {
    if (!(widthPx > 0)) throw new Error(`widthPx must be positive, got ${widthPx}`);
    if (!(end > start)) throw new Error(`empty viewport [${start}, ${end})`);
    this.widthPx = widthPx;
    this.start = start;
    this.end = end;
  }

  get span(): number {
    return this.end - this.start;
  }

  /** Samples per device pixel. < 1 means zoomed in past one sample per pixel. */
  get samplesPerPixel(): number {
    return this.span / this.widthPx;
  }

  sampleToPixel(sample: number): number {
    return ((sample - this.start) * this.widthPx) / this.span;
  }

  pixelToSample(px: number): number {
    return this.start + (px * this.span) / this.widthPx;
  }

  set(start: number, end: number): void {
    if (!(end > start)) throw new Error(`empty viewport [${start}, ${end})`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`viewport must be finite, got [${start}, ${end})`);
    }
    this.start = start;
    this.end = end;
  }

  /** Move the view by a pixel delta. Positive dx moves the data left (view moves right). */
  panPixels(dx: number): void {
    const ds = dx * this.samplesPerPixel;
    this.start += ds;
    this.end += ds;
  }

  /**
   * Zoom about a fixed device pixel, so the sample under the pointer stays put.
   * `spanFactor` multiplies the visible span: > 1 zooms out, < 1 zooms in.
   */
  zoomAt(pixelX: number, spanFactor: number): void {
    if (!(spanFactor > 0) || !Number.isFinite(spanFactor)) {
      throw new Error(`spanFactor must be finite and positive, got ${spanFactor}`);
    }
    const anchor = this.pixelToSample(pixelX);
    const f = pixelX / this.widthPx;
    const newSpan = this.span * spanFactor;
    this.start = anchor - f * newSpan;
    this.end = this.start + newSpan;
  }

  /**
   * Keep the view inside something sensible for a capture of `length` samples.
   *
   * - span is clamped below at MIN_SAMPLES_ON_SCREEN [SOURCE].
   * - span is clamped above so that at least `minVisibleFraction` of the screen can be
   *   covered by data. Zooming out PAST the end of the capture is deliberately allowed:
   *   the empty part renders as NO_DATA, which is the honest picture, and it is the
   *   normal state of affairs during a live capture where the window is longer than the
   *   data captured so far.
   * - the view cannot be panned so far right that less than `minVisibleFraction` of the
   *   screen has data, and cannot start before sample 0.
   *
   * `minVisibleFraction: 0` disables both of those and leaves only the zoom-in clamp.
   * That is what follow-the-live-edge uses, because there the user's chosen time span
   * has to survive a capture that is currently 3 ms long.
   *
   * [UNVERIFIED] How far past the end of a capture panning and zooming may go. The
   * zoom-IN clamp is known exactly (20 samples); its zoom-OUT limit is not in the spec.
   */
  clampTo(
    length: number,
    opts: { minSpan?: number; maxSpan?: number; minVisibleFraction?: number } = {},
  ): void {
    const minVisible = opts.minVisibleFraction ?? 0.5;
    const lo = opts.minSpan ?? MIN_SAMPLES_ON_SCREEN;
    const hi = opts.maxSpan ?? (minVisible > 0 ? Math.max(lo, length / minVisible) : Infinity);

    let span = this.span;
    const centre = this.start + 0.5 * span;
    if (span < lo) span = lo;
    if (span > hi) span = Math.max(lo, hi);
    let start = span === this.span ? this.start : centre - 0.5 * span;

    const maxStart = minVisible > 0 ? Math.max(0, length - minVisible * span) : Math.max(0, length - span);
    if (start > maxStart) start = maxStart;
    if (start < 0) start = 0;
    this.start = start;
    this.end = start + span;
  }

  snapshot(): ViewportRange {
    return { start: this.start, end: this.end };
  }
}

export interface WheelZoomOptions {
  /**
   * True for a discrete mouse wheel, false for a trackpad. [CHOSEN] We halve the
   * exponent for a physical wheel so one 120-unit notch is exactly sqrt(2).
   */
  isPhysicalWheel: boolean;
  /** [SOURCE] Shift sets scale = 0.1 for a 10x finer zoom. */
  shift: boolean;
}

/**
 * [CHOSEN] The wheel zoom factor:
 *
 *     zoomFactor = 2 ^ ( (isPhysicalWheel ? 0.5 : 1) * scale * (-deltaY) / 120 )
 *
 * Returned as a SPAN factor, i.e. multiply the visible sample span by it. One physical
 * notch of deltaY = +120 gives sqrt(2) = 1.4142, which zooms out.
 *
 * [UNVERIFIED] The sign convention. the spec states the magnitude ("one physical wheel
 * notch is exactly sqrt(2)") but not the sign convention on scroll-down.
 * `invert` flips it without touching the magnitude.
 */
export function wheelSpanFactor(deltaY: number, opts: WheelZoomOptions, invert = false): number {
  const scale = opts.shift ? 0.1 : 1;
  const k = opts.isPhysicalWheel ? 0.5 : 1;
  const exponent = (k * scale * (invert ? -deltaY : deltaY)) / 120;
  return Math.pow(2, exponent);
}

/**
 * [CHOSEN] A wheel gesture is classified as zoom or pan by comparing |deltaY| with
 * |deltaX| over a rolling history of 5..15 events inside a 200 ms window, so a diagonal
 * trackpad swipe resolves to a single intent instead of juddering between two.
 */
export class WheelIntent {
  private readonly hist: { t: number; dx: number; dy: number }[] = [];
  private locked: 'zoom' | 'pan' | null = null;
  private lastT = -Infinity;

  constructor(
    private readonly windowMs = 200,
    private readonly minEvents = 5,
    private readonly maxEvents = 15,
  ) {}

  /** Feed one wheel event; returns the intent to act on. */
  classify(deltaX: number, deltaY: number, now: number): 'zoom' | 'pan' {
    if (now - this.lastT > this.windowMs) {
      this.hist.length = 0;
      this.locked = null;
    }
    this.lastT = now;
    this.hist.push({ t: now, dx: Math.abs(deltaX), dy: Math.abs(deltaY) });
    while (this.hist.length > this.maxEvents) this.hist.shift();
    while (this.hist.length > 1 && now - this.hist[0]!.t > this.windowMs) this.hist.shift();

    if (this.locked !== null) return this.locked;
    let sx = 0;
    let sy = 0;
    for (const h of this.hist) {
      sx += h.dx;
      sy += h.dy;
    }
    const intent: 'zoom' | 'pan' = sy >= sx ? 'zoom' : 'pan';
    if (this.hist.length >= this.minEvents) this.locked = intent;
    return intent;
  }

  reset(): void {
    this.hist.length = 0;
    this.locked = null;
    this.lastT = -Infinity;
  }
}
