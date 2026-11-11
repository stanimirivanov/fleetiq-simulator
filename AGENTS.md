# FleetIQ simulator

Start with the issue and the nearest guide below. The simulator uses strict
TypeScript ESM on Node 24.18.0 and pnpm 12.5.1. Keep source compatible with Node's
native TypeScript stripping. Use native Buffer for wire bytes, Ajv for closed
input schemas and Effect 4 for TCP resource lifetime.

| Touching | Read next |
| --- | --- |
| `src/cli.ts` or CLI contracts | [Source guide](src/AGENTS.md) |
| Encoding and record validation | [Wire guide](src/wire/AGENTS.md) |
| Session settings or budget | [Session guide](src/session/AGENTS.md) |
| Handshake, ACK or retries | [Transport guide](src/transport/AGENTS.md) |
| Tests or fixtures | [Test guide](tests/AGENTS.md) |
| Gates, hooks or CI | [Tooling guide](tools/AGENTS.md) and [Harness](HARNESS.md) |

Read [CONSTRAINTS.md](CONSTRAINTS.md) before changing a quality gate or contract.
Reuse the existing layer boundaries. Use named exports, explicit units and fixed
error categories. Use comments to explain wire quirks, ownership or ordering
that a reader cannot infer from the code. Cite an independent source for literal
wire fixtures. Keep identities, captures and private settings out of the checkout
and evidence.

- **Plan.** Record the intended behavior, affected owner, acceptance test and
  final gate in the issue or working notes. Identify compatibility changes before
  editing.
- **Execute.** Make one bounded change. For behavior changes, show the new
  regression failing for the intended reason before implementing it. Keep the
  verification floor intact.
- **Verify.** Run the narrow reproduction, then `pnpm check:fast` and
  `pnpm check` before delivery. Inspect the first failure, distinguish a code
  failure from a tool failure, fix the cause and rerun the failing stage.
  Report exact commands and results, including incomplete checks. Run
  `pnpm security` on the final lockfile before opening the PR.

Use the agreed issue and PR workflow. Stage only the task's files. Keep installed
product and physical device qualification evidence separate from simulator tests.
