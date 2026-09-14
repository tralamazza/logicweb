// SPDX-License-Identifier: GPL-3.0-or-later
/** Known-answer smoke test for protocol decoding from dist/index.html over file://. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const PORT = 30000 + Math.floor(Math.random() * 20000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'logicweb-portable-'));
const urlOption = process.argv.find(arg => arg.startsWith('--url='));
const pageURL = urlOption?.slice('--url='.length) ||
  pathToFileURL(path.join(ROOT, 'dist/index.html')).href;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout, label) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* target is still starting */ }
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

if (!fs.existsSync(CHROMIUM)) throw new Error(`Chromium not found: ${CHROMIUM}`);

const browser = spawn(CHROMIUM, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions',
  '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserLog = '';
browser.stderr.on('data', chunk => { browserLog += chunk; });

let cdp;
let ws;

try {
  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    return targets.find(item => item.type === 'page');
  }, 20000, 'Chromium CDP target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket connection failed'));
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  };
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, 30000);
    pending.set(id, message => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const requests = [];
  await cdp('Network.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent') {
      requests.push(message.params.request.url);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      console.error('page exception:', message.params.exceptionDetails.text);
    }
    if (message.method === 'Log.entryAdded') {
      console.error('browser log:', message.params.entry.text);
    }
  });
  await cdp('Page.navigate', { url: pageURL });

  const result = await waitFor(async () => {
    const evaluated = await cdp('Runtime.evaluate', {
      expression: `window.logicweb?.decodeWarm ? 'ready' :
        window.logicweb?.statusError ? 'error:' + window.logicweb.statusError : ''`,
      returnByValue: true,
    });
    const value = evaluated.result.value;
    if (String(value).startsWith('error:')) throw new Error(value);
    return value === 'ready';
  }, 60000, 'embedded Pyodide warmup');
  if (!result) throw new Error('Pyodide did not become ready');

  const decoded = await cdp('Runtime.evaluate', {
    expression: `(async () => {
      const samplerate = 8000000, baudrate = 115200, byte = 0x55;
      const bits = [0, ...Array.from({length: 8}, (_, i) => (byte >> i) & 1), 1];
      const edges = [], spb = samplerate / baudrate, head = 200;
      let level = 1, pos = 0, sample = head;
      for (const bit of bits) {
        pos += spb;
        const next = head + Math.round(pos);
        if (bit !== level) { edges.push(sample); level = bit; }
        sample = next;
      }
      if (level !== 1) edges.push(sample);
      const response = await window.logicweb.decodeClient.decode({
        samplerate, length: sample + 400,
        channels: [{edges: Int32Array.from(edges), initial: 1}],
        stack: [{id: 'uart', channels: {0: 0}, options: {baudrate}}],
      });
      return JSON.stringify({count: response.annotations.count,
        errors: response.errors, texts: response.annotations.texts});
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (decoded.exceptionDetails) throw new Error(decoded.exceptionDetails.text);
  const answer = JSON.parse(decoded.result.value);
  if (answer.errors.length || answer.count === 0 || !answer.texts.some(t => /55/i.test(t))) {
    throw new Error(`UART known-answer mismatch: ${JSON.stringify(answer)}`);
  }

  if (pageURL.startsWith('file:')) {
    const external = requests.filter(url =>
      url !== pageURL && !url.startsWith('blob:') && !url.startsWith('data:'));
    if (external.length) throw new Error(`unexpected external requests: ${external.join(', ')}`);
  }
  console.log(JSON.stringify({ ok: true, protocol: 'uart', byte: '0x55',
    annotations: answer.count, requests }, null, 2));
  ws.close();
} catch (error) {
  if (cdp) {
    try {
      const state = await cdp('Runtime.evaluate', {
        expression: `JSON.stringify({ready: document.readyState,
          hasApp: !!window.logicweb, warm: window.logicweb?.decodeWarm,
          status: window.logicweb?.statusError,
          pending: window.logicweb?.decodeClient?.pending?.size,
          worker: !!window.logicweb?.decodeClient?.worker})`,
        returnByValue: true,
      });
      console.error('page state:', state.result.value);
    } catch { /* CDP may already be gone */ }
  }
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    console.error('targets:', targets.map(item => ({ type: item.type, url: item.url })));
  } catch { /* browser may already be gone */ }
  if (browserLog) console.error('Chromium stderr:', browserLog.slice(-4000));
  throw error;
} finally {
  browser.kill();
  console.error(`temporary Chromium profile: ${profile}`);
}
