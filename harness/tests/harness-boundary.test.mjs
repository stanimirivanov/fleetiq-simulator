import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  assert.deepEqual(Object.keys(product.devDependencies).sort(), [
    "@types/node",
    "typescript",
  ]);
  for (const [name, version] of Object.entries(product.devDependencies))
    assert.equal(harness.devDependencies[name], version);
  for (const name of ["biome.json", "eslint.config.mjs", "tools"])
    assert.equal(existsSync(join(root, name)), false, name);
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
    for (const name of ["src", "packaging", "tests", "profiles", "contracts"])
      cpSync(join(root, name), join(directory, name), { recursive: true });
    for (const name of [
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "tsconfig.typecheck.json",
      "README.md",
      "Dockerfile",
      ".dockerignore",
      "LICENSE",
    ])
      cpSync(join(root, name), join(directory, name));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_V8_COVERAGE;
    delete env.NODE_PATH;
    env.PATH = env.PATH?.split(":")
      .filter((part) => !part.startsWith(root))
      .join(":");
    const store = spawnSync("pnpm", ["store", "path"], {
      cwd: root,
      encoding: "utf8",
      env,
      timeout: 10000,
    });
    assert.equal(store.status, 0, store.stderr);
    const install = spawnSync(
      "pnpm",
      [
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--store-dir",
        store.stdout.trim(),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env,
        timeout: 30000,
      },
    );
    assert.equal(install.status, 0, install.stdout + install.stderr);
    for (const name of ["ajv", "effect", "typescript", "@types/node"])
      assert.ok(
        realpathSync(join(directory, "node_modules", name)).startsWith(
          `${directory}/`,
        ),
        name,
      );
    for (const name of ["eslint", "yaml", "@biomejs/biome"])
      assert.equal(
        existsSync(join(directory, "node_modules", name)),
        false,
        name,
      );
    assert.equal(existsSync(join(directory, "harness")), false);
    const build = spawnSync(
      process.execPath,
      [
        join(directory, "node_modules/typescript/bin/tsc"),
        "--rootDir",
        "src",
        "--outDir",
        "dist",
        "--rewriteRelativeImportExtensions",
      ],
      { cwd: directory, encoding: "utf8", env, timeout: 30000 },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const types = spawnSync(
      process.execPath,
      ["node_modules/typescript/bin/tsc", "-p", "tsconfig.typecheck.json"],
      {
        cwd: directory,
        encoding: "utf8",
        env,
        timeout: 30000,
      },
    );
    assert.equal(types.status, 0, types.stdout + types.stderr);
    const tests = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        "tests/**/*.test.ts",
        "tests/**/*.test.mjs",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    const gate = spawnSync("pnpm", ["floor"], {
      cwd: directory,
      encoding: "utf8",
      env,
      timeout: 10000,
    });
    assert.notEqual(gate.status, 0);
    assert.match(
      gate.stderr + gate.stdout,
      /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/,
    );

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
