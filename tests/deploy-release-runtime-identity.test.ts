import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const sha = "a".repeat(40);
const image = `example.invalid/api@sha256:${"b".repeat(64)}`;

function stamp(service: string, options: { sha?: string; image?: string; secretIdentity?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "schoolpilot-release-identity-"));
  const file = join(directory, "task.json");
  const definition = {
    family: `test-${service}`,
    cpu: "512",
    containerDefinitions: [{
      name: service,
      image,
      environment: [
        { name: "GIT_SHA", value: "c".repeat(40) },
        { name: "SERVICE_NAME", value: "stale-service" },
        { name: "RLS_GUC_ENABLED", value: "true" },
      ],
      secrets: options.secretIdentity ? [{ name: "GIT_SHA", valueFrom: "test-parameter" }] : [],
    }],
  };
  const original = JSON.stringify(definition);
  writeFileSync(file, original);
  try {
    const result = spawnSync(process.execPath, [
      join(root, "scripts/stamp-release-runtime-identity.mjs"),
      "--task-definition", file, "--service", service,
      "--git-sha", options.sha ?? sha, "--image-ref", options.image ?? image,
    ], { encoding: "utf8", windowsHide: true });
    return { result, definition: JSON.parse(readFileSync(file, "utf8")), original };
  } finally {
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}schoolpilot-release-identity-`));
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("release runtime identity", () => {
  for (const service of ["api", "scheduler-worker"]) {
    it(`binds ${service} to the new image after inherited environment merges`, () => {
      const { result, definition } = stamp(service);
      assert.equal(result.status, 0, result.stderr);
      const container = definition.containerDefinitions[0];
      assert.equal(container.image, image);
      assert.deepEqual(container.environment, [
        { name: "RLS_GUC_ENABLED", value: "true" },
        { name: "SERVICE_NAME", value: service },
        { name: "GIT_SHA", value: sha },
      ]);
      assert.equal(definition.cpu, "512");
    });
  }
  it("fails without changing the definition on an image mismatch, invalid SHA, or secret override", () => {
    for (const options of [
      { image: `example.invalid/api@sha256:${"d".repeat(64)}` },
      { sha: "not-a-release" },
      { secretIdentity: true },
    ]) {
      const { result, definition, original } = stamp("api", options);
      assert.notEqual(result.status, 0);
      assert.equal(JSON.stringify(definition), original);
    }
  });
  it("stamps both ordinary renderers, while same-image operations preserve the source identity", () => {
    const deploy = readFileSync(join(root, "scripts/deploy.sh"), "utf8");
    assert.equal(deploy.match(/stamp-release-runtime-identity\.mjs/g)?.length, 2);
    assert.match(deploy, /--task-definition \.worker-taskdef-new\.json --service scheduler-worker/);
    assert.match(deploy, /--task-definition \.taskdef-new\.json --service api/);
    const start = deploy.indexOf("SAME_IMAGE_SOURCE_PATH=\"$source_path\"");
    const end = deploy.indexOf("run_same_image_migration_task()", start);
    assert.ok(start > 0 && end > start);
    const sameImage = deploy.slice(start, end);
    assert.doesNotMatch(sameImage, /stamp-release-runtime-identity/);
  });
});
