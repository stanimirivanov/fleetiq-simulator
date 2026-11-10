import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

test("tooling comment lint rejects adjacent comments and missing summaries", async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(
    `const value = 1;
// This comment is adjacent.
const next = value + 1;
/** @param {number} input */
function tagged(input) { return input; }

function undocumented() {
  const first = value + next;
  const second = first + 1;
  const third = second * 2;
  return third;
}`,
    { filePath: "tools/comment-fixture.mjs" },
  );
  assert.ok(result);
  assert.deepEqual(
    result.messages.map(({ ruleId }) => ruleId),
    [
      "@stylistic/lines-around-comment",
      "@stylistic/lines-around-comment",
      "jsdoc/require-description",
      "jsdoc/require-jsdoc",
    ],
  );
});

test("tooling comment lint permits separated prose and short helpers", async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(
    `const base = 1;

function increment(value) { return value + base; }

/**
 * Builds the full result from the fixed starting value.
 *
 * @param {number} count
 */
function accumulate(count) {
  let result = base;
  for (let index = 0; index < count; index++) {
    result = increment(result);
  }
  return result;
}`,
    { filePath: "tools/comment-fixture.mjs" },
  );
  assert.ok(result);
  assert.deepEqual(result.messages, []);
});
