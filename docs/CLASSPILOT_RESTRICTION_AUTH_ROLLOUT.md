# ClassPilot restriction-auth rollout fence

`authPassThroughPolicyRevision` is a wire-order fence, not the raw settings-row
revision. SchoolPilot derives it as:

```text
(2 * classpilotSsoPolicyRevision) + (operator gate active ? 0 : 1)
```

This makes capability-first rollback monotonic: turning the operator gate off
changes an enabled fence `2N` into the newer tombstone `2N+1`. Clients retain
that high-water mark and reject delayed enabled frames at `2N`.

Because the operator gate is runtime configuration rather than database state,
re-enablement has one required sequence:

1. Turn the exact-school operator gate on. The provisional `2N` projection is
   older than the retained rollback tombstone and is intentionally ignored.
2. While the gate is on, review and PATCH/re-save the school SSO policy. The
   settings revision advances to `N+1`, producing fence `2N+2`.
3. Wait for recently active exact bindings to report
   `appliedAuthPolicyRevision: 2N+2` before treating enforcement as synced.

Do not use a policy PATCH performed while the gate is off as the re-enable
bump. It produces a still-newer off tombstone and therefore cannot authorize
the subsequent lower enabled projection. A future durable operator-rollout
generation can replace this sequencing rule if the gate moves into a
transactional data store.

## Policy-edit convergence

An administrator PATCH commits the new policy revision before SchoolPilot
starts best-effort exact-binding fan-out. This is deliberately asynchronous:
SchoolPilot does not claim instantaneous revocation at the instant the settings
transaction commits. The immediate control sync normally supplies the newer
envelope or tombstone first; heartbeat, login, WebSocket recovery, and explicit
state requests are the durable fallback. The extension's monotonic
`authPassThroughPolicyRevision` fence makes both network arrival orders safe:
newer authority replaces older authority, and a delayed older frame cannot
restore a removed host.
