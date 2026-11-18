import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const advisoryId = "GHSA-fc5q-39xc-vjpf";
const expiry = "2026-11-25T00:00:00Z";
const lockHash =
  "5844c38ad0879d637de831d1e8ac90edd495ee935925eaf93fb36f73323ddb9a";
const manifestHash =
  "0d60798ae80c194b56ef507a4881294b04dd42097b858d7f2c0d74d27382ea7b";
const approvedPaths = [
  ".>@stylistic/eslint-plugin>picomatch",
  ".>@typescript-eslint/parser>@typescript-eslint/typescript-estree>tinyglobby>picomatch",
  ".>@typescript-eslint/parser>@typescript-eslint/typescript-estree>tinyglobby>fdir>picomatch",
  ".>eslint-plugin-jsdoc>@typescript-eslint/utils>@typescript-eslint/typescript-estree>tinyglobby>picomatch",
  ".>eslint-plugin-jsdoc>@typescript-eslint/utils>@typescript-eslint/typescript-estree>tinyglobby>fdir>picomatch",
].sort();

/** Narrows native audit records without trusting JSON arrays, null or error responses.
 * @param {unknown} value @returns {Record<string, unknown>}
 */
function record(value) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}

/** Fingerprints the approved dependency input without coupling future script activation to it.
 * @param {string} text
 */
function dependencyHash(text) {
  const manifest = record(JSON.parse(text));
  delete manifest.scripts;
  return hash(
    JSON.stringify(Object.fromEntries(Object.entries(manifest).sort())),
  );
}

/** Hashes exact lock bytes; no dependency paths or package data enter public diagnostics.
 * @param {string} text
 */
function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Evaluates the complete native audit before considering one owner-approved,
 * expiring tooling exception. Unknown schema, status/count disagreement and
 * unrelated high/critical findings fail; lower severities keep the existing bar.
 * @param {string} output @param {number | null} status
 * @param {{lock: string, manifest: string, approval: string}} scope
 * @param {number} now
 */
export function evaluateAudit(output, status, scope, now) {
  assert.equal(hash(scope.lock), lockHash);
  assert.equal(dependencyHash(scope.manifest), manifestHash);
  const audit = record(JSON.parse(output));
  assert.deepEqual(Object.keys(audit).sort(), ["advisories", "metadata"]);
  const advisories = record(audit.advisories);
  const reported = record(record(audit.metadata).vulnerabilities);

  /** @type {Record<string, number>} */
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  let exceptions = 0;
  for (const [id, raw] of Object.entries(advisories)) {
    const advisory = record(raw);
    assert(Number.isSafeInteger(advisory.id) && String(advisory.id) === id);
    assert(
      typeof advisory.severity === "string" &&
        Object.hasOwn(counts, advisory.severity),
    );
    assert(
      typeof advisory.github_advisory_id === "string" &&
        /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u.test(
          advisory.github_advisory_id,
        ),
    );
    assert(
      typeof advisory.module_name === "string" &&
        advisory.module_name.length > 0,
    );
    assert(typeof advisory.vulnerable_versions === "string");
    assert(
      advisory.patched_versions === null ||
        typeof advisory.patched_versions === "string",
    );
    assert(Array.isArray(advisory.findings) && advisory.findings.length > 0);
    const findings = advisory.findings.map((value) => {
      const finding = record(value);
      assert(typeof finding.version === "string" && finding.version.length > 0);
      assert(Array.isArray(finding.paths) && finding.paths.length > 0);
      assert(
        finding.paths.every(
          (path) => typeof path === "string" && path.length > 0,
        ),
      );
      assert.equal(new Set(finding.paths).size, finding.paths.length);
      for (const key of ["dev", "optional", "bundled"])
        assert(typeof finding[key] === "boolean");
      return { ...finding, paths: [...finding.paths].sort() };
    });
    counts[advisory.severity] = (counts[advisory.severity] ?? 0) + 1;
    if (advisory.severity !== "high" && advisory.severity !== "critical")
      continue;
    assert.equal(advisory.severity, "high");
    assert.equal(advisory.github_advisory_id, advisoryId);
    assert.equal(advisory.module_name, "picomatch");
    assert.equal(advisory.vulnerable_versions, "<=4.0.7");
    assert.equal(advisory.patched_versions, null);
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0], {
      version: "4.0.7",
      paths: [...approvedPaths],
      dev: true,
      optional: false,
      bundled: false,
    });
    exceptions++;
  }
  assert.deepEqual(reported, counts);
  assert.equal(status, Object.keys(advisories).length > 0 ? 1 : 0);
  if (exceptions === 0) return "audit-clean high=0 critical=0";
  assert.equal(exceptions, 1);
  const approval = record(JSON.parse(scope.approval));
  assert.deepEqual(approval, {
    approved: true,
    advisory: advisoryId,
    owner: "stanimirivanov",
    expiresAt: expiry,
    lockSha256: lockHash,
  });
  assert(
    Number.isFinite(now) &&
      now >= Date.parse("2026-11-18T00:00:00Z") &&
      now < Date.parse(expiry),
  );
  return `audit-exception advisory=${advisoryId} owner=stanimirivanov expires=${expiry}`;
}

/**
 * Runs the unfiltered live native audit in the private harness. Retains raw output
 * with native exit status in an exclusive private temporary directory, including
 * on failure. Only fixed reviewed policy diagnostics reach stdout/stderr.
 * @param {string} root
 */
export function auditHarness(root) {
  const configs = [
    ".npmrc",
    ".pnpmfile.cjs",
    "pnpm-workspace.yaml",
    "pnpm-workspace.yml",
  ];
  assert(
    ![root, dirname(root)].some((directory) =>
      configs.some((name) => existsSync(join(directory, name))),
    ),
    "audit-config-refused",
  );
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "config/audit-exception.json",
  ]) {
    const path = join(root, name);
    assert(lstatSync(path).isFile() && realpathSync(path) === path);
  }
  assert.equal(
    hash(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")),
    lockHash,
  );
  assert.equal(
    dependencyHash(readFileSync(join(root, "package.json"), "utf8")),
    manifestHash,
  );
  const result = spawnSync("pnpm", ["audit", "--json"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      npm_config_userconfig: "/dev/null",
      npm_config_globalconfig: "/dev/null",
      npm_config_registry: "https://registry.npmjs.org",
    },
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-harness-audit-"));
  writeFileSync(join(directory, "native.json"), result.stdout ?? "", {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(join(directory, "stderr.txt"), result.stderr ?? "", {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(
    join(directory, "status.json"),
    JSON.stringify({
      status: result.status,
      signal: result.signal,
      toolError: Boolean(result.error),
    }),
    { flag: "wx", mode: 0o600 },
  );
  assert(!result.error && result.signal === null);
  return evaluateAudit(
    result.stdout,
    result.status,
    {
      lock: readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
      manifest: readFileSync(join(root, "package.json"), "utf8"),
      approval: readFileSync(join(root, "config/audit-exception.json"), "utf8"),
    },
    Date.now(),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(
      `${auditHarness(fileURLToPath(new URL("../../", import.meta.url)))}\n`,
    );
  } catch {
    process.stderr.write(
      "audit-policy-failed; Inspect the private native audit evidence, approved scope and expiry.\n",
    );
    process.exitCode = 1;
  }
}
