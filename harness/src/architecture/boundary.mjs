import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import ts from "typescript";

/**
 * Enforces the one-way harness boundary on actual import/export syntax, ignoring
 * fixture strings. Product code cannot load the harness, legacy tools or computed
 * modules; the harness may consume product APIs and independent test vectors.
 * @param {Record<string,string>} files
 */
export function checkProductImports(files) {
  const problems = new Set();
  for (const [file, text] of Object.entries(files)) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    /** Inspects only real dependency nodes; ordinary fixture text is not executable policy. @param {ts.Node} node */
    function visit(node) {
      let specifier;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      )
        specifier = node.moduleSpecifier;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        specifier = node.argument.literal;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        specifier = node.arguments[0];
        if (!specifier || !ts.isStringLiteralLike(specifier))
          problems.add("product-harness-import");
      }
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const target = posix.normalize(
          posix.join(dirname(file), specifier.text),
        );
        if (
          target === "harness" ||
          target.startsWith("harness/") ||
          target === "tools" ||
          target.startsWith("tools/") ||
          specifier.text === "@fleetiq/simulator-harness" ||
          specifier.text.startsWith("@fleetiq/simulator-harness/")
        )
          problems.add("product-harness-import");
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return [...problems];
}

/** Checks all product owners and behavior tests, refusing unexpected filesystem entries. @param {string} root */
export function checkProductTree(root) {
  const files = /** @type {Record<string,string>} */ ({});

  /** Preserves repository-relative ownership while recursively collecting only executable test/product modules. @param {string} directory */
  function collect(directory) {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      const file = posix.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (!entry.isFile()) throw new Error("product-boundary-unreadable");
      else if (/\.(?:ts|mjs|js)$/u.test(file))
        files[file] = readFileSync(join(root, file), "utf8");
    }
  }
  try {
    for (const owner of ["src", "tests", "packaging"]) collect(owner);
  } catch {
    return ["product-boundary-unreadable"];
  }
  return checkProductImports(files);
}
