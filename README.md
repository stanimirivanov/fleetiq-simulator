# FleetIQ simulator

For repository boundaries, agent instructions and verification commands, see
[AGENTS.md](AGENTS.md) and the [coding harness](HARNESS.md).

The simulator validates a versioned Codec 8 or Codec 8 Extended record offline or sends it to an
authorized local TCP listener using a private device identity file.

Linux is the supported runtime. Use the Node and pnpm pins in
[package.json](package.json) and the scanner release defined in
[tools/secrets.mjs](tools/secrets.mjs). The
[CI workflow](.github/workflows/ci.yml) contains the Linux x64 scanner checksum.
Confirm actual tool versions against those definitions before verification.

```sh
pnpm install --frozen-lockfile
pnpm check
node dist/cli.js validate --config ./private-record.json
node dist/cli.js encode --config ./private-record.json --output ./private-frame.bin
```

Keep input and output in an owned private directory outside the checkout.
The CLI reads a regular UTF-8 JSON file of at most 16 KiB and creates an output
file exclusively with mode 0600. Success is silent. Invalid input and file
errors return status 2 with a fixed error category on stderr.

```json
{
  "schemaVersion": 1,
  "timestampMs": "0",
  "priority": 0,
  "longitudeE7": 0,
  "latitudeE7": 0,
  "altitude": 0,
  "angle": 0,
  "satellites": 0,
  "speed": 0,
  "eventId": 0,
  "io": []
}
```

Timestamp is a canonical decimal u64 string. Coordinates are signed degrees
scaled by 10⁷. Altitude and speed are raw unsigned 16-bit values. IO contains
up to 64 entries of the form `{"id": 1, "hex": "00"}`; values are exactly 1, 2,
4 or 8 bytes. The encoder groups entries by width and preserves order within
each group. It derives wire counts, length and CRC. See the
[Teltonika Codec 8 TCP examples](https://wiki.teltonika-gps.com/view/Codec#Codec_8).

For Codec 8 Extended, add `"codec": "8e"` and `"variableIo": []` to the
record (including the nested `record` in a run config). Event and IO IDs then
admit 0–65535; group counts and IDs use two bytes. `io` retains the fixed
1/2/4/8-byte widths. `variableIo` contains `{ "id": 65535, "hex": "00010203ff" }`
entries of 1–256 bytes; these always use NX, even for a fixed-sized value.
The Extended profile rejects duplicate IDs across both lists, more than 64
combined entries and TCP frames larger than 1280 bytes. Values remain raw hex;
leading zeros and order within each group are preserved.

An absent `codec` or explicit `"codec": "8"` selects the original Codec 8
contract. `variableIo` is required only for Extended; unknown selectors and
cross-codec fields reject. `schemaVersion` remains 1: this is an additive
selector for this release, while older binaries reject the new fields.
See the [manufacturer's Extended format](https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended).
`pnpm test:platform /path/to/exact-platform-checkout` compares both codecs with
the pinned native decoder; that decoder rejects timestamps above signed i64
while the offline encoders retain exact u64 values.

`pnpm check` enforces the verification floor, style, strict types, architecture,
build, tests, coverage, redacted secret scanning and current dependency advisories.
The quality thresholds are defined in [CONSTRAINTS.md](CONSTRAINTS.md).
[tools/coverage.mjs](tools/coverage.mjs) enforces them in separate wire,
session/transport and CLI groups, with exact suite/source inventories.

## Send one record over TCP

Run `node dist/cli.js run --config ./private-run.json` against an authorized
local listener. The version 1 run config contains these fields:

| Field | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `record` | The complete version 1 record shown above |
| `deviceId` | A logical name, such as `sim-a` |
| `identityFile` | A filename beside the config, containing a JSON object mapping that one logical name to its 15-digit device identity |
| `target` | Optional `{"transport":"tcp","host":"127.0.0.1","port":55027}` (default). Literal `127.0.0.1`, `::1`, or the exact Compose service name `tcp-ingestion` are accepted |
| `retry` | Optional overrides for `ackDeadlineMs`, `maxAttempts`, and `totalDeadlineMs`. Defaults are defined in [session policy](src/session/state.ts) |
| `connectionPolicy` | Optional `single-batch` (default) or `persistent-compliant-peer` |

For the isolated deployment demo, `tcp-ingestion` resolves through IPv4 DNS once
per connection attempt. Every returned address must be loopback or RFC 1918
private space; public, link-local, mixed and empty answers fail closed. The socket
uses the validated numeric address without a second lookup. Arbitrary hostnames
and non-loopback literal addresses remain rejected. The default stays loopback.
DNS admission restricts destinations; it does not authenticate the peer. Use the
approved isolated Compose network and authorize the target before sending.

Keep both files in an owned private directory. The identity file must be owned
by the current user, have no group or other permissions, and be a regular
file. Use `chmod 600` on Linux. Each input is capped at 16 KiB.

The client sends a length-prefixed login and waits for acceptance before
sending the frame. One exact four-byte count completes the batch. A refusal
ends the run. After an uncertain reply the client closes the socket before
retrying the same bytes. By default it closes the socket after success as well.
Persistent mode is for peers that emit exactly one ACK per batch. Count-only
ACKs cannot distinguish an unsolicited duplicate of an earlier equal-count
batch on a reused connection. This command sends one batch per run.

Exit 0 prints a receipt for the wire ACK. Exit 1 reports a redacted
`internal-error` for an unexpected defect. Exit 2 is invalid input, 3 is a
session failure, and 130 is cancellation. A retry can result in duplicate
acceptance if the peer received a frame and its ACK was lost. Projection and
browser verification are separate.


Expected failures keep their existing exit codes and fixed categories. Run
validation proceeds through arguments, config file and schema, record, private
identity file, then session bounds and transport. The first failing stage wins.
Filesystem failures are classified at the operation that produced them.
Unexpected defects produce only `internal-error`, without a stack trace or
exception text.

The wire layer exposes the AVL payload separately from the TCP envelope.
`Codec8Frame` admits TCP frames through codec-specific factories and retains a private
copy of its bytes and declared count. Transport accepts these frames and
continues to accept raw Buffer inputs through wire validation.
`fromBytes` remains Codec 8 only; `fromExtendedBytes` explicitly admits Codec 8E.
Transport snapshots admit either codec, with Extended IO structure checked too.

A receipt counts each locally acknowledged record once, even if it was sent
several times. After a connection failure without an ACK, remote acceptance
is unknown. Exhausted runs emit a failure and no success receipt. The receiver
may already have accepted some or all transmitted records.

## Restricted simulator image

`pnpm image:qualify` builds and qualifies a local Linux AMD64 image. It needs
Docker, native `tar`, Gitleaks 8.30.1 and Trivy 0.76.2 on PATH, plus network access
to the pinned base images and current vulnerability database. The PR image
workflow installs checksum-pinned scanners and runs the same command; it does
not publish an image. Keep `pnpm check` and `pnpm security` as the source gates.

The gate runs validate, encode and bounded loopback TCP login/frame/ACK through
the compiled CLI with a read-only root, UID/GID 65532, no capabilities,
no-new-privileges, no external network, and bounded memory/CPU/processes. It scans
HIGH/CRITICAL vulnerabilities and secrets, scans all saved layers for known
secret patterns and supported identity JSON/IMEI assignments, and requires a deleted-layer
identity canary to fail. Scanner errors fail qualification. No hardware or
installed-product acceptance is implied by this synthetic peer.

A successful gate writes `.verification/image.json`: Git revision, actual source
fingerprint, clean/dirty status, local image ID, platform and completed checks.
The sanitized receipt is also printed in CI logs. The source fingerprint hashes sorted Git-visible paths and their length-delimited
bytes. Ignored files never enter the frozen build context; symlinks and private
artifact names are rejected. Dirty candidates are explicitly identified and do
not claim to be committed source. A local image ID is not a registry digest.
The JavaScript-only runtime removes dependency documentation comments, TypeScript
sources/types and source maps using the existing TypeScript parser. Executable
strings, package metadata and licenses remain; real secrets in code still fail
scanning. No new JavaScript dependency is added. The Dockerfile pins both upstream
image digests; dependencies use the frozen
lockfile. Future publication and immutable registry-reference qualification
require a separate maintainer action.

For operator runs, keep configuration, identities and outputs outside the checkout
and image. Mount private inputs read-only; give identity files mode 0600 owned by
the container's effective UID (the CLI verifies both). For bind mounts owned by a
nonroot host user, explicitly set Docker `--user` to that user's UID:GID. Retain
`--read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64
--memory 256m --cpus 1`; mount only a bounded output directory for `encode`.
`run` needs network access to the explicitly authorized TCP target. The image's
entrypoint accepts the existing `validate`, `encode` and `run` CLI arguments.

## Publish the qualified image

After merging reviewed source, a maintainer can dispatch **Publish immutable
simulator image** on `main`. Leave `source_revision` blank to use the exact main
SHA at dispatch, or provide that same full SHA. A different branch/revision,
main advancing during qualification, dirty source or a commit without a merged
PR fails admission. The workflow runs `pnpm check` and `pnpm image:qualify`
before authenticating or pushing to GHCR.

Publication uses `GITHUB_TOKEN` with job-scoped package write permission and an
isolated temporary Docker configuration. It pushes a unique source/run/attempt
tag, pulls the registry digest and verifies that the image ID, source labels,
fingerprint and platform match qualification. The run summary reports the
immutable `ghcr.io/stanimirivanov/fleetiq-simulator@sha256:...` reference, source
SHA and fingerprint for the deployment lock. `.verification/publication.json`
is sanitized local evidence; failed attempts remove any stale publication receipt.
A failed read-back is not a qualified publication, even if a push allocated bytes.
No publication runs on PRs or automatically after merge, and no environment is
promoted. The first hosted publication and GHCR package access remain maintainer
qualification actions after this workflow merges.

## Route and model playback (SIM-PR9)

The pure scenario API generates Codec 8E record inputs from bounded GeoJSON,
versioned phases and the documentation-derived FMB920 profile. It supports speed,
stops/ignition, explicit looping, GPS-loss state and exact device-clock drift.
See [the playback contract](docs/scenario-playback.md),
[normal-day scenario](scenarios/normal-day.json) and
[reviewed IO catalogue](profiles/fmb920-docs-v1.json). This API does not claim
hardware fidelity; capture/send scheduling uses the [capture and batching APIs](docs/capture-batching.md).


## Capture and bounded batching (SIM-PR10)

`capture` yields independent virtual capture/send ticks. `BatchQueue` freezes
Codec 8E records and assembles FIFO packets under record/byte limits, retaining
pending records until explicit acknowledgement. `createClock(1)` maps real-time
elapsed milliseconds; scales 2–1000 explicitly accelerate virtual simulation.
See [the API contracts and composition](docs/capture-batching.md). The CLI still
accepts its existing single-record config; durable run/spool integration is SIM-PR11.
