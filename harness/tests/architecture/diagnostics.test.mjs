import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkArchitecture,
  checkSourceTree,
} from "../../src/architecture/architecture.mjs";
import { files } from "../../support/architecture-fixture.mjs";

test("architecture diagnostics identify reviewed imports without echoing untrusted paths", () => {
  const privateName = `private-${"01234".repeat(3)}`;
  const diagnostics = checkArchitecture(
    files({
      "cli.ts": `import "node:net";\nimport "${privateName}";`,
      [`wire/${privateName}\n.ts`]: 'import "node:fs";',
    }),
  ).join("\n");
  assert.match(diagnostics, /src\/cli\.ts:1 external-import;.*node:net.*Move/);
  assert.match(diagnostics, /\[module withheld\]/);
  assert.match(diagnostics, /\[location withheld\]:1 external-import/);
  assert.ok(!diagnostics.includes(privateName));
});

test("source tree errors and checker failures have distinct recovery instructions", () => {
  const root = mkdtempSync(join(tmpdir(), "fleetiq-architecture-"));
  try {
    const src = join(root, "src");
    assert.match(checkSourceTree(src).join(), /missing-source.*Restore/);
    writeFileSync(src, "synthetic");
    assert.match(checkSourceTree(src).join(), /source-unreadable.*permissions/);
    rmSync(src);
    mkdirSync(src);
    writeFileSync(join(src, "unexpected.js"), "");
    assert.match(checkSourceTree(src).join(), /invalid-source-entry.*Remove/);
    rmSync(join(src, "unexpected.js"));
    writeFileSync(join(src, "cli.ts"), "");
    writeFileSync(join(src, "other.ts"), "");
    const failed = checkSourceTree(src, () => {
      throw new Error("private-checker-text");
    });
    assert.match(failed.join(), /checker-error.*fixture/);
    assert.ok(!failed.join().includes("private-checker-text"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
