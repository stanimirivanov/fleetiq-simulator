const reviewedPaths = new Set([
  ".github/workflows/ci.yml",
  ".gitleaks.toml",
  "package.json",
  "pnpm-lock.yaml",
  "src/cli.ts",
  "src/session/state.ts",
  "src/transport/tcp.ts",
  "src/wire/codec8.ts",
  "src/wire/codec8e.ts",
  "tests/codec8e.test.ts",
  "tests/codec8e-fixture.ts",
  "tests/architecture.test.mjs",
  "tests/codec8.test.ts",
  "tests/codec8-fixture.ts",
  "tests/cli.test.ts",
  "tests/coverage.test.mjs",
  "tests/comments.test.mjs",
  "tests/peer.ts",
  "tests/quality.test.mjs",
  "tests/tcp.test.ts",
  "tests/typecheck.test.mjs",
  "tests/transport-load.test.mjs",
  "tools/architecture.mjs",
  "tools/coverage.mjs",
  "tools/diagnostic-location.mjs",
  "tools/secrets.mjs",
  "tools/wire-ambient.mjs",
]);

/**
 * Publishes only paths reviewed in code. Even a tracked or syntactically valid
 * filename can contain private data or CI control characters.
 *
 * @param {string} path
 */
export function reviewedPath(path) {
  return reviewedPaths.has(path) ? path : undefined;
}
