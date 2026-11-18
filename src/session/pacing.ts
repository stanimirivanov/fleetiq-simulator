import { SessionError, type SessionLimits } from "./state.ts";

/** Checks the same bounded virtual-time domain as the deterministic capture schedule. */
function virtualTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 604800000;
}

/**
 * Paces a retained virtual cursor from a fresh monotonic origin. Downtime does
 * not advance virtual time; overdue ticks catch up without extra delay. The
 * caller owns the timer and run budget, so this policy performs no ambient IO.
 * Each requested sleep is capped at 50 ms; scheduler latency may delay wakeups.
 */
export function createPlaybackPacer(
  virtualStartMs: number,
  limits: Pick<SessionLimits, "now" | "remaining">,
  sleep: (milliseconds: number) => Promise<void>,
): { waitUntil: (atMs: number) => Promise<void> } {
  if (!virtualTime(virtualStartMs)) throw new SessionError("invalid-session");
  const origin = limits.now();
  if (!Number.isFinite(origin)) throw new SessionError("invalid-session");
  let lastClock = origin;
  let lastTick = virtualStartMs;

  /** Waits before advancing a tick; invalid clocks and exhausted budgets never release it. */
  async function waitUntil(atMs: number): Promise<void> {
    if (!virtualTime(atMs) || atMs < lastTick)
      throw new SessionError("invalid-session");
    while (true) {
      const remaining = limits.remaining();
      const now = limits.now();
      if (!Number.isFinite(now) || now < lastClock)
        throw new SessionError("invalid-session");
      lastClock = now;
      const delay = atMs - virtualStartMs - (now - origin);
      if (delay <= 0) {
        lastTick = atMs;
        return;
      }
      await sleep(Math.min(delay, remaining, 50));
    }
  }
  return { waitUntil };
}
