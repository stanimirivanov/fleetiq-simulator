# Simulator quality constraints

These thresholds preserve the approved simulator baseline. Gate and threshold
changes require separate review or explicit approval in the owning PR. Record
any approved exception with scope, owner, reason, expiry and a removal issue.

| Control | Required result | Enforcement |
| --- | --- | --- |
| Style and types | Biome clean with named exports, strict no-emit check for source, tests and tooling, erasable TypeScript syntax; descriptive source/tooling JSDoc and comment spacing | `pnpm lint`, `pnpm typecheck` |
| Source ownership | Closed import direction and external allowlists, no cycles | `pnpm architecture` and architecture fixtures |
| Build | ESM emitted successfully | `pnpm build` |
| Wire, scenarios, telemetry, storage, packaging and session/transport coverage | Each coverage group at least 90% lines and 85% branches | `pnpm test:coverage` |
| CLI coverage | At least 80% lines | `pnpm test:coverage` |
| Secrets and dependencies | Zero scanner findings, no known high or critical advisories, scanner errors fail | `pnpm security` with pinned Gitleaks and live pnpm audit |

Keep regression assertions, test discovery, redaction and bounds intact. Review
test deletions, skipped cases, suppression directives, threshold changes and
dependency additions explicitly. The import gate checks module dependencies.
It does not prove runtime purity, shell safety or protocol correctness. Those
properties require behavioral tests and review.

`pnpm test:bounds` enforces the approved fleet qualification envelope with actual
Linux measurements (256 MiB RSS, one CPU affinity, 2/100 profile slots and bounded
FD/elapsed cleanup). It is part of canonical `pnpm check`; retain its negative
controls and do not replace observations with device-count estimates.


## Approved, staged harness exception — issue #96

Owner: @stanimirivanov. Approval: explicit maintainer approval of
[issue #96](https://github.com/stanimirivanov/fleetiq-simulator/issues/96).
Hard expiry: **2026-11-25T00:00:00Z**, with no automatic extension. Remove sooner
when a patched upstream release is identified; #96 tracks retirement.

`pnpm --dir harness run audit:approved` permits only GHSA-fc5q-39xc-vjpf at high
severity in picomatch 4.0.7, with exactly the five reviewed private development
paths and frozen lock/manifest dependency inputs. This accepts a bounded tooling
availability risk; it does not claim the vulnerability is fixed or unreachable.
The approval record is [audit-exception.json](../config/audit-exception.json).
Unknown data, audit errors, changed scope, a published patch in the advisory,
critical escalation, any unrelated high/critical finding, and expiry fail closed.
Product audits, secrets, and image scanning have no exception.

This PR stages the policy and exact trusted-floor transitions. Existing canonical
and private `check` commands retain the native audit until a follow-up activation
PR uses the merged trusted checker. Publication and scheduled scans then inherit
the same policy through their existing canonical entry points. No global ignore
list, skipped audit, severity reduction or new dependency is introduced.

Each policy invocation keeps unfiltered native JSON and exit status in a new
0700 temporary directory named `fleetiq-harness-audit-*`, with 0600 files. These
private reports are not uploaded or echoed. A successful exception prints its
advisory, owner and expiry visibly. `pnpm --dir harness audit --audit-level high`
remains the raw failing witness while the advisory is present.
