import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { reviewedPath } from "./diagnostic-location.mjs";
import { wireAmbient } from "./wire-ambient.mjs";

const layers = {
  cli: ["session", "wire", "transport", "scenarios", "storage"],
  transport: ["transport", "session", "wire"],
  session: ["session", "wire"],
  wire: ["wire"],
  scenarios: ["scenarios", "wire"],
  storage: ["storage", "session"],
};

const remedies = {
  "transport-load":
    "Load transport with a dynamic import inside the CLI runTcp command.",
  "wire-ambient":
    "Pass deterministic values into wire/scenario code instead of reading ambient state.",
  "unknown-owner":
    "Move the file under an existing owner or review a policy update.",
  "computed-import": "Use a literal module specifier.",
  "unsupported-import": "Use an ESM import.",
  "external-import":
    "Move the dependency to its owning layer or use an allowed module.",
  "unresolved-import": "Check the relative path and explicit .ts extension.",
  "layer-import":
    "Move the dependency to an allowed layer or pass it across the boundary.",
  "import-cycle":
    "Break the cycle by moving shared code to a dependency both modules can use.",
};

/**
 * Shows only reviewed module names and paths in diagnostics. An arbitrary
 * specifier can carry private text even if it parses as a module name.
 *
 * @param {string} file
 * @param {string} name
 */
function moduleContext(file, name) {
  if (isBuiltin(name) || name === "effect" || name === "ajv/dist/2020.js")
    return name;
  if (name.startsWith("./") || name.startsWith("../")) {
    const target = posix.normalize(posix.join(posix.dirname(file), name));
    return reviewedPath(`src/${target}`) ?? "[module withheld]";
  }
  return "[module withheld]";
}

/**
 * Maps a source path to its policy layer, leaving unrecognized paths unowned.
 *
 * @param {string} file
 */
function owner(file) {
  if (file === "cli.ts") return "cli";
  const first = file.split("/")[0];
  if (
    first === "wire" ||
    first === "session" ||
    first === "transport" ||
    first === "scenarios" ||
    first === "storage"
  )
    return first;
}

/**
 * Allows platform imports only in the layer that owns the corresponding effect.
 *
 * @param {keyof typeof layers} layer
 * @param {string} name
 */
function allowedExternal(layer, name) {
  if (layer === "storage")
    return ["node:fs", "node:crypto", "node:sqlite"].includes(name);
  if (layer === "session") return name === "ajv/dist/2020.js";
  if (layer === "transport")
    return ["node:net", "node:dns", "effect"].includes(name);
  if (layer === "wire" || layer === "scenarios")
    return name === "ajv/dist/2020.js";
  return (
    layer === "cli" &&
    [
      "node:fs",
      "node:path",
      "node:url",
      "node:crypto",
      "ajv/dist/2020.js",
    ].includes(name)
  );
}

/**
 * A literal dynamic import in the top-level network command is the CLI's
 * only runtime entry to transport. Imports inside nested functions are
 * outside that boundary.
 *
 * @param {ts.Node} node
 */
function insideNetworkCommand(node) {
  if (
    !ts.isCallExpression(node) ||
    node.expression.kind !== ts.SyntaxKind.ImportKeyword
  )
    return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      return (
        ts.isFunctionDeclaration(parent) &&
        ts.isSourceFile(parent.parent) &&
        parent.name?.text === "runTcp" &&
        parent.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ) === true
      );
    }
  }
  return false;
}

/**
 * Checks imports and re-exports in a source snapshot and returns stable diagnostics.
 * The snapshot uses paths relative to src so tests can exercise the same policy
 * without opening files.
 *
 * @param {ReadonlyMap<string, string>} files
 */
export function checkArchitecture(files) {
  const problems = [];
  const ambient = wireAmbient(files);

  /** @type {Map<string, { target: string, report: () => void }[]>} */
  const graph = new Map();
  for (const file of [...files.keys()].sort()) {
    const text = files.get(file);
    if (text === undefined) throw new Error("missing-source-text");
    const location = reviewedPath(`src/${file}`) ?? "[location withheld]";
    const layer = owner(file);
    if (!layer) {
      problems.push(
        `${location}:1 unknown-owner; ${remedies["unknown-owner"]}`,
      );
      continue;
    }

    const source =
      ambient.source(file) ??
      ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    /** @type {{ target: string, report: () => void }[]} */
    const edges = [];
    graph.set(file, edges);

    /**
     * Uses the node's start position so diagnostics point to the import itself.
     *
     * @param {ts.Node} node
     * @param {keyof typeof remedies} rule
     * @param {string} [moduleName]
     */
    const report = (node, rule, moduleName) => {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      const context =
        moduleName === undefined
          ? ""
          : ` module=${moduleContext(file, moduleName)};`;
      problems.push(
        `${location}:${line + 1} ${rule};${context} ${remedies[rule]}`,
      );
    };

    /**
     * Checks a module reference and records only allowed local edges for cycle detection.
     *
     * @param {ts.Node} node
     * @param {ts.Node | undefined} specifier
     * @param {boolean} [typeOnly]
     */
    const checkImport = (node, specifier, typeOnly = false) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        report(node, "computed-import");
        return;
      }
      const name = specifier.text;
      if (!name.startsWith("./") && !name.startsWith("../")) {
        if (!allowedExternal(layer, name))
          report(node, "external-import", name);
        return;
      }

      const target = posix.normalize(posix.join(posix.dirname(file), name));
      if (!files.has(target)) {
        report(node, "unresolved-import", name);
      } else if (!layers[layer].some((allowed) => allowed === owner(target))) {
        report(node, "layer-import", name);
      } else if (
        layer === "cli" &&
        owner(target) === "transport" &&
        !typeOnly &&
        !insideNetworkCommand(node)
      ) {
        report(node, "transport-load", name);
      } else {
        edges.push({
          target,
          report: () => report(node, "import-cycle", name),
        });
      }
    };

    /**
     * Visits static, dynamic, and type-only references under the same import policy.
     *
     * @param {ts.Node} node
     */
    const visit = (node) => {
      if (
        (layer === "wire" || layer === "scenarios") &&
        ambient.isAmbient(node)
      )
        report(node, "wire-ambient");
      if (
        ts.isImportDeclaration(node) ||
        (ts.isExportDeclaration(node) && node.moduleSpecifier)
      ) {
        checkImport(
          node,
          node.moduleSpecifier,
          ts.isImportDeclaration(node)
            ? node.importClause?.isTypeOnly
            : node.isTypeOnly,
        );
      } else if (ts.isImportTypeNode(node)) {
        checkImport(
          node,
          ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined,
          true,
        );
      } else if (ts.isImportEqualsDeclaration(node)) {
        report(node, "unsupported-import");
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          checkImport(node, node.arguments[0]);
        } else if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"
        ) {
          report(node, "unsupported-import");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const active = new Set();
  const visited = new Set();

  /**
   * Detects cycles along the active traversal path, allowing shared dependencies.
   *
   * @param {string} file
   */
  function visitEdges(file) {
    if (visited.has(file)) return;
    active.add(file);
    for (const edge of graph.get(file) ?? []) {
      if (active.has(edge.target)) edge.report();
      else visitEdges(edge.target);
    }
    active.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visitEdges(file);
  return problems;
}

/**
 * Collects TypeScript source by path relative to src, rejecting unexpected entries
 * such as symlinks rather than silently leaving them out of the gate.
 *
 * @param {string} root
 * @param {string} [prefix]
 * @param {Map<string, string>} [files]
 */
function readSources(root, prefix = "", files = new Map()) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = prefix + entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      readSources(path, `${file}/`, files);
    } else if (entry.isFile() && file.endsWith(".ts")) {
      files.set(file, readFileSync(path, "utf8"));
    } else if (!entry.isFile() || !file.endsWith(".md")) {
      throw new InvalidSourceEntry();
    }
  }
  return files;
}

class InvalidSourceEntry extends Error {}

/**
 * Separates checkout and input failures from checker defects without emitting
 * raw exceptions. An empty result means the source passed.
 *
 * @param {string} root
 * @param {typeof checkArchitecture} [analyze]
 */
export function checkSourceTree(root, analyze = checkArchitecture) {
  let files;
  try {
    files = readSources(root);
  } catch (error) {
    if (error instanceof InvalidSourceEntry) {
      return [
        "invalid-source-entry; Remove unsupported files or symlinks from src/.",
      ];
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return ["missing-source; Restore the src/ checkout and rerun the gate."];
    }
    return ["source-unreadable; Check src/ paths and read permissions."];
  }
  if (!files.has("cli.ts") || files.size < 2) {
    return [
      "missing-source; Restore cli.ts and the source modules under src/.",
    ];
  }
  try {
    return analyze(files);
  } catch {
    return [
      "checker-error; Reproduce with an architecture fixture before changing policy.",
    ];
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const problems = checkSourceTree(
    fileURLToPath(new URL("../src/", import.meta.url)),
  );
  if (problems.length) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Architecture boundaries passed.\n");
  }
}
