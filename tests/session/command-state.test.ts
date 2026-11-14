import assert from "node:assert/strict";
import test from "node:test";
import { CommandFixture } from "../../src/session/command.ts";
import { getinfo } from "../support/peers/command-peer.ts";

test("command policy rejects wrong state, bounds fragments and replies once after AVL ACK", () => {
  const state = new CommandFixture();
  assert.throws(() => state.receive(getinfo), /invalid-command/);
  const active = new CommandFixture();
  active.avlAcknowledged();
  assert.equal(active.receive(getinfo.subarray(0, 7)), null);
  const response = active.receive(getinfo.subarray(7));
  assert.equal(response?.[10], 6);
  assert.equal(
    response?.subarray(15, -5).toString("ascii"),
    "SIMULATOR:read-only",
  );
  assert.throws(() => active.receive(getinfo), /invalid-command/);
  assert.throws(() => active.avlAcknowledged(), /invalid-command/);
  for (const chunk of [
    Buffer.alloc(28),
    Buffer.from("000000007fffffff", "hex"),
  ]) {
    const bad = new CommandFixture();
    bad.avlAcknowledged();
    assert.throws(() => bad.receive(chunk), /invalid-command/);
    assert.throws(() => bad.receive(getinfo), /invalid-command/);
  }
});
