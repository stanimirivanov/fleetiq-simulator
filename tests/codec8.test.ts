import assert from "node:assert/strict";
import { test } from "node:test";
import { crc16Arc, encodeCodec8 } from "../src/wire/codec8.ts";
import { frame, record } from "./codec8-fixture.ts";

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
