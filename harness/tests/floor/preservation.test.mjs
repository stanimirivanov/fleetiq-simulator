import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkFloor } from "../../src/verification/floor.mjs";
import { fixture, original } from "../../support/floor-fixture.mjs";

test("floor permits added tests, ordinary edits, and fixture strings resembling suppressions", (context) => {
  const { root, base, write } = fixture(context);
  write(
    "tests/example.test.mjs",
    `${original}\nspec("added", () => {});\nconst fixture = '// @ts-ignore\\ntest.skip("example")';`,
  );
  write("src/new.ts", "// This explains ownership.\nexport const count = 2;");
  assert.deepEqual(checkFloor(base, root), []);
});

test("floor rejects focused, disabled and removed tests including aliases and multiline options", (context) => {
  const { root, base, write } = fixture(context);
  for (const addition of [
    'spec.skip("ignored", () => {});',
    'spec.only("focused", () => {});',
    'spec.todo("later");',
    'spec("ignored", {\n skip: true\n}, () => {});',
    'spec("later", { todo: "reason" }, () => {});',
  ]) {
    write("tests/example.test.mjs", `${original}\n${addition}`);
    assert.ok(checkFloor(base, root).includes("test-disabled-or-focused"));
  }
  write("tests/example.test.mjs", 'import { test } from "node:test";');
  assert.ok(checkFloor(base, root).includes("test-removed"));
  rmSync(join(root, "tests/example.test.mjs"));
  assert.ok(checkFloor(base, root).includes("test-removed"));
});

test("floor permits literal title renames with the complete remaining call unchanged", (context) => {
  const { root, base, write } = fixture(context);
  write("tests/example.test.mjs", original.replace('"retained"', '"renamed"'));
  assert.deepEqual(checkFloor(base, root), []);
  write("tests/example.test.mjs", original.replace('"retained"', "`renamed`"));
  assert.deepEqual(checkFloor(base, root), []);
});

test("floor preserves rename duplicate counts and rejects altered callbacks or options", (context) => {
  const { root, write, git } = fixture(context);
  const source =
    'import { test as spec } from "node:test"; spec("first", { timeout: 100 }, () => { assert.equal(1, 1); }); spec("second", { timeout: 100 }, () => { assert.equal(1, 1); });';
  write("tests/example.test.mjs", source);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "assertions",
  ]);
  const base = git(["rev-parse", "HEAD"]);
  write("tests/example.test.mjs", source.replace('"first"', '"renamed"'));
  assert.deepEqual(checkFloor(base, root), []);
  for (const changed of [
    source.replace('"first"', '"renamed"').replace("assert.equal(1, 1);", ""),
    source
      .replace('"first"', '"renamed"')
      .replace("timeout: 100", "timeout: 200"),
    source
      .replace('"first"', '"renamed"')
      .replace("assert.equal(1, 1);", "assert.equal(1, 2);"),
    source.slice(0, source.indexOf(' spec("second"')),
  ]) {
    write("tests/example.test.mjs", changed);
    assert.ok(checkFloor(base, root).includes("test-removed"));
  }
});

test("floor does not collapse duplicate titles or duplicate shapes during maintenance", (context) => {
  const { root, write, git } = fixture(context);
  write(
    "tests/example.test.mjs",
    `${original}\nspec("retained", () => { assert.ok(true); });`,
  );
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "duplicates",
  ]);
  const base = git(["rev-parse", "HEAD"]);
  write(
    "tests/example.test.mjs",
    `${original.replace('"retained"', '"renamed"')}\nspec("retained", () => { assert.ok(true); });`,
  );
  assert.deepEqual(checkFloor(base, root), []);
  write("tests/example.test.mjs", original);
  assert.ok(checkFloor(base, root).includes("test-removed"));
});

test("floor keeps literal rename allowances separate from dynamic titles and changed targets", (context) => {
  const { root, base, write } = fixture(context);
  write(
    "tests/example.test.mjs",
    'import { test } from "node:test"; test("renamed", () => {});',
  );
  assert.ok(checkFloor(base, root).includes("test-removed"));
  write(
    "tests/example.test.mjs",
    'import { test as spec } from "node:test"; const title = "renamed"; spec(title, () => {});',
  );
  assert.ok(checkFloor(base, root).includes("test-removed"));
  write("tests/moved.test.mjs", original);
  rmSync(join(root, "tests/example.test.mjs"));
  assert.deepEqual(checkFloor(base, root), []);
});
