import assert from "node:assert/strict";
import { test } from "node:test";
import { BatchQueue } from "../../src/session/batches.ts";
import { SessionError } from "../../src/session/state.ts";
import { sendBatches } from "../../src/transport/tcp.ts";
import { ack, identity, login, withPeer } from "../support/peers/peer.ts";
import {
  variableFrame,
  variableRecord,
} from "../support/wire/codec8e-fixture.ts";

const options = {
  maxRecords: 2,
  maxFrameBytes: 1280,
  maxQueuedRecords: 10,
  maxQueuedBytes: 12800,
};

test("FIFO retains a frozen pending batch until its exact handle is acknowledged", () => {
  const queue = new BatchQueue(options);
  const first = structuredClone(variableRecord);
  queue.enqueue(first);
  queue.enqueue({ ...first, timestampMs: "1" });
  queue.enqueue({ ...first, timestampMs: "2" });
  assert.ok(first.io[0]);
  first.io[0].hex = "ffff";
  const batch = queue.peek();
  assert.ok(batch);
  assert.equal(batch.recordCount, 2);
  assert.equal(queue.peek(), batch);
  assert.equal(queue.length, 3);
  assert.throws(() => queue.acknowledge({} as typeof batch), SessionError);
  const bytes = batch.snapshot().bytes;
  assert.deepEqual(
    bytes.subarray(10, 61),
    Buffer.from(variableFrame, "hex").subarray(10, -5),
  );
  assert.equal(bytes.readBigUInt64BE(10), 0n);
  assert.equal(bytes.readBigUInt64BE(61), 1n);
  batch.snapshot().bytes.fill(0);
  assert.deepEqual(queue.peek()?.snapshot().bytes, bytes);
  queue.acknowledge(batch);
  assert.equal(queue.length, 1);
  assert.throws(() => queue.acknowledge(batch), SessionError);
  const tail = queue.peek();
  assert.ok(tail);
  assert.equal(tail.recordCount, 1);
  queue.acknowledge(tail);
  assert.equal(queue.peek(), undefined);
  assert.equal(queue.queuedBytes, 0);
});

test("byte limits split at exact boundaries and capacity/oversized input leave FIFO intact", () => {
  // NX example is 66 bytes alone, 117 bytes for two records (15-byte shared envelope).
  const queue = new BatchQueue({
    ...options,
    maxFrameBytes: 116,
    maxQueuedRecords: 2,
  });
  queue.enqueue(variableRecord);
  queue.enqueue(variableRecord);
  assert.equal(queue.peek()?.recordCount, 1);
  assert.throws(() => queue.enqueue(variableRecord), SessionError);
  assert.equal(queue.length, 2);
  const exact = new BatchQueue({ ...options, maxFrameBytes: 117 });
  exact.enqueue(variableRecord);
  exact.enqueue(variableRecord);
  assert.equal(exact.peek()?.recordCount, 2);
  const tooSmall = new BatchQueue({ ...options, maxFrameBytes: 53 });
  assert.throws(() => tooSmall.enqueue(variableRecord), SessionError);
  assert.equal(tooSmall.length, 0);
  const bytes = new BatchQueue({ ...options, maxQueuedBytes: 66 });
  bytes.enqueue(variableRecord);
  assert.throws(() => bytes.enqueue(variableRecord), SessionError);
  assert.equal(bytes.length, 1);
  for (const patch of [
    { maxRecords: 17 },
    { maxFrameBytes: 1281 },
    { maxQueuedRecords: 1001 },
    { maxQueuedBytes: 0 },
  ])
    assert.throws(() => new BatchQueue({ ...options, ...patch }), SessionError);
});

test("real peer must ACK the wire-owned batch count before FIFO removal", {
  timeout: 3000,
}, async () => {
  const queue = new BatchQueue(options);
  queue.enqueue(variableRecord);
  queue.enqueue(variableRecord);
  const frame = queue.peek();
  assert.ok(frame);
  await withPeer(
    async (socket) => {
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      const bytes = await read(frame.snapshot().bytes.length);
      assert.equal(bytes[9], 2);
      socket.end(Buffer.from([0, 0, 0, 2]));
    },
    async (port) => {
      const receipt = await sendBatches([frame], {
        host: "127.0.0.1",
        port,
        identity,
        maxAttempts: 1,
      });
      assert.equal(receipt.recordCount, 2);
      assert.equal(queue.length, 2);
      queue.acknowledge(frame);
      assert.equal(queue.length, 0);
    },
  );
  const failed = new BatchQueue(options);
  failed.enqueue(variableRecord);
  failed.enqueue(variableRecord);
  const retry = failed.peek();
  assert.ok(retry);
  await withPeer(
    async (socket) => {
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      await read(frame.snapshot().bytes.length);
      socket.end(ack);
    },
    async (port) => {
      await assert.rejects(
        sendBatches([retry], {
          host: "127.0.0.1",
          port,
          identity,
          maxAttempts: 1,
        }),
        /ack-count/,
      );
      assert.equal(failed.length, 2);
      assert.equal(failed.peek(), retry);
    },
  );
});

test("acknowledged removal uses private wire metadata despite a replaced public getter", () => {
  const queue = new BatchQueue(options);
  for (let n = 0; n < 2; n++) queue.enqueue(variableRecord);
  const pending = queue.peek();
  assert.ok(pending);
  queue.enqueue(variableRecord);
  assert.equal(queue.peek(), pending);
  const prototype = Object.getPrototypeOf(pending);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "recordCount");
  assert.ok(descriptor);
  try {
    Object.defineProperty(prototype, "recordCount", {
      get: () => 99,
      configurable: true,
    });
    queue.acknowledge(pending);
  } finally {
    Object.defineProperty(prototype, "recordCount", descriptor);
  }
  assert.equal(queue.length, 1);
});
