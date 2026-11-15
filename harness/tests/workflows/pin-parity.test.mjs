import assert from "node:assert/strict";
import { test } from "node:test";
import { gitleaksVersion } from "../../src/security/secrets.mjs";
import { manifest, workflow } from "../../support/workflow-fixture.mjs";
import { verifyVersionPins } from "./pin-policy.mjs";

/** @type {[string, string][]} */
const workflowJobs = [
  ["ci", "check"],
  ["image", "qualify"],
  ["publish", "publish"],
  ["security-scheduled", "security"],
  ["platform-decoder", "qualify"],
];

test("all workflow runtime and package-manager pins follow package metadata", () => {
  for (const name of [
    "ci",
    "security-scheduled",
    "platform-decoder",
    "image",
    "publish",
  ]) {
    const document = workflow(name);
    verifyVersionPins(document, manifest, gitleaksVersion);
    for (const metadata of [
      { ...manifest, engines: { ...manifest.engines, node: "0.0.0" } },
      { ...manifest, packageManager: "pnpm@0.0.0" },
    ])
      assert.throws(
        () => verifyVersionPins(document, metadata, gitleaksVersion),
        { name: "AssertionError" },
      );
  }
});

test("scanner workflow release and archive pins follow one scanner definition", () => {
  assert.equal(typeof gitleaksVersion, "string");
  for (const name of ["ci", "security-scheduled", "image", "publish"]) {
    const document = workflow(name);
    verifyVersionPins(document, manifest, gitleaksVersion);
    assert.throws(() => verifyVersionPins(document, manifest, "0.0.0"), {
      name: "AssertionError",
    });
  }
});

test("pin parity rejects independently changed workflow fields and scanner URLs", () => {
  for (const [name, job] of workflowJobs) {
    for (const field of ["node", "pnpm", "allow-scripts"]) {
      const document = workflow(name);
      if (field === "node")
        document.setIn(
          ["jobs", job, "steps", 1, "with", "node-version"],
          "0.0.0",
        );
      else {
        const path = ["jobs", job, "steps", 2, "run"];
        const command = document.getIn(path);
        assert.equal(typeof command, "string");
        const original =
          field === "pnpm"
            ? `--global ${manifest.packageManager}`
            : `--allow-scripts=${manifest.packageManager}`;
        const changed =
          field === "pnpm"
            ? "--global pnpm@0.0.0"
            : "--allow-scripts=pnpm@0.0.0";
        document.setIn(path, String(command).replace(original, changed));
      }
      assert.throws(
        () => verifyVersionPins(document, manifest, gitleaksVersion),
        { name: "AssertionError" },
      );
    }
  }
  for (const [name, job] of workflowJobs.filter(
    ([name]) => name !== "platform-decoder",
  )) {
    for (const field of ["release", "archive", "duplicate"]) {
      const document = workflow(name);
      const path = ["jobs", job, "steps", 4, "run"];
      const command = String(document.getIn(path));
      const changed =
        field === "release"
          ? command.replace(`/v${gitleaksVersion}/`, "/v0.0.0/")
          : field === "archive"
            ? command.replace(`gitleaks_${gitleaksVersion}_`, "gitleaks_0.0.0_")
            : `${command}\n# https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}/gitleaks_${gitleaksVersion}_linux_x64.tar.gz`;
      document.setIn(path, changed);
      assert.throws(
        () => verifyVersionPins(document, manifest, gitleaksVersion),
        { name: "AssertionError" },
      );
    }
  }
});
