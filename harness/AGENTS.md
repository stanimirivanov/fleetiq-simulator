# Verification tooling

Use Node ESM and existing pinned tools. Keep the same `pnpm check:fast` entry
point for the optional hook and CI, with `pnpm check` authoritative. Exit
nonzero on violations or tool errors. Use stable, actionable diagnostic categories
and print source locations for static failures. Preserve redaction on scans.

When changing architecture policy, ship a matching positive and negative
fixture. Document approved changes to quality checks in the PR. Keep CI
read-only for repository contents. PR verification and the scheduled/manual
security workflow are the approved verification triggers. Image publication is
manual-only on reviewed main; grant packages:write only to that publication job.
Authenticate only after source/image qualification, using disposable registry
authentication.
Do not add privileged PR execution.
Preserve `Simulator verification / check`. Prefer major-version references for
GitHub Actions (for example, `actions/checkout@v7`).
Use an exact commit only when specifically required; update workflow controls when
reviewing an action version change.

Put a blank line before a standalone comment or comment group so it reads
with the code it introduces. In tooling JSDoc, lead with what the function
guarantees, assumes, or deliberately leaves out. Type tags support `checkJs`.
Explain information a reader cannot get from the signature, such as why a
cycle check tracks the active path or why scanner output stays private.

Follow the [shared JS/TS comment standard](docs/comment-quality.md).
`pnpm lint:comments` applies ESLint to tooling modules;
`pnpm lint:source-comments` applies the source declaration policy to TypeScript. It uses
[ESLint Stylistic's lines-around-comment](https://eslint.style/rules/lines-around-comment)
and [eslint-plugin-jsdoc's require-jsdoc](https://github.com/gajus/eslint-plugin-jsdoc/blob/main/docs/rules/require-jsdoc.md)
and [require-description](https://github.com/gajus/eslint-plugin-jsdoc/blob/main/docs/rules/require-description.md).
Six lines is the local threshold for requiring JSDoc on functions. Existing
function JSDoc needs a summary regardless of length. Review the summary for
accuracy and usefulness.

Architecture diagnostics give the rule and a recovery step. The location and
module are shown only when reviewed, since paths and module names can contain
private data. Update `harness/src/verification/diagnostic-location.mjs` when adding a path that is
safe to publish.

Secret scan failures name the worktree, index or history phase. Findings report
the total count and safe metadata for the first finding. Unreviewed names and
locations are withheld. Inspect the affected scan privately when metadata is
withheld or when multiple findings are present. Never attach a raw report.


`pnpm floor` checks against fetched origin/main's merge base; an explicit full
ancestor SHA reproduces PR results. Preserve base-revision execution in PR CI
and its exact-SHA bootstrap restriction. Add Git fixtures when changing the
floor sensor. Never add a self-approved bypass or print candidate comment/test
text. CODEOWNERS and the external main ruleset govern deliberate policy changes;
see HARNESS.md for qualification and intentional-maintenance procedures.


The private package owns verification, qualification, publication, configuration
and self-tests. Product imports must never depend on it or legacy tools. Run
`pnpm --dir harness test` for self-tests; `pnpm check` remains authoritative and
executes every product/harness suite once through the coverage inventory.
Root tool dependency declarations and thin configuration/documentation adapters
remain compatibility wiring until M8. Their pins must match this package; do not
add generic floor-delegation exceptions or missing-tool fallbacks.
