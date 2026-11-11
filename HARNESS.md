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
| Stage | `pnpm check:fast` | Fix Biome, strict types or import diagnostics |
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
the index before it runs `pnpm check:fast`. Stage the intended files or isolate
unrelated edits in another checkout. CI is the authority because local hooks
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
3. **Guard the floor.** When there is a reviewed baseline, add a base-aware check
   for new suppression directives, skipped or deleted tests and weakened
   thresholds. Qualify it against allowed maintenance, deliberate violations
   and missing baseline history. Until then these changes require review.
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
floating action pins, elevated permissions and skipped scans. Future required
review and suppression-floor controls belong to H8.
