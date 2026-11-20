# Architecture acceptance

Technical constraints for this scope; the repository root `AGENTS.md` owns workflow routing.

Keep primitive dependency direction, import resolution and cycles in
`dependencies.test.mjs`. Keep runtime loading, ambient capabilities and effect
ownership across transport, scenarios, storage and telemetry in
`purity-effects.test.mjs`. Full diagnostic text, redaction and source-tree failure
recovery belong in `diagnostics.test.mjs`.

`harness-boundary.test.mjs` owns product/harness dependency isolation, the closed
module-loading boundary, private tool pins and the real product-only offline
build/test qualification. `transport-load.test.mjs` owns the offline source/built
CLI load canary and lazy UDP validation. Its hook remains in
`../../support/no-transport.mjs`. These suites resolve the repository root three
levels above their own location; preserve synthetic import strings as fixture
inputs when adjusting executable imports.

`../../support/architecture-fixture.mjs` owns only the existing minimal source-map
builder and diagnostic-prefix projection. Assertions and passing/violation cases
stay in their suites; do not add a policy assertion framework. Preserve literal
fixture source, source-line checks, titles and temporary-tree cleanup.

Run `node --test "harness/tests/architecture/*.test.mjs"` from the repository root.
Canonical `pnpm check` registers these suites once in the existing serial tooling
group. This decomposition must not change architecture policy or quality floors.
