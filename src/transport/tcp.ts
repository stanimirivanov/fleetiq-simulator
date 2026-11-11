import { createConnection, type Socket } from "node:net";
import { Cause, Effect, Exit } from "effect";
import {
  SessionError,
  type SessionLimits,
  type SessionOptions,
  sessionLimits,
} from "../session/state.ts";
import { crc16Arc } from "../wire/codec8.ts";

function readReply(
  socket: Socket,
  bytes: Buffer,
  size: 1 | 4,
  expired: () => boolean,
  timeout: SessionError,
) {
  return Effect.callback<Buffer, SessionError>((resume) => {
    if (socket.destroyed || socket.readableEnded) {
      resume(Effect.fail(new SessionError("connection-closed")));
      return;
    }
    // Buffered bytes predate this request, so they cannot acknowledge it.
    if (socket.readableLength !== 0) {
      resume(Effect.fail(new SessionError("unexpected-reply")));
      return;
    }

    const reply = Buffer.alloc(size);
    let received = 0;
    const cleanup = () => {
      socket.off("readable", readable);
      socket.off("close", closed);
      socket.off("end", closed);
    };
    const finish = (result: Effect.Effect<Buffer, SessionError>) => {
      cleanup();
      resume(result);
    };
    const closed = () =>
      finish(Effect.fail(new SessionError("connection-closed")));
    const readable = () => {
      if (expired()) {
        finish(Effect.fail(timeout));
        return;
      }
      const available = socket.readableLength;
      if (available > size - received) {
        finish(Effect.fail(new SessionError("unexpected-reply")));
      } else if (available > 0) {
        const chunk: Buffer = socket.read(available);
        received += chunk.copy(reply, received);
        if (received === size) finish(Effect.succeed(reply));
      }
    };

    socket.on("close", closed);
    socket.on("end", closed);
    socket.on("readable", readable);
    socket.write(bytes);
    return Effect.sync(cleanup);
  });
}

function remainingBudget(limits: SessionLimits, at?: number) {
  return Effect.try({
    try: () => limits.remaining(at),
    catch: (error) => {
      if (error instanceof SessionError) return error;
      throw error;
    },
  });
}

function exchange(
  socket: Socket,
  bytes: Buffer,
  size: 1 | 4,
  limits: SessionLimits,
) {
  return Effect.gen(function* () {
    const started = limits.now();
    const remaining = yield* remainingBudget(limits, started);
    const wait = Math.min(limits.ackDeadlineMs, remaining);
    const deadline = started + wait;
    const timeout = new SessionError(
      remaining <= limits.ackDeadlineMs
        ? "run-timeout"
        : size === 1
          ? "login-timeout"
          : "ack-timeout",
    );
    return yield* readReply(
      socket,
      bytes,
      size,
      () => limits.now() >= deadline,
      timeout,
    ).pipe(
      Effect.timeoutOrElse({
        duration: Math.ceil(wait),
        orElse: () => Effect.fail(timeout),
      }),
    );
  });
}

function openSocket({ host, port }: SessionOptions) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const address = { host, port, highWaterMark: 64, noDelay: true };
      const socket = createConnection(address);
      // The close event reports transport failure without exposing endpoints.
      socket.on("error", () => {});
      const closed = new Promise<void>((resolve) =>
        socket.once("close", resolve),
      );
      return { socket, closed };
    }),
    ({ socket, closed }) =>
      Effect.promise(() => {
        socket.destroy();
        return closed;
      }),
  );
}

function freezeFrame(frame: Buffer): Buffer {
  if (
    frame.length < 45 ||
    frame.length > 1280 ||
    frame.readUInt32BE(0) !== 0 ||
    frame.readUInt32BE(4) !== frame.length - 12 ||
    frame[8] !== 8 ||
    frame[9] !== 1 ||
    frame.at(-5) !== 1 ||
    frame.readUInt32BE(frame.length - 4) !== crc16Arc(frame.subarray(8, -4))
  )
    throw new SessionError("invalid-session");
  return Buffer.from(frame);
}

export async function sendBatches(
  frames: readonly Buffer[],
  options: SessionOptions,
): Promise<void> {
  const limits = sessionLimits(options);
  if (frames.length === 0 || frames.length > 16)
    throw new SessionError("invalid-session");
  const frozen = frames.map(freezeFrame);
  const login = Buffer.alloc(17);
  login.writeUInt16BE(15);
  login.write(options.identity, 2, "ascii");

  const program = Effect.gen(function* () {
    let next = 0;
    let failures = 0;
    const connection = Effect.gen(function* () {
      yield* remainingBudget(limits);
      const { socket } = yield* openSocket(options);
      const accepted = yield* exchange(socket, login, 1, limits);
      if (accepted[0] !== 1)
        return yield* Effect.fail(new SessionError("login-refused"));

      for (const frame of frozen.slice(next)) {
        const reply = yield* exchange(socket, frame, 4, limits);
        if (reply.readUInt32BE() !== frame[9])
          return yield* Effect.fail(new SessionError("ack-count"));
        next++;
        failures = 0;
        if (limits.connectionPolicy === "single-batch") break;
      }
    }).pipe(Effect.scoped);

    // Scope closes before the retry predicate runs. The cursor advances only on ACK.
    const send = connection.pipe(
      Effect.retry({
        while: (error) =>
          Effect.gen(function* () {
            if (
              error.category === "login-refused" ||
              error.category === "run-timeout" ||
              error.category === "cancelled" ||
              ++failures >= limits.maxAttempts
            )
              return false;
            const remaining = yield* remainingBudget(limits);
            yield* Effect.sleep(Math.min(100, remaining));
            return true;
          }),
      }),
    );
    while (next < frozen.length) yield* send;
  });

  const exit = await Effect.runPromiseExit(program, { signal: options.signal });
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterruptsOnly(exit.cause))
      throw new SessionError("cancelled");
    throw Cause.squash(exit.cause);
  }
}
