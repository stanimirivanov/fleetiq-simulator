import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * Prepares the image's JavaScript-only dependency tree without changing literals.
 * AST printing removes documentation examples, not credentials in executable code.
 * Licenses/notices survive; symlinks are not followed outside the build tree.
 * This runs after compilation and before pruning development packages.
 * @param {string} directory
 */
export function prepareRuntimeDependencies(directory) {
  const printer = ts.createPrinter({ removeComments: true });
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) prepareRuntimeDependencies(path);
    if (!entry.isFile() || /licen[cs]e|notice|copyright/i.test(entry.name))
      continue;
    if (/\.(?:[cm]?ts|map|md|markdown)$/i.test(entry.name)) rmSync(path);
    else if (/\.[cm]?js$/i.test(entry.name)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const legal =
        source.text
          .match(/\/\*[\s\S]*?\*\//g)
          ?.filter((comment) => /@license|@preserve|copyright/i.test(comment))
          .join("\n") ?? "";
      const printed = printer.printFile(source);
      writeFileSync(
        path,
        printed.replace(/^(#![^\n]*\n)?/, (prefix) => `${prefix}${legal}\n`),
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  prepareRuntimeDependencies("node_modules");
