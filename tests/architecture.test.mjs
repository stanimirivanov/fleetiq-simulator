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

test("DNS resolution belongs only to the transport adapter", () => {
  assert.deepEqual(
    checkArchitecture(files({ "transport/tcp.ts": 'import "node:dns";' })),
    [],
  );
  for (const owner of ["cli.ts", "session/state.ts", "wire/codec8.ts"]) {
    assert.equal(
      checkArchitecture(files({ [owner]: 'import "node:dns";' })).length,
      1,
    );
  }
});

test("scenarios depend only on pure scenario/wire contracts and the schema validator", () => {
  assert.deepEqual(
    checkArchitecture(
      files({
        "cli.ts": 'import "./scenarios/route.ts";',
        "scenarios/route.ts":
          'import "ajv/dist/2020.js"; export * from "../wire/codec8.ts";',
      }),
    ),
    [],
  );
  const invalid = checkArchitecture(
    files({
      "scenarios/route.ts":
        'import "../session/state.ts"; import "node:fs"; const now = Date.now();',
      "session/state.ts": 'import "../scenarios/route.ts";',
    }),
  ).join("\n");
  assert.match(invalid, /layer-import/);
  assert.match(invalid, /external-import/);
  assert.match(invalid, /wire-ambient/);
});

test("checkpoint storage owns file/SQLite effects while session depends only on a persistence port", () => {
  assert.deepEqual(
    checkArchitecture(
      files({
        "cli.ts": 'import "./storage/spool.ts";',
        "storage/spool.ts":
          'import "node:fs"; import "node:crypto"; import "node:sqlite"; export * from "../session/spool.ts";',
        "session/spool.ts": 'import "ajv/dist/2020.js";',
      }),
    ),
    [],
  );
  const bad = checkArchitecture(
    files({
      "session/spool.ts": 'import "node:fs"; import "../storage/spool.ts";',
      "storage/spool.ts": "",
    }),
  ).join("\n");
  assert.match(bad, /external-import/);
  assert.match(bad, /layer-import/);
});

test("transport consumes pure fault plans while scenarios cannot import socket owners", () => {
  assert.deepEqual(
    checkArchitecture(
      files({
        "transport/tcp.ts": 'import "../scenarios/faults.ts";',
        "scenarios/faults.ts": 'import "../wire/codec8.ts";',
      }),
    ),
    [],
  );
  assert.match(
    checkArchitecture(
      files({
        "scenarios/faults.ts": 'import "../transport/tcp.ts";',
        "transport/tcp.ts": "",
      }),
    ).join("\n"),
    /layer-import/,
  );
});

// Consuming the fault policy does not grant transport access to other scenario implementations.
test("transport fault policy dependency does not widen to route/model owners", () => {
  assert.match(
    checkArchitecture(
      files({
        "transport/tcp.ts": 'import "../scenarios/route.ts";',
        "scenarios/route.ts": "",
      }),
    ).join("\n"),
    /layer-import/,
  );
});

test("fleet orchestration consumes pure policy and metrics while measurements stay at the IO boundary", () => {
  assert.deepEqual(
    checkArchitecture(
      files({
        "transport/fleet.ts":
          'import "node:timers/promises"; import "../scenarios/fleet.ts"; import "../telemetry.ts";',
        "scenarios/fleet.ts": 'import "../wire/codec8.ts";',
        "telemetry.ts": "export const count=0;",
      }),
    ),
    [],
  );
  for (const text of [
    'import "node:fs";',
    "export const value=process.memoryUsage();",
  ]) {
    assert.equal(
      checkArchitecture(files({ "telemetry.ts": text })).length > 0,
      true,
    );
  }
  assert.match(
    checkArchitecture(
      files({
        "scenarios/fleet.ts": 'import "../transport/fleet.ts";',
        "transport/fleet.ts": "",
      }),
    ).join("\n"),
    /layer-import/,
  );
});
