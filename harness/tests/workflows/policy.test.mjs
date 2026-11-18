import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isMap, isSeq } from "yaml";
import { gitleaksVersion } from "../../src/security/secrets.mjs";
import {
  checkout,
  manifest,
  pnpmInstall,
  setupNode,
  workflow,
} from "../../support/workflow-fixture.mjs";
import { verifyVersionPins } from "./pin-policy.mjs";

/** Checks authority and required steps, rejecting conditions that could skip scans.
 * @param {import("yaml").Document} document
 * @param {boolean} scheduled
 */
function verify(document, scheduled) {
  verifyVersionPins(document, manifest, gitleaksVersion);
  assert.deepEqual(document.toJS().permissions, { contents: "read" });
  const jobs = document.get("jobs");
  assert.ok(isMap(jobs));
  assert.deepEqual(
    jobs.items.map((entry) => String(entry.key)),
    [scheduled ? "security" : "check"],
  );
  const job = document.getIn(["jobs", scheduled ? "security" : "check"]);
  assert.ok(isMap(job));
  assert.deepEqual(
    job.items.map((entry) => String(entry.key)).sort(),
    (scheduled
      ? ["if", "runs-on", "timeout-minutes", "steps"]
      : ["runs-on", "timeout-minutes", "steps"]
    ).sort(),
  );
  assert.equal(job.get("runs-on"), "ubuntu-latest");
  assert.equal(job.get("timeout-minutes"), 10);
  if (scheduled) assert.equal(job.get("if"), "github.ref == 'refs/heads/main'");
  const steps = job.get("steps");
  assert.ok(isSeq(steps));
  const values = steps.items.map((step, index) => {
    assert.ok(isMap(step));
    for (const entry of step.items)
      assert.ok(
        [
          "name",
          "uses",
          "with",
          "run",
          "shell",
          ...(!scheduled && index === 5 ? ["env"] : []),
        ].includes(String(entry.key)),
        "unexpected step authority or skip",
      );
    return step.toJSON();
  });
  assert.equal(values.length, 7);
  assert.deepEqual(values[0], {
    uses: checkout,
    with: {
      "persist-credentials": false,
      "fetch-depth": 0,
      ...(scheduled ? { ref: "refs/heads/main" } : {}),
    },
  });
  assert.deepEqual(values[1], {
    uses: setupNode,
    with: { "node-version": manifest.engines.node },
  });
  assert.deepEqual(values[2], { run: pnpmInstall });
  assert.deepEqual(values[3], {
    run: "pnpm install --frozen-lockfile && pnpm --dir harness install --frozen-lockfile --ignore-scripts",
  });
  assert.match(
    values[4].run,
    /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/,
  );
  assert.match(values[4].run, /sha256sum --check/);
  if (scheduled) {
    assert.equal(values[5].shell, "bash");
    assert.match(
      values[5].run,
      /test "\$\(git rev-parse --is-shallow-repository\)" = false/,
    );
    assert.match(
      values[5].run,
      /test "\$\(git rev-parse HEAD\)" = "\$\(git rev-parse refs\/remotes\/origin\/main\)"/,
    );
  }
  if (!scheduled) {
    assert.equal(values[5].shell, "bash");
    assert.deepEqual(values[5].env, {
      BASE_SHA: ["$", "{{ github.event.pull_request.base.sha }}"].join(""),
    });
    assert.match(
      values[5].run,
      /git show "\$BASE_SHA:harness\/src\/verification\/floor\.mjs" \| node --input-type=module - "\$BASE_SHA"/,
    );
    assert.doesNotMatch(
      values[5].run,
      /BASE_SHA:tools\/floor\.mjs|elif test "\$BASE_SHA"|One-time introduction/,
    );
  }
  assert.equal(values.at(-1).run, scheduled ? "pnpm security" : "pnpm check");
}

test("PR workflow retains its required check, full history and live security gate", () => {
  const document = workflow("ci");
  assert.equal(document.get("name"), "Simulator verification");
  assert.deepEqual(document.toJS().on, { pull_request: null });
  verify(document, false);
  const scripts = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ).scripts;
  assert.match(scripts.check, /&& pnpm security$/);
  const harness = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    scripts["security:harness"],
    "pnpm --dir harness run audit:approved",
  );
  assert.equal(
    harness.scripts.check,
    "pnpm typecheck && pnpm test && pnpm run audit:approved",
  );
  assert.equal(
    harness.scripts["audit:approved"],
    "node src/security/audit.mjs",
  );
  assert.equal(harness.scripts.audit, "pnpm audit --audit-level high");
  assert.equal(
    scripts.security,
    "pnpm secrets && pnpm audit --audit-level high && pnpm security:harness",
  );
});

test("daily and manual scans use full main history with read-only authority", () => {
  const document = workflow("security-scheduled");
  assert.deepEqual(document.toJS().on, {
    schedule: [{ cron: "17 4 * * *" }],
    workflow_dispatch: null,
  });
  verify(document, true);
});

test("workflow controls reject weakened permissions, scope, pins and skipped scans", () => {
  /** @type {[Array<string | number>, unknown][]} */
  const mutations = [
    [["permissions", "contents"], "write"],
    [["jobs", "security", "if"], "always()"],
    [["jobs", "security", "steps", 0, "uses"], "actions/checkout@v7"],
    [["jobs", "security", "steps", 0, "with", "fetch-depth"], 1],
    [["jobs", "security", "steps", 0, "with", "ref"], "untrusted"],
    [["jobs", "security", "steps", 6, "continue-on-error"], true],
    [["jobs", "security", "steps", 6, "if"], "false"],
    [["jobs", "security", "steps", 6, "run"], "echo skipped"],
  ];
  for (const [path, value] of mutations) {
    const document = workflow("security-scheduled");
    document.setIn(path, value);
    assert.throws(() => verify(document, true), { name: "AssertionError" });
  }
});
