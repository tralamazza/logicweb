// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
import type { Device } from './types.js';
import { PID_SLOGIC16_U3, PID_SLOGIC32_U3, USB_VID_SIPEED } from './protocol.js';
import { USB_FILTERS } from './slogic16u3.js';
import { workerTransport } from './workerTransport.js';

export type { CaptureConfig, CaptureStartOptions, Device, SampleSink } from './types.js';
export { WorkerSlogicDevice, workerTransport } from './workerTransport.js';

/**
 * Open the device the origin already has permission for, on the worker when it can and
 * on the page when it cannot. See `workerTransport`.
 */
export async function getGrantedDevicesOnBestThread(): Promise<Device[]> {
  if (!navigator.usb) throw new Error('WebUSB is not available in this browser');
  const all = await navigator.usb.getDevices();
  const mine = all.filter((d) => d.vendorId === USB_VID_SIPEED &&
    (d.productId === PID_SLOGIC16_U3 || d.productId === PID_SLOGIC32_U3));
  const devices: Device[] = [];
  for (const usb of mine) devices.push(await workerTransport.open(usb));
  return devices;
}

/**
 * Prompt for a device - which WebUSB only allows in response to a user gesture - and hand
 * back the transport that should run it.
 */
export async function requestDeviceOnBestThread(): Promise<Device> {
  if (!navigator.usb) throw new Error('WebUSB is not available in this browser');
  const usb = await navigator.usb.requestDevice({ filters: USB_FILTERS });
  return workerTransport.open(usb);
}
export {
  SoftwareTrigger,
  MAX_SOFTWARE_TRIGGER_PREFIX_BYTES,
  type SoftwareTriggerConfig,
  type SoftwareTriggerKind,
  type SoftwareTriggerLevel,
  type SoftwareTriggerOptions,
  type SoftwareTriggerStats,
} from '../data/softwareTrigger.js';
export {
  Slogic16U3,
  USB_FILTERS,
  expandPacked,
  getGrantedDevices,
  requestDevice,
  type StartOptions,
  type Stats,
  type StreamTuning,
} from './slogic16u3.js';
export {
  MAX_SAMPLERATE_HZ,
  MAX_SAMPLERATE_HZ_SLOGIC32_U3,
  PID_SLOGIC16_U3,
  PID_SLOGIC32_U3,
  SAMPLERATES_HZ,
  SUPPORTED_CHANNELS,
  TEST_MODE_EMULATION,
  TEST_MODE_NORMAL,
  TEST_MODE_USB_MAX_SPEED,
  vrefCode,
  vrefVolts,
  type TraceEntry,
} from './protocol.js';
