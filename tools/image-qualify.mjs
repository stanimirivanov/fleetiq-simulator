import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const trivyVersion = "0.76.2";
const repository = "https://github.com/stanimirivanov/fleetiq-simulator";
const limit = 256 * 1024 * 1024;

/**
 * Runs bounded native tools without forwarding potentially sensitive diagnostics.
 * A failed tool is never interpreted as a clean scan.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string,input?:Buffer,timeout?:number}} [options]
 * @returns {Buffer}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    shell: false,
    timeout: options.timeout ?? 120000,
    maxBuffer: limit,
  });
  if (result.error || result.status !== 0)
    throw new Error(`image-tool-failed: ${command}`);
  return result.stdout;
}

/**
 * Seals Git-visible bytes, excluding ignored operator inputs from the build context.
 * Symlinks and private artifact names fail closed even if force-added to Git.
 * @param {string} root
 */
export function sourceSnapshot(root) {
  const files = run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");

  /** @type {Map<string, Buffer>} */
  const contents = new Map();
  for (const file of files) {
    if (
      file
        .split("/")
        .some((part) => /^private-/i.test(part) || part === "..") ||
      /\.(bin|pcap|pcapng)$/i.test(file) ||
      !lstatSync(join(root, file)).isFile() ||
      realpathSync(join(root, file)) !== resolve(root, file)
    )
      throw new Error("image-source-invalid");
    const content = readFileSync(join(root, file));
    hash.update(`${file}\0${content.length}\0`).update(content);
    contents.set(file, content);
  }
  return { files, contents, fingerprint: hash.digest("hex") };
}

/**
 * Checks untrusted Docker metadata against the qualified runtime contract.
 * Invalid values are withheld from diagnostics to avoid echoing private labels.
 * @param {unknown} value
 * @param {string} revision
 * @param {string} fingerprint
 * @returns {string}
 */
export function validateImage(value, revision, fingerprint) {
  const expected = {
    User: "65532:65532",
    WorkingDir: "/app",
    Entrypoint: ["/usr/local/bin/node", "/app/dist/cli.js"],
  };
  const v =
    /** @type {{Id?:string,Os?:string,Architecture?:string,Config?:typeof expected & {Labels?:Record<string,string>}}} */ (
      value
    );
  if (
    !v ||
    !/^sha256:[a-f0-9]{64}$/.test(v.Id ?? "") ||
    v.Os !== "linux" ||
    v.Architecture !== "amd64" ||
    Object.entries(expected).some(
      ([key, item]) =>
        JSON.stringify(
          v.Config?.[/** @type {keyof typeof expected} */ (key)],
        ) !== JSON.stringify(item),
    ) ||
    v.Config?.Labels?.["org.opencontainers.image.source"] !== repository ||
    v.Config.Labels["org.opencontainers.image.revision"] !== revision ||
    v.Config.Labels["com.fleetiq.source.sha256"] !== fingerprint
  )
    throw new Error("image-metadata-invalid");
  return /** @type {string} */ (v.Id);
}

/**
 * Requires an attributable Trivy report and rejects secrets at every severity.
 * Vulnerability policy matches the repository's HIGH/CRITICAL dependency gate.
 * @param {unknown} value
 * @param {string} id
 */
export function validateScan(value, id) {
  const v =
    /** @type {{SchemaVersion?:number,ArtifactType?:string,Metadata?:{ImageID?:string},Results?:{Vulnerabilities?:{Severity?:string}[],Secrets?:unknown[]}[]}} */ (
      value
    );
  if (
    v?.SchemaVersion !== 2 ||
    v.ArtifactType !== "container_image" ||
    v.Metadata?.ImageID !== id ||
    !Array.isArray(v.Results) ||
    v.Results.length === 0
  )
    throw new Error("image-scan-invalid");
  for (const result of v.Results) {
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("image-scan-invalid");
    if (
      result.Secrets !== undefined &&
      (!Array.isArray(result.Secrets) || result.Secrets.length > 0)
    )
      throw new Error("image-scan-secret");
    if (
      result.Vulnerabilities !== undefined &&
      (!Array.isArray(result.Vulnerabilities) ||
        result.Vulnerabilities.some(
          (finding) =>
            !["UNKNOWN", "LOW", "MEDIUM"].includes(finding.Severity ?? ""),
        ))
    )
      throw new Error("image-scan-vulnerability");
  }
}

/**
 * Separates detected leaks from scanner failures so broken tools cannot pass a canary.
 * @param {number|null} status
 * @param {Error|undefined} error
 */
export function validateLeakExit(status, error) {
  if (error || (status !== 0 && status !== 42))
    throw new Error("image-tool-failed: gitleaks");
  if (status === 42) throw new Error("image-layer-secret");
}

/**
 * Preserves printable ASCII runs while making binary tar data scanable as text.
 * Gitleaks otherwise skips binary stdin before examining embedded credentials.
 * A text prefix defeats tar magic sniffing; NULs become identity delimiters.
 * No paths are extracted or executed.
 * @param {Buffer} bytes
 */
export function printableLayer(bytes) {
  return Buffer.from(
    `FLEETIQ ASCII LAYER\n${bytes.toString("latin1").replace(/[^\t\n\r\x20-\x7e]/g, "\n")}`,
  );
}

/**
 * Examines regular-file payloads in bounded USTAR layers without extracting paths.
 * Only supported CLI identity JSON is classified as identity input: arbitrary
 * numeric constants inside runtime binaries are not device identities. Checksums
 * and lengths fail closed before trusting file boundaries; PAX metadata is skipped.
 * @param {Buffer} bytes
 */
export function rejectIdentityFiles(bytes) {
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/s, "")
      .trim();
    const sumText = header
      .subarray(148, 156)
      .toString("ascii")
      .replace(/\0.*$/s, "")
      .trim();
    const size = Number.parseInt(sizeText, 8);
    const sum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    const end = offset + 512 + size;
    if (
      !/^[0-7]+$/.test(sizeText) ||
      !/^[0-7]+$/.test(sumText) ||
      sum !== Number.parseInt(sumText, 8) ||
      end > bytes.length
    )
      throw new Error("image-layers-invalid");
    if (
      (header[156] === 0 || header[156] === 48 || header[156] === 55) &&
      size <= 16384
    ) {
      let value;
      try {
        value = JSON.parse(bytes.subarray(offset + 512, end).toString("utf8"));
      } catch {
        value = null;
      }
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length > 0 &&
        Object.values(value).every(
          (entry) => typeof entry === "string" && /^[0-9]{15}$/.test(entry),
        )
      )
        throw new Error("image-layer-secret");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("image-layers-invalid");
}

/**
 * Scans every saved layer, including deleted files, without extracting untrusted paths.
 * A separate policy removes source-scan exclusions for dependencies and dist files.
 * @param {string} id
 * @param {string} directory
 */
function scanLayers(id, directory) {
  const archive = join(directory, "image.tar");
  const config = join(directory, "gitleaks.toml");
  writeFileSync(
    config,
    '[extend]\nuseDefault = true\n[[rules]]\nid = "image-device-identity"\ndescription = "CLI identity JSON or IMEI assignment"\nregex = \'(?i:imei)["\\s:=]+[0-9]{15}\'\n',
  );
  run("docker", ["image", "save", "--output", archive, id]);
  const manifest = JSON.parse(
    run("tar", ["-xOf", archive, "manifest.json"]).toString(),
  );
  if (
    !Array.isArray(manifest) ||
    manifest.length !== 1 ||
    !Array.isArray(manifest[0].Layers) ||
    manifest[0].Layers.length > 64
  )
    throw new Error("image-layers-invalid");
  for (const entry of [manifest[0].Config, ...manifest[0].Layers]) {
    if (
      typeof entry !== "string" ||
      !/^(?:blobs\/sha256\/[a-f0-9]{64}|[a-f0-9]{64}(?:\.json|\/layer.tar))$/.test(
        entry,
      )
    )
      throw new Error("image-layers-invalid");
    let input = run("tar", ["-xOf", archive, entry]);
    if (input[0] === 31 && input[1] === 139)
      input = gunzipSync(input, { maxOutputLength: limit });
    if (entry !== manifest[0].Config) rejectIdentityFiles(input);
    const result = spawnSync(
      "gitleaks",
      [
        "stdin",
        "--config",
        config,
        ..."--no-banner --ignore-gitleaks-allow --redact=100 --exit-code 42".split(
          " ",
        ),
      ],
      {
        cwd: directory,
        input: printableLayer(input),
        timeout: 120000,
        maxBuffer: 1048576,
        shell: false,
      },
    );
    validateLeakExit(result.status, result.error);
  }
  rmSync(archive);
}

/**
 * Qualifies one frozen candidate; no registry publication or promotion is performed.
 * Receipts identify both Git ancestry and actual source bytes for dirty worktrees.
 */
export function qualify() {
  const root = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "fleetiq-image-"));
  const tag = `fleetiq-simulator:${directory.split("/").at(-1)?.toLowerCase()}`;
  const canary = `${tag}-canary`;
  rmSync(join(root, ".verification/image.json"), { force: true });
  try {
    if (
      JSON.parse(run("trivy", ["--version", "--format", "json"]).toString())
        .Version !== trivyVersion ||
      run("gitleaks", ["version"]).toString().trim() !== "8.30.1"
    )
      throw new Error("image-tool-version");
    const revision = run("git", ["rev-parse", "HEAD"]).toString().trim();
    if (!/^[a-f0-9]{40}$/.test(revision))
      throw new Error("image-source-invalid");
    const snapshot = sourceSnapshot(root);
    const context = join(directory, "context");
    for (const [file, content] of snapshot.contents) {
      mkdirSync(dirname(join(context, file)), { recursive: true });
      writeFileSync(join(context, file), content);
    }
    run(
      "docker",
      [
        "build",
        "--platform",
        "linux/amd64",
        "--build-arg",
        `VCS_REF=${revision}`,
        "--build-arg",
        `SOURCE_SHA256=${snapshot.fingerprint}`,
        "--tag",
        tag,
        context,
      ],
      { timeout: 600000 },
    );
    const metadata = JSON.parse(
      run("docker", ["image", "inspect", tag]).toString(),
    )[0];
    const id = validateImage(metadata, revision, snapshot.fingerprint);
    const runtime = readFileSync(join(root, "tools/image-runtime.mjs"), "utf8");
    const profile = snapshot.contents.get("profiles/fmb920-docs-v1.json");
    if (!profile) throw new Error("image-profile-missing");
    const output = run("docker", [
      "run",
      ..."--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1 --tmpfs /tmp:rw,noexec,nosuid,size=4m".split(
        " ",
      ),
      "--name",
      `fleetiq-image-${directory.split("/").at(-1)?.toLowerCase()}`,
      "--env",
      `FLEETIQ_QUALIFICATION_PROFILE=${profile.toString("utf8")}`,
      "--entrypoint",
      "/usr/local/bin/node",
      id,
      "--input-type=module",
      "-e",
      runtime,
    ]);
    if (output.toString().trim() !== "image-runtime-ok")
      throw new Error("image-runtime-failed");
    const scan = run(
      "trivy",
      [
        ..."image --scanners vuln,secret --image-config-scanners secret --format json --quiet".split(
          " ",
        ),
        id,
      ],
      { cwd: directory, timeout: 600000 },
    );
    validateScan(JSON.parse(scan.toString()), id);
    scanLayers(id, directory);
    const canaryContext = join(directory, "canary");
    mkdirSync(canaryContext);
    writeFileSync(
      join(canaryContext, "Dockerfile"),
      `FROM ${tag}\nUSER 0\nRUN ["/usr/local/bin/node","-e","require('fs').writeFileSync('/app/private-canary', JSON.stringify({device:'3'.repeat(15)}))"]\nRUN ["/usr/local/bin/node","-e","require('fs').unlinkSync('/app/private-canary')"]\nUSER 65532:65532\n`,
    );
    run("docker", ["build", "--pull=false", "-t", canary, canaryContext]);
    let rejected = false;
    try {
      scanLayers(canary, directory);
    } catch (error) {
      if (error instanceof Error && error.message === "image-layer-secret")
        rejected = true;
      else throw error;
    }
    if (!rejected) throw new Error("image-canary-not-detected");
    if (sourceSnapshot(root).fingerprint !== snapshot.fingerprint)
      throw new Error("image-source-changed");
    const receipt = {
      schemaVersion: 1,
      status: "qualified",
      qualifiedAt: new Date().toISOString(),
      source: {
        repository,
        revision,
        fingerprint: snapshot.fingerprint,
        clean: run("git", ["status", "--porcelain"]).length === 0,
      },
      image: { id, platform: "linux/amd64" },
      scanners: { trivy: trivyVersion, gitleaks: "8.30.1" },
      checks: [
        "restricted-runtime",
        "bounded-loopback-ack",
        "vulnerability-and-secret-scan",
        "all-layers",
        "deleted-identity-canary",
      ],
    };
    mkdirSync(join(root, ".verification"), { recursive: true });
    writeFileSync(
      join(root, ".verification/image.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    console.log(
      `image-qualified: ${JSON.stringify(receipt)} (local image ID; not published)`,
    );
  } finally {
    spawnSync(
      "docker",
      [
        "container",
        "rm",
        "--force",
        `fleetiq-image-${directory.split("/").at(-1)?.toLowerCase()}`,
      ],
      { stdio: "ignore", timeout: 30000 },
    );
    spawnSync("docker", ["image", "rm", canary], {
      stdio: "ignore",
      timeout: 30000,
    });
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    qualify();
  } catch (error) {
    console.error(
      error instanceof Error &&
        /^image-[a-z-]+(?:: [a-z]+)?$/.test(error.message)
        ? error.message
        : "image-qualification-failed",
    );
    process.exitCode = 1;
  }
}
