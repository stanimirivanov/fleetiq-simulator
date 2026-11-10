# Wire encoding

Keep record encoding deterministic and independent of sockets, files, time and
Effect. The closed Ajv schema validates before frame allocation. Preserve signed
coordinates, exact u64 values, big-endian fields and raw IO widths. Derive
counts and lengths from validated records. Keep CRC coverage and TCP envelope
boundaries explicit.

Verify byte changes against literal independent vectors and malformed or boundary
inputs. Avoid computing the expected bytes with the production encoder or the
same CRC helper. `node --test tests/codec8.test.ts` is the focused gate.
