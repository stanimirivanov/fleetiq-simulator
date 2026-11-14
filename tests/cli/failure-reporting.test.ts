import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { run as runCli, runTcp } from "../../src/cli.ts";
import { defaultTarget } from "../../src/session/state.ts";
import { identity } from "../support/peers/peer.ts";
import { record } from "../support/wire/codec8-fixture.ts";

test("expected input failures preserve their category and precedence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-error-order-"));
  const config = join(directory, "run.json");
  const input = {
    schemaVersion: 1,
    identityFile: "identities.json",
    deviceId: "sim-a",
    target: { transport: "tcp", host: "127.0.0.1", port: -1 },
    record: { invalid: true },
  };
  const messages: string[] = [];
  const run = () =>
    runTcp(
      ["run", "--config", config],
      (message) => messages.push(message),
      new AbortController().signal,
    );
  try {
    assert.equal(await run(), 2);
    assert.deepEqual(messages.splice(0), ["input-unavailable"]);
    writeFileSync(config, "{");
    assert.equal(await run(), 2);
    assert.deepEqual(messages.splice(0), ["invalid-json"]);
    writeFileSync(config, JSON.stringify(input));
    assert.equal(await run(), 2);
    assert.deepEqual(messages.splice(0), ["invalid-record"]);
    writeFileSync(config, JSON.stringify({ ...input, record }));
    assert.equal(await run(), 2);
    assert.deepEqual(messages.splice(0), ["invalid-identity-file"]);
    writeFileSync(
      join(directory, "identities.json"),
      JSON.stringify({ "sim-a": identity }),
      { mode: 0o600 },
    );
    assert.equal(await run(), 2);
    assert.deepEqual(messages.splice(0), ["invalid-session"]);
    writeFileSync(
      config,
      JSON.stringify({
        ...input,
        target: { ...input.target, host: "localhost" },
      }),
    );
    assert.equal(await run(), 2);
    assert.deepEqual(messages.splice(0), ["invalid-run-config"]);
    writeFileSync(
      config,
      JSON.stringify({
        ...input,
        target: { transport: "tcp", ...defaultTarget },
        record,
      }),
    );
    const cancelled = new AbortController();
    cancelled.abort();
    assert.equal(
      await runTcp(
        ["run", "--config", config],
        (message) => messages.push(message),
        cancelled.signal,
      ),
      130,
    );
    assert.deepEqual(messages.splice(0), ["cancelled"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unexpected input defects cannot impersonate an expected category", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-defect-"));
  const input = join(directory, "record.json");
  writeFileSync(input, JSON.stringify(record));
  const messages: string[] = [];
  try {
    const fault = mock.method(JSON, "parse", () => {
      throw new Error("invalid-record");
    });
    try {
      assert.equal(
        runCli(["validate", "--config", input], (message) =>
          messages.push(message),
        ),
        1,
      );
      assert.deepEqual(messages, ["internal-error"]);
    } finally {
      fault.mock.restore();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unexpected transport defects produce only a redacted internal failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-transport-defect-"));
  try {
    const config = join(directory, "run.json");
    const hook = join(directory, "fault.mjs");
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
    format:"module",shortCircuit:true,source:'export async function sendBatches() { throw new Error("private-transport-defect"); }'
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
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "internal-error\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unexpected identity parsing defects remain internal failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-identity-defect-"));
  try {
    const input = {
      schemaVersion: 1,
      record,
      deviceId: "sim-a",
      identityFile: "identities.json",
    };
    const config = join(directory, "run.json");
    writeFileSync(config, JSON.stringify(input));
    writeFileSync(join(directory, "identities.json"), "{}", { mode: 0o600 });
    let calls = 0;
    const fault = mock.method(JSON, "parse", () => {
      if (++calls === 1) return input;
      throw new Error("private-identity-defect");
    });
    const messages: string[] = [];
    try {
      assert.equal(
        await runTcp(
          ["run", "--config", config],
          (message) => messages.push(message),
          new AbortController().signal,
        ),
        1,
      );
      assert.deepEqual(messages, ["internal-error"]);
    } finally {
      fault.mock.restore();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
