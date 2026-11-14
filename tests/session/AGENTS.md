# Session policy and durable state

Keep bounds, FIFO ownership, durable spool recovery and command state in their
named suites. Command-state tests exercise the state machine without a TCP peer;
real command exchanges belong in `../transport/`. Bounds tests retain the
adapter's preflight rejection checks, which must fail before connection.

Run from the repository root. Spool recovery deliberately launches
`tests/support/processes/spool-crash.ts` and uses real process termination;
preserve publication markers, signals, cleanup and existing deadlines.
`node harness/src/verification/coverage.mjs session` runs these and transport
suites in the existing serial coverage group without changing its denominator.
