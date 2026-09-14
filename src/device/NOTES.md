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
- **Chromium delivers the 32U3 stream at roughly half of libsigrok's rate.** Measured
  2026-09-10 on S/N 202608052052 (10 Gb/s link, `usbfs_memory_mb=16`): 32ch@100M sustains
  400.05 MB/s, which is the device's own rate and therefore lossless; 32ch@200M reaches
  497-503 MB/s against the 800 MB/s the device produces, while libsigrok on the same board and
  the same 5 x 3,129,344 B geometry reaches 800-1000 MB/s. The gap is host-side re-arm latency
  in the browser's USB path (one 12.5 MB request completes in ~60 ms when it is the only one in
  flight, i.e. ~200 MB/s, so the browser is latency-bound rather than link-bound). **The
  200 MSa/s target is therefore not met yet**, and closing it needs either a deeper queue
  (which needs a bigger `usbfs_memory_mb`) or fewer round trips per byte.
- **A 32U3 capture that fails at 200M leaves the endpoint dead until the board is unplugged.**
  After the first 200M capture of a plug-in session, the next capture fails its very first
  `transferIn` with `NetworkError`, and from that point libsigrok also reads 0 bytes and
  `usbreset` does not recover it; only a physical replug does. 100M does not show this - five
  consecutive 100M captures (one of them 12.04 s / 4.81 GB) all completed with zero short
  transfers. The open question is whether the 200M failure needs a USB port reset, a
  close/reopen of the device, or the cancel-then-stop sequence libsigrok uses.

## 6. Design decisions in this transport

- **Transfers are armed after `CTRL_RUN`, not before.** libusb happily leaves submitted URBs
  pending while the device is stopped, so libsigrok queues its five transfers *before* RUN.
  Chromium does not: a `transferIn` issued while the 32U3 is stopped completes immediately with
  `NetworkError` and poisons the whole queue, so every request after it fails too. Arming
  immediately after RUN works because the device FIFO covers the sub-millisecond handoff.
- **The queue is sized by the host's URB budget, not by libsigrok's first guess.** libsigrok
  *asks* for 200 MB per 250 ms, is refused with `LIBUSB_ERROR_NO_MEM`, halves four times and
  settles on 5 x 3,129,344 B (14.92 MiB). That settle point is Linux's `usbfs_memory_mb`
  budget, which is 16 MiB by default and is shared by every URB in the process. Reserving
  4 x 32 MiB - well inside Chromium's per-call limit - made *every* transfer fail with
  `NetworkError`, because the per-call ceiling and the queue budget are different limits.
  The transport therefore pins 5 x 3,129,344 B and refuses any tuning whose
  `depth x transferBytes` exceeds that budget before it can poison the endpoint.
- **The replacement transfer is submitted from the completion reaction** *before* the completed
  buffer reaches conversion, trigger matching or the UI sink. A sequence-numbered completion
  queue preserves endpoint order. This is the browser equivalent of libsigrok's callback plus
  `raw_data_queue`.
- **Head drop carried across transfers**: if the first transfer returns fewer than 4 bytes, the
  remainder applies to the next one. Once per acquisition.
- **`stop()` drains before it writes `CTRL=0`, and runs its teardown under `try/finally`.**
  WebUSB cannot cancel a single transfer, so `stop()` stops replenishing, lets the finite
  in-flight queue complete while the device is still producing, and only then writes `CTRL=0`.
  The old order - `CTRL=0` first, then `releaseInterface()` to cancel the stragglers - left the
  32U3 endpoint returning `EIO` for the rest of that plug-in, including to libsigrok. Releasing
  the interface is now the exceptional path only, for a device that has stopped responding.
  Unplugging mid-capture makes the `CTRL=0` write reject; without the finally the interface
  would never be released, `loopDone` would never clear, and the object would be wedged while
  the caller got a `NetworkError` from a control write instead of the read loop's actual error.
  The read loop's error wins; the control-write failure is reported as the symptom it is.
- **`drain()` delivers, it does not discard.** Transfers already carrying data when `stop()`
  runs are fed through the same head-drop path. At 16 x 1 MiB in flight, discarding them would
  silently lose up to 16 MB off the tail of every capture - invisible in a fixed-duration test,
  fatal for a caller doing "start, wait for N samples, stop". One unplug now reports once with a
  count, not 16 times.
- **Nothing is caught silently.** Every `catch` re-throws, `console.warn`s a teardown-only
  condition, or routes to `onError`. Cancellation during `stop()` is the one rejection treated
  as normal, and it is traced.

## 7. Test suites

**`offline-test.ts` - all checks passing, no hardware.** Runs against replies *recorded from
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

A WebUSB **short transfer is successful data**, not a dropout. The endpoint is allowed to
return fewer bytes than requested; libsigrok consumes `actual_length` and immediately submits
the next transfer. Treating the unfilled part as lost created false gaps and broke sample time
at high rates. The scripted test now splits a 32-bit sample across two short requests and checks
that the bytes concatenate without a dropout. The optional `onDropout` callback remains in the
cross-module contract for a future controller-level loss signal, but this transport does not
fire it for short packets.

The stream tests also cover the 32U3 path: 32-channel identification/configuration, native
little-endian words split across USB requests, the 32 KiB-aligned transfer sizing at 100M/200M,
and the invariant that all four initial lanes are re-armed before the first synchronous sink
callback. A separate 32 MiB ingest benchmark compares the native interleaved store against the
old planar transpose; the former is the shipping path for 32 channels.

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

## 8. Closing the 32U3 gap against libsigrok, 2026-09-10

The complaint that started this section: `sigrok-cli`/PulseView hold 32ch@100M and 32ch@200M
for tens of seconds, while this transport loses the 200M link and has to be replugged. The
comparison below is against the driver in
`$LIBSIGROK/src/hardware/sipeed-slogic-analyzer` (protocol.c, api.c), which is protocol
evidence, not a source to copy from.

**What the driver does that this transport did not.**

| libsigrok | this transport, before this change |
|---|---|
| Aborts the session when the host falls behind: `average_rate < expected_rate * 0.95` for `num_transfers_used` consecutive transfers (protocol.c:152-171), then cancels the URBs and writes `CTRL=0` | Kept streaming at whatever rate the browser managed, for the whole requested duration |
| libusb event thread resubmits each URB from the completion callback (protocol.c:140-150), while the session thread drains `raw_data_queue` | Same shape: the promise reaction re-arms before the data reaches the consumer (`arm()` before `finish()`) |
| Trains the transfer size: 250 ms of data, aligned to 32 KiB, halved until the allocation succeeds, then divided by four, and queues as many as the 16 MiB `usbfs` budget allows (protocol.c:249-330) | Pinned 5 x 3,129,344 B. Same count, near-identical size (the driver settles on 3,125,248 B at these rates) |
| Drops the 4-byte head of the first transfer only (protocol.c:117-125) | Same |
| Counts `actual_length` for rate accounting, before the head drop | Same (`rawBytes` is pre-drop) |

The missing piece is the abort. A 32U3 whose FIFO overruns for seconds wedges its bulk
endpoint: after that, every host - `libsigrok` included - reads 0 bytes with
`LIBUSB_TRANSFER_ERROR`/EPROTO until the board is unplugged. `sigrok-cli` never reaches that
state because it stops within ~10 transfers of falling behind. The transport now does the
same, measured over a sliding window (WebUSB can reap several URBs in one task, so a
per-transfer duration is not the same signal as it is in libusb):

```
SLogic32 U3 overran the host: 32ch @ 200 MHz offers 800 MB/s and the browser sustained
503 MB/s across 4 consecutive transfers (...). Capture aborted before the device FIFO
overflow wedged the endpoint.
```

**Why a worker cannot host the USB loop.** WebUSB is exposed in a Dedicated Worker
(`navigator.usb.getDevices()` returns the granted device, `open()` succeeds), but
`claimInterface()` always fails there with "Unable to claim interface", in a freshly started
browser, while the identical call from the page succeeds. Measured 2026-09-10 on
Chrome 152.0.7977.82. So the read loop stays on the main thread; the main thread is also
where the consumer runs, and that is a real difference from the driver's event thread.

**Where the main thread's time goes (measured in this page, no hardware).** `append()` into
the 32-channel interleaved store costs 1.8-1.9 ms per 3,129,344 B warm (1.7 GB/s), i.e. ~49 %
of one core at 800 MB/s. The level-1 mask pass is most of it: unrolling the 16-word OR/AND
loop exactly reproduces the pyramid but saves nothing, and skipping pyramid levels 2-6 saves
only 0.3 ms (16 %). Both variants were checked bit-identical against the stock pyramid.
Conclusion: the store is expensive but is not the thing that caps the link - the earlier
"Chromium delivers 500 MB/s" numbers were taken with a counting sink that does no per-sample
work at all.

**Open question for the next hardware session.** Is the ~500 MB/s ceiling a Chromium
per-transfer latency (fixable with a different geometry: 4 x 3,907,584 B, 8 x 1,953,792 B,
16 x 976,896 B - all inside the same 15.6 MiB queue budget) or a bandwidth ceiling in the
browser's usbfs path (in which case 32ch@200M is out of reach without raising
`usbfs_memory_mb` and queueing deeper, and the browser's honest maximum on this device is
32ch@100M)? `/tmp/lwapp/hwprobe.sh` answers it: native reference run first, then the browser
sweep with `transferMs`/`rearmMs`/`sinkMs`/`maxIdleGapMs` percentiles and per-process CPU
sampling, then the same capture driven through the real UI.

### 8.1 The second capture of a session, 2026-09-10

Bench report: the first capture is fine, the next one dies with
`Failed to execute 'transferIn' on 'USBDevice': A transfer error has occurred.` Two
different states produce that message and only one of them is recoverable in the page.

1. **The bulk pipe is left in Chromium's error state.** Stopping a capture whose reads are
   still parked forces cancellation, which releases the interface under those reads. Every
   later `transferIn` on that handle then fails immediately until the endpoint is cleared.
   `start()` writes `CTRL_STOP` and calls `clearHalt('in', EP2)` before arming, and
   `offline-test.ts` now proves that is load-bearing: with the clear removed, capture #2
   gets no data at all. The fake endpoint models the post-release state
   (`FakeStreamDevice.poisonEndpointOnRelease`), so the regression is deterministic.
2. **The device is wedged.** Then `transferIn` fails on the first call after RUN as well,
   `libsigrok` gets `LIBUSB_TRANSFER_ERROR` on every URB, and neither a kernel-level
   `usb_reset_device` (`usb_reset_and_verify_device`: port reset, re-address, re-configure -
   the two `reset ... device number 83` lines at 16:57 and 17:05) nor the driver's own
   `CTRL=reset` pulse brings the endpoint back. Only a power cycle does. Confirmed on the
   same board from both hosts on 2026-09-10, which is why the underrun watchdog above
   aborts early rather than streaming at half rate.

The watchdog had a false positive of its own, found while adding the case above. The
driver compares each URB's duration against `per_transfer_nbytes / expected_rate_MBps`;
this page measures the same thing over a window, but a window that starts at the previous
healthy completion is only one transfer long, and one transfer's worth of device time is
0.03 ms for a 1 KiB lane at 16ch/16 MHz. The promise hop and the re-arm (~0.04 ms) then
read as a 19% shortfall for `depth` completions in a row, and a capture that was never
behind aborted itself. `WATCHDOG_NOISE_ALLOWANCE_MS = 0.25` covers the completion path
without covering the 37% gap it has to catch at 32ch/200 MHz (it is ~3% of one 3.1 MB
transfer at 800 MB/s). The allowance is additive, not multiplicative: a fixed 1 ms
slipped the 4ch@5 MHz case, where the whole window's expected duration is 1.6 ms.

### 8.2 What actually wedges the board, measured 2026-09-10

Three captures and one accident on the recovered board (device 084, `usbfs_memory_mb=16`):

| run | result |
|---|---|
| `sigrok-cli 200m 12s` | rc=0, 9.6 GB, 796 MB/s, 3068 transfers (3,129,344 B each, depth 5) |
| `sigrok-cli 200m 12s` (second run) | aborted after 0.04 s, 25 MB, `average 721.63MBps (minimum 760.00MBps)`, `12 consecutive slow transfers` |
| `sigrok-cli 200m` (third run, killed at 6.98 s by the harness) | was at `805.70MBps` instantaneous, `799.84MBps` average when it died - and every later run from either host read 0 bytes |

**The wedge is caused by stopping the host while the device is still producing, not by a
slow host.** `SIGTERM` to a streaming `sigrok-cli` discards its URBs at process exit and
there is no chance to write `CMD_STOP`, so the device keeps pushing into an endpoint
nobody reaps, its FIFO overruns, and every later `transferIn` fails immediately
(`LIBUSB_TRANSFER_ERROR`/EPROTO) until the board loses power. Nothing else was running in
the twenty minutes before that: the runaway is the cause, and it reproduces on the native
driver, which the project had been treating as the reference for "stable".

This is what a browser tab reload or a closed tab during a capture does too - `vite` hot
reload included. `SLogic16U3.stop()` therefore has to reach `CMD_STOP` on every path a
page can control, and a page that is *destroyed* mid-capture cannot be protected from
inside JavaScript. The app can only avoid leaving a capture running when it does not have
to.

**The native driver can abort itself at start-up.** The second run stopped after 0.04 s on
its own watchdog: `duration 1.460ms (limit 5.085ms), rate 2143.39MBps (minimum
560.00MBps), average 721.63MBps (minimum 760.00MBps), 12 consecutive slow transfers`,
having received 25,034,748 B. The limit in that message is
`(1 + TRANSFERS_DURATION_TOLERANCE) * expected_transfer_duration` = 1.3 x 3,129,344 / 800,
so that run used the same 3,129,344 B lanes as the healthy one, and 25,034,748 + 4 is
exactly 8 of them. The per-transfer rate was never low - it was bursting at 2.1 GB/s - but
the *average since RUN* was 721 MB/s and `average_rate < expected_rate * 0.95` is one of the
three trip conditions. It needed 12 consecutive windows to fire, and the threshold is
`timeout_count_limit = num_transfers_used` (protocol.c:434) with a nominal depth of 5, so
that run had armed more of them than the healthy run did. The surviving log does not show
why. The driver's answer to staying behind is the same as this transport's: abort. But a
12-window threshold also means a start-up ramp can be enough to reach it, which is why the
arm/abort rule here skips the first `2 * depth` completions.

**`USBDEVFS_RESET` can remove the device instead of reviving it.** The 16:57 and 17:05
resets re-enumerated device 83 in place (`reset SuperSpeed Plus Gen 2x1 USB device number
83`) and changed nothing about the wedge. The one run against device 84 did not
re-enumerate: the ioctl returned `ENODEV` and the kernel logged `usb 2-1: USB disconnect,
device number 84`, i.e. the board failed to come back at the end of the reset. A physical
power cycle is still the only recovery.

### 8.3 How much of the main thread the page's own pipeline costs, 2026-09-10

Measured without hardware by injecting a device into `window.logicweb.device` that produces
one 3,129,344-byte chunk every 3.911 ms regardless of what the main thread is doing - the
board's behaviour at 32ch/200 MHz - and letting the real capture path (the store the app
chooses for 32 channels, the rAF plot, the panels) consume it. `/tmp/lwcdp/pipeline2.js`.

| stage | p50 | p95 | max | budget |
|---|---|---|---|---|
| `sink()` -> `InterleavedSampleStore.append` | 2.2 ms | 7.6 ms | 10.3 ms | 3.91 ms per chunk |
| rAF callback (JS only) | 0.7 ms | 1.2 ms | 3.3 ms | - |
| gap between chunks as seen by the producer | 48 ms | 69 ms | 80 ms | 19.5 ms (5 x 3.13 MiB) |

The store costs ~56% of one core at 800 MB/s and keeps up on average, with no headroom for
anything else on that thread. The rAF *callback* is cheap; the 40 ms per frame is the
software rasteriser in this headless browser (SwiftShader), which then delays every other
task on the renderer's main thread. That makes the last case an artifact of the test
environment rather than a property of the page - but it also means the browser sweep has to
be read with the UI idle (as `probe-geometry.js` does) and its final real-UI run has to be
labelled environment-limited, because a live capture in this headless page redraws 32
channels through software WebGL on every frame.

### 8.4 R32_FLAG: the reset does clear a FIFO overflow, 2026-09-10

The vendor protocol spec (`USB LA 协议规范`, REGISTER MAP / R32_FLAG) settles what neither this
transport nor libsigrok ever implemented:

* `0x08 R32_FLAG`, bit 1 `RB_FLAG_FIFO_OV` is **RW1** - write 1 to clear - with a reset value of
  **NA**, i.e. an event latch rather than a configuration field.
* The conditions for bit 0 `RB_FLAG_RDY` include `RB_FLAG_FIFO_OV == 0` and
  `RB_FLAG_INNER_ERR == 0`, and the spec makes RDY a precondition for setting `RB_CTRL_EN`.
  The R32_CTRL entry adds that a module reset "needs R32_CTRL and every later register written
  as well", so the register file is the host's job, not the reset's.
* libsigrok defines `SLOGIC16U3_R32_FLAG` (api.c:906) and never reads or writes it;
  `slogic16U3_remote_reset()` (api.c:965) writes only R32_CTRL. This transport had no `0x08`
  handling at all before this change.

What the transport now does: read `R32_FLAG` after the open-time reset and again before every
`CTRL_RUN`, and write the single W1C bit only when the overflow is actually set, then read back
and trace the result. A healthy board gets no write at all (covered by a negative-control test).
The read is diagnostic and never fatal: a device that does not answer `0x08` is left exactly as
it was, because refusing to capture is worse than capturing without a status report.

**Measured on hardware, S/N 202608052052, 2026-09-10 18:05.** The board had just re-enumerated
(`2.86`) and read `FLAG=0x00 RDY=0 FIFO_OV=0 INNER_ERR=0 CTRL=0x0000`. Then, over raw control
transfers only (`/tmp/lwapp/flagprobe.py`, no bulk reader anywhere):

```
CTRL=1 (RB_CTRL_EN) +2.5 s   FLAG=0x02  RDY=0 FIFO_OV=1 INNER_ERR=0  CTRL=0x0001
CTRL=2 (RB_CTRL_RST)         FLAG=0x00  RDY=0 FIFO_OV=0 INNER_ERR=0  CTRL=0x0002
CTRL=0 (de-assert)           FLAG=0x00  RDY=0 FIFO_OV=0 INNER_ERR=0  CTRL=0x0000
write FLAG=0x02 (W1C, clear) FLAG=0x00  (already clear; no error, no change)
```

Three things follow, and the first one contradicts the hypothesis this feature was built on.

1. **CTRL.RST clears the latch.** Enabling the module with nobody reading is enough to set
   `RB_FLAG_FIFO_OV` - the device produces into its FIFO with no host involvement - and one write
   to R32_CTRL took it straight back to 0. So a board left wedged by an earlier run is *not*
   explained by an overflow bit that survives a reset, and the "first capture fine, second one
   fails" failure needs another mechanism. The one still standing, and already fixed on the host
   side, is Chromium leaving the bulk endpoint in an error state after `releaseInterface()` with
   reads queued (NOTES 8.3; `start()` clears the endpoint before arming every run).
2. **`RB_FLAG_RDY` never asserts.** (Superseded by 8.8: it *does* assert, `FLAG=0x01`, once the
   firmware is in the state the raw-upload test leaves behind - so the bit means something, it just
   does not gate the sampler.) It read 0 in every state observed above, and also on the
   healthy idle board with `FUNC_SEL=1`, `FIFO_OV=0` and `INNER_ERR=0` - every condition the spec
   lists. Whatever this firmware means by RDY, the spec's list is not it, and nothing in this
   transport may gate on it. The offline `FakeSlogic` models RDY the way the spec describes it,
   which is more optimistic than the hardware; that is harmless only as long as no capture path
   reads the bit, and none does (it is printed, never tested).
3. **The overflow indication is not immediate.** 800 MB/s into the FIFO should overflow in about
   10 ms; the bit was still 0 at +2.0 s and set at +2.5 s. Either the firmware reports the
   overflow late or the engine does not start producing instantly after `RB_CTRL_EN`. Not worth
   modelling - it only means this is not a fast overflow detector.

The W1C write stays as the belt to the reset's braces: one control transfer, only when the bit is
set, on a path no healthy board touches. What is not yet measured is the state a *real* wedge
leaves behind - the earlier evidence for it (all five transfers failing with
`LIBUSB_TRANSFER_ERROR`, `/tmp/lwapp/dbg.log`, 17:23) was collected without ever reading R32_FLAG,
and reproducing it costs a replug. The procedure is in place for the next time it happens:
`flagprobe.py status` while wedged, then `reset`, then `clear`, then a capture.

### 8.5 The data path keeps up at 32ch/200M when the device clock is the only clock, 2026-09-10

Every offline device in this repo fired when the *host* asked it to. Nothing modelled the one
thing that decides this question: the board produces bytes whether or not the host is ready, so a
host keeps up only by keeping `depth` reads submitted. `src/device/bench-rate.ts` adds that clock
- it completes the k-th submitted read at `t0 + k * chunk / lineRate`, i.e. the data is already
waiting when the host is late - and reports the device FIFO occupancy the arrangement implies,
`produced - delivered - queued`. That last number is what the real board overruns on.

| plan (1 s, 32ch @ 200 MHz, 800 MB/s offered) | delivered | steady | sink p50/p95 | modelled FIFO | aborted |
|---|---|---|---|---|---|
| A pipe only, ingest discarded | 812 MB/s | 800.7 | - | 0.0 MiB peak | no |
| B pipe + the shipping 32ch InterleavedSampleStore | 813 MB/s | 800.0 | 1.79 / 2.29 ms (of 3.91) | 0.0 MiB peak | no |
| C B + 20 ms main-thread stall every 250 ms | - | - | - | - | yes |
| D B + 40 ms main-thread stall every 250 ms | - | - | - | - | yes |
| F A + 2 ms of completion delivery latency | 810 MB/s | 798.4 | - | 1.5 MiB peak | no |

What this does and does not say. It says the transport and the store are not the ceiling at
32ch/200M: with no browser in the path they run the full line rate, the queue stays `depth` deep,
and the modelled FIFO never holds a byte - the store costs 46-59% of the 3.91 ms per-chunk budget.
It also says a *sustained* 8% shortfall (plan C) is fatal and the capture is right to abort: even
with a full queue, producing 800 MB/s and draining 736 MB/s fills 23 MiB of buffer in about a
third of a second. Plan F is the control that keeps the watchdog honest: 2 ms of delivery latency
does not move the measured rate at all (a constant offset cancels between completions), so the
watchdog is reacting to rate, not to latency. What none of this can say is what Chromium's
`transferIn` costs or how the renderer's own scheduling behaves, which is what the `bench`
console command measures on hardware.

**The watchdog was not the driver's.** `readLoop` claimed to reproduce protocol.c:149-171 and
instead held a sliding `depth`-transfer window to 0.95 of the line rate - a 5% dip across five
transfers aborted a capture that libsigrok would have finished, since the driver's own five-percent
floor applies to the whole-run average (`average_rate < expected_rate * 0.95`) and its per-URB
conditions are 1.3x on duration and 0.7x on rate. The transport now applies the driver's
conditions: one transfer over `1.3 * expected + 0.25 ms` is slow, or the average since the first
`2 * depth` transfers is under 0.95 of the line rate, and `depth` consecutive slow transfers abort.
For a full-length transfer the driver's 0.7x rate test is the same statement as 1.43x on duration,
so the 1.3x duration test subsumes it; short reads are excluded because a short read is successful
data, not evidence of falling behind. The anchor skips start-up, which is the one deliberate
softening - the driver's average starts at RUN, and 8.2 records it aborting itself for that reason.

### 8.6 An overrun kills the bulk endpoint, and nothing short of a replug brings it back, 2026-09-10

> The title's "kills the bulk endpoint" is wrong - 8.8 measured 462 MB/s through EP 0x82 on a
> wedged board with the vendor's raw-upload test mode. The wedge is the sampling path, and it does
> survive every recovery but a replug.

The question 8.4 left open is what a *wedged* 32U3 actually is. It was reproduced deliberately, on
S/N 202608052052, with control transfers only - no browser, no libusb, nothing but `flagprobe.py`:

```
18:05  healthy, freshly enumerated      FLAG=0x00 CTRL=0x0000, bulk pipe never touched
18:05  CTRL.EN=1 with no reader, 2.5 s  FLAG=0x02  (RB_FLAG_FIFO_OV set by the overflow)
18:05  CTRL.RST=1, then CTRL=0          FLAG=0x00  (the reset does clear the latch)
18:16  browser capture, 32ch@200M 12 s  0 bytes, every transferIn fails
18:18  raw pyusb read on EP 0x82        [Errno 5] Input/Output Error, immediately
```

So the sequence "let the device produce with nobody draining it" leaves something behind that
outlives the register reset, but it is *not* the flag the spec documents, and it is not a state any
host-side call recovers from. All of the following were tried while the board was in this state,
each read back `FLAG=0x00`, and none of them brought the endpoint back:

* `CTRL.RST` and a follow-up `CTRL=0` (the reset `open()` performs), plus a fresh `open()`.
* `USBDevice.clearHalt('in', 2)` - which in this Chromium takes `(direction, endpointNumber)`,
  the opposite order from the WebUSB IDL in the TypeScript build's `lib.dom`, and returns ok.
* `USBDevice.reset()`, i.e. a USB port reset, followed by `close()`/`open()` and a re-claim.
* `USBDEVFS_RESET` on the usbfs node directly (`/tmp/lwapp/usbreset.py`), which is the same
  port reset without Chromium in the path. The device has no alternate setting to cycle either:
  interface 0 offers only setting 0.
* A native `sigrok-cli` run from a different process, with the page's device released first: it
  claimed the interface and configured the device, then stopped short of the bulk stage on its own
  vref write-back check (the read returned exactly what it wrote, so that check is worth a look
  separately on a healthy board).
* A raw `pyusb` `read(0x82, ...)` - the one test that reads the endpoint directly: `[Errno 5]
  Input/Output Error` on the first call, with `RB_CTRL_EN` set and the FIFO_OV bit clear.

Every diagnostic path still works while it is like this: the device stays enumerated, control
transfers answer, `R32_FUNC`/`R32_CTRL`/`R32_FLAG` read back normally, and `RB_FLAG_INNER_ERR` is
0. Only bulk IN is dead, and only a replug clears it. That is the "first capture fine, second one
fails" failure, and it is a hardware/firmware condition rather than a Chromium one - which is why
`clear-fifo` cannot be the fix even though the flag it clears is real. The measured protection is
prevention: stop the host from falling behind before the FIFO overruns, which is what the watchdog
in 8.5 does, at the driver's own thresholds.

What this does not yet say is how little it takes to overrun. 8 MiB of FIFO at 800 MB/s is ~10 ms,
and `depth` queued URBs are what stand between the device and that cliff, so the browser's stop
path - which stops re-arming first and writes `CTRL_STOP` once the queue drains - is the place to
look next. The instrument is `bench` (8.5) against a real capture, and the comparison is the
native run that has already held 32ch@200M for 12 s at 796 MB/s.

### 8.7 The browser aborts 32ch/200M at 57% of the line rate, and the abort is what kills the board, 2026-09-10

The first browser measurement on a board that had just re-enumerated (device 089, `FLAG=0x00`, the
page's own transport, shipping geometry 5 x 3,129,344 B, counting sink so the UI costs nothing):

```
32ch@200M, 12 s requested   19 transfers, 59.5 MB, steady 458.7 MB/s of 800 (ratio 0.573)
                            transfer interval p50 5.8 ms, p95 13.1 ms (limit 5.33 ms)
                            peakQueuedTransfers 5, maxIdleGapMs 0, sink p95 0.3 ms
                            aborted: "5 consecutive transfers ... 452 MB/s average over 35 ms"
after the abort             FLAG=0x00, raw pyusb read(0x82) -> [Errno 5] Input/Output Error
```

So the board went from healthy to the wedged state of 8.6 in one 200M capture, and the recovery is
a replug (8.8: the pipe itself stays healthy; it is the sampler-to-upload path that dies). Two things follow.

**The browser does not put `depth` transfers on the wire.** The device fills a 3,129,344 B request
in 3.91 ms at 800 MB/s, so completions cannot arrive faster than that; 5.8 ms p50 (and 6.8 ms over
the run) means the effective kernel queue is about one deep, with roughly 3 ms of host turnaround
added to each transfer. `maxIdleGapMs = 0` says the queue never emptied, so this is not the device
waiting on an empty queue - it is the host handing back one URB at a time. That also explains the
wedge: when the device finishes a request it has no next one to fill for ~3 ms, and unless the FIFO
holds 2-3 MB of that, it overruns. The instrument for the next session is `bench` (8.5) - the same
capture with no sink at all - plus a geometry sweep to see whether a different depth changes the
rate or whether Chromium serializes submissions.

**The abort had to stop being destructive, and it was not.** Three changes, all in teardown, none
of them the fix for the rate:

* A failing read loop now writes `CTRL_STOP` itself, before its caller's `stop()` runs. The loop
  has stopped replenishing by then, and the driver's own abort path stops the device too, as soon
  as its cancelled URBs are reaped (protocol.c:199-232). The write has to happen from the failure
  handler, not from the completion path: an extra async control transfer inside the completion
  callback reorders the browser's batches enough to change what the watchdog sees (a direct
  measurement, not a theory - the offline abort test stops tripping when it is moved there).
* `stop()` writes `CTRL_STOP` *before* waiting for the queue to drain, instead of after. Waiting
  first leaves the device producing with nothing queued while a control transfer makes its way
  through Chromium, which is exactly the overflow window. The old order came from an observation
  that `CTRL=0` before the drain left the endpoint returning EIO, but that measurement also had
  `releaseInterface()` immediately behind the stop write, and releasing is the only way WebUSB can
  cancel a transfer - so the release, not the early stop write, is what that observation is about.
  Release stays in the exceptional path.
* The drain deadline is now progress-based: `stop()` waits for the loop as long as transfers keep
  completing and gives up `STOP_TIMEOUT_MS` after the last one, rather than cutting off a drain
  that is still delivering.

**Not yet measured:** whether 32ch/100M (400 MB/s) is inside the browser's ceiling, and whether the
geometry sweep moves the 458 MB/s. Both need the board back on the bus, and the native reference
(796 MB/s, same board, same 12 s) is the number to compare against.

### 8.8 A wedged 32U3 is the sampling path, not the flag and not the pipe, 2026-09-10

The board was still on the bus from 8.7's abort (device 093, S/N 202608052052, page released, no
replug in between), so the procedure 8.4 asked for ran for real, plus the one control the project
had never used on a wedged board: the vendor's aux `0x05` test-mode raw upload. Everything below is
raw control transfers and raw bulk reads (`/tmp/lwapp/{flagprobe,overflow-test,stuck-probe,isolate,survey,usbreset2}.py`),
except the two rows marked "the page".

```
18:32  nothing touched yet                      FLAG=0x00 RDY=0 FIFO_OV=0 INNER_ERR=0  CTRL=0x0000
18:33  32ch@100M: EN=1, 400 ms of reads         0 B, every read times out, no error
18:33  CTRL.RST=1 then CTRL=0, EN, read         0 B
18:33  write FLAG=0x02 (the W1C), EN, read      0 B          (the bit was already 0)
18:33  clearHalt(in, 2) ok, EN, read            0 B
18:33  full re-configure (channels, rate, vref) 0 B
18:35  EN=1, read CTRL back                     0x0001       (the write lands)
18:35  EN=1 with no reader, read FLAG           0x02         (RB_FLAG_FIFO_OV does set)
18:35  aux 5 = 1 (raw upload), EN=1, 300 ms     138,936,320 B in 301 ms = 462 MB/s
18:36  aux 5 = 0, EN=1, first read              [Errno 5] EIO after 3.8 ms
18:38  1 / 10 / 100 MHz x 1 KB / 4 KB / 64 KB   every read [Errno 5] EIO in 3.4-3.8 ms
18:39  register dump                            FLAG=0x01 RDY=1 CTRL=0x0000 AUX sel 3
18:41  the page: 32ch@100M capture              transferIn NetworkError
18:41  the page: testMode 1 (raw upload)        transferIn NetworkError as well
18:44  libusb reset_device on the wedged board  "Entity not found"; gone from the bus, 20 s later still gone
```

**What the flag question actually answers.** `RB_FLAG_FIFO_OV` is real and it does set - the spec's
"自动清零" is what the hardware does, so the bit is a momentary event rather than a latch, and no
amount of polling makes it a wedge detector (8.4 point 3 sharpened: at 1 MHz it never set in 3 s, at
10 and 100 MHz a 0.5 s poll caught it at +2.0 s; a second run caught the same overflow at +2.5 s).
On the wedged board the bit read `0x00` before any recovery attempt and `0x00` after `CTRL.RST`,
after the W1C write, after `clearHalt`, and after a full re-configuration. So:

* RESET clearing the bit - confirmed, twice over (`CTRL.RST`, and any `CTRL` write with EN=0).
* RESET not restoring the board - confirmed. It is not because the bit survives it; the bit never
  survives anything, and it is not set in the state that is broken.
* Clearing the overflow flag restoring normal use - **falsified**. This transport already writes the
  W1C bit whenever the flag is set (`settleFifoOverflow`, plus the console's `clear-fifo`), and the
  wedged board does not care. There is nothing to add here.

**The endpoint is not dead, and 8.6/8.7 said it was.** `aux 5 = 1` is `RB_TEST_DUPLOAD`, "裸数据直接
输入 USB, 不经过采样逻辑, 可以测试 USB 最大速率" - raw bytes to the USB engine, bypassing the sampler
- and on the wedged board it moved 462 MB/s through EP 0x82 with no errors. So the pipe, the PHY,
the host controller and the 256 KB read pattern were all fine while a capture could not get a single
byte. What is broken is the sampling path into the upload engine; the earlier "dead bulk endpoint"
reading came from only ever testing the one path that was broken. The 462 MB/s is also the first
number above 8.7's 458 MB/s measured on this board through a plain reader, so it is a useful second
opinion on where the browser ceiling is (it is not the pipe).

**Two wedged signatures, and they are not the same state.** W1 is what the 18:30 browser sweep left:
`EN=1` and every read times out, no data and no error, which is what the page reports as a 0-byte
capture that says nothing is wrong. W2 is what the board was in by 18:36: every read fails with
`[Errno 5]` in 3.5 ms, at any sample rate and any buffer size, and the page reports it as
`transferIn` `NetworkError`. W2 appeared after the raw-upload run and after one deliberate 2.5 s
`EN=1` with no reader at 100 MHz, and it did not un-appear for the rest of the session. Both are
terminal for the host. Whether W1 -> W2 is *caused* by the raw-upload run or by the unread overrun
is not measured; the raw upload is the only thing that ever put bytes on the wire in either state,
so it is worth a look on a healthy board before anyone reaches for it as a recovery trick.

**A port reset on a wedged 32U3 removes the device.** `libusb_reset_device` returned `Entity not
found` and the analyzer left the bus without re-enumerating (still gone 20 s later; the hub port
stays empty). 8.6 recorded `USBDevice.reset()` as "tried, no help" - the sharper statement is that
on a *wedged* board the reset does not come back to a usable state, it does not come back at all.
Nothing but a physical replug brought this board back, and `USBDevice.reset()` in the page is a
call that can leave the user with a device they then have to unplug anyway.

**Where the wedge actually is, and what is left to measure.** The trigger both the driver and this
transport agree on is the device producing into a FIFO nobody drains (8.2), and the vendor's own
answer to it is `R32_SAMPLE_LEN` (aux 4), whose stated purpose is to stop the upload *before* the
host's stop command can arrive late. That register is exactly what is not used by any capture path
here or in libsigrok. The measurement that decides whether it is worth wiring in is how many bytes
the device sends for a given `R32_SAMPLE_LEN` value - it reads back raw and the unit is only
documented as "kSamplesByte" - and it needs a healthy board, because every question left open by
8.7 and 8.8 is on the other side of a replug:

1. Does `R32_SAMPLE_LEN` make the device stop by itself, and at what value does it stop at the
   capture length the host asked for?
2. Does a 2.5 s unread `EN=1` wedge a *healthy* board (the controlled version of 8.2's accident)?
   If yes, the whole class of "stop the reader, then tell the device" designs is out, and the
   device-side length limit is the fix rather than a refinement.
3. Does 32ch@100M (400 MB/s) fit inside the browser's ceiling (8.7), with the raw-upload ceiling
   measured at 462 MB/s through a single reader loop?

### 8.9 R32_SAMPLE_LEN makes the device stop itself, and it is the first thing that survives, 2026-09-10

The 8.8 procedure's questions were run on a replugged board (S/N 202608052052, device 094, fresh
enumeration, raw pyusb only unless marked). Two of them answered themselves immediately.

**The samplerate divider is 8 bits wide, and 5 MHz is a lie on a 32U3.** The device comes out of
enumeration with `R32_CTRL=0x0002` (`RB_CTRL_RST=1`) and the aux engine does not answer until that
is cleared - the first attempt read `aux 0x02 = 0x00000000`, base 0 MHz, for exactly that reason,
which is worth knowing before anyone reads a register out of a reset board. With the reset
de-asserted the aux table is `idx 0 = 1400 MHz, idx 1 = 800 MHz` (the driver's two-index walk).
Writing the divider and measuring the delivered byte rate at 32ch:

| wrote | divider read back | offered | measured |
|---|---|---|---|
| 50 MHz | 27 | 200 MB/s | 199.9 MB/s |
| 20 MHz | 69 | 80 MB/s | 80.0 MB/s |
| 10 MHz | 139 | 40 MB/s | 40.0 MB/s |
| 8 MHz | 174 | 32 MB/s | 32.0 MB/s |
| **5 MHz** | **279** | 20 MB/s | **233.2 MB/s = 58.33 MS/s = 1400/24** |

279 read back as 279 - the register holds 32 bits - but the *sampler* used 279 & 0xFF = 23, i.e. a
divider of 24. So the divider is truncated to its low byte somewhere past the host, and the smallest
rate a 1400 MHz base can express is 1400/256 = 5.47 MHz. The 16U3's base is 800 MHz, where 5 MHz is
divider 159 and fits, so this has never shown up in the driver or in this project's tables. On a
32U3 the 5 MHz entry in `SAMPLERATES_HZ` silently delivers 58.33 MHz. The fix is to walk to the next
base index when the divider does not fit a byte, which `configureSamplerate` already has the shape
for - it only asks whether the base divides the rate, never whether the quotient fits.

**R32_SAMPLE_LEN is real, and one unit is 1024 samples.** aux 4, 32ch, 50 MHz base, with the reads
left running until the device stopped on its own:

| written | bytes delivered | bytes / value | samples / value |
|---|---|---|---|
| 500 | 2,039,808 | 4079.6 | 1019.9 |
| 1000 | 4,087,808 | 4087.8 | 1022.0 |
| 2000 | 8,183,808 | 4091.9 | 1023.0 |
| 100000 | 409,591,808 | 4095.9 | 1024.0 |

All four are exactly `value * 4096 - 8192` bytes at 32ch, i.e. `value * 1024 - 2048` samples, and
every count is a whole number of 1024-byte packets. So:

```
device_samples(value) = value * 1024 - 2048        value = (samples + 2048) / 1024
```

The 2048-sample offset is a constant, not a per-rate effect (it is 8192 bytes in all four rows and
in the 5 MHz rows of the first attempt), which reads as a fixed pipeline delay in whatever counts
samples for the stop. `R32_SAMPLE_LEN=0` means "no limit" and the device then streams until the host
stops it, which is the behaviour every existing capture path in this repo and in libsigrok relies on.

**The payoff: six consecutive 32ch@100M captures, 100.00% of the requested length, every one of
them stopped by the device rather than by the host, and the board was still healthy after all six**
(`/tmp/lwapp/limited.py 6 100 2`, value = 195,315 per capture):

```
#1..#6  800,006,144 B of 800,000,000 (100.00%), 3052 transfers, ~2.8 s each,
        first byte 1 ms after RB_CTRL_EN, self-stop, FLAG=0x00 before and after every capture
```

Before this, nothing in this project had ever run a second 32ch capture on this board without the
endpoint dying; 8.7 measured the browser aborting one after another. The difference is exactly what
the vendor's register documentation says it is: the device stops producing at the capture length, so
the window in which the host can be late with `CMD_STOP` does not exist. The host's own tail reads
after the device stops are NAKs, which are free.

**Nothing here is measured through the browser yet.** The 6/6 run is pyusb with 262,144-byte reads;
Chromium's `transferIn` cadence (8.7: about one URB deep, ~3 ms of host turnaround per completion) is
the next thing that has to hold at 400 MB/s, and it is the difference between "the page works" and
"the page still aborts and now leaves the board producing". The three integration questions are
therefore: what value to program (the head drop this transport applies before the first delivered
byte counts towards the device's total), what to do in software-trigger mode, where the capture
length is not known when the device is armed, and whether the watchdog must stand down once the
device has stopped on its own instead of reading the missing tail as an underrun.

**200 MHz is not fixed by any of this, and it took the board down again.** Three captures at
32ch@200M with the limit programmed: #1 delivered 0 bytes in 602 ms, #2 delivered the full 1.6 GB
(100.00%, 6104 transfers, 3967 ms), #3 delivered 0 bytes. Four more attempts with the first-byte
time instrumented gave 0 bytes each, one of them with `RB_FLAG_FIFO_OV` set while `RB_CTRL_EN` was 1
- the sampler was producing into a FIFO whose contents never reached the host. A 32ch@100M run
afterwards, which had just been 6/6, then delivered 0 bytes three times in a row: the board was
back in 8.8's W1 (reads time out, no error, no data) and needed a replug. So the 200M case is still
the FIFO-overrun cliff of 8.2/8.7, and the device-side limit does not protect against it: the limit
stops *production*, but the overrun here happens because the host is behind while the device is
still producing, which is a transport-rate problem before it is a stop-ordering problem. The
browser has measured 458 MB/s of the 800 MB/s offered (8.7), so 200 MHz at 32 channels is out of
reach for this host path until something changes in the read cadence - and as long as it is out of
reach, asking for it is asking for a replug.

### 8.10 The device-side limit armed correctly in the page, and the capture still wedged, 2026-09-10

The feature from 8.9 was wired into the shipping timer path (`deviceSampleLimit`, programmed as
aux 0x04 before `RB_CTRL_EN`) and then driven through the page (`/tmp/lwcdp/limit-sweep.js`, 32ch @
100 MHz, 2 s per capture, four captures in a row, the real 32-channel store, no simulated device).
The programming is exactly right - the device layer traced
`device sample limit armed: R32_SAMPLE_LEN=195315 stops the device after ~200000001 samples`, which
is `ceil((2e8 + 1 head sample + 2048) / 1024)` - and it did not help, because the capture never got
near its length:

```
#2..#4 (200,000,000 samples requested)   14,082,047 samples stored, 0.25-0.5 s in
    aborted: "5 consecutive transfers: 5.10 ms for 3129344 B (limit 10.17 ms),
              330 MB/s average over 85 ms (minimum 380 MB/s)"
    steady 304.7-316.6 MB/s of 400, peakQueuedTransfers 3-5, maxIdleGapMs 0, 0 short transfers
after the aborts, raw pyusb 32ch@100M   0 bytes, every read times out, FLAG=0x00 -> board wedged again
```

So the limit protects the *end* of a capture, and none of these captures reached their end: the
page is 20% short of the line rate at 32ch/100M, the watchdog aborts, and the board wedges anyway.
The abort itself is not the dangerous part - it writes `CTRL_STOP` from the failing loop - the
dangerous part is that by the time any watchdog can react, the device has spent a fifth of a second
further behind than the host is draining, with a FIFO that holds a few tens of milliseconds of
stream. **Prevention has to be the host keeping up, not a stop that arrives after the fact.**

That makes the next measurement the one that decides the objective, and it is a measurement this
project already has the instrument for: `bench <seconds> <channels> <MHz>` (8.5) runs the same
transfers with the sink removed, and the last browser numbers on record are 383 MB/s with the real
store at 100M/32ch (8.7's sweep) against 399.6 MB/s with a counting sink at 16ch/200M - the same
400 MB/s on the wire. The difference between those two is the per-chunk cost of the 32-channel path
on the renderer's main thread, and `rs`/`bench` separate it into transport, store and rendering. In
a *headless* page the renderer is SwiftShader (8.3: 40 ms per frame for 32 channels), which is worse
than any real browser, so those numbers are a floor rather than the user's ceiling - but a floor
that wedges the board is still the right thing to measure first.

**Software-trigger captures carry no limit, by construction.** The trigger position is not known
before `RB_CTRL_EN`, and the search is unbounded (`searchLimitSamples: Infinity`), so a length
programmed at RUN would stop the capture before a late trigger arrived. `start()` therefore passes
no limit in that mode, and - because the register survives both `RB_CTRL_RST` and a page reload -
clears one an earlier capture armed, at `open()` (the first place a new session can look) and again
before RUN. The mid-capture protection that trigger mode does not get from R32_SAMPLE_LEN is the
same one every other path needs anyway: the host must not fall behind while it waits.

### 8.11 A read-back that says "verified" while the wire says otherwise, 2026-09-10

The complaint that started this one: on the page, 32ch at 100 MHz and 5 MHz alternating in a loop
(`/tmp/lwcdp/rate-reset-ab.js`), one capture in six came off the wire at the *previous* rate. Every
step traced `samplerate 5 MHz = 800 MHz / 160 verified`, and the capture that followed delivered
396 MB/s - the 100 MHz line rate - while the divider register read 159, which is 800/5 - 1. The
same loop with `CTRL=2` then `CTRL=0` before each configuration was 6/6, which is why the first
proposal was to reset before programming. That proposal is vetoed: the reset is not a register
writer, it drops the whole configuration with it.

**What the read-back can prove, and what it cannot.** `R32_AUX+4` is the device's aux scratch
buffer, so reading a register back proves that the host's word reached the buffer - not that the
live configuration follows. `/tmp/lwcdp/diag-rate.js` measured the two halves separately: after
each bench the payload read back exactly the divider that had just been written (`01 00 20 03 9f 00
00 00` for 5 MHz on the 800 MHz base) with the rate on the wire stale, so a read-back compare
inside the writing transaction cannot tell a landed write from a dropped live update. The device
has a live copy of this one register that the payload read does not show.

**What is done instead.** `configureSamplerate()` now runs the read -> write -> read cycle up to
`SAMPLERATE_WRITE_CYCLES` (3) times, each attempt in a *fresh* transaction, and confirms the winner
through one more complete command - the selector write is the aux command, and it is the only thing
the host can do that makes the device look at the buffer again. A read-back mismatch on either
count retries; a rate the device's base table cannot express still refuses immediately, because
repeating that walk can only repeat the same answer. If no cycle sticks, the capture fails with the
rate and the number of cycles named, rather than capturing at whatever rate the board was left on.

Cost: two extra control transfers (~1 ms) per capture. The failure mode has so far only been seen
right after a capture that ended badly, so the state to reproduce deliberately is "watchdog aborted
a capture, then configure the next one", not a clean alternation. On 2026-09-10 with this code in
place, `/tmp/lwcdp/rate-loop-fixed.js` ran 16 alternating 100 MHz / 5 MHz benches with no stale
step, no retry and no abort - which is a weaker result than it looks, because the retry never fired
(every first cycle landed). The deterministic versions of both halves live in `offline-test.ts`: a
device that swallows the first payload write (cycle 2 lands it), and a device whose live divider
only follows the buffer when the selector is written (`a second command is what makes the live
divider follow the payload`).

**Still unproven.** The confirmed command cannot move a live copy that is updated by something
other than the aux command. If a stale rate is seen again with the confirmation in place, the next
thing to measure is what else the firmware re-latches on - RUN being the obvious candidate - and
the honest fallback is a post-RUN rate check against `expectedBytesPerMs` rather than more register
traffic before RUN.

### 8.12 The shipping 32ch/100M capture walks into the store, and the store is on the pump's thread, 2026-09-10

The divider fix above did not change the page's own shortfall, and one capture through the real app
path says why (`/tmp/lwcdp/app-100m.js`: `app.debug.setSettings({channels:32, samplerate:100e6,
mode:'timer', seconds:1})`, then `app.debug.start()`, real 32-channel store, headless SwiftShader):

```
15 transfers, 11.7 M samples stored, 283.4 MB/s of 400 MB/s (ratio 0.708)
xfer p50 7.82 ms  <- exactly the line rate: the pipe itself is not short
5 consecutive transfers at 18.00 ms each -> "overran the host" abort
after the abort: 0 bytes from the bulk endpoint, from the page and from pyusb, FLAG=0x01.
The board is wedged and needs a replug (8.6).
```

The abort text is what a single ~90 ms main-thread pause looks like from inside the read loop: five
transfers were submitted before the pause and reaped after it, so all five measure 18 ms. The same
`bench` at 32ch/100M on this page sustains 386-393 MB/s with no sink at all (the 16-run alternation
in 8.11), so the transfer path, the device and the configuration are all fine; what is missing is
the time the capture spends on the main thread between two completions.

Where that time goes, measured in this page with no device (`/tmp/lwcdp/store-split.js`,
`store-stall2.js`): one 3,129,344 B append into the shipping 32-channel store costs 1.8 ms p50 and
3.5 ms max into an empty store, rising to 3.2 ms p50/5.6 ms p90 once the capture has filled a few
hundred MB, and 7.8 ms in the worst chunk of a one-second capture. About half of it is the memcpy
(0.9 ms p50) and the rest is the pyramid. At 100 MHz the whole budget between two transfers is
7.82 ms, so the store alone consumes 23-100% of it, on the same thread that has to re-arm the next
`transferIn`; at 200 MHz the budget is 3.9 ms and the store cannot fit at all.

Two consequences, and they are the reason this is not another register question:

- **A stall of ~40 ms is already fatal at 100M.** Five transfers in flight plus the device FIFO
  hold roughly 15.6 MB + a few ms, which is ~50 ms of line-rate slack; the renderer in this
  headless page is SwiftShader (8.3, ~40 ms per 32-channel frame), and GC on a 400 MB/s allocation
  stream can pause the same thread for longer than that. The watchdog aborts after the fact, but
  the overrun has already happened by then, which is why the board wedged.
- **The fix has to take work off that thread**, not tune the watchdog. Either the pump moves to a
  worker that owns the device (`/tmp/lwcdp/worker-claim4.js` shows a Dedicated Worker can
  `getDevices()`, `open()` and `claimInterface(0)` on Chrome 152, so the read loop would no longer
  wait for the renderer), or the append gets cheap enough to leave room for rendering - the memcpy
  floor of 0.9 ms p50 is what a deferred pyramid would approach. The first is architectural and
  removes the coupling; the second is a data-structure change that keeps the current shape.

### 8.13 R32_CTRL is verified by read -> write -> read, and never by RST, 2026-09-10

The directive that shaped this: registers get read, written and read back again, as many times as
it takes; CTRL.RST is not the tool, because it resets the module *and every register programmed
after it*. 8.11 had already vetoed the reset pulse for the samplerate bug for the same reason. This
is the same rule applied to the one register the transport was still firing blind.

**What R32_CTRL actually reads back.** Measured on S/N 202608052052 through pyusb, byte 0 returned
exactly what had been written, every time: `01`, `00`, `02` and back (`0x04` = `01000000`,
`02000000`, `00000000` on the wire). It is stable while the board is left alone for four seconds in
either state, and stable 120 ms after RUN (`01` for six reads). The `R32_CTRL reads 0x02000000` line
in 8.5/8.8 is a big-endian misread of those same four bytes: the register was not returning a
32-bit flag word, it was holding the *reset bit set*.

That last state is worth naming, because it is the shape of the wedge this transport spent the day
chasing - the board answers every control transfer and sends nothing on the bulk endpoint. A board
that has just been unplugged and plugged back in reads `CTRL=0x00`, so it is not the firmware's
power-on state; it is the state the driver's own open sequence leaves behind when the *second* write
of its `02` then `00` pulse is the one that gets lost. Seen once in this session: with the page's
HMR reload disposing the app in the middle of an open, the next control read of `0x04` answered
`02` while `FLAG` still read `0x00`.

**What changed.** `programCtrl()` in protocol.ts runs read -> write -> read, compares the read-back,
and repeats the cycle up to three times, exactly like the samplerate walk in 8.11. `open()` now
writes `CTRL_STOP` through it instead of the driver's `CTRL.RST` pulse, and `start()` verifies both
the `CTRL_STOP` and the `CTRL_RUN` it writes. A read that fails at the transport level is reported
and the write is still sent: the vendor contract is one 4-byte write, and no firmware should be
refused a capture because it cannot answer a read of `0x04`. `CTRL_RESET` stays in the register map,
marked as deliberately unwritten. The teardown path (`stopProducer`) keeps its unverified write on
purpose - verification costs two more control transfers and teardown is racing the watchdog.

**Why RUN is worth the two transfers.** A `CTRL_RUN` the firmware missed is indistinguishable from
the wedge above: the read loop arms, every transferIn comes back empty, and the no-data watchdog
reports a dead board half a second later. The verified write turns that into either a retry that
lands on cycle 2 or an error that names the register.

**Evidence.** Offline, four checks: `open()` clears a reset bit left set by an earlier session,
`open()` never writes `RB_CTRL_RST`, the CTRL write is read -> write -> read in that order, a dropped
`CTRL_RUN` is written again until it sticks (two writes, then `CTRL=0x01`), and a CTRL write that
never sticks fails the capture by name with no bulk read submitted. On hardware, with the board
staged at `CTRL=0x02` through pyusb and then opened by the real module in the page:

```
before: CTRL=02000000                                  (reset bit set, endpoint dead)
trace:  rd 0x4 | wr 0x4 | rd 0x4 -> "open: CTRL=0x00 verified"
after : CTRL=00000000
```

**Still unproven.** The read-back was measured while the bulk endpoint was wedged, so it is a live
mirror of the register in the stopped, running and idle states but not yet across a *streaming*
run: the next replug should confirm `CTRL` reads `01` all the way through a 32ch/100M capture. If a
running device ever answers something else, `programCtrl` retries twice and then fails the capture
naming CTRL and the cycle count rather than streaming from a board it cannot account for.

### 8.14 The consumer backlog is bounded by what is outstanding, not by what has arrived, 2026-09-10

8.12 says the shipping shortfall is the consumer, and the consumer is on the same thread as the
read loop. The first step out of that is letting the sink be asynchronous - the worker pump hands
each chunk to the page and waits for the ack - which means the read loop needs a bound on how far
the sink may fall behind before it stops refilling the USB queue. `StreamTuning.lagChunks` is that
bound, four `depth`s by default.

**The bound was wrong by a queue.** The first version checked `completed.size < lagChunks` before
the completing transfer was counted, and counted only what the consumer had not taken. The lanes
that were already submitted are just as much memory, and they all land afterwards. Measured with
`lagChunks = 8`, `depth = 4`: the backlog reached **12** - `lagChunks` plus the entire in-flight
queue - and the peak was only visible with a `process.env` trace inside `finish()`; the check that
was supposed to hold read clean. The rule is now on the sum, evaluated after the chunk is counted:

```
outstandingChunks() = completed.size + inFlight.size   // capped at lagChunks
canArm()            = inFlight.size < depth && outstandingChunks() < lagChunks
```

The refill moved from the transfer's `then` handler into `finish()`, one line after the chunk is
inserted and one line before `notify()` wakes the consumer. The throughput invariant 8.2 depends
on - replenish the queue before a completed buffer reaches consumer work - is unaffected, because
`notify()` only resolves a promise and the arm still runs in the same synchronous run.

**Two watchdog checks were measuring Node, not the device.** `offline-test.ts` had two checks that
failed about one run in six under load (`the underrun watchdog reports consecutive slow transfers`,
and the abort that follows it). The fake resolved each scripted `delayedData` from the moment the
call arrived, so when the event loop stalled, several completions were reaped in one task and every
one after the first measured ~0 ms - a device that looks fast is a device the watchdog must not
abort on, and one fast completion is enough to reset the consecutive-slow count. A real device
paces by its own clock, so the fake now schedules each delayed transfer `delayMs` after the one
before it (`nextResolveAt`), which survives a stall. 8 runs alone and 8 runs four-at-a-time with the
CPU loaded, all clean, against a failure rate that was ~15% before.

**Evidence.** Four new deterministic checks: a sink that stalls once at 256 KiB transfers reaches
exactly `lagChunks` and never more, the capture survives the stall instead of aborting, every chunk
arrives in the device's order with its tail intact, and the head drop still costs exactly four
bytes; plus a synchronous-sink control that the cap costs it neither a byte nor a transfer. The
existing check that the queue is replenished before the first synchronous sink callback still
passes, which is what says the refill move did not break the fast path.

### 8.15 Every control transfer now has a deadline, the way libusb's does, 2026-09-10

The driver hands libusb **500 ms** for every register read and write: `api.c:641` and `api.c:683`
pass 500 into `libusb_control_transfer`, and libusb cancels the URB when it expires. WebUSB has no
such parameter. `controlTransferIn`/`controlTransferOut` return a promise that settles when the
device answers, and a board that stops answering leaves that promise pending forever - with no
timeout, no error, and no way to cancel it from the page.

**Measured today.** A `start()` in the page sat in its first control read of `R32_CTRL` for more
than two minutes. `dev.running` was still false, `dev.stopping` false, no trace line, nothing in
`onError`, and the only way out was a page reload. The board had answered every one of those reads
in ~5 ms a few minutes earlier, so this is not a slow board: it is a board that stopped answering,
and the page had no vocabulary for it.

`CONTROL_TIMEOUT_MS` (2 s, `protocol.ts`) now bounds every `RegisterBus` read and write, and the
advanced console's raw `in`/`out` commands. Two deliberate properties:

* **It cannot retry.** A JS timeout does not cancel the underlying request - Chromium still holds
  the URB and will settle the promise whenever it likes. Retrying would stack a second request
  behind a transfer that may still be pending, so a timeout is reported and the caller aborts,
  which is what the driver does when libusb's 500 ms expires.
* **It is looser than the driver's 500 ms.** A WebUSB transfer crosses two extra process hops and a
  CPU-saturated capture must be allowed to delay a control transfer without being declared broken.
  Measured: a full `open()` sequence (CTRL, channel mask, samplerate, vref, flags) takes 5-30 ms in
  total, so 2 s cannot fire on a board that is answering.

The abandoned promise gets an attached no-op rejection handler, so the transfer Chromium settles
after the deadline cannot escape as an unhandled rejection behind an error the caller already has.
Six new deterministic checks cover it: read and write both fail at the deadline and not later, a
transfer that rejects after the deadline is reported and then swallowed, and an answering board
does not pay for the bound.

### 8.16 What today's board state says about the remaining 32ch/200M question, 2026-09-10

The board dropped off the bus during this session and needs a replug before anything else can be
measured. Recorded here so the observations are not lost:

* **`Failed to configure vref` is not a failure.** `api.c:1155` compares the vref read-back against
  the literal `1024`, which no sane threshold produces (the vref code is 226 for 1.6 V and 245 for
  1.7 V), so the driver prints that line on a healthy board too and carries on to `CTRL=RUN`. Every
  reference log in this session, healthy or wedged, contains it. Do not read it as evidence.
* **Pattern mode cannot stand in for a 200M drain measurement.** The pattern generator is a
  250 MB/s-class source, not a line-rate one: at a 200 MHz / 32ch configuration the page received
  ~500 MB/s (5 consecutive transfers of 3,129,344 B at 6.2 ms each), which is *below* the 800 MB/s
  that configuration promises, so the transport's watchdog correctly aborted the run. A pattern run
  measures the drain only where the pattern is faster than the configuration - which is why the
  earlier ceiling sweep used 100 MHz / 32ch (400 MB/s expected) rather than 200 MHz.
* **The depth this transport uses is the driver's own.** `usbfs_memory_mb` is 16 on this host, and
  the driver's allocation probe reports `Choose: receive 3129344 bytes per 3ms` followed by
  `Submited 5 transfers` - 5 x 3,129,344 B = 15.6 MB, i.e. the usbfs budget, not `NUM_MAX_TRANSFERS`
  (16). logicweb's `depth = 5`, `transferBytes = 3129344` is the same geometry for the same reason.
  Raising the budget is the lever that would allow more depth on both paths; it is untested here.

### 8.17 The consumer has two times the headroom the 200M line rate needs, 2026-09-10

Measured in the real page, with the real store and the real plot loop, no board involved: a fake
device handed the app's own `startCapture()` sink 200 chunks of 3,129,344 B back to back and each
call was timed.

```
chunks        200 x 3,129,344 B = 626 MB
sink          p50 1.90 ms, p95 2.50 ms, p99 4.60 ms, max 6.40 ms
throughput    1565 MB/s on the capture's own thread
budget        3.911 ms per chunk at 32ch/200M
```

So the store append is not what caps the shipping path: it uses **half** of one chunk's budget at
32ch/200M and has 2x headroom over the line rate. What it also does is spend that half on the same
thread the USB read loop needs, which is why the queue window - not the sink - is the thing to watch.

**The hypothesis this leaves, and why it fits every measurement so far.** The page services its event
loop every `E` ms; the transport survives a stall of up to `depth x transfer duration` because that
many URBs are outstanding. With `usbfs_memory_mb = 16` the queue is 15.6 MB - 5 x 3,129,344 B - no
matter how it is divided, so the window is **39 ms at 32ch/100M and 19.6 ms at 200M**. The browser
sustained 383 MB/s (0.957 of the line rate) for 3.9 s at 100M, where the window is 39 ms, and aborted
at 100M only when one transfer took 16.2 ms; at 200M it has never held the line rate at all. libsigrok
has no `E` worth the name: its 5 URBs are reaped and resubmitted on a dedicated libusb event thread
(`handle_events`, protocol.c:325), so the same 19.6 ms window is never exposed to the page's frame
loop.

Two consequences worth testing as soon as the board is back:

* **The queue window, not the consumer, is the lever at 200M**, and the only way to widen it is
  `usbfs_memory_mb` (the budget fixes `depth x transferBytes`, so re-slicing the same 15.6 MB changes
  nothing). Root can raise it; `queueBudgetBytes` has to be raised with it.
* **A headless page is not the page the user runs.** Rendering here costs 39 ms per frame under
  swiftshader (the fake-device run above), which is an environment artefact: a real window draws the
  same plot on the GPU. Any 200M verdict has to be taken with a visible window, or the transport has
  to be moved off the main thread the way libsigrok moved it off the session thread.

### 8.18 WebUSB is available in a Dedicated Worker, which makes the libsigrok-shaped fix possible, 2026-09-10

The transport shares a thread with everything the page does, and 8.17 shows the consumer alone
spends about half of one 32ch/200M budget (3.911 ms per 3.1 MB chunk) on that thread. libsigrok does
not: it reaps and resubmits URBs on a dedicated libusb event thread (protocol.c:325) and hands
completed buffers to a `GAsyncQueue` that the session thread consumes, so nothing the session does
can delay a re-arm.

**The browser can do the same thing.** Probed in the page's own Chromium 152:

```
new Worker('/src/device/_probeWorker.ts', { type: 'module' })
  typeof navigator.usb          -> "object"
  prototype methods             -> onconnect, ondisconnect, getDevices, constructor
  await navigator.usb.getDevices() -> []          (board unplugged; no error)
```

`requestDevice` is absent in the worker, which is the spec's worker exposure: the *grant* stays a
main-thread, user-gesture operation, and the worker then sees the origin's permitted devices through
`getDevices()`. Two things still have to be verified on a board that is plugged in: that a worker
sees a device the main thread was granted, and that the worker's own `open()`/`claimInterface()`/
`transferIn()` work. If they do, the transport can move wholesale, which is the only shippable way
to stop a 16 ms frame or a garbage collection from starving the device - widening the window instead
would mean raising `usbfs_memory_mb` on every user's machine.

**Two corrections to the measurements in 8.17, both from re-running them properly:**

* The per-chunk append cost is **not** as spiky as a first probe suggested. That probe allocated 200
  fresh 3.1 MB buffers and dropped them before timing the appends, and the 14-19 ms outliers it
  attributed to the store were its own garbage. Timing 300 appends into a fresh capture with one
  reused buffer, on the real GPU: 513.9 ms total, mean **1.71 ms**, two chunks over 5 ms (6.6 ms at
  the first chunk and 5.6 ms once more), everything else 2-3 ms. The store's blocks never copy (see
  `bitplane.ts`), so growth is not the stall it looked like.
* **A headless page can use the real GPU.** `--use-angle=gl --enable-gpu --ignore-gpu-blocklist`
  reports `ANGLE (Intel, Mesa Intel(R) UHD Graphics 730 (ADL-S GT1), OpenGL ES 3.2)` here, and with a
  156 M-sample 32-channel store loaded the app renders at a flat 16.7 ms frame. The 39 ms frames
  measured earlier were swiftshader, not the app: any rendering number taken in this container has
  to say which of the two it used.

The stall probe from this change is what makes the next hardware run decisive: the abort message now
carries the worst thread stall and the queue window it was measured against, so "logicweb failed at
200M" comes with either "the page blocked for 22 ms against a 19.6 ms window" or "the page never
blocked, the device did".

### 8.19 The transport runs in a Dedicated Worker, 2026-09-10

8.18 established that WebUSB is exposed in a worker; this change uses it. `usbWorker.ts` owns the
`Slogic16U3`, `workerTransport.ts` gives the page a `Device` it cannot distinguish from the in-page
one, and `usbWorkerSpawn.ts` is the one file that names the bundled-worker specifier.

**The backpressure is the existing one, moved.** The worker posts each chunk with its buffer
transferred and does not refill that URB slot until the page acks the chunk; the page acks after its
sink returns, and a sink that returns a promise holds the ack until it settles. That is
`StreamTuning.lagChunks` expressed across the thread boundary, so the bounded-queue property proven
earlier (NOTES 8.13) still holds - a worker cannot run ahead of the page by piling chunks in the
message queue. `requestDevice` is main-thread-only, so the grant stays a user gesture on the page and
the worker finds the device through `getDevices()`; when it cannot, `workerTransport.open()` falls
back to the in-page transport and records why, which the UI prints and the debug snapshot reports as
`transport`/`transportFallback`.

**One bundling constraint is worth remembering.** `./usbWorker.ts?worker&inline` is a Vite
specifier: plain esbuild cannot resolve it, and importing it from `workerTransport.ts` broke the
offline suite's bundle with `No matching export ... for import "default"` - the failure showed up as
an exit code with no test output, which is why it is recorded here. The specifier now lives only in
`usbWorkerSpawn.ts`, imported by the browser entry for its side effect via `installUsbWorkerSpawn()`;
everything under `device/` is again bundlable by esbuild, and a test injects a fake worker through
`spawn`. `?worker&inline` is also what the single-file `dist` needs, since it carries the worker as a
data URL rather than a second file.

**Verified with no board attached** (the 32U3 is off the bus; see 8.16):

* `offline-test.ts`: **139 checks, all passing**, 18 of them new and covering the open handshake,
  identity adoption, a worker that cannot see the device, an open that never answers (with the
  worker terminated rather than leaked), chunk transfer, ack-after-append, a held ack for a slow
  sink, dropouts/triggers/errors crossing, stats and console round trips, `stop()`, and a terminated
  worker failing what it was asked for.
* `tsc --noEmit`, `vite build`, and the single-file `npm run dist` (19.4 MB, worker inlined) all
  clean; `npm run check:portable` passes against the built `dist/index.html` over `file://`.
* **The worker really runs in the browser.** From the dev-server page in headless Chromium:
  `WorkerSlogicDevice.open({vendorId: 0x359f, productId: 0x3032})` spawned the inlined worker and
  came back in **11 ms** with `the 359f:3032 device is not visible to this worker; the page must
  grant it first`. That is the whole plumbing - module load, `navigator.usb` in the worker,
  `getDevices()`, the reply - exercised for real, and it fails exactly where it should with no board.

**What is still unverified, and needs the board plugged in:** that a worker sees a device the *page*
was granted (the probe above only proves the worker's WebUSB is live), that the worker's own
`open()`/`claimInterface()`/`transferIn()` succeed, and then the run this was all built for -
32ch@100M at 391.8 MB/s and 32ch@200M at 795.7 MB/s, with `threadStallMaxMs` reported against the
queue window so an abort says whether the page is still the cause. If a worker cannot hold 200M
either, the remaining lever is `usbfs_memory_mb`, still untested.

### 8.20 What the worker actually buys: 78 ms of slack at 200M, 2026-09-10

The fix is worth a number, because "moved to a thread" is not one. At 32ch the geometry is
3,129,344 B per transfer = 782,336 samples = **7.82 ms of device time at 100M, 3.91 ms at 200M**.

* On the page the window is `depth x transfer`: the completion callback *is* the re-arm, and a page
  blocked in a store append or a garbage collection cannot run it, so nothing is resubmitted while
  the thread is held. 5 transfers = **19.6 ms at 200M**, which is why a 38 ms collection both starved
  the device and looked like a slow device.
* In the worker the read loop is off that thread, and the bound on host-held buffers is `lagChunks`
  (`depth * 4` = 20 by default, `canArm()` in `slogic16u3.ts`). While the page is blocked the worker
  keeps reaping and resubmitting; `completed` fills until `completed + inFlight` reaches 20, after
  which the 5 already-submitted URBs drain - 20 transfer-times, i.e. **78.2 ms at 200M and 156.5 ms
  at 100M**, for 62.6 MB of page memory. That is 4x the old window against the worst stall measured
  here (38.1 ms), and it is the same decoupling libsigrok gets from `GAsyncQueue`, with a bound
  instead of an unbounded queue.

Two consequences for the hardware run, both board-free decisions:

* The abort message and the bench now say which thread they are talking about. `threadLabel` is
  passed as `worker` by the page transport and is sticky for the life of the instance, because the
  `bench` command restarts the loop without repeating the start options. An abort that reads "the
  worker thread was never blocked" is the architecture working; one that reads "the page thread was
  blocked" would be measuring the wrong thread entirely.
* The page measures *itself* for the length of every capture (`pageStallMaxMs`, `pageStalls`) and
  appends its own line to a `bench` reply, since the worker's reply can only describe the worker. If
  200M still fails, the first question is whether the page was ever blocked longer than 78 ms - and
  now the bench answers it in the same output as the rate.

**The one thing the worker cannot fix, and the test that separates it:** if Chromium's WebUSB tops
out below 800 MB/s, no amount of threading helps, and every measurement so far has been at 400 MB/s
or below (16ch@200M, 8ch@400M, 4ch@800M all saturate the same 400 MB/s wire budget). `bench 2 32 200`
runs `discard: true` - it counts the pipe and never touches the sink - so a rate near 795.7 MB/s proves
the pipe and points at the consumer, and a rate stuck near 400 MB/s would mean the browser's own
transport is the ceiling and the store was never the problem. Run 16ch@400M in the same session as
the control: same 800 MB/s of wire, half the samples per byte, so the two together separate pipe cost
from per-sample cost.

If the other half fails - the worker can see the device but cannot hold it - the same 78 ms can still
be bought on the page by raising `usbfs_memory_mb` and `queueBudgetBytes` together to ~64 MiB (21
transfers of 3.13 MB); it is the same window, charged to every user's kernel instead of to a thread,
and it is the only lever left that does not depend on the worker.

### 8.21 The two mechanisms the browser cannot copy, and what stands in for them, 2026-09-10

Re-reading `protocol.c` against this transport, the numbers confirmed are these: the training probe
asks for 250 ms, halves on `LIBUSB_ERROR_NO_MEM` until one submit succeeds, then quarters it to keep
"at least 4 transfers pending" (protocol.c:307-357) - which is 5 x 3,129,344 B at 200M, the geometry
`offline-test.ts` now pins. The abort rule is `timeout_count >= timeout_count_limit` with
`timeout_count_limit = num_transfers_used` (protocol.c:434), i.e. *depth* consecutive slow transfers:
the same threshold `slowCount >= depth` uses. And the re-arm really is in the libusb event thread
before the consumer ever sees the buffer: `receive_transfer` pushes into an unbounded
`GAsyncQueue` (protocol.c:112-119) while `handle_events` pops on the session thread.

**The one mechanism with no WebUSB equivalent is the per-transfer timeout.** Every URB is submitted
with `timeout = (TRANSFERS_DURATION_TOLERANCE + 1) * per_transfer_duration * (num_transfers_used + 2)`
(protocol.c:405) - about 36 ms for the fifth URB at 200M - and `LIBUSB_TRANSFER_TIMED_OUT` is handled
as a successful completion that *may have data* (protocol.c:50-52): the callback takes whatever
arrived, pushes it, and resubmits. libusb therefore cannot be left holding a URB that will never
complete, and a half-dead pipe degrades into slow transfers that the abort rule above eventually
catches. WebUSB's `transferIn` takes no timeout and a transfer the device never fills stays pending
until the interface is released, so the browser has no way to re-arm out of that state - only to
notice it (the no-data watchdog, NOTES 8.15) or to abandon it (`stop()` force-cancelling the
endpoint). This is a real gap in fidelity, not a tuning one, and it is the first thing to suspect if a
hardware run shows transfers stopping without an error.

**The other deviation is deliberate: the queue is bounded.** libsigrok's `GAsyncQueue` grows to
whatever the consumer cannot keep up with - at 200M that is 1.6 GB for a 2 s capture, and it does not
try to stop it. This transport caps host-held buffers at `lagChunks` (20 chunks, 62.6 MB, the 78 ms in
NOTES 8.20) because a browser page has to live inside a heap it can measure. If a hardware run shows
the page stalling for longer than that, `lagChunks` - memory, not threads - is the lever, and it is
the one place where matching libsigrok more closely means spending RAM instead of changing the
architecture.

### 8.22 32ch/200M, both transports, same device and same page stalls, 2026-09-10

The board is off the bus, so the comparison the objective needs was built without it:
`src/device/tools/windowHarness.ts` runs both transports against `ClockStreamDevice` - a scripted
device that samples on **its own clock** with a FIFO behind it, the one thing the offline suite's
scripted device cannot be, because there a transferIn completes when the host asks and a host that
stops reading is never punished. Both arms run the shipping `Slogic16U3`, the shipping
`createSampleStore` (interleaved at 32 channels - the first harness run used `PlanarSampleStore` and
measured 8.5 ms per chunk against a 3.9 ms budget, which is why the harness now says
`createSampleStore`), the same 3,129,344-byte transfers and the same capture-panel sink. A page-side
busy loop of `stallMs` every 300 ms stands in for the append-plus-GC stall that NOTES 8.18 measured
at 20-38 ms on real hardware; `stallMs 0` is the natural case, where the store alone stays inside the
budget.

Two seconds at 32ch/200M in each arm, `npm run dev` + the GPU Chromium, 9236:

| page stall | page transport | worker transport |
| --- | --- | --- |
| 0 ms | 799.7-801.0 MB/s, 517 transfers, completes | 799.9 MB/s, 517 transfers, 0.3 ms starved |
| 40 ms | **aborts at 113 MB (97 ms in)**, 546 MB/s average | **800.1 MB/s, 517 transfers, 0 short, 0 slow, 0.3 ms starved** |
| 60 ms | aborts at 297 MB | 800.1 MB/s, 517 transfers, 0.3 ms starved |
| 80 ms | aborts at 307 MB | 798.5 MB/s, completes, 49.8 ms starved (~40 MB) |
| 100 ms | aborts at 307 MB | 799.3 MB/s, completes, 337 ms starved (~270 MB) |
| 120 ms | aborts at 307 MB | **aborts at 316 MB** |

Three things this establishes:

* **The fix is the split, not the tuning.** At the stall the hardware actually shows (40 ms) the page
  transport dies 97 ms into a 2000 ms capture while the worker transport finishes all 517 transfers
  at 100.0% of 800 MB/s with no short transfer, no slow window and no data lost - while the page was
  blocked 38.4 ms in the middle of it. The page arm's abort is its own watchdog, quoting "the page
  thread was blocked ... worst 46.8 ms ... the queue covers 19.6 ms", which is 8.17 restated by the
  transport itself.
* **The 78 ms window in 8.20 is real, and it is the limit.** The worker arm is clean at 60 ms and
  starts losing data at 80 ms - the same number arrived at by arithmetic from `lagChunks x transfer`,
  now measured by a device that counts the milliseconds it had nothing to fill. Below it there is
  margin; above it `lagChunks` (memory) is the only lever, exactly as 8.21 says.
* **The harness is honest about what it cannot show.** `stallMs 0` passes in both arms, because a
  scripted device never adds Chromium's own WebUSB reaping cost to the page thread and the store
  alone fits the budget. Only a stall the hardware has and the script does not - or one injected on
  purpose - separates the two, which is why the A/B is run with one.

Run it with `node src/device/tools/window-bench.mjs <cdp-port> <seconds> <bytesPerMs> [stallMs]
[stallEveryMs]` against a dev server and a Chromium with the app open; `bytesPerMs` 800000 is
32ch/200M (the samplerate follows from it, so 400000 is 32ch/100M and the same 800000 at 16 channels
is 400 MSa/s).

Re-run on 2026-09-11 with the machine at load ~1.8 (a `tsc`+`vite build` in parallel), the same
`stallMs 0` row is not the table's row: the page arm aborted after 339 transfers with a **376 ms**
page stall and the worker arm after 415 with a 16.2 ms transfer, while the worker thread's own probe
never saw more than 8 ms. The harness measures this machine as well as the transport, so a run that
is meant to be compared has to be a run with the box quiet and nothing else building.

### 8.23 `bench` wedged the board, and the device's own stop now ends a capture early, 2026-09-11

The 32U3 came back on the bus (`Bus 002 Device 108: 359f:3032 Sipeed SLogic32 U3`, S/N 202608052052)
and the first hardware number taken with `bench` was `bench 2 32 100`: **398.0 MB/s of 400, 255
transfers, 0 short, 0 slow, longest idle gap 0.00 ms, page thread never blocked**, measured in the
worker through the page's own device grant - the 8.19 question ("can the worker see a page-granted
device") answered yes on real hardware.

Then `bench 2 32 200` failed three times in a row, and `bench 0.3 32 100` afterwards delivered **0
bytes**: the board was in 8.8's W1 state. The bench was the thing that put it there, and the reason is
the one 8.6 describes: `bench` waited `seconds` and then called `stop()` on a device that was still
producing, so the host cut a live producer off, the FIFO overran, and the bulk endpoint went silent
until a replug. A tool whose job is to measure the transport must not be the thing that breaks it.

That also means **the three 200M failures are not evidence about 200M**: by the time the first one
ran, the board had already been through one 100M bench that ended by cutting it off. The next
hardware session has to take 200M *first*, on a freshly replugged board, with the fixed tool.

The first failure was also reported as `the worker answered with no console result`, which is a
transport bug of its own: the worker posted `{kind:'failed'}` with the real sentence in it and
`WorkerSlogicDevice.usbControl`/`getStats` replaced it with a message about the reply *shape*. Both
now re-throw the worker's message, so a bench that fails says why.

Two fixes, both measured offline against the scripted devices:

* **`bench` arms the device's own length** (R32_SAMPLE_LEN, 8.9) with the sample count the run asks
  for and waits `seconds + 400 ms` before `stop()`, so the end of the measurement is the device
  stopping itself rather than the host stopping it.
* **A capture whose device limit has been delivered ends without waiting out `STOP_TIMEOUT_MS`.**
  After the device stops on its own, the reads still queued are tail reads the device answers with
  NAKs; WebUSB has no abort, so the only thing that ends them is releasing the interface, and the
  driver used to discover that by waiting 1500 ms first. `deviceReachedItsLimit()` (received device
  samples vs the verified armed total) now recognises the state and goes straight to the release.
  This is not just a bench optimisation: it is the same 1.5 s, and the same
  `releaseInterface`/`claimInterface` pair, on every timed capture whose length the device reached.
  It is safe because the armed total is the *device's* count: it can only be matched once the last
  data-carrying transfer has been consumed, and the device stops at exactly `value * 4096 - 8192`
  bytes (8.9). A limit the device refused to take is not trusted at all - `writeSampleLength` reads
  back, and a refused write leaves the count at 0 rather than letting it explain a silent queue.

The scripted clock device had to learn the same thing: it now rejects its post-limit reads on
release, the way libusb reports a cancelled URB, instead of handing the driver a promise that never
settles. A promise that never settles is what made the first version of the offline bench check hang
with no error at all. The offline suite is **147 checks**, four of them new, covering the armed
limit, the end on the device's own stop, the rate still being reported, and the stop timeout not
being paid.

### 8.24 A fresh 32U3 at 32ch/200M: the browser does 532 MB/s of 800, and the device is the same

The first hardware run after the bench fix, on a freshly replugged board (device 109, S/N
202608052052), with the simplest fixed configuration there is - `bench 1 32 200`, the worker
transport, no sink at all, only the pipe:

```
32ch@200M, 1 s requested, ended by the device's own R32_SAMPLE_LEN
  steady  532.5 MB/s of 800 (rateRatio 0.666)
  14 transfers, 43.8 MB, 0 short
  transfer p50 6.00 ms, p95 9.80 ms   (the device fills a 3,129,344 B read in 3.91 ms)
  rearm p50 0.10 ms, peakQueued 4, maxIdleGapMs 0
  threadStallMaxMs 0, pageStalls 0
  aborted: "5 consecutive transfers: 6.50 ms for 3129344 B (limit 5.09 ms), 505 MB/s average"
```

Nothing on the host thread was blocked, no read came back short, and the re-arm is 0.10 ms: the time
is inside Chromium's USB path, between the device filling a read and this transport being handed it.
The same board, same port, same session geometry through libsigrok's own path delivered **exactly
800 MB/s for 8 s** in an earlier run on this machine (`nat.200m-8000ms`: 6,400,000,012 bytes, 2046
transfers, 0 transfer timeouts, `Bulk in 2105032704/2105032704`), and 1,200,000,012 bytes for 3 s at
32ch/100M. The device is not the difference.

**Every browser attempt at 32ch/200M so far has ended with the board wedged**, including this one,
with the device-side length limit armed and the fixed bench: the sampler offers 800 MB/s, the host
drains ~530, and the backlog outruns the FIFO long before the abort rule fires at 31 ms. Recovery is
a physical replug; `bench 0.5 16 50` (100 MB/s, four times slower) then delivers nothing. That is
8.7's finding restated with a fixed tool, and it is why the next session's runs have to be short
enough for the device's own buffering to absorb them.

**The open question 8.7 left is now the only one that matters**, and it is answerable offline-free
with a geometry sweep: is the ~500 MB/s a per-transfer cost that a different read size or queue
depth can amortise (4 or 8 or 16 reads inside the same 15.6 MiB usbfs budget), or a per-byte cost in
Chromium's copy chain (Renderer -> USB service -> kernel and back), in which case no geometry moves
it and 32ch/200M is out of reach for WebUSB on this host while 32ch/100M is not? The decisive
instrument is a *length-limited* sweep: each run ends by R32_SAMPLE_LEN after ~20 MB, which is ~25 ms
of device time and therefore inside the 15.6 MiB the queued reads hold plus the FIFO, so a run that
measures a sub-800 MB/s host cannot overrun the device and cannot cost a replug. `/tmp/lwcdp/_safe200.js`
is that sweep, in the repository as `npm run bench:geometry`: libsigrok's own probe geometry
(5 x 3,129,344 B) plus four ways of trading read size for depth inside the same 16 MiB usbfs budget,
each as repeated slices capped at **80% of the queued-read budget** - measured on hardware, a 1 s run
at the default geometry aborted after 44 MB, which is 15.6 MiB of reads plus a couple of MB of FIFO,
so that bound is where a slice stops being safe. `bench` itself takes `[depth] [transferBytes]` and a
slice may be 5 ms long, so each configuration is one console line and every reply names the geometry
it measured. The 100M geometry is the method control and it reports the device's own rate
(398.0 MB/s at 32ch/100M), which is what makes a 200M number from the same tool believable.

### 8.25 Chromium copies every read twice above 64 KiB, and the sweep now brackets that threshold, 2026-09-11

8.24 asked whether the missing 269 MB/s is a per-read cost or a per-byte cost, and Chromium's own
source answers the shape of it before the board answers the numbers. The path a `transferIn` takes:

* the renderer asks over mojo (`DeviceImpl::GenericTransferIn`), and the browser-side device service
  allocates a fresh `base::RefCountedBytes(length)` for *every call*
  (`services/device/usb/mojo/device_impl.cc`), which libusb then fills;
* the reply's `mojo_base.mojom.ReadOnlyBuffer` is a `mojo_base::BigBuffer` constructed over a span of
  that buffer, and that constructor is documented as one that "Always copies the contents of |data|
  into some internal storage" (`mojo/public/cpp/base/big_buffer.h`). Above `kMaxInlineBytes`, which is
  **64 KiB** (same file), the storage is a fresh shared memory region: the sender allocates it, the
  kernel zeroes its pages on first touch, and the copy fills them;
* the renderer then turns the received span into the result the page reads with
  `DOMArrayBuffer::Create(data)` - a second full copy, into fresh renderer memory
  (`third_party/blink/renderer/modules/webusb/usb_in_transfer_result.h`).

So a read of `S` bytes above 64 KiB costs **at least two copies of S plus two large allocations whose
pages the kernel must fault and zero**, which is a per-*byte* tax, not a turnaround. The arithmetic
against 8.24's measurement says the same thing: 6.00 ms observed minus the device's own 3.91 ms is
2.09 ms of host time for 3,129,344 B, i.e. **0.68 µs per KiB**, and a per-byte tax at that rate gives
`1 / (1/800 MB/s + 0.68 µs/KiB) = 521 MB/s` *whatever* the read size is. The measured steady rate was
532.5 MB/s, so the two agree to 2% - and a per-read tax, the hypothesis a bigger read would pay off,
predicts a curve that climbs toward 800 with read size instead of a flat line.

**The same source names the one geometry that could still pay**: `BigBuffer` *inlines* payloads up to
64 KiB, so a read of 64 KiB or less never allocates a shared memory region and never leaves the mojo
message. That is a threshold, not a slope, and 8.24's sweep did not contain it - every row was 782,336
B and above. `bench:geometry` now brackets it at equal queue size: `32 x 131072 (just over the inline
limit)` against `64 x 65536 (inline, same queue)`, plus `120 x 65536` and `200 x 65536` to show
whether depth helps once the threshold is cleared. A jump between those two rows at the same 4 MiB
queue is the copy chain, and it decides in one run whether the browser's fix is a read size or a
different backend entirely. The other bound worth knowing comes from the same source:
`kWebUSBTransferSizeLimit` (enabled by default) refuses any single transfer over **32 MiB**
(`device_impl.cc`, `kUsbTransferLengthLimit`), so "one enormous read" tops out at 32 MiB even with
`usbfs_memory_mb` raised - which at 0.68 µs/KiB is still 520 MB/s, not 800.

None of that is measured yet: the board is in 8.8's W1 state (device 109 delivers 0 bytes at every
rate, `4ch@10M` included) and no software recovery exists - `CTRL.RST`, `clear-fifo`, `clearHalt` on
the bulk endpoint, `USBDevice.reset()` and a raw `USBDEVFS_RESET` on the usbfs node were all tried on
this wedge and all leave the pipe silent. The sweep needs a physical replug, and it is cheap to run
the moment one happens: every slice is ended by the device's own `R32_SAMPLE_LEN` inside the reads
already in flight, so measuring a host slower than the device cannot overrun the FIFO and cannot cost
another replug.

### 8.26 The host stops keeping up at 1 MiB, and that - not the line rate - was the browser's ceiling, 2026-09-11

**The instrument came first.** The board is wedged (8.8's W1), so its sampler sends nothing at any
rate, and the sweep 8.24/8.25 left waiting for a replug cannot run. But the wedge is in the sampling
path: `aux 5 = 1` (`RB_TEST_DUPLOAD`, the vendor's "test USB max speed" mode) still pushes bytes
through EP 0x82 on this board. `bench` now takes a sixth word to select the source - `bench 0.5 32 200
200 65536 usbmax` - so the raw upload is a free-running producer, and everything the host drains from
it is the *host's* number rather than 32 channels of sampling. Every run is still ended by the
device's own `R32_SAMPLE_LEN`, which this mode honours, so the slices stayed bounded. (The vendor's
*emulation* mode, `aux 5 = 2`, would have been the better instrument - it generates at the configured
samplerate, i.e. a calibrated 800 MB/s at 32ch/200M - but on this board 32ch/200M emulation delivers
nothing while 32ch/100M emulation delivered 118,915,072 B at 484 MB/s with transfer p50 6.00 ms,
which is that geometry keeping up. The calibrated 800 MB/s producer is one more thing a replug
restores.)

**The cliff is at 1 MiB, and it is the host's.** Read size swept with the queued bytes held at 12 MiB,
so the read size is the only variable:

| geometry | drained | rate | verdict |
| --- | --- | --- | --- |
| 64 KiB x 200 | 199,950,336 B in 216 ms | 927 MB/s | 3051 calls, 0 short, 0 slow |
| 128 KiB x 100 | 199,884,800 B in 207 ms | 967 MB/s | 1525 calls, clean |
| 256 KiB x 50 | 199,753,728 B in 216 ms | 927 MB/s | 762 calls, clean |
| 512 KiB x 25 | 199,753,728 B in 220 ms | 909 MB/s | 381 calls, clean |
| 768 KiB x 16 | **1,599,602,688 B in 1649 ms** | **970 MB/s** | 2034 calls, 2 s, clean |
| 956 KiB x 13 | 199,704,576 B in 217 ms | 921 MB/s | 204 calls, clean |
| 1 MiB x 12 | aborted after 24 ms | 477-533 MB/s | "overran the host" |
| 1.25 MiB x 10 | aborted after 26 ms | 510 MB/s | "overran the host" |
| 1.5 MiB x 8 | aborted after 24 ms | 526 MB/s | "overran the host" |
| 3,129,344 B x 5 | aborted after 95 ms | 396 MB/s | libsigrok's own geometry |

So **WebUSB on this host can receive 32ch/200M continuously** - 1.6 GB, two seconds, no short read, no
slow window, no thread stall, 21% above the 800 MB/s the sampler offers - and it does it with reads
below 1 MiB. libsigrok's 3,129,344-byte reads are what the browser cannot do, and that is exactly the
size the native driver trains on. The step is at a power of two with both sides page multiples and the
queue budget fixed, so it is a per-allocation threshold in Chromium's own path: below it the reads are
reused out of an allocator's pools, above it every `transferIn` takes a fresh mapping that the kernel
then faults and zeroes (the device service's buffer, the shared memory `BigBuffer` copies into, and
the `DOMArrayBuffer` the renderer copies into again - 8.25). libsigrok has none of that: it hands
libusb a buffer it allocated once and resubmits the same transfer, which is why the same reads reach
800 MB/s there and 396-530 here.

**What that changed in the transport.** `deriveStreamTuning` now decides from the line rate: below
500 MB/s it keeps libsigrok's geometry, because those reads sustain the rate and they keep the number
of chunks the page sees four times lower; above it - 32ch/200M is 800 MB/s - it uses 768 KiB x 16 (12
MiB, inside the same usbfs budget) and a new `coalesceBytes` makes the transport hand the sink 8 MiB
blocks instead of 1,017 reads a second. The coalescing is not a nicety: the interleaved store costs
about **1.2 ms per `append` whatever its size** plus 0.31 us/KiB (measured on this machine at 32
channels: 768 KiB -> 0.775-1.452 ms, 3.13 MB -> 2.185 ms, 8 MiB -> 5.025 ms), so per-read delivery
would ask the store for 1.5 s of work per second of data. This is the same split libsigrok has, with
its libusb callback reaping URBs and the session thread handing the application larger blocks. An
explicit tuning - the console, the offline suite - still gets its reads delivered one for one.

**And the wall moved to the consumer, which is where it now is.** A real `startCapture` at 32ch/200M
through the shipping app, with the raw upload as the source, now receives **134,217,728 B (16 blocks)
before the transport's own watchdog aborts it at 648-654 MB/s** - up from 14 MB at 104 MB/s at the
same geometry before the coalescing, and up from 532 MB/s on a healthy board with libsigrok's
geometry. Stubbing the frame loop's `draw()` moves it from 510 to 654 MB/s, so the live renderer costs
about 145 MB/s of the page's budget at this rate, and the rest is the store: `sink p95 7.2 ms` per 8
MiB append (5.0 ms of it the store itself, i.e. ~50% of one thread at 800 MB/s), and `peakQueued 63`
of the 64 the lag bound allows says the page really is the slow side. The pipe is no longer the
limit; the page is. That is the next piece of work, and it is app-side (the store's per-append and
per-byte cost, and how often the live view redraws at 200 MSa/s), not WebUSB.

What is still unmeasured is the one thing only a healthy board can answer: the *sampler* at
32ch/200M through this geometry. The 970 MB/s above is the raw upload's rate through the host path,
and the sampler's 800 MB/s is below it - but a FIFO that is fed by the sampler and drained by this
host for ten seconds is the claim the objective actually needs, and it needs the replug that 8.24 has
been waiting for.

### 8.27 The queue is bounded by the capture's own length, not by the consumer, and the page was never the slow side, 2026-09-11

**The last hardware run put the two numbers side by side that 8.26 could not.** Device 002:112, one
replug, the shipping app, normal mode: 32ch/100M received 12,517,372 B (4 reads) and then aborted -
"8.30 ms for 3129344 B (limit 10.17 ms), 374 MB/s average over 42 ms (minimum 380 MB/s)", slow for 5
consecutive transfers - and every row after it, including 32ch/200M, delivered **nothing at all**.
`peakQueued` in that run was **17 of the 20 chunks lagChunks allows**, and the page had appended 4.
That is the consumer bound, not the device: the loop stopped refilling while the consumer was behind,
the device was left with an empty queue, its FIFO overran, and a capture libsigrok would have carried
to its length came back as a wedge that only a replug clears.

**The page, measured on its own, is not the slow side.** With no device at all, the app's own store
and frame loop driven by a worker posting at the line rate:

| run | delivered | of the line rate | store duty |
| --- | --- | --- | --- |
| 32ch@100M, 3,129,344 B chunks | 792 MB | 0.99 | 0.27 |
| 32ch@200M, 8 MiB blocks | 1,602 MB | 1.001 | 0.50 |

The store absorbs 1584 MB/s at 100M's chunk size and 1418 MB/s at 200M's in isolation, and a
32-channel interleaved store held **6.7 GB (8.39 s at 200 MSa/s)** in this page before anything
failed, so neither the store nor the heap is what stops a ten-second capture (`_memceiling.js`).

One methodological trap is worth recording, because it cost an hour: a page `setTimeout` pump at 8 ms
runs at **40 ms** while a capture is drawing, with the CPU profile still 73% idle - the renderer's
task queue is gated by the compositor in headless Chrome, not by work. Timers are not the device; the
USB completion is a task from the browser process, and a worker posting chunks is the model that
behaves like one. Every number in the table above comes from that model.

**What changed.** `readLoop` now bounds refills by the capture's own length when it has one, exactly
as the driver does (`samples_got_nbytes + num_transfers_used * per_transfer_nbytes <
samples_need_nbytes`, protocol.c:395): `StartOptions.deviceSampleLimit` - which timer mode always sets,
because it is what arms `R32_SAMPLE_LEN` - fixes the budget, and the consumer may lag as far behind as
it likes without a read being withheld. A capture with no length of its own (software trigger) still
keeps the `lagChunks` bound, because nothing else bounds the memory, and the trace now says so when
that cap is what held the refill rather than leaving it to look like a slow device. Four new offline
checks pin it: a slow sink cannot stop replenishment, the device never runs out of queued reads
(`maxIdleGapMs === 0`), every chunk still arrives in order, and a slow sink is not reported as a
fallen-behind device. 155 -> 159 checks, all passing, `tsc --noEmit` clean.

**What is still open**, and it is the same sentence 8.26 ended on: a real sampler at 32ch/100M and
32ch/200M for ten seconds, on a board that has not already been driven into W1 by a previous abort.
The watcher is armed for the next replug (`/tmp/lwcdp/wait-and-sweep.sh`): the real captures first,
then the short-capture-at-a-slow-rate anomaly that every fresh board has shown so far (`bench 0.2 4
10` delivers nothing while `bench 0.2 4 200` delivers 90%), then the geometry sweep last, because its
slow rows are the ones that can wedge the board.
