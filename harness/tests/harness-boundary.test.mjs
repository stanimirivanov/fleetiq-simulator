import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("private harness pins its own tools and retains root compatibility until M8", () => {
  const product = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const harness = JSON.parse(
    readFileSync(join(root, "harness/package.json"), "utf8"),
  );
  assert.equal(harness.private, true);
  assert.equal(harness.type, "module");
  assert.deepEqual(harness.engines, product.engines);
  assert.equal(harness.packageManager, product.packageManager);
  assert.deepEqual(harness.devDependencies, product.devDependencies);
  assert.equal(
    harness.scripts.test,
    'cd .. && node --test "harness/tests/**/*.test.mjs"',
  );
  assert.equal(harness.scripts.audit, "pnpm audit --audit-level high");
});

test("product import boundary permits local modules and refuses harness, legacy tooling and computed imports", async () => {
  const { checkProductImports } = await import(
    "../src/architecture/boundary.mjs"
  );
  assert.deepEqual(
    checkProductImports({
      "src/cli.ts": 'import {encode} from "./wire/codec8.ts";',
      "tests/peer.ts": 'import {createServer} from "node:net";',
    }),
    [],
  );
  for (const value of [
    'import {check} from "../harness/src/verification/floor.mjs";',
    'export {check} from "../tools/floor.mjs";',
    'const gate = import("../harness/config/policy.mjs");',
    "const gate = import(target);",
    'import harness from "@fleetiq/simulator-harness";',
    'import harness from "@fleetiq/simulator-harness/gate";',
    'const gate = require("../harness/gate.mjs");',
  ])
    assert.deepEqual(checkProductImports({ "src/cli.ts": value }), [
      "product-harness-import",
    ]);
  assert.deepEqual(
    checkProductImports({
      "tests/example.test.mjs":
        "const fixture = 'import gate from \"../harness/gate.mjs\";';",
    }),
    [],
  );
});

test("product builds and validates without harness files or verification configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "sim-product-only-"));
  try {
    for (const name of ["src", "packaging"])
      cpSync(join(root, name), join(directory, name), { recursive: true });
    for (const name of ["package.json", "tsconfig.json"])
      cpSync(join(root, name), join(directory, name));
    symlinkSync(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    const build = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--rootDir",
        "src",
        "--outDir",
        "dist",
        "--rewriteRelativeImportExtensions",
      ],
      { cwd: directory, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const input = join(directory, "record.json");
    writeFileSync(
      input,
      JSON.stringify({
        schemaVersion: 1,
        timestampMs: "0",
        priority: 0,
        longitudeE7: 0,
        latitudeE7: 0,
        altitude: 0,
        angle: 0,
        satellites: 0,
        speed: 0,
        eventId: 0,
        io: [],
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["dist/cli.js", "validate", "--config", input],
      { cwd: directory, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unreadable or linked product trees fail closed without exposing paths", async () => {
  const { checkProductTree } = await import("../src/architecture/boundary.mjs");
  const { mkdirSync } = await import("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "sim-boundary-"));
  try {
    for (const owner of ["src", "tests", "packaging"])
      mkdirSync(join(directory, owner));
    writeFileSync(join(directory, "src/entry.ts"), "export const value = 1;");
    assert.deepEqual(checkProductTree(directory), []);
    symlinkSync(join(directory, "src"), join(directory, "tests/linked"), "dir");
    assert.deepEqual(checkProductTree(directory), [
      "product-boundary-unreadable",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
