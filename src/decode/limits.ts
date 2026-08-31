/**
 * Hard limits of the decode path, measured rather than guessed.
 *
 * Both of these are real ceilings that the product can reach, so they are
 * checked before work starts and reported as ordinary errors, not discovered
 * as a crash halfway through a decode.
 */

/**
 * Largest sample number an annotation can carry.
 *
 * Annotation spans are exported as Int32Array (and packed in Python with
 * array('i')), so a sample number at or above 2^31 cannot round-trip. At this
 * project's own device rate of 200 MSa/s that is a **10.7 second capture**, so
 * it is not a theoretical bound. Longer captures must be decoded in sub-ranges
 * with the annotation spans offset by the range start.
 */
export const MAX_SAMPLE = 2 ** 31 - 1;

/**
 * Maximum total edges accepted in one decode, across the channels the stack
 * actually reads.
 *
 * Measured cost is 29-35 bytes of wasm32 heap per edge once it is a Python int
 * inside a list: 16 M edges = 557 MB, 48 M = 1.63 GB, 80 M = 2.64 GB against a
 * hard 4 GB address space. Past ~80 M the failure is not a clean OOM - Pyodide
 * corrupts and starts returning garbage strings - so the budget is set well
 * below that, where refusing is still possible.
 */
export const EDGE_BUDGET = 48_000_000;

/** Default wall-clock ceiling for one decode request, in milliseconds. */
export const DEFAULT_DECODE_TIMEOUT_MS = 15_000;
