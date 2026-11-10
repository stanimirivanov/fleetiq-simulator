import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkArchitecture, checkSourceTree } from "../tools/architecture.mjs";

/** @param {Record<string, string>} extra */
const files = (extra) =>
  new Map(
    Object.entries({ "wire/codec8.ts": "export const codec = 8;", ...extra }),
  );

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

const codes = (/** @type {string[]} */ diagnostics) =>
  diagnostics.map((message) => message.split(";")[0]);

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

test("architecture diagnostics identify reviewed imports without echoing untrusted paths", () => {
  const privateName = `private-${"01234".repeat(3)}`;
  const diagnostics = checkArchitecture(
    files({
      "cli.ts": `import "node:net";\nimport "${privateName}";`,
      [`wire/${privateName}\n.ts`]: 'import "node:fs";',
    }),
  ).join("\n");
  assert.match(diagnostics, /src\/cli\.ts:1 external-import;.*node:net.*Move/);
  assert.match(diagnostics, /\[module withheld\]/);
  assert.match(diagnostics, /\[location withheld\]:1 external-import/);
  assert.ok(!diagnostics.includes(privateName));
});

test("source tree errors and checker failures have distinct recovery instructions", () => {
  const root = mkdtempSync(join(tmpdir(), "fleetiq-architecture-"));
  try {
    const src = join(root, "src");
    assert.match(checkSourceTree(src).join(), /missing-source.*Restore/);
    writeFileSync(src, "synthetic");
    assert.match(checkSourceTree(src).join(), /source-unreadable.*permissions/);
    rmSync(src);
    mkdirSync(src);
    writeFileSync(join(src, "unexpected.js"), "");
    assert.match(checkSourceTree(src).join(), /invalid-source-entry.*Remove/);
    rmSync(join(src, "unexpected.js"));
    writeFileSync(join(src, "cli.ts"), "");
    writeFileSync(join(src, "other.ts"), "");
    const failed = checkSourceTree(src, () => {
      throw new Error("private-checker-text");
    });
    assert.match(failed.join(), /checker-error.*fixture/);
    assert.ok(!failed.join().includes("private-checker-text"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the CLI network command can import transport at runtime", () => {
  const snapshot = files({
    "cli.ts": [
      'import "./transport/tcp.ts";',
      'export { value } from "./transport/tcp.ts";',
      'export type Tcp = typeof import("./transport/tcp.ts");',
      'if (enabled) void import("./transport/tcp.ts");',
      'export async function runTcp() { await import("./transport/tcp.ts"); }',
    ].join("\n"),
    "session/state.ts": 'export * from "../transport/tcp.ts";',
    "transport/tcp.ts": "export const value = 1;",
  });
  assert.deepEqual(codes(checkArchitecture(snapshot)), [
    "src/cli.ts:1 transport-load",
    "src/cli.ts:2 transport-load",
    "src/cli.ts:4 transport-load",
    "src/session/state.ts:1 layer-import",
  ]);
});

test("wire flags ambient capabilities while allowing local shadowing", () => {
  const snapshot = files({
    "wire/codec8.ts": [
      "export const time = Date.now();",
      "export const random = Math['random']();",
      "export const socket = globalThis.WebSocket;",
      "export const fetcher = fetch;",
      "export const round = Math.round(1.2);",
      "export function local(Date, Math, fetch) { return Date.now() + Math.random() + fetch(); }",
      "export const metadata = { Date: 0 };",
    ].join("\n"),
  });
  assert.deepEqual(
    codes(checkArchitecture(snapshot)),
    [1, 2, 3, 4].map((line) => `src/wire/codec8.ts:${line} wire-ambient`),
  );
});
