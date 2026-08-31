// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
// Differential conformance harness: run every stock decoder under the Pyodide
// shim and under native sigrok-cli on the *same* capture, and diff the
// annotations (sample numbers included). A decoder only counts as "runs" if
// its output is byte-identical to libsigrokdecode's.
//
// Usage: node conformance.mjs <capture.bin> <numchannels> <samplerate> [decoder-id ...]
// Requires: sigrok-cli on PATH, SRD_DECODERS pointing at a libsigrokdecode
// decoders/ checkout, PYODIDE_DIR pointing at the pyodide npm package.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const { loadPyodide } = await import(process.env.PYODIDE_DIR + '/pyodide.mjs');

const SRD_DECODERS = process.env.SRD_DECODERS;
const DECODERS_ZIP = process.env.DECODERS_ZIP;
const PY_SHIM = path.resolve(import.meta.dirname, '../py');

const [capFile, nchStr, srStr, ...only] = process.argv.slice(2);
const NCH = parseInt(nchStr, 10);
const SR = parseInt(srStr, 10);
const buf = fs.readFileSync(capFile);

// libsigrok packs logic samples as ceil(numchannels/8) bytes per sample,
// little endian, so a 16-channel capture is 2 bytes/sample.
const UNIT = Math.ceil(NCH / 8);
const NSAMP = Math.floor(buf.length / UNIT);

function edgesFrom(b, ch) {
  const byteOff = ch >> 3, bitOff = ch & 7;
  const edges = [];
  const initial = (b[byteOff] >> bitOff) & 1;
  let prev = initial;
  for (let i = 1; i < NSAMP; i++) {
    const v = (b[i * UNIT + byteOff] >> bitOff) & 1;
    if (v !== prev) { edges.push(i); prev = v; }
  }
  return [edges, initial];
}
const signals = [];
for (let c = 0; c < NCH; c++) signals.push(edgesFrom(buf, c));

const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });

// A decode runs synchronously inside runPython and blocks node's event loop,
// so a setTimeout watchdog can never fire. Pyodide's interrupt buffer is the
// only way out: a worker thread writes to it after DECODE_TIMEOUT_MS and the
// interpreter raises KeyboardInterrupt. Without this a decoder that fails to
// advance hangs the whole sweep silently - which it did, for 180 s, before an
// external watchdog noticed.
const DECODE_TIMEOUT_MS = Number(process.env.DECODE_TIMEOUT_MS || 120000);
const interrupt = new Uint8Array(new SharedArrayBuffer(1));
py.setInterruptBuffer(interrupt);
// [0]=armed, [1]=deadline in ms *since EPOCH0*. Date.now() is ~1.77e12 and
// silently wraps in an Int32Array, which made the watchdog fire instantly on
// every decode - so store a small relative value instead.
const EPOCH0 = Date.now();
const deadline = new Int32Array(new SharedArrayBuffer(12));   // [0]=armed [1]=deadline [2]=fired
const watchdog = new Worker(
  `import { workerData } from 'node:worker_threads';
   const { deadline, interrupt, EPOCH0 } = workerData;
   setInterval(() => {
     if (Atomics.load(deadline, 0) === 1 && (Date.now() - EPOCH0) > Atomics.load(deadline, 1)) {
       interrupt[0] = 2;                       // raise KeyboardInterrupt
       Atomics.store(deadline, 0, 0);
       Atomics.store(deadline, 2, 1);          // record that we really fired
     }
   }, 50);`,
  { eval: true, workerData: { deadline, interrupt, EPOCH0 } });
// A dead watchdog silently removes the only timeout, so make it fatal rather
// than letting a sweep hang. (It died for a week's worth of runs because the
// eval body used require() inside an ESM package.)
watchdog.on('error', (e) => {
  console.error('FATAL: decode watchdog failed to start:', e.message);
  process.exit(2);
});
const armWatchdog = () => {
  interrupt[0] = 0;
  Atomics.store(deadline, 2, 0);
  Atomics.store(deadline, 1, (Date.now() - EPOCH0) + DECODE_TIMEOUT_MS);
  Atomics.store(deadline, 0, 1);
};
const disarmWatchdog = () => Atomics.store(deadline, 0, 0);
py.FS.writeFile('/decoders.zip', fs.readFileSync(DECODERS_ZIP));
py.FS.mkdir('/srd');
for (const f of ['sigrokdecode.py', 'srdengine.py'])
  py.FS.writeFile('/srd/' + f, fs.readFileSync(path.join(PY_SHIM, f)));
py.runPython(`
import sys
sys.path.insert(0, '/srd')
sys.path.insert(0, '/decoders.zip')
import srdengine
`);

// allIds is the full set: producer lookup for stacked decoders has to search
// every decoder, not just the subset asked for on the command line.
const allIds = fs.readdirSync(SRD_DECODERS, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== 'common' &&
               fs.existsSync(path.join(SRD_DECODERS, d.name, 'pd.py')))
  .map(d => d.name).sort();
const ids = only.length ? allIds.filter(i => only.includes(i)) : allIds;

const results = { match: [], mismatch: [], skipped: [], nativeError: [], shimError: [] };
let totalAnnotations = 0;
let multiVariantAnnotations = 0;
let classRuns = 0;
let oracleChecked = 0;

/**
 * External oracle for annotation *text variants*.
 *
 * sigrok-cli only ever prints the first text of an annotation, so variants
 * 2..n cannot be diffed against the reference at all, and a round-trip check
 * cannot see a drop that happens before packing. The one source of truth left
 * is the upstream decoder itself: scan its .py for literal lists of two or
 * more string literals - `['Start bit', 'Start', 'S']` at uart/pd.py:284 and
 * so on - and require that whenever we emit an annotation whose first text
 * matches such a literal, we emit the whole list and not a truncation.
 */
const variantLiteralCache = new Map();
function variantLiterals(decId) {
  if (variantLiteralCache.has(decId)) return variantLiteralCache.get(decId);
  const byFirst = new Map();
  try {
    const src = fs.readFileSync(path.join(SRD_DECODERS, decId, 'pd.py'), 'utf8');
    const lines = src.split('\n');
    const strRe = /'[^'\\\n]*'|"[^"\\\n]*"/;
    const listRe = new RegExp(
      `\\[\\s*((?:${strRe.source})(?:\\s*,\\s*(?:${strRe.source}))+)\\s*,?\\s*\\]`, 'g');
    for (let i = 0; i < lines.length; i++) {
      // Only literals inside an annotation emission. Scanning every list in
      // the file produced false positives off plain data tables - usb_packet's
      // pid dict, nes_gamepad's button names - which are not text variants.
      if (!/\bput\w*\s*\(/.test(lines[i])) continue;
      const region = lines.slice(i, i + 3).join(' ');
      for (const m of region.matchAll(listRe)) {
        const parts = m[1].split(/\s*,\s*/).map(t => t.slice(1, -1));
        if (parts.length < 2) continue;
        const key = parts[0];
        if (!byFirst.has(key)) byFirst.set(key, []);
        const seen = byFirst.get(key);
        if (!seen.some(l => l.join('\u0000') === parts.join('\u0000'))) seen.push(parts);
      }
    }
    // A first text that maps to more than one distinct variant list cannot
    // identify which one a given annotation came from, so it proves nothing.
    // sdcard_sd emits both ['Reserved','Res','R'] and ['Reserved','RSVD'].
    for (const [k, v] of [...byFirst]) if (v.length !== 1) byFirst.delete(k);
  } catch { /* no readable source; oracle simply has no entries */ }
  variantLiteralCache.set(decId, byFirst);
  return byFirst;
}

function variantDiff(decId, texts) {
  const lits = variantLiterals(decId);
  if (!lits.size) return null;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const cands = lits.get(t[0]);
    if (!cands) continue;
    const lit = cands[0];
    if (lit.length !== t.length || lit.some((x, j) => x !== t[j])) {
      return `annotation ${i} text variants differ from the decoder source: ` +
             `emitted ${JSON.stringify(t)} but ${decId}/pd.py has ` +
             `${JSON.stringify(lit)}`;
    }
  }
  return null;
}

/**
 * Verify the annotation class of every annotation against sigrok-cli, which
 * can filter its output to one class at a time. Returns null when every class
 * agrees, or a description of the first disagreement.
 */
function classDiff(id, pdSpec, annClasses, ss, es, cls, texts) {
  for (let c = 0; c < annClasses.length; c++) {
    const mineLines = [];
    for (let i = 0; i < ss.length; i++) {
      if (cls[i] === c) mineLines.push(`${ss[i]}-${es[i]} ${id}-1: ${texts[i][0]}`);
    }
    let nativeCls;
    try {
      classRuns++;
      nativeCls = execFileSync('sigrok-cli', [
        '-i', capFile, '-I', `binary:numchannels=${NCH}:samplerate=${SR}`,
        '-P', pdSpec, '-A', `${id}=${annClasses[c].id}`, '--protocol-decoder-samplenum',
      ], { env: { ...process.env, SIGROKDECODE_DIR: SRD_DECODERS },
           maxBuffer: 1 << 30, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      return `class "${annClasses[c].id}": sigrok-cli failed: ${String(e.message).slice(0, 120)}`;
    }
    const mineTxt = mineLines.length ? mineLines.join('\n') + '\n' : '';
    if (mineTxt !== nativeCls) {
      const a = nativeCls.split('\n'), b = mineTxt.split('\n');
      let d = 0; while (d < a.length && d < b.length && a[d] === b[d]) d++;
      return `class ${c} ("${annClasses[c].id}"): native ${a.length - 1} lines / ` +
             `shim ${b.length - 1}; first diff line ${d + 1}: ` +
             `native=${JSON.stringify(a[d] ?? null)} shim=${JSON.stringify(b[d] ?? null)}`;
    }
  }
  return null;
}

const describe = (id) => JSON.parse(py.runPython(
  `import json; json.dumps(srdengine.describe(${JSON.stringify(id)}))`));

// ir_irmp dlopens a native library at import time, so describing every
// decoder cannot be assumed to succeed. Record the failure and carry on.
const info = {};
const undescribable = {};
for (const id of allIds) {
  try { info[id] = describe(id); }
  catch (e) {
    undescribable[id] = String(e.message).split('\n').filter(l => /Error/.test(l)).join(' ').slice(0, 200);
    info[id] = { inputs: [], outputs: [], channels: [], optional_channels: [] };
  }
}

// A decoder is sample driven iff it declares inputs == ['logic']; everything
// else consumes another decoder's OUTPUT_PYTHON stream and needs a producer
// underneath it. (uart's channels are all *optional*, so counting required
// channels is the wrong discriminator.)
const isLogic = (i) => i.inputs.length === 1 && i.inputs[0] === 'logic';
// Prefer a sample-driven producer. Some decoders both consume and produce a
// stream (arm_tpiu is inputs ['uart'] / outputs ['uart']) and sort earlier
// than the real source, so picking the first match by name builds a cycle.
const producerFor = (want, seen) => {
  const cands = allIds.filter(p => !seen.has(p) && info[p].outputs.includes(want));
  return cands.find(p => isLogic(info[p])) ?? cands[0];
};

/**
 * Build the chain of decoders needed to feed `id` from raw logic, bottom
 * first. sigrok stacks can be more than two deep - ds2408 needs
 * onewire_link -> onewire_network -> ds2408, usb_request needs
 * usb_signalling -> usb_packet -> usb_request - so walk producers until a
 * logic-level decoder is reached.
 */
function chainFor(id) {
  const chain = [id];
  const seen = new Set([id]);
  for (let depth = 0; depth < 8; depth++) {
    const bottom = info[chain[0]];
    if (isLogic(bottom)) return chain;
    if (bottom.inputs.length !== 1) return null;
    const p = producerFor(bottom.inputs[0], seen);
    if (!p) return null;
    seen.add(p);
    chain.unshift(p);
  }
  return null;
}

for (const id of ids) {
  if (undescribable[id]) { results.shimError.push([id, 'import: ' + undescribable[id]]); continue; }
  const chain = chainFor(id);
  if (!chain) {
    results.skipped.push([id, `no producer chain down to logic for inputs ${JSON.stringify(info[id].inputs)}`]);
    continue;
  }
  const base = chain[0];
  const bi = info[base];
  const chans = [...bi.channels, ...bi.optional_channels];
  if (bi.channels.length > NCH) { results.skipped.push([id, `base ${base} needs more channels than capture has`]); continue; }

  // Deterministic assignment: decoder channel i -> capture channel i.
  const assign = chans.slice(0, NCH).map((c, i) => [c.id, i]);
  const chanMap = {};
  assign.forEach(([, cap], i) => { chanMap[i] = cap; });

  let pdSpec = base + ':' + assign.map(([cid, cap]) => `${cid}=${cap}`).join(':');
  if (chain.length > 1) pdSpec += ',' + chain.slice(1).join(',');
  // sigrok-cli exits 0 even when a decoder throws; it only prints the
  // traceback on stderr. Treat that as a native failure, or we would be
  // diffing our full output against a truncated one.
  let native;
  try {
    const r = execFileSync('sigrok-cli', [
      '-i', capFile, '-I', `binary:numchannels=${NCH}:samplerate=${SR}`,
      '-P', pdSpec, '-A', id, '--protocol-decoder-samplenum',
    ], { env: { ...process.env, SIGROKDECODE_DIR: SRD_DECODERS },
         maxBuffer: 1 << 30, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
    native = r.toString('utf8');
  } catch (e) {
    results.nativeError.push([id, String(e.stderr || e.message).trim().slice(0, 200)]);
    continue;
  }
  const nativeErr = execFileSync('sh', ['-c',
    `SIGROKDECODE_DIR=${SRD_DECODERS} sigrok-cli -i ${capFile} ` +
    `-I binary:numchannels=${NCH}:samplerate=${SR} -P '${pdSpec}' -A ${id} ` +
    `--protocol-decoder-samplenum 2>&1 >/dev/null | head -c 400`],
    { encoding: 'utf8', maxBuffer: 1 << 20 });
  if (/^srd: .*(Error|Exception)/m.test(nativeErr)) {
    results.nativeError.push([id, nativeErr.replace(/\s+/g, ' ').trim().slice(0, 200)]);
    continue;
  }

  let mine;
  let ss = [], es = [], cls = [], texts = [];
  try {
    armWatchdog();
    // Query exactly the way worker.ts does: packed struct-of-arrays over the
    // buffer protocol, not json.dumps. Besides being what the application
    // ships, JSON of millions of annotations built a several-hundred-MB string
    // inside Pyodide and came back corrupted.
    const raw = py.runPython(`
import srdengine
S = srdengine.Session(SR, LENGTH, SIGNALS, eof_mode=EOFMODE)
want = S.add(CHAIN[0], CHAIN[0] + '-1', CHANS, None)
for _d in CHAIN[1:]:
    want = S.add(_d, _d + '-1', {}, None, stack_on=want)
errs = S.run()
p = S.packed_results()
p['errors'] = errs
p['want'] = want
p
`, { globals: py.toPy({ SR, LENGTH: NSAMP, SIGNALS: signals, CHAIN: chain,
                        EOFMODE: process.env.EOF_MODE || 'raise', CHANS: chanMap }) });
    disarmWatchdog();
    const obj = raw.toJs({ create_proxies: false, dict_converter: Object.fromEntries });
    raw.destroy();

    const buf = (b) => (b).slice().buffer;
    const pStart = new Int32Array(buf(obj.start));
    const pEnd = new Int32Array(buf(obj.end));
    const pInst = new Uint16Array(buf(obj.inst));
    const pCls = new Uint16Array(buf(obj.cls));
    const pOff = new Int32Array(buf(obj.textOffset));
    const pool = obj.texts;

    for (let i = 0; i < obj.count; i++) {
      if (pInst[i] !== obj.want) continue;
      ss.push(pStart[i]); es.push(pEnd[i]); cls.push(pCls[i]);
      texts.push(pool.slice(pOff[i], pOff[i + 1]));
    }
    mine = { e: obj.errors };
  } catch (e) {
    disarmWatchdog();
    if (String(e.message).includes('KeyboardInterrupt')) {
      const real = Atomics.load(deadline, 2) === 1;
      results.shimError.push([id, real
        ? `TIMEOUT: exceeded ${DECODE_TIMEOUT_MS} ms`
        : 'SPURIOUS KeyboardInterrupt (watchdog did not fire) - harness bug']);
      continue;
    }
    {
      const lines = String(e.message).split('\n').map(l => l.trim()).filter(Boolean);
      const errLine = [...lines].reverse().find(l => /Error|Exception/.test(l));
      results.shimError.push([id, (errLine || lines[lines.length - 1] || 'unknown').slice(0, 300)]);
    }
    continue;
  }
  if (mine.e.length) {
    {
      const lines = mine.e[0].split('\n').map(l => l.trim()).filter(Boolean);
      const errLine = [...lines].reverse().find(l => /Error|Exception/.test(l));
      results.shimError.push([id, (errLine || lines[lines.length - 1] || 'unknown').slice(0, 300)]);
    }
    continue;
  }

  // The arrays above came straight out of packed_results() - the exact
  // struct-of-arrays worker.ts ships - so what follows compares DecodeResult
  // itself, not a parallel representation built for the test.
  for (let i = 0; i < texts.length; i++) {
    totalAnnotations++;
    if (texts[i].length > 1) multiVariantAnnotations++;
  }

  // (b) Aggregate: ordering, sample numbers and primary text.
  const lines = [];
  for (let i = 0; i < ss.length; i++) lines.push(`${ss[i]}-${es[i]} ${id}-1: ${texts[i][0]}`);
  const mineTxt = lines.length ? lines.join('\n') + '\n' : '';

  if (mineTxt === native) {
    // (c) Annotation class. The aggregate diff above is blind to `cls`, and
    // `cls` is what registry.rowForClass() feeds the renderer. sigrok-cli can
    // filter by class id (-A dec=class), so ask it once per class and require
    // our cls-partitioned annotations to match each one exactly.
    const clsErr = classDiff(id, pdSpec, info[id].annotations, ss, es, cls, texts);
    if (clsErr) { results.mismatch.push([id, clsErr]); continue; }
    // (d) Text variants, against the decoder source (see variantDiff).
    const varErr = variantDiff(id, texts);
    if (varErr) { results.mismatch.push([id, varErr]); continue; }
    oracleChecked += texts.length;
    results.match.push([id, ss.length]);
  } else {
    const a = native.split('\n'), b = mineTxt.split('\n');
    let d = 0; while (d < a.length && d < b.length && a[d] === b[d]) d++;
    results.mismatch.push([id, `native ${a.length - 1} lines / shim ${b.length - 1}; first diff line ${d + 1}: ` +
      `native=${JSON.stringify(a[d] ?? null)} shim=${JSON.stringify(b[d] ?? null)}`]);
  }
}

const n = (k) => results[k].length;
console.log(`capture ${path.basename(capFile)}  ${NSAMP} samples  ${NCH}ch @ ${SR} Hz`);
console.log(`identical to sigrok-cli : ${n('match')}`);
console.log(`mismatched              : ${n('mismatch')}`);
console.log(`shim raised             : ${n('shimError')}`);
console.log(`sigrok-cli raised       : ${n('nativeError')}`);
console.log(`skipped                 : ${n('skipped')}`);
for (const [id, why] of results.mismatch) console.log('  MISMATCH', id, '::', why);
for (const [id, why] of results.shimError) console.log('  SHIM-ERR', id, '::', why);
for (const [id, why] of results.nativeError) console.log('  NATIVE-ERR', id, '::', why);
console.log(`annotations compared    : ${totalAnnotations}`);
console.log(`  with >1 text variant  : ${multiVariantAnnotations} ` +
  `(sigrok-cli never prints variants 2..n; they are checked against decoder source literals)`);
console.log(`per-class sigrok-cli runs: ${classRuns}`);
console.log(`variant-oracle checked  : ${oracleChecked} annotations against decoder source literals`);
fs.writeFileSync(process.env.CONF_JSON || '/tmp/lw/conformance.json',
  JSON.stringify({ ...results, totalAnnotations, multiVariantAnnotations }, null, 1));

// Fail the build. A correctness harness that returns 0 with mismatches present
// cannot gate anything.
await watchdog.terminate();
const failures = results.mismatch.length + results.shimError.length;
if (failures) {
  console.error(`\nFAILED: ${results.mismatch.length} mismatch(es), ` +
    `${results.shimError.length} shim error(s)`);
  process.exit(1);
}
process.exit(0);
