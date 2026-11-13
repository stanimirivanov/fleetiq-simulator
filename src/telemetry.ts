/** Actual process observations are supplied by the IO owner; this module never samples ambient state. */
export type FleetResources = {
  rssBytes: number;
  openFds: number;
  cpuUserUs: number;
  cpuSystemUs: number;
};
const categories = [
  "login-refused",
  "login-timeout",
  "ack-timeout",
  "ack-count",
  "unexpected-reply",
  "connection-closed",
] as const;
const bounds = [10, 50, 250, 1000, 5000, 60000];

/** Rejects invalid observations without retaining caller text, private labels or arbitrary metric keys. */
function number(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("invalid-metrics");
  return value;
}

/** Fixed counters and histogram buckets keep memory/cardinality independent of device names and run length. */
export class FleetMetrics {
  readonly #captured: number;
  readonly #loss: number;
  readonly #base: FleetResources;
  readonly #failures = Object.fromEntries(
    categories.map((key) => [key, 0]),
  ) as Record<(typeof categories)[number], number>;
  readonly #latencies = Array<number>(bounds.length + 1).fill(0);
  #attempts = 0;
  #duplicates = 0;
  #possibleDuplicateRecords = 0;
  #acks = 0;
  #queued = 0;
  #bytes = 0;
  #peakRecords = 0;
  #peakBytes = 0;
  #peakActive = 0;
  #rss = 0;
  #fds = 0;
  #user = 0;
  #system = 0;

  /** Captured and deliberate-loss counts describe preparation; resource deltas start at this baseline. */
  constructor(captured: number, loss: number, baseline: FleetResources) {
    this.#captured = number(captured);
    this.#loss = number(loss);
    if (loss > captured) throw new Error("invalid-metrics");
    this.#base = { ...baseline };
    this.sample(baseline);
  }

  /** Counts retry calls and an upper bound on possible duplicate records, never inferred remote effects. */
  attempt(repeated: boolean, records = 1) {
    number(records);
    this.#attempts++;
    if (repeated) {
      this.#duplicates++;
      this.#possibleDuplicateRecords += records;
    }
  }

  /** Counts only matched ACK records; latency is real attempt-to-ACK time, never virtual device time. */
  ack(records: number, latencyMs: number) {
    number(records);
    if (!Number.isFinite(latencyMs) || latencyMs < 0)
      throw new Error("invalid-metrics");
    this.#acks += records;
    const index = bounds.findIndex((bound) => latencyMs <= bound);
    const bucket = index < 0 ? bounds.length : index;
    this.#latencies[bucket] = (this.#latencies[bucket] ?? 0) + 1;
  }

  /** Only reviewed transport failure categories may become labels; timeouts are observations, not root causes. */
  failure(category: unknown) {
    if (
      typeof category !== "string" ||
      !categories.some((key) => key === category)
    )
      throw new Error("invalid-metrics");
    this.#failures[category as (typeof categories)[number]]++;
  }

  /** Queue includes in-flight and exhausted records until matching ACK removal; peaks do not decrease. */
  queue(records: number, bytes: number, active: number) {
    this.#queued = number(records);
    this.#bytes = number(bytes);
    number(active);
    this.#peakRecords = Math.max(this.#peakRecords, records);
    this.#peakBytes = Math.max(this.#peakBytes, bytes);
    this.#peakActive = Math.max(this.#peakActive, active);
  }

  /** Records actual high-water RSS and sampled FDs plus monotonic process CPU deltas in microseconds. */
  sample(value: FleetResources) {
    for (const key of [
      "rssBytes",
      "openFds",
      "cpuUserUs",
      "cpuSystemUs",
    ] as const)
      number(value[key]);
    if (
      value.cpuUserUs < this.#base.cpuUserUs + this.#user ||
      value.cpuSystemUs < this.#base.cpuSystemUs + this.#system
    )
      throw new Error("invalid-metrics");
    this.#rss = Math.max(this.#rss, value.rssBytes);
    this.#fds = Math.max(this.#fds, value.openFds);
    this.#user = value.cpuUserUs - this.#base.cpuUserUs;
    this.#system = value.cpuSystemUs - this.#base.cpuSystemUs;
  }

  /** Returns detached aggregates with no user-supplied names, error messages or unbounded samples. */
  snapshot() {
    return {
      capturedRecords: this.#captured,
      simulatedLossRecords: this.#loss,
      attempts: this.#attempts,
      retryAttempts: this.#duplicates,
      possibleDuplicateRecords: this.#possibleDuplicateRecords,
      acknowledgedRecords: this.#acks,
      overflows: 0,
      queuedRecords: this.#queued,
      queuedBytes: this.#bytes,
      peakQueuedRecords: this.#peakRecords,
      peakQueuedBytes: this.#peakBytes,
      peakSessions: this.#peakActive,
      sessionFailures: { ...this.#failures },
      ackLatencyMs: { upperBounds: [...bounds], counts: [...this.#latencies] },
      peakRssBytes: this.#rss,
      sampledPeakOpenFds: this.#fds,
      cpuUserUs: this.#user,
      cpuSystemUs: this.#system,
    };
  }
}
