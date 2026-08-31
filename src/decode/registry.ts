// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Decoder registry.
 *
 * Backed by `decoders/manifest.ts`, generated at build time by
 * `tools/build-manifest.py` from the same libsigrokdecode checkout that goes
 * into `decoders.zip`. Because the shim is pure Python, that metadata can be
 * extracted with the host interpreter, so listing and configuring decoders
 * costs no Pyodide load - only running one does.
 */

import manifest from './decoders/manifest';
import type { AnnotationRowInfo, DecoderInfo, DecoderInstance, DecoderListEntry } from './types';

const all = manifest;
const byId = new Map<string, DecoderInfo>(all.map(d => [d.id, d]));

/** Every stock decoder, in id order. */
export function listDecoders(): DecoderListEntry[] {
  return all.map(({ id, name, longname, desc, tags, inputs, outputs }) =>
    ({ id, name, longname, desc, tags, inputs, outputs }));
}

export function getDecoder(id: string): DecoderInfo {
  const d = byId.get(id);
  if (!d) throw new Error(`unknown decoder ${JSON.stringify(id)}`);
  return d;
}

export function hasDecoder(id: string): boolean {
  return byId.has(id);
}

export const decoderCount = all.length;

/** Decoders driven directly by sample data (`inputs == ['logic']`). */
export function logicDecoders(): DecoderInfo[] {
  return all.filter(isLogicDecoder);
}

export function isLogicDecoder(d: DecoderInfo): boolean {
  return d.inputs.length === 1 && d.inputs[0] === 'logic';
}

/** Decoders that can sit on top of `d`, i.e. consume one of its outputs. */
export function stackableOn(d: DecoderInfo): DecoderInfo[] {
  if (!d.outputs.length) return [];
  return all.filter(c => c !== d && c.inputs.some(i => d.outputs.includes(i)));
}

/** Decoders that can feed `d`. Empty for sample-driven decoders. */
export function producersFor(d: DecoderInfo): DecoderInfo[] {
  if (isLogicDecoder(d)) return [];
  return all.filter(p => p.outputs.some(o => d.inputs.includes(o)));
}

/** Union of tags across all decoders, for grouping in a decoder picker. */
export function allTags(): string[] {
  const s = new Set<string>();
  for (const d of all) for (const t of d.tags) s.add(t);
  return [...s].sort();
}

/**
 * Check a stack before sending it to the worker so the UI gets an immediate,
 * specific complaint instead of a Python traceback a second later.
 * Returns the problems; empty means it is well formed.
 */
export function validateStack(stack: DecoderInstance[], captureChannels: number): string[] {
  const problems: string[] = [];
  stack.forEach((inst, i) => {
    if (!hasDecoder(inst.id)) { problems.push(`stack[${i}]: unknown decoder ${inst.id}`); return; }
    const d = getDecoder(inst.id);
    const stacked = inst.stackOn !== undefined;

    if (stacked) {
      if (!(inst.stackOn! >= 0 && inst.stackOn! < i)) {
        problems.push(`stack[${i}] (${inst.id}): stackOn must reference an earlier entry`);
      } else {
        const under = stack[inst.stackOn!]!;
        if (hasDecoder(under.id)) {
          const supplied = getDecoder(under.id).outputs;
          if (!d.inputs.some(x => supplied.includes(x))) {
            problems.push(
              `stack[${i}]: ${inst.id} needs input ${JSON.stringify(d.inputs)} but ` +
              `${under.id} provides ${JSON.stringify(supplied)}`);
          }
        }
      }
    } else if (!isLogicDecoder(d)) {
      problems.push(
        `stack[${i}]: ${inst.id} consumes ${JSON.stringify(d.inputs)}, so it needs stackOn`);
    }

    const nChan = d.channels.length + d.optional_channels.length;
    for (const [k, v] of Object.entries(inst.channels ?? {})) {
      const idx = Number(k);
      if (!(idx >= 0 && idx < nChan)) {
        problems.push(`stack[${i}] (${inst.id}): channel index ${k} out of range 0..${nChan - 1}`);
      }
      if (v >= captureChannels) {
        problems.push(
          `stack[${i}] (${inst.id}): mapped to capture channel ${v}, capture has ${captureChannels}`);
      }
    }
    if (!stacked) {
      d.channels.forEach((c, ci) => {
        const v = (inst.channels ?? {})[ci];
        if (v === undefined || v < 0) {
          problems.push(`stack[${i}] (${inst.id}): required channel "${c.id}" is unassigned`);
        }
      });
    }
    for (const oid of Object.keys(inst.options ?? {})) {
      if (!d.options.some(o => o.id === oid)) {
        problems.push(`stack[${i}] (${inst.id}): unknown option ${JSON.stringify(oid)}`);
      }
    }
  });
  return problems;
}

/**
 * Rows to lay a decoder's annotations out in.
 *
 * 17 of the 131 stock decoders declare no `annotation_rows`, and
 * libsigrokdecode does not invent any for them - `get_annotation_rows()`
 * (decoder.c:474) returns success with an empty list when the member is
 * absent, and PulseView then draws everything in a single lane. `describe()`
 * reports that faithfully, so this is the **UI's** fallback, not srd
 * behaviour: one row per annotation class, which reads better than one lane
 * for decoders like `i2s` or `swd` that emit unrelated classes.
 */
export function displayRows(d: DecoderInfo): AnnotationRowInfo[] {
  if (d.annotation_rows.length) return d.annotation_rows;
  return d.annotations.map((a, i) => ({ id: a.id, desc: a.desc, classes: [i] }));
}

/**
 * Flatten a decoder's annotation classes to the row each belongs to, which is
 * what a renderer needs to lay annotations out in lanes.
 * Index = annotation class, value = row index into `displayRows(d)`.
 * A class in no row maps to -1; the renderer should still draw it somewhere.
 */
export function rowForClass(d: DecoderInfo): Int32Array {
  const map = new Int32Array(d.annotations.length).fill(-1);
  displayRows(d).forEach((row, ri) => {
    for (const c of row.classes) if (c >= 0 && c < map.length) map[c] = ri;
  });
  return map;
}
