import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runCli } from "../src/cli.ts";
import { crc16Arc, encodeCodec8 } from "../src/wire/codec8.ts";

const record = {
  schemaVersion: 1,
  timestampMs: String(0x16b40d8ea30),
  priority: 1,
  longitudeE7: 0,
  latitudeE7: 0,
  altitude: 0,
  angle: 0,
  satellites: 0,
  speed: 0,
  eventId: 1,
  io: [
    { id: 21, hex: "03" },
    { id: 1, hex: "01" },
    { id: 66, hex: "5e0f" },
    { id: 241, hex: "0000601a" },
    { id: 78, hex: "0000000000000000" },
  ],
};

// Teltonika Codec 8 over TCP, first worked example.
const frame =
  "000000000000003608010000016b40d8ea30010000000000000000000000000000000105021503010101425e0f01f10000601a014e0000000000000000010000c7cf";

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

test("CLI reads bounded files, redacts failures and writes private bytes once", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-codec8-"));
  try {
    const input = join(directory, "private-input");
    const output = join(directory, "private-output");
    const run = (...args: string[]) => {
      const messages: string[] = [];
      const status = runCli(args, (category) => messages.push(category));
      return {
        status,
        stderr: messages.map((message) => `${message}\n`).join(""),
      };
    };

    assert.equal(run("encode", input).stderr, "usage\n");
    assert.equal(
      run("validate", "--config", input).stderr,
      "input-unavailable\n",
    );
    assert.equal(
      run("validate", "--config", directory).stderr,
      "invalid-input-file\n",
    );
    for (const [contents, error] of [
      ["{private-value", "invalid-json"],
      [Buffer.from([0xff]), "invalid-json"],
      [JSON.stringify({ ...record, imei: "private-value" }), "invalid-record"],
      [" ".repeat(16 * 1024 + 1), "input-too-large"],
    ] as const) {
      writeFileSync(input, contents);
      const result = run("validate", "--config", input);
      assert.equal(result.status, 2);
      assert.equal(result.stderr, `${error}\n`);
    }
    writeFileSync(input, JSON.stringify(record));
    const validated = spawnSync(
      process.execPath,
      ["src/cli.ts", "validate", "--config", input],
      { encoding: "utf8" },
    );
    assert.equal(validated.status, 0);
    assert.equal(validated.stdout, "");
    assert.equal(validated.stderr, "");
    const encoded = run("encode", "--config", input, "--output", output);
    assert.equal(encoded.status, 0);
    assert.equal(readFileSync(output).toString("hex"), frame);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(
      run("encode", "--config", input, "--output", output).stderr,
      "output-unavailable\n",
    );
    assert.equal(readFileSync(output).toString("hex"), frame);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
