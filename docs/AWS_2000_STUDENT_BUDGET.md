# ClassPilot 2,000-online-student cost target

The operator's normal AWS baseline is approximately **$233/month**. The target
is **under $300/month before credits**, while retaining current features,
performance, reporting, retention, capture cadence and image quality. October's
account-wide $415.59 includes unusual resource-hours and is not the baseline.

## Implementation and release boundary

The coordinated implementation introduces negotiated device WebSocket telemetry,
cross-transport heartbeat idempotency, scoped exact-image references and smaller
Redis coordination commands. It preserves HTTP compatibility and recovery.
All three new capabilities default off. It does not itself change the serving fleet,
enroll a CDN plan, release an extension, shrink resources or establish capacity.

SchoolPilot implementation is based on main `71c0352e`; the extension is based
on main `c0a21a4` (source prepares 3.0.4). Those source observations do not establish
the currently published extension, an uploaded ZIP or managed-device adoption.
Recheck all release identities before a coordinated production rollout.
The second pass integrates SchoolPilot main `6b985954` through `ed32fc78` and
adds bounded origin gzip, lossless changed-image patches, safe completed
classification reuse at INSERT and guarded redundant-index retirement.

No paid AWS/Linux capacity environment is used. Normal local Windows checks,
the existing local database/Redis fixtures and real Chrome are used instead.

The WebSocket shared-IP limiter permits 300,000 operations per five minutes
while retaining current per-device limits, admission and frame bounds. The
separate HTTP WAF device-ingest limit was raised from 100,000 to 300,000 on
November 10 after 16:00 ET, using a reviewed full saved plan. This covers the
modeled 180,000 legitimate operations plus navigation/recovery headroom. The
generic API limit remains 50,000; authentication and all other rules are unchanged.
The two other plan actions reconciled unused Terraform-owned task templates by
adding only the canonical cookie name. Serving revisions, sizes, schedules and
images did not change. Verified encrypted before/after state backups, complete
live reference inventories and a fresh zero-change plan support the observed
300,000 baseline now recorded in `production.tfvars`. This removes a recovery
admission blocker; it does not establish fleet performance or a monthly ceiling.

The earlier 6f2b11dc application release enabled all three efficiency capabilities
globally on the API and worker. The separate ClassPilot 3.0.5 ZIP was prepared in
`dist`; actual Chrome Web Store publication and Chromebook adoption remain
unverified. The following source checkpoints describe implementation history.

## What changes economically

Without transport changes, 2,000 devices online six hours/day for twenty-two
school days generate **95.04 million heartbeat requests/month**. Screenshots
add **31.68 million** at thirty seconds, or **190.08 million** when all students
remain actively observed at five seconds. WebSocket frames do not each create
an edge HTTP request; upgrade requests and HTTP recovery still do.

Exact-image references continue actual captures and encoding at the current
quality/cadence. They avoid repeated pixel transfer and Redis blob rewrites only
when a fresh capture exactly matches the acknowledged image in the same exact
authority. Animated/scrolling pages can save zero bytes. Fresh metadata is still
validated; cache misses recover the full bytes from the same fresh capture.

## Reproduce the model without network access

```powershell
node scripts/cost/classpilot-budget.mjs --json
node scripts/cost/classpilot-budget.mjs --options='{"transport":"websocket","edgePlan":"payg","unchangedFraction":0.5}'
node --test tests/classpilot-budget.test.mjs
```

`estimateClasspilotBudget(options)` is a pure function. It never calls AWS or
reads credentials. Unknown overheads remain explicitly unverified; a modeled
subtotal is not an all-in bill or an AWS performance acceptance result.

The November 9 existing-log observation was approximately **22,342 UTF-8 bytes
per screenshot string** over seven days. It does not include full envelopes or
prove compressed wire size, future image sizes, or an unchanged-image ratio.

Illustrative demanding scenario: 2,000 online and five-second-observed students,
six hours/day, twenty-two days/month; one teacher copy/image; 22,342-byte image
strings; illustrative heartbeat request/response sizes 1/2 KiB; teacher metadata
256 bytes/student/read; one-third of Redis image traffic crossing AZs. These byte
and placement assumptions must be replaced with observations before budgeting.

| Exact-image references | PAYG subtotal | Hypothetical Pro subtotal |
| ---: | ---: | ---: |
| 0% | $680.89 | $340.91 |
| 25% | $554.66 | $318.50 |
| 50% | $428.42 | $296.09 |
| 75% | $302.19 | $273.68 |

At eight hours/day, with the other assumptions unchanged:

| Exact-image references | PAYG subtotal | Hypothetical Pro subtotal |
| ---: | ---: | ---: |
| 0% | $859.19 | $371.88 |
| 25% | $690.88 | $342.00 |
| 50% | $522.57 | $312.12 |
| 75% | $354.26 | $282.23 |

These conservative subtotals add modeled traffic to the $233 baseline without
subtracting its already-included current edge/traffic costs. They **exclude
unverified storage/backup growth, extra compute, monitoring growth and other
overhead**. They are not quotes. The zero-reference and eight-hour cases must
remain in every review; do not report only a favorable workload as success.

## Second-pass screenshot and database savings

The new optional delta path preserves the original JPEG bytes and capture
cadence. On three genuine Chrome worksheet typing captures, the current bounded
encoder produced 2,058/2,315/2,069-byte patches from
26,579/26,640/26,684-byte JPEGs, taking 3.8/5.2/3.9 ms. This is about 91–92%
patch-byte reduction for those fixtures, not an expected school-wide percentage.
Scrolling and noise were unprofitable and use full fallback. Exact references
remain the first choice when a fresh capture is byte-identical.

Origin gzip reduces Base64 JSON overhead independently of delta eligibility.
Compression is bounded and may fall back to identity. It completes before the
existing final authorization checks. CloudFront's cache-disabled API behavior
does not automatically compress origin responses; its normalized
`Accept-Encoding` forwarding permits origin encoding.
See [CloudFront compression behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html).

The pure model now separates `changedDeltaFraction` (among changed captures),
`deltaPatchRatio`, `teacherDeltaHitFraction`, `deltaMetadataBytes` and
`viewerImageWireRatio`. Viewer encoding does not reduce uploads or Redis bytes.
Every changed target is still stored in full; delta uploads additionally read a
full base and store one patch. A teacher whose exact base is missing receives
the full image. Actual cache placement and metadata traffic remain unmeasured.
`retransmitFraction` distinguishes post-send lost-receipt retries from fallback
before a WS send. It adds duplicate request/heartbeat-response bytes and
conservatively budgets an extra full recovery request/cache write for retried
delta/reference images. Other base misses and failed teacher-patch recovery
traffic remain unmeasured overhead. Idempotent rows do not make network retries
free.

The following PAYG sensitivity examples retain the earlier demanding workload,
$233 baseline and illustrative heartbeat/metadata/AZ assumptions. They assume
viewer image wire bytes are 75% of the JSON image strings, patches are 10% plus
256 bytes, and 75% of teacher patch reads have the exact base. These are explicit
scenario inputs, not fleet observations. No CloudFront subscription savings are
counted. These rows assume no HTTP fallback/retransmission; real recovery costs
must be added before treating them as an operating envelope.

| Exact references | Patches among changed captures | Six-hour subtotal | Eight-hour subtotal |
| ---: | ---: | ---: | ---: |
| 0% | 0% | $588.94 | $736.58 |
| 50% | 0% | $382.45 | $461.27 |
| 50% | 50% | $313.35 | $369.14 |
| 75% | 50% | $270.40 | $282.86 |
| 75% | 75% | $263.63 | $273.83 |

The favorable rows show a possible traffic envelope, with little room for
unverified database/compute/storage costs. They do not establish that the real
fleet has enough unchanged or patch-friendly content to stay under $300. The
all-moving case remains above target. Do not substitute the typing fixture's
91–92% saving for fleet eligibility, teacher base hits or an all-in AWS bill.

Database changes retain every heartbeat and current reporting. Valid completed
safety-free educational/unknown classification results can populate the original
INSERT, avoiding a redundant UPDATE, cache patch and broadcast. Unsafe inputs,
stale/model-changed cache entries and results requiring fresh teacher intent keep
their existing processing. Two single-column heartbeat indexes are retired only
after strict catalog attestation of their composite replacements. In an
80,000-row synthetic local fixture, those two indexes occupied 1,466,368 bytes;
this is not a live storage or dollar projection. Current history/report/retention
access paths remained valid. No retention window or history row is removed.

## CloudFront Pro is conditional

AWS currently lists Pro at $15/month with ten million requests and fifty TB
transfer, including certain WAF/DNS/edge-logging charges. It is not selected.
The November 9 read-only review confirmed that the live configuration cannot
subscribe unchanged:

- All five behaviors use legacy `ForwardedValues`, which flat-rate plans exclude.
- All five use a custom response-header policy, which requires Business rather
  than Pro. Its HSTS, framing, content-type, referrer, permissions and CSP report
  protections must survive any migration, including on errors. A viewer-response
  function alone is insufficient: CloudFront does not run it on origin errors
  of 400 or greater.
- The device-ingest WAF classifier uses regex filtering, which Pro excludes.
  Its exact POST/path predicate can be represented by four exact URI alternatives
  in a separately reviewed change without removing its label/rate semantics.

Account paid/active status, one apex domain, five behaviors and the 26-record DNS
zone fit the reviewed prerequisites. Shield Advanced and Firewall Manager did
not control the distribution. Managed WAF rule-group quota interpretation,
subscription-validator acceptance and sustained request allowance remain
unverified. No subscription or infrastructure change was made. Keep
`proCompatibilityConfirmed=false`; do not count this column as achievable with
the unchanged infrastructure. Pro does not include application metrics/alarms
or database/Redis/ALB charges.

At thirty students/class and one teacher batch every five seconds, the model
includes roughly 6.37 million teacher screenshot requests plus socket upgrades,
before history, reconciliation, other API traffic and recovery. The existing
shared screenshot queue enforces a five-second start ceiling per exact cohort
for both targeted notifications and reconciliation; its outer 250 ms event
coalescer does not bypass that ceiling. This remains a scenario rather than a
measured all-endpoint request rate. Image references reduce returned pixels, not
those teacher HTTP requests. Do not accept the request allowance without real
usage evidence. A routine HTTP heartbeat alongside healthy WS telemetry would
also undermine it and is deliberately absent.

The current dashboard also polls active sessions every ten seconds and active
command state every thirty seconds on healthy transport. At 67 simultaneously
visible classrooms for the full six-hour scenario, those two enabled polls add
about 3.18 million and 1.06 million requests. Together with screenshot reads,
that is **10.61 million** before history, raised hands, aggregate reconciliation,
schedule reads, sign-ins and recovery. This is conditional workload arithmetic,
not observed usage, but it already exceeds Pro's ten-million allowance. Further
teacher-request optimization or a different reviewed edge option is required
before treating that full-day workload as compatible with Pro.

If Pro is not compatible, do not count its savings or drop security features.
Actual deduplication/traffic observations may support another reviewed option.
The $233 baseline has not been independently reconciled to a normal full-month
ledger. Partial November billing does not justify subtracting all DNS, S3 or
CloudWatch costs. The model therefore keeps `replacedBaselineEdgeCost=0`.

The November 10 follow-up found no read-only subscription eligibility/dry-run API:
creating a manual-approval subscription still persists a pending subscription.
No subscription was created. A Business plan at the listed $200 price plus the
unreconciled $233 baseline would already be $433 before verified replacement
savings or growth; neither tier supplies established savings for this budget.

The latest local sensitivity run retains the adverse cases: all 2,000 students
actively observed with unique images models approximately $634.12 for six hours
or $797.88 for eight hours. A favorable six-hour case models $270.66 with 50%
exact reuse, 80% patch eligibility among changed captures, 15% patch size, 90%
teacher delta hits, 78% viewer wire size and 1% HTTP recovery. Those are unverified
assumptions, not measured fleet percentages. Unknown storage/backup, compute and
other growth remain excluded. Do not report the favorable subtotal as acceptance.
This follow-up bounds snapshot also leaves unmeasured heartbeat/teacher metadata
bytes and Redis cross-AZ traffic at zero; those unknowns are not verified savings.

## Preview freshness follow-up

Actual native Dashboard checks with genuine captures, missing notices, idle
devices and hidden tabs did not reproduce a new online pixel regression.
Existing Redis reference/delta recaptures retain fresh metadata. The original
aggregate mixes inactive/unobserved rows with current classroom previews and
cannot establish active classroom freshness. The additive `previewEligibilityV1`
diagnostic separates the eligible cohort in existing fixed-size logs, retaining
online missing/stale frames as failures. Legacy buckets, metric streams, counters,
recovery requests/timers, pixels and capture cadence remain unchanged. The event
gap counter is not a count of distinct outages. Real qualified production
observations are still needed; no paid AWS load testing was performed.

## What local evidence establishes

The bounded protocol comparison can be run with:

```powershell
node --import tsx scripts/local/device-telemetry-loopback.mjs --clients=2000 --rounds=2 --json
```

One November 9 Windows run held 2,000 sockets and completed 4,000 HTTP and 4,000
WebSocket operations. HTTP p95 was approximately 27 ms and reused-WebSocket p95
approximately 20 ms. The WS operations generated zero recurring HTTP requests;
there were 2,000 initial upgrades. It completed in approximately six seconds.

This exercises the real telemetry parser/dispatcher and real local HTTP/WS
transports with synthetic bindings. **It does not exercise PostgreSQL, prove
Fargate performance, or establish 2,000-device production capacity.** Normal
database, authority, retry and browser behavior have separate functional tests.
The registered-router integration also uses real local PostgreSQL and the real
authenticated WebSocket server: HTTP-to-WS and WS-to-HTTP recovery persist one
heartbeat each; mismatched replay returns 409, revoked entitlement 403 and
retired session 401. It exits cleanly without a forced process exit. This is a
correctness check with synthetic fixtures, not a capacity test.

## Production observations still required

Transport savings preserve every successful normal heartbeat. At ten seconds,
2,000 devices create 4.32 million rows per six-hour school day or 5.76 million
per eight-hour day. Retention defaults to 720 hours (30 calendar days), and the
prior schema declared a primary key plus nine secondary heartbeat indexes, with
another school/timestamp index in the bootstrap. The guarded second-pass
migration removes only the two proven prefix duplicates. The new
nullable 64-character payload hash adds about 6.08/8.11 GB of raw characters per
22-school-day six/eight-hour workload, without a new index or backfill. These
figures exclude all PostgreSQL tuple/index/WAL overhead and other row fields.
They do not establish whether the current 100 GiB allocation is sufficient.

The existing purge retains its 5,000-row batches and 100 ms inter-batch pauses.
Expiring one normal day's rows entails 864/1,152 batches: roughly 86/115 seconds
of deliberate pauses alone, before SQL, index cleanup and other retention work.
Measure actual table/index sizes, row width, purge duration, autovacuum and WAL/
backup growth. Do not shorten retention, skip history or remove indexes merely
to make the estimate fit the target.

As real schools adopt the reviewed release, observe existing aggregate counters
and normal AWS metrics: actual online/observed student-hours; full-image vs
reference/miss counts and bytes; HTTP recovery rate; command/preview latency;
API CPU/memory; database connections/credits/storage/purge duration; Redis memory/
evictions; ALB and CDN bytes/requests; gross AWS spend before credits.

The $300 goal is not achieved merely because code compiles or a local simulation
passes. Confirm the cost envelope and performance through real usage, without
creating the paid synthetic environment the operator rejected.

The existing `realtime_hot_path_summary` log now includes fixed-size
`screenshotImages` counters: `fullUploads`, `fullUploadBytes`, `referenceUploads`,
`referenceMisses` and `metadataOnlyReads`. Use full bytes/full uploads to estimate
actual full-image size and references/(full uploads+delta uploads+references) for the observed
reuse rate. These logs contain no image IDs, hashes or student labels and do not
create additional CloudWatch custom metric streams.
The second pass adds `deltaUploads`, `deltaUploadBytes`,
`deltaMaterializedBytes`, `deltaBaseReadBytes`, `deltaMisses`, `deltaReads` and
`deltaReadBytes`. Byte counters use Base64/data-URL string bytes, not full wire
envelopes. Compare patch bytes with materialized target bytes without treating
the full target write or base read as saved Redis traffic. Accepted delta
uploads/(full uploads+delta uploads) estimates changed-capture eligibility only
within the admitted cache-write population; it excludes denied/discarded and
failed uploads. Use delta misses and actual edge measurements as well.
These new counters describe accepted image-cache writes and reads. Uploads
discarded before that cache, legacy clients and denied requests are outside
their denominator. Correlate them with existing total upload, discarded upload
and screenshot-payload-byte counters and edge/ALB billing measurements; an
accepted-cache reuse percentage is not an all-traffic savings percentage.

## Local verification record

At SchoolPilot code checkpoint `0f172062` and ClassPilot `659838f`, the new
capabilities remain off. Backend check/build passed with the dependency-junction
`--preserveSymlinks` setting. Node 22 functional proof includes 23 fresh-database
checks for actual registered HTTP/WS recovery, durable retries, screenshot
authority and Office integration; 44 feature/native Redis checks; six health
checks and 25 Windows fixture-tool checks. Frontend lint/build, session lifecycle,
realtime cache, signal loss, command context, tile batching and Radix browser
checks passed. ClassPilot check/build, 209 tests and its full real-Chrome gate
passed, including actual captures and reference/full-image recovery. Independent
reviews found no remaining critical or important issue.

The broad backend run reported 4,521 passed, 122 failed, one cancelled and ten
skipped out of 4,654 tests. All 21 failed files later passed targeted reruns after
normal CI database setup, Node 22 sandbox compatibility, Windows LF/timeout
handling or narrowly reviewed test-fixture repairs. **The original whole-suite
report remains failed; a fresh clean whole-suite run is not claimed.** Detailed
reconciliation and sanitized local logs are in the worktree's Git validation
metadata. Four temporary databases were removed; the existing service was
reused. These checks establish local correctness rather than AWS fleet capacity.

Use [the guarded rollout and rollback runbook](CLASSPILOT_DEVICE_TELEMETRY_ROLLOUT.md)
for any separately reviewed release. No source version or local ZIP establishes
Chrome Web Store publication or managed-device adoption.

Second-pass backend source checkpoint `fb6ea3a3` passed Node 22 check/build with
`--preserveSymlinks`, the unchanged test-type/cast ratchets, 85 focused
screenshot/classification/Redis tests, 94 database unit/contract tests, 13 native
index checks, and 87 fresh-database telemetry/publication/history checks. Both
owned temporary databases were removed. The 1,446 runtime deployment assertions,
registry check and 32+45 Schema 12/13 assertions passed and are included in the
existing CI job. Frontend lint has zero errors and 37 existing warnings; build,
tile batching, realtime cache, signal loss and command-context checks passed.
These are local correctness checks; no new whole-backend-suite or AWS capacity
acceptance is claimed.
The complete teacher decoder was also checked in native Chrome 151 using the
genuine differing JPEG captures: all 30 tiles reconstructed the exact data URLs
over 25 iterations, with warm p50 26.1 ms and p95 27.5 ms for the entire cohort.
This includes Base64 handling and WebCrypto integrity, and describes one local
Windows machine rather than every teacher device or server capacity.
Frontend session lifecycle (5/5) and the Radix browser regression passed.
ClassPilot final source `77c88465e337b5fb922658f714ba76674365b943` passed check,
209 unit tests and build. The broad Chrome rerun passed current-source suites
and all 20 immutable expected-red cases; the final UUID metadata reservation
was additionally covered by 48 focused and packaged tests, genuine packaged
captures/deltas/full/HTTP recovery, and Windows Chrome/Edge parity. One initial
unchanged ACK diagnostic harness capture failed; four isolated reruns and the
complete broad rerun passed without an ACK code workaround. The new package
was not published and no feature flag or production resource was changed.

## Rate sources

- [CloudFront PAYG](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)
- [CloudFront flat-rate plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)
- [Subscription API operations](https://docs.aws.amazon.com/pricingplanmanager/latest/APIReference/API_Operations.html)
- [CreateSubscription approval behavior](https://docs.aws.amazon.com/pricingplanmanager/latest/APIReference/API_CreateSubscription.html)
- [CloudFront function error-response restrictions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html)
- [CloudFront WebSocket billing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/billing-and-usage-interpreting.html)
- [WAF pricing](https://aws.amazon.com/waf/pricing/)
- [ALB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)
- [ElastiCache transfer pricing](https://aws.amazon.com/elasticache/pricing/)
