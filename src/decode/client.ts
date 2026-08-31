// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Main-thread handle on the decode worker.
 *
 * The UI attaches a decoder (or a stack) to channels and gets annotation spans
 * back. Requests are serialised: Pyodide is single threaded, so queueing here
 * keeps ordering honest instead of letting messages interleave in the worker.
 *
 * Cold start is ~850 ms and is paid **once per worker**, so keep one client
 * alive for the life of the page - `sharedDecodeClient()` does that for you.
 * Every decode is bounded by a timeout and can be cancelled; see `decode()`.
 */

import { DEFAULT_DECODE_TIMEOUT_MS } from './limits';
import type { WorkerConfig, WorkerRequest, WorkerResponse } from './protocol';
import type { DecodeRequest, DecodeResult, DecoderInfo } from './types';

interface Pending {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
  want: WorkerResponse['type'];
}

/** Omit over a union has to distribute, or the members collapse. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ResponseOf<K extends WorkerResponse['type']> = Extract<WorkerResponse, { type: K }>;

export interface DecodeOptions {
  /** Wall-clock ceiling. Exceeding it cancels the decode and rejects.
   *  Defaults to DEFAULT_DECODE_TIMEOUT_MS; pass 0 to disable. */
  timeoutMs?: number;
  /** Aborts the decode. Works mid-decode, not merely before it starts. */
  signal?: AbortSignal;
}

export class DecodeCancelledError extends Error {
  constructor(msg = 'decode cancelled') {
    super(msg);
    this.name = 'DecodeCancelledError';
  }
}

export class DecodeTimeoutError extends Error {
  constructor(ms: number) {
    super(`decode exceeded ${ms} ms and was cancelled`);
    this.name = 'DecodeTimeoutError';
  }
}

export class DecodeClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private config: Partial<WorkerConfig> | undefined;
  private disposed = false;
  /** Pyodide's interrupt buffer, or null when SharedArrayBuffer is
   *  unavailable. Writing 2 raises KeyboardInterrupt inside the running
   *  decode. */
  private interrupt: Uint8Array | null = null;
  /** Pyodide load time, filled in after the first decode or warmup(). */
  loadMs = 0;
  /** Times the worker had to be killed to honour a cancel. Each one costs a
   *  fresh Pyodide load, so a non-zero value here is worth noticing. */
  hardCancels = 0;

  constructor(config?: Partial<WorkerConfig>) {
    this.config = config;
  }

  /** Spawn the worker if it is not up. Lazy, so `terminate()` is recoverable
   *  rather than one-way. */
  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('DecodeClient has been disposed');
    if (this.worker) return this.worker;

    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    w.onerror = (ev) => {
      // A worker-level error kills every in-flight request; failing them all
      // loudly beats leaving callers hanging forever.
      this.failAll(new Error(
        `decode worker error: ${ev.message} (${ev.filename}:${ev.lineno})`));
    };
    this.worker = w;
    if (this.config) void this.send({ type: 'configure', config: this.config }, 'configured');
    return w;
  }

  private failAll(err: Error) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /** Kill the worker and fail everything in flight. The next request spawns a
   *  fresh one, which costs a full Pyodide load. */
  private hardReset(err: Error) {
    this.worker?.terminate();
    this.worker = null;
    this.interrupt = null;
    this.loadMs = 0;
    this.failAll(err);
  }

  private onMessage(res: WorkerResponse) {
    if (res.type === 'interrupt-buffer') {
      // Present only when the page is cross-origin isolated. Without it,
      // cancelling means killing the worker.
      this.interrupt = res.buffer;
      return;
    }
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    if (res.type === 'failed') {
      const e = res.message === 'decode cancelled'
        ? new DecodeCancelledError() : new Error(res.message);
      if (res.stack) e.stack = res.stack;
      p.reject(e);
    } else if (res.type !== p.want) {
      p.reject(new Error(`decode worker: expected ${p.want}, got ${res.type}`));
    } else {
      if ('loadMs' in res) this.loadMs = res.loadMs;
      p.resolve(res as never);
    }
  }

  private send<K extends WorkerResponse['type']>(
    msg: DistOmit<WorkerRequest, 'id'>, want: K,
  ): Promise<ResponseOf<K>> {
    const w = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<ResponseOf<K>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, want });
      w.postMessage({ ...msg, id } as WorkerRequest);
    });
  }

  /** Serialise requests; Pyodide cannot run two decodes at once anyway. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Start Pyodide now instead of on the first decode. Call this as soon as a
   *  decoder looks likely, so the ~850 ms is not spent in front of the user. */
  warmup(): Promise<number> {
    return this.enqueue(async () => (await this.send({ type: 'warmup' }, 'ready')).loadMs);
  }

  /** Full metadata straight from the decoder class. Normally unnecessary -
   *  `getDecoder(id)` from the registry is the same data with no Pyodide. */
  describe(decoderId: string): Promise<DecoderInfo> {
    return this.enqueue(async () =>
      (await this.send({ type: 'describe', decoderId }, 'described')).info);
  }

  /**
   * Run a decoder stack. Always bounded: if the decode outlives `timeoutMs` or
   * the abort signal fires, it is cancelled and this rejects.
   *
   * Cancellation is cooperative where the page is cross-origin isolated
   * (Pyodide's interrupt buffer needs a SharedArrayBuffer). Otherwise the
   * worker is killed and respawned - still bounded, but it costs a Pyodide
   * reload, and `hardCancels` counts those.
   */
  decode(request: DecodeRequest, opts: DecodeOptions = {}): Promise<DecodeResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
    return this.enqueue(async () => {
      if (opts.signal?.aborted) throw new DecodeCancelledError();

      let timer: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const inflight = this.send({ type: 'decode', request }, 'decoded');
      inflight.catch(() => {});   // the race below reports it

      const bail = (err: Error) => {
        // Raise KeyboardInterrupt inside the running decode. Where the buffer
        // is unavailable the request will never settle, so arm a grace period
        // after which the worker is killed outright. Either way the caller is
        // freed, and the decode does not keep burning a core.
        if (this.interrupt) this.interrupt[0] = 2;
        grace = setTimeout(() => {
          if (this.pending.size) {
            this.hardCancels++;
            this.hardReset(err);
          }
        }, 250);
      };

      try {
        const raced = new Promise<never>((_, reject) => {
          if (timeoutMs > 0) {
            timer = setTimeout(() => {
              const err = new DecodeTimeoutError(timeoutMs);
              bail(err);
              reject(err);
            }, timeoutMs);
          }
          if (opts.signal) {
            onAbort = () => {
              const err = new DecodeCancelledError();
              bail(err);
              reject(err);
            };
            opts.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        return (await Promise.race([inflight, raced])).result;
      } finally {
        if (timer) clearTimeout(timer);
        if (grace) clearTimeout(grace);
        if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
      }
    });
  }

  /** Kill the worker. The client stays usable: the next request spawns a new
   *  one and pays the cold start again. */
  terminate() {
    this.hardReset(new Error('decode worker terminated'));
  }

  /** Permanently retire this client. */
  dispose() {
    this.terminate();
    this.disposed = true;
  }
}

let shared: DecodeClient | null = null;

/**
 * The process-wide client. Prefer this over constructing your own: the ~850 ms
 * cold start is per worker, so a second client means a second Pyodide load.
 */
export function sharedDecodeClient(config?: Partial<WorkerConfig>): DecodeClient {
  if (!shared) shared = new DecodeClient(config);
  return shared;
}

/** Text variants for annotation `i`, longest first, as sigrok emits them. A
 *  renderer picks the widest that fits, which is how annotation text degrades
 *  "Setup Write to [0xA0] + ACK" down to "A0". */
export function annotationTexts(r: DecodeResult, i: number): string[] {
  const { textOffset, texts } = r.annotations;
  return texts.slice(textOffset[i]!, textOffset[i + 1]!);
}

/**
 * Per-instance index over annotation spans, built once and reused.
 *
 * A linear scan costs 2.04 ms at 1.18 M annotations - 12% of a 16 ms frame for
 * a single attached decoder, before anything is drawn. Build this once per
 * DecodeResult and query it per frame instead.
 */
export class AnnotationIndex {
  /** Annotation indices per instance, ordered by start sample. */
  private byInst: Int32Array[];
  /** Running max of `end` down each instance's list. Spans nest and overlap,
   *  so a plain start-ordered search would miss a long span that began well
   *  before the viewport; this makes the lower bound searchable. */
  private maxEnd: Int32Array[];

  constructor(private result: DecodeResult) {
    const { count, inst, start, end } = result.annotations;
    const nInst = Math.max(1, result.instances.length);
    const counts = new Int32Array(nInst);
    for (let i = 0; i < count; i++) counts[inst[i]!]!++;

    const lists = Array.from(counts, n => new Int32Array(n));
    const fill = new Int32Array(nInst);
    for (let i = 0; i < count; i++) {
      const k = inst[i]!;
      lists[k]![fill[k]!++] = i;
    }
    // put() order is not sorted by start: decoders routinely emit a summary
    // span after the parts it covers.
    this.byInst = lists.map(list =>
      Int32Array.from(Array.from(list).sort((a, b) => start[a]! - start[b]!)));
    this.maxEnd = this.byInst.map(list => {
      const m = new Int32Array(list.length);
      let run = -1;
      for (let j = 0; j < list.length; j++) {
        const e = end[list[j]!]!;
        if (e > run) run = e;
        m[j] = run;
      }
      return m;
    });
  }

  /** Indices of annotations for `instance` overlapping [startSample, endSample). */
  query(instance: number, startSample: number, endSample: number): number[] {
    const list = this.byInst[instance];
    const maxEnd = this.maxEnd[instance];
    if (!list || !maxEnd) return [];
    const { start, end } = this.result.annotations;

    // Upper bound: first entry whose start is >= endSample.
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (start[list[mid]!]! < endSample) lo = mid + 1; else hi = mid;
    }
    const upper = lo;

    // Lower bound: first entry whose running max end exceeds startSample.
    lo = 0; hi = upper;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (maxEnd[mid]! <= startSample) lo = mid + 1; else hi = mid;
    }

    const out: number[] = [];
    for (let j = lo; j < upper; j++) {
      const i = list[j]!;
      if (end[i]! > startSample && start[i]! < endSample) out.push(i);
    }
    return out;
  }
}

/**
 * Indices of annotations overlapping [startSample, endSample) for one
 * instance. Scans; for repeated queries (i.e. every frame) build an
 * `AnnotationIndex` once instead.
 */
export function annotationsInRange(
  r: DecodeResult, instance: number, startSample: number, endSample: number,
): number[] {
  const { count, start, end, inst } = r.annotations;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (inst[i] !== instance) continue;
    if (end[i]! <= startSample || start[i]! >= endSample) continue;
    out.push(i);
  }
  return out;
}
