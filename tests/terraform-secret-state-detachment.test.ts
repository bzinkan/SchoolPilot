import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

const repositoryRoot = process.cwd();
const infraRoot = path.join(repositoryRoot, "infra");
const temporaryDirectories: string[] = [];
const terraformAvailable = spawnSync("terraform", ["version"], {
  encoding: "utf8",
  windowsHide: true,
}).status === 0;
const powerShellAvailable = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], {
  encoding: "utf8",
  windowsHide: true,
}).status === 0;
const secretResourceNames = [
  "database_url",
  "session_secret",
  "jwt_secret",
  "student_token_secret",
  "google_client_secret",
  "google_oauth_encryption_key",
  "sendgrid_api_key",
  "stripe_secret_key",
  "stripe_webhook_secret",
  "openai_api_key",
] as const;

const runtimeParameterNames = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "JWT_SECRET",
  "STUDENT_TOKEN_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_ENCRYPTION_KEY",
  "SENDGRID_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function terraform(args: string[], cwd: string) {
  return spawnSync("terraform", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" },
  });
}

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Terraform application-secret state detachment", () => {
  it("uses ten forget-only removed blocks and keeps only topology-derived Redis managed", () => {
    const source = read("infra/modules/ecs/ssm.tf");
    for (const resourceName of secretResourceNames) {
      const removed = new RegExp(
        `removed\\s*\\{\\s*from\\s*=\\s*aws_ssm_parameter\\.${resourceName}\\s*lifecycle\\s*\\{\\s*destroy\\s*=\\s*false`,
        "s"
      );
      assert.match(source, removed, `${resourceName} must be forgotten without destroy`);
      assert.doesNotMatch(
        source,
        new RegExp(`resource\\s+"aws_ssm_parameter"\\s+"${resourceName}"`)
      );
    }
    assert.equal((source.match(/destroy\s*=\s*false/g) || []).length, 10);
    assert.match(source, /resource "aws_ssm_parameter" "redis_url"/);
  });

  it("contains no application secret value variables or references", () => {
    const sources = [
      read("infra/main.tf"),
      read("infra/variables.tf"),
      read("infra/modules/ecs/main.tf"),
      read("infra/modules/ecs/variables.tf"),
      read("infra/modules/ecs/ssm.tf"),
    ].join("\n");
    for (const name of secretResourceNames) {
      assert.doesNotMatch(sources, new RegExp(`variable\\s+"${name}"`));
      assert.doesNotMatch(sources, new RegExp(`var\\.${name}(?![A-Za-z0-9_])`));
    }
  });

  it("constructs the same stable SSM ARNs for every runtime credential", () => {
    const ecsMain = read("infra/modules/ecs/main.tf");
    assert.match(
      ecsMain,
      /arn:aws:ssm:\$\{var\.aws_region\}:\$\{var\.aws_account_id\}:parameter\/\$\{var\.project\}\/\$\{var\.environment\}\/\$\{name\}/
    );
    for (const parameterName of runtimeParameterNames) {
      assert.match(ecsMain, new RegExp(`"${parameterName}"`));
    }
    assert.doesNotMatch(ecsMain, /"OPENAI_API_KEY"/);
    assert.match(
      ecsMain,
      /name = "REDIS_URL", valueFrom = aws_ssm_parameter\.redis_url\.arn/
    );
  });

  it("keeps production and HA profiles free of secret-value assignments", () => {
    for (const profile of ["infra/production.tfvars", "infra/production-ha-2000.tfvars"]) {
      const source = read(profile);
      for (const name of secretResourceNames) {
        assert.doesNotMatch(source, new RegExp(`^\\s*${name}\\s*=`, "m"));
      }
    }
  });

  it("pins the same public Google client ID in both production profiles", () => {
    const profiles = ["infra/production.tfvars", "infra/production-ha-2000.tfvars"];
    const clientIds = profiles.map((profile) => {
      const match = read(profile).match(/^\s*google_client_id\s*=\s*"([^"]+)"/m);
      assert.ok(match, `${profile} must pin google_client_id`);
      assert.match(match[1]!, /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/);
      return match[1]!;
    });

    assert.equal(clientIds[0], clientIds[1]);
  });

  it("uses an address-only, backup-gated state-rm workflow before any plan", () => {
    const source = read("scripts/terraform-detach-application-secret-state.ps1");
    for (const resourceName of secretResourceNames) {
      assert.match(
        source,
        new RegExp(`module\\.ecs\\.aws_ssm_parameter\\.${resourceName}`)
      );
    }
    assert.match(source, /"state",\s*"rm",\s*"-dry-run"/s);
    assert.match(source, /"-backup=\$backupSink"/);
    assert.match(source, /if \(\$IsWindows\) \{ "NUL" \} else \{ "\/dev\/null" \}/);
    assert.match(source, /Execute mode requires both verified encrypted state backup paths and the ACL-restricted DPAPI recovery credential/);
    assert.match(source, /-Mode Verify/);
    assert.match(source, /RetirePlaintextSecretSource/);
    assert.match(source, /\[System\.IO\.File\]::Delete\(\$ResolvedPath\)/);
    assert.match(source, /redis_url/);
    assert.doesNotMatch(source, /"(?:plan|apply|destroy|show)"/);
  });

  it(
    "the detachment CLI removes only the ten bindings and preserves Redis",
    { skip: !terraformAvailable || !powerShellAvailable },
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "schoolpilot-tf-detach-cli-"));
      temporaryDirectories.push(directory);
      const sentinel = "SCHOOLPILOT_STATE_ONLY_SECRET_SENTINEL";
      const resources = [...secretResourceNames, "redis_url"].map((name) => ({
        module: "module.ecs",
        mode: "managed",
        type: "aws_ssm_parameter",
        name,
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          {
            schema_version: 0,
            attributes: {
              arn: `arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/${name}`,
              id: `/schoolpilot/test/${name}`,
              name: `/schoolpilot/test/${name}`,
              type: "SecureString",
              value: name === "redis_url" ? "rediss://cache.invalid:6379" : sentinel,
            },
            sensitive_attributes: name === "redis_url" ? [] : [[{ type: "get_attr", value: "value" }]],
          },
        ],
      }));
      writeFileSync(
        path.join(directory, "terraform.tfstate"),
        JSON.stringify({
          version: 4,
          terraform_version: "1.14.3",
          serial: 1,
          lineage: randomUUID(),
          outputs: {},
          resources,
          check_results: null,
        }),
        "utf8"
      );
      writeFileSync(path.join(directory, "main.tf"), "terraform {}\n", "utf8");
      const plaintextSource = path.join(directory, "secrets.auto.tfvars");
      writeFileSync(plaintextSource, sentinel, "utf8");
      const backupDirectory = path.join(directory, "backups");
      const recovery = path.join(directory, "verified.aesgcm");
      const recoveryCredential = path.join(directory, "recovery-credential.dpapi");
      const backupSetup = path.join(directory, "prepare-backups.ps1");
      writeFileSync(
        backupSetup,
        `#requires -Version 7.0
param([string]$Tool,[string]$State,[string]$Output,[string]$Recovery,[string]$Credential,[string]$PlaintextSource)
$ErrorActionPreference = "Stop"
$passphrase = ConvertTo-SecureString -String "synthetic-${randomUUID()}-${randomUUID()}" -AsPlainText -Force
try {
  & $Tool -Mode Backup -StatePath $State -OutputDirectory $Output -Phase "detach-test" -Usage Manual -RecoveryPath $Recovery -RecoveryPassphrase $passphrase
  $protected = ConvertFrom-SecureString -SecureString $passphrase
  [IO.File]::WriteAllText($Credential, $protected, [Text.UTF8Encoding]::new($false))
  $currentUser = (& whoami.exe).Trim()
  & icacls.exe $Credential /inheritance:r /grant:r "\${currentUser}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "ACL setup failed" }
  & icacls.exe $PlaintextSource /inheritance:r /grant:r "\${currentUser}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Plaintext source ACL setup failed" }
} finally { $passphrase.Dispose() }
`,
        "utf8"
      );
      const backupSetupResult = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          backupSetup,
          "-Tool",
          path.join(repositoryRoot, "scripts", "terraform-state-backup.ps1"),
          "-State",
          path.join(directory, "terraform.tfstate"),
          "-Output",
          backupDirectory,
          "-Recovery",
          recovery,
          "-Credential",
          recoveryCredential,
          "-PlaintextSource",
          plaintextSource,
        ],
        { encoding: "utf8", windowsHide: true }
      );
      assert.equal(backupSetupResult.status, 0, backupSetupResult.stderr);
      const dpapiFiles = readdirSync(backupDirectory).filter((name) => name.endsWith(".dpapi"));
      assert.equal(dpapiFiles.length, 1);
      const dpapi = path.join(backupDirectory, dpapiFiles[0]!);
      writeFileSync(path.join(directory, "terraform.tfstate.backup"), sentinel, "utf8");

      const wrongRetirement = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          path.join(repositoryRoot, "scripts", "terraform-detach-application-secret-state.ps1"),
          "-Execute",
          "-TerraformDirectory",
          directory,
          "-VerifiedDpapiBackupPath",
          dpapi,
          "-VerifiedRecoveryBackupPath",
          recovery,
          "-RecoveryCredentialDpapiPath",
          recoveryCredential,
          "-RetirePlaintextSecretSource",
          "-PlaintextSecretSourcePath",
          path.join(directory, "wrong.auto.tfvars"),
        ],
        { encoding: "utf8", windowsHide: true }
      );
      assert.notEqual(wrongRetirement.status, 0);
      assert.equal(existsSync(plaintextSource), true);
      const beforeRejectedRetirement = terraform(["state", "list"], directory);
      assert.equal(beforeRejectedRetirement.status, 0, beforeRejectedRetirement.stderr);
      assert.equal(beforeRejectedRetirement.stdout.trim().split(/\r?\n/).length, 11);

      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          path.join(repositoryRoot, "scripts", "terraform-detach-application-secret-state.ps1"),
          "-Execute",
          "-TerraformDirectory",
          directory,
          "-VerifiedDpapiBackupPath",
          dpapi,
          "-VerifiedRecoveryBackupPath",
          recovery,
          "-RecoveryCredentialDpapiPath",
          recoveryCredential,
          "-RetirePlaintextSecretSource",
          "-PlaintextSecretSourcePath",
          plaintextSource,
        ],
        { encoding: "utf8", windowsHide: true }
      );
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
      assert.deepEqual(report, {
        status: "detached",
        candidates: 10,
        previouslyOwned: 10,
        detached: 10,
        remaining: 0,
        redisStillOwned: true,
        plaintextBackupsRemoved: 1,
        plaintextSecretSourceRemoved: 1,
      });
      const state = readFileSync(path.join(directory, "terraform.tfstate"), "utf8");
      assert.doesNotMatch(state, new RegExp(sentinel));
      const listed = terraform(["state", "list"], directory);
      assert.equal(listed.status, 0, listed.stderr);
      assert.equal(listed.stdout.trim(), "module.ecs.aws_ssm_parameter.redis_url");
      assert.equal(existsSync(path.join(directory, "terraform.tfstate.backup")), false);
      assert.equal(existsSync(plaintextSource), false);
    }
  );

  it(
    "removes state before planning so Terraform 1.14 plan/show contain no prior value",
    { skip: !terraformAvailable },
    () => {
    const directory = mkdtempSync(path.join(tmpdir(), "schoolpilot-tf-forget-"));
    temporaryDirectories.push(directory);
    const sentinel = "SCHOOLPILOT_REMOVED_SECRET_SENTINEL";
    const mainPath = path.join(directory, "main.tf");
    writeFileSync(
      mainPath,
      `terraform { required_version = ">= 1.7, < 2.0" }\nresource "terraform_data" "secret" { input = "${sentinel}" }\n`,
      "utf8"
    );
    const initialized = terraform(["init", "-backend=false", "-input=false", "-no-color"], directory);
    assert.equal(initialized.status, 0, initialized.stderr);
    const applied = terraform(["apply", "-auto-approve", "-input=false", "-no-color"], directory);
    assert.equal(applied.status, 0, applied.stderr);

    const nullBackup = process.platform === "win32" ? "NUL" : "/dev/null";
    const detached = terraform(
      ["state", "rm", `-backup=${nullBackup}`, "terraform_data.secret"],
      directory
    );
    assert.equal(detached.status, 0, detached.stderr);
    assert.doesNotMatch(detached.stdout + detached.stderr, new RegExp(sentinel));
    assert.doesNotMatch(
      readFileSync(path.join(directory, "terraform.tfstate"), "utf8"),
      new RegExp(sentinel)
    );

    writeFileSync(
      mainPath,
      `terraform { required_version = ">= 1.7, < 2.0" }\nremoved {\n  from = terraform_data.secret\n  lifecycle { destroy = false }\n}\n`,
      "utf8"
    );
    const planPath = path.join(directory, "detach.tfplan");
    const planned = terraform(
      ["plan", "-refresh=false", "-input=false", "-no-color", `-out=${planPath}`],
      directory
    );
    assert.equal(planned.status, 0, planned.stderr);
    assert.doesNotMatch(planned.stdout + planned.stderr, new RegExp(sentinel));
    assert.equal(existsSync(planPath), true);

    const shown = terraform(["show", "-json", planPath], directory);
    assert.equal(shown.status, 0, shown.stderr);
    assert.doesNotMatch(shown.stdout, new RegExp(sentinel));
    const plan = JSON.parse(shown.stdout);
    const changes = plan.resource_changes || [];
    assert.equal(changes.length, 0);
    assert.equal(
      changes.some((change: { change?: { actions?: string[] } }) =>
        change.change?.actions?.includes("delete")
      ),
      false
    );
    }
  );
});
