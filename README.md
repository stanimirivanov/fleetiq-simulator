# FleetIQ simulator

For repository boundaries, agent instructions and verification commands, see
[AGENTS.md](AGENTS.md) and the [coding harness](HARNESS.md).

The simulator validates a versioned Codec 8 record offline or sends it to an
authorized loopback TCP listener using a private device identity file.

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
| `target` | Optional `{"transport":"tcp","host":"127.0.0.1","port":55027}` (default). Only literal `127.0.0.1` and `::1` are accepted |
| `retry` | Optional overrides for `ackDeadlineMs`, `maxAttempts`, and `totalDeadlineMs`. Defaults are defined in [session policy](src/session/state.ts) |
| `connectionPolicy` | Optional `single-batch` (default) or `persistent-compliant-peer` |

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
`Codec8Frame` validates a single-record TCP envelope and retains a private
copy of its bytes and declared count. Transport accepts these frames and
continues to accept raw Buffer inputs through wire validation.

A receipt counts each locally acknowledged batch once, even if it was sent
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
