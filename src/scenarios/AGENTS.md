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

Use `node --test tests/scenarios/route.test.ts` for route/profile behavior. The disjoint
scenario coverage group retains 90% lines / 85% branches. `capture.ts` owns capture/send tick order and `clock.ts` maps injected monotonic
elapsed time to virtual time. Route metadata exposes state transitions without
advancing GPS samples. Keep transport deadlines outside all three. Use
`node --test tests/scenarios/capture.test.ts` for clock, trigger and batching composition.

`faults.ts` snapshots already-valid single-record frames and applies one explicit
action per original packet ordinal. Keep malformed bytes out of valid wire
constructors; mutations, identity selection and duplicate expansion happen before
IO. `node --test tests/scenarios/faults.test.ts` checks admission, exact bytes and bounds.

`fleet.ts` prepares independent seeded/device-clock playbacks and owns fair FIFO
leases under profile/queue caps. All scheduling times are caller-supplied; no
async attempts, backoff timers or metrics sampling belong here. Run
`node --test tests/scenarios/fleet.test.ts` for admission, independence and fairness.
