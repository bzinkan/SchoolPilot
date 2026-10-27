import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DATABASES, main, runContainerScan } from "../scripts/security/scan-container.mjs";

const now = () => Date.parse("2026-10-26T20:00:00Z");
const value = (args, option) => args[args.indexOf(option) + 1];
const databaseFor = (args) => DATABASES.find((db) => args.includes(`--download-${db.option}-only`));

function writeDatabase(args, { artifact = true, expired = false, schema, symlink = false } = {}) {
  const db = databaseFor(args);
  const directory = join(value(args, "--cache-dir"), db.directory);
  mkdirSync(directory);
  writeFileSync(join(directory, "metadata.json"), JSON.stringify({
    Version: schema ?? db.schema, UpdatedAt: "2026-10-26T18:00:00Z",
    NextUpdate: expired ? "2026-10-26T19:00:00Z" : "2026-10-27T00:00:00Z",
  }));
  if (symlink) symlinkSync(join(directory, "metadata.json"), join(directory, db.file));
  else if (artifact) writeFileSync(join(directory, db.file), "fixture database");
}

function fixture(t, execute) {
  const directory = mkdtempSync(join(tmpdir(), "trivy-scan-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [], logs = [];
  return {
    directory, calls, logs,
    options: {
      image: "schoolpilot-production-api:scan", temporaryRoot: directory, now,
      env: { PATH: "fixture-path", TRIVY_SKIP_DB_UPDATE: "true", TRIVY_SKIP_JAVA_DB_UPDATE: "true", TRIVY_EXIT_CODE: "0",
        TRIVY_USERNAME: "fixture-user", TRIVY_PASSWORD: "fixture-password", TRIVY_CONFIG: "untrusted.yaml", TRIVY_SCANNERS: "license" },
      log: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
      run(command, args, options) {
        calls.push({ command, args, options, config: readFileSync(value(args, "--config"), "utf8") });
        return execute?.({ command, args, options, calls }) ?? (writeDatabase(args), { status: 0 });
      },
    },
  };
}

test("terminal404 falls back for both DB schemas, then scans once with the unchanged gate", (t) => {
  const f = fixture(t, ({ args }) => {
    const db = databaseFor(args);
    if (!db) {
      for (const item of DATABASES) assert.ok(existsSync(join(value(args, "--cache-dir"), item.directory, item.file)));
      return { status: 0 };
    }
    if (value(args, `--${db.option}-repository`).startsWith("ghcr.io")) {
      writeDatabase(args); // partial/stale files from an unsuccessful process are never accepted
      return { status: 1, stderr: "unexpected status code404 Not Found" };
    }
    assert.deepEqual(readdirSync(value(args, "--cache-dir")), []);
    writeDatabase(args);
    return { status: 0 };
  });
  assert.equal(runContainerScan(f.options), 0);
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.calls.filter(({ args }) => databaseFor(args)).map(({ args }) => {
    const db = databaseFor(args);
    return value(args, `--${db.option}-repository`);
  }), [
    "ghcr.io/aquasecurity/trivy-db:2", "public.ecr.aws/aquasecurity/trivy-db:2",
    "ghcr.io/aquasecurity/trivy-java-db:1", "public.ecr.aws/aquasecurity/trivy-java-db:1",
  ]);
  const scans = f.calls.filter(({ args }) => !databaseFor(args));
  assert.equal(scans.length, 1);
  const final = scans[0];
  assert.equal(value(final.args, "--severity"), "CRITICAL,HIGH");
  assert.equal(value(final.args, "--exit-code"), "1");
  assert.equal(value(final.args, "--pkg-types"), "os,library");
  assert.equal(value(final.args, "--format"), "table");
  assert.ok(final.args.includes("--ignore-unfixed"));
  assert.equal(final.args.at(-1), "schoolpilot-production-api:scan");
  for (const call of f.calls) {
    assert.equal(call.command, "trivy");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.killSignal, "SIGKILL");
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 305000);
    assert.deepEqual(call.options.env, { PATH: "fixture-path" });
    assert.ok(!call.args.some((arg) => /^--(skip-.*update|offline-scan|ignore-policy)$/.test(arg)));
    assert.equal(call.config, "{}\n");
  }
  assert.deepEqual(readdirSync(f.directory), []);
});

test("findings and scanner failures stay nonzero and never retry the scan", (t) => {
  for (const result of [{ status: 1 }, { status: 2 }, { status: null, signal: "SIGKILL" }, { status: null, error: new Error("timeout") }]) {
    const f = fixture(t, ({ args }) => {
      if (databaseFor(args)) { writeDatabase(args); return { status: 0 }; }
      return result;
    });
    assert.equal(runContainerScan(f.options), result.status ?? 1);
    assert.equal(f.calls.filter(({ args }) => !databaseFor(args)).length, 1);
    assert.deepEqual(readdirSync(f.directory), []);
  }
});

test("all-source download failure stops before a scan even if failed attempts left DB files", (t) => {
  const f = fixture(t, ({ args }) => { writeDatabase(args); return { status: 1 }; });
  assert.equal(main(["--image", "schoolpilot-production-api:scan"], f.options), 1);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(({ args }) => databaseFor(args)));
  assert.deepEqual(readdirSync(f.directory), []);
});

test("Java DB failure cannot silently reduce language coverage", (t) => {
  const f = fixture(t, ({ args }) => {
    const db = databaseFor(args);
    if (db?.directory === "db") { writeDatabase(args); return { status: 0 }; }
    return { status: 1 };
  });
  assert.equal(main(["--image", "schoolpilot-production-api:scan"], f.options), 1);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(({ args }) => databaseFor(args)));
});

test("download timeout uses another fresh source; stale, incompatible or missing artifacts fail closed", (t) => {
  for (const badArtifact of [{ expired: true }, { schema: 99 }, { artifact: false }]) {
    const f = fixture(t, ({ args, calls }) => {
      if (calls.length === 1) return { status: null, signal: "SIGKILL", error: new Error("ETIMEDOUT") };
      writeDatabase(args, badArtifact);
      return { status: 0 };
    });
    assert.equal(main(["--image", "schoolpilot-production-api:scan"], f.options), 1);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(({ args }) => databaseFor(args)));
  }
});

test("artifact symlinks do not satisfy the downloaded DB contract", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t, ({ args }) => { writeDatabase(args, { symlink: true }); return { status: 0 }; });
  assert.equal(main(["--image", "schoolpilot-production-api:scan"], f.options), 1);
  assert.equal(f.calls.length, 2);
});

test("a real timed-out subprocess is killed before fallback, and final findings still fail", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "trivy-process-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fakeTrivy = join(directory, "fake-trivy.mjs");
  writeFileSync(fakeTrivy, `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (args.includes('--download-db-only') && value('--db-repository').startsWith('ghcr.io')) {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    } else if (args.includes('--download-db-only') || args.includes('--download-java-db-only')) {
      const java = args.includes('--download-java-db-only');
      const target = join(value('--cache-dir'), java ? 'java-db' : 'db');
      mkdirSync(target);
      writeFileSync(join(target, 'metadata.json'), JSON.stringify({ Version: java ? 1 : 2,
        UpdatedAt: '2026-10-26T18:00:00Z', NextUpdate: '2026-10-27T00:00:00Z' }));
      writeFileSync(join(target, java ? 'trivy-java.db' : 'trivy.db'), 'fixture');
    } else { process.exitCode = 1; }
  `);
  const outcomes = [];
  const options = { image: "schoolpilot-production-api:scan", temporaryRoot: directory, now,
    log: { info() {}, error() {} }, env: {},
    run(command, args, processOptions) {
      assert.equal(command, "trivy");
      assert.equal(processOptions.killSignal, "SIGKILL");
      const result = spawnSync(process.execPath, [fakeTrivy, ...args], { ...processOptions, stdio: "pipe", timeout: 500 });
      outcomes.push(result);
      return result;
    },
  };
  assert.equal(runContainerScan(options), 1);
  assert.equal(outcomes.length, 4);
  assert.equal(outcomes[0].error?.code, "ETIMEDOUT");
  assert.notEqual(outcomes[0].status, 0);
  assert.equal(outcomes.at(-1).status, 1);
  assert.deepEqual(readdirSync(directory), ["fake-trivy.mjs"]);
});

test("malformed CLI inputs never start Trivy", (t) => {
  const f = fixture(t, () => assert.fail("invalid CLI must not run"));
  for (const args of [[], ["--image"], ["--image", "--skip-db-update"], ["--image", "valid", "extra"]]) {
    assert.equal(main(args, f.options), 1);
  }
  assert.equal(f.calls.length, 0);
});

test("workflow installs the same scanner, tests the wrapper, covers its PR inputs and stays read-only", () => {
  const workflow = readFileSync(new URL("../.github/workflows/trivy.yml", import.meta.url), "utf8");
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.deepEqual([...dockerfile.matchAll(/^FROM ([^ \r\n]+)/gm)].map(match => match[1]), ["node:22-alpine", "node:22-alpine"]);
  assert.match(workflow, /--build-context node:22-alpine=docker-image:\/\/docker\.io\/library\/node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914/);
  for (const file of ["scripts/security/scan-container.mjs", "tests/trivy-container-scan.test.mjs"]) {
    assert.ok(workflow.includes(`- '${file}'`));
  }
  assert.match(workflow, /setup-trivy@3fb12ec12f41e471780db15c232d5dd185dcb514/);
  assert.match(workflow, /version: v0\.70\.0/);
  assert.match(workflow, /node --test tests\/trivy-container-scan\.test\.mjs/);
  assert.match(workflow, /node scripts\/security\/scan-container\.mjs --image schoolpilot-production-api:scan/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.doesNotMatch(workflow, /continue-on-error|packages: write|id-token: write|skip-(?:java-)?db-update/);
});
