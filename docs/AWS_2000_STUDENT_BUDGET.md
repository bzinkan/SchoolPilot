# ClassPilot 2,000-online-student cost target

The operator's normal AWS baseline is approximately **$233/month**. The target
is **under $300/month before credits**, while retaining current features,
performance, reporting, retention, capture cadence and image quality. October's
account-wide $415.59 includes unusual resource-hours and is not the baseline.

## Implementation and release boundary

The coordinated implementation introduces negotiated device WebSocket telemetry,
cross-transport heartbeat idempotency, scoped exact-image references and smaller
Redis coordination commands. It preserves HTTP compatibility and recovery.
Both new capabilities default off. It does not itself change the serving fleet,
enroll a CDN plan, release an extension, shrink resources or establish capacity.

SchoolPilot implementation is based on main `71c0352e`; the extension is based
on main `c0a21a4` (source prepares 3.0.4). Those source observations do not establish
the currently published extension, an uploaded ZIP or managed-device adoption.
Recheck all release identities before a coordinated production rollout.

No paid AWS/Linux capacity environment is used. Normal local Windows checks,
the existing local database/Redis fixtures and real Chrome are used instead.

The new WebSocket shared-IP limiter permits 300,000 operations per five minutes
while retaining current per-device limits, admission and frame bounds. The live
HTTP WAF limit is still 100,000. Before a 2,000-device rollout, separately review
and apply `infra/production-2000-telemetry.tfvars` with the normal production
profile so full HTTP recovery also admits 180,000 legitimate operations plus
navigation/recovery headroom. The observed `production.tfvars` stays unchanged
until the apply is verified; no Terraform apply is part of this implementation.

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
schema declares a primary key plus nine secondary heartbeat indexes. The new
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
actual full-image size and references/(full uploads+references) for the observed
reuse rate. These logs contain no image IDs, hashes or student labels and do not
create additional CloudWatch custom metric streams.
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

## Rate sources

- [CloudFront PAYG](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)
- [CloudFront flat-rate plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)
- [CloudFront function error-response restrictions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html)
- [CloudFront WebSocket billing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/billing-and-usage-interpreting.html)
- [WAF pricing](https://aws.amazon.com/waf/pricing/)
- [ALB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)
- [ElastiCache transfer pricing](https://aws.amazon.com/elasticache/pricing/)
