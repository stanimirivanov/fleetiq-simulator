# Harness failure learning

Record failures that reveal a missing control, recurring tool/environment issue
or misleading verification result. Each entry needs a symptom, root cause,
corrective control, evidence and an accurate status. Extend an existing entry
when the cause recurs; do not turn this into a transcript of routine runs.

Use fixed categories, reviewed source references and synthetic reproductions.
Never include credentials, device identities, operator endpoints, capture data,
raw tool reports, unreviewed filenames or private incident URLs. Public links
below refer only to reviewed repository issues, changes and regression tests.
A merged correction is not proof of external ruleset or hardware qualification.

## HF-001: Computed controls escaped the floor sensor

- **Symptom:** A retained test could acquire a literal computed disabling option without a floor violation.
- **Root cause:** The sensor recognized dot access and direct property spellings but did not normalize computed literal keys consistently.
- **Corrective control:** Normalize literal calls/options/context controls without evaluating expressions. Retain false-option and fixture-string passing controls.
- **Evidence:** [Issue #27](https://github.com/stanimirivanov/fleetiq-simulator/issues/27), [PR #28](https://github.com/stanimirivanov/fleetiq-simulator/pull/28), computed-control Git fixtures in [harness/tests/floor.test.mjs](../tests/floor.test.mjs).
- **Status:** Correction merged 2026-11-11. Reproduce with `node --test harness/tests/floor.test.mjs`. Arbitrary dynamic expressions remain outside this structural sensor.

## HF-002: Safe maintenance was rejected as weakened verification

- **Symptom:** A pure literal title rename or an additive verification command failed the floor gate.
- **Root cause:** Name-only test accounting and exact script equality could not distinguish bounded maintenance from removed protection.
- **Corrective control:** Consume declarations once, compare complete calls with only the title replaced, and allow narrowly additive namespaced commands. Real shell controls preserve baseline and added-gate failures.
- **Evidence:** [Issue #29](https://github.com/stanimirivanov/fleetiq-simulator/issues/29), [PR #30](https://github.com/stanimirivanov/fleetiq-simulator/pull/30), rename/duplicate/shell fixtures in [harness/tests/floor.test.mjs](../tests/floor.test.mjs).
- **Status:** Correction merged 2026-11-11. Structural preservation does not establish semantic quality or human approval; retained-name edits still need manual assertion review.

## HF-003: Private paths could enter commits without content findings

- **Symptom:** A capture path with innocuous contents could be staged, force-added or already committed without being rejected by filename policy.
- **Root cause:** Ignore rules and an index-path guard were absent; content scanning cannot identify every sensitive artifact.
- **Corrective control:** Ignore the prohibited names and inspect the entire NUL-delimited index before candidate contents. Run the floor gate from the hook after index agreement; keep diagnostics filename-free and working copies intact.
- **Evidence:** [Issue #31](https://github.com/stanimirivanov/fleetiq-simulator/issues/31), [PR #32](https://github.com/stanimirivanov/fleetiq-simulator/pull/32), independent force-add/committed-path/privacy/hook fixtures in [harness/tests/floor.test.mjs](../tests/floor.test.mjs).
- **Status:** Correction merged 2026-11-12. Current-index safeguards do not erase historical copies or replace secret scanning. Operator material still belongs outside the checkout.

## HF-004: An expired tool cache invalidated local verification evidence

- **Symptom:** A preliminary local canonical run succeeded under the workstation runtime instead of the repository-pinned Node release.
- **Root cause:** A temporary tool directory had expired, so PATH fell back to the workstation executable. Package-manager version selection did not enforce the Node pin.
- **Corrective control:** Check actual `node --version` and `pnpm --version` against package metadata before citing results. Restore the pinned tools outside the source tree and rerun verification; discard the preliminary pass as evidence for the pinned runtime.
- **Evidence:** [Issue #33](https://github.com/stanimirivanov/fleetiq-simulator/issues/33) and the runtime-version item in the [PR checklist](../../.github/pull_request_template.md).
- **Status:** Detected 2026-11-12 during HR-PR4. Pinned rerun qualification is recorded in the PR verification results. This manual control does not claim automated local runtime enforcement.


## HF-005: Source documentation escaped the tooling-only comment gate

- **Symptom:** Merged Codec 8/8E exports and other source contracts lacked declaration documentation while canonical lint passed.
- **Root cause:** ESLint selected only `tools/**/*.mjs`; TypeScript source had no matching parser/configuration. Scoped guides described invariants without an enforceable declaration policy.
- **Corrective control:** Add a pinned TypeScript parser, explicit source declaration contexts, descriptive-summary and comment-spacing checks. Route the new source gate through existing fast/canonical validation; document all five source modules and retain semantic review.
- **Evidence:** [Issue #45](https://github.com/stanimirivanov/fleetiq-simulator/issues/45), ignored-source RED fixtures and passing/failing declaration controls in [harness/tests/comments.test.mjs](../tests/comments.test.mjs).
- **Status:** Local correction under review. Lint cannot determine whether prose is accurate or useful; no external ruleset qualification is implied.

## HF-006: Sequential CLI startups shared one deadline

- **Symptom:** The private-identity CLI acceptance test was cancelled at 3000 ms twice in PR #52 while all result assertions completed.
- **Root cause:** Six sequential cold Node processes shared one three-second test deadline despite each child having a two-second limit. Coverage and slower CI startup exhausted the aggregate allowance.
- **Corrective control:** Give each scenario an independent test and private peer/fixture. Preserve the three-second test and two-second child deadlines, all six exit/output assertions and peer wire checks; additionally assert rejected inputs create zero TCP connections. No product deadline or verification floor changes.
- **Evidence:** [PR #52](https://github.com/stanimirivanov/fleetiq-simulator/pull/52), acceptance cases in [tests/cli.test.ts](../../tests/cli.test.ts). The bounded delayed-start reproduction below cancelled the original test and passes the independent cases.
- **Status:** Local correction under review; hosted CI confirmation remains pending.

Run under the pinned Node version to delay each cold process without changing application code:

```sh
NODE_OPTIONS='--import=data:text/javascript,await%20new%20Promise(r=>setTimeout(r,550))' node --test --test-name-pattern='CLI sends only|CLI private identity boundary' tests/cli.test.ts
```
