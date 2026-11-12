import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reviewedPath } from "./diagnostic-location.mjs";

// Canonical scanner release; workflow tests bind both download version fields.
export const gitleaksVersion = "8.30.1";

const config = fileURLToPath(new URL("../.gitleaks.toml", import.meta.url));
const scanArgs = {
  worktree: ["dir"],
  index: ["git", "--staged"],
  history: ["git"],
};
const reviewedRules = new Set(["device-identity", "generic-api-key"]);

/**
 * Validates the diagnostic fields before accepting a scanner report.
 * The rest of the record is deliberately outside the output contract.
 *
 * @param {unknown} entry
 * @returns {entry is {RuleID: string, File: string, StartLine: number}}
 */
function isFinding(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    "RuleID" in entry &&
    typeof entry.RuleID === "string" &&
    entry.RuleID.length > 0 &&
    "File" in entry &&
    typeof entry.File === "string" &&
    entry.File.length > 0 &&
    "StartLine" in entry &&
    typeof entry.StartLine === "number" &&
    Number.isSafeInteger(entry.StartLine) &&
    entry.StartLine > 0
  );
}

/**
 * Reports only reviewed metadata from a bounded Gitleaks report. The raw
 * report is never written to disk or sent to the terminal.
 *
 * @param {keyof typeof scanArgs} phase
 * @param {string} [target]
 * @param {string} [binary]
 */
export function scan(phase, target = ".", binary = "gitleaks") {
  const result = spawnSync(
    binary,
    [
      ...scanArgs[phase],
      target,
      "--config",
      config,
      "--redact=100",
      "--exit-code=42",
      "--ignore-gitleaks-allow",
      "--report-format",
      "json",
      "--report-path",
      "-",
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 42)) {
    return `secret-scan-scanner-error phase=${phase}; Check the pinned Gitleaks binary and scan inputs.`;
  }

  const invalidReport = `secret-scan-report-error phase=${phase}; Check the pinned scanner and rerun the scan privately.`;
  try {
    const report = JSON.parse(result.stdout);
    if (!Array.isArray(report)) return invalidReport;
    if (result.status === 0)
      return report.length === 0 ? "clean" : invalidReport;
    if (!report.every(isFinding)) return invalidReport;
    const finding = report[0];
    if (!finding) return invalidReport;

    const rule = reviewedRules.has(finding.RuleID)
      ? finding.RuleID
      : "withheld";
    const path = reviewedPath(
      isAbsolute(finding.File)
        ? relative(resolve(target), finding.File)
        : finding.File,
    );
    const location =
      path && rule !== "withheld" ? `${path}:${finding.StartLine}` : "withheld";
    return `secret-scan-finding phase=${phase} rule=${rule} location=${location} count=${report.length}; Review the affected material locally.`;
  } catch {
    return invalidReport;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const version = spawnSync("gitleaks", ["version"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 5_000,
  });
  if (
    version.error ||
    version.status !== 0 ||
    version.stdout.trim() !== gitleaksVersion
  ) {
    process.stderr.write(
      "secret-scanner-version-error; Install the pinned Gitleaks version.\n",
    );
    process.exitCode = 1;
  } else {
    for (const phase of /** @type {const} */ ([
      "worktree",
      "index",
      "history",
    ])) {
      const result = scan(phase);
      if (result !== "clean") {
        process.stderr.write(`${result}\n`);
        process.exitCode = 1;
        break;
      }
    }
  }
}
