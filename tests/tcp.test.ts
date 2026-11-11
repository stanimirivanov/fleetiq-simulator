import assert from "node:assert/strict";
import { once } from "node:events";
import type { Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sessionLimits } from "../src/session/state.ts";
import { sendBatches } from "../src/transport/tcp.ts";
import { encodeCodec8 } from "../src/wire/codec8.ts";
import { ack, identity, login, withPeer } from "./peer.ts";

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

test("a missing ACK retries the exact frozen frame on a fresh login", {
  timeout: 3000,
}, async () => {
  let attempts = 0;
  const pending = Buffer.from(frame);
  await withPeer(
    async (socket, attempt) => {
      attempts = attempt;
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(frame.length), frame);
      if (attempt === 2) socket.end(ack);
      else pending.fill(0);
    },
    async (port) => {
      await sendBatches([pending], { ...options(port), maxAttempts: 2 });
      assert.equal(attempts, 2);
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

test("cancellation and the monotonic run budget bound a silent peer", {
  timeout: 3000,
}, async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    await withPeer(
      async (socket) => {
        await login(socket);
        if (cancel) controller.abort();
      },
      async (port) => {
        await assert.rejects(
          sendBatches([frame], {
            ...options(port),
            signal: controller.signal,
            totalDeadlineMs: cancel ? 2000 : 75,
          }),
          cancel ? /^Error: cancelled$/ : /^Error: run-timeout$/,
        );
      },
    );
  }
});

test("validates session bounds before connecting and measures one absolute run budget", async () => {
  const settings = options(1);
  for (const patch of [
    { host: "localhost" },
    { port: 65536 },
    { identity: "wrong" },
    { ackDeadlineMs: 99 },
    { totalDeadlineMs: 86400001 },
    { maxAttempts: 0 },
  ]) {
    await assert.rejects(
      sendBatches([frame], { ...settings, ...patch }),
      /^Error: invalid-session$/,
    );
  }
  const damaged = Buffer.from(frame);
  damaged.writeUInt8(0xff, 10);
  await assert.rejects(
    sendBatches([damaged], settings),
    /^Error: invalid-session$/,
  );
  let now = 100;
  const budget = sessionLimits({
    ...settings,
    totalDeadlineMs: 500,
    now: () => now,
  });
  now += 400;
  assert.equal(budget.remaining(), 100);
  now += 100;
  assert.throws(budget.remaining, /^Error: run-timeout$/);
});

test("persistent reconnect retries only the unacknowledged batch", {
  timeout: 3000,
}, async () => {
  const next = encodeCodec8({
    schemaVersion: 1,
    timestampMs: "0",
    priority: 0,
    longitudeE7: 0,
    latitudeE7: 0,
    altitude: 0,
    angle: 0,
    satellites: 0,
    speed: 0,
    eventId: 0,
    io: [],
  });
  let attempts = 0;
  await withPeer(
    async (socket, attempt) => {
      attempts = attempt;
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      if (attempt === 1) {
        assert.deepEqual(await read(frame.length), frame);
        socket.write(ack);
      }
      assert.deepEqual(await read(next.length), next);
      if (attempt === 2) socket.end(ack);
    },
    async (port) => {
      await sendBatches([frame, next], {
        ...options(port),
        maxAttempts: 2,
        connectionPolicy: "persistent-compliant-peer",
      });
      assert.equal(attempts, 2);
    },
  );
});

test("a peer accepting a frame before a lost ACK can receive it twice but the receipt counts it once", {
  timeout: 3000,
}, async () => {
  let remoteAcceptances = 0;
  await withPeer(
    async (socket, attempt) => {
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(frame.length), frame);
      remoteAcceptances++;
      if (attempt === 1) socket.end();
      else socket.end(ack);
    },
    async (port) => {
      const receipt = await sendBatches([frame], {
        ...options(port),
        maxAttempts: 2,
      });
      assert.deepEqual(receipt, { status: "acknowledged", recordCount: 1 });
      assert.equal(remoteAcceptances, 2);
    },
  );
});

test("a later unacknowledged batch rejects without a partial success receipt", {
  timeout: 3000,
}, async () => {
  let completed = false;
  await withPeer(
    async (socket, attempt) => {
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(frame.length), frame);
      if (attempt === 1) socket.end(ack);
      else socket.end();
    },
    async (port) => {
      await assert.rejects(
        sendBatches([frame, frame], options(port)).then(() => {
          completed = true;
        }),
        /^Error: connection-closed$/,
      );
      assert.equal(completed, false);
    },
  );
});
