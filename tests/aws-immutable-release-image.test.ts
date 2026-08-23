import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(".github/workflows/release-image.yml", "utf8");
const deploy = readFileSync("scripts/deploy.sh", "utf8");

describe("immutable CI release image contract", () => {
  it("runs only after green main CI and uses OIDC", () => {
    assert.match(workflow, /workflow_run:/);
    assert.match(workflow, /vars\.IMMUTABLE_RELEASE_IMAGE_ENABLED == 'true'/);
    assert.match(workflow, /conclusion == 'success'/);
    assert.match(workflow, /head_branch == 'main'/);
    assert.match(workflow, /id-token: write/);
    assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID/);
  });

  it("builds once, scans, generates an SBOM, signs, and records rollback images", () => {
    assert.equal((workflow.match(/docker build/g) || []).length, 1);
    assert.match(workflow, /format: cyclonedx/);
    assert.match(workflow, /cosign sign --yes/);
    assert.match(workflow, /cosign attest --yes/);
    assert.match(workflow, /previous: \{api: \$apiRollbackImage, worker: \$workerRollbackImage\}/);
  });

  it("allows deploy to verify and reuse the exact digest without removing the shadow build path", () => {
    assert.match(deploy, /--immutable-image-digest/);
    assert.match(deploy, /The ECR SHA tag does not resolve to the authorized immutable image digest/);
    assert.match(deploy, /Using signed CI release image/);
    assert.match(deploy, /Legacy build path remains until two successful shadow deployments/);
    assert.match(deploy, /IMAGE_REF="\$\{ECR_REPO\}@\$\{DIGEST\}"/);
  });
});
