# Simulator coding harness

Start at [AGENTS.md](AGENTS.md). Use this guide for gate failures, harness changes
or rollout. The project is a Node 24.18.0 TypeScript ESM CLI built with TypeScript
5.9.3 and pnpm 12.5.1. It uses native Buffer and TCP, Ajv 8.20.0 for schema
validation and Effect 4.0.5 for TCP scope, interruption and retry. Node's built-in
test runner executes TypeScript with native type stripping and collects coverage.
Biome 2.5.15 checks style and Gitleaks 8.30.1 checks secrets. The repository
contains an offline encoder and a one-record loopback sender.

```text
AGENTS.md                  issue intake, PEV, and context routing
CONSTRAINTS.md             quality floor and gate authority
tsconfig.json               production build and shared strict options
tsconfig.typecheck.json     no-emit project for source, tests and tooling
HARNESS.md                 ownership and rollout
src/
  AGENTS.md                CLI and composition
  cli.ts                   commands, input files, receipts
  wire/AGENTS.md            wire invariants
  session/AGENTS.md         session settings and deadline invariants
  transport/AGENTS.md       socket and delivery invariants
tests/
  AGENTS.md                fixtures and test rules
  architecture.test.mjs     guard controls
tools/
  AGENTS.md                verification authoring
  architecture.mjs         AST import gate
  coverage.mjs             suite/source inventory and native coverage groups
  secrets.mjs              pinned secret scanner
.githooks/pre-commit       opt-in local sensor
.github/workflows/ci.yml   required-check candidate for main
```

| Owner | State or effects owned | Allowed production dependencies |
| --- | --- | --- |
| CLI | Arguments, files, configuration, redacted output, exit status | Session, wire, Ajv, Node fs/path/url. Runtime transport loads are confined to the network command |
| Session state | Validated settings, monotonic run budget, error categories | Session and wire modules, without external imports |
| TCP adapter | Socket lifetime, login, ACK, retries and frozen bytes | Session, wire, Node net, Effect |
| Wire | Validated record, AVL payload, TCP envelope and immutable frame metadata | Wire and Ajv |

The TypeScript AST gate checks imports, re-exports, import types, literal dynamic
imports, unsupported CommonJS imports and cycles. New ownership requires a
policy change with tests. The gate distinguishes type-only edges from runtime
loads and checks selected ambient wire APIs. A Node load canary verifies that
offline commands never load transport in source or built execution. These
checks complement the loopback tests that protect transport semantics.

| Point | Run | Failure action |
| --- | --- | --- |
| Edit | `node --test tests/codec8.test.ts` or `node --test tests/tcp.test.ts` | Inspect the failing assertion and reproduce the smallest case |
| Stage | `pnpm floor && pnpm check:fast` | Remove prohibited indexed paths; fix floor, style, type or import diagnostics |
| Pre-PR | `pnpm install --frozen-lockfile`, `pnpm check`, then `pnpm security` on the final lockfile | Fix the cause or report a missing tool, unavailable advisory service or other incomplete gate |
| PR CI | Existing `Simulator verification / check` job runs `pnpm check` | Attach concise, sanitized failure evidence to the task and return to the relevant narrow check |

The type gate checks source, TypeScript test helpers, and JavaScript test and
tool modules. The build emits only production code. Biome enforces named exports
and TypeScript rejects syntax that requires runtime transformation.

The canonical gate executes lint, type checking, architecture and canaries, build,
coverage tests, secret scanning and the dependency audit. `pnpm test:coverage`
registers each suite once in disjoint groups. It checks the source inventory
against structured Node coverage events so unloaded files cannot disappear
from a group's denominator. Each group has its own fresh test process and
thresholds. A failing group stops verification. The live advisory
database changes over time, so record the run outcome rather than treating it
as a permanent clearance. The install commands and scanner checksum are in CI.

To enable the optional hook, first inspect `git config --get core.hooksPath` and
preserve any hooks already in use. Then run
`git config --local core.hooksPath .githooks` if appropriate. The hook checks
staged changes by requiring tracked and unignored worktree contents to match
the index before it runs `pnpm floor` followed by `pnpm check:fast`. Fetch
`origin/main` before committing so the floor gate has its immutable local
baseline. Stage the intended files or isolate unrelated edits in another checkout. CI is the authority because local hooks
can be bypassed and ignored build/dependency inputs are local.

Progressive hardening:

1. **Repository baseline.** Review the scoped guides and the passing and failing
   controls together. Adopt the optional hook and record the normal fast-gate
   duration before introducing timing targets.
2. **Merge enforcement.** The repository owner configures a main ruleset to
   require the successful `Simulator verification / check` job and review of
   changes to verification policy. Verify the actual status context in GitHub
   and test the ruleset with a failing PR. Add a merge-group trigger before
   requiring this check in a merge queue. Ruleset configuration is external.
3. **Guard the floor.** `pnpm floor` compares the candidate worktree to a Git
   ancestor, detecting new suppressions, disabled/focused tests, removed test
   declarations, changed verification scripts and reduced coverage floors.
   See the authority and review procedure below; CODEOWNERS enforcement and
   merge-bypass restrictions still require an external ruleset.
4. **Ratchet with evidence.** Add executable image, resource and installed
   acceptance gates in their owning simulator/deployment slices. Record actual
   measurements before setting new budgets. Keep CI and operator evidence
   separate from physical hardware qualification.

## Security between pull requests

`Scheduled security / security` runs `pnpm security` at **04:17 UTC daily**
and on manual dispatch from `main`. The PR job remains
`Simulator verification / check` and still runs the complete canonical gate,
including both secret and live advisory scans. Neither job has write permission.
Checkout and setup-node use upstream-verified full commit SHAs (v7 at adoption);
review the upstream commit and workflow controls when updating pins.

The scheduled checkout explicitly fetches `refs/heads/main` with full history.
Before scanning, it rejects shallow history or a HEAD different from fetched
`origin/main`, and records the exact checked-out SHA in the run summary. A main
advance during queueing can make this SHA newer than the event SHA. Gitleaks
checks the worktree, index and history of **all locally available refs**
(its pinned default is `git log -p -U0 --full-history --all --diff-filter=tuxdb`).
This includes main and merged parents, plus other branches/tags fetched by
checkout. It does not prove coverage of server-only or unreachable/deleted refs,
forks or private operator files. See the [pinned scanner implementation](https://github.com/gitleaks/gitleaks/blob/v8.30.1/sources/git.go). The clean scheduled index has
no staged edits. Dependencies are installed from the frozen lockfile and audited
against the live registry with the unchanged high/critical failure threshold.
No findings are suppressed or cached as a permanent clearance; scanner or
advisory-service failures leave the gate incomplete and failing.

Repository maintainers own triage of failed scheduled runs: inspect the failed
step, keep raw secret reports private, rotate any exposed credential, and open
a bounded fix issue/PR. For tool or service failures, restore the tool/service
and rerun the workflow; do not bypass the gate. Use GitHub Actions failure
notifications and inspect the latest scheduled run before relying on it.

After merge, a maintainer must dispatch the workflow on `main` and verify its
recorded SHA, full-history guard and security result, then observe a scheduled
run. This PR does not claim that hosted execution or branch protection has been
qualified. [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
require the workflow on the default branch, can be delayed or dropped under
load, and are disabled in public repositories after 60 days without activity.
They are periodic detection, not an availability guarantee. If the default
branch is renamed, update the explicit ref and dispatch guard together.

The YAML workflow tests use `yaml` 2.9.1 (ISC, no runtime dependencies), a
development-only parser so quoted scalars and comments cannot substitute for
actual workflow settings. Mutation controls reject shallow/wrong-ref checkouts,
floating action pins, elevated permissions and skipped scans. Required review
depends on the external ruleset below; H8 adds the local floor sensor.

## Private inputs and captures

The ignore policy covers `private-*` names and `.bin`, `.pcap` and `.pcapng`
extensions, including case variants and nested directories. Private operator
inputs and captures belong outside the checkout. Keep reviewed synthetic wire
fixtures as hexadecimal text in TypeScript files.

Ignore rules reduce accidental staging; `pnpm floor` also checks every indexed
path using NUL-delimited Git output. A force-added ignored file, or a prohibited
file already committed with no current diff, still fails. Every path component
is checked, including ignored directory names. Rejection occurs before candidate
contents are read and emits a fixed category without filenames. The checker
never deletes working copies; remove an offending path from the index and move
private inputs outside the checkout. Ignored untracked artifacts are outside
this path gate's index scope.

The optional hook runs the floor gate after index/worktree agreement and before
fast verification. CI retains trusted-base execution after this change merges.
Filename rules do not replace redacted secret scanning or identify all sensitive
content; they do not erase historical copies.

## Verification-policy authority

`pnpm floor` is the first canonical stage. Locally it uses the merge base of
HEAD and fetched `origin/main`; run `git fetch origin main` before qualification.
For reproduction, `node tools/floor.mjs <40-character-base-SHA>` selects an exact
ancestor. Missing objects, unrelated history, unsupported file entries and Git
errors fail closed. The guard reads committed, staged, unstaged and untracked
candidate code, excluding Git-ignored build/dependency output.

The sensor uses the existing TypeScript parser (no new dependency). It compares
actual comments for TypeScript/Biome/ESLint and coverage suppressions, identifies
static node:test declarations/options and context skip controls, and compares
test-name multisets across changed suites. Moving an unchanged declaration is
allowed. A literal title rename is allowed only when the complete remaining
printed call (target, type arguments, options and callback) is unchanged.
Declarations are consumed once; duplicate titles/shapes cannot hide deletion.
Ambiguous combinations may conservatively fail. Retained-name edits keep their
existing behavior and still require review of assertion quality. Existing
suppression comments may move within a file; new or edited suppression comments fail. Coverage group
names and numeric line/branch floors must remain readable and cannot decrease.
Existing package scripts must remain unchanged, except the original floor
bootstrap and narrowly additive suffixes such as ` && pnpm check:extra`. The
complete baseline command must be preserved byte-for-byte and use only plain
`pnpm`/`node`/`tsc`/`biome`/`eslint` command chains joined by ` && `. Each appended
script must have a lowercase namespaced name (for example `check:extra`) and
an own nonempty definition in package.json. Namespacing avoids pnpm built-ins.
Arguments, comments, redirections, substitutions, alternate operators and
unknown scripts are rejected. Shell fixtures prove that a failed baseline
short-circuits the suffix and that added failures still fail the chain.
Added tests and ordinary implementation changes remain allowed.

This is a conservative structural sensor, not a proof of test semantics: it
cannot prove assertions remain meaningful, resolve arbitrary dynamic test
factories/options, or detect every semantic weakening inside a checker. Review
owns those cases. Failures emit fixed categories and recovery instructions;
inspect the diff privately rather than publishing candidate text or filenames.

PR CI passes the event's exact base SHA and runs **that base's** `floor.mjs`
through Node stdin before candidate verification. Candidate edits cannot replace
the already-merged checker. Introduction is allowed only against H7 merge
`2f86fa158e7996070257f61d6cdfeb948a041b1b`; any other missing base checker fails.
The bootstrap branch becomes unreachable once H8 is the base. The scheduled
security workflow is unchanged. Local execution uses candidate tooling; the
workflow itself, parser dependency and other harness changes still require review.

`.github/CODEOWNERS` assigns verification inputs, tests, guides and ownership
policy to the repository owner. Whole-file ownership protects `package.json`
scripts because CODEOWNERS cannot select individual JSON fields. Structural
maintenance allowances establish mechanical preservation, not human approval.
They do not authorize suppressions, assertion changes accompanying a rename,
deletions or lower thresholds; external code-owner review remains required.
For intentional blocked maintenance, retain the original protection where possible; otherwise
record the exact diff, rationale, replacement evidence and explicit maintainer
approval in a dedicated policy PR. A narrowly authorized ruleset bypass must be
recorded externally if needed; there is no in-repository skip flag or self-issued
allowlist. Do not weaken the checker merely to get an ordinary PR green.

Maintainer setup and qualification (not performed by this PR):

1. On `main`, require PRs, the actual `Simulator verification / check` status
   context, code-owner approval, dismissal of stale approvals, and approval of
   the most recent push by an eligible reviewer. Restrict bypass actors; do not
   give the coding agent routine bypass authority. Add another eligible owner
   when the sole owner authors a PR, since authors cannot approve their own PRs.
2. After merge, verify GitHub accepts the CODEOWNERS entries and requests the
   correct reviewer on a policy PR. Use deliberate failing fixtures to verify a
   failed status and a missing owner approval both prevent merging. Verify that
   a later push invalidates the required approval. Record URLs/results privately.
3. Until these checks are observed, report repository sensors as implemented
   and external merge enforcement as **unqualified**. Do not claim CODEOWNERS
   alone blocks merges or configure merge-queue requirements without a trigger.

References: [GitHub code ownership](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
and [ruleset review/status requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

## Wire oracle and qualification scope

`node --test tests/codec8.test.ts tests/codec8-oracle.test.ts` is the focused
wire gate; both suites run once in the canonical wire coverage group.
`tests/codec8-vectors.ts` cites the two applicable single-record TCP examples
from [Teltonika Codec 8](https://wiki.teltonika-gps.com/view/Codec#Codec_8).
The third literal example retains its manufacturer CRC and proves rejection
by the current single-record profile. UDP and later-codec fixtures belong to
those protocol slices; their support is not implied by this oracle.

`tests/codec8-oracle.ts` is test-only and imports no production code, schema,
layout constants or types. It uses a bounded sequential cursor and an MSB-first
CRC division with reflected input/output, independent of production's LSB-first
algorithm. Literal vectors anchor the decoder and encoder. Fixed seeds exercise
256 reproducible records with signed coordinates, exact u64 timestamps, field
limits/interior values, 0/1/4/64 IO entries and all four IO widths. Negative cases
cover truncation, trailing data, bit corruption and checksum-valid malformed
counts/fields. These are deterministic generated checks, not exhaustive proof
or a qualified mutation-testing toolchain.

Altitude stays raw `u16`, matching the current platform contract. The cited
manufacturer table gives width and units without resolving signedness; settle
that question before extending the contract to later codecs.

## Pinned platform decoder gate

`pnpm test:platform /absolute/path/to/platform-checkout` qualifies actual
simulator output against the reviewed revision and Rust release in
`tools/platform-pin.json`. Prepare a separate public checkout outside the
simulator tree (the workflow shows exact fetch commands), then install the
pinned toolchain with rustfmt. The gate verifies HEAD, the checkout root, a clean
tracked/untracked status and the source toolchain declaration before compiling.
Missing source, wrong revision, dirty source, tool/build failures and any output
mismatch fail; they never become a skipped success. Compiler and decoder output
stay private; diagnostics identify the failing stage and recovery action.

The pinned native package is std-only. The gate invokes `rustc +1.99.1` with
edition 2024 and warnings denied on its real `packages/teltonika/src/lib.rs`,
then compiles `tools/platform-adapter.rs` against that library. It does not copy
or reinterpret the platform decoder and performs no Cargo dependency resolution.
This qualifies the native wire API, not the Wasm component or the host pipeline.
If a future pin adds native dependencies/features, review and update the build
path explicitly. No platform working source or sibling checkout is changed.

The H9 manufacturer and generated corpus is shared via
`tests/codec8-corpus.ts`. Every accepted case compares codec, record count,
exact decimal timestamp, priority, signed coordinates, raw altitude, angle,
satellites, speed, event ID, IO order/IDs/widths and every raw value byte.
Expected output is derived from input records, not the independent decoder.
The simulator admits u64 timestamps and duplicate IO IDs; this platform revision
rejects timestamps above i64::MAX and duplicate IDs as Malformed (code 1).
Those original cases remain explicit rejection checks, with additional signed
timestamp boundary, duplicate-ID and checksum (code 4) controls. Current results:
262 cases, 165 exact accepted records and 97 expected rejections. A deliberately
wrong expected result must fail the comparator during every real gate run.

The adapter admits at most 512 lines, 2 MB input and 1280 bytes per frame.
Subprocess output is bounded to 2 MB, each build command to 60 seconds and corpus
execution to 10 seconds; artifacts are removed in a finally block. The separate
PR workflow has a 10-minute deadline, fetches only the exact public platform
revision into RUNNER_TEMP, installs the exact Rust toolchain and checks
`rustfmt +1.99.1 --check --edition 2024 tools/platform-adapter.rs` before running
the gate. Node-only canonical tests cover comparisons and failure controls;
they do not require Rust or a network checkout.

`Platform decoder qualification / qualify` is an additional required-check
candidate; `Simulator verification / check` remains unchanged. A maintainer must
observe the actual hosted status and configure/qualify its external main ruleset
before claiming merge enforcement. This PR does not configure rulesets or claim
hosted/physical-device/installed-product qualification. The separately run
`cargo test --locked -p fleetiq-teltonika` remains a supporting package gate,
not a substitute for feeding simulator output to the pinned decoder.
