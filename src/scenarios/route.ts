import { Ajv2020 } from "ajv/dist/2020.js";
import type { Record8E } from "../wire/codec8e.ts";
import { createProfile } from "./profile.ts";

/** Two-dimensional WGS84 GeoJSON geometry; only bare LineString is supported. */
type Route = { type: "LineString"; coordinates: [number, number][] };

/** Transitions take effect at phase start; speed is integer millimetres per virtual second. */
type Phase = {
  durationMs: number;
  speedMmPerSecond: number;
  ignition: boolean;
  gpsFix: boolean;
};

/** Versioned deterministic device state, independent of capture scheduling and ACK time. */
type Scenario = {
  schemaVersion: 1;
  profile: "fmb920-docs-v1";
  seed: string;
  startTimeMs: string;
  clockOffsetMs: number;
  driftPpm: number;
  loop: boolean;
  phases: Phase[];
};
const integer = (minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
});
const day = 86400000;
const validRoute = new Ajv2020({ ownProperties: true }).compile<Route>({
  type: "object",
  additionalProperties: false,
  required: ["type", "coordinates"],
  properties: {
    type: { const: "LineString" },
    coordinates: {
      type: "array",
      minItems: 2,
      maxItems: 100000,
      items: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        prefixItems: [
          { type: "number", minimum: -180, maximum: 180 },
          { type: "number", minimum: -90, maximum: 90 },
        ],
        items: false,
      },
    },
  },
});
const validScenario = new Ajv2020({ ownProperties: true }).compile<Scenario>({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "profile",
    "seed",
    "startTimeMs",
    "clockOffsetMs",
    "driftPpm",
    "loop",
    "phases",
  ],
  properties: {
    schemaVersion: { const: 1 },
    profile: { const: "fmb920-docs-v1" },
    seed: {
      type: "string",
      maxLength: 64,
      pattern: "^[a-zA-Z0-9_-]+(?![\\s\\S])",
    },
    startTimeMs: {
      type: "string",
      maxLength: 20,
      pattern: "^(?:0|[1-9][0-9]*)(?![\\s\\S])",
    },
    clockOffsetMs: integer(-day, day),
    driftPpm: integer(-1000, 1000),
    loop: { type: "boolean" },
    phases: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["durationMs", "speedMmPerSecond", "ignition", "gpsFix"],
        properties: {
          durationMs: integer(1, 7 * day),
          speedMmPerSecond: integer(0, 1000000),
          ignition: { type: "boolean" },
          gpsFix: { type: "boolean" },
        },
      },
    },
  },
});
const radians = Math.PI / 180;
const radius = 6371008.8;

/** A scenario failed validation or sampling order; private routes/config values stay out of errors. */
export class ScenarioError extends Error {
  constructor() {
    super("invalid-scenario");
  }
}

/** Converts longitude/latitude to a unit vector for shortest-arc spherical interpolation. */
function vector([lon, lat]: [number, number]) {
  return [
    Math.cos(lat * radians) * Math.cos(lon * radians),
    Math.cos(lat * radians) * Math.sin(lon * radians),
    Math.sin(lat * radians),
  ] as const;
}

/**
 * Snapshots validated segments using atan2(cross,dot), stable for short arcs.
 * Rejects coincident/near-antipodal points and antimeridian crossings rather than
 * silently selecting a path. GeoJSON supplies geometry; this sphere models motion.
 */
function segments(route: Route) {
  let total = 0;
  return route.coordinates.slice(1).map((end, index) => {
    const start = route.coordinates[index];
    if (!start) throw new ScenarioError();
    const a = vector(start),
      b = vector(end);
    const cross = Math.hypot(
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    );
    const angle = Math.atan2(cross, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
    if (
      Math.abs(end[0] - start[0]) > 180 ||
      angle < 1e-12 ||
      Math.PI - angle < 1e-12
    )
      throw new ScenarioError();
    total += angle * radius;
    return { a, b, angle, total };
  });
}

/**
 * Creates an owned virtual playback cursor; no files, clocks, sockets or ambient randomness.
 * Samples must be safe integer milliseconds in nondecreasing order within durationMs.
 * Slerp uses the 6371008.8m mean-radius sphere and rounds coordinates once to e7.
 * Device timestamps use exact bigint offset/drift (fractional milliseconds truncate
 * toward zero); this clock never controls transport deadlines. GPS loss holds the
 * last sampled fix, or zeros before any fix. Returns ordinary Codec 8E record inputs.
 */
export function createPlayback(
  route: unknown,
  scenario: unknown,
  profile: unknown,
) {
  if (!validRoute(route) || !validScenario(scenario)) throw new ScenarioError();
  const path = segments(route);
  const last = path.at(-1);
  if (!last) throw new ScenarioError();
  const routeLength = last.total;
  const routeMicrometers = BigInt(Math.floor(routeLength * 1000000));
  const phases = scenario.phases.map((phase) => ({ ...phase }));
  const durationMs = phases.reduce((sum, phase) => sum + phase.durationMs, 0);
  const epoch = BigInt(scenario.startTimeMs);
  const start = epoch + BigInt(scenario.clockOffsetMs);
  const drift = BigInt(scenario.driftPpm);
  if (
    epoch > (1n << 64n) - 1n ||
    durationMs > 7 * day ||
    start < 0n ||
    start + BigInt(durationMs) + (BigInt(durationMs) * drift) / 1000000n >
      (1n << 64n) - 1n
  )
    throw new ScenarioError();
  const io = createProfile(profile);
  const loop = scenario.loop;
  let seed = 2166136261;
  for (const char of scenario.seed)
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  let previous = -1;
  let fix = { longitudeE7: 0, latitudeE7: 0 };

  /** Applies transitions before sampling, retaining only sample time and last valid fix. */
  function sample(elapsedMs: number): Record8E {
    if (
      !Number.isSafeInteger(elapsedMs) ||
      elapsedMs < previous ||
      elapsedMs > durationMs ||
      elapsedMs < 0
    )
      throw new ScenarioError();
    let remaining = elapsedMs;
    let travelled = 0n;
    let active = phases[0];
    for (const phase of phases) {
      active = phase;
      const duration = Math.min(remaining, phase.durationMs);
      travelled += BigInt(duration) * BigInt(phase.speedMmPerSecond);
      if (remaining < phase.durationMs) break;
      remaining -= phase.durationMs;
    }
    if (!active) throw new ScenarioError();
    let distance = Number(travelled) / 1000000;
    const moving =
      active.speedMmPerSecond > 0 && (loop || distance < routeLength);
    distance = loop ? distance % routeLength : Math.min(distance, routeLength);
    let low = 0,
      high = path.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const segment = path[mid];
      if (!segment) throw new ScenarioError();
      if (distance >= segment.total) low = mid + 1;
      else high = mid;
    }
    const segment = path[low];
    if (!segment) throw new ScenarioError();
    const before = path[low - 1]?.total ?? 0;
    const fraction = (distance - before) / (segment.total - before);
    const left =
      Math.sin((1 - fraction) * segment.angle) / Math.sin(segment.angle);
    const right = Math.sin(fraction * segment.angle) / Math.sin(segment.angle);
    const [x, y, z] = segment.a.map(
      (value, index) => left * value + right * (segment.b[index] ?? 0),
    ) as [number, number, number];
    const lon = Math.atan2(y, x),
      lat = Math.atan2(z, Math.hypot(x, y));
    const endLon = Math.atan2(segment.b[1], segment.b[0]),
      endLat = Math.atan2(segment.b[2], Math.hypot(segment.b[0], segment.b[1]));
    const bearing = Math.atan2(
      Math.sin(endLon - lon) * Math.cos(endLat),
      Math.cos(lat) * Math.sin(endLat) -
        Math.sin(lat) * Math.cos(endLat) * Math.cos(endLon - lon),
    );
    if (active.gpsFix)
      fix = {
        longitudeE7: Math.round((lon / radians) * 1e7) || 0,
        latitudeE7: Math.round((lat / radians) * 1e7) || 0,
      };
    const odometerDistance =
      !loop && travelled > routeMicrometers ? routeMicrometers : travelled;
    previous = elapsedMs;
    return {
      schemaVersion: 1,
      timestampMs: String(
        start + BigInt(elapsedMs) + (BigInt(elapsedMs) * drift) / 1000000n,
      ),
      priority: 0,
      ...fix,
      altitude: 0,
      angle:
        active.gpsFix && moving
          ? Math.round((bearing / radians + 360) % 360) % 360
          : 0,
      satellites: active.gpsFix ? 8 : 0,
      speed:
        active.gpsFix && moving
          ? Math.round(active.speedMmPerSecond * 0.0036)
          : 0,
      eventId: 0,
      io: io({
        ignition: active.ignition,
        moving,
        distanceMicrometers: odometerDistance,
        strength: 3 + (((seed ^ (elapsedMs % 4294967296)) >>> 0) % 3),
      }),
      variableIo: [],
    };
  }
  return Object.freeze({ durationMs, sample });
}
