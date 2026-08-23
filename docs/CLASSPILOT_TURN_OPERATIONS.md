# ClassPilot TURN operations

The two-node coturn module remains dark until `enable_classpilot_turn=true` is
applied through the reviewed infrastructure workflow. Application capability
activation is separate: `liveViewIceServersV1` must be enabled for the exact
school and advertised by the current student binding before credentials or
telemetry are accepted.

## Provisioning and activation boundary

`infra/production.tfvars` intentionally defaults TURN to disabled. Provisioning
requires a separately reviewed Terraform plan/apply with the production TURN
flag enabled and the operator-owned TLS email supplied through the documented
private variable path. Do not combine this infrastructure mutation with an API
image deployment or a ClassPilot runtime-profile change.

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
6. aggregate identifier-free node/application telemetry is healthy; and
7. a managed test device with UDP blocked completes Live View through TURN/TCP
   or TURNS/443.

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

Run `scripts/deploy-classpilot-runtime-config.ps1` only after this gate is green.
It updates the exact active same-digest API and worker revisions together; do
not copy TURN values into one task definition by hand. Activate the test school
first, finish the managed Live View gate, and use the helper's `global-on`
profile only after the complete 2.7.1 managed test suite is green. The final
release state has `liveViewIceServersV1` globally on; leaving it dark is a
temporary deployment or incident posture, not release completion.

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
  aggregate collector. Raw coturn lines are never forwarded to CloudWatch;
- `RelayBytes` from client-side usage records for sessions that successfully
  allocated a relay (peer rows are excluded to prevent double counting);
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
