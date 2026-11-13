import ts from "typescript";

const ambientNames = new Set([
  "Date",
  "performance",
  "crypto",
  "fetch",
  "WebSocket",
  "process",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "console",
  "globalThis",
]);

/**
 * Resolves pure wire/scenario identifiers against local bindings. A library-free program
 * lets the guard distinguish ambient references from shadowed names without
 * reading third-party code or the filesystem.
 *
 * @param {ReadonlyMap<string, string>} files
 */
export function wireAmbient(files) {
  const options = {
    noLib: true,
    noResolve: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
  };
  const host = ts.createCompilerHost(options);

  /** Reads source only from the in-memory snapshot used by the import gate. */
  host.getSourceFile = (file, language) => {
    const text = files.get(file);
    return text === undefined
      ? undefined
      : ts.createSourceFile(file, text, language, true);
  };
  host.fileExists = (file) => files.has(file);
  host.readFile = (file) => files.get(file);
  const program = ts.createProgram(
    [...files.keys()].filter(
      (file) => file.startsWith("wire/") || file.startsWith("scenarios/"),
    ),
    options,
    host,
  );
  const checker = program.getTypeChecker();

  /**
   * Reports reviewed ambient capabilities, including references captured in
   * aliases. Pure Math members remain available through explicit property access.
   *
   * @param {ts.Node} node
   */
  function isAmbient(node) {
    if (!ts.isIdentifier(node)) return false;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node)
      return false;
    if (!ambientNames.has(node.text) && node.text !== "Math") return false;
    const binding = ts.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(node);
    if (binding?.declarations?.length) return false;
    if (node.text !== "Math") return true;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
      return parent.name.text === "random";
    if (ts.isElementAccessExpression(parent) && parent.expression === node)
      return (
        !ts.isStringLiteralLike(parent.argumentExpression) ||
        parent.argumentExpression.text === "random"
      );
    return true;
  }

  return {
    source: (/** @type {string} */ file) => program.getSourceFile(file),
    isAmbient,
  };
}
