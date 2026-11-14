import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
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
const udpPeer = createSocket("udp4");
let udpBound = false;
let expectedCodec = 8;
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
      assert.equal(pending[8], expectedCodec);
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
  writeFileSync(
    `${directory}/fault.json`,
    JSON.stringify({
      schemaVersion: 1,
      identityFile: "identities.json",
      deviceId: "sim-a",
      records: [record, record],
      target: { transport: "tcp", host: "127.0.0.1", port: address.port },
      retry: { maxAttempts: 1, ackDeadlineMs: 3000, totalDeadlineMs: 5000 },
      faults: {
        schemaVersion: 1,
        authorizedLocalTarget: true,
        actions: [
          { packet: 1, kind: "duplicate-record" },
          { packet: 2, kind: "split-write", offset: 7 },
        ],
      },
    }),
    { mode: 0o600 },
  );
  const faultChild = spawn(
    process.execPath,
    ["/app/dist/cli.js", "fault", "--config", `${directory}/fault.json`],
    { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
  );
  let faultOutput = "";
  let faultError = "";
  faultChild.stdout.on("data", (data) => {
    faultOutput += data;
  });
  faultChild.stderr.on("data", (data) => {
    faultError += data;
  });
  const [faultCode] = await once(faultChild, "close");
  assert.equal(faultCode, 0);
  assert.equal(faultError, "");
  assert.equal(
    faultOutput,
    '{"status":"faults-completed","packets":3,"acknowledged":3,"denied":0,"disconnected":0}\n',
  );
  expectedCodec = 0x8e;
  for (const [name, value] of Object.entries({
    "profile.json": JSON.parse(process.env.FLEETIQ_QUALIFICATION_PROFILE ?? ""),
    "route.json": {
      type: "LineString",
      coordinates: [
        [0, 0],
        [0.01, 0],
      ],
    },
    "scenario.json": {
      schemaVersion: 1,
      profile: "fmb920-docs-v1",
      seed: "image",
      startTimeMs: "1000000",
      clockOffsetMs: 0,
      driftPpm: 0,
      loop: false,
      phases: [
        {
          durationMs: 1000,
          speedMmPerSecond: 1000,
          ignition: true,
          gpsFix: true,
        },
      ],
    },
    "fleet.json": {
      schemaVersion: 1,
      identityFile: "identities.json",
      target: { transport: "tcp", host: "127.0.0.1", port: address.port },
      retry: { maxAttempts: 1, ackDeadlineMs: 3000, totalDeadlineMs: 5000 },
      fleet: {
        profile: "product",
        maxConcurrent: 2,
        retryDelayMs: 20,
        maxQueuedBytes: 16777216,
        routeFile: "route.json",
        scenarioFile: "scenario.json",
        profileFile: "profile.json",
        intervalMs: 1000,
        dropEvery: 0,
        devices: [
          {
            deviceId: "sim-a",
            seed: "image-member",
            clockOffsetMs: 0,
            driftPpm: 0,
          },
        ],
      },
    },
  }))
    writeFileSync(`${directory}/${name}`, JSON.stringify(value), {
      mode: 0o600,
    });
  const fleetChild = spawn(
    process.execPath,
    ["/app/dist/cli.js", "fleet", "--config", `${directory}/fleet.json`],
    { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
  );
  let fleetOutput = "",
    fleetError = "";
  fleetChild.stdout.on("data", (data) => {
    fleetOutput += data;
  });
  fleetChild.stderr.on("data", (data) => {
    fleetError += data;
  });
  const [fleetCode] = await once(fleetChild, "close");
  assert.equal(fleetCode, 0);
  assert.equal(fleetError, "");
  const fleetResult = JSON.parse(fleetOutput);
  assert.equal(fleetResult.status, "fleet-completed");
  assert.equal(fleetResult.metrics.acknowledgedRecords, 2);
  assert.equal(fleetResult.metrics.undeliveredRecords, 0);
  assert.equal(fleetOutput.includes(identity), false);
  assert.equal(fleetOutput.includes("sim-a"), false);
  assert(fleetResult.metrics.peakRssBytes > 0);
  assert(fleetResult.metrics.sampledPeakOpenFds > 0);
  udpPeer.on("message", (packet, source) => {
    assert.equal(packet.readUInt16BE(), packet.length - 2);
    assert.equal(packet.readUInt16BE(2), 7);
    assert.equal(packet[4], 1);
    assert.equal(packet[5], 9);
    assert.equal(packet.readUInt16BE(6), 15);
    assert.equal(packet.subarray(8, 23).toString(), identity);
    assert.equal(packet[23], 8);
    assert.equal(packet[24], 1);
    assert.equal(packet.at(-1), 1);
    udpPeer.send(
      Buffer.from("00050007010901", "hex"),
      source.port,
      source.address,
    );
  });
  udpPeer.bind(0, "127.0.0.1");
  await once(udpPeer, "listening");
  udpBound = true;
  writeFileSync(
    `${directory}/udp.json`,
    JSON.stringify({
      schemaVersion: 1,
      identityFile: "identities.json",
      deviceId: "sim-a",
      target: {
        transport: "udp",
        profile: "reference-peer",
        host: "127.0.0.1",
        port: udpPeer.address().port,
      },
      packetId: 7,
      avlPacketId: 9,
      records: [record],
      retry: { maxAttempts: 1, ackDeadlineMs: 3000, totalDeadlineMs: 5000 },
    }),
    { mode: 0o600 },
  );
  const udpChild = spawn(
    process.execPath,
    ["/app/dist/cli.js", "udp", "--config", `${directory}/udp.json`],
    { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
  );
  let udpOutput = "",
    udpError = "";
  udpChild.stdout.on("data", (data) => {
    udpOutput += data;
  });
  udpChild.stderr.on("data", (data) => {
    udpError += data;
  });
  const [udpCode] = await once(udpChild, "close");
  assert.equal(udpCode, 0);
  assert.equal(udpError, "");
  assert.equal(udpOutput, '{"status":"acknowledged","recordCount":1}\n');
  const storageModule = "/app/dist/storage/spool.js";

  /** @type {typeof import("../../../../src/storage/spool.ts")} */
  const { FileStore } = await import(storageModule);
  const store = new FileStore(`${directory}/state`);
  try {
    store.write("image-storage-check");
    assert.equal(store.read(), "image-storage-check");
    assert.throws(() => new FileStore(`${directory}/state`), /spool-busy/);
  } finally {
    store.close();
  }
  const reopened = new FileStore(`${directory}/state`);
  try {
    assert.equal(reopened.read(), "image-storage-check");
  } finally {
    reopened.close();
  }
  console.log("image-runtime-ok");
} finally {
  if (udpBound) udpPeer.close();
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
