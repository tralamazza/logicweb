/**
 * Public contract for src/device, as specified in docs/ARCHITECTURE.md.
 * Nothing outside this file is part of the cross-module interface.
 */

export interface CaptureConfig {
  channels: 4 | 8 | 16;
  samplerate: number; // Hz, from the table in PROTOCOL-SLOGIC16U3.md
  thresholdVolts: number; // mapped to the DAC code by the device layer
}

/**
 * `chunk` is raw device bytes with the 4 junk head bytes already removed and
 * sub-8-channel packing already expanded to one byte per sample. At 16
 * channels it stays 2 bytes/sample little endian.
 *
 * The buffer handed to the sink is owned by the sink from that point on; the
 * device layer never writes to it again.
 */
export type SampleSink = (chunk: Uint8Array) => void;

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
  start(cfg: CaptureConfig, sink: SampleSink, onDropout?: DropoutSink): Promise<void>;
  stop(): Promise<void>;
}
