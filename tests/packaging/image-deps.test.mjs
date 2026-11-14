import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareRuntimeDependencies } from "../../packaging/image-deps.mjs";

test("runtime packaging strips examples and development assets while preserving executable strings and licenses", () => {
  const directory = mkdtempSync(join(tmpdir(), "sim-runtime-deps-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(
      join(directory, "src/source.ts"),
      "export const source = true;",
    );
    writeFileSync(
      join(directory, "index.d.ts"),
      "export declare const value: string;",
    );
    writeFileSync(join(directory, "index.js.map"), "{}");
    writeFileSync(join(directory, "README.md"), "development documentation");
    writeFileSync(join(directory, "LICENSE.md"), "copyright notice");
    const executable = 'export const value = "literal /* preserved */";';
    writeFileSync(
      join(directory, "index.js"),
      `/** example-only configuration */\n${executable}`,
    );
    writeFileSync(
      join(directory, "bin.cjs"),
      '#!/usr/bin/env node\n/* copyright fixture */\nprocess.stdout.write("ready");',
    );
    prepareRuntimeDependencies(directory);
    const result = readFileSync(join(directory, "index.js"), "utf8");
    const binary = spawnSync(process.execPath, [join(directory, "bin.cjs")]);
    assert.equal(binary.status, 0);
    assert.equal(binary.stdout.toString(), "ready");
    assert(readFileSync(join(directory, "bin.cjs"), "utf8").startsWith("#!"));
    assert(!result.includes("example-only"));
    assert(result.includes('"literal /* preserved */"'));
    assert.equal(
      readFileSync(join(directory, "LICENSE.md"), "utf8"),
      "copyright notice",
    );
    for (const file of [
      "src/source.ts",
      "index.d.ts",
      "index.js.map",
      "README.md",
    ])
      assert(!existsSync(join(directory, file)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("product packaging entry point works without tools or harness trees", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-packaging-"));
  try {
    mkdirSync(join(root, "packaging"));
    mkdirSync(join(root, "node_modules"));
    copyFileSync(
      new URL("../../packaging/image-deps.mjs", import.meta.url),
      join(root, "packaging/image-deps.mjs"),
    );
    symlinkSync(
      fileURLToPath(new URL("../../node_modules/typescript", import.meta.url)),
      join(root, "node_modules/typescript"),
      "dir",
    );
    const runtime = join(root, "node_modules/runtime");
    mkdirSync(runtime);
    writeFileSync(
      join(runtime, "index.js"),
      '/* development example */\nconsole.log("ready");',
    );
    writeFileSync(join(runtime, "README.md"), "development asset");
    writeFileSync(join(runtime, "NOTICE"), "retain this notice");
    const result = spawnSync(
      process.execPath,
      [join(root, "packaging/image-deps.mjs")],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, "tools")), false);
    assert.equal(existsSync(join(root, "harness")), false);
    assert.equal(existsSync(join(runtime, "README.md")), false);
    assert.equal(
      readFileSync(join(runtime, "NOTICE"), "utf8"),
      "retain this notice",
    );
    assert.equal(
      readFileSync(join(runtime, "index.js"), "utf8").includes(
        "development example",
      ),
      false,
    );
    const executed = spawnSync(process.execPath, [join(runtime, "index.js")], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(executed.status, 0);
    assert.equal(executed.stdout, "ready\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker build copies and invokes product packaging without harness tooling", () => {
  const dockerfile = readFileSync(
    new URL("../../Dockerfile", import.meta.url),
    "utf8",
  );
  const ignore = readFileSync(
    new URL("../../.dockerignore", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    ignore.split("\n").filter((line) => line.startsWith("!packaging")),
    ["!packaging/", "!packaging/image-deps.mjs"],
  );
  assert.doesNotMatch(ignore, /^!(?:tools|harness)(?:\/|$)/m);
  assert.match(
    dockerfile,
    /^COPY packaging\/image-deps\.mjs \.\/packaging\/image-deps\.mjs$/m,
  );
  assert.match(
    dockerfile,
    /pnpm build && node packaging\/image-deps\.mjs && pnpm prune --prod/,
  );
  assert.doesNotMatch(dockerfile, /(?:COPY|RUN)[^\n]*(?:tools\/|harness\/)/);
});

test("runtime packaging preserves external symlinks and comment-free executable code", () => {
  const root = mkdtempSync(join(tmpdir(), "sim-packaging-links-"));
  try {
    const runtime = join(root, "runtime");
    const external = join(root, "external");
    mkdirSync(runtime);
    mkdirSync(external);
    const retained =
      '/** development example outside the build tree */\nconsole.log("external");';
    writeFileSync(join(external, "index.js"), retained);
    writeFileSync(
      join(external, "types.d.ts"),
      "export declare const value: number;",
    );
    symlinkSync(external, join(runtime, "linked-directory"), "dir");
    symlinkSync(join(external, "index.js"), join(runtime, "linked-file.js"));
    writeFileSync(join(runtime, "plain.js"), 'console.log("plain");');
    prepareRuntimeDependencies(runtime);
    assert.equal(readFileSync(join(external, "index.js"), "utf8"), retained);
    assert.equal(existsSync(join(external, "types.d.ts")), true);
    assert.equal(
      readFileSync(join(runtime, "linked-file.js"), "utf8"),
      retained,
    );
    const executed = spawnSync(process.execPath, [join(runtime, "plain.js")], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(executed.status, 0);
    assert.equal(executed.stdout, "plain\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
