// SPDX-License-Identifier: GPL-3.0-or-later
/** Focused ingest benchmark for the SLogic32 U3 4-byte sample path. */

import { PlanarSampleStore } from '../planarStore.js';
import { InterleavedSampleStore } from '../interleavedStore.js';

const chunkBytes = 32 * 1024 * 1024;
const repeats = 4;
const raw = new Uint8Array(chunkBytes);
for (let i = 0; i < raw.length; i += 4096) raw[i] = i & 0xff;

// Warm the transposer and pyramid code before measuring the sustained chunks.
new PlanarSampleStore({ channelCount: 32, samplerate: 200e6 }).append(raw.subarray(0, 4 * 1024 * 1024));

const samplesPerChunk = chunkBytes / 4;
interface StreamMeasure {
  name: string;
  chunkMs: number[];
  averageMSaPerSec: number;
  memoryMiB: number;
}

function measure(name: string, store: PlanarSampleStore | InterleavedSampleStore): StreamMeasure {
  const times: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const start = performance.now();
    store.append(raw);
    times.push(performance.now() - start);
  }
  const elapsed = times.reduce((a, b) => a + b, 0);
  const samples = samplesPerChunk * repeats;
  return {
    name,
    chunkMs: times.map((v) => Number(v.toFixed(2))),
    averageMSaPerSec: Number((samples / elapsed / 1000).toFixed(1)),
    memoryMiB: Number((store.memory().totalBytes / 1024 / 1024).toFixed(1)),
  };
}
const report = {
  chunkMiB: chunkBytes / 1024 / 1024,
  repeats,
  requiredMSaPerSec: 200,
  stores: [
    measure('planar32', new PlanarSampleStore({ channelCount: 32, samplerate: 200e6 })),
    measure('interleaved32', new InterleavedSampleStore(200e6, 32)),
  ],
};
console.log(JSON.stringify(report));
const shipping = report.stores[1]!;
if (shipping.averageMSaPerSec < report.requiredMSaPerSec) {
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (proc) proc.exitCode = 1;
}
