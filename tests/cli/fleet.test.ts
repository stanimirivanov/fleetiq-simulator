import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runCli, runTcp } from "../../src/cli.ts";
import { ack, identity, login, withPeer } from "../support/peers/peer.ts";

test("fleet CLI validates private seeded inputs and emits aggregate outcomes without device labels", {
  timeout: 5000,
}, async () => {
  const { playbackConfig } = await import(
    "../support/playback/playback-fixture.ts"
  );
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-fleet-cli-"));
  try {
    await withPeer(
      async (socket) => {
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        const header = await read(8);
        const body = await read(header.readUInt32BE(4) + 4);
        assert.equal(body[0], 0x8e);
        socket.end(ack);
      },
      async (port) => {
        const base = playbackConfig(directory, port);
        const config = {
          schemaVersion: 1,
          identityFile: base.identityFile,
          target: base.target,
          retry: base.retry,
          fleet: {
            profile: "product",
            maxConcurrent: 2,
            retryDelayMs: 20,
            maxQueuedBytes: 16777216,
            routeFile: "route.json",
            scenarioFile: "scenario.json",
            profileFile: "profile.json",
            intervalMs: 1000,
            dropEvery: 2,
            devices: [
              {
                deviceId: "sim-a",
                seed: "private-seed",
                clockOffsetMs: 0,
                driftPpm: 0,
              },
            ],
          },
        };
        const path = join(directory, "config.json");
        writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
        const messages: string[] = [];
        const results: unknown[] = [];
        assert.equal(
          runCli(["validate", "--config", path], (c) => messages.push(c)),
          0,
        );
        assert.equal(
          await runTcp(
            ["fleet", "--config", path],
            (c) => messages.push(c),
            new AbortController().signal,
            () => assert.fail("normal receipt"),
            () => assert.fail("fault receipt"),
            (r) => results.push(r),
          ),
          0,
        );
        assert.deepEqual(messages, []);
        assert.equal(results.length, 1);
        const result = results[0] as {
          status: string;
          metrics: {
            capturedRecords: number;
            simulatedLossRecords: number;
            acknowledgedRecords: number;
          };
        };
        assert.equal(result.status, "fleet-completed");
        assert.equal(result.metrics.capturedRecords, 3);
        assert.equal(result.metrics.simulatedLossRecords, 1);
        assert.equal(result.metrics.acknowledgedRecords, 2);
        const output = JSON.stringify(result);
        for (const value of [identity, "sim-a", "private-seed", "127.0.0.1"]) {
          assert.equal(output.includes(value), false);
        }
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
