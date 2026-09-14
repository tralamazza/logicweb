// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Runs `windowHarness.ts` in a browser and prints both arms as JSON.
 *
 * The harness needs a real browser - two threads and a real store - and a dev server for the
 * module graph, so this attaches to an already-running Chromium that has the app open:
 *
 *   npm run dev
 *   chromium --headless=new --remote-debugging-port=9236 --user-data-dir=/tmp/lw-gpu \
 *            --use-angle=gl --enable-gpu --ignore-gpu-blocklist http://127.0.0.1:5173/
 *   node src/device/tools/window-bench.mjs 9236 2
 *
 * Usage: node window-bench.mjs [port] [seconds] [bytesPerMs] [stallMs] [stallEveryMs]
 */

const port = process.argv[2] ?? '9236';
const seconds = process.argv[3] ?? '2';
const bytesPerMs = process.argv[4] ?? '800000';
const stallMs = process.argv[5] ?? '0';
const stallEveryMs = process.argv[6] ?? '300';

const expression = `(async () => {
  const m = await import('/src/device/tools/windowHarness.ts');
  const options = { seconds: ${seconds}, bytesPerMs: ${bytesPerMs}, stallMs: ${stallMs}, stallEveryMs: ${stallEveryMs} };
  const out = {};
  try { out.page = await m.runPageArm(options); }
  catch (e) { out.page = { error: String(e) }; }
  try { out.worker = await m.runWorkerArm(options); }
  catch (e) { out.worker = { error: String(e) }; }
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
const reply = await new Promise((ok, bad) => {
  // Two arms of `seconds` each, plus the store and the capture start-up, plus the stop path.
  const timer = setTimeout(() => bad(new Error('timed out')), (Number(seconds) * 2 + 60) * 1000);
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    ok(message);
  };
  ws.send(JSON.stringify({
    id: 1,
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
console.log(JSON.stringify(result, null, 2));

for (const arm of ['page', 'worker']) {
  const r = result[arm];
  if (!r) continue;
  if (r.error) {
    console.log(`\n${arm.padEnd(6)} ABORTED after ${r.transfers} transfers ` +
      `(${r.storeMB.toFixed(0)} MB of ${(r.expectedMBps * r.seconds / 1e3 * 1000).toFixed(0)} MB): ` +
      r.error.split(': ').slice(2).join(': '));
    continue;
  }
  console.log(`\n${arm.padEnd(6)} ${r.rawMBps.toFixed(1)} MB/s of ${r.expectedMBps} ` +
    `(${(100 * r.rawMBps / r.expectedMBps).toFixed(1)}%), ${r.transfers} transfers, ` +
    `${r.shortTransfers} short, ${r.slowTransfers} slow, starved ${r.starvedMs.toFixed(1)} ms ` +
    `(worst ${r.worstStarveMs.toFixed(1)}), lost ${(r.droppedBytes / 1e6).toFixed(1)} MB, ` +
    `store ${r.storeMB.toFixed(0)} MB, page stalls ${r.pageStallMaxMs.toFixed(1)} ms, ` +
    `${arm} thread stalls ${r.threadStallMaxMs.toFixed(1)} ms`);
}
