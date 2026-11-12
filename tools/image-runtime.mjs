import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

assert.equal(process.version, "v24.18.0");
assert.equal(process.getuid?.(), 65532);
assert.equal(process.getgid?.(), 65532);
assert.match(readFileSync("/proc/self/status", "utf8"), /^CapEff:\s+0+$/m);
assert.match(readFileSync("/proc/self/status", "utf8"), /^NoNewPrivs:\s+1$/m);
assert.match(readFileSync("/proc/mounts", "utf8"), /^\S+ \/ \S+ ro[, ]/m);
const directory = mkdtempSync("/tmp/simulator-");
const identity = "3".repeat(15);
const record = {
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
};

/** The independent peer accepts one login and acknowledges one framed record. */
const server = createServer((socket) => {
  let pending = Buffer.alloc(0);
  let loggedIn = false;
  socket.setTimeout(5000, () => socket.destroy());
  socket.on("error", () => {});

  /** Accumulate TCP fragments; never assume a data event is a protocol boundary. */
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (!loggedIn && pending.length >= 17) {
      assert.equal(pending.readUInt16BE(), 15);
      assert.equal(pending.subarray(2, 17).toString(), identity);
      pending = pending.subarray(17);
      loggedIn = true;
      socket.write(Buffer.from([1]));
    }
    if (
      loggedIn &&
      pending.length >= 8 &&
      pending.length >= 12 + pending.readUInt32BE(4)
    ) {
      assert.equal(pending[8], 8);
      assert.equal(pending[9], 1);
      socket.end(Buffer.from([0, 0, 0, 1]));
    }
  });
});
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  writeFileSync(
    `${directory}/identities.json`,
    JSON.stringify({ "sim-a": identity }),
    { mode: 0o600 },
  );
  writeFileSync(
    `${directory}/config.json`,
    JSON.stringify({
      schemaVersion: 1,
      identityFile: "identities.json",
      deviceId: "sim-a",
      record,
      target: { transport: "tcp", host: "127.0.0.1", port: address.port },
      retry: { maxAttempts: 1, ackDeadlineMs: 3000, totalDeadlineMs: 5000 },
    }),
    { mode: 0o600 },
  );
  writeFileSync(`${directory}/record.json`, JSON.stringify(record), {
    mode: 0o600,
  });
  for (const args of [
    ["validate", "--config", `${directory}/record.json`],
    [
      "encode",
      "--config",
      `${directory}/record.json`,
      "--output",
      `${directory}/frame.bin`,
    ],
  ]) {
    const result = spawnSync(process.execPath, ["/app/dist/cli.js", ...args], {
      timeout: 10000,
      maxBuffer: 65536,
    });
    assert.equal(result.status, 0);
    assert(!result.stdout.toString().includes(identity));
  }
  const child = spawn(
    process.execPath,
    ["/app/dist/cli.js", "run", "--config", `${directory}/config.json`],
    { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let error = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    error += data;
  });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.equal(error, "");
  assert.equal(output, '{"status":"acknowledged","recordCount":1}\n');
  console.log("image-runtime-ok");
} finally {
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
