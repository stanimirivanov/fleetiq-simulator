import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkInventory, groups } from "../../src/verification/coverage.mjs";

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
  const module = pathToFileURL(
    join(process.cwd(), "harness/src/verification/coverage.mjs"),
  ).href;
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

test("coverage thresholds reject an uncovered branch", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-coverage-"));
  try {
    const fixture = join(directory, "fixture.ts");
    const driver = join(directory, "driver.test.mjs");
    writeFileSync(
      driver,
      'import { choose } from "./fixture.ts";\nchoose(true);\n',
    );
    const command = [
      "--test",
      "--experimental-test-coverage",
      "--test-coverage-branches=85",
      "--test-coverage-include=fixture.ts",
      "driver.test.mjs",
    ];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = () =>
      spawnSync(process.execPath, command, {
        cwd: directory,
        encoding: "utf8",
        env,
      });
    const source =
      "export function choose(value: boolean) {\n  if (value) {\n    return 1;\n  }\n  return 0;\n}\n";
    writeFileSync(fixture, source);
    const incomplete = run();
    assert.equal(incomplete.status, 1, incomplete.stdout + incomplete.stderr);
    assert.match(
      incomplete.stdout + incomplete.stderr,
      /branch coverage.*(?:does not meet|below).*threshold/i,
    );
    writeFileSync(
      driver,
      'import { choose } from "./fixture.ts";\nchoose(true);\nchoose(false);\n',
    );
    assert.equal(run().status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("crash workers publish complete native coverage before advertising every kill boundary", {
  timeout: 20000,
}, async () => {
  const { FileStore } = await import("../../../src/storage/spool.ts");
  const { DurableSpool } = await import("../../../src/session/spool.ts");
  const { binding, limits, work } = await import(
    "../../../tests/support/playback/spool-fixture.ts"
  );
  const { setTimeout: delay } = await import("node:timers/promises");
  for (const action of ["advance", "prepare", "ack", "hold"]) {
    for (const stage of action === "hold"
      ? ["hold"]
      : ["before-rename", "after-rename", "after-sync"]) {
      const directory = mkdtempSync(join(tmpdir(), "fleetiq-crash-coverage-"));
      const state = join(directory, "state");
      const coverage = join(directory, "coverage");
      mkdirSync(state, { mode: 0o700 });
      mkdirSync(coverage);
      const store = new FileStore(state);
      try {
        const spool = new DurableSpool(store, binding, work, limits, false);
        if (action !== "advance") spool.advance();
        if (action === "ack") spool.prepare();
      } finally {
        store.close();
      }
      const marker = join(directory, "ready");
      const env = { ...process.env };
      env.NODE_V8_COVERAGE = coverage;
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(
        process.execPath,
        [
          "tests/support/processes/spool-crash.ts",
          state,
          action,
          stage,
          marker,
        ],
        { env, stdio: "ignore" },
      );
      const closed = once(child, "close");
      try {
        const until = Date.now() + 3000;
        while (!existsSync(marker) && Date.now() < until) await delay(10);
        assert.ok(
          existsSync(marker),
          `worker did not reach ${action}/${stage}`,
        );
        const profiles = readdirSync(coverage).filter(
          (file) =>
            file.startsWith(`coverage-${child.pid}-`) && file.endsWith(".json"),
        );
        assert.ok(
          profiles.length > 0,
          `coverage missing at ${action}/${stage}`,
        );

        /** @type {{url: string, functions: {ranges: {count: number}[]}[]}[]} */
        const scripts = profiles.flatMap(
          (file) =>
            JSON.parse(readFileSync(join(coverage, file), "utf8")).result,
        );
        assert.ok(
          scripts.some(
            (script) =>
              script.url.endsWith("/src/session/spool.ts") &&
              script.functions.some((fn) =>
                fn.ranges.some((range) => range.count > 0),
              ),
          ),
        );
      } finally {
        child.kill("SIGKILL");
        const [code, signal] = await closed;
        try {
          assert.equal(code, null);
          assert.equal(signal, "SIGKILL");
          for (const file of readdirSync(coverage))
            JSON.parse(readFileSync(join(coverage, file), "utf8"));
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }
});
