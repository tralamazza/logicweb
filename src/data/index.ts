/**
 * src/data - sample storage and multiresolution query.
 *
 * The store other modules should use is PlanarSampleStore. InterleavedSampleStore is the
 * rejected alternative, kept and exported only so the comparison in NOTES.md can be
 * re-run rather than taken on trust; do not build the application on it.
 */

export type { SampleStore, ColumnView, MemoryReport, GapSpan } from './types.js';
export { GAP_BIT } from './types.js';
export { appendLostSamples, channelAcrossGaps } from './gaps.js';
export { PlanarSampleStore, type PlanarStoreOptions } from './planarStore.js';
export { InterleavedSampleStore } from './interleavedStore.js';
export { RleSampleStore, type RleChannelData, type RleTransitionSource } from './rleStore.js';
export { generateCapture, fillMacro, makeTileBlock, CHANNEL_NAMES, MACRO_SAMPLES } from './generator.js';
export type { GeneratorOptions } from './generator.js';
export { runFastSuite, testNarrowGlitch, testGeneratedGlitch, formatResults } from './selftest.js';
export type { TestResult } from './selftest.js';

import { PlanarSampleStore } from './planarStore.js';
import { RleSampleStore, type RleChannelData, type RleTransitionSource } from './rleStore.js';
import type { GapSpan, SampleStore } from './types.js';

/**
 * What src/device, src/ui and src/render should call. Keeps the concrete class out of
 * their imports so the layout can change without touching them.
 */
export function createSampleStore(channelCount: 4 | 8 | 16, samplerate: number): SampleStore {
  return new PlanarSampleStore({ channelCount, samplerate });
}

/**
 * A store for imported captures, built straight from per-channel transition *times*.
 * The times are quantised to sample positions with the same rule the planar resample
 * used (first sample at or after the transition, same-sample toggles cancel pairwise),
 * so the two stores agree edge for edge. Takes ownership of the Float64Arrays.
 */
export function createTransitionStore(
  channelCount: 4 | 8 | 16, samplerate: number, length: number,
  channels: readonly RleTransitionSource[],
): SampleStore {
  return RleSampleStore.fromTransitions(channelCount, samplerate, length, [...channels]);
}

/**
 * A store for imported captures whose transitions are already sample positions (our
 * own `.lwcap`). Takes ownership of the edge Int32Arrays: the caller must not mutate
 * them afterwards. `gaps` are the unknown spans, sorted and non-overlapping.
 */
export function createEdgeStore(
  channelCount: 4 | 8 | 16, samplerate: number, length: number,
  channels: readonly RleChannelData[], gaps?: readonly GapSpan[],
): SampleStore {
  return new RleSampleStore({
    channelCount, samplerate, length, channels: [...channels],
    ...(gaps ? { gaps: gaps.map((g) => ({ ...g })) } : {}),
  });
}
