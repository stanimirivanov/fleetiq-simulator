import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBounds } from "../src/qualification/fleet/fleet-bounds.mjs";

const report = {
  profile: "product",
  devices: 100,
  peakSessions: 2,
  peerPeakRequests: 2,
  acknowledgedRecords: 200,
  attempts: 200,
  peakQueuedBytes: 12000,
  peakRssBytes: 128 * 1024 * 1024,
  peakOpenFds: 30,
  baselineOpenFds: 20,
  openFdsAfter: 20,
  cpuUserUs: 1000,
  cpuSystemUs: 1000,
  wallMs: 100,
  cpuAffinityCount: 1,
  overflowRejected: true,
};
test("fleet resource gate rejects excess or unmeasured bounds instead of inferring scale", () => {
  assert.doesNotThrow(() => assertBounds(report));
  for (const override of [
    { peakSessions: 3 },
    { peerPeakRequests: 3 },
    { peakRssBytes: 257 * 1024 * 1024 },
    { peakQueuedBytes: 16777217 },
    { openFdsAfter: 100 },
    { peakOpenFds: 1000 },
    { cpuUserUs: 0, cpuSystemUs: 0 },
    { wallMs: 0 },
    { cpuAffinityCount: 2 },
    { overflowRejected: false },
    { devices: 99 },
    { acknowledgedRecords: 199 },
    { profile: "private-label" },
    { identity: "private-value" },
  ])
    assert.throws(
      () => assertBounds({ ...report, ...override }),
      /fleet-bounds-failed/,
    );
  const { peakRssBytes: _rss, ...missing } = report;
  assert.throws(() => assertBounds(missing), /fleet-bounds-failed/);
  assert.doesNotThrow(() =>
    assertBounds({
      ...report,
      profile: "reference-peer",
      peakSessions: 100,
      peerPeakRequests: 100,
      peakOpenFds: 220,
    }),
  );
});
