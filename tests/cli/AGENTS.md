# CLI behavior and recovery

Technical constraints for this scope; the repository root `AGENTS.md` owns workflow routing.

Run these suites from the repository root; subprocesses deliberately exercise
`src/cli.ts` with independent peers and owned temporary inputs. Keep offline
encoding, configuration, identity, error reporting and receipts in their named
behavior suites. Keep playback recovery, process interruption, faults, fleet,
UDP and command fixtures in their own suites. Identity-specific setup stays with
its suite rather than a general CLI test framework. Every case owns cleanup, mocks and its existing
deadlines; do not combine cold subprocess runs under one timeout.

`node harness/src/verification/coverage.mjs cli` runs every suite here in the
existing serial CLI coverage group. Keep that source denominator and threshold
unchanged. Preserve real subprocess interruption and byte-exact resume checks;
fixture modules live under `tests/support/` without a `.test` suffix.

`persistent-playback.test.ts` owns cross-tick login reuse and frozen pending
resume through the real CLI. Keep exact source timestamps, ACK-only removal and
completed-resume no-resend assertions. Installed lifetime evidence stays in the
deployment repository.
