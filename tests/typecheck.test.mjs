import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("type and lint policy reject invalid test and tooling code", () => {
  const fixture = mkdtempSync(join(tmpdir(), "fleetiq-typecheck-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    for (const file of [
      "package.json",
      "tsconfig.json",
      "tsconfig.typecheck.json",
      "biome.json",
    ]) {
      const source = join(root, file);
      copyFileSync(source, join(fixture, file));
    }
    mkdirSync(join(fixture, "node_modules"));
    symlinkSync(
      join(root, "node_modules", "@types"),
      join(fixture, "node_modules", "@types"),
    );
    mkdirSync(join(fixture, "src"));
    mkdirSync(join(fixture, "tests"));
    mkdirSync(join(fixture, "tools"));
    const run = (
      /** @type {string} */ executable,
      /** @type {string[]} */ args,
    ) =>
      spawnSync(
        process.execPath,
        [join(root, "node_modules", executable), ...args],
        {
          cwd: fixture,
          encoding: "utf8",
          timeout: 30_000,
        },
      );

    writeFileSync(
      join(fixture, "src/control.ts"),
      "export const control = true;\n",
    );
    writeFileSync(
      join(fixture, "tests/types.test.ts"),
      'export const value: number = "invalid";\n',
    );
    writeFileSync(
      join(fixture, "tests/syntax.test.ts"),
      "export enum Runtime { Value }\n",
    );
    writeFileSync(
      join(fixture, "tools/types.mjs"),
      "/** @type {number} */\nexport const value = true;\n",
    );
    const rejected = run("typescript/bin/tsc", [
      "-p",
      "tsconfig.typecheck.json",
    ]);
    const output = rejected.stdout + rejected.stderr;
    assert.equal(rejected.status, 2, output);
    assert.match(output, /tests\/types\.test\.ts.*TS2322/);
    assert.match(output, /tests\/syntax\.test\.ts.*TS1294/);
    assert.match(output, /tools\/types\.mjs.*TS2322/);

    writeFileSync(join(fixture, "src/control.ts"), "export default true;\n");
    const lint = run("@biomejs/biome/bin/biome", [
      "ci",
      "src/control.ts",
      "--error-on-warnings",
    ]);
    assert.equal(lint.status, 1, lint.stdout + lint.stderr);
    assert.match(lint.stdout + lint.stderr, /noDefaultExport/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
