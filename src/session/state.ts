export type ConnectionPolicy = "single-batch" | "persistent-compliant-peer";

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

export type Failure =
  | "invalid-session"
  | "cancelled"
  | "run-timeout"
  | "login-timeout"
  | "login-refused"
  | "ack-timeout"
  | "ack-count"
  | "unexpected-reply"
  | "connection-closed";

export class SessionError extends Error {
  readonly category: Failure;

  constructor(category: Failure) {
    super(category);
    this.category = category;
  }
}

function bounded(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function sessionLimits({
  host,
  port,
  identity,
  ackDeadlineMs = 30_000,
  totalDeadlineMs = 600_000,
  maxAttempts = 5,
  connectionPolicy = "single-batch",
  now = () => performance.now(),
  signal,
}: SessionOptions) {
  if (
    (host !== "127.0.0.1" && host !== "::1") ||
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

export type SessionLimits = ReturnType<typeof sessionLimits>;
