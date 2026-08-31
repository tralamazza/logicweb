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
import { channelColor, type AnalyzerState, type ChannelState } from './state.js';

export interface ChannelCell {
  channel: ChannelState;
  /** Total CSS height, base row plus every lane this channel carries. */
  heightCss: number;
  analyzers: AnalyzerState[];
}

export interface ChannelListCallbacks {
  onToggle(index: number, enabled: boolean): void;
  onRename(index: number, name: string): void;
  /** Move the channel at `from` in display order to `to`. */
  onReorder(from: number, to: number): void;
  onRemoveAnalyzer(id: string): void;
}

export class ChannelList {
  private dragFrom = -1;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: ChannelListCallbacks,
  ) {}

  render(cells: readonly ChannelCell[]): void {
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
}
