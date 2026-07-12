import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

describe("previous PIN encryption key infrastructure wiring", () => {
  it("is optional and injects only an externally managed parameter ARN", () => {
    const rootVariables = read("infra/variables.tf");
    const rootMain = read("infra/main.tf");
    const ecsVariables = read("infra/modules/ecs/variables.tf");
    const ecsMain = read("infra/modules/ecs/main.tf");
    const ecsSsm = read("infra/modules/ecs/ssm.tf");
    const deployScript = read("scripts/deploy.sh");

    for (const source of [rootVariables, ecsVariables]) {
      assert.match(
        source,
        /variable "google_oauth_previous_encryption_key_parameter_arn"[\s\S]*?default\s*=\s*""/
      );
    }
    assert.match(
      rootMain,
      /google_oauth_previous_encryption_key_parameter_arn\s*=\s*var\.google_oauth_previous_encryption_key_parameter_arn/
    );
    assert.match(
      ecsMain,
      /name\s*=\s*"GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS"[\s\S]*?valueFrom\s*=\s*var\.google_oauth_previous_encryption_key_parameter_arn/
    );
    assert.doesNotMatch(
      ecsSsm,
      /resource "aws_ssm_parameter" "google_oauth_previous_encryption_key"/
    );
    assert.match(
      deployScript,
      /reconcileOptionalSecrets\(container, templateContainer\)[\s\S]*?GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS/
    );
    assert.match(
      deployScript,
      /container\.secrets = mergeNamed\(liveSecrets, templateContainer\.secrets\);\s+reconcileOptionalSecrets\(container, templateContainer\);/
    );
    assert.match(
      deployScript,
      /container\.secrets = mergeNamed\(apiContainer\.secrets, container\.secrets\);\s+reconcileOptionalSecrets\(container, apiContainer\);/
    );
    assert.match(
      deployScript,
      /retiredNames = new Set\(\["OPENAI_API_KEY"\]\)/
    );
    assert.match(
      deployScript,
      /!retiredNames\.has\(item\.name\)/
    );
  });
});
