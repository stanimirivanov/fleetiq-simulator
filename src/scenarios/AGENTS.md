# Deterministic playback

Own route kinematics, virtual sample order, last sampled GPS fix and the reviewed
IO profile. Accept parsed JSON from the caller; do not read files, ambient time,
randomness, sockets or session state. Only scenario/wire contracts and Ajv are
allowed dependencies. Keep the architecture/purity passing and failing controls.

Follow the shared comment standard. Document physical units, rounding, limits,
owned state and GPS quality assumptions. A profile is documentation-derived,
never a hardware/firmware support claim. Catalogue changes need sourced IDs,
widths and independent raw-value expectations. Typed input errors must keep
routes and model data out of diagnostics.

Use `node --test tests/route.test.ts` for route/profile behavior. The disjoint
scenario coverage group retains 90% lines / 85% branches. Do not move capture,
send scheduling or transport deadlines into playback; SIM-PR10 owns scheduling.
