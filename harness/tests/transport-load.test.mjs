import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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

const root = fileURLToPath(new URL("../../", import.meta.url));
const hook = fileURLToPath(
  new URL("../support/no-transport.mjs", import.meta.url),
);

/**
 * Installs the load canary before Node resolves the CLI entrypoint.
 *
 * @param {string} entry
 * @param {string[]} args
 */
function runOffline(entry, ...args) {
  return spawnSync(process.execPath, ["--import", hook, entry, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("offline source and built commands never load transport", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-transport-"));
  try {
    const dist = join(directory, "dist");
    const build = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--rootDir",
        "src",
        "--outDir",
        dist,
        "--rewriteRelativeImportExtensions",
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
    const config = join(directory, "record.json");
    writeFileSync(
      config,
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
    for (const [entry, label] of [
      [join(root, "src/cli.ts"), "source"],
      [join(dist, "cli.js"), "built"],
    ]) {
      assert.ok(entry && label);
      const output = join(directory, `${label}.bin`);
      for (const args of [
        ["validate", "--config", config],
        ["encode", "--config", config, "--output", output],
      ]) {
        const result = runOffline(entry, ...args);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
      }
      assert.equal(readFileSync(output).length, 45);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the canary rejects eager, conditional and transitive transport loads", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-transport-canary-"));
  try {
    mkdirSync(join(directory, "transport"));
    writeFileSync(
      join(directory, "transport", "tcp.mjs"),
      "export const wire = 1;",
    );
    writeFileSync(
      join(directory, "middle.mjs"),
      'export * from "./transport/tcp.mjs";',
    );
    const entry = join(directory, "cli.mjs");
    for (const fixture of [
      'import "./transport/tcp.mjs";',
      'if (process.argv[2] === "validate") await import("./transport/tcp.mjs");',
      'import "./middle.mjs";',
    ]) {
      writeFileSync(entry, fixture);
      const result = runOffline(entry, "validate");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /^offline-transport-load/m);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unselected UDP validation does not compile during ordinary CLI startup", () => {
  const script = `
 import {Ajv2020} from 'ajv/dist/2020.js';
 const original=Ajv2020.prototype.compile;
 let udpCompilations=0;
 Ajv2020.prototype.compile=function(schema){
   if(schema.required?.includes('packetId'))udpCompilations++;
   return original.call(this,schema);
 };
 await import('./src/cli.ts');
 process.stdout.write(JSON.stringify({udpCompilations}));
 `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { udpCompilations: 0 });
});
