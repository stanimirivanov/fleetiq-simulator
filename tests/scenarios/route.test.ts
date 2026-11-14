import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createProfile, ProfileError } from "../../src/scenarios/profile.ts";
import { createPlayback, ScenarioError } from "../../src/scenarios/route.ts";
import { encodeCodec8e } from "../../src/wire/codec8e.ts";

const profile = JSON.parse(
  readFileSync("profiles/fmb920-docs-v1.json", "utf8"),
);
const route = {
  type: "LineString",
  coordinates: [
    [-0.001, 0],
    [0.001, 0],
  ],
};
const scenario = {
  schemaVersion: 1,
  profile: "fmb920-docs-v1",
  seed: "a",
  startTimeMs: "1000000",
  clockOffsetMs: -100,
  driftPpm: 1000,
  loop: false,
  phases: [
    {
      durationMs: 400000,
      speedMmPerSecond: 1000,
      ignition: true,
      gpsFix: true,
    },
  ],
};

test("equatorial goldens preserve signed e7 coordinates, raw IO and exact event-time drift", () => {
  const playback = createPlayback(route, scenario, profile);
  assert.equal(playback.durationMs, 400000);
  const first = playback.sample(0);
  assert.deepEqual(
    [
      first.longitudeE7,
      first.latitudeE7,
      first.speed,
      first.angle,
      first.satellites,
    ],
    [-10000, 0, 4, 90, 8],
  );
  assert.equal(first.timestampMs, "999900");
  assert.deepEqual(first.io, [
    { id: 239, hex: "01" },
    { id: 240, hex: "01" },
    { id: 21, hex: "04" },
    { id: 66, hex: "2ee0" },
    { id: 67, hex: "0fa0" },
    { id: 16, hex: "00000000" },
    { id: 12, hex: "00000000" },
  ]);
  const second = playback.sample(100000);
  // Independently: 100m / (6371008.8m * pi/180), starting at -0.001 degrees.
  assert.equal(second.longitudeE7, -1007);
  assert.equal(second.timestampMs, "1100000");
  assert.equal(second.io.find(({ id }) => id === 16)?.hex, "00000064");
  assert.equal(second.io.find(({ id }) => id === 12)?.hex, "00000008");
  assert.doesNotThrow(() => encodeCodec8e(second));
  const end = playback.sample(300000);
  assert.deepEqual([end.longitudeE7, end.speed, end.angle], [10000, 0, 0]);
  assert.equal(end.io.find(({ id }) => id === 240)?.hex, "00");
  assert.deepEqual(
    createPlayback(route, scenario, profile).sample(100000),
    second,
  );
});

test("stops, ignition transitions, GPS loss and recovery use updated state without position jitter", () => {
  const value = {
    ...scenario,
    phases: [
      {
        durationMs: 100000,
        speedMmPerSecond: 1000,
        ignition: true,
        gpsFix: true,
      },
      {
        durationMs: 100000,
        speedMmPerSecond: 0,
        ignition: false,
        gpsFix: true,
      },
      {
        durationMs: 100000,
        speedMmPerSecond: 1000,
        ignition: true,
        gpsFix: false,
      },
      {
        durationMs: 100000,
        speedMmPerSecond: 1000,
        ignition: true,
        gpsFix: true,
      },
    ],
  };
  const playback = createPlayback(route, value, profile);
  const before = playback.sample(90000);
  const stopped = playback.sample(100000);
  assert.equal(stopped.longitudeE7, -1007);
  assert.deepEqual([stopped.speed, stopped.angle], [0, 0]);
  assert.equal(stopped.io[0]?.hex, "00");
  assert.equal(playback.sample(190000).longitudeE7, stopped.longitudeE7);
  const lost = playback.sample(250000);
  assert.deepEqual(
    [
      lost.longitudeE7,
      lost.latitudeE7,
      lost.speed,
      lost.angle,
      lost.satellites,
    ],
    [stopped.longitudeE7, 0, 0, 0, 0],
  );
  assert.equal(lost.io[1]?.hex, "01");
  assert.equal(playback.sample(300000).longitudeE7, 7986);
  assert.notEqual(before.longitudeE7, stopped.longitudeE7);
  assert.throws(() => playback.sample(0), ScenarioError);
  const noFix = createPlayback(
    route,
    { ...scenario, phases: [{ ...scenario.phases[0], gpsFix: false }] },
    profile,
  ).sample(100000);
  assert.deepEqual(
    [noFix.longitudeE7, noFix.latitudeE7, noFix.satellites],
    [0, 0, 0],
  );
});

test("malformed geometry, unsafe numeric/time input and altered model widths fail closed", () => {
  for (const geometry of [
    null,
    { type: "Point", coordinates: [0, 0] },
    {
      ...route,
      coordinates: [
        [0, 0],
        [0, 0],
      ],
    },
    {
      ...route,
      coordinates: [
        [179, 0],
        [-179, 0],
      ],
    },
    {
      ...route,
      coordinates: [
        [0, 0],
        [180, 0],
      ],
    },
    {
      ...route,
      coordinates: [
        [0, 91],
        [1, 0],
      ],
    },
    {
      ...route,
      coordinates: [
        [0, 0, 1],
        [1, 0],
      ],
    },
    {
      ...route,
      coordinates: [
        [NaN, 0],
        [1, 0],
      ],
    },
    { ...route, coordinates: Array.from({ length: 100001 }, () => [0, 0]) },
  ])
    assert.throws(
      () => createPlayback(geometry, scenario, profile),
      ScenarioError,
    );
  for (const patch of [
    { seed: "" },
    { startTimeMs: "01" },
    { startTimeMs: "0" },
    { startTimeMs: "18446744073709551615" },
    { driftPpm: 1001 },
    { clockOffsetMs: Number.MAX_SAFE_INTEGER + 1 },
    { phases: [{ ...scenario.phases[0], speedMmPerSecond: 1.5 }] },
    { phases: [{ ...scenario.phases[0], durationMs: 604800001 }] },
    { extra: true },
  ])
    assert.throws(
      () => createPlayback(route, { ...scenario, ...patch }, profile),
      ScenarioError,
    );
  const playback = createPlayback(route, scenario, profile);
  for (const time of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 400001])
    assert.throws(() => playback.sample(time), ScenarioError);
  const changed = structuredClone(profile);
  changed.io.ignition.width = 8;
  assert.throws(
    () => createPlayback(route, scenario, changed),
    /invalid-profile/,
  );
});

test("endpoint stopping caps odometer and timestamp validation checks the unshifted start", () => {
  const stopped = createPlayback(route, scenario, profile).sample(400000);
  assert.equal(stopped.io.find(({ id }) => id === 16)?.hex, "000000de");
  assert.throws(
    () =>
      createPlayback(
        route,
        {
          ...scenario,
          startTimeMs: "18446744073709551616",
          phases: [{ ...scenario.phases[0], durationMs: 1 }],
        },
        profile,
      ),
    ScenarioError,
  );
});

test("multiple segments and explicit looping use geodesic distance and copied inputs", () => {
  const geometry = {
    type: "LineString",
    coordinates: [
      [0, -0.001],
      [0, 0],
      [0.001, 0],
    ],
  };
  const value = {
    ...structuredClone(scenario),
    loop: true,
    driftPpm: -1000,
    startTimeMs: "18446744073700000000",
  };
  const playback = createPlayback(geometry, value, profile);
  geometry.coordinates[1] = [90, 90];
  value.phases[0] = {
    durationMs: 1,
    speedMmPerSecond: 0,
    ignition: false,
    gpsFix: false,
  };
  const north = playback.sample(100000);
  assert.deepEqual(
    [north.longitudeE7, north.latitudeE7, north.angle],
    [0, -1007, 0],
  );
  assert.equal(north.timestampMs, "18446744073700099800");
  const east = playback.sample(200000);
  assert.deepEqual(
    [east.longitudeE7, east.latitudeE7, east.angle],
    [7986, 0, 90],
  );
  const loop = playback.sample(300000);
  assert.deepEqual([loop.longitudeE7, loop.latitudeE7], [0, -3020]);
  assert.equal(loop.io.find(({ id }) => id === 16)?.hex, "0000012c");
  assert.deepEqual(playback.sample(300000), loop);
  const other = createPlayback(
    route,
    { ...scenario, seed: "c" },
    profile,
  ).sample(0);
  assert.notEqual(other.io[2]?.hex, "04");
});

test("profile value failures are typed and reject fractional raw values", () => {
  const io = createProfile(profile);
  for (const state of [
    { ignition: true, moving: true, distanceMicrometers: 0n, strength: 0.5 },
    { ignition: true, moving: true, distanceMicrometers: -1n, strength: 3 },
    {
      ignition: true,
      moving: true,
      distanceMicrometers: 2147483648n * 1000000n,
      strength: 3,
    },
  ])
    assert.throws(() => io(state), ProfileError);
});
