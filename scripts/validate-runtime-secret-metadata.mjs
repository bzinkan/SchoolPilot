import { pathToFileURL } from "node:url";

export const REQUIRED_RUNTIME_PARAMETERS = new Map([
  ["DATABASE_URL", "DATABASE_URL"],
  ["REDIS_URL", "REDIS_URL"],
  ["SESSION_SECRET", "SESSION_SECRET"],
  ["JWT_SECRET", "JWT_SECRET"],
  ["STUDENT_TOKEN_SECRET", "STUDENT_TOKEN_SECRET"],
  ["GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"],
  ["GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY", "GOOGLE_OAUTH_ENCRYPTION_KEY"],
  ["SENDGRID_API_KEY", "SENDGRID_API_KEY"],
  ["STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY"],
  ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET"],
]);

export const OPTIONAL_RUNTIME_PARAMETERS = new Map([
  ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
  ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"],
  [
    "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS",
    "GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS",
  ],
]);

export class RuntimeSecretValidationError extends Error {
  constructor(code) {
    super(`Runtime secret metadata validation failed (${code}).`);
    this.name = "RuntimeSecretValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new RuntimeSecretValidationError(code);
}

function validateContext(context) {
  if (
    !/^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-\d$/.test(
      context.region || ""
    )
  ) {
    fail("invalid_region");
  }
  if (!/^\d{12}$/.test(context.accountId || "")) fail("invalid_account");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(context.project || "")) fail("invalid_project");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(context.environment || "")) fail("invalid_environment");
}

function parameterPath(parameterName, context) {
  return `/${context.project}/${context.environment}/${parameterName}`;
}

function parameterArn(parameterName, context) {
  return `arn:aws:ssm:${context.region}:${context.accountId}:parameter/${context.project}/${context.environment}/${parameterName}`;
}

export function validateTaskSecretReferences(secrets, context) {
  validateContext(context);
  if (!Array.isArray(secrets)) fail("invalid_task_secret_shape");

  const byName = new Map();
  for (const secret of secrets) {
    if (
      !secret ||
      typeof secret !== "object" ||
      typeof secret.name !== "string" ||
      typeof secret.valueFrom !== "string"
    ) {
      fail("invalid_task_secret_shape");
    }
    if (byName.has(secret.name)) fail("duplicate_task_secret");
    byName.set(secret.name, secret.valueFrom);
  }

  // Bootstrap exception: an active pre-cleanup revision may still contain the
  // retired key. Accept only its historical environment-scoped ARN, never ask
  // SSM for it, and let deploy rendering remove the reference unconditionally.
  if (
    byName.has("OPENAI_API_KEY") &&
    byName.get("OPENAI_API_KEY") !== parameterArn("OPENAI_API_KEY", context)
  ) {
    fail("retired_task_secret_mismatch");
  }

  const parameterNames = [];
  for (const [environmentName, parameterName] of REQUIRED_RUNTIME_PARAMETERS) {
    if (byName.get(environmentName) !== parameterArn(parameterName, context)) {
      fail("required_task_secret_mismatch");
    }
    parameterNames.push(parameterPath(parameterName, context));
  }

  for (const [environmentName, parameterName] of OPTIONAL_RUNTIME_PARAMETERS) {
    if (!byName.has(environmentName)) continue;
    if (byName.get(environmentName) !== parameterArn(parameterName, context)) {
      fail("optional_task_secret_mismatch");
    }
    parameterNames.push(parameterPath(parameterName, context));
  }

  return parameterNames;
}

export function validateSsmMetadataBatches(batches, expectedParameterNames, context) {
  validateContext(context);
  if (!Array.isArray(batches) || !Array.isArray(expectedParameterNames)) {
    fail("invalid_metadata_shape");
  }
  const expected = new Set(expectedParameterNames);
  if (expected.size !== expectedParameterNames.length || expected.size < 1) {
    fail("invalid_expected_parameters");
  }

  const found = new Map();
  for (const batch of batches) {
    if (
      !batch ||
      typeof batch !== "object" ||
      !Array.isArray(batch.Parameters) ||
      !Array.isArray(batch.InvalidParameters)
    ) {
      fail("invalid_metadata_shape");
    }
    if (batch.InvalidParameters.length !== 0) fail("invalid_parameters");

    for (const parameter of batch.Parameters) {
      if (
        !parameter ||
        typeof parameter !== "object" ||
        Object.hasOwn(parameter, "Value") ||
        typeof parameter.Name !== "string" ||
        typeof parameter.ARN !== "string" ||
        parameter.Type !== "SecureString" ||
        !Number.isInteger(parameter.Version) ||
        parameter.Version < 1
      ) {
        fail("invalid_parameter_metadata");
      }
      if (!expected.has(parameter.Name)) fail("unexpected_parameter");
      if (found.has(parameter.Name)) fail("duplicate_parameter");
      const relativeName = parameter.Name.replace(
        `/${context.project}/${context.environment}/`,
        ""
      );
      if (parameter.Name !== parameterPath(relativeName, context)) {
        fail("parameter_name_mismatch");
      }
      if (parameter.ARN !== parameterArn(relativeName, context)) {
        fail("parameter_arn_mismatch");
      }
      found.set(parameter.Name, parameter);
    }
  }

  if (found.size !== expected.size) fail("missing_parameter");
  for (const name of expected) {
    if (!found.has(name)) fail("missing_parameter");
  }
  return found.size;
}

function contextFromEnvironment() {
  return {
    region: process.env.REGION,
    accountId: process.env.ACCOUNT_ID,
    project: process.env.PROJECT,
    environment: process.env.ENVIRONMENT,
  };
}

function parseJsonEnvironment(name) {
  try {
    return JSON.parse(process.env[name] || "");
  } catch {
    fail("invalid_json");
  }
}

export function runCli(mode) {
  const context = contextFromEnvironment();
  if (mode === "references") {
    const names = validateTaskSecretReferences(
      parseJsonEnvironment("TASK_SECRETS_JSON"),
      context
    );
    process.stdout.write(`${JSON.stringify(names)}\n`);
    return;
  }
  if (mode === "metadata") {
    const count = validateSsmMetadataBatches(
      parseJsonEnvironment("SSM_METADATA_BATCHES_JSON"),
      parseJsonEnvironment("EXPECTED_PARAMETER_NAMES_JSON"),
      context
    );
    process.stdout.write(`ok:${count}\n`);
    return;
  }
  fail("invalid_mode");
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedUrl === import.meta.url) {
  try {
    runCli(process.argv[2]);
  } catch (error) {
    const code =
      error instanceof RuntimeSecretValidationError ? error.code : "operation_failed";
    process.stderr.write(`runtime-secret-preflight:${code}\n`);
    process.exitCode = 1;
  }
}
