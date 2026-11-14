import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildFleet, FairFleet } from "../../src/scenarios/fleet.ts";
import { Codec8Frame } from "../../src/wire/codec8.ts";
import { frame } from "../support/wire/codec8-fixture.ts";

const policy = {
  profile: "product" as const,
  maxConcurrent: 1,
  maxAttempts: 2,
  retryDelayMs: 100,
  maxQueuedBytes: 16777216,
};
const device = (i: number) => ({
  deviceId: `sim-${i}`,
  identity: `9${String(i).padStart(14, "0")}`,
  frames: [Codec8Frame.fromBytes(Buffer.from(frame, "hex"))],
});

test("round-robin leases preserve FIFO and free retry slots for healthy devices", () => {
  const a = device(1),
    b = device(2);
  a.frames.push(a.frames[0] as Codec8Frame);
  const fleet = new FairFleet([a, b], policy);
  const first = fleet.claim(0);
  assert(first);
  assert.equal(first.deviceId, a.deviceId);
  assert.equal(fleet.claim(0), undefined);
  fleet.settle(first, "retry", 1);
  const second = fleet.claim(2);
  assert(second);
  assert.equal(second.deviceId, b.deviceId);
  fleet.settle(second, "ack", 3);
  assert.equal(fleet.claim(50), undefined);
  assert.equal(fleet.readyAt, 101);
  const retry = fleet.claim(101);
  assert(retry);
  assert.equal(retry.attempt, 2);
  assert.deepEqual(retry.frame.snapshot().bytes, first.frame.snapshot().bytes);
  assert.throws(() => fleet.settle(first, "ack", 102), /invalid-fleet/);
  fleet.settle(retry, "ack", 102);
  const tail = fleet.claim(102);
  assert(tail);
  assert.equal(tail.attempt, 1);
  fleet.settle(tail, "ack", 103);
  assert.equal(fleet.done, true);
  assert.deepEqual(fleet.stats, {
    active: 0,
    queuedRecords: 0,
    queuedBytes: 0,
    exhaustedRecords: 0,
  });
});

test("profile, identity, per-device and aggregate admission limits fail closed", () => {
  const a = device(1);
  for (const input of [
    [a, a],
    [a, { ...device(2), identity: a.identity }],
    [],
    Array.from({ length: 101 }, (_, i) => device(i)),
  ])
    assert.throws(() => new FairFleet(input, policy), /invalid-fleet/);
  for (const override of [
    { maxConcurrent: 3 },
    { profile: "unknown" },
    { maxAttempts: 0 },
    { retryDelayMs: -1 },
    { maxQueuedBytes: 16777217 },
  ])
    assert.throws(
      () => new FairFleet([a], { ...policy, ...override } as typeof policy),
      /invalid-fleet/,
    );
  assert.throws(
    () =>
      new FairFleet([{ ...a, frames: Array(1001).fill(a.frames[0]) }], policy),
    /fleet-overflow/,
  );
  assert.throws(
    () => new FairFleet([a, device(2)], { ...policy, maxQueuedBytes: 64 }),
    /fleet-overflow/,
  );
  const peer = new FairFleet(
    Array.from({ length: 100 }, (_, i) => device(i)),
    { ...policy, profile: "reference-peer", maxConcurrent: 100 },
  );
  assert.equal(
    Array.from({ length: 100 }, () => peer.claim(0)).filter(Boolean).length,
    100,
  );
  assert.equal(peer.claim(0), undefined);
});

test("exhaustion retains evidence, cancellation releases leases and caller mutation cannot change frozen work", () => {
  const a = device(1);
  const fleet = new FairFleet([a], policy);
  a.frames.length = 0;
  const lease = fleet.claim(0);
  assert(lease);
  fleet.settle(lease, "cancel", 1);
  assert.equal(fleet.stats.active, 0);
  assert.equal(fleet.stats.queuedRecords, 1);
  const next = fleet.claim(1);
  assert(next);
  fleet.settle(next, "retry", 2);
  assert.equal(fleet.done, true);
  assert.equal(fleet.stats.exhaustedRecords, 1);
  assert.throws(() => fleet.claim(1), /invalid-fleet/);
});

test("device playback has independent seed/clock state and simulated loss never becomes queued work", () => {
  const route = {
    type: "LineString",
    coordinates: [
      [0, 0],
      [0.01, 0],
    ],
  };
  const scenario = {
    schemaVersion: 1,
    profile: "fmb920-docs-v1",
    seed: "base",
    startTimeMs: "1000000",
    clockOffsetMs: 0,
    driftPpm: 0,
    loop: false,
    phases: [
      {
        durationMs: 1000,
        speedMmPerSecond: 1000,
        ignition: true,
        gpsFix: true,
      },
    ],
  };
  const profile = JSON.parse(
    readFileSync("profiles/fmb920-docs-v1.json", "utf8"),
  );
  const members = [
    { ...device(1), seed: "one", clockOffsetMs: 0, driftPpm: 0 },
    { ...device(2), seed: "two", clockOffsetMs: 2000, driftPpm: 1000 },
  ].map(({ frames: _frames, ...m }) => m);
  const result = buildFleet(
    route,
    scenario,
    profile,
    members,
    1000,
    2,
    16777216,
  );
  assert.equal(result.captured, 4);
  assert.equal(result.simulatedLoss, 2);
  assert.equal(
    result.devices[0]?.frames[0]?.snapshot().bytes.readBigUInt64BE(10),
    1000000n,
  );
  assert.equal(
    result.devices[1]?.frames[0]?.snapshot().bytes.readBigUInt64BE(10),
    1002000n,
  );
  assert.deepEqual(
    buildFleet(route, scenario, profile, members, 1000, 2, 16777216),
    result,
  );
  const first = members[0];
  assert(first);
  assert.throws(
    () =>
      buildFleet(route, scenario, profile, [first, first], 1000, 0, 16777216),
    /invalid-fleet/,
  );
});

test("rejecting a forged lease cannot advance time or poison the valid outstanding head", () => {
  const fleet = new FairFleet([device(1)], policy);
  const lease = fleet.claim(0);
  assert(lease);
  assert.throws(
    () => fleet.settle({ ...lease }, "ack", 1000000),
    /invalid-fleet/,
  );
  assert.doesNotThrow(() => fleet.settle(lease, "ack", 1));
  assert.equal(fleet.done, true);
});
