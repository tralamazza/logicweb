/**
 * Browser entry for the sample-store benchmark. Target is Brave (Chromium), which is the
 * only WebUSB-capable browser on this machine, so it is the only browser whose numbers
 * mean anything for this project.
 *
 * Served by serve.mjs with COOP/COEP so that
 * performance.measureUserAgentSpecificMemory() is available; without cross-origin
 * isolation it is not, and the run falls back to performance.memory and says so.
 */

import { runBench, type MemSample, type BenchReport } from './bench.js';
import { runFastSuite, testNarrowGlitch, formatResults, type TestResult } from '../selftest.js';

declare global {
  interface Performance {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number; breakdown: unknown[] }>;
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }
}

const out = document.getElementById('out') as HTMLPreElement;
const lines: string[] = [];

function log(s: string): void {
  lines.push(s);
  out.textContent += s + '\n';
  out.scrollTop = out.scrollHeight;
}

/** Yield to the event loop so the log actually paints between phases. */
const breathe = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const EXACT_LABELS = new Set(['baseline', 'planar peak', 'planar released', 'interleaved built']);

async function sampleMemory(label: string): Promise<MemSample | null> {
  await breathe();
  const exact = performance.measureUserAgentSpecificMemory;
  if (exact && crossOriginIsolated && EXACT_LABELS.has(label)) {
    const r = await exact.call(performance);
    log(`  [mem] ${label}: ${(r.bytes / 1e6).toFixed(0)} MB (measureUserAgentSpecificMemory)`);
    return { method: 'performance.measureUserAgentSpecificMemory', bytes: r.bytes };
  }
  const pm = performance.memory;
  if (pm) {
    log(`  [mem] ${label}: ${(pm.usedJSHeapSize / 1e6).toFixed(0)} MB (performance.memory proxy)`);
    return { method: 'performance.memory.usedJSHeapSize (proxy)', bytes: pm.usedJSHeapSize };
  }
  log(`  [mem] ${label}: no memory API available`);
  return null;
}

async function post(path: string, body: unknown): Promise<void> {
  try {
    await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    log(`could not post results: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const totalSamples = Number(params.get('samples') ?? 100_000_000);
  const bins = Number(params.get('bins') ?? 1000);

  log(`logicweb sample store benchmark`);
  log(`userAgent: ${navigator.userAgent}`);
  log(`crossOriginIsolated: ${crossOriginIsolated}` +
      `, measureUserAgentSpecificMemory: ${performance.measureUserAgentSpecificMemory ? 'yes' : 'no'}`);
  log(`hardwareConcurrency: ${navigator.hardwareConcurrency}`);
  log('');

  // Benchmark first, correctness second. The correctness suite builds five separate 100M
  // stores; running it first leaves the heap large and fragmented and made the measured
  // append rate read 50 MSa/s here against 344 MSa/s in node, which was the suite's
  // shadow, not the store's speed.
  log('--- benchmark ---');
  let report: BenchReport | null = null;
  let error: string | null = null;
  try {
    report = await runBench({ totalSamples, chunkSamples: 1 << 20, bins, log, sampleMemory });
  } catch (err) {
    error = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    log(`BENCH FAILED: ${error}`);
  }
  log('');

  const tests: TestResult[] = [];
  log('--- correctness suite ---');
  tests.push(...runFastSuite(log));
  log('--- 1-sample glitch at full scale ---');
  // Positions that hit the awkward alignments, derived from the capture length so this
  // still works when the page is opened with a small ?samples=: the very first sample, a
  // pyramid bin boundary, the sample just before one, an odd position mid-bin, and the
  // very last sample.
  const binAligned = Math.max(65_536, Math.floor(totalSamples / 2 / 65_536) * 65_536);
  const pulses = [...new Set([
    0,
    binAligned,
    binAligned - 1,
    Math.floor(totalSamples * 0.371) | 1,
    totalSamples - 1,
  ])].filter((p) => p >= 0 && p < totalSamples).sort((a, b) => a - b);
  log(`  pulse positions: ${pulses.join(', ')}`);
  for (const pulse of pulses) {
    tests.push(...testNarrowGlitch(log, totalSamples, [pulse]));
    await breathe();
  }
  log(formatResults(tests));

  log('');
  log('done');
  await post('/result', {
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    hasExactMemory: !!performance.measureUserAgentSpecificMemory,
    tests, report, error, log: lines,
  });
}

main().catch(async (err) => {
  log(`FATAL: ${String(err)}`);
  await post('/result', { fatal: String(err), log: lines });
});
