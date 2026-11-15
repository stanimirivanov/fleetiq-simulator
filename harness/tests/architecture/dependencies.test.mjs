import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArchitecture } from "../../src/architecture/architecture.mjs";
import { codes, files } from "../../support/architecture-fixture.mjs";

test("permits the CLI, session and wire dependency direction", () => {
  assert.deepEqual(
    checkArchitecture(
      files({
        "cli.ts":
          'export async function runTcp() { await import("./transport/tcp.ts"); }',
        "transport/tcp.ts":
          'import { createConnection } from "node:net"; export { codec } from "../wire/codec8.ts";',
        "session/state.ts":
          'export type State = typeof import("../wire/codec8.ts").codec;',
      }),
    ),
    [],
  );
});

test("reports reverse edges and misplaced effects with their source lines", () => {
  assert.deepEqual(
    codes(
      checkArchitecture(
        files({
          "cli.ts": 'import "node:net";',
          "wire/codec8.ts":
            '// wire\nexport type { State } from "../session/state.ts";',
          "session/state.ts":
            'export type State = typeof import("effect").Effect;',
        }),
      ),
    ),
    [
      "src/cli.ts:1 external-import",
      "src/session/state.ts:1 external-import",
      "src/wire/codec8.ts:2 layer-import",
    ],
  );
});

test("fails closed for unknown files, dynamic imports and unresolved modules", () => {
  assert.deepEqual(
    codes(
      checkArchitecture(
        files({
          "unowned.ts": "",
          "cli.ts":
            'void import(name);\nvoid require("node:net");\nvoid import("./missing.ts");\nimport X = require("effect");',
        }),
      ),
    ),
    [
      "src/cli.ts:1 computed-import",
      "src/cli.ts:2 unsupported-import",
      "src/cli.ts:3 unresolved-import",
      "src/cli.ts:4 unsupported-import",
      "[location withheld]:1 unknown-owner",
    ],
  );
});

test("detects a cycle between otherwise allowed wire modules", () => {
  assert.deepEqual(
    codes(
      checkArchitecture(
        files({
          "wire/a.ts": 'export * from "./codec8.ts";',
          "wire/codec8.ts": 'import "./a.ts";',
        }),
      ),
    ),
    ["src/wire/codec8.ts:1 import-cycle"],
  );
});
