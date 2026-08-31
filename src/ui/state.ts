/**
 * Session state. Plain data plus a change callback; there is no framework here, per
 * docs/ARCHITECTURE.md ("no UI framework unless a builder makes a case for one"), and this
 * shell never grew a case for one - the whole model is 16 channels and a handful of
 * analyzers.
 */

import type { AnnotationIndex, DecodeResult } from '../decode/index.js';
import { ANALYZER_COLORS, CHANNEL_COLORS } from './metrics.js';

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
  channels: 4 | 8 | 16;
  samplerate: number;
  thresholdVolts: number;
  /** 'free' runs until stopped or until the sample ceiling; 'timer' stops after seconds. */
  mode: 'free' | 'timer';
  seconds: number;
}

export type Source = 'none' | 'file' | 'device';

export function defaultChannels(n: number): ChannelState[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    name: `Channel ${i}`,
    enabled: true,
  }));
}

export function channelColor(index: number): string {
  return CHANNEL_COLORS[index % CHANNEL_COLORS.length]!;
}

export function analyzerColor(n: number): string {
  return ANALYZER_COLORS[n % ANALYZER_COLORS.length]!;
}
