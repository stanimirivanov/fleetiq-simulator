# Codec 16 reference evidence

Status: **provisional generic encoding only**. Manufacturer authority conflict
remains unresolved. Neither passing tests nor agreement between implementations
qualifies a device/firmware, the installed product, or FMB920 Codec 16 support.
No authoritative conformance acceptance may be issued while this conflict remains.

## Approved provisional interpretation

Use two-byte event/IO IDs, one-byte generation, one-byte total and one-byte
fixed-group counts. Generation 3 is reserved and rejected; values 0,1,2,4,5,6,7
are admitted. No NX, caller-supplied counts, or inferred device profile is accepted.
The generic profile conservatively caps TCP frames at 255 bytes and IO at 64.
Existing raw-u16 altitude semantics remain unchanged; no signed-altitude device
claim is introduced.

The [manufacturer's Codec 16 detailed layout and worked TCP example](https://wiki.teltonika-gps.com/view/Teltonika_AVL_Protocols#Codec_16)
use one-byte total. The comparison table on the same page says two bytes.
This is contradictory authority, not an alternative width to autodetect. A
reviewer explicitly approved the provisional one-byte interpretation on
2026-11-14 in this implementation conversation (issue #59). That approval does
not resolve the source conflict; authoritative qualification requires manufacturer clarification plus
reviewed replacement evidence/tests. A reference mismatch fails the tests and
blocks even provisional acceptance; never update expected bytes to hide it.

## Independent evidence and adaptation

- `tests/codec16-fixture.ts` retains the manufacturer's two-record TCP hex
  example (CRC 0x5fb3). Its hex has priority 00 although its prose says 01.
  The single-record literal retains the first record exactly; only envelope,
  counts and independent CRC (0x0f89) change. No identity or packet capture is used.
- Reference: [Traccar TeltonikaProtocolDecoder.java](https://github.com/traccar/traccar/blob/5357b171de1fbdcd0e8161b52b107dd406317660/src/main/java/org/traccar/protocol/TeltonikaProtocolDecoder.java),
  revision `5357b171de1fbdcd0e8161b52b107dd406317660`, source SHA-256
  `7e5fe46e604eb095870b6fbe7f018679f4d0a22144e8e32acbbec3d3fa83dee3`.
  `readExtByte` widens event/IO IDs for Codec 16 but widens total/group counts
  only for Codec 8 Extended. `decodeLocation` consumes a generation byte first.
- `tests/codec16-reference.ts` adapts that fixed-width parsing pattern to a
  standalone test runner with no production imports or new dependencies.
  Position/model mappings are replaced with raw fields; bounds, total and exact
  consumption checks are added. It is **not execution of the full Traccar decoder**
  and cannot prove model mappings or firmware behavior. Apache-2.0 provenance
  and adaptation notice are retained; full license is in `licenses/traccar.txt`.
- CRC verification uses the existing independent polynomial-division oracle;
  full-width IDs, all fixed widths and all admitted generation types are checked
  against the separate reference. A two-byte-total mutation must be rejected.

## Local and canonical gates

`pnpm test:reference` runs the Codec 8 oracle, UDP vectors and Codec 16 reference
checks. The canonical `pnpm check` already executes those suites exactly once in
its wire coverage group; it does not call the alias again. No online mutable
reference, extra dependency or Java service is required by CI.

## Public boundary

Offline `validate` and `encode` accept `codec: "16"` only with
`profile: "generic-codec16-provisional"` and an explicit `generationType`.
All other scalar fields match the existing record schema; event/IO IDs widen to
u16. The standalone encoder likewise requires the profile. Existing network,
playback, fault and UDP selectors do not admit Codec 16. No image publication,
platform decoder change or installed-product promotion is part of this PR.
