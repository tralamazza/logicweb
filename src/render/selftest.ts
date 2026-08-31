// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * src/render self test. Runs in a real browser against a real GPU.
 *
 * Every check is a falsifiable statement about pixels or arithmetic, not "it looked
 * fine". The headline one is `glitch-100M-1000px`: a single one-sample pulse in an
 * otherwise idle channel, 100M samples across 1000 pixel columns, which must render as a
 * full-height bar. Silently swallowing that pulse is the classic failure of this
 * component and is worse than being slow, so it is tested at three device pixel ratios
 * and the exact column is asserted, not just "something was drawn somewhere".
 *
 * Drive it with:  node src/render/tools/run-browser.mjs selftest
 */

import { PlanarSampleStore } from '../data/planarStore.js';
import { generateCapture } from '../data/generator.js';
import type { SampleStore } from '../data/types.js';
import { WaveformRenderer } from './waveformRenderer.js';
import { cpuRaster } from './cpuRaster.js';
import { planColumns } from './columns.js';
import { computeLayout } from './layout.js';
import { DARK_THEME, DEFAULT_ROW_HEIGHT_CSS_PX as ROWH, parseHexColor } from './theme.js';
import { MIN_SAMPLES_ON_SCREEN, ViewTransform, WheelIntent, wheelSpanFactor } from './transform.js';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
const log: string[] = [];

function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
  log.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function makeCanvas(cssW: number, cssH: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
  document.body.appendChild(c);
  return c;
}

// --------------------------------------------------------------- pure arithmetic

function testTransform(): void {
  const t = new ViewTransform(1000, 0, 1000);
  check('transform-identity', t.sampleToPixel(500) === 500 && t.pixelToSample(500) === 500);

  // Zoom must hold the sample under the pointer still. This is the property users feel.
  const t2 = new ViewTransform(1000, 1000, 2000);
  const anchorPx = 250;
  const anchorSample = t2.pixelToSample(anchorPx);
  t2.zoomAt(anchorPx, 0.5);
  check(
    'transform-zoom-anchor',
    near(t2.pixelToSample(anchorPx), anchorSample, 1e-9),
    `${t2.pixelToSample(anchorPx)} vs ${anchorSample}`,
  );
  check('transform-zoom-span', near(t2.span, 500, 1e-9), `span ${t2.span}`);

  // [SOURCE] one physical wheel notch is exactly sqrt(2).
  const f = wheelSpanFactor(120, { isPhysicalWheel: true, shift: false });
  check('wheel-notch-sqrt2', near(f, Math.SQRT2, 1e-12), `${f}`);
  const fs = wheelSpanFactor(120, { isPhysicalWheel: true, shift: true });
  check('wheel-shift-10x-finer', near(fs, Math.pow(2, 0.05), 1e-12), `${fs}`);
  const ft = wheelSpanFactor(120, { isPhysicalWheel: false, shift: false });
  check('wheel-trackpad-continuous', near(ft, 2, 1e-12), `${ft}`);

  // [SOURCE] zoom-in is clamped at 20 samples on screen.
  const t3 = new ViewTransform(1000, 0, 1_000_000);
  t3.set(500, 502);
  t3.clampTo(1_000_000);
  check('zoom-in-clamped-at-20', near(t3.span, MIN_SAMPLES_ON_SCREEN, 1e-9), `span ${t3.span}`);

  // Zooming out past the end is allowed and pins to sample 0.
  const t4 = new ViewTransform(1000, 0, 1000);
  t4.set(-500, 1500);
  t4.clampTo(1000);
  check('zoom-out-past-end-pins-to-0', t4.start === 0 && t4.span === 2000, `[${t4.start}, ${t4.end})`);

  // Follow mode must not let a 3 ms capture shrink a 1 s window.
  const t5 = new ViewTransform(1000, 0, 10_000_000);
  t5.clampTo(30_000, { minVisibleFraction: 0 });
  check('follow-keeps-span', t5.span === 10_000_000 && t5.start === 0, `[${t5.start}, ${t5.end})`);

  // [SOURCE] wheel intent locks after 5 events in a 200 ms window.
  const wi = new WheelIntent();
  let intent: 'zoom' | 'pan' = 'pan';
  for (let i = 0; i < 6; i++) intent = wi.classify(1, 10, 1000 + i * 10);
  check('wheel-intent-locks-zoom', intent === 'zoom', intent);
  for (let i = 0; i < 6; i++) intent = wi.classify(1, 10, 1060 + i * 10);
  check('wheel-intent-stays-locked', intent === 'zoom', intent);
}

function testPlan(): void {
  // The common case must be exactly 1:1 or every pixel is subtly wrong.
  const p = planColumns(0, 1000, 1000, 1000, 2000);
  check(
    'plan-identity',
    p.hasData && p.dataBins === 1000 && p.scale === 1 && p.offset === 0,
    JSON.stringify(p),
  );

  // View extends past the end: the data keeps its scale, the rest is NO_DATA.
  const p2 = planColumns(0, 2000, 1000, 1000, 4000);
  check(
    'plan-past-end-keeps-scale',
    p2.hasData && p2.queryEnd === 1000 && near(p2.dataBins * p2.scale, 500, 1e-9),
    JSON.stringify(p2),
  );

  // Fractional start: the integer query range is wider, and the offset carries the
  // sub-sample shift instead of it being rounded away.
  const p3 = planColumns(10.5, 20.5, 1000, 1000, 2000);
  check(
    'plan-fractional-offset',
    p3.queryStart === 10 && p3.queryEnd === 21 && near(p3.offset, -50, 1e-9),
    JSON.stringify(p3),
  );

  // Nothing captured yet.
  check('plan-empty-store', !planColumns(0, 1000, 1000, 0, 2000).hasData);
  // View entirely past the end.
  check('plan-view-past-all-data', !planColumns(5000, 6000, 1000, 1000, 2000).hasData);
}

function testLayout(): void {
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const l = computeLayout({
      rowCount: 16,
      rowHeightCssPx: ROWH,
      gutterCssPx: 8,
      lineWidthCssPx: 1,
      edgeWidthDevicePx: 1,
      noDataBorderCssPx: 2,
      rowSeparatorCssPx: 2,
      dpr,
    });
    let ok = true;
    let why = '';
    for (let i = 0; i < 16; i++) {
      const r = l.rows[i]!;
      if (!Number.isInteger(r.top) || !Number.isInteger(r.height)) { ok = false; why = `row ${i} not integral`; }
      if (!Number.isInteger(r.yHiTop) || !Number.isInteger(r.yLoTop)) { ok = false; why = `row ${i} band not integral`; }
      if (r.yLoTop <= r.yHiTop) { ok = false; why = `row ${i} inverted band`; }
      if (r.bandHeight !== r.height - l.separator) { ok = false; why = `row ${i} band != height - separator`; }
      if (r.yLoTop + l.lineWidth > r.top + r.bandHeight) { ok = false; why = `row ${i} low line inside the separator`; }
      if (i > 0 && l.rows[i - 1]!.top + l.rows[i - 1]!.height !== r.top) { ok = false; why = `row ${i} gap`; }
    }
    // No cumulative drift: the 16th row must end where 16 * 45 CSS px does.
    const want = Math.round(16 * ROWH * dpr);
    if (l.totalHeight !== want) { ok = false; why = `total ${l.totalHeight} != ${want}`; }
    check(`layout-integral-dpr-${dpr}`, ok, why);
  }

  // Pin the geometry measured directly off rendered output at
  // dpr 2, so a later tweak cannot silently drift:
  //   row pitch 98 device px, separator 4, band 94, idle line 2 device px,
  //   high line top at +16, low line top at +76, 60 px between the two line tops.
  const m = computeLayout({
    rowCount: 2,
    rowHeightCssPx: 49,
    gutterCssPx: 8,
    lineWidthCssPx: 1,
    edgeWidthDevicePx: 1,
    noDataBorderCssPx: 2,
    rowSeparatorCssPx: 2,
    dpr: 2,
  });
  const g0 = m.rows[0]!;
  const got = {
    pitch: g0.height,
    separator: m.separator,
    band: g0.bandHeight,
    lineWidth: m.lineWidth,
    hiOffset: g0.yHiTop - g0.top,
    loOffset: g0.yLoTop - g0.top,
    lineGap: g0.yLoTop - g0.yHiTop,
    edgeWidth: m.edgeWidth,
  };
  const wantGeom = {
    pitch: 98, separator: 4, band: 94, lineWidth: 2,
    hiOffset: 16, loOffset: 76, lineGap: 60, edgeWidth: 1,
  };
  check(
    'geometry-matches-logic2-screenshot',
    JSON.stringify(got) === JSON.stringify(wantGeom),
    `got ${JSON.stringify(got)} want ${JSON.stringify(wantGeom)}`,
  );

  // Non-uniform rows.
  //
  // measure-screenshot.py on 04-zoomed-in-edges.png reports "13x98 2x138": the two rows
  // carrying analyzer chips are 138 device px, the rest 98. A layout derived from a
  // single height puts every row below the first tall one 80 device px out, which loses
  // a blind A/B outright. A 138 px row has a 134 px band and its low line at
  // +116 = 134 - 16 - 2 - the same gutter rule at a different height.
  const mx = computeLayout({
    rowCount: 8,
    rowHeightCssPx: 49,
    rowHeightsCssPx: [49, 49, 49, 49, 69, 69, 49, 49],
    gutterCssPx: 8,
    lineWidthCssPx: 1,
    edgeWidthDevicePx: 1,
    noDataBorderCssPx: 2,
    rowSeparatorCssPx: 2,
    dpr: 2,
  });
  const pitches = mx.rows.map((rr) => rr.height);
  const tall = mx.rows[4]!;
  const gapless = mx.rows.every(
    (rr, i) => i === 0 || mx.rows[i - 1]!.top + mx.rows[i - 1]!.height === rr.top,
  );
  check(
    'layout-supports-non-uniform-rows',
    JSON.stringify(pitches) === JSON.stringify([98, 98, 98, 98, 138, 138, 98, 98]) &&
      tall.bandHeight === 134 &&
      tall.yLoTop - tall.top === 116 &&
      gapless,
    `pitches ${JSON.stringify(pitches)}, tall band ${tall.bandHeight}, ` +
      `loOffset ${tall.yLoTop - tall.top}, gapless ${gapless}`,
  );
}

// --------------------------------------------------------------- pixel checks

interface Rgba { r: number; g: number; b: number }

function pixelAt(img: { width: number; data: Uint8Array }, x: number, y: number): Rgba {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i]!, g: img.data[i + 1]!, b: img.data[i + 2]! };
}

function sameRgb(a: Rgba, b: Rgba): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function testAgainstCpuRaster(): void {
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 10_000_000 });
  for (const chunk of generateCapture({ totalSamples: 2_000_000, chunkSamples: 1 << 18 })) {
    store.append(chunk);
  }
  const canvas = makeCanvas(320, 16 * ROWH);
  const r = new WaveformRenderer({
    canvas,
    store,
    devicePixelRatio: 2,
    preserveDrawingBuffer: true,
  });
  r.resize(320, 16 * ROWH);

  // Integer, in-range viewports at four zoom levels: two samples per pixel, one per
  // pixel, deep zoom-out, and zoomed in past one sample per pixel.
  const cases: [number, number][] = [
    [0, 2_000_000],
    [0, 640],
    [1000, 1000 + 6400],
    [123_456, 123_456 + 40],
  ];
  for (const [s, e] of cases) {
    r.setViewport(s, e);
    r.render();
    const gpu = r.readPixels();
    const cpu = cpuRaster({
      store,
      channels: r.getChannels(),
      start: r.viewport.start,
      end: r.viewport.end,
      widthPx: r.widthDevicePx,
      heightPx: r.heightDevicePx,
      layout: r.rowGeometry,
      theme: DARK_THEME,
    });
    let diff = 0;
    let first = '';
    for (let i = 0; i < gpu.data.length; i += 4) {
      if (gpu.data[i] !== cpu.data[i] || gpu.data[i + 1] !== cpu.data[i + 1] || gpu.data[i + 2] !== cpu.data[i + 2]) {
        if (diff === 0) {
          const p = i / 4;
          first = `at (${p % gpu.width}, ${Math.floor(p / gpu.width)}) gpu ${gpu.data[i]},${gpu.data[i + 1]},${gpu.data[i + 2]} cpu ${cpu.data[i]},${cpu.data[i + 1]},${cpu.data[i + 2]}`;
        }
        diff++;
      }
    }
    check(`gpu-matches-cpu-raster-[${s},${e})`, diff === 0, `${diff} differing px ${first}`);
  }

  // Crispness: with integral geometry every pixel must be either exactly the background
  // or exactly the channel colour. Any third value is an antialiasing smear, which is
  // what the spec warns about on Retina.
  for (const dpr of [1, 1.5, 2]) {
    r.setDevicePixelRatio(dpr);
    r.resize(320, 16 * ROWH);
    r.setViewport(0, 640);
    r.render();
    const img = r.readPixels();
    const bg = parseHexColor(DARK_THEME.background).map((v) => Math.round(v * 255));
    const palette = DARK_THEME.channelColors.map((c) => parseHexColor(c).map((v) => Math.round(v * 255)));
    const sep = parseHexColor(DARK_THEME.rowSeparatorColor).map((v) => Math.round(v * 255));
    let bad = 0;
    let sample = '';
    for (let i = 0; i < img.data.length; i += 4) {
      const px = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
      if (px[0] === bg[0] && px[1] === bg[1] && px[2] === bg[2]) continue;
      if (palette.some((c) => c[0] === px[0] && c[1] === px[1] && c[2] === px[2])) continue;
      if (px[0] === sep[0] && px[1] === sep[1] && px[2] === sep[2]) continue;
      if (bad === 0) sample = `${px.join(',')} at ${(i / 4) % img.width},${Math.floor(i / 4 / img.width)}`;
      bad++;
    }
    check(`crisp-no-intermediate-values-dpr-${dpr}`, bad === 0, `${bad} smeared px ${sample}`);
  }

  r.setDevicePixelRatio(2);
  r.dispose();
  canvas.remove();
}

/**
 * The headline correctness test.
 *
 * 100M samples, one channel idle high with a single one-sample low pulse, 1000 pixel
 * columns - so one column is 100,000 samples and the pulse is 0.001% of it. It must show
 * as a full-height bar in exactly the column that contains it, and the columns either
 * side must still be idle lines.
 */
function testGlitch(): void {
  const GLITCH_CH = 12;
  const TOTAL = 100_000_000;
  const PULSE_AT = 61_234_567;

  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100_000_000 });
  const CHUNK = 1 << 20;
  const idle = new Uint16Array(CHUNK).fill(1 << GLITCH_CH); // idle high on GLITCH_CH only
  const idleBytes = new Uint8Array(idle.buffer);
  let written = 0;
  while (written < TOTAL) {
    const take = Math.min(CHUNK, TOTAL - written);
    if (PULSE_AT >= written && PULSE_AT < written + take) {
      const off = PULSE_AT - written;
      idle[off] = 0; // one sample low
      store.append(idleBytes.subarray(0, take * 2));
      idle[off] = 1 << GLITCH_CH;
    } else {
      store.append(idleBytes.subarray(0, take * 2));
    }
    written += take;
  }
  check('glitch-store-length', store.length === TOTAL, `${store.length}`);
  const e = store.edges(GLITCH_CH, 0, TOTAL);
  check('glitch-store-has-2-edges', e.length === 2 && e[0] === PULSE_AT && e[1] === PULSE_AT + 1, `${Array.from(e)}`);

  for (const dpr of [1, 2, 3]) {
    const widthCss = 1000 / dpr;
    const canvas = makeCanvas(widthCss, ROWH);
    const r = new WaveformRenderer({
      canvas,
      store,
      channels: [GLITCH_CH],
      devicePixelRatio: dpr,
      preserveDrawingBuffer: true,
    });
    r.resize(widthCss, ROWH);
    r.setViewport(0, TOTAL);
    r.render();
    const img = r.readPixels();
    const geom = r.rowGeometry.rows[0]!;
    const midY = Math.floor((geom.yHiTop + geom.yLoTop) / 2);
    const colour = parseHexColor(DARK_THEME.channelColors[GLITCH_CH % 8]!).map((v) => Math.round(v * 255));

    // Which pixel columns are painted at mid-trace height? Only a transition bar reaches
    // there; an idle line never does.
    const lit: number[] = [];
    for (let x = 0; x < img.width; x++) {
      const p = pixelAt(img, x, midY);
      if (p.r === colour[0] && p.g === colour[1] && p.b === colour[2]) lit.push(x);
    }
    const expected = Math.floor((PULSE_AT / TOTAL) * img.width);
    const ok = lit.length >= 1 && lit.length <= 2 && lit.every((x) => Math.abs(x - expected) <= 1);
    check(
      `glitch-100M-1000px-dpr-${dpr}`,
      ok,
      `lit columns ${JSON.stringify(lit)} expected near ${expected} (width ${img.width})`,
    );

    // And the rest of the row is still an idle HIGH line, not a low one and not blank.
    const hiY = geom.yHiTop;
    const loY = geom.yLoTop;
    const probe = expected > 50 ? 10 : img.width - 10;
    const hi = pixelAt(img, probe, hiY);
    const lo = pixelAt(img, probe, loY);
    check(
      `glitch-idle-line-still-high-dpr-${dpr}`,
      hi.r === colour[0] && hi.g === colour[1] && hi.b === colour[2] && !sameRgb(lo, hi),
      `hi ${JSON.stringify(hi)} lo ${JSON.stringify(lo)}`,
    );
    r.dispose();
    canvas.remove();
  }
  return;
}

function testNoData(): void {
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 10_000_000 });
  for (const chunk of generateCapture({ totalSamples: 1_000_000, chunkSamples: 1 << 18 })) {
    store.append(chunk);
  }
  const canvas = makeCanvas(400, ROWH);
  const r = new WaveformRenderer({ canvas, store, channels: [0], devicePixelRatio: 1, preserveDrawingBuffer: true });
  r.resize(400, ROWH);
  // Half data, half past the end.
  r.transform.set(0, 2_000_000);
  r.render();
  const img = r.readPixels();
  const geom = r.rowGeometry.rows[0]!;
  const bgRgb = parseHexColor(DARK_THEME.background).map((v) => Math.round(v * 255));
  const midY = Math.floor((geom.yHiTop + geom.yLoTop) / 2);
  const inData = pixelAt(img, 10, midY);
  const past = pixelAt(img, img.width - 10, midY);
  const pastTop = pixelAt(img, img.width - 10, geom.top);
  check(
    'nodata-distinct-from-background',
    !sameRgb(past, { r: bgRgb[0]!, g: bgRgb[1]!, b: bgRgb[2]! }),
    `past-end px ${JSON.stringify(past)} vs bg ${bgRgb.join(',')}`,
  );
  check('nodata-has-top-border', !sameRgb(pastTop, past), `border ${JSON.stringify(pastTop)} wash ${JSON.stringify(past)}`);
  check('nodata-only-past-the-end', !sameRgb(inData, past), `in-data ${JSON.stringify(inData)}`);
  r.dispose();
  canvas.remove();
}

/**
 * Rendering while data is being appended. The specific failure this catches: sampling
 * store.length more than once inside a frame, which lets channel 0 be drawn against a
 * shorter capture than channel 15 and puts a visible step in the live edge.
 */
function testLiveAppend(): void {
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 10_000_000 });
  const gen = generateCapture({ totalSamples: 4_000_000, chunkSamples: 1 << 16 });
  const canvas = makeCanvas(600, 16 * ROWH);
  const r = new WaveformRenderer({ canvas, store, devicePixelRatio: 1, preserveDrawingBuffer: true });
  r.resize(600, 16 * ROWH);
  store.append(gen.next().value as Uint8Array);
  r.setViewport(0, store.length);
  r.setFollowLatest(true);

  let frames = 0;
  let threw = '';
  let sawGrowth = false;
  let prevEnd = r.viewport.end;
  try {
    for (;;) {
      const n = gen.next();
      if (n.done) break;
      store.append(n.value);
      const before = store.length;
      r.render();
      frames++;
      if (r.viewport.end > prevEnd) sawGrowth = true;
      prevEnd = r.viewport.end;
      // Follow mode must sit exactly on the newest sample.
      if (Math.abs(r.viewport.end - before) > 1) {
        threw = `follow lagged: viewport ends at ${r.viewport.end}, store has ${before}`;
        break;
      }
    }
  } catch (err) {
    threw = String(err);
  }
  check('live-append-renders', frames > 10 && threw === '', `${frames} frames ${threw}`);
  check('live-follow-tracks-edge', sawGrowth, `end ${r.viewport.end}`);

  // [SOURCE] any pan or zoom detaches follow mode and leaves the view where you put it.
  r.panPixels(-10);
  const parked = r.viewport.start;
  const n = gen.next();
  if (!n.done) store.append(n.value);
  r.render();
  check(
    'pan-cancels-follow',
    !r.followLatest && Math.abs(r.viewport.start - parked) < 1e-6,
    `follow=${r.followLatest} start ${r.viewport.start} was ${parked}`,
  );
  r.dispose();
  canvas.remove();
}

// --------------------------------------------------------------- driver

async function main(): Promise<void> {
  const t0 = performance.now();
  try {
    testTransform();
    testPlan();
    testLayout();
    testAgainstCpuRaster();
    testNoData();
    testLiveAppend();
    testGlitch();
  } catch (err) {
    check('selftest-crashed', false, String(err instanceof Error ? err.stack : err));
  }
  const failed = checks.filter((c) => !c.pass);
  const result = {
    kind: 'render-selftest',
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    ms: performance.now() - t0,
    checks,
    log,
  };
  (globalThis as unknown as { __result: unknown }).__result = result;
  const pre = document.createElement('pre');
  pre.textContent = log.join('\n') + `\n\n${checks.length - failed.length}/${checks.length} passed`;
  document.body.appendChild(pre);
}

void main();

// Unused-import guard: SampleStore is referenced only in a type position above.
export type { SampleStore };
