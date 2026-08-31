// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/** Message protocol between the main thread and the decode worker. Internal:
 *  the UI talks to `DecodeClient`, not to these. */

import type { DecodeRequest, DecodeResult, DecoderInfo } from './types';

export interface WorkerConfig {
  /** Directory holding pyodide.js and its .wasm/.zip siblings. */
  pyodideIndexURL: string;
  /** URL of the zipped stock decoder tree. */
  decodersURL: string;
  /** Override the edge budget. Present so the limit can be exercised in a
   *  test without allocating 48 M edges; leave unset in production. */
  edgeBudget: number;
}

export type WorkerRequest =
  | { type: 'configure'; id: number; config: Partial<WorkerConfig> }
  | { type: 'warmup'; id: number }
  | { type: 'describe'; id: number; decoderId: string }
  | { type: 'decode'; id: number; request: DecodeRequest };

export type WorkerResponse =
  /** Unsolicited, sent once as soon as Pyodide is up. Carries the interrupt
   *  buffer the main thread writes to in order to cancel a running decode -
   *  a `cancel` *message* could not work, because the worker is blocked inside
   *  runPython and would not read its queue until the decode finished. */
  | { type: 'interrupt-buffer'; id: 0; buffer: Uint8Array | null }
  | { type: 'configured'; id: number }
  | { type: 'ready'; id: number; loadMs: number }
  | { type: 'described'; id: number; info: DecoderInfo }
  | { type: 'decoded'; id: number; result: DecodeResult; loadMs: number }
  | { type: 'failed'; id: number; message: string; stack: string };
