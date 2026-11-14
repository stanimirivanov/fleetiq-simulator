import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandError,
  decodeGetinfo,
  encodeCommandResponse,
} from "../../src/wire/codec12.ts";
import {
  getinfo,
  manufacturerInfo,
  manufacturerResponse,
} from "../support/peers/command-peer.ts";
import { oracleCrc } from "../support/wire/codec8-oracle.ts";

test("Codec 12 validates manufacturer getinfo and encodes the literal type 06 response", () => {
  assert.equal(decodeGetinfo(getinfo), "getinfo");
  assert.deepEqual(
    encodeCommandResponse(manufacturerInfo),
    manufacturerResponse,
  );
  assert.equal(oracleCrc(getinfo.subarray(8, -4)), 0x4312);
  assert.equal(oracleCrc(manufacturerResponse.subarray(8, -4)), 0xc78f);
});

test("Codec 12 rejects corrupt framing, unsupported commands and invalid response text", () => {
  for (let length = 0; length < getinfo.length; length++)
    assert.throws(
      () => decodeGetinfo(getinfo.subarray(0, length)),
      CommandError,
    );
  for (const offset of [0, 4, 8, 9, 10, 11, 15, 22, 25]) {
    const bad = Buffer.from(getinfo);
    bad[offset] = (bad[offset] ?? 0) ^ 1;
    if (offset !== 25)
      bad.writeUInt32BE(oracleCrc(bad.subarray(8, -4)), bad.length - 4);
    assert.throws(() => decodeGetinfo(bad), CommandError);
  }
  assert.throws(
    () => decodeGetinfo(Buffer.concat([getinfo, getinfo])),
    CommandError,
  );
  for (const text of ["", "x".repeat(257), "secret\n", "é"])
    assert.throws(() => encodeCommandResponse(text), CommandError);
});
