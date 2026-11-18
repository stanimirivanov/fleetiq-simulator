import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditHarness, evaluateAudit } from "../../src/security/audit.mjs";

const approval = {
  approved: true,
  advisory: "GHSA-fc5q-39xc-vjpf",
  owner: "stanimirivanov",
  expiresAt: "2026-11-25T00:00:00Z",
  lockSha256:
    "5844c38ad0879d637de831d1e8ac90edd495ee935925eaf93fb36f73323ddb9a",
};
const paths = [
  ".>@stylistic/eslint-plugin>picomatch",
  ".>@typescript-eslint/parser>@typescript-eslint/typescript-estree>tinyglobby>picomatch",
  ".>@typescript-eslint/parser>@typescript-eslint/typescript-estree>tinyglobby>fdir>picomatch",
  ".>eslint-plugin-jsdoc>@typescript-eslint/utils>@typescript-eslint/typescript-estree>tinyglobby>picomatch",
  ".>eslint-plugin-jsdoc>@typescript-eslint/utils>@typescript-eslint/typescript-estree>tinyglobby>fdir>picomatch",
];
const scope = {
  lock: readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
  manifest: readFileSync(
    new URL("../../package.json", import.meta.url),
    "utf8",
  ),
  approval: JSON.stringify(approval),
};
function report() {
  return {
    advisories: {
      1: {
        id: 1,
        module_name: "picomatch",
        github_advisory_id: approval.advisory,
        severity: "high",
        vulnerable_versions: "<=4.0.7",
        patched_versions: null,
        findings: [
          {
            version: "4.0.7",
            paths: [...paths],
            dev: true,
            optional: false,
            bundled: false,
          },
        ],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    },
  };
}
const now = Date.parse("2026-11-18T12:00:00Z");
const check = (
  value = report(),
  state = scope,
  at = now,
  /** @type {number | null} */ status = 1,
) => evaluateAudit(JSON.stringify(value), status, state, at);

test("approved audit exception exposes its owner and hard expiry for the exact frozen harness graph", () => {
  assert.match(
    check(),
    /audit-exception.*GHSA-fc5q-39xc-vjpf.*stanimirivanov.*2026-11-25T00:00:00Z/,
  );
  const clean = JSON.parse(JSON.stringify(report()));
  clean.advisories = {};
  clean.metadata.vulnerabilities.high = 0;
  assert.match(check(clean, scope, now, 0), /audit-clean/);
  const low = JSON.parse(JSON.stringify(report()));
  low.advisories[1].severity = "moderate";
  low.metadata.vulnerabilities.high = 0;
  low.metadata.vulnerabilities.moderate = 1;
  assert.match(check(low), /audit-clean/);
});

test("audit exception fails closed on expiry, missing approval or modified frozen dependencies", () => {
  for (const at of [
    Date.parse(approval.expiresAt),
    Date.parse(approval.expiresAt) + 1,
    NaN,
  ])
    assert.throws(() => check(report(), scope, at));
  for (const change of [
    { approved: false },
    { owner: "other" },
    { expiresAt: "2026-11-26T00:00:00Z" },
    { advisory: "GHSA-other" },
    { lockSha256: "0".repeat(64) },
  ]) {
    assert.throws(() =>
      check(report(), {
        ...scope,
        approval: JSON.stringify({ ...approval, ...change }),
      }),
    );
  }
  for (const change of [
    { approval: "{}" },
    { approval: "" },
    { lock: `${scope.lock}\n` },
    { manifest: "{}" },
  ])
    assert.throws(() => check(report(), { ...scope, ...change }));
});

test("audit exception rejects altered advisory identity, severity, versions, patches and dependency paths", () => {
  for (const change of [
    { github_advisory_id: "GHSA-other" },
    { module_name: "another-package" },
    { severity: "critical" },
    { patched_versions: ">=4.0.8" },
    { vulnerable_versions: "*" },
    { findings: [] },
    { findings: [{ ...report().advisories[1].findings[0], version: "4.0.6" }] },
    { findings: [{ ...report().advisories[1].findings[0], dev: false }] },
    {
      findings: [
        {
          ...report().advisories[1].findings[0],
          paths: [...paths, ".>unexpected>picomatch"],
        },
      ],
    },
    {
      findings: [
        { ...report().advisories[1].findings[0], paths: paths.slice(1) },
      ],
    },
  ]) {
    const value = JSON.parse(JSON.stringify(report()));
    Object.assign(value.advisories[1], change);
    assert.throws(() => check(value));
  }
});

test("native audit errors, inconsistent counts and additional high findings cannot become exception passes", () => {
  for (const output of ["", "{", "{}", '{"error":{"message":"private-text"}}'])
    assert.throws(() => evaluateAudit(output, 1, scope, now));
  for (const status of [null, 0, 2])
    assert.throws(() => check(report(), scope, now, status));
  for (const mutate of [
    (/** @type {ReturnType<typeof JSON.parse>} */ v) => {
      v.metadata.vulnerabilities.high = 0;
    },
    (/** @type {ReturnType<typeof JSON.parse>} */ v) => {
      v.metadata.vulnerabilities.critical = 1;
    },
    (/** @type {ReturnType<typeof JSON.parse>} */ v) => {
      delete v.metadata;
    },
    (/** @type {ReturnType<typeof JSON.parse>} */ v) => {
      v.error = "private-text";
    },
    (/** @type {ReturnType<typeof JSON.parse>} */ v) => {
      v.advisories[2] = {
        ...v.advisories[1],
        id: 2,
        github_advisory_id: "GHSA-aaaa-bbbb-cccc",
      };
      v.metadata.vulnerabilities.high = 2;
    },
  ]) {
    const value = JSON.parse(JSON.stringify(report()));
    mutate(value);
    assert.throws(() => check(value));
  }
});

test("a clean-looking native report cannot hide changed dependency or ignore configuration", () => {
  const clean = JSON.parse(JSON.stringify(report()));
  clean.advisories = {};
  clean.metadata.vulnerabilities.high = 0;
  const manifest = JSON.parse(scope.manifest);
  manifest.pnpm = { auditConfig: { ignoreGhsas: [approval.advisory] } };
  assert.throws(() =>
    check(clean, { ...scope, manifest: JSON.stringify(manifest) }, now, 0),
  );
  assert.throws(() =>
    check(clean, { ...scope, lock: `${scope.lock}\n` }, now, 0),
  );
});

test("audit runner refuses repository-local pnpm configuration before invoking the native scanner", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-audit-config-"));
  const harness = join(directory, "harness");
  mkdirSync(harness);
  try {
    for (const parent of [directory, harness]) {
      for (const name of [
        ".npmrc",
        ".pnpmfile.cjs",
        "pnpm-workspace.yaml",
        "pnpm-workspace.yml",
      ]) {
        const path = join(parent, name);
        writeFileSync(path, "synthetic");
        assert.throws(() => auditHarness(harness), /audit-config-refused/);
        rmSync(path);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit tool failure retains private native evidence and emits only a fixed public category", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-audit-process-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  try {
    writeFileSync(
      join(bin, "pnpm"),
      `#!${process.execPath}\nconsole.log('private-audit-output');console.error('private-audit-error');process.exit(2);\n`,
      { mode: 0o700 },
    );
    const env = { ...process.env };
    env.PATH = `${bin}:${process.env.PATH}`;
    env.TMPDIR = directory;
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ["harness/src/security/audit.mjs"],
      { encoding: "utf8", env, timeout: 5000 },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^audit-policy-failed;/);
    assert.equal(result.stderr.includes("private-audit"), false);
    const entries = readdirSync(directory).filter((name) =>
      name.startsWith("fleetiq-harness-audit-"),
    );
    assert.equal(entries.length, 1);
    const evidence = join(directory, entries[0] ?? "missing");
    assert.equal(statSync(evidence).mode & 0o777, 0o700);
    for (const name of ["native.json", "stderr.txt", "status.json"])
      assert.equal(statSync(join(evidence, name)).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(join(evidence, "native.json"), "utf8"),
      "private-audit-output\n",
    );
    assert.equal(
      readFileSync(join(evidence, "stderr.txt"), "utf8"),
      "private-audit-error\n",
    );
    assert.equal(
      JSON.parse(readFileSync(join(evidence, "status.json"), "utf8")).status,
      2,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
