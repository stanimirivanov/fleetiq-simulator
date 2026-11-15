import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const original =
  'import { test as spec } from "node:test";\nspec("retained", () => {});\n';

/** Owns a real Git baseline; fixtures never touch the working repository. @param {import("node:test").TestContext} context */
export function fixture(context) {
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
    "harness/src/verification/coverage.mjs",
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
