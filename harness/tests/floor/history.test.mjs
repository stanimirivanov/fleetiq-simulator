import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkFloor } from "../../src/verification/floor.mjs";
import { fixture } from "../../support/floor-fixture.mjs";

test("floor detects staged, unstaged, committed and untracked changes", (context) => {
  const { root, base, write, git } = fixture(context);
  write("src/new.ts", "// @ts-ignore\nexport const count = 2;");
  assert.ok(checkFloor(base, root).includes("suppression-added"));
  git(["add", "."]);
  assert.ok(checkFloor(base, root).includes("suppression-added"));
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "violation",
  ]);
  assert.ok(checkFloor(base, root).includes("suppression-added"));
});

test("floor fails closed for invalid, missing and unrelated baselines and hides private content", (context) => {
  const { root, base, write, git } = fixture(context);
  assert.throws(() => checkFloor("main", root), /baseline-invalid/);
  assert.throws(() => checkFloor("0".repeat(40), root), /baseline-unavailable/);
  git(["checkout", "--orphan", "other"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "unrelated",
  ]);
  assert.throws(() => checkFloor(base, root), /baseline-not-ancestor/);
  git(["checkout", "main"]);
  write(
    "src/private-fixture.ts",
    "// @ts-ignore confidential-fixture\nexport const value = 1;",
  );
  const result = spawnSync(
    process.execPath,
    [
      new URL("../../src/verification/floor.mjs", import.meta.url).pathname,
      base,
    ],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /suppression-added/);
  assert.doesNotMatch(result.stderr, /confidential-fixture|private-fixture/);
});
