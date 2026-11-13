import assert from "node:assert/strict";
import test from "node:test";
import { Codec8Frame, RecordError } from "../src/wire/codec8.ts";
import { encodeAvlRecord, encodeCodec8e } from "../src/wire/codec8e.ts";
import { frame, record } from "./codec8-fixture.ts";
import { oracleCrc } from "./codec8-oracle.ts";
import {
  extended,
  extendedFrame,
  variableFrame,
  variableRecord,
} from "./codec8e-fixture.ts";

test("manufacturer Extended vector preserves widths and count fields", () => {
  assert.equal(encodeCodec8e(extended).toString("hex"), extendedFrame);
  assert.equal(encodeAvlRecord(record).toString("hex"), frame);
  assert.equal(
    encodeAvlRecord({ ...record, codec: "8" }).toString("hex"),
    frame,
  );
  assert.equal(
    encodeAvlRecord({ ...extended, codec: "8e" }).toString("hex"),
    extendedFrame,
  );
  assert.throws(
    () => encodeAvlRecord({ ...extended, codec: "8x" }),
    RecordError,
  );
  assert.throws(() => encodeAvlRecord(null), RecordError);
});

test("Extended validates profile and schema boundaries before allocation", () => {
  for (const patch of [
    { eventId: 65536 },
    { eventId: -1 },
    { timestampMs: "18446744073709551616" },
    { io: [{ id: 65536, hex: "01" }] },
    { io: [{ id: 1, hex: "010203" }] },
    { variableIo: [{ id: 1, hex: "" }] },
    { variableIo: [{ id: -1, hex: "01" }] },
    { variableIo: [{ id: 1, hex: "0" }] },
    { variableIo: [{ id: 1, hex: "xx" }] },
    { variableIo: [{ id: 1, hex: "00".repeat(257) }] },
    { variableIo: [{ id: 1, hex: "00" }] },
    { io: Array.from({ length: 65 }, (_, id) => ({ id, hex: "01" })) },
    {
      io: [],
      variableIo: Array.from({ length: 5 }, (_, id) => ({
        id,
        hex: "00".repeat(256),
      })),
    },
    { extra: true },
  ])
    assert.throws(() => encodeCodec8e({ ...extended, ...patch }), RecordError);
  const bounded = encodeCodec8e({
    ...extended,
    eventId: 65535,
    io: [],
    variableIo: [{ id: 65535, hex: "ab".repeat(256) }],
  });
  assert.equal(bounded.readUInt16BE(34), 65535);
  assert.equal(bounded.readUInt16BE(46), 1);
  assert.equal(bounded.readUInt16BE(48), 65535);
  assert.equal(bounded.readUInt16BE(50), 256);
  assert.deepEqual(bounded.subarray(52, -5), Buffer.alloc(256, 0xab));
});

test("Extended frame admission is explicit and preserves snapshot ownership", () => {
  const bytes = encodeCodec8e(extended);
  assert.throws(() => Codec8Frame.fromBytes(bytes), /invalid-frame/);
  assert.throws(
    () => Codec8Frame.fromExtendedBytes(Buffer.from(frame, "hex")),
    /invalid-frame/,
  );
  const owned = Codec8Frame.fromExtendedBytes(bytes);
  bytes.fill(0);
  assert.equal(owned.recordCount, 1);
  assert.equal(owned.snapshot().bytes.toString("hex"), extendedFrame);
  assert.equal(
    Codec8Frame.snapshot(Buffer.from(extendedFrame, "hex")).recordCount,
    1,
  );
});

test("Extended rejects malformed raw IO even with a valid envelope and CRC", () => {
  for (const [offset, value] of [
    [36, 6],
    [38, 65],
    [42, 65535],
    [79, 1],
  ] as const) {
    const bytes = Buffer.from(extendedFrame, "hex");
    bytes.writeUInt16BE(value, offset);
    bytes.writeUInt32BE(oracleCrc(bytes.subarray(8, -4)), bytes.length - 4);
    assert.throws(
      () => Codec8Frame.fromExtendedBytes(bytes),
      /invalid-frame/,
      `offset ${offset}`,
    );
  }
});

test("independent NX vector preserves leading zeros, wide IDs and variable length", () => {
  assert.equal(encodeCodec8e(variableRecord).toString("hex"), variableFrame);
  const bytes = Buffer.from(variableFrame, "hex");
  assert.equal(oracleCrc(bytes.subarray(8, -4)), 0x7c8e);
  assert.equal(Codec8Frame.fromExtendedBytes(bytes).recordCount, 1);
  const full = {
    ...extended,
    io: Array.from({ length: 64 }, (_, id) => ({ id: id + 256, hex: "01" })),
    variableIo: [],
  };
  assert.equal(encodeCodec8e(full).readUInt16BE(38), 64);
  assert.doesNotThrow(() => Codec8Frame.fromExtendedBytes(encodeCodec8e(full)));
  for (const [offset, value] of [
    [54, 0],
    [54, 257],
    [50, 65535],
  ] as const) {
    const damaged = Buffer.from(variableFrame, "hex");
    damaged.writeUInt16BE(value, offset);
    damaged.writeUInt32BE(
      oracleCrc(damaged.subarray(8, -4)),
      damaged.length - 4,
    );
    assert.throws(
      () => Codec8Frame.fromExtendedBytes(damaged),
      /invalid-frame/,
    );
  }
});

test("short variable values stay in NX and raw IDs cannot repeat", () => {
  const value = {
    ...extended,
    io: [],
    variableIo: [
      { id: 500, hex: "0000000000000001" },
      { id: 501, hex: "00" },
      { id: 502, hex: "00000001" },
      { id: 503, hex: "0001" },
    ],
  };
  const bytes = encodeCodec8e(value);
  assert.equal(
    bytes.subarray(38, -5).toString("hex"),
    "0000000000000000000401f40008000000000000000101f500010001f600040000000101f700020001",
  );
  assert.doesNotThrow(() => Codec8Frame.fromExtendedBytes(bytes));
  // The second NX ID aliases the first; retain a valid CRC to isolate admission.
  bytes.writeUInt16BE(500, 60);
  bytes.writeUInt32BE(oracleCrc(bytes.subarray(8, -4)), bytes.length - 4);
  assert.throws(() => Codec8Frame.fromExtendedBytes(bytes), /invalid-frame/);
});
