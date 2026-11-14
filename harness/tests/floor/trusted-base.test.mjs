import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseDocument } from "yaml";
import { fixture } from "../../support/floor-fixture.mjs";

test("PR shell uses the trusted base checker despite candidate tampering and rejects missing bootstrap", (context) => {
  const { root, write, git, base } = fixture(context);
  const script = parseDocument(
    readFileSync(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  ).getIn(["jobs", "check", "steps", 5, "run"]);
  assert.equal(typeof script, "string");
  write("tools/floor.mjs", 'console.log("candidate-bypassed");');

  /** Executes the real workflow body with only a controlled event base. @param {string} revision */
  function run(revision) {
    return spawnSync("bash", ["-e", "-c", String(script)], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, BASE_SHA: revision },
    });
  }
  assert.equal(run(base).status, 1);
  write(
    "tools/floor.mjs",
    readFileSync(
      new URL("../../src/verification/floor.mjs", import.meta.url),
      "utf8",
    ),
  );
  git(["add", "tools/floor.mjs"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "trusted checker",
  ]);
  const trusted = git(["rev-parse", "HEAD"]);
  symlinkSync(
    new URL("../../../node_modules", import.meta.url).pathname,
    join(root, "node_modules"),
    "dir",
  );
  write("tools/floor.mjs", 'console.log("candidate-bypassed");');
  write(
    "src/new.ts",
    "// @ts-ignore confidential-fixture\nexport const value = 1;",
  );
  const result = run(trusted);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /suppression-added/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /candidate-bypassed|confidential-fixture/,
  );

  // The relocated base must win even when its legacy checker is a no-op.
  write(
    "harness/src/verification/floor.mjs",
    readFileSync(
      new URL("../../src/verification/floor.mjs", import.meta.url),
      "utf8",
    ),
  );
  git(["add", "harness/src/verification/floor.mjs", "tools/floor.mjs"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "relocated trusted checker",
  ]);
  const relocatedBase = git(["rev-parse", "HEAD"]);
  write(
    "harness/src/verification/floor.mjs",
    'console.log("candidate-bypassed");',
  );
  const relocated = run(relocatedBase);
  assert.equal(relocated.status, 1);
  assert.match(relocated.stderr, /suppression-added/);
  assert.doesNotMatch(
    relocated.stdout + relocated.stderr,
    /candidate-bypassed|confidential-fixture/,
  );
});
