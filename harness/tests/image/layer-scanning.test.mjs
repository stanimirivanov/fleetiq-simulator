import assert from "node:assert/strict";
import { test } from "node:test";
import {
  printableLayer,
  rejectIdentityFiles,
  validateLeakExit,
  validateScan,
} from "../../src/qualification/image/image-qualify.mjs";

const id = `sha256:${"c".repeat(64)}`;

test("scanner accepts clean and lower-severity reports, rejects secrets, high findings and malformed output", () => {
  const report = {
    SchemaVersion: 2,
    ArtifactType: "container_image",
    Metadata: { ImageID: id },
    Results: [{ Vulnerabilities: [{ Severity: "LOW" }] }],
  };
  assert.doesNotThrow(() => validateScan(report, id));
  for (const altered of [
    { ...report, Results: [{ Vulnerabilities: [{ Severity: "HIGH" }] }] },
    { ...report, Results: [{ Secrets: [{ Severity: "LOW" }] }] },
    {},
    { ...report, Results: [null] },
    { ...report, Results: ["malformed"] },
    { ...report, Metadata: { ImageID: "wrong" } },
  ])
    assert.throws(() => validateScan(altered, id), /image-scan-/);
});

test("layer findings cannot be confused with missing or broken scanners", () => {
  assert.doesNotThrow(() => validateLeakExit(0, undefined));
  assert.throws(() => validateLeakExit(42, undefined), /image-layer-secret/);
  for (const code of [null, 1, 2])
    assert.throws(() => validateLeakExit(code, undefined), /image-tool-failed/);
  assert.throws(
    () => validateLeakExit(0, new Error("private diagnostic")),
    /image-tool-failed/,
  );
});

test("binary layer normalization preserves embedded credentials instead of triggering binary skips", () => {
  const identity = "3".repeat(15);
  const value = Buffer.concat([
    Buffer.from([0, 255]),
    Buffer.from(identity),
    Buffer.from([0]),
    Buffer.from('api_key="synthetic-key"'),
  ]);
  assert.equal(
    printableLayer(value).toString(),
    `FLEETIQ ASCII LAYER\n\n\n${identity}\napi_key="synthetic-key"`,
  );
});

/** Builds a bounded USTAR control without using the production layer reader. @param {Buffer} payload */
function layer(payload) {
  const header = Buffer.alloc(512);
  header.write("fixture");
  header.write(`${payload.length.toString(8).padStart(11, "0")}\0`, 124);
  header.fill(32, 148, 156);
  header[156] = 48;
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([
    header,
    payload,
    Buffer.alloc(((512 - (payload.length % 512)) % 512) + 1024),
  ]);
}

test("layer identity checks honor file boundaries instead of mistaking runtime constants for private input", () => {
  const identity = "3".repeat(15);
  assert.doesNotThrow(() =>
    rejectIdentityFiles(layer(Buffer.from(`binary\0${identity}\0`))),
  );
  assert.throws(
    () =>
      rejectIdentityFiles(
        layer(Buffer.from(JSON.stringify({ device: identity }))),
      ),
    /image-layer-secret/,
  );
  assert.doesNotThrow(() =>
    rejectIdentityFiles(layer(Buffer.from('{"version":"1.0.0"}'))),
  );
  const corrupted = layer(Buffer.from("safe"));
  corrupted[0] = 0;
  assert.throws(() => rejectIdentityFiles(corrupted), /image-layers-invalid/);
  assert.throws(
    () => rejectIdentityFiles(layer(Buffer.from("safe")).subarray(0, 513)),
    /image-layers-invalid/,
  );
});
