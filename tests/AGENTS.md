# Verification fixtures

Use `node:test` and `node:assert/strict`. Put behavior tests in `*.test.ts` and
tooling tests in `*.test.mjs`. Check observable bytes, exit codes and socket
lifetime. Keep the peer independent of the production session. Use bounded
deadlines and test-owned loopback sockets or temporary directories with cleanup.
Build synthetic identities at runtime. Keep real identities, endpoints and
captures out of tests and output.

A sensor needs a passing control and a meaningful violation. Distinguish a
missing or broken tool from a clean result. Do not skip tests or weaken
assertions to reach a pass.
