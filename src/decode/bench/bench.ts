/**
 * In-browser decode benchmark and known-answer check.
 *
 * Exposes `window.runDecodeBench()`; `tools/browser-bench.mjs` drives it over
 * CDP so the numbers come from a script that can be re-run, not from eyeballing
 * devtools.
 *
 * Measures:
 *   coldStartMs   worker construction to the first annotation, Pyodide load
 *                 included - the number a user actually waits for
 *   annPerSec     steady-state throughput on a fixed capture
 *   decoderCount  stock decoders available
 * and verifies the decoded bytes against the transmitted message, so a fast
 * wrong answer cannot pass.
 */

import { DecodeClient, decoderCount, getDecoder, validateStack, MAX_SAMPLE } from '../index';
import type { DecodeResult, DecoderInstance } from '../types';
import { makeI2cCapture, makeUartCapture, MESSAGE, SAMPLERATE, BAUDRATE } from './fixture';
import hwCaptures from './hwfixture';

export interface BenchResult {
  ok: boolean;
  error?: string;
  decoderCount: number;
  captureSamples: number;
  coldStartMs: number;
  coldAnnotations: number;
  warmDecodeMs: number;
  warmAnnotations: number;
  annPerSec: number;
  /** Saturated 5 s of 115200 8N1 - the workload where the UI freeze showed up.
   *  Measured so the browser/native ratio is quoted on identical stimulus. */
  heavyBytes: number;
  heavyAnnotations: number;
  heavyDecodeMs: number;
  heavyAnnPerSec: number;
  pyodideLoadMs: number;
  transferMs: number;
  bytesDecoded: number;
  bytesExpected: number;
  bytesMatch: boolean;
  stackCheck: string;
  /** Decoder-stack check: i2c -> eeprom24xx through the public client API. */
  stackOk: boolean;
  stackAnnotations: number;
  stackedAnnotations: number;
  stackSample: string[];
  /** Cancellation and bounds - a decode must never be able to wedge the UI. */
  cancelOk: boolean;
  cancelMs: number;
  cancelMode: string;
  timeoutOk: boolean;
  reusableAfterCancel: boolean;
  limitsOk: boolean;
  limitErrors: string[];
  /** Known-answer checks on REAL captured signal, one per protocol. */
  hw: HwCheck[];
  hwOk: boolean;
}

export interface HwCheck {
  protocol: string;
  /** What the signal generator was commanded to emit. */
  command: string;
  expected: string;
  decoded: string;
  match: boolean;
  annotations: number;
  /** Warm decode time for this capture, for comparison against the previous
   *  per-analyzer time on equivalent traffic. */
  decodeMs: number;
}

/** Pull the uart decoder's data annotations back out as bytes. */
function decodedBytes(r: DecodeResult): number[] {
  const info = getDecoder('uart');
  const dataCls = info.annotations.findIndex(a => a.id === 'rx-data');
  const out: number[] = [];
  const { count, cls, textOffset, texts } = r.annotations;
  for (let i = 0; i < count; i++) {
    if (cls[i] !== dataCls) continue;
    out.push(parseInt(texts[textOffset[i]!]!, 16));
  }
  return out;
}

export async function runDecodeBench(repeats = 80): Promise<BenchResult> {
  const cap = makeUartCapture(repeats);
  const res: BenchResult = {
    ok: false, decoderCount, captureSamples: cap.length,
    coldStartMs: 0, coldAnnotations: 0, warmDecodeMs: 0, warmAnnotations: 0,
    annPerSec: 0, pyodideLoadMs: 0, transferMs: 0,
    heavyBytes: 0, heavyAnnotations: 0, heavyDecodeMs: 0, heavyAnnPerSec: 0,
    bytesDecoded: 0, bytesExpected: cap.bytes.length, bytesMatch: false,
    stackCheck: '', stackOk: false, stackAnnotations: 0, stackedAnnotations: 0,
    stackSample: [],
    cancelOk: false, cancelMs: 0, cancelMode: '', timeoutOk: false,
    reusableAfterCancel: false, limitsOk: false, limitErrors: [],
    hw: [], hwOk: false,
  };

  const stack = [{ id: 'uart', channels: { 0: 0 }, options: { baudrate: BAUDRATE } }];
  const problems = validateStack(stack, 1);
  res.stackCheck = problems.join('; ');
  if (problems.length) { res.error = 'stack rejected: ' + res.stackCheck; return res; }

  const request = {
    samplerate: SAMPLERATE,
    length: cap.length,
    channels: [{ edges: cap.edges, initial: cap.initial }],
    stack,
  };

  // Cold start is measured on a *small* capture so it reports time-to-first-
  // annotation - worker spawn, Pyodide load, decoder import - and not the cost
  // of decoding 4 M samples. Throughput is measured separately, below.
  const small = makeUartCapture(1);
  const smallRequest = {
    samplerate: SAMPLERATE, length: small.length,
    channels: [{ edges: small.edges, initial: small.initial }], stack,
  };

  // t0 is before the client exists: worker construction is part of what the
  // user waits for, and excluding it would understate cold start.
  const t0 = performance.now();
  const client = new DecodeClient();
  try {
    const cold = await client.decode(structuredClone(smallRequest));
    res.coldStartMs = performance.now() - t0;
    res.coldAnnotations = cold.annotations.count;
    res.pyodideLoadMs = client.loadMs;
    res.transferMs = res.coldStartMs - client.loadMs - cold.decodeMs;
    if (cold.errors.length) { res.error = cold.errors.join('\n'); return res; }

    // Warm: interpreter up, decoders imported. Best of three.
    let best = Infinity, ann = 0;
    for (let i = 0; i < 3; i++) {
      const r = await client.decode(structuredClone(request));
      if (r.errors.length) { res.error = r.errors.join('\n'); return res; }
      if (r.decodeMs < best) best = r.decodeMs;
      ann = r.annotations.count;

      if (i === 0) {
        const got = decodedBytes(r);
        res.bytesDecoded = got.length;
        const want = Array.from(cap.bytes);
        res.bytesMatch = got.length === want.length && got.every((b, j) => b === want[j]);
      }
    }
    res.warmDecodeMs = best;
    res.warmAnnotations = ann;
    res.annPerSec = Math.round(ann / (best / 1000));

    if (!res.bytesMatch) {
      res.error = `decoded ${res.bytesDecoded} bytes, expected ${res.bytesExpected}, ` +
        `content ${res.bytesMatch ? 'matches' : 'differs'} - message was ${JSON.stringify(MESSAGE)}`;
      return res;
    }
    // Decoder stack: eeprom24xx consumes i2c's OUTPUT_PYTHON stream. This runs
    // through the same public client API the UI uses, not a test back door.
    const i2c = makeI2cCapture(0x50, [0x00, 0xDE, 0xAD, 0xBE, 0xEF]);
    const stackSpec = [
      { id: 'i2c', channels: { 0: 0, 1: 1 } },
      { id: 'eeprom24xx', channels: {}, stackOn: 0 },
    ];
    const stackProblems = validateStack(stackSpec, 2);
    if (stackProblems.length) { res.error = 'stack rejected: ' + stackProblems.join('; '); return res; }

    const sr = await client.decode({
      samplerate: SAMPLERATE, length: i2c.length,
      channels: [i2c.scl, i2c.sda], stack: stackSpec,
    });
    if (sr.errors.length) { res.error = 'stack decode: ' + sr.errors.join('\n'); return res; }
    res.stackAnnotations = sr.annotations.count;
    let stacked = 0;
    const sample: string[] = [];
    for (let i = 0; i < sr.annotations.count; i++) {
      if (sr.annotations.inst[i] !== 1) continue;
      stacked++;
      if (sample.length < 6) sample.push(sr.annotations.texts[sr.annotations.textOffset[i]!]!);
    }
    res.stackedAnnotations = stacked;
    res.stackSample = sample;
    res.stackOk = stacked > 0;
    if (!res.stackOk) {
      res.error = `stacked decoder produced no annotations (i2c produced ${res.stackAnnotations})`;
      return res;
    }

    // 5 s of saturated 115200 8N1 = 57 600 bytes. This is the workload that
    // used to freeze the worker for ~7 s with no way out; it is measured here
    // so the browser/native ratio is quoted on stimulus of the same size.
    const sat = makeUartCapture(Math.ceil(57600 / MESSAGE.length));
    const satRes = await client.decode({
      samplerate: SAMPLERATE, length: sat.length,
      channels: [{ edges: sat.edges, initial: sat.initial }], stack,
    }, { timeoutMs: 60000 });
    if (satRes.errors.length) { res.error = satRes.errors.join('\n'); return res; }
    res.heavyBytes = sat.bytes.length;
    res.heavyAnnotations = satRes.annotations.count;
    res.heavyDecodeMs = satRes.decodeMs;
    res.heavyAnnPerSec = Math.round(satRes.annotations.count / (satRes.decodeMs / 1000));

    // --- bounds: a decode must never be able to wedge the UI ---------------
    // A big capture with an absurdly slow baud makes uart grind for a long
    // time; abort it and require the client to come back promptly and still
    // be usable afterwards.
    const heavy = makeUartCapture(400);
    const heavyReq = {
      samplerate: SAMPLERATE, length: heavy.length,
      channels: [{ edges: heavy.edges, initial: heavy.initial }], stack,
    };
    const abort = new AbortController();
    const tc = performance.now();
    setTimeout(() => abort.abort(), 60);
    try {
      await client.decode(structuredClone(heavyReq), { signal: abort.signal, timeoutMs: 0 });
      res.error = 'cancel: decode completed instead of aborting';
      return res;
    } catch (e) {
      res.cancelMs = performance.now() - tc;
      res.cancelOk = (e as Error).name === 'DecodeCancelledError';
      res.cancelMode = client.hardCancels > 0 ? 'worker-restart' : 'interrupt-buffer';
      if (!res.cancelOk) { res.error = 'cancel: unexpected ' + (e as Error).name + ': ' + (e as Error).message; return res; }
    }

    // The client must still work after a cancel, whichever path was taken.
    const after = await client.decode(structuredClone(smallRequest));
    res.reusableAfterCancel = after.annotations.count === res.coldAnnotations;
    if (!res.reusableAfterCancel) { res.error = 'client unusable after cancel'; return res; }

    // A timeout must fire and be reported as such.
    try {
      await client.decode(structuredClone(heavyReq), { timeoutMs: 60 });
      res.error = 'timeout: decode completed instead of timing out';
      return res;
    } catch (e) {
      res.timeoutOk = (e as Error).name === 'DecodeTimeoutError';
      if (!res.timeoutOk) { res.error = 'timeout: unexpected ' + (e as Error).name; return res; }
    }
    await client.decode(structuredClone(smallRequest));   // still usable

    // --- documented limits must be refused, not crashed into ----------------
    const limitProbes: [string, () => Promise<unknown>][] = [
      ['sample range past int32', () => client.decode({
        ...structuredClone(smallRequest), length: MAX_SAMPLE + 1,
      })],
      // Exercise the real budget check without allocating 48 M edges: a
      // throwaway client configured with a tiny budget.
      ['edge budget', async () => {
        const tiny = new DecodeClient({ edgeBudget: 10 });
        try { return await tiny.decode(structuredClone(request)); }
        finally { tiny.dispose(); }
      }],
    ];
    let refusals = 0;
    for (const [what, run] of limitProbes) {
      try { await run(); res.limitErrors.push(`${what}: accepted, expected refusal`); }
      catch (e) {
        const m = (e as Error).message;
        if (/exceeds the/.test(m)) refusals++;
        else res.limitErrors.push(`${what}: wrong error ${m.slice(0, 120)}`);
      }
    }
    res.limitsOk = res.limitErrors.length === 0 && refusals === limitProbes.length;

    // --- known-answer checks on REAL captured signal -----------------------
    // Channel map measured on this bench: D9 = GP17 UART TX, D10/D11/D12 =
    // GP19/GP20/GP21 SPI SCK/MOSI/CS, D13/D15 = GP22/GP26 I2C SCL/SDA.
    const hwStacks: Record<string, { stack: DecoderInstance[]; cls: string }> = {
      uart: { stack: [{ id: 'uart', channels: { 0: 9 }, options: { baudrate: 115200 } }], cls: 'rx-data' },
      // spi channel order is clk, miso, mosi, cs - MOSI is index 2.
      spi:  { stack: [{ id: 'spi', channels: { 0: 10, 2: 11, 3: 12 } }], cls: 'mosi-data' },
      i2c:  { stack: [{ id: 'i2c', channels: { 0: 13, 1: 15 } }], cls: 'data-write' },
    };
    for (const [proto, cap] of Object.entries(hwCaptures)) {
      const spec = hwStacks[proto]!;
      const problems = validateStack(spec.stack, cap.channels.length);
      if (problems.length) { res.error = `hw ${proto}: ${problems.join('; ')}`; return res; }
      const hwRes = await client.decode({
        samplerate: cap.samplerate,
        length: cap.samples,
        channels: cap.channels.map(c => ({
          edges: Int32Array.from(c.edges), initial: c.initial,
        })),
        stack: spec.stack,
      });
      if (hwRes.errors.length) { res.error = `hw ${proto}: ${hwRes.errors.join('\n')}`; return res; }

      const info = getDecoder(spec.stack[0]!.id);
      const want = info.annotations.findIndex(a => a.id === spec.cls);
      const got: number[] = [];
      const a = hwRes.annotations;
      for (let i = 0; i < a.count; i++) {
        if (a.cls[i] !== want) continue;
        // sigrok emits text variants longest-first, so the *last* is the bare
        // value: i2c's data-write is ['Data write: 00', 'DW: 00', '00'].
        // Using the last variant is also what a narrow renderer lane shows.
        const variants = a.texts.slice(a.textOffset[i]!, a.textOffset[i + 1]!);
        got.push(parseInt(variants[variants.length - 1]!, 16));
      }
      const hex = (xs: number[]) => xs.map(x => x.toString(16).padStart(2, '0')).join(' ');
      res.hw.push({
        protocol: proto, command: cap.command,
        expected: hex(cap.expect), decoded: hex(got),
        match: hex(got) === hex(cap.expect), annotations: a.count,
        decodeMs: hwRes.decodeMs,
      });
    }
    res.hwOk = res.hw.length === 3 && res.hw.every(h => h.match);
    if (!res.hwOk) {
      res.error = 'hw known-answer mismatch: ' +
        res.hw.filter(h => !h.match)
          .map(h => `${h.protocol} expected [${h.expected}] got [${h.decoded}]`).join('; ');
      return res;
    }

    res.ok = res.cancelOk && res.timeoutOk && res.reusableAfterCancel && res.limitsOk && res.hwOk;
    if (!res.ok && !res.error) res.error = 'bounds checks failed: ' + res.limitErrors.join('; ');
    return res;
  } finally {
    client.terminate();
  }
}

declare global {
  interface Window { runDecodeBench: typeof runDecodeBench; benchResult?: BenchResult }
}
window.runDecodeBench = runDecodeBench;

// Auto-run so the page is useful when opened by hand too.
const el = document.getElementById('out');
runDecodeBench().then(r => {
  window.benchResult = r;
  if (el) el.textContent = JSON.stringify(r, null, 2);
}).catch(e => {
  const r = { ok: false, error: String(e?.stack || e) } as unknown as BenchResult;
  window.benchResult = r;
  if (el) el.textContent = JSON.stringify(r, null, 2);
});
