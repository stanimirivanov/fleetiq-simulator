# Transport adapters

`tcp.ts` owns the Node socket and Effect scope, login, ACK framing and delivery
retries. Close the scope before retrying and preserve frozen frame bytes.
Advance the cursor only after an exact count ACK. Strict mode retires the
socket after success. Persistent mode requires one ACK per batch.

Use session policy and wire encoding without introducing a dependency back
into the CLI. Keep loopback defaults, deadlines and output redaction intact. Only the exact
`tcp-ingestion` Compose name may use DNS. Resolve IPv4 once per attempt, require
all answers to be loopback or RFC 1918 private, and connect to the admitted numeric
address. DNS belongs in transport; never admit arbitrary names or public targets.
Verify transport behavior against the independent peer with
`node --test tests/tcp.test.ts`.

Use wire-owned frame snapshots and counts for ACK matching. A successful
receipt counts locally acknowledged records once per completed batch.
Retried bytes may have been accepted remotely before an ACK was lost.

Explicit fault execution consumes only the pure `scenarios/faults.ts` plan; other
scenario imports stay forbidden. Run `node --test tests/fault-tcp.test.ts`. Fault
traffic has no retries or durable ACK removals and reports observations separately.
