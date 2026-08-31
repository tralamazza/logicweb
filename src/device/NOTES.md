# src/device - SLogic16 U3 WebUSB transport, measured notes

Hardware: Sipeed SLogic16 U3, `359f:3031`, USB 3.0 SuperSpeed, attached to this machine.
Native control: the libsigrok driver in
`$LIBSIGROK/src/hardware/sipeed-slogic-analyzer/`, run through the Homebrew `sigrok-cli`
with the locally built library, where `$LIBSIGROK` is a libsigrok checkout:

```
DYLD_LIBRARY_PATH=$LIBSIGROK/.libs \
  sigrok-cli -d sipeed-slogic-analyzer --config samplerate=16m --samples 1m -o /tmp/ref.sr
```

The Homebrew `sigrok-cli` on its own has **no** sipeed driver (`sigrok-cli -L | grep -i sipeed`
is empty); the `DYLD_LIBRARY_PATH` override is what makes it use the local build.

Browser run: Brave 151.1.93.138, `http://127.0.0.1:5173/src/device/selftest.html`,
2026-08-25 13:52 local. Raw report: `/tmp/slogic-selftest.json`.

---

## 1. Prediction record - one clean miss, and it is the headline

Predictions were written before the browser run, with the native numbers already in hand.

### P3 - FALSIFIED, badly

> Predicted: peak sustained WebUSB throughput lands in **150-250 MB/s**; 100 MHz x 16 ch
> (200 MB/s offered) is held to within 10 %, and 200 MHz x 16 ch (400 MB/s offered) is **not** -
> it falls short by more than 20 %.

Measured:

| config | offered | sustained in Brave | short of offered | short transfers |
|---|---|---|---|---|
| 16 ch @ 50 MHz | 100 MB/s | **100.01 MB/s** | -0.0 % | 0 / 439 |
| 16 ch @ 100 MHz | 200 MB/s | **199.97 MB/s** | 0.01 % | 0 / 572 |
| 16 ch @ 200 MHz | 400 MB/s | **399.57 MB/s** | **0.1 %** | 0 / 1313 |

Peak sustained: **399.57 MB/s**, moving 1.377 GB in 3.45 s. The predicted interval was
150-250 MB/s; the measurement is 60 % above the top of it. The specific sub-prediction that
200 MHz would fall short by more than 20 % is wrong by a factor of 200.

**Why the reasoning was wrong.** I predicted that "copy bandwidth and main-thread contention"
would be the constraint. I never checked the magnitude of the cost I was hypothesising. One
copy of the stream at 400 MB/s is on the order of 1 % of this machine's memory bandwidth -
two orders of magnitude away from being a limit. The transfer count was already ruled out in
the same paragraph (~380 transfers/s), and having ruled out the only mechanism I could
quantify, I should have concluded there was no mechanism left, not picked a number that felt
suitably humble. The prior "WebUSB will not reach the hardware ceiling" was inherited from the
brief and never tested; it is not supported by this hardware.

**What the measurement actually shows.** Sustained rate tracked the *offered* rate at every
point tested, with zero short transfers, and never plateaued. So this run **did not find a
WebUSB ceiling at all** - it established that the ceiling is somewhere above 400 MB/s, which
is the most the device can emit at 16 channels. Reporting "399.57 MB/s" as *the WebUSB limit*
would be the same error in the other direction: it is the device's limit, measured through
WebUSB. Locating the real browser ceiling needs a source faster than the capture path, e.g.
the device's own USB-max-speed test pattern (aux `0x05` mode 1). **That is untested.**

### P5 - FALSIFIED, and it is the same mistake as P3

Asked whether 400 MB/s is reachable at 4 and 8 channels as well as 16. Only the 16-channel
column had ever been run; the 4 and 8 ceilings came from `api.c:134` and were assumed.

> Predicted: 8 ch @ 400 MS/s sustains ~400 MB/s (identical wire load, and `expandPacked`
> is a pass-through at >= 8 channels). 4 ch @ 800 MS/s **does not** - it is 400 MB/s on the
> wire but `expandPacked` unpacks 2 samples per byte in a scalar JS loop, so the consumer
> must move 800 MB/s. Expect it to break there, showing up as short transfers.

Measured, 2026-08-31, same unit (S/N XLFhvXToUSJr0a05), 3 s per point:

| config | wire | to the sink | sustained | short of wire | short transfers |
|---|---|---|---|---|---|
| 16 ch @ 50 MHz | 100 MB/s | 100 MB/s | **100.0** | -0.0 % | 0 / 375 |
| 16 ch @ 100 MHz | 200 MB/s | 200 MB/s | **200.0** | 0.0 % | 0 / 572 |
| 16 ch @ 200 MHz | 400 MB/s | 400 MB/s | **399.4** | 0.2 % | 0 / 1143 |
| 8 ch @ 200 MHz | 200 MB/s | 200 MB/s | **200.0** | 0.0 % | 0 / 572 |
| 8 ch @ 400 MHz | 400 MB/s | 400 MB/s | **398.3** | 0.4 % | 0 / 1143 |
| 4 ch @ 400 MHz | 200 MB/s | 400 MB/s | **200.0** | 0.0 % | 0 / 572 |
| 4 ch @ 800 MHz | 400 MB/s | **800 MB/s** | **399.5** | 0.1 % | 0 / 1142 |

The 8-channel half of the prediction held. **The 4-channel half is wrong.** 4 ch @ 800 MHz
sustains the full 400 MB/s with zero short transfers, and the expansion is real, not
skipped: `sinkBytes / rawBytes` is exactly **2.0000** on both 4-channel rows, so the sink
received 2,394,947,576 bytes in 2.999 s = **799 MB/s**, delivered through the loop I
claimed could not keep up.

**Why the reasoning was wrong - and it is P3's error again.** I asserted that a scalar JS
byte loop could not hold 800 MB/s without computing what that requires: ~800 M iterations/s
is about 5 cycles per iteration at 4 GHz, for a shift, a mask and a store. That is
unremarkable, and the JIT compiles exactly this shape well. P3 above already records the
identical failure - hypothesising a cost and never checking its magnitude - which makes
this the second time in this file. The lesson that did not transfer: **an unquantified
bottleneck is not a prediction, it is a guess wearing one.**

**What this settles.** All three advertised widths are the same 400 MB/s wire budget
(`rate x channels / 8`), and the device holds it at every one. There is still no WebUSB
ceiling in evidence - the sink moved 799 MB/s at 4 channels without complaint, which is the
highest consumer rate measured here and is still not a plateau.

### P1 - held

> Predicted: 16 ch @ 16 MHz (32 MB/s offered) sustained to within 3 %, no short transfers.

Measured **31.995 MB/s** over 2.0 s, 64,000,000 bytes, 250 transfers, 0 short. Inside the
31.0-33.0 MB/s interval.

### P2 - held

> Predicted: under the Emulation pattern the first 20 bytes after the head drop are exactly
> `07 00 06 00 05 00 04 00 03 00 02 00 01 00 00 00 0f 00 0e 00`.

Measured byte-for-byte identical, at 16 channels. Also matched at 8 channels
(`07 06 05 04 03 02 01 00 0f 0e 0d 0c 0b 0a 09 08 17 16 ...`) and at 4 channels after
expansion (`07 06 05 04 03 02 01 00 0f 0e ...`, wrapping mod 16 as a 4-bit counter must).

## 2. The browser and native paths agree

`capture16.headHex` from the browser is byte-identical to `logic-1-1` in `ref.sr` from
`sigrok-cli`: `00 b2 00 b2 00 b2 ...`. Same alignment, same head drop, same framing.

The head-drop accounting is exact in three independent places in the run:

| config | raw bytes off the wire | bytes to the sink | difference |
|---|---|---|---|
| 16 ch | 64,000,000 | 63,999,996 | 4 |
| 8 ch | 15,744,000 | 15,743,996 | 4 |
| 4 ch | 7,864,320 | 15,728,632 | `(raw - 4) x 2` exactly |

The 4-channel row is the useful one: it confirms the drop happens on the wire *before*
expansion, and exactly once, not once per transfer (250, 123 and 120 transfers respectively).

### What is on the probes

Every sample in the idle capture reads `b2 00` on the wire, i.e. the little-endian 16-bit
value **`0xb200`**: D9, D12, D13 and D15 high, **D0-D7 all zero**.

(An earlier draft of this file read that as `0x00b2` and named D1/D4/D5/D7. That was wrong - it
decoded the wrong half of the bus. The bytes were always right; the note was not.)

The probes **are** connected to a stimulus generator, which was simply idle when this capture
was taken. Channels 0-7 carry real signal on command; channels 8-15 are floating, which is
exactly the `0xb200` seen here. So a live-edge comparison against the native path is possible -
it just was not exercised in this run. **That comparison remains unverified**, and it is the
obvious next test. What has been verified is byte-exact agreement on a static level and on the
device's deterministic Emulation pattern.

## 3. Native control numbers, and an anomaly the browser resolves

| config | offered | sustained (native) | note |
|---|---|---|---|
| 16 ch @ 16 MHz, 1 M samples | 32 MB/s | 30.85 MB/s | single 2 MB transfer, start-up included |
| 16 ch @ 50 MHz, 50 M samples | 100 MB/s | 99.48 MB/s | 16 transfers |
| 16 ch @ 100 MHz, 20 M samples | 200 MB/s | 196.72 MB/s | 4 transfers |
| 16 ch @ 100 MHz, 50 M samples | 200 MB/s | **99.46 MB/s** | 8 transfers of 12.5 MB - anomaly |
| 16 ch @ 200 MHz, 50 M samples | 400 MB/s | 391.26 MB/s | 4 transfers |

The 50 M-sample 100 MHz row collapses to half rate in the **native** path. The browser holds
**199.97 MB/s** in that exact configuration, with 572 transfers of 1 MiB and zero short
transfers. That is direct evidence the anomaly is libsigrok's transfer sizing
(`train_bulk_in_transfer`, protocol.c:382, which picks a buffer of one quarter of 250 ms of
data - 12.5 MB here) and **not** the device or the link. Worth reporting upstream; it is not a
defect in this module.

Note also that the browser beats the native path at 200 MHz: 399.57 vs 391.26 MB/s.

## 4. Where the libsigrok driver and docs/PROTOCOL-SLOGIC16U3.md disagree

The brief said to read `api.c`/`protocol.c` directly and flag disagreements. Three; the first
is a bug trap.

**a) The aux payload length is not "rounded down to a multiple of 4".** The doc (aux protocol,
step 3) says the length is "clamped to 60 and rounded down to a multiple of 4".
`aux_payload_len()` (api.c:1158) **only clamps**. The rounding that happens is a round *up*,
later, inside `slogic_usb_control_write/read` (api.c:807, api.c:853). The real device reports
lengths that are not multiples of 4:

| selector | status word | reported payload length |
|---|---|---|
| `0x01` channels | `0x00010401` | 2 |
| `0x02` samplerate | `0x00011002` | 8 |
| `0x03` vref | `0x00010403` | 2 |
| `0x05` test mode | `0x00010205` | 1 |

Rounding *down* gives 0 for three of the four: the payload write becomes a zero-length no-op,
every configuration item silently fails to take, and the device captures at whatever it was
last set to. Following the doc rather than the driver produces exactly the silent-rejection
failure the brief warns about.

**b) The status word format is undocumented.** It is
`u16[0] = (payloadLength << 9) | selector`, ready flag in bit 0 of byte 2. The selector echo in
byte 0 was verified for all four selectors, so this code treats a mismatched echo as fatal; the
driver does not check it.

**c) The samplerate base-index walk is bounded by the index, not by an iteration count.** The
doc says "the driver caps this at 5 iterations". The actual bound is `while (aux.u16[2] <= 1)`
(api.c:1325) - **only base indices 0 and 1 exist** - with `base_retry > 5` as a second guard
inside it. This code now bounds the index too, and refuses to write an index above 1 at all
(the driver writes index 2 once before its loop condition stops it). When the walk fails, the
driver logs at `sr_dbg` level and **starts the acquisition anyway** (api.c:1382 falls through to
the `CTRL=run` write), reporting a wrong samplerate as success. This code throws.

On this unit the walk never runs: base index 0 is **800 MHz** and every rate in the advertised
table divides it exactly. **The base-index increment path is untested against real hardware**;
it is covered only by the offline suite, against a synthetic device.

### Start-sequence details the doc omits

- `dev_open()` issues `CTRL=0x02` then `CTRL=0x00` (reset) before anything else.
- `sipeed_slogic_acquisition_start()` issues `CTRL=0x00` (stop) *before* configuring anything
  (protocol.c:478). The doc's "Start / stop" section starts at the channel mask.
- The driver only touches the test-pattern register when the frontend asks for a pattern, so a
  device left in "Emulation" by a previous session **stays there** and the next capture
  silently returns synthetic data. This transport deviates deliberately: it programs the
  pattern register on every `start()`, defaulting to Normal. Cost is one aux round trip;
  benefit is that a capture is never accidentally fake. This is the one intentional behavioural
  difference from the driver.

## 5. Things the hardware taught us that no source documents

- **`USBDevice.serialNumber` is not the device serial in Brave.** The run reported
  `PyZzCBfPPm6lSw3j` for a unit whose real serial is `202512261505`; Brave randomises it per
  origin as an anti-fingerprinting measure. `Device.serial` is therefore an opaque
  per-page-session handle, **not** a unit identifier, and no provenance claim may rest on it.
  libusb-based tools see the real serial; WebUSB does not. Flagged in the code at
  `Slogic16U3.serialIsBrowserSupplied`.
- The advertised payload length is genuinely register width: only the low 2 bytes of the
  channel-mask and vref words, and the low byte of the test-mode word, are register. On this
  unit the remaining bytes read back zero, but read-back verification is masked to the
  advertised length so that a unit leaving junk there is not bricked by our own checks.
- The Emulation pattern is deterministic across runs and identical in shape at 4, 8 and 16
  channels (a counter descending within groups of eight, truncated to the channel width). It is
  the only way to check stream alignment while the stimulus generator is idle - against a
  static level, dropping 4 bytes and dropping 0 look identical.

## 6. Design decisions in this transport

- **16 outstanding `transferIn` calls**, sized to ~8 ms of data, 1024-byte aligned, clamped to
  64 KiB..1 MiB. The replacement transfer is queued *before* the oldest is awaited, so the queue
  never drains below the configured depth while running. Bulk IN transfers on one endpoint
  complete in submission order, which is what makes the FIFO correct. Zero short transfers at
  every rate tested, up to 400 MB/s.
- **Head drop carried across transfers**: if the first transfer returns fewer than 4 bytes, the
  remainder applies to the next one. Once per acquisition.
- **`stop()` runs its teardown under `try/finally`.** Unplugging mid-capture makes the `CTRL=0`
  write reject; without the finally the interface would never be released, `loopDone` would
  never clear, and the object would be wedged while the caller got a `NetworkError` from a
  control write instead of the read loop's actual error. The read loop's error wins; the
  control-write failure is reported as the symptom it is.
- **`drain()` delivers, it does not discard.** Transfers already carrying data when `stop()`
  runs are fed through the same head-drop path. At 16 x 1 MiB in flight, discarding them would
  silently lose up to 16 MB off the tail of every capture - invisible in a fixed-duration test,
  fatal for a caller doing "start, wait for N samples, stop". One unplug now reports once with a
  count, not 16 times.
- **Nothing is caught silently.** Every `catch` re-throws, `console.warn`s a teardown-only
  condition, or routes to `onError`. Cancellation during `stop()` is the one rejection treated
  as normal, and it is traced.

## 7. Test suites

**`offline-test.ts` - 34 checks, all passing, no hardware.** Runs against replies *recorded from
the real device* (section 4a). Covers the 4-byte control chunking, the ready-bit handshake, the
payload-length clamp, read-back verification masked to the advertised length, divider arithmetic
(16 MHz -> 800/50, register 49, matching the driver's debug output), the vref mapping
(1.6 V -> 226, 1.7 V -> 245, matching the driver), sub-8-channel expansion, and the failure
modes: stalled write, wrong `bytesWritten`, short read, bad read status, ready bit never set,
wrong selector echo, read-back mismatch, unreachable samplerate, and out-of-range base index
never written.

It also drives the full streaming path against a scripted bulk endpoint, which is how the head
drop is tested at all: a 3-byte first transfer followed by a 5-byte one must yield exactly 4
bytes removed, once, with the carry across the boundary; and a transfer that only completes when
the interface is released must still reach the sink.

A mid-stream **short transfer is a dropout** and is now reported through the optional
`onDropout(samplePosition, missingSamples)` argument of `start()`. The scripted test pins the
arithmetic: one full 256000-byte transfer, one short by 100 bytes, one full, at 16ch/16 MHz,
must report exactly one dropout at sample 255948 with 50 missing. The short *final* transfer
of a run is the normal end and is not reported. Hardware has never produced a short transfer
mid-run (0 across every selftest), so the callback is currently exercised by the fake, not by
the device.

`samplePosition` is the position the short transfer *ends* on, not the one it starts on.
The short transfer still carries real samples and the shortfall is at its end, so the
report is emitted after `deliver()`. It was emitted before at first, which put the
discontinuity one whole transfer early - 127998 instead of 255948, a 128k-sample error
that the scripted test happily pinned because the test was written from the code.

**The consumer side is now wired** (`appendLostSamples`, `src/data/gaps.ts`). It was dead
for two rounds: the missing samples were never appended, so they occupied no index in the
store, and the callback's guard (`pos >= store.length`, always true) returned before
reaching `noteGap`. The root cause was structural rather than a bad guard - with nothing
appended the span has **zero width in store coordinates**, so there is no span to mark.
Loosening the guard could not have helped.

The decision taken: **append filler for the lost samples**, so the store's sample axis
keeps tracking device time, then mark that span as the gap. Without it sample 1,000,000
stops meaning the instant the device meant by it and every measurement after a dropout is
wrong by the shortfall, silently.

The filler repeats the **last known sample**, not zeros. Zeros invent a falling edge at the
gap's start and a rising one at its end on every channel that was high - and the one at the
end sits outside the gap, where `edges()` reports it as real and the renderer draws it.
[MEASURED] the mutation is unambiguous: zeroed filler gives exactly 1 spurious edge per
channel, 16 across the store, in a capture that has none.

Pinned end to end in `offline-test.ts` against the same scripted short transfer: the device
delivers 383,948 real samples and loses 50, so the store must end at **383,998** with one
gap at **[255948, 255998)**. Mutation-checked both ways - zeroing the filler turns the
edge check red, and skipping the append throws
`gap [255948, 255998) outside 0 <= start < end <= 255948`, which is the zero-width problem
stating itself.

Still true: hardware has never produced a short transfer, so this path has only ever run
against the scripted device.

Those stream tests were mutation-checked - reverting `drain()` to discard fulfilled transfers,
making the head drop per-transfer instead of per-acquisition, and dropping the `onDropout` call
each turn them red. A test that cannot fail is worth nothing.

```
npx esbuild src/device/offline-test.ts --bundle --format=esm --platform=node \
  --outfile=/tmp/slogic-offline.mjs && node /tmp/slogic-offline.mjs
```

**`selftest.html` - hardware, 18 checks.** The 2026-08-31 15:10 run was **18/18** (section 5
now sweeps all three capture widths and asserts each one's ceiling, which added 3 checks).
The 2026-08-25 13:52 run was 13/14; the one failure
was a **wrong constant in the test**, not a defect: it expected `vrefVolts(226) == 1.6493` when
the formula in `protocol.ts` and in `api.c:1447` both give
`0.005166 x 226 + 0.4318 = 1.599316`. The device and the code were right and the test was wrong.
Corrected, and the tautological "a 256-byte buffer has even length" check - which would have
passed forever - was replaced by the raw-minus-sink head-drop assertion in section 2.

```
npx vite --host 127.0.0.1 --port 5173      # from the project root
node src/device/result-server.mjs          # writes /tmp/slogic-selftest.json
```

Open `http://127.0.0.1:5173/src/device/selftest.html` in Brave. The permission grant is
remembered per origin, so after the first run it starts with no click. `sigrok-cli` must not be
running at the same time - it claims interface 0.
