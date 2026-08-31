/**
 * A SampleStore that forwards to another one, so the inner store can be replaced.
 *
 * `WaveformRenderer` takes its store at construction and holds it `readonly`. A new
 * capture means a new `PlanarSampleStore`, and rebuilding the renderer for each one would
 * leak a WebGL context per capture - Chromium caps a page at roughly 16 before it starts
 * killing the oldest. So the renderer is handed this once and the capture is swapped
 * underneath it.
 *
 * Nothing is cached here. `channelCount`, `samplerate` and `length` are read through on
 * every access, because `length` grows during a live capture and a stale copy would draw
 * half the channels against a different capture length.
 */

import type { ColumnView, GapSpan, SampleStore } from '../data/types.js';

export class StoreRef implements SampleStore {
  private inner: SampleStore;

  constructor(inner: SampleStore) {
    this.inner = inner;
  }

  /** Swap the capture. The renderer keeps its context; callers must re-send row specs,
   *  because the channel count may have changed. */
  set(inner: SampleStore): void {
    this.inner = inner;
  }

  get target(): SampleStore {
    return this.inner;
  }

  get channelCount(): number {
    return this.inner.channelCount;
  }

  get samplerate(): number {
    return this.inner.samplerate;
  }

  get length(): number {
    return this.inner.length;
  }

  append(chunk: Uint8Array): void {
    this.inner.append(chunk);
  }

  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView {
    return this.inner.query(channel, startSample, endSample, bins);
  }

  edges(channel: number, startSample: number, endSample: number): Int32Array {
    return this.inner.edges(channel, startSample, endSample);
  }

  noteGap(startSample: number, endSample: number): void {
    this.inner.noteGap(startSample, endSample);
  }

  gaps(): GapSpan[] {
    return this.inner.gaps();
  }
}
