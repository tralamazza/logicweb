#!/usr/bin/env node
/**
 * Tiny collector so a self-test run in the browser can be read back from the
 * terminal. Run it alongside `npx vite`:
 *
 *   node src/device/result-server.mjs
 *
 * It writes each POSTed report to /tmp/slogic-selftest.json and prints a
 * summary. It exists only for the self test; nothing in src/device depends on
 * it, and the page works fine without it.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const PORT = 5177;
const OUT = '/tmp/slogic-selftest.json';

createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/result')) {
    res.writeHead(404).end();
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    writeFileSync(OUT, body);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      console.error('report is not valid JSON:', e);
      return;
    }
    const failed = (parsed.checks ?? []).filter((c) => !c.pass);
    console.log(
      `[${new Date().toISOString()}] report: ${(parsed.checks ?? []).length} checks, ` +
        `${failed.length} failed, peak ${parsed.peakMBps?.toFixed?.(1) ?? '?'} MB/s -> ${OUT}`,
    );
    for (const f of failed) console.log('  FAILED:', f.name, JSON.stringify(f));
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`result collector on http://127.0.0.1:${PORT}/result -> ${OUT}`);
});
