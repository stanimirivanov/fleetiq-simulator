# Core CLI behavior

Run these suites from the repository root; subprocesses deliberately exercise
`src/cli.ts` with independent peers and owned temporary inputs. Keep offline
encoding, configuration, identity, error reporting and receipts in their named
behavior suites. Identity-specific setup stays with its suite rather than a
general CLI test framework. Every case owns cleanup, mocks and its existing
deadlines; do not combine cold subprocess runs under one timeout.

`node harness/src/verification/coverage.mjs cli` runs these suites and the
remaining `tests/cli.test.ts` scenarios in the existing serial CLI coverage group.
Keep that source denominator and threshold unchanged. M5 owns splitting the
remaining scenario/recovery suites; no product behavior belongs in this refactor.
