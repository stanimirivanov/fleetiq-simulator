import assert from "node:assert/strict";
import { test } from "node:test";
import { runFleet } from "../../src/transport/fleet.ts";
import { Codec8Frame } from "../../src/wire/codec8.ts";
import { ack, reader, withPeer } from "../support/peers/peer.ts";
import { frame } from "../support/wire/codec8-fixture.ts";

const bytes = Buffer.from(frame, "hex");
const device = (n: number) => ({
  deviceId: `member-${n}`,
  identity: `8${String(n).padStart(14, "0")}`,
  frames: [Codec8Frame.fromBytes(bytes)],
});
const policy = {
  profile: "product" as const,
  maxConcurrent: 1,
  maxAttempts: 2,
  retryDelayMs: 50,
  maxQueuedBytes: 16777216,
};
const probe = () => ({
  rssBytes: process.resourceUsage().maxRSS * 1024,
  openFds: 0,
  cpuUserUs: process.cpuUsage().user,
  cpuSystemUs: process.cpuUsage().system,
});
const options = (port: number) => ({
  host: "127.0.0.1",
  port,
  ackDeadlineMs: 500,
  totalDeadlineMs: 3000,
});

test("real fleet retries release closed slots and healthy members run before a failed head retries", {
  timeout: 5000,
}, async () => {
  const devices = [device(1), device(2), device(3)];
  const order: string[] = [];
  let active = 0,
    peak = 0;
  await withPeer(
    async (socket) => {
      active++;
      peak = Math.max(peak, active);
      // Count requests awaiting a protocol response; remote close callbacks may lag a retired client scope.
      const read = reader(socket);
      assert.deepEqual(await read(2), Buffer.from([0, 15]));
      const identity = (await read(15)).toString();
      order.push(identity);
      if (order.length === 1) {
        active--;
        socket.end();
        return;
      }
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(bytes.length), bytes);
      active--;
      socket.end(ack);
    },
    async (port) => {
      const result = await runFleet(
        { devices, captured: 3, simulatedLoss: 0 },
        policy,
        options(port),
        probe,
      );
      assert.equal(result.status, "fleet-completed");
      assert.equal(result.metrics.acknowledgedRecords, 3);
      assert.equal(result.metrics.attempts, 4);
      assert.equal(result.metrics.retryAttempts, 1);
      assert.equal(result.metrics.sessionFailures["connection-closed"], 1);
      assert.equal(result.metrics.undeliveredRecords, 0);
      assert.equal(peak, 1);
      assert.equal(result.metrics.peakSessions, 1);
      assert.deepEqual(order, [
        devices[0]?.identity,
        devices[1]?.identity,
        devices[2]?.identity,
        devices[0]?.identity,
      ]);
      const text = JSON.stringify(result);
      for (const d of devices) {
        assert.equal(text.includes(d.identity), false);
        assert.equal(text.includes(d.deviceId), false);
      }
    },
  );
});

test("fleet exhaustion preserves queued records while cancellation closes every in-flight socket", {
  timeout: 5000,
}, async () => {
  const devices = [device(1), device(2)];
  await withPeer(
    async (socket) => {
      const read = reader(socket);
      await read(17);
      socket.end(Buffer.from([0]));
    },
    async (port) => {
      const result = await runFleet(
        { devices, captured: 2, simulatedLoss: 0 },
        policy,
        options(port),
        probe,
      );
      assert.equal(result.status, "fleet-incomplete");
      assert.equal(result.metrics.exhaustedRecords, 2);
      assert.equal(result.metrics.queuedRecords, 2);
      assert.equal(result.metrics.sessionFailures["login-refused"], 2);
    },
  );
  await withPeer(
    async (socket) => {
      const read = reader(socket);
      await read(17);
    },
    async (port) => {
      const result = await runFleet(
        { devices, captured: 2, simulatedLoss: 0 },
        { ...policy, maxConcurrent: 2 },
        { ...options(port), signal: AbortSignal.timeout(50) },
        probe,
      );
      assert.equal(result.status, "fleet-cancelled");
      assert.equal(result.metrics.undeliveredRecords, 2);
      assert.equal(result.metrics.exhaustedRecords, 0);
      assert.equal(result.metrics.sessionFailures["login-timeout"], 0);
    },
  );
});

test("reference peer needs explicit loopback authorization and whole-run expiry is not a server failure", {
  timeout: 5000,
}, async () => {
  const devices = [device(1)];
  const input = { devices, captured: 1, simulatedLoss: 0 };
  await assert.rejects(
    runFleet(
      input,
      { ...policy, profile: "reference-peer" },
      options(1),
      probe,
    ),
    /invalid-fleet/,
  );
  await assert.rejects(
    runFleet(
      input,
      { ...policy, profile: "reference-peer" },
      { ...options(1), host: "tcp-ingestion", authorizedReferencePeer: true },
      probe,
    ),
    /invalid-fleet/,
  );
  await withPeer(
    async (socket) => {
      const read = reader(socket);
      await read(17);
    },
    async (port) => {
      const result = await runFleet(
        input,
        policy,
        { ...options(port), totalDeadlineMs: 50 },
        probe,
      );
      assert.equal(result.status, "fleet-timeout");
      assert.equal(result.metrics.undeliveredRecords, 1);
      assert.equal(
        Object.values(result.metrics.sessionFailures).reduce(
          (a, b) => a + b,
          0,
        ),
        0,
      );
    },
  );
});

test("expiry between claim and attempt admission does not invent a transport call", async () => {
  let at = 0;
  const result = await runFleet(
    { devices: [device(1)], captured: 1, simulatedLoss: 0 },
    policy,
    {
      ...options(1),
      totalDeadlineMs: 25,
      now: () => {
        at += 10;
        return at;
      },
    },
    probe,
  );
  assert.equal(result.status, "fleet-timeout");
  assert.equal(result.metrics.attempts, 0);
  assert.equal(result.metrics.undeliveredRecords, 1);
  assert.equal(result.metrics.peakSessions, 0);
});
