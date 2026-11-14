import { registerHooks } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const entry = process.argv[1];
if (!entry) throw new Error("missing-canary-entry");
const transport = resolve(dirname(entry), "transport") + sep;

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && fileURLToPath(url).startsWith(transport)) {
      process.stderr.write("offline-transport-load\n");
      throw new Error("offline-transport-load");
    }
    return nextLoad(url, context);
  },
});
