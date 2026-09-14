// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Session state. Plain data plus a change callback; there is no framework here, per
 * docs/ARCHITECTURE.md ("no UI framework unless a builder makes a case for one"), and this
 * shell never grew a case for one - the whole model is 16 channels and a handful of
 * analyzers.
 */

import type { AnnotationIndex, DecodeResult } from '../decode/index.js';
import { ANALYZER_COLORS, CHANNEL_COLORS } from './metrics.js';
import type { ChannelCount } from '../types.js';

export interface ChannelState {
  /** Capture channel index, i.e. D<index>. Never changes; display order does. */
  index: number;
  name: string;
  enabled: boolean;
}

export type AnalyzerStatus = 'idle' | 'decoding' | 'done' | 'error';

export interface AnalyzerState {
  id: string;
  decoderId: string;
  /** Short display name, e.g. "I2C". */
  label: string;
  color: string;
  /** decoder channel index -> capture channel index */
  channels: Record<number, number>;
  options: Record<string, string | number>;
  /** Capture channel whose row carries this analyzer's lane. */
  laneChannel: number;
  result: DecodeResult | null;
  index: AnnotationIndex | null;
  status: AnalyzerStatus;
  message: string;
}

export interface CaptureSettings {
  channels: ChannelCount;
  samplerate: number;
  thresholdVolts: number;
  /** 'free' runs until stopped or until the sample ceiling; 'timer' stops after seconds. */
  mode: 'free' | 'timer';
  seconds: number;
  /** Hardware data source: normal pins, USB maximum-speed pattern, or simulator. */
  testMode: 0 | 1 | 2;
  /** Global trigger enable mask. Per-channel modes remain stored when this is false. */
  triggerEnableMask: boolean;
  softwareTrigger: boolean;
  /** One of the five PulseView-style per-channel trigger glyphs. Missing means X. */
  triggerModes: Record<number, TriggerMode>;
  /** Confirmed per-channel conditions. They are combined with logical AND. */
  triggerConditions: TriggerCondition[];
  /** Legacy single-condition fields kept for saved/debug settings compatibility. */
  triggerChannel: number;
  triggerKind: 'level' | 'rising' | 'falling' | 'edge';
  triggerLevel: 0 | 1;
  preTriggerPercent: number;
}

export interface TriggerCondition {
  channel: number;
  kind: CaptureSettings['triggerKind'];
  level: 0 | 1;
}

export type TriggerMode = 'low' | 'high' | 'rising' | 'falling' | 'dont-care';

export type Source = 'none' | 'file' | 'device';

/**
 * Default names are empty: the coloured D<index> tag is the channel's identity, and
 * repeating it as a "Channel 12" name only made the label column wide. The name field
 * is for what the user connects the probe to ("SDA"), not for restating the index.
 */
export function defaultChannels(n: number): ChannelState[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    name: '',
    enabled: true,
  }));
}

export function channelColor(index: number): string {
  return CHANNEL_COLORS[index % CHANNEL_COLORS.length]!;
}

export function analyzerColor(n: number): string {
  return ANALYZER_COLORS[n % ANALYZER_COLORS.length]!;
}
