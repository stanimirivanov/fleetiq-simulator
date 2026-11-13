import { Codec8Frame, FrameError } from "../wire/codec8.ts";
import { encodeCodec8e } from "../wire/codec8e.ts";
import { capture } from "./capture.ts";
import { createPlayback } from "./route.ts";

/** Fixed fleet admission categories never retain member data or private input values. */
export class FleetError extends Error {
  readonly category: "invalid-fleet" | "fleet-overflow";

  /** Distinguishes rejected resource admission from malformed policy without including caller text. */
  constructor(category: "invalid-fleet" | "fleet-overflow" = "invalid-fleet") {
    super(category);
    this.category = category;
  }
}

/** Product capacity is unchanged; the larger profile is for independently authorized reference peers only. */
export type FleetPolicy = {
  profile: "product" | "reference-peer";
  maxConcurrent: number;
  maxAttempts: number;
  retryDelayMs: number;
  maxQueuedBytes: number;
};

/** Private ready work. Transport sees identities through opaque leases; diagnostics never label members. */
export type FleetDevice = {
  deviceId: string;
  identity: string;
  frames: readonly Codec8Frame[];
};

/** Each member owns a fresh playback cursor and explicit seed/device-clock mapping. */
export type FleetMember = {
  deviceId: string;
  identity: string;
  seed: string;
  clockOffsetMs: number;
  driftPpm: number;
};

/** One outstanding immutable frame per device; only the exact claimed object can settle its queue. */
export type FleetLease = Readonly<{
  deviceId: string;
  identity: string;
  frame: Codec8Frame;
  recordCount: number;
  attempt: number;
  startedAt: number;
}>;

/** Frozen packet metadata remains with its FIFO head until exact lease acknowledgement. */
type Item = { frame: Codec8Frame; bytes: number; records: number };

/** Per-device retry eligibility and queue ownership are never shared between playback members. */
type State = {
  deviceId: string;
  identity: string;
  items: Item[];
  records: number;
  attempt: number;
  ready: number;
  active: boolean;
  stopped: boolean;
};

/** Admits unique private identities and local logical names before any frame allocation or IO. */
function membersValid(
  members: readonly Pick<FleetDevice, "deviceId" | "identity">[],
) {
  if (members.length < 1 || members.length > 100) throw new FleetError();
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const m of members) {
    if (
      !m ||
      typeof m.deviceId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}(?![\s\S])/.test(m.deviceId) ||
      typeof m.identity !== "string" ||
      m.identity.length !== 15 ||
      /[^0-9]/u.test(m.identity) ||
      ids.has(m.deviceId) ||
      identities.has(m.identity)
    )
      throw new FleetError();
    ids.add(m.deviceId);
    identities.add(m.identity);
  }
}

/**
 * Prepares accelerated periodic captures with independent scenario seed/clock/fix state.
 * Simulated loss is explicit and counted before enqueue. Encoded queues are bounded during
 * construction, not after an unbounded fleet has been allocated. No timers or IO are used.
 */
export function buildFleet(
  route: unknown,
  scenario: unknown,
  profile: unknown,
  members: readonly FleetMember[],
  intervalMs: number,
  dropEvery: number,
  maxQueuedBytes: number,
) {
  membersValid(members);
  if (
    !scenario ||
    typeof scenario !== "object" ||
    Array.isArray(scenario) ||
    !Number.isSafeInteger(dropEvery) ||
    dropEvery < 0 ||
    dropEvery > 1000 ||
    !Number.isSafeInteger(maxQueuedBytes) ||
    maxQueuedBytes < 53 ||
    maxQueuedBytes > 16777216
  )
    throw new FleetError();
  const seeds = new Set<string>();
  for (const m of members) {
    if (
      typeof m.seed !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}(?![\s\S])/.test(m.seed) ||
      seeds.has(m.seed)
    )
      throw new FleetError();
    seeds.add(m.seed);
  }
  let captured = 0,
    simulatedLoss = 0,
    bytes = 0;
  const devices = members.map((m) => {
    const playback = createPlayback(
      route,
      {
        ...scenario,
        seed: m.seed,
        clockOffsetMs: m.clockOffsetMs,
        driftPpm: m.driftPpm,
      },
      profile,
    );
    const frames: Codec8Frame[] = [];
    let ordinal = 0;
    for (const tick of capture(playback, {
      intervalMs,
      sendIntervalMs: intervalMs,
      on: [],
    })) {
      if (tick.type !== "capture") continue;
      captured++;
      ordinal++;
      if (dropEvery && ordinal % dropEvery === 0) {
        simulatedLoss++;
        continue;
      }
      const encoded = encodeCodec8e(tick.record);
      bytes += encoded.length;
      if (bytes > maxQueuedBytes) throw new FleetError("fleet-overflow");
      frames.push(Codec8Frame.fromExtendedBytes(encoded));
    }
    return { deviceId: m.deviceId, identity: m.identity, frames };
  });
  return { devices, captured, simulatedLoss };
}

/**
 * Pure round-robin FIFO policy. Retries retain the head and release their slot until ready.
 * The caller supplies monotonic milliseconds and settles only after transport scope cleanup.
 * Exhaustion retains queued evidence; cancellation releases leases without claiming delivery.
 */
export class FairFleet {
  readonly #states: State[] = [];
  readonly #policy: FleetPolicy;
  readonly #active = new Map<FleetLease, State>();
  #cursor = 0;
  #previous = 0;
  #records = 0;
  #bytes = 0;

  /** Snapshots bounded queues before any claim; profile overrides cannot raise the product cap. */
  constructor(devices: readonly FleetDevice[], policy: FleetPolicy) {
    membersValid(devices);
    const cap =
      policy.profile === "product"
        ? 2
        : policy.profile === "reference-peer"
          ? 100
          : 0;
    for (const [value, min, max] of [
      [policy.maxConcurrent, 1, cap],
      [policy.maxAttempts, 1, 100],
      [policy.retryDelayMs, 0, 60000],
      [policy.maxQueuedBytes, 53, 16777216],
    ])
      if (
        value === undefined ||
        min === undefined ||
        max === undefined ||
        !Number.isSafeInteger(value) ||
        value < min ||
        value > max
      )
        throw new FleetError();
    this.#policy = { ...policy };
    for (const d of devices) {
      const items: Item[] = [];
      let records = 0;
      for (const input of d.frames) {
        let snapshot: ReturnType<typeof Codec8Frame.snapshot>;
        try {
          snapshot = Codec8Frame.snapshot(input);
        } catch (e) {
          if (e instanceof FrameError) throw new FleetError();
          throw e;
        }
        records += snapshot.recordCount;
        this.#records += snapshot.recordCount;
        this.#bytes += snapshot.bytes.length;
        if (records > 1000 || this.#bytes > policy.maxQueuedBytes)
          throw new FleetError("fleet-overflow");

        // Wire handles own immutable private bytes; a second retained copy would double the fleet byte budget.
        if (!(input instanceof Codec8Frame)) throw new FleetError();
        const frame = input;
        items.push({
          frame,
          bytes: snapshot.bytes.length,
          records: snapshot.recordCount,
        });
      }
      this.#states.push({
        deviceId: d.deviceId,
        identity: d.identity,
        items,
        records,
        attempt: 0,
        ready: 0,
        active: false,
        stopped: false,
      });
    }
  }

  /** Rejects backward/invalid scheduling time so device timestamp drift cannot alter retry ordering. */
  #time(at: number) {
    if (!Number.isFinite(at) || at < this.#previous) throw new FleetError();
    this.#previous = at;
  }

  /** Claims at most one ready head per device and moves the rotation past that device. */
  claim(at: number): FleetLease | undefined {
    this.#time(at);
    if (this.#active.size >= this.#policy.maxConcurrent) return;
    for (let n = 0; n < this.#states.length; n++) {
      const index = (this.#cursor + n) % this.#states.length;
      const s = this.#states[index];
      if (!s || s.active || s.stopped || s.ready > at) continue;
      const item = s.items[0];
      if (!item) continue;
      s.active = true;
      s.attempt++;
      this.#cursor = (index + 1) % this.#states.length;
      const lease = Object.freeze({
        deviceId: s.deviceId,
        identity: s.identity,
        frame: item.frame,
        recordCount: item.records,
        attempt: s.attempt,
        startedAt: at,
      });
      this.#active.set(lease, s);
      return lease;
    }
  }

  /** ACK removes exactly one head; failure/cancellation never deletes unacknowledged records. */
  settle(
    lease: FleetLease,
    outcome: "ack" | "retry" | "stop" | "cancel",
    at: number,
  ) {
    const s = this.#active.get(lease);
    if (!s || !["ack", "retry", "stop", "cancel"].includes(outcome))
      throw new FleetError();
    this.#time(at);
    this.#active.delete(lease);
    s.active = false;
    if (outcome === "ack") {
      const item = s.items.shift();
      if (!item) throw new FleetError();
      s.records -= item.records;
      this.#records -= item.records;
      this.#bytes -= item.bytes;
      s.attempt = 0;
    } else if (outcome !== "cancel") {
      s.stopped = outcome === "stop" || s.attempt >= this.#policy.maxAttempts;
      s.ready = at + this.#policy.retryDelayMs;
    }
  }

  /** A fleet is drained when every remaining queue is exhausted; retained failures still appear in stats. */
  get done() {
    return (
      !this.#active.size &&
      this.#states.every((s) => s.stopped || !s.items.length)
    );
  }

  /** Earliest non-active retry eligibility; undefined means no schedulable work remains. */
  get readyAt() {
    const times = this.#states
      .filter((s) => !s.active && !s.stopped && s.items.length)
      .map((s) => s.ready);
    return times.length ? Math.min(...times) : undefined;
  }

  /** Fixed aggregate queue diagnostics; member names, identities and frozen bytes never escape here. */
  get stats() {
    return {
      active: this.#active.size,
      queuedRecords: this.#records,
      queuedBytes: this.#bytes,
      exhaustedRecords: this.#states.reduce(
        (n, s) => n + (s.stopped ? s.records : 0),
        0,
      ),
    };
  }
}
