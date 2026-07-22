import { createHash } from "node:crypto";

const ECS_CONTAINER_METADATA_HOST = "169.254.170.2";
const ECS_RUNTIME_IDENTITY_MAX_ATTEMPTS = 3;
const ECS_RUNTIME_IDENTITY_TIMEOUT_MS = 2_000;

type EcsTaskMetadata = {
  TaskARN?: unknown;
  Family?: unknown;
  Revision?: unknown;
};

type MetadataResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type EcsMetadataFetch = (
  input: string,
  init: { signal: AbortSignal }
) => Promise<MetadataResponse>;

export type EcsApiRuntimeIdentity = {
  taskDefinitionArn: string;
  taskDefinitionSha256: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireMetadataEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("ecs_runtime_identity_metadata_uri_invalid");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== ECS_CONTAINER_METADATA_HOST ||
    endpoint.port !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    !endpoint.pathname.startsWith("/v4/")
  ) {
    throw new Error("ecs_runtime_identity_metadata_uri_invalid");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/task`;
  return endpoint;
}

function parseTaskDefinitionArn(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("ecs_runtime_identity_metadata_invalid");
  }
  const { TaskARN, Family, Revision } = metadata as EcsTaskMetadata;
  if (
    typeof TaskARN !== "string" ||
    typeof Family !== "string" ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(Family) ||
    !(
      (typeof Revision === "string" && /^[1-9]\d*$/.test(Revision)) ||
      (typeof Revision === "number" &&
        Number.isSafeInteger(Revision) &&
        Revision > 0)
    )
  ) {
    throw new Error("ecs_runtime_identity_metadata_invalid");
  }
  const taskArn =
    /^arn:(aws(?:-[a-z]+)?):ecs:([a-z0-9-]+):(\d{12}):task\/(?:[A-Za-z0-9_-]+\/)?[a-f0-9-]{32,64}$/.exec(
      TaskARN
    );
  if (!taskArn) {
    throw new Error("ecs_runtime_identity_metadata_invalid");
  }
  const [, partition, region, accountId] = taskArn;
  const revision = String(Revision);
  return `arn:${partition}:ecs:${region}:${accountId}:task-definition/${Family}:${revision}`;
}

export async function resolveEcsApiRuntimeIdentity(options: {
  metadataUri?: string;
  awsExecutionEnv?: string;
  fetchImpl?: EcsMetadataFetch;
  maximumAttempts?: number;
  timeoutMs?: number;
} = {}): Promise<EcsApiRuntimeIdentity | null> {
  const metadataUri = options.metadataUri ?? process.env.ECS_CONTAINER_METADATA_URI_V4;
  const awsExecutionEnv = options.awsExecutionEnv ?? process.env.AWS_EXECUTION_ENV;
  if (!metadataUri) {
    if (awsExecutionEnv?.startsWith("AWS_ECS")) {
      throw new Error("ecs_runtime_identity_metadata_uri_missing");
    }
    return null;
  }
  const endpoint = requireMetadataEndpoint(metadataUri);
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as EcsMetadataFetch);
  const maximumAttempts =
    options.maximumAttempts ?? ECS_RUNTIME_IDENTITY_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? ECS_RUNTIME_IDENTITY_TIMEOUT_MS;
  if (
    !Number.isInteger(maximumAttempts) ||
    maximumAttempts < 1 ||
    maximumAttempts > ECS_RUNTIME_IDENTITY_MAX_ATTEMPTS ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > ECS_RUNTIME_IDENTITY_TIMEOUT_MS
  ) {
    throw new Error("ecs_runtime_identity_options_invalid");
  }

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint.href, {
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 500 && attempt < maximumAttempts) continue;
        throw new Error(
          response.status >= 500
            ? "ecs_runtime_identity_metadata_unavailable"
            : "ecs_runtime_identity_metadata_rejected"
        );
      }
      const taskDefinitionArn = parseTaskDefinitionArn(await response.json());
      return {
        taskDefinitionArn,
        taskDefinitionSha256: sha256(taskDefinitionArn),
      };
    } catch (error) {
      if (attempt >= maximumAttempts) {
        if (
          error instanceof Error &&
          error.message.startsWith("ecs_runtime_identity_")
        ) {
          throw error;
        }
        throw new Error("ecs_runtime_identity_metadata_unavailable");
      }
      if (
        error instanceof Error &&
        (error.message === "ecs_runtime_identity_metadata_invalid" ||
          error.message === "ecs_runtime_identity_metadata_rejected")
      ) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("ecs_runtime_identity_metadata_unavailable");
}
