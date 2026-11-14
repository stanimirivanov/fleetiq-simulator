import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ack, identity, login, withPeer } from "../support/peers/peer.ts";
import { frame, record } from "../support/wire/codec8-fixture.ts";

test("CLI command fixture is explicit, private and emits only an acknowledged receipt", {
  timeout: 3000,
}, async () => {
  const { execFile } = await import("node:child_process");
  const { getinfo } = await import("../support/peers/command-peer.ts");
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
