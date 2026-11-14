import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runCli, runTcp } from "../../src/cli.ts";
import { record } from "../codec8-fixture.ts";
import { identity } from "../peer.ts";

test("UDP CLI admits only explicit reference peers with private identity and a correlated wire receipt", {
  timeout: 3000,
}, async () => {
  const { withUdpPeer } = await import("../udp-peer.ts");
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-udp-cli-"));
  try {
    const path = join(directory, "config.json");
    writeFileSync(
      join(directory, "identities.json"),
      JSON.stringify({ "sim-a": identity }),
      { mode: 0o600 },
    );
    await withUdpPeer(
      async (packet, source, peer) => {
        assert.equal(packet.subarray(8, 23).toString(), identity);
        peer.send(
          Buffer.from([0, 5, 0, 7, 1, 9, 1]),
          source.port,
          source.address,
        );
      },
      async (port) => {
        const input = {
          schemaVersion: 1,
          identityFile: "identities.json",
          deviceId: "sim-a",
          target: {
            transport: "udp",
            profile: "reference-peer",
            host: "127.0.0.1",
            port,
          },
          packetId: 7,
          avlPacketId: 9,
          records: [record],
          retry: { maxAttempts: 1, ackDeadlineMs: 200, totalDeadlineMs: 1000 },
        };
        const errors: string[] = [];
        const receipts: unknown[] = [];
        writeFileSync(path, JSON.stringify(input));
        assert.equal(
          runCli(["validate", "--config", path], (c) => errors.push(c)),
          0,
        );
        const run = (command: string) =>
          runTcp(
            [command, "--config", path],
            (c) => errors.push(c),
            new AbortController().signal,
            (r) => receipts.push(r),
          );
        assert.equal(await run("run"), 2);
        assert.deepEqual(receipts, []);
        for (const target of [
          { ...input.target, profile: "product" },
          { ...input.target, host: "tcp-ingestion" },
        ]) {
          writeFileSync(path, JSON.stringify({ ...input, target }));
          assert.equal(await run("udp"), 2);
        }
        writeFileSync(path, JSON.stringify(input));
        assert.equal(await run("udp"), 0);
        assert.deepEqual(receipts, [
          { status: "acknowledged", recordCount: 1 },
        ]);
        assert.equal(
          JSON.stringify({ errors, receipts }).includes(identity),
          false,
        );
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
