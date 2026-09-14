// SPDX-License-Identifier: GPL-3.0-or-later
/** Shared capability types. Keep channel-width policy in one place. */

/** Channel widths currently representable by the storage and file formats. */
export type ChannelCount = 4 | 8 | 16 | 32 | 64 | 128;

export const CHANNEL_COUNTS: readonly ChannelCount[] = [4, 8, 16, 32, 64, 128];

export function isChannelCount(value: number): value is ChannelCount {
  return CHANNEL_COUNTS.includes(value as ChannelCount);
}

/** Bytes occupied by one interleaved sample for `channels` logic channels. */
export function bytesPerSampleForChannels(channels: number): number {
  if (!Number.isInteger(channels) || channels < 1) throw new Error(`invalid channel count ${channels}`);
  return Math.ceil(channels / 8);
}

/** Smallest supported storage width that can contain `probes` input probes. */
export function channelWidthForProbes(probes: number): ChannelCount {
  if (!Number.isInteger(probes) || probes < 1 || probes > 128) {
    throw new Error(`probe count must be an integer in [1, 128], got ${probes}`);
  }
  for (const width of CHANNEL_COUNTS) if (probes <= width) return width;
  // The loop above is exhaustive, but keeping an explicit throw helps callers if the
  // capability list is edited without extending this guard.
  throw new Error(`probe count ${probes} exceeds the supported 128-channel envelope`);
}
