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
import {
  type ConnectionPolicy,
  type DeliveryReceipt,
  defaultTarget,
  SessionError,
} from "./session/state.ts";
import { Codec8Frame, RecordError } from "./wire/codec8.ts";
import { encodeAvlRecord } from "./wire/codec8e.ts";

const maxInput = 16 * 1024;

type InputCategory =
  | "invalid-input-file"
  | "invalid-identity-file"
  | "input-too-large"
  | "invalid-json"
  | "input-unavailable"
  | "output-unavailable"
  | "invalid-run-config";

class InputError extends Error {
  readonly category: InputCategory;

  constructor(category: InputCategory) {
    super(category);
    this.category = category;
  }
}

// Only filesystem errno failures become input errors. Programming defects
// at the same boundary retain the internal-error classification.
function fileOperation<A>(operation: () => A, category: InputCategory): A {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof Error &&
      "errno" in error &&
      typeof error.errno === "number" &&
      "syscall" in error &&
      typeof error.syscall === "string"
    ) {
      throw new InputError(category);
    }
    throw error;
  }
}

function reportFailure(
  error: unknown,
  report: (category: string) => void,
): number {
  if (error instanceof InputError) {
    report(error.category);
    return 2;
  }
  if (error instanceof RecordError) {
    report("invalid-record");
    return 2;
  }
  if (error instanceof SessionError) {
    report(error.category);
    if (error.category === "cancelled") return 130;
    return error.category === "invalid-session" ? 2 : 3;
  }
  report("internal-error");
  return 1;
}

function readInput(path: string, privateFile = false): unknown {
  const fd = fileOperation(
    () =>
      openSync(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      ),
    "input-unavailable",
  );
  try {
    const stat = fileOperation(() => fstatSync(fd), "input-unavailable");
    if (!stat.isFile()) throw new InputError("invalid-input-file");
    if (
      privateFile &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    ) {
      throw new InputError("invalid-identity-file");
    }
    if (stat.size > maxInput) throw new InputError("input-too-large");
    const buffer = Buffer.alloc(maxInput + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fileOperation(
        () => readSync(fd, buffer, offset, buffer.length - offset, null),
        "input-unavailable",
      );
      if (read === 0) break;
      offset += read;
    }
    if (offset > maxInput) throw new InputError("input-too-large");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, offset),
        ),
      );
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof TypeError &&
          "code" in error &&
          error.code === "ERR_ENCODING_INVALID_ENCODED_DATA")
      ) {
        throw new InputError("invalid-json");
      }
      throw error;
    }
  } finally {
    fileOperation(() => closeSync(fd), "input-unavailable");
  }
}

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
    frame = encodeAvlRecord(readInput(input));
  } catch (error) {
    return reportFailure(error, report);
  }
  if (command === "encode" && output) {
    try {
      fileOperation(
        () => writeFileSync(output, frame, { mode: 0o600, flag: "wx" }),
        "output-unavailable",
      );
    } catch (error) {
      return reportFailure(error, report);
    }
  }
  return 0;
}

export type RunConfig = {
  schemaVersion: 1;
  identityFile: string;
  deviceId: string;
  target?: { transport: "tcp"; host: "127.0.0.1" | "::1"; port: number };
  connectionPolicy?: ConnectionPolicy;
  retry?: {
    ackDeadlineMs?: number;
    totalDeadlineMs?: number;
    maxAttempts?: number;
  };
  record: Record<string, unknown>;
};

const integer = { type: "integer" };
export const runConfigSchema = {
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
        host: { enum: ["127.0.0.1", "::1", "tcp-ingestion"] },
        port: integer,
      } satisfies Record<keyof NonNullable<RunConfig["target"]>, object>,
    },
    connectionPolicy: { enum: ["single-batch", "persistent-compliant-peer"] },
    retry: {
      type: "object",
      additionalProperties: false,
      properties: {
        ackDeadlineMs: integer,
        totalDeadlineMs: integer,
        maxAttempts: integer,
      } satisfies Record<keyof NonNullable<RunConfig["retry"]>, object>,
    },
  } satisfies Record<keyof RunConfig, object>,
};

const validRunConfig = new Ajv2020({ ownProperties: true }).compile<RunConfig>(
  runConfigSchema,
);

export async function runTcp(
  args: string[],
  report: (category: string) => void,
  signal: AbortSignal,
  acknowledge: (receipt: DeliveryReceipt) => void = () => {},
): Promise<number> {
  const [, flag, path] = args;
  if (flag !== "--config" || !path || args.length !== 3) {
    report("usage");
    return 2;
  }
  try {
    const config = readInput(path);
    if (!validRunConfig(config)) {
      throw new InputError("invalid-run-config");
    }
    const bytes = encodeAvlRecord(config.record);
    const frame =
      bytes[8] === 0x8e
        ? Codec8Frame.fromExtendedBytes(bytes)
        : Codec8Frame.fromBytes(bytes);
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
        throw new InputError("invalid-identity-file");
      const value = (identities as Record<string, unknown>)[config.deviceId];
      if (
        typeof value !== "string" ||
        value.length !== 15 ||
        /[^0-9]/u.test(value)
      )
        throw new InputError("invalid-identity-file");
      identity = value;
    } catch (error) {
      if (error instanceof InputError)
        throw new InputError("invalid-identity-file");
      throw error;
    }

    const { sendBatches } = await import("./transport/tcp.ts");
    const receipt = await sendBatches([frame], {
      host: config.target?.host ?? defaultTarget.host,
      port: config.target?.port ?? defaultTarget.port,
      ...config.retry,
      connectionPolicy: config.connectionPolicy,
      identity,
      signal,
    });
    acknowledge(receipt);
    return 0;
  } catch (error) {
    return reportFailure(error, report);
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
      process.exitCode = await runTcp(
        args,
        report,
        controller.signal,
        (receipt) =>
          process.stdout.write(
            `${JSON.stringify({ status: receipt.status, recordCount: receipt.recordCount })}\n`,
          ),
      );
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  } else {
    process.exitCode = run(args, report);
  }
}
