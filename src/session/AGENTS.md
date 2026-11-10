# TCP session

`state.ts` owns validated session settings, monotonic budget and typed failure
categories. `tcp.ts` owns the Node socket and Effect scope. Close the scope
before retrying and preserve frozen frame bytes. Advance the cursor only after an
exact count ACK. The strict policy retires the socket after success. Persistent
mode relies on a peer that emits one ACK per batch.

Keep retries, timeouts and cancellation bounded. Avoid bypassing the loopback
target policy, logging transport errors or treating a wire ACK as downstream
acceptance. Test failures against a real loopback peer and use an injected
monotonic clock for budget assertions. Run `node --test tests/tcp.test.ts`.
