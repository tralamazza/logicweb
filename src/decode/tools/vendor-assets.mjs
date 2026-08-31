// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
// Stage the two runtime assets the decode worker fetches at run time:
//
//   public/pyodide/          the Pyodide runtime (wasm + stdlib)
//   public/decoders/decoders.zip   the stock libsigrokdecode decoder tree
//
// Both go under public/ because that is Vite's zero-config static directory -
// no vite.config.ts is created, so this cannot collide with another module's
// build settings. Everything written here is generated; nothing is edited by
// hand.
//
// Usage:
//   node src/decode/tools/vendor-assets.mjs <libsigrokdecode/decoders>
//
// Requires `pyodide` in node_modules and `zip` on PATH.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '../../..');
const PUBLIC = path.join(ROOT, 'public');
const decodersSrc = process.argv[2];

if (!decodersSrc || !fs.existsSync(decodersSrc)) {
  console.error('usage: vendor-assets.mjs <path to libsigrokdecode/decoders>');
  console.error('clone it with: git clone --depth 1 https://github.com/sigrokproject/libsigrokdecode');
  process.exit(1);
}

// -- Pyodide runtime ---------------------------------------------------------
// Only the files loadPyodide() actually pulls; the package also ships console
// pages, source maps and type declarations that have no business in a build.
const KEEP = [
  'pyodide.js', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.mjs',
  'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json',
];

let pyodideDir;
try {
  pyodideDir = path.dirname(require.resolve('pyodide/package.json'));
} catch {
  console.error('pyodide not installed. Run: npm i pyodide');
  process.exit(1);
}

const outPy = path.join(PUBLIC, 'pyodide');
fs.mkdirSync(outPy, { recursive: true });
let pyBytes = 0;
for (const f of KEEP) {
  const src = path.join(pyodideDir, f);
  if (!fs.existsSync(src)) continue;   // .asm.js only exists on some builds
  fs.copyFileSync(src, path.join(outPy, f));
  pyBytes += fs.statSync(src).size;
}
const pyVersion = JSON.parse(
  fs.readFileSync(path.join(pyodideDir, 'package.json'), 'utf8')).version;

// -- Decoder tree ------------------------------------------------------------
// zipimport reads these straight out of the archive, which is what
// libsigrokdecode itself does for zipped decoder sets.
const outDec = path.join(PUBLIC, 'decoders');
fs.mkdirSync(outDec, { recursive: true });
const zipPath = path.join(outDec, 'decoders.zip');
fs.rmSync(zipPath, { force: true });
execFileSync('zip', ['-q', '-r', '-9', zipPath, '.',
  '-x', '*.pyc', '*__pycache__*', '*.sr', '*.output'],
  { cwd: decodersSrc, stdio: 'inherit' });

const decIds = fs.readdirSync(decodersSrc, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== 'common' &&
               fs.existsSync(path.join(decodersSrc, d.name, 'pd.py')))
  .map(d => d.name).sort();

// -- Manifest ----------------------------------------------------------------
execFileSync('python3', [
  path.join(import.meta.dirname, 'build-manifest.py'),
  decodersSrc,
  path.join(import.meta.dirname, '..', 'decoders', 'manifest.ts'),
], { stdio: 'inherit' });

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(`pyodide ${pyVersion}: ${KEEP.length} files, ${mb(pyBytes)} -> public/pyodide/`);
console.log(`decoders: ${decIds.length} decoders, ${mb(fs.statSync(zipPath).size)} -> public/decoders/decoders.zip`);
