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
| Wire | Validated record and deterministic bytes | Wire and Ajv |

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
