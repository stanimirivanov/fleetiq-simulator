import assert from "node:assert/strict";
import { test } from "node:test";
import { planFaults } from "../../src/scenarios/faults.ts";
import { Codec8Frame, crc16Arc } from "../../src/wire/codec8.ts";
import { encodeCodec8e } from "../../src/wire/codec8e.ts";
import { identity } from "../support/peers/peer.ts";
import { frame } from "../support/wire/codec8-fixture.ts";
import { extended, variableRecord } from "../support/wire/codec8e-fixture.ts";

const spec = (actions: unknown[]) => ({
  schemaVersion: 1,
  authorizedLocalTarget: true,
  actions,
});

test("fault ordinals freeze exact CRC/truncation/split/duplicate bytes without changing valid frames", () => {
  const source = Buffer.from(frame, "hex");
  const original = Buffer.from(source);
  const input = spec([
    { packet: 1, kind: "corrupt-crc" },
    { packet: 2, kind: "truncate-close", offset: 11 },
    { packet: 3, kind: "split-write", offset: 7 },
    { packet: 4, kind: "duplicate-record" },
  ]);
  const result = planFaults([source, source, source, source], input, identity);
  assert.equal(result.length, 5);
  const corrupt = Buffer.from(original);
  corrupt.writeUInt8(
    corrupt.readUInt8(corrupt.length - 1) ^ 1,
    corrupt.length - 1,
  );
  assert.deepEqual(
    result.map((p) => p.bytes),
    [corrupt, original.subarray(0, 11), original, original, original],
  );
  assert.equal(result[2]?.splitAt, 7);
  assert.deepEqual(
    result.map((p) => p.ordinal),
    [1, 2, 3, 4, 4],
  );
  assert.deepEqual(
    result.map((p) => p.deny),
    [true, true, false, false, false],
  );
  assert.deepEqual(
    planFaults([source, source, source, source], input, identity),
    result,
  );
  source.fill(0);
  assert.deepEqual(result[4]?.bytes, original);
});

test("late timestamps preserve every other record byte and repair the valid frame CRC", () => {
  const source = Buffer.from(frame, "hex");
  const result = planFaults(
    [source],
    spec([{ packet: 1, kind: "late-event-time", timestampMs: "1" }]),
    identity,
  )[0];
  assert(result);
  assert.equal(result.bytes.readBigUInt64BE(10), 1n);
  assert.deepEqual(result.bytes.subarray(18, -4), source.subarray(18, -4));
  assert.equal(
    result.bytes.readUInt32BE(result.bytes.length - 4),
    crc16Arc(result.bytes.subarray(8, -4)),
  );
  assert.doesNotThrow(() => Codec8Frame.snapshot(result.bytes));
  assert.notDeepEqual(result.bytes, source);
});

test("unregistered identities and explicit disconnects target only their scheduled packet", () => {
  const source = Buffer.from(frame, "hex");
  const other = "12345".repeat(3);
  const result = planFaults(
    [source, source, source],
    spec([
      { packet: 1, kind: "unregistered-identity" },
      { packet: 2, kind: "disconnect-before-write" },
      { packet: 3, kind: "disconnect-after-write" },
    ]),
    identity,
    other,
  );
  assert.equal(result[0]?.identity, other);
  assert.equal(result[0]?.deny, true);
  assert.deepEqual(
    result.map((p) => p.disconnect),
    [null, "before", "after"],
  );
  assert.equal(result[1]?.identity, identity);
});

test("fault admission refuses missing authorization, ambiguous actions, bad offsets/ordinals and private identity mistakes", () => {
  const source = Buffer.from(frame, "hex");
  for (const input of [
    {},
    { ...spec([]), authorizedLocalTarget: false },
    spec([]),
    spec([{ packet: 0, kind: "corrupt-crc" }]),
    spec([{ packet: 2, kind: "corrupt-crc" }]),
    spec([{ packet: 1, kind: "corrupt-crc", secret: "private-value" }]),
    spec([{ packet: 1, kind: "split-write", offset: source.length }]),
    spec([{ packet: 1, kind: "truncate-close", offset: 0 }]),
    spec([
      {
        packet: 1,
        kind: "late-event-time",
        timestampMs: "18446744073709551616",
      },
    ]),
    spec([
      {
        packet: 1,
        kind: "late-event-time",
        timestampMs: source.readBigUInt64BE(10).toString(),
      },
    ]),
    spec([
      { packet: 1, kind: "corrupt-crc" },
      { packet: 1, kind: "duplicate-record" },
    ]),
    spec([{ packet: 1, kind: "unregistered-identity" }]),
  ])
    assert.throws(
      () => planFaults([source], input, identity),
      /^Error: invalid-faults$/,
    );
  assert.throws(
    () => planFaults([], spec([{ packet: 1, kind: "corrupt-crc" }]), identity),
    /invalid-faults/,
  );
  assert.throws(
    () =>
      planFaults(
        Array(17).fill(source),
        spec([{ packet: 1, kind: "corrupt-crc" }]),
        identity,
      ),
    /invalid-faults/,
  );
  assert.throws(
    () =>
      planFaults(
        [source],
        spec([{ packet: 1, kind: "corrupt-crc" }]),
        "private",
      ),
    /invalid-faults/,
  );
  assert.throws(
    () =>
      planFaults(
        [source],
        spec([{ packet: 1, kind: "unregistered-identity" }]),
        identity,
        identity,
      ),
    /invalid-faults/,
  );
  assert.throws(
    () =>
      planFaults(
        [Buffer.alloc(2)],
        spec([{ packet: 1, kind: "corrupt-crc" }]),
        identity,
      ),
    /invalid-faults/,
  );
});

test("fault plans retain unselected Extended NX records and strictly admit decimal fields", () => {
  const a = encodeCodec8e(extended);
  const b = encodeCodec8e({ ...variableRecord, timestampMs: "2" });
  const result = planFaults(
    [a, b],
    spec([{ packet: 2, kind: "late-event-time", timestampMs: "1" }]),
    identity,
  );
  assert.deepEqual(result[0]?.bytes, a);
  assert.equal(result[1]?.bytes.readBigUInt64BE(10), 1n);
  assert.doesNotThrow(() =>
    Codec8Frame.snapshot(result[1]?.bytes ?? Buffer.alloc(0)),
  );
  for (const value of ["1\n", " 1", "-1"]) {
    assert.throws(
      () =>
        planFaults(
          [b],
          spec([{ packet: 1, kind: "late-event-time", timestampMs: value }]),
          identity,
        ),
      /invalid-faults/,
    );
  }
  assert.throws(
    () =>
      planFaults(
        [a],
        spec([{ packet: 1, kind: "corrupt-crc" }]),
        `${identity}\n`,
      ),
    /invalid-faults/,
  );
  assert.throws(
    () =>
      planFaults(
        [a],
        spec([{ packet: 1, kind: "unregistered-identity" }]),
        identity,
        "x".repeat(15),
      ),
    /invalid-faults/,
  );
});
