/// <reference lib="webworker" />
/**
 * Decode worker.
 *
 * Owns a Pyodide interpreter running the stock libsigrokdecode `.py` decoders
 * against `py/sigrokdecode.py`, our reimplementation of the `sigrokdecode`
 * module that the C core normally provides. Nothing here is a reimplementation
 * of a protocol - every decoder that runs is the unmodified upstream file out
 * of `decoders/decoders.zip`.
 *
 * Pyodide is loaded lazily on the first decode, not at worker start, because
 * listing and configuring decoders only needs `decoders/manifest.json`, which
 * the main thread already has.
 */

import sigrokdecodePy from './py/sigrokdecode.py?raw';
import srdenginePy from './py/srdengine.py?raw';
import { getDecoder } from './registry';
import { EDGE_BUDGET, MAX_SAMPLE } from './limits';
import type { Annotations, DecodeRequest, DecodeResult } from './types';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

interface PyodideAPI {
  FS: {
    writeFile(path: string, data: Uint8Array | string): void;
    mkdir(path: string): void;
  };
  runPython(code: string, opts?: { globals?: unknown }): any;
  toPy(obj: unknown): any;
  setInterruptBuffer(buf: Uint8Array): void;
}

/**
 * Cooperative cancellation.
 *
 * Pyodide polls this buffer from inside the interpreter loop; writing 2 makes
 * the *currently running* runPython raise KeyboardInterrupt. That is the only
 * way to abort a decode without destroying the interpreter, and it is the
 * moral equivalent of libsigrokdecode's srd_session_terminate_reset().
 *
 * It needs a SharedArrayBuffer, which needs cross-origin isolation
 * (COOP/COEP). Where that is unavailable the client falls back to killing and
 * respawning the worker, so cancellation always works - it is just more
 * expensive, costing a Pyodide reload.
 */
let interruptBuffer: Uint8Array | null = null;

function installInterruptBuffer(py: PyodideAPI) {
  if (typeof SharedArrayBuffer !== 'undefined') {
    try {
      interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
      py.setInterruptBuffer(interruptBuffer);
    } catch {
      interruptBuffer = null;   // not cross-origin isolated
    }
  }
  // Tell the client either way: a null buffer means "cancellation has to kill
  // the worker", which the client reports through hardCancels.
  self.postMessage({ type: 'interrupt-buffer', id: 0, buffer: interruptBuffer });
}

let pyodide: PyodideAPI | null = null;
let loading: Promise<PyodideAPI> | null = null;
/*
 * Both of these were absolute ('/pyodide/', '/decoders/decoders.zip'), which pins the app
 * to a domain ROOT: hosted at example.com/logicweb/ they resolve to example.com/pyodide/
 * and 404, so decoding dies while the rest of the app looks fine.
 *
 * BASE_URL is what `vite build --base=/logicweb/` bakes in, and it defaults to '/', so at
 * a domain root nothing changes. It must stay an ABSOLUTE path: a relative base like './'
 * would resolve against the worker script's own URL (/assets/), not the document, and
 * point at /assets/pyodide/. That is why the build does not simply set `base: './'`.
 */
let config = {
  pyodideIndexURL: `${import.meta.env.BASE_URL}pyodide/`,
  decodersURL: `${import.meta.env.BASE_URL}decoders/decoders.zip`,
  edgeBudget: EDGE_BUDGET,
};
let loadMs = 0;

async function getPyodide(): Promise<PyodideAPI> {
  if (pyodide) return pyodide;
  if (loading) return loading;

  loading = (async () => {
    const t0 = performance.now();
    // Loading Pyodide is the one genuinely awkward part of the packaging, so
    // it is worth stating why it looks like this.
    //
    //   * Bundling pyodide's ESM entry makes Vite code-split the worker, and
    //     its default worker.format of 'iife' cannot code-split. worker.format
    //     lives in a root vite.config.ts, which this module does not own.
    //   * A classic worker fixes the production build but breaks `vite` dev,
    //     which serves classic workers unbundled, import statements and all.
    //   * A plain dynamic import of /pyodide/pyodide.mjs works in production
    //     but 500s in dev, because the dev server appends ?import to it.
    //
    // Fetching the module text and importing it from a blob URL sidesteps all
    // three: Vite has no static edge to follow and never rewrites a blob: URL.
    // Pyodide locates its own siblings as `${indexURL}pyodide.asm.mjs`, an
    // absolute URL, so loading the entry from a blob is safe as long as
    // indexURL is passed - which it is.
    const entryURL = config.pyodideIndexURL + 'pyodide.mjs';
    const entryRes = await fetch(entryURL);
    if (!entryRes.ok) {
      throw new Error(
        `fetching ${entryURL} failed: ${entryRes.status} ${entryRes.statusText} - ` +
        `run: node src/decode/tools/vendor-assets.mjs <libsigrokdecode/decoders>`);
    }
    const blobURL = URL.createObjectURL(
      new Blob([await entryRes.text()], { type: 'text/javascript' }));
    let loadPyodide: (o: { indexURL: string }) => Promise<unknown>;
    try {
      ({ loadPyodide } = await import(/* @vite-ignore */ blobURL));
    } finally {
      URL.revokeObjectURL(blobURL);
    }
    if (typeof loadPyodide !== 'function') {
      throw new Error(`${entryURL} did not export loadPyodide`);
    }
    const py = await loadPyodide({ indexURL: config.pyodideIndexURL }) as PyodideAPI;

    const res = await fetch(config.decodersURL);
    if (!res.ok) {
      throw new Error(`fetching ${config.decodersURL} failed: ${res.status} ${res.statusText}`);
    }
    const zip = new Uint8Array(await res.arrayBuffer());
    py.FS.writeFile('/decoders.zip', zip);
    py.FS.mkdir('/srd');
    py.FS.writeFile('/srd/sigrokdecode.py', sigrokdecodePy);
    py.FS.writeFile('/srd/srdengine.py', srdenginePy);

    // zipimport handles the decoder packages straight out of the zip, which is
    // what libsigrokdecode itself does for zipped decoder sets.
    py.runPython(`
import sys
sys.path.insert(0, '/srd')
sys.path.insert(0, '/decoders.zip')
import srdengine
`);
    installInterruptBuffer(py);
    loadMs = performance.now() - t0;
    pyodide = py;
    return py;
  })();

  try {
    return await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

function toTyped(buf: unknown): ArrayBuffer {
  // Pyodide hands `bytes` over as a Uint8Array view on its heap; copy out so
  // the buffer survives and can be transferred.
  const u8 = buf as Uint8Array;
  return u8.slice().buffer;
}

async function decode(req: DecodeRequest): Promise<DecodeResult> {
  const py = await getPyodide();

  if (!req.stack.length) throw new Error('decode: empty decoder stack');
  if (!(req.samplerate > 0)) throw new Error(`decode: bad samplerate ${req.samplerate}`);
  if (!(req.length > 0)) throw new Error(`decode: bad length ${req.length}`);

  // Sample numbers are exported as int32. Refuse a range that cannot be
  // represented rather than letting packed_results() raise OverflowError from
  // somewhere the caller cannot interpret. At 200 MSa/s this is a 10.7 s
  // capture, so it is reachable on this project's own hardware; decode a
  // sub-range and offset the annotations.
  if (req.length > MAX_SAMPLE) {
    throw new Error(
      `decode: range of ${req.length} samples exceeds the int32 annotation ` +
      `limit of ${MAX_SAMPLE}. Decode a sub-range.`);
  }

  req.stack.forEach((inst, i) => {
    if (inst.stackOn !== undefined && !(inst.stackOn >= 0 && inst.stackOn < i)) {
      throw new Error(
        `decode: stack[${i}] (${inst.id}) stacks on ${inst.stackOn}, which must be an earlier entry`);
    }
  });

  // Only marshal channels some decoder in the stack actually reads. Copying an
  // edge list into Pyodide costs real time - on a 16-channel 2 M-edge capture,
  // marshalling the 14 channels an i2c decode never touches was 34% of total
  // wall time - and the decoders cannot observe the difference because an
  // unmapped channel is never indexed.
  const used = new Set<number>();
  for (const inst of req.stack) {
    for (const v of Object.values(inst.channels ?? {})) {
      if (v >= 0) used.add(v);
    }
  }

  let edgeTotal = 0;
  for (const c of used) edgeTotal += req.channels[c]?.edges.length ?? 0;
  // Each edge costs 29-35 bytes of wasm32 heap once it is a Python int in a
  // list, against a hard 4 GB address space. Past roughly 80 M edges Pyodide
  // does not fail cleanly - it corrupts and returns garbage - so stop short of
  // that with an error the caller can act on.
  if (edgeTotal > config.edgeBudget) {
    throw new Error(
      `decode: ${edgeTotal} edges across ${used.size} channel(s) exceeds the ` +
      `${config.edgeBudget} edge budget (~${Math.round(config.edgeBudget * 35 / 1e6)} MB ` +
      `of wasm heap). Decode a narrower sample range or fewer channels.`);
  }

  // Unused channels cross as empty lists, which is cheap and legal.
  const signals = req.channels.map((c, i) =>
    used.has(i) ? [Array.from(c.edges), c.initial] : [[], c.initial]);

  const specs = req.stack.map((inst, i) => ({
    id: inst.id,
    instanceId: inst.instanceId ?? `${inst.id}-${i + 1}`,
    channels: inst.channels ?? {},
    options: inst.options ?? {},
    stackOn: inst.stackOn ?? -1,
  }));

  if (interruptBuffer) interruptBuffer[0] = 0;   // clear a stale cancel

  const t0 = performance.now();
  let raw;
  try {
    raw = py.runPython(
      `
import srdengine
S = srdengine.Session(SR, LENGTH, SIGNALS, eof_mode=EOF_MODE)
for spec in SPECS:
    S.add(spec['id'], spec['instanceId'], spec['channels'], spec['options'],
          stack_on=(None if spec['stackOn'] < 0 else spec['stackOn']))
errs = S.run()
p = S.packed_results()
p['errors'] = errs
p
`,
      {
        globals: py.toPy({
          SR: req.samplerate, LENGTH: req.length, SIGNALS: signals, SPECS: specs,
          EOF_MODE: req.eofMode ?? 'raise',
        }),
      },
    );
  } catch (e) {
    // A cancel arrives as KeyboardInterrupt out of the interpreter loop.
    if (String((e as Error)?.message ?? '').includes('KeyboardInterrupt')) {
      throw new Error('decode cancelled');
    }
    throw e;
  }
  const decodeMs = performance.now() - t0;

  const obj = raw.toJs({ create_proxies: false, dict_converter: Object.fromEntries });
  raw.destroy();

  const count: number = obj.count;
  const annotations: Annotations = {
    count,
    start: new Int32Array(toTyped(obj.start)),
    end: new Int32Array(toTyped(obj.end)),
    inst: new Uint16Array(toTyped(obj.inst)),
    cls: new Uint16Array(toTyped(obj.cls)),
    textOffset: new Int32Array(toTyped(obj.textOffset)),
    texts: obj.texts as string[],
  };

  // Instance metadata comes from the build-time manifest, not from a fresh
  // describe() per decode: it is static, and re-deriving it inside Pyodide on
  // every request duplicated data the main thread already had.
  const instances = req.stack.map(s => getDecoder(s.id));

  return { annotations, instances, errors: obj.errors as string[], decodeMs };
}

function transferables(r: DecodeResult): Transferable[] {
  const a = r.annotations;
  return [a.start.buffer, a.end.buffer, a.inst.buffer, a.cls.buffer, a.textOffset.buffer];
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  const reply = (r: WorkerResponse, t?: Transferable[]) => self.postMessage(r, t ?? []);
  try {
    switch (msg.type) {
      case 'configure':
        config = { ...config, ...msg.config };
        reply({ type: 'configured', id: msg.id });
        break;
      case 'warmup': {
        await getPyodide();
        reply({ type: 'ready', id: msg.id, loadMs });
        break;
      }
      case 'describe': {
        const py = await getPyodide();
        const info = JSON.parse(py.runPython(
          `import json, srdengine; json.dumps(srdengine.describe(${JSON.stringify(msg.decoderId)}))`));
        reply({ type: 'described', id: msg.id, info });
        break;
      }
      case 'decode': {
        const result = await decode(msg.request);
        reply({ type: 'decoded', id: msg.id, result, loadMs }, transferables(result));
        break;
      }
      default: {
        const bad = msg as { type: string };
        throw new Error(`unknown worker message type ${JSON.stringify(bad.type)}`);
      }
    }
  } catch (e) {
    // No silent catch: everything the worker cannot do comes back as an error
    // message with the Python traceback intact.
    const err = e as Error;
    reply({
      type: 'failed',
      id: (msg as { id: number }).id,
      message: err?.message ?? String(e),
      stack: err?.stack ?? '',
    });
  }
};
