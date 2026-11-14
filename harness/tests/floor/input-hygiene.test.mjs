import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkFloor } from "../../src/verification/floor.mjs";
import { fixture } from "../../support/floor-fixture.mjs";

test("floor rejects ordinary and committed capture paths even without secret-like contents", (context) => {
  const { root, base, write, git } = fixture(context);
  write("nested/capture.bin", "innocuous synthetic fixture\n");
  git(["add", "nested/capture.bin"]);
  assert.ok(checkFloor(base, root).includes("private-path-tracked"));
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "capture fixture",
  ]);
  const committed = git(["rev-parse", "HEAD"]);
  assert.ok(checkFloor(committed, root).includes("private-path-tracked"));
});

test("ignore and floor policies cover force-added nested and case-variant private paths", (context) => {
  const { root, base, write, git } = fixture(context);
  write(
    ".gitignore",
    readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8"),
  );
  for (const path of [
    "private-record.json",
    "nested/PRIVATE-input.txt",
    "private-directory/record.json",
    "nested/record.BIN",
    "trace.pcap",
    "nested/TRACE.PCAPNG",
    "nested/capture.BIN/record.json",
  ]) {
    write(path, "innocuous synthetic fixture\n");
    assert.equal(git(["check-ignore", "--", path]), path);
    git(["add", "-f", "--", path]);
    assert.ok(checkFloor(base, root).includes("private-path-tracked"));
    git(["rm", "--cached", "--", path]);
    assert.deepEqual(checkFloor(base, root), []);
  }
});

test("floor permits textual hex fixtures and ignores untracked private artifacts", (context) => {
  const { root, base, write, git } = fixture(context);
  write(
    ".gitignore",
    readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8"),
  );
  write("tests/hex-fixture.ts", 'export const frame = "00000102";');
  git(["add", "tests/hex-fixture.ts"]);
  assert.deepEqual(checkFloor(base, root), []);
  write("private-record.json", "{}\n");
  write("capture.pcapng", "synthetic\n");
  assert.equal(
    git(["check-ignore", "--", "private-record.json", "capture.pcapng"]),
    "private-record.json\ncapture.pcapng",
  );
  assert.deepEqual(checkFloor(base, root), []);
});

test("private-path diagnostics never print the tracked filename", (context) => {
  const { root, base, write, git } = fixture(context);
  const path = "nested/private-\nconfidential-name.json";
  write(path, "{}\n");
  git(["add", "-f", "--", path]);
  const result = spawnSync(
    process.execPath,
    [
      new URL("../../src/verification/floor.mjs", import.meta.url).pathname,
      base,
    ],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private-path-tracked/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /confidential-name|nested|private-\n/,
  );
});

test("pre-commit blocks private index paths before delegating to fast verification", (context) => {
  const { root, base, write, git } = fixture(context);
  const hook = readFileSync(
    new URL("../../../.githooks/pre-commit", import.meta.url),
    "utf8",
  );
  write(".githooks/pre-commit", hook);
  write(
    "harness/src/verification/pre-commit.sh",
    readFileSync(
      new URL("../../src/verification/pre-commit.sh", import.meta.url),
      "utf8",
    ),
  );
  write(
    "bin/pnpm",
    `#!/bin/sh
case "$1" in
  floor) exec "$FLEETIQ_NODE" "$FLEETIQ_CHECKER" "$FLEETIQ_BASE" ;;
  check:fast) printf '%s\\n' fast >> "$FLEETIQ_DELEGATE_LOG" ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(join(root, "bin/pnpm"), 0o700);
  git(["add", "."]);
  const log = join(root, ".git/delegate-log");
  const run = () =>
    spawnSync("/bin/sh", [".githooks/pre-commit"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        FLEETIQ_NODE: process.execPath,
        FLEETIQ_CHECKER: new URL(
          "../../src/verification/floor.mjs",
          import.meta.url,
        ).pathname,
        FLEETIQ_BASE: base,
        FLEETIQ_DELEGATE_LOG: log,
      },
    });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(readFileSync(log, "utf8"), "fast\n");
  rmSync(log);
  write("private-fixture.json", "{}\n");
  git(["add", "-f", "private-fixture.json"]);
  const blocked = run();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /private-path-tracked/);
  assert.throws(() => readFileSync(log), { code: "ENOENT" });
  assert.equal(
    readFileSync(join(root, "private-fixture.json"), "utf8"),
    "{}\n",
  );
});
