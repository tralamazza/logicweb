// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * src/data - sample storage and multiresolution query.
 *
 * Call createSampleStore() rather than choosing a layout. It uses planar bit planes for
 * ordinary widths and native interleaved uint32 words for the 800 MB/s SLogic32 path.
 */

export type { SampleStore, ColumnView, MemoryReport, GapSpan } from './types.js';
export { GAP_BIT } from './types.js';
export { appendLostSamples, channelAcrossGaps } from './gaps.js';
export { PlanarSampleStore, type PlanarStoreOptions } from './planarStore.js';
export { InterleavedSampleStore } from './interleavedStore.js';
export { RleSampleStore, type RleChannelData, type RleTransitionSource } from './rleStore.js';
export {
  SoftwareTrigger,
  MAX_SOFTWARE_TRIGGER_PREFIX_BYTES,
  type SoftwareTriggerConfig,
  type SoftwareTriggerKind,
  type SoftwareTriggerLevel,
  type SoftwareTriggerOptions,
  type SoftwareTriggerStats,
} from './softwareTrigger.js';
export { runSoftwareTriggerSuite, type SoftwareTriggerTestResult } from './softwareTriggerSelftest.js';
export { generateCapture, fillMacro, makeTileBlock, CHANNEL_NAMES, MACRO_SAMPLES } from './generator.js';
export type { GeneratorOptions } from './generator.js';
export { runFastSuite, testNarrowGlitch, testGeneratedGlitch, formatResults } from './selftest.js';
export type { TestResult } from './selftest.js';

import { PlanarSampleStore } from './planarStore.js';
import { InterleavedSampleStore } from './interleavedStore.js';
import { RleSampleStore, type RleChannelData, type RleTransitionSource } from './rleStore.js';
import type { GapSpan, SampleStore } from './types.js';
import type { ChannelCount } from '../types.js';

/**
 * What src/device, src/ui and src/render should call. Keeps the concrete class out of
 * their imports so the layout can change without touching them.
 */
export function createSampleStore(channelCount: ChannelCount, samplerate: number): SampleStore {
  // Keep SLogic32 U3 words interleaved. At 200 MSa/s, copying its native uint32 stream
  // is fast enough to sustain USB while a synchronous 32-plane transpose is not.
  if (channelCount === 32) return new InterleavedSampleStore(samplerate, 32);
  return new PlanarSampleStore({ channelCount, samplerate });
}

/**
 * A store for imported captures, built straight from per-channel transition *times*.
 * The times are quantised to sample positions with the same rule the planar resample
 * used (first sample at or after the transition, same-sample toggles cancel pairwise),
 * so the two stores agree edge for edge. Takes ownership of the Float64Arrays.
 */
export function createTransitionStore(
  channelCount: ChannelCount, samplerate: number, length: number,
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
  channelCount: ChannelCount, samplerate: number, length: number,
  channels: readonly RleChannelData[], gaps?: readonly GapSpan[],
): SampleStore {
  return new RleSampleStore({
    channelCount, samplerate, length, channels: [...channels],
    ...(gaps ? { gaps: gaps.map((g) => ({ ...g })) } : {}),
  });
}
