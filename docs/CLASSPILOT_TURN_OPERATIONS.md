# ClassPilot TURN operations

The two-node coturn module remains dark until `enable_classpilot_turn=true` is
applied through the reviewed infrastructure workflow. Application capability
activation is separate: `liveViewIceServersV1` must be enabled for the exact
school and advertised by the current student binding before credentials or
telemetry are accepted.

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
authority mismatch or if the release-wide Live View gates fail. Capability
rollback is server-side; the additive infrastructure remains in place.
