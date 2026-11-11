import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseDocument } from "yaml";
import { checkFloor } from "../tools/floor.mjs";

const original =
  'import { test as spec } from "node:test";\nspec("retained", () => {});\n';

/** Owns a real Git baseline; fixtures never touch the working repository. @param {import("node:test").TestContext} context */
function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), "fleetiq-floor-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  /** Writes only into this test's checkout. @param {string} path @param {string} text */
  function write(path, text) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  /** Runs bounded Git commands with a synthetic identity. @param {string[]} args */
  function git(args) {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "--initial-branch=main"]);
  write("tests/example.test.mjs", original);
  write(
    "package.json",
    JSON.stringify({ scripts: { check: "pnpm test", test: "node --test" } }),
  );
  write(
    "tools/coverage.mjs",
    'export const groups = [{ name: "wire", lines: 90, branches: 85 }];',
  );
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "baseline",
  ]);
  const base = git(["rev-parse", "HEAD"]);
  return { root, base, write, git };
}

test("floor permits added tests, ordinary edits, and fixture strings resembling suppressions", (context) => {
  const { root, base, write } = fixture(context);
  write(
    "tests/example.test.mjs",
    `${original}\nspec("added", () => {});\nconst fixture = '// @ts-ignore\\ntest.skip("example")';`,
  );
  write("src/new.ts", "// This explains ownership.\nexport const count = 2;");
  assert.deepEqual(checkFloor(base, root), []);
});

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

test("floor rejects removed gates and reduced coverage but permits adding itself", (context) => {
  const { root, base, write } = fixture(context);
  write("package.json", JSON.stringify({ scripts: { check: "echo success" } }));
  assert.ok(checkFloor(base, root).includes("verification-script-changed"));
  write(
    "package.json",
    JSON.stringify({
      scripts: {
        check: "pnpm floor && pnpm test",
        test: "node --test",
        floor: "node tools/floor.mjs",
      },
    }),
  );
  assert.deepEqual(checkFloor(base, root), []);
  write(
    "tools/coverage.mjs",
    'export const groups = [{ name: "wire", lines: 89, branches: 85 }];',
  );
  assert.ok(checkFloor(base, root).includes("coverage-floor-lowered"));
  write(
    "tools/coverage.mjs",
    'const decoy = { name: "wire", lines: 90, branches: 85 }; export const groups = dynamic;',
  );
  assert.ok(checkFloor(base, root).includes("coverage-floor-lowered"));
  write("tools/coverage.mjs", "export const groups = [];");
  assert.ok(checkFloor(base, root).includes("coverage-floor-lowered"));
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
    [new URL("../tools/floor.mjs", import.meta.url).pathname, base],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /suppression-added/);
  assert.doesNotMatch(result.stderr, /confidential-fixture|private-fixture/);
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

test("PR shell uses the trusted base checker despite candidate tampering and rejects missing bootstrap", (context) => {
  const { root, write, git, base } = fixture(context);
  const script = parseDocument(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
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
    readFileSync(new URL("../tools/floor.mjs", import.meta.url), "utf8"),
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
    new URL("../node_modules", import.meta.url).pathname,
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
