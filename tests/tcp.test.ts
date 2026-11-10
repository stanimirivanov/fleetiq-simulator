import assert from "node:assert/strict";
import { once } from "node:events";
import type { Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sessionLimits } from "../src/session/state.ts";
import { sendBatches } from "../src/session/tcp.ts";
import { encodeCodec8 } from "../src/wire/codec8.ts";
import { reader, withPeer } from "./peer.ts";

// Published Teltonika TCP Codec 8 example, one record.
const frame = Buffer.from(
  "000000000000002808010000016b40d9ad80010000000000000000000000000000000103021503010101425e100000010000f22a",
  "hex",
);
const ack = Buffer.from([0, 0, 0, 1]);
const identity = "01234".repeat(3);

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

async function login(socket: Socket) {
  const read = reader(socket);
  assert.deepEqual(await read(2), Buffer.from([0, 15]));
  assert.equal((await read(15)).toString("ascii"), identity);
  return read;
}

test("waits for all four ACK bytes and accepts a compliant persistent peer", {
  timeout: 3000,
}, async () => {
  await withPeer(
    async (socket, attempt) => {
      assert.equal(attempt, 1);
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      for (let batch = 0; batch < 2; batch++) {
        assert.deepEqual(await read(frame.length), frame);
        socket.write(ack.subarray(0, 1));
        await delay(10);
        socket.write(ack.subarray(1));
      }
    },
    async (port) => {
      await sendBatches([frame, frame], {
        ...options(port),
        connectionPolicy: "persistent-compliant-peer",
      });
    },
  );
});

test("strict mode cannot accept a delayed equal-count duplicate from the retired socket", {
  timeout: 3000,
}, async () => {
  let first: Socket | undefined;
  let retired: Promise<unknown> | undefined;
  await withPeer(
    async (socket, attempt) => {
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(frame.length), frame);
      if (attempt === 1) {
        first = socket;
        retired = once(socket, "close");
        socket.write(ack);
      } else {
        assert.equal(attempt, 2);
        await retired;
        assert.ok(first?.destroyed);
        first.write(ack);
        // Only the old session emits an ACK for this second equal-count batch.
      }
    },
    async (port) => {
      await assert.rejects(
        sendBatches([frame, frame], options(port)),
        /^Error: ack-timeout$/,
      );
    },
  );
});

test("a missing ACK retries the exact frozen frame on a fresh login", {
  timeout: 3000,
}, async () => {
  let attempts = 0;
  const pending = Buffer.from(frame);
  await withPeer(
    async (socket, attempt) => {
      attempts = attempt;
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      assert.deepEqual(await read(frame.length), frame);
      if (attempt === 2) socket.end(ack);
      else pending.fill(0);
    },
    async (port) => {
      await sendBatches([pending], { ...options(port), maxAttempts: 2 });
      assert.equal(attempts, 2);
    },
  );
});

test("refusal is terminal, premature coalesced bytes and wrong counts fail", {
  timeout: 3000,
}, async () => {
  for (const [response, category] of [
    [Buffer.from([0]), "login-refused"],
    [Buffer.concat([Buffer.from([1]), ack]), "unexpected-reply"],
    [Buffer.from([1]), "ack-count"],
  ] as const) {
    await withPeer(
      async (socket, attempt) => {
        assert.equal(attempt, 1);
        const read = await login(socket);
        socket.write(response);
        if (category === "ack-count") {
          assert.deepEqual(await read(frame.length), frame);
          socket.write(Buffer.from([0, 0, 0, 2]));
        }
      },
      async (port) => {
        await assert.rejects(
          sendBatches([frame], {
            ...options(port),
            maxAttempts: category === "login-refused" ? 2 : 1,
          }),
          new RegExp(`^Error: ${category}$`),
        );
      },
    );
  }
});

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

test("CLI sends only with a private identity file and prints a sanitized receipt", {
  timeout: 3000,
}, async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, rm, writeFile, chmod } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "fleetiq-tcp-"));
  try {
    const config = join(directory, "config.json");
    const identities = join(directory, "identities.json");
    const run = () =>
      new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            ["src/cli.ts", "run", "--config", config],
            { timeout: 2000 },
            (error, stdout, stderr) => {
              resolve({ code: Number(error?.code ?? 0), stdout, stderr });
            },
          );
        },
      );
    await withPeer(
      async (socket, attempt) => {
        const read = await login(socket);
        if (attempt === 2) {
          socket.end(Buffer.from([0]));
          return;
        }
        assert.equal(attempt, 1);
        socket.write(Buffer.from([1]));
        const received = await read(45);
        assert.equal(received[8], 8);
        assert.equal(received[9], 1);
        socket.end(ack);
      },
      async (port) => {
        const inputs = {
          schemaVersion: 1,
          identityFile: "identities.json",
          deviceId: "sim-a",
          target: { transport: "tcp", host: "127.0.0.1", port },
          record: {
            schemaVersion: 1,
            timestampMs: "0",
            priority: 0,
            longitudeE7: 0,
            latitudeE7: 0,
            altitude: 0,
            angle: 0,
            satellites: 0,
            speed: 0,
            eventId: 0,
            io: [],
          },
        };
        for (const invalid of [
          { ...inputs, identityFile: "../identities.json" },
          { ...inputs, imei: identity },
          { ...inputs, target: { ...inputs.target, host: "localhost" } },
        ]) {
          await writeFile(config, JSON.stringify(invalid));
          assert.deepEqual(await run(), {
            code: 2,
            stdout: "",
            stderr: "invalid-run-config\n",
          });
        }
        await writeFile(config, JSON.stringify(inputs));
        await writeFile(identities, JSON.stringify({ "sim-a": identity }), {
          mode: 0o644,
        });
        assert.deepEqual(await run(), {
          code: 2,
          stdout: "",
          stderr: "invalid-identity-file\n",
        });
        await chmod(identities, 0o600);
        assert.deepEqual(await run(), {
          code: 0,
          stdout: '{"status":"acknowledged","recordCount":1}\n',
          stderr: "",
        });
        assert.deepEqual(await run(), {
          code: 3,
          stdout: "",
          stderr: "login-refused\n",
        });
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("persistent reconnect retries only the unacknowledged batch", {
  timeout: 3000,
}, async () => {
  const next = encodeCodec8({
    schemaVersion: 1,
    timestampMs: "0",
    priority: 0,
    longitudeE7: 0,
    latitudeE7: 0,
    altitude: 0,
    angle: 0,
    satellites: 0,
    speed: 0,
    eventId: 0,
    io: [],
  });
  let attempts = 0;
  await withPeer(
    async (socket, attempt) => {
      attempts = attempt;
      const read = await login(socket);
      socket.write(Buffer.from([1]));
      if (attempt === 1) {
        assert.deepEqual(await read(frame.length), frame);
        socket.write(ack);
      }
      assert.deepEqual(await read(next.length), next);
      if (attempt === 2) socket.end(ack);
    },
    async (port) => {
      await sendBatches([frame, next], {
        ...options(port),
        maxAttempts: 2,
        connectionPolicy: "persistent-compliant-peer",
      });
      assert.equal(attempts, 2);
    },
  );
});
