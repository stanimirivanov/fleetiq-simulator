import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  sourceSnapshot,
  validateImage,
} from "../../src/qualification/image/image-qualify.mjs";

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
