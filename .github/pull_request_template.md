## Problem and result

Closes #<!-- issue number -->

Describe the concrete trigger, previous behavior and resulting behavior. State
what is outside this PR and any remaining prerequisite.

## Review checklist

- [ ] One coherent issue is addressed; unrelated refactoring and generated churn are absent.
- [ ] Dependencies follow the repository boundaries; state, byte ownership and resource cleanup have a clear owner.
- [ ] Wire/profile changes, defaults, schemas, exit codes, receipts and retry behavior are compatible, or the compatibility change is explicit.
- [ ] Changed behavior has a regression that failed before the fix; assertions check useful outcomes and protocol expectations have an independent source. For prose-only changes, explain why behavior tests do not apply.
- [ ] Nontrivial comments explain constraints or reasons; types and names agree with the actual behavior.
- [ ] No identities, credentials, endpoints, captures, raw scanner reports or unreviewed diagnostic metadata appear in the diff or evidence.
- [ ] Test deletions, suppressions, threshold changes, dependency additions and verification-policy changes are called out with their rationale and replacement evidence.
- [ ] Observed runtime/tool versions match repository pins, and required checks ran on the final relevant state. Missing, failed or not-run checks and known limitations are recorded accurately.

## Verification

List the commands and outcomes, including focused regressions and canonical
verification. For protocol qualification, identify the source revision and
separate local, hosted, installed-product and physical-device evidence.

| Command / check | Result | Sanitized evidence |
| --- | --- | --- |
| | | |

Use the current commands and quality floor in [HARNESS.md](https://github.com/stanimirivanov/fleetiq-simulator/blob/main/HARNESS.md) and
[CONSTRAINTS.md](https://github.com/stanimirivanov/fleetiq-simulator/blob/main/CONSTRAINTS.md); do not copy version or threshold pins here.

## Maintainer review and policy changes

Record review notes and unresolved concerns. When verification policy changes,
identify the exact scope, baseline, reason and preservation/replacement control.
Explain any nontrivial rollout or rollback requirements.

This checklist supports manual maintainer review. CODEOWNERS records
responsibility and review routing; a second reviewer or formal independent
approval is not a prerequisite. Checked boxes and green checks are not permission
for a coding agent to merge, change repository settings or claim human approval.

For a new or recurring harness failure, update the
[sanitized failure log](https://github.com/stanimirivanov/fleetiq-simulator/blob/main/docs/harness-failures.md) with the root cause,
corrective control and evidence. Keep raw incident material private.
