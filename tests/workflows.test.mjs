import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isMap, isSeq, parseDocument } from "yaml";
import { gitleaksVersion } from "../tools/secrets.mjs";

const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNode = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";

/** @typedef {{engines: {node: string}, packageManager: string}} ToolMetadata */

/** @type {ToolMetadata} */
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

/** Preserves the reviewed installation command while varying only its pin. @param {string} manager */
function installCommand(manager) {
  return `npm install --global ${manager} --allow-scripts=${manager} --strict-allow-scripts`;
}

const pnpmInstall = installCommand(manifest.packageManager);

/** @type {[string, string][]} */
const workflowJobs = [
  ["ci", "check"],
  ["security-scheduled", "security"],
  ["platform-decoder", "qualify"],
];

/** Reads real YAML so comments and quoted scalars cannot impersonate policy. @param {string} name */
function workflow(name) {
  const document = parseDocument(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
    { uniqueKeys: true },
  );
  assert.deepEqual(document.errors, []);
  return document;
}

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
  assert.deepEqual(values[3], { run: "pnpm install --frozen-lockfile" });
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
      /git show "\$BASE_SHA:tools\/floor\.mjs" \| node --input-type=module - "\$BASE_SHA"/,
    );
    assert.match(
      values[5].run,
      /elif test "\$BASE_SHA" = 2f86fa158e7996070257f61d6cdfeb948a041b1b/,
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
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).scripts;
  assert.match(scripts.check, /&& pnpm security$/);
  assert.equal(
    scripts.security,
    "pnpm secrets && pnpm audit --audit-level high",
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

test("history guard accepts full main and rejects shallow or mismatched checkouts", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-workflow-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = join(directory, "origin");
  const shallow = join(directory, "shallow");

  /** Executes Git without inherited identity or hook requirements. @param {string[]} args */
  function git(args) {
    const result = spawnSync("git", args, {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "--initial-branch=main", origin]);
  git([
    "-C",
    origin,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  git(["-C", origin, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  const script = workflow("security-scheduled").getIn([
    "jobs",
    "security",
    "steps",
    5,
    "run",
  ]);
  assert.equal(typeof script, "string");

  /** Runs the actual workflow shell body against an owned fixture. @param {string} cwd */
  function guard(cwd) {
    return spawnSync("bash", ["-e", "-c", String(script)], {
      cwd,
      env: { ...process.env, GITHUB_STEP_SUMMARY: join(directory, "summary") },
      encoding: "utf8",
      timeout: 10_000,
    });
  }
  assert.equal(guard(origin).status, 0);
  assert.match(
    readFileSync(join(directory, "summary"), "utf8"),
    new RegExp(git(["-C", origin, "rev-parse", "HEAD"])),
  );
  git(["clone", "--depth=1", `file://${origin}`, shallow]);
  assert.equal(guard(shallow).status, 1);
  git([
    "-C",
    origin,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "unmatched",
  ]);
  assert.equal(guard(origin).status, 1);
});

test("verification inputs and the ownership policy have a maintainer owner", () => {
  const rules = readFileSync(
    new URL("../.github/CODEOWNERS", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.trim().split(/\s+/u));
  for (const rule of rules) assert.equal(rule[1], "@stanimirivanov");
  for (const path of [
    "/.github/",
    "/.githooks/",
    "/tools/",
    "/tests/",
    "/**/AGENTS.md",
    "/CONSTRAINTS.md",
    "/HARNESS.md",
    "/docs/harness-failures.md",
    "/package.json",
    "/pnpm-lock.yaml",
    "/tsconfig*.json",
    "/biome.json",
    "/eslint.config.mjs",
    "/.gitleaks.toml",
    "/.gitignore",
  ])
    assert.ok(
      rules.some((rule) => rule[0] === path),
      path,
    );
});

test("platform decoder workflow uses the reviewed source pin and exact Rust toolchain", () => {
  const document = workflow("platform-decoder");
  verifyVersionPins(document, manifest, gitleaksVersion);
  const value = document.toJS();
  const pin = JSON.parse(
    readFileSync(
      new URL("../tools/platform-pin.json", import.meta.url),
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
  assert.deepEqual(steps[3], { run: "pnpm install --frozen-lockfile" });
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
    `rustfmt +${pin.rustToolchain} --check --edition 2024 tools/platform-adapter.rs`,
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

/**
 * Checks executable workflow pins against package metadata and scanner policy.
 * It checks both release-path and archive versions, without accepting duplicates.
 * @param {import("yaml").Document} document
 * @param {ToolMetadata} metadata
 * @param {string} scannerVersion
 */
function verifyVersionPins(document, metadata, scannerVersion) {
  assert.match(metadata.engines.node, /^\d+\.\d+\.\d+$/u);
  assert.match(metadata.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
  assert.match(scannerVersion, /^\d+\.\d+\.\d+$/u);
  const jobs = document.get("jobs");
  assert.ok(isMap(jobs));
  for (const entry of jobs.items) {
    assert.ok(isMap(entry.value));
    const steps = entry.value.get("steps");
    assert.ok(isSeq(steps));
    const values = steps.items.map((step) => {
      assert.ok(isMap(step));
      return step.toJSON();
    });
    const setup = values.filter(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/setup-node@"),
    );
    assert.equal(setup.length, 1);
    assert.deepEqual(setup[0], {
      uses: setupNode,
      with: { "node-version": metadata.engines.node },
    });
    const install = values.filter(
      (step) =>
        typeof step.run === "string" &&
        step.run.startsWith("npm install --global pnpm@"),
    );
    assert.equal(install.length, 1);
    assert.deepEqual(install[0], {
      run: installCommand(metadata.packageManager),
    });
    if (String(entry.key) !== "qualify") {
      const scanners = values.filter(
        (step) => step.name === "Install checksum-pinned Gitleaks",
      );
      assert.equal(scanners.length, 1);
      const urls = [
        ...scanners[0].run.matchAll(
          /https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v([0-9.]+)\/gitleaks_([0-9.]+)_linux_x64\.tar\.gz/gu,
        ),
      ];
      assert.equal(urls.length, 1);
      assert.equal(urls[0]?.[1], scannerVersion);
      assert.equal(urls[0]?.[2], scannerVersion);
    }
  }
}

test("all workflow runtime and package-manager pins follow package metadata", () => {
  for (const name of ["ci", "security-scheduled", "platform-decoder"]) {
    const document = workflow(name);
    verifyVersionPins(document, manifest, gitleaksVersion);
    for (const metadata of [
      { ...manifest, engines: { ...manifest.engines, node: "0.0.0" } },
      { ...manifest, packageManager: "pnpm@0.0.0" },
    ])
      assert.throws(
        () => verifyVersionPins(document, metadata, gitleaksVersion),
        { name: "AssertionError" },
      );
  }
});

test("scanner workflow release and archive pins follow one scanner definition", () => {
  assert.equal(typeof gitleaksVersion, "string");
  for (const name of ["ci", "security-scheduled"]) {
    const document = workflow(name);
    verifyVersionPins(document, manifest, gitleaksVersion);
    assert.throws(() => verifyVersionPins(document, manifest, "0.0.0"), {
      name: "AssertionError",
    });
  }
});

test("pin parity rejects independently changed workflow fields and scanner URLs", () => {
  for (const [name, job] of workflowJobs) {
    for (const field of ["node", "pnpm", "allow-scripts"]) {
      const document = workflow(name);
      if (field === "node")
        document.setIn(
          ["jobs", job, "steps", 1, "with", "node-version"],
          "0.0.0",
        );
      else {
        const path = ["jobs", job, "steps", 2, "run"];
        const command = document.getIn(path);
        assert.equal(typeof command, "string");
        const original =
          field === "pnpm"
            ? `--global ${manifest.packageManager}`
            : `--allow-scripts=${manifest.packageManager}`;
        const changed =
          field === "pnpm"
            ? "--global pnpm@0.0.0"
            : "--allow-scripts=pnpm@0.0.0";
        document.setIn(path, String(command).replace(original, changed));
      }
      assert.throws(
        () => verifyVersionPins(document, manifest, gitleaksVersion),
        { name: "AssertionError" },
      );
    }
  }
  for (const [name, job] of workflowJobs.filter(
    ([name]) => name !== "platform-decoder",
  )) {
    for (const field of ["release", "archive", "duplicate"]) {
      const document = workflow(name);
      const path = ["jobs", job, "steps", 4, "run"];
      const command = String(document.getIn(path));
      const changed =
        field === "release"
          ? command.replace(`/v${gitleaksVersion}/`, "/v0.0.0/")
          : field === "archive"
            ? command.replace(`gitleaks_${gitleaksVersion}_`, "gitleaks_0.0.0_")
            : `${command}\n# https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}/gitleaks_${gitleaksVersion}_linux_x64.tar.gz`;
      document.setIn(path, changed);
      assert.throws(
        () => verifyVersionPins(document, manifest, gitleaksVersion),
        { name: "AssertionError" },
      );
    }
  }
});
