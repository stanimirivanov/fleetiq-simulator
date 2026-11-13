# Simulator quality constraints

These thresholds preserve the approved simulator baseline. Gate and threshold
changes require separate review or explicit approval in the owning PR. Record
any approved exception with scope, owner, reason, expiry and a removal issue.

| Control | Required result | Enforcement |
| --- | --- | --- |
| Style and types | Biome clean with named exports, strict no-emit check for source, tests and tooling, erasable TypeScript syntax; descriptive source/tooling JSDoc and comment spacing | `pnpm lint`, `pnpm typecheck` |
| Source ownership | Closed import direction and external allowlists, no cycles | `pnpm architecture` and architecture fixtures |
| Build | ESM emitted successfully | `pnpm build` |
| Wire, scenarios, storage and session/transport coverage | Each coverage group at least 90% lines and 85% branches | `pnpm test:coverage` |
| CLI coverage | At least 80% lines | `pnpm test:coverage` |
| Secrets and dependencies | Zero scanner findings, no known high or critical advisories, scanner errors fail | `pnpm security` with pinned Gitleaks and live pnpm audit |

Keep regression assertions, test discovery, redaction and bounds intact. Review
test deletions, skipped cases, suppression directives, threshold changes and
dependency additions explicitly. The import gate checks module dependencies.
It does not prove runtime purity, shell safety or protocol correctness. Those
properties require behavioral tests and review.
