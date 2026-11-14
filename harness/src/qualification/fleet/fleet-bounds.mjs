import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { FairFleet, FleetError } from "../../../../src/scenarios/fleet.ts";
import { runFleet } from "../../../../src/transport/fleet.ts";
import { Codec8Frame, encodeCodec8 } from "../../../../src/wire/codec8.ts";
import { encodeCodec8e } from "../../../../src/wire/codec8e.ts";

/** @typedef {"product"|"reference-peer"} Profile */
/** @typedef {{profile:Profile,devices:number,peakSessions:number,peerPeakRequests:number,acknowledgedRecords:number,attempts:number,peakQueuedBytes:number,peakRssBytes:number,peakOpenFds:number,baselineOpenFds:number,openFdsAfter:number,cpuUserUs:number,cpuSystemUs:number,wallMs:number,cpuAffinityCount:number,overflowRejected:boolean}} BoundsReport */
const keys = [
  "profile",
  "devices",
  "peakSessions",
  "peerPeakRequests",
  "acknowledgedRecords",
  "attempts",
  "peakQueuedBytes",
  "peakRssBytes",
  "peakOpenFds",
  "baselineOpenFds",
  "openFdsAfter",
  "cpuUserUs",
  "cpuSystemUs",
  "wallMs",
  "cpuAffinityCount",
  "overflowRejected",
];

/**
 * Rejects malformed/extra fields and over-budget measured reports without echoing values.
 * @param {unknown} input
 * @returns {asserts input is BoundsReport}
 */
export function assertBounds(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("fleet-bounds-failed");
  const value = /** @type {Record<string,unknown>} */ (input);
  if (
    Object.keys(value).sort().join() !== [...keys].sort().join() ||
    typeof value.profile !== "string" ||
    !["product", "reference-peer"].includes(value.profile) ||
    keys
      .filter((key) => !["profile", "overflowRejected"].includes(key))
      .some(
        (key) => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0,
      )
  )
    throw new Error("fleet-bounds-failed");
  const r = /** @type {BoundsReport} */ (input);
  const cap = r.profile === "product" ? 2 : 100;
  if (
    r.devices !== 100 ||
    r.peakSessions !== cap ||
    r.peerPeakRequests !== cap ||
    r.acknowledgedRecords !== 200 ||
    r.attempts !== 200 ||
    r.peakQueuedBytes < 1 ||
    r.peakQueuedBytes > 16777216 ||
    r.peakRssBytes <= 0 ||
    r.peakRssBytes > 256 * 1024 * 1024 ||
    r.baselineOpenFds < 3 ||
    r.peakOpenFds < r.baselineOpenFds ||
    r.openFdsAfter < 3 ||
    r.peakOpenFds > r.baselineOpenFds + 2 * cap + 32 ||
    r.openFdsAfter > r.baselineOpenFds + 4 ||
    r.cpuUserUs + r.cpuSystemUs <= 0 ||
    r.wallMs < 1 ||
    r.wallMs > 30000 ||
    r.cpuAffinityCount !== 1 ||
    r.overflowRejected !== true
  )
    throw new Error("fleet-bounds-failed");
}

/**
 * Runs actual sockets under one-CPU affinity, including a first-wave barrier that proves full concurrency.
 * Counts kernel descriptors and high-water RSS; no device-count scaling estimate substitutes for a sample.
 * @param {Profile} profile
 * @returns {Promise<BoundsReport>}
 */
async function workload(profile) {
  const baselineOpenFds = readdirSync("/proc/self/fd").length;
  const started = performance.now();
  const cpu = process.cpuUsage();
  const cap = profile === "product" ? 2 : 100;
  let peakOpenFds = baselineOpenFds;

  /** Capture actual Linux process observations without returning paths or descriptor targets. */
  const probe = () => {
    const usage = process.cpuUsage();
    const openFds = readdirSync("/proc/self/fd").length;
    peakOpenFds = Math.max(peakOpenFds, openFds);
    return {
      rssBytes: process.resourceUsage().maxRSS * 1024,
      openFds,
      cpuUserUs: usage.user,
      cpuSystemUs: usage.system,
    };
  };
  const record = {
    schemaVersion: 1,
    timestampMs: "1000000",
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
  const frame = Codec8Frame.fromRecord(record);
  const bytes = encodeCodec8(record);
  const devices = Array.from({ length: 100 }, (_, i) => ({
    deviceId: `peer-${i}`,
    identity: `7${String(i).padStart(14, "0")}`,
    frames: [frame, frame],
  }));
  const sockets = new Set();
  const waiting = new Set();
  let outstanding = 0,
    peerPeakRequests = 0,
    barrier = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    probe();
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0),
      loggedIn = false,
      handled = false;

    /** The fixed peer buffers TCP fragments and acknowledges exactly one independently checked frame. */
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!loggedIn && buffer.length >= 17) {
        assert.equal(buffer.readUInt16BE(), 15);
        buffer = buffer.subarray(17);
        loggedIn = true;
        socket.write(Buffer.from([1]));
      }
      if (!loggedIn || handled || buffer.length < bytes.length) return;
      assert.deepEqual(buffer, bytes);
      handled = true;
      outstanding++;
      peerPeakRequests = Math.max(peerPeakRequests, outstanding);
      waiting.add(socket);
      probe();
      if (!barrier && waiting.size < cap) return;
      const firstWave = !barrier;
      barrier = true;

      /** Hold the first complete wave briefly so the runner also samples live sockets at the full profile. */
      setTimeout(
        () => {
          for (const peer of waiting) {
            outstanding--;
            peer.end(Buffer.from([0, 0, 0, 1]));
          }
          waiting.clear();
        },
        firstWave ? 25 : 0,
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  let result;
  try {
    result = await runFleet(
      { devices, captured: 200, simulatedLoss: 0 },
      {
        profile,
        maxConcurrent: cap,
        maxAttempts: 2,
        retryDelayMs: 20,
        maxQueuedBytes: 16777216,
      },
      {
        host: "127.0.0.1",
        port: address.port,
        ackDeadlineMs: 3000,
        totalDeadlineMs: 15000,
        authorizedReferencePeer: profile === "reference-peer",
      },
      probe,
    );
    assert.equal(result.status, "fleet-completed");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  // Exercise real admission near the aggregate byte ceiling, not just a small queue inferred to scale.
  const large = Codec8Frame.fromExtendedBytes(
    encodeCodec8e({
      ...record,
      variableIo: Array.from({ length: 4 }, (_, i) => ({
        id: i + 1,
        hex: "ab".repeat(256),
      })),
    }),
  );
  let overflowRejected = false;
  try {
    new FairFleet(
      devices.slice(0, 20).map((d) => ({
        ...d,
        frames: Array.from({ length: 1000 }, () =>
          Codec8Frame.fromExtendedBytes(large.snapshot().bytes),
        ),
      })),
      {
        profile,
        maxConcurrent: cap,
        maxAttempts: 1,
        retryDelayMs: 0,
        maxQueuedBytes: 16777216,
      },
    );
  } catch (error) {
    if (!(error instanceof FleetError) || error.category !== "fleet-overflow")
      throw error;
    overflowRejected = true;
  }
  const usage = process.cpuUsage(cpu);
  const affinity = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]
    ?.trim();
  const report = {
    profile,
    devices: 100,
    peakSessions: result.metrics.peakSessions,
    peerPeakRequests,
    acknowledgedRecords: result.metrics.acknowledgedRecords,
    attempts: result.metrics.attempts,
    peakQueuedBytes: result.metrics.peakQueuedBytes,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    peakOpenFds,
    baselineOpenFds,
    openFdsAfter: readdirSync("/proc/self/fd").length,
    cpuUserUs: usage.user,
    cpuSystemUs: usage.system,
    wallMs: Math.ceil(performance.now() - started),
    cpuAffinityCount: affinity && /^\d+$/.test(affinity) ? 1 : 0,
    overflowRejected,
  };
  assertBounds(report);
  return report;
}

/** Pins each isolated workload child to one allowed Linux CPU and publishes only validated fixed-field reports. */
async function main() {
  const node = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  ).engines.node;
  if (process.version !== `v${node}`)
    throw new Error("fleet-bounds-runtime-mismatch");
  if (process.argv[2] === "--profile") {
    const profile = process.argv[3];
    if (profile !== "product" && profile !== "reference-peer")
      throw new Error("fleet-bounds-failed");
    console.log(JSON.stringify(await workload(profile)));
    return;
  }
  const cpu = readFileSync("/proc/self/status", "utf8").match(
    /^Cpus_allowed_list:\s*(\d+)/m,
  )?.[1];
  if (!cpu) throw new Error("fleet-bounds-tool-failed");
  for (const profile of ["product", "reference-peer"]) {
    const result = spawnSync(
      "taskset",
      [
        "-c",
        cpu,
        process.execPath,
        fileURLToPath(import.meta.url),
        "--profile",
        profile,
      ],
      { encoding: "utf8", timeout: 45000, maxBuffer: 65536 },
    );
    if (result.error || result.status !== 0)
      throw new Error("fleet-bounds-tool-failed");
    const report = JSON.parse(result.stdout);
    assertBounds(report);
    console.log(JSON.stringify(report));
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
