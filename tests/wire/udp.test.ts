import assert from "node:assert/strict";
import { test } from "node:test";
import { Codec8Frame } from "../../src/wire/codec8.ts";
import { combineCodec8e } from "../../src/wire/codec8e.ts";
import { encodeUdp, matchesUdpAck, udpIds } from "../../src/wire/udp.ts";
import { identity } from "../support/peers/peer.ts";
import { frame } from "../support/wire/codec8-fixture.ts";
import { variableFrame } from "../support/wire/codec8e-fixture.ts";

// Manufacturer TCP worked-example AVL body, independently placed in its documented UDP layout.
// Identity is synthetic ASCII; no TCP preamble/length/CRC belongs in this expected datagram.
const literal =
  "004bcafe0105000f" +
  "3031323334".repeat(3) +
  "08010000016b40d8ea30010000000000000000000000000000000105021503010101425e0f01f10000601a014e000000000000000001";

test("UDP encodes literal channel length, IDs, ASCII identity and raw AVL body without TCP framing", () => {
  const input = Buffer.from(frame, "hex");
  const packet = encodeUdp(input, identity, 0xcafe, 5);
  assert.equal(packet.bytes.toString("hex"), literal);
  assert.equal(packet.recordCount, 1);
  assert.equal(packet.bytes.readUInt16BE(), packet.bytes.length - 2);
  input.fill(0);
  assert.equal(packet.bytes.toString("hex"), literal);
  const extended = combineCodec8e([
    Codec8Frame.fromExtendedBytes(Buffer.from(variableFrame, "hex")),
    Codec8Frame.fromExtendedBytes(Buffer.from(variableFrame, "hex")),
  ]);
  const datagram = encodeUdp(extended, identity, 0, 255);
  assert.equal(datagram.bytes[23], 0x8e);
  assert.equal(datagram.recordCount, 2);
  assert.deepEqual(
    datagram.bytes.subarray(23),
    extended.snapshot().bytes.subarray(8, -4),
  );
});

test("UDP ACK correlation rejects channel-only, truncated, surplus, wrong length/flag/IDs/count replies", () => {
  assert.equal(
    matchesUdpAck(Buffer.from("0005cafe010500", "hex"), 0xcafe, 5, 0),
    false,
  );
  assert.equal(
    matchesUdpAck(Buffer.from("0005cafe010501", "hex"), 0xcafe, 5, 1),
    true,
  );
  for (const hex of [
    "",
    "0003cafe01",
    "0005cafe0105",
    "0005cafe01050100",
    "0004cafe010501",
    "0005cafe000501",
    "0005caff010501",
    "0005cafe010601",
    "0005cafe010500",
  ])
    assert.equal(matchesUdpAck(Buffer.from(hex, "hex"), 0xcafe, 5, 1), false);
});

test("UDP IDs roll over together without reusing a pair in a bounded sequence and bad admission is fixed-category", () => {
  assert.deepEqual(udpIds(65535, 255, 0), {
    packetId: 65535,
    avlPacketId: 255,
  });
  assert.deepEqual(udpIds(65535, 255, 1), { packetId: 0, avlPacketId: 0 });
  assert.deepEqual(udpIds(65535, 255, 255), {
    packetId: 254,
    avlPacketId: 254,
  });
  for (const args of [
    [-1, 0, 0],
    [65536, 0, 0],
    [0, 256, 0],
    [0, 0, 65536],
    [0, 0, 0.5],
    [0, 0, NaN],
  ] as const)
    assert.throws(() => udpIds(args[0], args[1], args[2]), /invalid-udp/);
  for (const value of ["", `${identity}\n`, "x".repeat(15)])
    assert.throws(
      () => encodeUdp(Buffer.from(frame, "hex"), value, 0, 0),
      /invalid-udp/,
    );
  assert.throws(
    () => encodeUdp(Buffer.alloc(4), identity, 0, 0),
    /invalid-udp/,
  );
});
