import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkOutput,
  platformCases,
  runCommand,
  verifyCheckout,
} from "../tools/platform-decoder.mjs";

test("platform comparison requires every case, field and raw byte without numeric coercion", () => {
  const cases = platformCases();
  assert.ok(cases.length >= 258);
  const output = `${cases.map((entry) => entry.expected).join("\n")}\n`;
  assert.doesNotThrow(() => checkOutput(cases, output));
  assert.throws(
    () => checkOutput(cases, output.replace("ok\t8\t1", "ok\t8\t2")),
    /platform-output-mismatch/,
  );
  assert.throws(
    () => checkOutput(cases, output.replace("ok\t8\t1", "ok\t08\t1")),
    /platform-output-mismatch/,
  );
  assert.throws(
    () => checkOutput(cases, output.split("\n").slice(1).join("\n")),
    /platform-output-mismatch/,
  );
  assert.throws(
    () => checkOutput(cases, `${output}unexpected\n`),
    /platform-output-mismatch/,
  );
  assert.throws(
    () => checkOutput(cases, output.replace("reject:1", "reject:4")),
    /platform-output-mismatch/,
  );
});

test("platform corpus retains full u64 tests as explicit rejections and duplicate-ID controls", () => {
  const cases = platformCases();
  assert.ok(cases.some((entry) => entry.expected === "reject:1"));
  assert.ok(cases.some((entry) => entry.expected === "reject:4"));
  assert.ok(
    cases.filter((entry) => entry.expected.startsWith("ok\t8\t1\t")).length >
      100,
  );
});

test("platform qualification fails for a missing checkout or missing build tool", () => {
  assert.throws(
    () => verifyCheckout("/nonexistent/fleetiq-platform-fixture"),
    /platform-checkout-failed/,
  );
  assert.throws(
    () => runCommand("missing-fleetiq-compiler-fixture", [], "build"),
    /platform-build-failed/,
  );
});

test("platform build errors are distinct failures and do not echo subprocess output", () => {
  assert.throws(
    () =>
      runCommand(
        process.execPath,
        ["-e", 'console.error("private-compiler-fixture"); process.exit(9);'],
        "build",
      ),
    { message: "platform-build-failed" },
  );
});

test("platform checkout verification rejects an unrelated Git HEAD", (context) => {
  const root = mkdtempSync(join(tmpdir(), "fleetiq-wrong-platform-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  runCommand("git", ["init", root], "checkout");
  runCommand(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "unrelated",
    ],
    "checkout",
  );
  assert.throws(() => verifyCheckout(root), /platform-checkout-failed/);
});

test("platform corpus qualifies both Extended IO forms and profile boundaries", () => {
  const cases = platformCases();
  assert.ok(
    cases.filter((entry) => entry.expected.startsWith("ok\t142\t1\t")).length >=
      5,
  );
  assert.ok(
    cases.some((entry) => entry.expected.endsWith("300:0102,65535:00010203ff")),
  );
});

test("native corpus retains normal-day motion, stops and no-fix model IO", () => {
  const records = platformCases()
    .map(({ expected }) => expected.split("\t"))
    .filter((fields) => fields[0] === "ok" && fields[3]?.startsWith("1700000"));
  assert.equal(records.length, 6);
  assert.ok(
    records.some(
      (fields) =>
        fields[9] === "0" &&
        fields[10] === "0" &&
        fields[12]?.includes("240:01"),
    ),
  );
  assert.ok(records.some((fields) => fields[12]?.includes("239:00")));
});

test("native corpus includes every ordered record in 2/16-record packets", () => {
  for (const count of [2, 16]) {
    const entry = platformCases().find(({ expected }) =>
      expected.startsWith(`ok\t142\t${count}\t`),
    );
    assert.ok(entry);
    const records = entry.expected.split("\n");
    assert.equal(records.length, count);
    assert.deepEqual(
      records.map((line) => line.split("\t")[3]),
      Array.from({ length: count }, (_, index) => String(index)),
    );
  }
});
