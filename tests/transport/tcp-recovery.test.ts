import assert from "node:assert/strict";
import { test } from "node:test";
import { sendBatches } from "../../src/transport/tcp.ts";
import { encodeCodec8 } from "../../src/wire/codec8.ts";
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
