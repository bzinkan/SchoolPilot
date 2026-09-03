# ClassPilot TURN operations

The canonical production baseline enables the two-node coturn module.
Infrastructure apply, node health, application capability activation, and
managed-Chromebook validation are separate facts. `liveViewIceServersV1` must
be accepted together with its parent marker `scopedAuthorityChecksV1` and
advertised by the current student binding before credentials or telemetry are
accepted. Chrome Web Store `2.7.1` being live on August 24, 2026 proves none of
those TURN or managed-device gates by itself.

## Provisioning and activation boundary

`infra/production.tfvars` enables TURN without storing the operator-owned TLS
email. Before producing the saved production plan, set
`TF_VAR_classpilot_turn_tls_email` only in the current PowerShell process, then
clear it after planning. The saved plan already contains the input used during
planning; `terraform apply` does not reread the environment variable. The
address remains inside the sensitive saved plan/state and rendered instance
user data because certbot requires it; process cleanup does not erase those
controlled copies. Terraform's sensitive marking redacts ordinary display but
does not encrypt plan or state bytes, so retain their existing restricted ACLs
and encrypted recovery copies. Do not supply a higher-precedence email
assignment in `terraform.tfvars`, `terraform.tfvars.json`, an auto-tfvars file,
later var-file, or `-var` argument.

Provisioning requires a separately reviewed Terraform plan/apply. After this
baseline merges, do not run an unrelated production Terraform operation until
the TURN plan is either applied or the baseline is explicitly reverted. The
reviewed plan must contain zero destructive actions and only the TURN activation
gate, TURN module, ECS execution-role secret permission, and TURN outputs. It
must not deploy an API/worker image, update a live ECS service, or activate a
ClassPilot runtime profile.

### Authorized one-time node-replacement exception (pending)

On August 24, 2026, one narrow targeted repair was authorized for the already
reviewed TURN module. It is pending execution and does not authorize a general
Terraform apply. The only replacement targets are:

- `module.turn[0].aws_instance.turn["a"]`;
- `module.turn[0].aws_instance.turn["b"]`;
- `module.turn[0].aws_eip_association.turn["a"]`; and
- `module.turn[0].aws_eip_association.turn["b"]`.

The only additional create targets are:

- `module.turn[0].aws_cloudwatch_metric_alarm.log_storage["a"]`; and
- `module.turn[0].aws_cloudwatch_metric_alarm.log_storage["b"]`.

The only in-place update targets are:

- `module.turn[0].aws_cloudwatch_metric_alarm.node_status["a"]`; and
- `module.turn[0].aws_cloudwatch_metric_alarm.node_status["b"]`; and
- `module.turn[0].aws_cloudwatch_dashboard.turn`.

Create a unique saved plan with explicit replacement targeting for the two
instances; their two associations must be the only dependent replacements. The
reviewed summary must be exactly `6 to create, 3 to update, 4 to destroy`, and
the full plan must show only the four instance/association replacements, the two
new bounded-log-storage alarms, the two node-status alarm updates, and the TURN
CloudWatch dashboard update listed above. Abort if the plan changes or replaces
an EIP, Route 53/DNS record, secret, IAM resource, security group, ECS resource,
API, worker, frontend resource, or any other address. A dashboard update is
authorized only at the exact `module.turn[0].aws_cloudwatch_dashboard.turn`
address; a dashboard replacement or any other dashboard change is forbidden.

Take and verify the standard external CurrentUser-DPAPI and OneDrive AES-GCM
Terraform-state backups before planning, again immediately before applying the
hash-verified saved plan, and again after apply. Retain each backup receipt, the
saved-plan SHA-256, and the reviewed plan JSON outside the repository. Do not
re-plan between approval and apply.

After apply, require both nodes to pass EC2/system status, retain their exact
Elastic IP and DNS bindings, authenticate and relay on UDP/3478, TCP/3478, and
TURNS/443, present current matching certificates, publish both node metric
dimensions, and pass the relay-range and aggregate-telemetry checks. Then run a
fresh full no-op plan and verify state-backup recovery material. Only after all
of those checks pass may the operator mark the exception `completed` and
`non-reusable`. Authorization alone is not completion. Any failed or ambiguous
check leaves it an authorized one-time exception pending reconciliation; never
reuse the saved plan or broaden the targets.

```powershell
$env:TF_VAR_classpilot_turn_tls_email = "<MONITORED_OPERATIONAL_EMAIL>"
try {
  # Create and inspect the reviewed saved plan while this value exists.
}
finally {
  Remove-Item Env:TF_VAR_classpilot_turn_tls_email -ErrorAction SilentlyContinue
}
```

Before any profile includes `liveViewIceServersV1`, prove all of the following
against the live production nodes:

1. exactly two running coturn instances exist in different availability zones,
   each with a stable Elastic IP and its expected DNS record;
2. EC2 instance and system checks are both `ok` for both nodes;
3. UDP/3478, TCP/3478, and TURNS/TCP/443 authenticate and relay traffic;
4. the configured relay range is reachable and certificate chains and renewal
   automation are current;
5. the exact environment-scoped TURN REST secret exists in Secrets Manager and
   neither its ARN nor value is inline environment data;
6. aggregate identifier-free node/application telemetry is healthy;
7. the synthetic UDP-blocked fallback suite completes through TURN/TCP or
   TURNS/443; and
8. for the ordinary strict path, a managed test device with UDP blocked
   completes Live View through TURN/TCP or TURNS/443.

Record those results in the private, two-hour TURN evidence format documented
in `CLASSPILOT_2_7_1_RELEASE.md`. Supply that file from a private path outside
the repository. During `Plan`, the runtime-config helper reads it once and
stores the exact hash-bound bytes in the run directory as the neutral
`turn-evidence.json`; subsequent `Apply` or `Rollback` operations use that copy,
not the source path. The plan and stdout do not disclose the operator-supplied
path, hosts, secret ARN, or school identifier. The helper independently checks
that the requested profile contains exactly
`turn-a.school-pilot.net` and `turn-b.school-pilot.net`, that the secret ARN has
the exact production shape, that AWS currently exposes two healthy nodes in
different zones, and that the exact secret has not been scheduled for deletion.
The evidence hash binds those control-plane checks to the operator's network,
TLS, relay, telemetry, and UDP-blocked validation.

TURN evidence schema version 2 keeps the last two checks separate as
`syntheticUdpBlockedFallbackPassed` and
`managedUdpBlockedLiveViewPassed`. The strict path requires both to be `true`.
The approved synthetic-only global path requires the synthetic value to be
`true` and the managed value to be `false`, plus a separate fresh waiver that
binds the TURN-evidence and synthetic-validation hashes and records exactly
`validationLevel: "synthetic_only"` and
`managedValidation: "waived_not_passed"`. Never collapse the checks into one
UDP-fallback boolean or describe the waiver as a managed pass.

Run `scripts/deploy-classpilot-runtime-config.ps1` only after this gate is green.
It updates the exact active same-digest API and worker revisions together; do
not copy TURN values into one task definition by hand. The ordinary strict path
activates the test school first and requires the managed Live View gate before
`global-on`. The approved synthetic-only path may use `global-on` without a
managed pass only with the exact evidence, waiver, and three explicit
confirmations in `CLASSPILOT_2_7_1_RELEASE.md`. The final target has
all nine repaired capabilities globally on, including
`scopedAuthorityChecksV1` and its dependent `liveViewIceServersV1`, while
`kioskLaunchTicketV1` stays off. Leaving Live View dark is temporary deployment
or incident containment, not the final target.

When the approved activation runs during the weekday 04:45–05:59 Eastern
protected window, both Plan and Apply require
`-ConfirmProductionMutation -ConfirmProtectedWindowProductionMutation`; the
synthetic-only global path also requires
`-ConfirmSyntheticOnlyGlobalActivation`. The plan must record
`protectedWindowProductionMutation: true`. The helper accepts only a stable API
desired count from one through six and temporarily maps counts `1..6` to API
bounds `100/200`, `50/100`, `66/100`, `75/100`, `80/100`, and `83/100`,
respectively; the worker uses `0/100`. Counts two through six allow one stop and
no growth, while singleton `100/200` preserves one replacement slot. The exact
prior deployment configuration and current scheduled minimum must be restored
before the scaling hold is released.

For containment, use a fresh `mode: "off"` Plan/Apply. It disables protocol-v3
acceptance and all nine repaired capabilities together while leaving TURN
infrastructure provisioned. Do not partially turn off only Live View, edit one
service by hand, or use `-Operation Rollback` as a kill switch.

## Telemetry contract

`POST /api/classpilot/device/live-view/telemetry` uses the cryptographic device
token and accepts only a still-active signed Live View negotiation. The server
also rechecks the exact student/session/device binding, current session staff
authority, current control session, entitlement, capability rollout, and a
fresh capability-bearing heartbeat.

The strict body is:

```json
{
  "negotiationId": "signed value returned by Live View setup",
  "attempt": 0,
  "outcome": "connected",
  "connectionTimeMs": 1250,
  "selectedCandidateType": "relay",
  "relayTransport": "tls"
}
```

- `attempt` is `0`, `1`, or `2`.
- `outcome` is `connected` or `failed`.
- `connectionTimeMs` is an integer from 0 through 90,000.
- Candidate type is `host`, `server_reflexive`, `relay`, or `unknown`.
- Relay transport is required only for a successful relay selection and is
  limited to `udp`, `tcp`, `tls`, or `unknown`.
- One terminal report is accepted per negotiation attempt. Redis provides
  cross-task idempotency; the advisory fallback is opaque, TTL-bound, and
  capped at 8,192 entries per API task.

The endpoint never echoes authority identifiers and metrics use only the
`Environment` dimension. Never add school, user, student, student-session,
device, negotiation, credential, URL, or request dimensions.

## Metrics and alarms

The `SchoolPilot/ClassPilotTURN` namespace contains:

- `AllocationCount` and `AuthenticationFailureCount` from the on-node bounded
  aggregate collector. Each is published both without dimensions for existing
  release-wide alarms/dashboard graphs and with exactly `Node=a` or `Node=b`
  for per-node readiness validation. Raw coturn lines are never forwarded to
  CloudWatch;
- `RelayBytes` from client-side usage records for sessions that successfully
  allocated a relay (peer rows are excluded to prevent double counting), also
  dual-published as dimensionless and exact `Node=a` or `Node=b` series;
- `IceSuccessCount`, `IceFailureCount`, `IceConnectionTimeMs`, and
  `RelayFallbackCount` from exact-bound client telemetry;
- fixed relay transport and ICE restart counters; and
- per-node aggregate network bytes from the CloudWatch agent.

The module creates a CloudWatch operations dashboard, alarms on EC2 status
failure and excessive TURN authentication failure, and alarms when ICE success
stays below 70% for two five-minute periods with at least ten reports per
period. Missing telemetry is not treated as a failure while the capability is
dark.

Before enabling a canary, verify both instances are healthy, certificates are
current, the relay-byte timer is active, and the dashboard receives allocation,
ICE outcome, connection-time, and fallback metrics. Stop the canary for any
authority mismatch or if the release-wide Live View gates fail. For emergency
capability containment, pause OU unpinning and create/apply a fresh
`mode: "off"` runtime profile; do not partially edit rollout entries or ECS task
definitions. `-Operation Rollback` only restores the exact immediately prior
API/worker pair recorded by its plan. The additive TURN infrastructure remains
in place.

## Node bootstrap contract

Keep Certbot's `/etc/letsencrypt` tree root-only. The deploy hook validates the
hostname, expiry, and matching certificate/private-key public keys, stages both
files as `root:turnserver` with mode `0640`, and atomically switches the
`/etc/coturn/tls/current` symlink before restarting an already-running coturn
service. Coturn receives only `CAP_NET_BIND_SERVICE` so its unprivileged service
account can bind TURNS/443. Never repair certificate access by making the
Let's Encrypt tree world-readable.

The identifier-free relay collector must remain LF-only because systemd executes
its Python shebang directly. Bootstrap runs its built-in self-test before the
timer is enabled. User data passes only its strict `a` or `b` node name. The
collector keeps each existing dimensionless metric and emits one matching
`Node=a` or `Node=b` copy; the CloudWatch agent separately attaches the same
custom `Node` dimension in the `net` metric block. Post-provisioning validation
must find recent allocation, relay-byte, authentication, and network datapoints
for both `Node=a` and `Node=b` before TURN activation. Existing aggregate alarm
and dashboard semantics remain dimensionless.

Coturn must retain moderate `verbose` logging so the collector receives
allocation and session-usage lifecycle rows. `no-stdout-log` keeps those raw
rows out of journald. They remain only on a 64 MiB node-local tmpfs, with an
8 MiB/five-minute rotation guard, six retained rotations, and an 80% storage
alarm; they are never forwarded to CloudWatch. TURN
REST usernames are expiry plus a non-identifying digest; do not replace them
with school, student, device, or session identifiers. Activation validation
must perform an authenticated relay, run the collector, and observe both a
fresh aggregate `AllocationCount` datapoint and the matching exact-node copy
rather than accepting service health alone as telemetry proof.

EC2 accepts at most 16 KiB of decoded user data. The certificate-refresh and
relay-metrics helpers are therefore LF-normalized, gzip-compressed, and
base64-encoded before Terraform renders them into the bootstrap. Keep the
rendered-size contract below the repository's 15 KiB guard so certificate or
telemetry maintenance cannot silently make a production plan unapplyable.
