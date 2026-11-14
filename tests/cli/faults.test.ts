import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runCli, runTcp } from "../../src/cli.ts";
import { frame, record } from "../codec8-fixture.ts";
import { identity, login, withPeer } from "../peer.ts";

test("fault CLI requires separate authorization/command and emits only observation counters", {
  timeout: 3000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-fault-cli-"));
  try {
    const path = join(directory, "config.json");
    writeFileSync(
      join(directory, "identities.json"),
      JSON.stringify({ "sim-a": identity }),
      { mode: 0o600 },
    );
    await withPeer(
      async (socket) => {
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        await read(Buffer.from(frame, "hex").length);
        socket.end();
      },
      async (port) => {
        const config = {
          schemaVersion: 1,
          identityFile: "identities.json",
          deviceId: "sim-a",
          target: { transport: "tcp", host: "127.0.0.1", port },
          retry: { maxAttempts: 1, ackDeadlineMs: 100, totalDeadlineMs: 1000 },
          records: [record],
          faults: {
            schemaVersion: 1,
            authorizedLocalTarget: true,
            actions: [{ packet: 1, kind: "corrupt-crc" }],
          },
        };
        writeFileSync(path, JSON.stringify(config));
        const errors: string[] = [];
        const observations: unknown[] = [];
        const ordinary: unknown[] = [];
        const run = (command: string) =>
          runTcp(
            [command, "--config", path],
            (category) => errors.push(category),
            new AbortController().signal,
            (r) => ordinary.push(r),
            (r) => observations.push(r),
          );
        assert.equal(await run("run"), 2);
        assert.deepEqual(observations, []);
        assert.equal(
          runCli(["validate", "--config", path], (c) => errors.push(c)),
          0,
        );
        writeFileSync(
          path,
          JSON.stringify({
            ...config,
            faults: { ...config.faults, authorizedLocalTarget: false },
          }),
        );
        assert.equal(await run("fault"), 2);
        writeFileSync(path, JSON.stringify(config));
        assert.equal(await run("fault"), 0);
        assert.deepEqual(ordinary, []);
        assert.deepEqual(observations, [
          {
            status: "faults-completed",
            packets: 1,
            acknowledged: 0,
            denied: 1,
            disconnected: 0,
          },
        ]);
        assert.equal(
          JSON.stringify({ errors, observations }).includes(identity),
          false,
        );
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
