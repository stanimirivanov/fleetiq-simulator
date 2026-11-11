import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkInventory, groups } from "../tools/coverage.mjs";

test("every test and source belongs to exactly one coverage group", () => {
  const tests = groups.flatMap((group) => group.tests);
  const sources = groups.flatMap((group) => group.sources);
  assert.deepEqual(checkInventory(groups, tests, sources), []);
  assert.deepEqual(
    checkInventory(groups, [...tests, "tests/unregistered.test.ts"], sources),
    ["test-inventory"],
  );
  assert.deepEqual(checkInventory(groups, tests.slice(1), sources), [
    "test-inventory",
  ]);
  assert.deepEqual(checkInventory(groups, tests, sources.slice(1)), [
    "source-inventory",
  ]);
  assert.deepEqual(
    checkInventory(groups, tests, [...sources, "src/missing.ts"]),
    ["source-inventory"],
  );
  const first = groups[0];
  assert.ok(first);
  assert.deepEqual(checkInventory([...groups, first], tests, sources), [
    "duplicate-group",
    "duplicate-suite",
    "duplicate-source",
  ]);
});

test("native coverage counts a subprocess-only source once and rejects missing or uncovered files", () => {
  const root = mkdtempSync(join(tmpdir(), "fleetiq-coverage-group-"));
  const module = pathToFileURL(join(process.cwd(), "tools/coverage.mjs")).href;
  const script = `import {runGroup} from ${JSON.stringify(module)}; process.exitCode = await runGroup(JSON.parse(process.argv[2]), process.argv[3]);`;
  const group = {
    name: "canary",
    tests: ["tests/probe.test.mjs"],
    sources: ["src/probe.ts"],
    lines: 90,
    branches: 85,
  };
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (sources = group.sources) =>
    spawnSync(
      process.execPath,
      [join(root, "driver.mjs"), JSON.stringify({ ...group, sources }), root],
      { encoding: "utf8", env, timeout: 30_000 },
    );
  try {
    writeFileSync(join(root, "driver.mjs"), script);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(
      join(root, "src/probe.ts"),
      "export const answer: number = 42;\n",
    );
    writeFileSync(
      join(root, "tests/probe.test.mjs"),
      `
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {appendFileSync} from "node:fs";
test("child-only", () => {
  appendFileSync("runs", "one\\n");
  assert.equal(spawnSync(process.execPath, ["src/probe.ts"]).status, 0);
});
`,
    );
    const clean = run();
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.equal(readFileSync(join(root, "runs"), "utf8"), "one\n");
    assert.match(clean.stdout, /coverage-group canary.*lines=1\/1/);
    writeFileSync(
      join(root, "src/unloaded.ts"),
      "export const neverLoaded = true;\n",
    );
    const missing = run([...group.sources, "src/unloaded.ts"]);
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(missing.stderr, /coverage-inventory/);
    writeFileSync(
      join(root, "src/probe.ts"),
      `export function choose(value: boolean) {
  if (value) {
    return 1;
  }
  return 0;
}
choose(true);
`,
    );
    const uncovered = run();
    assert.equal(uncovered.status, 1, uncovered.stdout);
    assert.match(uncovered.stderr, /coverage-threshold/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
