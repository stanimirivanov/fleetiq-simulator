import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runCli, runTcp } from "../src/cli.ts";
import { frame, record } from "./codec8-fixture.ts";
import { ack, identity, login, withPeer } from "./peer.ts";

test("durable CLI captures through outage and resumes frozen FIFO work without new captures", {
  timeout: 10000,
}, async () => {
  const { execFile } = await import("node:child_process");
  const { playbackConfig } = await import("./playback-fixture.ts");
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-recovery-"));
  let online = false;
  const received: Buffer[] = [];
  const launch = (command: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
      execFile(
        process.execPath,
        ["src/cli.ts", command, "--config", join(directory, "config.json")],
        { timeout: 4000 },
        (error, stdout, stderr) =>
          done({ code: Number(error?.code ?? 0), stdout, stderr }),
      ),
    );
  try {
    await withPeer(
      async (socket) => {
        const read = await login(socket);
        if (!online) {
          socket.destroy();
          return;
        }
        socket.write(Buffer.from([1]));
        const header = await read(8);
        const rest = await read(header.readUInt32BE(4) + 4);
        const packet = Buffer.concat([header, rest]);
        received.push(packet);
        const ack = Buffer.alloc(4);
        ack.writeUInt32BE(packet[9] ?? 0);
        socket.end(ack);
      },
      async (port) => {
        const config = playbackConfig(directory, port);
        const offline = await launch("run");
        assert.equal(offline.code, 3);
        assert.equal(offline.stdout, "");
        assert.equal(offline.stderr, "connection-closed\n");
        const checkpoint = join(directory, "private-state", "checkpoint.json");
        const body = JSON.parse(
          JSON.parse(readFileSync(checkpoint, "utf8")).body,
        );
        assert.deepEqual(
          [body.captured, body.acknowledged, body.records.length],
          [3, 0, 3],
        );
        const pending = body.pending;
        online = true;
        const resumed = await launch("resume");
        assert.equal(resumed.code, 0, resumed.stderr);
        assert.deepEqual(JSON.parse(resumed.stdout), {
          status: "acknowledged",
          recordCount: 3,
        });
        assert.equal(resumed.stderr, "");
        assert.equal(received[0]?.toString("hex"), pending);
        assert.deepEqual(
          received.map((packet) => packet[9]),
          [2, 1],
        );
        const count = received.length;
        assert.equal((await launch("resume")).code, 0);
        assert.equal(received.length, count);
        config.playback.intervalMs = 500;
        writeFileSync(join(directory, "config.json"), JSON.stringify(config));
        const mismatch = await launch("resume");
        assert.equal(mismatch.code, 4);
        assert.equal(mismatch.stderr, "spool-mismatch\n");
        assert.equal(received.length, count);
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SIGKILL and cooperative SIGTERM preserve uncertain packets for byte-exact resume", {
  timeout: 15000,
}, async () => {
  const { spawn } = await import("node:child_process");
  const { playbackConfig } = await import("./playback-fixture.ts");
  for (const signal of ["SIGKILL", "SIGTERM"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "fleetiq-interrupt-"));
    let online = false;
    let child: import("node:child_process").ChildProcess | undefined;
    const received: Buffer[] = [];
    const launch = (command: string) => {
      let stdout = "",
        stderr = "";
      child = spawn(
        process.execPath,
        ["src/cli.ts", command, "--config", join(directory, "config.json")],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      return new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((done) =>
        child?.once("close", (code, signal) =>
          done({ code, signal, stdout, stderr }),
        ),
      );
    };
    try {
      await withPeer(
        async (socket) => {
          const read = await login(socket);
          socket.write(Buffer.from([1]));
          const header = await read(8);
          const packet = Buffer.concat([
            header,
            await read(header.readUInt32BE(4) + 4),
          ]);
          received.push(packet);
          if (!online) {
            assert.ok(child);
            child.kill(signal);
            return;
          }
          const ack = Buffer.alloc(4);
          ack.writeUInt32BE(packet[9] ?? 0);
          socket.end(ack);
        },
        async (port) => {
          playbackConfig(directory, port);
          const stopped = await launch("run");
          assert.equal(stopped.stdout, "");
          if (signal === "SIGTERM") {
            assert.equal(stopped.code, 130);
            assert.equal(stopped.stderr, "cancelled\n");
          } else assert.equal(stopped.signal, "SIGKILL");
          const state = JSON.parse(
            JSON.parse(
              readFileSync(
                join(directory, "private-state", "checkpoint.json"),
                "utf8",
              ),
            ).body,
          );
          assert.equal(state.acknowledged, 0);
          assert.equal(state.pending, received[0]?.toString("hex"));
          online = true;
          const recovered = await launch("resume");
          assert.equal(recovered.code, 0, recovered.stderr);
          assert.deepEqual(JSON.parse(recovered.stdout), {
            status: "acknowledged",
            recordCount: 3,
          });
          assert.deepEqual(received[1], received[0]);
          assert.deepEqual(
            received.map((bytes) => bytes[9]),
            [2, 2, 1],
          );
        },
      );
    } finally {
      child?.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("playback validation checks private inputs offline without creating checkpoint state", async () => {
  const { existsSync } = await import("node:fs");
  const { playbackConfig } = await import("./playback-fixture.ts");
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-validate-spool-"));
  try {
    playbackConfig(directory, 55027);
    const errors: string[] = [];
    assert.equal(
      runCli(
        ["validate", "--config", join(directory, "config.json")],
        (error) => errors.push(error),
      ),
      0,
    );
    assert.deepEqual(errors, []);
    assert.equal(existsSync(join(directory, "private-state")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test("fleet CLI validates private seeded inputs and emits aggregate outcomes without device labels", {
  timeout: 5000,
}, async () => {
  const { playbackConfig } = await import("./playback-fixture.ts");
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

test("UDP CLI admits only explicit reference peers with private identity and a correlated wire receipt", {
  timeout: 3000,
}, async () => {
  const { withUdpPeer } = await import("./udp-peer.ts");
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-udp-cli-"));
  try {
    const path = join(directory, "config.json");
    writeFileSync(
      join(directory, "identities.json"),
      JSON.stringify({ "sim-a": identity }),
      { mode: 0o600 },
    );
    await withUdpPeer(
      async (packet, source, peer) => {
        assert.equal(packet.subarray(8, 23).toString(), identity);
        peer.send(
          Buffer.from([0, 5, 0, 7, 1, 9, 1]),
          source.port,
          source.address,
        );
      },
      async (port) => {
        const input = {
          schemaVersion: 1,
          identityFile: "identities.json",
          deviceId: "sim-a",
          target: {
            transport: "udp",
            profile: "reference-peer",
            host: "127.0.0.1",
            port,
          },
          packetId: 7,
          avlPacketId: 9,
          records: [record],
          retry: { maxAttempts: 1, ackDeadlineMs: 200, totalDeadlineMs: 1000 },
        };
        const errors: string[] = [];
        const receipts: unknown[] = [];
        writeFileSync(path, JSON.stringify(input));
        assert.equal(
          runCli(["validate", "--config", path], (c) => errors.push(c)),
          0,
        );
        const run = (command: string) =>
          runTcp(
            [command, "--config", path],
            (c) => errors.push(c),
            new AbortController().signal,
            (r) => receipts.push(r),
          );
        assert.equal(await run("run"), 2);
        assert.deepEqual(receipts, []);
        for (const target of [
          { ...input.target, profile: "product" },
          { ...input.target, host: "tcp-ingestion" },
        ]) {
          writeFileSync(path, JSON.stringify({ ...input, target }));
          assert.equal(await run("udp"), 2);
        }
        writeFileSync(path, JSON.stringify(input));
        assert.equal(await run("udp"), 0);
        assert.deepEqual(receipts, [
          { status: "acknowledged", recordCount: 1 },
        ]);
        assert.equal(
          JSON.stringify({ errors, receipts }).includes(identity),
          false,
        );
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI command fixture is explicit, private and emits only an acknowledged receipt", {
  timeout: 3000,
}, async () => {
  const { execFile } = await import("node:child_process");
  const { getinfo } = await import("./command-peer.ts");
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-command-"));
  const observed = Promise.withResolvers<void>();
  try {
    const config = join(directory, "run.json");
    writeFileSync(
      join(directory, "identity.json"),
      JSON.stringify({ "sim-a": identity }),
      { mode: 0o600 },
    );
    await withPeer(
      async (socket) => {
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        assert.equal((await read(frame.length / 2)).toString("hex"), frame);
        socket.write(Buffer.concat([ack, getinfo]));
        const header = await read(8);
        const body = await read(header.readUInt32BE(4) + 4);
        assert.equal(
          body.subarray(7, -5).toString("ascii"),
          "SIMULATOR:read-only",
        );
        observed.resolve();
      },
      async (port) => {
        writeFileSync(
          config,
          JSON.stringify({
            schemaVersion: 1,
            identityFile: "identity.json",
            deviceId: "sim-a",
            target: { transport: "tcp", host: "127.0.0.1", port },
            retry: { maxAttempts: 1 },
            record,
          }),
        );
        const result = await new Promise<{
          code: number;
          stdout: string;
          stderr: string;
        }>((resolve) =>
          execFile(
            process.execPath,
            ["src/cli.ts", "command-fixture", "--config", config],
            { timeout: 2000 },
            (error, stdout, stderr) =>
              resolve({ code: Number(error?.code ?? 0), stdout, stderr }),
          ),
        );
        await observed.promise;
        assert.deepEqual(result, {
          code: 0,
          stdout: `${JSON.stringify({ status: "acknowledged", recordCount: 1 })}\n`,
          stderr: "",
        });
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
