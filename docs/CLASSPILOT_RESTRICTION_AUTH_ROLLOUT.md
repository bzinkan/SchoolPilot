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

### Portal-first login compatibility

Student Portal is configured in **Admin Panel → Student Portal**. A client
advertising `restrictionPortalFirstV1` must also negotiate
`restrictionAuthPassThroughV1` and `scopedAuthorityChecksV1`. The portal marker
is a companion of the existing school authentication rollout: it uses that
parent's flag and school selection, with no separate rollout entry to enable.

For an active Waypoint or Flight Path at a full-monitoring student login, the
locked login response includes `deliveryContext.portalFirstOnLogin: true` and
the configured authentication policy only for a negotiated portal client.
That client stages the snapshot until its authentication commit completes,
then validates and applies the exact student/session binding before opening
the portal. Older clients retain the envelope-free login response that avoids
the restricted-sign-in regression. A heartbeat, reconnect, policy save, or
ordinary live teacher command never creates a fresh portal-entry request.

The student chooses an application from the portal. Completing an identity
provider round trip does not navigate away from the portal, and the bounded
authentication-attempt timer does not remove portal access. The destination
must still satisfy the current Waypoint or Flight Path; authenticating through
Clever does not approve all applications in Clever. School and teacher blocks
and attention remain authoritative. Waypoint authentication completion uses
the same domain boundary as subsequent page navigation.

The independent `lateSignInRestrictionSsoV1` rollout still controls authoring
and delivery of restrictions assigned while students are signed out. A portal
policy does not silently enable that rollout. Test both an ordinary retained
restriction and a deferred assignment with its existing gate enabled before
claiming support for both operational flows.

Portal readiness counts the new `restrictionPortalFirstV1` negotiation, not
only older authentication pass-through. A ready count is protocol evidence,
not proof of a successful real Clever/IXL login on managed Chromebooks.

An administrator PATCH commits the new policy revision before SchoolPilot
starts best-effort exact-binding fan-out. This is deliberately asynchronous:
SchoolPilot does not claim instantaneous revocation at the instant the settings
transaction commits. The immediate control sync normally supplies the newer
envelope or tombstone first; heartbeat, login, WebSocket recovery, and explicit
state requests are the durable fallback. The extension's monotonic
`authPassThroughPolicyRevision` fence makes both network arrival orders safe:
newer authority replaces older authority, and a delayed older frame cannot
restore a removed host.

## Guarded runtime profiles

The operator gate is runtime configuration and is changed only through
`scripts/deploy-classpilot-runtime-config.ps1` with a schema-6 profile. Two
profiles exist:

```json
{ "schemaVersion": 6, "mode": "restriction-auth-pilot", "pilotSchoolId": "<canonical school uuid>" }
```

```json
{ "schemaVersion": 6, "mode": "restriction-auth-off" }
```

There is deliberately no global-on mode. `restriction-auth-pilot` scopes the
capability to exactly one canonical UUID school, and the deploy test rejects
both a `restriction-auth-global-on` profile and any runtime whose
`restrictionAuthPassThroughV1` rollout entry is `on` without `schoolIds`.
Schema 6 requires no candidate receipt and no pilot evidence file; the
receipt and evidence parameters of the tool do not apply to it.

Prerequisites, enforced when the plan is built and re-checked at Apply:

- The source runtime already runs `global-on`, `tracking-window-pilot`, or
  `tracking-window-global-on`. The profile is additive on top of that
  completed runtime; it cannot bootstrap one.
- `restrictionAuthPassThroughV1` starts from off. A pilot cannot replace an
  existing pilot; apply `restriction-auth-off` first.
- Every other capability keeps its mode and school list byte-for-byte. The
  tool copies the source `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON`, rewrites only
  the `restrictionAuthPassThroughV1` entry and its
  `CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1` kill switch, and refuses
  the plan if any other capability, school scope, or the TURN wiring would
  change.
- `scopedAuthorityChecksV1` is `on` in the source rollout registry.
- Weekdays 04:45–05:59 America/New_York are the protected school-day floor
  scale-up window.
  Plan and Apply are both blocked inside it unless
  `-ConfirmProtectedWindowProductionMutation` is passed together with
  `-ConfirmProductionMutation`. The plan records that authority, and Apply
  must present the same confirmation the plan was built with.
- Apply requires `-ConfirmProductionMutation -PlanPath -ExpectedPlanSha256`.
  The plan file is re-hashed and must match.
- Profile files are private: an absolute path outside the repository, a
  regular file (no reparse points), with an ACL restricted to the operator
  and SYSTEM. `-ExternalEvidenceRoot` is likewise a private directory
  outside the repository; the tool writes each run's `plan.json` and
  `result.json` there.
- The DynamoDB operation lock (`schoolpilot-terraform-locks`, item
  `schoolpilot/production/classpilot-runtime-config-v1`) must be free. Apply
  and Rollback acquire it for the duration of the run.

## Deployment and rollback

1. Deploy the API and worker from one reviewed SHA with
   `CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1=false` and the
   `restrictionAuthPassThroughV1` rollout entry at `{"mode":"off"}`. Existing
   clients are unchanged; the policy endpoint reports
   `operatorGateActive: false` and `extensionReadiness.status:
   "rollout_disabled"`.
2. Confirm recently active managed devices report the raw and accepted
   `restrictionPortalFirstV1` capability. `extensionReadiness` counts
   `rawCapableBindings`, `acceptedCapableBindings`, and `readyBindings` over
   the five-minute observation window; the Admin Panel → Student Portal
   card surfaces this as the Chromebook evidence step
   (`N of N recent bindings reported and negotiated the required
   capability`).
3. Plan, hash, and apply `restriction-auth-pilot` for exactly one school:

   ```text
   -Operation Plan -ProfilePath <private profile> -ExternalEvidenceRoot <private root>
     -ExpectedAppSha <sha> -ExpectedImageDigest <sha256:…>
     -ExpectedApiTaskDefinitionArn <current api arn>
     -ExpectedWorkerTaskDefinitionArn <current worker arn>
   -Operation Apply -PlanPath <root>/<runId>/plan.json -ExpectedPlanSha256 <sha256>
     -ConfirmProductionMutation
   ```

   Record the SHA-256 the Plan step prints and pass it verbatim to Apply.
   Verify both newly registered task definitions carry
   `CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1=true` and a
   `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` entry
   `"restrictionAuthPassThroughV1":{"mode":"on","schoolIds":["<uuid>"]}` with
   every other entry unchanged from the prior task definitions.
4. With the gate on, open Admin Panel → Student Portal for
   the pilot school. The Server rollout step must read "Student Portal rollout
   is active for this school." Enable the policy, choose the provider, resolve any
   block-list conflicts, and Save. This PATCH is the policy revision bump
   that mints the even fence `2N` described above; a save performed before
   this point only produces another off tombstone.
5. Verify convergence. `extensionReadiness.status` moves from
   `no_recent_bindings` (off-hours, no binding in the window) through
   `partial` to `ready`, and recently active exact bindings report
   `appliedAuthPolicyRevision` equal to the new fence. On a managed
   Chromebook under a Waypoint, confirm a Clever or Google sign-in round trip
   (provider start, any Google Accounts handoff, callback) leaves the portal
   available for the student to launch an allowed learning destination while
   unrelated applications and hosts stay blocked, and that
   attention, school blocks, and teacher blocks still win over pass-through.
6. Rollback is capability-first. Plan and Apply `restriction-auth-off` with
   the post-pilot API and worker task-definition ARNs as
   `-ExpectedApiTaskDefinitionArn` / `-ExpectedWorkerTaskDefinitionArn`, or
   run `-Operation Rollback -PlanPath -ExpectedPlanSha256
   -ConfirmProductionMutation` against the pilot plan to restore its recorded
   prior task definitions. Either path flips the gate off, which projects the
   `2N+1` tombstone; no policy edit and no extension rollback is required.
   Re-enabling later must repeat steps 3 and 4 in that order: gate on first,
   then a policy save while the gate is on. A policy save while the gate is
   off only mints another off tombstone and cannot authorize the later
   enabled projection.
