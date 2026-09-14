// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Messages between the page and the thread that owns the device.
 *
 * The point of the split is the one libsigrok makes: a completed URB is reaped and
 * resubmitted on a thread whose only job is that callback (protocol.c:325), while the
 * session thread appends buffers and a libusb-less GUI is free to draw, allocate and
 * collect garbage. In the page those are the same thread, and at 32ch/200M the same
 * thread cannot afford it: one 4 s capture is 3.2 GB of store, and the measured garbage
 * collection pauses inside it are 20-38 ms against a USB queue that covers 19.6 ms
 * (NOTES 8.18).
 *
 * Types only - this module exists so both sides agree on the shape without importing
 * each other.
 */

import type { Stats, StartOptions } from './slogic16u3.js';
import type { CaptureConfig, SampleSink } from './types.js';
import type { TraceEntry } from './protocol.js';

export interface DeviceFilter {
  vendorId: number;
  productId: number;
  /** WebUSB's serial, which Chromium hands the page as an anti-fingerprinting hash. */
  serial?: string | undefined;
}

export type ToWorker =
  | { kind: 'open'; filter: DeviceFilter }
  | { kind: 'start'; cfg: CaptureConfig; options: WorkerStartOptions }
  | { kind: 'stop' }
  | { kind: 'stats' }
  | { kind: 'console'; command: string }
  | { kind: 'ack'; id: number };

/**
 * `StartOptions` minus the callbacks: a function cannot cross a structured clone, so the
 * worker reports trigger transitions and end-of-capture as messages instead (the page
 * turns them back into the `onTriggerState` / `onEnd` calls the device layer expects).
 */
export type WorkerStartOptions = Omit<StartOptions, 'onTriggerState' | 'onEnd'>;

/**
 * A chunk of samples. `buffer` is transferred, not copied, so the worker hands over its
 * only reference to the bytes the device delivered; the page owns them from then on and
 * answers with an `ack` carrying the same id.
 *
 * `offset`/`length` are needed because the transport's head drop leaves the payload at a
 * byte offset into the transfer buffer and the buffer is transferred whole.
 */
export interface ChunkMessage {
  kind: 'chunk';
  id: number;
  buffer: ArrayBuffer;
  offset: number;
  length: number;
}

export type FromWorker =
  | {
      kind: 'opened';
      name: string;
      serial: string;
      maxChannels: number;
      maxSamplerateHz: Readonly<Record<number, number>>;
    }
  | ChunkMessage
  | { kind: 'dropout'; position: number; missing: number }
  | { kind: 'trigger'; state: 'waiting' | 'triggered' | 'not-found'; index?: number }
  /** The capture delivered everything it ever will; every chunk of it precedes this. */
  | { kind: 'ended' }
  | { kind: 'trace'; entry: TraceEntry }
  | { kind: 'error'; message: string }
  | { kind: 'stats'; stats: Stats }
  | { kind: 'console'; result: string }
  | { kind: 'started' }
  | { kind: 'stopped' }
  | { kind: 'failed'; message: string };

/** What the worker's caller has to provide for `start`. */
export interface WorkerStart {
  cfg: CaptureConfig;
  sink: SampleSink;
  options: WorkerStartOptions;
}
