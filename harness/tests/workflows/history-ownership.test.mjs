import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workflow } from "../../support/workflow-fixture.mjs";

test("history guard accepts full main and rejects shallow or mismatched checkouts", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-workflow-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = join(directory, "origin");
  const shallow = join(directory, "shallow");

  /** Executes Git without inherited identity or hook requirements. @param {string[]} args */
  function git(args) {
    const result = spawnSync("git", args, {
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
  git(["init", "--initial-branch=main", origin]);
  git([
    "-C",
    origin,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  git(["-C", origin, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  const script = workflow("security-scheduled").getIn([
    "jobs",
    "security",
    "steps",
    5,
    "run",
  ]);
  assert.equal(typeof script, "string");

  /** Runs the actual workflow shell body against an owned fixture. @param {string} cwd */
  function guard(cwd) {
    return spawnSync("bash", ["-e", "-c", String(script)], {
      cwd,
      env: { ...process.env, GITHUB_STEP_SUMMARY: join(directory, "summary") },
      encoding: "utf8",
      timeout: 10_000,
    });
  }
  assert.equal(guard(origin).status, 0);
  assert.match(
    readFileSync(join(directory, "summary"), "utf8"),
    new RegExp(git(["-C", origin, "rev-parse", "HEAD"])),
  );
  git(["clone", "--depth=1", `file://${origin}`, shallow]);
  assert.equal(guard(shallow).status, 1);
  git([
    "-C",
    origin,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "unmatched",
  ]);
  assert.equal(guard(origin).status, 1);
});

test("verification inputs and the ownership policy have a maintainer owner", () => {
  const rules = readFileSync(
    new URL("../../../.github/CODEOWNERS", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.trim().split(/\s+/u));
  for (const rule of rules) assert.equal(rule[1], "@stanimirivanov");
  for (const path of [
    "/.github/",
    "/.githooks/",
    "/tests/",
    "/**/AGENTS.md",
    "/harness/",
    "/packaging/",
    "/package.json",
    "/pnpm-lock.yaml",
    "/tsconfig*.json",
    "/.gitignore",
  ])
    assert.ok(
      rules.some((rule) => rule[0] === path),
      path,
    );
});
