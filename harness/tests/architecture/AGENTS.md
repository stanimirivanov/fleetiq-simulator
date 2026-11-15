# Architecture acceptance

Keep primitive dependency direction, import resolution and cycles in
`dependencies.test.mjs`. Keep runtime loading, ambient capabilities and effect
ownership across transport, scenarios, storage and telemetry in
`purity-effects.test.mjs`. Full diagnostic text, redaction and source-tree failure
recovery belong in `diagnostics.test.mjs`.

`../../support/architecture-fixture.mjs` owns only the existing minimal source-map
builder and diagnostic-prefix projection. Assertions and passing/violation cases
stay in their suites; do not add a policy assertion framework. Preserve literal
fixture source, source-line checks, titles and temporary-tree cleanup.

Run `node --test "harness/tests/architecture/*.test.mjs"` from the repository root.
Canonical `pnpm check` registers these suites once in the existing serial tooling
group. This decomposition must not change architecture policy or quality floors.
