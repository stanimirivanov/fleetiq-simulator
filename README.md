# FleetIQ simulator

SIM-PR1 validates one versioned record offline and writes a Teltonika Codec 8
TCP AVL frame. It accepts no device identity. TCP sessions are a later slice.

Use Node 24.18.0, pnpm 12.5.1 and Gitleaks 8.30.1 on Linux. The CI workflow
contains the checksum for the Linux x64 scanner release.

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

`pnpm check` enforces Biome, strict types, build, tests, wire coverage (90%
lines and 85% branches), CLI line coverage (80%), a redacted secret scan and
current dependency advisories (high and critical findings fail the gate).

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
| `retry` | Optional overrides for `ackDeadlineMs` (30,000), `maxAttempts` (5), and `totalDeadlineMs` (600,000) |
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

Exit 0 prints a receipt for the wire ACK. Exit 2 is invalid input, 3 is a
session failure, and 130 is cancellation. A retry can result in duplicate
acceptance if the peer received a frame and its ACK was lost. Projection and
browser verification are separate.
