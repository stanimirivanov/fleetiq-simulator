# Verification tooling

Use Node ESM and existing pinned tools. Keep the same `pnpm check:fast` entry
point for the optional hook and CI, with `pnpm check` authoritative. Exit
nonzero on violations or tool errors. Use stable, actionable diagnostic categories
and print source locations for static failures. Preserve redaction on scans.

When changing architecture policy, ship a matching positive and negative
fixture. Document approved changes to quality checks in the PR. Keep CI
read-only for repository contents and scoped to pull requests.
