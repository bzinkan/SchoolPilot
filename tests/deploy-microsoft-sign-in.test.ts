import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  addMicrosoftSignIn,
  assertMicrosoftSignIn,
  microsoftClientSecretArn,
  validateClientId,
} from "../scripts/enable-microsoft-sign-in-runtime.mjs";

const CLIENT_ID = "0c1f7a55-7b39-4c52-8a3b-0d5b7f2e9a10";
const context = { region: "us-east-1", accountId: "123456789012", project: "schoolpilot", environment: "production" };
const SECRET_ARN = "arn:aws:ssm:us-east-1:123456789012:parameter/schoolpilot/production/MICROSOFT_CLIENT_SECRET";
const helperPath = fileURLToPath(new URL("../scripts/enable-microsoft-sign-in-runtime.mjs", import.meta.url));
const deploySource = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function apiTaskDefinition() {
  return {
    family: "schoolpilot-production-api",
    containerDefinitions: [
      {
        name: "api",
        environment: [{ name: "GOOGLE_CLIENT_ID", value: "google-client" }],
        secrets: [{ name: "GOOGLE_CLIENT_SECRET", valueFrom: "arn:google" }],
      },
    ],
  };
}

describe("Microsoft sign-in deploy delta", () => {
  it("accepts only a lowercase Entra client ID and builds the environment-scoped secret ARN", () => {
    assert.equal(validateClientId(CLIENT_ID), CLIENT_ID);
    assert.throws(() => validateClientId(CLIENT_ID.toUpperCase()));
    assert.throws(() => validateClientId("SchoolPilot"));
    assert.equal(microsoftClientSecretArn(context), SECRET_ARN);
    assert.throws(() => microsoftClientSecretArn({ ...context, accountId: "1234" }));
  });

  it("adds the client ID and secret reference to the API container and keeps everything else", () => {
    const rendered = addMicrosoftSignIn(apiTaskDefinition(), {
      containerName: "api",
      clientId: CLIENT_ID,
      secretArn: SECRET_ARN,
    });
    const api = rendered.containerDefinitions[0]!;
    assert.deepEqual(api.environment, [
      { name: "GOOGLE_CLIENT_ID", value: "google-client" },
      { name: "MICROSOFT_CLIENT_ID", value: CLIENT_ID },
    ]);
    assert.deepEqual(api.secrets, [
      { name: "GOOGLE_CLIENT_SECRET", valueFrom: "arn:google" },
      { name: "MICROSOFT_CLIENT_SECRET", valueFrom: SECRET_ARN },
    ]);
    assert.doesNotThrow(() => assertMicrosoftSignIn(rendered, { containerName: "api", clientId: CLIENT_ID, secretArn: SECRET_ARN }));

    const replaced = addMicrosoftSignIn(rendered, { containerName: "api", clientId: CLIENT_ID, secretArn: SECRET_ARN });
    assert.equal(replaced.containerDefinitions[0]!.environment.filter((entry: { name: string }) => entry.name === "MICROSOFT_CLIENT_ID").length, 1);
  });

  it("refuses an inline secret, a missing container, and a revision that lost or changed the settings", () => {
    const inline = apiTaskDefinition();
    inline.containerDefinitions[0]!.environment.push({ name: "MICROSOFT_CLIENT_SECRET", value: "plaintext" });
    assert.throws(() => addMicrosoftSignIn(inline, { containerName: "api", clientId: CLIENT_ID, secretArn: SECRET_ARN }), /inline/);
    assert.throws(() => addMicrosoftSignIn(apiTaskDefinition(), { containerName: "scheduler-worker", clientId: CLIENT_ID, secretArn: SECRET_ARN }), /exactly one/);

    const request = { containerName: "api", clientId: CLIENT_ID, secretArn: SECRET_ARN };
    assert.throws(() => assertMicrosoftSignIn(apiTaskDefinition(), request), /MICROSOFT_CLIENT_ID/);
    const otherClient = addMicrosoftSignIn(apiTaskDefinition(), { ...request, clientId: "11111111-2222-3333-4444-555555555555" });
    assert.throws(() => assertMicrosoftSignIn(otherClient, request), /MICROSOFT_CLIENT_ID/);
    const otherSecret = addMicrosoftSignIn(apiTaskDefinition(), { ...request, secretArn: SECRET_ARN.replace("production", "staging") });
    assert.throws(() => assertMicrosoftSignIn(otherSecret, request), /MICROSOFT_CLIENT_SECRET/);
  });

  it("renders and verifies a task definition file through the CLI deploy.sh calls", () => {
    const directory = mkdtempSync(join(tmpdir(), "schoolpilot-microsoft-sign-in-"));
    const file = join(directory, "taskdef.json");
    writeFileSync(file, JSON.stringify(apiTaskDefinition()));
    const common = ["--client-id", CLIENT_ID, "--region", context.region, "--account-id", context.accountId,
      "--project", context.project, "--environment", context.environment];
    try {
      const add = spawnSync(process.execPath, [helperPath, "add", "--task-definition", file, "--container", "api", ...common], { encoding: "utf8" });
      assert.equal(add.status, 0, add.stderr);
      const verify = spawnSync(process.execPath, [helperPath, "verify", "--task-definition", file, "--container", "api", ...common], { encoding: "utf8" });
      assert.equal(verify.status, 0, verify.stderr);
      const wrong = spawnSync(process.execPath, [helperPath, "verify", "--task-definition", file, "--container", "api",
        ...common.map((value) => (value === CLIENT_ID ? "11111111-2222-3333-4444-555555555555" : value))], { encoding: "utf8" });
      assert.notEqual(wrong.status, 0);
      const rejected = spawnSync(process.execPath, [helperPath, "validate-request", "--client-id", "not-a-guid"], { encoding: "utf8" });
      assert.notEqual(rejected.status, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("deploy.sh Microsoft sign-in flag", () => {
  it("parses the flag once and validates it before any AWS mutation", () => {
    assert.match(deploySource, /--enable-microsoft-sign-in\)\n\s+\[\[ \$# -ge 2 \]\]/);
    assert.match(deploySource, /--enable-microsoft-sign-in may be specified only once/);
    const validation = deploySource.slice(
      deploySource.indexOf("validate_microsoft_sign_in_enablement_mode() {"),
      deploySource.indexOf("validate_staff_identity_contract_rollout_mode() {")
    );
    for (const guard of [
      '"$DEPLOY_FRONTEND" != false',
      '"$CONFIRM_PROTECTED_WINDOW_PRODUCTION_MUTATION" == true',
      '"$APPLY_STAFF_IDENTITY_CONTRACTS" == true',
      '-n "$SAME_IMAGE_NETWORKING_STAGE"',
      '"$CAPACITY_ACCEPTANCE_RELEASE" == true',
    ]) {
      assert.ok(validation.includes(guard), `missing guard ${guard}`);
    }
    const validateCall = deploySource.indexOf("if ! validate_microsoft_sign_in_enablement_mode; then");
    assert.ok(validateCall > 0 && validateCall < deploySource.indexOf("docker build"), "validation must run before the image build");
  });

  it("checks the SSM SecureString without decrypting it before registering anything", () => {
    const preflight = deploySource.slice(
      deploySource.indexOf("preflight_microsoft_sign_in_secret() {"),
      deploySource.indexOf("register_classpilot_candidate_worker_task_definition() {")
    );
    assert.match(
      preflight,
      /MSYS2_ARG_CONV_EXCL="\*" aws ssm describe-parameters/,
      "Git Bash would rewrite the /schoolpilot/... filter into a Windows path without the exclusion"
    );
    assert.match(preflight, /MICROSOFT_CLIENT_SECRET/);
    assert.match(preflight, /!= "SecureString"/);
    assert.doesNotMatch(preflight, /--with-decryption|get-parameter/);
    assert.match(deploySource, /preflight_rls_table_enablement_sources\n\s+preflight_microsoft_sign_in_secret\n/);
  });

  it("adds the settings to the rendered API before the API and emergency revisions register, then verifies all three", () => {
    const addIndex = deploySource.indexOf('enable-microsoft-sign-in-runtime.mjs" add');
    assert.ok(addIndex > deploySource.indexOf('fs.writeFileSync(".taskdef-new.json"'));
    assert.ok(addIndex < deploySource.indexOf("STANDARD_API_CANDIDATE_TASK_DEFINITION_ARN=$(aws ecs register-task-definition"));
    assert.ok(addIndex < deploySource.indexOf('EMERGENCY_FAMILY="${NAME}-api-emergency"'));
    assert.match(
      deploySource,
      /verify_registered_rls_table_enablement_candidates\n\s+verify_registered_microsoft_sign_in_candidates\n/
    );
    const verify = deploySource.slice(
      deploySource.indexOf("verify_registered_microsoft_sign_in_candidates() {"),
      deploySource.indexOf("verify_classpilot_rehearsed_candidates() {")
    );
    assert.match(verify, /standard-api emergency-api scheduler-worker/);
    assert.match(verify, /scheduler-worker\) arn="\$WORKER_CANDIDATE_TASK_DEF"; container=scheduler-worker/);
  });
});
