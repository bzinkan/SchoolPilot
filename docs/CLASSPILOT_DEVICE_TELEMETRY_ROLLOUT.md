# Device telemetry and exact screenshot references

This implementation adds two capabilities, both off by default:

| Capability | Flag | Required parents |
| --- | --- | --- |
| `deviceTelemetryTransportV1` | `CLASSPILOT_CAP_DEVICE_TELEMETRY_TRANSPORT_V1` | Protocol v3, `scopedAuthorityChecksV1` |
| `scopedScreenshotReferencesV1` | `CLASSPILOT_CAP_SCOPED_SCREENSHOT_REFERENCES_V1` | Protocol v3, scoped authority, device telemetry, `screenshotTrackingWindowLeaseV1` |

Chrome extension publication is separate from the backend and dashboard release.
Windows bridge negotiation removes both markers until that client supports them.
Captures keep their existing cadence and quality. References reuse only identical
image bytes within the exact school/student/login/classroom or supervision binding;
each capture still supplies fresh metadata and passes current authority checks.

## Release order

1. Merge and review both repositories. Complete the backend migration through the
   checksum-ledger migration task. Deploy the backend and dashboard with both new
   capabilities **off**, then wait for the API and worker to converge completely.
2. Release the separately reviewed extension package and establish actual managed
   device adoption. A Store listing or submission alone does not prove adoption.
3. Complete the bounded Windows/local correctness checks against the exact final
   committed backend and extension sources. Preserve their factual outputs in the
   owner-only external evidence directory. Do not claim fleet capacity from these
   checks and do not start Linux/AWS load infrastructure for this rollout.
4. Prepare and review the existing WAF rule override separately before an entire
   2,000-device fleet can recover through HTTP. The existing 100,000-request/5-minute
   WAF setting is below the modeled 180,000 telemetry operations/5 minutes at the
   all-observed cadence. The proposed 300,000 override requires its own reviewed
   infrastructure apply. No infrastructure apply is part of this implementation.
5. Use the governed runtime tool's Plan → review → Apply → verify flow for a
   one-school telemetry pilot, then its global promotion. Activate a references
   pilot afterwards, then promote it globally. Pilot scopes must stay inside each
   active parent scope; a global child requires global parents.

The runtime tool requires a stable API/worker pair on the exact reviewed image
digest and source SHA before planning and again before mutation. Its source
capability projection refuses ON controls if either the serving source or a
requested rollback target lacks the registry entries. This makes the image-first,
flags-second sequence mandatory. The existing shared mutation lease, source pins,
private profile snapshot hash, task bounds, and convergence checks are unchanged.

## Schema 12 profiles

| Mode | Changes |
| --- | --- |
| `device-telemetry-pilot` | Transport off → on for exactly `pilotSchoolId` |
| `device-telemetry-global-on` | Transport's active one-school pilot → global |
| `device-telemetry-off` | Disable transport only; references must already be off |
| `screenshot-references-pilot` | References off → on for exactly `pilotSchoolId` |
| `screenshot-references-global-on` | References' active one-school pilot → global |
| `screenshot-references-off` | Disable references only |

Every mode preserves all unrelated capability flags, entries, school scopes,
transient replay controls, and existing task configuration. Off profiles need no
compatibility record and cannot broaden any other capability. They can be applied
idempotently. An activation record is distinct from runtime approval and from
capacity acceptance. Schema 12 does not reuse old Roadmap/2.9.7 release artifacts.

An activation profile has this shape; placeholders make this example invalid:

```json
{
  "schemaVersion": 12,
  "mode": "device-telemetry-pilot",
  "pilotSchoolId": "REPLACE_CANONICAL_SCHOOL_UUID",
  "localValidation": {
    "schemaVersion": 1,
    "validationLevel": "local_windows_correctness",
    "capacityAccepted": false,
    "appSha": "REPLACE_FINAL_BACKEND_40_HEX_SHA",
    "extensionSha": "REPLACE_FINAL_EXTENSION_40_HEX_SHA",
    "checks": {
      "httpWsParity": true,
      "lostReplyIdempotency": true,
      "staleBindingDenied": true,
      "controlLaneIndependent": true,
      "realChromeMv3Passed": true,
      "captureCadenceAndPixelsPreserved": true
    }
  }
}
```

Set a check to true only after the corresponding check has actually passed for
both exact commits. The record must live with the private profile outside the
repository; tests contain synthetic records only. Plan and Apply both require
`localValidation.appSha` to match the immutable `ExpectedAppSha` serving-image
identity. The extension SHA identifies the independently checked client commit;
publication and device adoption still require separate operator verification.
`capacityAccepted` must be the boolean `false`; true is rejected. No completed
production compatibility or capacity record is generated by this change.

Global profiles omit `pilotSchoolId` and carry the same factual local record.
Off profiles contain only `schemaVersion` and `mode`, for example:

```json
{"schemaVersion":12,"mode":"screenshot-references-off"}
```

Use `scripts/deploy-classpilot-runtime-config.ps1` with `-Operation Plan`, the
private `-ProfilePath` and `-ExternalEvidenceRoot`, and the exact
`-ExpectedAppSha`, `-ExpectedImageDigest`, `-ExpectedApiTaskDefinitionArn`, and
`-ExpectedWorkerTaskDefinitionArn`. Review the resulting plan and hash, then use
the documented Apply procedure in [runtime operations](CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md).
The tool changes runtime configuration only; it does not release either binary.

## Disable and binary rollback

First apply `screenshot-references-off`, then `device-telemetry-off`. Confirm the
serving pair has converged with both controls off. Wait **at least 120 seconds**
for exact-image cache entries and in-flight recovery to drain before rolling back
to a pre-feature binary. Keep the additive nullable heartbeat fingerprint column
and its immutable migration ledger entry. Do not reverse the migration or reuse
an operation ID for changed payloads. Older clients continue to use canonical HTTP.

The 300,000-operation/300-second WebSocket source-IP ceiling is shared across API
processes through Redis. Without `REDIS_URL`, MemoryStore is per-process. Configured
Redis store errors preserve the existing HTTP `passOnStoreError` bypass behavior.
Authenticated per-device limits when the store is healthy, admission, bounded frames,
fresh token/session/entitlement checks, and separate control lanes remain active.
This ceiling provides recovery headroom above the modeled 2,000-device cadence;
it is not evidence that database capacity or a $300 monthly ceiling has passed.

## Local verification and governance evidence

The focused PowerShell tests dot-source pure profile helpers and invoke no AWS
provider:

```powershell
pwsh -NoProfile -File tests/classpilot-telemetry-runtime-registry.test.ps1
pwsh -NoProfile -File tests/classpilot-telemetry-runtime-profiles.test.ps1
pwsh -NoProfile -File tests/classpilot-runtime-config-deploy.test.ps1
```

Backend auth/session changes require the repository's SOC2 evidence workflow:

```powershell
npm run soc2:privileged-access-evidence
npm run soc2:deployment-evidence
```

These commands collect local, ignored evidence; they do not authorize deployment
or satisfy a missing human approval. Run the required backend/frontend correctness
checks and final source-bound local Chrome checks as part of the release review.
