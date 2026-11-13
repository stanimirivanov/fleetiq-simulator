import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { sendFaultBatches } from "../src/transport/tcp.ts";
import { frame } from "./codec8-fixture.ts";
import { ack, identity, login, reader, withPeer } from "./peer.ts";

const bytes = Buffer.from(frame, "hex");
const spec = (actions: unknown[]) => ({
  schemaVersion: 1,
  authorizedLocalTarget: true,
  actions,
});
const options = (port: number) => ({
  host: "127.0.0.1",
  port,
  identity,
  ackDeadlineMs: 100,
  totalDeadlineMs: 2000,
  maxAttempts: 1,
});

test("fault TCP preserves split/duplicate bytes and sends the earlier timestamp at the original ordinal", {
  timeout: 3000,
}, async () => {
  await withPeer(
    async (socket, attempt) => {
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      const actual = await read(bytes.length);
      if (attempt < 4) assert.deepEqual(actual, bytes);
      else {
        assert.equal(attempt, 4);
        assert.equal(actual.readBigUInt64BE(10), 1n);
      }
      socket.end(ack);
    },
    async (port) =>
      assert.deepEqual(
        await sendFaultBatches(
          [bytes, bytes, bytes],
          spec([
            { packet: 1, kind: "split-write", offset: 7 },
            { packet: 2, kind: "duplicate-record" },
            { packet: 3, kind: "late-event-time", timestampMs: "1" },
          ]),
          options(port),
        ),
        {
          status: "faults-completed",
          packets: 4,
          acknowledged: 4,
          denied: 0,
          disconnected: 0,
        },
      ),
  );
});

for (const kind of [
  "corrupt-crc",
  "truncate-close",
  "unregistered-identity",
] as const) {
  test(`fault TCP observes denial without claiming validation: ${kind}`, {
    timeout: 3000,
  }, async () => {
    const alternate = "12345".repeat(3);
    await withPeer(
      async (socket) => {
        const read = reader(socket);
        assert.deepEqual(await read(2), Buffer.from([0, 15]));
        assert.equal(
          (await read(15)).toString(),
          kind === "unregistered-identity" ? alternate : identity,
        );
        if (kind === "unregistered-identity") {
          socket.end(Buffer.from([0]));
          return;
        }
        socket.write(Buffer.from([1]));
        const actual = await read(
          kind === "truncate-close" ? 11 : bytes.length,
        );
        if (kind === "truncate-close")
          assert.deepEqual(actual, bytes.subarray(0, 11));
        else {
          assert.deepEqual(actual.subarray(0, -1), bytes.subarray(0, -1));
          assert.equal(actual.at(-1), (bytes.at(-1) ?? 0) ^ 1);
        }
        socket.end();
      },
      async (port) =>
        assert.deepEqual(
          await sendFaultBatches(
            [bytes],
            spec([
              {
                packet: 1,
                kind,
                ...(kind === "truncate-close" ? { offset: 11 } : {}),
              },
            ]),
            { ...options(port), unregisteredIdentity: alternate },
          ),
          {
            status: "faults-completed",
            packets: 1,
            acknowledged: 0,
            denied: 1,
            disconnected: 0,
          },
        ),
    );
  });
}

for (const when of ["before", "after"] as const) {
  test(`fault TCP closes exactly ${when} AVL write without a delivery receipt`, {
    timeout: 3000,
  }, async () => {
    await withPeer(
      async (socket) => {
        const closed = once(socket, "close");
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        if (when === "after") {
          assert.deepEqual(await read(bytes.length), bytes);
          socket.end(ack);
        } else
          await assert.rejects(
            read(1),
            /unexpected-client-close|Premature close/,
          );
        await closed;
      },
      async (port) =>
        assert.deepEqual(
          await sendFaultBatches(
            [bytes],
            spec([{ packet: 1, kind: `disconnect-${when}-write` }]),
            options(port),
          ),
          {
            status: "faults-completed",
            packets: 1,
            acknowledged: 0,
            denied: 0,
            disconnected: 1,
          },
        ),
    );
  });
}

test("fault TCP refuses a successful ACK for deliberately invalid traffic", {
  timeout: 3000,
}, async () => {
  await withPeer(
    async (socket) => {
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      await read(bytes.length);
      socket.end(ack);
    },
    async (port) => {
      await assert.rejects(
        sendFaultBatches(
          [bytes],
          spec([{ packet: 1, kind: "corrupt-crc" }]),
          options(port),
        ),
        /^Error: fault-accepted$/,
      );
    },
  );
});

test("fault TCP does not count cancellation, run expiry or an invalid target as denial", {
  timeout: 3000,
}, async () => {
  await withPeer(
    async (socket) => {
      await login(socket);
    },
    async (port) => {
      const input = spec([{ packet: 1, kind: "corrupt-crc" }]);
      await assert.rejects(
        sendFaultBatches([bytes], input, {
          ...options(port),
          host: "example.com",
        }),
        /invalid-session/,
      );
      await assert.rejects(
        sendFaultBatches([bytes], input, {
          ...options(port),
          totalDeadlineMs: 30,
        }),
        /run-timeout/,
      );
      const signal = AbortSignal.timeout(20);
      await assert.rejects(
        sendFaultBatches([bytes], input, { ...options(port), signal }),
        /cancelled/,
      );
    },
  );
});

test("after-write closure expiry distinguishes the exchange cap from the whole-run budget", {
  timeout: 3000,
}, async () => {
  await withPeer(
    async (socket) => {
      socket.allowHalfOpen = true;
      await login(socket);
      socket.write(Buffer.from([1]));
    },
    async (port) => {
      const input = spec([{ packet: 1, kind: "disconnect-after-write" }]);
      await assert.rejects(
        sendFaultBatches([bytes], input, {
          ...options(port),
          ackDeadlineMs: 500,
        }),
        /^Error: disconnect-timeout$/,
      );
      await assert.rejects(
        sendFaultBatches([bytes], input, {
          ...options(port),
          totalDeadlineMs: 30,
        }),
        /^Error: run-timeout$/,
      );
    },
  );
});
