/**
 * Public contract for src/decode.
 *
 * The decoder runs in a Web Worker. It consumes `SampleStore.edges()` output -
 * exact edge positions per channel - and produces annotation spans in sample
 * coordinates. It never sees raw samples, which is what keeps the transfer to
 * the worker proportional to edge count rather than capture length.
 */

/** One channel expressed as its transitions, matching `SampleStore.edges()`. */
export interface ChannelEdges {
  /** Sample indices (relative to the decoded range) where the level changes.
   *  Strictly increasing, never contains 0. */
  edges: Int32Array;
  /** Level at the first sample of the range. */
  initial: 0 | 1;
}

/** One decoder in a stack. */
export interface DecoderInstance {
  /** Stock sigrok decoder id, e.g. 'uart', 'i2c', 'eeprom24xx'. */
  id: string;
  /** Unique within a request; defaults to `${id}-${index}`. Shown in the UI. */
  instanceId?: string;
  /** Decoder channel index -> capture channel index. Omitted or -1 means the
   *  channel is unassigned; required channels must all be present unless this
   *  instance is stacked. */
  channels: Record<number, number>;
  /** Decoder option id -> value. Unknown ids are rejected, loudly. */
  options?: Record<string, string | number>;
  /** Index into `DecodeRequest.stack` of the decoder feeding this one via
   *  OUTPUT_PYTHON. Omitted for sample-driven decoders. */
  stackOn?: number;
}

export interface DecodeRequest {
  samplerate: number;
  /**
   * Number of samples in the decoded range.
   *
   * Must be <= `MAX_SAMPLE` (2^31 - 1): annotation spans are Int32Array, so a
   * longer range cannot round-trip. At 200 MSa/s that is a 10.7 s capture, so
   * long captures must be decoded in sub-ranges with spans offset by the
   * range start. Exceeding it is rejected before any work is done.
   */
  length: number;
  /**
   * Indexed by capture channel number.
   *
   * **Only channels referenced by `stack[].channels` are read.** Supplying a
   * real edge list for a channel no decoder maps is pure cost - marshalling
   * unread channels was 34% of wall time on a 16-channel 2 M-edge capture -
   * so pass `{ edges: new Int32Array(0), initial: 0 }` for the rest. The
   * worker prunes them anyway; this just avoids building the arrays.
   *
   * Total edges across the *referenced* channels must be <= `EDGE_BUDGET`.
   */
  channels: ChannelEdges[];
  /** Decoders to run. Producers must appear before the decoders stacked on them. */
  stack: DecoderInstance[];
  /**
   * What happens when a decoder runs off the end of the data.
   *
   * 'raise' (default) delivers EOFError, so a decoder's trailing flush runs
   * and the last item of a capture is kept.
   *
   * 'terminate' reproduces sigrok-cli 0.7.2 exactly: it kills decode() with an
   * uncatchable exception, so post-EOF code never runs. Only `parallel` is
   * known to differ between the two, by one trailing annotation. Use this to
   * compare against the reference implementation, not to ship.
   */
  eofMode?: 'raise' | 'terminate';
}

/**
 * Annotations in struct-of-arrays form. The numeric arrays are transferable;
 * `texts` is a flat pool indexed by `textOffset` so there is one string array
 * to clone instead of one per annotation.
 *
 * Annotation i:
 *   span      [start[i], end[i])            in samples
 *   producer  stack[inst[i]]
 *   class     cls[i]                        index into the decoder's `annotations`
 *   texts     texts[textOffset[i] .. textOffset[i+1])
 *             longest first, as sigrok emits them
 */
export interface Annotations {
  count: number;
  start: Int32Array;
  end: Int32Array;
  inst: Uint16Array;
  cls: Uint16Array;
  textOffset: Int32Array;
  texts: string[];
}

export interface DecodeResult {
  annotations: Annotations;
  /** Per-instance decoder metadata, for rows and colouring. */
  instances: DecoderInfo[];
  /** Decoders that threw. A decoder raising is normal on unexpected input -
   *  sigrok's own decoders do it - so this is reported, not swallowed. */
  errors: string[];
  /** Milliseconds spent inside decode(), excluding transfer. */
  decodeMs: number;
}

export interface DecoderChannelInfo {
  id: string;
  name: string;
  desc: string;
}

export interface DecoderOptionInfo {
  id: string;
  desc: string;
  default: string | number | null;
  type: 'int' | 'float' | 'str';
  /** Allowed values, if the decoder constrains them. */
  values: (string | number)[];
}

export interface AnnotationRowInfo {
  id: string;
  desc: string;
  /** Indices into `annotations`. */
  classes: number[];
}

/** Mirrors libsigrokdecode's struct srd_decoder. */
export interface DecoderInfo {
  id: string;
  name: string;
  longname: string;
  desc: string;
  license: string;
  /** ['logic'] for sample-driven decoders; anything else names the protocol
   *  stream this decoder consumes from another decoder. */
  inputs: string[];
  outputs: string[];
  tags: string[];
  channels: DecoderChannelInfo[];
  optional_channels: DecoderChannelInfo[];
  options: DecoderOptionInfo[];
  annotations: { id: string; desc: string }[];
  annotation_rows: AnnotationRowInfo[];
  binary: { id: string; desc: string }[];
}

/** Summary entry, cheap enough to list all decoders without importing them. */
export interface DecoderListEntry {
  id: string;
  name: string;
  longname: string;
  desc: string;
  tags: string[];
  inputs: string[];
  outputs: string[];
}
