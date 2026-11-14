import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identity } from "../peers/peer.ts";
export function playbackConfig(directory: string, port: number) {
  const write = (name: string, value: unknown) =>
    writeFileSync(join(directory, name), JSON.stringify(value), {
      mode: 0o600,
    });
  write("identities.json", { "sim-a": identity });
  write("route.json", {
    type: "LineString",
    coordinates: [
      [0, 0],
      [0.01, 0],
    ],
  });
  write(
    "profile.json",
    JSON.parse(readFileSync("profiles/fmb920-docs-v1.json", "utf8")),
  );
  write("scenario.json", {
    schemaVersion: 1,
    profile: "fmb920-docs-v1",
    seed: "spool",
    startTimeMs: "1000000",
    clockOffsetMs: 0,
    driftPpm: 0,
    loop: false,
    phases: [
      {
        durationMs: 2000,
        speedMmPerSecond: 1000,
        ignition: true,
        gpsFix: true,
      },
    ],
  });
  const config = {
    schemaVersion: 1,
    identityFile: "identities.json",
    deviceId: "sim-a",
    target: { transport: "tcp", host: "127.0.0.1", port },
    retry: { maxAttempts: 1, ackDeadlineMs: 100, totalDeadlineMs: 2000 },
    playback: {
      routeFile: "route.json",
      scenarioFile: "scenario.json",
      profileFile: "profile.json",
      stateDirectory: "private-state",
      intervalMs: 1000,
      sendIntervalMs: 1500,
      on: [],
      offlineUntilMs: 1000,
      timingProfile: "accelerated",
      maxRecords: 2,
      maxFrameBytes: 1280,
      maxQueuedRecords: 1000,
      maxQueuedBytes: 16777216,
      maxAgeMs: 86400000,
    },
  };
  write("config.json", config);
  return config;
}
