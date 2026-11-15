import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gitleaksVersion } from "../../src/security/secrets.mjs";
import {
  checkout,
  manifest,
  pnpmInstall,
  setupNode,
  workflow,
} from "../../support/workflow-fixture.mjs";
import { verifyVersionPins } from "./pin-policy.mjs";

test("platform decoder workflow uses the reviewed source pin and exact Rust toolchain", () => {
  const document = workflow("platform-decoder");
  verifyVersionPins(document, manifest, gitleaksVersion);
  const value = document.toJS();
  const pin = JSON.parse(
    readFileSync(
      new URL(
        "../../src/qualification/platform/platform-pin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(value.on, { pull_request: null });
  assert.deepEqual(value.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(value.jobs), ["qualify"]);
  assert.equal(value.jobs.qualify["timeout-minutes"], 10);
  const steps = value.jobs.qualify.steps;
  assert.equal(steps.length, 8);
  assert.deepEqual(steps[0], {
    uses: checkout,
    with: { "persist-credentials": false },
  });
  assert.deepEqual(steps[1], {
    uses: setupNode,
    with: { "node-version": manifest.engines.node },
  });
  assert.deepEqual(steps[2], { run: pnpmInstall });
  assert.deepEqual(steps[3], {
    run: "pnpm install --frozen-lockfile && pnpm --dir harness install --frozen-lockfile --ignore-scripts",
  });
  assert.deepEqual(steps[4].env, { PLATFORM_REVISION: pin.revision });
  assert.match(
    steps[4].run,
    /git .* fetch --depth=1 origin "\$PLATFORM_REVISION"/,
  );
  assert.match(
    steps[4].run,
    /https:\/\/github.com\/stanimirivanov\/fleetiq-platform.git/,
  );
  assert.match(steps[4].run, /checkout --detach FETCH_HEAD/);
  assert.equal(
    steps[5].run,
    `rustup toolchain install ${pin.rustToolchain} --profile minimal --component rustfmt`,
  );
  assert.equal(
    steps[6].run,
    `rustfmt +${pin.rustToolchain} --check --edition 2024 harness/src/qualification/platform/platform-adapter.rs`,
  );
  assert.equal(
    steps[7].run,
    'pnpm test:platform "$RUNNER_TEMP/fleetiq-platform"',
  );
  for (const step of steps) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  }
});
