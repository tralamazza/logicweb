# src/ui - the application shell

Owner: ui builder. Owns layout, the channel list, the time axis, cursors and measurement,
capture controls, analyzer attachment, and the app entry point. Calls into
`src/device`, `src/data`, `src/render` and `src/decode` through their published
interfaces only; never touches WebUSB or WebGL directly.

Written as the work happened, not at the end.

## Run it

```
npm run dev                    # http://127.0.0.1:5173/
node src/ui/tools/run-ui.mjs all      # the whole evidence run, headed Brave, real device
python3 src/ui/tools/measure-chrome.py --selftest    # the measuring tool's own controls
```

`run-ui.mjs` writes screenshots and `report.json` to `/tmp/logicweb-ui/`. It deletes
nothing - not its output, not the throwaway Brave profile, whose path it prints.

---

## 1. Everything about appearance is measured, not invented

Tool: `src/ui/tools/measure-chrome.py`. It reports panel boundaries, band heights, border
colours and row pitch for any PNG, converting through the embedded ICC profile first - the
Screenshots are in the display's wide gamut, and skipping that makes 7 of the 8
channel colours read wrong while the neutrals read right, which is the hardest kind of
error to notice.

**The tool carries controls and they are run every time.** `--selftest` builds a synthetic
PNG with known band boundaries and requires exact recovery, *and* builds a second one with
one band moved 20 px and requires the tool to report a difference. The first check alone
would pass for a tool that printed a constant.

```
$ python3 src/ui/tools/measure-chrome.py --selftest
control 1 PASS: synthetic bands recovered exactly
control 2 PASS: 20 px shift detected (120:2#57575F -> 140:2#57575F)
```

Everything below is **device px at dpr 2** from the 3200x2000 screenshots.

### Text placement in the label column, measured at y=240

- 5 CSS px of the channel colour at the far left (device x 0..9).
- the `D0` tag **in the channel colour**, device x 37..59.
- the channel name in `#E0E0E0` from device x 106.
- below it, one line per attached analyzer: a filled square in the analyzer's colour then
  its name in small grey text, exactly as `05-analyzer-annotations.png` shows
  `I2C - SDA` under `D0`.

### Time axis

- Major label ink at device y 136..152, minor at 159..176. 11 px bold, left aligned
  `[SOURCE]`, which the measurement agrees with.
- Minor tick marks 2 device px wide in the **bottom 7 device px** of the axis; `[SOURCE]`
  says "a short line in the bottom 3 px" (3.5 CSS px, so both are right).
- Major ticks run from **half the axis height** downward `[SOURCE]`, measured from
  device y 156 of a 58 px axis.
- Minor spacing measured 92.6 device px = 46.3 CSS px, i.e. the smallest power of ten at
  least 45 CSS px apart `[SOURCE]`, at the boundary of the rule. Majors at 0/10/20/30 ms
  with 1 ms minors: major = 10x minor, confirmed.

### Gridlines, and a measurement that contradicted intuition

Vertical, dropped from every minor tick through the whole stack, 1 CSS px wide, dashed
**3 CSS px on / 3 off**.

The gridline at a **major** tick is **dimmer** than at a minor one - `#262629` against
`#39393D`. Checked on all four majors of `01-idle-empty-session.png` (device x 210, 1136,
2062, 2990) against their neighbouring minors. Intuition said majors would be brighter.
The pixels said otherwise and the pixels win.

## 2. The annotation lane, and the thing that would have lost the A/B

`[MEASURED]` A row that displays annotations is exactly **40 device px (20 CSS px) taller**
than a plain row, in every screenshot that has one:

| screenshot | plain row | annotated row |
|---|---|---|
| `02-capture-in-progress` | 96 | 136 |
| `05-analyzer-annotations` | 96 | 136 |
| `04-zoomed-in-edges` | 98 | 138 |

20 CSS px is `[SOURCE]` the spec's "bubble rows are 16 px tall for low-level analyzers with
4 px top padding". Measured and source agree exactly. The bubble in `05` row 0 occupies
device y 196..227 = rowTop+8 to rowTop+40: 8 device px (4 CSS) of padding then 32 device
px (16 CSS) of bubble.

**The lane is inserted ABOVE the trace band and the band keeps its plain height.** This is
the part that is easy to get wrong, and `src/render`'s layout does the opposite - it
derives the band from the row height, so a taller row stretches the trace.

Idle-line offsets from the row top, measured on `05-analyzer-annotations.png` by scanning
each row band for the dense horizontal run:

| row | height | line offset | reading |
|---|---|---|---|
| D1 (plain) | 96 | +74 | band 92, gutter 16, line 2: low line = 92-16-2 |
| D6 (plain) | 96 | +74 | same |
| D2 (annotated) | 136 | **+56** | 40 + 16: the **high** line of a 92 px band pushed down by the lane |
| D0 (annotated) | 136 | **+114** | 40 + 74: the **low** line of the same |
| D4 (annotated) | 136 | **+114** | same |

If the band were stretched to the full 132 px the two lines would be 98 px apart. They are
58 apart, the same as in a plain row. So a lane is prepended and the band left alone.

Passing tall row heights straight to `WaveformRenderer` gives yHi at +16 and yLo at +114:
the low line lands right and the high line is 40 px too high. That would look plausible in
isolation and be wrong against the bar in exactly the rows a critic looks at hardest.

### How this is handled without editing src/render

The lane is given to the renderer as **its own row**, 20 CSS px tall, drawing the same
channel; the overlay then paints an opaque `#1B1B1C` rectangle over the whole lane before
drawing bubbles into it. Whatever the renderer drew there is hidden, separator included,
and the *real* channel row underneath is a plain base-height row - so its band, gutter and
both idle lines are what a plain row gets, by construction.

Verified on our own output: in `/tmp/logicweb-ui/05-annotations.png` the D0 lane occupies
device y 122..161 and the row's band runs 162..253, giving a 92 device px band identical
to every other row's.

Cost: one extra `store.query` per annotated channel per frame, ~30-60 us.

### Which forces a second canvas

`src/render`'s `MAX_ROWS` is **16** - a shader uniform array size the UI cannot raise - and
16 channels plus one annotation lane is 17 rows.

`WaveformStack` therefore owns **one `WaveformRenderer` per 16 rows**, on canvases stacked
vertically with no gap, all driven from one viewport. Two things make the seam exact:
every row height is a whole number of CSS px and each canvas's CSS height is the exact sum
of its rows', so `round((edge-offset)*dpr) + round(offset*dpr) === round(edge*dpr)`; and
the viewport is applied to renderer 0, read back after its own clamp, then pushed to the
rest.

Measured, with 17 rows across two canvases (`05-annotations.png`): row separators at
device y 254, 350, 446, ... 1694 in **both** the label column and the plot, pitch a uniform
96 device px across the canvas boundary, no discontinuity. The seam is not merely
approximately aligned; it is invisible.

**A live capture never splits.** Annotations are cleared when a capture starts, so during
streaming there are no lanes and the row count is the channel count, at most 16. That
matters because in follow-the-live-edge mode each renderer snapshots `store.length` for
itself, and two canvases a frame apart would put a horizontal step across the screen at the
live edge.

## 3. Gridlines are drawn with `mix-blend-mode: lighten`

The waveform canvas is opaque (`alpha: false`, cleared to the background), so gridlines
cannot be painted underneath it. Painting them on top at full opacity would let a gridline
cut a notch through a trace, which we do not do: `[MEASURED]` where a gridline
crosses a row separator the separator's `#57575F` survives, and over background the
gridline's `#39393D` survives. That is a per-channel maximum, so the grid gets its own
canvas with `mix-blend-mode: lighten` and the compositor reproduces the observed order
exactly rather than approximating it.

Confirmed on our own screenshots: gridlines read `#39393D` over background and `#262629`
at majors - the exact measured colours - and row separators read `#57575E` where the two
cross.

## 4. Layout ownership

```
index.html               app entry point (project root, as ARCHITECTURE assigns it)
src/ui/main.ts           bootstrap; a failure to construct paints the stack trace
src/ui/app.ts            state, wiring, the frame loop, the debug surface
src/ui/metrics.ts        every measured constant, each tagged MEASURED / SOURCE / CHOICE
src/ui/style.css         the chrome
src/ui/format.ts         time and frequency formats
src/ui/timeAxis.ts       tick selection and the axis canvas
src/ui/waveformStack.ts  the multi-canvas WaveformRenderer stack and the row model
src/ui/overlay.ts        grid, level markers, cursors, hover measurement, bubbles
src/ui/annotationLayout.ts  bubble text selection, multi-bubble merging, clamping
src/ui/channelList.ts    enable / rename / reorder / analyzer chips
src/ui/capturePanel.ts   device, samplerate, channels, threshold, mode, start/stop
src/ui/analyzerPanel.ts  attach a decoder to channels
src/ui/captureIO.ts      load .sr sessions, save/load .lwcap
src/ui/storeRef.ts       a SampleStore delegate whose inner store can be swapped
src/ui/state.ts          the session model
src/ui/tools/            the measuring tool and the browser driver
```

`storeRef.ts` exists because `WaveformRenderer` takes its store at construction and a new
capture means a new `PlanarSampleStore`; rebuilding the renderer per capture would leak a
WebGL context each time and Chromium caps a page at roughly 16.

## 5. What works end to end

The following was produced in headed Brave with the SLogic16 U3 attached. The browser
harness that drove it has been removed along with the capture files it loaded, so these
rows are a record, not something currently re-runnable.

| | result |
|---|---|
| **Zoom / pan / fit** | zoom ladder 5.038 s -> 1 ms -> 100 us, all shots crisp |
| **Cursors + measurement** | A/B cursors with chips, status shows A, B, \|B-A\| 27.00 us, 1/\|B-A\| 37.0 kHz; hover readout Duty / Freq / Width / width^-1 |
| **Channel enable** | 16 rows -> 14 after disabling D9 and D10, remaining rows auto-refit |
| **Channel rename** | D3 renamed to "SPI CS", persists through relayout |
| **Channel reorder** | drag D0 to position 5: order becomes 1,2,3,4,0,5,... |
| **Attach a decoder (file capture)** | `i2c` on D0/D1 -> **1,826 annotations, 33-38 ms decode**, one lane, 17 rows across 2 canvases |
| **Live capture from the device** | 16 ch @ 16 MSa/s, 0.30 s timer -> **4,800,000 samples in 460-470 ms**, live edge followed during streaming (2,303,998 samples at the mid-capture snapshot) |
| **Decode real captured signal** | `i2c` on D13/D15 -> **2,178-2,244 annotations, 22-44 ms**, bubble reads **`Address write: 50`** against a generator commanded `i2c 100k 0x50 00 ff` - a known-answer match |
| **Save and reload** | `.lwcap` round trip: 17,787 bytes, 4,356 edges, **every edge on every channel identical**, 0 problems |
| **Production build** | `npm run build` clean: 257 kB JS (65 kB gzip) + 186 kB worker + 6 kB CSS |
| **Page errors** | `report.json` `pageErrors: []` - no uncaught exception in any run |

The stimulus generator is left in a stated known state; the last thing the run does is
`stop` then `status`, and the reply is recorded:

```
[stim] status -> ok mode=stopped samples=0 txstall=no dma=idle proto=idle
```

### The WebUSB click

The permission prompt is a native chooser and cannot be clicked from JavaScript. The
driver uses CDP's `DeviceAccess` domain, which is what a human's click does, issued over
the debugger. **A human running the app by hand still clicks once**; the grant then
persists for that origin and profile.

Two failures on the way to that, both recorded because both produced a confident wrong
answer first:

1. `Runtime.evaluate` without `userGesture: true` makes `requestDevice` throw
   `SecurityError`. Obvious in hindsight, invisible in the failure message.
2. Waiting for `DeviceAccess.deviceRequestPrompted` **times out**: on this Brave build
   enabling the domain makes `requestDevice` resolve directly without emitting the event.
   The first version reported "no device" for a device that had in fact been granted. The
   driver now arms the prompt handler but polls the app's own state instead of waiting on
   an event that may never come.

A third, in the stimulus path: `fs.openSync(port, 'r+')` on a CDC device gives a
**blocking** fd, and a `readSync` with nothing pending never returns - the run wedged
silently after the first command. `O_NONBLOCK`, the way the generator's own
`tools/console.py` does it.

## 6. Open time, and why imports stay transitions

Open time used to grow with capture size, and that was architectural: imports were
expanded into a full `PlanarSampleStore` at O(samples), so a 120 s capture cost hundreds
of milliseconds of store building before anything could be drawn. Imports now stay
transitions end to end in `src/data/rleStore.ts`, which loads in O(edges) and is flat
with sample count. On the captures measured at the time this landed, open time went from
167 ms to ~11 ms at 5 s and from 528 ms to ~30 ms at 120 s.

Those figures were taken against capture files that are no longer in the repo, so they
are a record rather than a reproducible measurement. What remains testable is the
equivalence, and that is not asserted but tested: `src/data/selftest.ts` derives an RLE
store from a planar store and holds it to the same brute-force zoom ladder as the planar
store - edges byte-identical on all 16 channels, `query()` output byte-identical across
128 channel-views per capture.

A side effect worth keeping: query at the operating point is faster on imports - 0.8 ms
for a 3200-column 16-channel frame on a 120 s capture where the planar store measures
3.51 ms, and 2.1 ms on a synthetic dense worst case of 2M edges per channel. Measured in
node; the browser frame-loop numbers for the edge store are not separately benchmarked.

Two other honest gaps:

- **Cold decode.** `src/decode` is ~850 ms cold and 0.9-4.9 ms warm; a native tool is 119-682 ms
  every time. The shell calls `warmup()` on construction so the cold start is paid before
  a user asks for anything, but the first ~1 s after page load is slower than the bar.
- **No analog channels, no data table, no marker pairs, no trigger.** The trigger UI is
  not implemented: the SLogic16 U3 driver in `src/device` exposes no trigger, so a
  trigger panel would be a control that does nothing.

## 7. Limits surfaced in the UI rather than hit

- **2^31 samples**, which `src/data`'s `append` throws past, and which is **10.7 s at
  200 MSa/s**. The capture panel prints the ceiling in samples *and* as a duration for the
  selected rate ("Ceiling 2,147,483,648 samples = 134.2 s at 16 MS/s. A free run stops
  itself there."), and a free-running capture truncates its last chunk and stops itself
  instead of letting `append` throw mid-stream.
- **`EDGE_BUDGET` = 48,000,000 edges** across the channels a stack reads
  (`src/decode/limits.ts`; past ~80 M Pyodide corrupts rather than failing cleanly). The
  analyzer path counts edges with `edgeCount()` - which does not materialise them - before
  requesting a decode, and refuses with the count and a suggestion.
- **`MAX_SAMPLE` = 2^31 - 1** for decode spans, checked separately from the store limit
  because a decode can be asked for a sub-range.
## 9. What is stubbed, and what is not verified

- **Trigger configuration is not implemented.** See section 6.
- **`.sr` (sigrok) sessions load, logic-only.** `src/ui/srLoad.ts` reads the zip
  (stored + deflated members, v1 and v2 member naming) and builds an edge store from the
  per-probe transition lists, so `reference/hwcaptures/{i2c,spi,uart}.sr` open straight
  into the shell. Analog .sr data is refused with that reason; the format carries no
  gaps. Pinned by `src/ui/tools/sr-selftest.ts` (12/12: the three real files, .lwcap
  round trips, synthetic zips, corrupt inputs, and an independent 8N1 framer recovering
  the generator's "Hello" from uart.sr's D9).
- **Decoder stacking is not exposed.** The analyzer panel lists only sample-driven
  decoders (`inputs == ['logic']`); `eeprom24xx` on top of `i2c` works in `src/decode` and
  has no UI here. Stated in the panel rather than hidden.
- **Only `i2c` has been driven end to end through the UI.** `uart` and `spi` decode
  correctly in `src/decode`'s own suite against the same hardware, but the shell has not
  been screenshotted with them attached.
- **Analyzer bubble colours** are the three chosen in
  `05-analyzer-annotations.png` (`#D2B56F` I2C, `#F69998` Async Serial, `#ABA48B` SPI) then
  the spec's stated default `#95A0B4`, then two of ours. Which analyzer gets which colour is
  ours; there is no external rule being matched.
- **The multi-bubble merge threshold is ours.** `[SOURCE]` says frames merge "when frames
  are narrower than legibility allows" and that the badge saturates at `99+`; it does not
  give the width. We merge while a group's *average* width is below 14 CSS px. The
  saturation, the badge geometry, the viewport clamping and the 3 px overflow triangle are
  all `[SOURCE]` and implemented as specified - but a dense multi-bubble has not been
  screenshotted, because neither test capture produced one.
- **Physical wheel vs trackpad is a guess.** `[SOURCE]` gives the zoom exponent exactly
  (one notch is `sqrt(2)`, Shift is 10x finer) and that is implemented from
  `src/render`'s `wheelSpanFactor`; how to tell the two apart reliably is unsettled and a
  browser does not report it. We use "large, quantised `deltaY`, no `deltaX`".
- **Row auto-fit is inferred.** Row height is persisted per capture and varies
  across the five screenshots (48, 49, 53 CSS px), and in each one the stack fills the
  available height to within a few px. We derive the height the same way. That the *rule*
  is auto-fit rather than a stored value that happens to fit is an inference from five
  samples.
- **The hover measurement window is bounded and could miss.** `edges()` is a linear scan,
  so the pulse under the pointer is found by widening a window up to 8 times rather than
  scanning the capture. On a channel with one transition in 120 s the readout says
  "no transition in view" instead of searching 240 MB.
- **Nothing here has been reviewed by anyone but me.** The band
  table in section 1 is a property-by-property match produced by a tool that can fail; it
  is not the same thing as a critic looking at two pictures.

## 10. Tooling safety

`run-ui.mjs` creates a throwaway Brave profile in the OS temp directory and **does not
delete it**; the path is printed at the end of each run. Nothing in `src/ui` recursively
removes any directory, including ones it created itself.
