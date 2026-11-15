import { writeFileSync } from "node:fs";
import { stopCoverage, takeCoverage } from "node:v8";
import { DurableSpool } from "../../../src/session/spool.ts";
import { FileStore } from "../../../src/storage/spool.ts";
import { binding, limits, work } from "../playback/spool-fixture.ts";

const [directory, action, stage, marker] = process.argv.slice(2);
if (!directory || !marker) process.exit(2);

/** Publishes completed coverage before the parent can kill this worker at a real storage boundary. */
function stopAtBoundary(marker: string): void {
  // SIGKILL cannot flush V8. Preserve executed work, then prevent an exit-time
  // writer racing the marker; no product work runs after this stop point.
  takeCoverage();
  stopCoverage();
  writeFileSync(marker, "ready", { mode: 0o600 });
  process.kill(process.pid, "SIGSTOP");
}

let armed = false;
const store = new FileStore(directory, (at) => {
  if (armed && at === stage) {
    stopAtBoundary(marker);
  }
});
try {
  const spool = new DurableSpool(store, binding, work, limits, true);
  if (action === "hold") {
    stopAtBoundary(marker);
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
