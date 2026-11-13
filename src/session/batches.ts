import { Codec8Frame } from "../wire/codec8.ts";
import { combineCodec8e, encodeCodec8e } from "../wire/codec8e.ts";
import { SessionError } from "./state.ts";

/** Limits include the whole TCP envelope; queuedBytes conservatively counts single-record frames. */
type Limits = {
  maxRecords: number;
  maxFrameBytes: number;
  maxQueuedRecords: number;
  maxQueuedBytes: number;
};

/**
 * Owns a bounded FIFO and one stable in-flight head. Enqueue freezes validated bytes;
 * peek never removes records, and only the exact pending handle can acknowledge them.
 * A caller invokes acknowledge only after transport success (durable commit is SIM-PR11).
 */
export class BatchQueue {
  readonly #limits: Limits;
  readonly #records: { frame: Codec8Frame; size: number }[] = [];
  #pending: Codec8Frame | undefined;
  #bytes = 0;

  /** Copies bounded integer policy; malformed options fail before queue state exists. */
  constructor(limits: Limits) {
    const ranges = {
      maxRecords: [1, 16],
      maxFrameBytes: [53, 1280],
      maxQueuedRecords: [1, 1000],
      maxQueuedBytes: [53, 16777216],
    } as const;
    for (const key of Object.keys(ranges) as (keyof Limits)[]) {
      const [min, max] = ranges[key];
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < min ||
        limits[key] > max
      )
        throw new SessionError("invalid-session");
    }
    this.#limits = { ...limits };
  }

  /** Returns queued records, including any unacknowledged pending head. */
  get length() {
    return this.#records.length;
  }

  /** Returns owned single-record frame bytes; the cached assembled batch adds at most 1280 bytes. */
  get queuedBytes() {
    return this.#bytes;
  }

  /** Validates/freezes before insertion; overflow never removes or replaces an existing record. */
  enqueue(record: unknown): void {
    const frame = Codec8Frame.fromExtendedBytes(encodeCodec8e(record));
    const size = frame.snapshot().bytes.length;
    if (
      size > this.#limits.maxFrameBytes ||
      this.length >= this.#limits.maxQueuedRecords ||
      this.#bytes + size > this.#limits.maxQueuedBytes
    )
      throw new SessionError("invalid-session");
    this.#records.push({ frame, size });
    this.#bytes += size;
  }

  /** Returns the stable largest fitting FIFO prefix without dequeueing; empty queues return undefined. */
  peek(): Codec8Frame | undefined {
    if (this.#pending) return this.#pending;
    const frames: Codec8Frame[] = [];
    let bytes = 15;
    for (const entry of this.#records) {
      if (
        frames.length === this.#limits.maxRecords ||
        bytes + entry.size - 15 > this.#limits.maxFrameBytes
      )
        break;
      frames.push(entry.frame);
      bytes += entry.size - 15;
    }
    if (frames.length) this.#pending = combineCodec8e(frames);
    return this.#pending;
  }

  /** Commits head removal only for the current opaque handle; stale/forged ACKs leave FIFO intact. */
  acknowledge(frame: Codec8Frame): void {
    if (!this.#pending || frame !== this.#pending)
      throw new SessionError("invalid-session");
    for (const entry of this.#records.splice(
      0,
      Codec8Frame.snapshot(frame).recordCount,
    ))
      this.#bytes -= entry.size;
    this.#pending = undefined;
  }
}
