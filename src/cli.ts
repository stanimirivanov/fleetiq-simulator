import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { capture } from "./scenarios/capture.ts";
import { ProfileError } from "./scenarios/profile.ts";
import { createPlayback, ScenarioError } from "./scenarios/route.ts";
import { BatchQueue } from "./session/batches.ts";
import { DurableSpool, SpoolError } from "./session/spool.ts";
import {
  type ConnectionPolicy,
  type DeliveryReceipt,
  defaultTarget,
  SessionError,
  sessionLimits,
} from "./session/state.ts";
import { Codec8Frame, RecordError } from "./wire/codec8.ts";
import { encodeAvlRecord, encodeCodec8e } from "./wire/codec8e.ts";

const maxInput = 16 * 1024;

/**
 * Reviewed file/config failure categories; output must never include input contents or paths.
 */
type InputCategory =
  | "invalid-input-file"
  | "invalid-identity-file"
  | "input-too-large"
  | "invalid-json"
  | "input-unavailable"
  | "output-unavailable"
  | "invalid-run-config";

/**
 * Expected input failure distinct from programming defects and session errors.
 */
class InputError extends Error {
  readonly category: InputCategory;

  /** Stores only the fixed output category, without retaining an underlying private error. */
  constructor(category: InputCategory) {
    super(category);
    this.category = category;
  }
}

/**
 * Maps only filesystem errno failures to the supplied fixed input category.
 * Programming defects at the same boundary propagate for internal-error classification.
 */
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

/**
 * Emits only a reviewed category and maps expected input/session failures to CLI exit codes.
 * Unexpected defects report internal-error (1); invalid input is 2, session failure
 * is 3 and cancellation is 130. Never serializes arbitrary Error messages.
 */
function reportFailure(
  error: unknown,
  report: (category: string) => void,
): number {
  if (error instanceof InputError) {
    report(error.category);
    return 2;
  }
  if (error instanceof SpoolError) {
    report(error.category);
    return 4;
  }
  if (error instanceof ScenarioError) {
    report("invalid-scenario");
    return 2;
  }
  if (error instanceof ProfileError) {
    report("invalid-profile");
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

/**
 * Reads bounded strict UTF-8 JSON from a regular, non-symlink file (16 KiB by default).
 * Private identity files additionally require current-user ownership and no group/other
 * permissions. Always attempts descriptor cleanup; expected file/JSON failures
 * become InputError while programming defects propagate.
 */
function readInput(
  path: string,
  privateFile: boolean | "spool" = false,
  limit = maxInput,
): unknown {
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
      ((stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        (privateFile === "spool" && stat.nlink !== 1))
    ) {
      throw new InputError("invalid-identity-file");
    }
    if (stat.size > limit) throw new InputError("input-too-large");
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fileOperation(
        () => readSync(fd, buffer, offset, buffer.length - offset, null),
        "input-unavailable",
      );
      if (read === 0) break;
      offset += read;
    }
    if (offset > limit) throw new InputError("input-too-large");
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

/**
 * Runs offline validate/encode without loading transport or sending network traffic.
 * Encoding exclusively creates a mode-0600 output file; success is silent. Reports
 * fixed failure categories through report and returns the corresponding CLI exit code.
 */
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
    const value = readInput(input);
    if (command === "validate" && validPlaybackConfig(value)) {
      const pinned = openPlaybackRoot(input, value);
      try {
        readIdentity(value, pinned.root, true);
        loadPlayback(value, pinned.root);
        return 0;
      } finally {
        pinned.close();
      }
    }
    frame = encodeAvlRecord(value);
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

/**
 * Version-1 file layout for one authorized device and one record.
 * The identity filename is resolved beside the config; record validation belongs
 * to wire, while target/retry admission belongs to session and transport.
 */
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

/**
 * Closed run-file schema; wire validates record contents and session validates numeric ranges.
 * Identity paths are restricted to a sibling filename before any private file is opened.
 */
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

/** Accelerated playback inputs are sibling private files; queue state lives in a dedicated directory. */
export type PlaybackRunConfig = Omit<RunConfig, "record"> & {
  playback: {
    routeFile: string;
    scenarioFile: string;
    profileFile: string;
    stateDirectory: string;
    intervalMs: number;
    sendIntervalMs: number;
    on: ("ignition" | "movement" | "stop")[];
    offlineUntilMs: number;
    timingProfile: "accelerated";
    maxRecords: number;
    maxFrameBytes: number;
    maxQueuedRecords: number;
    maxQueuedBytes: number;
    maxAgeMs: number;
  };
};
const { record: _record, ...commonRunProperties } = runConfigSchema.properties;
const filename = runConfigSchema.properties.identityFile;
const playbackKeys = [
  "routeFile",
  "scenarioFile",
  "profileFile",
  "stateDirectory",
  "intervalMs",
  "sendIntervalMs",
  "on",
  "offlineUntilMs",
  "timingProfile",
  "maxRecords",
  "maxFrameBytes",
  "maxQueuedRecords",
  "maxQueuedBytes",
  "maxAgeMs",
];
const validPlaybackConfig = new Ajv2020({
  ownProperties: true,
}).compile<PlaybackRunConfig>({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "identityFile", "deviceId", "playback"],
  properties: {
    ...commonRunProperties,
    playback: {
      type: "object",
      additionalProperties: false,
      required: playbackKeys,
      properties: {
        routeFile: filename,
        scenarioFile: filename,
        profileFile: filename,
        stateDirectory: filename,
        intervalMs: integer,
        sendIntervalMs: integer,
        on: {
          type: "array",
          maxItems: 3,
          uniqueItems: true,
          items: { enum: ["ignition", "movement", "stop"] },
        },
        offlineUntilMs: integer,
        timingProfile: { const: "accelerated" },
        maxRecords: integer,
        maxFrameBytes: integer,
        maxQueuedRecords: integer,
        maxQueuedBytes: integer,
        maxAgeMs: integer,
      },
    },
  },
});

/** Selects a validated mode and preserves legacy record-before-identity validation order. */
function selectRun(value: unknown) {
  if (validRunConfig(value)) {
    const bytes = encodeAvlRecord(value.record);
    return {
      kind: "record" as const,
      config: value,
      frame:
        bytes[8] === 0x8e
          ? Codec8Frame.fromExtendedBytes(bytes)
          : Codec8Frame.fromBytes(bytes),
    };
  }
  if (validPlaybackConfig(value))
    return { kind: "playback" as const, config: value };
  throw new InputError("invalid-run-config");
}

/** Hashes normalized JSON inputs; only digests enter private checkpoint binding, never public receipts. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Pins and verifies one private input directory so later sibling reads cannot follow a replaced parent. */
function openPlaybackRoot(path: string, config: PlaybackRunConfig) {
  const fd = fileOperation(
    () =>
      openSync(
        dirname(resolve(path)),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
    "input-unavailable",
  );
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
      throw new InputError("invalid-input-file");
    const root = `/proc/self/fd/${fd}`;
    if (
      digest(readInput(resolve(root, basename(path)), "spool")) !==
      digest(config)
    )
      throw new InputError("invalid-run-config");
    return { root, close: () => closeSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Reads one private device identity and preserves fixed-category classification for expected file failures. */
function readIdentity(
  config: Pick<RunConfig, "identityFile" | "deviceId">,
  root: string,
  strict = false,
): string {
  try {
    const identities = readInput(
      resolve(root, config.identityFile),
      strict ? "spool" : true,
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
    return value;
  } catch (error) {
    if (error instanceof InputError)
      throw new InputError("invalid-identity-file");
    throw error;
  }
}

/** Validates private playback inputs and queue policy without creating state or loading transport. */
function loadPlayback(config: PlaybackRunConfig, root: string) {
  const p = config.playback;
  const scenario = readInput(
    resolve(root, p.scenarioFile),
    "spool",
    1024 * 1024,
  );
  const route = readInput(resolve(root, p.routeFile), "spool", 8 * 1024 * 1024);
  const profile = readInput(resolve(root, p.profileFile), "spool");
  const playback = createPlayback(route, scenario, profile);
  if (
    !Number.isSafeInteger(p.offlineUntilMs) ||
    p.offlineUntilMs < 0 ||
    p.offlineUntilMs > playback.durationMs
  )
    throw new InputError("invalid-run-config");
  const work = [
    ...capture(playback, {
      intervalMs: p.intervalMs,
      sendIntervalMs: p.sendIntervalMs,
      on: p.on,
    }),
  ].map((tick) => ({
    atMs: tick.atMs,
    frame:
      tick.type === "capture"
        ? Codec8Frame.fromExtendedBytes(encodeCodec8e(tick.record))
        : null,
  }));
  new BatchQueue(p);
  if (
    !Number.isSafeInteger(p.maxAgeMs) ||
    p.maxAgeMs < 1 ||
    p.maxAgeMs > 604800000 ||
    p.maxQueuedBytes < 4096
  )
    throw new InputError("invalid-run-config");
  return { work, scenario, route, profile };
}

/**
 * Runs bounded accelerated capture with durable-before-send and ACK-before-removal ordering.
 * Reconstructs the same schedule on resume and keeps real session deadlines separate.
 * Expected network outages retain capture; unexpected defects and storage failures stop the run.
 */
async function runPlayback(
  config: PlaybackRunConfig,
  root: string,
  identity: string,
  resume: boolean,
  signal: AbortSignal,
  perform: typeof import("./transport/tcp.ts").sendBatches,
  acknowledge: (receipt: DeliveryReceipt) => void,
): Promise<number> {
  const p = config.playback;
  const { work, scenario, route, profile } = loadPlayback(config, root);
  const binding = {
    config: digest(config),
    scenario: digest(scenario),
    route: digest(route),
    profile: digest(profile),
    identity: digest(identity),
    schedule: digest(
      work.map((item) => ({
        atMs: item.atMs,
        hex: item.frame?.snapshot().bytes.toString("hex") ?? null,
      })),
    ),
  };
  const options = {
    host: config.target?.host ?? defaultTarget.host,
    port: config.target?.port ?? defaultTarget.port,
    ...config.retry,
    connectionPolicy: config.connectionPolicy,
    identity,
    signal,
  };
  const budget = sessionLimits(options);
  const { FileStore } = await import("./storage/spool.ts");
  const store = new FileStore(resolve(root, p.stateDirectory));
  try {
    const spool = new DurableSpool(store, binding, work, p, resume);
    let last: SessionError | undefined;
    let blocked = false;

    /** A failing count/refusal blocks further sends this run; ordinary outage may retry at the next send tick. */
    async function drain(): Promise<void> {
      for (let frame = spool.prepare(); frame; frame = spool.prepare()) {
        try {
          await perform([frame], {
            ...options,
            totalDeadlineMs: Math.ceil(budget.remaining()),
          });
          spool.acknowledge(frame);
        } catch (error) {
          if (
            !(error instanceof SessionError) ||
            error.category === "cancelled" ||
            error.category === "run-timeout" ||
            error.category === "invalid-session"
          )
            throw error;
          last = error;
          blocked = ["login-refused", "ack-count", "unexpected-reply"].includes(
            error.category,
          );
          return;
        }
      }
    }

    try {
      if (resume && spool.stats.atMs >= p.offlineUntilMs) await drain();
      while (spool.stats.cursor < work.length) {
        if (signal.aborted) throw new SessionError("cancelled");
        budget.remaining();
        const send = spool.advance();
        if (send && spool.stats.atMs >= p.offlineUntilMs && !blocked)
          await drain();
        await new Promise<void>((done) => setImmediate(done));
      }
      if (signal.aborted) throw new SessionError("cancelled");
      if (spool.stats.queued)
        throw last ?? new SessionError("connection-closed");
      acknowledge({
        status: "acknowledged",
        recordCount: spool.stats.acknowledged,
      });
      return 0;
    } catch (error) {
      if (error instanceof SessionError && error.category === "cancelled")
        spool.cancel();
      throw error;
    }
  } finally {
    store.close();
  }
}

/**
 * Validates run config, record and private identity before lazily loading transport.
 * Preserves the legacy single-record mode or runs durable accelerated playback.
 * Calls acknowledge only
 * after a matching wire ACK. Returns a CLI exit code and reports fixed categories;
 * no receipt asserts downstream projection or browser acceptance.
 */
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
    const task = selectRun(readInput(path));
    const config = task.config;
    if (args[0] === "resume" && task.kind !== "playback")
      throw new InputError("invalid-run-config");
    const inputRoot =
      task.kind === "playback"
        ? openPlaybackRoot(path, task.config)
        : undefined;
    try {
      const identity = readIdentity(
        config,
        inputRoot?.root ?? dirname(path),
        Boolean(inputRoot),
      );

      const { sendBatches } = await import("./transport/tcp.ts");
      if (task.kind === "playback")
        return await runPlayback(
          task.config,
          inputRoot?.root ?? dirname(path),
          identity,
          args[0] === "resume",
          signal,
          sendBatches,
          acknowledge,
        );
      const receipt = await sendBatches([task.frame], {
        host: config.target?.host ?? defaultTarget.host,
        port: config.target?.port ?? defaultTarget.port,
        ...config.retry,
        connectionPolicy: config.connectionPolicy,
        identity,
        signal,
      });
      acknowledge(receipt);
      return 0;
    } finally {
      inputRoot?.close();
    }
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
  if (args[0] === "run" || args[0] === "resume") {
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
