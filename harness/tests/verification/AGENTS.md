# Verification acceptance

`coverage.test.mjs` owns discovery/inventory, subprocess-only source coverage,
missing-source rejection and the native uncovered-branch canary. Keep the passing
and failing controls together; do not pool coverage or change thresholds.

`comments.test.mjs` owns comment-quality passing and violation fixtures.
`typecheck.test.mjs` owns independent product/harness type controls and invalid
TypeScript/JavaScript fixtures. Preserve real subprocess execution, fixture
source, assertions and deadlines. Assertions/setup stay local; no generic test
framework is needed. Sensor implementations and configuration remain unchanged.

Run `node --test "harness/tests/verification/*.test.mjs"` from the repository root.
Canonical `pnpm check` registers each suite once in the existing serial tooling
group. Scanner semantics and private-data diagnostics belong in `../security/`.
