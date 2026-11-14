# Source boundaries

`cli.ts` owns argument parsing, closed config and private file validation, output
and exit codes. It adapts those inputs to the encoder and session API. Load the
TCP adapter with a literal dynamic import inside the network command. Treat caller data, peer replies and
error text as untrusted. Return reviewed error categories without input content,
paths, endpoints or wire bytes.

`scenarios/` owns deterministic kinematics and model IO, depending only on its
own modules, wire types and Ajv. It reads no files, clocks or network state.
`storage/` owns private checkpoint files and kernel-backed locking behind the
session persistence port. Session validates checkpoint state without filesystem imports.
`wire/` owns record validation and bytes. `session/` owns policy and
`transport/` owns handshake and delivery. The CLI composes them. Use explicit relative `.ts` imports so
Node and the build agree. New top-level source owners require a reviewed
boundary update in `harness/src/architecture/architecture.mjs`.


Follow the [shared JS/TS comment standard](../docs/comment-quality.md). Document
public contracts and nontrivial named helpers with meaningful JSDoc; explain
bounds, ownership, effects and failure behavior where relevant. Type signatures
are not prose documentation. `pnpm lint:source-comments` enforces structure and
spacing through the existing fast/canonical gates; review checks accuracy.

`telemetry.ts` owns pure fixed-cardinality aggregates; transport supplies real
measurements through its caller. No files, process state, timers or private labels
belong in that module. Fleet retry orchestration lives in `transport/fleet.ts`;
`scenarios/fleet.ts` owns only deterministic preparation and lease policy.
