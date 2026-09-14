// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The real USB worker, with a scripted device where WebUSB would be.
 *
 * The point of the harness is to decide whether moving the transport into a worker changes
 * anything, so it must run *that* worker - `usbWorker.ts` is imported for its side effect and
 * nothing here reimplements its loop. Only the thing Chromium would provide (`navigator.usb`)
 * is replaced, and it is replaced after the worker module has been evaluated but before any
 * message can be delivered, because `usbWorker.ts` reads `navigator.usb` when it handles an
 * `open` message rather than at import time.
 */

import '../usbWorker.js';
import { ClockStreamDevice } from '../fakeUsb.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const device = new ClockStreamDevice(Number(scope.name) || 800_000);

Object.defineProperty(navigator, 'usb', {
  configurable: true,
  value: {
    getDevices: async () => [device],
    addEventListener() {},
    removeEventListener() {},
  },
});

// A side channel for the numbers that live with the device rather than with the driver.
// `usbWorker.ts` ignores message kinds it does not know, so this costs it nothing.
scope.addEventListener('message', (event: MessageEvent<{ kind?: string }>) => {
  if (event.data?.kind !== 'harness-report') return;
  scope.postMessage({
    kind: 'harness-report',
    droppedBytes: device.droppedBytes,
    starvedMs: device.starvedMs,
    worstStarveMs: device.worstStarveMs,
    bytesPerMs: device.bytesPerMs,
    fifoBytes: device.fifoBytes,
  });
});
