import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Official publishers for both schemas:
// https://github.com/aquasecurity/trivy-db/blob/main/.github/workflows/cron.yml
// https://github.com/aquasecurity/trivy-java-db/blob/main/.github/workflows/cron.yml
// Trivy v0.70.0 does not try another repository for every terminal HTTP404:
// https://github.com/aquasecurity/trivy/blob/v0.70.0/pkg/oci/artifact.go#L228-L279
export const DATABASES = Object.freeze([
  Object.freeze({ directory: "db", file: "trivy.db", schema: 2, option: "db", repository: "trivy-db:2" }),
  Object.freeze({ directory: "java-db", file: "trivy-java.db", schema: 1, option: "java-db", repository: "trivy-java-db:1" }),
]);
const REGISTRIES = ["ghcr.io/aquasecurity", "public.ecr.aws/aquasecurity"];

function succeeded(result) {
  return result?.status === 0 && !result.error && !result.signal;
}

function verifyDatabase(cache, database, now) {
  const directory = join(cache, database.directory);
  if (!lstatSync(directory).isDirectory()) throw new Error("Database directory is not a directory");
  for (const file of ["metadata.json", database.file]) {
    const stat = lstatSync(join(directory, file));
    if (!stat.isFile() || stat.size === 0) throw new Error(`Missing regular nonempty ${file}`);
    if (file === "metadata.json" && stat.size > 65536) throw new Error("Database metadata too large");
  }
  const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
  const updated = Date.parse(metadata.UpdatedAt), nextUpdate = Date.parse(metadata.NextUpdate);
  if (metadata.Version !== database.schema || !Number.isFinite(updated) ||
      !Number.isFinite(nextUpdate) || updated > now() || nextUpdate <= now() || nextUpdate <= updated) {
    throw new Error(`Expired or incompatible ${database.directory} metadata`);
  }
  return directory;
}

/** Download-only fallback cannot turn findings or incomplete scans into success. */
export function runContainerScan({ image, run = spawnSync, env = process.env, temporaryRoot = tmpdir(), now = Date.now, log = console }) {
  if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9./:@_-]*$/.test(image)) {
    throw new Error("One container image reference is required");
  }
  // A job's token/skip/config/exit-code overrides must not alter this gate or be
  // forwarded as global registry credentials to an anonymous public fallback.
  const scanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("TRIVY_")));
  const parent = realpathSync(temporaryRoot);
  const workspace = mkdtempSync(join(parent, "schoolpilot-trivy-"));
  try {
    const cache = join(workspace, "scan");
    mkdirSync(cache);
    const config = join(workspace, "trivy.yaml");
    writeFileSync(config, "{}\n");
    const common = ["--config", config, "--no-progress"];
    const selected = [];
    for (const database of DATABASES) {
      let downloaded = false;
      for (const registry of REGISTRIES) {
        // Even a failed download that wrote partial files cannot seed a retry.
        const attemptCache = mkdtempSync(join(workspace, `${database.directory}-`));
        const repository = `${registry}/${database.repository}`;
        log.info(`Downloading ${database.directory} from ${repository}`);
        try {
          const result = run("trivy", ["image", ...common, "--cache-dir", attemptCache,
            `--download-${database.option}-only`, `--${database.option}-repository`, repository, "--timeout", "2m"],
          { env: scanEnv, stdio: "inherit", timeout: 125000, killSignal: "SIGKILL", shell: false });
          if (!succeeded(result)) throw new Error("Download process failed or timed out");
          const source = verifyDatabase(attemptCache, database, now);
          const promotion = mkdtempSync(join(workspace, "promote-"));
          for (const file of ["metadata.json", database.file]) copyFileSync(join(source, file), join(promotion, file));
          renameSync(promotion, join(cache, database.directory));
          selected.push(`--${database.option}-repository`, repository);
          downloaded = true;
          break;
        } catch (error) {
          log.error(`${database.directory} download unsuccessful (${error.message}); trying the next official source if available.`);
        }
      }
      if (!downloaded) throw new Error(`No fresh ${database.directory} available; no scan was run`);
    }
    // Keep normal update/expiry validation enabled. No skip-db-update, offline
    // scan, stale restored cache, or findings retry is permitted by this path.
    const result = run("trivy", ["image", ...common, "--cache-dir", cache, ...selected,
      "--format", "table", "--pkg-types", "os,library", "--severity", "CRITICAL,HIGH",
      "--ignore-unfixed", "--exit-code", "1", "--timeout", "5m", image],
    { env: scanEnv, stdio: "inherit", timeout: 305000, killSignal: "SIGKILL", shell: false });
    return !result?.error && !result?.signal && Number.isInteger(result?.status) && result.status >= 0 && result.status <= 255
      ? result.status : 1;
  } finally {
    // Only delete the absolute mkdtemp directory owned by this invocation.
    if (dirname(workspace) !== parent || !basename(workspace).startsWith("schoolpilot-trivy-")) {
      throw new Error("Temporary cleanup ownership mismatch");
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function main(args = process.argv.slice(2), options = {}) {
  try {
    if (args.length !== 2 || args[0] !== "--image") throw new Error("Usage: scan-container.mjs --image <image>");
    return runContainerScan({ ...options, image: args[1] });
  } catch (error) {
    (options.log ?? console).error(`Trivy scan incomplete: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
