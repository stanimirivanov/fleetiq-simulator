import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CommandFixture } from "../src/session/command.ts";
import { sendBatches } from "../src/transport/tcp.ts";
import { frame } from "./codec8-fixture.ts";
import { oracleCrc } from "./codec8-oracle.ts";
import { getinfo } from "./command-peer.ts";
import { ack, identity, login, withPeer } from "./peer.ts";

const bytes = Buffer.from(frame, "hex");
const options = (port: number) => ({
  host: "127.0.0.1",
  port,
  identity,
  maxAttempts: 1,
  ackDeadlineMs: 150,
  totalDeadlineMs: 2000,
});

test("command policy rejects wrong state, bounds fragments and replies once after AVL ACK", () => {
  const state = new CommandFixture();
  assert.throws(() => state.receive(getinfo), /invalid-command/);
  const active = new CommandFixture();
  active.avlAcknowledged();
  assert.equal(active.receive(getinfo.subarray(0, 7)), null);
  const response = active.receive(getinfo.subarray(7));
  assert.equal(response?.[10], 6);
  assert.equal(
    response?.subarray(15, -5).toString("ascii"),
    "SIMULATOR:read-only",
  );
  assert.throws(() => active.receive(getinfo), /invalid-command/);
  assert.throws(() => active.avlAcknowledged(), /invalid-command/);
  for (const chunk of [
    Buffer.alloc(28),
    Buffer.from("000000007fffffff", "hex"),
  ]) {
    const bad = new CommandFixture();
    bad.avlAcknowledged();
    assert.throws(() => bad.receive(chunk), /invalid-command/);
    assert.throws(() => bad.receive(getinfo), /invalid-command/);
  }
});

for (const coalesced of [false, true])
  test(`command peer receives a type 06 reply after AVL ACK; coalesced=${coalesced}`, {
    timeout: 3000,
  }, async () => {
    const observed = Promise.withResolvers<void>();
    await withPeer(
      async (socket) => {
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        assert.deepEqual(await read(bytes.length), bytes);
        if (coalesced) socket.write(Buffer.concat([ack, getinfo]));
        else {
          socket.write(ack);
          for (let index = 0; index < getinfo.length; index++) {
            socket.write(getinfo.subarray(index, index + 1));
            await delay(1);
          }
        }
        const header = await read(8);
        const body = await read(header.readUInt32BE(4) + 4);
        assert.deepEqual(body.subarray(0, 3), Buffer.from([12, 1, 6]));
        assert.equal(
          body.subarray(7, -5).toString("ascii"),
          "SIMULATOR:read-only",
        );
        assert.equal(
          body.readUInt32BE(body.length - 4),
          oracleCrc(body.subarray(0, -4)),
        );
        observed.resolve();
      },
      async (port) => {
        assert.deepEqual(await sendBatches([bytes], options(port), true), {
          status: "acknowledged",
          recordCount: 1,
        });
        await observed.promise;
      },
    );
  });

test("command fixture fails closed on early, surplus and unsupported commands", {
  timeout: 3000,
}, async () => {
  const unsupported = Buffer.from(getinfo);
  unsupported.write("setconf", 15, "ascii");
  unsupported.writeUInt32BE(
    oracleCrc(unsupported.subarray(8, -4)),
    unsupported.length - 4,
  );
  const corrupt = Buffer.from(getinfo);
  corrupt[26] = (corrupt[26] ?? 0) ^ 1;
  for (const packet of [
    Buffer.concat([getinfo, getinfo]),
    Buffer.concat([ack, getinfo, getinfo]),
    Buffer.concat([ack, unsupported]),
    Buffer.concat([ack, corrupt]),
  ]) {
    await withPeer(
      async (socket) => {
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        await read(bytes.length);
        socket.write(packet);
        const unexpected: Buffer[] = [];
        socket.on("data", (chunk) => unexpected.push(chunk));
        socket.resume();
        await once(socket, "close");
        assert.equal(Buffer.concat(unexpected).length, 0);
      },
      async (port) => {
        await assert.rejects(
          sendBatches([bytes], options(port), true),
          /unexpected-reply|ack-count|invalid-command/,
        );
      },
    );
  }
});

test("missing command times out and interruption closes the fixture socket", {
  timeout: 3000,
}, async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    await withPeer(
      async (socket) => {
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        await read(bytes.length);
        socket.write(ack);
        if (cancel) {
          await delay(20);
          controller.abort();
        }
        await once(socket, "end");
      },
      async (port) => {
        await assert.rejects(
          sendBatches(
            [bytes],
            { ...options(port), signal: controller.signal },
            true,
          ),
          cancel ? /cancelled/ : /command-timeout/,
        );
      },
    );
  }
});

test("fixture rejects product targets, retries, multiple batches and persistent mode", async () => {
  for (const patch of [
    { host: "tcp-ingestion" },
    { maxAttempts: 2 },
    { connectionPolicy: "persistent-compliant-peer" as const },
  ])
    await assert.rejects(
      sendBatches([bytes], { ...options(1), ...patch }, true),
      /invalid-session/,
    );
  await assert.rejects(
    sendBatches([bytes, bytes], options(1), true),
    /invalid-session/,
  );
});
