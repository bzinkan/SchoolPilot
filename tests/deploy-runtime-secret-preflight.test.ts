import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPTIONAL_RUNTIME_PARAMETERS,
  REQUIRED_RUNTIME_PARAMETERS,
  RuntimeSecretValidationError,
  validateSsmMetadataBatches,
  validateTaskSecretReferences,
} from "../scripts/validate-runtime-secret-metadata.mjs";

const context = {
  region: "us-east-1",
  accountId: "123456789012",
  project: "schoolpilot",
  environment: "production",
};

function parameterPath(parameterName: string): string {
  return `/${context.project}/${context.environment}/${parameterName}`;
}

function parameterArn(parameterName: string): string {
  return `arn:aws:ssm:${context.region}:${context.accountId}:parameter/${context.project}/${context.environment}/${parameterName}`;
}

function taskSecrets(options: { optional?: boolean } = {}) {
  const mappings = [
    ...REQUIRED_RUNTIME_PARAMETERS,
    ...(options.optional ? OPTIONAL_RUNTIME_PARAMETERS : []),
  ];
  return mappings.map(([name, parameterName]) => ({
    name,
    valueFrom: parameterArn(parameterName),
  }));
}

function metadata(name: string) {
  const parameterName = name.split("/").at(-1)!;
  return {
    Name: name,
    Type: "SecureString",
    Version: 1,
    ARN: parameterArn(parameterName),
  };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    return error instanceof RuntimeSecretValidationError && error.code === code;
  });
}

function bashExecutable(): string {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  return candidates.find(existsSync) ?? "bash";
}

describe("runtime SecureString reference validation", () => {
  it("requires all ten runtime references and deliberately excludes retired OpenAI", () => {
    const names = validateTaskSecretReferences(taskSecrets(), context);

    assert.equal(names.length, 10);
    assert.deepEqual(
      names,
      [...REQUIRED_RUNTIME_PARAMETERS.values()].map(parameterPath)
    );
    assert.equal(REQUIRED_RUNTIME_PARAMETERS.has("OPENAI_API_KEY"), false);
    assert.equal(OPTIONAL_RUNTIME_PARAMETERS.has("OPENAI_API_KEY"), false);
  });

  it("validates Anthropic, Telegram, and the previous encryption key only when configured", () => {
    const names = validateTaskSecretReferences(taskSecrets({ optional: true }), context);

    assert.equal(names.length, 13);
    assert.deepEqual(
      names.slice(-3),
      [
        parameterPath("ANTHROPIC_API_KEY"),
        parameterPath("TELEGRAM_BOT_TOKEN"),
        parameterPath("GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS"),
      ]
    );
  });

  it("queries and validates the separately controlled temporary previous PIN-key reference", () => {
    const secrets = [
      ...taskSecrets(),
      {
        name: "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS",
        valueFrom: parameterArn("GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS"),
      },
    ];

    const names = validateTaskSecretReferences(secrets, context);
    assert.equal(names.length, 11);
    assert.equal(
      names.includes(parameterPath("GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS")),
      true
    );
  });

  it("fails closed on missing, duplicate, wrong-account, and wrong historical OpenAI references", () => {
    expectCode(
      () => validateTaskSecretReferences(taskSecrets().slice(1), context),
      "required_task_secret_mismatch"
    );
    expectCode(
      () =>
        validateTaskSecretReferences(
          [...taskSecrets(), taskSecrets()[0]],
          context
        ),
      "duplicate_task_secret"
    );

    const wrongAccount = taskSecrets();
    wrongAccount[0] = {
      ...wrongAccount[0],
      valueFrom: wrongAccount[0].valueFrom.replace(context.accountId, "999999999999"),
    };
    expectCode(
      () => validateTaskSecretReferences(wrongAccount, context),
      "required_task_secret_mismatch"
    );

    const wrongPreviousKey = taskSecrets({ optional: true });
    wrongPreviousKey.at(-1)!.valueFrom = parameterArn(
      "GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS"
    ).replace("/production/", "/staging/");
    expectCode(
      () => validateTaskSecretReferences(wrongPreviousKey, context),
      "optional_task_secret_mismatch"
    );

    const exactHistoricalOpenAi = [
      ...taskSecrets(),
      { name: "OPENAI_API_KEY", valueFrom: parameterArn("OPENAI_API_KEY") },
    ];
    assert.deepEqual(
      validateTaskSecretReferences(exactHistoricalOpenAi, context),
      validateTaskSecretReferences(taskSecrets(), context)
    );
    const wrongHistoricalOpenAi = structuredClone(exactHistoricalOpenAi);
    wrongHistoricalOpenAi.at(-1)!.valueFrom = parameterArn("OPENAI_API_KEY").replace(
      context.accountId,
      "999999999999"
    );
    expectCode(
      () => validateTaskSecretReferences(wrongHistoricalOpenAi, context),
      "retired_task_secret_mismatch"
    );
  });

  it("accepts only commercial-partition regions and exact account context", () => {
    expectCode(
      () =>
        validateTaskSecretReferences(taskSecrets(), {
          ...context,
          region: "us-gov-west-1",
        }),
      "invalid_region"
    );
    expectCode(
      () =>
        validateTaskSecretReferences(taskSecrets(), {
          ...context,
          accountId: "1234",
        }),
      "invalid_account"
    );
  });
});

describe("redacted SSM metadata validation", () => {
  it("accepts the exact 13-name metadata set across SSM's ten-name batches", () => {
    const names = validateTaskSecretReferences(taskSecrets({ optional: true }), context);
    const count = validateSsmMetadataBatches(
      [
        { Parameters: names.slice(0, 10).map(metadata), InvalidParameters: [] },
        { Parameters: names.slice(10).map(metadata), InvalidParameters: [] },
      ],
      names,
      context
    );

    assert.equal(count, 13);
  });

  it("rejects invalid names, types, versions, ARNs, duplicates, and omissions", () => {
    const names = validateTaskSecretReferences(taskSecrets(), context);
    const valid = names.map(metadata);
    const cases: Array<[string, unknown, string]> = [
      [
        "invalid SSM names",
        { Parameters: valid, InvalidParameters: [names[0]] },
        "invalid_parameters",
      ],
      [
        "plain strings",
        {
          Parameters: [{ ...valid[0], Type: "String" }, ...valid.slice(1)],
          InvalidParameters: [],
        },
        "invalid_parameter_metadata",
      ],
      [
        "zero versions",
        {
          Parameters: [{ ...valid[0], Version: 0 }, ...valid.slice(1)],
          InvalidParameters: [],
        },
        "invalid_parameter_metadata",
      ],
      [
        "wrong ARNs",
        {
          Parameters: [
            { ...valid[0], ARN: valid[0].ARN.replace(context.region, "us-west-2") },
            ...valid.slice(1),
          ],
          InvalidParameters: [],
        },
        "parameter_arn_mismatch",
      ],
      [
        "duplicates",
        { Parameters: [...valid, valid[0]], InvalidParameters: [] },
        "duplicate_parameter",
      ],
      [
        "missing metadata",
        { Parameters: valid.slice(1), InvalidParameters: [] },
        "missing_parameter",
      ],
    ];

    for (const [label, batch, code] of cases) {
      expectCode(
        () => validateSsmMetadataBatches([batch], names, context),
        code
      );
      assert.ok(label);
    }
  });

  it("rejects any response containing Value and never leaks it through the CLI", () => {
    const names = validateTaskSecretReferences(taskSecrets(), context);
    const secretSentinel = "must-never-appear-in-output";
    const parameters = names.map(metadata);
    const batches = [
      {
        Parameters: [{ ...parameters[0], Value: secretSentinel }, ...parameters.slice(1)],
        InvalidParameters: [],
      },
    ];

    expectCode(
      () => validateSsmMetadataBatches(batches, names, context),
      "invalid_parameter_metadata"
    );

    const scriptPath = fileURLToPath(
      new URL("../scripts/validate-runtime-secret-metadata.mjs", import.meta.url)
    );
    const result = spawnSync(process.execPath, [scriptPath, "metadata"], {
      encoding: "utf8",
      env: {
        ...process.env,
        REGION: context.region,
        ACCOUNT_ID: context.accountId,
        PROJECT: context.project,
        ENVIRONMENT: context.environment,
        SSM_METADATA_BATCHES_JSON: JSON.stringify(batches),
        EXPECTED_PARAMETER_NAMES_JSON: JSON.stringify(names),
      },
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^runtime-secret-preflight:invalid_parameter_metadata\r?\n$/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel));
  });
});

describe("backend deploy integration", () => {
  const deploySource = readFileSync(
    new URL("../scripts/deploy.sh", import.meta.url),
    "utf8"
  );
  const functionStart = deploySource.indexOf("runtime_securestring_preflight() {");
  const executionStart = deploySource.indexOf("# --- Preflight checks ---");
  const invocation = deploySource.indexOf("\n  runtime_securestring_preflight\n", executionStart);
  const dockerBuild = deploySource.indexOf("docker build", executionStart);
  const taskRegistration = deploySource.indexOf("aws ecs register-task-definition", executionStart);
  const functionBody = deploySource.slice(functionStart, executionStart);

  it("runs before Docker build and task-definition registration", () => {
    assert.ok(functionStart > 0);
    assert.ok(invocation > executionStart);
    assert.ok(invocation < dockerBuild);
    assert.ok(invocation < taskRegistration);
  });

  it("uses a no-decryption SSM call with a Value-free metadata projection", () => {
    assert.match(functionBody, /aws ssm get-parameters/);
    assert.match(functionBody, /MSYS2_ARG_CONV_EXCL="\*" aws ssm get-parameters/);
    assert.match(functionBody, /--no-with-decryption/);
    assert.match(
      functionBody,
      /--query '\{Parameters:Parameters\[\]\.\{Name:Name,Type:Type,Version:Version,ARN:ARN\},InvalidParameters:InvalidParameters\}'/
    );
    assert.doesNotMatch(functionBody, /Value:Value/);
    assert.doesNotMatch(functionBody, /--with-decryption/);
  });

  it("batches at SSM's ten-name limit and validates active API and worker revisions", () => {
    assert.match(functionBody, /offset \+= 10/);
    assert.match(functionBody, /parameter_names\[@\]:offset:10/);
    assert.match(functionBody, /services=\("\$SERVICE" "\$WORKER_SERVICE"\)/);
    assert.match(functionBody, /containers=\("api" "scheduler-worker"\)/);
    assert.match(functionBody, /services\[0\]\.taskDefinition/);
    assert.match(functionBody, /unique\.length > 13/);
  });

  it("executes the active two-service contract successfully against redacted mock metadata", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "schoolpilot-runtime-secret-preflight-"));
    const mockAwsPath = join(fixtureDir, "mock-aws.mjs");
    const commandLogPath = join(fixtureDir, "commands.jsonl");
    writeFileSync(
      mockAwsPath,
      `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_AWS_LOG, JSON.stringify(args) + "\\n");
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === "ecs" && args[1] === "describe-services") {
  if ((option("--query") || "").includes(".status")) {
    process.stdout.write("ACTIVE\\n");
  } else {
    const service = option("--services");
    const revision = service.endsWith("scheduler-worker") ? "21" : "101";
    process.stdout.write(
      \`arn:aws:ecs:us-east-1:135775632425:task-definition/\${service}:\${revision}\\n\`
    );
  }
} else if (args[0] === "ecs" && args[1] === "describe-task-definition") {
  process.stdout.write(process.env.MOCK_TASK_SECRETS_JSON + "\\n");
} else if (args[0] === "ssm" && args[1] === "get-parameters") {
  const start = args.indexOf("--names") + 1;
  const names = [];
  for (let index = start; index < args.length && !args[index].startsWith("--"); index++) {
    names.push(args[index]);
  }
  const parameters = names.map((Name) => ({
    Name,
    Type: "SecureString",
    Version: 1,
    ARN: \`arn:aws:ssm:us-east-1:135775632425:parameter\${Name}\`,
  }));
  process.stdout.write(JSON.stringify({ Parameters: parameters, InvalidParameters: [] }) + "\\n");
} else {
  process.exitCode = 91;
}
`,
      "utf8"
    );

    const librarySource = deploySource.slice(0, executionStart);
    const scriptDirectory = fileURLToPath(
      new URL("../scripts", import.meta.url)
    ).replaceAll("\\", "/");
    const preflightInput = `
${librarySource}
SCRIPT_DIR="$TEST_SCRIPT_DIRECTORY"
aws() { node "$TEST_MOCK_AWS" "$@"; }
runtime_securestring_preflight
`;
    const exactHistoricalSecrets = [
      ...taskSecrets({ optional: true }),
      { name: "OPENAI_API_KEY", valueFrom: parameterArn("OPENAI_API_KEY") },
    ];
    const mockEnvironment = {
      ...process.env,
      TEST_SCRIPT_DIRECTORY: scriptDirectory,
      TEST_MOCK_AWS: mockAwsPath.replaceAll("\\", "/"),
      MOCK_AWS_LOG: commandLogPath,
    };
    const result = spawnSync(bashExecutable(), ["-s"], {
      encoding: "utf8",
      input: preflightInput,
      env: {
        ...mockEnvironment,
        MOCK_TASK_SECRETS_JSON: JSON.stringify(exactHistoricalSecrets).replaceAll(
          context.accountId,
          "135775632425"
        ),
      },
    });

    try {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const commands = readFileSync(commandLogPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as string[]);
      const ssmCalls = commands.filter(
        (args) => args[0] === "ssm" && args[1] === "get-parameters"
      );
      assert.equal(ssmCalls.length, 2);
      assert.deepEqual(
        ssmCalls.map((args) => {
          const start = args.indexOf("--names") + 1;
          const end = args.findIndex((arg, index) => index >= start && arg.startsWith("--"));
          return args.slice(start, end).length;
        }),
        [10, 3]
      );
      assert.ok(ssmCalls.every((args) => args.includes("--no-with-decryption")));
      assert.equal(
        commands.filter(
          (args) => args[0] === "ecs" && args[1] === "describe-task-definition"
        ).length,
        2
      );

      writeFileSync(commandLogPath, "", "utf8");
      const wrongHistoricalSecrets = structuredClone(exactHistoricalSecrets);
      wrongHistoricalSecrets.at(-1)!.valueFrom = parameterArn("OPENAI_API_KEY").replace(
        context.accountId,
        "999999999999"
      );
      const rejected = spawnSync(bashExecutable(), ["-s"], {
        encoding: "utf8",
        input: preflightInput,
        env: {
          ...mockEnvironment,
          MOCK_TASK_SECRETS_JSON: JSON.stringify(wrongHistoricalSecrets).replaceAll(
            context.accountId,
            "135775632425"
          ),
        },
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /runtime-secret-preflight:retired_task_secret_mismatch/);
      const rejectedCommands = readFileSync(commandLogPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(
        rejectedCommands.filter(
          (args) => args[0] === "ssm" && args[1] === "get-parameters"
        ).length,
        0
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("renders the historical OpenAI reference out of API and emergency revisions", () => {
    const renderMarker = 'IMAGE_REF="${ECR_REPO}@${DIGEST}" node -e \'';
    const renderMarkerIndex = deploySource.indexOf(renderMarker);
    const renderScriptStart = renderMarkerIndex + renderMarker.length;
    const renderScriptEnd = deploySource.indexOf("\n  '\n\n  NEW_REV=", renderScriptStart);
    assert.ok(renderMarkerIndex > 0 && renderScriptEnd > renderScriptStart);
    const renderScript = deploySource.slice(renderScriptStart, renderScriptEnd);

    const emergencyMarker = 'EMERGENCY_FAMILY="${NAME}-api-emergency" IMAGE_REF="${ECR_REPO}@${DIGEST}" node -e \'';
    const emergencyMarkerIndex = deploySource.indexOf(emergencyMarker);
    const emergencyScriptStart = emergencyMarkerIndex + emergencyMarker.length;
    const emergencyScriptEnd = deploySource.indexOf(
      "\n  '\n\n  EMERGENCY_TASK_DEF_ARN=",
      emergencyScriptStart
    );
    assert.ok(emergencyMarkerIndex > 0 && emergencyScriptEnd > emergencyScriptStart);
    const emergencyScript = deploySource.slice(emergencyScriptStart, emergencyScriptEnd);

    const fixtureDir = mkdtempSync(join(tmpdir(), "schoolpilot-openai-reconcile-"));
    const deploySecrets = JSON.parse(
      JSON.stringify([
        ...taskSecrets({ optional: true }),
        { name: "OPENAI_API_KEY", valueFrom: parameterArn("OPENAI_API_KEY") },
      ]).replaceAll(context.accountId, "135775632425")
    );
    const currentTask = {
      family: "schoolpilot-production-api",
      cpu: "512",
      memory: "1024",
      containerDefinitions: [
        {
          name: "api",
          image: "old.invalid/image:old",
          environment: [
            { name: "PORT", value: "4000" },
            { name: "OPENAI_API_KEY", value: "historical-plaintext-must-disappear" },
          ],
          secrets: deploySecrets,
        },
      ],
    };
    const templateTask = {
      family: "schoolpilot-production-api",
      cpu: "512",
      memory: "1024",
      containerDefinitions: [
        {
          name: "api",
          image: "template.invalid/image:latest",
          environment: [{ name: "PORT", value: "4000" }],
          secrets: deploySecrets.filter((secret: { name: string }) => secret.name !== "OPENAI_API_KEY"),
        },
      ],
    };
    writeFileSync(join(fixtureDir, ".taskdef-current.json"), JSON.stringify(currentTask));
    writeFileSync(join(fixtureDir, ".taskdef-template.json"), JSON.stringify(templateTask));
    const imageRef = "135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@sha256:0123456789abcdef";

    try {
      const rendered = spawnSync(process.execPath, ["-e", renderScript], {
        cwd: fixtureDir,
        encoding: "utf8",
        env: {
          ...process.env,
          ACCOUNT_ID: "135775632425",
          REGION: "us-east-1",
          PROJECT: "schoolpilot",
          ENVIRONMENT: "production",
          IMAGE_REF: imageRef,
        },
      });
      assert.equal(rendered.status, 0, `${rendered.stdout}\n${rendered.stderr}`);
      const apiTask = JSON.parse(readFileSync(join(fixtureDir, ".taskdef-new.json"), "utf8"));
      const apiContainer = apiTask.containerDefinitions[0];
      assert.equal(apiContainer.secrets.some((item: { name: string }) => item.name === "OPENAI_API_KEY"), false);
      assert.equal(apiContainer.environment.some((item: { name: string }) => item.name === "OPENAI_API_KEY"), false);
      assert.equal(apiContainer.image, imageRef);

      const emergency = spawnSync(process.execPath, ["-e", emergencyScript], {
        cwd: fixtureDir,
        encoding: "utf8",
        env: {
          ...process.env,
          EMERGENCY_FAMILY: "schoolpilot-production-api-emergency",
          IMAGE_REF: imageRef,
        },
      });
      assert.equal(emergency.status, 0, `${emergency.stdout}\n${emergency.stderr}`);
      const emergencyTask = JSON.parse(
        readFileSync(join(fixtureDir, ".taskdef-emergency.json"), "utf8")
      );
      assert.equal(
        emergencyTask.containerDefinitions[0].secrets.some(
          (item: { name: string }) => item.name === "OPENAI_API_KEY"
        ),
        false
      );
      assert.equal(
        (deploySource.match(/retiredNames = new Set\(\["OPENAI_API_KEY"\]\)/g) ?? []).length,
        2,
        "API and worker renderers must each strip the retired key"
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

describe("previous Google OAuth encryption-key Terraform ARN gate", () => {
  const ecsModuleSource = readFileSync(
    new URL("../infra/modules/ecs/main.tf", import.meta.url),
    "utf8"
  );
  const terraformTestSource = readFileSync(
    new URL("../infra/tests/secret_state_detachment.tftest.hcl", import.meta.url),
    "utf8"
  );

  it("uses exact region, account, project, environment, and parameter-path equality", () => {
    assert.match(
      ecsModuleSource,
      /expected_google_oauth_previous_encryption_key_parameter_arn\s*=\s*"arn:aws:ssm:\$\{var\.aws_region\}:\$\{var\.aws_account_id\}:parameter\/\$\{var\.project\}\/\$\{var\.environment\}\/GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS"/
    );
    assert.match(
      ecsModuleSource,
      /var\.google_oauth_previous_encryption_key_parameter_arn == "" \|\|\s*var\.google_oauth_previous_encryption_key_parameter_arn == local\.expected_google_oauth_previous_encryption_key_parameter_arn/
    );
    assert.equal(
      (ecsModuleSource.match(/condition\s*=\s*local\.google_oauth_previous_encryption_key_parameter_arn_valid/g) ?? []).length,
      2
    );
  });

  it("has native Terraform coverage for empty, exact, and wrong-environment values", () => {
    assert.match(terraformTestSource, /run "runtime_secret_arns_are_stable_without_values"/);
    assert.match(terraformTestSource, /run "previous_pin_key_is_arn_only_and_temporary"/);
    assert.match(terraformTestSource, /run "previous_pin_key_rejects_wrong_environment_arn"/);
    assert.match(
      terraformTestSource,
      /expect_failures = \[\s*aws_ecs_task_definition\.api,\s*aws_ecs_task_definition\.worker,\s*\]/
    );
  });
});
