// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Sustained pan/zoom framerate on a 100M-sample 16-channel capture.
 *
 * Method, stated before the numbers so it can be attacked:
 *
 * - Real Brave, headed, real GPU. Headless with SwiftShader would measure a software
 *   rasteriser and would be worthless for a WebGL claim.
 * - The frame clock is the requestAnimationFrame timestamp, which is what the compositor
 *   actually did, not what we wish it did. A separate untimed loop measures pure CPU work
 *   per frame so the vsync ceiling can be told apart from a slow renderer.
 * - Every phase is run REPEATS times and the best run is reported, with the full spread.
 *   This machine runs several agents at once and the data builder measured a 1.11 ms
 *   frame as 9.59 ms under contention. Best-of-N is the only honest reading when the
 *   noise is one-sided (contention can only make things slower).
 * - A stability re-check re-runs the first phase at the end. If the two medians disagree
 *   by more than 15% the whole run is flagged `contended` and the numbers must not be
 *   quoted. Reporting a contaminated number as a result is worse than reporting nothing.
 * - document.visibilityState is asserted visible. A backgrounded tab throttles rAF to
 *   1 Hz and would otherwise silently produce "1 fps".
 */

import { PlanarSampleStore } from '../../data/planarStore.js';
import { generateCapture } from '../../data/generator.js';
import { WaveformRenderer } from '../waveformRenderer.js';

const params = new URLSearchParams(location.search);
const TOTAL = Number(params.get('samples') ?? 100_000_000);
const CSS_W = Number(params.get('w') ?? 1600);
const CSS_H = Number(params.get('h') ?? 720);
const FRAMES = Number(params.get('frames') ?? 240);
const REPEATS = Number(params.get('repeats') ?? 5);

const log: string[] = [];
function say(s: string): void {
  log.push(s);
  const pre = document.getElementById('out');
  if (pre) pre.textContent = log.join('\n');
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]!;
}

const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));

/** Display refresh ceiling, so "60 fps" can be distinguished from "vsync-limited". */
async function measureVsync(): Promise<number> {
  const dt: number[] = [];
  let prev = await raf();
  for (let i = 0; i < 120; i++) {
    const t = await raf();
    dt.push(t - prev);
    prev = t;
  }
  return median(dt);
}

export interface PhaseResult {
  name: string;
  /** Best of REPEATS, by median CPU time per frame. */
  fps: number;
  frameMsMedian: number;
  frameMsP95: number;
  frameMsP99: number;
  /**
   * Fraction of frames whose CPU time inside render() alone exceeded the vsync budget.
   * This is the real miss criterion - see the comment on `runPhase`.
   */
  overBudgetFraction: number;
  /** Fraction of frames using more than 80% of the budget on CPU alone. */
  nearBudgetFraction: number;
  /** Fraction of frames whose compositor interval exceeded 1.5 vsync. Kept, not trusted. */
  lateIntervalFraction: number;
  cpuMsMax: number;
  /** Median wall clock inside render(), i.e. our CPU cost, GPU excluded. */
  cpuMsMedian: number;
  cpuMsP95: number;
  /** Median of store.query() time for all 16 channels, inside cpuMs. */
  queryMsMedian: number;
  /** Median fps of every repeat, worst to best - the spread contention produces. */
  allFps: number[];
  /** Median CPU ms of every repeat, in run order. The honest picture of the spread. */
  allCpuMedians: number[];
}

type Driver = (r: WaveformRenderer, frame: number) => void;

async function runPhase(
  r: WaveformRenderer,
  name: string,
  setup: () => void,
  drive: Driver,
  vsyncMs: number,
): Promise<PhaseResult> {
  const runs: { intervals: number[]; cpu: number[]; query: number[] }[] = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    setup();
    // Warm up: first frames after a viewport change pay for shader/texture state and a
    // cold pyramid walk, and including them measures startup, not sustained rate.
    for (let i = 0; i < 10; i++) {
      drive(r, i);
      r.render();
      await raf();
    }
    const intervals: number[] = [];
    const cpu: number[] = [];
    const query: number[] = [];
    let prev = await raf();
    for (let i = 0; i < FRAMES; i++) {
      drive(r, i);
      const st = r.render();
      cpu.push(st.totalMs);
      query.push(st.queryMs);
      const t = await raf();
      intervals.push(t - prev);
      prev = t;
    }
    runs.push({ intervals, cpu, query });
    say(`  ${name} rep ${rep + 1}/${REPEATS}: ${(1000 / median(intervals)).toFixed(1)} fps, cpu ${median(cpu).toFixed(2)} ms`);
  }
  // Rank runs by CPU time, not by frame interval.
  //
  // Sorting on the interval is sorting on a key that vsync has pinned: every rep reads
  // 120.5 fps, the comparator sees ties in float noise, and the "best" run is arbitrary.
  // On the published round-2 table that picked the SLOWEST of five reps - per-rep CPU
  // medians 5.70/4.40/4.40/4.80/4.50, published 5.70 - while the notes claimed
  // best-of-N was honest because contention only slows things down. The rationale was
  // right and the sort key made it false.
  runs.sort((a, b) => median(a.cpu) - median(b.cpu));
  const best = runs[0]!;

  // A frame is missed when the work does not fit in one vsync interval, NOT when the
  // compositor interval exceeds 1.5 of them.
  //
  // The old >=1.5x criterion cannot see a frame that misses one vsync but not two, which
  // is the entire interesting range: injecting a 10 ms stall into 10% of frames against
  // an 8.30 ms interval produced a render() max of 15.0 ms and this detector reported
  // 0.00% dropped, still reading 120.5 fps. It only fires at 20 ms.
  //
  // render().totalMs > vsyncMs is a lower bound on missing - it counts only CPU, before
  // any GPU work or compositing - so anything it flags is definitely late.
  const over = best.cpu.filter((v) => v > vsyncMs).length / best.cpu.length;
  const near = best.cpu.filter((v) => v > vsyncMs * 0.8).length / best.cpu.length;
  const late = best.intervals.filter((v) => v > vsyncMs * 1.5).length / best.intervals.length;
  return {
    name,
    fps: 1000 / median(best.intervals),
    frameMsMedian: median(best.intervals),
    frameMsP95: percentile(best.intervals, 95),
    frameMsP99: percentile(best.intervals, 99),
    overBudgetFraction: over,
    nearBudgetFraction: near,
    lateIntervalFraction: late,
    cpuMsMax: Math.max(...best.cpu),
    cpuMsMedian: median(best.cpu),
    cpuMsP95: percentile(best.cpu, 95),
    queryMsMedian: median(best.query),
    allFps: runs.map((x) => 1000 / median(x.intervals)).sort((a, b) => a - b),
    allCpuMedians: runs.map((x) => Number(median(x.cpu).toFixed(3))),
  };
}

/**
 * Control for the miss detector itself.
 *
 * Stalls the CPU for `stallMs` on one frame in ten and checks that the detector fires.
 * Without this the detector is an untested instrument: the previous >=1.5-vsync
 * criterion sat at 0.00% through a 15 ms frame and nothing in the harness noticed.
 * A detector that cannot be shown to detect anything is not evidence.
 */
async function detectorControl(r: WaveformRenderer, vsyncMs: number, stallMs: number) {
  r.setViewport(0, 1_000_000);
  const cpu: number[] = [];
  for (let i = 0; i < 120; i++) {
    const st = r.render();
    let extra = 0;
    if (i % 10 === 0) {
      const until = performance.now() + stallMs;
      while (performance.now() < until) { /* burn CPU, do not yield */ }
      extra = stallMs;
    }
    cpu.push(st.totalMs + extra);
    await raf();
  }
  const over = cpu.filter((v) => v > vsyncMs).length / cpu.length;
  return {
    stallMs,
    injectedFraction: 0.1,
    detectedFraction: Number(over.toFixed(4)),
    cpuMsMax: Number(Math.max(...cpu).toFixed(2)),
    detects: over >= 0.08,
  };
}

async function main(): Promise<void> {
  if (document.visibilityState !== 'visible') {
    (globalThis as unknown as { __result: unknown }).__result = {
      kind: 'render-fps',
      ok: false,
      error: `document.visibilityState is ${document.visibilityState}; rAF is throttled and any fps number would be a lie`,
    };
    return;
  }

  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${CSS_W}px`;
  canvas.style.height = `${CSS_H}px`;

  say(`building ${TOTAL.toLocaleString()} samples x 16 channels...`);
  const t0 = performance.now();
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100_000_000 });
  for (const chunk of generateCapture({ totalSamples: TOTAL, chunkSamples: 1 << 20 })) {
    store.append(chunk);
  }
  const buildMs = performance.now() - t0;
  say(`built in ${(buildMs / 1000).toFixed(2)} s, ${store.length.toLocaleString()} samples`);

  const r = new WaveformRenderer({ canvas, store, devicePixelRatio: dpr });
  r.resize(CSS_W, CSS_H);
  say(`canvas ${r.widthDevicePx} x ${r.heightDevicePx} device px (dpr ${dpr}), ${r.getChannels().length} rows`);

  const vsyncMs = await measureVsync();
  say(`display refresh: ${(1000 / vsyncMs).toFixed(1)} Hz (${vsyncMs.toFixed(3)} ms)`);

  const N = store.length;
  const phases: PhaseResult[] = [];

  // 1. Whole capture on screen, redrawn every frame. 100M samples across ~3200 columns
  //    is ~31,000 samples per column - the deepest the pyramid ever has to go.
  phases.push(
    await runPhase(r, 'redraw-full-zoom-out', () => r.setViewport(0, N), () => {}, vsyncMs),
  );

  // 2. Continuous pan at 1M samples on screen. This is the drag the brief names.
  phases.push(
    await runPhase(
      r,
      'pan-1M-span',
      () => r.setViewport(0, 1_000_000),
      (rr, i) => {
        if (i % 200 === 199) rr.setViewport(0, 1_000_000);
        else rr.panPixels(8);
      },
      vsyncMs,
    ),
  );

  // 3. Continuous pan while fully zoomed out. Every column is a different 31k-sample
  //    window, so nothing can be cached frame to frame.
  phases.push(
    await runPhase(
      r,
      'pan-full-zoom-out',
      () => r.setViewport(0, N / 2),
      (rr, i) => {
        if (i % 200 === 199) rr.setViewport(0, N / 2);
        else rr.panPixels(8);
      },
      vsyncMs,
    ),
  );

  // 4. Continuous zoom, centred, sweeping the whole range from the 20-sample clamp to
  //    the whole capture and back. Each frame is a different pyramid level.
  phases.push(
    await runPhase(
      r,
      'zoom-sweep',
      () => r.setViewport(0, N),
      (rr, i) => {
        const phase = (i % 120) / 120;
        const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
        const span = Math.exp(Math.log(20) + tri * (Math.log(N) - Math.log(20)));
        const c = N / 2;
        rr.setViewport(c - span / 2, c + span / 2);
      },
      vsyncMs,
    ),
  );

  // 5. Live capture: append while rendering, with follow mode on.
  //
  // The canvas swap matters. This phase used to draw into #c2, which the stylesheet
  // parked at left:-10000px, while #c - the only canvas on screen - was not drawn at
  // all. The compositor therefore had nothing to present and the phase measured the rAF
  // cadence of an idle page, not a live capture. #c is hidden and #c2 shown for the
  // duration so the frames actually reach the screen, and the phase now runs REPEATS
  // times like every other one.
  const mainCanvas = document.getElementById('c') as HTMLCanvasElement;
  const liveCanvas = document.getElementById('c2') as HTMLCanvasElement;
  liveCanvas.style.width = `${CSS_W}px`;
  liveCanvas.style.height = `${CSS_H}px`;
  mainCanvas.style.display = 'none';
  liveCanvas.style.display = 'block';
  // Give the compositor a frame to notice the swap before anything is timed.
  await raf();
  await raf();

  const CHUNK = 1 << 20;
  const LIVE_FRAMES = Math.min(FRAMES, 150);
  const liveRuns: { intervals: number[]; cpu: number[] }[] = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    const liveStore = new PlanarSampleStore({ channelCount: 16, samplerate: 100_000_000 });
    const liveR = new WaveformRenderer({ canvas: liveCanvas, store: liveStore, devicePixelRatio: dpr });
    liveR.resize(CSS_W, CSS_H);
    const gen = generateCapture({ totalSamples: CHUNK * (LIVE_FRAMES + 20), chunkSamples: CHUNK });
    liveStore.append(gen.next().value as Uint8Array);
    liveR.setViewport(0, 10_000_000);
    liveR.setFollowLatest(true);
    for (let i = 0; i < 10; i++) {
      const w = gen.next();
      if (!w.done) liveStore.append(w.value);
      liveR.render();
      await raf();
    }
    const intervals: number[] = [];
    const cpu: number[] = [];
    let prev = await raf();
    for (let i = 0; i < LIVE_FRAMES; i++) {
      const w = gen.next();
      if (!w.done) liveStore.append(w.value);
      const fst = liveR.render();
      cpu.push(fst.totalMs);
      const t = await raf();
      intervals.push(t - prev);
      prev = t;
    }
    liveRuns.push({ intervals, cpu });
    say(`  live-append rep ${rep + 1}/${REPEATS}: ${(1000 / median(intervals)).toFixed(1)} fps, cpu ${median(cpu).toFixed(2)} ms, ${liveStore.length.toLocaleString()} samples`);
    liveR.dispose();
  }
  mainCanvas.style.display = 'block';
  liveCanvas.style.display = 'none';
  await raf();

  liveRuns.sort((a, b) => median(a.cpu) - median(b.cpu));
  const lb = liveRuns[0]!;
  phases.push({
    name: 'live-append-1MSa-per-frame',
    fps: 1000 / median(lb.intervals),
    frameMsMedian: median(lb.intervals),
    frameMsP95: percentile(lb.intervals, 95),
    frameMsP99: percentile(lb.intervals, 99),
    overBudgetFraction: lb.cpu.filter((v) => v > vsyncMs).length / lb.cpu.length,
    nearBudgetFraction: lb.cpu.filter((v) => v > vsyncMs * 0.8).length / lb.cpu.length,
    lateIntervalFraction: lb.intervals.filter((v) => v > vsyncMs * 1.5).length / lb.intervals.length,
    cpuMsMax: Math.max(...lb.cpu),
    cpuMsMedian: median(lb.cpu),
    cpuMsP95: percentile(lb.cpu, 95),
    queryMsMedian: NaN,
    allFps: liveRuns.map((x) => 1000 / median(x.intervals)).sort((a, b) => a - b),
    allCpuMedians: liveRuns.map((x) => Number(median(x.cpu).toFixed(3))),
  });

  // Span sweep: cost as a function of visible span ONLY.
  //
  // This exists to settle a disagreement with the sample store. I reported full zoom-out
  // as 4.2x the cost of "the pan phase", the store measured 1.2x at 3200 columns and
  // 0.7x at 1000 - i.e. it found panning WORSE than full zoom-out at 1000 columns.
  //
  // My two phases differed in more than zoom: `redraw-full-zoom-out` re-rendered a static
  // 100M-sample view while `pan-1M-span` panned a 1M-sample view every frame. Comparing
  // them attributes to zoom level a difference that also contains pan-vs-static and a
  // 100x span change. Here every point pans by the same 8 px/frame at the same column
  // count and only the span changes, so the ratio means what it says.
  const spanSweep: { span: number; columns: number; cpuMsMedian: number; cpuMsP95: number }[] = [];
  for (const columns of [3200, 1000]) {
    const cssW = columns / dpr;
    r.resize(cssW, CSS_H);
    for (const span of [1e4, 1e5, 1e6, 1e7, 1e8]) {
      const sp = Math.min(span, N);
      r.setViewport(0, sp);
      for (let i = 0; i < 15; i++) { r.render(); r.panPixels(8); }
      const cpu: number[] = [];
      for (let i = 0; i < 150; i++) {
        if (i % 100 === 99) r.setViewport(0, sp);
        else r.panPixels(8);
        cpu.push(r.render().totalMs);
        await raf();
      }
      spanSweep.push({
        span: sp,
        columns: r.widthDevicePx,
        cpuMsMedian: Number(median(cpu).toFixed(3)),
        cpuMsP95: Number(percentile(cpu, 95).toFixed(3)),
      });
      say(`  span-sweep ${r.widthDevicePx} cols, span ${sp.toExponential(0)}: cpu ${median(cpu).toFixed(2)} ms`);
    }
  }
  r.resize(CSS_W, CSS_H);

  // Control the miss detector at two stall sizes: one that misses a single vsync (the
  // range the old criterion was blind to) and one that misses two.
  const detector = [
    await detectorControl(r, vsyncMs, 10),
    await detectorControl(r, vsyncMs, 20),
  ];
  for (const d of detector) {
    say(`  detector control: ${d.stallMs} ms stall on 10% of frames -> detected ${(d.detectedFraction * 100).toFixed(1)}%, max cpu ${d.cpuMsMax} ms, ${d.detects ? 'FIRES' : 'BLIND'}`);
  }

  // Stability re-check: repeat phase 1 and compare.
  //
  // The first version of this compared fps, and it was useless: fps is pinned to the
  // vsync interval, so it reads exactly 120.5 whether the machine is idle or has a
  // 99%-CPU sigrok-cli next to it. It can only detect contention severe enough to drop
  // frames. The comparison is on CPU time per frame, which is what contention actually
  // moves, and fps is kept only as a second opinion.
  const recheck = await runPhase(r, 'recheck-full-zoom-out', () => r.setViewport(0, N), () => {}, vsyncMs);
  // Compare the MEDIAN of each rep set, not the fastest rep of each.
  //
  // Comparing best-against-best is comparing the two least contended moments in each
  // window, which is exactly the comparison least able to detect contention. On the
  // round-2 data best-vs-best gave 9.1% and passed the 15% gate, while median-vs-median
  // on the same reps gave 19.3% and worst-vs-worst 38% - so the published table passed
  // its own quality gate on the choice of estimator.
  const p1med = median(phases[0]!.allCpuMedians);
  const rcmed = median(recheck.allCpuMedians);
  const cpuDrift = Math.abs(rcmed - p1med) / p1med;
  const cpuDriftBest = Math.abs(recheck.cpuMsMedian - phases[0]!.cpuMsMedian) / phases[0]!.cpuMsMedian;
  const fpsDrift = Math.abs(recheck.fps - phases[0]!.fps) / phases[0]!.fps;
  const contended = cpuDrift > 0.15;

  // Headroom: how fast could we go without vsync? Tight loop, gl.finish() to include the
  // GPU, no rAF. This is the number that says whether 60 fps is our ceiling or the
  // display's.
  r.setViewport(0, N / 2);
  const uncapped: number[] = [];
  const gl = r.gl;
  for (let i = 0; i < 200; i++) {
    const a = performance.now();
    r.panPixels(8);
    r.render();
    gl.finish();
    uncapped.push(performance.now() - a);
  }
  const uncappedMs = median(uncapped);

  // Split the frame into "what the store costs" and "what this module costs".
  //
  // performance.now() is clamped to 100 us in Brave, so a per-frame reading cannot
  // resolve the renderer's own contribution at all - it just reports 0.0 or 0.1. Both
  // halves are therefore timed as one batch of 300 and divided, which puts the clock
  // granularity 300x below the quantity being measured.
  // Split the frame into "what the store costs" and "what this module costs".
  //
  // Two corrections since round 2, both of which made the published number wrong:
  //
  // 1. gl.finish() used to be called ONCE after 100 renders, so the GPU pipelined behind
  //    the CPU and the loop measured how fast we could submit commands, not how long a
  //    frame took. It is now called per frame. That moved the renderer's own cost from a
  //    claimed "3-6 us" to roughly ten times that.
  // 2. Two sequential batches gave a NEGATIVE renderer cost on an even earlier run
  //    (-0.693 ms of 4.2 ms) - impossible, and pure drift between the batches leaking
  //    into their difference. A and B are interleaved and medianed.
  //
  // The old note also claimed this measurement covered "all 4.6M fragments". It does not:
  // the canvas-area control below changes the fragment count 16x and barely moves the
  // cost, so what is being measured is fixed per-frame overhead - uniform uploads, the
  // texSubImage2D, one draw call - not fragment shading.
  const BATCH = 100;
  const ROUNDS = 6;
  const splitAt = (span: number) => {
    r.setViewport(0, span);
    for (let i = 0; i < 20; i++) { r.render(); }
    gl.finish();
    const wholes: number[] = [];
    const queries: number[] = [];
    for (let k = 0; k < ROUNDS; k++) {
      const a0 = performance.now();
      for (let i = 0; i < BATCH; i++) {
        r.render();
        gl.finish();
      }
      wholes.push((performance.now() - a0) / BATCH);
      const b0 = performance.now();
      for (let i = 0; i < BATCH; i++) r.queryOnly();
      queries.push((performance.now() - b0) / BATCH);
    }
    const whole = median(wholes);
    const queryOnly = median(queries);
    return {
      span,
      wholeMs: whole,
      queryMs: queryOnly,
      rendererMs: whole - queryOnly,
      wholeSpreadMs: Math.max(...wholes) - Math.min(...wholes),
      querySpreadMs: Math.max(...queries) - Math.min(...queries),
    };
  };
  const split = [splitAt(N), splitAt(1_000_000), splitAt(10_000)];

  // Is the GPU half fragment-bound or fixed overhead? Change the canvas area 16x at a
  // fixed span and see whether the cost follows. If it does not, quoting fragment counts
  // in the writeup is meaningless.
  const areaControl: { deviceW: number; deviceH: number; fragments: number; rendererMs: number }[] = [];
  for (const [w, h] of [[CSS_W, CSS_H], [CSS_W / 4, CSS_H / 4]] as [number, number][]) {
    r.resize(w, h);
    const sp = splitAt(1_000_000);
    areaControl.push({
      deviceW: r.widthDevicePx,
      deviceH: r.heightDevicePx,
      fragments: r.widthDevicePx * r.heightDevicePx,
      rendererMs: Number(sp.rendererMs.toFixed(4)),
    });
  }
  r.resize(CSS_W, CSS_H);

  const result = {
    kind: 'render-fps',
    ok: !contended,
    contended,
    spanSweep,
    detector,
    areaControl,
    stabilityCpuDriftPct: cpuDrift * 100,
    stabilityCpuDriftBestVsBestPct: cpuDriftBest * 100,
    phase1CpuMedians: phases[0]!.allCpuMedians,
    recheckCpuMedians: recheck.allCpuMedians,
    stabilityFpsDriftPct: fpsDrift * 100,
    split,
    samples: store.length,
    channels: 16,
    buildSeconds: buildMs / 1000,
    canvas: { cssW: CSS_W, cssH: CSS_H, dpr, deviceW: r.widthDevicePx, deviceH: r.heightDevicePx },
    displayHz: 1000 / vsyncMs,
    framesPerPhase: FRAMES,
    repeats: REPEATS,
    phases,
    uncapped: { msMedian: uncappedMs, fps: 1000 / uncappedMs },
    log,
  };
  (globalThis as unknown as { __result: unknown }).__result = result;

  say('');
  for (const p of phases) {
    say(
      `${p.name.padEnd(28)} ${p.fps.toFixed(1).padStart(6)} fps  ` +
        `frame p95 ${p.frameMsP95.toFixed(2).padStart(6)} ms  ` +
        `cpu ${p.cpuMsMedian.toFixed(2).padStart(5)}/${p.cpuMsP95.toFixed(2).padStart(5)}/${p.cpuMsMax.toFixed(2).padStart(5)} ms  ` +
        `over-budget ${(p.overBudgetFraction * 100).toFixed(2).padStart(6)}%  ` +
        `near ${(p.nearBudgetFraction * 100).toFixed(1).padStart(5)}%`,
    );
  }
  say(`uncapped (no vsync, gl.finish): ${uncappedMs.toFixed(2)} ms/frame = ${(1000 / uncappedMs).toFixed(0)} fps`);
  for (const s of split) {
    say(
      `split span ${s.span.toExponential(1).padStart(8)}: whole ${s.wholeMs.toFixed(3)} ms = ` +
        `store.query ${s.queryMs.toFixed(3)} ms + render ${s.rendererMs.toFixed(3)} ms ` +
        `(spread ${s.wholeSpreadMs.toFixed(3)}/${s.querySpreadMs.toFixed(3)} ms)`,
    );
  }
  say(
    `stability: cpu drift (median of reps) ${(cpuDrift * 100).toFixed(1)}%, ` +
      `best-vs-best ${(cpuDriftBest * 100).toFixed(1)}%, fps drift ${(fpsDrift * 100).toFixed(1)}% -> ` +
      `${contended ? 'CONTENDED, DO NOT QUOTE' : 'clean'}`,
  );
}

void main().catch((e) => {
  (globalThis as unknown as { __result: unknown }).__result = {
    kind: 'render-fps',
    ok: false,
    error: String(e instanceof Error ? e.stack : e),
  };
  say(`ERROR ${e}`);
});
