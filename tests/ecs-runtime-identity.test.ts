import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  resolveEcsApiRuntimeIdentity,
  type EcsMetadataFetch,
} from "../src/services/ecsRuntimeIdentity.ts";

const metadataUri = "http://169.254.170.2/v4/0123456789abcdef";
const taskDefinitionArn =
  "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:42";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

describe("ECS API runtime identity", () => {
  it("derives the exact revisioned task-definition ARN and precision-safe hash", async () => {
    let requested = "";
    const fetchImpl: EcsMetadataFetch = async (input) => {
      requested = input;
      return response({
        TaskARN:
          "arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production/1234567890abcdef1234567890abcdef",
        Family: "schoolpilot-production-api-emergency",
        Revision: "42",
      });
    };
    const identity = await resolveEcsApiRuntimeIdentity({
      metadataUri,
      awsExecutionEnv: "AWS_ECS_FARGATE",
      fetchImpl,
    });
    assert.equal(requested, `${metadataUri}/task`);
    assert.equal(identity?.taskDefinitionArn, taskDefinitionArn);
    assert.equal(
      identity?.taskDefinitionSha256,
      createHash("sha256").update(taskDefinitionArn, "utf8").digest("hex")
    );
  });

  it("is a no-op outside ECS and fails closed for ECS metadata loss", async () => {
    assert.equal(
      await resolveEcsApiRuntimeIdentity({
        metadataUri: "",
        awsExecutionEnv: "",
      }),
      null
    );
    await assert.rejects(
      resolveEcsApiRuntimeIdentity({
        metadataUri: "",
        awsExecutionEnv: "AWS_ECS_FARGATE",
      }),
      /ecs_runtime_identity_metadata_uri_missing/
    );
  });

  it("rejects SSRF endpoints and malformed task metadata", async () => {
    await assert.rejects(
      resolveEcsApiRuntimeIdentity({
        metadataUri: "https://example.com/v4/metadata",
        awsExecutionEnv: "AWS_ECS_FARGATE",
      }),
      /ecs_runtime_identity_metadata_uri_invalid/
    );
    await assert.rejects(
      resolveEcsApiRuntimeIdentity({
        metadataUri,
        awsExecutionEnv: "AWS_ECS_FARGATE",
        fetchImpl: async () =>
          response({ TaskARN: "sensitive-task", Family: "api", Revision: 1 }),
        maximumAttempts: 1,
      }),
      /ecs_runtime_identity_metadata_invalid/
    );
  });

  it("retries bounded transient metadata failures", async () => {
    let calls = 0;
    const identity = await resolveEcsApiRuntimeIdentity({
      metadataUri,
      awsExecutionEnv: "AWS_ECS_FARGATE",
      maximumAttempts: 2,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return response({}, 503);
        return response({
          TaskARN:
            "arn:aws:ecs:us-east-1:135775632425:task/1234567890abcdef1234567890abcdef",
          Family: "schoolpilot-production-api-emergency",
          Revision: 42,
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(identity?.taskDefinitionArn, taskDefinitionArn);
  });
});
