import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const config = fileURLToPath(new URL("../.gitleaks.toml", import.meta.url));

/** @param {readonly string[]} args */
export function scan(args, binary = "gitleaks") {
  const result = spawnSync(
    binary,
    [
      ...args,
      "--config",
      config,
      "--redact=100",
      "--exit-code=42",
      "--ignore-gitleaks-allow",
    ],
    { stdio: "ignore", timeout: 60_000 },
  );
  if (result.status === 0) return "clean";
  return result.status === 42 ? "finding" : "scanner-error";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const version = spawnSync("gitleaks", ["version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (version.status !== 0 || version.stdout.trim() !== "8.30.1") {
    process.stderr.write("secret-scanner-version-error\n");
    process.exitCode = 1;
  } else {
    for (const args of [
      ["dir", "."],
      ["git", "--staged", "."],
      ["git", "."],
    ]) {
      const result = scan(args);
      if (result !== "clean") {
        process.stderr.write(`secret-scan-${result}\n`);
        process.exitCode = 1;
        break;
      }
    }
  }
}
