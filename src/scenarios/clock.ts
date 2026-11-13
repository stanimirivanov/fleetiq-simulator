import { ScenarioError } from "./route.ts";

/**
 * Maps caller-supplied monotonic elapsed milliseconds to bounded virtual time.
 * Scale 1 is real-time; 2–1000 is explicitly accelerated simulation. Device event
 * timestamps and drift are not inputs. No timers or transport deadlines are owned here.
 */
export function createClock(scale: number) {
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 1000)
    throw new ScenarioError();
  let previous = 0;
  return (elapsedMs: number) => {
    if (
      !Number.isSafeInteger(elapsedMs) ||
      elapsedMs < previous ||
      elapsedMs * scale > 604800000
    )
      throw new ScenarioError();
    previous = elapsedMs;
    return elapsedMs * scale;
  };
}
