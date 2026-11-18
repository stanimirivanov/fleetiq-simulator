import assert from "node:assert/strict";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkFloor } from "../../src/verification/floor.mjs";
import { fixture } from "../../support/floor-fixture.mjs";

const rootBefore = "pnpm --dir harness audit --audit-level high";
const rootAfter = "pnpm --dir harness run audit:approved";
const checkBefore =
  "pnpm typecheck && pnpm test && pnpm audit --audit-level high";
const checkAfter = "pnpm typecheck && pnpm test && pnpm run audit:approved";

/** Owns an immutable native-audit baseline and candidate-only delegates. @param {import("node:test").TestContext} context */
function auditFixture(context) {
  const f = fixture(context);
  const product = (/** @type {string} */ command) =>
    f.write(
      "package.json",
      JSON.stringify({ scripts: { "security:harness": command } }),
    );
  const harness = (
    /** @type {string} */ check,
    gate = "node src/security/audit.mjs",
    privatePackage = true,
  ) =>
    f.write(
      "harness/package.json",
      JSON.stringify({
        private: privatePackage,
        scripts: { check, "audit:approved": gate },
      }),
    );
  product(rootBefore);
  harness(checkBefore);
  f.git(["add", "."]);
  f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "audit baseline",
  ]);
  const base = f.git(["rev-parse", "HEAD"]);
  for (const path of [
    "harness/src/security/audit.mjs",
    "harness/config/audit-exception.json",
    "harness/pnpm-lock.yaml",
  ])
    f.write(path, "{}\n");
  return { ...f, base, product, harness };
}

test("floor admits only the reviewed audit command replacements after the prerequisite is trusted", (context) => {
  const f = auditFixture(context);
  f.product(rootAfter);
  assert.deepEqual(checkFloor(f.base, f.root), []);
  f.harness(checkAfter);
  assert.deepEqual(checkFloor(f.base, f.root), []);
});

test("audit transitions reject changed shell chains, target scripts, nonprivate packages and missing policy files", (context) => {
  const f = auditFixture(context);
  for (const command of [
    "echo passed",
    `${rootAfter} || true`,
    "pnpm --dir harness run another-audit",
  ]) {
    f.product(command);
    assert.ok(
      checkFloor(f.base, f.root).includes("verification-script-changed"),
    );
  }
  f.product(rootAfter);
  for (const gate of [
    "echo passed",
    "node src/security/audit.mjs --ignore-errors",
  ]) {
    f.harness(checkAfter, gate);
    assert.ok(
      checkFloor(f.base, f.root).includes("verification-script-changed"),
    );
  }
  f.harness(checkAfter, "node src/security/audit.mjs", false);
  assert.ok(checkFloor(f.base, f.root).includes("verification-script-changed"));
  f.harness(checkAfter);
  const policy = join(f.root, "harness/config/audit-exception.json");
  rmSync(policy);
  assert.ok(checkFloor(f.base, f.root).includes("verification-script-changed"));
  symlinkSync(join(f.root, "harness/pnpm-lock.yaml"), policy);
  assert.ok(checkFloor(f.base, f.root).includes("verification-script-changed"));
});
