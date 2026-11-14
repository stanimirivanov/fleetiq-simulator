import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionLimits } from "../../src/session/state.ts";
import { sendBatches } from "../../src/transport/tcp.ts";
import { identity } from "../support/peers/peer.ts";

// Published Teltonika TCP Codec 8 example, one record.
const frame = Buffer.from(
  "000000000000002808010000016b40d9ad80010000000000000000000000000000000103021503010101425e100000010000f22a",
  "hex",
);

function options(port: number) {
  return {
    host: "127.0.0.1",
    port,
    identity,
    ackDeadlineMs: 150,
    totalDeadlineMs: 2_000,
    maxAttempts: 1,
  } as const;
}

test("validates session bounds before connecting and measures one absolute run budget", async () => {
  const settings = options(1);
  for (const patch of [
    { host: "localhost" },
    { port: 65536 },
    { identity: "wrong" },
    { ackDeadlineMs: 99 },
    { totalDeadlineMs: 86400001 },
    { maxAttempts: 0 },
  ]) {
    await assert.rejects(
      sendBatches([frame], { ...settings, ...patch }),
      /^Error: invalid-session$/,
    );
  }
  const damaged = Buffer.from(frame);
  damaged.writeUInt8(0xff, 10);
  await assert.rejects(
    sendBatches([damaged], settings),
    /^Error: invalid-session$/,
  );
  let now = 100;
  const budget = sessionLimits({
    ...settings,
    totalDeadlineMs: 500,
    now: () => now,
  });
  now += 400;
  assert.equal(budget.remaining(), 100);
  now += 100;
  assert.throws(budget.remaining, /^Error: run-timeout$/);
});
