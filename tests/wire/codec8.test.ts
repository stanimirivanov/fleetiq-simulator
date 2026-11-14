import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Codec8Frame,
  crc16Arc,
  encodeCodec8,
  encodeCodec8Payload,
  type Record8,
  recordSchema,
} from "../../src/wire/codec8.ts";
import { frame, record } from "../support/wire/codec8-fixture.ts";

test("encodes Teltonika's literal frame and CRC-16/ARC check value", () => {
  assert.equal(encodeCodec8(record).toString("hex"), frame);
  assert.equal(crc16Arc(Buffer.from("123456789")), 0xbb3d);
});

test("preserves unsigned 64-bit bytes and signed coordinates at their limits", () => {
  const packet = encodeCodec8({
    ...record,
    timestampMs: "18446744073709551615",
    longitudeE7: -1800000000,
    latitudeE7: 900000000,
    altitude: 65535,
    io: [{ id: 255, hex: "ffffffffffffffff" }],
  });
  assert.equal(
    packet.subarray(10, 34).toString("hex"),
    "ffffffffffffffff0194b62e0035a4e900ffff0000000000",
  );
  assert.equal(
    packet.subarray(34, -4).toString("hex"),
    "010100000001ffffffffffffffffff01",
  );
});

test("rejects invalid ranges, unknown keys, widths and counts", () => {
  for (const patch of [
    { schemaVersion: 2 },
    { timestampMs: "18446744073709551616" },
    { timestampMs: "1\n" },
    { timestampMs: 9007199254740992 },
    { priority: 3 },
    { longitudeE7: -1800000001 },
    { latitudeE7: 900000001 },
    { altitude: -1 },
    { angle: 361 },
    { speed: 65536 },
    { satellites: 1.5 },
    { io: [{ id: 256, hex: "00" }] },
    { io: [{ id: 1, hex: "abc" }] },
    { io: [{ id: 1, hex: "000000" }] },
    { io: [{ id: 1, hex: "aa\n" }] },
    { io: [{ id: 1, hex: "aa", extra: true }] },
    { io: Array.from({ length: 65 }, (_, id) => ({ id, hex: "aa" })) },
    { imei: "private-value" },
  ]) {
    assert.throws(
      () => encodeCodec8({ ...record, ...patch }),
      /^Error: invalid-record$/,
    );
  }
  const full = Array.from({ length: 64 }, (_, id) => ({ id, hex: "aabbccdd" }));
  assert.equal(encodeCodec8({ ...record, io: full })[35], 64);
});

test("the typed record fixture covers every required schema property", () => {
  const typed = { ...record, schemaVersion: 1 } satisfies Record8;
  assert.deepEqual(
    Object.keys(recordSchema.properties).sort(),
    Object.keys(typed).sort(),
  );
  assert.deepEqual(
    [...recordSchema.required].sort(),
    Object.keys(typed).sort(),
  );
  assert.equal(encodeCodec8(typed).toString("hex"), frame);
});

test("wire frame metadata stays tied to its private byte snapshot", () => {
  const source = Buffer.from(frame, "hex");
  const frozen = Codec8Frame.fromBytes(source);
  source.fill(0);
  assert.equal(frozen.recordCount, 1);
  const exposed = frozen.snapshot();
  assert.equal(exposed.bytes.toString("hex"), frame);
  new Uint8Array(exposed.bytes.buffer).fill(0);
  exposed.recordCount = 99;
  assert.equal(frozen.recordCount, 1);
  assert.equal(frozen.snapshot().bytes.toString("hex"), frame);
  assert.equal(
    encodeCodec8Payload(record).toString("hex"),
    frame.slice(16, -8),
  );
});

test("wire validates the single-record TCP envelope before exposing metadata", () => {
  const good = Buffer.from(frame, "hex");
  for (const offset of [0, 4, 8, 9, good.length - 5, good.length - 1]) {
    const damaged = Buffer.from(good);
    damaged[offset] = (damaged[offset] ?? 0) ^ 1;
    assert.throws(
      () => Codec8Frame.fromBytes(damaged),
      /^Error: invalid-frame$/,
    );
  }
  for (const damaged of [Buffer.alloc(0), Buffer.alloc(1281)]) {
    assert.throws(
      () => Codec8Frame.fromBytes(damaged),
      /^Error: invalid-frame$/,
    );
  }
});

test("frame metadata rejects fabricated brands and a checksum-valid two-record declaration", () => {
  for (const fabricated of [
    Object.create(Codec8Frame.prototype),
    Object.create(null),
  ]) {
    assert.throws(
      () => Codec8Frame.snapshot(fabricated),
      /^Error: invalid-frame$/,
    );
  }
  const two = Buffer.from(frame, "hex");
  two[9] = 2;
  two[two.length - 5] = 2;
  two.writeUInt32BE(crc16Arc(two.subarray(8, -4)), two.length - 4);
  assert.throws(() => Codec8Frame.fromBytes(two), /^Error: invalid-frame$/);
});
