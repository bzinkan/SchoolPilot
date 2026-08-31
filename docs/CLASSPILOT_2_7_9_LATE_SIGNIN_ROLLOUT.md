# ClassPilot 2.7.9 late-sign-in rollout

This deployment is authorized for one exact school only. The capability is
fail-closed and must remain off while SchoolPilot is deployed and while Chrome
Web Store clients are mixed between 2.7.8 and 2.7.9.

## Runtime profiles

Use the source-preserving schema 4 profiles with
`scripts/deploy-classpilot-runtime-config.ps1`:

```json
{
  "schemaVersion": 4,
  "mode": "late-signin-pilot",
  "pilotSchoolId": "00000000-0000-4000-8000-000000000000"
}
```

```json
{
  "schemaVersion": 4,
  "mode": "late-signin-off"
}
```

`late-signin-pilot` preserves every existing runtime entry, sets
`CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1=true`, and creates an `on`
`lateSignInRestrictionSsoV1` rollout entry scoped to exactly the supplied
school UUID. `late-signin-off` preserves the registry while setting both the
kill switch and rollout entry off.

The older `student-gate-global-on` compatibility profile remains accepted by
the deployment tool for prior rollout recovery. It is not authorized for this
2.7.9 single-school deployment. Neither student-gate presence nor late-sign-in
delivery may be enabled globally.

## Activation order

1. Deploy the API and web application with both new capabilities off.
2. Confirm API, worker, Redis, and frontend health with public 2.7.8 clients.
3. Publish 2.7.9 only after controlled-Chromebook acceptance.
4. Wait until every recently active managed Chromebook reports 2.7.9 and raw
   `studentAuthGatePresenceV1` and `lateSignInRestrictionSsoV1` capabilities.
5. Enable `student-gate-pilot` for the exact school and complete its pilot.
6. Enable `late-signin-pilot` for the same exact school and observe a normal
   school day.

Unknown, offline, stale, and older bindings remain withheld. A raw capability
report is not delivery authority: SchoolPilot also requires the current
exact-school gate, negotiated capability, and exact student/session/device
binding.

## Rollback

Run `late-signin-off` before changing any extension or backend deployment. The
off profile stops new offline authoring, deferred delivery, and deferred ACK
processing. Durable deferred-origin provenance remains until the restriction
is explicitly cleared or expires. Do not deploy backend code that predates the
feature while stamped states remain. After 2.7.9 is published, extension repair
requires a higher Chrome Web Store version, normally 2.7.10.

Use the school-admin `GET /api/classpilot/late-signin-rollout-status` response
as the rollback backlog gauge. `stampedStateCount` is read directly from
durable control state and contains no student identifiers. A pre-feature
backend is eligible only after the late-sign-in gate is off and the response
reports both `stampedStateCount: 0` and `safeForBackendRollback: true`;
hot-path event counts are not proof of a zero backlog.
The count includes both top-level deferred state and deferred provenance nested
under Coverage's `restorableClassState`, so an active Coverage handoff cannot
produce a false zero.
