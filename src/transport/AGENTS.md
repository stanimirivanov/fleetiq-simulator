# Transport adapters

`tcp.ts` owns the Node socket and Effect scope, login, ACK framing and delivery
retries. Close the scope before retrying and preserve frozen frame bytes.
Advance the cursor only after an exact count ACK. Strict mode retires the
socket after success. Persistent mode requires one ACK per batch.

Use session policy and wire encoding without introducing a dependency back
into the CLI. Keep loopback admission, deadlines and output redaction intact.
Verify transport behavior against the independent peer with
`node --test tests/tcp.test.ts`.

Use wire-owned frame snapshots and counts for ACK matching. A successful
receipt counts locally acknowledged records once per completed batch.
Retried bytes may have been accepted remotely before an ACK was lost.
