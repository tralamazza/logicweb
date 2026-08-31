# src/data - design, measurements, and where the numbers and predictions missed

**Every number in this file comes from one run, in one environment**, kept at
`/tmp/logicweb-bench/20260827-144252/` (`result.json` raw, `bench.log` transcript).
Environment: Brave 151 (Chromium), headed, cross-origin isolated so
`performance.measureUserAgentSpecificMemory()` is genuinely available. 100,000,000 samples
x 16 channels throughout.

Re-run:

```
src/data/bench/run-browser.sh          # new timestamped dir each run, deletes nothing
node_modules/.bin/esbuild src/data/bench/runtests.ts --bundle --format=esm \
  --platform=node --outfile=/tmp/t.mjs && node /tmp/t.mjs --glitch-100m
```

---

## 0. What moved since the previous version of this file, and why

The previous head-to-head table was assembled from **two different environments**: planar
measured in node, interleaved measured in the browser. Node is roughly twice as fast at
this workload, so every ratio was inflated by about that factor. The giveaway was an
interleaved append cell of "208 MSa/s" sitting in the same row as a planar figure that run
had never produced. Corrected, in one environment, one run, A/B alternated:

| claim | published before | measured now | |
|---|---|---|---|
| query advantage, full zoom-out | 2.7x | **1.93x** | overstated 1.4x |
| query advantage, 1M across | 4.2x | **2.86x** | overstated 1.5x |
| `edges()` advantage, idle channel | 69x | **34.1x** | overstated 2.0x |
| `edges()` advantage, sparse channel | 36x | **17.1x** | overstated 2.1x |
| `edges()` advantage, dense channel | 6.9x | **4.3x** | overstated 1.6x |
| where interleaved wins (1000 across) | "1.2x" | **1.85x** | understated - I made my loss look smaller |
| planar full-zoom frame, 1000 cols | 0.82 ms | 0.866 ms | ~same |
| planar append | 362 MSa/s | 379 MSa/s | ~same |

Two figures were flatly wrong rather than merely inflated:

- **P6 was recorded HELD when the browser run had missed it.** The browser measured
  append at 2696 ms / 37 MSa/s; the 276 ms / 362 MSa/s I published was the node run. It is
  logged as a miss in section 3, and the current 379 MSa/s comes from a build that is now
  A/B alternated against interleaved so the comparison is fair.
- **My stated reason for the P4 miss was false.** I wrote that `pickLevel` selects the same
  level for both viewports being compared. It does not: at 1000 columns, 100,000 samples
  across is 100 samples/column and selects **level 0**, while 100,000,000 across is 100,000
  samples/column and selects **level 2**. The conclusion survives on better evidence
  (section 3); the supporting detail was checkable and wrong.

The bench has been rebuilt so it cannot produce a cross-environment table again: both
stores are built together, held resident together, and every comparison alternates
A/B/A/B inside one timing round.

---

## 1. The layout decision: bit-packed channel planes, not device order

`append` transposes device-order samples into **one bit-plane per channel**. The
alternative - device order, 2 bytes per sample, same pyramid over it - is implemented in
full in `interleavedStore.ts`, and **both stores' tuning constants are swept over the same
range**; quoting a swept constant against a hardcoded one is a handicap, not a comparison.

### Memory is a tie, exactly

| | base | pyramid | total | overhead |
|---|---|---|---|---|
| planar | 201.3 MB | 26.9 MB | 228.2 MB | 13.4% |
| interleaved | 201.3 MB | 26.8 MB | 228.2 MB | 13.3% |

16 channels at 1 bit each is 2 bytes per sample either way. This was never a memory
decision.

### Speed, one run, both resident, A/B interleaved

16-channel frame at **1000 columns**, best of 5 alternated repeats:

| samples across | level | planar | interleaved | |
|---|---|---|---|---|
| 100,000,000 | 2 | **0.866 ms** | 1.673 ms | planar 1.93x |
| 10,000,000 | 2 | **1.204 ms** | 1.434 ms | planar 1.19x |
| 1,000,000 | 1 | **0.530 ms** | 1.518 ms | planar 2.86x |
| 100,000 | 0 | **0.263 ms** | 0.968 ms | planar 3.68x |
| 10,000 | 0 | 0.237 ms | **0.230 ms** | interleaved 1.03x |
| 1,000 | 0 | 0.215 ms | **0.116 ms** | interleaved 1.85x |
| 300 | 0 | 0.226 ms | **0.116 ms** | interleaved 1.95x |
| 100 | 0 | 0.230 ms | **0.116 ms** | interleaved 1.98x |

Each store at its own best `coreBins` (planar 256, interleaved 2): full zoom-out planar
0.914 ms vs interleaved 1.667 ms, **planar 1.82x**; 1M across, planar 0.466 vs 0.858,
**planar 1.84x**.

`edges()` over the whole capture:

| channel | edges | planar | interleaved | |
|---|---|---|---|---|
| ch14 never toggles | 0 | **2.3 ms** | 79.7 ms | planar 34.1x |
| ch12 sparse glitches | 50 | **4.7 ms** | 79.9 ms | planar 17.1x |
| ch8 SPI chip select | 452 | **4.7 ms** | 80.7 ms | planar 17.2x |
| ch0 period-4 clock | 50,000,000 | **41.4 ms** | 179.5 ms | planar 4.3x |

`append`, built alternately over 3 rounds, best round kept:

| | append+pyramid | average | best chunk |
|---|---|---|---|
| planar | 264 ms | 379 MSa/s | 443 MSa/s |
| interleaved | 71 ms | 1413 MSa/s | 1691 MSa/s |

**Interleaved wins append by 3.7x** (memcpy vs transpose) and wins below ~10,000 samples
across by up to **1.98x**, where the pyramid is unused and a query is "read the sample
under this pixel": one `uint16` load beats masking a bit out of a plane through a block
index. Both losses are real and neither is close to decisive - the deep-zoom loss is
0.11 ms per frame, and 379 MSa/s of transpose is 724 MB/s, far above what the SLogic16 U3
streams.

Planar is chosen because it wins the two things that decide whether the application works:
the zoomed-out query, which the render loop does every frame on a large capture, and
`edges()` on quiet channels, which every protocol decoder does across a whole capture.

### coreBins, swept for both stores over the same range

Full-zoom 16-channel frame, 1000 columns:

| coreBins | 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 |
|---|---|---|---|---|---|---|---|---|---|
| planar | 1.391 | 1.239 | 1.196 | 1.215 | 1.225 | **0.912** | 0.926 | 0.960 | 0.918 |
| interleaved | 1.709 | **1.627** | 1.628 | 1.632 | 1.641 | 7.015 | 7.037 | 7.473 | 7.010 |

The structural point, which is more honest than quoting an untuned constant: **interleaved
falls off a cliff above 16 and planar does not.** Raising `coreBins` selects a shallower
level, so each column's aligned core spans more bins. Planar reads that core as whole words
- more bins is a longer sequential scan, nearly free. Interleaved's `levelState` is a
scalar loop over one bin at a time, so the same change multiplies its work ~4x. Interleaved
is quoted at 2, its own optimum, everywhere above.

Planar's 32-256 range is flat within noise; the sweep picked 256 this run and 64 last run.
32 stays the default as the smallest value on the plateau, hence the least column-boundary
error.

### The transpose

32 samples into one word of each of 16 planes. Four samples' low bytes pack into
`L = b0 | b1<<8 | b2<<16 | b3<<24`, then for channel `c`:

```js
nibble = Math.imul((L >>> c) & 0x01010101, 0x10204080) >>> 28;
```

Multiplier bits at 7/14/21/28 put the four wanted bits on 28..31 with every cross term on a
distinct lower bit, so no carry can corrupt it. Measured, all three producing identical
output: channel-major bit-at-a-time 140 MSa/s, sample-major with 16 accumulators
345 MSa/s, **imul gather 583 MSa/s**.

### Storage growth

Fixed `Uint32Array` blocks of 2^24 samples. Not a doubling array (holds old and new at
once, 3x spike at 200 MB), and not a resizable `ArrayBuffer`, which also never copies but
reads slower - measured, sequential scan of 64 MB: normal `ArrayBuffer` 9.3 GB/s, resizable
fixed-length view 1.5 GB/s, resizable tracking view 4.0 GB/s, **chunked blocks 11.1 GB/s**.
V8 routes every access to a resizable-buffer-backed array through a dynamic bounds check,
and that scan speed *is* the cost of `edges()`.

### The pyramid

Level *k* summarises 16^*k* samples into two bits - "contains a 1", "contains a 0" - as two
more bit-planes. Two bits, not one, because the pair carries low, high *and* mixed, and
reduction is then a plain OR at every level, word-parallel. Cost 2/15 bits per sample per
channel = 13.3%.

Top level is 6. It was 7, which was dead code: `pickLevel` reaches level *k* only when
16^*k* * coreBins <= samplesPerBin, so level 7 at coreBins 32 needs 2^33 samples in one
column, four times the 2^31 ceiling `append` enforces. Built on every capture, never read.

Bins publish only once complete, so `append` never recomputes and a live capture descends
past the incomplete tail. Column boundaries are **exact** - the descent covers the partial
bins at each end rather than rounding outward. `snapColumns` (snap to whole bins) is
measured at 0.666 vs 0.925 ms/frame, 28% cheaper, and is **off by default**: the exact path
is fast enough that buying speed with correctness is not a trade worth making.

---

## 2. The operating point: column count, not zoom, is the lever

The render builder measured 4.1 ms/frame of query cost at ~3200 columns and predicted it by
scaling my 1000-column figure linearly. That extrapolation is not valid, and the reason is
worth stating: **a different column count lands on a different pyramid level**, because
`pickLevel` keys off samples-per-column. 1000-column numbers cannot be scaled to the
operating point; they have to be measured there.

16-channel frame at **3200 columns**, same run:

| samples across | planar | interleaved | |
|---|---|---|---|
| 100,000,000 | **3.508 ms** | 10.196 ms | planar 2.91x |
| 10,000,000 | **2.816 ms** | 3.923 ms | planar 1.39x |
| 1,000,000 | **0.970 ms** | 2.568 ms | planar 2.65x |
| 100,000 | **0.722 ms** | 1.394 ms | planar 1.93x |
| 10,000 | 0.752 ms | **0.444 ms** | interleaved 1.69x |
| 1,000 | 0.707 ms | **0.408 ms** | interleaved 1.73x |
| 300 | 0.710 ms | **0.391 ms** | interleaved 1.82x |
| 100 | 0.670 ms | **0.392 ms** | interleaved 1.71x |

Column-count sweep - cost per column per channel is the shape that shows O(bins):

| columns | 500 | 1000 | 1920 | 3200 | 6400 |
|---|---|---|---|---|---|
| frame, 100M across | 0.546 ms | 0.950 | 2.423 | 3.841 | 12.231 |
| us/column/channel | 0.068 | 0.059 | 0.079 | 0.075 | 0.119 |
| frame, 10M across | 0.555 ms | 1.234 | 2.075 | 2.928 | 4.327 |
| us/column/channel | 0.069 | 0.077 | 0.068 | 0.057 | 0.042 |

Per-column cost is flat from 500 to 3200 columns - the O(bins) claim holding - and degrades
at 6400 at full zoom-out (0.119 us/column, a 3.2x frame jump from 3200) where the working
set stops fitting.

**The headline is a range, not a number: 0.87 ms per 16-channel frame at 1000 columns,
3.51 ms at 3200 columns, both at full zoom-out on 100M samples.** At 3200 columns the data
layer alone is ~21% of a 16.6 ms budget. That is the figure the renderer should build its
budget from, and it is consistent with the 4.1 ms it measured.

**On "full zoom-out costs 4.2x the pan phase": I do not reproduce that.** Measured here,
full zoom-out against the worst frame while panning:

| columns | full zoom-out | worst while panning | ratio |
|---|---|---|---|
| 1000 | 0.866 ms | 1.204 ms at 10M across | **0.7x** - panning is *worse* |
| 3200 | 3.508 ms | 2.816 ms at 10M across | **1.2x** |

Full zoom-out is not uniformly the worst case, because which level gets selected changes
with the viewport. The gap between 1.2x and the renderer's 4.2x is unresolved - it may be a
different pan width, or render work folded into the figure. Whoever owns that number should
compare against this table rather than against a single figure from me.

---

## 3. The predictions, and where they missed

Written into `bench.ts` as `PREDICTIONS` **before the bench was first run**, judged
mechanically at 1000 columns, the operating point they were written against.

| | claim | measured | |
|---|---|---|---|
| P1 | full zoom-out median channel < 100 us | 64.5 us | held |
| P2 | full zoom-out worst channel < 400 us | 71.4 us | held |
| P3 | full zoom-out 16-ch frame < 1.5 ms | 0.866 ms | held at 1000 cols, **3.51 ms at 3200** |
| P4 | 1000x the samples across costs < 3x the time | **3.28x** | **MISSED** |
| P5 | pyramid overhead < 15% of base | 13.4% | held |
| P6 | append >= 100 MSa/s including the pyramid | 379 MSa/s | held now, **missed at 37 MSa/s** in an earlier browser run I misreported as held |
| P7 | tab < 600 MB with the capture resident | 238 MB | held |

**P4 missed, reproducibly**: 3.10x, 3.24x, 3.26x, 3.28x, 3.75x, 3.99x across every run
taken, never once under 3. I set the threshold and measured past it.

The conclusion that this is not an O(bins) failure stands, but on evidence I did not have
before: the column-count sweep in section 2 shows cost per column flat from 500 to 3200
columns at both viewports, which is what O(bins) means - linear in samples would be 1000x,
not 3.28x. The extra 3.28x is the memory hierarchy plus two extra levels of descent: at 100
samples per column the base reads sit in one cache line, at 100,000 they are 12.5 KB apart
in the plane and each is a separate trip to memory. My earlier explanation - that
`pickLevel` chose the same level for both - was simply false (level 0 vs level 2).

**P3 holds at the column count it was written for and fails at the one the application
uses.** 3.51 ms at 3200 columns is over the 1.5 ms bar. The bar was mine and the operating
point was not; I am recording it as a caveat on P3 rather than quietly rescoping it.

---

## 4. Correctness

`runtests.ts --glitch-100m`: **42/42 pass**. Controls:

- Every `query` compared against a **brute-force scan of the same samples** - 2500
  (channel, viewport, bins) combinations per chunking mode, widths from the whole capture
  down to one sample, offsets landing mid-word and mid-block. The reference loops over
  samples and shares no code with the pyramid.
- **Both layouts checked against the same reference and each other**, so a bug in the
  shared descent logic would have to appear identically in two layouts.
- Append verified bit-for-bit with aligned and **prime-sized chunks (4099, 7919)**, which
  exercises the unaligned head/tail paths; 4- and 8-channel modes; queries **during a live
  capture** at lengths that are not a multiple of any bin size.
- **Pyramid levels 4, 5 and 6 forced with real content** - 24M samples, `coreBins` swept
  1/2/8/32 so the same range is answered from several different levels, 112 queries against
  brute force. This closed a real hole: the suite topped out at 400,000 samples, so the top
  levels could have been built as garbage and still reported all-green. The level is an
  implementation choice, not part of the answer, so making several levels answer the same
  question localises a broken one immediately.
- **11 bad-argument cases must throw.**

### The narrow-glitch case

A one-sample pulse in an otherwise idle channel at 100,000 samples per column, at full
scale on a real 100M-sample 16-channel store, at five pulse positions chosen for awkward
alignment (sample 0, a pyramid bin boundary, the sample before one, an odd mid-bin
position, the last sample), each at 1000, 1920, 997 and 1 columns and through an offset
viewport.

**All 1000 columns are asserted, not just the interesting one** - a store returning
`hasEdge = 1` unconditionally would pass a test that only checked the pulse's column.
Exactly one column reports `edge=1, high=1, low=0`, the other 999 all zeros, and `edges()`
returns exactly `[pulse, pulse+1]`. Confirmed again on generated content: the narrowest
pulse the generator actually emitted on ch12 is 1 sample at 14,741,709, and it still shows
at 100M across 1000 columns.

Two deliberate details. `hasEdge` covers `[colStart - 1, colEnd)`, folding in the sample
before the column, so a transition landing exactly on a boundary belongs to the column it
enters instead of falling into the gap between two columns. And boundaries are exact rather
than rounded outward, so an edge is never smeared into a neighbour.

### Bugs these tests found

- `maskTo(31)` written `(1 << 31) - 1`, which JS evaluates as -2147483649 (a double). It
  masks correctly but compares unequal to the int32 result of `word & mask`, so any range
  ending 31 bits into a word reported "contains a zero" when it did not - a phantom edge,
  drawn confidently, on a channel that never moved.
- `query(0, NaN, 5000, 100)` returned 100 columns with `low=1, high=0` - a minimum above a
  maximum, which this module's own type contract says is impossible - and `packed=2`
  throughout, which a renderer paints as a clean flat idle trace on all 16 channels. The
  guard was `if (s >= e)`, which is *false* for NaN. Non-finite bounds now throw in `query`
  and `edges` in both stores, with 11 regression cases. This violated this module's own
  "fail loudly and early" rule and was survivable only because the renderer happened to
  reject non-finite spans upstream; `src/ui` and `src/decode` call in directly.

### Contract landmines now documented in `types.ts`

- **The returned arrays are borrowed, not owned.** One set of scratch buffers is reused for
  every query of a given `bins`, so two successive `query()` results alias the same
  `packed` buffer. Deliberate - a 16-channel frame at 60 fps would otherwise churn
  megabytes of garbage - but `readonly Uint8Array` reads as an owned buffer and is not one.
- **An over-wide range is clamped silently**, reported only through `view.startSample` /
  `view.endSample`. Asking for 2e8 on a 100M store returns columns twice as wide as
  intended. Callers converting pixels to time must read the view back.
- The interval notation was off by one against the implementation: `edge[i]` flags
  transitions at `[colStart, colEnd)`; the *sample span* folded in is
  `[colStart - 1, colEnd)`. The prose was right, the interval was not. Fixed.

---

## 5. Measurement method, and two instruments that were wrong

Timings are the **best of 5 alternated repeats**. This machine runs other work; one early
run recorded a single "query" at 48 ms - a scheduler stall inside the loop, not a query
cost. Contention only adds time, so the minimum is both the closest estimate and the only
one that reproduces.

**The stability check was measuring the wrong thing.** It re-measured its own first row at
the end of the same phase. That catches drift *within* a phase and certifies a uniformly
slow machine as perfectly stable - which is exactly what it did, returning ratio 1.02 on a
run whose planar numbers were 1.6x worse than the run being quoted. Replaced by a **fixed
reference workload** (4 MiB integer scan, unrelated to src/data) sampled at every phase
boundary, with a split verdict: phase-2 spread gates the A/B numbers, whole-run spread
gates any cross-phase comparison. This run: phase-2 spread **1.05x**, so every head-to-head
number above is valid.

**The reference workload was itself wrong on its first attempt** - 17.8 ms at the start of a
run and 1.3 ms at the end, a 13x "drift" that was partly the function being promoted out of
the interpreter. It is now warmed before its first reading is used. A residual gap remains:
it reads ~18 ms during phase 1 and ~1.3 ms during phase 2, while `append` in phase 1
measures 379 MSa/s, consistent with node's 354 - so phase 1 is plainly *not* 14x slow and
the reference is responding to something specific to itself, most likely GC from building
and dropping 228 MB stores repeatedly. **I have not isolated it.** It is handled rather than
hidden: phase-1 numbers are only compared with phase-1 numbers, the two builds are
alternated so that comparison is internally fair (bracketing marks differ by 1.06x), and no
phase-1 figure is divided by a phase-2 figure anywhere in this document.

The bench writes each run into its own timestamped directory and **deletes nothing** - not
the output directory, not the browser profile. It used to open with `rm -rf` on its output
directory, which is why the old table could not be audited: each run destroyed the evidence
for the last one.

---

## 6. What I could not verify

- **No real device data.** Everything is the synthetic generator. The contract for incoming
  bytes is fixed in ARCHITECTURE.md, but no chunk from a real SLogic16 U3 has been through
  this code.
- **The renderer's 4.2x full-zoom-vs-pan ratio.** I measure 1.2x at 3200 columns and 0.7x
  at 1000. Unresolved; see section 2.
- **The 6400-column cliff.** 3.841 ms at 3200 columns to 12.231 ms at 6400 at full
  zoom-out, a 3.2x jump for 2x the columns. Recorded, not chased. Above realistic window
  widths, but a real discontinuity.
- **The phase-1/phase-2 reference gap.** Not isolated; see section 5.
- **Absolute frame numbers are measured with both stores resident** (471 MB), so they carry
  more cache pressure than the shipping configuration will. Conservative, but not the
  number a single-store app would see.
- **No renderer in the loop.** These are data-layer costs only; I have deliberately not
  claimed an fps figure for the application.
- **Above 2^31 samples the design stops.** `edges()` returns `Int32Array`; `append` throws
  past 2^31 rather than wrapping. Not tested near the boundary.
- **`edges()` on a dense channel over a whole capture is a 200 MB answer** (50M positions
  from a period-4 clock). Inherent to "exact transition positions"; `edgeCount()` lets
  callers check first, and the two-pass implementation allocates exactly once instead of
  doubling, which had driven peak RSS to 770 MB. Nothing forces callers to window.
- **`snapColumns` is measured but not tested to the depth of the exact path.** Off by
  default; test it before turning it on.

---

## 7. RleSampleStore - the import store

Added to fix the time-to-interactive loss, which section 0's store choice could not: the
import path expanded transition lists into a full planar store at O(samples), so the
120 s capture took 3.2 s to build. Imports now stay
transitions end to end.

**Layout.** Per channel: the ascending edge positions (4 bytes per edge) plus a segment
index (`segIdx[s]` = index of the first edge at or past sample `s * 2^14`), which is the
RLE analog of the planar pyramid. `length` is virtual and free. `append` throws - the
store is immutable.

**Query.** A column [c0, c1) needs the edge count in it and the parity of edges below c0:
two binary searches, each bracketed by the two 16k-sample segment windows, so cost is
O(log edges-per-segment) per column, not O(edges in span). Segments without edges answer
in O(1). Measured in node: 0.80 ms for a 3200-column 16-channel frame on the 120 s
reference import, 2.08 ms on a synthetic 2M-edges-per-channel dense capture. The dense
worst case still fits the 60 Hz budget 8x over. What it cannot beat is planar on a
capture that toggles nearly every sample; imports that dense are also past the 48M decode
edge budget, so they are refused upstream anyway.

**The "faster than planar" claim, stated honestly.** This paragraph originally set the
0.80 ms against planar's 3.51 ms and concluded 4.4x. Those two numbers are from
*different captures* - 3.51 ms is the 100M-sample generated capture, and planar cannot
hold `bin120` at 10 MSa/s at all (1.2e9 samples is roughly 2.4 GB of bit planes), so the
pairing was the same cross-workload division this repo already called out once for the
head-to-head table. The same-capture control, both stores on `reference/data/bin` at
3200 columns x 16 channels: planar **1.84 ms**, RLE **0.63 ms**, i.e. **2.9x**. The
conclusion survives; the ratio was inflated. The 2.08 ms dense figure also did not
reproduce on an independently constructed dense capture (3.11 ms at 2M edges/channel,
edge every 4 samples) - different construction, so not a refutation, but no construction
was recorded next to the original number and it should have been.

**Quantisation is the old expansion's rule, proven identical.** `fromTransitions` converts
a time t to `ceil(t * sr)` (the first sample at or after t), same-sample toggles cancel
pairwise, a transition at sample 0 flips `initial` but produces no edge, and transitions
at or past `length` are dropped - exactly what the sample-stream expansion produced. Proven, not
assumed: A/B on `reference/data/bin` and `bin120`, edges byte-identical on all 16 channels
and `query()` packed bytes identical across 128 channel-views per capture. The suite pins
the rule against an independent stream simulation, and the equivalence harness holds the
store to the same brute-force zoom ladder as the planar store (mutation-checked: reverting
the boundary-edge classification, dropping the collapse parity, dropping the gap bit and
ignoring gaps in `edges()` each turn the suite red).

**Gaps.** `noteGap` spans mark unknown data; `query()` sets bit3 on intersecting columns
and `edges()` filters transitions inside gaps. A gap's *interior* levels are a frozen best
effort - its interior edges are unknown by definition - which is why the contract says
bit3 columns' other bits are unspecified. Its *end* level is not unknown, and is preserved
across a round trip; see the parity fixup below. `.lwcap` v2 persists the spans (magic
`LWCAP2`, `gapCount` in the old reserved slot, u32 pairs after the name blob); v1 files
load as gapless, and the round trip is pinned by `src/ui/tools/lwcap-selftest.ts`.

**Parity across a gap** (`channelAcrossGaps` in `gaps.ts`) - this was a real corruption
bug, recorded here as an open hole for two rounds before it was fixed:

- `saveLwcap` and `RleSampleStore.fromStore` both rebuild a channel from `edges()`, which
  is gap-filtered, and the RLE store derives levels as `initial ^ parity(edges below)`.
  Drop an odd count and everything from the gap's end to the end of the capture flips -
  in a region where the data is known. Real loss the source store did not have: a live
  planar store keeps appending real samples after a dropout, so its post-gap levels are
  correct; only the round trip lost them.
- Both call sites now go through `channelAcrossGaps`, which asks the source store for the
  level at each gap's end and inserts one synthetic edge when the filtered list reproduces
  the wrong one. A gap ending at `length` is skipped: nothing observable follows it.
- The synthetic edge goes at `endSample - 1`, **inside** the gap, not at `endSample`.
  [MEASURED] that is not a stylistic choice - placing it at `endSample` throws
  `channel 1: edges are not strictly increasing at index 2500` on the suite's own capture,
  because channel 1 has a real edge exactly there and the duplicate position is rejected.
  Inside the gap the interior is empty by construction, so no collision is possible.
- [MEASURED] on the suite capture, gap `[40000, 150000)`: channels 1 and 2 swallow an odd
  count and inverted; the other 14 are even and did not. After the fix, 0/2 odd inverted,
  0/14 even (the control). Mutation-checked: neutering the fixup turns both suites red.

Why it survived two rounds: **both** suites were blind, for two independent reasons. They
guarded with `c1 <= G0`, comparing only pre-gap columns - and the data suite's channel list
`[0, 5, 12, 15]` had *zero* overlap with the odd-parity channels `[1, 2, 11]`, so removing
the guard alone still left it green. Removing a skip is not the same as adding coverage;
the channels the skip was hiding have to actually be in the list.

The monotone gap walk in `query()` was briefly recorded here as a second hole - the worry
being that `snapColumns` could round `c0` backwards and make `gp` miss a gap. **That was
wrong and the entry is retracted.** `pickLevel` guarantees `binSize[level] * coreBins <=
samplesPerBin`, so `B <= pitch/32` and a snap moves a column start by at most `B/2`, an
order of magnitude less than the column pitch; level 0 disables snapping outright. Swept
294k column starts across the real ladder (1,16,256,4096,...) at `coreBins=32`: worst
backstep 0. The walk is safe with `snapColumns` on. The example originally written here
used `B=1024`, which is not on the ladder at all.

**Side effects, both measured.** The 120 s import no longer needs the 1 MSa/s budget
reduction: it loads at its 10 MSa/s grid rate with a virtual length of 1.2e9 (the only
clamp left is 2^31). And `edgeCount()` over a whole capture is O(log) instead of O(scan):
0.01 ms on 2M edges.
