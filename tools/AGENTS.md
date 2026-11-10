# Verification tooling

Use Node ESM and existing pinned tools. Keep the same `pnpm check:fast` entry
point for the optional hook and CI, with `pnpm check` authoritative. Exit
nonzero on violations or tool errors. Use stable, actionable diagnostic categories
and print source locations for static failures. Preserve redaction on scans.

When changing architecture policy, ship a matching positive and negative
fixture. Document approved changes to quality checks in the PR. Keep CI
read-only for repository contents and scoped to pull requests.

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
