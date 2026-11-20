# Verification-floor self-tests

Technical constraints for this scope; the repository root `AGENTS.md` owns workflow routing.

Keep preservation and renames, computed controls, script policy, baseline/history,
trusted-base execution, input hygiene, reviewed relocations and exact harness
command transitions in their named
suites. Retain positive controls alongside violations and leave assertion logic
in each suite. Synthetic source text is fixture data, not executable guidance.

`../../support/floor-fixture.mjs` owns the common synthetic Git baseline, bounded
Git commands and per-test cleanup. The relocation suite retains its distinct
baseline and manifest helpers. Do not merge these into a configurable assertion
framework or share writable checkouts across cases.

Run from the repository root:
`node --test "harness/tests/floor/*.test.mjs"`.
Canonical `pnpm check` executes each registered suite once through the serial
tooling group. Preserve titles, declarations, timeouts, real hook/workflow shell
execution and redaction assertions. Rebase real `new URL(..., import.meta.url)`
paths when moving tests; leave synthetic legacy paths inside fixtures intact.
