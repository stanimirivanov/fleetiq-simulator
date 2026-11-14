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
import { mock, test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  type RunConfig,
  run as runCli,
  runConfigSchema,
  runTcp,
} from "../src/cli.ts";
import {
  defaultTarget,
  sessionDefaults,
  sessionLimits,
} from "../src/session/state.ts";
import { encodeCodec8 } from "../src/wire/codec8.ts";
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

type IdentityScenario =
  | "parent identity path"
  | "inline identity"
  | "unapproved destination"
  | "public identity file"
  | "acknowledged receipt"
  | "login refusal";

/** Exercises one private CLI invocation and its exact output against an independent peer. */
async function verifyIdentityScenario(scenario: IdentityScenario) {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "fleetiq-tcp-"));
  try {
    const config = join(directory, "config.json");
    let connections = 0;
    await withPeer(
      async (socket) => {
        connections++;
        const read = await login(socket);
        if (scenario === "login refusal") {
          socket.end(Buffer.from([0]));
          return;
        }
        socket.write(Buffer.from([1]));
        const received = await read(45);
        assert.equal(received[8], 8);
        assert.equal(received[9], 1);
        socket.end(ack);
      },
      async (port) => {
        const inputs = {
          schemaVersion: 1,
          identityFile:
            scenario === "parent identity path"
              ? "../identities.json"
              : "identities.json",
          deviceId: "sim-a",
          target: {
            transport: "tcp",
            host:
              scenario === "unapproved destination" ? "localhost" : "127.0.0.1",
            port,
          },
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
          ...(scenario === "inline identity" ? { imei: identity } : {}),
        };
        await writeFile(config, JSON.stringify(inputs));
        await writeFile(
          join(directory, "identities.json"),
          JSON.stringify({ "sim-a": identity }),
          {
            mode: scenario === "public identity file" ? 0o644 : 0o600,
          },
        );
        const result = await new Promise<{
          code: number;
          stdout: string;
          stderr: string;
        }>((resolve) => {
          execFile(
            process.execPath,
            ["src/cli.ts", "run", "--config", config],
            { timeout: 2000 },
            (error, stdout, stderr) => {
              resolve({ code: Number(error?.code ?? 0), stdout, stderr });
            },
          );
        });
        const sends =
          scenario === "acknowledged receipt" || scenario === "login refusal";
        assert.equal(connections, sends ? 1 : 0);
        assert.deepEqual(
          result,
          scenario === "acknowledged receipt"
            ? {
                code: 0,
                stdout: '{"status":"acknowledged","recordCount":1}\n',
                stderr: "",
              }
            : {
                code: scenario === "login refusal" ? 3 : 2,
                stdout: "",
                stderr: `${scenario === "login refusal" ? "login-refused" : scenario === "public identity file" ? "invalid-identity-file" : "invalid-run-config"}\n`,
              },
        );
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Each cold CLI process owns a deadline; unrelated invocations must not share one.
test("CLI sends only with a private identity file and prints a sanitized receipt", {
  timeout: 3000,
}, async () => {
  await verifyIdentityScenario("acknowledged receipt");
});

for (const scenario of [
  "parent identity path",
  "inline identity",
  "unapproved destination",
  "public identity file",
  "login refusal",
] as const) {
  test(`CLI private identity boundary: ${scenario}`, {
    timeout: 3000,
  }, async () => {
    await verifyIdentityScenario(scenario);
  });
}

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

test("typed run configurations agree with the closed schema and documented defaults", () => {
  const valid = new Ajv2020({ ownProperties: true }).compile<RunConfig>(
    runConfigSchema,
  );
  const minimal = {
    schemaVersion: 1,
    record,
    deviceId: "sim-a",
    identityFile: "identities.json",
  } satisfies RunConfig;
  const full = {
    ...minimal,
    target: { transport: "tcp", ...defaultTarget },
    retry: { ackDeadlineMs: 100, totalDeadlineMs: 1, maxAttempts: 1 },
    connectionPolicy: "persistent-compliant-peer",
  } satisfies RunConfig;
  assert.equal(valid(minimal), true);
  assert.equal(valid(full), true);
  const emptyRetry = { ...minimal, retry: {} } satisfies RunConfig;
  assert.equal(valid(emptyRetry), true);
  const explicitDefaults = {
    ...minimal,
    retry: {
      ackDeadlineMs: sessionDefaults.ackDeadlineMs,
      totalDeadlineMs: sessionDefaults.totalDeadlineMs,
      maxAttempts: sessionDefaults.maxAttempts,
    },
    connectionPolicy: sessionDefaults.connectionPolicy,
  } satisfies RunConfig;
  assert.equal(valid(explicitDefaults), true);
  assert.deepEqual(
    [...runConfigSchema.required].sort(),
    Object.keys(minimal).sort(),
  );
  assert.deepEqual(
    Object.keys(runConfigSchema.properties).sort(),
    Object.keys(full).sort(),
  );
  assert.deepEqual(
    [...runConfigSchema.properties.target.required].sort(),
    Object.keys(full.target).sort(),
  );
  for (const patch of [
    { schemaVersion: 2 },
    { target: { ...full.target, transport: "udp" } },
    { target: { host: "127.0.0.1", port: 55027 } },
    { retry: { ...full.retry, maxAttempts: "1" } },
    { retry: null },
  ])
    assert.equal(valid({ ...minimal, ...patch }), false);

  const limits = sessionLimits({ ...defaultTarget, identity, now: () => 0 });
  assert.equal(limits.ackDeadlineMs, sessionDefaults.ackDeadlineMs);
  assert.equal(limits.maxAttempts, sessionDefaults.maxAttempts);
  assert.equal(limits.connectionPolicy, sessionDefaults.connectionPolicy);
  assert.equal(limits.remaining(), sessionDefaults.totalDeadlineMs);
  const readme = readFileSync("README.md", "utf8");
  const sample = /```json\n([\s\S]*?)\n```/u.exec(readme)?.[1];
  assert.ok(sample);
  const documentedTarget = readme.match(
    /Optional `(\{[^\n]+?\})` \(default\)/u,
  )?.[1];
  assert.ok(documentedTarget);
  assert.deepEqual(JSON.parse(documentedTarget), {
    transport: "tcp",
    ...defaultTarget,
  });
  assert.equal(valid({ ...minimal, record: JSON.parse(sample) }), true);
  assert.equal(encodeCodec8(JSON.parse(sample)).length, 45);
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

test("CLI schema admits the precise Compose name while keeping arbitrary destinations rejected", () => {
  const validate = new Ajv2020().compile(runConfigSchema);
  const input = {
    schemaVersion: 1,
    identityFile: "identities.json",
    deviceId: "demo",
    record: {},
    target: { transport: "tcp", host: "tcp-ingestion", port: 55027 },
  };
  assert.equal(validate(input), true);
  for (const host of [
    "example.com",
    "tcp-ingestion.example.com",
    "8.8.8.8",
    "localhost",
  ])
    assert.equal(
      validate({ ...input, target: { ...input.target, host } }),
      false,
    );
});

test("Extended CLI validates, encodes and sends the exact NX frame with one ACK", {
  timeout: 3000,
}, async () => {
  const { variableRecord, variableFrame } = await import(
    "./codec8e-fixture.ts"
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
