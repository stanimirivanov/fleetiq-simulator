# Scanner acceptance

Technical constraints for this scope; the repository root `AGENTS.md` owns workflow routing.

Keep scanner findings, tool failures, malformed reports, metadata withholding and
real index/history phase checks here. Preserve the clean controls and every
redaction assertion; malformed or unavailable tools must never count as clean.

Each case owns its temporary tree, synthetic identity data, fake scanner or real
Git repository and cleanup. Keep assertions/setup local and fixture strings
unchanged. The actual scanner implementation and configuration remain under
`harness/src/security/` and `harness/config/`.

Run `node --test "harness/tests/security/*.test.mjs"` from the repository root
with the pinned Gitleaks binary available. Canonical `pnpm check` registers this
suite once in its existing serial tooling group.

`audit.test.mjs` owns the issue #96 advisory/graph/expiry boundary. Keep native
status/schema/count, approval, package/version/path and unrelated-advisory
negative controls. Never use a global advisory ignore or hide the active owner
and expiry. Raw native reports remain private evidence, not CI attachments.
