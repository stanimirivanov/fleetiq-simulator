import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DurableSpool, SpoolError } from "../../src/session/spool.ts";
import { FileStore } from "../../src/storage/spool.ts";
import { binding, limits, work } from "../support/playback/spool-fixture.ts";

function instance() {
  return mkdtempSync(join(tmpdir(), "fleetiq-spool-"));
}

test("reopen retains frozen pending boundaries and commits ACK plus cursor atomically", () => {
  const dir = instance();
  let store = new FileStore(dir);
  try {
    let spool = new DurableSpool(store, binding, work, limits, false);
    spool.advance();
    const pending = spool.prepare();
    assert.ok(pending);
    const bytes = pending.snapshot().bytes;
    spool.advance();
    store.close();
    store = new FileStore(dir);
    spool = new DurableSpool(store, binding, work, limits, true);
    const retry = spool.prepare();
    assert.ok(retry);
    assert.deepEqual(retry.snapshot().bytes, bytes);
    spool.acknowledge(retry);
    assert.equal(spool.stats.queued, 1);
    spool.advance();
    const tail = spool.prepare();
    assert.ok(tail);
    spool.acknowledge(tail);
    assert.deepEqual(
      [spool.stats.cursor, spool.stats.acknowledged, spool.stats.status],
      [3, 2, "complete"],
    );
    store.close();
    store = new FileStore(dir);
    spool = new DurableSpool(store, binding, work, limits, true);
    assert.equal(spool.prepare(), undefined);
    assert.equal(statSync(join(dir, "checkpoint.json")).mode & 0o777, 0o600);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overflow, age, mismatched binding and unsupported versions preserve authoritative bytes", () => {
  const dir = instance();
  const store = new FileStore(dir);
  try {
    const spool = new DurableSpool(
      store,
      binding,
      work,
      { ...limits, maxQueuedRecords: 1 },
      false,
    );
    spool.advance();
    const original = readFileSync(join(dir, "checkpoint.json"));
    assert.throws(() => spool.advance(), /spool-capacity/);
    assert.deepEqual(readFileSync(join(dir, "checkpoint.json")), original);
    assert.throws(
      () =>
        new DurableSpool(
          store,
          { ...binding, identity: "a".repeat(64) },
          work,
          limits,
          true,
        ),
      /spool-mismatch/,
    );
    assert.throws(
      () =>
        new DurableSpool(
          store,
          binding,
          work,
          { ...limits, maxAgeMs: 5 },
          true,
        ).advance(),
      /spool-expired/,
    );
    const body = store.read();
    assert.ok(body);
    const state = JSON.parse(body);
    store.write(JSON.stringify({ ...state, version: 99 }));
    const unknown = readFileSync(join(dir, "checkpoint.json"));
    assert.throws(
      () => new DurableSpool(store, binding, work, limits, true),
      /spool-invalid/,
    );
    assert.deepEqual(readFileSync(join(dir, "checkpoint.json")), unknown);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private storage rejects concurrent writers, symlinks, permissions and checksum corruption", () => {
  const dir = instance();
  let store = new FileStore(dir);
  try {
    new DurableSpool(store, binding, work, limits, false);
    assert.throws(() => new FileStore(dir), /spool-busy/);
    const path = join(dir, "checkpoint.json");
    const bytes = readFileSync(path);
    writeFileSync(path, "corrupt");
    assert.throws(() => store.read(), SpoolError);
    writeFileSync(path, bytes);
    chmodSync(path, 0o644);
    assert.throws(() => store.read(), SpoolError);
    chmodSync(path, 0o600);
    store.close();
    rmSync(path);
    symlinkSync(join(dir, "writer.sqlite"), path);
    store = new FileStore(dir);
    assert.throws(() => store.read(), SpoolError);
    store.close();
    chmodSync(dir, 0o755);
    assert.throws(() => new FileStore(dir), SpoolError);
    chmodSync(dir, 0o700);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real SIGKILL at enqueue/send/ACK publication boundaries recovers old or new state", {
  timeout: 20000,
}, async () => {
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { setTimeout: delay } = await import("node:timers/promises");
  for (const action of ["advance", "prepare", "ack", "hold"])
    for (const stage of action === "hold"
      ? ["hold"]
      : ["before-rename", "after-rename", "after-sync"]) {
      const dir = instance();
      let store = new FileStore(dir);
      try {
        const initial = new DurableSpool(store, binding, work, limits, false);
        if (action !== "advance") initial.advance();
        if (action === "ack") initial.prepare();
        store.close();
        const marker = join(dir, "ready");
        const child = spawn(
          process.execPath,
          [
            "tests/support/processes/spool-crash.ts",
            dir,
            action,
            stage,
            marker,
          ],
          { stdio: "ignore" },
        );
        const exited = once(child, "exit");
        try {
          const until = Date.now() + 3000;
          while (!existsSync(marker) && Date.now() < until) await delay(10);
          assert.equal(
            existsSync(marker),
            true,
            `worker did not reach ${action}/${stage}`,
          );
          if (action === "hold")
            assert.throws(() => new FileStore(dir), /spool-busy/);
        } finally {
          child.kill("SIGKILL");
          await exited;
        }
        store = new FileStore(dir);
        const recovered = new DurableSpool(store, binding, work, limits, true);
        const published = stage !== "before-rename";
        assert.equal(
          recovered.stats.cursor,
          action === "advance" ? (published ? 1 : 0) : 1,
        );
        assert.equal(
          recovered.stats.acknowledged,
          action === "ack" && published ? 1 : 0,
        );
        assert.equal(
          recovered.stats.queued,
          action === "advance"
            ? published
              ? 1
              : 0
            : action === "ack" && published
              ? 0
              : 1,
        );
        const pending = recovered.prepare();
        assert.equal(Boolean(pending), recovered.stats.queued > 0);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
});

test("invalid replay metadata is rejected and uncertain writes poison memory until reopen", () => {
  const dir = instance();
  let store = new FileStore(dir);
  try {
    assert.throws(
      () =>
        new DurableSpool(
          store,
          binding,
          [{ frame: null, atMs: NaN }],
          limits,
          false,
        ),
      /spool-invalid/,
    );
    let spool = new DurableSpool(store, binding, work, limits, false);
    assert.throws(
      () => new DurableSpool(store, binding, work, limits, false),
      /spool-exists/,
    );
    store.close();
    store = new FileStore(dir, (stage) => {
      if (stage === "before-rename") throw new SpoolError("spool-io");
    });
    spool = new DurableSpool(store, binding, work, limits, true);
    assert.throws(() => spool.advance(), /spool-io/);
    assert.throws(() => spool.prepare(), /spool-io/);
    store.close();
    store = new FileStore(dir);
    spool = new DurableSpool(store, binding, work, limits, true);
    assert.equal(spool.stats.cursor, 0);
    const local = work.map((item) => ({ ...item }));
    spool = new DurableSpool(store, binding, local, limits, true);
    local[0] = { atMs: 99, frame: null };
    spool.advance();
    assert.equal(spool.stats.atMs, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
