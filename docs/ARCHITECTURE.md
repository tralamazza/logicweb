# logicweb - module contracts

The point of this file is that several agents build in parallel without colliding. **Own
your directory, import across boundaries only through the interfaces below, do not edit
another module's files.** If you need a contract changed, say so in your report instead of
changing it unilaterally.

Stack: TypeScript, Vite, no UI framework unless a builder makes a case for one. Browser is
Brave (Chromium) - the only WebUSB-capable browser installed on this machine.

## Layout

```
src/
  device/     WebUSB transport for the SLogic16 U3          (owner: device builder)
  data/       sample storage + multiresolution query         (owner: data builder)
  render/     WebGL2 waveform canvas                         (owner: render builder)
  ui/         shell, channel rows, timebase, cursors         (owner: ui builder)
  decode/     protocol decoders in a worker                  (owner: decode builder)
bench/        the three measured numbers                     (owner: bench builder)
fixtures/     .sr captures from our own hardware, for the suites
docs/         specs, this file, progress                     (owner: lead)
```

## Contracts

### `src/device`

```ts
export interface CaptureConfig {
  channels: 4 | 8 | 16;
  samplerate: number;        // Hz, from the table in PROTOCOL-SLOGIC16U3.md
  thresholdVolts: number;    // mapped to the DAC code by the device layer
}

export interface Device {
  readonly name: string;
  readonly serial: string;
  start(cfg: CaptureConfig, sink: (chunk: Uint8Array) => void,
        onDropout?: (samplePosition: number, missingSamples: number) => void): Promise<void>;
  stop(): Promise<void>;
}

export function requestDevice(): Promise<Device>;   // triggers the WebUSB picker
```

`onDropout` fires when a bulk transfer comes back short mid-run: `samplePosition` samples
were delivered before `missingSamples` were lost. The short final transfer of a run is the
normal end and is not reported. Callers should mark the span via `SampleStore.noteGap`.

`chunk` is raw device bytes with the 4 junk head bytes already removed and sub-8-channel
packing already expanded to one byte per sample. At 16 channels it stays 2 bytes/sample
little endian.

### `src/data`

```ts
export interface SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  readonly length: number;                 // samples
  append(chunk: Uint8Array): void;
  /** Downsampled view for rendering: for each of `bins` pixel columns over
   *  [startSample, endSample), the low bit, the high bit and whether the column
   *  contains at least one edge. Must be O(bins), not O(samples). */
  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView;
  /** Exact edge positions, for cursors, measurement and decoders. */
  edges(channel: number, startSample: number, endSample: number): Int32Array;
  /** Record that samples [startSample, endSample) are unknown (a transfer dropout).
   *  Overlapping notes are merged. */
  noteGap(startSample: number, endSample: number): void;
  /** The unknown spans, sorted and non-overlapping; [] for a store without gaps. */
  gaps(): GapSpan[];
}
```

`query` being sublinear in sample count is the whole ballgame for the framerate metric.
Build the mip pyramid on append. Two implementations satisfy the contract:

- `PlanarSampleStore` - the live-capture store. One bit per sample per channel plus a
  pyramid; `createSampleStore()` returns it.
- `RleSampleStore` - the import store, built from per-channel transition lists
  (`createTransitionStore()` quantises transition times to sample positions with the same
  rule the planar resample used: first sample at or after the transition, same-sample
  toggles cancel pairwise; `createEdgeStore()` takes transitions already in sample space).
  O(edges) to build and O(log edges-per-segment) per column to query; `append` throws -
  it is immutable. Loads are flat with capture size because nothing expands to samples.

`ColumnView` was left undefined here originally, which was a gap in this contract. The data
builder defined it in `src/data/types.ts` and flagged it rather than assuming the renderer
would agree. It is now the contract:

```ts
export interface ColumnView {
  readonly channel: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly bins: number;
  readonly low: Uint8Array;    // min sample value in the column
  readonly high: Uint8Array;   // max sample value in the column
  readonly edge: Uint8Array;   // 1 if a transition falls in [colStart-1, colEnd)
  readonly packed: Uint8Array; // bit0=high, bit1=low, bit2=edge, bit3=gap
}
```

`GAP_BIT` (bit3 of `packed`, value 8) is set on every column that overlaps a `noteGap`
span. The renderer draws NO_DATA there and ignores the other bits; `edges()` never
reports a transition inside a gap - unknown is not idle.

Two properties the renderer must not undo. The `-1` in the edge span makes a transition
landing exactly on a column boundary belong to the column it enters, so an edge can never
fall in the gap between two columns and vanish. And `low != high` implies `edge`, but not
the reverse: a column that is entirely 0 but was preceded by a 1 has a real falling edge at
its left border and reports `edge=1, low=0, high=0`. Render from `edge`, not from
`low != high`, or narrow pulses disappear at zoom-out.

`packed` is laid out for direct upload as a WebGL2 R8UI texture.

### `src/render`

Consumes `SampleStore.query` only. Owns the canvas, the transform (samples <-> pixels), and
nothing else. Exposes `setViewport(startSample, endSample)` and `render()`.

### `src/ui`

Owns layout, channel enable/rename/reorder, timebase readout, cursors and measurements,
trigger settings, capture controls. Calls into device/data/render; never touches WebUSB or
WebGL directly.

### `src/decode`

Runs in a Web Worker. Takes `edges()` output, produces annotation spans. Whether that is
libsigrokdecode compiled with emscripten, or Pyodide running the stock `.py` decoders
against a JS-side `sigrokdecode` shim, is the decode builder's call - **measure both before
choosing, and report the numbers.** libsigrokdecode is not checked out on this machine;
clone it from `git://sigrok.org/libsigrokdecode` if needed.

### `bench/`

Three numbers, measured on this machine, reported with the method used:

1. Sustained pan/zoom framerate on a 100M-sample 16-channel capture.
2. Seconds from opening a capture file to an interactive waveform.
3. Decoder count, and annotations per second on a fixed capture.

Each must be produced by a script that can be re-run, not by eyeballing devtools.

## Shipping it as a static site

There is no server-side anything. `npm run build` emits a self-contained `dist/` that any
static host serves - GitHub Pages, Netlify, S3, `npx serve`, `python3 -m http.server`. The
"Python" in this project is Pyodide, CPython compiled to WASM running **in the browser**
for the sigrok decoders; it is vendored into `public/pyodide/` and nothing executes Python
server-side.

Two things the build has to get right, both of which were broken:

- **Every run-time asset must be in `dist/`.** `public/pyodide/` and `public/decoders/`
  are gitignored and staged by `npm run vendor`; `reference/data/bin{,120}` live outside
  `public/` and are copied by the `logicweb:reference-captures` plugin in
  `vite.config.ts`. That plugin also *checks* all four at `buildStart` and fails the build
  if any are missing, because the failure mode otherwise is a bundle that looks fine and
  404s at run time - which is exactly how the Reference buttons shipped broken.
- **Sub-directory hosting needs `--base`.** Four run-time paths are built from
  `import.meta.env.BASE_URL` (`/pyodide/`, `/decoders/decoders.zip` in the decode worker,
  and the two reference captures in `app.ts`). It defaults to `/`, so a domain root needs
  nothing; for `example.com/logicweb/` build with `vite build --base=/logicweb/`.
  [MEASURED] with the base set, the app loads, the reference capture opens and the decode
  worker reaches Pyodide; without it, served from a sub-directory, the page cannot even
  load its own bundle.

`base: './'` is deliberately **not** used: a relative base resolves against the decode
worker's own URL (`/assets/`) rather than the document, pointing Pyodide at
`/assets/pyodide/`.

Two limits worth knowing before choosing a host:

- **`file://` does not work and cannot be made to.** [MEASURED] Chrome blocks ES module
  scripts from `origin 'null'` even with correct relative paths, and the same applies to
  the decode worker and Pyodide's `.wasm` fetches. (`file://` *is* a secure context and
  does expose `navigator.usb` - that part is not the obstacle.)
- **No COOP/COEP means no `SharedArrayBuffer`**, so decode cancellation kills and respawns
  the worker instead of interrupting it, costing a Pyodide reload on the next decode
  (~870 ms against 13-46 ms warm). That is already true in dev and is not a regression
  from deploying - see `src/decode/NOTES.md`, where this was recorded backwards.
  WebUSB needs `https` or `localhost` either way.

## Rules for every builder

- Check the reply of every device command before trusting what follows.
- Fail loudly and early. No silent catch blocks.
- Report what you measured, including misses. A tested wrong hypothesis is progress.
