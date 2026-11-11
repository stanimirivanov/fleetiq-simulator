import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Runs bounded, argument-separated Git and withholds unreviewed error output.
 * @param {string} root @param {string[]} args
 */
function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("git-input-unavailable");
  return result.stdout;
}

/** Compares multisets so removing one duplicate cannot hide another deletion.
 * @param {string[]} before @param {string[]} after
 */
function removed(before, after) {
  const remaining = [...after];
  return before.some((entry) => {
    const index = remaining.indexOf(entry);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

/**
 * Gives direct and computed literal keys the same decoded spelling. Computed
 * identifiers and expressions stay unresolved; inspecting a fixture never runs it.
 *
 * @param {ts.Node | undefined} node
 * @returns {string | undefined}
 */
function staticPropertyName(node) {
  if (!node) return undefined;
  if (ts.isComputedPropertyName(node) || ts.isElementAccessExpression(node)) {
    const key = ts.isComputedPropertyName(node)
      ? node.expression
      : node.argumentExpression;
    return key && ts.isStringLiteralLike(key) ? key.text : undefined;
  }
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node)
    ? node.text
    : undefined;
}

/** Reads real comments and node:test declarations, excluding fixture strings.
 * Names identify tests across moves; renames deliberately require review.
 * @param {string} text @param {string} file
 */
function inspect(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const comments = new Set();

  /** @type {string[]} */
  const tests = [];

  /** @type {string[]} */
  const disabled = [];
  const aliases = new Set(["test", "it", "describe"]);
  const contexts = new Set(["t", "context"]);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "node:test"
    )
      continue;
    if (statement.importClause?.name)
      aliases.add(statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      aliases.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const entry of bindings.elements) aliases.add(entry.name.text);
    }
  }

  /** Traverses syntax rather than matching test-looking text inside strings.
   * @param {ts.Node} node
   */
  function visit(node) {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ]) {
      const comment = text.slice(range.pos, range.end);
      if (
        /@ts-(ignore|expect-error|nocheck)|biome-ignore|eslint-disable|(?:c8|istanbul) ignore|node:coverage (?:disable|ignore)/u.test(
          comment,
        )
      )
        comments.add(`${range.pos}:${comment}`);
    }
    if (/\.test\.(?:ts|mjs|js)$/u.test(file) && ts.isCallExpression(node)) {
      let target = node.expression;
      const methods = [];
      while (
        ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)
      ) {
        const property = staticPropertyName(
          ts.isPropertyAccessExpression(target) ? target.name : target,
        );
        if (property === undefined) break;
        methods.unshift(property);
        target = target.expression;
      }
      const name = ts.isIdentifier(target) ? target.text : "";
      const method = methods.at(-1) ?? "test";
      if (
        contexts.has(name) &&
        ["skip", "todo", "only", "runOnly"].includes(method)
      )
        disabled.push(`context-control:${method}`);
      if (aliases.has(name) || contexts.has(name)) {
        const first = node.arguments[0];
        if (first && (aliases.has(name) || method === "test")) {
          const identity = ts.isStringLiteralLike(first)
            ? first.text
            : first.getText(source);
          tests.push(identity);
          for (const argument of node.arguments) {
            if (
              ts.isArrowFunction(argument) ||
              ts.isFunctionExpression(argument)
            ) {
              const parameter = argument.parameters[0]?.name;
              if (parameter && ts.isIdentifier(parameter))
                contexts.add(parameter.text);
            }
          }
          const options = node.arguments[1];
          const flagged =
            options &&
            ts.isObjectLiteralExpression(options) &&
            options.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                ["skip", "todo", "only"].includes(
                  staticPropertyName(property.name) ?? "",
                ) &&
                property.initializer.kind !== ts.SyntaxKind.FalseKeyword,
            );
          if (["skip", "todo", "only"].includes(method) || flagged)
            disabled.push(identity);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return {
    comments: [...comments].map((comment) =>
      comment.slice(comment.indexOf(":") + 1),
    ),
    tests,
    disabled,
  };
}

/** Refuses dynamic coverage policy instead of silently losing the numeric floor.
 * @param {string} text
 */
function floors(text) {
  const source = ts.createSourceFile(
    "coverage.mjs",
    text,
    ts.ScriptTarget.Latest,
    true,
  );

  /** @type {Map<string, number[]>} */
  const result = new Map();

  /** Reads only the active groups declaration; unused objects cannot satisfy it.
   * @param {ts.Node} node
   */
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "groups"
    ) {
      if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer))
        throw new Error("coverage-policy-unreadable");
      for (const group of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(group))
          throw new Error("coverage-policy-unreadable");
        const fields = new Map(
          group.properties
            .filter(ts.isPropertyAssignment)
            .map((property) => [
              property.name.getText(source),
              property.initializer,
            ]),
        );
        const name = fields.get("name");
        if (!name || !ts.isStringLiteral(name) || result.has(name.text))
          throw new Error("coverage-policy-unreadable");
        const values = ["lines", "branches"].map((key) => {
          const value = fields.get(key);
          if (!value || !ts.isNumericLiteral(value))
            throw new Error("coverage-policy-unreadable");
          const number = Number(value.text);
          if (!Number.isFinite(number) || number < 0 || number > 100)
            throw new Error("coverage-policy-unreadable");
          return number;
        });
        result.set(name.text, values);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!result.size) throw new Error("coverage-policy-unreadable");
  return result;
}

/** Checks the complete candidate worktree against an immutable ancestor commit.
 * Staged, committed and untracked code are included; missing history fails closed.
 * @param {string} base @param {string} [root]
 */
export function checkFloor(base, root = ".") {
  if (!/^[a-f0-9]{40}$/u.test(base)) throw new Error("baseline-invalid");
  try {
    git(root, ["cat-file", "-e", `${base}^{commit}`]);
  } catch {
    throw new Error("baseline-unavailable");
  }
  try {
    git(root, ["merge-base", "--is-ancestor", base, "HEAD"]);
  } catch {
    throw new Error("baseline-not-ancestor");
  }
  const baseFiles = new Set(
    git(root, ["ls-tree", "-r", "--name-only", "-z", base]).split("\0"),
  );
  const files = new Set(
    [
      ...git(root, [
        "diff",
        "--no-ext-diff",
        "--name-only",
        "-z",
        base,
        "--",
      ]).split("\0"),
      ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split(
        "\0",
      ),
    ].filter(Boolean),
  );
  const problems = new Set();
  const previousTests = [];
  const currentTests = [];
  for (const file of files) {
    if (!/\.(?:ts|mjs|js)$/u.test(file) && file !== "package.json") continue;
    const before = baseFiles.has(file)
      ? git(root, ["show", `${base}:${file}`])
      : "";
    let after = "";
    try {
      if (!lstatSync(join(root, file)).isFile())
        throw new Error("unsupported-entry");
      after = readFileSync(join(root, file), "utf8");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw new Error("candidate-unreadable");
    }
    if (file === "package.json") {
      const oldScripts = JSON.parse(before || "{}").scripts ?? {};
      const newScripts = JSON.parse(after || "{}").scripts ?? {};
      for (const [name, command] of Object.entries(oldScripts)) {
        if (
          newScripts[name] !== command &&
          !(
            name === "check" &&
            newScripts[name] === `pnpm floor && ${command}` &&
            newScripts.floor === "node tools/floor.mjs"
          )
        )
          problems.add("verification-script-changed");
      }
      continue;
    }
    const old = inspect(before, file);
    const next = inspect(after, file);
    if (removed(next.comments, old.comments)) problems.add("suppression-added");
    if (removed(next.disabled, old.disabled))
      problems.add("test-disabled-or-focused");
    previousTests.push(...old.tests);
    currentTests.push(...next.tests);
    if (file === "tools/coverage.mjs" && before) {
      try {
        const nextFloors = floors(after);
        for (const [name, values] of floors(before)) {
          if (
            values.some(
              (value, index) => value > (nextFloors.get(name)?.[index] ?? -1),
            )
          )
            problems.add("coverage-floor-lowered");
        }
      } catch {
        problems.add("coverage-floor-lowered");
      }
    }
  }
  if (removed(previousTests, currentTests)) problems.add("test-removed");
  return [...problems].sort();
}

if (
  process.argv[1] === "-" ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  try {
    const base =
      process.argv[2] ??
      git(".", ["merge-base", "HEAD", "refs/remotes/origin/main"]).trim();
    const problems = checkFloor(base);
    if (problems.length) {
      for (const problem of problems)
        process.stderr.write(
          `verification-floor ${problem}; Restore the baseline protection; inspect the diff privately and request maintainer review for intentional changes.\n`,
        );
      process.exitCode = 1;
    } else process.stdout.write(`Verification floor passed against ${base}.\n`);
  } catch {
    process.stderr.write(
      "verification-floor baseline-or-input-error; Fetch the exact PR base/full origin/main history and check candidate file types before retrying.\n",
    );
    process.exitCode = 1;
  }
}
