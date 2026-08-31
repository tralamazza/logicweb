// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The capture panel - the right-hand device panel, modelled on
 * a conventional capture-settings panel.
 *
 * Layout: a device header with the product name, a "Digital"
 * section with All/Clear and two rows of eight channel chips filled with the channel
 * colour when enabled, a sample-rate dropdown and a voltage dropdown side by side, then a
 * segmented capture-mode control.
 *
 * Two things it has to show that a native tool would not: the WebUSB permission state, and the
 * **sample ceiling**. `src/data`'s `append` throws past 2^31 samples, which at this
 * device's 200 MSa/s is 10.7 seconds, so the panel prints the maximum duration for the
 * selected rate and a free-running capture stops itself there instead of dying mid-stream.
 */

import { MAX_SAMPLERATE_HZ, SAMPLERATES_HZ, vrefCode, vrefVolts } from '../device/index.js';
import { formatDuration, formatRate } from './format.js';
import { channelColor, type CaptureSettings, type ChannelState } from './state.js';
import { MAX_SAMPLES } from './captureIO.js';

const THRESHOLDS = [0.6, 0.9, 1.2, 1.5, 1.65, 1.8, 2.5, 3.3];

export interface CapturePanelCallbacks {
  onSettings(next: CaptureSettings): void;
  onToggleChannel(index: number, enabled: boolean): void;
  onSetAllChannels(enabled: boolean): void;
  onConnect(): void;
}

export interface CapturePanelView {
  settings: CaptureSettings;
  channels: readonly ChannelState[];
  deviceName: string | null;
  running: boolean;
  /** Non-null while a capture is streaming. */
  progress: { seconds: number; samples: number; bytes: number; lost: number } | null;
  webusbAvailable: boolean;
}

export class CapturePanel {
  constructor(
    private readonly root: HTMLElement,
    private readonly cb: CapturePanelCallbacks,
  ) {}

  render(v: CapturePanelView): void {
    const s = v.settings;
    this.root.replaceChildren();

    const head = div('panel-head');
    const title = div('panel-title');
    title.textContent = v.deviceName ?? 'No device';
    head.appendChild(title);
    const sub = div('panel-sub');
    sub.textContent = v.deviceName
      ? 'Sipeed SLogic16 U3 over WebUSB'
      : v.webusbAvailable
        ? 'Click Connect and pick the SLogic16 U3. The grant is remembered for this origin.'
        : 'WebUSB is unavailable in this browser. Use Brave or Chrome over http://127.0.0.1.';
    head.appendChild(sub);
    const connect = button(v.deviceName ? 'Reconnect' : 'Connect device', 'pill');
    connect.disabled = !v.webusbAvailable;
    connect.addEventListener('click', () => this.cb.onConnect());
    head.appendChild(connect);
    this.root.appendChild(head);

    // ---- channels
    const chSec = section('Digital');
    const all = button('All', 'mini');
    all.addEventListener('click', () => this.cb.onSetAllChannels(true));
    const clear = button('Clear', 'mini');
    clear.addEventListener('click', () => this.cb.onSetAllChannels(false));
    chSec.header.append(all, clear);

    const grid = div('chip-grid');
    for (const c of v.channels) {
      const chip = document.createElement('button');
      chip.className = 'chip' + (c.enabled ? ' on' : '');
      chip.textContent = String(c.index);
      chip.title = c.name;
      if (c.enabled) {
        chip.style.background = channelColor(c.index);
        chip.style.color = '#141415';
      } else {
        chip.style.color = channelColor(c.index);
      }
      chip.addEventListener('click', () => this.cb.onToggleChannel(c.index, !c.enabled));
      grid.appendChild(chip);
    }
    chSec.body.appendChild(grid);

    // ---- rate + threshold
    const rowRT = div('field-row');
    const ceiling = MAX_SAMPLERATE_HZ[s.channels] ?? 200e6;
    const rate = select(
      SAMPLERATES_HZ.filter((r) => r <= ceiling).map((r) => [String(r), formatRate(r)]),
      String(s.samplerate),
    );
    rate.addEventListener('change', () =>
      this.cb.onSettings({ ...s, samplerate: Number(rate.value) }));
    rowRT.appendChild(labelled('Sample rate', rate));

    const th = select(
      THRESHOLDS.map((t) => [String(t), `${t} V`]),
      String(nearest(THRESHOLDS, s.thresholdVolts)),
    );
    th.addEventListener('change', () =>
      this.cb.onSettings({ ...s, thresholdVolts: Number(th.value) }));
    rowRT.appendChild(labelled('Threshold', th));
    chSec.body.appendChild(rowRT);

    const code = vrefCode(s.thresholdVolts);
    const note = div('panel-note');
    note.textContent =
      `DAC code ${code} = ${vrefVolts(code).toFixed(3)} V actual. ` +
      `Capture width ${s.channels} ch (ceiling ${formatRate(ceiling)}).`;
    chSec.body.appendChild(note);
    this.root.appendChild(chSec.el);

    // ---- mode
    const modeSec = section('Capture');
    const seg = div('segmented');
    for (const [id, text] of [['free', 'Free run'], ['timer', 'Timer']] as const) {
      const b = document.createElement('button');
      b.className = 'seg' + (s.mode === id ? ' on' : '');
      b.textContent = text;
      b.addEventListener('click', () => this.cb.onSettings({ ...s, mode: id }));
      seg.appendChild(b);
    }
    modeSec.body.appendChild(seg);

    const maxSeconds = MAX_SAMPLES / s.samplerate;
    if (s.mode === 'timer') {
      const secs = document.createElement('input');
      secs.type = 'number';
      secs.min = '0.001';
      secs.step = '0.1';
      secs.max = String(maxSeconds);
      secs.value = String(s.seconds);
      secs.addEventListener('change', () =>
        this.cb.onSettings({ ...s, seconds: Math.min(Number(secs.value), maxSeconds) }));
      modeSec.body.appendChild(labelled('Duration (s)', secs));
    }

    const limit = div('panel-note');
    limit.textContent =
      `Ceiling ${MAX_SAMPLES.toLocaleString()} samples = ${formatDuration(maxSeconds)} at ` +
      `${formatRate(s.samplerate)}. A free run stops itself there.`;
    modeSec.body.appendChild(limit);

    // No Start/Stop here on purpose: the toolbar transport is the only one, so there is
    // no second control that can disagree with it about whether a capture may start.
    if (v.progress) {
      const p = div('panel-note live');
      p.textContent =
        `Recording ${v.progress.seconds.toFixed(2)} s · ` +
        `${v.progress.samples.toLocaleString()} samples · ` +
        `${(v.progress.bytes / 1e6).toFixed(1)} MB`;
      modeSec.body.appendChild(p);
      // A dropout that the user cannot see is nearly as bad as one that is not recorded:
      // the samples are in the store as filler and drawn as NO_DATA, but the count is the
      // only place the size of the loss is legible while the capture is still running.
      if (v.progress.lost > 0) {
        const d = div('panel-note error');
        d.textContent =
          `${v.progress.lost.toLocaleString()} samples lost to dropouts, marked as gaps`;
        modeSec.body.appendChild(d);
      }
    }
    this.root.appendChild(modeSec.el);
  }
}

function nearest(list: number[], v: number): number {
  return list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), list[0]!);
}

export function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

export function button(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  return b;
}

export function select(opts: [string, string][], value: string): HTMLSelectElement {
  const s = document.createElement('select');
  for (const [v, t] of opts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    s.appendChild(o);
  }
  s.value = value;
  return s;
}

export function labelled(text: string, el: HTMLElement): HTMLDivElement {
  const d = div('field');
  const l = document.createElement('label');
  l.textContent = text;
  d.append(l, el);
  return d;
}

export function section(title: string): { el: HTMLDivElement; header: HTMLDivElement; body: HTMLDivElement } {
  const el = div('panel-section');
  const header = div('panel-section-head');
  const h = document.createElement('span');
  h.textContent = title;
  header.appendChild(h);
  const body = div('panel-section-body');
  el.append(header, body);
  return { el, header, body };
}
