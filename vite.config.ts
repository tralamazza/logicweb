import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/*
 * Fail the build when a run-time asset is missing, rather than shipping a bundle that
 * looks fine and 404s on first use.
 *
 * `public/pyodide/` and `public/decoders/` are gitignored - they are vendored by
 * `npm run vendor` - so a fresh clone would otherwise build something that dies on the
 * first decode with no hint as to why.
 */
function requireRuntimeAssets(): Plugin {
  return {
    name: 'logicweb:runtime-assets',
    apply: 'build',
    buildStart() {
      const required = [
        ['public/pyodide', 'the Pyodide runtime'],
        ['public/decoders', 'the sigrok decoder tree'],
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

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },

  /*
   * The decode worker is an ES module: it imports the Pyodide loader and the
   * decoder registry. Vite's default worker format is 'iife', which cannot use
   * import at all, so without this the worker fails at parse time in the
   * production build while still working in dev - the worst shape of bug.
   */
  worker: { format: 'es' },

  plugins: [requireRuntimeAssets()],
});
