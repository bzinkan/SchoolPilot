# Release image and unused121 anchor preparation

This page describes the historical version-1 DDC path. Changed application
candidates require the additive [version-2 source binding](RELEASE_SOURCE_BINDING_V2.md).
Its committed profile is pending and blocks all v2 operations; no fresh native
acceptance or release authorization is implied by the tooling repair.

`scripts/prepare-release-artifacts.mjs` provides two separately authorized
artifact operations. `PublishImage` publishes a previously built and scanned
image. `RegisterUnused121` registers an API/worker pair from the current live121
definitions. Neither operation launches tasks, contacts PostgreSQL, runs
migrations, updates services, changes desired counts or scaling, or activates a
capability. ECS registers these **unused** revisions as ACTIVE; they are not
serving revisions.

The offline Plan operations do not run AWS, Docker or GitHub commands. They
verify retained inputs, Git identity and private-path permissions, and write a
fresh private plan. Publication and registration each require their own exact
plan hash, affirmative authorization and at most twenty-minute window. An
approved release criterion, merge or earlier local fixture window is not that
authorization. This document and its examples do not authorize operations.

## Sources and image evidence

Run the adapter from its clean committed checkout. Use a separate clean image
source checkout at the exact full SHA. A serving anchor must be current remote
`main`, have successful push CI, and have identical application inputs to the
reviewed DDC application. The guard compares `src`, package manifests, TypeScript
and Drizzle configuration, Dockerfile, `.dockerignore`, `config`, and `docs/soc2`.
Tooling/document-only commits can therefore produce a new image identity without
claiming that its digest equals the historical DDC image. The source revision
label must equal the new full source SHA.

The compatible fallback is a separate publication input with kind `fallback`.
It must retain the exact C578 source, local image index, config and published
platform identity from
`FALLBACK` in `register-compatible-fallback-inactive.mjs`. It cannot register a
serving121 anchor. Do not rebuild or substitute a different fallback and call it
the retained image.

For a separately authorized local build/scan, reuse the existing legacy helper's
`init` and `scan` operations and the existing Dockerfile build pattern. From the
clean source checkout, `init <full-source-sha>` creates an external evidence
directory. Build with `--label org.opencontainers.image.revision=<full-source-sha>`
and `--iidfile <evidence-directory>/build-image-id.txt`, then run
`scan <evidence-directory> <full-source-sha> <local-tag>`. These steps allocate
local build/scanner resources and are outside this adapter's offline Plan.
Preserve failures and the exact unforced scanner ownership/absence record.
The adapter replays the saved image archive, actual linux/amd64 config/source
label, pinned scanner digest, report hashes/counts, HIGH/CRITICAL zero gate and
matching scanner cleanup. It does not replace that evidence with a Boolean.

Every reference below uses `{ "path": "<absolute-private-file>",
"sha256": "<raw-file-sha256>" }`. Retained inputs and output directories must be
private, ordinary paths outside the source and tool checkouts. Do not copy
task-definition secrets/environment files into Git or operator messages.

## Publication Plan and authorization

The version1 publication input contains:

```json
{
  "schemaVersion": 1,
  "kind": "serving-anchor",
  "source": "<full-main-source-sha>",
  "sourceDirectory": "<absolute-clean-source-directory>",
  "outputDirectory": "<absolute-new-private-directory>",
  "scan": { "path": "<scan-receipt.json>", "sha256": "<hash>" },
  "scanCleanup": { "path": "<independent-unforced-scan-custody.json>", "sha256": "<hash>" },
  "mainCi": { "path": "<main-ci.private.json>", "sha256": "<hash>" },
  "repository": { "path": "<describe-repositories.private.json>", "sha256": "<hash>" },
  "publisherConfiguration": { "path": "<publisher-configuration.json>", "sha256": "<hash>" }
}
```

`mainCi` has `repository="bzinkan/SchoolPilot"`, `branch="main"`, `source` and
the exact `gh run list` push records (`headSha,headBranch,event,status,conclusion,
workflowName`). The latest `CI` must succeed; every latest workflow must be
completed with success, skipped or neutral. Publication and registration also
freshly verify remote main and push CI before mutation. Fallback publication
does not claim main CI or require a `mainCi` record.

`repository` is the actual one-repository AWS describe response for account
`135775632425`, region `us-east-1`, repository `schoolpilot-production-api`.
The currently observed MUTABLE policy and null exclusions are supported and
preserved. `publisherConfiguration` is exactly:

```json
{
  "repository": "bzinkan/SchoolPilot",
  "variable": "IMMUTABLE_RELEASE_IMAGE_ENABLED",
  "enabled": false
}
```

The adapter does not enable the immutable workflow, change tag mutability or
filters, or create infrastructure. `PublishImage` requires an explicitly
reserved **single publisher**: the operator must keep all other publication
processes idle for this window. It freshly checks every GitHub variable page to
confirm that the CI publisher remains disabled/absent. Both full-SHA and
12-character source tags are checked before each mutation and after publication.
A pre-existing compatible image is verified and reused; any conflicting config
or digest blocks publication. No `latest` tag is written. These checks on a
MUTABLE repository are not an atomic compare-and-set lock against an unauthorized
concurrent writer. Do not issue this authorization while another publisher can
run.

```text
node scripts/prepare-release-artifacts.mjs PlanPublication <input-path> <input-hash>
node scripts/prepare-release-artifacts.mjs PublishImage <plan-path> <plan-hash> <authorization-path> <authorization-hash>
```

The authorization JSON has `schemaVersion=1`, `authorized=true`,
`operation="PublishImage"`, `planSha256=<exact-plan-hash>`, `singlePublisher=true`
and a pinned `window` reference. Its window has:

```json
{
  "owner": "release-artifact-preparation",
  "operation": "PublishImage",
  "source": "<full-source-sha>",
  "planSha256": "<exact-plan-hash>",
  "startsAtUtc": "<explicit-start>",
  "expiresAtUtc": "<explicit-end-at-most-20-minutes-later>",
  "singlePublisher": true,
  "servicesMayChange": false,
  "tasksMayLaunch": false,
  "productionDatabaseOperations": 0
}
```

ECR credentials go only through Docker login stdin. The exact local scanned
image is pushed once if needed; the second source tag uses its exact manifest.
The existing `verifyPublishedImage` verifier binds source, scan, archive, registry
manifest, one linux/amd64 platform and config. The resulting
`publication.private.json` pins the plan/authorization and `registry-proof.json`
and records the actual digest. It explicitly records `signed=false`: manually
published scanned images are not signed CI artifacts. The scan directory must
not already contain a `registry-proof.json`; that verifier uses exclusive writes.
Preserve a partial/failed receipt rather than deleting it to rerun the plan.

## Unused121 Plan and registration

Make a new input with the same serving source/scan/mainCI evidence, a fresh
output directory, and pinned `publication`, `api`, `worker`, `liveServices` files.
`publication` is the successful publication receipt. `api` and `worker` are exact
`describe-task-definition --include TAGS` responses for the current live pair.
`liveServices` is the exact two-service describe response. Both services must be
stable and still use those exact definitions.

The render guard requires the canonical121 inventory, tenant GUC, explicit
Usage OFF and new capability issuance OFF, API1024/2048 and worker512/1024,
digest-bound images, and unchanged other runtime configuration. It copies all
supported task fields, sidecars, secret references, tags, commands, logging and
resource settings. Only the primary image and its existing `GIT_SHA` change.
The plan records the actual published digest and both generated request hashes.

```text
node scripts/prepare-release-artifacts.mjs PlanUnused121 <input-path> <input-hash>
node scripts/prepare-release-artifacts.mjs RegisterUnused121 <plan-path> <plan-hash> <authorization-path> <authorization-hash>
```

Use a separate authorization/window with operation `RegisterUnused121`, its own
plan SHA and the same owner/source/duration/no-service/no-task/no-SQL fields.
The adapter freshly verifies source/mainCI, exact registry/platform/config and
both source tags, live services and original definitions. Each returned raw
response and ARN is persisted before semantic validation or a further command.
Returned definitions are read back and compared to the exact requests; current
services are rechecked and must not reference either unused ARN.

Pass the successful pair's exact ARNs and retained describe responses, together
with its source/image scan and registry evidence, to the existing `PlanAnchor128`
path. That separate tool only expands the unused admission bundles
121→125→126→127→128. Matching compatible129 fallback preparation remains separate
and must precede its adoption. None of these receipts authorizes a serving
deployment or the retired rehearsal flags or paused capacity executor.

## Exact image consumption and failed operations

After a separate reviewed deployment authorization, the current ordinary
backend path can consume the published main image with
`--immutable-image-sha <full-sha> --immutable-image-digest <actual-digest>`.
It requires clean main equal to origin/main, green main push CI and exact full
SHA tag resolution to that digest. It rejects `--tag`, same-image and rehearsal
reuse combinations. The existing default legacy path rebuilds and republishes
the short tag, so it does not promise consumption of the prepared bytes.
The existing resolver does not require the GitHub publisher variable or verify
a signature; its "signed CI" status wording must not be used as proof of a
manual image signature. All other deployment/admission guards and approved
operations remain independently required.

The adapter performs no automatic retry, deregistration, image deletion or
rollback. A transport timeout can leave a publication or registration outcome
uncertain. Partial receipts preserve the last attempted tag/role and every
returned ARN; read-only reconciliation and a new separately authorized plan are
required. Retain all prior receipts, including failures, and never describe an
uncertain result or unused anchor as a successful rollout.
