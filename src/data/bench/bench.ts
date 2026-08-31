/**
 * The measurement harness for src/data.
 *
 * Two rules, both learned from published numbers that turned out to be wrong:
 *
 * 1. **Every comparison happens inside one run of one environment.** The first version of
 *    this file measured the two storage layouts in separate phases, and an earlier
 *    NOTES.md ended up dividing planar-measured-in-node by interleaved-measured-in-browser.
 *    Every ratio in that table was inflated, some by 2.5x. The head-to-head now builds
 *    both stores, keeps both resident, and alternates A/B/A/B inside each timing round, so
 *    both layouts see the same machine, the same cache pressure, and the same moment in
 *    time. The ratio is what is being measured; absolutes are secondary and are labelled
 *    with the fact that a second store was resident.
 *
 * 2. **Stability is anchored to an absolute reference, not to self-consistency.** The old
 *    check re-measured its own first row at the end of the same phase. That catches drift
 *    *within* a phase and certifies a uniformly slow machine as perfectly stable - which
 *    is exactly what it did, returning ratio 1.02 on a run whose numbers were 1.6x worse
 *    than the run being quoted. There is now a fixed reference workload with a fixed cost,
 *    measured at every phase boundary; if it moves, the run says so.
 */

import { PlanarSampleStore } from '../planarStore.js';
import { InterleavedSampleStore } from '../interleavedStore.js';
import { generateCapture } from '../generator.js';
import { testGeneratedGlitch, type TestResult } from '../selftest.js';
import type { SampleStore } from '../types.js';

const now = (): number => performance.now();

/** Timed loops report the best of this many repeats. Contention only ever adds time. */
const REPEATS = 5;

// ---------------------------------------------------------------------------
// Absolute machine reference

const REF_WORDS = 1 << 20; // 4 MiB, past L2, so it responds to memory pressure too
let refBuf: Int32Array | null = null;

/**
 * A fixed workload with a fixed cost, independent of everything in src/data. Its job is to
 * answer "was the machine the same speed when those two numbers were taken", which no
 * amount of self-consistency checking can answer.
 *
 * It has to be warmed before it is trusted. The first version was not, and it read 17.8 ms
 * at the start of a run and 1.3 ms at the end - a 13x "drift" that was this function being
 * promoted out of the interpreter, not the machine changing. An instrument built to
 * separate machine speed from JIT tier that is itself confounded by JIT tier is worse than
 * no instrument, because it reports NOT STABLE on a stable machine and gets ignored.
 */
function referencePass(): number {
  const a = refBuf!;
  let acc = 0;
  const t0 = now();
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < REF_WORDS; i++) acc = (acc + Math.imul(a[i]!, 2246822519)) | 0;
  }
  const ms = now() - t0;
  if (acc === 0x7fffffff) throw new Error('unreachable; keeps acc live');
  return ms;
}

function machineReference(): number {
  if (refBuf === null) {
    refBuf = new Int32Array(REF_WORDS);
    for (let i = 0; i < REF_WORDS; i++) refBuf[i] = (i * 2654435761) | 0;
    // Warm to the top tier before the first reading is ever used.
    for (let i = 0; i < 12; i++) referencePass();
  }
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const ms = referencePass();
    if (ms < best) best = ms;
  }
  return best;
}

/** Burn CPU so a freshly scheduled renderer is promoted before anything is timed. */
function settle(ms: number): number {
  const t0 = now();
  let x = 1;
  while (now() - t0 < ms) {
    for (let i = 0; i < 200000; i++) x = (Math.imul(x, 1103515245) + 12345) | 0;
  }
  return x;
}

// ---------------------------------------------------------------------------

export interface MemSample {
  method: string;
  bytes: number;
}

export interface BenchOptions {
  totalSamples: number;
  chunkSamples: number;
  bins: number;
  log: (s: string) => void;
  sampleMemory: (label: string) => Promise<MemSample | null>;
}

export interface BuildResult {
  name: string;
  genMs: number;
  appendMs: number;
  appendMSaPerSec: number;
  appendBestMSaPerSec: number;
  baseBytes: number;
  pyramidBytes: number;
  totalBytes: number;
  overhead: number;
  tabBytes: MemSample | null;
  machineRefMs: number;
}

export interface AbRow {
  width: number;
  bins: number;
  samplesPerBin: number;
  level: number;
  planarFrameUs: number;
  interFrameUs: number;
  planarMedianUs: number;
  interMedianUs: number;
  planarWorstUs: number;
  interWorstUs: number;
}

/** Frame cost against column count, at a fixed viewport. */
export interface BinsRow {
  bins: number;
  width: number;
  planarFrameUs: number;
  interFrameUs: number;
  usPerColumn: number;
}

export interface AbEdges {
  channel: number;
  planarMs: number;
  interMs: number;
  count: number;
}

export interface CoreBinsRow {
  coreBins: number;
  planarFullUs: number;
  interFullUs: number;
  planarMidUs: number;
  interMidUs: number;
}

export interface Verdict {
  claim: string;
  measured: string;
  held: boolean;
  verifiable: boolean;
}

export interface BenchReport {
  environment: string;
  totalSamples: number;
  channelCount: number;
  bins: number;
  machineRef: { label: string; ms: number }[];
  machineSpread: number;
  machineStable: boolean;
  builds: BuildResult[];
  /** The zoom sweep, run at every column count in `binsList`. */
  ab: AbRow[];
  binsList: number[];
  binsSweep: BinsRow[];
  abEdges: AbEdges[];
  coreBinsSweep: CoreBinsRow[];
  bestCoreBins: { planar: number; interleaved: number };
  tunedHeadline: { planarFullUs: number; interFullUs: number; planarMidUs: number; interMidUs: number };
  snapCompare: { exactFrameUs: number; snapFrameUs: number };
  scalingCheck: { widthA: number; usA: number; widthB: number; usB: number; ratio: number };
  tests: TestResult[];
  predictionVerdicts: Verdict[];
}

function zoomWidths(total: number): number[] {
  return [total, 10_000_000, 1_000_000, 100_000, 10_000, 1_000, 300, 100]
    .filter((w) => w <= total && w >= 1);
}

function itersFor(width: number): number {
  return width > 1_000_000 ? 120 : 800;
}

/** Which pyramid level a viewport selects, for the record. */
function levelFor(samplesPerBin: number, coreBins: number): number {
  let k = 0;
  while (k < 6 && Math.pow(16, k + 1) * coreBins <= samplesPerBin) k++;
  return k;
}

// ---------------------------------------------------------------------------
// Timing primitives: each runs one store once, the A/B driver interleaves them.

function frameOnce(store: SampleStore, width: number, bins: number, total: number, iters: number): number {
  const nch = store.channelCount;
  const span = Math.max(1, total - width);
  const stride = Math.max(1, Math.floor(span / iters));
  let start = 0;
  const t0 = now();
  for (let i = 0; i < iters; i++) {
    for (let c = 0; c < nch; c++) store.query(c, start, start + width, bins);
    start = (start + stride) % (span + 1);
  }
  return ((now() - t0) * 1000) / iters;
}

function channelOnce(
  store: SampleStore, ch: number, width: number, bins: number, total: number, iters: number,
): number {
  const span = Math.max(1, total - width);
  const stride = Math.max(1, Math.floor(span / iters));
  let start = 0;
  const t0 = now();
  for (let i = 0; i < iters; i++) {
    store.query(ch, start, start + width, bins);
    start = (start + stride) % (span + 1);
  }
  return ((now() - t0) * 1000) / iters;
}

/**
 * Alternate two measurements inside each repeat round and return the best of each.
 * Interleaving is the point: a contention spike then hits both sides, not just one.
 */
function ab(fa: () => number, fb: () => number, repeats = REPEATS): [number, number] {
  let bestA = Infinity;
  let bestB = Infinity;
  fa(); fb(); // warm both before either is scored
  for (let r = 0; r < repeats; r++) {
    const a = fa();
    const b = fb();
    if (a < bestA) bestA = a;
    if (b < bestB) bestB = b;
  }
  return [bestA, bestB];
}

function warmup(store: SampleStore, total: number, bins: number): void {
  const widths = [total, Math.floor(total / 10), 1_000_000, 100_000, 1000, 100]
    .filter((w) => w >= 1 && w <= total);
  for (let r = 0; r < 60; r++) {
    for (const w of widths) {
      const start = (r * 977) % Math.max(1, total - w + 1);
      for (let c = 0; c < store.channelCount; c++) store.query(c, start, start + w, bins);
    }
  }
  store.edges(0, 0, Math.min(total, 200_000));
  store.edges(14, 0, Math.min(total, 200_000));
}

// ---------------------------------------------------------------------------

type MeasurableStore = SampleStore & {
  memory(): { baseBytes: number; pyramidBytes: number; totalBytes: number; overhead: number };
};

interface Built<T> { store: T; genMs: number; appendMs: number; best: number }

function build<T extends MeasurableStore>(make: () => T, opts: BenchOptions): Built<T> {
  const { totalSamples, chunkSamples } = opts;
  const store = make();
  const it = generateCapture({ totalSamples, chunkSamples });
  let genMs = 0;
  let appendMs = 0;
  let best = 0;
  let idx = 0;
  for (;;) {
    const t0 = now();
    const r = it.next();
    const t1 = now();
    genMs += t1 - t0;
    if (r.done) break;
    const samples = r.value.byteLength / 2;
    store.append(r.value);
    const dt = now() - t1;
    appendMs += dt;
    // Skip the first few chunks: that is the JIT warming up, not the machine.
    if (idx++ >= 4 && dt > 0) {
      const rate = samples / dt / 1000;
      if (rate > best) best = rate;
    }
  }
  if (store.length !== totalSamples) throw new Error(`built ${store.length}, wanted ${totalSamples}`);
  return { store, genMs, appendMs, best };
}

/**
 * Build both stores alternately, several rounds, and keep the best round for each.
 *
 * Alternating matters for the same reason it matters in the query A/B: building planar
 * once and interleaved once, back to back, hands whichever one landed in a contention
 * window a worse number. The absolute machine reference caught exactly that - one run had
 * the two builds bracketed by reference readings of 21.0 ms and 1.2 ms, which makes those
 * two append rates simply not comparable. Alternating and taking the best round per store
 * removes the ordering bias; the memory figure is taken once per store with only that
 * store resident, because two 228 MB stores at once is not a memory measurement of either.
 */
async function buildBothAlternating(
  opts: BenchOptions, rounds: number,
): Promise<[BuildResult, BuildResult]> {
  const { totalSamples, log } = opts;
  const makePlanar = () => new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
  const makeInter = () => new InterleavedSampleStore(100e6);

  let pBest: Built<PlanarSampleStore> | null = null;
  let qBest: Built<InterleavedSampleStore> | null = null;
  let pMem = { baseBytes: 0, pyramidBytes: 0, totalBytes: 0, overhead: 0 };
  let qMem = { baseBytes: 0, pyramidBytes: 0, totalBytes: 0, overhead: 0 };
  let pTab: MemSample | null = null;
  let qTab: MemSample | null = null;

  for (let r = 0; r < rounds; r++) {
    {
      const b = build(makePlanar, opts);
      if (pBest === null || b.appendMs < pBest.appendMs) pBest = b;
      pMem = b.store.memory();
      if (r === 0) pTab = await opts.sampleMemory('planar resident');
    }
    {
      const b = build(makeInter, opts);
      if (qBest === null || b.appendMs < qBest.appendMs) qBest = b;
      qMem = b.store.memory();
      if (r === 0) qTab = await opts.sampleMemory('interleaved resident');
    }
  }

  const pack = (
    name: string, b: Built<MeasurableStore>,
    mem: { baseBytes: number; pyramidBytes: number; totalBytes: number; overhead: number },
    tab: MemSample | null,
  ): BuildResult => {
    log(`  ${name}: generate ${b.genMs.toFixed(0)} ms, append+pyramid ${b.appendMs.toFixed(0)} ms ` +
        `(${(totalSamples / b.appendMs / 1000).toFixed(0)} MSa/s avg, ${b.best.toFixed(0)} MSa/s best chunk) ` +
        `over ${rounds} alternating rounds, best kept; accounted ${(mem.totalBytes / 1e6).toFixed(1)} MB ` +
        `(base ${(mem.baseBytes / 1e6).toFixed(1)} + pyramid ${(mem.pyramidBytes / 1e6).toFixed(1)}, ` +
        `${(mem.overhead * 100).toFixed(1)}% overhead)`);
    return {
      name,
      genMs: b.genMs,
      appendMs: b.appendMs,
      appendMSaPerSec: totalSamples / b.appendMs / 1000,
      appendBestMSaPerSec: b.best,
      baseBytes: mem.baseBytes,
      pyramidBytes: mem.pyramidBytes,
      totalBytes: mem.totalBytes,
      overhead: mem.overhead,
      tabBytes: tab,
      machineRefMs: machineReference(),
    };
  };

  return [
    pack('planar', pBest as Built<MeasurableStore>, pMem, pTab),
    pack('interleaved', qBest as Built<MeasurableStore>, qMem, qTab),
  ];
}

// ---------------------------------------------------------------------------

export const PREDICTIONS = [
  { claim: 'P1 full zoom-out (100M across, 1000 columns): median channel under 100 us' },
  { claim: 'P2 full zoom-out worst channel under 400 us' },
  { claim: 'P3 full zoom-out 16-channel frame under 1.5 ms, i.e. inside a 60 fps budget' },
  { claim: 'P4 query is O(bins): 1000x more samples across costs under 3x the time' },
  { claim: 'P5 pyramid overhead under 15% of the base plane bytes' },
  { claim: 'P6 append sustains at least 100 MSa/s including the pyramid update' },
  { claim: 'P7 process/tab stays under 600 MB with a 100M x 16 capture resident' },
];

export async function runBench(opts: BenchOptions): Promise<BenchReport> {
  const { totalSamples, bins, log } = opts;
  const environment = typeof navigator === 'undefined' ? 'node' : navigator.userAgent;

  log('--- prediction, stated before any measurement ---');
  for (const p of PREDICTIONS) log(`  ${p.claim}`);
  log('');
  log(`environment: ${environment}`);
  log('every number below comes from this one run in this one environment');

  settle(4000);
  const machineRef: { label: string; ms: number }[] = [];
  const mark = (label: string): number => {
    const ms = machineReference();
    machineRef.push({ label, ms });
    log(`  [machine ref] ${label}: ${ms.toFixed(1)} ms`);
    return ms;
  };
  mark('start');

  // ---- Phase 1: build and memory, alternating, one store resident at a time --
  log('phase 1: build and memory, stores built alternately over 3 rounds, best round kept');
  await opts.sampleMemory('baseline');
  const [planarBuild, interBuild] = await buildBothAlternating(opts, 3);
  mark('after builds');

  // ---- Phase 2: A/B speed, both resident -----------------------------------
  log('phase 2: head-to-head, both stores resident, A/B interleaved within every round');
  const p = build(() => new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 }), opts).store;
  const q = build(() => new InterleavedSampleStore(100e6), opts).store;
  await opts.sampleMemory('both stores resident');
  warmup(p, totalSamples, bins);
  warmup(q, totalSamples, bins);
  // Re-settle: sampleMemory() forces a GC and yields, which drops the renderer's priority.
  // Timing immediately after that is what produced the old "first sweep reads 13x slow"
  // pathology, which the previous version retried around instead of fixing.
  settle(1500);
  mark('phase 2 start');

  // The whole zoom sweep is run at every column count the application actually uses.
  // 1000 was the number the predictions were written against; 3200 is what the renderer
  // reports for a wide window, and reporting only the cheaper one would understate the
  // cost of the operating point the app really runs at.
  const binsList = [bins, 3200].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  const abRows: AbRow[] = [];
  for (const nb of binsList) {
    log(`  --- ${nb} columns ---`);
    for (const width of zoomWidths(totalSamples)) {
      const iters = itersFor(width);
      const [pf, qf] = ab(
        () => frameOnce(p, width, nb, totalSamples, Math.max(20, iters >> 2)),
        () => frameOnce(q, width, nb, totalSamples, Math.max(20, iters >> 2)),
      );
      const pch: number[] = [];
      const qch: number[] = [];
      for (let c = 0; c < 16; c++) {
        const [a, b] = ab(
          () => channelOnce(p, c, width, nb, totalSamples, iters),
          () => channelOnce(q, c, width, nb, totalSamples, iters),
          3,
        );
        pch.push(a);
        qch.push(b);
      }
      const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
      const mx = (xs: number[]): number => xs.reduce((a, b) => (b > a ? b : a), 0);
      const row: AbRow = {
        width,
        bins: nb,
        samplesPerBin: width / nb,
        level: levelFor(width / nb, 32),
        planarFrameUs: pf, interFrameUs: qf,
        planarMedianUs: med(pch), interMedianUs: med(qch),
        planarWorstUs: mx(pch), interWorstUs: mx(qch),
      };
      abRows.push(row);
      log(`  ${String(width).padStart(9)} across (level ${row.level}): ` +
          `planar ${row.planarMedianUs.toFixed(1)} us/ch frame ${(row.planarFrameUs / 1000).toFixed(3)} ms | ` +
          `interleaved ${row.interMedianUs.toFixed(1)} us/ch frame ${(row.interFrameUs / 1000).toFixed(3)} ms | ` +
          `planar ${(row.interFrameUs / row.planarFrameUs).toFixed(2)}x`);
    }
    const rows = abRows.filter((r) => r.bins === nb);
    const fullRow = rows[0]!;
    const panRows = rows.filter((r) => r.width !== totalSamples);
    const worstPan = panRows.reduce((a, b) => (b.planarFrameUs > a.planarFrameUs ? b : a), panRows[0]!);
    log(`  at ${nb} columns: full zoom-out ${(fullRow.planarFrameUs / 1000).toFixed(3)} ms/frame, ` +
        `worst while panning ${(worstPan.planarFrameUs / 1000).toFixed(3)} ms at ` +
        `${worstPan.width.toLocaleString()} across, ` +
        `full zoom-out costs ${(fullRow.planarFrameUs / worstPan.planarFrameUs).toFixed(1)}x the pan phase`);
  }

  // Frame cost against column count at the two extreme viewports. query is O(bins), so
  // this should be close to linear with a flat offset - and if the renderer sees 4.1 ms
  // at 3200 columns, this is the row that has to explain it.
  log('column-count sweep (query is O(bins), so this is the shape that matters)');
  const binsSweep: BinsRow[] = [];
  for (const nb of [500, 1000, 1920, 3200, 6400]) {
    for (const width of [totalSamples, 10_000_000]) {
      const iters = width === totalSamples ? 30 : 30;
      const [pf, qf] = ab(
        () => frameOnce(p, width, nb, totalSamples, iters),
        () => frameOnce(q, width, nb, totalSamples, iters),
        3,
      );
      binsSweep.push({ bins: nb, width, planarFrameUs: pf, interFrameUs: qf, usPerColumn: pf / nb / 16 });
      log(`  ${String(nb).padStart(4)} columns, ${width.toLocaleString()} across: ` +
          `planar ${(pf / 1000).toFixed(3)} ms/frame (${(pf / nb / 16).toFixed(3)} us per column per channel) | ` +
          `interleaved ${(qf / 1000).toFixed(3)} ms`);
    }
  }

  const abEdgeRows: AbEdges[] = [];
  for (const ch of [0, 8, 12, 14]) {
    const count = p.edges(ch, 0, totalSamples).length;
    const [pm, qm] = ab(
      () => { const t = now(); p.edges(ch, 0, totalSamples); return now() - t; },
      () => { const t = now(); q.edges(ch, 0, totalSamples); return now() - t; },
      3,
    );
    abEdgeRows.push({ channel: ch, planarMs: pm, interMs: qm, count });
    log(`  edges ch${ch} (${count} edges): planar ${pm.toFixed(1)} ms | ` +
        `interleaved ${qm.toFixed(1)} ms | planar ${(qm / pm).toFixed(1)}x`);
  }
  mark('after A/B sweep');

  // coreBins sweep over BOTH stores. Sweeping only the winner's constant and leaving the
  // loser's hardcoded is a handicap, not a comparison.
  log('coreBins sweep, both stores over the same range (first pass discarded)');
  const cbValues = [1, 2, 4, 8, 16, 32, 64, 128, 256];
  let coreBinsSweep: CoreBinsRow[] = [];
  for (let pass = 0; pass < 2; pass++) {
    coreBinsSweep = [];
    for (const cb of cbValues) {
      p.coreBins = cb;
      q.coreBins = cb;
      const [pf, qf] = ab(
        () => frameOnce(p, totalSamples, bins, totalSamples, 30),
        () => frameOnce(q, totalSamples, bins, totalSamples, 30),
        3,
      );
      const [pm, qm] = ab(
        () => frameOnce(p, 1_000_000, bins, totalSamples, 120),
        () => frameOnce(q, 1_000_000, bins, totalSamples, 120),
        3,
      );
      coreBinsSweep.push({ coreBins: cb, planarFullUs: pf, interFullUs: qf, planarMidUs: pm, interMidUs: qm });
      if (pass === 1) {
        log(`  coreBins=${String(cb).padStart(3)}: full-zoom planar ${(pf / 1000).toFixed(3)} ms ` +
            `interleaved ${(qf / 1000).toFixed(3)} ms | 1M-across planar ${(pm / 1000).toFixed(3)} ms ` +
            `interleaved ${(qm / 1000).toFixed(3)} ms`);
      }
    }
  }
  const argmin = (pick: (r: CoreBinsRow) => number): number =>
    coreBinsSweep.reduce((b, r) => (pick(r) < pick(b) ? r : b), coreBinsSweep[0]!).coreBins;
  const bestPlanar = argmin((r) => r.planarFullUs + r.planarMidUs);
  const bestInter = argmin((r) => r.interFullUs + r.interMidUs);
  log(`  best coreBins: planar ${bestPlanar}, interleaved ${bestInter}`);

  // Requote the two headline rows with each store at its own best setting.
  p.coreBins = bestPlanar;
  q.coreBins = bestInter;
  const [pFullBest, qFullBest] = ab(
    () => frameOnce(p, totalSamples, bins, totalSamples, 30),
    () => frameOnce(q, totalSamples, bins, totalSamples, 30),
  );
  const [pMidBest, qMidBest] = ab(
    () => frameOnce(p, 1_000_000, bins, totalSamples, 120),
    () => frameOnce(q, 1_000_000, bins, totalSamples, 120),
  );
  log(`  each store at its own best coreBins: full-zoom planar ${(pFullBest / 1000).toFixed(3)} ms vs ` +
      `interleaved ${(qFullBest / 1000).toFixed(3)} ms (planar ${(qFullBest / pFullBest).toFixed(2)}x); ` +
      `1M-across planar ${(pMidBest / 1000).toFixed(3)} ms vs interleaved ${(qMidBest / 1000).toFixed(3)} ms ` +
      `(planar ${(qMidBest / pMidBest).toFixed(2)}x)`);
  p.coreBins = 32;

  const exactFrameUs = frameOnce(p, totalSamples, bins, totalSamples, 40);
  p.snapColumns = true;
  const snapFrameUs = frameOnce(p, totalSamples, bins, totalSamples, 40);
  p.snapColumns = false;
  log(`  exact columns ${(exactFrameUs / 1000).toFixed(3)} ms/frame, ` +
      `snapped ${(snapFrameUs / 1000).toFixed(3)} ms/frame`);

  const usA = frameOnce(p, 100_000, bins, totalSamples, 300);
  const usB = frameOnce(p, totalSamples, bins, totalSamples, 40);
  log(`  scaling: 100,000 across (level ${levelFor(100, 32)}) ${(usA / 1000).toFixed(3)} ms/frame, ` +
      `${totalSamples.toLocaleString()} across (level ${levelFor(totalSamples / bins, 32)}) ` +
      `${(usB / 1000).toFixed(3)} ms/frame, ratio ${(usB / usA).toFixed(2)}x for 1000x the samples`);

  log('correctness on the built capture');
  const tests = testGeneratedGlitch(p, log);
  for (const t of tests) log(`  ${t.pass ? 'PASS' : 'FAIL'} ${t.name}: ${t.detail}`);

  const refEnd = mark('end');
  const refs = machineRef.map((m) => m.ms);
  const spread = Math.max(...refs) / Math.min(...refs);
  // Split the verdict. A spread across the whole run only invalidates comparisons made
  // *across* phases; every head-to-head number is an A/B alternation inside one phase and
  // survives a machine that was slow for all of it. Reporting one global "stable" flag
  // would either discard good data or bless bad data.
  const p2 = machineRef.slice(machineRef.findIndex((m) => m.label === 'phase 2 start')).map((m) => m.ms);
  const phase2Spread = Math.max(...p2) / Math.min(...p2);
  const machineStable = phase2Spread < 1.25;
  log(`machine reference: ${machineRef.map((m) => `${m.label} ${m.ms.toFixed(1)}ms`).join(', ')}`);
  log(`  whole-run spread ${spread.toFixed(2)}x (${refs[0]!.toFixed(1)} -> ${refEnd.toFixed(1)} ms); ` +
      `phase-2 spread ${phase2Spread.toFixed(2)}x`);
  log(`  ${machineStable ? 'phase 2 was stable: every A/B head-to-head number is valid'
                         : 'PHASE 2 DRIFTED: treat even the A/B numbers as approximate'}` +
      (spread >= 1.25
        ? '. Whole-run spread is high, so do not compare a phase-1 number against a phase-2 number.'
        : '.'));

  // The predictions were written against 1000 columns, so they are judged against 1000
  // columns. The 3200-column rows are reported separately rather than folded in here.
  const full = abRows.find((r) => r.bins === bins && r.width === totalSamples)!;
  const verdicts = judge(full, planarBuild, usA, usB, machineStable);
  for (const v of verdicts) {
    const tag = !v.verifiable ? 'N/A  ' : v.held ? 'HELD ' : 'MISS ';
    log(`${tag} ${v.claim}\n        measured: ${v.measured}`);
  }

  return {
    environment,
    totalSamples,
    channelCount: 16,
    bins,
    machineRef,
    machineSpread: spread,
    machineStable,
    builds: [planarBuild, interBuild],
    ab: abRows,
    binsList,
    binsSweep,
    abEdges: abEdgeRows,
    coreBinsSweep,
    bestCoreBins: { planar: bestPlanar, interleaved: bestInter },
    tunedHeadline: {
      planarFullUs: pFullBest, interFullUs: qFullBest, planarMidUs: pMidBest, interMidUs: qMidBest,
    },
    snapCompare: { exactFrameUs, snapFrameUs },
    scalingCheck: { widthA: 100_000, usA, widthB: totalSamples, usB, ratio: usB / usA },
    tests,
    predictionVerdicts: verdicts,
  };
}

function judge(
  full: AbRow, planar: BuildResult, usA: number, usB: number, machineStable: boolean,
): Verdict[] {
  const out: Verdict[] = [];
  const add = (i: number, held: boolean, measured: string, verifiable = true) =>
    out.push({ claim: PREDICTIONS[i]!.claim, measured, held, verifiable });
  const peak = planar.tabBytes;
  add(0, full.planarMedianUs < 100, `${full.planarMedianUs.toFixed(1)} us`);
  add(1, full.planarWorstUs < 400, `${full.planarWorstUs.toFixed(1)} us`);
  add(2, full.planarFrameUs < 1500,
      `${(full.planarFrameUs / 1000).toFixed(3)} ms (measured with the second store also resident)`);
  add(3, usB / usA < 3, `${(usB / usA).toFixed(2)}x`);
  add(4, planar.overhead < 0.15, `${(planar.overhead * 100).toFixed(1)}%`);
  add(5, planar.appendMSaPerSec >= 100,
      `${planar.appendMSaPerSec.toFixed(0)} MSa/s average, ` +
      `${planar.appendBestMSaPerSec.toFixed(0)} MSa/s best chunk` +
      (machineStable ? '' : ' - machine was NOT stable this run'));
  add(6, peak !== null && peak.bytes < 600e6,
      peak ? `${(peak.bytes / 1e6).toFixed(0)} MB via ${peak.method}` : 'no tab-level memory API here',
      peak !== null);
  return out;
}
