import { Ajv2020 } from "ajv/dist/2020.js";
import { Codec8Frame, FrameError } from "../wire/codec8.ts";
import { BatchQueue } from "./batches.ts";
import { SessionError } from "./state.ts";

/** Immutable JSON strings cross the persistence port; writes return only after durable replacement. */
export type CheckpointStore = {
  read(): string | undefined;
  write(body: string): void;
};

/** Digests bind normalized inputs, private identity and the complete encoded schedule. */
export type Binding = Record<
  "config" | "route" | "profile" | "scenario" | "identity" | "schedule",
  string
>;

/** Frame-null entries are independent send ticks; frame entries are frozen captures. */
export type Work = { atMs: number; frame: Codec8Frame | null };

/** Queue limits include serialized metadata and frozen bytes; age uses virtual capture time. */
export type SpoolLimits = ConstructorParameters<typeof BatchQueue>[0] & {
  maxAgeMs: number;
};

/** Fixed resource/privacy categories; original input, path and OS messages never enter output. */
type Category =
  | "spool-invalid"
  | "spool-mismatch"
  | "spool-capacity"
  | "spool-expired"
  | "spool-io"
  | "spool-busy"
  | "spool-exists";

/** A reviewed checkpoint/storage failure without private OS or input details. */
export class SpoolError extends Error {
  readonly category: Category;

  /** Stores only a reviewed category, never the filesystem/SQLite error object. */
  constructor(category: Category) {
    super(category);
    this.category = category;
  }
}

/** Version one is replay-bound: cursor reconstructs route/capture/random decisions from the schedule digest. */
type State = {
  version: 1;
  producer: "capture1-codec8e1";
  binding: Binding;
  cursor: number;
  atMs: number;
  captured: number;
  acknowledged: number;
  attempts: number;
  status: "active" | "pending" | "cancelled" | "complete";
  records: { atMs: number; hex: string }[];
  pending: string | null;
};
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const integer = { type: "integer", minimum: 0, maximum: 1000000 };
const time = { type: "integer", minimum: 0, maximum: 604800000 };
const hex = {
  type: "string",
  minLength: 106,
  maxLength: 2560,
  pattern: "^(?:[a-f0-9]{2})+$",
};
const keys = [
  "config",
  "route",
  "profile",
  "scenario",
  "identity",
  "schedule",
] as const;
const valid = new Ajv2020({ ownProperties: true }).compile<State>({
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "producer",
    "binding",
    "cursor",
    "atMs",
    "captured",
    "acknowledged",
    "attempts",
    "status",
    "records",
    "pending",
  ],
  properties: {
    version: { const: 1 },
    producer: { const: "capture1-codec8e1" },
    binding: {
      type: "object",
      additionalProperties: false,
      required: keys,
      properties: Object.fromEntries(keys.map((key) => [key, digest])),
    },
    cursor: integer,
    atMs: time,
    captured: integer,
    acknowledged: integer,
    attempts: integer,
    status: { enum: ["active", "pending", "cancelled", "complete"] },
    records: {
      type: "array",
      maxItems: 1000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["atMs", "hex"],
        properties: { atMs: time, hex },
      },
    },
    pending: { anyOf: [hex, { type: "null" }] },
  },
});

/**
 * Couples queue ownership and replay cursor to synchronous durable commits.
 * A failed/uncertain write poisons this instance; reopen the authoritative file.
 * Pending bytes are persisted before send; only acknowledged commits remove FIFO work.
 */
export class DurableSpool {
  readonly #store: CheckpointStore;
  readonly #work: readonly Work[];
  readonly #limits: SpoolLimits;
  readonly #queue: BatchQueue;
  #state: State;
  #failed = false;

  /** Validates checkpoint and exact replay binding before any replacement or transmission. */
  constructor(
    store: CheckpointStore,
    binding: Binding,
    work: readonly Work[],
    limits: SpoolLimits,
    resume: boolean,
  ) {
    this.#store = store;
    this.#limits = { ...limits };
    this.#queue = new BatchQueue(limits);
    this.#work = work.map((item) => ({
      atMs: item.atMs,
      frame: item.frame
        ? Codec8Frame.fromExtendedBytes(Codec8Frame.snapshot(item.frame).bytes)
        : null,
    }));
    if (
      !Number.isSafeInteger(limits.maxAgeMs) ||
      limits.maxAgeMs < 1 ||
      limits.maxAgeMs > 604800000 ||
      work.length > 2000
    )
      throw new SpoolError("spool-invalid");
    if (
      this.#work.some(
        (item, index) =>
          !Number.isSafeInteger(item.atMs) ||
          item.atMs < 0 ||
          item.atMs > 604800000 ||
          item.atMs < (this.#work[index - 1]?.atMs ?? 0),
      ) ||
      keys.some((key) => !/^[a-f0-9]{64}$/.test(binding[key]))
    )
      throw new SpoolError("spool-invalid");
    const body = store.read();
    if (body === undefined) {
      if (resume) throw new SpoolError("spool-invalid");
      this.#state = {
        version: 1,
        producer: "capture1-codec8e1",
        binding: { ...binding },
        cursor: 0,
        atMs: 0,
        captured: 0,
        acknowledged: 0,
        attempts: 0,
        status: "active",
        records: [],
        pending: null,
      };
      this.#commit(this.#state);
      return;
    }
    if (!resume) throw new SpoolError("spool-exists");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new SpoolError("spool-invalid");
    }
    if (!valid(parsed)) throw new SpoolError("spool-invalid");
    this.#state = parsed;
    if (keys.some((key) => binding[key] !== parsed.binding[key]))
      throw new SpoolError("spool-mismatch");
    const captures = this.#work
      .slice(0, parsed.cursor)
      .filter((item) => item.frame !== null);
    if (
      parsed.cursor > this.#work.length ||
      captures.length !== parsed.captured ||
      parsed.acknowledged > parsed.captured ||
      parsed.records.length !== parsed.captured - parsed.acknowledged ||
      parsed.atMs !== (this.#work[parsed.cursor - 1]?.atMs ?? 0)
    )
      throw new SpoolError("spool-invalid");
    try {
      for (const [index, entry] of parsed.records.entries()) {
        const expected = captures[parsed.acknowledged + index];
        if (
          !expected?.frame ||
          expected.atMs !== entry.atMs ||
          expected.frame.snapshot().bytes.toString("hex") !== entry.hex
        )
          throw new SpoolError("spool-invalid");
        this.#queue.enqueueFrame(
          Codec8Frame.fromExtendedBytes(Buffer.from(entry.hex, "hex")),
        );
      }
      if (parsed.pending !== null)
        this.#queue.restorePending(
          Codec8Frame.fromExtendedBatchBytes(
            Buffer.from(parsed.pending, "hex"),
          ),
        );
    } catch (error) {
      if (error instanceof FrameError || error instanceof SessionError)
        throw new SpoolError("spool-invalid");
      throw error;
    }
    if (
      parsed.status === "complete" &&
      (parsed.cursor !== this.#work.length || parsed.records.length)
    )
      throw new SpoolError("spool-invalid");
    this.#budget(parsed);
  }

  /** Returns sanitized counters, never frozen bytes or binding/identity data. */
  get stats() {
    const s = this.#state;
    return {
      cursor: s.cursor,
      atMs: s.atMs,
      captured: s.captured,
      acknowledged: s.acknowledged,
      queued: s.records.length,
      attempts: s.attempts,
      status: s.status,
    };
  }

  /** Commits one capture/send cursor step; enqueue and capture progress cannot diverge. */
  advance(): boolean {
    this.#healthy();
    const item = this.#work[this.#state.cursor];
    if (!item) return false;
    this.#age(item.atMs);
    const records = [...this.#state.records];
    if (item.frame)
      records.push({
        atMs: item.atMs,
        hex: item.frame.snapshot().bytes.toString("hex"),
      });
    const next: State = {
      ...this.#state,
      status: "active",
      cursor: this.#state.cursor + 1,
      atMs: item.atMs,
      captured: this.#state.captured + (item.frame ? 1 : 0),
      records,
    };
    this.#budget(next);
    if (item.frame)
      try {
        this.#queue.enqueueFrame(item.frame);
      } catch (error) {
        if (error instanceof SessionError)
          throw new SpoolError("spool-capacity");
        throw error;
      }
    this.#commit(next);
    return item.frame === null;
  }

  /** Persists the exact pending packet and logical submission count before making it eligible to send. */
  prepare(): Codec8Frame | undefined {
    this.#healthy();
    this.#age(this.#state.atMs);
    const frame = this.#queue.peek();
    if (!frame) return undefined;
    this.#commit({
      ...this.#state,
      status: "active",
      pending: frame.snapshot().bytes.toString("hex"),
      attempts: this.#state.attempts + 1,
    });
    return frame;
  }

  /** Atomically persists ACK removal and current replay cursor; uncertain commits require reopen. */
  acknowledge(frame: Codec8Frame): void {
    this.#healthy();
    if (this.#state.pending === null) throw new SpoolError("spool-invalid");
    this.#queue.acknowledge(frame);
    const count = Codec8Frame.snapshot(frame).recordCount;
    this.#commit({
      ...this.#state,
      status: "active",
      records: this.#state.records.slice(count),
      acknowledged: this.#state.acknowledged + count,
      pending: null,
    });
  }

  /** Records cooperative cancellation without advancing capture or deleting queued work. */
  cancel(): void {
    this.#healthy();
    this.#commit({
      ...this.#state,
      status:
        this.#state.cursor === this.#work.length && !this.#state.records.length
          ? "complete"
          : "cancelled",
    });
  }

  /** Refuses reuse after a write may have published either old or new state. */
  #healthy() {
    if (this.#failed) throw new SpoolError("spool-io");
  }

  /** Expiry is measured from capture virtual time, never device drift or downtime. */
  #age(at: number) {
    if (
      this.#state.records.some(
        (entry) => at - entry.atMs > this.#limits.maxAgeMs,
      )
    )
      throw new SpoolError("spool-expired");
  }

  /** Bounds serialized metadata plus distinct frozen bytes before any replacement. */
  #budget(next: State) {
    const bytes =
      JSON.stringify(next).length +
      next.records.reduce((n, r) => n + r.hex.length / 2, 0) +
      (next.pending?.length ?? 0) / 2;
    if (
      next.records.length > this.#limits.maxQueuedRecords ||
      bytes > this.#limits.maxQueuedBytes ||
      next.attempts > 1000000
    )
      throw new SpoolError("spool-capacity");
  }

  /** Publishes immutable JSON before assigning authoritative memory; failures poison the instance. */
  #commit(next: State) {
    next = {
      ...next,
      status:
        next.status === "cancelled"
          ? "cancelled"
          : next.cursor === this.#work.length
            ? next.records.length
              ? "pending"
              : "complete"
            : "active",
    };
    this.#budget(next);
    this.#failed = true;
    this.#store.write(JSON.stringify(next));
    this.#state = next;
    this.#failed = false;
  }
}
