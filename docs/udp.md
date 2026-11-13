# Reference-peer UDP

SIM-PR14 adds an explicit `udp` command for an authorized loopback reference peer.
FleetIQ compatibility remains TCP-only: UDP configs reject product profiles,
`tcp-ingestion`, DNS names and public addresses. Existing TCP, fleet, fault and
checkpoint contracts remain unchanged. This is simulator conformance, not
installed-product UDP support or physical-device qualification.

The closed version-1 run layout contains `identityFile`, `deviceId`, `records`
(1–16 valid single-record Codec 8/8E inputs), `packetId` (0–65535), `avlPacketId`
(0–255), optional existing `retry` fields, and an explicit target:

```json
{ "transport": "udp", "profile": "reference-peer", "host": "127.0.0.1", "port": 55028 }
```

`::1` is also admitted. There is no implicit target, profile or ID selection.
The normal 16 KiB input limit applies. UDP schema compilation is lazy, so
unselected ordinary commands do not pay this mode's compilation cost. Identity comes only from an owned,
owner-only, non-symlink, regular single-link private sibling identity file; never
commit it or datagrams containing identity/location data. Offline validation
checks identities, records, framing and numeric policy without opening sockets.
The ordinary `encode` command retains its record/TCP contract; the pure `encodeUdp`
API exposes detached datagram bytes when an operator needs an offline capture.

```sh
node dist/cli.js validate --config /absolute/private/udp-run.json
node dist/cli.js udp --config /absolute/private/udp-run.json
```

The wire layout follows the [manufacturer UDP channel and AVL response tables](https://wiki.teltonika-gps.com/view/Teltonika_AVL_Protocols#Codec_8).
A two-byte big-endian length excludes itself, followed by channel ID (u16), flag
01, AVL ID (u8), identity length 000f, 15 ASCII digits and the AVL body. The body
retains codec and both counts, with no TCP preamble/length/CRC. Existing validated
wire frames supply authoritative bytes/counts. Maximum datagram size is 1291 bytes
for the inherited 1280-byte TCP profile (UDP adds eleven net bytes).

Only a seven-byte `0005 | channel-id[2] | 01 | avl-id | accepted-count` response
with exact echoed IDs and exact wire-owned count acknowledges work. Generic
channel ACKs, partial counts, malformed/trailing data and stale IDs do not qualify.
Some manufacturer worked examples contain inconsistent IDs; use the stated echo
rule, not those inconsistencies. Literal byte tests use an independently placed
published AVL body and synthetic identity.

One connected socket is bound to the selected loopback address for the bounded
run. [Node datagram connection semantics](https://nodejs.org/download/release/v24.18.0/docs/api/dgram.html#socketconnectport-address-callback)
filter peers in the kernel; the callback also checks source address and port.
Each packet is outstanding alone. A matching ACK advances both IDs modulo their
widths; at most 16 pairs are used, so rollover never repeats a pair within this
run. Admission snapshots scalar options before asynchronous binding. Retries preserve
exact bytes and IDs on the same endpoint. Invalid replies
are ignored within the ACK/run deadlines, with a fixed 256-reply flood allowance
per attempt. Receive buffering is limited; no stream concatenation is performed.

Session budgets/cancellation and retry caps reuse existing policy. All paths await
socket cleanup through Effect scope. A positive receipt is the existing sanitized
`{"status":"acknowledged","recordCount":N}` and counts only matched AVL ACKs;
it does not prove projection, browser visibility or remote deduplication. Lost
ACKs may cause repeated remote effects. Correlation is not cryptographic peer
identity or replay protection across separate invocations; choose IDs and isolate
this authorized reference test accordingly.

Expected input errors remain exit 2, bounded transport failure exit 3 and signal
cancellation 130. No identity, endpoint or reply bytes enter diagnostics. The pure
wire API uses fixed `invalid-udp`; transport maps malformed local inputs to
`invalid-session`. No UDP fleet/spool integration, DNS, server implementation,
installed acceptance or new dependency is included.

Focused gates: `node --test tests/udp.test.ts tests/udp-transport.test.ts`.
Canonical `pnpm check` retains coverage, architecture, live security and measured
fleet bounds. Restricted-image smoke exercises the compiled UDP command against
an independent loopback datagram peer. The native platform decoder gate remains
valid-encoder qualification; it does not establish backend UDP support.
