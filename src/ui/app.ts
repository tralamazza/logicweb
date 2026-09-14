// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The application: state, wiring and the frame loop.
 *
 * This is the only file that knows about all four modules at once. It talks to them
 * through their published interfaces and nothing else - no WebUSB call, no GL call, no
 * Pyodide, no direct access to another module's internals - which is what
 * docs/ARCHITECTURE.md asks of `src/ui`.
 */

import {
  appendLostSamples, createSampleStore, MAX_SOFTWARE_TRIGGER_PREFIX_BYTES,
} from '../data/index.js';
import type { SampleStore } from '../data/types.js';
import { bytesPerSampleForChannels, isChannelCount, type ChannelCount } from '../types.js';
import {
  MAX_SAMPLERATE_HZ, getGrantedDevicesOnBestThread, requestDeviceOnBestThread, vrefCode,
  type CaptureConfig, type Device,
} from '../device/index.js';
import { WorkerSlogicDevice, workerTransport } from '../device/workerTransport.js';
import { WheelIntent, wheelSpanFactor } from '../render/index.js';
import {
  AnnotationIndex, DecodeCancelledError, DecodeTimeoutError, EDGE_BUDGET, MAX_SAMPLE,
  annotationTexts, displayRows, getDecoder, rowForClass, sharedDecodeClient,
} from '../decode/index.js';
import type { ChannelEdges, DecodeRequest, DecodeResult } from '../decode/index.js';

import { AnalyzerPanel } from './analyzerPanel.js';
import { layoutBubbles, type AnnotationSpan, type Bubble } from './annotationLayout.js';
import { CapturePanel } from './capturePanel.js';
import { ChannelList, type ChannelCell } from './channelList.js';
import {
  MAX_SAMPLES, levelAt, loadFiles, loadLwcap, saveLwcap,
} from './captureIO.js';
import { formatCount, formatDuration, formatFreq, formatRate } from './format.js';
import { COLORS, MEASURE_COLORS, ROWS } from './metrics.js';
import { Overlay, type HoverMeasurement } from './overlay.js';
import { StoreRef } from './storeRef.js';
import {
  analyzerColor, defaultChannels, channelColor,
  type AnalyzerState, type CaptureSettings, type ChannelState, type TriggerMode,
} from './state.js';
import { computeTicks, drawAxis, type TickSet } from './timeAxis.js';
import { WaveformStack, type RowSpec } from './waveformStack.js';

/** A store that can also count edges without materialising them (PlanarSampleStore does). */
type CountingStore = SampleStore & { edgeCount?(c: number, s: number, e: number): number };

interface Lane {
  analyzer: AnalyzerState;
  /** Index into displayRows(decoder). */
  displayRow: number;
  laneChannel: number;
}

export class App {
  private readonly storeRef: StoreRef;
  private readonly stack: WaveformStack;
  private readonly overlay: Overlay;
  private readonly channelList: ChannelList;
  private readonly capturePanel: CapturePanel;
  private readonly analyzerPanel: AnalyzerPanel;
  private readonly decodeClient = sharedDecodeClient({
    // Resolve from the document, not from the worker script. This supports static sites
    // hosted below a subdirectory and keeps all runtime files together in dist/.
    pyodideIndexURL: new URL('./pyodide/', document.baseURI).href,
    decodersURL: new URL('./decoders/decoders.zip', document.baseURI).href,
  });

  private channels: ChannelState[] = defaultChannels(16);
  /** Display order, holding capture channel indices. */
  private order: number[] = Array.from({ length: 16 }, (_, i) => i);
  private analyzers: AnalyzerState[] = [];
  private lanes: Lane[] = [];
  private nextAnalyzer = 0;

  private settings: CaptureSettings = {
    channels: 16, samplerate: 16e6, thresholdVolts: 1.2, mode: 'timer', seconds: 1,
    testMode: 0, triggerEnableMask: false, softwareTrigger: false, triggerModes: {},
    triggerConditions: [], triggerChannel: 0,
    triggerKind: 'rising', triggerLevel: 1, preTriggerPercent: 10,
  };

  private device: Device | null = null;
  private rateCeilings: Readonly<Record<number, number>> = MAX_SAMPLERATE_HZ;
  private running = false;
  /** True while WebUSB transfers from the previous run are being cancelled and drained. */
  private stopping = false;
  private captureStart = 0;
  private captureBytes = 0;
  /** Samples the device could not deliver, appended as filler and marked as gaps. */
  private lostSamples = 0;
  private captureLimitSamples = 0;
  private triggerState: 'off' | 'waiting' | 'triggered' | 'not-found' = 'off';
  /** Trigger sample position in SampleStore; the time axis labels this sample T=0. */
  private triggerSampleIndex: number | null = null;

  private captureLabel = 'no capture';
  private statusError = '';
  private decodeBusy = false;
  private decodeWarm = false;
  private abort: AbortController | null = null;

  private cursorA: number | null = null;
  private cursorB: number | null = null;
  private hover: HoverMeasurement | null = null;

  private dirty = true;
  private panel: 'device' | 'analyzers' | null = 'device';
  private readonly wheelIntent = new WheelIntent();

  // DOM
  private readonly el: {
    plot: HTMLDivElement; waveStack: HTMLDivElement; axis: HTMLCanvasElement;
    scroll: HTMLDivElement;
    channelList: HTMLDivElement; side: HTMLDivElement; status: HTMLDivElement;
    hint: HTMLDivElement; transport: HTMLButtonElement; title: HTMLSpanElement;
    fileInput: HTMLInputElement;
  };

  constructor() {
    this.el = {
      plot: must<HTMLDivElement>('plot'),
      scroll: must<HTMLDivElement>('scroll-area'),
      waveStack: must<HTMLDivElement>('wave-stack'),
      axis: must<HTMLCanvasElement>('axis'),
      channelList: must<HTMLDivElement>('channel-list'),
      side: must<HTMLDivElement>('side-panel'),
      status: must<HTMLDivElement>('status'),
      hint: must<HTMLDivElement>('empty-hint'),
      transport: must<HTMLButtonElement>('transport'),
      title: must<HTMLSpanElement>('capture-title'),
      fileInput: must<HTMLInputElement>('file-input'),
    };

    this.storeRef = new StoreRef(createSampleStore(16, 16e6));
    this.stack = new WaveformStack(this.el.waveStack, this.storeRef);
    this.overlay = new Overlay(this.el.plot);
    this.channelList = new ChannelList(this.el.channelList, {
      onToggle: (i, on) => this.setChannelEnabled(i, on),
      onRename: (i, name) => { this.channels[i]!.name = name; this.relayout(); },
      onReorder: (from, to) => this.reorder(from, to),
      onRemoveAnalyzer: (id) => this.removeAnalyzer(id),
      onSetTrigger: (channel, mode) => this.setTriggerMode(channel, mode),
    });

    const panelHost = document.createElement('div');
    this.el.side.appendChild(panelHost);
    this.capturePanel = new CapturePanel(panelHost, {
      onSettings: (s) => {
        const next = clampSettings(s, this.rateCeilings);
        if (triggerSettingsChanged(this.settings, next)) {
          this.triggerState = 'off';
          this.triggerSampleIndex = null;
          this.dirty = true;
        }
        this.settings = next;
        this.relayout();
        this.renderPanels();
      },
      onToggleChannel: (i, on) => this.setChannelEnabled(i, on),
      onSetAllChannels: (on) => this.setAllChannels(on),
      onConnect: () => void this.connect(),
      onUsbControl: (command) => this.usbControl(command),
    });
    this.analyzerPanel = new AnalyzerPanel(panelHost, {
      onAttach: (id, ch, opts) => void this.attachAnalyzer(id, ch, opts),
      onRemove: (id) => this.removeAnalyzer(id),
      onRedecode: (id) => void this.runDecode(id),
      onCancel: () => this.abort?.abort(),
    });

    this.wireToolbar();
    this.wirePlot();
    this.wireRail();

    // Observe the scroll viewport, not the plot: the plot's height is now an *output*
    // of relayout (its canvases stack in normal flow so the rows can scroll), and
    // observing it would loop layout -> resize -> layout.
    new ResizeObserver(() => { this.relayout(); }).observe(this.el.scroll);
    window.addEventListener('resize', () => this.relayout());

    this.relayout();
    this.renderPanels();
    this.frame();

    // Pay the Pyodide cold start once. The portable build uses only embedded bytes,
    // including on file://; dev uses the staged files served by Vite.
    this.decodeClient.warmup().then(
      () => { this.decodeWarm = true; this.renderPanels(); },
      (e: unknown) => this.fail('decode worker warmup', e),
    );
    void this.reconnectGranted();
  }

  // ------------------------------------------------------------------ layout

  private get store(): SampleStore { return this.storeRef.target; }

  private enabledChannels(): ChannelState[] {
    return this.order.map((i) => this.channels[i]!).filter((c) => c.enabled);
  }

  /** Commit one inline five-state selector immediately. The global checkbox remains the
   * only enable gate; changing a channel while it is off merely edits saved modes. */
  private setTriggerMode(channel: number, mode: TriggerMode): void {
    if (this.running || this.stopping) return;
    const triggerModes = { ...this.settings.triggerModes, [channel]: mode };
    const triggerConditions = modesToConditions(triggerModes);
    const first = triggerConditions[0] ?? {
      channel, kind: 'level' as const, level: 1 as const,
    };
    this.settings = clampSettings({
      ...this.settings, triggerModes, triggerConditions,
      triggerChannel: first.channel, triggerKind: first.kind, triggerLevel: first.level,
    }, this.rateCeilings);
    this.triggerState = 'off';
    this.triggerSampleIndex = null;
    this.relayout();
    this.renderPanels();
  }

  /**
   * Rebuild the row model.
   *
   * Rows auto-fit the plot: the stack fills the available height, so the base row height
   * is derived rather than a constant, and annotation lanes are subtracted first.
   */
  private relayout(): void {
    // Rows auto-fit the *visible* plot height (the scroll viewport minus the sticky
    // axis). When even minimum-height rows do not fit, the stack overflows and the
    // scroll area scrolls - phones get every channel instead of the first six.
    const axisH = this.el.axis.offsetHeight || 30;
    const plotH = Math.max(120, (this.el.scroll.clientHeight || 630) - axisH);
    const enabled = this.enabledChannels();
    this.lanes = this.computeLanes(enabled);

    if (enabled.length === 0) {
      this.stack.setRows([]);
      this.channelList.render([]);
      this.dirty = true;
      return;
    }

    const laneTotal = this.lanes.length * ROWS.laneHeight;
    let base = Math.floor((plotH - laneTotal) / enabled.length);
    base = Math.max(ROWS.minRowHeight, Math.min(ROWS.maxRowHeight, base));

    const rows: RowSpec[] = [];
    const cells: ChannelCell[] = [];
    for (const c of enabled) {
      const mine = this.lanes.filter((l) => l.laneChannel === c.index);
      for (const l of mine) {
        rows.push({
          kind: 'lane', channel: c.index, heightCss: ROWS.laneHeight,
          analyzer: this.analyzers.indexOf(l.analyzer),
        });
      }
      rows.push({ kind: 'channel', channel: c.index, heightCss: base });
      cells.push({
        channel: c,
        heightCss: base + mine.length * ROWS.laneHeight,
        analyzers: this.analyzers.filter((a) => this.chipChannels(a).includes(c.index)),
        trigger: {
          active: this.settings.triggerModes[c.index] !== undefined && this.settings.triggerModes[c.index] !== 'dont-care',
          masked: !this.settings.triggerEnableMask,
          mode: this.settings.triggerModes[c.index] ?? 'dont-care',
          disabled: this.running || this.stopping,
          state: this.triggerState,
          summary: triggerSummary(this.settings, c.index),
        },
      });
    }

    this.stack.setRows(rows);
    this.channelList.render(cells);
    this.dirty = true;
  }

  /**
   * One lane per annotation row a decoder actually produced output in - with two rules.
   *
   * **Bit-level rows are dropped.** [CHOICE, with a reason] sigrok's decoders declare a
   * row per *bit* alongside the byte-level rows: i2c has `bits`, uart `rx-data-bits` and
   * `tx-data-bits`, spi `miso-bits` and `mosi-bits`. Those are one annotation per clock
   * and are unreadable at any zoom where a byte fits on screen, so we draw no
   * equivalent - `05-analyzer-annotations.png` shows I2C as a single lane of
   * "Setup Read to [0x20] + ACK" frames. Dropping them is a name match on `/bits$/`,
   * which is a heuristic and is called out as one; if a decoder has nothing else, its bit
   * rows are shown rather than showing nothing.
   *
   * **Capped at 3 lanes per analyzer.** Each lane costs 20 CSS px off every channel row,
   * and `uart` alone declares ten rows.
   */
  private computeLanes(enabled: readonly ChannelState[]): Lane[] {
    const out: Lane[] = [];
    const visible = new Set(enabled.map((c) => c.index));
    for (const a of this.analyzers) {
      if (!a.result || a.result.annotations.count === 0) continue;
      if (!visible.has(a.laneChannel)) continue;
      const info = getDecoder(a.decoderId);
      const rows = displayRows(info);
      const map = rowForClass(info);
      const used = new Set<number>();
      const cls = a.result.annotations.cls;
      for (let i = 0; i < a.result.annotations.count; i++) {
        const r = map[cls[i]!] ?? -1;
        used.add(r < 0 ? 0 : r);
      }
      const candidates = [...used].sort((x, y) => x - y);
      const isBitRow = (r: number) => /bits$/.test(rows[r]?.id ?? '');
      const kept = candidates.filter((r) => !isBitRow(r));
      const chosen = (kept.length ? kept : candidates).slice(0, 3);
      for (const r of chosen) {
        out.push({ analyzer: a, displayRow: r, laneChannel: a.laneChannel });
      }
    }
    return out;
  }

  /** Capture channels this analyzer should show a chip on: every channel it reads. */
  private chipChannels(a: AnalyzerState): number[] {
    return Object.values(a.channels).filter((v) => v >= 0);
  }

  private setChannelEnabled(index: number, enabled: boolean): void {
    const c = this.channels[index];
    if (!c) return;
    if (!enabled && this.enabledChannels().length <= 1) return;   // never zero rows
    c.enabled = enabled;
    this.afterChannelChange();
  }

  /**
   * All / Clear. Clear keeps channel 0 for the same reason `setChannelEnabled` refuses the
   * last one: zero rows is not a state the stack can lay out.
   */
  private setAllChannels(on: boolean): void {
    for (const c of this.channels) c.enabled = on;
    if (!on && this.channels[0]) this.channels[0].enabled = true;
    this.afterChannelChange();
  }

  /**
   * Every path that flips a channel ends here. It used to be open-coded in two places and
   * the All/Clear one was missing both halves: no `renderPanels`, so the chips kept their
   * old fill even though the plot had already updated, and no width recompute, so Clear
   * left `settings.channels` at 16 and the device would still have been configured for a
   * 16-channel capture at the 16-channel rate ceiling.
   */
  private afterChannelChange(): void {
    this.settings = clampSettings(
      { ...this.settings, channels: this.neededWidth() }, this.rateCeilings,
    );
    this.relayout();
    this.renderPanels();
  }

  /** Narrowest capture width that covers every enabled channel. */
  private neededWidth(): ChannelCount {
    const hi = Math.max(0, ...this.enabledChannels().map((c) => c.index));
    return hi < 4 ? 4 : hi < 8 ? 8 : hi < 16 ? 16 : hi < 32 ? 32 : hi < 64 ? 64 : 128;
  }

  private reorder(from: number, to: number): void {
    const enabled = this.enabledChannels();
    const moving = enabled[from];
    const target = enabled[to];
    if (!moving || !target) return;
    const src = this.order.indexOf(moving.index);
    const dst = this.order.indexOf(target.index);
    this.order.splice(src, 1);
    this.order.splice(dst, 0, moving.index);
    this.relayout();
  }

  // ------------------------------------------------------------------ frame

  private frame = (): void => {
    requestAnimationFrame(this.frame);
    if (!this.dirty && !this.running) return;
    this.dirty = false;
    try {
      this.draw();
    } catch (e) {
      this.fail('render', e);
    }
  };

  private draw(): void {
    this.stack.syncSize();
    const wCss = this.el.plot.clientWidth;
    const hCss = this.el.plot.clientHeight;
    this.overlay.syncSize(wCss, hCss);
    this.el.hint.style.display = this.store.length > 0 ? 'none' : 'flex';

    this.stack.render();
    const view = this.stack.view;
    const sr = this.store.samplerate;
    const timeOrigin = this.triggerSampleIndex ?? 0;
    const ticks = computeTicks(
      ((view.start - timeOrigin) / sr) * 1e12,
      ((view.end - timeOrigin) / sr) * 1e12,
      wCss, sr,
    );

    this.drawAxisCanvas(ticks, wCss);

    this.overlay.beginFrame();
    this.overlay.drawGrid(ticks);
    this.overlay.drawLevels(this.stack.boxes().map((b) => ({
      top: b.top, band: b.band, isChannel: b.spec.kind === 'channel',
    })));
    this.drawLanes(wCss);

    if (this.triggerSampleIndex !== null) {
      this.overlay.drawTrigger(this.toPx(this.triggerSampleIndex));
    }

    if (this.running && this.store.length > 0) {
      this.overlay.drawLiveEdge(this.toPx(this.store.length));
    }
    if (this.cursorA !== null) {
      this.overlay.drawCursor(this.toPx(this.cursorA), MEASURE_COLORS[0]!, 'A');
    }
    if (this.cursorB !== null) {
      this.overlay.drawCursor(this.toPx(this.cursorB), MEASURE_COLORS[2]!, 'B');
    }
    if (this.hover) this.overlay.drawHover(this.hover);

    this.renderStatus();
  }

  private drawAxisCanvas(ticks: TickSet, wCss: number): void {
    const dpr = globalThis.devicePixelRatio || 1;
    const c = this.el.axis;
    const hCss = c.clientHeight || 29;
    const w = Math.max(1, Math.round(wCss * dpr));
    const h = Math.max(1, Math.round(hCss * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('axis 2D context unavailable');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAxis(ctx, ticks, wCss, hCss);
  }

  private drawLanes(wCss: number): void {
    const boxes = this.stack.boxes();
    const view = this.stack.view;
    const measure = this.overlay.measureCtx;
    for (const box of boxes) {
      if (box.spec.kind !== 'lane') continue;
      // The lane is a renderer row, so it currently holds a trace and a separator. Cover
      // it before drawing into it - NOTES.md section 2.
      this.overlay.fillLane(box.top, box.height);
      const lane = this.laneFor(box);
      if (!lane || !lane.analyzer.result || !lane.analyzer.index) continue;
      const spans = this.spansFor(lane, view.start, view.end);
      if (spans.length === 0) continue;
      const bubbles: Bubble[] = layoutBubbles({
        spans, widthCss: wCss, measure, toPx: (s) => this.toPx(s),
      });
      this.overlay.drawBubbles(bubbles, box.top, lane.analyzer.color);
    }
  }

  private laneFor(box: { spec: RowSpec; top: number }): Lane | null {
    // Lanes are emitted in the same order they appear in `this.lanes` for a channel, so
    // matching on (channel, ordinal) is exact.
    let ordinal = 0;
    for (const b of this.stack.boxes()) {
      if (b.top === box.top) break;
      if (b.spec.kind === 'lane' && b.spec.channel === box.spec.channel) ordinal++;
    }
    const mine = this.lanes.filter((l) => l.laneChannel === box.spec.channel);
    return mine[ordinal] ?? null;
  }

  private spansFor(lane: Lane, startSample: number, endSample: number): AnnotationSpan[] {
    const a = lane.analyzer;
    if (!a.result || !a.index) return [];
    const info = getDecoder(a.decoderId);
    const map = rowForClass(info);
    const idx = a.index.query(0, Math.floor(startSample), Math.ceil(endSample));
    const { start, end, cls } = a.result.annotations;
    const out: AnnotationSpan[] = [];
    for (const i of idx) {
      const r = map[cls[i]!] ?? -1;
      if ((r < 0 ? 0 : r) !== lane.displayRow) continue;
      out.push({ start: start[i]!, end: end[i]!, texts: annotationTexts(a.result, i) });
    }
    return out;
  }

  /** Sample -> CSS px inside the plot. The renderer's transform is in device px. */
  private toPx(sample: number): number {
    const dpr = globalThis.devicePixelRatio || 1;
    return this.stack.view.sampleToPixel(sample) / dpr;
  }

  private toSample(cssX: number): number {
    const dpr = globalThis.devicePixelRatio || 1;
    return this.stack.view.pixelToSample(cssX * dpr);
  }

  // ------------------------------------------------------------------ input

  private wirePlot(): void {
    const plot = this.el.plot;

    plot.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.store.length === 0) return;
      const dpr = globalThis.devicePixelRatio || 1;
      const rect = plot.getBoundingClientRect();
      const x = (e.clientX - rect.left) * dpr;
      const intent = this.wheelIntent.classify(e.deltaX, e.deltaY, performance.now());
      if (intent === 'zoom') {
        // [SOURCE] zoomFactor = 2 ^ ((isPhysicalWheel ? 0.5 : 1) * scale * -deltaY / 120),
        // so one 120-unit notch is exactly sqrt(2) and Shift makes it 10x finer.
        // [UNVERIFIED] telling a physical wheel from a trackpad: the spec does not say how
        // A browser does not report it directly. A large, quantised deltaY with
        // no deltaX is the usual signature.
        const physical = e.deltaX === 0 && Math.abs(e.deltaY) >= 100 && Number.isInteger(e.deltaY);
        const f = wheelSpanFactor(e.deltaY, { isPhysicalWheel: physical, shift: e.shiftKey });
        this.stack.zoomAt(x, f);
      } else {
        this.stack.panPixels(e.deltaX * dpr);
      }
      this.setFollow(false);
      this.dirty = true;
    }, { passive: false });

    // One pointer drags (pan) or clicks (cursor); two pointers pinch-zoom around their
    // midpoint. Touch is pointer events here too - #plot carries `touch-action: pan-y`,
    // so the browser keeps vertical scrolling and hands everything else to this code.
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; midX: number } | null = null;
    let dragging = false;
    let lastX = 0;
    let downX = 0;
    let moved = 0;
    plot.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      plot.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2 };
        dragging = false;
        moved = 1000;   // a pinch never ends in a cursor placement
      } else if (pointers.size === 1) {
        dragging = true;
        lastX = e.clientX;
        downX = e.clientX;
        moved = 0;
      }
    });
    plot.addEventListener('pointermove', (e) => {
      const rect = plot.getBoundingClientRect();
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        if (this.store.length > 0 && dist > 0 && pinch.dist > 0) {
          const dpr = globalThis.devicePixelRatio || 1;
          // Fingers spreading = zoom in = a smaller sample span, anchored between them.
          this.stack.zoomAt((midX - rect.left) * dpr, pinch.dist / dist);
          this.stack.panPixels(-(midX - pinch.midX) * dpr);
          this.setFollow(false);
          this.dirty = true;
        }
        pinch = { dist, midX };
        return;
      }
      if (dragging) {
        const dpr = globalThis.devicePixelRatio || 1;
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        moved += Math.abs(dx);
        this.stack.panPixels(-dx * dpr);
        this.setFollow(false);
        this.dirty = true;
        return;
      }
      this.updateHover(e.clientX - rect.left, e.clientY - rect.top);
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (plot.hasPointerCapture(e.pointerId)) plot.releasePointerCapture(e.pointerId);
      if (pinch && pointers.size >= 2) {
        // Three fingers down and one lifted: the pinch pair changed identity, so the
        // baseline must be re-measured or the next move zooms by the pair difference.
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2 };
      } else if (pinch) {
        pinch = null;
        // The finger that stays down keeps panning; it must not read as a click.
        const rest = [...pointers.values()][0];
        if (rest) { dragging = true; lastX = rest.x; moved = 1000; }
      }
      if (!dragging || pointers.size > 0) return;
      dragging = false;
      // A pointercancel is the browser taking the gesture for itself - with
      // `touch-action: pan-y` that is every vertical scroll of the channel stack,
      // which has near-zero horizontal displacement and must not read as a click.
      if (e.type === 'pointercancel') return;
      // A click, not a drag: place a cursor. Shift places B.
      if (moved < 3 && Math.abs(e.clientX - downX) < 3 && this.store.length > 0) {
        const rect = plot.getBoundingClientRect();
        const s = Math.round(this.toSample(e.clientX - rect.left));
        if (e.shiftKey) this.cursorB = s; else this.cursorA = s;
        this.dirty = true;
      }
    };
    plot.addEventListener('pointerup', end);
    plot.addEventListener('pointercancel', end);
    plot.addEventListener('pointerleave', () => { this.hover = null; this.dirty = true; });
    plot.addEventListener('dblclick', () => { this.stack.zoomToFit(); this.dirty = true; });

    // Dragging the axis pans, which is what a time ruler is for.
    let axisDrag = false;
    let axisLast = 0;
    this.el.axis.addEventListener('pointerdown', (e) => {
      axisDrag = true; axisLast = e.clientX;
      this.el.axis.setPointerCapture(e.pointerId);
    });
    this.el.axis.addEventListener('pointermove', (e) => {
      if (!axisDrag) return;
      const dpr = globalThis.devicePixelRatio || 1;
      this.stack.panPixels(-(e.clientX - axisLast) * dpr);
      axisLast = e.clientX;
      this.setFollow(false);
      this.dirty = true;
    });
    const axisEnd = (e: PointerEvent) => {
      axisDrag = false;
      if (this.el.axis.hasPointerCapture(e.pointerId)) {
        this.el.axis.releasePointerCapture(e.pointerId);
      }
    };
    this.el.axis.addEventListener('pointerup', axisEnd);
    // Without this, a cancelled drag (tab switch, system gesture) leaves axisDrag
    // stuck on and every later hover over the ruler pans with no button held.
    this.el.axis.addEventListener('pointercancel', axisEnd);

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'f') { this.stack.zoomToFit(); this.dirty = true; }
      if (e.key === ' ') {
        e.preventDefault();
        if (this.running) void this.stopCapture(); else void this.startCapture();
      }
      if (e.key === 'Escape') { this.cursorA = null; this.cursorB = null; this.dirty = true; }
    });

    // Drag and drop a capture file straight onto the window.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void this.openFiles(files);
    });
  }

  /**
   * [CHOSEN] : hovering a digital pulse produces measurements with no
   * clicking at all - width and period brackets plus a readout of duty, frequency and
   * 1/width. Matching it is explicitly "not optional".
   */
  private updateHover(cssX: number, cssY: number): void {
    this.hover = null;
    const store = this.store;
    if (store.length === 0) { this.dirty = true; return; }

    let box = null;
    for (const b of this.stack.boxes()) {
      if (cssY >= b.top && cssY < b.top + b.height && b.spec.kind === 'channel') { box = b; break; }
    }
    if (!box) { this.dirty = true; return; }

    const ch = box.spec.channel;
    const s = Math.round(this.toSample(cssX));
    if (s < 0 || s >= store.length) { this.dirty = true; return; }

    // Look outward in widening windows rather than scanning the whole capture: edges() is
    // a linear scan, and on a dense channel over 100M samples that is a 200 MB answer.
    const spp = Math.max(1, this.stack.view.samplesPerPixel);
    let win = Math.max(64, Math.ceil(spp * 200));
    let prev = -1;
    let next = -1;
    let next2 = -1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const lo = Math.max(0, s - win);
      const hi = Math.min(store.length, s + win * 2);
      const e = store.edges(ch, lo, hi);
      prev = -1; next = -1; next2 = -1;
      for (let i = 0; i < e.length; i++) {
        if (e[i]! <= s) prev = e[i]!;
        else if (next < 0) next = e[i]!;
        else if (next2 < 0) { next2 = e[i]!; break; }
      }
      if (prev >= 0 && next >= 0 && next2 >= 0) break;
      if (lo === 0 && hi === store.length) break;
      win *= 4;
    }

    const sr = store.samplerate;
    const lines: string[] = [];
    let widthX0: number | null = null;
    let widthX1: number | null = null;
    let periodX0: number | null = null;
    let periodX1: number | null = null;

    if (prev >= 0 && next >= 0) {
      const width = (next - prev) / sr;
      widthX0 = this.toPx(prev);
      widthX1 = this.toPx(next);
      lines.push(`Width: ${formatDuration(width)}`);
      lines.push(`width⁻¹: ${formatFreq(1 / width)}`);
      if (next2 >= 0) {
        const period = (next2 - prev) / sr;
        periodX0 = this.toPx(prev);
        periodX1 = this.toPx(next2);
        lines.unshift(`Freq: ${formatFreq(1 / period)}`);
        lines.unshift(`Duty: ${((width / period) * 100).toFixed(2)} %`);
      }
    } else {
      lines.push('no transition in view');
    }

    this.hover = {
      pointerX: cssX,
      rowTop: box.top,
      rowBand: box.band,
      color: channelColor(ch),
      widthX0, widthX1, periodX0, periodX1,
      lines,
    };
    this.dirty = true;
  }

  private setFollow(on: boolean): void {
    this.stack.setFollowLatest(on);
  }

  // ------------------------------------------------------------------ toolbar / rail

  private wireToolbar(): void {
    this.el.transport.addEventListener('click', () => {
      if (this.running) void this.stopCapture(); else void this.startCapture();
    });
    must<HTMLButtonElement>('btn-open').addEventListener('click', () => {
      this.el.fileInput.value = '';
      this.el.fileInput.click();
    });
    this.el.fileInput.addEventListener('change', () => {
      const files = [...(this.el.fileInput.files ?? [])];
      if (files.length) void this.openFiles(files);
    });
    must<HTMLButtonElement>('btn-save').addEventListener('click', () => this.save());
    must<HTMLButtonElement>('btn-fit').addEventListener('click', () => {
      this.stack.zoomToFit();
      this.dirty = true;
    });
  }

  private wireRail(): void {
    const dev = must<HTMLButtonElement>('rail-device');
    const ana = must<HTMLButtonElement>('rail-analyzers');
    dev.addEventListener('click', () => {
      this.panel = this.panel === 'device' ? null : 'device';
      this.renderPanels();
      this.relayout();
    });
    ana.addEventListener('click', () => {
      this.panel = this.panel === 'analyzers' ? null : 'analyzers';
      this.renderPanels();
      this.relayout();
    });
  }

  private renderPanels(): void {
    const dev = must<HTMLButtonElement>('rail-device');
    const ana = must<HTMLButtonElement>('rail-analyzers');
    dev.classList.toggle('on', this.panel === 'device');
    ana.classList.toggle('on', this.panel === 'analyzers');
    this.el.side.classList.toggle('hidden', this.panel === null);

    // Toolbar chrome is updated before the early return below, not after it. It used to be
    // after, which meant that with no side panel open - the default - starting a capture
    // left the button reading "Start" and the title reading "no capture".
    this.renderToolbarState();
    if (this.panel === null) return;

    const host = this.el.side.firstElementChild as HTMLElement;
    host.replaceChildren();
    if (this.panel === 'device') {
      this.capturePanel.render({
        settings: this.settings,
        channels: this.channels,
        deviceName: this.device?.name ?? null,
        running: this.running,
        stopping: this.stopping,
        progress: this.running
          ? {
            seconds: this.captureStart > 0 ? (performance.now() - this.captureStart) / 1000 : 0,
            samples: this.store.length,
            bytes: this.captureBytes,
            lost: this.lostSamples,
          }
          : null,
        webusbAvailable: typeof navigator !== 'undefined' && !!navigator.usb,
        maxSamplerateHz: this.rateCeilings,
        triggerState: this.triggerState,
      });
    } else {
      this.analyzerPanel.render({
        channels: this.channels,
        analyzers: this.analyzers,
        captureChannels: this.store.channelCount,
        hasCapture: this.store.length > 0,
        warm: this.decodeWarm,
        busy: this.decodeBusy,
      });
    }
  }

  /**
   * The toolbar transport is the only Start/Stop in the shell - the capture panel used to
   * carry a second pair wired to the same two methods, and the two disagreed about when a
   * capture may start.
   *
   * Disabled without a device rather than clickable into a "no device connected" error:
   * `startCapture` still refuses, but the button is no longer the thing that reports it.
   * Always clickable while running, so a capture can be stopped even if the device
   * vanished mid-run.
   */
  private renderToolbarState(): void {
    const t = this.el.transport;
    t.textContent = this.stopping ? 'Stopping…' : this.running ? 'Stop' : 'Start';
    t.className = this.running ? 'danger' : 'primary';
    t.disabled = this.stopping || (!this.running && !this.device);
    t.title = t.disabled
      ? this.stopping ? 'Waiting for pending USB transfers to be cancelled'
        : 'Connect a device first (rail: ◈)'
      : this.running ? 'Stop the running capture' : 'Start a capture on the connected device';
    this.el.title.textContent = this.captureLabel;
  }

  private renderStatus(): void {
    const store = this.store;
    const view = this.stack.view;
    const sr = store.samplerate;
    const parts: string[] = [];
    parts.push(this.captureLabel);
    if (store.length > 0) {
      parts.push(`${formatCount(store.length)} samples @ ${formatRate(sr)}`);
      parts.push(`${formatDuration(store.length / sr)} total`);
      parts.push(`view ${formatDuration((view.end - view.start) / sr)}`);
    }
    // Cursor positions share the axis's origin: T=0 is the trigger sample when there
    // is one, so a pre-trigger cursor reads as the negative time the axis shows.
    const origin = this.triggerSampleIndex ?? 0;
    if (this.cursorA !== null) parts.push(`A ${formatDuration((this.cursorA - origin) / sr)}`);
    if (this.cursorB !== null) parts.push(`B ${formatDuration((this.cursorB - origin) / sr)}`);
    if (this.cursorA !== null && this.cursorB !== null) {
      const d = Math.abs(this.cursorB - this.cursorA) / sr;
      parts.push(`|B-A| ${formatDuration(d)}`);
      if (d > 0) parts.push(`1/|B-A| ${formatFreq(1 / d)}`);
    }

    this.el.status.replaceChildren();
    parts.forEach((p, i) => {
      if (i) {
        const s = document.createElement('span');
        s.className = 'sep';
        s.textContent = '·';
        this.el.status.appendChild(s);
      }
      const s = document.createElement('span');
      s.textContent = p;
      this.el.status.appendChild(s);
    });
    if (this.statusError) {
      const s = document.createElement('span');
      s.className = 'right err';
      s.textContent = this.statusError;
      this.el.status.appendChild(s);
    }
  }

  private fail(what: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.statusError = `${what}: ${msg}`;
    console.error(`[ui] ${what}`, e);
    this.dirty = true;
  }

  /**
   * A fatal error from the device's read loop. The stream is already dead at this
   * point, so a capture still marked as running would sit there displaying samples
   * that can never grow - the 32U3 underrun abort (device layer) is the common case.
   * stop() re-throws the same error, which fail() reports once more, so the message
   * the user reads is the read loop's, not a teardown artefact.
   */
  private deviceFailed(e: unknown): void {
    this.fail('device', e);
    if (this.running && !this.stopping) void this.stopCapture();
  }

  // ------------------------------------------------------------------ captures

  private async openFiles(files: File[]): Promise<void> {
    try {
      this.statusError = '';
      const t0 = performance.now();
      const cap = await loadFiles(files);
      this.adoptCapture(cap.store, cap.channelNames,
        `${cap.sourceDescription} · loaded in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      this.fail('open capture', e);
    }
  }

  private adoptCapture(store: SampleStore, names: string[], label: string): void {
    this.storeRef.set(store);
    this.channels = defaultChannels(store.channelCount);
    for (let i = 0; i < this.channels.length; i++) {
      // Keep real names ("SDA"); drop auto-generated ones that would just repeat the
      // D-tag next to them ("D3", "Channel 3", "3").
      const n = names[i];
      if (n && n !== `D${i}` && n !== `Channel ${i}` && n !== String(i)) {
        this.channels[i]!.name = n;
      }
    }
    this.order = this.channels.map((c) => c.index);
    // Annotations belong to a capture; a new one invalidates them.
    for (const a of this.analyzers) {
      a.result = null; a.index = null; a.status = 'idle'; a.message = 'not decoded';
    }
    this.cursorA = null;
    this.cursorB = null;
    this.triggerState = 'off';
    this.triggerSampleIndex = null;
    this.captureLabel = label;
    this.settings = clampSettings(
      { ...this.settings, channels: this.neededWidth() }, this.rateCeilings,
    );
    this.relayout();
    this.stack.zoomToFit();
    this.renderPanels();
    this.dirty = true;
  }

  private save(): void {
    try {
      if (this.store.length === 0) throw new Error('nothing to save');
      const blob = saveLwcap(this.store, this.channels.map((c) => c.name));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.lwcap`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      this.fail('save', e);
    }
  }

  // ------------------------------------------------------------------ device

  private async reconnectGranted(): Promise<void> {
    try {
      if (!navigator.usb) return;
      const devs = await getGrantedDevicesOnBestThread();
      const d = devs[0];
      if (!d) return;
      d.onError = (e) => this.deviceFailed(e);
      this.device = d;
      this.noteTransport();
      this.adoptDeviceChannels(d);
      this.renderPanels();
    } catch (e) {
      // Not fatal: the device may be claimed by sigrok-cli, or unplugged.
      this.fail('reconnect', e);
    }
  }

  private async connect(): Promise<void> {
    try {
      this.statusError = '';
      const d = await requestDeviceOnBestThread();
      d.onError = (e) => this.deviceFailed(e);
      this.device = d;
      this.noteTransport();
      this.adoptDeviceChannels(d);
      this.renderPanels();
    } catch (e) {
      this.fail('connect', e);
    }
  }

  /**
   * The worker is the transport that keeps a re-arm from waiting on this thread, so a
   * silent fall back to the page is worth saying out loud - it is the difference between
   * a capture that survives a 30 ms garbage collection at 800 MB/s and one that does not.
   */
  private noteTransport(): void {
    if (!(this.device instanceof WorkerSlogicDevice) && workerTransport.lastFallbackReason) {
      console.warn(
        '[slogic] capturing on the page thread: the worker transport could not open the ' +
        `device (${workerTransport.lastFallbackReason})`,
      );
    }
  }

  private async usbControl(command: string): Promise<string> {
    if (!this.device) throw new Error('no device connected');
    if (!this.device.usbControl) throw new Error('this device does not expose a USB console');
    return this.device.usbControl(command);
  }

  /** Grow the channel model when a wider SLogic board is connected. */
  private adoptDeviceChannels(device: Device): void {
    this.rateCeilings = device.maxSamplerateHz ?? MAX_SAMPLERATE_HZ;
    const max = device.maxChannels ?? this.channels.length;
    if (!isChannelCount(max)) {
      throw new Error(`device reported unsupported channel count ${max}`);
    }
    if (this.store.length === 0 && max !== this.store.channelCount) {
      // The empty store is still rendered before Start is pressed. Grow it together with
      // the channel rows; otherwise row 16 of a newly-connected 32U3 is queried against
      // the initial 16-channel placeholder and WaveformRenderer rejects it as out of range.
      this.storeRef.set(createSampleStore(max, this.settings.samplerate));
    }
    if (this.store.length === 0 && max !== this.channels.length) {
      this.channels = defaultChannels(max);
      this.order = this.channels.map((c) => c.index);
    }
    this.settings = clampSettings(
      { ...this.settings, channels: max }, this.rateCeilings,
    );
    this.relayout();
  }

  private async startCapture(): Promise<void> {
    if (this.running || this.stopping) return;
    if (!this.device) { this.fail('start', new Error('no device connected')); return; }
    try {
      this.statusError = '';
      const cfg: CaptureConfig = {
        channels: this.settings.channels,
        samplerate: this.settings.samplerate,
        thresholdVolts: this.settings.thresholdVolts,
        testMode: this.settings.testMode,
      };
      // The device layer maps volts to a DAC code; check it lands somewhere sane before
      // the capture rather than discovering a clipped threshold in the data.
      const code = vrefCode(cfg.thresholdVolts);
      if (code === 0 || code === 1023) {
        throw new Error(`threshold ${cfg.thresholdVolts} V clips the DAC (code ${code})`);
      }

      const store = createSampleStore(cfg.channels, cfg.samplerate);
      this.storeRef.set(store);
      this.channels = defaultChannels(cfg.channels);
      this.order = this.channels.map((c) => c.index);
      for (const a of this.analyzers) {
        a.result = null; a.index = null; a.status = 'idle'; a.message = 'not decoded';
      }
      this.captureBytes = 0;
      this.lostSamples = 0;
      this.triggerSampleIndex = null;
      this.captureStart = this.settings.softwareTrigger ? 0 : performance.now();
      const postTriggerSamples = this.settings.mode === 'timer'
        ? Math.min(MAX_SAMPLES - 1, Math.round(this.settings.seconds * cfg.samplerate))
        : MAX_SAMPLES - 1;
      this.captureLimitSamples = postTriggerSamples;
      this.triggerState = this.settings.softwareTrigger ? 'waiting' : 'off';
      this.captureLabel = `capturing ${cfg.channels} ch @ ${formatRate(cfg.samplerate)}`;
      this.running = true;
      this.relayout();
      // Show a window rather than the whole (empty) capture, and follow the live edge.
      const span = Math.max(1000, Math.round(cfg.samplerate * 0.05));
      this.stack.setViewport(0, span);
      this.setFollow(true);
      this.renderPanels();

      const bytesPerSample = bytesPerSampleForChannels(cfg.channels);
      const triggerConditions = this.settings.triggerConditions.length
        ? this.settings.triggerConditions
        : [{ channel: this.settings.triggerChannel, kind: this.settings.triggerKind,
          level: this.settings.triggerLevel }];
      const preTriggerSamples = this.settings.softwareTrigger ? Math.min(
        Math.max(0, this.captureLimitSamples - 1),
        Math.max(0, Math.floor(postTriggerSamples * this.settings.preTriggerPercent / 100)),
        Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bytesPerSampleForChannels(cfg.channels)),
      ) : 0;
      if (this.settings.softwareTrigger) {
        // Timer duration starts at the trigger sample. The store budget therefore
        // includes the retained prefix plus the requested post-trigger duration.
        // In free-run mode `post` is already the store ceiling, so this clamp trims
        // the post-trigger window, not the prefix - the trigger keeps its full ring.
        this.captureLimitSamples = Math.min(MAX_SAMPLES - 1, postTriggerSamples + preTriggerSamples);
      }
      await this.device.start(cfg, (chunk) => {
        // Chunks arriving while `stopping` are the drained tail of this capture - the
        // reads that had already completed when stop began, plus the flushed coalescing
        // block. Dropping them truncated every manually stopped capture by up to one
        // sink block (~10 ms at 32ch/200M).
        if (!this.running && !this.stopping) return;
        const room = (this.captureLimitSamples - store.length) * bytesPerSample;
        if (room <= 0) { void this.stopCapture(); return; }
        // Count what is actually kept: a truncated tail chunk must not inflate the
        // progress readout past the capture.
        this.captureBytes += Math.min(room, chunk.length);
        store.append(room < chunk.length ? chunk.subarray(0, room) : chunk);
        this.dirty = true;
        if (store.length >= this.captureLimitSamples) void this.stopCapture();
      }, (pos, missing) => {
        // A transfer the device could not fill. Append filler for the lost samples so
        // store time keeps tracking device time, then mark that span untrusted.
        //
        // The anchor is `store.length`, not `pos`. They are the same number by
        // construction - onDropout fires after deliver(), which has already handed the
        // short transfer's payload to the sink above - but the store's own length is the
        // invariant that has to hold, and the two cases where they can diverge are both
        // already handled: the sink returns early when !running (checked here too) and
        // when the capture is full (appendLostSamples then finds no room and returns 0).
        if (!this.running && !this.stopping) return;
        // `pos` is not the anchor, but it is a free cross-check on the invariant, and a
        // silent divergence here would misplace every gap in the capture. Reported once.
        if (pos !== store.length && this.lostSamples === 0) {
          this.fail('dropout accounting',
            new Error(`device counted ${pos} samples delivered, store holds ${store.length}`));
        }
        const n = appendLostSamples(store, missing, this.captureLimitSamples);
        if (n === 0) return;
        this.lostSamples += n;
        if (store.length >= this.captureLimitSamples) void this.stopCapture();
      }, this.settings.softwareTrigger ? {
        // The transport says when the capture has delivered everything it ever will
        // (trigger budget emitted, or the device stopped at its own length). This is
        // the stop signal that does not depend on this side's sample arithmetic
        // agreeing with the device's to the sample.
        onEnd: () => { if (this.running) void this.stopCapture(); },
        softwareTrigger: {
          channels: cfg.channels,
          conditions: triggerConditions.map((c) => ({
            channel: Math.min(c.channel, cfg.channels - 1), kind: c.kind, level: c.level,
          })),
          channel: Math.min(triggerConditions[0]!.channel, cfg.channels - 1),
          kind: triggerConditions[0]!.kind,
          level: triggerConditions[0]!.level,
          preTriggerSamples, maxSamples: this.captureLimitSamples,
          searchLimitSamples: Number.POSITIVE_INFINITY,
        },
        onTriggerState: (state, triggerSampleIndex) => {
          this.triggerState = state;
          if (state === 'triggered' && triggerSampleIndex !== undefined) {
            this.triggerSampleIndex = triggerSampleIndex;
            this.captureStart = performance.now();
          }
          this.dirty = true;
          this.relayout();
          this.renderPanels();
          if (state === 'not-found') void this.stopCapture();
        },
      } : {
        // A timer capture knows its length before RUN, so the device can be told to
        // stop by itself at that length (R32_SAMPLE_LEN). That is the vendor's own
        // answer to the overrun that wedges the board, and it is the only end-of-
        // capture that never requires cutting off a device that is still producing.
        // Software-trigger mode cannot use it: where the trigger will land is not
        // known when the device is armed, and a limit there would stop the capture
        // before the trigger arrives.
        deviceSampleLimit: this.captureLimitSamples,
        onEnd: () => { if (this.running) void this.stopCapture(); },
      });
    } catch (e) {
      this.running = false;
      this.triggerState = 'off';
      this.triggerSampleIndex = null;
      this.relayout();
      this.fail('start capture', e);
      this.renderPanels();
    }
  }

  private async stopCapture(): Promise<void> {
    if (!this.running || this.stopping) return;
    this.running = false;
    this.stopping = true;
    this.renderPanels();
    try {
      await this.device?.stop();
    } catch (e) {
      this.fail('stop capture', e);
    } finally {
      this.stopping = false;
    }
    this.setFollow(false);
    const sr = this.store.samplerate;
    this.captureLabel = this.triggerState === 'not-found'
      ? `no trigger · ${formatCount(this.store.length)} samples retained`
      : `live capture · ${formatCount(this.store.length)} samples @ ${formatRate(sr)} · ` +
        `${formatDuration(this.store.length / sr)}`;
    this.stack.zoomToFit();
    this.relayout();
    this.renderPanels();
    this.dirty = true;
  }

  // ------------------------------------------------------------------ analyzers

  private async attachAnalyzer(
    decoderId: string, channels: Record<number, number>, options: Record<string, string | number>,
  ): Promise<void> {
    const info = getDecoder(decoderId);
    const mapped = Object.keys(channels).map(Number).sort((a, b) => a - b);
    const laneChannel = mapped.length ? channels[mapped[mapped.length - 1]!]! : 0;
    const a: AnalyzerState = {
      id: `${decoderId}-${this.nextAnalyzer++}`,
      decoderId,
      label: info.name,
      color: analyzerColor(this.analyzers.length),
      channels,
      options,
      laneChannel,
      result: null,
      index: null,
      status: 'idle',
      message: 'not decoded',
    };
    this.analyzers.push(a);
    this.renderPanels();
    await this.runDecode(a.id);
  }

  private removeAnalyzer(id: string): void {
    this.analyzers = this.analyzers.filter((a) => a.id !== id);
    this.relayout();
    this.renderPanels();
  }

  private async runDecode(id: string): Promise<void> {
    const a = this.analyzers.find((x) => x.id === id);
    if (!a) return;
    const store = this.store as CountingStore;
    try {
      this.statusError = '';
      if (store.length === 0) throw new Error('no capture to decode');
      // [src/decode/limits.ts] annotation spans are Int32Array, so 2^31-1 is a hard
      // ceiling - 10.7 s at 200 MSa/s, which this bench can actually reach.
      if (store.length > MAX_SAMPLE) {
        throw new Error(
          `capture is ${formatCount(store.length)} samples; decode is limited to ` +
          `${formatCount(MAX_SAMPLE)} (10.7 s at 200 MSa/s). Decode a sub-range instead.`);
      }
      const used = [...new Set(Object.values(a.channels).filter((v) => v >= 0))];
      let edgeTotal = 0;
      for (const c of used) {
        edgeTotal += store.edgeCount
          ? store.edgeCount(c, 0, store.length)
          : store.edges(c, 0, store.length).length;
      }
      // [src/decode/limits.ts] past ~80 M edges Pyodide corrupts rather than failing, so
      // the budget stops at 48 M where refusing is still possible.
      if (edgeTotal > EDGE_BUDGET) {
        throw new Error(
          `${formatCount(edgeTotal)} edges on the mapped channels exceeds the ` +
          `${formatCount(EDGE_BUDGET)} decode budget. Disable a channel or zoom the ` +
          `capture down.`);
      }

      a.status = 'decoding';
      a.message = `${formatCount(edgeTotal)} edges`;
      this.decodeBusy = true;
      this.renderPanels();

      // [src/decode] only channels the stack maps are read; supplying real edge lists for
      // the rest was 34% of wall time on a 16-channel 2 M-edge capture.
      const empty: ChannelEdges = { edges: new Int32Array(0), initial: 0 };
      const chans: ChannelEdges[] = Array.from({ length: store.channelCount }, () => empty);
      for (const c of used) {
        chans[c] = { edges: store.edges(c, 0, store.length), initial: levelAt(store, c, 0) };
      }
      const req: DecodeRequest = {
        samplerate: store.samplerate,
        length: store.length,
        channels: chans,
        stack: [{ id: a.decoderId, instanceId: a.id, channels: a.channels, options: a.options }],
      };
      this.abort = new AbortController();
      const t0 = performance.now();
      const result: DecodeResult = await this.decodeClient.decode(
        req, { timeoutMs: 120_000, signal: this.abort.signal });
      a.result = result;
      a.index = new AnnotationIndex(result);
      a.status = 'done';
      a.message =
        `${formatCount(result.annotations.count)} anns, ${Math.round(result.decodeMs)} ms ` +
        `(${Math.round(performance.now() - t0)} ms wall)`;
      if (result.errors.length) a.message += ` · ${result.errors[0]}`;
    } catch (e) {
      a.status = 'error';
      a.message = e instanceof DecodeTimeoutError ? 'timed out'
        : e instanceof DecodeCancelledError ? 'cancelled'
          : e instanceof Error ? e.message : String(e);
      this.fail(`decode ${a.decoderId}`, e);
    } finally {
      this.decodeBusy = false;
      this.abort = null;
      this.relayout();
      this.renderPanels();
      this.dirty = true;
    }
  }

  // ------------------------------------------------------------------ test surface

  /**
   * What `src/ui/tools/run-ui.mjs` drives. It exists so the evidence in NOTES.md is
   * produced by a re-runnable script rather than by a screenshot somebody took once, and
   * so that script does not have to reach into private fields.
   *
   * Every method here is one a button also calls, so driving it exercises the shipping
   * path rather than a parallel one built for the test.
   */
  readonly debug = {
    connect: () => this.connect(),
    start: () => this.startCapture(),
    stop: () => this.stopCapture(),
    attach: (id: string, ch: Record<number, number>, opts: Record<string, string | number> = {}) =>
      this.attachAnalyzer(id, ch, opts),
    setSettings: (s: Partial<CaptureSettings>) => {
      const next = clampSettings({ ...this.settings, ...s }, this.rateCeilings);
      if (triggerSettingsChanged(this.settings, next)) {
        this.triggerState = 'off';
        this.triggerSampleIndex = null;
        this.dirty = true;
      }
      this.settings = next;
      this.relayout();
      this.renderPanels();
    },
    setPanel: (p: 'device' | 'analyzers' | null) => {
      this.panel = p;
      this.renderPanels();
      this.relayout();
    },
    setViewportSeconds: (a: number, b: number) => {
      const sr = this.store.samplerate;
      this.stack.setViewport(a * sr, b * sr);
      this.dirty = true;
    },
    setCursors: (a: number | null, b: number | null) => {
      this.cursorA = a;
      this.cursorB = b;
      this.dirty = true;
    },
    hoverAt: (cssX: number, cssY: number) => this.updateHover(cssX, cssY),
    toggleChannel: (i: number, on: boolean) => this.setChannelEnabled(i, on),
    rename: (i: number, name: string) => {
      const c = this.channels[i];
      if (c) c.name = name;
      this.relayout();
    },
    reorder: (from: number, to: number) => this.reorder(from, to),
    /**
     * Save this capture as `.lwcap` and load it straight back, comparing every channel's
     * edge list. The format stores transitions rather than samples, so a round trip is
     * the only thing that proves the replay reconstructs the stream - a file that writes
     * and reads consistently but reconstructs wrongly would otherwise look fine.
     */
    roundTripLwcap: async () => {
      const store = this.store;
      const before = { n: store.channelCount, sr: store.samplerate, len: store.length };
      const blob = saveLwcap(store, this.channels.map((c) => c.name));
      const back = loadLwcap(await blob.arrayBuffer(), 'round-trip');
      const problems: string[] = [];
      if (back.store.channelCount !== before.n) problems.push('channelCount');
      if (back.store.samplerate !== before.sr) problems.push('samplerate');
      if (back.store.length !== before.len) problems.push(`length ${back.store.length} != ${before.len}`);
      let edges = 0;
      for (let c = 0; c < before.n && problems.length === 0; c++) {
        const a = store.edges(c, 0, before.len);
        const b = back.store.edges(c, 0, before.len);
        edges += a.length;
        if (a.length !== b.length) { problems.push(`ch${c} edge count ${a.length} != ${b.length}`); break; }
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) { problems.push(`ch${c} edge ${i}: ${a[i]} != ${b[i]}`); break; }
        }
      }
      return { bytes: blob.size, edges, ok: problems.length === 0, problems };
    },
    /** Centre the view on the nth annotation of an analyzer, with `pad` spans either side.
     *  Used by the screenshot driver so a shot lands on real traffic instead of on luck. */
    zoomToAnnotation: (analyzerIndex: number, n: number, pad = 3) => {
      // -1 means "the last analyzer that actually has a result", which is what a driver
      // wants after a new capture cleared the earlier ones.
      const a = analyzerIndex >= 0
        ? this.analyzers[analyzerIndex]
        : [...this.analyzers].reverse().find((x) => x.result);
      if (!a?.result || a.result.annotations.count <= n) return false;
      const { start, end } = a.result.annotations;
      const s = start[n]!;
      const e = Math.max(end[n]!, s + 1);
      const w = (e - s) * (1 + 2 * pad);
      this.stack.setViewport(s - (e - s) * pad, s - (e - s) * pad + w);
      this.dirty = true;
      return true;
    },
    snapshot: () => ({
      label: this.captureLabel,
      error: this.statusError,
      running: this.running,
      device: this.device?.name ?? null,
      transport: this.device instanceof WorkerSlogicDevice ? 'worker' : 'page',
      transportFallback: workerTransport.lastFallbackReason,
      warm: this.decodeWarm,
      samples: this.store.length,
      samplerate: this.store.samplerate,
      channels: this.store.channelCount,
      triggerState: this.triggerState,
      triggerSampleIndex: this.triggerSampleIndex,
      trigger: {
        enabled: this.settings.softwareTrigger,
        enableMask: this.settings.triggerEnableMask,
        preTriggerPercent: this.settings.preTriggerPercent,
        modes: { ...this.settings.triggerModes },
        conditions: this.settings.triggerConditions,
      },
      enabled: this.enabledChannels().map((c) => c.index),
      rows: this.stack.rowSpecs.map((r) => `${r.kind}:${r.channel}:${r.heightCss}`),
      lanes: this.lanes.length,
      view: { start: this.stack.view.start, end: this.stack.view.end },
      analyzers: this.analyzers.map((a) => ({
        id: a.id,
        decoder: a.decoderId,
        status: a.status,
        message: a.message,
        annotations: a.result?.annotations.count ?? 0,
        laneChannel: a.laneChannel,
      })),
    }),
  };
}

/**
 * Settings are clamped, not rejected: every field here has a hard limit the device or the
 * store enforces anyway, and a value the user cannot reach is better than an error at
 * Start.
 *
 * The samplerate clamp matters because the capture width is derived, not chosen. Narrow to
 * 4 channels, pick the 800 MS/s the panel then offers, re-enable a high channel, and the
 * width jumps to 16 whose ceiling is 200 MS/s. Without this the stale 800 MS/s survived,
 * the rate dropdown - which lists only rates at or under the ceiling - rendered with no
 * selection at all, and Start threw "800 MHz exceeds the 16-channel ceiling of 200 MHz"
 * from the device layer with no visible control to fix it. Every MAX_SAMPLERATE_HZ value
 * is itself in SAMPLERATES_HZ, so the clamp always lands on a rate the device supports.
 */
function clampSettings(
  s: CaptureSettings, ceilings: Readonly<Record<number, number>> = MAX_SAMPLERATE_HZ,
): CaptureSettings {
  const samplerate = Math.min(s.samplerate, ceilings[s.channels] ?? 200e6);
  const max = MAX_SAMPLES / samplerate;
  const savedModes = s.triggerModes ?? {};
  const configuredConditions = Object.keys(savedModes).length ? modesToConditions(savedModes)
    : s.triggerConditions.length ? s.triggerConditions : s.softwareTrigger
      ? [{ channel: s.triggerChannel, kind: s.triggerKind, level: s.triggerLevel }]
      : [];
  const triggerConditions = configuredConditions
    .filter((c) => c.channel >= 0 && c.channel < s.channels)
    .map((c) => ({ ...c }));
  const triggerModes: Record<number, TriggerMode> = { ...savedModes };
  for (const c of triggerConditions) {
    // 'edge' (either direction) is engine-supported but has no glyph in the inline
    // five-state picker, so a saved/debug condition using it maps to X here and the
    // condition is dropped on the next settings edit. Unsupported in this UI on
    // purpose; pick rising or falling instead.
    triggerModes[c.channel] = c.kind === 'level' ? (c.level ? 'high' : 'low')
      : c.kind === 'rising' ? 'rising' : c.kind === 'falling' ? 'falling' : 'dont-care';
  }
  return {
    ...s, samplerate, seconds: Math.max(0.001, Math.min(s.seconds, max)),
    triggerEnableMask: s.triggerEnableMask ?? true,
    // Enable Mask is the sole global gate. Turning it off must not erase the
    // per-channel modes; turning it back on must restore the same conditions.
    softwareTrigger: s.triggerEnableMask !== false && triggerConditions.length > 0,
    triggerModes,
    triggerChannel: Math.max(0, Math.min(s.triggerChannel, s.channels - 1)),
    triggerConditions,
    preTriggerPercent: Math.max(0, Math.min(75, s.preTriggerPercent)),
  };
}

function modesToConditions(modes: Record<number, TriggerMode>): CaptureSettings['triggerConditions'] {
  return Object.keys(modes).map(Number).sort((a, b) => a - b).flatMap((channel): CaptureSettings['triggerConditions'] => {
    const mode = modes[channel];
    if (!mode || mode === 'dont-care') return [];
    if (mode === 'low' || mode === 'high') return [{ channel, kind: 'level' as const, level: mode === 'high' ? 1 as const : 0 as const }];
    return [{ channel, kind: mode, level: 1 as const }];
  });
}

function triggerSummary(s: CaptureSettings, channel: number): string {
  const c = s.triggerConditions.find((x) => x.channel === channel);
  const kind = c?.kind ?? s.triggerKind;
  const level = c?.level ?? s.triggerLevel;
  const condition = kind === 'level'
    ? `Level ${level}`
    : kind === 'rising'
      ? 'Rising edge'
      : kind === 'falling'
        ? 'Falling edge'
        : 'Any edge';
  const total = s.triggerConditions.length;
  return `${condition} · ${s.preTriggerPercent}% pre-trigger${total > 1 ? ` · AND ${total} conditions` : ''}`;
}

/** Configuration edits describe a future capture; they must not leave the previous
 * capture's T origin and relative axis attached to a newly selected trigger. */
function triggerSettingsChanged(a: CaptureSettings, b: CaptureSettings): boolean {
  if (a.softwareTrigger !== b.softwareTrigger || a.triggerEnableMask !== b.triggerEnableMask ||
      a.triggerChannel !== b.triggerChannel || a.triggerKind !== b.triggerKind ||
      a.triggerLevel !== b.triggerLevel || a.preTriggerPercent !== b.preTriggerPercent ||
      a.triggerConditions.length !== b.triggerConditions.length) return true;
  const am = a.triggerModes ?? {};
  const bm = b.triggerModes ?? {};
  const modeKeys = new Set([...Object.keys(am), ...Object.keys(bm)]);
  for (const key of modeKeys) if (am[Number(key)] !== bm[Number(key)]) return true;
  return a.triggerConditions.some((x, i) => {
    const y = b.triggerConditions[i];
    return !y || x.channel !== y.channel || x.kind !== y.kind || x.level !== y.level;
  });
}

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html is missing #${id}`);
  return el as T;
}

export { COLORS };
