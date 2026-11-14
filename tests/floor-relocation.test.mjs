import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkFloor } from "../tools/floor.mjs";

const oldCoverage = "tools/coverage.mjs";
const newCoverage = "harness/src/verification/coverage.mjs";
const policy = 'export const groups = [{name:"wire",lines:90,branches:85}];';
const declaration =
  'import test from "node:test"; test("retained", () => {});\n';

/** Creates an isolated real Git baseline with protected gate scripts and coverage. @param {import("node:test").TestContext} context */
function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), "sim-relocation-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (/** @type {string} */ path, /** @type {string} */ text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const git = (/** @type {string[]} */ args) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const scripts = {
    check: "pnpm test:coverage",
    "test:coverage": `node ${oldCoverage} && pnpm test:bounds`,
    "test:bounds": "node tools/fleet-bounds.mjs",
    test: "node --test tests/*.test.ts tests/*.test.mjs",
  };
  const manifest = (/** @type {Record<string,string>} */ overrides = {}) =>
    write(
      "package.json",
      JSON.stringify({ scripts: { ...scripts, ...overrides } }),
    );
  const commit = () => {
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "--initial-branch=main"]);
  manifest();
  write(oldCoverage, policy);
  write(
    "tests/original.test.mjs",
    declaration + declaration.replaceAll("retained", "second"),
  );
  const base = commit();
  return { root, write, manifest, commit, base };
}

test("floor permits only the reviewed coverage move and preserves its active thresholds across baselines", (context) => {
  const { root, base, write, manifest, commit } = fixture(context);
  write(newCoverage, policy);
  rmSync(join(root, oldCoverage));
  manifest({ "test:coverage": `node ${newCoverage} && pnpm test:bounds` });
  assert.deepEqual(checkFloor(base, root), []);
  const moved = commit();
  write(newCoverage, policy.replace("90", "89"));
  assert.ok(checkFloor(moved, root).includes("coverage-floor-lowered"));
  assert.ok(checkFloor(base, root).includes("coverage-floor-lowered"));
  rmSync(join(root, newCoverage));
  assert.ok(checkFloor(moved, root).includes("coverage-floor-lowered"));
});

test("floor rejects weak or unreadable relocated coverage even when a strong legacy copy remains", (context) => {
  const { root, base, write, manifest } = fixture(context);
  manifest({ "test:coverage": `node ${newCoverage} && pnpm test:bounds` });
  for (const text of [
    policy.replace("85", "84"),
    "export const groups = [];",
    "export const groups = unknown;",
    "export const groups = [{name:'wire',lines:90}];",
  ]) {
    write(newCoverage, text);
    assert.ok(checkFloor(base, root).includes("coverage-floor-lowered"));
  }
  rmSync(join(root, newCoverage));
  assert.ok(checkFloor(base, root).includes("coverage-floor-lowered"));
});

test("floor admits exact discovery and gate destinations but rejects script bypasses and candidate exceptions", (context) => {
  const { root, base, write, manifest } = fixture(context);
  write(
    "harness/src/qualification/fleet/fleet-bounds.mjs",
    "export const probe = true;",
  );
  manifest({
    "test:bounds": "node harness/src/qualification/fleet/fleet-bounds.mjs",
    test: 'node --test "tests/**/*.test.ts" "tests/**/*.test.mjs"',
  });
  assert.deepEqual(checkFloor(base, root), []);
  for (const command of [
    "node harness/other.mjs",
    "true",
    "pnpm --dir harness test:bounds",
    "node harness/src/qualification/fleet/fleet-bounds.mjs || true",
    "node harness/src/qualification/fleet/fleet-bounds.mjs --skip",
  ]) {
    write(
      "harness/relocations.json",
      JSON.stringify({ "test:bounds": command }),
    );
    manifest({ "test:bounds": command });
    assert.ok(checkFloor(base, root).includes("verification-script-changed"));
  }
});

test("floor accepts each reviewed direct gate binding without permitting operator or argument changes", (context) => {
  const { root, write, manifest, commit } = fixture(context);
  const pairs = [
    ["floor", "tools/floor.mjs", "harness/src/verification/floor.mjs"],
    [
      "architecture",
      "tools/architecture.mjs",
      "harness/src/architecture/architecture.mjs",
    ],
    ["secrets", "tools/secrets.mjs", "harness/src/security/secrets.mjs"],
    [
      "test:platform",
      "tools/platform-decoder.mjs",
      "harness/src/qualification/platform/platform-decoder.mjs",
    ],
    [
      "image:qualify",
      "tools/image-qualify.mjs",
      "harness/src/qualification/image/image-qualify.mjs",
    ],
    [
      "test:reference",
      "tests/codec8-oracle.test.ts",
      "tests/wire/codec8-oracle.test.ts",
    ],
  ];
  manifest(
    Object.fromEntries(pairs.map(([name, old]) => [name, `node ${old}`])),
  );
  const base = commit();
  for (const [name, _old, next] of pairs) {
    if (!name || !next) throw new Error("invalid-fixture");
    write(next, "export const fixture = true;");
    const overrides = Object.fromEntries(
      pairs.map(([key, old]) => [key, `node ${old}`]),
    );
    manifest({ ...overrides, [name]: `node ${next}` });
    assert.deepEqual(checkFloor(base, root), []);
    manifest({ ...overrides, [name]: `node ${next} || true` });
    assert.ok(checkFloor(base, root).includes("verification-script-changed"));
  }
});

test("floor rejects missing and symlinked gate destinations", (context) => {
  const { root, base, write, manifest } = fixture(context);
  const target = "harness/src/qualification/fleet/fleet-bounds.mjs";
  manifest({ "test:bounds": `node ${target}` });
  assert.ok(checkFloor(base, root).includes("verification-script-changed"));
  write("harness/target.mjs", "export const probe = true;");
  mkdirSync(dirname(join(root, target)), { recursive: true });
  symlinkSync(join(root, "harness/target.mjs"), join(root, target));
  assert.throws(() => checkFloor(base, root), /candidate-unreadable/);
  rmSync(join(root, target));
  rmSync(join(root, "harness/src/qualification/fleet"), { recursive: true });
  write("harness/fleet-bounds.mjs", "export const probe = true;");
  symlinkSync(
    join(root, "harness"),
    join(root, "harness/src/qualification/fleet"),
    "dir",
  );
  assert.ok(checkFloor(base, root).includes("verification-script-changed"));
});

test("splitting suites preserves duplicate declarations and still rejects removal and computed focus", (context) => {
  const { root, write, commit } = fixture(context);
  write("tests/original.test.mjs", declaration + declaration);
  const baseline = commit();
  write("tests/nested/first.test.mjs", declaration);
  write("tests/nested/second.test.mjs", declaration);
  rmSync(join(root, "tests/original.test.mjs"));
  assert.deepEqual(checkFloor(baseline, root), []);
  write("tests/nested/second.test.mjs", "");
  assert.ok(checkFloor(baseline, root).includes("test-removed"));
  write(
    "tests/nested/second.test.mjs",
    declaration.replace('test("retained"', 'test["only"]("retained"'),
  );
  assert.ok(checkFloor(baseline, root).includes("test-disabled-or-focused"));
});
