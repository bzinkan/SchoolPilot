import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const main = readFileSync("infra/modules/turn/main.tf", "utf8");
const userData = readFileSync("infra/modules/turn/user-data.sh.tftpl", "utf8");
const relayMetrics = readFileSync("infra/modules/turn/relay-metrics.py", "utf8");
const root = readFileSync("infra/main.tf", "utf8");
const ecs = readFileSync("infra/modules/ecs/main.tf", "utf8");

describe("ClassPilot AWS TURN infrastructure contract", () => {
  it("creates exactly two independently addressed nodes across indexed public subnets", () => {
    assert.match(main, /nodes\s*=\s*\{\s*a\s*=\s*0\s+b\s*=\s*1/s);
    assert.match(main, /subnet_id\s*=\s*var\.public_subnet_ids\[each\.value\]/);
    assert.match(main, /data "aws_subnet" "turn"/);
    assert.match(main, /length\(local\.turn_availability_zones\) == 2/);
    assert.match(main, /resource "aws_eip" "turn"/);
    assert.match(main, /resource "aws_route53_record" "turn"/);
  });

  it("opens only the documented listeners and bounded relay range", () => {
    for (const port of ["3478", "443"]) assert.match(main, new RegExp(`from_port\\s*=\\s*${port}`));
    assert.match(main, /from_port\s*=\s*var\.relay_port_min/);
    assert.match(main, /to_port\s*=\s*var\.relay_port_max/);
    assert.match(userData, /min-port=\$\{relay_port_min\}/);
    assert.match(userData, /max-port=\$\{relay_port_max\}/);
  });

  it("generates the shared secret in AWS and pre-grants only its ARN without runtime wiring", () => {
    assert.match(main, /AWS::SecretsManager::Secret/);
    assert.match(main, /GenerateSecretString/);
    assert.doesNotMatch(main, /secret_string\s*=/i);
    assert.match(ecs, /CLASSPILOT_TURN_REST_SECRET/);
    assert.match(ecs, /classpilot_turn_secret_access_arn/);
    assert.match(ecs, /secretsmanager:GetSecretValue/);
    assert.match(root, /classpilot_turn_secret_access_arn\s*=\s*try\(module\.turn\[0\]\.rest_secret_arn/);
    assert.match(root, /classpilot_turn_hosts\s*=\s*""/);
    assert.match(root, /classpilot_turn_rest_secret_arn\s*=\s*""/);
  });

  it("configures REST auth, TURNS 443, DNS certificate renewal, and telemetry", () => {
    assert.match(userData, /use-auth-secret/);
    assert.match(userData, /tls-listening-port=443/);
    assert.match(userData, /--dns-route53/);
    assert.match(userData, /certbot\.timer/);
    assert.match(main, /AllocationCount/);
    assert.match(main, /AuthenticationFailureCount/);
    assert.doesNotMatch(main, /pattern\s*=\s*"%[^"\n]*(?:Unauthorized|401)/);
    assert.match(userData, /bytes_sent/);
    assert.match(userData, /classpilot-turn-relay-metrics\.py/);
    assert.match(relayMetrics, /"MetricName": "RelayBytes"/);
    assert.match(relayMetrics, /"MetricName": "AllocationCount"/);
    assert.match(relayMetrics, /"MetricName": "AuthenticationFailureCount"/);
    assert.match(relayMetrics, /ALLOCATION_PATTERN = re\.compile/);
    assert.match(
      relayMetrics,
      /relay_bytes \+= int\(usage_match\.group\(1\)\) \+ int\(usage_match\.group\(2\)\)/
    );
    assert.match(relayMetrics, /MAX_ACTIVE_ALLOCATIONS = 2_048/);
    assert.match(relayMetrics, /peer usage/);
    assert.match(userData, /relay_metrics_script_base64/);
    assert.match(userData, /OnUnitActiveSec=1min/);
    assert.doesNotMatch(userData, /logs_collected|log_group_name|log_stream_name/);
    assert.doesNotMatch(main, /aws_cloudwatch_log_metric_filter|aws_cloudwatch_log_group/);
    assert.match(main, /IceSuccessCount/);
    assert.match(main, /IceFailureCount/);
    assert.match(main, /IceConnectionTimeMs/);
    assert.match(main, /RelayFallbackCount/);
    assert.match(main, /resource "aws_cloudwatch_dashboard" "turn"/);
    assert.match(main, /resource "aws_cloudwatch_metric_alarm" "authentication_failures"/);
    assert.match(main, /resource "aws_cloudwatch_metric_alarm" "ice_success_rate"/);
    assert.doesNotMatch(
      main,
      /(?:SchoolId|StudentId|StudentSessionId|DeviceId|NegotiationId)\s*=/
    );
  });
});
