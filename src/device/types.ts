// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Public contract for src/device, as specified in docs/ARCHITECTURE.md.
 * Nothing outside this file is part of the cross-module interface.
 */

export interface CaptureConfig {
  channels: import('../types.js').ChannelCount;
  samplerate: number; // Hz, from the table in PROTOCOL-SLOGIC16U3.md
  thresholdVolts: number; // mapped to the DAC code by the device layer
  /** 0 normal input, 1 USB throughput pattern, 2 simulated logic pattern. */
  testMode?: 0 | 1 | 2;
}

export interface CaptureStartOptions {
  /** Optional bounded host-side trigger. Omit to preserve unfiltered streaming. */
  softwareTrigger?: import('../data/softwareTrigger.js').SoftwareTriggerConfig;
  /**
   * Samples the device should deliver before it stops itself, when the capture
   * length is known before it is armed. The transport programmes the device's own
   * length register (R32_SAMPLE_LEN) so the capture can end without the host
   * cutting off a device that is still producing - the overrun that wedges a
   * 32U3 until it is unplugged. Ignored by transports that have no such register.
   */
  deviceSampleLimit?: number;
  /** `triggerSampleIndex` is present for `triggered` and refers to the emitted stream. */
  onTriggerState?: (
    state: 'waiting' | 'triggered' | 'not-found', triggerSampleIndex?: number,
  ) => void;
}

/**
 * `chunk` is raw device bytes with the 4 junk head bytes already removed and
 * sub-8-channel packing already expanded. Samples are little-endian and occupy
 * ceil(channels / 8) bytes (2 at 16 channels, 4 at 32, up to 16 at 128).
 *
 * The buffer handed to the sink is owned by the sink from that point on; the
 * device layer never writes to it again.
 */
export type SampleSink = (chunk: Uint8Array) => void | Promise<void>;

/**
 * Reports a mid-capture dropout: `samplePosition` samples were delivered
 * before the device failed to fill a transfer and `missingSamples` were lost.
 * The stream continues afterwards, so every sample position at or past the
 * gap is shifted relative to device time - mark the span untrusted rather
 * than resuming as if nothing happened.
 */
export type DropoutSink = (samplePosition: number, missingSamples: number) => void;

export interface Device {
  readonly name: string;
  readonly serial: string;
  /** Capability envelope exposed to the UI; absent for third-party devices. */
  readonly maxChannels?: number;
  readonly maxSamplerateHz?: Readonly<Record<number, number>>;
  /** Advanced, idle-only USB/register console. */
  usbControl?(command: string): Promise<string>;
  start(
    cfg: CaptureConfig, sink: SampleSink, onDropout?: DropoutSink,
    options?: CaptureStartOptions,
  ): Promise<void>;
  stop(): Promise<void>;
  /**
   * Fatal errors from the transport's background reader. Optional because a
   * third-party device need not have one; when present it is set by the UI, which is
   * what turns "the capture died in the background" into something the user sees.
   */
  onError?: ((error: unknown) => void) | null;
}
