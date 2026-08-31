// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry for the benchmark. The browser run is the one that counts (that is where
 * this code will actually live), but node is the same V8 and it makes the edit-measure
 * loop fast. Node has no tab-level memory API, so the memory prediction is reported as
 * not verifiable here rather than as a pass.
 *
 *   node_modules/.bin/esbuild src/data/bench/runbench.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/logicweb-bench.mjs
 *   node --max-old-space-size=8000 --expose-gc /tmp/logicweb-bench.mjs
 */

import { runBench, type MemSample } from './bench.js';
import { nodeProcess, nodeGc } from './nodeglobals.js';

const proc = nodeProcess();
const gc = nodeGc();

// async to match BenchOptions.sampleMemory, which the browser needs for the awaitable
// measureUserAgentSpecificMemory(); node's rss read is synchronous.
async function sampleMemory(label: string): Promise<MemSample | null> {
  if (gc) gc();
  const rss = proc.memoryUsage().rss;
  console.log(`  [mem] ${label}: rss ${(rss / 1e6).toFixed(0)} MB` + (gc ? '' : ' (no --expose-gc, not settled)'));
  return { method: 'process.memoryUsage().rss (node, not the browser number)', bytes: rss };
}

const total = Number(proc.env['SAMPLES'] ?? 100_000_000);

const report = await runBench({
  totalSamples: total,
  chunkSamples: 1 << 20,
  bins: 1000,
  log: (s) => console.log(s),
  sampleMemory,
});

console.log('\n--- json ---');
console.log(JSON.stringify(report, null, 1));
