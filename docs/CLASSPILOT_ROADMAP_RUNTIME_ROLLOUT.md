# Runtime rollout: monitoring hours, school website policy, content labels, precise restriction resources

This document describes the implemented protocol and the checks required before an operator enables it. It is not deployment or load-test evidence. The API/web deploy and Chrome Web Store release remain separate operations.

## Capability admission

Negotiation requires a protocol-v3 client advertising the capability, `CLASSPILOT_PROTOCOL_V3_ENABLED=true`, `CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1=true`, and the corresponding feature flag below. `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` is authoritative when present: both the feature and `scopedAuthorityChecksV1` need active entries covering the school. An omitted entry stays off even when its flag is true; `off` and `observe` do not activate a capability. Without the rollout map, enabled flags apply globally, so use the guarded school-scoped profiles for admission.

| Capability | Feature flag | Schema-v7 profile modes |
| --- | --- | --- |
| `afterHoursSafetyOnlyV1` | `CLASSPILOT_CAP_AFTER_HOURS_SAFETY_ONLY_V1` | `after-hours-safety-only-pilot`, `after-hours-safety-only-off` |
| `schoolWebsiteBlockEnforcementV1` | `CLASSPILOT_CAP_SCHOOL_WEBSITE_BLOCK_ENFORCEMENT_V1` | `school-website-block-pilot`, `school-website-block-off` |
| `screenshotReadOnlyObservationV1` | `CLASSPILOT_CAP_SCREENSHOT_READ_ONLY_OBSERVATION_V1` | `read-only-observation-pilot`, `read-only-observation-off` |
| `preciseRestrictionResourcesV1` | `CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1` | `precise-restriction-resources-pilot` (refused until the 2.10.0 evidence is bound), `precise-restriction-resources-off`; see [Precise restriction resources](#precise-restriction-resources-roadmap-pr-2) |

Read-only observation additionally requires the existing tracking-window and active-preview capabilities to cover the pilot school. It changes screenshot cadence only; see [teacher-independent observation](CLASSPILOT_READ_ONLY_OBSERVATION.md) for authorization, older-extension compatibility and rollback.

Each private pilot profile contains `schemaVersion: 7`, its `mode`, and one canonical UUID `pilotSchoolId`. Each off profile contains only the version and mode. These profiles require the completed global repaired-capability runtime, preserve every other capability/school scope and TURN wiring, and write identical API/worker controls through the existing hash-bound Plan/Apply/Rollback workflow. A pre-roadmap task with both the new flag and its rollout entry absent is recognized as off; the next source-preserving plan materializes both controls as explicitly off unless that capability is the selected pilot. A partially missing pair fails closed. There is no schema-v7 global or multiple-school activation profile; further expansion requires a reviewed admission contract. Existing screenshot/cadence profiles cannot silently disable active roadmap pilots: apply their individual off profiles first when a base-profile transition requires it. Overall protocol-off containment still disables all capabilities.

These client flags do not gate the core Safety Center/outbox, scheduling or history code. Apply the eight roadmap migrations (including reusable schedule-profile supervision) and complete the documented RLS admission before dependent API/worker deployment. The notification worker requires the normal scheduler, a valid shared `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY`, `SENDGRID_API_KEY`/sender configuration, and the correct frontend origin in `PUBLIC_APP_URL` or `APP_URL`. Validate delivery to a controlled pilot before broad exposure. Report v3 has its separate two-flag gate below.

## Monitoring hours

The server resolves `full`, `safety_only`, or `off` from school tracking hours, timezone, instructional calendar/date overrides and the existing `afterHoursMode` setting. `limited` means `safety_only` outside an eligible instructional window. Missing or invalid settings deny monitoring. An overnight window uses its starting school-local date; an explicit makeup date can substitute its chosen meeting weekday. Closures select the configured after-hours mode. Explicit full after-hours monitoring and disabled tracking hours retain their existing always-full meaning.

The non-secret calendar/override projection shares the existing five-second heartbeat cache. Calendar and scheduling writes invalidate it locally and across healthy Redis peers only after commit. Screenshot retention and delayed safety classification read uncached settings under shared school/settings locks, so concurrent calendar or date-override writes cannot change their authority mid-transaction. The extension uses the same calendar predicate and receives updated dates through authenticated settings/restricted heartbeat responses.

The extension must advertise and negotiate `afterHoursSafetyOnlyV1` with `scopedAuthorityChecksV1`; rollout uses `CLASSPILOT_CAP_AFTER_HOURS_SAFETY_ONLY_V1` and the existing scoped school capability configuration. An older/unnegotiated client receives `off` for a limited window. There is no grace period that treats limited as full.

Safety-only requests carry the active HTTP(S) URL and bounded title plus the protocol descriptor. The server authenticates the exact current student/session/device tuple and renews a manual sign-in lease without recording a normal heartbeat. It does not create normal browsing history, realtime presence, screenshot leases, pixels, teacher commands or teacher messages. Ordinary observations are transient; only an unsuppressed safety hit is retained in the Safety Center. Before retaining a delayed classification, the service rechecks the exact binding and current hours under the student-control and settings locks. No classifier closes a tab.

The extension stops screenshots, Live View, the student WebSocket, teacher overlays and classroom controls. Settings refresh on the one-minute health check, and a restricted heartbeat response carries the authoritative hours projection so an administrator's change can retire capture immediately after that response. Server pixel reads/uploads and command/observation endpoints enforce the policy independently. Authentication status is not telemetry and must not be counted as monitoring coverage. New report snapshots treat safety-only time as excluded monitoring time.

## Administrator website policy

`classpilot_school_website_policies` stores a school revision. `classpilot_school_website_deliveries` freezes exact authenticated targets and keeps pending/applied/failed results. Enforcement counts include only the current exact student/session/device bindings; ended or superseded deliveries remain historical records and do not inflate pending counts. All school block-list writes pass through `classpilotSchoolWebsitePolicy.ts`; the optional `afterSave` callback commits a Safety Center review/audit in the same transaction, including idempotent repeated blocks.

The existing `update-global-blacklist` message now includes `blockedDomains` and `policyRevision`. Clients negotiate `schoolWebsiteBlockEnforcementV1` with `scopedAuthorityChecksV1` using `CLASSPILOT_CAP_SCHOOL_WEBSITE_BLOCK_ENFORCEMENT_V1`. New clients apply DNR rules, enumerate existing tabs, re-read each candidate, and close it only if its URL and authenticated binding remain current. A changed URL is left alone. Lower revisions are ignored. A durable, binding-scoped receipt is retried at `/api/classpilot/device/school-policy-acks` until accepted or terminally superseded. `applied` means rule installation and existing-tab reconciliation completed; it is not proof that a disconnected or old client has updated. Display pending and failed outcomes honestly. Existing clients continue to install future-navigation rules; they do not claim existing-tab enforcement support.

## Content labels and report versions

`contentCategory` is nullable and uses the 20 labels in `classpilotContentCategories.ts`. It is separate from educational/non-educational/unknown, safety concern and teacher intent. Exact reviewed domain rules precede AI fallback. A mixed-purpose domain may stay unlabeled. Old heartbeat rows remain null; there is no retroactive AI backfill.

Heartbeat and decision persistence, history caches and realtime DTOs retain the label. `teacherIntentSource` on new heartbeat classifications preserves an active Flight Path or school allowed-domain exemption without changing the educational classifier result or granting safety suppression. The school allowed-domain hint has a bounded five-second cache and is never an authorization source.

`CLASSPILOT_SESSION_REPORT_V3_MODE=on` creates report v3 only when the established `CLASSPILOT_SESSION_REPORT_V2_MODE=on` is also active. Existing row versions continue using their stored version. V3 stores category totals from observed off-task intervals, with nullable labels forming the unlabeled bucket; largest-remainder allocation keeps the integer category total equal to off-task seconds. JSON and CSV read the same immutable student-report data. V1/v2 exports retain their existing columns. Browser safety explanation records identify a deterministic ruleset or an actual model version; absent confidence stays null. Daytime and safety-only browser alerts use the same versioned urgency mapping: self-harm and reviewed threatening search rules are high; broad domain matches and otherwise unsupported urgency default to medium. Browser labels alone never establish critical/imminent risk.

## Screenshot publication and capacity gate

Strict screenshot storage and screenshot-available publication now share one `withClasspilotScreenshotUploadAuthority` transaction. The callback holds the original exact student-control authority through the bounded 300ms ordered Redis publication. Existing unobserved background captures skip publication. Local fallback preserves the ordered revision fence when configured. Authority loss, capture time, tracking-window and retained-frame checks remain in force.

Capture the identifier-free `screenshotAuthorityTransactions` counter plus `screenshotAuthorityMs`, `screenshotStoreMs` and `screenshotPublicationMs` timings. The counter also emits as `ScreenshotAuthorityTransactions` in the established EMF namespace. For accepted strict uploads, verify one authority transaction; for an observed upload verify one publication, and for unobserved background verify the skip counter.

Before expanding five-second cadence, follow the current 40/500/800 fully-observed profiles in `CLASSPILOT_2_8_0_FAST_PREVIEW.md`, including class switches, shared-device handoff, school-hours boundary and browser background/wake. Retain run identities, database pool/lock timing, Redis latency/errors, upload rejection reasons, end-to-end fresh-frame latency, and cross-binding isolation results. Run both one-school and multi-school/reconnect profiles before broadening cohort scope. The historical paused 500/800 capacity campaign is not equivalent evidence. No live capability or cadence flag was changed by this implementation.

The fast-preview artifact admission remains pinned to `v2.8.2` in the guarded runtime tool. The final clean-tag `v2.8.5` package does not satisfy that release-evidence contract. Its exact identity, passing main/tag CI and unresolved first-run local resilience failure are recorded in `CLASSPILOT_ROADMAP_IMPLEMENTATION.md`; two managed-Chromebook checks and Chrome Web Store publication remain pending. Before five-second activation, verify the published successor and review an explicit admission update for that exact release and matching fixtures/runbook. Generate fresh private candidate/soak receipts bound to the resulting tag, merge SHA, ZIP hash, extension ID, tool/app/image identities and source API/worker task pair. Keep the existing pin and cadence disabled until that process completes; neither relabeling the receipt nor enabling flags manually is an admission substitute.

## Verification and rollback

Safety notification workers reserve at most 20 complete due bundles per tick at a fixed cutoff: one student report/recipient for initial mail, or one school/recipient for follow-ups. Per-bundle serialization and whole-bundle lock deferral prevent concurrent workers or queue limits from splitting alerts that were already waiting. Email detail is bounded; full counts and authenticated report links represent the complete bundle. State changes use set-based updates rather than a database roundtrip per alert.

A reservation has `status=sending` and no `submission_started_at`; a crash before submission returns that reservation to pending after ten minutes without consuming an attempt. The final entitlement, active administrator membership, review and exact URL-approval checks run under the same URL/case/alert locks as review. Committing `submission_started_at` authorizes submission and defines the in-flight boundary. Reviews committed earlier cancel the email; reviews committed later cancel remaining follow-ups but cannot recall the in-flight message. The provider call runs outside every database transaction and is bounded to 15 seconds. Timeout, ambiguous transport and crashes after authorization become `unknown` and are never blindly retried; the small interval between authorization and actual transport can therefore conservatively report unknown even if nothing left the worker. Known transient failures retry with bounded backoff. Alert generation continues even when the old AI email toggle is off.

Acknowledge records receipt and cancels follow-ups; it leaves the alert unreviewed and does not cancel the initial administrator notification. Review and case closure are separate actions.

Before rollout, run the Safety integration tests for reservation recovery, concurrent review before authorization, review during provider submission, administrator membership, MailPilot entitlement, and source expiry. The authenticated report exposes delivery status; operators should investigate sustained `unknown`/`failed` results and missing provider configuration. URL approval revocation writes a strict rule-ID audit even after the original case expires; it never adds the retained URL to the general audit log.

Focused tests are `classpilot-monitoring-policy`, `classpilot-screenshot-publish-gate`, `classpilot-school-website-policy.integration`, `classpilot-content-categories`, classifier benign fixtures, realtime/cache qualification, report exports and report rollout. Extension checks are `test-school-website-policy.mjs` and `test-extension-2-7-behavior.mjs` (10,000 forced identity races). Run database tests serially with the roadmap migrations on a local fixture database.

Before an extension release, additionally rehearse a full→limited→full and full→off→full boundary in an actual Chrome profile with the new capability on/off, a stale client, a manual shared-device handoff during classification, an offline website-policy update, a newer revision arriving before an older one, and a partial tab-close failure. Inspect receipt status and confirm private telemetry stays absent during restricted time. Packaged-extension and school cohort rollout checks remain release requirements.

Rollback capability flags before widening another cohort. A safety-only rollback makes limited clients stop monitoring; it never restores full after-hours collection. Disabling website enforcement capability leaves the durable block list and DNR filtering intact while removing the existing-tab enforcement claim. Disable the v3 report gate to keep new rows on the previous configured report version; completed v3 snapshots remain readable. Retain policy revisions and review audit history rather than deleting them.

## Precise restriction resources (roadmap PR 2)

`preciseRestrictionResourcesV1` adds "This resource only" Waypoints and Flight Path entries for one YouTube video, Google Doc, Slides deck, Sheet, Form or Drive file, or one section of a site. The extension contract, matcher and case-file hash are in [the ClassPilot 2.10.0 contract](CLASSPILOT_PRECISE_RESTRICTIONS_CONTRACT.md). The capability is off by default. While it is off for a school, teachers cannot author sections or resources (409 `PRECISE_RESTRICTION_RESOURCES_DISABLED`), a Flight Path that has them cannot be applied, and the dashboard hides the controls. An owner can still edit the websites of such a path; the stored entries stay untouched.

Admission follows the schema-v7 pattern above. Profiles:

```json
{ "schemaVersion": 7, "mode": "precise-restriction-resources-pilot", "pilotSchoolId": "<school uuid>" }
{ "schemaVersion": 7, "mode": "precise-restriction-resources-off" }
```

The pilot profile is refused until a reviewed follow-up binds the exact ClassPilot 2.10.0 package in `scripts/deploy-classpilot-runtime-config.ps1` (`PreciseRestrictionRequiredReleaseTag`, `PreciseRestrictionRequiredMergeSha`, `PreciseRestrictionRequiredZipSha256`). That package must be MANAGED-CHROMEBOOK VERIFIED on at least two Google Admin-managed Chromebooks. The off profile is always available.

### Deployment order

1. PR 2-pre (#550) and PR 2 (#555) reached `main` together, and `scripts/deploy.sh` deploys only `origin/main`, so the first production image with PR 2 also carries the PR 2-pre fence; no separate PR 2-pre image exists. Precise state can exist only after the capability is activated, so until then a rollback below #550 cannot widen anything. Never activate `preciseRestrictionResourcesV1` until the serving image and the image a rollback would return to both contain #550, which takes at least one more ordinary deploy after the first image that ships it. Once the capability has been active, never roll an image back below #550.
2. Deploy the server image containing PR 2 with the capability off. Merging PR 2 changes the runtime-config tool, so any plan saved before the merge is void; plan every later profile from the post-merge tool SHA.
3. Only an image that registers `preciseRestrictionResourcesV1` ever receives its registry entry. An older image's boot check (`assertClasspilotCapabilityRolloutsEnv`) refuses to start on an unknown registry key, so the tool projects every runtime it produces onto the capabilities the serving image registers:
   - It reads them with `git show <app sha>:src/services/classpilotProtocol.ts`; the ECR tag check binds that SHA to the serving digest.
   - It omits the registry entry and the kill switch of any capability the image does not register; the image reads that exactly as off.
   - It refuses a profile only when that profile would activate, or keep active, such a capability.

   Every Apply against an image with PR 2 writes the entry, as `{"mode":"off"}` unless the precise pilot is selected. Apply re-derives the projection and must reproduce the reviewed runtime byte for byte.
4. ClassPilot 2.10.0 ships only after server PRs 2 to 5 are deployed with their capabilities off. Then comes the pilot profile, after the evidence binding above.

**Emergency use in the merge-to-deploy window.** While this tool is newer than the serving image, ordinary profiles simply omit the precise pair, and `-Operation Rollback` restores exact prior pairs as before. The global `off` containment skips the ECR tag check, so it does not trust the typed app SHA for the projection. It projects onto the keys of the serving task definition's own registry instead: the running image parsed every one of them at boot. A mistyped, newer or unreadable app SHA therefore cannot put an unknown key into the emergency runtime, and the emergency path needs neither ECR nor the app's commit in the local checkout.

Saving a `forms.gle` link makes the API resolve it once, at save time: HTTPS `HEAD` requests with manual redirects, at most 3 hops, 3 seconds each, and `GET` only on a 405. Each hop must stay on `forms.gle` or `https://docs.google.com/forms/`. This is an outbound egress dependency of the API tasks (through the NAT). A failure returns 400 `RESOURCE_SHORT_LINK_UNRESOLVED` and nothing is stored. Only requests that need resolution count against `restrictionResourceResolutionLimiter`: 30 per user per 10 minutes, Redis-backed.

### Rollback runbook

Follow these steps in order. They end every stored precise restriction explicitly before any image older than PR 2 can read it.

1. **Turn the capability off.** Plan and Apply `precise-restriction-resources-off`. Precise states are then withheld from every client, precise commands are refused, and teachers see "Extension update required for this Waypoint or Flight Path" for affected students.
2. **Clear stored precise restrictions with a control-revision bump.** The reviewed script is `src/cli/clearClasspilotPreciseRestrictions.ts`. It is dry-run first and prints only school IDs, counts and a proof. Run the inventory in an ECS one-off task of the API task definition, so it reads the same registry:

   ```text
   npm run clear:classpilot-precise-restrictions -- --all-schools
   ```

   Exit code 3 means precise rows remain; each affected school is listed. For each school, run the dry run, then execute with the exact proof it printed. Execution has three requirements:
   - The one-off task override `PRECISE_RESTRICTION_CLEAR_EXECUTION_ADMISSION=controlled-ecs-one-off-v1`.
   - The one-off must run the live API service's current task definition revision. Read it with `aws ecs describe-services --cluster schoolpilot-production-cluster --services schoolpilot-production-api --query 'services[0].taskDefinition'` and pass it as `--api-task-definition-arn`. The CLI verifies its own ECS task identity against it, so the capability check reads the live service's registry and kill switch, not another revision's.
   - The capability must be off for the school in that live revision.

   ```text
   npm run clear:classpilot-precise-restrictions -- --school-id <school-uuid>
   npm run clear:classpilot-precise-restrictions -- --school-id <school-uuid> --execute --proof <precise-clear-proof-v1:...> --acknowledge precise-restriction-clear-v1 --api-task-definition-arn <live API task definition ARN>
   ```

   The clear runs in one transaction per school and takes each student's control lock. It is refused while the capability is still active for the school, and it is refused when the rows changed after the dry run: run the dry run again. It replaces each precise Waypoint with `{ "active": false }` and each precise Flight Path with `{ "active": false, "allowedDomains": [] }`, in the snapshot, the legacy flat shape and the Coverage restoration snapshot. Every other restriction is kept exactly. The script also bumps the revision, sets health `pending` and clears the source command, and it clears the matching `classpilot_classroom_states` rows. Devices pick up the new revision on their next heartbeat. Flight Path definitions (`flight_paths.resources`) and command history are not changed. Tell the affected teachers that those restrictions ended; they can apply a website Waypoint or a website-only Flight Path instead.

   The inventory runs this read-only precheck, quoted verbatim so it can be reviewed and run separately. It must return zero rows before step 3:

   ```sql
   SELECT 'control_state' AS kind, school_id, count(*)::int AS row_count
   FROM classpilot_student_control_states
   WHERE desired_state @? 'strict $.restrictions.screenLock.resource'
      OR desired_state @? 'strict $.restrictions.flightPath.resources'
      OR desired_state @? 'strict $.screenLock.resource'
      OR desired_state @? 'strict $.flightPath.resources'
      OR desired_state @? 'strict $.restorableClassState.desiredState.restrictions.screenLock.resource'
      OR desired_state @? 'strict $.restorableClassState.desiredState.restrictions.flightPath.resources'
      OR desired_state @? 'strict $.restorableClassState.desiredState.screenLock.resource'
      OR desired_state @? 'strict $.restorableClassState.desiredState.flightPath.resources'
   GROUP BY school_id
   UNION ALL
   SELECT 'classroom_state' AS kind, school_id, count(*)::int AS row_count
   FROM classpilot_classroom_states
   WHERE cleared_at IS NULL
     AND ((state_type = 'screen-lock' AND payload ? 'resource')
       OR (state_type = 'flight-path' AND payload ? 'resources'))
   GROUP BY school_id
   ORDER BY kind, school_id;
   ```

3. **Project the registry onto the target image.** Plan and Apply `precise-restriction-resources-off` again with `-RegistryTargetAppSha <the older image's full app SHA>`. The plan projects onto what both the serving image and the target register: it drops the precise entry and kill switch, which are already off, and preserves every other control. The plan records the target, and Apply re-derives the same projection. A target that would drop an active capability is refused; turn that capability off with its own off profile first. This works after ordinary `scripts/deploy.sh` deploys too, and needs no `-Operation Rollback` and no pre-PR-2 tool. Apply no other runtime profile between this step and step 4: a plan against the still-serving PR 2 image would write the entry again.
4. **Only then revert the image**, and never below the PR 2-pre (#550) image. `scripts/deploy.sh` carries the live registry forward; it now names only capabilities the older image registers, so the older image boots. Later plans against it project onto its registry automatically.

If step 2 is skipped, an older image still fails closed: the PR 2-pre fence withholds every stored precise state, so a 2.10.0 device keeps its last applied restriction until the revision changes or `hardExpiresAt` passes (at most 12 hours), and teachers see the student as unsupported. The clear is still required, because it ends those restrictions visibly and leaves nothing for a later image to interpret.

After a rollback, older images never read `flight_paths.resources`. A resource-only Flight Path is refused with 409 `FLIGHT_PATH_EMPTY`, and a mixed path applies its websites only, which is narrower. Re-deploying PR 2 later restores the stored entries unchanged.

Focused tests: `restriction-resources`, `restriction-resource-resolver`, `classpilot-precise-restriction-projection`, `classpilot-precise-restriction-fence`, `classpilot-precise-restriction-dispatch` (dispatch gate and the rollback clear, DB), `classpilot-precise-restriction-clear` (transform, precheck and CLI safety), `flight-path-precise-resources-routes` (DB), `flight-path-resources-migration`, and the `classpilot-runtime-config-deploy.test.ps1` precise and registry-projection cases: the merge-to-deploy window, refused activation, emergency off with an unreadable or mistyped SHA, the older-image target, and refusing to drop an active capability.
