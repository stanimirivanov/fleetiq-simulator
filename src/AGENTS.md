# Source boundaries

`cli.ts` owns argument parsing, closed config and private file validation, output
and exit codes. It adapts those inputs to the encoder and session API. Load the
TCP adapter only for the network command. Treat caller data, peer replies and
error text as untrusted. Return reviewed error categories without input content,
paths, endpoints or wire bytes.

`wire/` owns record validation and bytes. `session/` owns handshake and
delivery state. The CLI composes them. Use explicit relative `.ts` imports so
Node and the build agree. New top-level source owners require a reviewed
boundary update in `tools/architecture.mjs`.
