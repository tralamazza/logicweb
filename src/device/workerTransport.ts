// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The page's handle on the transport that lives in `usbWorker.ts`.
 *
 * It implements the same `Device` contract as the in-page transport, so everything
 * downstream - the store, the trigger, the panels - cannot tell the difference. What
 * changes is which thread has to be scheduled for a completed transferIn to be replaced:
 * the worker's, which has nothing else to do, instead of the page's, which is appending
 * to a multi-gigabyte store and drawing it (NOTES 8.18).
 */

import { LoopStallWatch, Slogic16U3, USB_FILTERS } from './slogic16u3.js';
import type { Stats, StartOptions } from './slogic16u3.js';
import type {
  CaptureConfig, CaptureStartOptions, Device, DropoutSink, SampleSink,
} from './types.js';
import type {
  DeviceFilter, FromWorker, ToWorker, WorkerStartOptions,
} from './usbWorkerProtocol.js';

/** A worker that never answers is the failure this whole file is written to avoid. */
const OPEN_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5000;
const CONSOLE_TIMEOUT_MS = 10_000;

/**
 * The worker's statistics plus the one thing only the page can measure.
 *
 * `threadStallMaxMs` in `Stats` belongs to the thread running the read loop - the worker,
 * where it should read "never blocked". The page's own stalls are reported separately
 * because they are what the architecture is there to absorb, not a fault.
 */
export interface WorkerStats extends Stats {
  /** Longest the page could not run a 4 ms timer during the capture, ms. */
  pageStallMaxMs: number;
  /** Page stalls over the report threshold during the capture. */
  pageStalls: number;
}

/**
 * How the browser builds the worker. It is installed by `usbWorkerSpawn.ts` rather than
 * imported here, because the constructor comes from `./usbWorker.ts?worker&inline` and a
 * specifier only a Vite build can resolve would keep this file out of the plain esbuild
 * bundle the offline suite runs on.
 */
let installedSpawn: (() => Worker) | null = null;

export function installUsbWorkerSpawn(spawn: () => Worker): void {
  installedSpawn = spawn;
}

/**
 * What a test (or a future caller with different patience) may substitute. The browser
 * spawns a real Vite worker; the offline suite passes a fake that answers by hand.
 */
export interface WorkerTransportOptions {
  spawn?: () => Worker;
  openTimeoutMs?: number;
  stopTimeoutMs?: number;
  requestTimeoutMs?: number;
  consoleTimeoutMs?: number;
}

export class WorkerSlogicDevice implements Device {
  onError: ((error: unknown) => void) | null = null;
  onTrace: ((entry: FromWorker & { kind: 'trace' }) => void) | null = null;

  /**
   * What the *page* was doing while the worker kept the device fed.
   *
   * The worker owns the read loop, so its own stall probe measures the worker thread and
   * will say "never blocked" almost every time - which is the point of the split, and also
   * why it cannot show what the device was being protected from. This one does: it runs on
   * the page for the length of the capture, so the numbers that used to explain a starved
   * capture (a 38 ms garbage collection against a 19.6 ms queue) are still recorded, now
   * as the reason they stopped mattering.
   */
  private readonly pageStalls = new LoopStallWatch();

  private readonly waiters = new Map<string, Array<{
    resolve: (message: FromWorker) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>>();
  private sink: SampleSink | null = null;
  private dropout: DropoutSink | null = null;
  private triggerState: CaptureStartOptions['onTriggerState'] | null = null;
  private readonly inFlight = new Map<number, Promise<void>>();
  private stopped = false;

  private constructor(
    private readonly worker: Worker,
    readonly name: string,
    readonly serial: string,
    readonly maxChannels: number,
    readonly maxSamplerateHz: Readonly<Record<number, number>>,
    private readonly timeouts: Required<Omit<WorkerTransportOptions, 'spawn'>>,
  ) {
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.onMessage(event.data);
    worker.onerror = (event) => {
      this.failAll(new Error(`USB worker error: ${event.message || 'unknown'}`));
    };
  }

  /**
   * Ask a worker to open the device the page has already been granted. Throws if the
   * worker cannot see it, which is the caller's signal to fall back to the in-page
   * transport rather than to give up on the device.
   */
  static async open(
    filter: DeviceFilter, options: WorkerTransportOptions = {},
  ): Promise<WorkerSlogicDevice> {
    const spawn = options.spawn ?? installedSpawn;
    // No `typeof Worker` test here: without a spawn nothing can be started anyway, and
    // with one the caller has already decided the environment supports workers (the
    // offline suite passes a fake, in Node, where the global does not exist).
    if (!spawn) throw new Error('workers are unavailable');
    const timeouts = {
      openTimeoutMs: options.openTimeoutMs ?? OPEN_TIMEOUT_MS,
      stopTimeoutMs: options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      consoleTimeoutMs: options.consoleTimeoutMs ?? CONSOLE_TIMEOUT_MS,
    };
    const worker = spawn();
    const opened = firstMessage(worker, 'opened', timeouts.openTimeoutMs);
    try {
      post(worker, { kind: 'open', filter });
      const message = await opened;
      if (message.kind === 'failed') throw new Error(message.message);
      if (message.kind !== 'opened') throw new Error('the worker did not report a device');
      return new WorkerSlogicDevice(
        worker, message.name, message.serial, message.maxChannels, message.maxSamplerateHz,
        timeouts,
      );
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }

  async start(
    cfg: CaptureConfig, sink: SampleSink, onDropout?: DropoutSink, options: StartOptions = {},
  ): Promise<void> {
    this.sink = sink;
    this.dropout = onDropout ?? null;
    this.triggerState = options.onTriggerState ?? null;
    this.pageStalls.start();
    // Functions cannot cross a structured clone: the callback stays here and the worker
    // reports transitions as messages (the type enforces that split).
    const { onTriggerState: _ignored, ...wire } = options;
    const started = this.waitFor('started', this.timeouts.openTimeoutMs);
    post(this.worker, {
      kind: 'start',
      cfg,
      // The read loop runs over there: any abort that names a blocked thread has to name
      // the worker, or a page stall that the split was built to absorb reads as the cause.
      options: { ...wire, threadLabel: 'worker' } as WorkerStartOptions,
    });
    let message: FromWorker;
    try {
      message = await started;
    } catch (error) {
      this.pageStalls.stop();
      throw error;
    }
    if (message.kind === 'failed') {
      this.pageStalls.stop();
      throw new Error(message.message);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    const stopped = this.waitFor('stopped', this.timeouts.stopTimeoutMs);
    post(this.worker, { kind: 'stop' });
    let message: FromWorker;
    try {
      message = await stopped;
    } finally {
      this.pageStalls.stop();
    }
    if (message.kind === 'failed') throw new Error(message.message);
  }

  /** Nothing on the page can use the device after this; the OS handle dies with it. */
  terminate(): void {
    this.stopped = true;
    this.pageStalls.stop();
    this.failAll(new Error('the worker transport was terminated'));
    this.worker.terminate();
  }

  async getStats(): Promise<WorkerStats> {
    const message = await this.request(
      { kind: 'stats' }, 'stats', this.timeouts.requestTimeoutMs,
    );
    // A `failed` reply is the worker saying why the command threw; reporting it as "no
    // statistics" would hide the one sentence that matters.
    if (message.kind === 'failed') throw new Error(message.message);
    if (message.kind !== 'stats') throw new Error('the worker answered with no statistics');
    return {
      ...message.stats,
      pageStallMaxMs: this.pageStalls.maxMs,
      pageStalls: this.pageStalls.count,
    };
  }

  async usbControl(command: string): Promise<string> {
    // `bench` is the one command that measures rather than configures, and it runs the
    // read loop over there. The reply's thread numbers are therefore the worker's, and the
    // question the bench exists to answer - what was this side doing while the device was
    // being drained - can only be answered here.
    const bench = command.trim().split(/\s+/)[0] === 'bench';
    if (bench) this.pageStalls.start();
    try {
      const message = await this.request(
        { kind: 'console', command }, 'console', this.timeouts.consoleTimeoutMs,
      );
      // A `failed` reply is the worker saying why the command threw. Reporting it as "no
      // console result" hides the one sentence that matters - measured on hardware, where a
      // bench that aborted with a rate report looked like a protocol bug instead.
      if (message.kind === 'failed') throw new Error(message.message);
      if (message.kind !== 'console') throw new Error('the worker answered with no console result');
      return bench
        ? `${message.result}\n  page       thread blocked ${this.pageStalls.count} time(s), ` +
          `worst ${this.pageStalls.maxMs.toFixed(1)} ms (measured here, not in the worker)`
        : message.result;
    } finally {
      if (bench) this.pageStalls.stop();
    }
  }

  private request(message: ToWorker, kind: string, timeoutMs: number): Promise<FromWorker> {
    const waiting = this.waitFor(kind, timeoutMs);
    post(this.worker, message);
    return waiting;
  }

  private waitFor(kind: string, timeoutMs: number): Promise<FromWorker> {
    return new Promise<FromWorker>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(kind);
        if (list) {
          const index = list.findIndex((w) => w.timer === timer);
          if (index >= 0) list.splice(index, 1);
        }
        reject(new Error(`the USB worker did not answer "${kind}" within ${timeoutMs} ms`));
      }, timeoutMs);
      const list = this.waiters.get(kind) ?? [];
      list.push({ resolve, reject, timer });
      this.waiters.set(kind, list);
    });
  }

  private settle(kind: string, message: FromWorker): boolean {
    const list = this.waiters.get(kind);
    const waiter = list?.shift();
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    waiter.resolve(message);
    return true;
  }

  private onMessage(message: FromWorker): void {
    switch (message.kind) {
      case 'chunk': {
        const view = new Uint8Array(message.buffer, message.offset, message.length);
        const sink = this.sink;
        // The page's own sink is synchronous; a future one may not be. Either way the ack
        // is what releases the worker's next URB slot, so it follows the append.
        let result: void | Promise<void>;
        try {
          result = sink?.(view);
        } catch (error) {
          this.ack(message.id);
          this.onError?.(error);
          return;
        }
        if (result && typeof result.then === 'function') {
          const done = result.then(
            () => this.ack(message.id),
            (error: unknown) => { this.ack(message.id); this.onError?.(error); },
          );
          this.inFlight.set(message.id, done);
          void done.finally(() => this.inFlight.delete(message.id));
        } else {
          this.ack(message.id);
        }
        return;
      }
      case 'dropout':
        this.dropout?.(message.position, message.missing);
        return;
      case 'trigger':
        this.triggerState?.(message.state, message.index);
        return;
      case 'trace':
        this.onTrace?.(message);
        return;
      case 'error':
        // Transport-level and fatal: the read loop is over, so is the page measurement.
        this.pageStalls.stop();
        this.onError?.(new Error(message.message));
        return;
      case 'failed': {
        // A failure answers whatever the page is waiting for; with nothing outstanding it
        // is a transport-level error and belongs on the same path as `error`.
        for (const kind of ['opened', 'started', 'stopped', 'stats', 'console']) {
          if (this.settle(kind, message)) return;
        }
        this.onError?.(new Error(message.message));
        return;
      }
      case 'opened':
      case 'started':
      case 'stopped':
      case 'stats':
      case 'console':
        if (!this.settle(message.kind, message)) {
          this.onError?.(
            new Error(`the USB worker answered "${message.kind}" with nobody waiting`),
          );
        }
        return;
    }
  }

  private ack(id: number): void {
    post(this.worker, { kind: 'ack', id });
  }

  private failAll(error: Error): void {
    this.sink = null;
    for (const [, list] of this.waiters) {
      for (const waiter of list.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  }
}

/**
 * Wait for one message of a kind, before the class exists - the constructor needs the
 * identity the worker reports and cannot be built until it arrives.
 */
function firstMessage(
  worker: Worker, kind: FromWorker['kind'], timeoutMs: number,
): Promise<FromWorker> {
  return new Promise<FromWorker>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.onmessage = null;
      reject(new Error(`the USB worker did not answer "${kind}" within ${timeoutMs} ms`));
    }, timeoutMs);
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.kind !== kind && message.kind !== 'failed') return;
      clearTimeout(timer);
      worker.onmessage = null;
      resolve(message);
    };
  });
}

function post(worker: Worker, message: ToWorker): void {
  worker.postMessage(message);
}

/** The in-page transport, used when the worker path is unavailable or refused. */
export async function openInPage(usb: USBDevice): Promise<Device> {
  const device = new Slogic16U3(usb);
  await device.open();
  return device;
}

/**
 * The device layer the UI should talk to, worker-first.
 *
 * The worker is preferred because it is the only way a page that has to draw and collect
 * garbage can keep the USB queue fed, but it is not required: this falls back to the
 * in-page transport whenever the worker cannot see the device, and reports why through
 * `onWorkerFallback` so the reason is visible instead of silently slower.
 */
export const workerTransport = {
  preferred: true,
  lastFallbackReason: '',

  /** Open the device the page already has permission for, on the best available thread. */
  async open(usb: USBDevice): Promise<Device> {
    if (!this.preferred) return openInPage(usb);
    // A worker without WebUSB can still spawn and will say so; skipping the round trip
    // keeps the fallback free in browsers that have no worker-side support at all.
    if (typeof navigator === 'undefined' || !navigator.usb) return openInPage(usb);
    try {
      const device = await WorkerSlogicDevice.open({
        vendorId: usb.vendorId,
        productId: usb.productId,
        serial: usb.serialNumber ?? undefined,
      });
      this.lastFallbackReason = '';
      return device;
    } catch (error) {
      this.lastFallbackReason = error instanceof Error ? error.message : String(error);
      return openInPage(usb);
    }
  },
};

export { USB_FILTERS };
