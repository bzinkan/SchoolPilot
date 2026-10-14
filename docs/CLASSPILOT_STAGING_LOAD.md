# Staging reliability campaigns

Use only the isolated stack in [staging operations](./CLASSPILOT_STAGING_OPERATIONS.md).
These are preparation commands, not completed capacity evidence. The API image
must contain the frozen candidate CLI; fixture and browser scripts run outside
that image. No production data, credentials or extension upload is involved.

## Fresh operator and governed fixtures

Run `node dist/cli/bootstrapClasspilotStagingOperator.js` once in a controlled
staging ECS task using the restricted, non-owner application role after schema,
ledger, RLS and grants are verified. It creates only
`operator@classpilot-staging.invalid`. Required process environment:

- `APP_ENV=staging`, `PUBLIC_BASE_URL=https://staging.school-pilot.net`,
  `RLS_GUC_ENABLED=true`.
- `CLP_STAGING_DATABASE_HOST` is the exact newly created
  `schoolpilot-staging-db.*.rds.amazonaws.com` endpoint;
  `CLP_STAGING_DATABASE_NAME=schoolpilot_staging`.
- `DATABASE_URL` uses that exact host/database, port5432 and exactly one query
  parameter, `sslmode=verify-full`. The CLI constructs explicit pg options so
  the verified bundled CA is retained.
- `CLP_STAGING_BOOTSTRAP_ACK=FRESH_ISOLATED_STAGING_NO_CUSTOMER_DATA`.
- `CLP_SUPER_ADMIN_EMAIL=operator@classpilot-staging.invalid` and a fresh
  `CLP_SUPER_ADMIN_PASSWORD` of24..128 characters from staging-only protected
  secret custody. Never place a password in command arguments or logs.
- External email, billing, AI, Telegram and OAuth provider secrets are absent.

The CLI refuses existing schools, unrelated users, owner roles, superusers,
RLS-bypass roles, production RDS instance names, unverified TLS and connection
query overrides. A rerun accepts only the same exact bootstrap identity and
password before any schools exist; it never resets credentials.

For each campaign create a fresh fixture ID and external protected directory.
The following commands assume the three passwords are already in the current
process through protected custody; they do not retrieve or print secrets:

```powershell
$primaryDevices = 40 # then500, then800 in separate fresh fixture directories
$fixtureRoot = Join-Path $env:LOCALAPPDATA ('SchoolPilot\load-gates\stage-' + $primaryDevices + '-' + [guid]::NewGuid().ToString('N'))
node scripts/load/create-classpilot-staging-fixture-config.mjs --devices $primaryDevices --output $fixtureRoot
$configPath = Join-Path $fixtureRoot 'fixture-config.json'
$fixtureConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$env:APP_ENV = 'staging'
$env:LOAD_SESSION_COOKIE_NAME = 'schoolpilot.staging.sid'
$env:CLP_SUPER_ADMIN_EMAIL = 'operator@classpilot-staging.invalid'
$env:CLP_STAGING_NO_EMAIL_CONFIRMED = $fixtureConfig.fixtureId
node scripts/load/prepare-classpilot-load-test.mjs provision --config $configPath --output $fixtureRoot --dry-run
node scripts/load/prepare-classpilot-load-test.mjs provision --config $configPath --output $fixtureRoot
node scripts/load/prepare-classpilot-load-test.mjs verify --config $configPath --output $fixtureRoot
```

The no-email acknowledgement means staging has no email transport and uses only
reserved `.invalid` synthetic addresses. It does not claim mailbox receipt.
Normal fixture profiles still require actual mailbox/alias receipt. All schools
retain the literal synthetic, non-billable marker and tool ownership ledger.
The preparer uses normal authenticated administrative, roster, enrollment and
teaching-session APIs; direct DB school/student/device seeding is unnecessary.

Fresh generated school domains include the fixture ID under
`classpilot-staging.invalid`; the exact staging operator remains
`operator@classpilot-staging.invalid`. Shared-domain canary creation acknowledges
only the sole undeleted, active primary school with the exact ID, name and domain
in that fixture's private tool-ownership checkpoint and current non-billable
proof. An extra sibling, replacement or unrelated fixture refuses creation.
Ordinary mailbox profiles retain their existing confirmation rules.

The governed source fixture retains20 teachers,20 classes,1,000 synthetic
students and10 foreign-school canaries plus authorization-plan controls. For
500, each official class roster has exactly25 students; other profiles retain40.
Only the selected50/510/810 devices emit campaign traffic. Spare registered
synthetic devices remain idle. Separate fixture IDs prevent one campaign's
recent online devices from contaminating the next campaign's command scope.

Enable staging protocol flags for scoped authority, screenshot observation,
tracking-window leases, active observation cadence and read-only observation.
Enable scheduled-classroom capability/mode for candidate classroom UI. Record
the exact staging task revisions/flags; no production rollout map is reused.
The isolated stack contains only tool-owned synthetic schools, so its flags
may cover that whole isolated namespace. Before admitting other schools, bind
capabilities to exact reviewed IDs in `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON`.
Refresh and verify again after any configuration change or long preparation.

## Exact cohort and immutable duration

```powershell
$campaignRoot = Join-Path $env:LOCALAPPDATA ('SchoolPilot\load-gates\run-' + [guid]::NewGuid().ToString('N'))
node scripts/load/select-classpilot-reliability-cohort.mjs --config $configPath --source $fixtureRoot --output $campaignRoot --devices $primaryDevices
$env:LOAD_BASE_URL = 'https://staging.school-pilot.net'
$env:LOAD_RELIABILITY_STAGING_ORIGIN = $env:LOAD_BASE_URL
$env:LOAD_DEVICE_MANIFEST = Join-Path $campaignRoot 'load-devices.private.json'
$env:LOAD_TEACHER_AUTH_FILE = Join-Path $campaignRoot 'load-auth.private.json'
$env:LOAD_COMMAND_BODIES_FILE = Join-Path $campaignRoot 'load-command-bodies.private.json'
$env:LOAD_RUN_ID = 'staging-' + $primaryDevices + '-' + [guid]::NewGuid().ToString('N')
$env:LOAD_STAGE = 'reliability-' + $primaryDevices
$env:LOAD_EXTERNAL_PROGRESS_PATH = Join-Path $campaignRoot 'fleet-progress.jsonl'
$env:LOAD_EXTERNAL_SUMMARY_PATH = Join-Path $campaignRoot 'fleet-summary.json'
# Prepare the shared-start manifest below before the staging fleet preflight.
```

The selector requires verification within15 minutes, full valid state/auth
contracts, exact device bindings, original safe command URL/shape and a fresh
output directory. It never changes source artifacts. It selects1×40,
20×25 or20×40 independently authenticated teacher cohorts plus10 leading
foreign canaries. All credentials must outlive the entire selected duration.

The remote generator runs the matching fleet profile for600/1,800/5,400
seconds, respectively. Its preflight and execution use the exact prepared
manifest and shared future start; do not launch an unbound staging workload.

For remote execution, use the separate generator custody/runner described in
staging operations. It must download exact private input keys, record source
hashes and preserve these same fixed profile values. Never use loopback smoke
or test-time acceleration for staging capacity. The initial burst submits every
selected class command concurrently; later traffic retains the documented
cadence. The `classpilot-reliability-v2` identity requires independent high
entropy legal JPEG comment payloads for every device. Each decoded JPEG is
exactly40KiB; only the96-byte capture-stamp tail is predictable. The generator
caches decoded buffers once per device (33,177,600bytes for810devices), then
reuses those buffers with the existing unique capture stamp. No target IDs or
actual screen contents enter the payload or aggregate fixture evidence.

Preflight and final summaries retain bounded creation/capture CPU and memory
observations, cache cardinality, and40-device JSON/gzip/Brotli byte totals.
Both compressed cohorts must retain at least95% of decoded JPEG bytes; base64
overhead may compress. Shared payloads or old repeated-character padding fail
this check. The native browser gate verifies distinct decoded/stamped frames
and actual encoded response sizes for both codecs. Earlier low entropy v1
passes remain diagnostic and cannot establish v2 screenshot wire capacity.

The synthetic JPEG decodes to one pixel. These campaigns measure transport,
authority, recovery and dashboard source updates; they do not measure Chromebook
capture encoding or the decode/compositing cost of real screen thumbnails.
The managed-device classroom pilot must supply that evidence.

## Remote generator custody and identity

Build `scripts/load/Dockerfile.remote-generator` from the repository root with
`CANDIDATE_API_IMAGE` set to the verified staging API pull digest. The derived
image contains exactly the twelve executed fleet/generator scripts and no private
inputs. Its image manifest binds that API image and the SHA-256 of every script.
Use a single-platform immutable ECR pull digest for the generator task and record
the reviewed tooling commit separately from the API commit.

Before downloading inputs, run the same task with command
`["--preflight-metadata"]`. This verifies the installed script manifest, exact
staging cluster/family/image, Fargate launch type,2vCPU/4GiB allocation and live
resource statistics. It emits no fixture values and makes no S3 or application
requests. Compare the receipt's manifest digest with the registered task image
and `describe-tasks` digest. The [ECS metadata contract](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-response.html)
defines `ImageID` as the pullable image manifest digest; do not substitute the
image configuration digest or accept an unverified tag.

The fleet task keeps its root filesystem read-only and mounts a writable,
ephemeral `/tmp` volume. The derived Dockerfile declares that volume with mode
1777 so the non-root `node` user can create private mode0700 scratch directories.
A native temp-file write/delete preflight must pass on the exact image and task
mount before loading any private inputs. A metadata-only preflight does not
establish scratch writability.

For each freshly selected cohort, prepare a new protected input directory:

```powershell
$startAt = [DateTime]::UtcNow.AddMinutes(4).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
node scripts/load/prepare-classpilot-remote-inputs.mjs --source $campaignRoot --output $remoteInputRoot --account $accountId --campaign $campaignId --run-id $remoteRunId --devices $primaryDevices --candidate-image $candidateApiImage --script-sha $generatorScriptSha256 --generator-digest $generatorImageDigest --start-at $startAt
```

The source must remain under the protected load-gates root and the output must
not exist. Upload only `manifest.json`, `devices.json`, `auth.json` and
`commands.json` to
`schoolpilot-staging-load-<account>/runs/<campaign>/<run>/inputs/`. The returned
receipt contains checksums and prefixes, not credentials. Launch within15
minutes of preparing this manifest. Keep all input values out of task-definition
environment, command arguments, images and logs.

Bind these non-secret task environment values exactly:

- `AWS_REGION=us-east-1`, `CLP_GENERATOR_ACCOUNT_ID`, `CLP_GENERATOR_BUCKET`.
- `CLP_GENERATOR_CAMPAIGN`, `CLP_GENERATOR_RUN_ID` (`40|500|800-<freshhex>`),
  `CLP_GENERATOR_DEVICES`, `CLP_GENERATOR_ORIGIN=https://staging.school-pilot.net`.
- `CLP_GENERATOR_INPUT_SHA256`, `CLP_GENERATOR_SCRIPT_SHA256`,
  `CLP_GENERATOR_IMAGE_DIGEST`, `CLP_GENERATOR_CANDIDATE_IMAGE`.
- `CLP_GENERATOR_START_AT`, matching the manifest's canonical UTC `startAt`.

The generator uses only the campaign artifact task role. It rejects app/provider
credentials and static AWS credentials, verifies each downloaded file's exact
bytes, executes the full harness preflight, and strips inherited load overrides,
proxy settings and test acceleration. Input headers/body reads and result
uploads have deadlines. Result upload failure terminates the fleet process
group. Completed evidence requires the exact full profile duration, enforced
passing thresholds and finalized progress; a zero subprocess exit alone cannot
establish success. Only bounded aggregate `ready.json`, `progress.jsonl`, `summary.json` and
`generator.json` leave the task through the campaign's `results/` prefix.

Choose one common `startAt` within five minutes, in the exact form
`YYYY-MM-DDTHH:mm:ss.sssZ`, before preparing the remote input manifest. Launch
the fleet and rendered browser preparations promptly. The fleet completes its
artifact preflight and the browser authenticates, verifies exact rosters and
subscribes before that time. Require both the remote `ready.json` and local
`rendered-ready.json` for the same run/start before allowing the paired campaign
to proceed; stop the peer if either preparation fails. Browser setup reads are
preparation traffic. Timed fleet and browser clocks start at the shared instant
and retain the full600/1,800/5,400-second profiles. Late readiness or missed
start deadlines fail; no process starts a shortened catch-up run. Receipts save
actual start skew, and monotonic clocks prevent wall-clock changes from silently
altering durations. Manifest freshness and credential lifetime include the
pre-start wait and are rechecked at timed start.

## Independent backend observation

Run `scripts/load/observe-classpilot-staging.mjs` against an explicit UTC window
with a protected external JSON config containing version1, accountId, region,
origin, campaign, the exact staging ALB/target-group ARN suffixes, and the single
staging Redis cache-cluster ID. It makes only fixed read operations against the
bound staging services, target group, RDS, Redis, WAF and aggregate application
CloudWatch metrics. It rejects cross-account service/task identities and
incomplete metric pagination. Stopped/OOM task counts include only the selected
campaign window; earlier stopped tasks remain a separate count.

Missing/partial CloudWatch data remains unknown. Zero-activity application/WAF
metrics may be absent and require log or request evidence rather than a claim
of zero errors. The saved one-minute ALB p95 series is operational evidence;
its p95 is not a pooled request p95. Use fleet histograms and summed dashboard
freshness bucket counts for fleet percentiles. This observer never accepts a
release, mutates infrastructure or changes capacity.

The final fleet summary also saves `fineEndpointLatency`: fixed1ms request
latency counts per fixed endpoint class, pooled across every device/teacher
actor, with an explicit bucket for values above the8s deadline. Existing coarse
latency and absolute SLO outputs remain unchanged. Fine histograms appear only
in the final summary, keeping recurring progress uploads bounded. Target IDs,
queries and unknown route names are never labels; unclassified requests retain
only a counter. For finite nearest-rank p95, true p95 lies in
`[max(0, upperMs - 1), upperMs]`; an overflow percentile has no finite upper
bound. Invalid measurements are counted and cannot establish a comparison.

A future fresh pre-repair baseline must use the same workload, capacity,
configuration and valid full execution window. Its20% regression comparison
can pass only when `candidate.p95UpperMs <= 1.20 * reference.p95LowerMs` for
each required endpoint. Overlapping quantization bounds or missing evidence
remain inconclusive. The arithmetic alone does not establish matched workload,
privacy/error gates or release acceptance. No baseline or production capacity
acceptance is inferred from the candidate's fine histograms.

## Native cookie isolation proof

Use the fresh40-device fixture's full auth and selected campaign auth. The
checker consumes one existing teacher session that is absent from the selected
fleet. It refuses500/800 selected auth, requires matching source credentials,
performs no login, and never contacts production. It installs an explicitly
invalid synthetic parent-domain `schoolpilot.sid` in its isolated browser;
actual customer cookies are never read or copied.

```powershell
node scripts/check-classpilot-staging-cookie-isolation.mjs --config $configPath --source-auth (Join-Path $fixtureRoot 'load-auth.private.json') --selected-auth $env:LOAD_TEACHER_AUTH_FILE --output (Join-Path $campaignRoot 'cookie-proof') --consume-unused-fixture-session --dry-run
node scripts/check-classpilot-staging-cookie-isolation.mjs --config $configPath --source-auth (Join-Path $fixtureRoot 'load-auth.private.json') --selected-auth $env:LOAD_TEACHER_AUTH_FILE --output (Join-Path $campaignRoot 'cookie-proof') --consume-unused-fixture-session
```

The real browser checks that the fake production cookie alone is unauthorized,
mixed cookies authenticate the exact unused teacher, the server issues a secure
host-only staging cookie, logout clears only that staging cookie, the synthetic
parent cookie survives, and the consumed session is unauthorized afterward.
The check uses one real frontend document and four real API calls. API JSON
documents have a restrictive content security policy and cannot host the
browser fetch probe. It writes content-free results. The unused source session is intentionally
destroyed; refresh the full source fixture before reusing its verification or
auth artifacts. The active selected teacher session remains untouched.

## Real rendered dashboards

The native instrumentation regression is an explicit frontend browser gate:
`node --test scripts/classpilot-rendered-frame-chrome.test.mjs`. CI runs it
after installing frontend Playwright and Chromium; backend unit discovery does
not require either dependency. Its synthetic20-context check does not establish
staging application capacity.

Start the following helper concurrently with the matching fleet process using
the same selected auth and exact candidate frontend build. On a workstation,
use a dedicated synthetic Chrome process; the remote Node fleet image does not
include a browser. Record generator and browser host/network separately.

```powershell
$browserRoot = Join-Path $campaignRoot 'rendered'
$inputManifestPath = Join-Path $remoteInputRoot 'manifest.json'
$env:LOAD_TEACHER_AUTH_FILE = Join-Path $remoteInputRoot 'auth.json'
node scripts/load/run-classpilot-rendered-dashboards.mjs --config $configPath --auth $env:LOAD_TEACHER_AUTH_FILE --input-manifest $inputManifestPath --output $browserRoot --devices $primaryDevices --frontend-dist schoolpilot-app/dist --dry-run
node scripts/load/run-classpilot-rendered-dashboards.mjs --config $configPath --auth $env:LOAD_TEACHER_AUTH_FILE --input-manifest $inputManifestPath --output $browserRoot --devices $primaryDevices --frontend-dist schoolpilot-app/dist
```

The helper launches1/20/20 real browser contexts with verified visible
documents and candidate asset hashes. It verifies the exact fleet input
manifest/auth bytes and shared future UTC start, prepares authenticated live
subscriptions and exact rosters, then writes `rendered-ready.json` before that
instant. Both actors must be ready at least one second early; stale inputs,
late starts and clock discontinuities fail the gate. Setup traffic precedes
the barrier; the complete600/1,800/5,400-second timed run uses a monotonic clock.
Credentials must outlive the shared start plus that entire duration and margin.
The recorded1920×4320 test viewport is
large enough for the complete40-student grid; every sampled image must be fully
inside the viewport and its clipping ancestors after two animation frames.
Offscreen decoded images cannot count as painted. It uses the actual authenticated UI,
collects exactly owned tiles, verifies current server binding before measuring
the exact painted capture identity. It records native compositor output hashes
without persisting pixels or student identifiers in operational results.
It opens the real Open URL dialogs, then submits every classroom concurrently
within one second. The UI may freeze all exact students explicitly; the Node
fleet's separate burst uses canonical class scope. No device ID is added to
teacher requests. Receipt/completion remains99% within2/5 seconds, measured from
the UI click to the issuing teacher's first observed WebSocket status frame.
Server timestamps and delayed status-poll replies cannot establish that latency.

The passive browser census counts every same-origin API request started in the
timed window, including controls and retry attempts. Fixed counters distinguish
403,429,5xx, other HTTP errors, network failures and eight-second measurement
deadlines. Request-finished events measure complete response bodies. Deadline
observations retain unknown raw transport work and use overflow histogram
buckets; they do not abort or replay application requests. At window end, the
driver records in-flight work and allows at most eight seconds for its evidence
to settle. Tracking overflow or unresolved transport work prevents acceptance.

The browser and fleet share fixed one-millisecond endpoint histograms.
Classroom-state and raised-hands reads require per-dashboard samples and pooled
p95 at most one second. Browser counters include a conservative five-minute
request peak using301 one-second buckets; adding it to the fleet peak provides
a conservative combined-school bound. HTTP status alone cannot attribute WAF
decisions, so actual WAF evidence remains a separate requirement.

Rendered acceptance requires the full duration, sufficient per-class sampling,
at least99% available decoded authorized frames, p95 capture age at most10s,
p99 at most15s, exact roster isolation, visible contexts, matching candidate
assets and no browser runtime errors. Cancellation or missing final evidence
fails the gate. A passing fleet summary alone cannot establish browser paint,
managed Chromebook installation, production capacity or release acceptance.

Export protected receipts/results before staging custody expiry. Deactivate
owned synthetic fixtures through the preparer's documented lifecycle; retain
the ownership ledger and obey its retention hold. Stack teardown belongs to
the reviewed staging-only infrastructure procedure.
