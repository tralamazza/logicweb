// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The channel label column.
 *
 * [MEASURED] on 01-idle-empty-session.png at y=240: a 5 CSS px strip of the channel colour
 * at the far left, the "D0" tag in the *channel colour* starting at x=18, the channel name
 * in `#E0E0E0` starting at x=53, and below it one line per attached analyzer - a filled
 * square in the analyzer's colour then its name in small grey text. The column is 106 CSS
 * px wide including a 1 CSS px `#57575F` right border.
 *
 * Each cell's height is its row's height in the waveform stack, annotation lanes included,
 * so the labels line up with the traces by construction rather than by a shared constant
 * that could drift.
 */

import { COLORS } from './metrics.js';
import { channelColor, type AnalyzerState, type ChannelState, type TriggerMode } from './state.js';

export interface ChannelCell {
  channel: ChannelState;
  /** Total CSS height, base row plus every lane this channel carries. */
  heightCss: number;
  analyzers: AnalyzerState[];
  trigger: {
    active: boolean;
    masked: boolean;
    mode: TriggerMode;
    disabled: boolean;
    state: 'off' | 'waiting' | 'triggered' | 'not-found';
    summary: string;
  };
}

export interface ChannelListCallbacks {
  onToggle(index: number, enabled: boolean): void;
  onRename(index: number, name: string): void;
  /** Move the channel at `from` in display order to `to`. */
  onReorder(from: number, to: number): void;
  onRemoveAnalyzer(id: string): void;
  onSetTrigger(index: number, mode: TriggerMode): void;
}

export class ChannelList {
  private dragFrom = -1;
  private picker: HTMLDivElement | null = null;
  private pickerAnchor: HTMLButtonElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: ChannelListCallbacks,
  ) {}

  render(cells: readonly ChannelCell[]): void {
    this.closePicker(false);
    this.root.replaceChildren();
    cells.forEach((cell, pos) => {
      const el = document.createElement('div');
      el.className = 'ch-cell';
      el.style.height = `${cell.heightCss}px`;
      el.draggable = true;
      el.dataset['pos'] = String(pos);
      if (!cell.channel.enabled) el.classList.add('disabled');

      const strip = document.createElement('div');
      strip.className = 'ch-strip';
      strip.style.background = channelColor(cell.channel.index);
      el.appendChild(strip);

      const body = document.createElement('div');
      body.className = 'ch-body';

      const head = document.createElement('div');
      head.className = 'ch-head';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'ch-enable';
      box.checked = cell.channel.enabled;
      box.title = cell.channel.enabled ? 'Disable this channel' : 'Enable this channel';
      box.addEventListener('change', () => this.cb.onToggle(cell.channel.index, box.checked));
      head.appendChild(box);

      const tag = document.createElement('span');
      tag.className = 'ch-tag';
      tag.textContent = `D${cell.channel.index}`;
      tag.style.color = channelColor(cell.channel.index);
      head.appendChild(tag);

      const name = document.createElement('input');
      name.className = 'ch-name';
      name.value = cell.channel.name;
      name.spellcheck = false;
      name.title = 'Rename';
      // Committing on blur and on Enter, not on every keystroke: a re-render on each
      // character would take the caret with it.
      const commit = () => {
        const v = name.value.trim() || `Channel ${cell.channel.index}`;
        if (v !== cell.channel.name) this.cb.onRename(cell.channel.index, v);
      };
      name.addEventListener('blur', commit);
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') name.blur();
        if (e.key === 'Escape') { name.value = cell.channel.name; name.blur(); }
        e.stopPropagation();
      });
      // Dragging the cell must not start from inside a text field, or the field is
      // unusable.
      name.addEventListener('mousedown', () => { el.draggable = false; });
      name.addEventListener('mouseup', () => { el.draggable = true; });
      head.appendChild(name);

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'ch-trigger' + (cell.trigger.active ? ' active' : '') +
        (cell.trigger.masked ? ' masked' : '');
      if (cell.trigger.active) trigger.classList.add(cell.trigger.state);
      trigger.replaceChildren(triggerIcon(cell.trigger.mode));
      trigger.title = cell.trigger.active
        ? `${cell.trigger.summary}${cell.trigger.masked ? ' (Enable Mask off)' : ''}. Click to configure.`
        : `Configure software trigger for D${cell.channel.index}`;
      trigger.disabled = cell.trigger.disabled;
      trigger.setAttribute('aria-pressed', String(cell.trigger.active && !cell.trigger.masked));
      trigger.setAttribute('aria-label', cell.trigger.active
        ? `${cell.trigger.summary}${cell.trigger.masked ? ', inactive because global Enable Mask is off' : ', active'}`
        : `D${cell.channel.index} trigger: X, any value`);
      trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        this.openPicker(trigger, cell.channel.index, cell.trigger.mode);
      });
      trigger.addEventListener('mousedown', () => { el.draggable = false; });
      trigger.addEventListener('mouseup', () => { el.draggable = true; });
      head.appendChild(trigger);
      body.appendChild(head);

      for (const a of cell.analyzers) {
        const chip = document.createElement('div');
        chip.className = 'ch-analyzer';
        const sq = document.createElement('span');
        sq.className = 'ch-analyzer-sq';
        sq.style.background = a.color;
        chip.appendChild(sq);
        const txt = document.createElement('span');
        txt.textContent = a.label;
        txt.style.color = a.status === 'error' ? COLORS.negative : COLORS.text50;
        chip.appendChild(txt);
        const x = document.createElement('button');
        x.className = 'ch-analyzer-x';
        x.textContent = '×';
        x.title = `Remove ${a.label}`;
        x.addEventListener('click', () => this.cb.onRemoveAnalyzer(a.id));
        chip.appendChild(x);
        chip.title = a.message || a.label;
        body.appendChild(chip);
      }

      el.appendChild(body);

      el.addEventListener('dragstart', (e) => {
        this.dragFrom = pos;
        e.dataTransfer?.setData('text/plain', String(pos));
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('drop-target');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drop-target');
        if (this.dragFrom >= 0 && this.dragFrom !== pos) this.cb.onReorder(this.dragFrom, pos);
        this.dragFrom = -1;
      });

      this.root.appendChild(el);
    });
  }

  private openPicker(anchor: HTMLButtonElement, channel: number, selected: TriggerMode): void {
    if (this.pickerAnchor === anchor && this.picker) { this.closePicker(); return; }
    this.closePicker(false);
    const picker = document.createElement('div');
    picker.className = 'trigger-inline-picker';
    picker.setAttribute('role', 'radiogroup');
    picker.setAttribute('aria-label', `Trigger condition for D${channel}`);
    const modes: readonly TriggerMode[] = ['falling', 'rising', 'high', 'low', 'dont-care'];
    const names: Record<TriggerMode, string> = {
      falling: 'Falling edge', rising: 'Rising edge', high: 'High level',
      low: 'Low level', 'dont-care': 'Any value (X)',
    };
    for (const mode of modes) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'trigger-inline-option' + (mode === selected ? ' selected' : '');
      option.title = names[mode];
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(mode === selected));
      option.appendChild(triggerIcon(mode));
      option.addEventListener('pointerdown', (event) => event.stopPropagation());
      option.addEventListener('click', (event) => {
        event.stopPropagation();
        this.closePicker();
        this.cb.onSetTrigger(channel, mode);
      });
      picker.appendChild(option);
    }
    const rect = anchor.getBoundingClientRect();
    picker.style.left = `${Math.round(rect.left)}px`;
    picker.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
    document.body.appendChild(picker);
    this.picker = picker;
    this.pickerAnchor = anchor;
    requestAnimationFrame(() => picker.classList.add('open'));
    document.addEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.addEventListener('keydown', this.onPickerKeyDown, true);
  }

  private readonly onOutsidePointerDown = (event: PointerEvent): void => {
    if (this.picker?.contains(event.target as Node) || this.pickerAnchor?.contains(event.target as Node)) return;
    this.closePicker();
  };

  private readonly onPickerKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.closePicker();
  };

  private closePicker(animate = true): void {
    const picker = this.picker;
    this.picker = null;
    this.pickerAnchor = null;
    document.removeEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.removeEventListener('keydown', this.onPickerKeyDown, true);
    if (!picker) return;
    picker.classList.remove('open');
    if (animate && picker.isConnected) setTimeout(() => picker.remove(), 140);
    else picker.remove();
  }
}

function triggerIcon(mode: TriggerMode): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const d = mode === 'falling' ? 'M1 3H9L15 13H23' : mode === 'rising' ? 'M1 13H9L15 3H23'
    : mode === 'high' ? 'M1 3H23' : mode === 'low' ? 'M1 13H23' : 'M5 3L19 13M19 3L5 13';
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'square');
  svg.appendChild(path);
  return svg;
}
