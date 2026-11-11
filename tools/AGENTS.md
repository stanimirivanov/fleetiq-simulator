# Verification tooling

Use Node ESM and existing pinned tools. Keep the same `pnpm check:fast` entry
point for the optional hook and CI, with `pnpm check` authoritative. Exit
nonzero on violations or tool errors. Use stable, actionable diagnostic categories
and print source locations for static failures. Preserve redaction on scans.

When changing architecture policy, ship a matching positive and negative
fixture. Document approved changes to quality checks in the PR. Keep CI
read-only for repository contents. PR verification and the scheduled/manual
security workflow are the approved triggers; do not add privileged PR execution.
Preserve `Simulator verification / check`. Pin actions to verified upstream full
commit SHAs and update the workflow controls when reviewing a pin upgrade.

Put a blank line before a standalone comment or comment group so it reads
with the code it introduces. In tooling JSDoc, lead with what the function
guarantees, assumes, or deliberately leaves out. Type tags support `checkJs`.
Explain information a reader cannot get from the signature, such as why a
cycle check tracks the active path or why scanner output stays private.

`pnpm lint:comments` applies ESLint only to tooling modules. It uses
[ESLint Stylistic's lines-around-comment](https://eslint.style/rules/lines-around-comment)
and [eslint-plugin-jsdoc's require-jsdoc](https://github.com/gajus/eslint-plugin-jsdoc/blob/main/docs/rules/require-jsdoc.md)
and [require-description](https://github.com/gajus/eslint-plugin-jsdoc/blob/main/docs/rules/require-description.md).
Six lines is the local threshold for requiring JSDoc on functions. Existing
function JSDoc needs a summary regardless of length. Review the summary for
accuracy and usefulness.

Architecture diagnostics give the rule and a recovery step. The location and
module are shown only when reviewed, since paths and module names can contain
private data. Update `tools/diagnostic-location.mjs` when adding a path that is
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
