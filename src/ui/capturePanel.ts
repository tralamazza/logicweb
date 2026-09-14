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

import { SAMPLERATES_HZ, vrefCode, vrefVolts } from '../device/index.js';
import { MAX_SOFTWARE_TRIGGER_PREFIX_BYTES } from '../data/index.js';
import { bytesPerSampleForChannels } from '../types.js';
import { formatDuration, formatRate } from './format.js';
import { channelColor, type CaptureSettings, type ChannelState } from './state.js';
import { MAX_SAMPLES } from './captureIO.js';

const THRESHOLDS = [0.6, 0.9, 1.2, 1.5, 1.65, 1.8, 2.5, 3.3];

export interface CapturePanelCallbacks {
  onSettings(next: CaptureSettings): void;
  onToggleChannel(index: number, enabled: boolean): void;
  onSetAllChannels(enabled: boolean): void;
  onConnect(): void;
  onUsbControl(command: string): Promise<string>;
}

export interface CapturePanelView {
  settings: CaptureSettings;
  channels: readonly ChannelState[];
  deviceName: string | null;
  running: boolean;
  stopping: boolean;
  /** Non-null while a capture is streaming. */
  progress: { seconds: number; samples: number; bytes: number; lost: number } | null;
  webusbAvailable: boolean;
  maxSamplerateHz: Readonly<Record<number, number>>;
  triggerState: 'off' | 'waiting' | 'triggered' | 'not-found';
}

export class CapturePanel {
  private advancedOpen = false;
  private consoleLines: string[] = [
    'Enter help for commands. Numbers are decimal or 0x-prefixed hex.',
  ];

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
      ? 'Sipeed SLogic U3 over WebUSB'
      : v.webusbAvailable
        ? 'Click Connect and pick an SLogic16/32 U3. The grant is remembered for this origin.'
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
    const ceiling = v.maxSamplerateHz[s.channels] ?? 200e6;
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

    const triggerSec = section('Software trigger');
    const mask = document.createElement('input');
    mask.type = 'checkbox'; mask.checked = s.triggerEnableMask; mask.disabled = v.running || v.stopping;
    mask.title = 'Enable software trigger';
    triggerSec.header.appendChild(mask);
    mask.addEventListener('change', () => this.cb.onSettings({ ...s, triggerEnableMask: mask.checked }));
    triggerSec.body.hidden = !s.triggerEnableMask;
    if (s.triggerEnableMask) {
      const pre = select([
        ['0', 'No pre-trigger'], ['10', '10%'], ['25', '25%'], ['50', '50%'], ['75', '75%'],
      ], String(s.preTriggerPercent));
      pre.disabled = v.running || v.stopping;
      pre.addEventListener('change', () => this.cb.onSettings({ ...s, preTriggerPercent: Number(pre.value) }));
      triggerSec.body.appendChild(labelled('Pre-trigger buffer', pre));

      // The one mistake this section invites: enabling the trigger and never picking a
      // condition, which silently arms nothing. Say what is armed, or what is missing.
      const armed = div('panel-note');
      if (s.triggerConditions.length === 0) {
        armed.classList.add('error');
        armed.textContent =
          'No condition set - the capture will run untriggered. Click the trigger ' +
          'button on a channel row (left column) and pick an edge or a level.';
      } else {
        const what = s.triggerConditions
          .map((c) => `D${c.channel} ${c.kind === 'level' ? (c.level ? 'high' : 'low') : c.kind}`)
          .join(' AND ');
        // The *effective* pre-trigger window, with the same clamps startCapture
        // applies: percent of the post-trigger budget, capped by the 64 MiB retained
        // prefix. Promising the raw percentage would overstate it exactly when the
        // cap bites (e.g. 50% of 1 s at 16ch/200M is capped at ~167 ms).
        const post = s.mode === 'timer'
          ? Math.min(MAX_SAMPLES - 1, Math.round(s.seconds * s.samplerate))
          : MAX_SAMPLES - 1;
        const pre = Math.min(
          Math.max(0, post - 1),
          Math.max(0, Math.floor(post * s.preTriggerPercent / 100)),
          Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bytesPerSampleForChannels(s.channels)),
        );
        const capped = pre < Math.floor(post * s.preTriggerPercent / 100);
        armed.textContent =
          `Armed: ${what}. T=0 at the trigger; up to ` +
          `${formatDuration(pre / s.samplerate)} before it is kept as negative time` +
          (capped ? ` (capped by the ${MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / 1048576} MiB pre-trigger buffer)` : '') +
          '.';
      }
      triggerSec.body.appendChild(armed);

      if (v.triggerState === 'waiting') {
        const wait = div('panel-note live');
        wait.textContent = 'Waiting for the trigger condition…';
        triggerSec.body.appendChild(wait);
      } else if (v.triggerState === 'triggered') {
        const hit = div('panel-note live');
        hit.textContent = 'Triggered - recording the post-trigger window.';
        triggerSec.body.appendChild(hit);
      } else if (v.triggerState === 'not-found') {
        const miss = div('panel-note error');
        // finish() discards the rolling search prefix - nothing was recorded.
        miss.textContent = 'Stopped without a trigger; nothing was recorded.';
        triggerSec.body.appendChild(miss);
      }
    }

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
    this.root.appendChild(triggerSec.el);

    // ---- advanced test mode + raw USB console
    const advanced = document.createElement('details');
    advanced.className = 'advanced';
    advanced.open = this.advancedOpen;
    advanced.addEventListener('toggle', () => { this.advancedOpen = advanced.open; });
    const summary = document.createElement('summary');
    summary.textContent = 'Advanced';
    advanced.appendChild(summary);
    const body = div('advanced-body');

    const source = select([
      ['0', 'Normal'],
      ['2', 'Simulator'],
      ['1', 'USB MAX SPEED'],
    ], String(s.testMode));
    source.disabled = v.running;
    source.addEventListener('change', () =>
      this.cb.onSettings({ ...s, testMode: Number(source.value) as 0 | 1 | 2 }));
    body.appendChild(labelled('Device test mode (next capture)', source));

    const consoleLabel = document.createElement('label');
    consoleLabel.className = 'advanced-console-label';
    consoleLabel.textContent = 'USB control console';
    const output = document.createElement('pre');
    output.className = 'usb-console-output';
    const renderOutput = (): void => {
      output.textContent = this.consoleLines.join('\n');
      output.scrollTop = output.scrollHeight;
    };
    renderOutput();
    const commandRow = div('usb-console-command');
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = 'read 0x000c 4';
    input.disabled = !v.deviceName || v.running;
    const send = button('Send', 'mini');
    send.disabled = input.disabled;
    const execute = async (): Promise<void> => {
      const command = input.value.trim();
      if (!command || send.disabled) return;
      input.value = '';
      input.disabled = true;
      send.disabled = true;
      this.consoleLines.push(`> ${command}`);
      renderOutput();
      try {
        this.consoleLines.push(await this.cb.onUsbControl(command));
      } catch (e) {
        this.consoleLines.push(`error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.consoleLines = this.consoleLines.slice(-80);
        input.disabled = !v.deviceName || v.running;
        send.disabled = input.disabled;
        renderOutput();
        input.focus();
      }
    };
    send.addEventListener('click', () => void execute());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void execute(); }
    });
    commandRow.append(input, send);
    body.append(consoleLabel, output, commandRow);
    const help = div('panel-note');
    help.textContent =
      'Commands: read <addr> [len], write <addr> <byte>..., ctrl <value>, ' +
      'flags, clear-fifo, ' +
      'in <request> <value> <index> <len>, out <request> <value> <index> [byte]...';
    body.appendChild(help);
    advanced.appendChild(body);
    this.root.appendChild(advanced);
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
