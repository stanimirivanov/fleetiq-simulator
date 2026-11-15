import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkFloor } from "../../src/verification/floor.mjs";
import { fixture } from "../../support/floor-fixture.mjs";

test("retired flat discovery and tools aliases cannot authorize new command changes", (context) => {
  const { root, write, git } = fixture(context);
  write(
    "package.json",
    JSON.stringify({
      scripts: {
        floor: "node tools/floor.mjs",
        test: "node --test tests/*.test.ts tests/*.test.mjs",
      },
    }),
  );
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "legacy commands",
  ]);
  const base = git(["rev-parse", "HEAD"]);
  write("harness/src/verification/floor.mjs", "export const gate = true;");
  write(
    "package.json",
    JSON.stringify({
      scripts: {
        floor: "node harness/src/verification/floor.mjs",
        test: 'node --test "tests/**/*.test.ts" "tests/**/*.test.mjs"',
      },
    }),
  );
  assert.ok(checkFloor(base, root).includes("verification-script-changed"));
});

test("PR verification requires the merged harness checker without legacy or introduction fallbacks", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.doesNotMatch(
    workflow,
    /BASE_SHA:tools\/floor\.mjs|One-time introduction|elif test "\$BASE_SHA"/,
  );
  assert.match(
    workflow,
    /git show "\$BASE_SHA:harness\/src\/verification\/floor\.mjs"/,
  );
});
