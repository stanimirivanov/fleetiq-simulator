import assert from "node:assert/strict";
import dns from "node:dns";
import { test } from "node:test";
import { composeLookup, sendBatches } from "../../src/transport/tcp.ts";
import { ack, identity, login, withPeer } from "../support/peers/peer.ts";

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

test("Compose target resolves once to private IPv4 and rejects failed, public or mixed DNS", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.2",
  ]) {
    const lookup = composeLookup((_host, done) =>
      done(null, [{ address, family: 4 }]),
    );
    await new Promise<void>((resolve, reject) =>
      lookup("tcp-ingestion", { family: 4 }, (error, result, family) => {
        if (error) reject(error);
        else {
          assert.equal(result, address);
          assert.equal(family, 4);
          resolve();
        }
      }),
    );
  }
  for (const addresses of [
    [],
    [{ address: "8.8.8.8", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "172.32.0.1", family: 4 }],
    [{ address: "192.167.1.1", family: 4 }],
    [{ address: "::1", family: 6 }],
    [{ address: "invalid", family: 4 }],
    [
      { address: "10.0.0.1", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ],
  ]) {
    const lookup = composeLookup((_host, done) => done(null, addresses));
    await new Promise<void>((resolve) =>
      lookup("tcp-ingestion", { family: 4 }, (error) => {
        assert(error);
        resolve();
      }),
    );
  }
  const failed = composeLookup((_host, done) =>
    done(new Error("private resolver failure"), []),
  );
  await new Promise<void>((resolve) =>
    failed("tcp-ingestion", { family: 4 }, (error) => {
      assert(error);
      resolve();
    }),
  );
});

test("named Compose target completes real login/frame/ACK without changing loopback defaults", {
  timeout: 3000,
}, async (t) => {
  t.mock.method(
    dns,
    "lookup",
    (
      _host: string,
      _options: unknown,
      callback: (error: Error | null, addresses: dns.LookupAddress[]) => void,
    ) => callback(null, [{ address: "127.0.0.1", family: 4 }]),
  );
  await withPeer(
    async (socket) => {
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(frame.length), frame);
      socket.write(ack);
    },
    async (port) => {
      assert.deepEqual(
        await sendBatches([frame], { ...options(port), host: "tcp-ingestion" }),
        { status: "acknowledged", recordCount: 1 },
      );
    },
  );
});

test("Compose resolver refuses unapproved names before DNS", async () => {
  const lookup = composeLookup(() =>
    assert.fail("unapproved name reached DNS"),
  );
  await new Promise<void>((resolve) =>
    lookup("example.com", { family: 4 }, (error) => {
      assert(error);
      resolve();
    }),
  );
});
