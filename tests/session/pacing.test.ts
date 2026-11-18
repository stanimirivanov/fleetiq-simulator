import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlaybackPacer } from "../../src/session/pacing.ts";
import { SessionError, sessionLimits } from "../../src/session/state.ts";

function clock(start = 0, duration = 1000) {
  let now = start;
  const controller = new AbortController();
  const waits: number[] = [];
  const limits = sessionLimits({
    host: "127.0.0.1",
    port: 1,
    identity: "0".repeat(15),
    now: () => now,
    totalDeadlineMs: duration,
    signal: controller.signal,
  });
  const wait = async (ms: number) => {
    waits.push(ms);
    now += ms;
  };
  return {
    limits,
    wait,
    waits,
    controller,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("real-time pacing waits for virtual intervals using monotonic elapsed time only", async () => {
  const time = clock(100000);
  const pacer = createPlaybackPacer(0, time.limits, time.wait);
  await pacer.waitUntil(125);
  assert.equal(
    time.waits.reduce((sum, ms) => sum + ms, 0),
    125,
  );
  assert.ok(time.waits.every((ms) => ms > 0 && ms <= 50));
  time.advance(100);
  await pacer.waitUntil(200);
  assert.equal(
    time.waits.reduce((sum, ms) => sum + ms, 0),
    125,
  );
  await pacer.waitUntil(250);
  assert.equal(
    time.waits.reduce((sum, ms) => sum + ms, 0),
    150,
  );
});

test("resumed pacing rebases to the retained virtual cursor without replaying downtime", async () => {
  const time = clock(900000);
  const pacer = createPlaybackPacer(600000, time.limits, time.wait);
  await pacer.waitUntil(600000);
  assert.deepEqual(time.waits, []);
  await pacer.waitUntil(600100);
  assert.equal(
    time.waits.reduce((sum, ms) => sum + ms, 0),
    100,
  );
});

test("pacing checks deadline and cancellation while waiting without a success tick", async () => {
  const time = clock(0, 75);
  const pacer = createPlaybackPacer(0, time.limits, time.wait);
  await assert.rejects(pacer.waitUntil(100), { category: "run-timeout" });
  assert.equal(
    time.waits.reduce((sum, ms) => sum + ms, 0),
    75,
  );
  const cancelled = clock();
  const waiting = createPlaybackPacer(0, cancelled.limits, async (ms) => {
    await cancelled.wait(ms);
    cancelled.controller.abort();
  });
  await assert.rejects(waiting.waitUntil(500), { category: "cancelled" });
  assert.deepEqual(cancelled.waits, [50]);
});

test("pacing rejects invalid virtual times and backwards monotonic clocks", async () => {
  for (const value of [-1, 0.5, NaN, Infinity, 604800001]) {
    const time = clock();
    assert.throws(
      () => createPlaybackPacer(value, time.limits, time.wait),
      SessionError,
    );
    const pacer = createPlaybackPacer(0, time.limits, time.wait);
    await assert.rejects(pacer.waitUntil(value), SessionError);
  }
  const time = clock(100);
  const pacer = createPlaybackPacer(1000, time.limits, time.wait);
  await assert.rejects(pacer.waitUntil(999), SessionError);
  time.advance(-1);
  await assert.rejects(pacer.waitUntil(1000), SessionError);
});
