import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { login, withPeer } from "../support/peers/peer.ts";

test("SIGKILL and cooperative SIGTERM preserve uncertain packets for byte-exact resume", {
  timeout: 15000,
}, async () => {
  const { spawn } = await import("node:child_process");
  const { playbackConfig } = await import(
    "../support/playback/playback-fixture.ts"
  );
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
