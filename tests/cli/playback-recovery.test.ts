import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runCli } from "../../src/cli.ts";
import { login, withPeer } from "../support/peers/peer.ts";

test("durable CLI captures through outage and resumes frozen FIFO work without new captures", {
  timeout: 10000,
}, async () => {
  const { execFile } = await import("node:child_process");
  const { playbackConfig } = await import(
    "../support/playback/playback-fixture.ts"
  );
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

test("playback validation checks private inputs offline without creating checkpoint state", async () => {
  const { existsSync } = await import("node:fs");
  const { playbackConfig } = await import(
    "../support/playback/playback-fixture.ts"
  );
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
