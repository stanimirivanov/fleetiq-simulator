import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { capture } from "../../src/scenarios/capture.ts";
import { createClock } from "../../src/scenarios/clock.ts";
import { createPlayback, ScenarioError } from "../../src/scenarios/route.ts";
import { BatchQueue } from "../../src/session/batches.ts";
import { sessionLimits } from "../../src/session/state.ts";
import { encodeCodec8e } from "../../src/wire/codec8e.ts";

const profile = JSON.parse(
  readFileSync("profiles/fmb920-docs-v1.json", "utf8"),
);
const scenario = {
  schemaVersion: 1,
  profile: "fmb920-docs-v1",
  seed: "capture",
  startTimeMs: "1000000",
  clockOffsetMs: -100,
  driftPpm: 1000,
  loop: false,
  phases: [
    { durationMs: 1000, speedMmPerSecond: 1000, ignition: true, gpsFix: true },
    { durationMs: 1000, speedMmPerSecond: 0, ignition: false, gpsFix: true },
    { durationMs: 1000, speedMmPerSecond: 1000, ignition: true, gpsFix: false },
  ],
};
const route = {
  type: "LineString",
  coordinates: [
    [0, 0],
    [0.01, 0],
  ],
};
const options = {
  intervalMs: 1000,
  sendIntervalMs: 1500,
  on: ["stop", "ignition", "movement"],
};

test("events retain declared order before periodic captures and independent send ticks", () => {
  const playback = createPlayback(route, scenario, profile);
  const ticks = [...capture(playback, options)];
  assert.deepEqual(
    ticks.map((t) => [t.atMs, t.type === "send" ? "send" : t.reason]),
    [
      [0, "periodic"],
      [1000, "stop"],
      [1000, "ignition"],
      [1000, "periodic"],
      [1500, "send"],
      [2000, "ignition"],
      [2000, "movement"],
      [2000, "periodic"],
      [3000, "periodic"],
      [3000, "send"],
    ],
  );
  const records = ticks
    .filter((t) => t.type === "capture")
    .map((t) => t.record);
  assert.deepEqual(
    records.slice(1, 4).map((r) => [r.eventId, r.priority, r.io[0]?.hex]),
    [
      [240, 0, "00"],
      [239, 0, "00"],
      [0, 0, "00"],
    ],
  );
  assert.equal(records[1]?.timestampMs, "1000901");
  assert.equal(records.at(-1)?.satellites, 0);
});

test("physical endpoint stop is captured between periodic samples, without a GPS-loss false stop", () => {
  const playback = createPlayback(
    {
      ...route,
      coordinates: [
        [0, 0],
        [0.00001, 0],
      ],
    },
    scenario,
    profile,
  );
  const ticks = [...capture(playback, { ...options, intervalMs: 3000 })];
  assert.deepEqual(
    ticks
      .filter((t) => t.type === "capture" && t.reason === "stop")
      .map((t) => t.atMs),
    [1000, 2112],
  );
  assert.throws(
    () => [
      ...capture(createPlayback(route, scenario, profile), {
        ...options,
        intervalMs: 1,
      }),
    ],
    ScenarioError,
  );
  for (const patch of [
    { intervalMs: 0 },
    { sendIntervalMs: 1 },
    { on: ["stop", "stop"] },
    { on: ["unknown"] },
    { extra: true },
  ])
    assert.throws(
      () => [
        ...capture(createPlayback(route, scenario, profile), {
          ...options,
          ...patch,
        }),
      ],
      ScenarioError,
    );
});

test("accelerated clock maps monotonic elapsed only; invalid/backward/unsafe time fails", () => {
  const clock = createClock(10);
  assert.equal(clock(0), 0);
  assert.equal(clock(15), 150);
  assert.equal(clock(15), 150);
  for (const time of [14, 1.5, Number.MAX_SAFE_INTEGER, Infinity])
    assert.throws(() => clock(time), ScenarioError);
  for (const scale of [0, 1.5, 1001])
    assert.throws(() => createClock(scale), ScenarioError);
});

test("all event and periodic records reach FIFO batches on send cadence without loss", () => {
  const queue = new BatchQueue({
    maxRecords: 2,
    maxFrameBytes: 1280,
    maxQueuedRecords: 1000,
    maxQueuedBytes: 16777216,
  });
  const captured: Buffer[] = [],
    sent: Buffer[] = [];
  const times: number[] = [];
  for (const tick of capture(
    createPlayback(route, scenario, profile),
    options,
  )) {
    if (tick.type === "capture") {
      captured.push(encodeCodec8e(tick.record).subarray(10, -5));
      queue.enqueue(tick.record);
    } else {
      let batch = queue.peek();
      while (batch) {
        times.push(tick.atMs);
        sent.push(batch.snapshot().bytes.subarray(10, -5));
        queue.acknowledge(batch);
        batch = queue.peek();
      }
    }
  }
  assert.equal(captured.length, 8);
  assert.deepEqual(Buffer.concat(sent), Buffer.concat(captured));
  assert.deepEqual(times, [1500, 1500, 3000, 3000]);
  assert.equal(queue.length, 0);
});

test("accelerated/drifting event time leaves the injected monotonic ACK budget unchanged", () => {
  let monotonic = 0;
  const limits = sessionLimits({
    host: "127.0.0.1",
    port: 55027,
    identity: "3".repeat(15),
    now: () => monotonic,
    totalDeadlineMs: 1000,
    ackDeadlineMs: 100,
  });
  const virtual = createClock(1000);
  monotonic = 1;
  const record = createPlayback(route, scenario, profile).sample(
    virtual(monotonic),
  );
  assert.equal(record.timestampMs, "1000901");
  assert.equal(limits.remaining(), 999);
  assert.equal(limits.ackDeadlineMs, 100);
  monotonic = 1000;
  assert.throws(() => limits.remaining(), /run-timeout/);
});
