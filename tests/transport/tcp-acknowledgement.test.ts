import assert from "node:assert/strict";
import { once } from "node:events";
import type { Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sendBatches } from "../../src/transport/tcp.ts";
import { ack, identity, login, withPeer } from "../support/peers/peer.ts";

// Published Teltonika TCP Codec 8 example, one record.
const frame = Buffer.from(
  "000000000000002808010000016b40d9ad80010000000000000000000000000000000103021503010101425e100000010000f22a",
  "hex",
);

function options(port: number) {
  return {
    host: "127.0.0.1",
    port,
    identity,
    ackDeadlineMs: 150,
    totalDeadlineMs: 2_000,
    maxAttempts: 1,
  } as const;
}

test("waits for all four ACK bytes and accepts a compliant persistent peer", {
  timeout: 3000,
}, async () => {
  await withPeer(
    async (socket, attempt) => {
      assert.equal(attempt, 1);
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      for (let batch = 0; batch < 2; batch++) {
        assert.deepEqual(await read(frame.length), frame);
        socket.write(ack.subarray(0, 1));
        await delay(10);
        socket.write(ack.subarray(1));
      }
    },
    async (port) => {
      assert.deepEqual(
        await sendBatches([frame, frame], {
          ...options(port),
          connectionPolicy: "persistent-compliant-peer",
        }),
        { status: "acknowledged", recordCount: 2 },
      );
    },
  );
});

test("strict mode cannot accept a delayed equal-count duplicate from the retired socket", {
  timeout: 3000,
}, async () => {
  let first: Socket | undefined;
  let retired: Promise<unknown> | undefined;
  await withPeer(
    async (socket, attempt) => {
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(frame.length), frame);
      if (attempt === 1) {
        first = socket;
        retired = once(socket, "close");
        socket.write(ack);
      } else {
        assert.equal(attempt, 2);
        await retired;
        assert.ok(first?.destroyed);
        first.write(ack);
        // Only the old session emits an ACK for this second equal-count batch.
      }
    },
    async (port) => {
      await assert.rejects(
        sendBatches([frame, frame], options(port)),
        /^Error: ack-timeout$/,
      );
    },
  );
});

test("refusal is terminal, premature coalesced bytes and wrong counts fail", {
  timeout: 3000,
}, async () => {
  for (const [response, category] of [
    [Buffer.from([0]), "login-refused"],
    [Buffer.concat([Buffer.from([1]), ack]), "unexpected-reply"],
    [Buffer.from([1]), "ack-count"],
  ] as const) {
    await withPeer(
      async (socket, attempt) => {
        assert.equal(attempt, 1);
        const read = await login(socket);
        socket.write(response);
        if (category === "ack-count") {
          assert.deepEqual(await read(frame.length), frame);
          socket.write(Buffer.from([0, 0, 0, 2]));
        }
      },
      async (port) => {
        await assert.rejects(
          sendBatches([frame], {
            ...options(port),
            maxAttempts: category === "login-refused" ? 2 : 1,
          }),
          new RegExp(`^Error: ${category}$`),
        );
      },
    );
  }
});
