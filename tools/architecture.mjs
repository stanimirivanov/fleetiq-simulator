import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const layers = {
  cli: ["session", "wire"],
  session: ["session", "wire"],
  wire: ["wire"],
};

/** @param {string} file */
function owner(file) {
  if (file === "cli.ts") return "cli";
  const first = file.split("/")[0];
  if (first === "wire" || first === "session") return first;
}

/**
 * @param {string} file
 * @param {keyof typeof layers} layer
 * @param {string} name
 */
function allowedExternal(file, layer, name) {
  if (file === "session/tcp.ts")
    return name === "node:net" || name === "effect";
  if (layer === "wire") return name === "ajv/dist/2020.js";
  return (
    layer === "cli" &&
    ["node:fs", "node:path", "node:url", "ajv/dist/2020.js"].includes(name)
  );
}

/** @param {ReadonlyMap<string, string>} files */
export function checkArchitecture(files) {
  const problems = [];
  /** @type {Map<string, { target: string, report: () => void }[]>} */
  const graph = new Map();
  for (const file of [...files.keys()].sort()) {
    const text = files.get(file);
    if (text === undefined) throw new Error("missing-source-text");
    const layer = owner(file);
    if (!layer) {
      problems.push(`${file}:1 unknown-owner`);
      continue;
    }

    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    /** @type {{ target: string, report: () => void }[]} */
    const edges = [];
    graph.set(file, edges);
    /** @param {ts.Node} node @param {string} rule */
    const report = (node, rule) => {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      problems.push(`${file}:${line + 1} ${rule}`);
    };
    /** @param {ts.Node} node @param {ts.Node | undefined} specifier */
    const checkImport = (node, specifier) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        report(node, "computed-import");
        return;
      }
      const name = specifier.text;
      if (!name.startsWith("./") && !name.startsWith("../")) {
        if (!allowedExternal(file, layer, name))
          report(node, "external-import");
        return;
      }

      const target = posix.normalize(posix.join(posix.dirname(file), name));
      if (!files.has(target)) {
        report(node, "unresolved-import");
      } else if (!layers[layer].some((allowed) => allowed === owner(target))) {
        report(node, "layer-import");
      } else {
        edges.push({ target, report: () => report(node, "import-cycle") });
      }
    };
    /** @param {ts.Node} node */
    const visit = (node) => {
      if (
        ts.isImportDeclaration(node) ||
        (ts.isExportDeclaration(node) && node.moduleSpecifier)
      ) {
        checkImport(node, node.moduleSpecifier);
      } else if (ts.isImportTypeNode(node)) {
        checkImport(
          node,
          ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined,
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
  /** @param {string} file */
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
      throw new Error("unsupported-source-entry");
    }
  }
  return files;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const files = readSources(
      fileURLToPath(new URL("../src/", import.meta.url)),
    );
    if (!files.has("cli.ts") || files.size < 2)
      throw new Error("missing-source");
    const problems = checkArchitecture(files);
    if (problems.length) {
      process.stderr.write(
        `${problems.map((problem) => `src/${problem}`).join("\n")}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write("Architecture boundaries passed.\n");
    }
  } catch {
    process.stderr.write(
      "Architecture check could not read the source tree.\n",
    );
    process.exitCode = 1;
  }
}
