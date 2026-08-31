/**
 * RleSampleStore - a store over per-channel transition lists, for imported captures.
 *
 * Why it exists: imported captures and our own `.lwcap` are already transition lists.
 * Expanding them into a PlanarSampleStore costs O(samples) at load, which made open time
 * grow with capture size. Keeping the transitions as transitions loads in O(edges), flat
 * with size.
 *
 * What it costs: a query can no longer be answered from bit planes. Per channel this
 * store keeps
 *
 *   - `edges`, the ascending transition positions (4 bytes per edge), and
 *   - `segIdx`, a block index: `segIdx[s]` is the index of the first edge at or past
 *     sample `s * 2^SEG_LOG`. One entry per segment, so 4 bytes per 16k samples.
 *
 * A column [c0, c1) needs the number of edges in it and the parity of the edges before
 * it. Both come from two binary searches bracketed by the two segments' `segIdx` windows,
 * so the cost is O(log edges-per-segment) per column regardless of zoom: a segment with
 * no edges at all answers in O(1), and the dense worst case is a search inside a hot,
 * contiguous window. The planar store is still faster on a capture that is dense
 * everywhere; this store exists for captures that are mostly transitions-free, which is
 * what real logic-analyzer imports are. Measured, not argued - see NOTES.md.
 *
 * The store is immutable: `append` throws. Gaps (bit3 in `ColumnView.packed`) mark spans
 * where the data is unknown; `edges()` never reports a transition inside one.
 */

import {
  assertGapBounds, channelAcrossGaps, isSampleIndex, mergeGap, splitAroundGaps,
} from './gaps.js';
import type { ColumnView, GapSpan, MemoryReport, SampleStore } from './types.js';
import { GAP_BIT } from './types.js';

/** Segment size for the block index, as a log2. Segment = 2^SEG_LOG samples. */
const SEG_LOG = 14;
const SEG = 1 << SEG_LOG;

/** One channel expressed as its transitions. Mirrors the `.lwcap` record exactly. */
export interface RleChannelData {
  /** Level at sample 0. */
  initial: 0 | 1;
  /** Ascending transition positions, strictly increasing, each in [1, length).
   *  Ownership passes to the store: the caller must not mutate the array after. */
  edges: Int32Array;
}

export interface RleStoreOptions {
  channelCount: 4 | 8 | 16;
  samplerate: number;
  /** Virtual sample count. Costs no memory; the store's cost is in edges. */
  length: number;
  channels: RleChannelData[];
  gaps?: GapSpan[];
}

/** A channel before quantisation: transition times in seconds plus the level at t=0. */
export interface RleTransitionSource {
  initial: number;
  /** Ascending transition times in seconds. */
  transitions: Float64Array;
}

/**
 * The largest sample count the store can hold. Edge positions live in an Int32Array and
 * every position is < length, so length itself may be int32's maximum. This is the same
 * ceiling `captureIO.MAX_SAMPLES` enforces (which rejects `total >= 2**31`), stated the
 * other way round - they used to disagree by one, which made a capture of exactly
 * 2^31-1 samples pass the friendly check and die in here.
 */
const MAX_LENGTH = 0x7fffffff;

export class RleSampleStore implements SampleStore {
  readonly channelCount: 4 | 8 | 16;
  readonly samplerate: number;
  readonly length: number;

  private readonly channels: Array<{
    initial: 0 | 1;
    edges: Int32Array;
    segIdx: Uint32Array;
  }> = [];
  private gapList: GapSpan[] = [];

  private scratchBins = 0;
  private scratchLow = new Uint8Array(0);
  private scratchHigh = new Uint8Array(0);
  private scratchEdge = new Uint8Array(0);
  private scratchPacked = new Uint8Array(0);

  constructor(opts: RleStoreOptions) {
    const { channelCount, samplerate, length, channels } = opts;
    if (channelCount !== 4 && channelCount !== 8 && channelCount !== 16) {
      throw new Error(`channelCount must be 4, 8 or 16, got ${channelCount}`);
    }
    if (!(samplerate > 0)) throw new Error(`samplerate must be positive, got ${samplerate}`);
    if (!isSampleIndex(length) || length < 0) {
      throw new Error(`length must be an integer in [0, ${MAX_LENGTH}], got ${length}`);
    }
    if (channels.length !== channelCount) {
      throw new Error(`got ${channels.length} channels for channelCount ${channelCount}`);
    }
    this.channelCount = channelCount;
    this.samplerate = samplerate;
    this.length = length;

    for (let c = 0; c < channelCount; c++) {
      const src = channels[c]!;
      if (src.initial !== 0 && src.initial !== 1) {
        throw new Error(`channel ${c}: initial must be 0 or 1, got ${src.initial}`);
      }
      const edges = src.edges;
      for (let i = 0; i < edges.length; i++) {
        const p = edges[i]!;
        if (!isSampleIndex(p) || p < 1 || p >= length) {
          throw new Error(`channel ${c}: edge ${i} = ${p} outside [1, ${length})`);
        }
        if (i > 0 && !(p > edges[i - 1]!)) {
          throw new Error(`channel ${c}: edges are not strictly increasing at index ${i}`);
        }
      }
      this.channels[c] = { initial: src.initial, edges, segIdx: buildSegIndex(edges, length) };
    }

    if (opts.gaps) for (const g of opts.gaps) this.noteGap(g.startSample, g.endSample);
  }

  /**
   * Quantise per-channel transition times to edge positions, replicating exactly what
   * the sample-stream expansion it replaced produced:
   *
   *   - a transition at time t becomes the FIRST sample at or after t: ceil(t * sr);
   *   - transitions of one channel landing on the same sample cancel pairwise (net parity);
   *   - a transition at sample 0 has no predecessor, so it never appears in edges() - but
   *     it still flips the level, so `initial` absorbs it;
   *   - a transition at or past `length` is dropped - the stream ends there.
   */
  static fromTransitions(
    channelCount: 4 | 8 | 16, samplerate: number, length: number, sources: RleTransitionSource[],
  ): RleSampleStore {
    if (!(samplerate > 0)) throw new Error(`samplerate must be positive, got ${samplerate}`);
    if (sources.length !== channelCount) {
      throw new Error(`got ${sources.length} sources for channelCount ${channelCount}`);
    }
    const channels: RleChannelData[] = sources.map((src, c) => {
      if (src.initial !== 0 && src.initial !== 1) {
        throw new Error(`channel ${c}: initial must be 0 or 1, got ${src.initial}`);
      }
      const t = src.transitions;
      let initial = src.initial;
      const out: number[] = [];
      let pending = -1;
      let pendingCount = 0;
      const flush = (): void => {
        if ((pendingCount & 1) === 1) {
          if (pending === 0) initial ^= 1;
          else if (pending < length) out.push(pending);
        }
      };
      for (let i = 0; i < t.length; i++) {
        const x = t[i]!;
        if (!Number.isFinite(x)) throw new Error(`channel ${c}: transition ${i} is ${x}`);
        if (i > 0 && !(x > t[i - 1]!)) {
          throw new Error(`channel ${c}: transitions are not strictly ascending at index ${i}`);
        }
        const p = Math.ceil(x * samplerate);
        if (p !== pending) {
          flush();
          pending = p;
          pendingCount = 1;
        } else {
          pendingCount++;
        }
      }
      flush();
      return { initial: initial as 0 | 1, edges: new Int32Array(out) };
    });
    return new RleSampleStore({ channelCount, samplerate, length, channels });
  }

  /** Round-trip another store into transition form (tests, `.lwcap` style). */
  static fromStore(store: SampleStore): RleSampleStore {
    const channels: RleChannelData[] = [];
    for (let c = 0; c < store.channelCount; c++) {
      // Not store.edges() directly: see channelAcrossGaps - a gap that swallowed an odd
      // number of edges would invert every level after it.
      const { initial, edges } = channelAcrossGaps(store, c);
      channels.push({ initial, edges });
    }
    return new RleSampleStore({
      channelCount: store.channelCount as 4 | 8 | 16,
      samplerate: store.samplerate,
      length: store.length,
      channels,
      gaps: store.gaps(),
    });
  }

  // ---------------------------------------------------------------- contract

  append(_chunk: Uint8Array): void {
    throw new Error('RleSampleStore is immutable - it exists for imported captures, not live append');
  }

  noteGap(startSample: number, endSample: number): void {
    assertGapBounds(startSample, endSample, this.length);
    this.gapList = mergeGap(this.gapList, startSample, endSample);
  }

  gaps(): GapSpan[] {
    return this.gapList.map((g) => ({ ...g }));
  }

  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) {
      throw new Error(`channel ${channel} out of range 0..${this.channelCount - 1}`);
    }
    if (!(bins > 0) || (bins | 0) !== bins) throw new Error(`bins must be a positive integer, got ${bins}`);
    // Same guard as the planar store: a NaN bound slips past `s >= e` and produces
    // columns with low=1 and high=0, which a renderer draws as a clean flat idle trace.
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`query range must be finite, got [${startSample}, ${endSample})`);
    }
    if (this.length === 0) throw new Error('query on an empty store');
    const s = Math.max(0, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) throw new Error(`empty range [${startSample}, ${endSample}) against length ${this.length}`);

    const width = e - s;
    if (bins !== this.scratchBins) {
      this.scratchBins = bins;
      this.scratchLow = new Uint8Array(bins);
      this.scratchHigh = new Uint8Array(bins);
      this.scratchEdge = new Uint8Array(bins);
      this.scratchPacked = new Uint8Array(bins);
    }
    const low = this.scratchLow, high = this.scratchHigh;
    const edge = this.scratchEdge, packed = this.scratchPacked;

    const { initial, edges, segIdx } = this.channels[channel]!;
    const gaps = this.gapList;
    // Column i covers [s + floor(i*width/bins), s + floor((i+1)*width/bins)) - the same
    // tiling as the planar store, so the two agree column for column.
    let gp = 0;
    for (let i = 0; i < bins; i++) {
      const c0 = s + Math.floor((i * width) / bins);
      let c1 = s + Math.floor(((i + 1) * width) / bins);
      if (c1 <= c0) c1 = c0 + 1;
      if (c1 > e) c1 = e;

      // lo = count of edges below c0; hi = count of edges below c1. Edges sit in the
      // segment windows, so each search is bracketed to the two 16k-sample segments.
      const lo = lowerBound(edges, segIdx, c0);
      const hi = lowerBound(edges, segIdx, c1);
      const n = hi - lo;
      // A transition at exactly c0 flips the level AT c0 but is not strictly inside the
      // column; it sets the edge bit without making the column mixed.
      const edgeAtC0 = n > 0 && edges[lo]! === c0;

      let lv: number, hv: number;
      if (n - (edgeAtC0 ? 1 : 0) > 0) {
        lv = 0; hv = 1; // an edge strictly inside [c0, c1): both levels present
      } else {
        let levelC0 = initial ^ (lo & 1);
        if (edgeAtC0) levelC0 ^= 1;
        lv = levelC0; hv = levelC0;
      }
      const ev = n > 0 ? 1 : 0;

      while (gp < gaps.length && gaps[gp]!.endSample <= c0) gp++;
      const gapHit = gp < gaps.length && gaps[gp]!.startSample < c1;

      high[i] = hv;
      low[i] = lv;
      edge[i] = ev;
      packed[i] = hv | (lv << 1) | (ev << 2) | (gapHit ? GAP_BIT : 0);
    }

    return {
      channel, startSample: s, endSample: e, bins,
      low, high, edge, packed,
    };
  }

  edges(channel: number, startSample: number, endSample: number): Int32Array {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return new Int32Array(0);
    const { edges, segIdx } = this.channels[channel]!;
    let total = 0;
    for (const [a, b] of segs) total += lowerBound(edges, segIdx, b) - lowerBound(edges, segIdx, a);
    if (total === 0) return new Int32Array(0);
    const out = new Int32Array(total);
    let w = 0;
    for (const [a, b] of segs) {
      let i = lowerBound(edges, segIdx, a);
      const end = lowerBound(edges, segIdx, b);
      while (i < end) out[w++] = edges[i++]!;
    }
    if (w !== total) throw new Error(`edge count changed mid-query: ${total} then ${w}`);
    return out;
  }

  /** How many edges edges() would return, without materialising them. */
  edgeCount(channel: number, startSample: number, endSample: number): number {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return 0;
    const { edges, segIdx } = this.channels[channel]!;
    let total = 0;
    for (const [a, b] of segs) total += lowerBound(edges, segIdx, b) - lowerBound(edges, segIdx, a);
    return total;
  }

  /** Validated, gap-filtered sub-ranges of [start, end), or null when empty. */
  private edgeSegments(
    channel: number, startSample: number, endSample: number,
  ): Array<[number, number]> | null {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) {
      throw new Error(`channel ${channel} out of range 0..${this.channelCount - 1}`);
    }
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`edges range must be finite, got [${startSample}, ${endSample})`);
    }
    const s = Math.max(1, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) return null;
    return splitAroundGaps(this.gapList, s, e);
  }

  // ---------------------------------------------------------------- misc

  memory(): MemoryReport {
    let baseBytes = 0;
    let pyramidBytes = 0;
    for (const ch of this.channels) {
      baseBytes += ch.edges.length * 4;
      pyramidBytes += ch.segIdx.length * 4;
    }
    return {
      baseBytes,
      pyramidBytes,
      totalBytes: baseBytes + pyramidBytes,
      overhead: baseBytes === 0 ? 0 : pyramidBytes / baseBytes,
      slackBytes: 0,
    };
  }

  /** Level of `channel` at `index` - exposed for tests, like the planar store's. */
  sampleAt(channel: number, index: number): number {
    if (!isSampleIndex(index) || index < 0 || index >= this.length) throw new Error(`sample ${index} out of range`);
    const { initial, edges, segIdx } = this.channels[channel]!;
    const below = lowerBound(edges, segIdx, index + 1); // count of edges <= index
    return initial ^ (below & 1);
  }
}

/** First edge index with position >= pos, bracketed by the segment window around pos.
 *  `pos === length` with `length` an exact multiple of SEG lands on the sentinel, so it
 *  is clamped to the last real segment - whose window contains no edge >= length, which
 *  makes the search return edges.length, the right answer. */
function lowerBound(edges: Int32Array, segIdx: Uint32Array, pos: number): number {
  const seg = Math.min(pos >>> SEG_LOG, segIdx.length - 2);
  let lo = segIdx[seg]!;
  let hi = segIdx[seg + 1]!;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (edges[mid]! < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** segIdx[s] = index of the first edge with position >= s * SEG. segIdx[nSeg] = edges.length. */
function buildSegIndex(edges: Int32Array, length: number): Uint32Array {
  const nSeg = length === 0 ? 1 : Math.ceil(length / SEG);
  const idx = new Uint32Array(nSeg + 1);
  let e = 0;
  const E = edges.length;
  for (let s = 0; s < nSeg; s++) {
    const lim = Math.min((s + 1) * SEG, length);
    while (e < E && edges[e]! < lim) e++;
    idx[s + 1] = e;
  }
  return idx;
}
