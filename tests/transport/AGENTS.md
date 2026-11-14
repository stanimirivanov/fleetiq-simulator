# Transport acceptance

Separate TCP acknowledgement, uncertain-acceptance recovery, deadlines and
Compose DNS from pure session/command state. Keep command exchange, fault, fleet
and UDP acceptance in their own suites. Small TCP frame/options setup stays
suite-local; independent socket peers live under `../support/peers/`.

Run from the repository root. Every case owns its sockets, mocks, signals and
cleanup. Preserve test titles, retry bytes, receipt checks and deadlines; splitting
files must not create a parallel startup burst. Run
`node harness/src/verification/coverage.mjs session` for the serial group.
