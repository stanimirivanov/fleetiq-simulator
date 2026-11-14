import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  printableLayer,
  rejectIdentityFiles,
  sourceSnapshot,
  trivyVersion,
  validateImage,
  validateLeakExit,
  validateScan,
} from "../tools/image-qualify.mjs";

const revision = "a".repeat(40),
  fingerprint = "b".repeat(64),
  id = `sha256:${"c".repeat(64)}`;
function image() {
  return {
    Id: id,
    Os: "linux",
    Architecture: "amd64",
    Config: {
      User: "65532:65532",
      WorkingDir: "/app",
      Entrypoint: ["/usr/local/bin/node", "/app/dist/cli.js"],
      Labels: {
        "org.opencontainers.image.source":
          "https://github.com/stanimirivanov/fleetiq-simulator",
        "org.opencontainers.image.revision": revision,
        "com.fleetiq.source.sha256": fingerprint,
      },
    },
  };
}
test("image metadata binds nonroot runtime, platform, CLI and exact candidate source", () => {
  assert.equal(validateImage(image(), revision, fingerprint), id);
  /** @type {((value: ReturnType<typeof image>) => void)[]} */
  const mutations = [
    (v) => {
      v.Config.User = "0";
    },
    (v) => {
      v.Architecture = "arm64";
    },
    (v) => {
      v.Config.Entrypoint = ["/bin/sh"];
    },
    (v) => {
      v.Config.Labels["org.opencontainers.image.revision"] = "d".repeat(40);
    },
    (v) => {
      v.Config.Labels["com.fleetiq.source.sha256"] = "e".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const value = image();
    mutate(value);
    assert.throws(
      () => validateImage(value, revision, fingerprint),
      /image-metadata-invalid/,
    );
  }
});
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
test("source snapshot excludes ignored inputs, rejects indexed private names and seals candidate bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "fleetiq-image-test-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
    writeFileSync(join(root, ".gitignore"), "private-*\n");
    writeFileSync(join(root, "source.txt"), "first");
    writeFileSync(join(root, "private-input"), "not-a-build-input");
    const before = sourceSnapshot(root);
    assert(!before.files.includes("private-input"));
    writeFileSync(join(root, "source.txt"), "second");
    assert.equal(before.contents.get("source.txt")?.toString(), "first");
    assert.notEqual(sourceSnapshot(root).fingerprint, before.fingerprint);
    assert.equal(
      spawnSync("git", ["-C", root, "add", "-f", "private-input"]).status,
      0,
    );
    assert.throws(() => sourceSnapshot(root), /image-source-invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("PR image gate is unconditional, read-only and uses the local qualification command", () => {
  const value = parse(
    readFileSync(
      new URL("../.github/workflows/image.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(value.on, { pull_request: null });
  assert.deepEqual(value.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(value.jobs), ["qualify"]);
  const job = value.jobs.qualify;
  assert.deepEqual(Object.keys(job).sort(), [
    "runs-on",
    "steps",
    "timeout-minutes",
  ]);
  assert.equal(job["timeout-minutes"], 20);
  assert.equal(job.steps[0].uses, "actions/checkout@v7");
  assert.equal(job.steps[1].uses, "actions/setup-node@v7");
  assert.equal(job.steps.at(-1).run, "pnpm image:qualify");
  for (const step of job.steps) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  }
  const installation = job.steps.find(
    (/** @type {{name?:string,run:string}} */ step) =>
      step.name === "Install checksum-pinned Trivy",
  ).run;
  assert(
    installation.includes(
      `/v${trivyVersion}/trivy_${trivyVersion}_Linux-64bit.tar.gz`,
    ),
  );
  assert(
    installation.includes(
      "bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf",
    ),
  );
  assert(installation.includes("sha256sum --check"));
});

test("image pins Node and pnpm to repository metadata and keeps a nonroot shell-free runtime", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const dockerfile = readFileSync(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  assert(
    dockerfile.includes(
      `FROM node:${manifest.engines.node}-bookworm-slim@sha256:`,
    ),
  );
  assert(
    dockerfile.includes(`npm install --global ${manifest.packageManager}`),
  );
  assert.match(
    dockerfile,
    /FROM gcr.io\/distroless\/cc-debian13:nonroot@sha256:[a-f0-9]{64}/,
  );
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(
    dockerfile,
    /ENTRYPOINT \["\/usr\/local\/bin\/node", "\/app\/dist\/cli.js"\]/,
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
