# JavaScript and TypeScript comment quality

Document the contract a reader cannot recover from names and types: purpose,
units, preconditions, ownership, effects, bounds, failure behavior and deliberate
limitations. Cover the relevant points, rather than filling every category.
Describe why an algorithm or ordering constraint exists. Do not narrate obvious
statements or add empty tags to satisfy lint.

## Source declarations

Use `/** ... */` immediately above exported functions/constants, types,
interfaces, classes and class methods/accessors. Class documentation can explain
a trivial constructor; document substantive construction/admission separately.
Named local functions and function-valued variables spanning six or more lines
also need a summary. Tiny local helpers can remain self-explanatory. Inline
callbacks are covered by their enclosing operation's contract; add a local
comment when they introduce a separate invariant or lifetime constraint.

Start with a prose summary. Add paragraphs or `@param`, `@returns` and `@throws`
when they clarify behavior beyond the signature. In TypeScript, do not duplicate
types with JSDoc `{Type}` annotations. For JavaScript tooling, type tags support
`checkJs` but do not replace the summary. Retain protocol references for wire
layouts and independent fixture provenance.

Put a blank line before a standalone line comment or block. Use ordinary `//`
comments for local reasoning and JSDoc for declaration contracts. Keep comments
accurate when changing behavior; mention uncertainty explicitly rather than
claiming validation or acceptance that the implementation does not provide.

## Mechanical checks and review

- `pnpm lint:source-comments` applies ESLint to `src/**/*.ts` using the pinned
  TypeScript parser. `jsdoc/require-jsdoc` enforces the declaration contexts and
  six-line local-helper threshold in `eslint.config.mjs`.
- `jsdoc/require-description` rejects missing/tag-only summaries, including type
  and class documentation. `@stylistic/lines-around-comment` enforces spacing.
- `pnpm lint:comments` retains the existing tooling policy. Both commands run
  through `pnpm lint`, `pnpm check:fast` and canonical `pnpm check`, covering the
  opt-in pre-commit hook and required-check workflow.
- `node --test harness/tests/comments.test.mjs` tests passing and failing controls,
  including TypeScript syntax, short public declarations, named helpers and
  comments on exported constants.

Lint proves presence, attachment and nonempty prose, not truth or usefulness.
Reviewers must compare each contract with the implementation and tests. A vague
summary can pass lint; do not substitute word-count heuristics for that review.

## Basis and local choices

This policy adapts the [Google TS/JS comments guide](https://google.github.io/styleguide/tsguide.html#comments-and-documentation):
use JSDoc for declarations, explain intent and avoid redundant type information.
It does not adopt that guide wholesale. The six-line threshold extends this
repository's existing tooling convention; it is a local trigger, not an industry
standard or a claim that shorter code never needs explanation.

The enforcement uses documented [JSDoc contexts and thresholds](https://github.com/gajus/eslint-plugin-jsdoc/blob/main/docs/rules/require-jsdoc.md),
[description checks](https://github.com/gajus/eslint-plugin-jsdoc/blob/main/docs/rules/require-description.md),
[comment spacing](https://eslint.style/rules/lines-around-comment), and the
[TypeScript ESLint parser](https://typescript-eslint.io/packages/parser/).
The parser is an MIT-licensed development dependency, with no runtime dependency
or architecture change. Existing JSDoc and spacing plugins remain in use.
