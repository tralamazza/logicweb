// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The USB transport, on a thread of its own.
 *
 * Everything in this file runs in a Dedicated Worker; the page only ever sees chunks and
 * survives on the other side of the pipe. That is the split libsigrok already has - the
 * libusb event thread reaps and resubmits URBs (protocol.c:325) while the session thread
 * consumes a `GAsyncQueue` - and it is the only shippable way to keep a re-arm from
 * waiting on the page: at 32ch/200M a 4 s capture is 3.2 GB of store, and the garbage
 * collection that comes with it blocks the main thread for 20-38 ms against a USB queue
 * that only covers 19.6 ms (NOTES 8.18).
 *
 * WebUSB exposes `getDevices()` in workers but not `requestDevice`, so the one-time grant
 * stays a page-side, user-gesture operation; the worker then opens the device the origin
 * already has permission for. `navigator.usb` is missing entirely in older browsers, and
 * the page falls back to its own transport when `open` cannot find the device.
 */

import { Slogic16U3 } from './slogic16u3.js';
import type { SampleSink } from './types.js';
import type {
  ChunkMessage, FromWorker, ToWorker, WorkerStartOptions,
} from './usbWorkerProtocol.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let device: Slogic16U3 | null = null;
/**
 * One resolver per chunk in flight. The transport treats the returned promise as
 * backpressure (`StreamTuning.lagChunks`), so a slow page stops the worker from
 * replenishing the USB queue instead of piling chunks up in the message queue.
 */
const acks = new Map<number, () => void>();
let nextChunkId = 1;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

/**
 * Hand a delivered chunk to the page. The buffer is *transferred*: the transport never
 * touches a completed transfer's buffer again (each one comes from a fresh `transferIn`),
 * so this costs nothing and leaves the page the only owner.
 */
const sink: SampleSink = (chunk: Uint8Array): Promise<void> => {
  const id = nextChunkId++;
  const buffer = chunk.buffer as ArrayBuffer;
  const message: ChunkMessage = {
    kind: 'chunk', id, buffer,
    // After the head drop the payload starts at an offset into the transfer buffer.
    offset: chunk.byteOffset, length: chunk.byteLength,
  };
  return new Promise<void>((resolve) => {
    acks.set(id, resolve);
    post(message, [buffer]);
  });
};

async function handle(message: ToWorker): Promise<void> {
  switch (message.kind) {
    case 'open': {
      const all = await navigator.usb.getDevices();
      const usb = all.find((candidate) =>
        candidate.vendorId === message.filter.vendorId &&
        candidate.productId === message.filter.productId &&
        (message.filter.serial === undefined || candidate.serialNumber === message.filter.serial));
      if (!usb) {
        throw new Error(
          `the ${message.filter.vendorId.toString(16)}:${message.filter.productId.toString(16)} ` +
          'device is not visible to this worker; the page must grant it first',
        );
      }
      const instance = new Slogic16U3(usb);
      instance.onTrace = (entry) => post({ kind: 'trace', entry });
      instance.onError = (error) => post({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      await instance.open();
      device = instance;
      post({
        kind: 'opened',
        name: instance.name,
        serial: instance.serial,
        maxChannels: instance.maxChannels,
        maxSamplerateHz: instance.maxSamplerateHz,
      });
      return;
    }

    case 'start': {
      if (!device) throw new Error('start before open');
      const running = device;
      // The device-layer call resolves once the read loop is armed, not when the capture
      // ends, so the page is free to stop at any time after this.
      await running.start(
        message.cfg, sink,
        (position, missing) => post({ kind: 'dropout', position, missing }),
        {
          ...(message.options as WorkerStartOptions),
          // The loop is running here, not on the page: say so, so an abort that names a
          // blocked thread names the right one. The page transport already sets this; the
          // fallback covers a worker driven without it.
          threadLabel: message.options.threadLabel ?? 'worker',
          onTriggerState: (state, index) => {
            if (index === undefined) post({ kind: 'trigger', state });
            else post({ kind: 'trigger', state, index });
          },
        },
      );
      post({ kind: 'started' });
      return;
    }

    case 'stop': {
      if (!device) throw new Error('stop before open');
      await device.stop();
      post({ kind: 'stopped' });
      return;
    }

    case 'stats': {
      if (!device) throw new Error('stats before open');
      post({ kind: 'stats', stats: device.getStats() });
      return;
    }

    case 'console': {
      if (!device) throw new Error('console before open');
      post({ kind: 'console', result: await device.usbControl(message.command) });
      return;
    }

    case 'ack': {
      const resolve = acks.get(message.id);
      if (resolve) {
        acks.delete(message.id);
        resolve();
      }
      return;
    }
  }
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  void handle(event.data).catch((error: unknown) => {
    post({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
  });
};
