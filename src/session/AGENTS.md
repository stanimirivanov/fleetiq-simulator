# Session policy

`state.ts` owns validated session settings, the monotonic run budget and typed
failure categories. Use the injected monotonic clock for budget assertions.
Session may depend on wire contracts. Transport adapters consume session
policy and own sockets, framing exchanges and retry execution. Keep session
independent of transport and the CLI.

Run `node --test tests/tcp.test.ts` for session bounds and TCP behavior.


`batches.ts` owns the bounded FIFO and stable pending handle. Freeze bytes at
enqueue; peek must not remove data. Acknowledgement reads wire-owned private
counts and commits removal only for the exact pending handle. Durable ACK/cursor
commit is separate work in SIM-PR11. Verify with `node --test tests/batches.test.ts`.
