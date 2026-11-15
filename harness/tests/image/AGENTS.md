# Image acceptance

Keep immutable candidate metadata and source snapshots in `candidate-source.test.mjs`;
scanner reports, binary normalization and independent USTAR controls in
`layer-scanning.test.mjs`; and image workflow/runtime wiring in
`workflow-runtime.test.mjs`. Publication authority, receipts, registry readback
and temporary-authentication cleanup remain in the cohesive `publication.test.mjs`.

Keep builders and assertions local. The synthetic image ID may be duplicated
between qualification suites; do not introduce a general assertion framework.
Publication continues to use `../../support/image-publish-fixture.mjs`. Preserve
all mutation matrices, source/identity boundaries, real Git/shell operations,
cleanup, titles and deadlines. Rebase only real imports and file URLs; fixture
strings must remain unchanged.

Run `node --test "harness/tests/image/*.test.mjs"` from the repository root.
`pnpm check` registers these suites once in the existing serial tooling group.
This refactor must not publish an image or alter qualification, workflow, scanner
or production policy.
