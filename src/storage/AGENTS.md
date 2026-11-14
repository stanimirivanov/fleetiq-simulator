# Private checkpoint adapter

Own filesystem and SQLite effects here; session code owns checkpoint policy and
state through an immutable-string persistence port. Storage may depend on session,
node:fs/crypto/sqlite; no dependency on CLI, transport or scenario state.

Hold the kernel-backed writer lock until close; never reclaim it using a PID,
heartbeat or lock-file deletion. Pin the private directory inode, reject links and
unsafe ownership/modes, bound reads before parsing, and preserve fixed categories.
Flush temp → rename → flush directory before returning commit success. Do not add
production fault controls: the constructor hook exists for crash-boundary tests.

`node --test tests/storage/spool.test.ts tests/session/spool.test.ts` checks old/new publication,
privacy, corruption, concurrent writers and actual process death. The image gate
must exercise the shipped SQLite/private filesystem path. Follow the shared
comment standard and keep source inventories/coverage current.
