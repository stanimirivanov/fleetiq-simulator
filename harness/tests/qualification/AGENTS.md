# Qualification acceptance

Technical constraints for this scope; the repository root `AGENTS.md` owns workflow routing.

`fleet-bounds.test.mjs` owns synthetic report acceptance and rejection for measured
resource bounds. Preserve both product/reference-peer passing controls and every
excess, missing-measurement and private-field rejection. Real Linux measurements
remain in `pnpm test:bounds`, which canonical `pnpm check` also executes.

`platform-decoder.test.mjs` owns exact corpus comparison, full-width rejection
controls, profile/IO boundaries and ordered multi-record cases. Retain real
Git/process checks for unrelated checkouts, missing tools and redacted compiler
failures. These local self-tests do not qualify an external platform build;
`pnpm test:platform` still requires the separately prepared pinned checkout and
Rust toolchain described in [the harness guide](../../docs/HARNESS.md).

Keep assertions and synthetic fixtures local. Preserve test titles, byte/numeric
comparisons, process bounds and temporary-directory cleanup. Repair only real
imports when moving suites; fixture strings and qualification implementations
must remain unchanged. Do not add forwarding suites or a generic test framework.

Run `node --test "harness/tests/qualification/*.test.mjs"` from the repository root.
Canonical `pnpm check` registers each suite once in the existing serial tooling
group. Keep source inventories, thresholds, platform pins and publication
workflows intact; this directory owns acceptance tests, not maintainer authority.
