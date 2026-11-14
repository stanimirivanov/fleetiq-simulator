import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @typedef {{name: string, tests: string[], sources: string[], lines: number, branches: number}} CoverageGroup */

/** @type {CoverageGroup[]} */
export const groups = [
  {
    name: "wire",
    tests: [
      "tests/codec8.test.ts",
      "tests/codec8-oracle.test.ts",
      "tests/codec8e.test.ts",
      "tests/codec16.test.ts",
      "tests/codec12.test.ts",
      "tests/udp.test.ts",
    ],
    sources: [
      "src/wire/codec8.ts",
      "src/wire/codec8e.ts",
      "src/wire/codec16.ts",
      "src/wire/codec12.ts",
      "src/wire/udp.ts",
    ],
    lines: 90,
    branches: 85,
  },
  {
    name: "scenarios",
    tests: [
      "tests/route.test.ts",
      "tests/capture.test.ts",
      "tests/faults.test.ts",
      "tests/fleet.test.ts",
    ],
    sources: [
      "src/scenarios/route.ts",
      "src/scenarios/profile.ts",
      "src/scenarios/capture.ts",
      "src/scenarios/clock.ts",
      "src/scenarios/faults.ts",
      "src/scenarios/fleet.ts",
    ],
    lines: 90,
    branches: 85,
  },
  {
    name: "session",
    tests: [
      "tests/tcp.test.ts",
      "tests/command.test.ts",
      "tests/batches.test.ts",
      "tests/spool.test.ts",
      "tests/fault-tcp.test.ts",
      "tests/fleet-tcp.test.ts",
      "tests/udp-transport.test.ts",
    ],
    sources: [
      "src/session/state.ts",
      "src/session/command.ts",
      "src/transport/tcp.ts",
      "src/transport/fleet.ts",
      "src/transport/udp.ts",
      "src/session/batches.ts",
      "src/session/spool.ts",
    ],
    lines: 90,
    branches: 85,
  },
  {
    name: "telemetry",
    tests: ["tests/telemetry.test.ts"],
    sources: ["src/telemetry.ts"],
    lines: 90,
    branches: 85,
  },
  {
    name: "storage",
    tests: ["tests/storage.test.ts"],
    sources: ["src/storage/spool.ts"],
    lines: 90,
    branches: 85,
  },
  {
    name: "cli",
    tests: [
      "tests/cli/offline-encoding.test.ts",
      "tests/cli/configuration.test.ts",
      "tests/cli/identity-boundary.test.ts",
      "tests/cli/failure-reporting.test.ts",
      "tests/cli/delivery-receipts.test.ts",
      "tests/cli/playback-recovery.test.ts",
      "tests/cli/process-interruption.test.ts",
      "tests/cli/faults.test.ts",
      "tests/cli/fleet.test.ts",
      "tests/cli/udp.test.ts",
      "tests/cli/command-fixture.test.ts",
    ],
    sources: ["src/cli.ts"],
    lines: 80,
    branches: 0,
  },
  {
    name: "packaging",
    tests: ["tests/packaging/image-deps.test.mjs"],
    sources: ["packaging/image-deps.mjs"],
    lines: 90,
    branches: 85,
  },
  {
    name: "tooling",
    tests: [
      "harness/tests/architecture.test.mjs",
      "harness/tests/harness-boundary.test.mjs",
      "harness/tests/comments.test.mjs",
      "harness/tests/coverage.test.mjs",
      "harness/tests/fleet-bounds.test.mjs",
      "harness/tests/floor.test.mjs",
      "harness/tests/floor-relocation.test.mjs",
      "harness/tests/image.test.mjs",
      "harness/tests/image-publish.test.mjs",
      "harness/tests/platform-decoder.test.mjs",
      "harness/tests/quality.test.mjs",
      "harness/tests/transport-load.test.mjs",
      "harness/tests/typecheck.test.mjs",
      "harness/tests/workflows.test.mjs",
    ],
    sources: [],
    lines: 0,
    branches: 0,
  },
];

/**
 * Refuses omitted or duplicated suites and production files before execution.
 * Exact inventories keep unloaded sources from disappearing from the denominator.
 *
 * @param {CoverageGroup[]} plan
 * @param {string[]} tests
 * @param {string[]} sources
 */
export function checkInventory(plan, tests, sources) {
  const registeredTests = plan.flatMap((group) => group.tests);
  const registeredSources = plan.flatMap((group) => group.sources);
  const problems = [];
  if (new Set(plan.map((group) => group.name)).size !== plan.length)
    problems.push("duplicate-group");
  if (new Set(registeredTests).size !== registeredTests.length)
    problems.push("duplicate-suite");
  if (new Set(registeredSources).size !== registeredSources.length)
    problems.push("duplicate-source");
  if (
    JSON.stringify([...new Set(registeredTests)].sort()) !==
    JSON.stringify([...tests].sort())
  )
    problems.push("test-inventory");
  if (
    JSON.stringify([...new Set(registeredSources)].sort()) !==
    JSON.stringify([...sources].sort())
  )
    problems.push("source-inventory");
  return problems;
}

/**
 * Lists regular files recursively so new nested suites cannot escape discovery.
 * Unexpected filesystem entries fail the inventory rather than being ignored.
 *
 * @param {string} directory
 * @param {string} [prefix]
 * @returns {string[]}
 */
function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.isDirectory())
      return listFiles(join(directory, entry.name), `${path}/`);
    if (!entry.isFile()) throw new Error("invalid-inventory-entry");
    return [path];
  });
}

/**
 * Runs one disjoint group through Node's native test runner. Coverage comes from
 * structured events, including inherited child-process coverage. The expected
 * source list is checked separately from the native percentage thresholds.
 *
 * @param {CoverageGroup} group
 * @param {string} [root]
 */
export async function runGroup(group, root = process.cwd()) {
  for (const path of [...group.tests, ...group.sources]) {
    if (!lstatSync(resolve(root, path)).isFile())
      throw new Error("missing-group-input");
  }
  const stream = run({
    cwd: root,
    execArgv: [],
    files: group.tests,
    coverage: group.sources.length > 0,
    coverageIncludeGlobs: group.sources,
    lineCoverage: group.lines,
    branchCoverage: group.branches,
  });
  let failed = false;

  /** @type {import("node:test").test.EventData.TestCoverage["summary"] | undefined} */
  let summary;
  stream.on("test:fail", () => {
    failed = true;
  });
  stream.on("test:coverage", (event) => {
    summary = event.summary;
  });
  const reporter = stream.compose(spec);
  reporter.pipe(process.stdout);
  await finished(reporter);
  if (group.sources.length > 0) {
    if (
      !summary ||
      JSON.stringify(
        summary.files.map((file) => relative(root, file.path)).sort(),
      ) !== JSON.stringify([...group.sources].sort())
    ) {
      process.stderr.write(
        `coverage-inventory group=${group.name}; Restore the expected source coverage.\n`,
      );
      return 1;
    }
    const totals = summary.totals;
    process.stdout.write(
      `coverage-group ${group.name} lines=${totals.coveredLineCount}/${totals.totalLineCount} branches=${totals.coveredBranchCount}/${totals.totalBranchCount}\n`,
    );
    if (
      totals.totalLineCount === 0 ||
      totals.coveredLinePercent < group.lines ||
      totals.coveredBranchPercent < group.branches
    ) {
      process.stderr.write(
        `coverage-threshold group=${group.name}; Add tests for the uncovered behavior.\n`,
      );
      return 1;
    }
  }
  return failed ? 1 : 0;
}

/**
 * Starts each group in a fresh process so its coverage cannot be pooled with
 * another group's result. Test-runner context is cleared for nested canaries.
 */
function main() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const tests = [
    ...listFiles(join(root, "tests"), "tests/"),
    ...listFiles(join(root, "harness/tests"), "harness/tests/"),
  ].filter((file) => /\.test\.(ts|mjs)$/u.test(file));
  const sources = [
    ...listFiles(join(root, "src"), "src/").filter((file) =>
      file.endsWith(".ts"),
    ),
    ...listFiles(join(root, "packaging"), "packaging/").filter((file) =>
      file.endsWith(".mjs"),
    ),
  ];
  const problems = checkInventory(groups, tests, sources);
  if (problems.length) {
    process.stderr.write(
      `${problems.join("\n")}; Update the coverage group inventory.\n`,
    );
    return 1;
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const group of groups) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), group.name],
      {
        cwd: root,
        env,
        stdio: "inherit",
        timeout: 120_000,
      },
    );
    if (result.status !== 0) return 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const name = process.argv[2];
    const group = groups.find((candidate) => candidate.name === name);
    if (name && !group) throw new Error("unknown-group");
    process.exitCode = group ? await runGroup(group) : main();
  } catch {
    process.stderr.write(
      "coverage-runner-error; Check the group inputs and pinned Node runtime.\n",
    );
    process.exitCode = 1;
  }
}
