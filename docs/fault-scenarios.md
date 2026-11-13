# Deterministic local TCP faults

Use the explicit `fault` command for authorized isolated local targets. Ordinary
`run`, `resume`, `encode` and durable checkpoints do not accept fault configs.
Faults are applied to private snapshots after normal valid encoding; valid wire
constructors never admit corrupt or truncated frames. No new dependency is added.

The separate closed run layout has the usual `schemaVersion: 1`, `identityFile`,
`deviceId`, optional local TCP `target` and `retry`, plus `records` (1–16 valid
single-record Codec 8 or Codec 8E inputs) and `faults`. The complete run JSON
retains the existing 16 KiB input limit. The identity file remains
owned/private and sibling-only. Optional `unregisteredDeviceId` selects a second
logical entry in that same private file. Operators must independently ensure it
is authorized for testing and unregistered on this target; the simulator cannot
query or prove server registration. It must differ from the ordinary identity.
Never put device identities in the fault plan or attach private run files.

Copy the contents of [scenarios/faults.json](../scenarios/faults.json) into the
`faults` property, and provide eight record inputs to exercise that example.
`authorizedLocalTarget: true` is required, with exactly one action per original
one-based packet ordinal. Unselected packets remain valid and unchanged.

| Action | Required value | Result |
| --- | --- | --- |
| `corrupt-crc` | none | XOR the last CRC byte with 1 |
| `truncate-close` | `offset` | Send the prefix then FIN, retaining the advertised original length |
| `split-write` | `offset` | Two ordered socket writes, preserving all bytes |
| `duplicate-record` | none | Send the identical complete single-record packet twice on fresh connections |
| `late-event-time` | `timestampMs` | Replace the single record's u64 timestamp with a strictly earlier decimal value, repair CRC |
| `unregistered-identity` | private `unregisteredDeviceId` entry | Use that identity for this packet's login |
| `disconnect-before-write` | none | Close after login, before any AVL bytes |
| `disconnect-after-write` | none | Send all AVL bytes and FIN; wait for closure within the deadline |

Offsets are 1 through frame length minus one. Actions repeat deterministically
from the original input ordinal: duplicating packet 2 does not turn packet 3 into
packet 4 for action selection. Each packet contains one complete record, so
repeating a packet repeats the complete record; this mode does not duplicate IO
fields or mutate existing multi-record batches. Late time changes every other
record field by zero bytes; choose an earlier timestamp than a preceding record
to exercise out-of-order arrival. Timestamps, not wall-clock delivery, are reordered.

```sh
node dist/cli.js validate --config /absolute/private/fault-run.json
node dist/cli.js fault --config /absolute/private/fault-run.json
```

Validation is offline: it validates record encoding, private identity selection,
authorization, action bounds and mutations without TCP or checkpoint creation.
Fault execution retains loopback literals and the exact private-address-admitted
`tcp-ingestion` Compose name. It has no retries or persistent connection mode:
`retry.maxAttempts` must be omitted or 1. Each expanded transmission gets a fresh
login/socket, within the existing ACK and shared monotonic run budgets and signal
cancellation. At most 32 transmissions of at most 1280 bytes are prepared.
There is no automatic resume and no queue removal or durable checkpoint update.

Success prints only `status: "faults-completed"`, `packets`, `acknowledged`,
`denied`, and `disconnected`. These are packet observations, not a delivery
receipt or device/product acceptance. `denied` means a zero-count reply, login
refusal, connection closure or per-exchange timeout without a successful AVL ACK
for deliberately invalid traffic. It does not prove why a server denied traffic;
a broken/unavailable server can produce the same observation. A positive count
for malformed/unregistered traffic fails as `fault-accepted` (exit 3). Unexpected
failures on valid traffic, whole-run expiry and cancellation are never counted as
denials. A peer withholding closure after the deliberate FIN fails with
`disconnect-timeout` at the exchange cap, or `run-timeout` when the shared run
budget expires first. Invalid plans return a fixed `invalid-faults` / `invalid-run-config`
category (exit 2). Cancellation remains 130. No private bytes or identities enter
output. Later installed qualification must correlate observations with real
server diagnostics; these peer tests are not that qualification.

The [manufacturer field layout](https://wiki.teltonika-gps.com/view/Codec#Codec_8)
defines timestamp placement and CRC scope. [Node's socket API](https://nodejs.org/download/release/v24.18.0/docs/api/net.html#socketwritedata-encoding-callback)
provides ordered writes and a separate FIN boundary. Two writes do not guarantee
two TCP packets or two peer read events; the assertions concern the byte stream.
