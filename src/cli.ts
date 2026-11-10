import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { type ConnectionPolicy, SessionError } from "./session/state.ts";
import { sendBatches } from "./session/tcp.ts";
import { encodeCodec8 } from "./wire/codec8.ts";

const maxInput = 16 * 1024;

function readInput(path: string, privateFile = false): unknown {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("invalid-input-file");
    if (
      privateFile &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    ) {
      throw new Error("invalid-identity-file");
    }
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

type RunConfig = {
  identityFile: string;
  deviceId: string;
  target?: { host: string; port: number };
  connectionPolicy?: ConnectionPolicy;
  retry?: {
    ackDeadlineMs?: number;
    totalDeadlineMs?: number;
    maxAttempts?: number;
  };
  record: unknown;
};

const integer = { type: "integer" };
const validRunConfig = new Ajv2020({ ownProperties: true }).compile<RunConfig>({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "identityFile", "deviceId", "record"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    identityFile: {
      type: "string",
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\\s\\S])",
    },
    deviceId: {
      type: "string",
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?![\\s\\S])",
    },
    record: { type: "object" },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["transport", "host", "port"],
      properties: {
        transport: { const: "tcp" },
        host: { enum: ["127.0.0.1", "::1"] },
        port: integer,
      },
    },
    connectionPolicy: { enum: ["single-batch", "persistent-compliant-peer"] },
    retry: {
      type: "object",
      additionalProperties: false,
      properties: {
        ackDeadlineMs: integer,
        totalDeadlineMs: integer,
        maxAttempts: integer,
      },
    },
  },
});

export async function runTcp(
  args: string[],
  report: (category: string) => void,
  signal: AbortSignal,
): Promise<number> {
  const [, flag, path] = args;
  if (flag !== "--config" || !path || args.length !== 3) {
    report("usage");
    return 2;
  }
  try {
    const config = readInput(path);
    if (!validRunConfig(config)) {
      report("invalid-run-config");
      return 2;
    }
    const frame = encodeCodec8(config.record);
    let identity: string;
    try {
      const identities = readInput(
        resolve(dirname(path), config.identityFile),
        true,
      );
      if (
        identities === null ||
        typeof identities !== "object" ||
        Array.isArray(identities) ||
        Object.keys(identities).length !== 1 ||
        !Object.hasOwn(identities, config.deviceId)
      )
        throw new Error();
      const value = (identities as Record<string, unknown>)[config.deviceId];
      if (
        typeof value !== "string" ||
        value.length !== 15 ||
        /[^0-9]/u.test(value)
      )
        throw new Error();
      identity = value;
    } catch {
      report("invalid-identity-file");
      return 2;
    }

    await sendBatches([frame], {
      ...(config.target ?? { host: "127.0.0.1", port: 55027 }),
      ...config.retry,
      connectionPolicy: config.connectionPolicy,
      identity,
      signal,
    });
    return 0;
  } catch (error) {
    if (error instanceof SessionError) {
      report(error.category);
      if (error.category === "cancelled") return 130;
      return error.category === "invalid-session" ? 2 : 3;
    }
    report(
      error instanceof Error && inputErrors.has(error.message)
        ? error.message
        : "input-unavailable",
    );
    return 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const report = (category: string) => process.stderr.write(`${category}\n`);
  if (args[0] === "run") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      process.exitCode = await runTcp(args, report, controller.signal);
      if (process.exitCode === 0) {
        process.stdout.write('{"status":"acknowledged","recordCount":1}\n');
      }
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  } else {
    process.exitCode = run(args, report);
  }
}
