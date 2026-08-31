// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * src/decode - stock sigrok protocol decoders in the browser.
 *
 * Every decoder that runs here is the unmodified upstream libsigrokdecode
 * `.py` file, executed by Pyodide in a Web Worker against a pure-Python
 * reimplementation of the `sigrokdecode` module that libsigrokdecode's C core
 * normally provides. See NOTES.md for the route comparison and the
 * differential testing against `sigrok-cli`.
 *
 * Typical use:
 *
 *   const client = sharedDecodeClient();   // one worker per page
 *   void client.warmup();                  // pay the ~850 ms up front
 *
 *   const stack = [{ id: 'uart', channels: { 0: 3 }, options: { baudrate: 115200 } }];
 *   const problems = validateStack(stack, store.channelCount);
 *   if (problems.length) throw new Error(problems.join('\n'));
 *
 *   // Supply edges only for channels the stack maps; the rest are never read.
 *   const empty = { edges: new Int32Array(0), initial: 0 as const };
 *   const channels = Array.from({ length: store.channelCount }, () => empty);
 *   channels[3] = { edges: store.edges(3, 0, store.length), initial: 0 };
 *
 *   const result = await client.decode(
 *     { samplerate: store.samplerate, length: store.length, channels, stack },
 *     { timeoutMs: 5000, signal: abort.signal });
 */

export {
  DecodeClient, sharedDecodeClient, AnnotationIndex, annotationTexts,
  annotationsInRange, DecodeCancelledError, DecodeTimeoutError,
} from './client';
export type { DecodeOptions } from './client';
export { MAX_SAMPLE, EDGE_BUDGET, DEFAULT_DECODE_TIMEOUT_MS } from './limits';
export {
  listDecoders, getDecoder, hasDecoder, decoderCount, logicDecoders,
  isLogicDecoder, stackableOn, producersFor, allTags, validateStack, rowForClass,
  displayRows,
} from './registry';
export type {
  Annotations, AnnotationRowInfo, ChannelEdges, DecodeRequest, DecodeResult,
  DecoderChannelInfo, DecoderInfo, DecoderInstance, DecoderListEntry,
  DecoderOptionInfo,
} from './types';
export type { WorkerConfig } from './protocol';
