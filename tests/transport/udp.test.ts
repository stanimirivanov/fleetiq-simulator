import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sendUdp } from "../../src/transport/udp.ts";
import { identity } from "../support/peers/peer.ts";
import { withUdpPeer } from "../support/peers/udp-peer.ts";
import { frame } from "../support/wire/codec8-fixture.ts";

const bytes = Buffer.from(frame, "hex");
const options = (port: number) => ({
  host: "127.0.0.1",
  port,
  identity,
  profile: "reference-peer" as const,
  packetId: 65535,
  avlPacketId: 255,
  maxAttempts: 1,
  ackDeadlineMs: 150,
  totalDeadlineMs: 2000,
});
const ack = (packet: Buffer) =>
  Buffer.from([
    0,
    5,
    packet[2] ?? 0,
    packet[3] ?? 0,
    1,
    packet[5] ?? 0,
    packet[24] ?? 0,
  ]);

test("real UDP correlates both rollover IDs and ignores stale/channel-only/count-mismatched replies", {
  timeout: 3000,
}, async () => {
  const received: Buffer[] = [];
  let previous: Buffer | undefined;
  await withUdpPeer(
    async (packet, source, peer) => {
      received.push(packet);
      assert.equal(packet.readUInt16BE(6), 15);
      assert.equal(packet.subarray(8, 23).toString(), identity);
      const good = ack(packet);
      for (const bad of [
        Buffer.from([0, 3, 0, 0, 1]),
        Buffer.from([0, 5, good[2] ?? 0, good[3] ?? 0, 1, good[5] ?? 0, 0]),
        Buffer.concat([good, Buffer.from([0])]),
      ])
        peer.send(bad, source.port, source.address);
      if (previous) peer.send(previous, source.port, source.address);
      previous = good;
      await delay(10);
      peer.send(good, source.port, source.address);
    },
    async (port) => {
      assert.deepEqual(await sendUdp([bytes, bytes], options(port)), {
        status: "acknowledged",
        recordCount: 2,
      });
    },
  );
  assert.deepEqual(
    received.map((p) => [p.readUInt16BE(2), p[5]]),
    [
      [65535, 255],
      [0, 0],
    ],
  );
  assert.deepEqual(received[0]?.subarray(23), bytes.subarray(8, -4));
});

test("wrong source port cannot acknowledge work and retry bytes remain frozen", {
  timeout: 3000,
}, async () => {
  const rogue = createSocket("udp4");
  rogue.bind(0, "127.0.0.1");
  await once(rogue, "listening");
  const received: Buffer[] = [];
  let completed = false;
  try {
    await withUdpPeer(
      async (packet, source, peer) => {
        received.push(Buffer.from(packet));
        rogue.send(ack(packet), source.port, source.address);
        if (received.length === 1) {
          await delay(25);
          assert.equal(completed, false);
          return;
        }
        assert.equal(received.length, 2);
        assert.deepEqual(packet, received[0]);
        peer.send(ack(packet), source.port, source.address);
      },
      async (port) => {
        const input = Buffer.from(bytes);
        const run = sendUdp([input], { ...options(port), maxAttempts: 2 });
        input.fill(0);
        assert.deepEqual(await run, { status: "acknowledged", recordCount: 1 });
        completed = true;
      },
    );
  } finally {
    rogue.close();
    await once(rogue, "close");
  }
  assert.equal(received.length, 2);
});

for (const kind of ["packet-id", "avl-id", "channel-only", "count"] as const) {
  test(`UDP refuses uncorrelated ${kind} without a false receipt`, {
    timeout: 3000,
  }, async () => {
    await withUdpPeer(
      async (packet, source, peer) => {
        const reply = ack(packet);
        if (kind === "packet-id") reply.writeUInt16BE(1, 2);
        else if (kind === "avl-id") reply[5] = 1;
        else if (kind === "count") reply[6] = 0;
        peer.send(
          kind === "channel-only" ? reply.subarray(0, 5) : reply,
          source.port,
          source.address,
        );
      },
      async (port) =>
        assert.rejects(sendUdp([bytes], options(port)), /^Error: ack-timeout$/),
    );
  });
}

test("UDP refuses product/Compose/public targets and bounds silence, cancellation and reply floods", {
  timeout: 3000,
}, async () => {
  for (const override of [
    { profile: "product" },
    { host: "tcp-ingestion" },
    { host: "192.0.2.1" },
  ])
    await assert.rejects(
      sendUdp([bytes], { ...options(1), ...override } as ReturnType<
        typeof options
      >),
      /invalid-session/,
    );
  await withUdpPeer(
    async () => {},
    async (port) => {
      await assert.rejects(
        sendUdp([bytes], { ...options(port), totalDeadlineMs: 40 }),
        /run-timeout/,
      );
      await assert.rejects(
        sendUdp([bytes], { ...options(port), signal: AbortSignal.timeout(20) }),
        /cancelled/,
      );
    },
  );
  await withUdpPeer(
    async (_packet, source, peer) => {
      for (let n = 0; n < 257; n++) {
        peer.send(Buffer.from([0]), source.port, source.address);
        await delay(1);
      }
    },
    async (port) =>
      assert.rejects(
        sendUdp([bytes], { ...options(port), ackDeadlineMs: 2000 }),
        /unexpected-reply/,
      ),
  );
});

test("UDP IPv6 carries the exact Extended batch count without a separate login", {
  timeout: 3000,
}, async () => {
  const { Codec8Frame } = await import("../../src/wire/codec8.ts");
  const { combineCodec8e } = await import("../../src/wire/codec8e.ts");
  const { variableFrame } = await import("../support/wire/codec8e-fixture.ts");
  const single = Codec8Frame.fromExtendedBytes(
    Buffer.from(variableFrame, "hex"),
  );
  const batch = combineCodec8e([single, single]);
  await withUdpPeer(
    async (packet, source, peer) => {
      assert.equal(packet[23], 0x8e);
      assert.equal(packet[24], 2);
      peer.send(ack(packet), source.port, source.address);
    },
    async (port) =>
      assert.deepEqual(
        await sendUdp([batch], { ...options(port), host: "::1" }),
        { status: "acknowledged", recordCount: 2 },
      ),
    "::1",
  );
});

test("UDP preflight and immediate abort leave no unowned binding attempt", async () => {
  for (const input of [[], Array(17).fill(bytes), [Buffer.alloc(0)]])
    await assert.rejects(sendUdp(input, options(1)), /invalid-session/);
  await assert.rejects(
    sendUdp([bytes], { ...options(1), packetId: 65536 }),
    /invalid-session/,
  );
  const controller = new AbortController();
  const pending = sendUdp([bytes], {
    ...options(1),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("a matching ACK from the correct port but wrong loopback address is ignored", {
  timeout: 3000,
}, async () => {
  let completed = false;
  await withUdpPeer(
    async (packet, source, peer) => {
      const other = createSocket("udp4");
      other.bind(peer.address().port, "127.0.0.2");
      await once(other, "listening");
      try {
        other.send(ack(packet), source.port, source.address);
        await delay(20);
        assert.equal(completed, false);
        peer.send(ack(packet), source.port, source.address);
      } finally {
        other.close();
        await once(other, "close");
      }
    },
    async (port) => {
      await sendUdp([bytes], options(port));
      completed = true;
    },
  );
});

test("UDP snapshots admitted options before asynchronous socket work", {
  timeout: 3000,
}, async () => {
  await withUdpPeer(
    async (packet, source, peer) => {
      peer.send(ack(packet), source.port, source.address);
    },
    async (port) => {
      const input = options(port);
      const pending = sendUdp([bytes], input);
      input.host = "127.0.0.2";
      input.port = 1;
      input.packetId = 0;
      input.avlPacketId = 0;
      assert.deepEqual(await pending, {
        status: "acknowledged",
        recordCount: 1,
      });
    },
  );
});
