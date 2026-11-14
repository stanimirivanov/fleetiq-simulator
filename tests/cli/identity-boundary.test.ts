import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ack, identity, login, withPeer } from "../peer.ts";

type IdentityScenario =
  | "parent identity path"
  | "inline identity"
  | "unapproved destination"
  | "public identity file"
  | "acknowledged receipt"
  | "login refusal";

/** Exercises one private CLI invocation and its exact output against an independent peer. */
async function verifyIdentityScenario(scenario: IdentityScenario) {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "fleetiq-tcp-"));
  try {
    const config = join(directory, "config.json");
    let connections = 0;
    await withPeer(
      async (socket) => {
        connections++;
        const read = await login(socket);
        if (scenario === "login refusal") {
          socket.end(Buffer.from([0]));
          return;
        }
        socket.write(Buffer.from([1]));
        const received = await read(45);
        assert.equal(received[8], 8);
        assert.equal(received[9], 1);
        socket.end(ack);
      },
      async (port) => {
        const inputs = {
          schemaVersion: 1,
          identityFile:
            scenario === "parent identity path"
              ? "../identities.json"
              : "identities.json",
          deviceId: "sim-a",
          target: {
            transport: "tcp",
            host:
              scenario === "unapproved destination" ? "localhost" : "127.0.0.1",
            port,
          },
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
          ...(scenario === "inline identity" ? { imei: identity } : {}),
        };
        await writeFile(config, JSON.stringify(inputs));
        await writeFile(
          join(directory, "identities.json"),
          JSON.stringify({ "sim-a": identity }),
          {
            mode: scenario === "public identity file" ? 0o644 : 0o600,
          },
        );
        const result = await new Promise<{
          code: number;
          stdout: string;
          stderr: string;
        }>((resolve) => {
          execFile(
            process.execPath,
            ["src/cli.ts", "run", "--config", config],
            { timeout: 2000 },
            (error, stdout, stderr) => {
              resolve({ code: Number(error?.code ?? 0), stdout, stderr });
            },
          );
        });
        const sends =
          scenario === "acknowledged receipt" || scenario === "login refusal";
        assert.equal(connections, sends ? 1 : 0);
        assert.deepEqual(
          result,
          scenario === "acknowledged receipt"
            ? {
                code: 0,
                stdout: '{"status":"acknowledged","recordCount":1}\n',
                stderr: "",
              }
            : {
                code: scenario === "login refusal" ? 3 : 2,
                stdout: "",
                stderr: `${scenario === "login refusal" ? "login-refused" : scenario === "public identity file" ? "invalid-identity-file" : "invalid-run-config"}\n`,
              },
        );
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Each cold CLI process owns a deadline; unrelated invocations must not share one.
test("CLI sends only with a private identity file and prints a sanitized receipt", {
  timeout: 3000,
}, async () => {
  await verifyIdentityScenario("acknowledged receipt");
});

for (const scenario of [
  "parent identity path",
  "inline identity",
  "unapproved destination",
  "public identity file",
  "login refusal",
] as const) {
  test(`CLI private identity boundary: ${scenario}`, {
    timeout: 3000,
  }, async () => {
    await verifyIdentityScenario(scenario);
  });
}
