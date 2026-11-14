import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  sourceSnapshot,
  validateImage,
} from "../qualification/image/image-qualify.mjs";

const repository = "stanimirivanov/fleetiq-simulator";
const imageRepository = `ghcr.io/${repository}`;
const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const requiredChecks = [
  "restricted-runtime",
  "bounded-loopback-ack",
  "vulnerability-and-secret-scan",
  "all-layers",
  "deleted-identity-canary",
];

/** @typedef {{schemaVersion:number,status:string,source:{repository:string,revision:string,fingerprint:string,clean:boolean},image:{id:string,platform:string},checks:string[]}} Qualification */

/**
 * Requires the dispatch revision to remain current main and belong to a merged PR.
 * Blank input means the exact dispatch SHA, never an arbitrary later checkout.
 * @param {{ref?:string,repository?:string,revision?:string,mainRevision?:string,requestedRevision?:string,pulls?:{merged_at?:string|null,merge_commit_sha?:string}[]}} value
 */
export function validatePublicationSource(value) {
  if (
    value.ref !== "refs/heads/main" ||
    value.repository !== repository ||
    !sha.test(value.revision ?? "") ||
    value.mainRevision !== value.revision ||
    (value.requestedRevision && value.requestedRevision !== value.revision) ||
    !Array.isArray(value.pulls) ||
    !value.pulls.some(
      (pull) => pull.merged_at && pull.merge_commit_sha === value.revision,
    )
  )
    throw new Error("image-publication-source-invalid");
  return /** @type {string} */ (value.revision);
}

/**
 * Consumes only successful qualification of clean, exact source and bounded runtime.
 * A stale or incomplete receipt cannot authorize authentication or publication.
 * @param {unknown} value
 * @param {string} revision
 * @returns {Qualification}
 */
export function validatePublicationReceipt(value, revision) {
  const receipt = /** @type {Qualification} */ (value);
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.status !== "qualified" ||
    receipt.source?.repository !== `https://github.com/${repository}` ||
    receipt.source.revision !== revision ||
    receipt.source.clean !== true ||
    !/^[a-f0-9]{64}$/.test(receipt.source.fingerprint) ||
    !digest.test(receipt.image?.id ?? "") ||
    receipt.image.platform !== "linux/amd64" ||
    !Array.isArray(receipt.checks) ||
    requiredChecks.some((check) => !receipt.checks.includes(check))
  )
    throw new Error("image-publication-qualification-invalid");
  return receipt;
}

/**
 * Binds registry read-back to qualified content and OCI labels, withholding raw metadata.
 * Only one immutable digest for this repository is a valid publication result.
 * @param {Qualification} receipt
 * @param {unknown} value
 */
export function publishedReference(receipt, value) {
  try {
    const image = /** @type {{RepoDigests:string[]}} */ (value);
    if (
      validateImage(
        value,
        receipt.source.revision,
        receipt.source.fingerprint,
      ) !== receipt.image.id
    )
      throw new Error();
    const references = image.RepoDigests.filter(
      (ref) =>
        ref.startsWith(`${imageRepository}@`) &&
        digest.test(ref.slice(imageRepository.length + 1)),
    );
    if (references.length !== 1) throw new Error();
    return /** @type {string} */ (references[0]);
  } catch {
    throw new Error("image-publication-registry-invalid");
  }
}

/**
 * Captures bounded tool output privately; tokens enter only a child's stdin.
 * Docker children do not inherit the publication or source-read tokens.
 * @param {string} command
 * @param {string[]} args
 * @param {Buffer} [input]
 */
function run(command, args, input) {
  const env = { ...process.env };
  if (command === "docker") {
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    delete env.GHCR_TOKEN;
  }
  const result = spawnSync(command, args, {
    input,
    env,
    shell: false,
    timeout: 300000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`image-publication-tool-failed-${command}`);
  return result.stdout.toString().trim();
}

/**
 * Rechecks the authoritative main pointer immediately before publishing.
 * GitHub responses remain private; only the validated revision leaves this boundary.
 */
function reviewedSource() {
  const revision = run("git", ["rev-parse", "HEAD"]);
  const main = JSON.parse(
    run("gh", ["api", `repos/${repository}/commits/main`]),
  );
  const pulls = JSON.parse(
    run("gh", ["api", `repos/${repository}/commits/${revision}/pulls`]),
  );
  if (
    process.env.GITHUB_SHA !== revision ||
    run("git", ["status", "--porcelain"]) !== ""
  )
    throw new Error("image-publication-source-invalid");
  return validatePublicationSource({
    ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY,
    revision,
    mainRevision: main.sha,
    requestedRevision: process.env.REQUESTED_REVISION,
    pulls,
  });
}

/**
 * Publishes already-qualified bytes using disposable authentication, never default credentials.
 * Pulling the immutable reference must recover the identical image before reporting success.
 * @param {Qualification} receipt
 */
function publish(receipt) {
  const token = process.env.GHCR_TOKEN;
  const actor = process.env.GITHUB_ACTOR;
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (
    !token ||
    !actor ||
    !/^[0-9]+$/.test(runId ?? "") ||
    !/^[0-9]+$/.test(attempt ?? "")
  )
    throw new Error("image-publication-context-invalid");
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-publication-"));
  const auth = ["--config", directory];
  const tag = `${imageRepository}:sha-${receipt.source.revision}-${runId}-${attempt}`;
  try {
    run(
      "docker",
      [...auth, "login", "ghcr.io", "--username", actor, "--password-stdin"],
      Buffer.from(token),
    );
    run("docker", [...auth, "tag", receipt.image.id, tag]);
    run("docker", [...auth, "push", tag]);
    run("docker", [...auth, "pull", "--platform", "linux/amd64", tag]);
    const [image] = JSON.parse(
      run("docker", [...auth, "image", "inspect", tag]),
    );
    const reference = publishedReference(receipt, image);
    run("docker", [...auth, "pull", "--platform", "linux/amd64", reference]);
    const [immutable] = JSON.parse(
      run("docker", [...auth, "image", "inspect", reference]),
    );
    if (publishedReference(receipt, immutable) !== reference)
      throw new Error("image-publication-registry-invalid");
    return reference;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Dispatch-only entry point: source admission precedes qualification in the workflow,
 * then fresh source and receipt checks precede every registry mutation here.
 */
function main() {
  if (process.argv[2] === "publish")
    rmSync(".verification/publication.json", { force: true });
  const revision = reviewedSource();
  const command = process.argv[2];
  if (command === "source") {
    console.log("image-publication-source-accepted");
    return;
  }
  if (command !== "publish")
    throw new Error("image-publication-command-invalid");
  const receipt = validatePublicationReceipt(
    JSON.parse(readFileSync(".verification/image.json", "utf8")),
    revision,
  );
  if (sourceSnapshot(process.cwd()).fingerprint !== receipt.source.fingerprint)
    throw new Error("image-publication-source-changed");
  const reference = publish(receipt);
  const publication = {
    schemaVersion: 1,
    status: "published",
    image: reference,
    source: receipt.source,
    localImageId: receipt.image.id,
    platform: receipt.image.platform,
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(
    ".verification/publication.json",
    `${JSON.stringify(publication, null, 2)}\n`,
  );
  const summary = `Published simulator: \`${reference}\`\n\nSource: \`${revision}\` (linux/amd64). Source fingerprint: \`${receipt.source.fingerprint}\`. This does not promote an environment.\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error &&
        /^image-publication-[a-z-]+$/.test(error.message)
        ? error.message
        : "image-publication-failed",
    );
    process.exitCode = 1;
  }
}
