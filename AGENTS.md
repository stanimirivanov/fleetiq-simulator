# FleetIQ simulator

## Workflow authority

Use installed `mattpocock/skills` as the primary workflow for matching tasks.
Discover and load skills on demand. When workflows overlap, use the matching
Matt Pocock skill rather than a parallel workflow. Use other skills only for
capabilities not covered by that workflow or when explicitly requested.

Repository guidance supplies technical constraints, architecture boundaries and
verification requirements. Scoped `AGENTS.md` files are subordinate for workflow
decisions and add only module-specific constraints. Explicit user instructions
and host permissions remain authoritative.

Start with the issue and the nearest guide below. The simulator uses strict
TypeScript ESM; runtime, package-manager and dependency pins are in
[package.json](package.json). Keep source compatible with Node's native
TypeScript stripping. Use native Buffer for wire bytes, Ajv for closed input
schemas and Effect for TCP resource lifetime.

| Touching | Read next |
| --- | --- |
| `src/cli.ts` or CLI contracts | [Source guide](src/AGENTS.md) |
| Route playback and model IO | [Scenario guide](src/scenarios/AGENTS.md) |
| Encoding and record validation | [Wire guide](src/wire/AGENTS.md) |
| Private checkpoint IO | [Storage guide](src/storage/AGENTS.md) |
| Session settings or budget | [Session guide](src/session/AGENTS.md) |
| Handshake, ACK or retries | [Transport guide](src/transport/AGENTS.md) |
| Product image preparation | [Packaging guide](packaging/AGENTS.md) |
| Tests or fixtures | [Test guide](tests/AGENTS.md) |
| Gates, hooks or CI | [Tooling guide](harness/AGENTS.md) and [Harness](harness/docs/HARNESS.md) |

Read [CONSTRAINTS.md](harness/docs/CONSTRAINTS.md) before changing a quality gate or contract.
Reuse the existing layer boundaries. Use named exports, explicit units and fixed
error categories. Use comments to explain wire quirks, ownership or ordering
that a reader cannot infer from the code. Cite an independent source for literal
wire fixtures. Keep identities, captures and private settings out of the checkout
and evidence.

- Verification: Run the narrow reproduction, then `pnpm check:fast` and
  `pnpm check` before delivery. Inspect the first failure, distinguish a code
  failure from a tool failure, fix the cause and rerun the failing stage.
  Report exact commands and results, including incomplete checks. Run
  `pnpm security` on the final lockfile before opening the PR.

Keep installed
product and physical device qualification evidence separate from simulator tests.

## Agent skills

### Issue tracker

GitHub Issues in `stanimirivanov/fleetiq-simulator`.
See [issue tracker](docs/agents/issue-tracker.md).

### Triage labels

Use the five configured roles. See [triage labels](docs/agents/triage-labels.md).

### Domain docs

Single-context glossary and repository-owned decisions.
See [domain docs](docs/agents/domain.md).
