// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Correctness tests for the sample store. Runs unchanged in node and in the browser.
 *
 * The controls that matter:
 *  - every query result is compared against a brute-force scan of the same samples, so a
 *    pyramid bug cannot hide behind a pyramid-shaped reference;
 *  - the planar store and the interleaved store are compared against each other, so a bug
 *    in the shared descent logic has to be present identically in two different layouts to
 *    go unnoticed;
 *  - the narrow-glitch case is tested at the full 100M x 1000 columns scale, not scaled
 *    down, because that is exactly the case where a wrong level choice stops mattering.
 */

import { PlanarSampleStore } from './planarStore.js';
import { InterleavedSampleStore } from './interleavedStore.js';
import { RleSampleStore } from './rleStore.js';
import { GAP_BIT } from './types.js';
import { generateCapture, fillMacro, makeTileBlock, MACRO_SAMPLES } from './generator.js';
import type { SampleStore, ColumnView } from './types.js';

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

type Log = (line: string) => void;

/** Column boundaries exactly as query() defines them. */
function columnBounds(s: number, e: number, bins: number): { a: Int32Array; b: Int32Array } {
  const a = new Int32Array(bins), b = new Int32Array(bins);
  const width = e - s;
  for (let i = 0; i < bins; i++) {
    const c0 = s + Math.floor((i * width) / bins);
    let c1 = s + Math.floor(((i + 1) * width) / bins);
    if (c1 <= c0) c1 = c0 + 1;
    if (c1 > e) c1 = e;
    a[i] = c0;
    b[i] = c1;
  }
  return { a, b };
}

/** Independent check that the column definition itself is sane. */
function checkTiling(s: number, e: number, bins: number): string | null {
  const { a, b } = columnBounds(s, e, bins);
  if (a[0] !== s) return `first column starts at ${a[0]}, not ${s}`;
  if (b[bins - 1] !== e) return `last column ends at ${b[bins - 1]}, not ${e}`;
  for (let i = 0; i < bins; i++) {
    if (b[i]! <= a[i]!) return `column ${i} is empty`;
    if (i > 0 && e - s >= bins && a[i] !== b[i - 1]) return `gap or overlap between column ${i - 1} and ${i}`;
  }
  return null;
}

/** Brute force: one pass over every sample in the range. */
function referenceQuery(
  sample: (i: number) => number, s: number, e: number, bins: number,
): { low: Uint8Array; high: Uint8Array; edge: Uint8Array } {
  const bounds = columnBounds(s, e, bins);
  const low = new Uint8Array(bins), high = new Uint8Array(bins), edge = new Uint8Array(bins);
  for (let i = 0; i < bins; i++) {
    const c0 = bounds.a[i]!, c1 = bounds.b[i]!;
    let anyHi = 0, anyLo = 0;
    for (let j = c0; j < c1; j++) {
      if (sample(j)) anyHi = 1; else anyLo = 1;
    }
    high[i] = anyHi;
    low[i] = anyLo ? 0 : 1;
    let eh = anyHi, el = anyLo;
    if (c0 > 0) { if (sample(c0 - 1)) eh = 1; else el = 1; }
    edge[i] = eh && el ? 1 : 0;
  }
  return { low, high, edge };
}

function referenceEdges(sample: (i: number) => number, s: number, e: number, len: number): number[] {
  const out: number[] = [];
  const a = Math.max(1, s), z = Math.min(e, len);
  for (let i = a; i < z; i++) if (sample(i) !== sample(i - 1)) out.push(i);
  return out;
}

function compareView(
  got: ColumnView, want: { low: Uint8Array; high: Uint8Array; edge: Uint8Array }, tag: string,
): string | null {
  for (let i = 0; i < got.bins; i++) {
    if (got.low[i] !== want.low[i] || got.high[i] !== want.high[i] || got.edge[i] !== want.edge[i]) {
      return `${tag}: column ${i} got low=${got.low[i]} high=${got.high[i]} edge=${got.edge[i]}` +
             ` want low=${want.low[i]} high=${want.high[i]} edge=${want.edge[i]}`;
    }
    const expectPacked = got.high[i]! | (got.low[i]! << 1) | (got.edge[i]! << 2);
    if (got.packed[i] !== expectPacked) return `${tag}: packed mismatch at column ${i}`;
  }
  return null;
}

// ---------------------------------------------------------------------------

/** The zoom ladder every brute-force comparison runs. */
function zoomCases(totalSamples: number): Array<[number, number, number]> {
  const zooms: Array<[number, number, number]> = [];
  const widths = [totalSamples, Math.floor(totalSamples / 3), 100000, 12345, 1024, 257, 33, 7, 1];
  for (const w of widths) {
    if (w < 1 || w > totalSamples) continue;
    for (const off of [0, 1, 17, 4095, 65536, totalSamples - w]) {
      if (off < 0 || off + w > totalSamples) continue;
      for (const bins of [1, 7, 256, 1000, 1920]) zooms.push([off, off + w, bins]);
    }
  }
  return zooms;
}

/**
 * Build a small store from generated content plus a reference copy of the same samples,
 * then check append round-trip, query at many zooms and edges against brute force.
 */
function testAgainstBruteForce(log: Log, chunkSamples: number, totalSamples: number): TestResult[] {
  const results: TestResult[] = [];
  const ref = new Uint16Array(totalSamples);
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
  const inter = new InterleavedSampleStore(100e6);

  let written = 0;
  for (const chunk of generateCapture({ totalSamples, chunkSamples })) {
    const n = chunk.byteLength / 2;
    const view = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    ref.set(view, written);
    store.append(chunk);
    inter.append(chunk);
    written += n;
  }

  let bad = -1;
  for (let i = 0; i < totalSamples && bad < 0; i++) {
    for (let c = 0; c < 16; c++) {
      if (store.sampleAt(c, i) !== ((ref[i]! >>> c) & 1)) { bad = i; break; }
    }
  }
  results.push({
    name: `append round-trip (chunk=${chunkSamples}, n=${totalSamples})`,
    pass: bad < 0,
    detail: bad < 0 ? `${totalSamples * 16} bits verified` : `first mismatch at sample ${bad}`,
  });
  if (bad >= 0) return results;

  let qFail: string | null = null;
  let qChecked = 0;
  for (const ch of [0, 2, 3, 5, 8, 11, 12, 13, 14, 15]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    for (const [s, e, bins] of zoomCases(totalSamples)) {
      const want = referenceQuery(sample, s, e, bins);
      qFail = compareView(store.query(ch, s, e, bins), want, `planar ch${ch} [${s},${e}) x${bins}`);
      if (qFail) break;
      qFail = compareView(inter.query(ch, s, e, bins), want, `interleaved ch${ch} [${s},${e}) x${bins}`);
      if (qFail) break;
      qChecked++;
    }
    if (qFail) break;
  }
  results.push({
    name: `query vs brute force (chunk=${chunkSamples})`,
    pass: qFail === null,
    detail: qFail ?? `${qChecked} (channel, viewport, bins) combinations, both layouts`,
  });

  let eFail: string | null = null;
  let eChecked = 0;
  for (const ch of [0, 3, 5, 11, 12, 13, 14, 15]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    for (const [s, e] of [[0, totalSamples], [1, 999], [12345, 200000], [totalSamples - 5000, totalSamples], [7, 8]] as Array<[number, number]>) {
      if (e > totalSamples) continue;
      const want = referenceEdges(sample, s, e, totalSamples);
      const gotP = Array.from(store.edges(ch, s, e));
      const gotI = Array.from(inter.edges(ch, s, e));
      if (gotP.length !== want.length || gotP.some((v, i) => v !== want[i])) {
        eFail = `planar ch${ch} [${s},${e}): got ${gotP.length} edges want ${want.length}` +
                (gotP.length === want.length ? ` (first diff at ${gotP.findIndex((v, i) => v !== want[i])})` : '');
        break;
      }
      if (gotI.length !== want.length || gotI.some((v, i) => v !== want[i])) {
        eFail = `interleaved ch${ch} [${s},${e}) disagrees with brute force`;
        break;
      }
      eChecked++;
    }
    if (eFail) break;
  }
  results.push({
    name: `edges vs brute force (chunk=${chunkSamples})`,
    pass: eFail === null,
    detail: eFail ?? `${eChecked} (channel, window) combinations, both layouts`,
  });

  log(`  brute-force set done for chunk=${chunkSamples}`);
  return results;
}

// ---------------------------------------------------------------------------

/**
 * The RLE store against the same brute-force reference: derive it from a planar store
 * (the round trip an import goes through), then hold it to every zoom and every edge
 * window the planar store was held to. A query bug in either store now needs to agree
 * with the brute-force scan to pass, so the two cannot cancel out.
 */
function testRleAgainstBruteForce(log: Log, chunkSamples: number, totalSamples: number): TestResult[] {
  const results: TestResult[] = [];
  const ref = new Uint16Array(totalSamples);
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });

  let written = 0;
  for (const chunk of generateCapture({ totalSamples, chunkSamples })) {
    const n = chunk.byteLength / 2;
    const view = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    ref.set(view, written);
    store.append(chunk);
    written += n;
  }
  const rle = RleSampleStore.fromStore(store);

  // Level round trip at a scatter of positions, plus the ends and the first samples.
  let rtFail = '';
  const spots = [0, 1, 2, 31, 32, 33, 997, 4095, 4096, 65537, totalSamples - 2, totalSamples - 1];
  for (const i of spots) {
    if (i < 0 || i >= totalSamples) continue;
    for (let c = 0; c < 16 && !rtFail; c++) {
      if (rle.sampleAt(c, i) !== store.sampleAt(c, i)) rtFail = `level ch${c} @${i}`;
    }
  }
  results.push({
    name: `rle sampleAt round trip (chunk=${chunkSamples})`,
    pass: rtFail === '',
    detail: rtFail ? `first mismatch: ${rtFail}` : `${spots.length} positions x 16 channels verified`,
  });

  let qFail: string | null = null;
  let qChecked = 0;
  for (const ch of [0, 2, 3, 5, 8, 11, 12, 13, 14, 15]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    for (const [s, e, bins] of zoomCases(totalSamples)) {
      const want = referenceQuery(sample, s, e, bins);
      qFail = compareView(rle.query(ch, s, e, bins), want, `rle ch${ch} [${s},${e}) x${bins}`);
      if (qFail) break;
      qChecked++;
    }
    if (qFail) break;
  }
  results.push({
    name: `rle query vs brute force (chunk=${chunkSamples})`,
    pass: qFail === null,
    detail: qFail ?? `${qChecked} (channel, viewport, bins) combinations`,
  });

  let eFail: string | null = null;
  let eChecked = 0;
  for (const ch of [0, 3, 5, 11, 12, 13, 14, 15]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    for (const [s, e] of [[0, totalSamples], [1, 999], [12345, 200000], [totalSamples - 5000, totalSamples], [7, 8]] as Array<[number, number]>) {
      if (e > totalSamples) continue;
      const want = referenceEdges(sample, s, e, totalSamples);
      const got = Array.from(rle.edges(ch, s, e));
      if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
        eFail = `rle ch${ch} [${s},${e}): got ${got.length} edges want ${want.length}` +
                (got.length === want.length ? ` (first diff at ${got.findIndex((v, i) => v !== want[i])})` : '');
        break;
      }
      eChecked++;
    }
    if (eFail) break;
  }
  results.push({
    name: `rle edges vs brute force (chunk=${chunkSamples})`,
    pass: eFail === null,
    detail: eFail ?? `${eChecked} (channel, window) combinations`,
  });

  log(`  rle brute-force set done for chunk=${chunkSamples}`);
  return results;
}

/**
 * The quantisation rule `fromTransitions` implements, checked against an independent
 * sample-stream simulation of the same rule - the control for the transition-time ->
 * edge-position conversion. The rule itself is the one the old planar import path used
 * (transition time -> first sample at or after it), so this pins the contract between
 * the two stores.
 */
function testRleQuantization(): TestResult[] {
  const results: TestResult[] = [];
  const sr = 10e6;
  const length = 1000;

  // Simulate the sample stream exactly as the old expansion did, per channel: levels
  // first, edges derived from the levels.
  const quantizeReference = (initial: number, times: readonly number[]): Int8Array => {
    const level = new Int8Array(length);
    let state = initial;
    let cursor = 0;
    for (let p = 0; p < length; p++) {
      while (cursor < times.length && Math.ceil(times[cursor]! * sr) <= p) { state ^= 1; cursor++; }
      level[p] = state;
    }
    return level;
  };
  const edgesOf = (level: Int8Array): number[] => {
    const edges: number[] = [];
    for (let p = 1; p < length; p++) if (level[p] !== level[p - 1]) edges.push(p);
    return edges;
  };

  const cases: Array<{ name: string; initial: number; times: number[] }> = [
    { name: 'grid-exact, all interior', initial: 0, times: [0.0000001, 0.0000003, 0.0000007] },
    // 0.00000015 -> ceil(1.5)=2, 0.00000019 -> ceil(1.9)=2, 0.00000029 -> ceil(2.9)=3:
    // three at 2 cancel to one, plus the grid-exact pair of 2s from the first case shape.
    { name: 'same-sample cancels pairwise', initial: 0, times: [0.00000015, 0.00000019, 0.00000029] },
    { name: 'three on one sample leave one', initial: 1, times: [0.0000001, 0.00000015, 0.00000019] },
    // ceil(0)=0: flips the level at sample 0, but never produces an edge.
    { name: 'transition at t=0 flips initial only', initial: 0, times: [0, 0.0000003] },
    // ceil(999.5)=1000 >= length: dropped.
    { name: 'transition past the end is dropped', initial: 0, times: [0.0000001, 0.00009995] },
    { name: 'idle channel', initial: 1, times: [] },
  ];

  let fail: string | null = null;
  let checks = 0;
  for (const cse of cases) {
    const sources = Array.from({ length: 4 }, () => ({ initial: 0, transitions: new Float64Array(0) }));
    sources[0] = { initial: cse.initial, transitions: new Float64Array(cse.times) };
    const store = RleSampleStore.fromTransitions(4, sr, length, sources);

    const levelRef = quantizeReference(cse.initial, cse.times);
    const wantEdges = edgesOf(levelRef);
    const gotEdges = Array.from(store.edges(0, 0, length));
    if (gotEdges.length !== wantEdges.length || gotEdges.some((v, i) => v !== wantEdges[i])) {
      fail = `${cse.name}: got edges [${gotEdges.join(', ')}] want [${wantEdges.join(', ')}]`;
      break;
    }
    // Level at sample 0 must absorb t=0 flips, and levels elsewhere follow the edges.
    for (const p of [0, 1, 2, 3, 500, 998, 999]) {
      if (store.sampleAt(0, p) !== levelRef[p]!) {
        fail = `${cse.name}: level at ${p} is ${store.sampleAt(0, p)}, stream says ${levelRef[p]}`;
        break;
      }
      checks++;
    }
    if (fail) break;
    // Full-view sanity: the store must agree with a brute-force query over the stream.
    const sample = (i: number) => levelRef[i]!;
    for (const bins of [1, 7, 256, 1000]) {
      const want = referenceQuery(sample, 0, length, bins);
      const q = compareView(store.query(0, 0, length, bins), want, `quantize ${cse.name} x${bins}`);
      if (q) { fail = q; break; }
      checks++;
    }
    if (fail) break;
  }
  results.push({
    name: 'fromTransitions quantisation vs a stream simulation',
    pass: fail === null,
    detail: fail ?? `${cases.length} cases, ${checks} checks`,
  });

  // Bad input must throw, not produce a plausible-looking store.
  const badInputs: Array<[string, () => unknown]> = [
    ['non-ascending transitions', () => RleSampleStore.fromTransitions(4, sr, 100, [
      { initial: 0, transitions: new Float64Array([1e-6, 0.5e-6]) },
      { initial: 0, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
    ])],
    ['bad initial', () => RleSampleStore.fromTransitions(4, sr, 100, [
      { initial: 2, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
    ])],
  ];
  const notThrown: string[] = [];
  for (const [name, fn] of badInputs) {
    try { fn(); notThrown.push(name); } catch { /* expected */ }
  }
  results.push({
    name: 'fromTransitions rejects bad input',
    pass: notThrown.length === 0,
    detail: notThrown.length === 0 ? `${badInputs.length} bad-input cases all threw` : `did not throw: ${notThrown.join(', ')}`,
  });

  return results;
}

/**
 * Gap spans: noteGap merging, bit3 in query output, and edge filtering - on the planar
 * store and on an RLE store derived from it, which must agree bit for bit.
 */
function testGaps(): TestResult[] {
  const results: TestResult[] = [];
  const total = 400000;
  const ref = new Uint16Array(total);
  const clean = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
  const gapped = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });

  let written = 0;
  for (const chunk of generateCapture({ totalSamples: total, chunkSamples: 4099 })) {
    const n = chunk.byteLength / 2;
    const view = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    ref.set(view, written);
    clean.append(chunk);
    gapped.append(chunk);
    written += n;
  }

  const G0 = 50000, G1 = 160000;
  gapped.noteGap(G0, 100000);
  gapped.noteGap(150000, 150001); // 1-sample gap
  gapped.noteGap(70000, 160000);  // overlaps both -> must merge into [50000, 160000)

  const gapList = gapped.gaps();
  const merged =
    gapList.length === 1 && gapList[0]!.startSample === G0 && gapList[0]!.endSample === G1;
  results.push({
    name: 'noteGap merges overlapping and adjacent spans',
    pass: merged,
    detail: merged ? `[${G0}, ${G1})` : `got ${JSON.stringify(gapList)}`,
  });

  // Validation: out-of-range and empty gaps must throw.
  const badGaps: Array<[string, () => void]> = [
    ['start > end', () => gapped.noteGap(10, 5)],
    ['end past length', () => gapped.noteGap(0, total + 1)],
    ['negative start', () => gapped.noteGap(-1, 5)],
  ];
  const notThrown: string[] = [];
  for (const [name, fn] of badGaps) {
    try { fn(); notThrown.push(name); } catch { /* expected */ }
  }
  results.push({
    name: 'noteGap rejects invalid spans',
    pass: notThrown.length === 0,
    detail: notThrown.length === 0 ? `${badGaps.length} invalid spans all threw` : `did not throw: ${notThrown.join(', ')}`,
  });

  // Query: low/high/edge identical to the gap-free store; bit3 exactly on intersecting
  // columns. The one gap [G0, G1) covers many zoom levels, and column boundaries rarely
  // line up with it, so this exercises partial overlap.
  let qFail: string | null = null;
  let qChecked = 0;
  const CHANNELS = [0, 3, 5, 11, 12, 15];
  for (const ch of CHANNELS) {
    for (const [s, e, bins] of zoomCases(total)) {
      const a = clean.query(ch, s, e, bins);
      const b = gapped.query(ch, s, e, bins);
      const bounds = columnBounds(s, e, bins);
      for (let i = 0; i < bins && !qFail; i++) {
        const c0 = bounds.a[i]!, c1 = bounds.b[i]!;
        const wantGap = c0 < G1 && c1 > G0 ? 1 : 0;
        if (b.low[i] !== a.low[i] || b.high[i] !== a.high[i] || b.edge[i] !== a.edge[i]) {
          qFail = `ch${ch} [${s},${e}) x${bins} column ${i}: gapped store changed low/high/edge`;
          break;
        }
        if (b.packed[i] !== (a.packed[i]! | (wantGap ? GAP_BIT : 0))) {
          qFail = `ch${ch} [${s},${e}) x${bins} column ${i}: packed ${b.packed[i]} want ${a.packed[i]! | (wantGap ? GAP_BIT : 0)}`;
          break;
        }
        qChecked++;
      }
      if (qFail) break;
    }
    if (qFail) break;
  }
  results.push({
    name: 'gap bit3 lands exactly on intersecting columns, other bits unchanged',
    pass: qFail === null,
    detail: qFail ?? `${qChecked} columns verified`,
  });

  // edges(): the gap-free edges with the ones inside [G0, G1) removed.
  let eFail: string | null = null;
  let eChecked = 0;
  for (const ch of CHANNELS) {
    const want = clean.edges(ch, 0, total).filter((p) => p < G0 || p >= G1);
    const got = gapped.edges(ch, 0, total);
    if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
      eFail = `ch${ch}: got ${got.length} edges want ${want.length}`;
      break;
    }
    eChecked++;
  }
  results.push({
    name: 'edges() never reports a transition inside a gap',
    pass: eFail === null,
    detail: eFail ?? `${eChecked} channels verified against the gap-free store`,
  });

  // The RLE store derived from the gapped store must agree with it exactly on bit3 and on
  // the bits of every column that does not intersect a gap - before it AND after it.
  // Only columns that touch the gap are exempt: there the planar store keeps drawing its
  // (untrusted) stored samples while the RLE store's best effort is a frozen level, so
  // comparing them would be comparing two unspecified values. Columns after the gap are
  // NOT exempt - the data there is known, and getting their levels right across the gap
  // is exactly what channelAcrossGaps exists for. This comment used to say "inside and
  // after", which is what let the inversion bug sit here unnoticed.
  // The edge lists must agree everywhere: both filter gap transitions out.
  const rle = RleSampleStore.fromStore(gapped);
  let rFail: string | null = null;
  let rChecked = 0;
  // Channels 1, 2 and 11 are the ones whose [G0, G1) swallows an ODD number of edges at
  // this capture's shape - they are the only ones a parity bug in the reconstruction can
  // show up on, and the old list [0, 5, 12, 15] happened to contain none of them.
  for (const ch of [0, 1, 2, 5, 11, 12, 15]) {
    for (const [s, e, bins] of zoomCases(total)) {
      const a = gapped.query(ch, s, e, bins);
      const b = rle.query(ch, s, e, bins);
      const bounds = columnBounds(s, e, bins);
      for (let i = 0; i < bins && !rFail; i++) {
        const c0 = bounds.a[i]!, c1 = bounds.b[i]!;
        const gapHit = c0 < G1 && c1 > G0;
        if (((b.packed[i]! ^ a.packed[i]!) & GAP_BIT) !== 0) {
          rFail = `ch${ch} [${s},${e}) x${bins} column ${i}: bit3 ${b.packed[i]! & GAP_BIT} vs ${a.packed[i]! & GAP_BIT}`;
          break;
        }
        if (!gapHit) {
          if (b.low[i] !== a.low[i] || b.high[i] !== a.high[i] || b.edge[i] !== a.edge[i]) {
            rFail = `ch${ch} [${s},${e}) x${bins} column ${i} (${c0 >= G1 ? 'post' : 'pre'}-gap)`;
            break;
          }
          rChecked++;
        }
      }
      if (rFail) break;
    }
    if (!rFail) {
      const a = gapped.edges(ch, 0, total);
      const b = rle.edges(ch, 0, total);
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) rFail = `ch${ch} edges disagree`;
    }
    if (rFail) break;
  }
  results.push({
    name: 'rle store derived from a gapped store agrees on bit3, non-gap bits and edges',
    pass: rFail === null,
    detail: rFail ?? `${rChecked} columns outside the gap (both sides) plus edge lists verified`,
  });

  // Brute-force control for the edge filtering itself: referenceEdges on the samples,
  // minus the gap, must equal the gapped store's output.
  let bFail: string | null = null;
  for (const ch of [0, 3, 5, 11]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    const want = referenceEdges(sample, 0, total, total).filter((p) => p < G0 || p >= G1);
    const got = Array.from(gapped.edges(ch, 0, total));
    if (got.length !== want.length || got.some((v, i) => v !== want[i])) { bFail = `ch${ch}`; break; }
  }
  results.push({
    name: 'gap-filtered edges vs brute force',
    pass: bFail === null,
    detail: bFail ? `first mismatch on ${bFail}` : '4 channels verified',
  });

  return results;
}

/** 4 and 8 channel modes: one byte per sample from the device layer. */
function testNarrowModes(): TestResult[] {
  const out: TestResult[] = [];
  for (const nch of [4, 8] as const) {
    const n = 300000;
    const raw = new Uint8Array(n);
    let x = 12345;
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x |= 0; x ^= x >>> 17; x ^= x << 5; x |= 0;
      // channel 0 a clock, channel 1 mostly idle, the rest pseudorandom-ish but bursty
      let v = ((i >> 3) & 1);
      if ((i % 50000) < 200) v |= (x & 0xfe);
      if (i > 100000 && i < 100003) v |= 2;
      raw[i] = v & ((1 << nch) - 1);
    }
    const store = new PlanarSampleStore({ channelCount: nch, samplerate: 10e6 });
    for (let off = 0; off < n; ) {
      const take = Math.min(7919, n - off); // prime chunk size, exercises head and tail
      store.append(raw.subarray(off, off + take));
      off += take;
    }
    let bad = -1;
    for (let i = 0; i < n && bad < 0; i++) {
      for (let c = 0; c < nch; c++) if (store.sampleAt(c, i) !== ((raw[i]! >>> c) & 1)) { bad = i; break; }
    }
    let qFail: string | null = null;
    if (bad < 0) {
      for (let c = 0; c < nch && !qFail; c++) {
        const sample = (i: number) => (raw[i]! >>> c) & 1;
        for (const bins of [1, 333, 1000]) {
          qFail = compareView(store.query(c, 0, n, bins), referenceQuery(sample, 0, n, bins), `${nch}ch ch${c} x${bins}`);
          if (qFail) break;
        }
      }
    }
    out.push({
      name: `${nch}-channel mode, prime-sized chunks`,
      pass: bad < 0 && qFail === null,
      detail: bad >= 0 ? `sample mismatch at ${bad}` : (qFail ?? 'round-trip and query verified'),
    });
  }
  return out;
}

/** Query correctness while the capture is still arriving and levels are incomplete. */
function testLiveCapture(): TestResult[] {
  const total = 2_000_003; // deliberately not a multiple of any bin size
  const ref = new Uint16Array(total);
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
  let written = 0;
  let fail: string | null = null;
  let checks = 0;
  for (const chunk of generateCapture({ totalSamples: total, chunkSamples: 65537 })) {
    const n = chunk.byteLength / 2;
    ref.set(new Uint16Array(chunk.buffer, chunk.byteOffset, n), written);
    store.append(chunk);
    written += n;
    if (written % 7 === 0 || written === total) {
      for (const ch of [0, 11, 12, 15]) {
        const sample = (i: number) => (ref[i]! >>> ch) & 1;
        const got = store.query(ch, 0, written, 137);
        fail = compareView(got, referenceQuery(sample, 0, written, 137), `live ch${ch} at n=${written}`);
        if (fail) break;
        checks++;
      }
    }
    if (fail) break;
  }
  return [{
    name: 'query during a live capture (incomplete pyramid levels)',
    pass: fail === null,
    detail: fail ?? `${checks} mid-capture queries verified against brute force`,
  }];
}

// ---------------------------------------------------------------------------

export interface GlitchCase {
  bins: number;
  start: number;
  end: number;
  pulse: number;
}

/**
 * The failure this component is famous for: a one-sample pulse in an otherwise idle
 * channel, viewed with 100,000 samples per pixel column, silently disappearing.
 *
 * Builds a real 100M-sample 16-channel store whose channel 0 is entirely low except for a
 * single high sample, then checks every one of the 1000 columns, not just the interesting
 * one - reporting the glitch everywhere would be just as wrong as reporting it nowhere.
 */
export function testNarrowGlitch(log: Log, totalSamples: number, pulses: number[]): TestResult[] {
  const results: TestResult[] = [];
  for (const pulse of pulses) {
    const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
    const zero = new Uint8Array(MACRO_SAMPLES * 2);
    let written = 0;
    while (written < totalSamples) {
      const take = Math.min(MACRO_SAMPLES, totalSamples - written);
      let patched = -1;
      if (pulse >= written && pulse < written + take) {
        patched = (pulse - written) * 2;
        zero[patched] = 1; // channel 0, low byte, bit 0
      }
      store.append(zero.subarray(0, take * 2));
      if (patched >= 0) zero[patched] = 0;
      written += take;
    }
    if (store.length !== totalSamples) throw new Error(`store length ${store.length} != ${totalSamples}`);
    if (store.sampleAt(0, pulse) !== 1) throw new Error(`pulse not stored at ${pulse}`);

    const cases: GlitchCase[] = [
      { bins: 1000, start: 0, end: totalSamples, pulse },
      { bins: 1920, start: 0, end: totalSamples, pulse },
      { bins: 1, start: 0, end: totalSamples, pulse },
      { bins: 1000, start: 7, end: totalSamples - 13, pulse },
      { bins: 997, start: 0, end: totalSamples, pulse },
    ];

    for (const c of cases) {
      const view = store.query(0, c.start, c.end, c.bins);
      const bounds = columnBounds(view.startSample, view.endSample, c.bins);
      let fail: string | null = checkTiling(view.startSample, view.endSample, c.bins);
      let flagged = 0;
      for (let i = 0; i < c.bins && !fail; i++) {
        const c0 = bounds.a[i]!, c1 = bounds.b[i]!;
        const inCol = pulse >= c0 && pulse < c1;
        const inColOrPrev = pulse >= c0 - 1 && pulse < c1;
        const wantHigh = inCol ? 1 : 0;
        const wantLow = inCol && c1 - c0 === 1 ? 1 : 0;
        const wantEdge = inColOrPrev ? 1 : 0;
        if (view.high[i] !== wantHigh || view.low[i] !== wantLow || view.edge[i] !== wantEdge) {
          fail = `column ${i} [${c0},${c1}) got low=${view.low[i]} high=${view.high[i]} edge=${view.edge[i]}` +
                 ` want low=${wantLow} high=${wantHigh} edge=${wantEdge}`;
          break;
        }
        if (view.edge[i]) flagged++;
      }
      results.push({
        name: `1-sample pulse at ${pulse} of ${totalSamples}, [${c.start},${c.end}) across ${c.bins} columns`,
        pass: fail === null,
        detail: fail ?? `${flagged} of ${c.bins} columns flagged (expected ${pulse === 0 ? 1 : 'the 1 or 2 straddling it'})`,
      });
      if (fail) log(`  FAIL ${fail}`);
    }

    // Same pulse, but seen through edges() at full range - the exact-position path.
    const ed = store.edges(0, 0, totalSamples);
    const wantEd: number[] = [];
    if (pulse >= 1) wantEd.push(pulse);
    if (pulse + 1 < totalSamples) wantEd.push(pulse + 1);
    const ok = ed.length === wantEd.length && wantEd.every((v, i) => ed[i] === v);
    results.push({
      name: `edges() finds the same 1-sample pulse at ${pulse}`,
      pass: ok,
      detail: ok ? `[${Array.from(ed).join(', ')}]` : `got [${Array.from(ed).join(', ')}] want [${wantEd.join(', ')}]`,
    });
  }
  return results;
}

/**
 * The same property on generated content rather than a hand-placed pulse: find the
 * narrowest pulse the generator actually produced on the glitch channel and confirm the
 * fully zoomed out view still shows it.
 */
export function testGeneratedGlitch(store: SampleStore, log: Log): TestResult[] {
  const ed = store.edges(12, 0, store.length);
  let narrowest = Infinity;
  let at = -1;
  for (let i = 0; i + 1 < ed.length; i++) {
    const w = ed[i + 1]! - ed[i]!;
    if (w < narrowest) { narrowest = w; at = ed[i]!; }
  }
  if (at < 0) return [{ name: 'generated glitch channel', pass: false, detail: 'no edges found on ch12' }];
  log(`  narrowest pulse on ch12: ${narrowest} sample(s) at ${at} (${ed.length} edges total)`);
  const bins = 1000;
  const view = store.query(12, 0, store.length, bins);
  const bounds = columnBounds(view.startSample, view.endSample, bins);
  let col = -1;
  for (let i = 0; i < bins; i++) if (at >= bounds.a[i]! && at < bounds.b[i]!) { col = i; break; }
  const pass = col >= 0 && view.edge[col] === 1 && view.low[col] === 0;
  return [{
    name: `generated ${narrowest}-sample pulse on ch12 survives ${store.length} samples / ${bins} columns`,
    pass,
    detail: pass
      ? `column ${col} reports edge=1 low=0 high=${view.high[col]}`
      : `column ${col} reports edge=${col >= 0 ? view.edge[col] : 'n/a'} - the glitch was dropped`,
  }];
}

// ---------------------------------------------------------------------------

/**
 * Force pyramid levels 4, 5 and 6 to be built from real content and actually read.
 *
 * The gap this closes: runFastSuite tops out at 400,000 samples, which only ever builds
 * levels 1-3, and the 100M glitch cases run against an all-zeros channel where a broken
 * upper level is indistinguishable from a working one. Mutation testing showed the top
 * two levels could be filled with garbage and the suite would still report 40/40.
 *
 * Level k is selected when 16^k * coreBins <= samplesPerBin. Sweeping coreBins makes the
 * same range get answered from several different levels, and they must all agree with
 * brute force and therefore with each other - the level is an implementation choice, not
 * part of the answer, so disagreement localises the broken level immediately.
 */
function testDeepLevels(log: Log): TestResult[] {
  const total = 24_000_000; // level 4 at coreBins=32, level 6 at coreBins=1
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });

  // Keep the reference as one byte per sample for a handful of channels rather than a
  // full copy: 24M x 16 channels of reference would be 384 MB.
  const checked = [0, 3, 5, 11, 12, 14, 15];
  const bits = new Map<number, Uint8Array>();
  for (const c of checked) bits.set(c, new Uint8Array(total));

  let written = 0;
  for (const chunk of generateCapture({ totalSamples: total, chunkSamples: 1 << 20 })) {
    const n = chunk.byteLength / 2;
    const view = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    for (const c of checked) {
      const dst = bits.get(c)!;
      for (let i = 0; i < n; i++) dst[written + i] = (view[i]! >>> c) & 1;
    }
    store.append(chunk);
    written += n;
  }

  const results: TestResult[] = [];
  let fail: string | null = null;
  const levelsSeen = new Set<number>();
  let checks = 0;

  for (const coreBins of [1, 2, 8, 32]) {
    store.coreBins = coreBins;
    for (const bins of [1, 3, 17, 1000]) {
      const spb = total / bins;
      let lvl = 0;
      while (lvl < 6 && Math.pow(16, lvl + 1) * coreBins <= spb) lvl++;
      levelsSeen.add(lvl);
      for (const c of checked) {
        const ref = bits.get(c)!;
        const sample = (i: number) => ref[i]!;
        const want = referenceQuery(sample, 0, total, bins);
        fail = compareView(store.query(c, 0, total, bins), want,
                           `deep ch${c} bins=${bins} coreBins=${coreBins} level=${lvl}`);
        if (fail) break;
        checks++;
      }
      if (fail) break;
    }
    if (fail) break;
  }
  store.coreBins = 32;

  const sorted = [...levelsSeen].sort((a, b) => a - b);
  log(`  pyramid levels selected: ${sorted.join(', ')}`);
  results.push({
    name: `pyramid levels 4-6 vs brute force (${total.toLocaleString()} samples of real content)`,
    pass: fail === null && levelsSeen.has(4) && levelsSeen.has(5) && levelsSeen.has(6),
    detail: fail ?? `${checks} queries verified across levels ${sorted.join('/')}`,
  });
  return results;
}

/** Invalid arguments must throw, not produce columns with low > high. */
function testBadArguments(store: SampleStore, tag: string): TestResult[] {
  const cases: Array<[string, () => unknown]> = [
    ['query NaN start', () => store.query(0, NaN, 500, 100)],
    ['query NaN end', () => store.query(0, 0, NaN, 100)],
    ['query Infinity start', () => store.query(0, Infinity, 500, 100)],
    ['query -Infinity start', () => store.query(0, -Infinity, 500, 100)],
    ['query Infinity end', () => store.query(0, 0, Infinity, 100)],
    ['query NaN bins', () => store.query(0, 0, 500, NaN)],
    ['query zero bins', () => store.query(0, 0, 500, 0)],
    ['query channel 16', () => store.query(16, 0, 500, 10)],
    ['query channel -1', () => store.query(-1, 0, 500, 10)],
    ['edges NaN start', () => store.edges(0, NaN, 500)],
    ['edges NaN end', () => store.edges(0, 0, NaN)],
  ];
  const bad: string[] = [];
  for (const [name, fn] of cases) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) bad.push(name);
  }
  // And the specific impossible output the guard exists to prevent.
  let impossible = '';
  try {
    const v = store.query(0, NaN, 500, 100);
    if (v.low[0]! > v.high[0]!) impossible = ` and returned low=${v.low[0]} > high=${v.high[0]}`;
  } catch { /* expected */ }
  return [{
    name: `invalid arguments throw instead of returning impossible columns (${tag})`,
    pass: bad.length === 0,
    detail: bad.length === 0
      ? `${cases.length} bad-argument cases all threw`
      : `did not throw: ${bad.join(', ')}${impossible}`,
  }];
}

/** The full suite minus the 100M-sample cases, which are driven by the bench. */
export function runFastSuite(log: Log): TestResult[] {
  const results: TestResult[] = [];
  log('generator sanity');
  {
    const tile = makeTileBlock();
    const buf = new Uint16Array(MACRO_SAMPLES);
    const toggling = new Array<number>(16).fill(0);
    for (let m = 0; m < 8; m++) {
      fillMacro(buf, m, 1, tile);
      for (let c = 0; c < 16; c++) {
        let last = (buf[0]! >>> c) & 1;
        let n = 0;
        for (let i = 1; i < MACRO_SAMPLES; i++) { const v = (buf[i]! >>> c) & 1; if (v !== last) { n++; last = v; } }
        toggling[c]! += n;
      }
    }
    // A fast clock, several bursty buses that move but not constantly, a couple of
    // near-static lines, and two rails that never move at all.
    const pass =
      toggling[0]! > 1_000_000 &&                        // fast clock
      toggling[14] === 0 && toggling[15] === 0 &&        // rails
      toggling[12]! > 0 && toggling[12]! < 40 &&         // glitch channel: rare
      toggling[13]! > 0 && toggling[13]! < 40 &&         // enable: rare
      toggling[3]! > 100 && toggling[3]! < 100_000 &&    // UART: bursty
      toggling[5]! > 100 && toggling[5]! < 100_000;      // SPI clock: bursty
    results.push({
      name: 'generator produces a mix, not noise',
      pass,
      detail: `edges per 8 x 2^20 samples per channel: ${toggling.join(', ')}`,
    });
  }
  log('brute-force comparison, aligned chunks');
  results.push(...testAgainstBruteForce(log, 1 << 16, 400000));
  log('brute-force comparison, prime chunks (unaligned append)');
  results.push(...testAgainstBruteForce(log, 4099, 400000));
  log('rle brute-force comparison, aligned chunks');
  results.push(...testRleAgainstBruteForce(log, 1 << 16, 400000));
  log('rle brute-force comparison, prime chunks (unaligned append)');
  results.push(...testRleAgainstBruteForce(log, 4099, 400000));
  log('rle transition quantisation');
  results.push(...testRleQuantization());
  log('gap spans');
  results.push(...testGaps());
  log('narrow channel modes');
  results.push(...testNarrowModes());
  log('live capture');
  results.push(...testLiveCapture());
  log('bad arguments');
  {
    const planar = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
    planar.append(new Uint8Array(4096 * 2));
    results.push(...testBadArguments(planar, 'planar'));
    const rle = RleSampleStore.fromTransitions(16, 100e6, 4096,
      Array.from({ length: 16 }, () => ({ initial: 0, transitions: new Float64Array(0) })));
    results.push(...testBadArguments(rle, 'rle'));
    let rleAppendThrows = false;
    try { rle.append(new Uint8Array(2)); } catch { rleAppendThrows = true; }
    results.push({
      name: 'rle append throws (immutable store)',
      pass: rleAppendThrows,
      detail: rleAppendThrows ? 'append() refused' : 'append() did not throw',
    });
  }
  log('deep pyramid levels (24M samples, this one takes a few seconds)');
  results.push(...testDeepLevels(log));
  return results;
}

export function formatResults(results: TestResult[]): string {
  const lines = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  lines.push(`\n${results.length - failed}/${results.length} passed`);
  return lines.join('\n');
}
