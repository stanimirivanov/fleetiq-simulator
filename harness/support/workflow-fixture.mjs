import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

export const checkout =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

export const setupNode =
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";

/** @typedef {{engines: {node: string}, packageManager: string}} ToolMetadata */

/** @type {ToolMetadata} */
export const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

/** Preserves the reviewed installation command while varying only its pin. @param {string} manager */
export function installCommand(manager) {
  return `npm install --global ${manager} --allow-scripts=${manager} --strict-allow-scripts`;
}

export const pnpmInstall = installCommand(manifest.packageManager);

/** Reads real YAML so comments and quoted scalars cannot impersonate policy. @param {string} name */
export function workflow(name) {
  const document = parseDocument(
    readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
    { uniqueKeys: true },
  );
  assert.deepEqual(document.errors, []);
  return document;
}
