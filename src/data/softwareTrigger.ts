// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bounded software trigger for an interleaved device sample stream.
 *
 * This module deliberately sits below WebUSB and above SampleStore. `feed()` accepts
 * arbitrary transfer fragments, carries an incomplete sample to the next call, and
 * invokes `emit` synchronously with complete sample-aligned byte ranges. The emitted
 * ranges must be consumed before `feed()` returns; this matches SampleStore.append().
 *
 * The waiting state owns at most `preTriggerSamples * bytesPerSample` bytes. It never
 * accumulates an unbounded search prefix. Once a match is found, the retained prefix
 * and the trigger sample are emitted, followed by post-trigger samples until
 * `maxSamples` is reached.
 */

import { bytesPerSampleForChannels, isChannelCount, type ChannelCount } from '../types.js';

export type SoftwareTriggerKind = 'level' | 'rising' | 'falling' | 'edge';
export type SoftwareTriggerLevel = 0 | 1;
/** Hard heap ceiling for retained pre-trigger samples, including direct API use. */
export const MAX_SOFTWARE_TRIGGER_PREFIX_BYTES = 64 * 1024 * 1024;

export interface SoftwareTriggerCondition {
  channel: number;
  kind: SoftwareTriggerKind;
  level?: SoftwareTriggerLevel;
}

export interface SoftwareTriggerConfig {
  channels: ChannelCount;
  /** All conditions must match on the same complete sample (logical AND). */
  conditions?: readonly SoftwareTriggerCondition[];
  /** Legacy single-condition fields; retained for callers upgrading from v1. */
  kind?: SoftwareTriggerKind;
  /** Used by `level`; rising/falling/edge use the transition between samples. */
  level?: SoftwareTriggerLevel;
  channel?: number;
  /** Number of samples retained immediately before the trigger sample. */
  preTriggerSamples: number;
  /** Total samples emitted, including the retained prefix and trigger sample. */
  maxSamples: number;
  /** Optional waiting budget. Infinity means keep rolling the prefix until stopped. */
  searchLimitSamples?: number;
}

export interface SoftwareTriggerStats {
  /** Samples inspected while waiting, including the trigger sample if found. */
  inspectedSamples: number;
  /** Samples emitted to the downstream store. */
  emittedSamples: number;
  /** Whether a trigger condition has matched. */
  matched: boolean;
  /** Zero-based index of the trigger sample in the emitted stream. */
  triggerSampleIndex: number | null;
  /** True after finish() when no trigger condition matched. */
  noTrigger: boolean;
  /** Whether maxSamples has been emitted and the caller can stop the device. */
  complete: boolean;
}

export interface SoftwareTriggerOptions {
  config: SoftwareTriggerConfig;
  emit: (chunk: Uint8Array) => void;
}

function assertConfig(c: SoftwareTriggerConfig): void {
  if (!isChannelCount(c.channels)) {
    throw new Error(`unsupported trigger channel width ${c.channels}`);
  }
  const conditions = c.conditions?.length
    ? c.conditions
    : c.channel !== undefined && c.kind !== undefined
      ? [{ channel: c.channel, kind: c.kind, level: c.level }]
      : [];
  if (conditions.length === 0) throw new Error('software trigger requires at least one condition');
  for (const condition of conditions) {
    if (!Number.isInteger(condition.channel) || condition.channel < 0 || condition.channel >= c.channels) {
      throw new Error(`trigger channel ${condition.channel} outside 0..${c.channels - 1}`);
    }
    if (condition.kind === 'level' && condition.level !== 0 && condition.level !== 1) {
      throw new Error(`level trigger requires level 0 or 1, got ${condition.level}`);
    }
  }
  if (!Number.isInteger(c.preTriggerSamples) || c.preTriggerSamples < 0) {
    throw new Error(`preTriggerSamples must be a non-negative integer, got ${c.preTriggerSamples}`);
  }
  if (!Number.isInteger(c.maxSamples) || c.maxSamples < 1) {
    throw new Error(`maxSamples must be a positive integer, got ${c.maxSamples}`);
  }
  if (c.searchLimitSamples !== undefined && c.searchLimitSamples !== Infinity &&
      (!Number.isInteger(c.searchLimitSamples) || c.searchLimitSamples < 1)) {
    throw new Error(`searchLimitSamples must be a positive integer or Infinity, got ${c.searchLimitSamples}`);
  }
  if (c.kind === 'level' && c.level !== 0 && c.level !== 1) {
    throw new Error(`level trigger requires level 0 or 1, got ${c.level}`);
  }
}

/**
 * A synchronous, bounded trigger state machine.
 *
 * A pre-trigger equal to the full capture budget is reduced by one sample so the
 * trigger sample itself can always be retained. This makes the output budget an
 * invariant rather than a best effort.
 */
export class SoftwareTrigger {
  readonly channels: ChannelCount;
  readonly bytesPerSample: number;
  readonly channel: number;
  readonly kind: SoftwareTriggerKind;
  readonly level: SoftwareTriggerLevel | undefined;
  readonly preTriggerSamples: number;
  readonly maxSamples: number;
  readonly conditions: readonly SoftwareTriggerCondition[];
  /** Maximum complete samples inspected while waiting. Defaults to output budget plus
   * retained prefix; callers may use Infinity for a timer that starts at trigger time. */
  readonly searchLimitSamples: number;

  private readonly emit: (chunk: Uint8Array) => void;
  private readonly ring: Uint8Array;
  private ringStart = 0;
  private ringCount = 0;
  private partial = new Uint8Array(0);
  private previous: Array<number | null>;
  private statsValue: SoftwareTriggerStats = {
    inspectedSamples: 0,
    emittedSamples: 0,
    matched: false,
    triggerSampleIndex: null,
    noTrigger: false,
    complete: false,
  };

  constructor(opts: SoftwareTriggerOptions) {
    assertConfig(opts.config);
    this.channels = opts.config.channels;
    this.bytesPerSample = bytesPerSampleForChannels(this.channels);
    const first = opts.config.conditions?.[0] ?? {
      channel: opts.config.channel!, kind: opts.config.kind!, level: opts.config.level,
    };
    this.channel = first.channel;
    this.kind = first.kind!;
    this.level = first.level;
    this.maxSamples = opts.config.maxSamples;
    const conditions = opts.config.conditions?.length
      ? opts.config.conditions
      : [{ channel: opts.config.channel!, kind: opts.config.kind!, level: opts.config.level }];
    for (const c of conditions) {
      if (!Number.isInteger(c.channel) || c.channel < 0 || c.channel >= this.channels) {
        throw new Error(`trigger channel ${c.channel} outside 0..${this.channels - 1}`);
      }
      if (c.kind === 'level' && c.level !== 0 && c.level !== 1) {
        throw new Error(`level trigger requires level 0 or 1, got ${c.level}`);
      }
    }
    this.conditions = conditions.map((c) => c.level === undefined
      ? { channel: c.channel, kind: c.kind! }
      : { channel: c.channel, kind: c.kind!, level: c.level });
    this.previous = Array.from({ length: this.channels }, () => null);
    this.preTriggerSamples = Math.min(
      opts.config.preTriggerSamples,
      Math.max(0, this.maxSamples - 1),
      Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / this.bytesPerSample),
    );
    this.searchLimitSamples = opts.config.searchLimitSamples ?? this.maxSamples + this.preTriggerSamples;
    this.emit = opts.emit;
    this.ring = new Uint8Array(this.preTriggerSamples * this.bytesPerSample);
  }

  get waiting(): boolean {
    return !this.statsValue.matched && !this.statsValue.noTrigger;
  }

  get stats(): SoftwareTriggerStats {
    return { ...this.statsValue };
  }

  /**
   * Feed any transfer fragment. A fragment may end in the middle of a wide sample.
   * The only retained bytes outside the ring are at most bytesPerSample - 1.
   */
  feed(fragment: Uint8Array): void {
    if (fragment.byteLength === 0 || this.statsValue.complete || this.statsValue.noTrigger) return;

    let src = fragment;
    if (this.partial.length > 0) {
      const need = this.bytesPerSample - this.partial.length;
      const take = Math.min(need, src.length);
      const joined = new Uint8Array(this.partial.length + take);
      joined.set(this.partial);
      joined.set(src.subarray(0, take), this.partial.length);
      this.partial = joined.length === this.bytesPerSample ? new Uint8Array(0) : joined;
      src = src.subarray(take);
      if (joined.length === this.bytesPerSample) this.consume(joined);
      if (this.statsValue.complete || this.statsValue.noTrigger) return;
      if (this.statsValue.matched) {
        this.emitPost(src);
        return;
      }
    }

    const whole = src.length - (src.length % this.bytesPerSample);
    for (let offset = 0; offset < whole && !this.statsValue.complete && !this.statsValue.noTrigger; offset += this.bytesPerSample) {
      if (this.statsValue.matched) {
        this.emitPost(src.subarray(offset));
        return;
      }
      this.consume(src.subarray(offset, offset + this.bytesPerSample));
    }
    if (whole < src.length) this.partial = src.slice(whole);
  }

  /**
   * End a capture that stopped before a match. The ring is discarded and no
   * untriggered samples are emitted: callers can expose `noTrigger` to the UI.
   */
  finish(): void {
    if (this.statsValue.matched || this.statsValue.complete) return;
    this.partial = new Uint8Array(0);
    this.ringStart = 0;
    this.ringCount = 0;
    this.statsValue.noTrigger = true;
  }

  /**
   * A device dropout invalidates a transition across the gap and any pre-trigger
   * bytes spanning it. The processor remains bounded and continues searching.
   */
  resetContinuity(): void {
    this.previous.fill(null);
    this.partial = new Uint8Array(0);
    this.ringStart = 0;
    this.ringCount = 0;
  }

  /** Account for samples lost in a transport gap without allowing a transition
   * across the gap. The bounded search budget still advances. */
  noteGap(samples: number): void {
    if (!Number.isFinite(samples) || samples <= 0 || !this.waiting) {
      this.resetContinuity();
      return;
    }
    this.statsValue.inspectedSamples += Math.floor(samples);
    this.resetContinuity();
  }

  private consume(sample: Uint8Array): void {
    this.statsValue.inspectedSamples++;

    if (!this.statsValue.matched) {
      let match = true;
      for (const condition of this.conditions) {
        const value = (sample[condition.channel >>> 3]! >>> (condition.channel & 7)) & 1;
        if (!this.matches(condition, value, this.previous[condition.channel])) match = false;
      }
      for (const condition of this.conditions) {
        this.previous[condition.channel] =
          (sample[condition.channel >>> 3]! >>> (condition.channel & 7)) & 1;
      }
      if (match) {
        this.statsValue.matched = true;
        this.emitRing();
        // emitRing() has just accounted for every retained pre-trigger sample, so
        // the next output slot is the exact T=0 sample seen by SampleStore.
        this.statsValue.triggerSampleIndex = this.statsValue.emittedSamples;
        this.emit(sample);
        this.statsValue.emittedSamples++;
        if (this.statsValue.emittedSamples >= this.maxSamples) {
          this.statsValue.complete = true;
          return;
        }
      } else {
        this.pushRing(sample);
        if (this.statsValue.inspectedSamples >= this.searchLimitSamples) this.finish();
        return;
      }
    } else {
      this.emit(sample);
      this.statsValue.emittedSamples++;
      if (this.statsValue.emittedSamples >= this.maxSamples) this.statsValue.complete = true;
    }
  }

  private emitPost(bytes: Uint8Array): void {
    if (this.statsValue.complete) return;
    const available = Math.floor(bytes.length / this.bytesPerSample);
    const remaining = this.maxSamples - this.statsValue.emittedSamples;
    const count = Math.min(available, remaining);
    if (count <= 0) {
      if (remaining <= 0) this.statsValue.complete = true;
      else if (bytes.length) this.partial = bytes.slice();
      return;
    }
    const n = count * this.bytesPerSample;
    this.emit(bytes.subarray(0, n));
    this.statsValue.emittedSamples += count;
    if (this.statsValue.emittedSamples >= this.maxSamples) this.statsValue.complete = true;
    else if (n < bytes.length) this.partial = bytes.slice(n);
  }

  private matches(condition: SoftwareTriggerCondition, value: number, old: number | null): boolean {
    switch (condition.kind) {
      case 'level': return value === condition.level;
      case 'rising': return old === 0 && value === 1;
      case 'falling': return old === 1 && value === 0;
      case 'edge': return old !== null && old !== value;
    }
    return false;
  }

  private pushRing(sample: Uint8Array): void {
    if (this.preTriggerSamples === 0) return;
    const offset = (this.ringStart + this.ringCount) % this.preTriggerSamples;
    this.ring.set(sample, offset * this.bytesPerSample);
    if (this.ringCount < this.preTriggerSamples) this.ringCount++;
    else this.ringStart = (this.ringStart + 1) % this.preTriggerSamples;
  }

  private emitRing(): void {
    if (this.ringCount === 0) return;
    // At most two copies: the ring's two contiguous spans. Per-sample copies would
    // create avoidable allocation pressure for a large pre-trigger window.
    const first = Math.min(this.ringCount, this.preTriggerSamples - this.ringStart);
    this.emit(this.ring.slice(
      this.ringStart * this.bytesPerSample,
      (this.ringStart + first) * this.bytesPerSample,
    ));
    if (first < this.ringCount) {
      this.emit(this.ring.slice(0, (this.ringCount - first) * this.bytesPerSample));
    }
    this.statsValue.emittedSamples += this.ringCount;
    this.ringStart = 0;
    this.ringCount = 0;
  }
}
