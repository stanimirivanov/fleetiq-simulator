import { Ajv2020 } from "ajv/dist/2020.js";
import type { Record8E } from "../wire/codec8e.ts";
import { profileEvents } from "./profile.ts";
import { type createPlayback, ScenarioError } from "./route.ts";

/** Triggers refer to documented IO: ignition 239, movement start/stop 240. */
type Trigger = keyof typeof profileEvents;

/** Independent virtual capture/send cadence; on determines same-time event order. */
type Options = { intervalMs: number; sendIntervalMs: number; on: Trigger[] };

/** Captures precede a same-time send tick; only capture ticks own new record inputs. */
export type CaptureTick =
  | { atMs: number; type: "send" }
  | {
      atMs: number;
      type: "capture";
      reason: Trigger | "periodic";
      record: Record8E;
    };
const period = { type: "integer", minimum: 1, maximum: 604800000 };
const valid = new Ajv2020({ ownProperties: true }).compile<Options>({
  type: "object",
  additionalProperties: false,
  required: ["intervalMs", "sendIntervalMs", "on"],
  properties: {
    intervalMs: period,
    sendIntervalMs: period,
    on: {
      type: "array",
      maxItems: 3,
      uniqueItems: true,
      items: { enum: Object.keys(profileEvents) },
    },
  },
});

/**
 * Produces bounded virtual-time capture/send ticks for a fresh playback cursor.
 * Apply updated route state, then each configured event, then periodic capture,
 * then send. Never coalesces equal-time captures. Preflights at most 1000 records
 * and 1000 send ticks before sampling; consumption is single-use and does no IO.
 */
export function* capture(
  playback: ReturnType<typeof createPlayback>,
  options: unknown,
): Generator<CaptureTick> {
  if (!valid(options)) throw new ScenarioError();
  const { intervalMs, sendIntervalMs, on } = options;
  const duration = playback.durationMs;
  const captures: { atMs: number; reason: Trigger | "periodic" }[] = [];
  if (
    Math.floor(duration / intervalMs) + 1 > 1000 ||
    Math.ceil(duration / sendIntervalMs) > 1000
  )
    throw new ScenarioError();
  let previous = playback.transitions[0];
  for (const transition of playback.transitions.slice(1)) {
    for (const reason of on) {
      const changed =
        reason === "ignition"
          ? previous?.ignition !== transition.ignition
          : previous?.moving !== transition.moving &&
            (reason === "movement" ? transition.moving : !transition.moving);
      if (changed) captures.push({ atMs: transition.atMs, reason });
    }
    previous = transition;
  }
  for (let atMs = 0; atMs <= duration; atMs += intervalMs)
    captures.push({ atMs, reason: "periodic" });
  if (captures.length > 1000) throw new ScenarioError();

  // Stable sort preserves configured event order; periodic entries were added last.
  captures.sort((a, b) => a.atMs - b.atMs);
  let index = 0;
  for (let sendAt = sendIntervalMs; ; sendAt += sendIntervalMs) {
    const atMs = Math.min(sendAt, duration);
    while (index < captures.length) {
      const next = captures[index];
      if (!next || next.atMs > atMs) break;
      const record = playback.sample(next.atMs);
      if (next.reason !== "periodic") {
        Object.assign(record, profileEvents[next.reason]);
      }
      yield { type: "capture", ...next, record };
      index++;
    }
    yield { type: "send", atMs };
    if (atMs === duration) break;
  }
}
