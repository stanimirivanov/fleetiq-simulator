import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { Cause, Effect, Exit } from "effect";
import {
  type DeliveryReceipt,
  SessionError,
  type SessionLimits,
  type SessionOptions,
  sessionLimits,
} from "../session/state.ts";
import type { Codec8Frame } from "../wire/codec8.ts";
import { encodeUdp, matchesUdpAck, UdpError, udpIds } from "../wire/udp.ts";

/** Reference-only loopback UDP; channel/AVL IDs are explicit per invocation, never guessed from peer replies. */
export type UdpOptions = Omit<SessionOptions, "connectionPolicy"> & {
  profile: "reference-peer";
  packetId: number;
  avlPacketId: number;
};

/** One invocation owns the bound connected socket and awaits its closure on every exit. */
type Handle = { socket: Socket; alive: boolean; closed: Promise<void> };

/** Converts only expected policy failures to typed Effect errors; programming defects retain their identity. */
function budget(limits: SessionLimits) {
  return Effect.try({
    try: () => limits.remaining(),
    catch: (error) => {
      if (error instanceof SessionError) return error;
      throw error;
    },
  });
}

/** Binds socket lifetime to Effect scope; an unbound socket may report not-running during cancellation cleanup. */
function openUdp(host: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const socket = createSocket({
        type: host === "::1" ? "udp6" : "udp4",
        recvBufferSize: 8192,
      });
      socket.on("error", () => {});
      const handle: Handle = { socket, alive: true, closed: Promise.resolve() };
      handle.closed = new Promise<void>((resolve) =>
        socket.once("close", () => {
          handle.alive = false;
          resolve();
        }),
      );
      return handle;
    }),
    (handle) =>
      Effect.promise(async () => {
        handle.alive = false;
        try {
          handle.socket.close();
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ERR_SOCKET_DGRAM_NOT_RUNNING"
          )
            return;
          throw error;
        }
        await handle.closed;
      }),
  );
}

/** Connect filters source endpoints in the kernel as well as the explicit reply predicate; no DNS is admitted. */
function connectUdp(
  handle: Handle,
  options: UdpOptions,
  limits: SessionLimits,
) {
  return Effect.gen(function* () {
    const remaining = yield* budget(limits);
    return yield* Effect.callback<void, SessionError>((resume) => {
      const cleanup = () => handle.socket.off("error", failed);
      const failed = () => {
        handle.alive = false;
        cleanup();
        resume(Effect.fail(new SessionError("connection-closed")));
      };
      handle.socket.once("error", failed);
      handle.socket.bind(0, options.host, () => {
        if (!handle.alive) return;
        handle.socket.connect(options.port, options.host, () => {
          if (handle.alive) {
            cleanup();
            resume(Effect.void);
          }
        });
      });
      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeoutOrElse({
        duration: Math.ceil(remaining),
        orElse: () => Effect.fail(new SessionError("run-timeout")),
      }),
    );
  });
}

/** Waits for one correlated AVL ACK; unrelated replies are ignored under both time and fixed flood budgets. */
function exchange(
  handle: Handle,
  packet: ReturnType<typeof encodeUdp>,
  options: UdpOptions,
  limits: SessionLimits,
) {
  return Effect.gen(function* () {
    const remaining = yield* budget(limits);
    const wait = Math.min(limits.ackDeadlineMs, remaining);
    const deadline = limits.now() + wait;
    const timeout = new SessionError(
      remaining <= limits.ackDeadlineMs ? "run-timeout" : "ack-timeout",
    );
    return yield* Effect.callback<void, SessionError>((resume) => {
      let finished = false,
        ignored = 0;
      const cleanup = () => {
        handle.socket.off("message", message);
        handle.socket.off("error", failed);
      };

      /** Detaches this attempt exactly once, including late send/error callbacks after cancellation. */
      const finish = (error?: SessionError) => {
        if (finished) return;
        finished = true;
        cleanup();
        resume(error ? Effect.fail(error) : Effect.void);
      };
      const failed = () => finish(new SessionError("connection-closed"));

      /** Endpoint, deadline, full response shape, both echoed IDs and wire-owned count must all agree. */
      const message = (reply: Buffer, source: RemoteInfo) => {
        if (limits.now() >= deadline) {
          finish(timeout);
          return;
        }
        if (
          source.address === options.host &&
          source.port === options.port &&
          matchesUdpAck(
            reply,
            packet.packetId,
            packet.avlPacketId,
            packet.recordCount,
          )
        ) {
          finish();
          return;
        }
        if (++ignored > 256) finish(new SessionError("unexpected-reply"));
      };
      handle.socket.on("message", message);
      handle.socket.on("error", failed);
      handle.socket.send(packet.bytes, (error) => {
        if (error) failed();
      });
      return Effect.sync(() => {
        finished = true;
        cleanup();
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: Math.ceil(wait),
        orElse: () => Effect.fail(timeout),
      }),
    );
  });
}

/**
 * Sends at most sixteen frozen datagrams to an explicitly selected local reference peer.
 * Retries preserve bytes and IDs; advancing packets increments both IDs modulo their
 * widths without repeating a pair in this run. No TCP login/framing or product UDP support
 * is implied. ACK loss can duplicate remote acceptance; all exits close the socket.
 */
export async function sendUdp(
  frames: readonly (Codec8Frame | Buffer)[],
  options: UdpOptions,
): Promise<DeliveryReceipt> {
  options = { ...options };
  if (
    options.profile !== "reference-peer" ||
    !["127.0.0.1", "::1"].includes(options.host) ||
    frames.length < 1 ||
    frames.length > 16
  )
    throw new SessionError("invalid-session");
  const limits = sessionLimits(options);
  let packets: ReturnType<typeof encodeUdp>[];
  try {
    packets = frames.map((frame, index) => {
      const ids = udpIds(options.packetId, options.avlPacketId, index);
      return encodeUdp(frame, options.identity, ids.packetId, ids.avlPacketId);
    });
  } catch (error) {
    if (error instanceof UdpError) throw new SessionError("invalid-session");
    throw error;
  }
  const program = Effect.gen(function* () {
    const handle = yield* openUdp(options.host);
    yield* connectUdp(handle, options, limits);
    let recordCount = 0;
    for (const packet of packets) {
      let attempts = 0;
      yield* exchange(handle, packet, options, limits).pipe(
        Effect.retry({
          while: (error) =>
            Effect.gen(function* () {
              if (
                ["run-timeout", "cancelled", "invalid-session"].includes(
                  error.category,
                ) ||
                ++attempts >= limits.maxAttempts
              )
                return false;
              const remaining = yield* budget(limits);
              yield* Effect.sleep(Math.min(100, remaining));
              return true;
            }),
        }),
      );
      recordCount += packet.recordCount;
    }
    return { status: "acknowledged", recordCount } satisfies DeliveryReceipt;
  }).pipe(Effect.scoped);
  const exit = await Effect.runPromiseExit(program, { signal: options.signal });
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterruptsOnly(exit.cause))
      throw new SessionError("cancelled");
    throw Cause.squash(exit.cause);
  }
  return exit.value;
}
