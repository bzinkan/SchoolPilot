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

The deployment helper binds `late-signin-pilot` to this immutable final release
identity:

- annotated tag: `v2.7.9`;
- merged extension commit: `ce4b45d0da67dab8f28e71600528b50ab52bff01`;
- production extension ID: `iggbfegfcjkfieoemeolfmfnapepalca`;
- clean-tag ZIP SHA-256:
  `0a60e83b4e968e0fa5ae36c077ee7715ff19af3f2902c8ea39ce2e4d651b08ac`.

All four values must match together. The helper explicitly rejects both the
prematurely tagged auth-only commit and its obsolete ZIP hash. Synthetic
evidence must repeat the exact final values. The `late-signin-off` rollback
profile remains usable with the final binding.

The older `student-gate-global-on` compatibility profile remains accepted by
the deployment tool for prior rollout recovery. It is not authorized for this
2.7.9 single-school deployment. Neither student-gate presence nor late-sign-in
delivery may be enabled globally.

## Activation order

1. Deploy the API and web application with both new capabilities off.
2. Confirm API, worker, Redis, and frontend health with public 2.7.8 clients.
3. Verify the deployment helper and reviewed evidence match the immutable
   `v2.7.9` tag, merge SHA, extension ID, and retained ZIP SHA-256 above.
4. Publish 2.7.9 only after controlled-Chromebook acceptance.
5. Wait until every recently active managed Chromebook reports 2.7.9 and raw
   `studentAuthGatePresenceV1` and `lateSignInRestrictionSsoV1` capabilities.
6. Enable `student-gate-pilot` for the exact school and complete its pilot.
7. Enable `late-signin-pilot` for the same exact school and observe a normal
   school day.

Unknown, offline, stale, and older bindings remain withheld. A raw capability
report is not delivery authority: SchoolPilot also requires the current
exact-school gate, negotiated capability, and exact student/session/device
binding.

## Rollback

Run `late-signin-off` before changing any extension or backend deployment. The
off profile stops new offline authoring, deferred delivery, and deferred ACK
processing. Explicit clear removes deferred-origin provenance. Effective
expiry leaves that provenance as immutable audit history, but the expired row
serializes only an empty restriction revision and no longer counts as a
rollback blocker. Do not deploy backend code that predates the feature while
unexpired stamped states remain. After 2.7.9 is published, extension repair
requires a higher Chrome Web Store version, normally 2.7.10.

Use the school-admin `GET /api/classpilot/late-signin-rollout-status` response
as the rollback backlog gauge. `stampedStateCount` is read directly from
durable control state, excludes effectively expired top-level stamps, and
contains no student identifiers. A pre-feature
backend is eligible only after the late-sign-in gate is off and the response
reports both `stampedStateCount: 0` and `safeForBackendRollback: true`;
hot-path event counts are not proof of a zero backlog.
The count includes deferred provenance nested under Coverage's
`restorableClassState` even after the Coverage row expires, because lifecycle
restoration can still copy that state into a live class with a fresh expiry.
That nested stamp blocks rollback until Coverage lifecycle restores or clears
it. Null top-level expiry metadata remains fail-closed and continues to count
until an explicit clear supplies a safe terminal state.
