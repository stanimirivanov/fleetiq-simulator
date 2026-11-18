import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withBatchSender } from "../../src/transport/tcp.ts";
import { ack, identity, login, withPeer } from "../support/peers/peer.ts";

const frame = Buffer.from(
  "000000000000002808010000016b40d9ad80010000000000000000000000000000000103021503010101425e100000010000f22a",
  "hex",
);
const options = (port: number) => ({
  host: "127.0.0.1",
  port,
  identity,
  ackDeadlineMs: 200,
  totalDeadlineMs: 2000,
  maxAttempts: 2,
  connectionPolicy: "persistent-compliant-peer" as const,
});

test("durable sender retains one compliant-peer socket across idle send calls and closes before return", {
  timeout: 3000,
}, async () => {
  let connections = 0;
  let peerClosed: Promise<unknown> | undefined;
  await withPeer(
    async (socket) => {
      connections++;
      peerClosed = once(socket, "end");
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(await read(frame.length), frame);
        socket.write(ack);
      }
    },
    async (port) => {
      await withBatchSender(options(port), async (send) => {
        assert.equal(connections, 0);
        assert.deepEqual(await send(frame), {
          status: "acknowledged",
          recordCount: 1,
        });
        await delay(30);
        assert.deepEqual(await send(frame), {
          status: "acknowledged",
          recordCount: 1,
        });
      });
      await peerClosed;
      assert.equal(connections, 1);
    },
  );
});

test("strict durable sends retain the default one-batch socket retirement", {
  timeout: 3000,
}, async () => {
  let connections = 0;
  await withPeer(
    async (socket) => {
      connections++;
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(frame.length), frame);
      socket.write(ack);
    },
    async (port) => {
      const { connectionPolicy: _policy, ...strict } = options(port);
      await withBatchSender(strict, async (send) => {
        await send(frame);
        await send(frame);
      });
      assert.equal(connections, 2);
    },
  );
});

test("idle peer closure reconnects while uncertain ACK retry retires and preserves exact bytes", {
  timeout: 3000,
}, async () => {
  let connections = 0;
  const pending = Buffer.from(frame);
  await withPeer(
    async (socket, attempt) => {
      connections++;
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(frame.length), frame);
      if (attempt === 2) {
        pending.fill(0);
        socket.destroy();
      } else socket.end(ack);
    },
    async (port) => {
      await withBatchSender(options(port), async (send) => {
        await send(pending);
        await delay(30);
        assert.deepEqual(await send(pending), {
          status: "acknowledged",
          recordCount: 1,
        });
      });
      assert.equal(connections, 3);
    },
  );
});

test("wrong counts poison the durable sender and never produce a receipt or a reused socket", {
  timeout: 3000,
}, async () => {
  let connections = 0;
  await withPeer(
    async (socket) => {
      connections++;
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      await read(frame.length);
      socket.write(Buffer.from([0, 0, 0, 2]));
    },
    async (port) => {
      await withBatchSender(
        { ...options(port), maxAttempts: 1 },
        async (send) => {
          await assert.rejects(send(frame), { category: "ack-count" });
          await assert.rejects(send(frame), { category: "ack-count" });
        },
      );
      assert.equal(connections, 1);
    },
  );
});

test("one deadline spans durable sends and caller pauses without a fresh budget", {
  timeout: 3000,
}, async () => {
  let connections = 0;
  await withPeer(
    async (socket) => {
      connections++;
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      await read(frame.length);
      socket.write(ack);
    },
    async (port) => {
      let now = 0;
      await withBatchSender(
        { ...options(port), now: () => now, totalDeadlineMs: 500 },
        async (send) => {
          await send(frame);
          now = 500;
          await assert.rejects(send(frame), { category: "run-timeout" });
        },
      );
      assert.equal(connections, 1);
    },
  );
});

test("callback failure and cancellation close retained sockets without a success receipt", {
  timeout: 3000,
}, async () => {
  for (const cancel of [false, true]) {
    let peerClosed: Promise<unknown> | undefined;
    const controller = new AbortController();
    await withPeer(
      async (socket) => {
        peerClosed = once(socket, "end");
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        await read(frame.length);
        socket.write(ack);
      },
      async (port) => {
        await assert.rejects(
          withBatchSender(
            { ...options(port), signal: controller.signal },
            async (send) => {
              await send(frame);
              if (cancel) {
                controller.abort();
                await send(frame);
              } else throw new Error("checkpoint-canary");
            },
          ),
          cancel ? { category: "cancelled" } : { message: "checkpoint-canary" },
        );
        await peerClosed;
      },
    );
  }
});

test("durable login refusal and stale idle replies are terminal and never acknowledged", {
  timeout: 3000,
}, async () => {
  for (const refused of [true, false]) {
    let connections = 0;
    await withPeer(
      async (socket) => {
        connections++;
        const read = await login(socket);
        socket.write(Buffer.from([refused ? 0 : 1]));
        if (!refused) {
          await read(frame.length);
          socket.write(ack);
          await delay(5);
          socket.write(ack);
        }
      },
      async (port) => {
        await withBatchSender(
          { ...options(port), maxAttempts: 1 },
          async (send) => {
            if (!refused) {
              await send(frame);
              await delay(20);
            }
            const category = refused ? "login-refused" : "unexpected-reply";
            await assert.rejects(send(frame), { category });
            await assert.rejects(send(frame), { category });
          },
        );
        assert.equal(connections, 1);
      },
    );
  }
});

test("concurrent durable sends reject and in-flight cancellation releases the active scope", {
  timeout: 3000,
}, async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let connections = 0;
    await withPeer(
      async (socket) => {
        connections++;
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        await read(frame.length);
        if (cancel) controller.abort();
        else socket.write(ack);
      },
      async (port) => {
        const operation = withBatchSender(
          { ...options(port), signal: controller.signal },
          async (send) => {
            const pending = send(frame);
            await assert.rejects(send(frame), { category: "invalid-session" });
            return await pending;
          },
        );
        if (cancel) await assert.rejects(operation, { category: "cancelled" });
        else
          assert.deepEqual(await operation, {
            status: "acknowledged",
            recordCount: 1,
          });
        assert.equal(connections, 1);
      },
    );
  }
});
