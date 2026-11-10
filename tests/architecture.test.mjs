import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArchitecture } from "../tools/architecture.mjs";

const files = (extra) =>
  new Map(
    Object.entries({ "wire/codec8.ts": "export const codec = 8;", ...extra }),
  );

test("permits the CLI, session and wire dependency direction", () => {
  assert.deepEqual(
    checkArchitecture(
      files({
        "cli.ts": 'void import("./session/tcp.ts");',
        "session/tcp.ts":
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
    checkArchitecture(
      files({
        "cli.ts": 'import "node:net";',
        "wire/codec8.ts":
          '// wire\nexport type { State } from "../session/state.ts";',
        "session/state.ts":
          'export type State = typeof import("effect").Effect;',
      }),
    ),
    [
      "cli.ts:1 external-import",
      "session/state.ts:1 external-import",
      "wire/codec8.ts:2 layer-import",
    ],
  );
});

test("fails closed for unknown files, dynamic imports and unresolved modules", () => {
  assert.deepEqual(
    checkArchitecture(
      files({
        "unowned.ts": "",
        "cli.ts":
          'void import(name);\nvoid require("node:net");\nvoid import("./missing.ts");\nimport X = require("effect");',
      }),
    ),
    [
      "cli.ts:1 computed-import",
      "cli.ts:2 unsupported-import",
      "cli.ts:3 unresolved-import",
      "cli.ts:4 unsupported-import",
      "unowned.ts:1 unknown-owner",
    ],
  );
});

test("detects a cycle between otherwise allowed wire modules", () => {
  assert.deepEqual(
    checkArchitecture(
      files({
        "wire/a.ts": 'export * from "./codec8.ts";',
        "wire/codec8.ts": 'import "./a.ts";',
      }),
    ),
    ["wire/codec8.ts:1 import-cycle"],
  );
});
