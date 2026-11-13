import assert from "node:assert/strict";
import { test } from "node:test";
import { FleetMetrics } from "../src/telemetry.ts";

const resource = {
  rssBytes: 1000,
  openFds: 10,
  cpuUserUs: 100,
  cpuSystemUs: 20,
};
test("fleet metrics have fixed cardinality, exact accounting and detached snapshots", () => {
  const m = new FleetMetrics(5, 1, resource);
  m.queue(4, 256, 2);
  m.attempt(false);
  m.failure("ack-timeout");
  m.attempt(true);
  m.ack(1, 25);
  m.sample({
    ...resource,
    rssBytes: 2000,
    openFds: 12,
    cpuUserUs: 140,
    cpuSystemUs: 25,
  });
  m.queue(3, 192, 0);
  const out = m.snapshot();
  assert.equal(out.capturedRecords, 5);
  assert.equal(out.simulatedLossRecords, 1);
  assert.equal(out.acknowledgedRecords, 1);
  assert.equal(out.attempts, 2);
  assert.equal(out.retryAttempts, 1);
  assert.equal(out.sessionFailures["ack-timeout"], 1);
  assert.equal(out.peakQueuedBytes, 256);
  assert.equal(out.peakSessions, 2);
  assert.equal(out.peakRssBytes, 2000);
  assert.equal(out.cpuUserUs, 40);
  assert.equal(out.cpuSystemUs, 5);
  assert.equal(
    out.ackLatencyMs.counts.reduce((a, b) => a + b, 0),
    1,
  );
  out.ackLatencyMs.counts.fill(999);
  out.sessionFailures["ack-timeout"] = 99;
  assert.equal(m.snapshot().sessionFailures["ack-timeout"], 1);
  assert.equal(Object.keys(m.snapshot().sessionFailures).length, 6);
});

test("metrics reject arbitrary private labels and invalid values rather than silently emitting them", () => {
  const m = new FleetMetrics(0, 0, resource);
  assert.throws(() => m.failure("private-identity"), /invalid-metrics/);
  assert.throws(() => m.ack(1, NaN), /invalid-metrics/);
  assert.throws(() => m.queue(-1, 0, 0), /invalid-metrics/);
  assert.throws(
    () => m.sample({ ...resource, cpuUserUs: 1 }),
    /invalid-metrics/,
  );
  assert.equal(
    JSON.stringify(m.snapshot()).includes("private-identity"),
    false,
  );
});

test("resource samples reject missing fields instead of emitting NaN and null measurements", () => {
  const m = new FleetMetrics(2, 0, resource);
  const { rssBytes: _rss, ...missing } = resource;
  assert.throws(() => m.sample(missing as typeof resource), /invalid-metrics/);
});
