import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { encodeCodec8 } from "./wire/codec8.ts";

const maxInput = 16 * 1024;

function readInput(path: string): unknown {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("invalid-input-file");
    if (stat.size > maxInput) throw new Error("input-too-large");
    const buffer = Buffer.alloc(maxInput + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > maxInput) throw new Error("input-too-large");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, offset),
        ),
      );
    } catch {
      throw new Error("invalid-json");
    }
  } finally {
    closeSync(fd);
  }
}

const inputErrors = new Set([
  "invalid-input-file",
  "input-too-large",
  "invalid-json",
  "invalid-record",
]);

export function run(
  args: string[],
  report: (category: string) => void,
): number {
  const [command, configFlag, input, outputFlag, output] = args;
  if (
    configFlag !== "--config" ||
    !input ||
    !(
      (command === "validate" && args.length === 3) ||
      (command === "encode" &&
        outputFlag === "--output" &&
        output &&
        args.length === 5)
    )
  ) {
    report("usage");
    return 2;
  }
  let frame: Buffer;
  try {
    frame = encodeCodec8(readInput(input));
  } catch (error) {
    report(
      error instanceof Error && inputErrors.has(error.message)
        ? error.message
        : "input-unavailable",
    );
    return 2;
  }
  if (command === "encode" && output) {
    try {
      writeFileSync(output, frame, { mode: 0o600, flag: "wx" });
    } catch {
      report("output-unavailable");
      return 2;
    }
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = run(process.argv.slice(2), (category) =>
    process.stderr.write(`${category}\n`),
  );
}
