import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSnapshot } from "../src/qualification/image/image-qualify.mjs";

/** Create a clean repository and native fake tools; never authenticate to a registry. */
export function publicationFixture() {
  const directory = mkdtempSync(join(tmpdir(), "sim-publication-test-"));
  const root = join(directory, "source");
  const bin = join(directory, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(root, ".gitignore"), ".verification/\n");
  for (const args of [
    ["init", "-q"],
    ["add", ".gitignore"],
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    const result = spawnSync("git", args, { cwd: root });
    assert(!result.error && result.status === 0);
  }
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  const fingerprint = sourceSnapshot(root).fingerprint;
  const id = `sha256:${"b".repeat(64)}`;
  const repository = "stanimirivanov/fleetiq-simulator";
  const reference = `ghcr.io/${repository}@sha256:${"d".repeat(64)}`;
  const receipt = {
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
  mkdirSync(join(root, ".verification"));
  writeFileSync(
    join(root, ".verification/image.json"),
    JSON.stringify(receipt),
  );
  const metadata = {
    Id: id,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [reference],
    Config: {
      User: "65532:65532",
      WorkingDir: "/app",
      Entrypoint: ["/usr/local/bin/node", "/app/dist/cli.js"],
      Labels: {
        "org.opencontainers.image.source": receipt.source.repository,
        "org.opencontainers.image.revision": revision,
        "com.fleetiq.source.sha256": fingerprint,
      },
    },
  };
  writeFileSync(join(directory, "metadata.json"), JSON.stringify(metadata));
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const revision=process.env.FIXTURE_REVISION;
console.log(JSON.stringify(process.argv.at(-1).endsWith('/main')?{sha:revision}:[{merged_at:'2026-11-12',merge_commit_sha:revision}]));
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2), command=args[2];
fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n');
if(process.env.GH_TOKEN||process.env.GHCR_TOKEN||process.env.GITHUB_TOKEN)process.exit(91);
if(command==='login'){
 if(fs.readFileSync(0,'utf8')!==process.env.FIXTURE_TOKEN)process.exit(92);
 fs.writeFileSync(args[1]+'/config.json','temporary private auth',{mode:0o600});
}
if(command==='push'&&process.env.FIXTURE_FAIL){console.error(process.env.FIXTURE_TOKEN);process.exit(2);}
if(command==='image')console.log(fs.readFileSync(process.env.FIXTURE_METADATA,'utf8').replace(/^/,'[')+']');
`,
    { mode: 0o700 },
  );
  const token = `synthetic-${Date.now()}`;
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: revision,
    GITHUB_REPOSITORY: repository,
    GITHUB_ACTOR: "maintainer",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
    GHCR_TOKEN: token,
    REQUESTED_REVISION: "",
    FIXTURE_REVISION: revision,
    FIXTURE_TOKEN: token,
    FIXTURE_METADATA: join(directory, "metadata.json"),
    FIXTURE_LOG: join(directory, "commands.jsonl"),
    GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
  };
  return {
    directory,
    root,
    env,
    reference,
    token,
    commands: () =>
      readFileSync(env.FIXTURE_LOG, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
