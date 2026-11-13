# Session policy

`state.ts` owns validated session settings, the monotonic run budget and typed
failure categories. Use the injected monotonic clock for budget assertions.
Session may depend on wire contracts and Ajv for closed checkpoint validation. Transport adapters consume session
policy and own sockets, framing exchanges and retry execution. Keep session
independent of transport and the CLI.

Run `node --test tests/tcp.test.ts` for session bounds and TCP behavior.


`batches.ts` owns the bounded FIFO and stable pending handle. Freeze bytes at
enqueue; peek must not remove data. Acknowledgement reads wire-owned private
counts and commits removal only for the exact pending handle. `spool.ts` couples FIFO/cursor state to a durable persistence port;
`storage/` implements atomic file replacement. Verify with `node --test tests/batches.test.ts`.

Checkpoint errors must preserve authoritative bytes and fixed categories. A failed
write poisons memory; resume revalidates bindings and frozen FIFO bytes before send.
Use `node --test tests/spool.test.ts` for process death and exact replay.
