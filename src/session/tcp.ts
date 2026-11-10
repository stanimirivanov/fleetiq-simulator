import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { crc16Arc } from "../wire/codec8.ts";
import {
  SessionError,
  type SessionLimits,
  type SessionOptions,
  sessionLimits,
} from "./state.ts";

function exchange(
  socket: Socket,
  bytes: Buffer,
  size: 1 | 4,
  limits: SessionLimits,
): Promise<Buffer> {
  const started = limits.now();
  const remaining = limits.remaining(started);
  const wait = Math.min(limits.ackDeadlineMs, remaining);
  const deadline = started + wait;
  const timeout =
    remaining <= limits.ackDeadlineMs
      ? "run-timeout"
      : size === 1
        ? "login-timeout"
        : "ack-timeout";

  return new Promise((resolve, reject) => {
    const finish = (result: Buffer | SessionError) => {
      clearTimeout(timer);
      socket.off("readable", readable);
      socket.off("close", closed);
      socket.off("end", closed);
      limits.signal?.removeEventListener("abort", cancelled);
      if (result instanceof SessionError) reject(result);
      else resolve(result);
    };
    const expired = () => finish(new SessionError(timeout));
    const reply = Buffer.alloc(size);
    let received = 0;
    const readable = () => {
      if (limits.now() >= deadline) {
        expired();
        return;
      }
      const available = socket.readableLength;
      if (available > size - received) {
        finish(new SessionError("unexpected-reply"));
      } else if (available > 0) {
        const chunk: Buffer = socket.read(available);
        received += chunk.copy(reply, received);
        if (received === size) finish(reply);
      }
    };
    const closed = () => finish(new SessionError("connection-closed"));
    const cancelled = () => finish(new SessionError("cancelled"));
    const timer = setTimeout(expired, Math.ceil(wait));

    if (socket.destroyed || socket.readableEnded) {
      closed();
      return;
    }
    // Buffered bytes predate this request, so they cannot acknowledge it.
    if (socket.readableLength !== 0) {
      finish(new SessionError("unexpected-reply"));
      return;
    }
    limits.signal?.addEventListener("abort", cancelled, { once: true });
    socket.on("close", closed);
    socket.on("end", closed);
    socket.on("readable", readable);
    socket.write(bytes);
  });
}

function connect({ host, port }: SessionOptions) {
  const address = { host, port, highWaterMark: 64, noDelay: true };
  const socket = createConnection(address);
  // Transport errors are reported by the close event without exposing endpoints.
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  return {
    socket,
    async retire() {
      socket.destroy();
      await closed;
    },
  };
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

  let connection: ReturnType<typeof connect> | undefined;
  try {
    for (const frame of frozen) {
      for (let attempt = 1; ; attempt++) {
        limits.remaining();
        try {
          if (!connection) {
            connection = connect(options);
            const reply = await exchange(connection.socket, login, 1, limits);
            if (reply[0] !== 1) throw new SessionError("login-refused");
          }
          const reply = await exchange(connection.socket, frame, 4, limits);
          if (reply.readUInt32BE() !== frame[9])
            throw new SessionError("ack-count");
          if (limits.connectionPolicy === "single-batch") {
            await connection.retire();
            connection = undefined;
          }
          break;
        } catch (error) {
          await connection?.retire();
          connection = undefined;
          if (
            !(error instanceof SessionError) ||
            error.category === "login-refused" ||
            error.category === "run-timeout" ||
            error.category === "cancelled" ||
            attempt === limits.maxAttempts
          )
            throw error;
          const remaining = limits.remaining();
          try {
            await delay(Math.min(100, remaining), undefined, {
              signal: limits.signal,
            });
          } catch {
            throw new SessionError("cancelled");
          }
        }
      }
    }
  } finally {
    await connection?.retire();
  }
}
