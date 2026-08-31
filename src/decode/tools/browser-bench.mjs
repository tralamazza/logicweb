// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
// Drive src/decode/bench in real Brave (Chromium) over CDP and print the
// numbers. Re-runnable, no devtools eyeballing.
//
//   node src/decode/tools/browser-bench.mjs [--headed]
//
// Starts `vite`, launches Brave against the bench page, waits for
// window.benchResult, prints it as JSON, and exits non-zero if the in-page
// known-answer check failed.

import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const HEADED = process.argv.includes('--headed');
// --prod builds the bench and serves the static output, so the production
// bundle is exercised and not just the dev server's on-the-fly transform.
const PROD = process.argv.includes('--prod');
// Random ports: other agents run dev servers on this machine, and a fixed
// port turns their server into our silent, wrong answer.
const pick = () => 20000 + Math.floor(Math.random() * 20000);
const PORT = pick();
const CDP_PORT = pick();

if (!fs.existsSync(BRAVE)) {
  console.error(`Brave not found at ${BRAVE}`);
  process.exit(1);
}
for (const p of ['public/pyodide/pyodide.js', 'public/decoders/decoders.zip']) {
  if (!fs.existsSync(path.join(ROOT, p))) {
    console.error(`missing ${p} - run: node src/decode/tools/vendor-assets.mjs <decoders dir>`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const DIST = path.join(os.tmpdir(), 'lw-decode-dist');
if (PROD) {
  execFileSync('npx', ['vite', 'build', 'src/decode/bench', '--outDir', DIST, '--emptyOutDir'],
    { cwd: ROOT, stdio: 'inherit' });
  // The bench is built with src/decode/bench as its root, so the repo's
  // public/ is not copied automatically; the runtime assets have to come along.
  for (const d of ['pyodide', 'decoders']) {
    fs.cpSync(path.join(ROOT, 'public', d), path.join(DIST, d), { recursive: true });
  }
}
const vite = PROD
  ? spawn('npx', ['vite', 'preview', '--outDir', DIST, '--host', '127.0.0.1',
                  '--port', String(PORT), '--strictPort'],
          { cwd: path.join(ROOT, 'src/decode/bench'), stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
          { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let viteLog = '';
vite.stdout.on('data', d => { viteLog += d; });
vite.stderr.on('data', d => { viteLog += d; });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-bench-'));
let brave;
let code = 1;
try {
  // Probe the bench page itself: the repo has no root index.html, so '/' is a
  // 404 and would never report ready.
  const url = PROD
    ? `http://127.0.0.1:${PORT}/index.html`
    : `http://127.0.0.1:${PORT}/src/decode/bench/index.html`;
  await waitFor(async () => (await fetch(url)).ok, 30000, 'vite to serve the bench page');
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    ...(HEADED ? [] : ['--headless=new']),
    url,
  ];
  brave = spawn(BRAVE, args, { stdio: 'ignore' });

  const target = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const list = await r.json();
    return list.find(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}/`));
  }, 30000, 'the bench page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('CDP connect failed')); });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  };
  const cdp = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await cdp('Runtime.enable');
  await cdp('Log.enable');

  // The page auto-runs the bench; poll for the result rather than racing it.
  const res = await waitFor(async () => {
    const r = await cdp('Runtime.evaluate', {
      expression: 'window.benchResult ? JSON.stringify(window.benchResult) : ""',
      returnByValue: true, awaitPromise: false,
    });
    const v = r.result?.result?.value;
    return v ? JSON.parse(v) : null;
  }, 180000, 'window.benchResult');

  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) {
    console.error('\nBENCH FAILED:', res.error);
  } else {
    console.log(`\ndecoders            ${res.decoderCount}`);
    console.log(`capture             ${res.captureSamples} samples`);
    console.log(`cold start          ${res.coldStartMs.toFixed(0)} ms to first annotation (pyodide load ${res.pyodideLoadMs.toFixed(0)} ms, ${res.coldAnnotations} anns)`);
    console.log(`warm decode         ${res.warmDecodeMs.toFixed(0)} ms for ${res.warmAnnotations} annotations`);
    console.log(`annotations/sec     ${res.annPerSec}`);
    console.log(`saturated 5s uart   ${res.heavyBytes} bytes, ${res.heavyAnnotations} anns in ${res.heavyDecodeMs.toFixed(0)} ms (${res.heavyAnnPerSec}/s)`);
    console.log(`bytes verified      ${res.bytesDecoded}/${res.bytesExpected} ${res.bytesMatch ? 'MATCH' : 'MISMATCH'}`);
    console.log(`stack i2c->eeprom   ${res.stackedAnnotations} stacked anns of ${res.stackAnnotations}`);
    console.log(`cancel              ${res.cancelOk ? 'OK' : 'FAIL'} in ${res.cancelMs.toFixed(0)} ms via ${res.cancelMode}; reusable after: ${res.reusableAfterCancel}`);
    console.log(`timeout             ${res.timeoutOk ? 'OK' : 'FAIL'}`);
    console.log(`limits refused      ${res.limitsOk ? 'OK' : 'FAIL ' + res.limitErrors.join("; ")}`);
    console.log('real-signal known-answer checks:');
    for (const h of res.hw) {
      console.log(`  ${h.protocol.padEnd(5)} "${h.command}" -> [${h.decoded}] expected [${h.expected}] ${h.match ? 'MATCH' : 'MISMATCH'} (${h.decodeMs.toFixed(1)} ms warm, ${h.annotations} anns)`);
    }
    code = 0;
  }
  ws.close();
} catch (e) {
  console.error('bench harness failed:', e.message);
  console.error('--- vite log ---\n' + viteLog.slice(-2000));
} finally {
  brave?.kill();
  vite.kill();
  // Deliberately NOT deleting the temp Brave profile: no recursive removal
  // from a script. It lives under os.tmpdir() and the OS reclaims it.
  console.error(`(temp browser profile left at ${profile})`);
}
process.exit(code);
