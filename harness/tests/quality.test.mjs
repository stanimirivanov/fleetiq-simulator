import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scan } from "../src/security/secrets.mjs";

test("secret scanner separates clean content, device identity findings, and tool failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-scan-"));
  try {
    const fixture = join(directory, "package.json");
    writeFileSync(fixture, "synthetic");
    assert.equal(scan("worktree", directory), "clean");
    writeFileSync(fixture, "01234".repeat(3));
    assert.match(
      scan("worktree", directory),
      /secret-scan-finding.*worktree.*device-identity.*package\.json:1/,
    );
    assert.equal(
      scan("worktree", directory, join(directory, "missing")),
      "secret-scan-scanner-error phase=worktree; Check the pinned Gitleaks binary and scan inputs.",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
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

test("scanner reports fail closed and never expose unreviewed metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-scan-report-"));
  const binary = join(directory, "scanner");
  const privateText = `private-${"01234".repeat(3)}`;
  try {
    for (const [exit, report, category] of [
      [42, "{", "secret-scan-report-error"],
      [42, "[]", "secret-scan-report-error"],
      [
        42,
        '[{"RuleID":"device-identity","File":"package.json","StartLine":"1"}]',
        "secret-scan-report-error",
      ],
      [
        0,
        '[{"RuleID":"device-identity","File":"package.json","StartLine":1}]',
        "secret-scan-report-error",
      ],
      [
        42,
        JSON.stringify([
          {
            RuleID: privateText,
            File: `../${privateText}`,
            StartLine: 1,
            Secret: privateText,
            Match: privateText,
          },
        ]),
        "secret-scan-finding",
      ],
    ]) {
      writeFileSync(
        binary,
        `#!/bin/sh\ncat <<'REPORT'\n${report}\nREPORT\necho '${privateText}' >&2\nexit ${exit}\n`,
        { mode: 0o700 },
      );
      const result = scan("history", directory, binary);
      assert.match(result, new RegExp(`^${category} phase=history`));
      assert.ok(!result.includes(privateText));
      if (category === "secret-scan-finding")
        assert.match(result, /rule=withheld location=withheld/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real index and history scans report the phase without emitting the match", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-scan-git-"));
  const identity = "01234".repeat(3);
  const git = (/** @type {string[]} */ ...args) => {
    const result = spawnSync(
      "git",
      [
        "-C",
        directory,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
  };
  try {
    git("init", "--quiet");
    writeFileSync(join(directory, "package.json"), "{}\n");
    git("add", "package.json");
    git("commit", "--quiet", "-m", "clean control");
    assert.equal(scan("history", directory), "clean");
    writeFileSync(join(directory, "package.json"), `"${identity}"\n`);
    git("add", "package.json");
    const index = scan("index", directory);
    assert.match(
      index,
      /secret-scan-finding phase=index rule=device-identity location=package\.json:1/,
    );
    assert.ok(!index.includes(identity));
    git("commit", "--quiet", "-m", "synthetic test fixture");
    const history = scan("history", directory);
    assert.match(
      history,
      /secret-scan-finding phase=history rule=device-identity location=package\.json:1/,
    );
    assert.ok(!history.includes(identity));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
