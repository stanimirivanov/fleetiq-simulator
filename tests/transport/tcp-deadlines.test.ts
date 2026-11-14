import assert from "node:assert/strict";
import { test } from "node:test";
import { sendBatches } from "../../src/transport/tcp.ts";
import { identity, login, withPeer } from "../support/peers/peer.ts";

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

test("cancellation and the monotonic run budget bound a silent peer", {
  timeout: 3000,
}, async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    await withPeer(
      async (socket) => {
        await login(socket);
        if (cancel) controller.abort();
      },
      async (port) => {
        await assert.rejects(
          sendBatches([frame], {
            ...options(port),
            signal: controller.signal,
            totalDeadlineMs: cancel ? 2000 : 75,
          }),
          cancel ? /^Error: cancelled$/ : /^Error: run-timeout$/,
        );
      },
    );
  }
});
