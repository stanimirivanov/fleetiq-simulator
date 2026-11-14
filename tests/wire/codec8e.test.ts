import assert from "node:assert/strict";
import test from "node:test";
import { Codec8Frame, RecordError } from "../../src/wire/codec8.ts";
import {
  combineCodec8e,
  encodeAvlRecord,
  encodeCodec8e,
} from "../../src/wire/codec8e.ts";
import { frame, record } from "../support/wire/codec8-fixture.ts";
import { oracleCrc } from "../support/wire/codec8-oracle.ts";
import {
  extended,
  extendedFrame,
  variableFrame,
  variableRecord,
} from "../support/wire/codec8e-fixture.ts";

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

test("multi-record Extended assembly preserves literal bodies and independently checked CRC", () => {
  const single = Codec8Frame.fromExtendedBytes(
    Buffer.from(variableFrame, "hex"),
  );
  const batch = combineCodec8e([single, single]);
  const bytes = batch.snapshot().bytes;
  assert.equal(bytes.length, 117);
  assert.equal(bytes[9], 2);
  assert.equal(bytes[112], 2);
  assert.equal(
    bytes.subarray(10, -5).toString("hex"),
    variableFrame.slice(20, -10).repeat(2),
  );
  assert.equal(bytes.readUInt32BE(113), oracleCrc(bytes.subarray(8, -4)));
  assert.equal(Codec8Frame.snapshot(bytes).recordCount, 2);
  assert.throws(() => Codec8Frame.fromExtendedBytes(bytes), /invalid-frame/);
  for (const values of [
    [],
    Array(17).fill(single),
    [Codec8Frame.fromBytes(Buffer.from(frame, "hex"))],
  ])
    assert.throws(() => combineCodec8e(values));
  const large = Codec8Frame.fromExtendedBytes(
    encodeCodec8e({
      ...extended,
      io: [],
      variableIo: [{ id: 1, hex: "00".repeat(256) }],
    }),
  );
  assert.throws(() => combineCodec8e(Array(16).fill(large)));
  const edge = (length: number) =>
    Codec8Frame.fromExtendedBytes(
      encodeCodec8e({
        ...extended,
        io: [],
        variableIo: [
          { id: 1, hex: "00".repeat(256) },
          { id: 2, hex: "00".repeat(length) },
        ],
      }),
    );
  assert.equal(
    combineCodec8e([large, large, large, edge(69)]).snapshot().bytes.length,
    1280,
  );
  assert.throws(
    () => combineCodec8e([large, large, large, edge(70)]),
    RecordError,
  );
  const sixteen = combineCodec8e(Array(16).fill(single));
  assert.equal(sixteen.recordCount, 16);
  for (const count of [0, 3, 17]) {
    const wrong = Buffer.from(bytes);
    wrong[9] = count;
    wrong[112] = count;
    wrong.writeUInt32BE(oracleCrc(wrong.subarray(8, -4)), 113);
    assert.throws(
      () => Codec8Frame.fromExtendedBatchBytes(wrong),
      /invalid-frame/,
    );
  }
});
