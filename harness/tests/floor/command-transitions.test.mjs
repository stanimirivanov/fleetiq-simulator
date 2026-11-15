import assert from "node:assert/strict";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkFloor } from "../../src/verification/floor.mjs";
import { fixture } from "../../support/floor-fixture.mjs";

const cases = [
  {
    name: "lint",
    before:
      "biome ci . --error-on-warnings && pnpm lint:comments && pnpm lint:source-comments",
    target: "lint:product",
    script:
      "cd .. && harness/node_modules/.bin/biome ci . --config-path=harness/config/biome.json --error-on-warnings && pnpm lint:comments && pnpm lint:source-comments",
    files: ["harness/config/biome.json"],
  },
  {
    name: "lint:comments",
    before: "eslint harness/src && pnpm lint:packaging",
    target: "lint:comments",
    script:
      "cd .. && harness/node_modules/.bin/eslint --config harness/config/eslint.config.mjs harness/src harness/support && pnpm lint:packaging",
    files: ["harness/config/eslint.config.mjs"],
  },
  {
    name: "lint:packaging",
    before: "eslint packaging",
    target: "lint:packaging",
    script:
      "cd .. && harness/node_modules/.bin/eslint --config harness/config/eslint.config.mjs packaging",
    files: ["harness/config/eslint.config.mjs"],
  },
  {
    name: "lint:source-comments",
    before: "eslint src",
    target: "lint:source-comments",
    script:
      "cd .. && harness/node_modules/.bin/eslint --config harness/config/eslint.config.mjs src",
    files: ["harness/config/eslint.config.mjs"],
  },
  {
    name: "typecheck",
    before: "tsc -p tsconfig.typecheck.json",
    target: "typecheck",
    script: "tsc -p config/tsconfig.json",
    files: ["tsconfig.typecheck.json", "harness/config/tsconfig.json"],
  },
];
const before = Object.fromEntries(
  cases.map((item) => [item.name, item.before]),
);
const targets = Object.fromEntries(
  cases.map((item) => [item.target, item.script]),
);
const delegate = (/** @type {(typeof cases)[number]} */ item) =>
  `${item.name === "typecheck" ? "tsc -p tsconfig.typecheck.json && " : ""}pnpm --dir harness run ${item.target}`;

/** Owns the reviewed command baseline; proposed destinations are candidate files. @param {import("node:test").TestContext} context */
function transitionFixture(context) {
  const { root, write, git } = fixture(context);
  const product = (/** @type {Record<string,string>} */ scripts) =>
    write("package.json", JSON.stringify({ scripts }));
  const harness = (
    /** @type {Record<string,string>} */ scripts,
    isPrivate = true,
  ) =>
    write(
      "harness/package.json",
      JSON.stringify({ private: isPrivate, scripts }),
    );
  product(before);
  harness({ typecheck: "tsc -p config/tsconfig.json" });
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "command baseline",
  ]);
  const base = git(["rev-parse", "HEAD"]);
  harness(targets);
  for (const file of new Set(cases.flatMap((item) => item.files)))
    write(file, "{}\n");
  return { root, base, write, product, harness };
}

test("floor admits each exact root command transition and their combined harness binding", (context) => {
  const { root, base, product } = transitionFixture(context);
  for (const item of cases) {
    product({ ...before, [item.name]: delegate(item) });
    assert.deepEqual(checkFloor(base, root), [], item.name);
  }
  product(Object.fromEntries(cases.map((item) => [item.name, delegate(item)])));
  assert.deepEqual(checkFloor(base, root), []);
});

test("floor rejects command transition bypasses, alternate destinations and candidate maps", (context) => {
  const { root, base, write, product } = transitionFixture(context);
  for (const item of cases) {
    const good = delegate(item);
    for (const command of [
      `${good} || true`,
      `${good} --skip`,
      good.replace("--dir harness", "--dir other"),
      good.replace(" run ", " exec "),
      good.replace(item.target, "unreviewed"),
      good.replace("pnpm --dir", "pnpm --silent --dir"),
      "true",
    ]) {
      write(
        "harness/command-transitions.json",
        JSON.stringify({ [item.name]: command }),
      );
      product({ ...before, [item.name]: command });
      assert.ok(
        checkFloor(base, root).includes("verification-script-changed"),
        command,
      );
    }
  }
});

test("floor binds transitions to exact private harness scripts instead of trusting delegates", (context) => {
  const { root, base, product, harness, write } = transitionFixture(context);
  for (const item of cases) {
    product({ ...before, [item.name]: delegate(item) });
    for (const changed of [
      "true",
      `${item.script} || true`,
      `${item.script.replace(" && ", " ; ")} `,
    ]) {
      harness({ ...targets, [item.target]: changed });
      assert.ok(
        checkFloor(base, root).includes("verification-script-changed"),
        item.name,
      );
    }
    const missing = { ...targets };
    delete missing[item.target];
    harness(missing);
    assert.ok(checkFloor(base, root).includes("verification-script-changed"));
    harness(targets, false);
    assert.ok(checkFloor(base, root).includes("verification-script-changed"));
    harness(targets);
    assert.deepEqual(checkFloor(base, root), []);
  }
  rmSync(join(root, "harness/package.json"));
  assert.ok(checkFloor(base, root).includes("verification-script-changed"));
  write("harness/package.json", "not json");
  assert.throws(() => checkFloor(base, root));
  rmSync(join(root, "harness/package.json"));
  write(
    "harness/manifest.json",
    JSON.stringify({ private: true, scripts: targets }),
  );
  symlinkSync(
    join(root, "harness/manifest.json"),
    join(root, "harness/package.json"),
  );
  assert.throws(() => checkFloor(base, root), /candidate-unreadable/);
});

test("floor refuses missing or linked command configuration destinations", (context) => {
  const { root, base, product, write } = transitionFixture(context);
  for (const item of cases) {
    product({ ...before, [item.name]: delegate(item) });
    for (const file of item.files) {
      rmSync(join(root, file));
      assert.ok(
        checkFloor(base, root).includes("verification-script-changed"),
        file,
      );
      write(file, "{}\n");
    }
  }
  const lint = cases[0];
  assert.ok(lint);
  product({ ...before, lint: delegate(lint) });
  rmSync(join(root, "harness/config"), { recursive: true });
  write("harness/other/biome.json", "{}\n");
  symlinkSync(join(root, "harness/other"), join(root, "harness/config"), "dir");
  assert.ok(checkFloor(base, root).includes("verification-script-changed"));
  rmSync(join(root, "harness/config"));
  write("harness/config/other.json", "{}\n");
  symlinkSync(
    join(root, "harness/config/other.json"),
    join(root, "harness/config/biome.json"),
  );
  assert.deepEqual(checkFloor(base, root), ["verification-script-changed"]);
});

test("floor restricts command transitions to their reviewed root names and original commands", (context) => {
  for (const item of cases) {
    const { root, write, git } = fixture(context);
    const manifest = (/** @type {Record<string,string>} */ scripts) =>
      write("package.json", JSON.stringify({ scripts }));
    manifest({ [item.name]: `${item.before} `, other: item.before });
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "wrong origins",
    ]);
    const base = git(["rev-parse", "HEAD"]);
    write(
      "harness/package.json",
      JSON.stringify({ private: true, scripts: targets }),
    );
    for (const file of item.files) write(file, "{}\n");
    manifest({ [item.name]: delegate(item), other: item.before });
    assert.ok(checkFloor(base, root).includes("verification-script-changed"));
    manifest({ [item.name]: `${item.before} `, other: delegate(item) });
    assert.ok(checkFloor(base, root).includes("verification-script-changed"));
  }
});

test("floor does not apply root command transitions inside the harness package", (context) => {
  const item = cases[0];
  assert.ok(item);
  const { root, write, git } = fixture(context);
  const manifest = (/** @type {string} */ command) =>
    write(
      "harness/package.json",
      JSON.stringify({
        private: true,
        scripts: { lint: command, "lint:product": item.script },
      }),
    );
  manifest(item.before);
  write("harness/config/biome.json", "{}\n");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "harness scope",
  ]);
  const base = git(["rev-parse", "HEAD"]);
  manifest(delegate(item));
  assert.deepEqual(checkFloor(base, root), ["verification-script-changed"]);
});
