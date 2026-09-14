// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The 32ch/200M question, asked without a board.
 *
 * Both arms run the same code the app runs - `Slogic16U3`, the same `PlanarSampleStore`
 * append the capture panel does, the same 3,129,344-byte transfers - against a device that
 * produces on its own clock with a FIFO behind it. The only difference between the arms is
 * which thread owns the read loop. What is measured is therefore not "is the browser fast
 * enough" in the abstract but whether the page's own stalls (NOTES 8.18: 20-38 ms while a
 * multi-gigabyte store is built) cost the device data or not.
 *
 * Loaded as a module by the CDP driver (`window-bench.mjs`); not imported by the app.
 */

import { Slogic16U3 } from '../slogic16u3.js';
import { WorkerSlogicDevice, type WorkerStats } from '../workerTransport.js';
import { ClockStreamDevice } from '../fakeUsb.js';
import { createSampleStore } from '../../data/index.js';
import type { SampleStore } from '../../data/types.js';
import FakeUsbWorker from './fakeUsbWorker.js?worker&inline';
import type { Stats } from '../slogic16u3.js';

export interface ArmReport {
  transport: 'page' | 'worker';
  seconds: number;
  /** Set when the arm aborted: the watchdog firing is a result, not a harness failure. */
  error?: string;
  /** MB/s the host took off the wire. */
  rawMBps: number;
  /** MB/s the configuration should produce; 800,000 B/ms is 795.7 MB/s at 32ch/200M. */
  expectedMBps: number;
  /** Longest stretch with no transferIn outstanding, ms: the device had nothing to fill. */
  maxIdleGapMs: number;
  /** Longest this arm's read-loop thread could not run a 4 ms timer, ms. */
  threadStallMaxMs: number;
  threadStalls: number;
  /** Worker arm only: longest the page itself was blocked, ms. */
  pageStallMaxMs: number;
  /** Bytes the device produced that the host never collected. Data lost, not slowed. */
  droppedBytes: number;
  /** Milliseconds the scripted sampler had no queued read at all. */
  starvedMs: number;
  worstStarveMs: number;
  transfers: number;
  shortTransfers: number;
  slowTransfers: number;
  sinkMsP95: number;
  samples: number;
  storeMB: number;
}

export interface HarnessOptions {
  /** Bytes the scripted sampler produces per millisecond: 800,000 = 32ch@200M. */
  bytesPerMs?: number;
  seconds?: number;
  channels?: 4 | 8 | 16 | 32;
  fifoBytes?: number;
  /**
   * Hold the page's thread for `stallMs` every `stallEveryMs`, the way a store append plus
   * a garbage collection does on real hardware (NOTES 8.18: 20-38 ms). Without this the two
   * arms can both pass - the store alone stays inside the budget - and the harness would be
   * measuring the scripted store rather than the architecture.
   */
  stallMs?: number;
  stallEveryMs?: number;
}

const TRANSFER_BYTES = 3_129_344;
const BYTES_PER_SAMPLE = 4; // 32 channels pack one sample into four bytes

/** Busy-wait on the page's own thread, the way a long append or a GC does. */
function startStalls(options: HarnessOptions): () => void {
  const stallMs = options.stallMs ?? 0;
  const everyMs = options.stallEveryMs ?? 300;
  if (stallMs <= 0) return () => {};
  const timer = setInterval(() => {
    const until = performance.now() + stallMs;
    while (performance.now() < until) { /* hold the thread */ }
  }, everyMs);
  return () => clearInterval(timer);
}

function report(
  transport: 'page' | 'worker', seconds: number, stats: Stats,
  pageStallMaxMs: number, droppedBytes: number, store: SampleStore,
  starvedMs = 0, worstStarveMs = 0,
): ArmReport {
  return {
    transport,
    seconds,
    rawMBps: stats.steadyMBps,
    expectedMBps: stats.expectedMBps,
    maxIdleGapMs: stats.maxIdleGapMs,
    threadStallMaxMs: stats.threadStallMaxMs,
    threadStalls: stats.threadStalls,
    pageStallMaxMs,
    droppedBytes,
    starvedMs,
    worstStarveMs,
    transfers: stats.transfers,
    shortTransfers: stats.shortTransfers,
    slowTransfers: stats.slowTransfers,
    sinkMsP95: stats.sinkMsP95,
    samples: store.length,
    storeMB: (store.length * BYTES_PER_SAMPLE) / 1e6,
  };
}

/** The page's sink, copied from the capture panel: append, and stop when the budget is hit. */
function makeSink(store: SampleStore, budgetSamples: number, onFull: () => void) {
  return (chunk: Uint8Array): void => {
    const room = (budgetSamples - store.length) * BYTES_PER_SAMPLE;
    if (room <= 0) return;
    store.append(room < chunk.length ? chunk.subarray(0, room) : chunk);
    if (store.length >= budgetSamples) onFull();
  };
}

/** Arm A: the transport as it was before the worker, on the page's own thread. */
export async function runPageArm(options: HarnessOptions = {}): Promise<ArmReport> {
  const seconds = options.seconds ?? 2;
  const channels = options.channels ?? 32;
  const samplerate = (options.bytesPerMs ?? 800_000) * 1000 / (channels / 8);
  const cfg = { channels, samplerate, thresholdVolts: 1.6 } as const;
  const budgetSamples = Math.floor(samplerate * seconds);
  // `createSampleStore`, not `PlanarSampleStore`: at 32 channels the app deliberately uses
  // the interleaved store, because a synchronous 32-plane transpose costs 8.5 ms per chunk
  // against a 3.9 ms budget (measured in this harness's first run, which is how it got
  // caught). The arms have to run the consumer the shipping app runs.
  const store = createSampleStore(channels, samplerate);
  const device = new ClockStreamDevice(options.bytesPerMs ?? 800_000,
    options.fifoBytes ?? 262_144);
  const dev = new Slogic16U3(device as unknown as USBDevice);
  await dev.open();
  const stopStalls = startStalls(options);
  let full = false;
  let filled!: () => void;
  const done = new Promise<void>((resolve) => { filled = resolve; });
  const sink = makeSink(store, budgetSamples, () => { if (!full) { full = true; filled(); } });
  let error: string | undefined;
  await dev.start(cfg, sink);
  await Promise.race([done, new Promise((r) => setTimeout(r, seconds * 1000 + 250))]);
  try {
    await dev.stop();
  } catch (e) {
    error = String(e);
  }
  stopStalls();
  device.release();
  return {
    ...report('page', seconds, dev.getStats(), dev.getStats().threadStallMaxMs,
      device.droppedBytes, store, device.starvedMs, device.worstStarveMs),
    ...(error === undefined ? {} : { error }),
  };
}

/** Arm B: the same driver, the same store, the read loop on the worker's thread. */
export async function runWorkerArm(options: HarnessOptions = {}): Promise<ArmReport> {
  const seconds = options.seconds ?? 2;
  const channels = options.channels ?? 32;
  const bytesPerMs = options.bytesPerMs ?? 800_000;
  const samplerate = bytesPerMs * 1000 / (channels / 8);
  const cfg = { channels, samplerate, thresholdVolts: 1.6 } as const;
  const budgetSamples = Math.floor(samplerate * seconds);
  const store = createSampleStore(channels, samplerate);
  // The scripted device lives on the worker's side, so its rate has to be handed over
  // before the first message: the worker's own name is the one channel that exists before
  // any postMessage does.
  const worker = new FakeUsbWorker({ name: String(bytesPerMs) });
  // The scripted device's own numbers are only visible on the worker's side of the wall.
  const probe = { dropped: 0, starvedMs: 0, worstStarveMs: 0 };
  worker.addEventListener('message', (event: MessageEvent<{
    kind?: string; droppedBytes?: number; starvedMs?: number; worstStarveMs?: number;
  }>) => {
    if (event.data?.kind !== 'harness-report') return;
    probe.dropped = event.data.droppedBytes ?? 0;
    probe.starvedMs = event.data.starvedMs ?? 0;
    probe.worstStarveMs = event.data.worstStarveMs ?? 0;
  });
  const dev = await WorkerSlogicDevice.open(
    { vendorId: 0x359f, productId: 0x3032, serial: 'clock' },
    { spawn: () => worker, openTimeoutMs: 5000 },
  );
  const stopStalls = startStalls(options);
  let full = false;
  let filled!: () => void;
  const done = new Promise<void>((resolve) => { filled = resolve; });
  const sink = makeSink(store, budgetSamples, () => { if (!full) { full = true; filled(); } });
  await dev.start(cfg, sink);
  await Promise.race([done, new Promise((r) => setTimeout(r, seconds * 1000 + 250))]);
  let error: string | undefined;
  try {
    await dev.stop();
  } catch (e) {
    error = String(e);
  }
  stopStalls();
  worker.postMessage({ kind: 'harness-report' });
  await new Promise((r) => setTimeout(r, 50));
  const stats: WorkerStats = await dev.getStats();
  worker.terminate();
  return {
    ...report('worker', seconds, stats, stats.pageStallMaxMs, probe.dropped, store,
      probe.starvedMs, probe.worstStarveMs),
    ...(error === undefined ? {} : { error }),
  };
}

export { TRANSFER_BYTES };
