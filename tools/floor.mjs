import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** @typedef {{identity: string, shape: string | undefined}} TestDeclaration */

const testPrinter = ts.createPrinter({ removeComments: true });

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
 * Prints the complete call with only its static title replaced. The compiler's
 * printer preserves operators, options and callbacks while ignoring trivia.
 *
 * @param {ts.CallExpression} call
 * @param {ts.SourceFile} source
 */
function renamedShape(call, source) {
  const first = call.arguments[0];
  if (!first || !ts.isStringLiteralLike(first)) return undefined;
  const normalized = ts.factory.updateCallExpression(
    call,
    call.expression,
    call.typeArguments,
    [ts.factory.createStringLiteral(""), ...call.arguments.slice(1)],
  );
  return testPrinter.printNode(ts.EmitHint.Expression, normalized, source);
}

/**
 * Consumes each declaration once: exact matches, retained names, then unchanged
 * shapes for literal renames. Ambiguous combinations can conservatively fail.
 *
 * @param {TestDeclaration[]} before
 * @param {TestDeclaration[]} after
 */
function removedTests(before, after) {
  const remaining = [...after];

  /** Removes one matching candidate without collapsing duplicate declarations.
   * @param {TestDeclaration[]} pending
   * @param {(old: TestDeclaration, next: TestDeclaration) => boolean} matches
   */
  function consume(pending, matches) {
    return pending.filter((old) => {
      const index = remaining.findIndex((next) => matches(old, next));
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
  }
  const exact = consume(
    before,
    (old, next) => old.identity === next.identity && old.shape === next.shape,
  );
  const renamed = consume(exact, (old, next) => old.identity === next.identity);
  return (
    consume(
      renamed,
      (old, next) => old.shape !== undefined && old.shape === next.shape,
    ).length > 0
  );
}

/**
 * Accepts only an unchanged plain command chain followed by extra script calls.
 * Namespaced targets avoid pnpm built-ins; no shell syntax or arguments may be
 * added, and every target must name an own, nonempty package script.
 *
 * @param {unknown} before
 * @param {unknown} after
 * @param {Record<string, unknown>} scripts
 */
function additiveCommand(before, after, scripts) {
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    !after.startsWith(before)
  )
    return false;
  if (
    !before
      .split(" && ")
      .every((command) =>
        /^(?:pnpm|node|tsc|biome|eslint) [A-Za-z0-9_./:@= *-]+$/u.test(command),
      )
  )
    return false;
  const suffix = after.slice(before.length).split(" && pnpm ");
  if (suffix.shift() !== "" || !suffix.length) return false;
  return suffix.every(
    (name) =>
      /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9:-]*$/u.test(name) &&
      Object.hasOwn(scripts, name) &&
      typeof scripts[name] === "string" &&
      scripts[name].trim().length > 0,
  );
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
 * Retained names preserve existing behavior; literal renames need a full shape.
 * @param {string} text @param {string} file
 */
function inspect(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const comments = new Set();

  /** @type {TestDeclaration[]} */
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
          tests.push({ identity, shape: renamedShape(node, source) });
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

  /** @type {TestDeclaration[]} */
  const previousTests = [];

  /** @type {TestDeclaration[]} */
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
          !additiveCommand(command, newScripts[name], newScripts) &&
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
  if (removedTests(previousTests, currentTests)) problems.add("test-removed");
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
