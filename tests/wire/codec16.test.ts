import assert from "node:assert/strict";
import test from "node:test";
import { RecordError } from "../../src/wire/codec8.ts";
import { encodeCodec16 } from "../../src/wire/codec16.ts";
import { record16, single16 } from "../support/wire/codec16-fixture.ts";

test("Codec 16 matches the literal manufacturer record with one-byte total", () => {
  assert.equal(encodeCodec16(record16).toString("hex"), single16);
});

test("Codec 16 requires the provisional profile and rejects invalid or ambiguous input", () => {
  for (const patch of [
    { profile: "fmb920" },
    { profile: undefined },
    { generationType: undefined },
    { generationType: 3 },
    { generationType: -1 },
    { generationType: 8 },
    { generationType: 1.5 },
    { eventId: 65536 },
    { eventId: -1 },
    { timestampMs: "18446744073709551616" },
    { variableIo: [] },
    { totalIo: 4 },
    { io: [{ id: 65536, hex: "00" }] },
    { io: [{ id: 1, hex: "000000" }] },
    { io: [{ id: 1, hex: "xx" }] },
    {
      io: [
        { id: 1, hex: "00" },
        { id: 1, hex: "0000" },
      ],
    },
    { io: Array.from({ length: 65 }, (_, id) => ({ id, hex: "00" })) },
    {
      io: Array.from({ length: 21 }, (_, id) => ({ id, hex: "00".repeat(8) })),
    },
  ])
    assert.throws(() => encodeCodec16({ ...record16, ...patch }), RecordError);
  for (const value of [null, [], 1, Object.create(record16)])
    assert.throws(() => encodeCodec16(value), RecordError);
});

test("manufacturer and Traccar-derived reference agree; contradictory total fails", async () => {
  const { reference16 } = await import("../support/wire/codec16-reference.ts");
  const { manufacturer16 } = await import("../support/wire/codec16-fixture.ts");
  const { oracleCrc } = await import("../support/wire/codec8-oracle.ts");
  const original = Buffer.from(manufacturer16, "hex");
  assert.equal(original.readUInt32BE(4), original.length - 12);
  assert.equal(oracleCrc(original.subarray(8, -4)), 0x5fb3);
  const records = reference16(original.subarray(8, -4));
  assert.equal(records.length, 2);
  assert.deepEqual(records[0]?.io, record16.io);
  assert.equal(records[1]?.io[2]?.hex, "0026");
  const encoded = encodeCodec16(record16);
  assert.deepEqual(reference16(encoded.subarray(8, -4)), [records[0]]);
  assert.deepEqual(encoded.subarray(10, -5), original.subarray(10, 56));
  const contradictory = Buffer.concat([
    encoded.subarray(8, 37),
    Buffer.from([0]),
    encoded.subarray(37, -4),
  ]);
  assert.throws(() => reference16(contradictory));
  const wrongTotal = Buffer.from(encoded.subarray(8, -4));
  wrongTotal[29] = 5;
  assert.throws(() => reference16(wrongTotal));
});

test("Codec 16 preserves full-width identifiers and fixed values for every generation", async () => {
  const { reference16 } = await import("../support/wire/codec16-reference.ts");
  const { oracleCrc } = await import("../support/wire/codec8-oracle.ts");
  for (const generationType of [0, 1, 2, 4, 5, 6, 7]) {
    const io = [
      { id: 256, hex: "01" },
      { id: 65535, hex: "0001" },
      { id: 300, hex: "80000000" },
      { id: 65534, hex: "ffffffffffffffff" },
    ];
    const frame = encodeCodec16({
      ...record16,
      eventId: 65535,
      generationType,
      io,
    });
    const decoded = reference16(frame.subarray(8, -4))[0];
    assert.equal(decoded?.eventId, 65535);
    assert.equal(decoded?.generationType, generationType);
    assert.deepEqual(decoded?.io, io);
    assert.equal(
      frame.readUInt32BE(frame.length - 4),
      oracleCrc(frame.subarray(8, -4)),
    );
  }
  for (const io of [
    [],
    Array.from({ length: 64 }, (_, id) => ({ id, hex: "00" })),
    Array.from({ length: 20 }, (_, id) => ({ id, hex: "00".repeat(8) })),
  ]) {
    const frame = encodeCodec16({
      ...record16,
      io,
      timestampMs: "18446744073709551615",
    });
    assert.deepEqual(reference16(frame.subarray(8, -4))[0]?.io, io);
  }
});
