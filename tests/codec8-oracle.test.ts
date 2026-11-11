import assert from "node:assert/strict";
import { test } from "node:test";
import { Codec8Frame, encodeCodec8, type Record8 } from "../src/wire/codec8.ts";
import { decodeSingleRecord, oracleCrc } from "./codec8-oracle.ts";
import { singleRecordVectors, twoRecordVector } from "./codec8-vectors.ts";

function normalized(record: Record8): Record8 {
  return {
    ...record,
    io: record.io
      .map(({ id, hex }) => ({ id, hex: hex.toLowerCase() }))
      .sort((a, b) => a.hex.length - b.hex.length),
  };
}

// Fixed-seed generation is reproducible without a new dependency or live data.
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

// Vary field boundaries independently of IO cardinality. Reverse IO entries
// so the encoder must regroup widths while preserving order within each width.
function generatedRecord(index: number, next: () => number): Record8 {
  const io = Array.from(
    { length: [0, 1, 4, 64][(index >>> 2) % 4] ?? 0 },
    (_, item) => {
      const width = [1, 2, 4, 8][item % 4] ?? 1;
      const hex = Array.from({ length: width }, () =>
        (next() & 255).toString(16).padStart(2, "0"),
      ).join("");
      return { id: 255 - item, hex: item % 2 ? hex.toUpperCase() : hex };
    },
  ).reverse();
  return {
    schemaVersion: 1,
    timestampMs:
      [
        "0",
        "18446744073709551615",
        "9007199254740993",
        String((BigInt(next()) << 32n) | BigInt(next())),
      ][index % 4] ?? "0",
    priority: index % 3,
    longitudeE7:
      [-1800000000, 0, 1800000000, (next() % 3600000001) - 1800000000][
        index % 4
      ] ?? 0,
    latitudeE7:
      [-900000000, 900000000, 0, (next() % 1800000001) - 900000000][
        index % 4
      ] ?? 0,
    altitude: [0, 65535, next() % 65536][index % 3] ?? 0,
    angle: [0, 360, next() % 361][index % 3] ?? 0,
    satellites: [0, 255, next() % 256][index % 3] ?? 0,
    speed: [0, 65535, next() % 65536][index % 3] ?? 0,
    eventId: [0, 255, next() % 256][index % 3] ?? 0,
    io,
  };
}

function reseal(frame: Buffer): Buffer {
  frame.writeUInt32BE(oracleCrc(frame.subarray(8, -4)), frame.length - 4);
  return frame;
}

test("independent oracle and encoder agree with both single-record manufacturer vectors", () => {
  assert.equal(oracleCrc(Buffer.from("123456789")), 0xbb3d);
  for (const vector of singleRecordVectors) {
    assert.deepEqual(
      decodeSingleRecord(Buffer.from(vector.frame, "hex")),
      vector.record,
    );
    assert.equal(encodeCodec8(vector.record).toString("hex"), vector.frame);
  }
  const multiRecord = Buffer.from(twoRecordVector, "hex");
  assert.equal(
    oracleCrc(multiRecord.subarray(8, -4)),
    multiRecord.readUInt32BE(multiRecord.length - 4),
  );
  assert.throws(
    () => decodeSingleRecord(Buffer.from(twoRecordVector, "hex")),
    /oracle-invalid-frame/,
  );
  assert.throws(
    () => Codec8Frame.fromBytes(Buffer.from(twoRecordVector, "hex")),
    /invalid-frame/,
  );
});

test("independent oracle round trips deterministic field limits and every IO width", () => {
  for (const seed of [1, 0x8badf00d]) {
    const next = generator(seed);
    for (let index = 0; index < 128; index++) {
      const record = generatedRecord(index, next);
      const encoded = encodeCodec8(record);
      assert.deepEqual(
        decodeSingleRecord(encoded),
        normalized(record),
        `seed=${seed} case=${index}`,
      );
      assert.deepEqual(
        Codec8Frame.fromBytes(encoded).snapshot().bytes,
        encoded,
      );
    }
  }
});

test("oracle rejects every truncated prefix, trailing bytes and every single-bit corruption", () => {
  for (const { frame } of singleRecordVectors) {
    const bytes = Buffer.from(frame, "hex");
    for (let end = 0; end < bytes.length; end++)
      assert.throws(
        () => decodeSingleRecord(bytes.subarray(0, end)),
        /oracle-invalid-frame/,
      );
    assert.throws(
      () => decodeSingleRecord(Buffer.concat([bytes, Buffer.from([0])])),
      /oracle-invalid-frame/,
    );
    for (let position = 0; position < bytes.length; position++) {
      for (let bit = 0; bit < 8; bit++) {
        const damaged = Buffer.from(bytes);
        damaged[position] = (damaged[position] ?? 0) ^ (1 << bit);
        assert.throws(
          () => decodeSingleRecord(damaged),
          /oracle-invalid-frame/,
          `byte=${position} bit=${bit}`,
        );
      }
    }
  }
});

test("oracle parses IO totals, groups and cursor bounds even with a valid checksum", () => {
  const vector = singleRecordVectors[0];
  assert.ok(vector);
  for (const [offset, value] of [
    [8, 0x8e],
    [9, 2],
    [18, 3],
    [19, 0x80],
    [23, 0x80],
    [29, 2],
    [35, 4],
    [36, 255],
    [41, 255],
    [45, 255],
    [51, 255],
  ] as const) {
    const damaged = Buffer.from(vector.frame, "hex");
    damaged[offset] = value;
    assert.throws(
      () => decodeSingleRecord(reseal(damaged)),
      /oracle-invalid-frame/,
    );
  }
  const mismatched = Buffer.from(vector.frame, "hex");
  mismatched[mismatched.length - 5] = 2;
  assert.throws(
    () => decodeSingleRecord(reseal(mismatched)),
    /oracle-invalid-frame/,
  );
  const truncated = Buffer.from(
    `${vector.frame.slice(0, -12)}0100000000`,
    "hex",
  );
  truncated.writeUInt32BE(truncated.length - 12, 4);
  assert.throws(
    () => decodeSingleRecord(reseal(truncated)),
    /oracle-invalid-frame/,
  );
});
