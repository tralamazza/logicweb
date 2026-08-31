// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/*
 * Fail the build when a run-time asset is missing, rather than shipping a bundle that
 * looks fine and 404s on first use.
 *
 * `public/pyodide/` and `public/decoders/` are gitignored - they are vendored by
 * `npm run vendor` - so a fresh clone would otherwise build something that dies on the
 * first decode with no hint as to why.
 *
 * The two licence texts are checked for the same reason, one step removed: without them
 * the build still runs perfectly, and ships MPL-2.0 and PSF code with no notice
 * attached. A silent licensing defect is worse than a loud missing file.
 */
function requireRuntimeAssets(): Plugin {
  return {
    name: 'logicweb:runtime-assets',
    apply: 'build',
    buildStart() {
      const required = [
        ['public/pyodide', 'the Pyodide runtime'],
        ['public/decoders', 'the sigrok decoder tree'],
        ['public/pyodide/LICENSE-pyodide-MPL-2.0.txt', "Pyodide's licence"],
        ['public/pyodide/LICENSE-cpython-PSF.txt', "the embedded CPython's licence"],
      ] as const;
      const missing = required
        .filter(([p]) => !existsSync(resolve(__dirname, p)))
        .map(([p, what]) => `  ${p}  (${what})`);
      if (missing.length > 0) {
        this.error(
          `the build would 404 at run time, missing:\n${missing.join('\n')}\n` +
          `Run \`npm run vendor -- <libsigrokdecode/decoders>\`.`);
      }
    },
  };
}

/*
 * Put this project's own GPLv3 text in the published tree.
 *
 * GPLv3 section 6 wants the corresponding source offered to whoever receives the object
 * code, and the banner on each chunk points at the repository - but a deployment that
 * carries the licence itself needs no argument about whether a link is enough. It also
 * covers the bundled decoders, which are GPL and ship their per-file headers inside
 * decoders.zip but not the licence body.
 */
function emitLicense(): Plugin {
  return {
    name: 'logicweb:emit-license',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'LICENSE.txt',
        source: readFileSync(resolve(__dirname, 'LICENSE'), 'utf8'),
      });
    },
  };
}

/*
 * Every source file carries an SPDX header, but the minifier strips comments, so the
 * built bundles would otherwise reach users with no licence notice at all - which is
 * the one thing the GPL is actually about. Re-attach it to each emitted chunk.
 */
const BANNER =
  '/*! SPDX-License-Identifier: GPL-3.0-or-later\n' +
  ' * logicweb - Copyright (C) 2026 Daniel Tralamazza\n' +
  ' * Free software with NO WARRANTY, under GNU GPL v3 or later.\n' +
  ' * Source: https://github.com/tralamazza/logicweb\n' +
  ' */';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },

  /*
   * The decode worker is an ES module: it imports the Pyodide loader and the
   * decoder registry. Vite's default worker format is 'iife', which cannot use
   * import at all, so without this the worker fails at parse time in the
   * production build while still working in dev - the worst shape of bug.
   */
  worker: {
    format: 'es',
    rollupOptions: { output: { banner: BANNER } },
  },

  build: { rollupOptions: { output: { banner: BANNER } } },

  plugins: [requireRuntimeAssets(), emitLicense()],
});
