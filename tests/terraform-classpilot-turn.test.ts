import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

const main = readFileSync("infra/modules/turn/main.tf", "utf8");
const userData = readFileSync("infra/modules/turn/user-data.sh.tftpl", "utf8");
const relayMetrics = readFileSync("infra/modules/turn/relay-metrics.py", "utf8");
const certificateRefresh = readFileSync(
  "infra/modules/turn/refresh-certificate.sh",
  "utf8"
);
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
