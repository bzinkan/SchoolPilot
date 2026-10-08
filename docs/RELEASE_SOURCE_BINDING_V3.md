# Reviewed C578 security successor preparation

Version 3 is additive. Versions 1 and 2 keep their existing DDC/C578 identities,
historical rehearsal requirements and behavior. Only
`release-297-current-school-fallback-v3` is allowlisted. The reviewed profile is
stored under `docs/release-bindings`, outside the image inputs.

The application recovery reference A, current-main tooling source B and fallback
source F are separate. F is `d75fc1c48d0a3918857508d3965904c69023a153`, a child of
exact C578 with only the lockfile delta represented by `86ea5c5`. Its Git delta
must match the correction's semantic before/after values, preserving C578's
unrelated lock entries. No CLI source override or equivalence bypass exists.

## Offline preparation validation

Both artifact controllers expose `ValidateSuccessorPreparation <input.json>
<sha256>`. This operation validates evidence and prints a preparation result; it
does not create an executable Plan, publish, register, launch, deploy or activate.

The input contains `schemaVersion: 3`, the allowlisted `releaseBindingId`, an
absolute clean `anchorDirectory` and its exact `anchorSource`, an absolute clean
`fallbackDirectory`, and an external private `retainedEvidenceDirectory`. A and B
must have identical deterministic backend/frontend Git inventories. Output and
private evidence roots cannot overlap source/tool roots. Public pins normalize
Git LF bytes; private pins hash actual bytes. Reparse points and inadequate
private permissions fail validation.

The profile's preparation evidence contains exactly `successorScan`,
`screenshotRuntime`, `requestIpRateLimit`, `ordinaryRecovery`, and
`restrictedRestoration`. Each committed public envelope binds the exact A/F
artifact pair and hashes a retained native result and independent review. Native
results hash their actual raw JSON, text or binary records. Review must identify
a different producer/reviewer, review the exact native and raw hashes and occur
after the native result. Ordinary recovery requires 43→53, the ordered admission
chain 121→125→126→127→128→129 and A→F→A with 52 declared fallback migrations and
53 retained completed rows. Historical 54-entry evidence is rejected.
Migration receipts must explicitly observe a NOSUPERUSER/NOBYPASSRLS migration
role for the ordinary 43→53 path. Restoration receipts must observe both a
NOSUPERUSER/NOBYPASSRLS DDL owner and probe role, with a stable 43/53 serialization
roundtrip; a superuser restore followed by restricted probes does not satisfy it.

The scan additionally replays exact receipt/report/config/archive hashes, pinned
scanner identity, zero High/Critical findings, database metadata and unforced
owned-scanner custody. It must follow C578's recorded failed scan and be no more
than 24 hours old. Lower-severity findings remain visible. Successful preparation
always returns `preparationPassed: true`, `releaseReady: false`,
`operationalAuthorization: false`, `cloudMutations: 0`, and remaining acceptance
and selection gates.

## Publication and unused definitions

Operational Plans require the profile to be accepted, the exact successor
selection to be independently recorded, original candidate campaigns and owner
source applicability to pass, and both sources/tools to be clean. B must equal
the tool HEAD and local `origin/main`, with a private exact-main push CI snapshot
observed within two hours. Apply refreshes GitHub main and exact-main workflows
before cloud mutation and each write. Existing explicit authorization windows,
environment/capability equality and private-chat floors remain in force.

Publication inputs use `kind: serving-anchor` or `kind: fallback`. Each receipt
contains `artifactRole`, `artifactSource`, role-specific image/configuration,
binding ID/hash and validator hash. Serving publication takes `sourceDirectory`
and `source` for B while its tested image remains labelled A. Fallback publication
takes those fields for F and also `mainDirectory`/`mainSource` for B; it must not
include alternate `anchorDirectory`/`anchorSource` fields. Both paths require
`mainCi`; caller receipt fields cannot select a different artifact.

Unused121 and Anchor128 require serving-anchor publication. Compatible fallback
requires **both** the serving-anchor `anchorPublication` and exact F
`fallbackPublication`. Candidate publication or scan cannot satisfy F checks.
Every path carries the same binding and validator pins through Plan and replay;
fallback definitions stamp F's source and preserve all unrelated runtime fields.
The original C578 identity and failed scan remain historical records. Partial
registration keeps returned ARNs and uncertainty without cleanup mutations.

Preparation acceptance does not select F. A recorded exact-artifact replacement
review and full candidate release acceptance are subsequent gates. Any A/F
application change invalidates affected recovery evidence. ClassPilot 2.9.7,
DeSales's 133 clients, both new Usage modes off and managed-device
`waived_not_passed` remain unchanged.
