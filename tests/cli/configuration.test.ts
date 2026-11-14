import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { type RunConfig, runConfigSchema } from "../../src/cli.ts";
import {
  defaultTarget,
  sessionDefaults,
  sessionLimits,
} from "../../src/session/state.ts";
import { encodeCodec8 } from "../../src/wire/codec8.ts";
import { record } from "../codec8-fixture.ts";
import { identity } from "../peer.ts";

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
