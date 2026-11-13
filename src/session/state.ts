/**
 * Controls socket retirement after each ACK; persistent mode requires a compliant
 * peer because equal-count unsolicited ACKs cannot be correlated to batches.
 */
export type ConnectionPolicy = "single-batch" | "persistent-compliant-peer";

/**
 * Loopback-only default; sending elsewhere requires an explicitly admitted target.
 */
export const defaultTarget = { host: "127.0.0.1", port: 55027 } as const;

/**
 * Default per-exchange wait, whole-run monotonic budget and attempt policy.
 * A successful batch resets the failure counter; these values are validated by sessionLimits.
 */
export const sessionDefaults = {
  ackDeadlineMs: 30_000,
  totalDeadlineMs: 600_000,
  maxAttempts: 5,
  connectionPolicy: "single-batch",
} as const;

/**
 * Counts locally acknowledged records once per batch; ACK loss can still cause remote duplicates.
 * This receipt does not prove projection, browser visibility or physical-device acceptance.
 */
export type DeliveryReceipt = { status: "acknowledged"; recordCount: number };

/**
 * Inputs for a bounded authorized TCP run; identity must be exactly 15 decimal digits.
 * Deadlines are milliseconds; now must be a monotonic millisecond clock. Signal
 * cancellation is shared by budget checks and Effect execution. DNS admission belongs to transport.
 */
export type SessionOptions = {
  host: string;
  port: number;
  identity: string;
  ackDeadlineMs?: number;
  totalDeadlineMs?: number;
  maxAttempts?: number;
  connectionPolicy?: ConnectionPolicy;
  signal?: AbortSignal;
  now?: () => number;
};

/**
 * Reviewed session failure categories safe for output without endpoints, identities or peer bytes.
 */
export type Failure =
  | "disconnect-timeout"
  | "fault-accepted"
  | "invalid-session"
  | "cancelled"
  | "run-timeout"
  | "login-timeout"
  | "login-refused"
  | "ack-timeout"
  | "ack-count"
  | "unexpected-reply"
  | "connection-closed";

/**
 * Carries an expected session failure category across policy and transport boundaries.
 */
export class SessionError extends Error {
  readonly category: Failure;

  /** Retains only the reviewed category; no underlying socket or input error is exposed. */
  constructor(category: Failure) {
    super(category);
    this.category = category;
  }
}

function bounded(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validates target, identity and numeric limits, then captures one monotonic run deadline.
 * Throws invalid-session for rejected options; the returned remaining function checks
 * cancellation before timeout. Does not resolve DNS, open sockets or restart the budget.
 */
export function sessionLimits({
  host,
  port,
  identity,
  ackDeadlineMs = sessionDefaults.ackDeadlineMs,
  totalDeadlineMs = sessionDefaults.totalDeadlineMs,
  maxAttempts = sessionDefaults.maxAttempts,
  connectionPolicy = sessionDefaults.connectionPolicy,
  now = () => performance.now(),
  signal,
}: SessionOptions) {
  if (
    (host !== "127.0.0.1" && host !== "::1" && host !== "tcp-ingestion") ||
    !bounded(port, 1, 65535) ||
    identity.length !== 15 ||
    /[^0-9]/u.test(identity) ||
    !bounded(ackDeadlineMs, 100, 60_000) ||
    !bounded(totalDeadlineMs, 1, 86_400_000) ||
    !bounded(maxAttempts, 1, 100) ||
    (connectionPolicy !== "single-batch" &&
      connectionPolicy !== "persistent-compliant-peer")
  )
    throw new SessionError("invalid-session");

  const end = now() + totalDeadlineMs;

  /** Returns positive remaining milliseconds or throws cancelled/run-timeout. */
  function remaining(at = now()) {
    if (signal?.aborted) throw new SessionError("cancelled");
    const ms = end - at;
    if (ms <= 0) throw new SessionError("run-timeout");
    return ms;
  }
  return {
    ackDeadlineMs,
    maxAttempts,
    connectionPolicy,
    now,
    remaining,
    signal,
  };
}

/**
 * Validated policy and shared deadline operations consumed by transport; no socket state is owned here.
 */
export type SessionLimits = ReturnType<typeof sessionLimits>;
