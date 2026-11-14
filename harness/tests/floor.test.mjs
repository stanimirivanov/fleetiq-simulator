import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { checkFloor } from "../src/verification/floor.mjs";

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
    [new URL("../src/verification/floor.mjs", import.meta.url).pathname, base],
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
      new URL("../../.github/workflows/ci.yml", import.meta.url),
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
      new URL("../src/verification/floor.mjs", import.meta.url),
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
    new URL("../../node_modules", import.meta.url).pathname,
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
      new URL("../src/verification/floor.mjs", import.meta.url),
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

test("floor permits additive namespaced verification commands but rejects shell bypasses", (context) => {
  const { root, base, write } = fixture(context);
  const scripts = {
    test: "node --test",
    "check:extra": "node extra.mjs",
    "lint:extra": "node lint.mjs",
  };
  for (const command of [
    "pnpm test && pnpm check:extra",
    "pnpm test && pnpm check:extra && pnpm lint:extra",
  ]) {
    write(
      "package.json",
      JSON.stringify({ scripts: { ...scripts, check: command } }),
    );
    assert.deepEqual(checkFloor(base, root), [], command);
  }
  for (const command of [
    "pnpm test || pnpm check:extra",
    "pnpm test; pnpm check:extra",
    "pnpm test && pnpm check:extra || true",
    "pnpm test && pnpm check:extra # ignored",
    "pnpm test && pnpm check:extra\necho success",
    "pnpm test && pnpm check:extra &",
    "pnpm test && pnpm check:missing",
    "pnpm test && pnpm check:extra --ignore-failure",
    "pnpm test && pnpm install",
    "pnpm test && pnpm check:extra$(echo injected)",
    "echo success && pnpm check:extra",
  ]) {
    write(
      "package.json",
      JSON.stringify({ scripts: { ...scripts, check: command } }),
    );
    assert.ok(
      checkFloor(base, root).includes("verification-script-changed"),
      command,
    );
  }
});

test("additive gates preserve real shell failure and short-circuit behavior", (context) => {
  const { root, base, write } = fixture(context);
  const command = "pnpm test && pnpm check:extra";
  write(
    "package.json",
    JSON.stringify({
      scripts: {
        check: command,
        test: "node --test",
        "check:extra": "node extra.mjs",
      },
    }),
  );
  assert.deepEqual(checkFloor(base, root), []);
  write(
    "bin/pnpm",
    `#!/bin/sh
printf '%s\\n' "$1" >> "$FLEETIQ_CALL_LOG"
case "$1" in
  test) exit "$FLEETIQ_BASE_EXIT" ;;
  check:extra) exit "$FLEETIQ_ADDED_EXIT" ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(join(root, "bin/pnpm"), 0o700);
  for (const [baseline, added, expected, calls] of [
    [7, 0, 7, "test\n"],
    [0, 9, 9, "test\ncheck:extra\n"],
    [0, 0, 0, "test\ncheck:extra\n"],
  ]) {
    const log = join(root, "calls");
    write("calls", "");
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        FLEETIQ_CALL_LOG: log,
        FLEETIQ_BASE_EXIT: String(baseline),
        FLEETIQ_ADDED_EXIT: String(added),
      },
    });
    assert.equal(result.status, expected, result.stderr);
    assert.equal(readFileSync(log, "utf8"), calls);
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

test("floor rejects additive suffixes on ambiguous baseline shell syntax", (context) => {
  const { root, write, git } = fixture(context);
  for (const command of [
    "pnpm test # comment",
    "exit 0",
    "pnpm test; echo done",
  ]) {
    write(
      "package.json",
      JSON.stringify({ scripts: { check: command, test: "node --test" } }),
    );
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "legacy command",
    ]);
    const base = git(["rev-parse", "HEAD"]);
    write(
      "package.json",
      JSON.stringify({
        scripts: {
          check: `${command} && pnpm check:extra`,
          test: "node --test",
          "check:extra": "node extra.mjs",
        },
      }),
    );
    assert.ok(checkFloor(base, root).includes("verification-script-changed"));
  }
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

test("floor rejects ordinary and committed capture paths even without secret-like contents", (context) => {
  const { root, base, write, git } = fixture(context);
  write("nested/capture.bin", "innocuous synthetic fixture\n");
  git(["add", "nested/capture.bin"]);
  assert.ok(checkFloor(base, root).includes("private-path-tracked"));
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "capture fixture",
  ]);
  const committed = git(["rev-parse", "HEAD"]);
  assert.ok(checkFloor(committed, root).includes("private-path-tracked"));
});

test("ignore and floor policies cover force-added nested and case-variant private paths", (context) => {
  const { root, base, write, git } = fixture(context);
  write(
    ".gitignore",
    readFileSync(new URL("../../.gitignore", import.meta.url), "utf8"),
  );
  for (const path of [
    "private-record.json",
    "nested/PRIVATE-input.txt",
    "private-directory/record.json",
    "nested/record.BIN",
    "trace.pcap",
    "nested/TRACE.PCAPNG",
    "nested/capture.BIN/record.json",
  ]) {
    write(path, "innocuous synthetic fixture\n");
    assert.equal(git(["check-ignore", "--", path]), path);
    git(["add", "-f", "--", path]);
    assert.ok(checkFloor(base, root).includes("private-path-tracked"));
    git(["rm", "--cached", "--", path]);
    assert.deepEqual(checkFloor(base, root), []);
  }
});

test("floor permits textual hex fixtures and ignores untracked private artifacts", (context) => {
  const { root, base, write, git } = fixture(context);
  write(
    ".gitignore",
    readFileSync(new URL("../../.gitignore", import.meta.url), "utf8"),
  );
  write("tests/hex-fixture.ts", 'export const frame = "00000102";');
  git(["add", "tests/hex-fixture.ts"]);
  assert.deepEqual(checkFloor(base, root), []);
  write("private-record.json", "{}\n");
  write("capture.pcapng", "synthetic\n");
  assert.equal(
    git(["check-ignore", "--", "private-record.json", "capture.pcapng"]),
    "private-record.json\ncapture.pcapng",
  );
  assert.deepEqual(checkFloor(base, root), []);
});

test("private-path diagnostics never print the tracked filename", (context) => {
  const { root, base, write, git } = fixture(context);
  const path = "nested/private-\nconfidential-name.json";
  write(path, "{}\n");
  git(["add", "-f", "--", path]);
  const result = spawnSync(
    process.execPath,
    [new URL("../src/verification/floor.mjs", import.meta.url).pathname, base],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private-path-tracked/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /confidential-name|nested|private-\n/,
  );
});

test("pre-commit blocks private index paths before delegating to fast verification", (context) => {
  const { root, base, write, git } = fixture(context);
  const hook = readFileSync(
    new URL("../../.githooks/pre-commit", import.meta.url),
    "utf8",
  );
  write(".githooks/pre-commit", hook);
  write(
    "harness/src/verification/pre-commit.sh",
    readFileSync(
      new URL("../src/verification/pre-commit.sh", import.meta.url),
      "utf8",
    ),
  );
  write(
    "bin/pnpm",
    `#!/bin/sh
case "$1" in
  floor) exec "$FLEETIQ_NODE" "$FLEETIQ_CHECKER" "$FLEETIQ_BASE" ;;
  check:fast) printf '%s\\n' fast >> "$FLEETIQ_DELEGATE_LOG" ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(join(root, "bin/pnpm"), 0o700);
  git(["add", "."]);
  const log = join(root, ".git/delegate-log");
  const run = () =>
    spawnSync("/bin/sh", [".githooks/pre-commit"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        FLEETIQ_NODE: process.execPath,
        FLEETIQ_CHECKER: new URL(
          "../src/verification/floor.mjs",
          import.meta.url,
        ).pathname,
        FLEETIQ_BASE: base,
        FLEETIQ_DELEGATE_LOG: log,
      },
    });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(readFileSync(log, "utf8"), "fast\n");
  rmSync(log);
  write("private-fixture.json", "{}\n");
  git(["add", "-f", "private-fixture.json"]);
  const blocked = run();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /private-path-tracked/);
  assert.throws(() => readFileSync(log), { code: "ENOENT" });
  assert.equal(
    readFileSync(join(root, "private-fixture.json"), "utf8"),
    "{}\n",
  );
});
