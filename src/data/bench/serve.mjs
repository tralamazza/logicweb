/**
 * Serves the benchmark page with the COOP/COEP headers that
 * performance.measureUserAgentSpecificMemory() requires, collects the result the page
 * posts back, writes it to disk and exits.
 *
 * Bundle first, then run:
 *   node_modules/.bin/esbuild src/data/bench/main.ts --bundle --format=esm \
 *     --outfile=/tmp/logicweb-bench/main.js
 *   cp src/data/bench/index.html /tmp/logicweb-bench/
 *   node src/data/bench/serve.mjs /tmp/logicweb-bench /tmp/logicweb-bench/result.json 5297
 *
 * Then open http://127.0.0.1:5297/ in Brave, or let run-browser.sh drive it headless.
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const root = process.argv[2];
const outFile = process.argv[3];
const port = Number(process.argv[4] ?? 5297);
if (!root || !outFile) {
  console.error('usage: serve.mjs <static-root> <result-json-path> [port]');
  process.exit(2);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };

const server = createServer(async (req, res) => {
  // Cross-origin isolation. Without both of these, crossOriginIsolated is false and the
  // exact memory API is simply absent - which would silently downgrade the measurement.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'POST' && req.url === '/result') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    await writeFile(outFile, body);
    res.writeHead(204).end();
    console.log(`result written to ${outFile} (${body.length} bytes)`);
    setTimeout(() => { server.close(); process.exit(0); }, 200);
    return;
  }

  // The page streams its log here too, so a run that dies mid-way still leaves a trace
  // instead of just an idle renderer and an empty output file.
  if (req.method === 'POST' && req.url === '/log') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    console.log(`[page] ${Buffer.concat(chunks).toString('utf8')}`);
    res.writeHead(204).end();
    return;
  }

  // Strip the query string *before* deciding whether this is the root request. Doing it
  // the other way round makes "/?samples=..." resolve to the directory itself, which
  // fails with EISDIR and serves a 404 for the page - an idle renderer, not an error.
  const bare = (req.url ?? '/').split('?')[0];
  const path = bare === '/' || bare === '' ? '/index.html' : bare;
  try {
    const buf = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(buf);
    console.log(`GET ${req.url} -> 200 (${buf.length} bytes)`);
  } catch (err) {
    res.writeHead(404).end('not found');
    console.log(`GET ${req.url} -> 404 (${err.code})`);
  }
});

server.on('error', (err) => {
  console.error(`could not listen on 127.0.0.1:${port}: ${err.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`serving on http://127.0.0.1:${port}/`));

// Do not hang forever if the page dies without posting.
setTimeout(() => {
  console.error('timed out waiting for the page to post a result');
  process.exit(1);
}, 15 * 60 * 1000).unref?.();
