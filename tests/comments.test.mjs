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

test("source comment lint requires docs on TypeScript contracts and named helpers", async () => {
  const eslint = new ESLint();
  for (const source of [
    "export type Record = { timestampMs: string };",
    "interface InternalContract { bytes: Uint8Array }",
    "class Frame {}",
    "export const schema = { type: 'object' } as const;",
    "export function encode(value: unknown): unknown { return value; }",
    "/** Owns detached bytes. */\nclass Frame { snapshot(): Uint8Array { return new Uint8Array(); } }",
    "function validate(value: unknown) {\n const bytes = String(value);\n const length = bytes.length;\n const bounded = length < 1280;\n return bounded;\n}",
    "const validate = (value: unknown) => {\n const bytes = String(value);\n const length = bytes.length;\n const bounded = length < 1280;\n return bounded;\n};",
  ]) {
    const [result] = await eslint.lintText(source, {
      filePath: "src/wire/comment-fixture.ts",
    });
    assert.ok(result);
    assert.ok(
      result.messages.some(({ ruleId }) => ruleId === "jsdoc/require-jsdoc"),
      source,
    );
    assert.equal(
      result.messages.some(({ fatal }) => fatal),
      false,
    );
  }
});

test("source comment lint rejects tag-only docs and adjacent comments", async () => {
  const eslint = new ESLint();
  for (const source of [
    "/** @param value */\nexport function encode(value: unknown) { return value; }",
    "/** @typedef Record */\nexport type Record = { timestampMs: string };",
    "/** @class */\nclass Frame {}",
  ]) {
    const [result] = await eslint.lintText(source, {
      filePath: "src/wire/comment-fixture.ts",
    });
    assert.ok(
      result?.messages.some(
        ({ ruleId }) => ruleId === "jsdoc/require-description",
      ),
    );
  }
  const [result] = await eslint.lintText(
    "const count = 1;\n// Explains the wire quirk.\nconst next = count + 1;",
    { filePath: "src/wire/comment-fixture.ts" },
  );
  assert.ok(
    result?.messages.some(
      ({ ruleId }) => ruleId === "@stylistic/lines-around-comment",
    ),
  );
});

test("source comment lint accepts contracts, private fields and concise local helpers", async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(
    `
/** Closed schema for timestamp admission before any allocation. */
export const schema = { type: "object" } as const;

/** Exact decimal timestamp; numeric conversion would lose u64 precision. */
export type Record = { timestampMs: string };

/** Owns bytes so callers cannot change an in-flight frame. */
export class Frame {
  #bytes = new Uint8Array();

  /** Returns detached bytes; changes cannot reach private storage. */
  snapshot(): Uint8Array { return this.#bytes.slice(); }
}

function increment(value: number) { return value + 1; }

/** Rejects overlong input before allocating an encoded frame. */
function validate(value: unknown) {
  const bytes = String(value);
  const length = bytes.length;
  const bounded = length < 1280;
  return bounded;
}

[1, 2].map((value) => increment(value));
`,
    { filePath: "src/wire/comment-fixture.ts" },
  );
  assert.ok(result);
  assert.deepEqual(result.messages, []);
});
