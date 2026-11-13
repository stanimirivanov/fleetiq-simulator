import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SpoolError } from "../session/spool.ts";

/** Test-only observation seam; no fault action or environment control is exposed to config. */
type Stage = "before-rename" | "after-rename" | "after-sync";

/** Maps expected OS/storage failures without swallowing programming defects or echoing paths. */
function io<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (
      error instanceof Error &&
      "errcode" in error &&
      typeof error.errcode === "number"
    ) {
      if ([5, 6].includes(error.errcode)) throw new SpoolError("spool-busy");
      if ([11, 26].includes(error.errcode))
        throw new SpoolError("spool-invalid");
      if ([3, 8, 10, 13, 14].includes(error.errcode))
        throw new SpoolError("spool-io");
    }
    if (error instanceof Error && "errno" in error && "syscall" in error)
      throw new SpoolError("spool-io");
    throw error;
  }
}

/**
 * Linux private JSON checkpoint adapter. SQLite holds only an exclusive OS-released
 * writer lock; checkpoint bytes use temp fsync → rename → directory fsync.
 * Hold close() until all queue operations finish. Never delete/replace the lock file.
 */
export class FileStore {
  #directory: number | undefined;
  #db: DatabaseSync | undefined;
  #lock: Stats | undefined;
  readonly #hook: (stage: Stage) => void;

  /** Pins the owned 0700 directory inode; competing writers fail without stale-lock reclamation. */
  constructor(directory: string, hook: (stage: Stage) => void = () => {}) {
    this.#hook = hook;
    try {
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
      this.#directory = io(() =>
        openSync(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
      const stat = fstatSync(this.#directory);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
        throw new SpoolError("spool-invalid");
      let prior: Stats | undefined;
      try {
        prior = lstatSync(this.#path("writer.sqlite"));
        this.#validate(prior);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      const fresh = prior === undefined || prior.size === 0;

      // Only SQLite may open/close this inode: unrelated closes release POSIX locks.
      this.#db = io(() => new DatabaseSync(this.#path("writer.sqlite")));
      if (prior === undefined) chmodSync(this.#path("writer.sqlite"), 0o600);
      this.#lock = lstatSync(this.#path("writer.sqlite"));
      this.#validate(this.#lock);
      if (
        prior &&
        (prior.ino !== this.#lock.ino || prior.dev !== this.#lock.dev)
      )
        throw new SpoolError("spool-invalid");
      const db = this.#db;
      io(() => {
        db.exec(
          "PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;",
        );
        const marker = db
          .prepare("PRAGMA application_id")
          .get()?.application_id;
        if (!fresh && marker !== 1179210067)
          throw new SpoolError("spool-invalid");
        if (fresh)
          db.exec("PRAGMA application_id=1179210067; COMMIT; BEGIN EXCLUSIVE;");
      });

      // An uncommitted temporary file is never authoritative after an interrupted write.
      try {
        const fd = this.#file("checkpoint.next");
        closeSync(fd);
        unlinkSync(this.#path("checkpoint.next"));
        fsyncSync(this.#directory);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    } catch (error) {
      this.close();
      if (error instanceof Error && "errno" in error)
        throw new SpoolError("spool-io");
      throw error;
    }
  }

  /** Rejects unsafe metadata without opening an inode that might hold another writer's lock. */
  #validate(stat: Stats): void {
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 17000000
    )
      throw new SpoolError("spool-invalid");
  }

  /** Opens only validated checkpoint inodes, excluding aliases of the SQLite lock database. */
  #file(name: string): number {
    const prior = lstatSync(this.#path(name));
    this.#validate(prior);
    if (prior.ino === this.#lock?.ino && prior.dev === this.#lock.dev)
      throw new SpoolError("spool-invalid");
    const fd = openSync(
      this.#path(name),
      constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(fd);
      this.#validate(stat);
      if (stat.ino !== prior.ino || stat.dev !== prior.dev)
        throw new SpoolError("spool-invalid");
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return fd;
  }

  /** Resolves fixed basenames through the pinned directory descriptor rather than a mutable parent path. */
  #path(name: string): string {
    if (this.#directory === undefined) throw new SpoolError("spool-io");
    return `/proc/self/fd/${this.#directory}/${name}`;
  }

  /** Returns only a checksum-verified body; absent state is distinct from corrupted state. */
  read(): string | undefined {
    let fd: number;
    try {
      fd = this.#file("checkpoint.json");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      return io(() => {
        throw error;
      });
    }
    let text: string;
    try {
      const bytes = Buffer.alloc(Math.min(fstatSync(fd).size + 1, 17000001));
      let size = 0;
      while (size < bytes.length) {
        const n = io(() =>
          readSync(fd, bytes, size, bytes.length - size, null),
        );
        if (!n) break;
        size += n;
      }
      if (size === bytes.length) throw new SpoolError("spool-invalid");
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, size),
        );
      } catch {
        throw new SpoolError("spool-invalid");
      }
    } finally {
      closeSync(fd);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SpoolError("spool-invalid");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "body,checksum" ||
      !("body" in value) ||
      typeof value.body !== "string" ||
      !("checksum" in value) ||
      typeof value.checksum !== "string" ||
      createHash("sha256").update(value.body).digest("hex") !== value.checksum
    )
      throw new SpoolError("spool-invalid");
    return value.body;
  }

  /** Completes durable replacement before returning; an interrupted write leaves old or new JSON authoritative. */
  write(body: string): void {
    if (body.length > 16777216) throw new SpoolError("spool-capacity");
    const bytes = JSON.stringify({
      checksum: createHash("sha256").update(body).digest("hex"),
      body,
    });
    if (Buffer.byteLength(bytes) > 17000000)
      throw new SpoolError("spool-capacity");
    io(() => {
      const fd = openSync(
        this.#path("checkpoint.next"),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.#hook("before-rename");
      renameSync(this.#path("checkpoint.next"), this.#path("checkpoint.json"));
      this.#hook("after-rename");
      if (this.#directory === undefined) throw new SpoolError("spool-io");
      fsyncSync(this.#directory);
      this.#hook("after-sync");
    });
  }

  /** Releases kernel locks on normal completion; SIGKILL relies on OS descriptor cleanup instead. */
  close(): void {
    try {
      this.#db?.close();
    } finally {
      this.#db = undefined;
      if (this.#directory !== undefined) closeSync(this.#directory);
      this.#directory = undefined;
    }
  }
}
