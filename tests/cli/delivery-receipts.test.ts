import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runCli, runTcp } from "../../src/cli.ts";
import { frame, record } from "../codec8-fixture.ts";
import { ack, identity, login, withPeer } from "../peer.ts";

test("an exhausted run emits no receipt after the peer accepted bytes without an ACK", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-no-receipt-"));
  try {
    const config = join(directory, "run.json");
    writeFileSync(
      join(directory, "identities.json"),
      JSON.stringify({ "sim-a": identity }),
      { mode: 0o600 },
    );
    let accepted = false;
    await withPeer(
      async (socket) => {
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        assert.equal(
          (await read(Buffer.from(frame, "hex").length)).toString("hex"),
          frame,
        );
        accepted = true;
        socket.end();
      },
      async (port) => {
        writeFileSync(
          config,
          JSON.stringify({
            schemaVersion: 1,
            record,
            identityFile: "identities.json",
            deviceId: "sim-a",
            target: { transport: "tcp", host: "127.0.0.1", port },
            retry: { maxAttempts: 1 },
          }),
        );
        const messages: string[] = [];
        const receipts: unknown[] = [];
        const code = await runTcp(
          ["run", "--config", config],
          (message) => messages.push(message),
          new AbortController().signal,
          (receipt) => receipts.push(receipt),
        );
        assert.equal(code, 3);
        assert.deepEqual(messages, ["connection-closed"]);
        assert.deepEqual(receipts, []);
        assert.equal(accepted, true);
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the CLI serializes the adapter receipt without inventing its count or exposing extra fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-receipt-"));
  try {
    const config = join(directory, "run.json");
    const hook = join(directory, "receipt.mjs");
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        record,
        identityFile: "identities.json",
        deviceId: "sim-a",
      }),
    );
    writeFileSync(
      join(directory, "identities.json"),
      JSON.stringify({ "sim-a": identity }),
      { mode: 0o600 },
    );
    writeFileSync(
      hook,
      `import {registerHooks} from "node:module";
registerHooks({load(url,context,next) {
  if (url.endsWith("/src/transport/tcp.ts")) return {
    format:"module",shortCircuit:true,source:'export async function sendBatches() { return { status:"acknowledged", recordCount:2, extra:"private-receipt-field" }; }'
  };
  return next(url,context);
}});
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", hook, "src/cli.ts", "run", "--config", config],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{"status":"acknowledged","recordCount":2}\n');
    assert.equal(result.stderr, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Extended CLI validates, encodes and sends the exact NX frame with one ACK", {
  timeout: 3000,
}, async () => {
  const { variableRecord, variableFrame } = await import(
    "../codec8e-fixture.ts"
  );
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-extended-"));
  try {
    const input = join(directory, "record.json");
    const output = join(directory, "frame.bin");
    const config = join(directory, "run.json");
    const record = { ...variableRecord, codec: "8e" };
    writeFileSync(input, JSON.stringify(record));
    writeFileSync(
      join(directory, "identity.json"),
      JSON.stringify({ "sim-a": identity }),
      { mode: 0o600 },
    );
    assert.equal(
      runCli(["validate", "--config", input], () => {}),
      0,
    );
    assert.equal(
      runCli(["encode", "--config", input, "--output", output], () => {}),
      0,
    );
    assert.equal(readFileSync(output).toString("hex"), variableFrame);
    await withPeer(
      async (socket) => {
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        assert.equal(
          (await read(variableFrame.length / 2)).toString("hex"),
          variableFrame,
        );
        socket.end(ack);
      },
      async (port) => {
        writeFileSync(
          config,
          JSON.stringify({
            schemaVersion: 1,
            deviceId: "sim-a",
            identityFile: "identity.json",
            target: { transport: "tcp", host: "127.0.0.1", port },
            record,
          }),
        );
        const messages: string[] = [];
        assert.equal(
          await runTcp(
            ["run", "--config", config],
            (line) => messages.push(line),
            new AbortController().signal,
            (receipt) => messages.push(JSON.stringify(receipt)),
          ),
          0,
        );
        assert.deepEqual(messages, [
          '{"status":"acknowledged","recordCount":1}',
        ]);
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
