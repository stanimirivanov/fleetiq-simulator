import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkFloor } from "../../src/verification/floor.mjs";
import { fixture } from "../../support/floor-fixture.mjs";

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
