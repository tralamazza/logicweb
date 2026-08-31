/**
 * Node entry point for the correctness suite. The browser runs the same code from
 * src/data/bench/main.ts; node is here because the edit-run loop is faster.
 *
 *   node_modules/.bin/esbuild src/data/bench/runtests.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/logicweb-tests.mjs && node /tmp/logicweb-tests.mjs
 */

import { runFastSuite, testNarrowGlitch, formatResults, type TestResult } from '../selftest.js';
import { nodeProcess } from './nodeglobals.js';

const proc = nodeProcess();
const args = new Set(proc.argv.slice(2));
const log = (s: string) => console.log(s);

const results: TestResult[] = [];
results.push(...runFastSuite(log));

if (args.has('--glitch-100m')) {
  log('100M-sample narrow glitch cases (this allocates ~230 MB per case)');
  // Positions chosen to hit the awkward alignments: a pyramid bin boundary, one sample
  // before one, an odd position mid-bin, the very first sample and the very last.
  results.push(...testNarrowGlitch(log, 100_000_000, [0]));
  results.push(...testNarrowGlitch(log, 100_000_000, [65_536 * 700]));
  results.push(...testNarrowGlitch(log, 100_000_000, [65_536 * 700 - 1]));
  results.push(...testNarrowGlitch(log, 100_000_000, [37_123_457]));
  results.push(...testNarrowGlitch(log, 100_000_000, [99_999_999]));
}

console.log('\n' + formatResults(results));
proc.exit(results.every((r) => r.pass) ? 0 : 1);
