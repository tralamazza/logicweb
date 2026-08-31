/**
 * A growable bit vector stored as a list of fixed-size Uint32Array blocks.
 *
 * Why blocks and not one array that doubles: doubling a 12.5 MB per-channel plane means
 * holding the old and the new array at once, so peak RSS spikes to 3x the live set right
 * at the point where the tab is already at 200 MB. Blocks never copy.
 *
 * Why blocks and not a resizable ArrayBuffer (which also never copies): measured on this
 * machine, V8 puts every access to a typed array backed by a resizable buffer through a
 * dynamic bounds check. Sequential scan of 64 MB:
 *
 *     normal ArrayBuffer        9.3 GB/s read
 *     resizable, fixed view     1.5 GB/s read   (6x slower)
 *     resizable, tracking view  4.0 GB/s read   (2x slower)
 *     16 chunked blocks        11.1 GB/s read
 *
 * The scan speed of the base plane is exactly what edges() and deep-zoom query() cost, so
 * blocks win. See NOTES.md.
 *
 * Bit i lives in block `i >> blockBitsLog`, word `(i & blockMask) >> 5`, bit `i & 31`,
 * least significant bit first. Block sizes are powers of two so every level of the
 * pyramid divides evenly into every other level and no reduction ever straddles a block.
 */

/** State bits returned by range queries. */
export const HAS_ONE = 1;
export const HAS_ZERO = 2;
export const HAS_BOTH = 3;

/** Bits [lo, 32) set. lo must be 0..31. */
function maskFrom(lo: number): number {
  return -1 << lo;
}

/**
 * Bits [0, hi) set. hi must be 1..32.
 *
 * Not `(1 << hi) - 1`: at hi = 31 that is 2147483648 - 1 evaluated as a double, i.e.
 * -2147483649, which still masks correctly but compares unequal to the int32 result of
 * `word & mask`. That produced a false "this range contains a zero" on any range ending
 * 31 bits into a word, which is exactly the sort of thing that quietly draws an edge that
 * is not there.
 */
function maskTo(hi: number): number {
  return hi === 32 ? -1 : ~(-1 << hi);
}

export class BitPlane {
  readonly blockBitsLog: number;
  readonly blockBits: number;
  readonly blockMask: number;
  readonly blockWords: number;
  readonly blocks: Uint32Array[] = [];
  /** Number of bits that have been written. Bits past this are zero but meaningless. */
  bits = 0;

  constructor(blockBitsLog: number) {
    if (blockBitsLog < 5 || blockBitsLog > 30) throw new Error(`bad blockBitsLog ${blockBitsLog}`);
    this.blockBitsLog = blockBitsLog;
    this.blockBits = 1 << blockBitsLog;
    this.blockMask = this.blockBits - 1;
    this.blockWords = this.blockBits >>> 5;
  }

  /** Allocate storage so that bit indices [0, n) exist. Does not change `bits`. */
  reserve(n: number): void {
    const need = Math.ceil(n / this.blockBits);
    while (this.blocks.length < need) this.blocks.push(new Uint32Array(this.blockWords));
  }

  /** Allocate and mark [0, n) as written. */
  extendTo(n: number): void {
    this.reserve(n);
    if (n > this.bits) this.bits = n;
  }

  getBit(i: number): number {
    const b = this.blocks[i >>> this.blockBitsLog];
    if (b === undefined) throw new Error(`bit ${i} out of range (bits=${this.bits})`);
    return (b[(i & this.blockMask) >>> 5]! >>> (i & 31)) & 1;
  }

  setBit(i: number, v: number): void {
    const b = this.blocks[i >>> this.blockBitsLog];
    if (b === undefined) throw new Error(`bit ${i} out of range (bits=${this.bits})`);
    const w = (i & this.blockMask) >>> 5;
    const m = 1 << (i & 31);
    if (v) b[w] |= m;
    else b[w] &= ~m;
  }

  /**
   * HAS_ONE | HAS_ZERO over bits [a, b). O((b - a) / 32) words, and it returns the
   * instant both bits are known, which is the common case for any channel that is
   * actually toggling.
   */
  rangeState(a: number, b: number): number {
    if (a >= b) return 0;
    let state = 0;
    const bbl = this.blockBitsLog;
    const bb = this.blockBits;
    let blk = a >>> bbl;
    while (a < b) {
      const arr = this.blocks[blk];
      if (arr === undefined) throw new Error(`rangeState [${a},${b}) past end (bits=${this.bits})`);
      const blockEnd = (blk + 1) * bb;
      const e = b < blockEnd ? b : blockEnd;
      state |= this.rangeStateInBlock(arr, a - blk * bb, e - blk * bb);
      if (state === HAS_BOTH) return HAS_BOTH;
      a = e;
      blk++;
    }
    return state;
  }

  /** [a, b) are block-relative bit indices, 0 <= a < b <= blockBits. */
  private rangeStateInBlock(arr: Uint32Array, a: number, b: number): number {
    const wa = a >>> 5;
    const wb = (b - 1) >>> 5;
    const loBit = a & 31;
    const hiBit = ((b - 1) & 31) + 1;
    if (wa === wb) {
      const m = maskFrom(loBit) & maskTo(hiBit);
      const v = arr[wa]! & m;
      return (v !== 0 ? HAS_ONE : 0) | (v !== m ? HAS_ZERO : 0);
    }
    let state = 0;
    {
      const m = maskFrom(loBit);
      const v = arr[wa]! & m;
      if (v !== 0) state |= HAS_ONE;
      if (v !== m) state |= HAS_ZERO;
    }
    for (let w = wa + 1; w < wb; w++) {
      if (state === HAS_BOTH) return HAS_BOTH;
      const v = arr[w]! | 0;
      if (v !== 0) state |= HAS_ONE;
      if (v !== -1) state |= HAS_ZERO;
    }
    if (state !== HAS_BOTH) {
      const m = maskTo(hiBit);
      const v = arr[wb]! & m;
      if (v !== 0) state |= HAS_ONE;
      if (v !== m) state |= HAS_ZERO;
    }
    return state;
  }

  /**
   * True if any bit in [a, b) is set. Pyramid levels keep "has a one" and "has a zero"
   * in two separate planes, so above the base level this is the only test needed and it
   * is cheaper than rangeState.
   */
  anyOne(a: number, b: number): boolean {
    if (a >= b) return false;
    const bbl = this.blockBitsLog;
    const bb = this.blockBits;
    let blk = a >>> bbl;
    while (a < b) {
      const arr = this.blocks[blk];
      if (arr === undefined) throw new Error(`anyOne [${a},${b}) past end (bits=${this.bits})`);
      const blockEnd = (blk + 1) * bb;
      const e = b < blockEnd ? b : blockEnd;
      const ra = a - blk * bb;
      const re = e - blk * bb;
      const wa = ra >>> 5;
      const wb = (re - 1) >>> 5;
      const loBit = ra & 31;
      const hiBit = ((re - 1) & 31) + 1;
      if (wa === wb) {
        if ((arr[wa]! & maskFrom(loBit) & maskTo(hiBit)) !== 0) return true;
      } else {
        if ((arr[wa]! & maskFrom(loBit)) !== 0) return true;
        for (let w = wa + 1; w < wb; w++) if (arr[w] !== 0) return true;
        if ((arr[wb]! & maskTo(hiBit)) !== 0) return true;
      }
      a = e;
      blk++;
    }
    return false;
  }

  /** Bytes actually allocated. */
  byteLength(): number {
    return this.blocks.length * this.blockWords * 4;
  }
}
