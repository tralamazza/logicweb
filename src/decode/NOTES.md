# src/decode - route choice, measurements, and what is not verified

**131 stock libsigrokdecode decoders run unmodified in the browser. 124 produce
output byte-identical to native `sigrok-cli` - spans, annotation class and the
full text variant list - in the shipping configuration; 125 with
`eofMode: 'terminate'`. Zero decoder source files were patched, and there is no
case where the shim fails and native succeeds.**

A mature commercial tool ships roughly 25 protocol analyzers. The number above is not a
count of things written here; it is a count of upstream sigrok `.py` files
executing against a reimplementation of the one module they import.

## Harness honesty: what "byte-identical" covers, and the mutation check

An earlier version of `tools/conformance.mjs` compared only sample spans and
`texts[0]`. It destructured the annotation **class** away and discarded every
text variant after the first - which are precisely the two fields the renderer
consumes (`registry.rowForClass` picks the row, `client.annotationTexts` picks
the width-appropriate string). It was therefore a claim about `sigrok-cli`'s
stdout, not about `DecodeResult`.

It now compares all four columns, and reads them out of `packed_results()` -
the same struct-of-arrays `worker.ts` ships - so the test exercises the shipped
representation rather than a parallel one built for the test.

| field | how it is verified |
|---|---|
| `start`, `end` | aggregate diff against `sigrok-cli --protocol-decoder-samplenum` |
| `cls` | one `sigrok-cli -A <dec>=<class>` run **per annotation class**, required to match exactly (1 118 such runs on the random capture alone) |
| `texts[0]` | aggregate diff, as above |
| `texts[1..n]` | **not observable in any sigrok-cli output** - it only ever prints the first. Checked against literal variant lists parsed out of the upstream decoder's own `.py`, restricted to `put()` call sites and to first-texts that map to exactly one literal |

Mutation results on the final harness, run explicitly:

| mutation | result |
|---|---|
| baseline, unmutated | **GREEN**, exit 0 |
| force every annotation class to 0 | **RED**, exit 1 - `class 0 ("rx-data"): native 72 lines / shim 792` |
| drop every text variant after the first | **RED**, exit 1 - `emitted ["Start bit"] but uart/pd.py has ["Start bit","Start","S"]` |
| reverse the text variant order | **RED**, exit 1 - `native="...: Start bit" shim="...: S"` |

Both of the mutations that defeated the old harness now fail it. The harness
also **exits non-zero** on any mismatch or shim error, so it can gate a build,
and every decode is bounded by a watchdog (`DECODE_TIMEOUT_MS`, default 120 s)
that raises `KeyboardInterrupt` through Pyodide's interrupt buffer from a
worker thread - a `setTimeout` cannot fire, because `runPython` blocks node's
event loop.

Three harness bugs were found and fixed while doing this, all of which had been
silently weakening results:

- the watchdog stored `Date.now()` in an `Int32Array`, which wraps, so it fired
  instantly on every decode;
- its worker body used `require()` inside an ESM package, so it died at startup
  and there was no timeout at all;
- the old query `json.dumps`'d millions of annotations, building a
  several-hundred-MB string inside Pyodide that came back **corrupted** - three
  decoders were being reported as shim failures because of it. The packed-buffer
  query fixes it.

A `TIMEOUT` is now only reported if the watchdog actually fired; a spurious
interrupt is labelled as a harness bug. That distinction caught a 120 s
"timeout" for a decode that takes 4.6 s.

## Decode is bounded and cancellable

Previously a decode ran to completion inside one un-interruptible `runPython`,
and `terminate()` destroyed the worker permanently. A 5 s saturated UART
capture is 6.9 s of that - an un-escapable UI freeze.

- `DecodeClient.decode(request, { timeoutMs, signal })`. Default timeout
  `DEFAULT_DECODE_TIMEOUT_MS` = 15 s; `timeoutMs: 0` disables.
- Cancellation uses Pyodide's `setInterruptBuffer`, the equivalent of
  libsigrokdecode's `srd_session_terminate_reset`. The worker allocates a
  `SharedArrayBuffer` and posts it to the client unsolicited as soon as Pyodide
  is up; the client writes 2 to raise `KeyboardInterrupt` inside the running
  decode. A *message* cannot work - the worker is blocked and would not read
  its queue until the decode finished.
- Where `SharedArrayBuffer` is unavailable (no cross-origin isolation) the
  client kills and respawns the worker after a 250 ms grace period. Still
  bounded, but it costs a Pyodide reload; `client.hardCancels` counts those.
- `terminate()` is no longer one-way: the next request spawns a fresh worker.
  `dispose()` retires a client permanently.
- `sharedDecodeClient()` returns a process-wide client, because the ~870 ms cold
  start is per worker. `warmup()` pays it before the user is watching.

Measured in Brave against the production bundle: **cancel honoured in 62 ms via
the interrupt buffer, client reusable afterwards, timeout fires and is reported
as `DecodeTimeoutError`, and all documented limits are refused rather than
crashed into.** These are assertions in `bench/bench.ts`, so the bench fails if
any regress.

## Real captured signal vs synthetic

**UART, SPI and I2C are now verified on real captured signal.** An earlier
version of this file said they were out of probe range; that was wrong.
Captures are `reference/hwcaptures/{uart,spi,i2c}.sr`, taken with the SLogic16
U3 at 16 MSa/s off a picolyzer-tester, mapped `uart:rx=D9`,
`spi:clk=D10:mosi=D11:cs=D12`, `i2c:scl=D13:sda=D15`.

These are **known-answer** checks - the generator reports exactly what it sent -
run through the real `DecodeClient` in the production bundle:

| stimulus commanded | decoded | warm decode |
|---|---|---|
| `uart 115200 48 65 6c 6c 6f` | `48 65 6c 6c 6f` MATCH | 2.1 ms, 55 anns |
| `spi 1M de ad be ef` | `de ad be ef` MATCH | 4.9 ms, 37 anns |
| `i2c 100k 0x50 00 ff` | `00 ff` MATCH | 0.9 ms, 33 anns |

I2C shows NAK on every byte because the generator is push-pull with no slave;
that is expected, and the address/data still decode correctly. The byte
extraction deliberately takes the **last** text variant, since sigrok emits
longest-first (`['Data write: 00', 'DW: 00', '00']`) - so this also exercises
the variant list end to end.

Also real: `gray 100k 8` and `count 1M` on the 8-bit bus (GP0-7), and
`pulse 0 2000 10000`, where stock `pwm` reports 20.000000% / 100.000 kHz for
1 248 periods against a commanded 1.9998 us / 9.999 us, with the raw capture
independently measuring 160 samples/period and 32 high.

**Synthetic:** the UART throughput captures, the pseudo-random 8-channel
capture, and the I2C fixture used for the `i2c -> eeprom24xx` stack test. The
random capture is deliberately hostile (per-channel mean run lengths 4 to 521
samples) because random input drives decoders into their error and
resynchronisation paths, which is where a `wait()` bug shows.

Unprobed and therefore unobservable: GP9-GP15 and GP18, i.e. bus bits 9-15.

## Decoder breadth

| capture | kind | identical | non-empty | mismatch | shim-only failures |
|---|---|---|---|---|---|
| `uart.sr` 200 k, 16 ch | **real** | 125 | 3 | 0 | 0 |
| `spi.sr` 100 k, 16 ch | **real** | 125 | 2 | 0 | 0 |
| `i2c.sr` 100 k, 16 ch | **real** | 125 | 1 | 0 | 0 |
| `count` 200 k, 16 ch | **real** | 121 | 60 | 0 | 0 |
| `gray` 200 k, 16 ch | **real** | 123 | 56 | 0 | 0 |
| `rand8` 400 k, 8 ch | synthetic | 101 | 77 | 1 (`parallel`) | 0 |

- **125 byte-identical on at least one capture**, 86 of those with non-empty
  output. A match on empty output is nearly free evidence, so 86 is the number
  to trust for "did real work and got it right".
- **125 byte-identical on real captured signal**, 62 with non-empty output.
- **5 011 275 annotations compared, 957 897 of them multi-variant.**
- **0 shim-only failures anywhere.**

Stacks are exercised to three levels: `i2c -> eeprom24xx`,
`onewire_link -> onewire_network -> ds2408`,
`usb_signalling -> usb_packet -> usb_request`. All byte-identical.

### 124 vs 125

The single mismatch is `parallel`, which emits one extra trailing annotation.
`sigrok-cli` never delivers `EOFError` - it kills the decode thread inside
`wait()`, so a decoder's post-EOF flush never runs natively (established with a
probe decoder, below). `DecodeRequest.eofMode` now exposes both behaviours:

- `'raise'` (**default**) delivers `EOFError`, keeping the last item of a
  capture. `parallel` differs from the reference by one annotation.
- `'terminate'` reproduces sigrok-cli exactly; `parallel` then matches.

The default is `'raise'` because losing the final decoded byte of a capture to
match a truncation bug is worse for the user. So the honest headline is **124 in
the shipping default, 125 with `eofMode: 'terminate'`**, and the product can
select either.

### The 6 that are never identical - all fail natively too

| Decoder | Why | Native |
|---|---|---|
| `i2cdemux`, `i2cfilter` | OUTPUT_PYTHON only; `sigrok-cli -A` refuses them | not comparable |
| `ir_irmp` | `dlopen`s a native `libirmp` | same `LibraryError` |
| `swim` | reads `self.samplerate` in `start()`, which runs before `metadata()`, with no class default | same `AttributeError` |
| `pca9571`, `tca6408a` | need `srd.OUTPUT_LOGIC` | **fail natively, work here** |

Others fail on *some* captures with the identical exception on both sides:
`avr_pdi`, `cjtag`, `lpc`, `spdif`, `atsha204a`, `amulet_ascii`, `ieee488`,
`xfp`. Reproducing upstream's bugs exactly is the point.

## Route choice: Pyodide, not emscripten

Prediction, recorded before Route A's outcome was known: *Route A will not build
in this budget and the blocker will be glib, not CPython; if it did build it
would win only on throughput; Route B runs >90% of stock decoders unmodified.*

**Held, except one that is untestable.** CPython 3.13 cross-compiled to
`wasm32-unknown-emscripten` and produced `libpython3.13.a` (42 MB) - the part
libsigrokdecode links against; only the optional standalone `python.js` link
failed, on `memfd_create`. glib produced **no library at all** in five attempts:
missing `packaging`; `res_query()` absent from emscripten and gio not optional;
`size_t` function-pointer mismatch; C23 `free_sized` *mis-detected as present*
because attempt 2's `-sERROR_ON_UNDEFINED_SYMBOLS=0` made every libc probe
answer yes; and finally meson resolving the **host macOS libffi** and feeding
macOS SDK headers into an emscripten compile. Each fix widened the blast radius.

Route A never linked, so **its throughput and bundle size were never measured**.
That half of prediction 2 is unfalsified, not confirmed - the one claim here
that is an argument rather than a number.

## Performance, measured

| | Route B (Brave, production bundle) | native `sigrok-cli` |
|---|---|---|
| cold start to first annotation | **870 ms** (Pyodide load 852 ms) | n/a |
| warm, 4 000 600-sample UART, 63 360 anns | 696 ms (91 074/s) | n/a |
| **5 s saturated 115200 8N1, 633 600 anns** | **7 089 ms** | **2 300 ms** |
| app bundle | 160 KB (33 KB gzip) + 32 KB worker | n/a |
| lazily fetched runtime | 12.9 MB pyodide + 0.59 MB decoders | n/a |

**On identical stimulus the browser is 3.0x slower than native**, not the 2.3x
this file previously claimed. That earlier figure came from comparing against a
capture ten times smaller; measuring both sides on the same 5-second workload
gives 7.089 s against 2.300 s. A separate reviewer measured 3.2-3.4x with a
slightly faster native run; the ratio is ~3x either way.

Cold start is measured from **before the client is constructed**, so worker
construction is included; it previously was not, despite the doc comment.

Against the bar: warm per-analyzer decode on real protocol traffic is 0.9-4.9 ms
against a native tool's 119-682 ms, so warm this compares well. Cold, at ~870 ms,
it does not. On dense saturated traffic it is well outside.
The profile is *excellent warm, poor cold, weak under load* - so keep one client
alive and call `warmup()` early; that is what `sharedDecodeClient()` is for.

**34.8% of decode wall time used to go to channels no decoder reads.** The
worker now prunes them: on a 16-channel 2 M-edge capture an `i2c` decode was
1 010 ms with 14 unread channels populated and 659 ms with them empty, with
byte-identical output. Callers no longer need to know.

## Documented limits, refused rather than crashed into

- **`MAX_SAMPLE` = 2^31 - 1.** Annotation spans are `Int32Array` and packed with
  `array('i')`, so a longer range cannot round-trip. **At this device's
  200 MSa/s that is a 10.7 second capture** - reachable on this bench. Longer
  captures must be decoded in sub-ranges with spans offset by the range start.
  Checked before any work, in both the worker and `Session.__init__`.
- **`EDGE_BUDGET` = 48 000 000 edges** across the channels the stack reads.
  Measured cost is 29-35 bytes of wasm32 heap per edge against a hard 4 GB
  address space: 16 M edges 557 MB, 48 M 1.63 GB, 80 M 2.64 GB. Past ~80 M
  Pyodide does not fail cleanly - it corrupts and returns garbage - so the
  budget stops well short, where refusing is still possible.

Both are asserted in the bench: a request past either limit must be refused with
a specific error.

## Semantics established empirically

`wait()` is undocumented; it was read out of `instance.c:find_match()` and then
confirmed with a probe decoder run under `sigrok-cli`. Four findings, three of
which contradicted what the source suggested:

1. `start()` runs **before** `metadata()`, not after (this broke `em4305` and
   `ir_sirc` until fixed).
2. `samplenum` and `matched` do not exist during `start()`.
3. `reset()` is never called on the decode path - though libsigrokdecode
   *refuses to load* a decoder that lacks the method.
4. `EOFError` is never delivered; the thread is killed inside `wait()`.

A fifth, found by differential testing: `lfast.__init__` sets
`decimal.getcontext().rounding = ROUND_HALF_UP`, but srd runs `decode()` on a
different thread and the decimal context is thread-local, so srd silently drops
it. `srdengine.py` runs `decode()` under `decimal.DefaultContext` to reproduce
that. A libsigrokdecode bug deliberately copied.

`describe()` also no longer invents `annotation_rows`. libsigrokdecode's
`get_annotation_rows()` (decoder.c:474) returns success with an empty list when
the member is absent, which is true of 17 stock decoders. The one-row-per-class
fallback moved to `registry.displayRows()`, labelled as a UI choice.

## Packaging

The worker fetches `/pyodide/pyodide.mjs` and imports it from a **blob URL**.
Deliberate: bundling Pyodide's ESM makes Vite code-split the worker, which its
default `worker.format: 'iife'` cannot do; a classic worker fixes production but
breaks `vite` dev; a plain dynamic import works in production but 500s in dev
(`?import` appended). A blob URL is invisible to Vite in both. Pyodide resolves
siblings as `` `${indexURL}pyodide.asm.mjs` `` - absolute - so this is safe.

**The clean fix is `worker: { format: 'es' }` in a root `vite.config.ts`.** That
file is shared and not this module's to create; once the lead adds it, the blob
indirection can be deleted.

## What is still unverified

- Route A's throughput and bundle size. Never built.
- The ~39 decoders that matched only with empty output.
- **The interrupt-buffer cancellation path.** This entry used to say the
  opposite - that the no-SAB *fallback* was the untested one, "because this
  bench has SAB". That was wrong, and backwards. The bench that has SAB is
  `tools/conformance.mjs`, which runs under **node**, where `SharedArrayBuffer`
  is unconditional. The browser app is the other case entirely.

  [MEASURED] `crossOriginIsolated: false` and `SharedArrayBuffer is not
  defined`, in all four combinations: headed and headless Brave, against the
  vite dev server and against a plain static `dist/`. Nothing sends COOP/COEP.

  So the fallback - kill the worker after the 250 ms grace period, respawn, pay
  a fresh Pyodide load - is the **only** path the app has ever taken, and
  `interruptBuffer` has always been null there. What has never run in a browser
  is `py.setInterruptBuffer` and the cheap cooperative cancel.

  The consequence for deployment is the reverse of what this file implied:
  shipping to a static host changes nothing, and *adding* COOP/COEP is the
  change that would move the app onto untested code.
- Captures beyond 4 M samples, and the edge budget itself - the 29-35 bytes/edge
  figure and the ~80 M corruption point are from a reviewer's measurement, not
  reproduced here.
- `OUTPUT_BINARY`, `OUTPUT_META`, `OUTPUT_LOGIC` sinks: accepted so decoders
  using them run, but not surfaced or compared.
- Decoder options beyond `baudrate`: type-checked against each decoder's
  declared default and unknown ids rejected, but only `uart`'s is exercised
  end to end.

## Reproducing

```sh
git clone --depth 1 https://github.com/sigrokproject/libsigrokdecode /tmp/lsd
npm i
node src/decode/tools/vendor-assets.mjs /tmp/lsd/decoders   # runtime + manifest
node src/decode/tools/build-hwfixture.mjs                   # real-capture fixture
node src/decode/tools/browser-bench.mjs --prod              # browser numbers, exits non-zero on failure

SRD_DECODERS=/tmp/lsd/decoders DECODERS_ZIP=public/decoders/decoders.zip \
  PYODIDE_DIR=node_modules/pyodide \
  node src/decode/tools/conformance.mjs <capture.bin> <nch> <samplerate>
```

`conformance.mjs` needs `sigrok-cli` on PATH (`brew install sigrok-cli`) and
exits non-zero on any mismatch.
