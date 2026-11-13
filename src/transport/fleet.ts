import { setTimeout as delay } from "node:timers/promises";
import {
  FairFleet,
  type FleetDevice,
  FleetError,
  type FleetLease,
  type FleetPolicy,
} from "../scenarios/fleet.ts";
import {
  SessionError,
  type SessionOptions,
  sessionLimits,
} from "../session/state.ts";
import { FleetMetrics, type FleetResources } from "../telemetry.ts";
import { sendBatches } from "./tcp.ts";

/** Prepared captures are bounded before IO; supplied counts must equal queued records plus deliberate loss. */
type Input = {
  devices: readonly FleetDevice[];
  captured: number;
  simulatedLoss: number;
};

/** Profile authorization is independent of target admission; reference capacity never applies to Compose DNS. */
type Options = Omit<
  SessionOptions,
  "identity" | "maxAttempts" | "connectionPolicy"
> & { authorizedReferencePeer?: boolean };

/** Aggregate outcome only; it does not prove product ingestion, remote deduplication or physical fidelity. */
export type FleetResult = {
  status:
    | "fleet-completed"
    | "fleet-incomplete"
    | "fleet-cancelled"
    | "fleet-timeout";
  metrics: ReturnType<FleetMetrics["snapshot"]> & {
    exhaustedRecords: number;
    undeliveredRecords: number;
  };
};

/** Settled scoped attempt; failure presence is explicit so even a thrown undefined remains a defect. */
type Event = { lease: FleetLease; error?: unknown; failed: boolean };

/**
 * Runs one strict scoped transport attempt per lease. Backoff lives in the fair policy,
 * not in a held socket/worker. A shared monotonic budget and abort controller bound
 * all attempts; every outstanding promise is drained before returning any outcome.
 * Resource observations are supplied by the IO owner, never inferred from device count.
 */
export async function runFleet(
  input: Input,
  policy: FleetPolicy,
  options: Options,
  probe: () => FleetResources,
): Promise<FleetResult> {
  const fleet = new FairFleet(input.devices, policy);
  const first = input.devices[0];
  if (
    !first ||
    input.captured !== fleet.stats.queuedRecords + input.simulatedLoss ||
    (policy.profile === "reference-peer" &&
      (!options.authorizedReferencePeer ||
        !["127.0.0.1", "::1"].includes(options.host)))
  )
    throw new FleetError();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const limits = sessionLimits({
    ...options,
    identity: first.identity,
    maxAttempts: policy.maxAttempts,
    signal,
  });
  const metrics = new FleetMetrics(
    input.captured,
    input.simulatedLoss,
    probe(),
  );
  const active = new Map<FleetLease, Promise<Event>>();
  let status: FleetResult["status"] = "fleet-completed";
  let failed = false;
  let defect: unknown;

  /** Samples only bounded aggregates; snapshots include retained exhausted/in-flight queue bytes. */
  function observe() {
    const s = fleet.stats;
    metrics.queue(s.queuedRecords, s.queuedBytes, s.active);
    metrics.sample(probe());
  }

  /** Commits only a matching transport receipt; cleanup retains uncertain work without blaming cancellation on peers. */
  function finish(event: Event, cleanup = false) {
    active.delete(event.lease);
    const at = limits.now();
    if (!event.failed) {
      fleet.settle(event.lease, "ack", at);
      metrics.ack(event.lease.recordCount, at - event.lease.startedAt);
      return;
    }
    const error = event.error;
    if (!(error instanceof SessionError)) {
      fleet.settle(event.lease, "cancel", at);
      throw error;
    }
    if (
      ["cancelled", "run-timeout", "invalid-session"].includes(error.category)
    ) {
      fleet.settle(event.lease, "cancel", at);
      if (!cleanup) throw error;
      return;
    }
    metrics.failure(error.category);
    fleet.settle(
      event.lease,
      cleanup
        ? "cancel"
        : error.category === "login-refused"
          ? "stop"
          : "retry",
      at,
    );
  }

  try {
    observe();
    while (!fleet.done) {
      limits.remaining();
      for (;;) {
        const claimed = fleet.claim(limits.now());
        if (!claimed) break;
        let remaining: number;
        try {
          remaining = limits.remaining();
        } catch (error) {
          fleet.settle(claimed, "cancel", limits.now());
          throw error;
        }
        const attempt = sendBatches([claimed.frame], {
          ...options,
          identity: claimed.identity,
          signal,
          maxAttempts: 1,
          connectionPolicy: "single-batch",
          totalDeadlineMs: Math.ceil(remaining),
        });
        active.set(
          claimed,
          attempt.then(
            () => ({ lease: claimed, failed: false }),
            (error) => ({ lease: claimed, failed: true, error }),
          ),
        );
        metrics.attempt(claimed.attempt > 1, claimed.recordCount);
      }
      observe();
      if (fleet.done) break;
      const ready = fleet.readyAt;
      const wait = Math.max(
        1,
        Math.min(
          10,
          limits.remaining(),
          active.size < policy.maxConcurrent && ready !== undefined
            ? Math.max(0, ready - limits.now())
            : 10,
        ),
      );
      const timer = new AbortController();
      try {
        const wake = delay(wait, undefined, {
          signal: AbortSignal.any([signal, timer.signal]),
        });
        const event = await Promise.race([...active.values(), wake]);
        if (event) finish(event);
      } catch (error) {
        if (signal.aborted) throw new SessionError("cancelled");
        throw error;
      } finally {
        timer.abort();
      }
    }
    limits.remaining();
    if (fleet.stats.queuedRecords) status = "fleet-incomplete";
  } catch (error) {
    if (error instanceof SessionError && error.category === "cancelled")
      status = "fleet-cancelled";
    else if (error instanceof SessionError && error.category === "run-timeout")
      status = "fleet-timeout";
    else {
      failed = true;
      defect = error;
    }
  } finally {
    controller.abort();
    for (const event of await Promise.all(active.values())) {
      try {
        finish(event, true);
      } catch (error) {
        if (!failed) {
          failed = true;
          defect = error;
        }
      }
    }
  }
  if (failed) throw defect;
  observe();
  return {
    status,
    metrics: {
      ...metrics.snapshot(),
      exhaustedRecords: fleet.stats.exhaustedRecords,
      undeliveredRecords: fleet.stats.queuedRecords,
    },
  };
}
