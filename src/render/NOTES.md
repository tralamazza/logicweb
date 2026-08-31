# src/render - WebGL2 waveform canvas

Owner: render builder. Consumes `SampleStore.query()` and nothing else, per
`docs/ARCHITECTURE.md`. Owns the canvas, the samples<->pixels transform,
`setViewport(startSample, endSample)` and `render()`.

Values below are tagged with an evidence class - `[MEASURED]` (read off rendered output
on this machine), `[CHOSEN]` (a design decision, reasoning stated inline), or
`[UNVERIFIED]`. Nothing here treats an unverified line as observed.

## Reproducing everything in this file

`src/render/selftest.ts` runs the checks in a browser (it needs a DOM and a real GPU).
Nothing in it writes outside `/tmp`.

---

## Design

### The one decision that matters

`[CHOSEN]` The store returns, per channel and per view, a run-length-encoded
array of **per-pixel-column classifications** - not samples. That is why its zoom-out is
O(screen width) instead of O(samples), and the spec names it as the thing to copy.

We get the same property for free because `src/data` already answers in pixel columns:
`SampleStore.query(channel, start, end, bins)` returns `bins` bytes, and the data builder
guarantees it is O(bins), not O(samples). So one frame is:

| step | cost |
|---|---|
| `planColumns` - float viewport to an integer query range plus an affine map | O(1) |
| `store.query` once per visible channel | O(columns) x 16 |
| one `texSubImage2D` of a `columns x rows` R8UI atlas | O(columns x rows) |
| one `drawArraysInstanced`, `rows` instances of a 2-triangle quad | O(pixels) |

There is no per-sample and no per-edge work anywhere in that list. A 100M-sample capture
costs the same as a 100k one at the same zoom - measured below.

`packed` from `ColumnView` is uploaded directly as an R8UI texture with no repacking:
bit0 = high, bit1 = low, bit2 = edge. The data builder laid that byte out for this
purpose.

**Edges are read from bit2 only.** Never from `low != high`. The contract says
`low != high` implies `edge` but not the converse: a column that is entirely 0 but was
preceded by a 1 reports `edge=1, low=0, high=0`. Rendering from `low != high` would drop
exactly those columns, which is the narrow-pulse-vanishes bug this component is judged
on. `grep -n 'BIT_LOW' src/render` returns the constant's definition and its re-export,
and no use.

### What is drawn, per pixel column

A direct transcription of `[SOURCE]` the spec below:

| classification | drawn |
|---|---|
| ALWAYS_HIGH (`!edge && high`) | a 1 CSS px line at the top of the trace band |
| ALWAYS_LOW (`!edge && !high`) | a 1 CSS px line at the bottom |
| ONE_OR_MORE_TRANSITIONS (`edge`) | a solid bar spanning the **full trace height** |
| NO_DATA (no captured samples under the column) | 4% alpha wash + a 2 px top border at 20% |

Plus a row separator, which is not in the spec at all and was found by measuring the
screenshots - see below.

Defaults are **measured off rendered output**,
not inferred: 49 CSS px row pitch, 2 CSS px `#57575E` separator, 8 CSS px gutter, 1 CSS px
idle lines, 1 device px transition bars, background `#1B1B1C`, the 8 legacy channel
colours cycled.

MISSING_DATA (data lost mid-capture, as distinct from never captured) is implemented as
of the gap contract: the store declares unknown spans via `noteGap`, `query()` sets bit3
of `packed` on columns overlapping one, and the shader draws the NO_DATA wash there
(bit3 wins over low/high/edge, and transition bars never extend into a gap column).
No live capture produces gaps. The device layer reports dropouts via `onDropout`, but the
UI cannot turn one into a `noteGap`: the lost samples are never appended, so the span has
zero width in store coordinates and the callback in `src/ui/app.ts` returns without
recording anything. The renderer half is real and is exercised by the data suite; the
capture half is not wired, and calling the path "end to end" was wrong.

### Crispness: coverage instead of half-pixel offsets

`[CHOSEN]` Crisp 1 px lines come from sizing the canvas `cssWidth * dpr`, calling
`ctx.scale(dpr, dpr)`, and drawing at `highY - 0.5` with height `1.0`. the spec warns that
missing the half-pixel discipline turns 1 px idle lines into "2 px grey smears on
Retina".

This renderer reaches the same result differently. All geometry is snapped to whole
device pixels on the CPU (`layout.ts`), and the fragment shader computes **analytic area
coverage** of the pixel by the stroke. With integral geometry the coverage comes out
exactly 0 or 1, so the output is bit-identical to a crisp non-antialiased draw - and when
the geometry is *not* integral (fractional dpr, a hand-set line width) it degrades to
correct area coverage instead of Canvas 2D's fractional-`fillRect` blur.

Row tops are `round(i * h)`, not `i * round(h)`, so 49 CSS px rows at dpr 1.5 come out
73/74/73/74 instead of accumulating a pixel of drift down a 16-row stack.

Verified, not asserted: `crisp-no-intermediate-values-dpr-{1,1.5,2}` scans every pixel of
a rendered frame and fails if any pixel is neither exactly the background, exactly a
channel colour, or exactly the separator colour. 0 smeared pixels at all three ratios.
And confirmed against rendered output: the pixels adjacent to the idle lines and to the
transition bars are pure background, i.e. genuinely no antialiasing. So are ours.

### The float viewport vs the integer store

The viewport is held in **floating point samples**. At maximum zoom one sample is ~100 px
wide and an integer-only viewport would make a drag jump in 100 px steps.

`SampleStore.query` takes an integer range that must lie inside the capture. Three things
push the two apart: fractional zoom, the view running past the end of the data (always
true during a live capture), and the view starting before sample 0.

The naive fix - clamp the range and ask for the same number of bins - silently rescales
the picture: the same data is stretched to fill the screen and every edge moves. So
instead `planColumns` keeps the query on the integer range the store can answer and
carries the mismatch as an exact affine map `screenX = column * scale + offset`, which
the shader inverts per fragment. When the view lies wholly inside the data and starts on
an integer sample, `scale == 1` and `offset == 0` and every screen pixel is exactly one
data column - the common case costs nothing, and `plan-identity` asserts it.

When a screen pixel does straddle two data columns, the shader **ORs** them. OR is the
safe direction: an edge can be reported one pixel wider than it should be, but it can
never disappear.

### Live capture

- `store.length` is snapshotted **once per frame**. Sampling it per channel would let
  channel 0 be drawn against a shorter capture than channel 15 and put a visible step in
  the live edge.
- `setFollowLatest(true)` re-pins the view to the newest sample every frame, keeping the
  span. `[SOURCE]` `RenderingManager.followViewMode === LatestData`.
- `[SOURCE]` "any pan or zoom calls `cancelFollowMode('latest')`". `setViewport`,
  `panPixels`, `zoomAt` and `zoomToFit` all clear follow mode. Tested by
  `pan-cancels-follow`.
- In follow mode the zoom-out clamp is disabled. A capture that is 3 ms old must not drag
  a 1 s window down to 3 ms; the un-captured part of the window renders as NO_DATA, which
  is the honest picture.

## Performance

**Settled, and no longer being worked on.** The user's requirement is 60 Hz. We measure
120.5 fps, pinned to a 120 Hz panel, so the
metric is tied with margin and further re-measurement buys nothing. What follows is the
record, including the parts that were wrong.

### Headline

Comfortably above the 60 Hz requirement, vsync-limited on this display.
Frame cost is dominated by `SampleStore.query`, not by this module: at a 1M-sample span a
frame is ~1.2 ms of which the renderer's own share is ~40 us.

### Corrections to previously published numbers

Three claims in the round-1 version of this file were wrong. They are corrected here
rather than re-measured, because the metric no longer matters.

1. **"0.0% dropped frames" was unsupported.** The detector fired only at >= 1.5 vsync
   intervals, so it could not see a frame that missed a single vsync - the entire
   interesting range. The criterion is now `render().totalMs > vsyncMs`, and the harness
   carries a control that injects a stall into 10% of frames and asserts the detector
   fires: at a 10 ms stall against an 8.30 ms interval the old criterion reported 0.00%
   and the new one reports 10.0% detected, max frame 13.0 ms.

   With the working detector, most phases are genuinely 0.00% over budget, but **the zoom
   sweep is not**: 1.67% of frames spend more CPU inside `render()` alone than the whole
   8.30 ms budget, max 10.4 ms. That is roughly one frame in 60 during a continuous zoom
   gesture arriving late. Reproduced at 1.67% on two consecutive runs.

2. **"3-6 microseconds per frame" was wrong by about 10x and wrong in kind.**
   `gl.finish()` was called once per 100 renders, so the GPU pipelined behind the CPU and
   the loop timed command submission rather than frames. With a per-frame finish the
   renderer's own cost is **~33-59 us** (0.033 ms and 0.059 ms at 10k and 1M spans across
   two runs), consistent with the critic's independent ~31 us.

   The old text also said the measurement included "all 4.6M fragments". It never did. A
   control that changes canvas area 16x - 4,608,000 fragments against 288,000 - moves the
   cost from 0.033 ms to 0.025 ms, a 24% change for a 16x change in fragment count. This
   is fixed per-frame overhead (uniform uploads, one `texSubImage2D`, one draw call), not
   fragment shading. The conclusion it supported - that frame cost is the store, not the
   renderer - is unaffected and still holds.

3. **The published `cpuMsMedian` was the slowest of five runs, not the best.**
   `runs.sort()` ranked by median frame interval, which vsync has pinned at 120.5 fps for
   every rep, so the comparator saw float noise and picked arbitrarily. On the round-1
   table the per-rep CPU medians were 5.70/4.40/4.40/4.80/4.50 and the figure published as
   "best of 5" was 5.70. The sort is now on CPU time. The stated rationale - contention is
   one-sided, so best-of-N is the honest estimator - was right; the sort key made it false.

   The same key decided whether a run counted at all. The contention gate compared the
   *fastest* recheck rep against the *fastest* phase-1 rep, which is the comparison least
   able to detect contention. It now compares the median of each rep set. On both runs
   since the fix that flips the verdict: run A read 15.1% drift on medians against 1.2%
   best-vs-best, run B 25.6% against 0.0%. **Both runs were flagged CONTENDED and their
   absolute millisecond figures are therefore not certified.** The fps figures, which are
   vsync-pinned and identical across every run, are unaffected.

### Numbers, flagged

From two consecutive runs, both flagged contended - quote as ranges, not as figures.
3200x1440 device px, 16 channels, 100M samples, 120.48 Hz display, 240 frames per phase,
best of 5 by CPU time.

| phase | fps | CPU median | CPU max | over budget |
|---|---|---|---|---|
| redraw-full-zoom-out | 120.5 | 4.25 - 4.30 ms | 7.3 - 7.6 ms | 0.00% |
| pan-1M-span | 120.5 | 2.30 ms | 2.8 - 2.9 ms | 0.00% |
| pan-full-zoom-out | 120.5 | 4.20 ms | 6.2 - 7.6 ms | 0.00% |
| zoom-sweep | 120.5 | 2.20 ms | 10.0 - 10.4 ms | **1.67%** |
| live-append 1 MSa/frame | 120.5 | 2.05 - 2.10 ms | 2.3 ms | 0.00% |

Frame split, interleaved batches with a per-frame `gl.finish()`:

| visible span | whole frame | `store.query` | this module |
|---|---|---|---|
| 100M samples | 4.48 - 4.84 ms | 3.42 - 3.61 ms | 1.06 - 1.23 ms (see below) |
| 1M samples | 1.21 - 1.22 ms | 1.15 - 1.18 ms | 0.043 - 0.059 ms |
| 10k samples | 0.91 - 0.92 ms | 0.88 ms | 0.033 - 0.041 ms |

The 100M row does **not** mean the renderer costs 1.2 ms there. The renderer's work is
span-independent - same atlas, same upload, same draw - so a figure that grows 25x with
span is not measuring it. What the subtraction picks up is cache interference: at a 100M
span the store's pyramid walk has its largest working set, and interleaving GL calls with
it costs more than running 100 queries back to back. Subtraction attributes that to the
renderer. The honest statement is ~40 us of renderer overhead plus an unseparated
interference term that grows with the store's working set.

`store.query` at 3200 columns and full zoom-out reads 3.42-3.61 ms here against the data
builder's independently measured 3.51 ms. Two agents, two paths, same number.

### Prediction and outcome

Stated before any measurement:

> **P1** sustained pan holds >= 58 fps median with < 2% dropped frames.
> **P2** median CPU inside `render()` < 6.0 ms, p95 < 9.0 ms, `store.query()` < 3.5 ms.
> **P3** uncapped (gl.finish, no vsync) < 8 ms/frame, i.e. >= 125 fps headroom.
> **P4** full-zoom-out redraw is the slowest phase but within 1.5x of the pan phase.

**P1 half-held.** 120.5 fps, yes - but the display is 120 Hz, not the 60 I assumed, so the
margin came partly from hardware I had not checked. And the "< 2% dropped" half was
*unfalsifiable as measured*, because the detector could not see single-vsync misses. With
a working detector the zoom sweep is 1.67% over budget, which happens to land inside the
prediction, but that is luck: the instrument that would have caught a miss did not exist.

**P2 half-falsified.** Total CPU held. `store.query` did not: I predicted < 3.5 ms and it
is 3.42-3.61 ms straddling the line, having scaled the data builder's 1000-column figure
linearly to 3200 columns. Linear was the wrong model - different column counts land on
different pyramid levels.

**P3 held.** 3.70-3.80 ms/frame uncapped, 263-270 fps.

**P4 unresolved, and the original figure was an artifact.** I reported full zoom-out at
4.2x the pan phase. That compared a *static* 100M-sample redraw against a *panning*
1M-sample view - two variables, not one - so it never measured zoom level. A span sweep
with pan rate and column count held fixed gives:

| span | 3200 columns | 1000 columns |
|---|---|---|
| 1e4 | 2.30 ms | 1.30 ms |
| 1e5 | 2.20 ms | 1.20 ms |
| 1e6 | 2.60 ms | 1.30 ms |
| 1e7 | 3.10 ms | 1.90 ms |
| 1e8 | 4.50 ms | **1.50 ms** |

So 1.7x rather than 4.2x at 3200 columns, and at 1000 columns the curve is **not
monotonic** - a 1e7 span costs more than a full 1e8 zoom-out. The sample store reported
1.2x at 3200 columns and 0.7x at 1000, i.e. it also found full zoom-out not to be the
worst case at 1000 columns. We now agree on the shape and disagree on the exact ratio,
within a run-to-run spread neither of us can currently close on a loaded machine.

**Left unresolved deliberately.** It only mattered for deciding where to optimise, and
with the metric settled at 2x the requirement there is nothing to optimise. Do not read
the round-1 "4.2x" anywhere; it is withdrawn.

### Method

Real Brave, headed, real GPU - headless falls back to SwiftShader and would measure a
software rasteriser. `document.visibilityState` is asserted visible before anything is
timed, and Brave is launched with backgrounding, occlusion and timer throttling disabled.
`performance.now()` is clamped to 100 us in Brave, which is why the renderer/store split
is measured as a batch difference rather than per frame.

## Correctness

51 checks, all passing: `node src/render/tools/run-browser.mjs selftest`.

### The headline test

`glitch-100M-1000px-dpr-{1,2,3}` - the failure mode named in the brief. A single
**one-sample** low pulse in an otherwise idle-high channel, 100,000,000 samples across
**1000 pixel columns**, so one column is 100,000 samples and the pulse is 0.001% of it.

Result at all three device pixel ratios: **exactly one lit column, at column 612, which
is exactly `floor(61234567 / 100000000 * 1000)`.** Asserted by scanning the rendered
frame at mid-trace height, where only a full-height transition bar can reach - an idle
line never does. The companion check `glitch-idle-line-still-high` confirms the rest of
the row is still an idle *high* line and not a low one.

### GPU against an independent CPU rasteriser

`cpuRaster.ts` renders the same picture on the CPU and the two are compared pixel by
pixel. It deliberately does **not** reuse `planColumns` or the atlas: it asks the store
for one column at a time with `bins = 1`, so a bug in the plan, the texture layout, the
instanced row indexing or the shader's column arithmetic shows as a pixel difference
instead of cancelling out.

**0 differing pixels** at four zoom levels: whole capture, 1 sample/px, 10 samples/px,
and zoomed in past 1 sample per pixel.

What that does *not* control for: both paths were written by the same author from the
same reading of one spec, so they would share any misreading of it. It
controls implementation, not interpretation.

### Other checks

- `[SOURCE]` one physical wheel notch is exactly `sqrt(2)`; Shift gives `2^0.05`;
  trackpad is continuous. All asserted numerically.
- `[SOURCE]` zoom-in clamps at 20 samples on screen.
- Zoom holds the sample under the pointer fixed to 1e-9.
- `[SOURCE]` wheel gesture intent locks to zoom-or-pan after 5 events in a 200 ms window.
- Row geometry is integral, gapless and drift-free at dpr 1, 1.25, 1.5, 2 and 3.
- NO_DATA is distinct from the background, from an idle line, and has its 2 px top
  border.
- 61 frames rendered while data was appended, with follow mode tracking the live edge to
  within one sample every frame.

---

## Unverified, and where I could be wrong

Ranked by how much a critic could get out of it. Four items that were on this list are
gone, having been measured against the screenshots - see the verification section above.

1. **Only two of the seven screenshots were available when this was written**
   (`03-zoomed-out-long-capture`, `04-zoomed-in-edges`; the annotation and live-capture
   shots landed later or are still landing). Everything verified above comes from those
   two. In particular I have **not** checked our live-capture appearance against
   `02-capture-in-progress.png`, and I have not checked anything about how our rows sit
   next to analyzer annotation bubbles.
2. **The NO_DATA colour is still a guess.** the spec gives the alphas (4% wash, 20% border)
   and the 2 px height `[SOURCE]` but never names the "lost data colour"; I used neutral
   grey `#909091`. At 4% over `#1B1B1C` the wash is a 5/255 difference - faithful to the
   stated alpha, but it means any comparison is decided by a colour I do not have. None
   of the available screenshots contain a NO_DATA region, so this is untested against the
   bar. It is the weakest appearance claim in the module.
3. **Row heights must be supplied by the UI, and a mismatch is invisible until it is
   fatal.** Supported per-row now, but the *values* still have to come from the capture's
   `meta.json`, which this module does not read. The defaults (49 CSS px uniform) match
   `04-zoomed-in-edges` only for its plain rows; `03` uses 106 device px, and any row with
   an analyzer chip is 138. If the UI does not pass real heights, every row below the
   first analyzer row is offset and the waveform itself will look correct while the
   comparison fails.
4. **Zoom-out limit and pan-past-end limit are invented.** `[SOURCE]` gives the zoom-*in*
   clamp exactly (20 samples). It says nothing about the other end. I allow zooming out
   until only half the screen has data.
5. **Wheel direction is unverified.** The magnitude is `[SOURCE]` and exact; whether
   scroll-down zooms in or out is not in the spec. `wheelSpanFactor(..., invert)` flips it.
6. **Performance is closed, not proven in detail.** The requirement is 60 Hz, we and
   sits at 120.5 on this panel, so the metric is settled with margin and
   was dropped by decision. What remains unproven: every timing run since the contention
   gate was fixed has been flagged CONTENDED (15.1% and 25.6% drift on rep medians), so
   the absolute millisecond figures are indicative only. The zoom sweep's 1.67%
   over-budget frames are real and reproduced twice, and nobody has looked at whether
   they are visible. The zoom-versus-pan disagreement with the sample store is recorded
   as unresolved.
8. **MISSING_DATA renders from bit3 of the packed column byte.** The store declares gaps
   via `noteGap`; the renderer just draws what it is told. `cpuRaster` mirrors the
   shader's wash and top border.
9. **Very high zoom-out saturates, and that is inherent to the current contract.**
   Density shading - showing that a column holds 3 transitions differently from 3000 -
   needs a transition count in `ColumnView`, which `low`/`high`/`edge` cannot provide.
   That is a data-layer contract change and is the lead's call, not mine. We now know
   the only available behaviour here (saturate to solid, lit fraction 1.0000) and we match
   it. We do not beat it, and with this contract we cannot.
10. **The CPU control rasteriser shares my interpretation.** `cpuRaster.ts` catches
    implementation bugs, not misreadings of the bar - both were written by the same
    author from the same reading. The screenshot measurements above are the independent
    check, and they only cover the properties the tool measures.

## A note on tooling safety

`run-browser.mjs` creates a throwaway Brave profile in the OS temp directory and
deliberately **does not delete it**. Nothing in `src/render` recursively removes any
directory, including ones it created itself. The profile path is printed at the end of
each run if you want to remove it by hand.
