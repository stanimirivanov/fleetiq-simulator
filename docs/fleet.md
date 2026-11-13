# Bounded accelerated fleets

SIM-PR13 adds an explicit `fleet` command with private input files and aggregate
observations. Existing run/resume/fault modes and delivery receipts stay unchanged.
Fleet work is precomputed, bounded accelerated periodic capture; it is not a
wall-clock paced device, continuous ingestion service or durable fleet resume.

Copy [the reconnect configuration](../scenarios/reconnect-storm.json) to an owned
0700 directory outside Git. Copy the reviewed normal-day scenario/profile to its
private sibling filenames and supply an authorized route and private identity map.
All files must be owned 0600 regular single-link files without symlinks. The config
is limited to 16 KiB, identity/profile to 16 KiB each, scenario to 1 MiB and route
to 8 MiB. Identity lookup reads the private map once; no raw identity belongs in
config, Git, logs or metrics. The input directory is pinned during sibling reads.

```sh
node dist/cli.js validate --config /absolute/private/fleet.json
node dist/cli.js fleet --config /absolute/private/fleet.json
```

Each of 1–100 members has a unique logical device ID, unique private 15-digit
identity and unique explicit seed. Offset (milliseconds) and drift (ppm) belong
to that member's fresh playback cursor, including GPS-fix history. Equal clock
settings are allowed; state is independent. Existing route/profile validation
applies. Capture is periodic at `intervalMs`; trigger-only capture and fleet fault
mutation are outside this slice. `dropEvery: N` deliberately omits every Nth
capture per member before enqueue; 0 disables simulated loss. Model sampling still
advances, and loss counts never become server failures or successful ACKs.

The precomputed queues admit at most 1000 records/member and 16 MiB aggregate
encoded frames (`maxQueuedBytes` may reduce that ceiling). Immutable wire handles
are shared safely with scheduling rather than retaining a second payload copy.
One opaque lease owns one FIFO head; only a matching ACK removes it. Exhaustion
retains undelivered records in memory for diagnostics, then process exit discards
this non-durable fleet. Use the single-device durable path for restart recovery.
Admission overflow fails before TCP, with `fleet-overflow` / exit 4; the network
command also emits `{ "status": "fleet-rejected", "overflows": 1 }`.

`profile: "product"` caps active client attempts at **two**, preserving the current
FleetIQ compatibility limit. More members rotate through those slots. The separate
`reference-peer` profile allows up to 100, requires `authorizedReferencePeer: true`
and a literal loopback target; the Compose name is refused for that profile.
Authorize it only for an independent local peer, never to raise FleetIQ capacity.
Product mode retains the existing admitted loopback/exact private Compose target.

One attempt uses one strict socket with internal retries disabled. The closed
Effect scope settles before its lease is freed. Retry backoff holds no slot and
round-robin selection lets healthy members proceed. Attempts per head use the
existing `retry.maxAttempts`; login refusal is terminal for that member. A shared
monotonic run deadline and cancellation abort and await every running attempt.
Device clock drift cannot alter transport deadlines. Remote FIN/close callbacks
can lag client retirement; the cap is active client attempts, not an assertion
about every remote kernel socket in its closing states. The measured FD budget
includes client, peer, listener and retiring sockets.

Output has a fixed `status` and `metrics` layout, with no device/identity/seed/route
or endpoint labels. `fleet-completed` / exit 0 includes all intended loss and
matched ACKs; `fleet-incomplete` / exit 3 retains exhausted work; `fleet-timeout` /
exit 3 and `fleet-cancelled` / exit 130 preserve undelivered counts. No fleet
outcome is a normal delivery receipt or product/browser/hardware acceptance.

Counters distinguish captured, deliberately lost, acknowledged, queued,
undelivered and exhausted records. `attempts` and `retryAttempts` count actual
transport calls. `possibleDuplicateRecords` is an upper bound from retries, not
proof of remote duplicate acceptance; a failed login may transmit no AVL bytes.
Six fixed session-failure categories count observed refusals/timeouts/protocol
failures; whole-run expiry and cancellation do not blame the server. ACK latency
is real attempt-to-completed-scope time for matched ACKs, in fixed buckets ending
at 10/50/250/1000/5000/60000 ms plus an overflow bucket. Snapshots are detached.

Resources are actual process high-water RSS, sampled open-FD peaks and CPU deltas
(user/system microseconds) during execution. RSS includes process startup/history;
FD peaks are samples, not proof of unsampled instantaneous maxima. Preparation is
outside executor CPU deltas; the bounds gate measures the complete workload.
The [Node process APIs](https://nodejs.org/download/release/v24.18.0/docs/api/process.html#processresourceusage)
define RSS/CPU units; Linux `/proc/self/fd` supplies descriptor counts.

## Mechanical qualification

`pnpm test:coverage` appends `pnpm test:bounds` once after the disjoint coverage
groups. The unchanged canonical `pnpm check` therefore runs it before its final
live security gate. The new gate requires Linux `/proc`
and `taskset` (util-linux, available on the Ubuntu CI runner). It starts separate
pinned-Node children on one allowed CPU each. Each profile runs **100 devices and
200 real matched TCP ACKs**; a first-wave peer barrier proves 2 or 100 outstanding
requests. Private independent NX buffers exercise actual aggregate overflow
admission. Reports contain only validated fixed names and measured numbers.

The gate enforces RSS at most 256 MiB, one CPU affinity, queue ceiling, successful
ACK/attempt counts, exact profile peaks, an FD ceiling of baseline + 2×slots + 32,
cleanup within baseline + 4 descriptors, and a 30-second wall-clock workload limit.
CPU is measured, not inferred from device count. Negative controls reject missing,
extra, false or over-budget reports. This qualifies these synthetic workloads;
it is not an RSS proof for every route/model/input or installed capacity evidence.
The runtime image smoke separately uses enforced 256 MiB/one CPU container limits.
Installed fault/fleet acceptance remains SIM-PR18. No backend limit, public API,
persistent checkpoint schema, dependency or publication policy changes here.
