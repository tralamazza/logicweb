// SPDX-License-Identifier: GPL-3.0-or-later
/** Build a complete, debug-friendly static distribution into dist/. */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const decoderCandidates = [
  process.argv[2],
  process.env.SRD_DECODERS,
  path.resolve(ROOT, '../libsigrokdecode/decoders'),
  path.resolve(ROOT, '../SLogic/sources/libsigrokdecode/decoders'),
].filter(Boolean);
const decoders = decoderCandidates.find((p) =>
  fs.existsSync(path.join(path.resolve(p), 'uart', 'pd.py')));

if (!decoders) {
  console.error('Could not find libsigrokdecode/decoders.');
  console.error('Use: npm run dist -- /path/to/libsigrokdecode/decoders');
  console.error('Or set SRD_DECODERS=/path/to/libsigrokdecode/decoders.');
  process.exit(1);
}

const run = (file, args, env = {}) => execFileSync(file, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ...env },
});
run(process.execPath, [path.join(ROOT, 'src/decode/tools/vendor-assets.mjs'), path.resolve(decoders)]);
run(path.join(ROOT, 'node_modules/.bin/tsc'), ['--noEmit']);
run(path.join(ROOT, 'node_modules/.bin/vite'), ['build'], { LOGICWEB_PORTABLE: '1' });

console.log(`\nStatic distribution ready: ${path.join(ROOT, 'dist')}`);
console.log('Node/npm are not required to run the generated files.');
console.log('Double-click dist/index.html for capture, USB debug and protocol decoding.');
console.log('index.html is standalone; retain the adjacent licence texts when redistributing it.');
