/**
 * Hardware-free model of the 32U3 data path.
 *
 * The one thing a fake device in this repo has never modelled is the device's own
 * clock: the board produces bytes whether or not the host is ready, and the only
 * reason a host keeps up is that it keeps `depth` bulk reads submitted. So this
 * device completes the k-th submitted read at
 *
 *     max(now, t0 + k * chunkBytes / lineBytesPerMs)
 *
 * - i.e. "the data was already waiting" if the host was late - and tracks how far
 * its FIFO would have run ahead of what the host had queued. That occupancy is the
 * quantity the real board overruns on, and the quantity no offline test measured.
 *
 * Run:
 *   node_modules/.bin/esbuild src/device/bench-rate.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/lwbench/rate.mjs
 *   node --max-old-space-size=6144 /tmp/lwbench/rate.mjs      # all plans
 *   PLANS=AB node --max-old-space-size=6144 /tmp/lwbench/rate.mjs
 *
 * The browser's own `bench` console command (slogic16u3.ts) is the hardware version of
 * plan A: same measurement, real endpoint, no sink.
 */
import { Slogic16U3 } from './slogic16u3.js';
import { InterleavedSampleStore } from '../data/interleavedStore.js';
import { nodeProcess } from '../data/bench/nodeglobals.js';

const proc = nodeProcess();
/** Node's setImmediate: the fine-grained delivery the model needs (see pumpLoop). */
const soon: (fn: () => void) => void = (fn) => {
  (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate(fn);
};

const CHUNK = 3_129_344;
const FIFO_BYTES = Number(proc.env.FIFO_BYTES ?? 8 * 1024 * 1024);

interface AuxModel {
  status: number;
  payload: number[];
  ready?: boolean;
}

class RateDevice {
  readonly log: string[] = [];
  opened = true;
  configuration = {} as USBConfiguration;
  readonly productName = 'SLogic32 U3';
  readonly serialNumber = 'rate-model';
  readonly productId = 0x3032;

  private selector = 0;
  private flags = { rst: false, fifoOverflow: false, innerError: false };
  /** R32_CTRL as the model holds it; the real register reads this back byte for byte. */
  private ctrlValue = 0;

  /** Bytes per millisecond the board produces at the configured rate. */
  bytesPerMs = 800_000; // 32ch @ 200 MHz = 800 MB/s
  /**
   * Extra latency between the board filling a read and the host observing it - the
   * browser process, mojo and the renderer's task queue all sit in that gap. A constant
   * latency must not change the rate the host measures; only jitter can.
   */
  deliverDelayMs = 0;
  /** Device time of the next byte the board must have produced. */
  private t0 = 0;
  private queue: Array<{
    resolve: (r: USBInTransferResult) => void;
    reject: (e: unknown) => void;
    len: number;
    readyAt: number;
  }> = [];
  /** Cumulative bytes of every read submitted so far, to place completions in time. */
  private submittedBytes = 0;
  private drainedBytes = 0;
  private pendingSum = 0;

  /** Bytes produced but not yet handed to a submitted read: the board's FIFO. */
  private fifoBytes = 0;
  /** Times the modelled FIFO ran past its capacity - the real board's wedge. */
  overruns = 0;
  maxFifoBytes = 0;
  transferInCalls = 0;
  /** Wall-clock of the last submission, for "how deep was the queue" reporting. */
  private pendingBytes = 0;
  maxPendingBytes = 0;

  constructor(private readonly aux: Record<number, AuxModel>) {}

  private auxModel(): AuxModel {
    const m = this.aux[this.selector];
    if (!m) throw new Error(`model: no aux model for 0x${this.selector.toString(16)}`);
    return m;
  }

  private flagWord(): number {
    const ready = !this.flags.rst && !this.flags.fifoOverflow && !this.flags.innerError;
    return (ready ? 0x01 : 0) | (this.flags.fifoOverflow ? 0x02 : 0) |
      (this.flags.innerError ? 0x04 : 0);
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async selectConfiguration(): Promise<void> {}
  async claimInterface(): Promise<void> {}
  async clearHalt(): Promise<void> {}
  async releaseInterface(): Promise<void> {
    const parked = this.queue;
    this.queue = [];
    this.pendingSum = 0;
    for (const item of parked) item.reject(new Error('NetworkError: transfer was cancelled'));
  }

  async controlTransferOut(
    s: USBControlTransferParameters, data: BufferSource,
  ): Promise<USBOutTransferResult> {
    const b = new Uint8Array(
      data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer,
      data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset,
      data.byteLength,
    );
    const word = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
    if (s.value === 0x0004) {
      this.ctrlValue = word >>> 0;
      this.flags.rst = (word & 0x02) !== 0;
      // CTRL_RUN starts the board producing; the model's clock starts there.
      if (word & 0x01) this.onRun();
    } else if (s.value === 0x0008) {
      if (word & 0x02) this.flags.fifoOverflow = false;
    } else if (s.value === 0x000c) {
      this.selector = word & 0xff;
    } else if (s.value >= 0x0010) {
      const m = this.auxModel();
      const idx = (s.value - 0x0010) / 4;
      const words = Math.max(1, Math.ceil(((m.status & 0xffff) >> 9) / 4));
      if (idx < words) m.payload[idx] = word;
    }
    return { status: 'ok', bytesWritten: 4 };
  }

  async controlTransferIn(
    s: USBControlTransferParameters, _length: number,
  ): Promise<USBInTransferResult> {
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    if (s.value === 0x0008) {
      dv.setUint32(0, this.flagWord(), true);
    } else if (s.value === 0x0004) {
      dv.setUint32(0, this.ctrlValue, true);
    } else if (s.value === 0x000c) {
      const m = this.auxModel();
      const ready = m.ready === false ? 0 : 1;
      dv.setUint32(0, ((m.status & 0xff00ffff) | (ready << 16)) >>> 0, true);
    } else if (s.value >= 0x0010) {
      dv.setUint32(0, this.auxModel().payload[(s.value - 0x0010) / 4] ?? 0, true);
    }
    return { status: 'ok', data: dv };
  }

  /** Called when the host writes CTRL_RUN/STOP: the board starts/stops producing. */
  onRun(): void {
    this.t0 = performance.now();
    this.submittedBytes = 0;
    this.drainedBytes = 0;
    this.pendingSum = 0;
    this.fifoBytes = 0;
    this.maxFifoBytes = 0;
    this.overruns = 0;
  }

  transferIn(_ep: number, len: number): Promise<USBInTransferResult> {
    this.transferInCalls += 1;
    this.pendingBytes += len;
    this.pendingSum += len;
    this.maxPendingBytes = Math.max(this.maxPendingBytes, this.pendingBytes);
    const readyAt = this.t0 + (this.submittedBytes + len) / this.bytesPerMs;
    this.submittedBytes += len;
    return new Promise<USBInTransferResult>((resolve, reject) => {
      this.queue.push({ resolve, reject, len, readyAt });
      this.pump();
    });
  }

  /**
   * Deliver every read the board has already filled, in submission order, and account
   * for the FIFO it fills whenever the host has nothing queued to receive.
   */
  pump(): void {
    const now = performance.now();
    const produced = (now - this.t0) * this.bytesPerMs;
    // Bytes the board has produced that no submitted read is holding. A pending read
    // has already been filled by the device, so its bytes are not FIFO occupancy.
    this.fifoBytes = Math.max(0, produced - this.drainedBytes - this.pendingSum);
    this.maxFifoBytes = Math.max(this.maxFifoBytes, this.fifoBytes);
    if (this.fifoBytes > FIFO_BYTES) {
      this.overruns += 1;
      this.drainedBytes = produced - this.pendingSum; // the overflowed bytes are lost
      this.fifoBytes = 0;
    }
    while (this.queue.length && this.queue[0]!.readyAt + this.deliverDelayMs <= now) {
      const item = this.queue.shift()!;
      this.pendingBytes -= item.len;
      this.pendingSum -= item.len;
      this.drainedBytes += item.len;
      const data = new DataView(new ArrayBuffer(item.len));
      item.resolve({ status: 'ok', data });
    }
  }
}

function recorded32(): Record<number, AuxModel> {
  return {
    0x01: { status: 0x00010401, payload: [0xffffffff] },
    0x02: { status: 0x00011002, payload: [(1600 << 16) | 0, 100] },
    0x03: { status: 0x00010403, payload: [0x00000136] },
    0x05: { status: 0x00010205, payload: [0] },
  };
}

/** Stop-the-world stall of `ms` on the thread that has to re-arm the queue. */
function block(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* spin */ }
}

interface Plan {
  label: string;
  seconds: number;
  sink: 'store' | 'drop';
  stallMs: number;
  stallEveryMs: number;
  deliverDelayMs?: number;
}

async function run(plan: Plan): Promise<void> {
  const dev = new RateDevice(recorded32());
  dev.deliverDelayMs = plan.deliverDelayMs ?? 0;
  const bus = dev as unknown as USBDevice;
  const transport = new Slogic16U3(bus);
  const store = plan.sink === 'store'
    ? new InterleavedSampleStore(200e6, 32)
    : null;
  let bytes = 0;
  let nextStall = plan.stallEveryMs;
  const errors: unknown[] = [];
  transport.onError = (e) => errors.push(e);

  await transport.open();
  const t0 = performance.now();
  /*
   * setImmediate, not setInterval(1): the board completes a read the moment it has
   * produced the bytes, and the host observes it then. A 1 ms poll floor would delay
   * every completion by up to a millisecond, which the transport measures as itself
   * being 12% behind the device and aborts a healthy run over. Node's setImmediate
   * loop gives the microsecond-resolution delivery a browser event loop has.
   */
  let pumpRunning = true;
  const pumpLoop = (): void => {
    if (!pumpRunning) return;
    const elapsed = performance.now() - t0;
    if (elapsed >= nextStall && plan.stallMs > 0) {
      nextStall += plan.stallEveryMs;
      block(plan.stallMs);
    }
    dev.pump();
    soon(pumpLoop);
  };
  soon(pumpLoop);

  await transport.start(
    { channels: 32 as const, samplerate: 200e6, thresholdVolts: 1.6 },
    (chunk) => {
      bytes += chunk.length;
      store?.append(chunk);
    },
  );
  await new Promise((r) => setTimeout(r, plan.seconds * 1000));
  const elapsed = performance.now() - t0;
  // stop() re-throws the read loop's abort on purpose, and the abort is the result this
  // plan exists to measure: a stall big enough to break the line rate has to end the
  // capture rather than stream on and wedge the board (NOTES 8.6). Letting it out of
  // here ends the whole bench on the first such plan instead of reporting it.
  try {
    await transport.stop();
  } catch (e) {
    if (!errors.includes(e)) errors.push(e);
  }
  pumpRunning = false;
  const stats = transport.getStats();

  console.log(`${plan.label}`);
  console.log(`  bytes            ${bytes.toLocaleString()} in ${(elapsed / 1000).toFixed(2)} s`);
  console.log(`  delivered        ${(bytes / elapsed / 1000).toFixed(1)} MB/s ` +
    `(line rate ${(dev.bytesPerMs / 1000).toFixed(0)} MB/s)`);
  console.log(`  steady (stats)   ${stats.steadyMBps.toFixed(1)} MB/s, ` +
    `transfers ${stats.transfers}, short ${stats.shortTransfers}`);
  console.log(`  queue            peak ${(stats.peakQueuedTransfers ?? 0)} transfers, ` +
    `max pending ${(dev.maxPendingBytes / 1048576).toFixed(1)} MiB`);
  console.log(`  sink             p50 ${stats.sinkMsP50.toFixed(2)} ms, ` +
    `p95 ${stats.sinkMsP95.toFixed(2)} ms (budget ${(CHUNK / dev.bytesPerMs).toFixed(2)} ms)`);
  console.log(`  modelled FIFO    peak ${(dev.maxFifoBytes / 1048576).toFixed(1)} MiB ` +
    `of ${(FIFO_BYTES / 1048576).toFixed(1)} MiB, overruns ${dev.overruns}`);
  console.log(`  errors           ${errors.map(String).join(' | ') || 'none'}`);
  console.log(`  store            ${store ? (store.length / 1e6).toFixed(1) + ' Msamples' : 'discarded'}`);
  console.log('');
}

const allPlans: Plan[] = [
  { label: 'A  transport only, ingest discarded', seconds: 1, sink: 'drop', stallMs: 0, stallEveryMs: 0 },
  { label: 'B  + real 32ch store (the shipping sink)', seconds: 1, sink: 'store', stallMs: 0, stallEveryMs: 0 },
  { label: 'C  + 20 ms main-thread stall every 250 ms', seconds: 1, sink: 'store', stallMs: 20, stallEveryMs: 250 },
  { label: 'D  + 40 ms main-thread stall every 250 ms', seconds: 1, sink: 'store', stallMs: 40, stallEveryMs: 250 },
  { label: 'F  + 2 ms of completion delivery latency', seconds: 1, sink: 'drop', stallMs: 0, stallEveryMs: 0, deliverDelayMs: 2 },
];

const want = proc.env.PLANS;
const plans = want ? allPlans.filter((p) => want.includes(p.label[0]!)) : allPlans;
for (const plan of plans) await run(plan);

// The `bench` console command is the same measurement from inside the app, so it has
// to work against the same model - it is the only way to check it without the board.
if (!want || want.includes('E')) {
  const dev = new RateDevice(recorded32());
  const transport = new Slogic16U3(dev as unknown as USBDevice);
  await transport.open();
  let pumpRunning = true;
  const pumpLoop = (): void => { if (pumpRunning) { dev.pump(); soon(pumpLoop); } };
  soon(pumpLoop);
  const report = await transport.usbControl('bench 1 32 200');
  pumpRunning = false;
  await transport.close();
  console.log('E  console: bench 1 32 200');
  console.log(report.split('\n').map((l) => `  ${l}`).join('\n'));
  console.log('');
}
