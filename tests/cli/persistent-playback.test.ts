import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTcp } from "../../src/cli.ts";
import { login, withPeer } from "../support/peers/peer.ts";
import { playbackConfig } from "../support/playback/playback-fixture.ts";

test("paced durable playback retains one login across capture and send ticks and resumes without resending completed work", {
  timeout: 5000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-persistent-playback-"));
  let connections = 0;
  const timestamps: string[] = [];
  try {
    await withPeer(
      async (socket) => {
        connections++;
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        while (timestamps.length < 3) {
          const header = await read(8);
          const rest = await read(header.readUInt32BE(4) + 4);
          const packet = Buffer.concat([header, rest]);
          assert.equal(packet[9], 1);
          timestamps.push(packet.readBigUInt64BE(10).toString());
          socket.write(Buffer.from([0, 0, 0, 1]));
        }
      },
      async (port) => {
        const config = {
          ...playbackConfig(directory, port),
          connectionPolicy: "persistent-compliant-peer",
        };
        config.playback.timingProfile = "real-time";
        Object.assign(config.playback, {
          intervalMs: 100,
          sendIntervalMs: 100,
          offlineUntilMs: 0,
          maxRecords: 1,
        });
        config.retry.totalDeadlineMs = 3000;
        const scenario = JSON.parse(
          readFileSync(join(directory, "scenario.json"), "utf8"),
        );
        scenario.phases[0].durationMs = 200;
        writeFileSync(
          join(directory, "scenario.json"),
          JSON.stringify(scenario),
        );
        writeFileSync(join(directory, "config.json"), JSON.stringify(config));
        const errors: string[] = [],
          receipts: unknown[] = [];
        for (const command of ["run", "resume"]) {
          assert.equal(
            await runTcp(
              [command, "--config", join(directory, "config.json")],
              (e) => errors.push(e),
              new AbortController().signal,
              (r) => receipts.push(r),
            ),
            0,
          );
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(
          receipts,
          Array(2).fill({ status: "acknowledged", recordCount: 3 }),
        );
        assert.deepEqual(timestamps, ["1000000", "1000100", "1000200"]);
        assert.equal(connections, 1);
        const state = JSON.parse(
          JSON.parse(
            readFileSync(
              join(directory, "private-state/checkpoint.json"),
              "utf8",
            ),
          ).body,
        );
        assert.equal(state.acknowledged, 3);
        assert.equal(state.records.length, 0);
        assert.equal(state.pending, null);
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent resume retransmits the frozen unacknowledged prefix and commits only matched ACKs", {
  timeout: 5000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-persistent-resume-"));
  let online = false,
    connections = 0;
  const packets: Buffer[] = [];
  try {
    await withPeer(
      async (socket) => {
        connections++;
        const read = await login(socket);
        socket.write(Buffer.from([1]));
        let count = 0;
        do {
          const header = await read(8);
          const packet = Buffer.concat([
            header,
            await read(header.readUInt32BE(4) + 4),
          ]);
          if (!online) {
            socket.destroy();
            return;
          }
          packets.push(packet);
          count += packet[9] ?? 0;
          const ack = Buffer.alloc(4);
          ack.writeUInt32BE(packet[9] ?? 0);
          socket.write(ack);
        } while (count < 3);
      },
      async (port) => {
        const config = {
          ...playbackConfig(directory, port),
          connectionPolicy: "persistent-compliant-peer",
        };
        writeFileSync(join(directory, "config.json"), JSON.stringify(config));
        const errors: string[] = [],
          receipts: unknown[] = [];
        const run = (command: string) =>
          runTcp(
            [command, "--config", join(directory, "config.json")],
            (e) => errors.push(e),
            new AbortController().signal,
            (r) => receipts.push(r),
          );
        assert.equal(await run("run"), 3);
        assert.deepEqual(receipts, []);
        assert.deepEqual(errors, ["connection-closed"]);
        const checkpoint = join(directory, "private-state/checkpoint.json");
        const retained = JSON.parse(
          JSON.parse(readFileSync(checkpoint, "utf8")).body,
        );
        assert.equal(retained.captured, 3);
        assert.equal(retained.acknowledged, 0);
        assert.equal(retained.records.length, 3);
        const before = connections;
        online = true;
        assert.equal(await run("resume"), 0);
        assert.equal(connections, before + 1);
        assert.equal(packets[0]?.toString("hex"), retained.pending);
        assert.deepEqual(
          packets.map((packet) => packet[9]),
          [2, 1],
        );
        assert.deepEqual(receipts, [
          { status: "acknowledged", recordCount: 3 },
        ]);
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("already-cancelled persistent playback records cancellation without sending or acknowledging", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-persistent-aborted-"));
  try {
    const config = {
      ...playbackConfig(directory, 55027),
      connectionPolicy: "persistent-compliant-peer",
    };
    writeFileSync(join(directory, "config.json"), JSON.stringify(config));
    const controller = new AbortController();
    controller.abort();
    const errors: string[] = [];
    let acknowledged = false;
    assert.equal(
      await runTcp(
        ["run", "--config", join(directory, "config.json")],
        (e) => errors.push(e),
        controller.signal,
        () => {
          acknowledged = true;
        },
      ),
      130,
    );
    assert.equal(acknowledged, false);
    assert.deepEqual(errors, ["cancelled"]);
    const state = JSON.parse(
      JSON.parse(
        readFileSync(join(directory, "private-state/checkpoint.json"), "utf8"),
      ).body,
    );
    assert.equal(state.status, "cancelled");
    assert.equal(state.captured, 0);
    assert.equal(state.acknowledged, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
