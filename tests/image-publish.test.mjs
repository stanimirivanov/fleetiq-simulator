import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  publishedReference,
  validatePublicationReceipt,
  validatePublicationSource,
} from "../tools/image-publish.mjs";
import { publicationFixture } from "./image-publish-fixture.mjs";

const revision = "a".repeat(40);
const repository = "stanimirivanov/fleetiq-simulator";
const id = `sha256:${"b".repeat(64)}`;
const fingerprint = "c".repeat(64);
const reference = `ghcr.io/${repository}@sha256:${"d".repeat(64)}`;
function receipt() {
  return {
    schemaVersion: 1,
    status: "qualified",
    source: {
      repository: `https://github.com/${repository}`,
      revision,
      fingerprint,
      clean: true,
    },
    image: { id, platform: "linux/amd64" },
    checks: [
      "restricted-runtime",
      "bounded-loopback-ack",
      "vulnerability-and-secret-scan",
      "all-layers",
      "deleted-identity-canary",
    ],
  };
}
function source() {
  return {
    ref: "refs/heads/main",
    repository,
    revision,
    mainRevision: revision,
    requestedRevision: "",
    pulls: [{ merged_at: "2026-11-12T00:00:00Z", merge_commit_sha: revision }],
  };
}
function image() {
  return {
    Id: id,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [reference],
    Config: {
      User: "65532:65532",
      WorkingDir: "/app",
      Entrypoint: ["/usr/local/bin/node", "/app/dist/cli.js"],
      Labels: {
        "org.opencontainers.image.source": `https://github.com/${repository}`,
        "org.opencontainers.image.revision": revision,
        "com.fleetiq.source.sha256": fingerprint,
      },
    },
  };
}
test("publication admits only current reviewed main; blank input selects the dispatch revision", () => {
  assert.doesNotThrow(() => validatePublicationSource(source()));
  assert.doesNotThrow(() =>
    validatePublicationSource({ ...source(), requestedRevision: revision }),
  );
  for (const value of [
    { ...source(), ref: "refs/heads/feature" },
    { ...source(), repository: "foreign/repo" },
    { ...source(), mainRevision: "e".repeat(40) },
    { ...source(), requestedRevision: "bad" },
    { ...source(), pulls: [] },
    { ...source(), pulls: [{ merged_at: null, merge_commit_sha: revision }] },
  ])
    assert.throws(
      () => validatePublicationSource(value),
      /image-publication-source-invalid/,
    );
});
test("publication requires complete clean qualification for the exact source and image", () => {
  assert.doesNotThrow(() => validatePublicationReceipt(receipt(), revision));
  for (const value of [
    { ...receipt(), status: "failed" },
    { ...receipt(), source: { ...receipt().source, clean: false } },
    { ...receipt(), source: { ...receipt().source, revision: "e".repeat(40) } },
    { ...receipt(), checks: [] },
    { ...receipt(), image: { id: "tag:latest", platform: "linux/amd64" } },
  ])
    assert.throws(
      () => validatePublicationReceipt(value, revision),
      /image-publication-qualification-invalid/,
    );
});
test("registry readback must match qualified content, labels and immutable repository digest", () => {
  assert.equal(publishedReference(receipt(), image()), reference);
  for (const value of [
    { ...image(), Id: `sha256:${"e".repeat(64)}` },
    { ...image(), RepoDigests: [] },
    {
      ...image(),
      RepoDigests: [`ghcr.io/foreign/repo@sha256:${"f".repeat(64)}`],
    },
    { ...image(), Config: { ...image().Config, User: "0" } },
  ])
    assert.throws(
      () => publishedReference(receipt(), value),
      /image-publication-registry-invalid/,
    );
});
test("publisher is manual on main, read-only until qualification and uses v7 actions", () => {
  const workflow = parse(
    readFileSync(
      new URL("../.github/workflows/publish.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(
    workflow.on.workflow_dispatch.inputs.source_revision.required,
    false,
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["publish"]);
  const job = workflow.jobs.publish;
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(job.permissions, { contents: "read", packages: "write" });
  assert.equal(job.steps[0].uses, "actions/checkout@v7");
  assert.equal(job.steps[0].with["persist-credentials"], false);
  assert.equal(job.steps[1].uses, "actions/setup-node@v7");
  const commands = job.steps
    .filter((/** @type {{run?:string}} */ step) => step.run)
    .map((/** @type {{run:string}} */ step) => step.run);
  assert(
    commands.indexOf("pnpm check") < commands.indexOf("pnpm image:qualify"),
  );
  assert(
    commands.indexOf("pnpm image:qualify") <
      commands.indexOf("node tools/image-publish.mjs publish"),
  );
  assert(commands.includes("node tools/image-publish.mjs source"));
  for (const step of job.steps) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  }
});

test("native publication projects only immutable evidence and removes temporary authentication on success and failure", () => {
  const fixture = publicationFixture();
  try {
    const script = fileURLToPath(
      new URL("../tools/image-publish.mjs", import.meta.url),
    );
    const success = spawnSync(process.execPath, [script, "publish"], {
      cwd: fixture.root,
      env: fixture.env,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(success.status, 0, success.stderr);
    const publication = JSON.parse(
      readFileSync(
        join(fixture.root, ".verification/publication.json"),
        "utf8",
      ),
    );
    assert.equal(publication.image, fixture.reference);
    assert(success.stdout.includes(fixture.reference));
    assert(!success.stdout.includes(fixture.token));
    for (const args of fixture.commands()) {
      assert(!JSON.stringify(args).includes(fixture.token));
      assert(!existsSync(args[1]));
    }
    const failure = spawnSync(process.execPath, [script, "publish"], {
      cwd: fixture.root,
      env: { ...fixture.env, FIXTURE_FAIL: "1" },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /image-publication-tool-failed-docker/);
    assert(!failure.stderr.includes(fixture.token));
    assert(
      !existsSync(join(fixture.root, ".verification/publication.json")),
      "failed publication must not retain stale acceptance",
    );
    for (const args of fixture.commands()) assert(!existsSync(args[1]));
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
