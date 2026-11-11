import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runCli } from "../src/cli.ts";
import { frame, record } from "./codec8-fixture.ts";
import { ack, identity, login, withPeer } from "./peer.ts";

test("CLI reads bounded files, redacts failures and writes private bytes once", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-codec8-"));
  try {
    const input = join(directory, "private-input");
    const output = join(directory, "private-output");
    const run = (...args: string[]) => {
      const messages: string[] = [];
      const status = runCli(args, (category) => messages.push(category));
      return {
        status,
        stderr: messages.map((message) => `${message}\n`).join(""),
      };
    };

    assert.equal(run("encode", input).stderr, "usage\n");
    assert.equal(
      run("validate", "--config", input).stderr,
      "input-unavailable\n",
    );
    assert.equal(
      run("validate", "--config", directory).stderr,
      "invalid-input-file\n",
    );
    for (const [contents, error] of [
      ["{private-value", "invalid-json"],
      [Buffer.from([0xff]), "invalid-json"],
      [JSON.stringify({ ...record, imei: "private-value" }), "invalid-record"],
      [" ".repeat(16 * 1024 + 1), "input-too-large"],
    ] as const) {
      writeFileSync(input, contents);
      const result = run("validate", "--config", input);
      assert.equal(result.status, 2);
      assert.equal(result.stderr, `${error}\n`);
    }
    writeFileSync(input, JSON.stringify(record));
    const validated = spawnSync(
      process.execPath,
      ["src/cli.ts", "validate", "--config", input],
      { encoding: "utf8" },
    );
    assert.equal(validated.status, 0);
    assert.equal(validated.stdout, "");
    assert.equal(validated.stderr, "");
    const encoded = run("encode", "--config", input, "--output", output);
    assert.equal(encoded.status, 0);
    assert.equal(readFileSync(output).toString("hex"), frame);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(
      run("encode", "--config", input, "--output", output).stderr,
      "output-unavailable\n",
    );
    assert.equal(readFileSync(output).toString("hex"), frame);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI sends only with a private identity file and prints a sanitized receipt", {
  timeout: 3000,
}, async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, rm, writeFile, chmod } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "fleetiq-tcp-"));
  try {
    const config = join(directory, "config.json");
    const identities = join(directory, "identities.json");
    const run = () =>
      new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            ["src/cli.ts", "run", "--config", config],
            { timeout: 2000 },
            (error, stdout, stderr) => {
              resolve({ code: Number(error?.code ?? 0), stdout, stderr });
            },
          );
        },
      );
    await withPeer(
      async (socket, attempt) => {
        const read = await login(socket);
        if (attempt === 2) {
          socket.end(Buffer.from([0]));
          return;
        }
        assert.equal(attempt, 1);
        socket.write(Buffer.from([1]));
        const received = await read(45);
        assert.equal(received[8], 8);
        assert.equal(received[9], 1);
        socket.end(ack);
      },
      async (port) => {
        const inputs = {
          schemaVersion: 1,
          identityFile: "identities.json",
          deviceId: "sim-a",
          target: { transport: "tcp", host: "127.0.0.1", port },
          record: {
            schemaVersion: 1,
            timestampMs: "0",
            priority: 0,
            longitudeE7: 0,
            latitudeE7: 0,
            altitude: 0,
            angle: 0,
            satellites: 0,
            speed: 0,
            eventId: 0,
            io: [],
          },
        };
        for (const invalid of [
          { ...inputs, identityFile: "../identities.json" },
          { ...inputs, imei: identity },
          { ...inputs, target: { ...inputs.target, host: "localhost" } },
        ]) {
          await writeFile(config, JSON.stringify(invalid));
          assert.deepEqual(await run(), {
            code: 2,
            stdout: "",
            stderr: "invalid-run-config\n",
          });
        }
        await writeFile(config, JSON.stringify(inputs));
        await writeFile(identities, JSON.stringify({ "sim-a": identity }), {
          mode: 0o644,
        });
        assert.deepEqual(await run(), {
          code: 2,
          stdout: "",
          stderr: "invalid-identity-file\n",
        });
        await chmod(identities, 0o600);
        assert.deepEqual(await run(), {
          code: 0,
          stdout: '{"status":"acknowledged","recordCount":1}\n',
          stderr: "",
        });
        assert.deepEqual(await run(), {
          code: 3,
          stdout: "",
          stderr: "login-refused\n",
        });
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
