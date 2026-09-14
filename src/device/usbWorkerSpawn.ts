// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Gives `workerTransport` the browser's constructor for `usbWorker.ts`.
 *
 * This is the only file that names a `?worker&inline` specifier, and it is imported by
 * the browser entry alone. Everything else - `workerTransport`, `device/index.ts`, the
 * offline suite - stays importable by a plain esbuild bundle, which cannot resolve that
 * specifier and used to fail on it.
 */

import UsbWorker from './usbWorker.ts?worker&inline';
import { installUsbWorkerSpawn } from './workerTransport.js';

installUsbWorkerSpawn(() => new UsbWorker() as unknown as Worker);
