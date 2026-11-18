import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runCli, runTcp } from "../../src/cli.ts";
import {
  ack,
  identity,
  login,
  reader,
  withPeer,
} from "../support/peers/peer.ts";
import { frame, record } from "../support/wire/codec8-fixture.ts";

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

test("fault CLI validates and sends an explicit identity pair without ordinary receipts or leaked values", {
  timeout: 5000,
}, async () => {
  const { execFile } = await import("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-fault-pair-"));
  const alternate = [...identity].reverse().join("");
  const path = join(directory, "config.json");
  let connections = 0;
  try {
    writeFileSync(
      join(directory, "identities.json"),
      JSON.stringify({ "sim-a": identity, "sim-b": alternate }),
      { mode: 0o600 },
    );
    await withPeer(
      async (socket, attempt) => {
        connections++;
        const read = reader(socket);
        assert.deepEqual(await read(2), Buffer.from([0, 15]));
        assert.equal(
          (await read(15)).toString("ascii"),
          attempt === 1 ? identity : alternate,
        );
        if (attempt === 1) {
          socket.write(Buffer.from([1]));
          assert.deepEqual(
            await read(Buffer.from(frame, "hex").length),
            Buffer.from(frame, "hex"),
          );
          socket.end(ack);
        } else {
          socket.end(Buffer.from([0]));
          await assert.rejects(read(1), /unexpected-client-close/);
        }
      },
      async (port) => {
        const config = {
          schemaVersion: 1,
          identityFile: "identities.json",
          deviceId: "sim-a",
          unregisteredDeviceId: "sim-b",
          target: { transport: "tcp", host: "127.0.0.1", port },
          retry: { maxAttempts: 1, ackDeadlineMs: 500, totalDeadlineMs: 2000 },
          records: [record, record],
          faults: {
            schemaVersion: 1,
            authorizedLocalTarget: true,
            actions: [{ packet: 2, kind: "unregistered-identity" }],
          },
        };
        writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
        const errors: string[] = [];
        assert.equal(
          runCli(["validate", "--config", path], (c) => errors.push(c)),
          0,
        );
        assert.deepEqual(errors, []);
        assert.equal(connections, 0);
        const result = await new Promise<{
          code: number;
          stdout: string;
          stderr: string;
        }>((resolve) => {
          execFile(
            process.execPath,
            ["src/cli.ts", "fault", "--config", path],
            { timeout: 3000 },
            (error, stdout, stderr) =>
              resolve({ code: Number(error?.code ?? 0), stdout, stderr }),
          );
        });
        assert.deepEqual(result, {
          code: 0,
          stdout:
            '{"status":"faults-completed","packets":2,"acknowledged":1,"denied":1,"disconnected":0}\n',
          stderr: "",
        });
        assert.equal(connections, 2);
        for (const secret of [identity, alternate, directory])
          assert.equal(JSON.stringify(result).includes(secret), false);
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fault identity admission rejects malformed, missing, extra or public entries and preserves ordinary singleton validation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-fault-pair-policy-"));
  const path = join(directory, "config.json"),
    file = join(directory, "identities.json");
  const alternate = [...identity].reverse().join("");
  const config = {
    schemaVersion: 1,
    identityFile: "identities.json",
    deviceId: "sim-a",
    unregisteredDeviceId: "sim-b",
    records: [record],
    faults: {
      schemaVersion: 1,
      authorizedLocalTarget: true,
      actions: [{ packet: 1, kind: "unregistered-identity" }],
    },
  };
  const validate = (value: unknown) => {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    const errors: string[] = [];
    const code = runCli(["validate", "--config", path], (c) => errors.push(c));
    return { code, errors };
  };
  try {
    for (const entries of [
      { "sim-a": identity },
      { "sim-b": alternate },
      { "sim-a": identity, "sim-b": alternate, unused: identity },
      { "sim-a": identity, "sim-b": "bad" },
    ]) {
      writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
      assert.deepEqual(validate(config), {
        code: 2,
        errors: ["invalid-identity-file"],
      });
    }
    writeFileSync(
      file,
      JSON.stringify({ "sim-a": identity, "sim-b": alternate }),
      { mode: 0o600 },
    );
    assert.deepEqual(validate({ ...config, unregisteredDeviceId: "sim-a" }), {
      code: 2,
      errors: ["invalid-identity-file"],
    });
    const ordinary = {
      schemaVersion: 1,
      identityFile: "identities.json",
      deviceId: "sim-a",
      record,
    };
    await withPeer(
      async () => {
        assert.fail("Ordinary multi-entry input must not connect");
      },
      async (port) => {
        writeFileSync(
          path,
          JSON.stringify({
            ...ordinary,
            target: { transport: "tcp", host: "127.0.0.1", port },
            retry: { maxAttempts: 1, ackDeadlineMs: 100, totalDeadlineMs: 500 },
          }),
          { mode: 0o600 },
        );
        const errors: string[] = [];
        assert.equal(
          await runTcp(
            ["run", "--config", path],
            (c) => errors.push(c),
            new AbortController().signal,
          ),
          2,
        );
        assert.deepEqual(errors, ["invalid-identity-file"]);
      },
    );
    chmodSync(file, 0o644);
    assert.deepEqual(validate(config), {
      code: 2,
      errors: ["invalid-identity-file"],
    });
    chmodSync(file, 0o600);
    writeFileSync(
      file,
      JSON.stringify({ "sim-a": identity, "sim-b": identity }),
    );
    assert.deepEqual(validate(config), { code: 2, errors: ["invalid-faults"] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
