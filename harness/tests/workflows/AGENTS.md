# Workflow acceptance

Technical constraints for this scope; the repository root `AGENTS.md` owns workflow routing.

Keep PR/security authority policy, real history/ownership checks, platform
qualification and pin parity in their named suites. Authority assertions stay
with `policy.test.mjs`; the existing pin assertions have one workflow-scoped
owner in `pin-policy.mjs`, reused by the policy and platform controls. Do not turn
these assertions into a general-purpose workflow test framework.

`../../support/workflow-fixture.mjs` owns real YAML parsing, package metadata and
reviewed setup/installation values. History tests own their Git repositories,
shell execution and cleanup. Preserve all mutation cases, titles, deadlines and
real `new URL(..., import.meta.url)` targets when moving code.

Run `node --test "harness/tests/workflows/*.test.mjs"` from the repository root.
`pnpm check` registers each suite once in the existing serial tooling group;
helpers have no `.test` suffix. Preserve action/runtime pins, authority and verification policy.
