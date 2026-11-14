# Product image packaging

This tree belongs to the product build. Keep it independent of `tools/` and
`harness/`; Docker must be able to build without copying either tree. TypeScript
is an existing build dependency used to preserve executable JavaScript literals
while removing dependency documentation examples. Retain licenses/notices and
the existing policy of not following symlinks.

Run `node --test tests/packaging/image-deps.test.mjs` for behavior and isolated
entry-point checks. Canonical `pnpm check` includes this suite exactly once with
90% line / 85% branch coverage, strict JS typechecking and comment lint. Follow
[the shared comment standard](../docs/comment-quality.md). Changes to image
preparation also require `pnpm image:qualify`; never publish as part of a PR.
