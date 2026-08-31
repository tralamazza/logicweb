// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the .lwcap round-trip suite.
 *
 *   node_modules/.bin/esbuild src/ui/tools/lwcap-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/logicweb-lwcap-tests.mjs && node /tmp/logicweb-lwcap-tests.mjs
 *
 * Exits non-zero on the first failure. The format is ours (src/ui/captureIO.ts), so a
 * bug here is a silent data-loss bug for every user who saves a capture: the suite pins
 *
 *   - gapless round trip stays byte-identical (edges, initial levels, queries),
 *   - gap spans survive save -> load -> save,
 *   - a gapped capture loads with the same bit3 columns and the same bits on BOTH sides of
 *     the gap (the post-gap half is the one that caught the parity inversion),
 *   - v1 files (written before gap support) still load as gapless,
 *   - corrupt v2 spans throw instead of being silently merged.
 */

import { PlanarSampleStore, generateCapture } from '../../data/index.js';
import type { SampleStore } from '../../data/index.js';
import { saveLwcap, loadLwcap, levelAt } from '../captureIO.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') {
    throw new Error('this entry point only runs under node');
  }
  return p;
})();

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function buildPlanar(chunkSamples: number): PlanarSampleStore {
  const total = 200000;
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 10e6 });
  for (const chunk of generateCapture({ totalSamples: total, chunkSamples })) {
    store.append(chunk);
  }
  return store;
}

function compareStores(a: SampleStore, b: SampleStore, tag: string): string | null {
  if (a.length !== b.length) return `${tag}: length ${a.length} != ${b.length}`;
  const n = a.length;
  for (let c = 0; c < 16; c++) {
    const ea = a.edges(c, 0, n);
    const eb = b.edges(c, 0, n);
    if (ea.length !== eb.length || ea.some((v, i) => v !== eb[i])) return `${tag}: ch${c} edges differ`;
    if (levelAt(a, c, 0) !== levelAt(b, c, 0)) return `${tag}: ch${c} initial differs`;
  }
  for (const [s, e, bins] of [[0, n, 1000], [0, n, 97], [12345, 54321, 3200], [n - 100, n, 1000]] as Array<[number, number, number]>) {
    for (let c = 0; c < 16; c++) {
      const va = a.query(c, s, e, bins);
      const vb = b.query(c, s, e, bins);
      for (let i = 0; i < bins; i++) {
        if (va.packed[i] !== vb.packed[i]) return `${tag}: ch${c} [${s},${e}) x${bins} col ${i}: ${va.packed[i]} vs ${vb.packed[i]}`;
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const names = Array.from({ length: 16 }, (_, i) => `Channel ${i}`);

  // 1. Gapless round trip.
  {
    const store = buildPlanar(4099);
    const blob = saveLwcap(store, names);
    const loaded = loadLwcap(await blob.arrayBuffer(), 'gapless.lwcap');
    const fail = compareStores(store, loaded.store, 'gapless round trip');
    results.push({
      name: 'gapless round trip byte-identical',
      pass: fail === null,
      detail: fail ?? `${blob.size} bytes, ${store.length} samples, edges and queries verified`,
    });
  }

  // 2. Gapped round trip: spans survive, bit3 identical, bits identical on both sides of
  //    the gap. Only columns intersecting the gap are exempt.
  {
    const store = buildPlanar(4099);
    store.noteGap(40000, 90000);
    store.noteGap(120000, 120001);
    store.noteGap(60000, 150000); // merges into [40000, 150000)
    const G0 = 40000, G1 = 150000;
    const blob = saveLwcap(store, names);
    const loaded = loadLwcap(await blob.arrayBuffer(), 'gapped.lwcap');

    const spans = loaded.store.gaps();
    const spansOk = spans.length === 1 && spans[0]!.startSample === G0 && spans[0]!.endSample === G1;

    const n = store.length;
    let qFail = '';
    let checked = 0;
    for (const [s, e, bins] of [[0, n, 1000], [0, n, 97], [50000, 140000, 3200], [n - 100, n, 1000]] as Array<[number, number, number]>) {
      if (qFail) break;
      for (let c = 0; c < 16 && !qFail; c++) {
        const a = store.query(c, s, e, bins);
        const b = loaded.store.query(c, s, e, bins);
        const width = e - s;
        for (let i = 0; i < bins && !qFail; i++) {
          const c0 = s + Math.floor((i * width) / bins);
          const c1 = s + Math.floor(((i + 1) * width) / bins);
          const gapHit = c0 < G1 && c1 > G0;
          if (((a.packed[i]! ^ b.packed[i]!) & 8) !== 0) {
            qFail = `ch${c} [${s},${e}) x${bins} col ${i}: bit3 differs`;
            break;
          }
          if (!gapHit && (a.low[i] !== b.low[i] || a.high[i] !== b.high[i] || a.edge[i] !== b.edge[i])) {
            qFail = `ch${c} [${s},${e}) x${bins} col ${i}: ${c0 >= G1 ? 'post' : 'pre'}-gap bits differ`;
            break;
          }
          checked++;
        }
      }
    }
    // Round-trip stability: save the loaded store again, spans must be unchanged.
    const blob2 = saveLwcap(loaded.store, names);
    const loaded2 = loadLwcap(await blob2.arrayBuffer(), 'gapped2.lwcap');
    const spans2 = loaded2.store.gaps();
    const stable = spans2.length === 1 && spans2[0]!.startSample === G0 && spans2[0]!.endSample === G1;

    results.push({
      name: 'gap spans survive save -> load -> save',
      pass: spansOk && qFail === '' && stable,
      detail: qFail
        ? qFail
        : (spansOk && stable ? `[${G0}, ${G1}), ${checked} columns verified` : `spans: first=${spansOk}, second=${stable}`),
    });

    // Edges: the gapped round trip filters gap transitions like the source store.
    let eFail = '';
    for (let c = 0; c < 16 && !eFail; c++) {
      const a = store.edges(c, 0, n);
      const b = loaded.store.edges(c, 0, n);
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) eFail = `ch${c} (${a.length} vs ${b.length})`;
    }
    results.push({
      name: 'gapped round trip filters the same edges',
      pass: eFail === '',
      detail: eFail ? eFail : '16 channels byte-identical',
    });
  }

  // 3. A v1 file still loads as gapless.
  {
    const store = buildPlanar(4099);
    const blob = saveLwcap(store, names);
    const u8 = new Uint8Array(await blob.arrayBuffer());
    for (let i = 0; i < 8; i++) u8[i] = 'LWCAP1\0\0'.charCodeAt(i);
    u8[12] = 0; u8[13] = 0; u8[14] = 0; u8[15] = 0;
    const loaded = loadLwcap(u8.buffer, 'v1.lwcap');
    const fail = compareStores(store, loaded.store, 'v1 file');
    const gapless = loaded.store.gaps().length === 0;
    results.push({
      name: 'v1 file loads and carries no gaps',
      pass: fail === null && gapless,
      detail: fail ?? `loaded, gaps=${loaded.store.gaps().length}`,
    });
  }

  // 4. Corrupt v2 spans throw, not merge.
  {
    const store = buildPlanar(4099);
    store.noteGap(40000, 90000);
    const blob = saveLwcap(store, names);
    const ab = await blob.arrayBuffer();
    const bad: string[] = [];
    for (const [name, s, e] of [
      ['reversed span', 90000, 40000],
      ['span past length', 1000, 99999999],
    ] as Array<[string, number, number]>) {
      const u8 = new Uint8Array(ab.slice(0));
      const dv = new DataView(u8.buffer);
      const nameLen = dv.getUint32(32, true);
      const o = 36 + nameLen;
      dv.setUint32(o, s, true);
      dv.setUint32(o + 4, e, true);
      try {
        loadLwcap(u8.buffer, `corrupt-${name}.lwcap`);
        bad.push(name);
      } catch { /* expected */ }
    }
    results.push({
      name: 'corrupt v2 spans throw instead of loading',
      pass: bad.length === 0,
      detail: bad.length === 0 ? 'reversed and past-length spans both threw' : `did not throw: ${bad.join(', ')}`,
    });
  }

  console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  nodeProcess.exit(failed === 0 ? 0 : 1);
}

void main();
