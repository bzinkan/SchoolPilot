import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("canonical production Terraform profile", () => {
  it("declares each protected launch value exactly once at the live posture", () => {
    const production = source("infra/production.tfvars");
    const expectedAssignments = {
      ecs_tasks_in_public_subnets: "false",
      enable_nat_gateway: "true",
      route53_measure_latency: "true",
      db_instance_class: '"db.t4g.medium"',
      redis_node_type: '"cache.t4g.small"',
      waf_rate_rule_action: '"block"',
    } as const;

    for (const [name, expectedValue] of Object.entries(expectedAssignments)) {
      const assignments = [
        ...production.matchAll(
          new RegExp(
            `^\\s*${escapeRegExp(name)}\\s*=\\s*([^\\s#]+)\\s*(?:#.*)?$`,
            "gm"
          )
        ),
      ];

      assert.equal(
        assignments.length,
        1,
        `${name} must have exactly one assignment in production.tfvars`
      );
      assert.equal(
        assignments[0][1],
        expectedValue,
        `${name} must match the current Terraform-managed production baseline`
      );
    }
  });
});
