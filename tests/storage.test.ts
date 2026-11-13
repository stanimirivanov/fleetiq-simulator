import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SpoolError } from "../src/session/spool.ts";
import { FileStore } from "../src/storage/spool.ts";

test("atomic adapter keeps old/new files at each commit boundary and safely reopens orphan temp", () => {
  for (const stage of ["before-rename", "after-rename", "after-sync"]) {
    const dir = mkdtempSync(join(tmpdir(), "fleetiq-store-"));
    let store = new FileStore(dir);
    try {
      assert.equal(store.read(), undefined);
      store.write("old");
      store.close();
      store = new FileStore(dir, (at) => {
        if (at === stage) throw new SpoolError("spool-io");
      });
      assert.throws(() => store.write("new"), /spool-io/);
      store.close();
      store = new FileStore(dir);
      assert.equal(store.read(), stage === "before-rename" ? "old" : "new");
      store.write("final");
      assert.equal(store.read(), "final");
      store.close();
      store.close();
      assert.throws(() => store.write("closed"), SpoolError);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("adapter rejects private-path violations, oversized files and corrupt envelopes without replacing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleetiq-store-"));
  let store = new FileStore(dir);
  try {
    store.write("body");
    assert.throws(() => new FileStore(dir), /spool-busy/);
    const path = join(dir, "checkpoint.json");
    for (const value of [
      "bad",
      JSON.stringify({ body: "body", checksum: "bad" }),
      JSON.stringify({ body: 1, checksum: "bad" }),
      JSON.stringify({ body: "body", checksum: "bad", extra: true }),
    ]) {
      writeFileSync(path, value);
      assert.throws(() => store.read(), SpoolError);
      assert.equal(readFileSync(path, "utf8"), value);
    }
    writeFileSync(path, Buffer.alloc(17000001));
    assert.throws(() => store.read(), SpoolError);
    rmSync(path);
    store.write("valid");
    chmodSync(path, 0o644);
    assert.throws(() => store.read(), SpoolError);
    chmodSync(path, 0o600);
    linkSync(path, join(dir, "hardlink"));
    assert.throws(() => store.read(), SpoolError);
    rmSync(join(dir, "hardlink"));
    store.close();
    rmSync(path);
    symlinkSync(join(dir, "writer.sqlite"), path);
    store = new FileStore(dir);
    assert.throws(() => store.read(), SpoolError);
    store.close();
    chmodSync(dir, 0o755);
    assert.throws(() => new FileStore(dir), SpoolError);
    chmodSync(dir, 0o700);
    symlinkSync(join(dir, "writer.sqlite"), join(dir, "checkpoint.next"));
    assert.throws(() => new FileStore(dir), SpoolError);
    rmSync(join(dir, "checkpoint.next"));
    assert.throws(
      () => new FileStore(join(dir, "checkpoint.json")),
      SpoolError,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected same-process opener cannot release another writer kernel lock", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "fleetiq-lock-"));
  const store = new FileStore(dir);
  try {
    assert.throws(() => new FileStore(dir), /spool-busy/);
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {FileStore} from "./src/storage/spool.ts"; try {const s=new FileStore(process.argv[1]);s.close();process.exitCode=0;} catch(e){process.exitCode=e instanceof Error&&e.message==="spool-busy"?23:24;}',
        dir,
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    assert.equal(
      probe.status,
      23,
      "exclusive lock must still block a separate process",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsafe existing lock files are refused without repairing or replacing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleetiq-lock-private-"));
  const lock = join(dir, "writer.sqlite");
  const original = new FileStore(dir);
  original.close();
  try {
    chmodSync(lock, 0o644);
    assert.throws(() => new FileStore(dir), /spool-invalid/);
    chmodSync(lock, 0o600);
    linkSync(lock, join(dir, "alias"));
    assert.throws(() => new FileStore(dir), /spool-invalid/);
    rmSync(join(dir, "alias"));
    const reopened = new FileStore(dir);
    reopened.write("still-usable");
    assert.equal(reopened.read(), "still-usable");
    reopened.close();
    rmSync(lock);
    symlinkSync(join(dir, "checkpoint.json"), lock);
    assert.throws(() => new FileStore(dir), /spool-invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
