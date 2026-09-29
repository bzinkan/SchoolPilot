import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

const main = readFileSync("infra/modules/turn/main.tf", "utf8");
const userData = readFileSync("infra/modules/turn/user-data.sh.tftpl", "utf8");
const relayMetrics = readFileSync("infra/modules/turn/relay-metrics.py", "utf8");
const turnOperations = readFileSync(
  "docs/CLASSPILOT_TURN_OPERATIONS.md",
  "utf8"
);
const releaseRunbook = readFileSync(
  "docs/CLASSPILOT_2_7_1_RELEASE.md",
  "utf8"
);
const repositoryGuidance = readFileSync("CLAUDE.md", "utf8");
const certificateRefresh = readFileSync(
  "infra/modules/turn/refresh-certificate.sh",
  "utf8"
);
const root = readFileSync("infra/main.tf", "utf8");
const ecs = readFileSync("infra/modules/ecs/main.tf", "utf8");

describe("ClassPilot AWS TURN infrastructure contract", () => {
  it("pins the one-time repair to the exact authorized 6/3/4 address set", () => {
    const authorizedAddresses = [
      'module.turn[0].aws_instance.turn["a"]',
      'module.turn[0].aws_instance.turn["b"]',
      'module.turn[0].aws_eip_association.turn["a"]',
      'module.turn[0].aws_eip_association.turn["b"]',
      'module.turn[0].aws_cloudwatch_metric_alarm.log_storage["a"]',
      'module.turn[0].aws_cloudwatch_metric_alarm.log_storage["b"]',
      'module.turn[0].aws_cloudwatch_metric_alarm.node_status["a"]',
      'module.turn[0].aws_cloudwatch_metric_alarm.node_status["b"]',
      "module.turn[0].aws_cloudwatch_dashboard.turn",
    ];
    for (const address of authorizedAddresses) {
      assert.ok(
        turnOperations.includes(`\`${address}\``),
        `TURN operations must name the authorized address ${address}`
      );
    }
    for (const document of [turnOperations, releaseRunbook, repositoryGuidance]) {
      assert.match(document, /6 to create, 3 to update, 4 to destroy/);
      assert.doesNotMatch(document, /4 to create, 2 to update, 4 to destroy/);
    }
  });

  it("creates exactly two independently addressed nodes across indexed public subnets", () => {
    assert.match(main, /nodes\s*=\s*\{\s*a\s*=\s*0\s+b\s*=\s*1/s);
    assert.match(main, /subnet_id\s*=\s*var\.public_subnet_ids\[each\.value\]/);
    assert.match(main, /data "aws_subnet" "turn"/);
    assert.match(main, /length\(local\.turn_availability_zones\) == 2/);
    assert.match(main, /resource "aws_eip" "turn"/);
    assert.match(main, /resource "aws_route53_record" "turn"/);
  });

  it("opens only the documented listeners and bounded relay range", () => {
    for (const port of ["3478", "443"]) {
      assert.match(main, new RegExp(`from_port\\s*=\\s*${port}`));
    }
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
    assert.match(
      root,
      /classpilot_turn_secret_access_arn\s*=\s*try\(module\.turn\[0\]\.rest_secret_arn/
    );
    assert.match(root, /classpilot_turn_hosts\s*=\s*""/);
    assert.match(root, /classpilot_turn_rest_secret_arn\s*=\s*""/);
  });

  it("configures REST auth, TURNS 443, DNS certificate renewal, and telemetry", () => {
    assert.doesNotMatch(userData, /\r/);
    assert.doesNotMatch(relayMetrics, /\r/);
    assert.doesNotMatch(certificateRefresh, /\r/);
    assert.doesNotMatch(userData, /apt-get install[^\n]*\bawscli\b/);
    assert.match(userData, /apt-get install[^\n]*\bgnupg\b/);
    assert.match(userData, /apt-get install[^\n]*\bgzip\b/);
    assert.match(userData, /apt-get install[^\n]*\bunzip\b/);
    assert.match(userData, /https:\/\/awscli\.amazonaws\.com\/v2\/install\.sh/);
    assert.match(userData, /--retry 5 --retry-delay 2 --retry-connrefused/);
    assert.match(userData, /--connect-timeout 15 --max-time 120/);
    assert.match(userData, /bash \/tmp\/aws-cli-install\.sh --system/);
    assert.match(userData, /aws --version/);
    assert.match(userData, /use-auth-secret/);
    assert.match(userData, /tls-listening-port=443/);
    assert.match(userData, /--dns-route53/);
    assert.match(userData, /certbot\.timer/);
    assert.match(
      userData,
      /install -d -m 0750 -o root -g turnserver \/etc\/coturn\/tls\/releases/
    );
    assert.match(userData, /pkey=\/etc\/coturn\/tls\/current\/privkey\.pem/);
    assert.match(userData, /cert=\/etc\/coturn\/tls\/current\/fullchain\.pem/);
    assert.match(userData, /classpilot-turn-refresh-certificate/);
    assert.match(userData, /certificate_refresh_script_base64gzip/);
    assert.match(
      userData,
      /certificate_refresh_script_base64gzip}' \| base64 --decode \| gzip --decompress/
    );
    assert.match(
      userData,
      /exec \/usr\/local\/sbin\/classpilot-turn-refresh-certificate '\$\{hostname\}'/
    );
    assert.match(
      userData,
      /test -L \/etc\/coturn\/tls\/current \|\| \\\n\s+\/usr\/local\/sbin\/classpilot-turn-refresh-certificate '\$\{hostname\}'/
    );
    assert.match(
      certificateRefresh,
      /install -m 0640 -o root -g turnserver "\$source_path" "\$destination_path"/
    );
    assert.match(
      certificateRefresh,
      /cmp -s "\$certificate_public_key" "\$private_public_key"/
    );
    assert.match(
      certificateRefresh,
      /mv -Tf -- "\$temporary_link" "\$tls_root\/current"/
    );
    assert.match(certificateRefresh, /restore_previous_release/);
    assert.match(certificateRefresh, /prune_old_releases/);
    assert.match(certificateRefresh, /verify_live_tls/);
    assert.match(userData, /AmbientCapabilities=CAP_NET_BIND_SERVICE/);
    assert.match(userData, /CapabilityBoundingSet=CAP_NET_BIND_SERVICE/);
    assert.match(userData, /NoNewPrivileges=true/);
    assert.match(userData, /openssl s_client -connect 127\.0\.0\.1:443/);
    assert.match(userData, /classpilot-turn-relay-metrics\.py --self-test/);
    assert.match(userData, /Environment=NODE_NAME=\$\{node_name\}/);
    assert.match(
      userData,
      /# The aggregate collector needs coturn's moderate session lifecycle records\.[\s\S]*?\nverbose\nlog-file=\/var\/log\/turnserver\/turn\.log\nsimple-log\nno-stdout-log/
    );
    assert.doesNotMatch(userData, /\nVerbose\n/);
    assert.match(userData, /size=64M,mode=0750,uid=\$turnserver_uid,gid=\$turnserver_gid/);
    assert.match(userData, /maxsize 8M/);
    assert.match(userData, /OnUnitActiveSec=5min/);
    assert.match(userData, /classpilot-turn-logrotate\.timer/);
    assert.match(userData, /"rename": "turn_log_used_percent"/);
    assert.match(main, /resource "aws_cloudwatch_metric_alarm" "log_storage"/);
    assert.match(main, /metric_name\s*=\s*"turn_log_used_percent"/);
    assert.match(main, /refresh-certificate\.sh/);
    assert.match(
      main,
      /base64gzip\(replace\(\s*replace\(file\([^)]*relay-metrics\.py/
    );
    assert.match(
      main,
      /base64gzip\(replace\(\s*replace\(file\([^)]*refresh-certificate\.sh/
    );
    assert.doesNotMatch(userData, /(?:chmod|chown)[^\n]*\/etc\/letsencrypt\/live/);
    assert.doesNotMatch(userData, /pkey=\/etc\/letsencrypt\/live/);
    assert.ok(
      userData.indexOf("certificate_refresh_script_base64")
        < userData.indexOf("certbot certonly"),
      "the renewal-safe certificate hook must exist before initial issuance"
    );
    assert.ok(
      userData.indexOf("amazon-cloudwatch-agent-ctl")
        < userData.indexOf("systemctl start coturn"),
      "coturn must not serve traffic before mandatory telemetry setup completes"
    );
    assert.ok(
      userData.indexOf("test -s /var/lib/classpilot-turn-metrics/state.json")
        < userData.indexOf("bootstrap_complete=true"),
      "bootstrap containment must remain armed until the metrics path is proven"
    );
    assert.match(
      userData,
      /systemctl disable --now coturn certbot\.timer \\\n\s+classpilot-turn-relay-metrics\.timer/
    );
    assert.ok(
      userData.lastIndexOf("systemctl enable coturn")
        > userData.indexOf("test -s /var/lib/classpilot-turn-metrics/state.json"),
      "coturn must remain disabled until all post-start checks pass"
    );
    assert.match(main, /AllocationCount/);
    assert.match(main, /AuthenticationFailureCount/);
    assert.doesNotMatch(main, /pattern\s*=\s*"%[^"\n]*(?:Unauthorized|401)/);
    assert.match(userData, /bytes_sent/);
    assert.match(
      userData,
      /"net":\s*\{[\s\S]*?"append_dimensions":\s*\{\s*"Node":\s*"\$\{node_name\}"\s*\}/
    );
    assert.doesNotMatch(
      userData,
      /"namespace":\s*"\$\{metric_namespace\}",\s*"append_dimensions"/
    );
    assert.match(userData, /classpilot-turn-relay-metrics\.py/);
    assert.match(relayMetrics, /append_metric\("RelayBytes", "Bytes"/);
    assert.match(relayMetrics, /append_metric\("AllocationCount", "Count"/);
    assert.match(relayMetrics, /"AuthenticationFailureCount",\n\s+"Count"/);
    assert.match(relayMetrics, /NODE_PATTERN = re\.compile\(r"\[ab\]"\)/);
    assert.match(
      relayMetrics,
      /"Dimensions": \[\{"Name": "Node", "Value": node_name\}\]/
    );
    assert.match(relayMetrics, /metric_data\.append\(aggregate\)/);
    assert.match(relayMetrics, /assert len\(metric_data\) == 6/);
    assert.match(relayMetrics, /assert validate_node_name\("b"\) == "b"/);
    assert.match(
      relayMetrics,
      /\[\{"Name": "Node", "Value": "b"\}\]/
    );
    assert.match(relayMetrics, /ALLOCATION_PATTERN = re\.compile/);
    assert.match(
      relayMetrics,
      /relay_bytes \+= int\(usage_match\.group\(1\)\) \+ int\(usage_match\.group\(2\)\)/
    );
    assert.match(relayMetrics, /MAX_ACTIVE_ALLOCATIONS = 2_048/);
    assert.match(
      relayMetrics,
      /Sanitized rows captured from the Ubuntu 24\.04 coturn 4\.6\.1-1build4/
    );
    assert.match(
      relayMetrics,
      /"1: : session 000000000000000001: realm <synthetic> user <>: incoming packet message processed, error 401: Unauthorized\\n"/
    );
    assert.match(
      relayMetrics,
      /"2: : session 000000000000000002: realm <synthetic> user <opaque>: incoming packet ALLOCATE processed, success\\n"/
    );
    assert.match(relayMetrics, /peer usage/);
    assert.match(userData, /relay_metrics_script_base64gzip/);
    assert.match(
      userData,
      /relay_metrics_script_base64gzip}' \| base64 --decode \| gzip --decompress/
    );
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

  it("keeps the rendered EC2 bootstrap below the 16 KiB user-data limit", () => {
    const normalizeLf = (value: string) => value.replace(/\r\n?/g, "\n");
    const gzipBase64 = (value: string) =>
      gzipSync(Buffer.from(normalizeLf(value), "utf8")).toString("base64");
    const substitutions: Record<string, string> = {
      aws_region: "us-east-1",
      hostname: "turn-a.school-pilot.net",
      public_ip: "255.255.255.255",
      realm: "school-pilot.net",
      relay_port_min: "49152",
      relay_port_max: "49252",
      rest_secret_arn:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:/schoolpilot/production/CLASSPILOT_TURN_REST_SECRET-XXXXXX",
      tls_email: "turn-certificates@school-pilot.net",
      metric_namespace: "SchoolPilot/ClassPilotTURN",
      node_name: "a",
      certificate_refresh_script_base64gzip: gzipBase64(certificateRefresh),
      relay_metrics_script_base64gzip: gzipBase64(relayMetrics),
    };
    let rendered = normalizeLf(userData);
    for (const [name, value] of Object.entries(substitutions)) {
      rendered = rendered.replaceAll(`\${${name}}`, value);
    }
    assert.doesNotMatch(rendered, /\$\{[a-z][a-z0-9_]*\}/);
    const renderedBytes = Buffer.byteLength(rendered, "utf8");
    const guardedLimit = 15_360;
    assert.ok(
      renderedBytes <= guardedLimit,
      `TURN user data is ${renderedBytes} bytes; the guarded limit is ${guardedLimit}`
    );
  });

  it("rolls back failed renewals and bounds retained private-key releases", () => {
    const bash = process.platform === "win32"
      ? `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Git\\bin\\bash.exe`
      : "bash";
    const behavior = String.raw`
set -euo pipefail
source infra/modules/turn/refresh-certificate.sh
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
tls_root="$test_root/tls"
mkdir -p "$tls_root/releases"

prepare_candidate_directory() { chmod 0750 "$1"; }
new_public_key_temporary_file() { mktemp "$test_root/$1-public.XXXXXX"; }
install_candidate_file() { cp -- "$1" "$2"; chmod 0640 "$2"; }
candidate_is_readable() { test -r "$1/fullchain.pem" && test -r "$1/privkey.pem"; }
validate_candidate_material() {
  if test -f "$test_root/fail-validation"; then
    rm -f -- "$test_root/fail-validation"
    return 1
  fi
  candidate_is_readable "$1"
}
coturn_is_active() { test -f "$test_root/active"; }
restart_coturn() { printf 'restart\n' >>"$test_root/actions"; touch "$test_root/active"; }
stop_coturn() { printf 'stop\n' >>"$test_root/actions"; rm -f -- "$test_root/active"; }
atomic_switch_current() {
  local temporary="$1/.current-target.$$"
  printf '%s\n' "$2" >"$temporary"
  mv -f -- "$temporary" "$1/current-target"
}
current_link_exists() { test -f "$1/current-target"; }
current_path_exists() { test -e "$1/current-target"; }
read_current_target() { cat "$1/current-target"; }
current_material_directory() { printf '%s/%s\n' "$1" "$(cat "$1/current-target")"; }
remove_current_link() { rm -f -- "$1/current-target"; }
verify_live_tls() {
  if test -f "$test_root/fail-handshake"; then
    rm -f -- "$test_root/fail-handshake"
    return 1
  fi
}
new_lineage() {
  local name="$1"
  local path="$test_root/$name"
  mkdir -p "$path"
  printf 'certificate-%s\n' "$name" >"$path/fullchain.pem"
  printf 'private-key-%s\n' "$name" >"$path/privkey.pem"
  printf '%s\n' "$path"
}

first_lineage="$(new_lineage first)"
deploy_certificate turn-a.school-pilot.net "$first_lineage" "$tls_root"
first_target="$(read_current_target "$tls_root")"
test -n "$first_target"

touch "$test_root/active"
second_lineage="$(new_lineage second)"
deploy_certificate turn-a.school-pilot.net "$second_lineage" "$tls_root"
second_target="$(read_current_target "$tls_root")"
test "$second_target" != "$first_target"
test "$(find "$tls_root/releases" -mindepth 1 -maxdepth 1 -type d -name 'release-*' | wc -l)" = 2

third_lineage="$(new_lineage third)"
touch "$test_root/fail-handshake"
if deploy_certificate turn-a.school-pilot.net "$third_lineage" "$tls_root"; then
  exit 10
fi
test "$(read_current_target "$tls_root")" = "$second_target"
test -f "$test_root/active"
test "$(find "$tls_root/releases" -mindepth 1 -maxdepth 1 -type d -name 'release-*' | wc -l)" = 2

fourth_lineage="$(new_lineage fourth)"
touch "$test_root/fail-validation"
if deploy_certificate turn-a.school-pilot.net "$fourth_lineage" "$tls_root"; then
  exit 11
fi
test "$(read_current_target "$tls_root")" = "$second_target"

fifth_lineage="$(new_lineage fifth)"
deploy_certificate turn-a.school-pilot.net "$fifth_lineage" "$tls_root"
fifth_target="$(read_current_target "$tls_root")"
test "$fifth_target" != "$second_target"
test "$(find "$tls_root/releases" -mindepth 1 -maxdepth 1 -type d -name 'release-*' | wc -l)" = 2

sixth_lineage="$(new_lineage sixth)"
expected_lineage_path() { printf '%s\n' "$sixth_lineage"; }
production_tls_root() { printf '%s\n' "$tls_root"; }
unset RENEWED_LINEAGE
main turn-a.school-pilot.net
sixth_target="$(read_current_target "$tls_root")"
test "$sixth_target" != "$fifth_target"

export RENEWED_LINEAGE="$test_root/unrelated"
main turn-a.school-pilot.net
test "$(read_current_target "$tls_root")" = "$sixth_target"

unset RENEWED_LINEAGE
seventh_lineage="$(new_lineage seventh)"
expected_lineage_path() { printf '%s\n' "$seventh_lineage"; }
prune_old_releases() { return 1; }
if main turn-a.school-pilot.net; then
  exit 12
fi
seventh_target="$(read_current_target "$tls_root")"
test "$seventh_target" != "$sixth_target"
test -r "$(current_material_directory "$tls_root")/privkey.pem"
test -f "$test_root/active"
`;
    const result = spawnSync(bash, ["-c", behavior], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `certificate refresh behavior failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  });
});

// terraform fmt (enforced in CI) closes every top-level block with a column-0
// brace and indents everything nested, and the TURN module has no heredocs, so
// the first column-0 brace after a resource header ends that resource.
function resourceBlock(source: string, type: string, name: string): string {
  const header = `resource "${type}" "${name}" {`;
  const start = source.indexOf(header);
  assert.ok(start >= 0, `missing resource ${type}.${name}`);
  assert.equal(source.indexOf(header, start + header.length), -1, `duplicate resource ${type}.${name}`);
  const close = /\r?\n\}(?=\r?\n|$)/g;
  close.lastIndex = start;
  const end = close.exec(source);
  assert.ok(end, `unterminated resource ${type}.${name}`);
  return source.slice(start, end.index + end[0].length);
}

// The resource's own lifecycle block: two-space indent under the resource, so
// its direct attributes sit at four spaces and nested preconditions deeper.
function lifecycleBlock(resource: string): string | null {
  const start = resource.search(/\r?\n  lifecycle \{\r?\n/);
  if (start < 0) return null;
  const end = resource.indexOf("\n  }", start + 1);
  return end < 0 ? null : resource.slice(start, end);
}

function turnAssignments(profile: string): string[] {
  return [...profile.matchAll(/^[ \t]*(enable_classpilot_turn|classpilot_turn_\w+)[ \t]*=[ \t]*(.+?)[ \t]*$/gm)]
    .map((match) => `${match[1]} = ${match[2]}`)
    .sort();
}

describe("Legacy ClassPilot TURN parking contract", () => {
  const production = readFileSync("infra/production.tfvars", "utf8");
  const moduleVariables = readFileSync("infra/modules/turn/variables.tf", "utf8");
  const parking = readFileSync("docs/CLASSPILOT_TURN_PARKING.md", "utf8");

  it("retains the TURN resources while production keeps the legacy nodes parked on a pinned image", () => {
    // Resource retention, not a running service.
    assert.match(production, /^enable_classpilot_turn\s*=\s*true\s*$/m);
    assert.match(production, /^classpilot_turn_parked\s*=\s*true\s*$/m);
    assert.match(production, /^classpilot_turn_ami_id\s*=\s*"ami-052355af2a014bd2c"\s*$/m);
    assert.match(root, /parked\s*=\s*var\.classpilot_turn_parked/);
    assert.match(root, /ami_id\s*=\s*var\.classpilot_turn_ami_id/);
  });

  it("stops parked nodes through an explicit power-state resource that cannot replace them", () => {
    assert.match(main, /resource "aws_ec2_instance_state" "turn"/);
    assert.match(main, /instance_id\s*=\s*aws_instance\.turn\[each\.key\]\.id/);
    assert.match(main, /state\s*=\s*var\.parked \? "stopped" : "running"/);
    assert.match(main, /prevent_destroy\s*=\s*true/);
    assert.doesNotMatch(main, /ignore_changes/);
    assert.match(main, /ami\s*=\s*var\.ami_id != null \? var\.ami_id : one\(data\.aws_ssm_parameter\.ubuntu_ami\[\*\]\.value\)/);
    assert.match(main, /count\s*=\s*var\.ami_id == null \? 1 : 0/);
    assert.match(moduleVariables, /variable "parked"/);
    assert.match(moduleVariables, /variable "ami_id"/);
  });

  it("documents parking as retention with a restart runbook and keeps capability activation separate", () => {
    for (const heading of ["Current status", "Why", "Live View status", "Restart conditions", "Restart procedure", "Future decommission"]) {
      assert.match(parking, new RegExp(`^## ${heading}`, "m"), `missing section ${heading}`);
    }
    assert.match(parking, /Legacy TURN is parked\/stopped/);
    assert.doesNotMatch(parking, /TURN has been removed/);
    assert.match(parking, /Never enable\s+`liveViewIceServersV1` because the nodes were restarted/);
    assert.match(parking, /Stopped does not mean safe to delete/);
    assert.match(turnOperations, /## Legacy ClassPilot TURN — Parked/);
    assert.match(turnOperations, /superseded by parking/);
  });

  it("protects every retained TURN identity resource with a literal prevent_destroy", () => {
    // terraform test cannot assert prevent_destroy (expect_failures covers only
    // variables, outputs, checks and conditions), and the mocked infra/tests
    // plans start from empty state, so they cannot show "no diff" either. This
    // static contract is the evidence for the literals; only the next reviewed
    // production plan showing No changes for module.turn proves the no-op.
    const newlyProtected: Array<[string, string]> = [
      ["aws_security_group", "turn"],
      ["aws_iam_role", "turn"],
      ["aws_iam_role_policy_attachment", "ssm"],
      ["aws_iam_role_policy", "turn"],
      ["aws_iam_instance_profile", "turn"],
      ["aws_eip", "turn"],
      ["aws_route53_record", "turn"],
      ["aws_eip_association", "turn"],
    ];
    const protectedResources: Array<[string, string]> = [
      ["aws_cloudformation_stack", "rest_secret"],
      ["aws_instance", "turn"],
      ...newlyProtected,
    ];
    // Alarms and the dashboard can be rebuilt; the power state must stay
    // changeable so a reviewed restart can flip it.
    const unprotectedResources: Array<[string, string]> = [
      ["aws_ec2_instance_state", "turn"],
      ["aws_cloudwatch_metric_alarm", "authentication_failures"],
      ["aws_cloudwatch_metric_alarm", "node_status"],
      ["aws_cloudwatch_metric_alarm", "log_storage"],
      ["aws_cloudwatch_metric_alarm", "ice_success_rate"],
      ["aws_cloudwatch_dashboard", "turn"],
    ];
    const address = ([type, name]: [string, string]) => `${type}.${name}`;
    const declared = [...main.matchAll(/^resource "([^"]+)" "([^"]+)" \{/gm)]
      .map((match) => `${match[1]}.${match[2]}`)
      .sort();
    assert.deepEqual(
      declared,
      [...protectedResources, ...unprotectedResources].map(address).sort(),
      "every TURN resource must be classified as protected or deliberately unprotected"
    );

    for (const resource of protectedResources) {
      const lifecycle = lifecycleBlock(resourceBlock(main, ...resource));
      assert.ok(lifecycle, `${address(resource)} must declare a lifecycle block`);
      assert.match(
        lifecycle,
        /^    prevent_destroy\s*=\s*true\s*$/m,
        `${address(resource)} must set a literal prevent_destroy = true`
      );
    }
    for (const resource of newlyProtected) {
      assert.match(
        resourceBlock(main, ...resource),
        /# Terraform requires a literal here; only the reviewed Lane D decommission PR removes it\.\r?\n  lifecycle \{/,
        `${address(resource)} must say who may remove its protection`
      );
    }
    for (const resource of unprotectedResources) {
      assert.doesNotMatch(
        resourceBlock(main, ...resource),
        /prevent_destroy/,
        `${address(resource)} must stay unprotected`
      );
    }
    assert.match(
      lifecycleBlock(resourceBlock(main, "aws_security_group", "turn")) ?? "",
      /^    create_before_destroy\s*=\s*true\s*$/m
    );
    // One literal per protected resource and nothing else: Terraform rejects
    // expressions here, and there is still no ignore_changes anywhere.
    const settings = main.match(/^[ \t]*prevent_destroy[ \t]*=.*$/gm) ?? [];
    assert.equal(settings.length, protectedResources.length);
    for (const setting of settings) assert.match(setting, /^[ \t]*prevent_destroy\s*=\s*true\s*$/);
    assert.doesNotMatch(main, /ignore_changes/);
  });

  it("keeps the HA scale-up profile on production's parked TURN inputs without the TLS email", () => {
    const ha = readFileSync("infra/production-ha-2000.tfvars", "utf8");
    // The three inputs move together: enabling alone would start both nodes on
    // a newer image, and omitting enable would plan a destroy of the module.
    for (const assignment of [
      "enable_classpilot_turn = true",
      "classpilot_turn_parked = true",
      'classpilot_turn_ami_id = "ami-052355af2a014bd2c"',
    ]) {
      assert.ok(turnAssignments(production).includes(assignment), `production.tfvars must keep ${assignment}`);
    }
    assert.deepEqual(turnAssignments(ha), turnAssignments(production));
    for (const profile of [production, ha]) {
      assert.doesNotMatch(profile, /^[ \t]*classpilot_turn_tls_email[ \t]*=/m);
    }
    // With TURN enabled the turn_activation_gate precondition applies to every
    // HA plan, so the profile must say where the private email comes from.
    assert.match(ha, /TF_VAR_classpilot_turn_tls_email/);
  });
});
