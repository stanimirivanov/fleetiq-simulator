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
import { run as runCli, runTcp } from "../../src/cli.ts";
import { defaultTarget } from "../../src/session/state.ts";
import { frame, record } from "../codec8-fixture.ts";

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

test("Codec 16 is an explicit provisional offline profile, never a network selector", async () => {
  const { record16, single16 } = await import("../codec16-fixture.ts");
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-codec16-"));
  try {
    const input = join(directory, "input");
    const output = join(directory, "output");
    const messages: string[] = [];
    writeFileSync(input, JSON.stringify({ ...record16, codec: "16" }));
    assert.equal(
      runCli(["validate", "--config", input], (m) => messages.push(m)),
      0,
    );
    assert.equal(
      runCli(["encode", "--config", input, "--output", output], (m) =>
        messages.push(m),
      ),
      0,
    );
    assert.equal(readFileSync(output).toString("hex"), single16);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    writeFileSync(
      input,
      JSON.stringify({ ...record16, codec: "16", profile: "fmb920" }),
    );
    assert.equal(
      runCli(["validate", "--config", input], (m) => messages.push(m)),
      2,
    );
    writeFileSync(
      input,
      JSON.stringify({
        schemaVersion: 1,
        identityFile: "identities.json",
        deviceId: "demo",
        target: { transport: "tcp", ...defaultTarget },
        record: { ...record16, codec: "16" },
      }),
    );
    assert.equal(
      await runTcp(
        ["run", "--config", input],
        (m) => messages.push(m),
        new AbortController().signal,
      ),
      2,
    );
    assert.deepEqual(messages, ["invalid-record", "invalid-record"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
