// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Loader for sigrok .sr session files.
 *
 * An .sr is a zip whose `metadata` member carries a `capturefile=logic-N` line and the
 * sample data lives in members named `capturefile-<pack>` (session format version 2) or
 * `capturefile` (version 1). One sample per probe per position: `unitsize` bytes per
 * sample, little-endian, bit k = probe k+1. Verified against the three real captures in
 * `fixtures/` (version 2, deflated members, 16 probes, 16 MHz, unitsize 2),
 * not against sigrok's documentation.
 *
 * Only the zip features the format actually uses are read: stored and deflated members,
 * no ZIP64, no data descriptors (the central directory is authoritative). Anything else
 * throws rather than guessing.
 *
 * Only logic captures are supported - analog .sr data is a different file format
 * entirely and is refused with that reason. The format has no gap concept, so no span
 * is ever marked missing here.
 */

import { createEdgeStore } from '../data/index.js';
import type { SampleStore } from '../data/types.js';
import type { LoadedCapture } from './captureIO.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

interface ZipMember {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the local header. */
  localOffset: number;
}

function u16(dv: DataView, o: number): number {
  return dv.getUint16(o, true);
}

function u32(dv: DataView, o: number): number {
  return dv.getUint32(o, true);
}

/**
 * The central directory, straight from the end-of-central-directory record. Only
 * single-disk, no-ZIP64 archives pass.
 */
function readCentralDirectory(buf: ArrayBuffer): Map<string, ZipMember> {
  const dv = new DataView(buf);
  if (buf.byteLength < 22) throw new Error('not a zip (shorter than the EOCD record)');
  const maxComment = Math.min(0xffff, buf.byteLength - 22);
  let eocd = -1;
  for (let c = 0; c <= maxComment; c++) {
    const o = buf.byteLength - 22 - c;
    if (dv.getUint32(o, true) === EOCD_SIG) { eocd = o; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD record)');
  if (u16(dv, eocd + 4) !== 0 || u16(dv, eocd + 6) !== 0) {
    throw new Error('multi-disk zips are not supported');
  }
  const count = u16(dv, eocd + 10);
  const cdSize = u32(dv, eocd + 12);
  const cdOffset = u32(dv, eocd + 16);
  if (cdOffset + cdSize > eocd) throw new Error('corrupt zip (central directory past the EOCD)');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  const members = new Map<string, ZipMember>();
  let o = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(dv, o) !== CENTRAL_SIG) throw new Error(`corrupt zip (central entry ${i} has no signature)`);
    const flags = u16(dv, o + 8);
    const method = u16(dv, o + 10);
    const compressedSize = u32(dv, o + 20);
    const uncompressedSize = u32(dv, o + 24);
    const nameLen = u16(dv, o + 28);
    const extraLen = u16(dv, o + 30);
    const commentLen = u16(dv, o + 32);
    const localOffset = u32(dv, o + 42);
    const name = new TextDecoder().decode(new Uint8Array(buf, o + 46, nameLen));
    if (flags & 0x0008) {
      throw new Error(`member ${name} uses a data descriptor - not supported`);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`member ${name} needs ZIP64 - not supported`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new Error(`member ${name} uses compression method ${method} - only stored and deflate are supported`);
    }
    members.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

/** The raw member payload, inflating deflated members through DecompressionStream. */
async function inflate(
  buf: ArrayBuffer, m: ZipMember,
): Promise<Uint8Array> {
  const dv = new DataView(buf);
  if (u32(dv, m.localOffset) !== LOCAL_SIG) {
    throw new Error(`member ${m.name} has no local header where the directory says it is`);
  }
  const nameLen = u16(dv, m.localOffset + 26);
  const extraLen = u16(dv, m.localOffset + 28);
  const start = m.localOffset + 30 + nameLen + extraLen;
  if (start + m.compressedSize > buf.byteLength) {
    throw new Error(`member ${m.name} runs past the end of the file`);
  }
  const raw = new Uint8Array(buf, start, m.compressedSize);

  if (m.method === METHOD_STORED) {
    if (raw.length !== m.uncompressedSize) throw new Error(`member ${m.name} size mismatch`);
    return raw.slice();
  }

  // DecompressionStream wants the raw deflate stream, which is exactly what the zip
  // local payload is (no zlib header, no adler trailer).
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(raw).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  if (total !== m.uncompressedSize) {
    throw new Error(`member ${m.name} inflates to ${total} bytes, directory says ${m.uncompressedSize}`);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---------------------------------------------------------------- metadata

interface SrDevice {
  capturefile: string;
  probes: number;
  analog: number;
  samplerate: number;
  unitsize: number;
  probeNames: string[];
}

/** key=value lines under [section] headers; the first device that owns a capturefile. */
function parseMetadata(text: string): SrDevice {
  let dev: { capturefile?: string; probes: number; analog: number; samplerate?: number; unitsize: number; probeNames: string[] } | null = null;
  let sawDevice = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line.length === 0) continue;
    if (line.startsWith('[')) {
      sawDevice = !line.startsWith('[global]');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!sawDevice) continue;
    if (dev === null) {
      if (key !== 'capturefile') continue; // an analog device before any logic one
      dev = { probes: 0, analog: 0, unitsize: 1, probeNames: [] };
    }
    if (key === 'capturefile') {
      if (dev.capturefile !== undefined) {
        // A new device section without a header would be malformed; refuse rather than merge.
        throw new Error('metadata has two capturefiles in one device section');
      }
      if (!/^logic-[0-9]+$/.test(value)) {
        throw new Error(`capturefile ${value} is not a logic unit - analog captures are not supported`);
      }
      dev.capturefile = value;
    } else if (key === 'total probes') dev.probes = Number(value);
    else if (key === 'total analog') dev.analog = Number(value);
    else if (key === 'samplerate') dev.samplerate = parseSamplerate(value);
    else if (key === 'unitsize') dev.unitsize = Number(value);
    else if (/^probe\d+$/.test(key)) {
      const idx = Number(key.slice(5)) - 1;
      dev.probeNames[idx] = value;
    }
  }
  if (!dev || dev.capturefile === undefined) throw new Error('no logic capturefile in the metadata');
  const samplerate = dev.samplerate;
  if (!(samplerate !== undefined && samplerate > 0)) throw new Error('no samplerate in the metadata');
  if (!(dev.probes >= 1 && dev.probes <= 16)) {
    throw new Error(`total probes ${dev.probes} outside 1..16`);
  }
  if (dev.analog > 0) throw new Error('analog channels in this capture are not supported');
  if (dev.unitsize !== 1 && dev.unitsize !== 2) {
    throw new Error(`unitsize ${dev.unitsize} is not 1 or 2`);
  }
  if (dev.unitsize === 1 && dev.probes > 8) {
    throw new Error(`unitsize 1 cannot carry ${dev.probes} probes`);
  }
  return {
    capturefile: dev.capturefile,
    probes: dev.probes,
    analog: dev.analog,
    samplerate,
    unitsize: dev.unitsize,
    probeNames: dev.probeNames,
  };
}

/** "16 MHz", "1 kHz", "100 Hz" - the suffixes sigrok writes. */
function parseSamplerate(v: string): number {
  const m = /^([0-9.]+)\s*(GHz|MHz|kHz|Hz)?$/.exec(v);
  if (!m) throw new Error(`unparsable samplerate ${JSON.stringify(v)}`);
  const mult = m[2] === 'GHz' ? 1e9 : m[2] === 'MHz' ? 1e6 : m[2] === 'kHz' ? 1e3 : 1;
  const r = Number(m[1]) * mult;
  if (!(r > 0) || !Number.isFinite(r)) throw new Error(`unparsable samplerate ${JSON.stringify(v)}`);
  return r;
}

// ---------------------------------------------------------------- samples

/** Per-probe transition lists from unitsize-byte little-endian samples. */
function samplesToChannels(
  data: Uint8Array, unitsize: number, probes: number,
): Array<{ initial: 0 | 1; edges: Int32Array }> {
  const length = data.length / unitsize;
  if (length !== Math.floor(length)) {
    throw new Error(`data length ${data.length} is not a whole number of ${unitsize}-byte samples`);
  }
  const initialAt = (c: number): number => {
    let v = data[0]!;
    if (unitsize === 2) v |= data[1]! << 8;
    return (v >>> c) & 1;
  };
  const out: Array<{ initial: 0 | 1; edges: Int32Array }> = [];
  for (let c = 0; c < probes; c++) {
    const edges: number[] = [];
    let level = initialAt(c);
    for (let i = 1; i < length; i++) {
      let v = data[i * unitsize]!;
      if (unitsize === 2) v |= data[i * unitsize + 1]! << 8;
      const b = (v >>> c) & 1;
      if (b !== level) {
        edges.push(i);
        level = b;
      }
    }
    out.push({ initial: initialAt(c) as 0 | 1, edges: new Int32Array(edges) });
  }
  return out;
}

// ---------------------------------------------------------------- entry

/**
 * Parse a sigrok .sr session file into a transition-backed store.
 *
 * `source` is a display name for error messages. Only the first logic device of the
 * session is loaded; sessions with analog channels are refused.
 */
export async function parseSr(buf: ArrayBuffer, source: string): Promise<LoadedCapture> {
  const members = readCentralDirectory(buf);
  const metadata = members.get('metadata');
  if (!metadata) throw new Error(`${source} has no metadata member - not a sigrok session`);
  const dev = parseMetadata(new TextDecoder().decode(await inflate(buf, metadata)));

  // v1: the member is named exactly `capturefile`; v2: `capturefile-1`, `-2`, ... in
  // pack order. Accept both; sort packs numerically.
  const packNames: Array<{ n: number; name: string }> = [];
  const exact = members.get(dev.capturefile);
  if (exact) packNames.push({ n: 0, name: dev.capturefile });
  for (const name of members.keys()) {
    const m = new RegExp(`^${dev.capturefile}-(\\d+)$`).exec(name);
    if (m) packNames.push({ n: Number(m[1]), name });
  }
  if (packNames.length === 0) {
    throw new Error(`${source} has no data members for capturefile ${dev.capturefile}`);
  }
  packNames.sort((a, b) => a.n - b.n);

  const packs: Uint8Array[] = [];
  let bytes = 0;
  for (const p of packNames) {
    const d = await inflate(buf, members.get(p.name)!);
    packs.push(d);
    bytes += d.length;
  }
  const data = new Uint8Array(bytes);
  let o = 0;
  for (const p of packs) { data.set(p, o); o += p.length; }

  const channels = samplesToChannels(data, dev.unitsize, dev.probes);
  const length = data.length / dev.unitsize;
  // The store packs 4, 8 or 16 channels; an .sr with fewer probes pads with empty
  // transition lists, which cost nothing in the edge store.
  const channelCount: 4 | 8 | 16 = dev.probes <= 4 ? 4 : dev.probes <= 8 ? 8 : 16;
  const padded = Array.from({ length: channelCount }, (_, c) =>
    channels[c] ?? { initial: 0 as const, edges: new Int32Array(0) });
  const store: SampleStore = createEdgeStore(channelCount, dev.samplerate, length, padded);

  const names = Array.from({ length: channelCount }, (_, c) =>
    dev.probeNames[c] ?? (c < dev.probes ? `D${c}` : `Channel ${c}`));
  return {
    store,
    channelNames: names,
    duration: length / dev.samplerate,
    sourceDescription: `${source} @ ${dev.samplerate / 1e6} MSa/s, ${dev.probes} probes`,
  };
}
