import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { trivyVersion } from "../../src/qualification/image/image-qualify.mjs";

test("PR image gate is unconditional, read-only and uses the local qualification command", () => {
  const value = parse(
    readFileSync(
      new URL("../../../.github/workflows/image.yml", import.meta.url),
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
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const dockerfile = readFileSync(
    new URL("../../../Dockerfile", import.meta.url),
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
