import { writeFileSync } from "node:fs";
import { DurableSpool } from "../../../src/session/spool.ts";
import { FileStore } from "../../../src/storage/spool.ts";
import { binding, limits, work } from "../playback/spool-fixture.ts";

const [directory, action, stage, marker] = process.argv.slice(2);
if (!directory || !marker) process.exit(2);
let armed = false;
const store = new FileStore(directory, (at) => {
  if (armed && at === stage) {
    writeFileSync(marker, "ready", { mode: 0o600 });
    process.kill(process.pid, "SIGSTOP");
  }
});
try {
  const spool = new DurableSpool(store, binding, work, limits, true);
  if (action === "hold") {
    writeFileSync(marker, "ready", { mode: 0o600 });
    process.kill(process.pid, "SIGSTOP");
  }
  if (action === "advance") {
    armed = true;
    spool.advance();
  }
  if (action === "prepare") {
    armed = true;
    spool.prepare();
  }
  if (action === "ack") {
    const frame = spool.prepare();
    if (!frame) process.exit(2);
    armed = true;
    spool.acknowledge(frame);
  }
} finally {
  store.close();
}
