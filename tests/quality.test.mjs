import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scan } from "../tools/secrets.mjs";

test("secret scanner separates clean content, device identity findings, and tool failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-scan-"));
  try {
    const fixture = join(directory, "fixture.txt");
    writeFileSync(fixture, "synthetic");
    assert.equal(scan(["dir", directory]), "clean");
    writeFileSync(fixture, "01234".repeat(3));
    assert.equal(scan(["dir", directory]), "finding");
    assert.equal(
      scan(["dir", directory], join(directory, "missing")),
      "scanner-error",
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
