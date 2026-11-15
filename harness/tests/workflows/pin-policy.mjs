import assert from "node:assert/strict";
import { isMap, isSeq } from "yaml";
import { installCommand } from "../../support/workflow-fixture.mjs";

/**
 * Checks executable workflow pins against package metadata and scanner policy.
 * It checks both release-path and archive versions, without accepting duplicates.
 * @param {import("yaml").Document} document
 * @param {import("../../support/workflow-fixture.mjs").ToolMetadata} metadata
 * @param {string} scannerVersion
 */
export function verifyVersionPins(document, metadata, scannerVersion) {
  assert.match(metadata.engines.node, /^\d+\.\d+\.\d+$/u);
  assert.match(metadata.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
  assert.match(scannerVersion, /^\d+\.\d+\.\d+$/u);
  const jobs = document.get("jobs");
  assert.ok(isMap(jobs));
  for (const entry of jobs.items) {
    assert.ok(isMap(entry.value));
    const steps = entry.value.get("steps");
    assert.ok(isSeq(steps));
    const values = steps.items.map((step) => {
      assert.ok(isMap(step));
      return step.toJSON();
    });
    const setup = values.filter(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/setup-node@"),
    );
    assert.equal(setup.length, 1);
    assert.deepEqual(setup[0].with, { "node-version": metadata.engines.node });
    const install = values.filter(
      (step) =>
        typeof step.run === "string" &&
        step.run.startsWith("npm install --global pnpm@"),
    );
    assert.equal(install.length, 1);
    assert.deepEqual(install[0], {
      run: installCommand(metadata.packageManager),
    });
    if (document.get("name") !== "Platform decoder qualification") {
      const scanners = values.filter(
        (step) => step.name === "Install checksum-pinned Gitleaks",
      );
      assert.equal(scanners.length, 1);
      const urls = [
        ...scanners[0].run.matchAll(
          /https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v([0-9.]+)\/gitleaks_([0-9.]+)_linux_x64\.tar\.gz/gu,
        ),
      ];
      assert.equal(urls.length, 1);
      assert.equal(urls[0]?.[1], scannerVersion);
      assert.equal(urls[0]?.[2], scannerVersion);
    }
  }
}
