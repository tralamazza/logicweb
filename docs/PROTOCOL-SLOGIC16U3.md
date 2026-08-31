# Sipeed SLogic16 U3 - USB protocol

Distilled from the working libsigrok driver at
`src/hardware/sipeed-slogic-analyzer/` (`api.c`, `protocol.c`) in a libsigrok checkout -
see https://github.com/tralamazza/libsigrok. That driver is the ground truth. If anything here
disagrees with it, the driver wins - go read it, do not guess.

Verified on the attached unit (`ioreg -p IOUSB -l`):

- Vendor `0x359f` (Sipeed), product `0x3031`, product string `SLogic16 U3`
- Serial `202512261505` (this is the same unit the vref calibration below was measured on)
- `bDeviceClass = 255` (vendor specific) -> no kernel driver binds it, WebUSB can claim it
- `UsbLinkSpeed = 5000000000` (USB 3.0 SuperSpeed, 5 Gbps)

## Endpoints and interface

- Interface 0, alternate 0. `libusb_claim_interface(handle, 0)` (`api.c:392`).
- Bulk IN endpoint `0x02 | IN` = **`0x82`** (`api.c:1531`). Sample data only.
- All control is vendor-type control transfers on endpoint 0.

WebUSB mapping:

```js
await dev.open();
await dev.selectConfiguration(1);
await dev.claimInterface(0);
// control write: {requestType:'vendor', recipient:'device', request, value, index}
// bulk read:     dev.transferIn(2, len)
```

## Control transfers

Two vendor requests (`api.c:1129`):

| request | dir | meaning |
|---|---|---|
| `0x00` | IN  | register read |
| `0x01` | OUT | register write |

**Critical quirk** (`slogic_usb_control_write` / `_read`, `api.c:791` and `api.c:838`):
every transfer moves **exactly 4 bytes**. Longer payloads are split into 4-byte chunks and
`wValue` is incremented by 4 for each chunk - the register address travels in `wValue`,
`wIndex` is always 0. Lengths are rounded up to a multiple of 4. Do not issue a single
16-byte control transfer; the device will not accept it.

```js
async function regWrite(dev, addr, bytes) {      // bytes.length % 4 == 0
  for (let i = 0; i < bytes.length; i += 4)
    await dev.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: 0x01,
        value: addr + i, index: 0 }, bytes.subarray(i, i + 4));
}
async function regRead(dev, addr, len) {         // len % 4 == 0
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 4) {
    const r = await dev.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request: 0x00,
        value: addr + i, index: 0 }, 4);
    out.set(new Uint8Array(r.data.buffer), i);
  }
  return out;
}
```

## Registers

| name | addr | notes |
|---|---|---|
| `R32_CTRL` | `0x0004` | `{0x01,0,0,0}` run, `{0x00,0,0,0}` stop, `{0x02,0,0,0}` then `{0x00,..}` reset |
| `R32_FLAG` | `0x0008` | declared, unused by the driver |
| `R32_AUX`  | `0x000c` | command selector (4 bytes) followed by payload at `0x0010` |

## The aux protocol

Every configuration item follows the same handshake (`api.c:1242`, `slogic16U3_remote_run`):

1. Write a 4-byte **selector** to `R32_AUX` (`0x000c`).
2. Poll `R32_AUX` (4-byte read) until `byte[2] & 0x01` is set - the ready bit. The driver
   gives up after 5 reads. **Check the reply; silent rejection is the failure mode here.**
3. The payload length is `u16[0] >> 9` of that same word, clamped to 60 (`aux_payload_len`,
   `api.c:1158`). Unclamped, the device can overrun the caller's buffer - keep the clamp.

   **Do not round this length down to a multiple of 4.** An earlier revision of this file
   said to; it was wrong, and the device builder caught it against real hardware. The
   clamp in `aux_payload_len` is a clamp only - the rounding *up* to a multiple of 4
   happens later, inside the control transfer helpers. This unit reports lengths of 2, 8,
   2 and 1 for selectors `0x01`, `0x02`, `0x03` and `0x05`. Rounding down turns three of
   those four into zero-length no-ops: every setting silently fails and the device keeps
   capturing at whatever it was configured with before.

4. The status word format, which the driver does not document:
   `u16[0] = (len << 9) | selector`, and the ready bit is bit 0 of byte 2. The selector
   echoes back, so a mismatch means the device did not accept the command. The driver does
   not check this; we do.
5. Read the payload from `R32_AUX + 4` (`0x0010`), modify it, write it back to `0x0010`,
   then read it back and compare. A silent mismatch means the setting did not take.

Selectors:

| selector | sets | payload |
|---|---|---|
| `0x01` | enabled channels | `u32` bitmask at `0x0010` = `(1 << nch) - 1` |
| `0x02` | samplerate | see below |
| `0x03` | vref / threshold | `u32` DAC code at `0x0010` |
| `0x05` | test pattern mode | `u32` mode at `0x0010` |

### Samplerate (selector `0x02`)

The payload is a base table walk (`api.c:1297`). After the ready handshake, read 
`0x0010..` and interpret as: `u16[2]` = base index, `u16[3]` = base clock in MHz,
`u32[2]` = divider.

- `base = 1_000_000 * u16[3]` Hz.
- If `base % wanted != 0`, increment the base index (`u16[2] += 1`), write back 4 bytes,
  and re-read. The driver caps this at 5 iterations - firmware that keeps reporting the
  same base index otherwise spins forever mid-acquisition.
- When it divides evenly: `u32[2] = base / wanted - 1`, write payload back, read back,
  verify.

### Threshold (selector `0x03`)

Measured transfer function on serial `202512261505` (`api.c:1417` comment - three
calibration points fit to within 13 mV, independently predicted a 3.32 V high at 3.638 V
against 3.643 V measured):

```
threshold_volts = 0.005166 * code + 0.4318
code = clamp(round((volts - 0.4318) / 0.005166), 0, 1023)
```

Linearity degrades above ~4 V. The older `V / 6.66 * 1024` form has no intercept term and
is wrong. Note the constants come from one unit; part spread is unmeasured.

## Start / stop

Run (`slogic16U3_remote_run`), in this order:

1. aux selector `0x01` - channel mask
2. aux selector `0x02` - samplerate
3. aux selector `0x03` - vref
4. write `{0x01,0x00,0x00,0x00}` to `R32_CTRL`

Stop: write `{0x00,0x00,0x00,0x00}` to `R32_CTRL`.
Reset: `{0x02,0,0,0}` then `{0x00,0,0,0}` to `R32_CTRL`.

## Sample stream

Bulk IN on `0x82`, continuous once running.

- **The first 4 bytes of the stream are junk** and must be dropped exactly once per
  acquisition, not once per transfer (`protocol.c:117`, `head_dropped`). If the first
  transfer returns fewer than 4 bytes, carry the drop to the next one.
- Packing at 16 channels: 2 bytes per sample, channel *n* = bit *n*, little endian.
- Below 8 channels the device packs several samples per byte and the host unpacks
  (`slogic_submit_raw_data`, `api.c:880`): with `nCh` channels there are `8 / nCh` samples
  per byte, sample *j* occupying bits `[j % (8/nCh) * nCh ... +nCh)`. Supported channel
  counts are 4, 8, 16 (`api.c:129`).
- Transfer sizing (`protocol.c:400`): buffers are 32 KiB-aligned, sized to roughly one
  transfer duration of data, with at least 4 transfers in flight. Keep several
  `transferIn` calls outstanding or the device overruns.

## Rate limits

Samplerates offered (`api.c:95`): 5, 8, 10, 16, 20, 25, 32, 40, 50, 80, 100, 160, 200, 400,
800 MHz.

Ceiling by channel count on non-Windows (`api.c:134`), `{4ch, 8ch, 16ch}`:

| channels | max samplerate |
|---|---|
| 16 | 200 MHz |
| 8  | 400 MHz |
| 4  | 800 MHz |

Hardware bandwidth cap is 3200 Mbit/s = 400 MB/s. **WebUSB will not sustain that.** Expect
the browser path to cap well below the device ceiling. Measure what it actually sustains
and report that number honestly - do not quote the datasheet figure.

## Known-good reference command

The native driver is built in this tree. Use it as the control when the browser path
misbehaves - if sigrok-cli also fails, the problem is not your WebUSB code:

```
sigrok-cli -d sipeed-slogic-analyzer --config samplerate=16m --samples 1m -o /tmp/ref.sr
```

## Control signal on the bus

A second device is attached: `picolyzer-tester / "Logic Analyzer Test Source"`
(VID `0x16c0`). It emits known patterns, and a decode that disagrees between the two
applications on a known stimulus is a real defect rather than a matter of taste.

The probes **are** wired to it. An earlier note here said they were not, on the strength of
a capture that read a constant value; that capture was taken while the source was sitting
at `mode=stopped`, which is its idle state. It emits nothing until commanded. Start it
first:

```sh
cd <picolyzer-tester checkout>
python3 tools/console.py "walk 100k 16" "status"     # or square/uart/spi/i2c
```

Full command set and pin map: that project's README. GP0..GP15 are the 16-bit bus, GP16 a
trigger marker, GP17 UART TX, GP19/20/21 SPI, GP22/GP26 I2C. It reports what it actually
emitted, so `status` saying `txstall=no` means a missing sample is the analyzer's fault.

### Verified channel mapping, measured 2026-08-25

`square 0 1M` captured at 16 MSa/s gives exactly two words, `0xb201` and `0xb200`, 50000
each. So **GP*k* maps to bit *k* of the captured 16-bit word, with no byte swap.**

`walk 100k 16` over 200k samples shows which inputs actually follow the source:

| channels | behaviour |
|---|---|
| 0-7 | follow the walk correctly - verified good |
| 14 | follows the walk |
| 8, 10, 11 | do not respond to the walk, read low |
| 9, 12, 13, 15 | do not respond to the walk, read high (the `0xb2` in the high byte) |

**An earlier revision of this file read that as floating inputs and told everyone to build
only on channels 0-7. That was wrong, and it cost a whole investigation.** Nothing floats.
The upper eight probes are wired to the generator's *protocol* pins, which simply sit at
their idle levels when no protocol command is running. Every "stuck" value is an idle
state: UART TX idles high, SPI mode 0 clock and data idle low, SPI chip select is
active-low so it idles high, I2C idles released high, and the burst marker idles low.
Seven for seven.

### Verified analyzer channel map, measured 2026-08-27

Each link measured rather than inferred - GP8 driven alone produced exactly 12500 edges on
D14 at 1 MHz with zero activity on any other channel, which also killed the earlier
crosstalk theory:

| analyzer | generator pin | signal |
|---|---|---|
| D0-D7 | GP0-GP7 | parallel bus, low 8 bits |
| D8 | GP16 | burst trigger marker |
| D9 | GP17 | UART TX |
| D10 / D11 / D12 | GP19 / GP20 / GP21 | SPI SCK / MOSI / CS |
| D13 | GP22 | I2C SCL |
| D14 | GP8 | parallel bus bit 8 |
| D15 | GP26 | I2C SDA |

GP9-GP15 and GP18 are unprobed, so bus bits 9-15 genuinely cannot be observed. Making all
16 bus channels visible at once is a rewiring job, not a firmware one.

Decoder channel mapping for this bench:

```
uart:rx=D9    spi:clk=D10:mosi=D11:cs=D12    i2c:scl=D13:sda=D15
```

Working captures of all three live in `reference/hwcaptures/`. I2C shows NAK on every byte
because the generator is push-pull with no slave attached - that is expected and
documented, not a decode fault.

The device's own Emulation pattern (selector `0x05`) is a second control that needs no
probes at all, verified deterministic over three runs. Byte-exact fingerprint:

- 16 channels: `0700 0600 0500 ...`
- 8 channels: `07 06 05 04 ...`
- 4 channels, on the wire before expansion: `67 45 23 01 ...`

Note the driver never resets the pattern register, so a device left in Emulation keeps
returning fake data on the next run. Our device layer programs it on every `start()`,
defaulting to Normal. That is a deliberate deviation from the driver.
