# Wire encoding

Keep record encoding deterministic and independent of sockets, files, time and
Effect. The architecture gate catches reviewed ambient APIs such as Date,
Math.random, fetch, and globalThis while allowing local shadowing. Treat this
as a narrow guard for accidental effects. The closed Ajv schema validates before frame allocation. Preserve signed
coordinates, exact u64 values, big-endian fields and raw IO widths. Derive
counts and lengths from validated records. Keep CRC coverage and TCP envelope
boundaries explicit.

Verify byte changes against literal independent vectors and malformed or boundary
inputs. Avoid computing the expected bytes with the production encoder or the
same CRC helper. `node --test tests/wire/codec8.test.ts` is the focused gate.

Wire owns the AVL payload, TCP envelope, CRC and declared record count.
`Codec8Frame` retains a private validated byte snapshot and exposes copies.
Transport consumes that snapshot and its count together. Keep raw Buffer
admission and frame validation in wire when changing future codecs.


Legacy factories remain single-record. `fromExtendedBatchBytes` admits 1–16
complete Extended records within 1280 TCP bytes; `combineCodec8e` derives both
counts, length and CRC from owned single-record frames. Never let session or
transport override byte/count metadata. Run `node --test tests/wire/codec8e.test.ts`
for assembly, strict admission, count/byte boundaries and independent CRC checks.

`udp.ts` owns the UDP length/identity/ID envelope and strict seven-byte AVL ACK
predicate. Reuse validated bodies/counts and omit every TCP envelope/CRC byte.
Never treat a generic channel ACK as record acceptance. Literal and malformed
vectors live in `tests/wire/udp.test.ts`; do not derive expected bytes with the encoder.
