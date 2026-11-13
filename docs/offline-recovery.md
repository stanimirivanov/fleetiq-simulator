# Durable single-device offline recovery

SIM-PR11 adds `run` / `resume` for an accelerated playback config containing
`playback` instead of `record`. Existing single-record inputs remain compatible;
`encode` still encodes one record. `validate` checks playback inputs and scheduling
offline without creating state or loading TCP; it does not qualify an existing
checkpoint for resume. Run/resume performs that check while holding the writer lock.

Start with [scenarios/offline.json](../scenarios/offline.json), a run-config template.
Copy it to an owned 0700 directory outside Git, alongside private route, scenario,
profile and identity files. Use the basenames in that template, copy the reviewed
normal-day scenario/profile, and supply a valid bare GeoJSON LineString. The one
logical `sim-a` identity must be an authorized private 15-digit device identity;
no global synthetic reservation is assumed. All files must be owned, single-link,
regular, mode 0600 and non-symlink. The directory is pinned by descriptor for
sibling reads; `private-state` is created separately as 0700. Do not use public
shared directories, network filesystems or a state directory belonging to another app.

```sh
node dist/cli.js validate --config /absolute/private-instance/private-run.json
node dist/cli.js run --config /absolute/private-instance/private-run.json
node dist/cli.js resume --config /absolute/private-instance/private-run.json
```

Config/profile/identity files are limited to 16 KiB, scenario to 1 MiB and route
to 8 MiB; existing geometry/phase bounds still apply. Relative input/state references
are sibling basenames only. Config queue bounds are the existing 16-record,
1280-byte and 1000-record limits, plus a 16 MiB conservative metadata/frozen-byte
budget (minimum configured budget 4096 bytes). Age is 1 ms–7 virtual days; the
example uses 24h. Overflow/expiry fails without dropping old records.

`offlineUntilMs` suppresses sends before that virtual timestamp, within the
scenario horizon. Capture continues through ordinary connection failures; the
next send tick can retry. Refusal, wrong count or unsolicited replies block further
sends for that invocation while remaining capture is retained. Cancellation and
run-budget expiry stop capture. `timingProfile: "accelerated"` processes the
bounded virtual schedule as fast as persistence/IO allows, yielding between ticks.
It is not real-time hardware timing. ACK/run budgets remain real monotonic time.

## Checkpoint and recovery contract

Checkpoint version 1 has a producer semantic version, separate config/route/
profile/scenario/identity/schedule SHA-256 bindings, next work cursor, virtual time,
capture/ACK counters, FIFO frozen record bytes, frozen pending packet, logical
submission count and status. Bindings hash normalized JSON inputs and the entire
ordered encoded schedule. No raw identity is stored or printed. Records still
contain private location/IO data: never commit or attach the checkpoint.

The current seed model has no mutable PRNG stream. Replaying the bounded schedule
reconstructs route/fix/random decisions; capture ordinal and virtual cursor replace
redundant internal snapshots. The schedule digest refuses semantic/encoder changes
even when input versions have not changed. Pending bytes must match an exact FIFO
prefix and retain the original boundary after later enqueues. Paused downtime does
not advance virtual time or queue age; gap simulation remains separate work.

Enqueue and next-capture cursor commit together before send eligibility. Preparing
a packet commits its exact bytes before transmission. ACK removal, ACK ordinal and
current capture cursor commit in one replacement. Unknown versions, corruption or
binding mismatch refuse resume without replacing authoritative data. `run` refuses
an existing checkpoint; `resume` requires one. Completed resumes send nothing.

Writes create a private exclusive temporary file, flush it, rename to the fixed
checkpoint name, then flush the pinned directory. Recovery discards only the
validated uncommitted temporary file while exclusively locked. A write failure
poisons the in-memory instance; reopen to discover the old/new authoritative state.
An interruption after a remote acceptance but before ACK commit can retransmit the
same packet. This is at-least-once recovery, not exactly-once server effects.

Node's built-in [SQLite API](https://nodejs.org/download/release/v24.18.0/docs/api/sqlite.html)
provides only a persistent OS-backed exclusive lock and application marker; queue
data stays in checksummed JSON, not SQL. The pinned Node API is release-candidate
stability, adds no package/native build dependency, and is exercised in the shipped
restricted image. [SQLite exclusive locking](https://sqlite.org/pragma.html#pragma_locking_mode)
releases on close/process death, so no stale PID/heartbeat lease is reclaimed.
Never delete/replace `writer.sqlite` while a process is active. The adapter supports
local Linux filesystems honoring locks, atomic rename and fsync; checksums detect
corruption and are not authentication against another process with the same UID.

SIGINT/SIGTERM retain committed work and exit 130; SIGKILL recovery is covered by
process tests. No hard power-loss/storage-controller test is claimed. A successful
receipt counts the completed workload cumulatively across resumes, not physical
transmissions; retries may repeat server effects. Expected session failure is 3,
checkpoint/privacy/resource rejection is 4, invalid input is 2, and unexpected
programming defects remain redacted internal failures (1). No success receipt is
emitted for incomplete work. Submission counters count preparations/calls, not
hidden transport-internal attempts. Fleet, gap/fault scheduling, migrations and
installed/hardware qualification remain later slices. The byte budget is not an
RSS or filesystem-volume proof.
