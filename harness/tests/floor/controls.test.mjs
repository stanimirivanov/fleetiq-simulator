import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFloor } from "../../src/verification/floor.mjs";
import { fixture, original } from "../../support/floor-fixture.mjs";

test("floor rejects new suppression comments without flagging their string fixtures", (context) => {
  const { root, base, write } = fixture(context);
  for (const directive of [
    "@ts-ignore",
    "@ts-expect-error",
    "@ts-nocheck",
    "biome-ignore lint: reason",
    "eslint-disable",
    "node:coverage disable",
    "c8 ignore next",
    "istanbul ignore next",
  ]) {
    write("src/new.ts", `// ${directive}\nexport const count = 2;`);
    assert.ok(checkFloor(base, root).includes("suppression-added"), directive);
  }
});

test("floor recognizes namespace imports and callback-owned skip controls", (context) => {
  const { root, base, write } = fixture(context);
  for (const addition of [
    'import * as suite from "node:test"; suite.test.skip("ignored", () => {});',
    'spec("ignored", (caseContext) => { caseContext.skip("reason"); });',
  ]) {
    write("tests/example.test.mjs", `${original}\n${addition}`);
    assert.ok(checkFloor(base, root).includes("test-disabled-or-focused"));
  }
});

test("floor rejects literal computed skip and focus options on a retained test", (context) => {
  const { root, base, write } = fixture(context);
  for (const option of [
    '["skip"]: true',
    "['only']: true",
    '[`todo`]: "later"',
    '["sk\\u0069p"]: true',
    '"skip": true',
    "only: true",
  ]) {
    write(
      "tests/example.test.mjs",
      `import { test as spec } from "node:test"; spec("retained", { ${option} }, () => {});`,
    );
    assert.deepEqual(
      checkFloor(base, root),
      ["test-disabled-or-focused"],
      option,
    );
  }
});

test("floor recognizes literal computed calls through aliases and namespaces", (context) => {
  const { root, base, write } = fixture(context);
  for (const addition of [
    'spec["skip"]("new", () => {});',
    "spec['only'](\"new\", () => {});",
    'spec[`todo`]("new");',
    'spec["sk\\u0069p"]("new", () => {});',
    'import * as suite from "node:test"; suite["test"]["skip"]("new", () => {});',
    'import * as suite from "node:test"; suite.test["only"]("new", () => {});',
    'import * as suite from "node:test"; suite["test"].skip("new", () => {});',
  ]) {
    write("tests/example.test.mjs", `${original}\n${addition}`);
    assert.deepEqual(
      checkFloor(base, root),
      ["test-disabled-or-focused"],
      addition,
    );
  }
});

test("floor recognizes computed controls on the retained test callback", (context) => {
  const { root, base, write } = fixture(context);
  for (const method of [
    '["skip"]("reason")',
    "['todo'](\"later\")",
    '["runOnly"](true)',
    '.skip("reason")',
  ]) {
    write(
      "tests/example.test.mjs",
      `import { test as spec } from "node:test"; spec("retained", (caseContext) => { caseContext${method}; });`,
    );
    assert.deepEqual(
      checkFloor(base, root),
      ["test-disabled-or-focused"],
      method,
    );
  }
});

test("floor permits false literal options and ignores computed-looking fixture strings", (context) => {
  const { root, base, write } = fixture(context);
  for (const options of [
    '["skip"]: false',
    "['only']: false",
    "[`todo`]: false",
    '"skip": false',
    "skip: false",
  ]) {
    write(
      "tests/example.test.mjs",
      `import { test as spec } from "node:test"; spec("retained", { ${options} }, () => {}); const fixture = 'spec["skip"]("example")';`,
    );
    assert.deepEqual(checkFloor(base, root), [], options);
  }
});

test("floor does not evaluate computed identifiers or expressions", (context) => {
  const { root, base, write } = fixture(context);
  write(
    "tests/example.test.mjs",
    `${original}\nconst skip = "ordinary"; spec("added", { [skip]: true, [(() => { throw new Error("must-not-execute"); })()]: true }, () => {});`,
  );
  assert.deepEqual(checkFloor(base, root), []);
});
