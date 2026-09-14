// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The read-geometry sweep, through the shipping `bench` console command.
 *
 * The question this exists for (NOTES 8.24, 8.7): at 32ch/200M the device offers 800 MB/s
 * and the browser delivers ~530, with no thread stall and no short read - so the cost is
 * inside Chromium's USB path. Is that cost per READ (a fixed turnaround that a different
 * depth or read size amortises) or per BYTE (Chromium's copy chain, in which case no
 * geometry helps and 32ch/200M is out of reach for WebUSB on this host)?
 *
 * Every run is length-limited by the device itself (R32_SAMPLE_LEN) to what the reads
 * already in flight can absorb, so a run that measures a rate the host cannot drain cannot
 * overrun the device's FIFO - which on a 32U3 means a wedged board and a physical replug
 * (NOTES 8.6). That is what makes a sweep of a *too slow* host affordable: 5 slices of
 * ~20 MB per geometry instead of one replug per attempt.
 *
 * Run against an already-running Chromium with the app open on a dev server:
 *
 *   npm run dev
 *   chromium --remote-debugging-port=9235 ... http://127.0.0.1:5173/
 *   node src/device/tools/geometry-bench.mjs 9235 32 200
 *
 * Usage: node geometry-bench.mjs [port] [channels] [mhz] [sliceMB] [repeats]
 *
 * The page is reloaded first, on purpose: after a physical replug the granted profile still
 * holds the permission but the USBDevice object the page connected to is gone, and the app
 * re-acquires it from `getDevices()` on start-up. Without the reload every run after a
 * replug fails with "device not found" and looks like a measurement.
 */

const port = process.argv[2] ?? '9235';
const channels = Number(process.argv[3] ?? 32);
const mhz = Number(process.argv[4] ?? 200);
const sliceMB = Number(process.argv[5] ?? 20);
const repeats = Number(process.argv[6] ?? 3);

/**
 * The geometries. The first is libsigrok's own probe result (five 3,129,344-byte reads,
 * 14.9 MiB, the most the usual 16 MiB usbfs budget takes); the rest trade read size for
 * depth inside the same budget, which is the only lever a per-read cost leaves.
 *
 * The last four rows exist because Chromium's own source says there is a second, sharper
 * lever than "read size": `mojo_base::BigBuffer` inlines payloads up to `kMaxInlineBytes`
 * (64 KiB) and copies anything larger into a fresh shared memory region, which the
 * renderer then copies again into the `DOMArrayBuffer` it hands the page
 * (`services/device/usb/mojo/device_impl.cc` -> `mojo/public/cpp/base/big_buffer.h` ->
 * `modules/webusb/usb_in_transfer_result.h`). If that copy chain is the missing 269 MB/s,
 * reads of 64 KiB or less should beat reads just above the threshold at the same queue
 * size - the 64 x 65536 row against the 32 x 131072 row - and no read size above it should
 * help at all.
 */
const geometries = [
  ['5 x 3129344 (libsigrok probe)', 5, 3129344],
  ['4 x 3907584 (largest reads that fit)', 4, 3907584],
  ['3 x 3129344 (shallower)', 3, 3129344],
  ['5 x 1564672 (half reads)', 5, 1564672],
  ['10 x 1564672 (same budget, deeper)', 10, 1564672],
  ['16 x 978944 (same budget, deepest)', 16, 978944],
  ['20 x 782336 (small reads)', 20, 782336],
  ['32 x 131072 (just over the inline limit)', 32, 131072],
  ['64 x 65536 (inline, same queue)', 64, 65536],
  ['120 x 65536 (inline, 7.5 MiB)', 120, 65536],
  ['200 x 65536 (inline, 12.5 MiB)', 200, 65536],
];

const rateMBps = (mhz * 1e6 * channels) / 8 / 1e6;
const plan = geometries.map(([label, depth, transferBytes]) => {
  // The hard safety bound: the device cannot be asked to produce more than the reads
  // already in flight can hold, or the bytes behind them have nowhere to go when the host
  // is the slow side. Measured on hardware: a 1 s run at the default geometry aborted
  // after 44 MB, which is 15.6 MiB of queued reads plus a couple of MB of FIFO, so 80% of
  // the queued-read budget is the number to stay inside.
  const safeMB = Math.min(sliceMB, 0.8 * (depth * transferBytes) / 1e6);
  const seconds = +(safeMB / rateMBps).toFixed(4);
  return { label, depth, transferBytes, seconds, safeMB: +safeMB.toFixed(1) };
});

const expression = `(async () => {
  const app = window.logicweb;
  const dev = app.device;
  if (!dev) return { error: 'no device' };
  const plan = ${JSON.stringify(plan)};
  const out = { transport: dev.constructor.name, device: dev.name, runs: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const item of plan) {
    const run = { label: item.label, depth: item.depth, transferBytes: item.transferBytes,
      seconds: item.seconds, slices: [] };
    for (let i = 0; i < ${repeats}; i++) {
      const cmd = 'bench ' + item.seconds + ' ${channels} ${mhz} ' + item.depth + ' ' + item.transferBytes;
      try {
        const text = await dev.usbControl(cmd);
        const slice = { reply: text };
        const m = /(\\d+\\.\\d) MB\\/s, expected (\\d+) MB\\/s \\(ratio ([\\d.]+)\\)/.exec(text);
        if (m) Object.assign(slice, { MBps: +m[1], expected: +m[2], ratio: +m[3] });
        const t = /transfers\\s+(\\d+) calls, (\\d+) short/.exec(text);
        if (t) Object.assign(slice, { transfers: +t[1], short: +t[2] });
        const p = /transfer\\s+p50 ([\\d.]+) ms, p95 ([\\d.]+) ms/.exec(text);
        if (p) Object.assign(slice, { p50: +p[1], p95: +p[2] });
        // The queue never emptying is what says the device is not the one waiting: a
        // non-zero gap means the device had no read to fill, and the overrun that wedges
        // the board is measured from that moment (NOTES 8.7, 8.2).
        const g = /longest idle gap ([\\d.]+) ms/.exec(text);
        if (g) slice.idleGapMs = +g[1];
        const w = /blocked (\\d+) time\\(s\\), worst ([\\d.]+) ms/.exec(text);
        if (w) Object.assign(slice, { threadStalls: +w[1], threadStallMaxMs: +w[2] });
        run.slices.push(slice);
      } catch (e) { run.slices.push({ error: String(e) }); break; }
      await sleep(200);
    }
    const ok = run.slices.filter((s) => s.MBps > 0);
    if (ok.length) {
      const med = (key) => ok.map((s) => s[key]).sort((a, b) => a - b)[Math.floor(ok.length / 2)];
      run.median = {
        MBps: med('MBps'), p50: med('p50'), transfers: med('transfers'),
        idleGapMs: Math.max(...ok.map((s) => s.idleGapMs ?? 0)),
        threadStallMaxMs: Math.max(...ok.map((s) => s.threadStallMaxMs ?? 0)),
      };
    }
    try { run.flags = await dev.usbControl('flags'); } catch (e) { run.flags = 'ERR'; }
    out.runs.push(run);
    // FIFO_OV latched, or a slice that delivered nothing: stop, the board is wedged.
    if (!ok.length || /FIFO_OV=1/.test(run.flags)) { out.stoppedEarly = run.label; break; }
  }
  return out;
})()`;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'));
if (!page) {
  console.error(`no 127.0.0.1:5173 page on port ${port}; open the app there first`);
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (resolve) { pending.delete(message.id); resolve(message); }
};
const send = (method, params = {}) => new Promise((ok) => {
  const id = nextId++;
  pending.set(id, ok);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Page.reload', { ignoreCache: false });
// The app has to come back, claim the interface and re-acquire the grant before a run.
await new Promise((r) => setTimeout(r, 7000));

const reply = await new Promise((ok, bad) => {
  const timer = setTimeout(() => bad(new Error('timed out')), (repeats * plan.length * 3 + 60) * 1000);
  const id = nextId++;
  pending.set(id, (message) => { clearTimeout(timer); ok(message); });
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  }));
});
ws.close();

const result = reply.result?.result?.value;
if (!result) {
  console.error(JSON.stringify(reply, null, 2));
  process.exit(1);
}

console.log(`${channels}ch @ ${mhz} MHz (expected ${rateMBps.toFixed(0)} MB/s), ` +
  `${repeats} slices per geometry, capped at 80% of the queued reads and at most ` +
  `${sliceMB} MB, each ended by the device itself`);
if (result.error || !result.runs) {
  console.error(`${result.error ?? 'the page returned no runs'}` +
    ' - the device may not be granted to this page (open the app and connect first)');
  process.exit(2);
}
console.log(`${result.device} via ${result.transport}${result.stoppedEarly ? `, STOPPED at ${result.stoppedEarly}` : ''}\n`);
console.log('geometry                                  read ms p50   MB/s   of expected   transfers  short  idle gap  thread');
for (const run of result.runs) {
  const m = run.median;
  if (!m) {
    const why = run.slices[0]?.error
      ?? (run.slices[0]?.reply ?? '?').split('\n').map((s) => s.trim()).filter(Boolean)[0];
    console.log(`${run.label.padEnd(40)} no data: ${why}`);
    continue;
  }
  console.log(`${run.label.padEnd(40)} ${String(m.p50).padStart(9)}   ${String(m.MBps).padStart(6)}   ` +
    `${(m.MBps / rateMBps).toFixed(3).padStart(9)}   ${String(m.transfers).padStart(8)}  ` +
    `${String(run.slices.reduce((a, s) => a + (s.short ?? 0), 0)).padStart(5)}  ` +
    `${m.idleGapMs.toFixed(2).padStart(8)}  ${m.threadStallMaxMs.toFixed(1).padStart(6)}`);
}
console.log('\nA per-READ cost shows as the same read ms at every read size; a per-BYTE cost shows');
console.log('as read ms proportional to the read size. The device fills a read in 3.91 ms at');
console.log('32ch/200M and 7.82 ms at 32ch/100M (NOTES 8.2).');
console.log('Rows above and below 65536 B answer Chromium\'s 64 KiB BigBuffer threshold: a jump');
console.log('between 32 x 131072 and 64 x 65536 at the same queue size is the copy chain, and');
console.log('nothing above 64 KiB will move it.');
