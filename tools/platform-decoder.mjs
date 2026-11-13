import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPlayback } from "../src/scenarios/route.ts";
import { encodeCodec8 } from "../src/wire/codec8.ts";
import { encodeCodec8e } from "../src/wire/codec8e.ts";
import { generatedCorpus } from "../tests/codec8-corpus.ts";
import { singleRecordVectors } from "../tests/codec8-vectors.ts";
import { extended, variableRecord } from "../tests/codec8e-fixture.ts";

/** @type {{repository: string, revision: string, rustToolchain: string}} */
export const pin = JSON.parse(
  readFileSync(new URL("./platform-pin.json", import.meta.url), "utf8"),
);

/** Runs bounded tools and hides raw compiler, Git and decoder output on failure.
 * @param {string} binary @param {string[]} args @param {string} stage
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} [options]
 */
export function runCommand(
  binary,
  args,
  stage,
  options = { encoding: "utf8" },
) {
  const result = spawnSync(binary, args, {
    timeout: 60_000,
    maxBuffer: 2_000_000,
    ...options,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw new Error(`platform-${stage}-failed`);
  return result.stdout;
}

/** Verifies the whole checkout before trusting its source or toolchain file.
 * Untracked source changes also fail; ignored build output is not compiled.
 * @param {string} root
 */
export function verifyCheckout(root) {
  try {
    if (
      pin.repository !== "stanimirivanov/fleetiq-platform" ||
      !/^[a-f0-9]{40}$/u.test(pin.revision) ||
      pin.rustToolchain !== "1.99.1"
    )
      throw new Error("invalid-pin");
    const git = (/** @type {string[]} */ args) =>
      runCommand("git", ["-C", root, ...args], "checkout").trim();
    if (
      git(["rev-parse", "HEAD"]) !== pin.revision ||
      git(["rev-parse", "--show-toplevel"]) !== realpathSync(root) ||
      git(["status", "--porcelain", "--untracked-files=all"]) !== ""
    )
      throw new Error("wrong-checkout");
    if (
      !new RegExp(
        `^channel = "${pin.rustToolchain.replaceAll(".", "\\.")}"$`,
        "m",
      ).test(readFileSync(join(root, "rust-toolchain.toml"), "utf8"))
    )
      throw new Error("wrong-toolchain");
  } catch {
    throw new Error("platform-checkout-failed");
  }
}

/** Serializes every transmitted field without converting u64 timestamps to Number.
 * The platform's narrower profile is asserted as an exact rejection, not skipped.
 * @param {Omit<import("../src/wire/codec8.ts").Record8, "schemaVersion">} record
 * @param {number} [codec]
 * @param {{id: number, hex: string}[]} [variableIo]
 */
function expectedLine(record, codec = 8, variableIo = []) {
  if (
    BigInt(record.timestampMs) > 9223372036854775807n ||
    new Set(record.io.map((value) => value.id)).size !== record.io.length
  )
    return "reject:1";
  const io = [
    ...[...record.io].sort((a, b) => a.hex.length - b.hex.length),
    ...variableIo,
  ]
    .map((value) => `${value.id}:${value.hex.toLowerCase()}`)
    .join(",");
  return [
    "ok",
    codec,
    1,
    record.timestampMs,
    record.priority,
    record.longitudeE7,
    record.latitudeE7,
    record.altitude,
    record.angle,
    record.satellites,
    record.speed,
    record.eventId,
    io,
  ].join("\t");
}

/** Retains the H9 corpus and profile boundary controls, adding real scenario-produced records. */
export function platformCases() {
  const vectors = singleRecordVectors.map((value) => ({
    hex: encodeCodec8(value.record).toString("hex"),
    expected: expectedLine(value.record),
  }));
  const generated = generatedCorpus().map(({ record }) => ({
    hex: encodeCodec8(record).toString("hex"),
    expected: expectedLine(record),
  }));
  const base = singleRecordVectors[0];
  if (!base) throw new Error("platform-corpus-missing");
  const boundaries = [
    { ...base.record, timestampMs: "9223372036854775807" },
    { ...base.record, timestampMs: "9223372036854775808" },
    {
      ...base.record,
      io: [
        { id: 1, hex: "01" },
        { id: 1, hex: "0203" },
      ],
    },
  ].map((record) => ({
    hex: encodeCodec8(record).toString("hex"),
    expected: expectedLine(record),
  }));
  const corrupted = Buffer.from(base.frame, "hex");
  corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 1;
  const playback = createPlayback(
    {
      type: "LineString",
      coordinates: [
        [-0.01, 0],
        [0.01, 0],
      ],
    },
    JSON.parse(
      readFileSync(
        new URL("../scenarios/normal-day.json", import.meta.url),
        "utf8",
      ),
    ),
    JSON.parse(
      readFileSync(
        new URL("../profiles/fmb920-docs-v1.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const routeRecords = [0, 30000, 60000, 90000, 100000, 160000].map((at) =>
    playback.sample(at),
  );
  return [
    ...[
      ...routeRecords,
      extended,
      variableRecord,
      { ...variableRecord, variableIo: [{ id: 65535, hex: "00" }] },
      { ...extended, io: [], variableIo: [] },
      {
        ...variableRecord,
        timestampMs: "9223372036854775807",
        variableIo: [{ id: 65535, hex: "00".repeat(256) }],
      },
      {
        ...extended,
        io: Array.from({ length: 64 }, (_, id) => ({
          id: id + 256,
          hex: "01",
        })),
        variableIo: [],
      },
      { ...extended, timestampMs: "18446744073709551615" },
    ].map((record) => ({
      hex: encodeCodec8e(record).toString("hex"),
      expected: expectedLine(record, 0x8e, record.variableIo),
    })),
    ...vectors,
    ...generated,
    ...boundaries,
    { hex: corrupted.toString("hex"), expected: "reject:4" },
  ];
}

/** Requires an exact ordered result for every input, including final newline.
 * No coercion, partial output or extra diagnostics can count as success.
 * @param {{expected: string}[]} cases @param {string} output
 */
export function checkOutput(cases, output) {
  if (output !== `${cases.map((entry) => entry.expected).join("\n")}\n`)
    throw new Error("platform-output-mismatch");
}

/** Builds only the std-only native crate from verified source, then its adapter.
 * Artifacts are test-owned and removed on success and failure.
 * @param {string} checkout
 */
export function qualify(checkout) {
  verifyCheckout(checkout);
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-platform-decoder-"));
  try {
    const toolchain = `+${pin.rustToolchain}`;
    const rust = runCommand("rustc", [toolchain, "--version"], "toolchain");
    if (!rust.startsWith(`rustc ${pin.rustToolchain} `))
      throw new Error("platform-toolchain-failed");
    const library = join(directory, "libfleetiq_teltonika.rlib");
    const binary = join(directory, "platform-adapter");
    runCommand(
      "rustc",
      [
        toolchain,
        "--edition=2024",
        "-Dwarnings",
        "--crate-name",
        "fleetiq_teltonika",
        "--crate-type=rlib",
        join(checkout, "packages/teltonika/src/lib.rs"),
        "-o",
        library,
      ],
      "build",
    );
    runCommand(
      "rustc",
      [
        toolchain,
        "--edition=2024",
        "-Dwarnings",
        fileURLToPath(new URL("./platform-adapter.rs", import.meta.url)),
        "--extern",
        `fleetiq_teltonika=${library}`,
        "-o",
        binary,
      ],
      "build",
    );
    const cases = platformCases();
    const output = runCommand(binary, [], "decode", {
      encoding: "utf8",
      input: `${cases.map((entry) => entry.hex).join("\n")}\n`,
      timeout: 10_000,
    });
    checkOutput(cases, output);
    let rejected = false;
    try {
      checkOutput(
        [{ ...cases[0], expected: "deliberate-mismatch" }, ...cases.slice(1)],
        output,
      );
    } catch (error) {
      if (
        !(
          error instanceof Error && error.message === "platform-output-mismatch"
        )
      )
        throw error;
      rejected = true;
    }
    if (!rejected) throw new Error("platform-negative-control-failed");
    const accepted = cases.filter((entry) =>
      entry.expected.startsWith("ok\t"),
    ).length;
    return { total: cases.length, accepted, rejected: cases.length - accepted };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!process.argv[2]) throw new Error("platform-checkout-required");
    const result = qualify(resolve(process.argv[2]));
    console.log(
      `Platform decoder qualified ${result.total} cases (${result.accepted} accepted, ${result.rejected} expected rejections) at ${pin.revision} with Rust ${pin.rustToolchain}; mismatch control rejected.`,
    );
  } catch (error) {
    const recovery = new Map([
      [
        "platform-checkout-required",
        "Pass the path to a separately fetched pinned platform checkout.",
      ],
      [
        "platform-checkout-failed",
        "Fetch the configured revision and restore a clean checkout with its pinned toolchain file.",
      ],
      [
        "platform-toolchain-failed",
        "Install the exact Rust toolchain from tools/platform-pin.json.",
      ],
      [
        "platform-build-failed",
        "Inspect the native library and adapter compilation privately using the pinned Rust toolchain.",
      ],
      [
        "platform-decode-failed",
        "Inspect adapter execution, bounded input and runtime availability privately.",
      ],
      [
        "platform-output-mismatch",
        "Reproduce the pinned corpus and inspect decoded fields and raw IO privately.",
      ],
    ]);
    const category =
      error instanceof Error && recovery.has(error.message)
        ? error.message
        : "platform-internal-failure";
    console.error(
      `${category}; ${recovery.get(category) ?? "Reproduce with a qualification fixture before changing policy."}`,
    );
    process.exitCode = 1;
  }
}
