# Usage Reports monitoring tools

`scripts/operations/usage-reports-monitoring.psm1` is the versioned replacement
for the ad hoc capture and evidence-reading helpers used during the October 26
attended observation. It neither starts a schedule nor changes production flags,
scaling, alarm thresholds, credentials, or the guarded shutdown procedure.
Historical scripts, receipts and failed captures remain immutable.

## Before a new attended run

Review the module and its dependency `scripts/private-permissions.ps1`, record
their actual SHA-256/byte bindings, and run:

```powershell
pwsh -NoProfile -File tests/usage-reports-monitoring.test.ps1
Import-Module ./scripts/operations/usage-reports-monitoring.psm1
```

Keep the original operating recipe's source, query, helper, native transport and
binary preflight pins. This module is a capture/interpretation building block,
not a replacement for caller, identity, service/task/image, RLS, scaling/schedule,
budget, Plan/Apply freshness, lease or recovery guards. A new source revision
requires a new independent review and binding; never retarget a historical
invocation. The public capture API admits only the five reviewed read-only
reader source hashes, including the bounded two-hour worker reader. It cannot
run a Plan, Apply, credential process, raw STS read or arbitrary AWS operation.
The existing native helper's closed operation whitelist is unchanged.

Use a private evidence directory **outside the repository**, prepared with the
existing permission helper before writing. Pass the reviewed reader and
PowerShell file bindings to `Invoke-UsageMonitoringReader`, with a fresh unique
label and the unchanged 60-second default bound. It invokes the original reader
once, returns a native **binding**, and never automatically retries. Reconcile
an inconclusive attempt, then explicitly choose a new label for any authorized
read-only recheck. Never repeat a mutation after an uncertain outcome.

## Capture and validation rules

- Ordinary source files, executables and live automation TOML use
  `Get-UsageMonitoringFileBinding` without `-Private`: hash, byte length and
  non-reparse checks. Reading an ordinary file never changes its permissions.
  Private evidence uses the explicit `-Private` path policy.
- Capture claims a label with `CreateNew`, sets private permissions before any
  body bytes, drains the original child's stdout/stderr after reaping it, closes
  streams, and only then hashes/finalizes the receipt. Timeouts terminate the
  owned process tree. Reap and pipe waits remain bounded. A timeout, nonzero
  exit, incomplete pipe or uncertain capture is **not success** even if its
  partial stdout is valid JSON. Later process absence does not amend that result.
  If a pipe copy cannot settle even after bounded cancellation, its raw reference
  is explicitly `finalized: false`, without a transient hash or byte-length claim.
- `Read-UsageMonitoringCapture` validates native status **before opening stdout**.
  It requires exit 0, no timeout, full pipes, reaped original child and actually
  empty stderr. An empty page with a continuation token remains incomplete.
  Failed stdout remains private diagnostic material and is never used as health.
- `Read-UsageMonitoringJson` always returns an object as a hashtable with
  `-DateKind String`. `Assert-UsageMonitoringReview` supports the explicit
  numeric-count and findings-array schemas, refuses null/string/boolean counts,
  and does not confuse numeric zero with a one-item array. Keep full request,
  result, full configuration copy and same-ID binding receipts when changing a
  monitor; a prepared update is not an executed update.

## Interpreting returned telemetry

`Merge-UsageMonitoringMetrics` orders actual snapshots by capture start, keeps
one fresh value for each metric/UTC epoch, and returns real revisions separately.
Never add overlapping windows. Empty sparse target-5xx values have count 0 and
sum **null**, not measured zero. The helper does not invent a lag threshold or
convert a missing point into an application failure.

`Get-UsageMonitoringProcessSummary` deduplicates EventIDs only when the **whole
record** matches. It requires the nine real counter fields, including
`studentChatFanOutMissed`/`studentChatFanOutDelivered`; wrong aliases are not zero.
It preserves exact partial-interval endpoints and per-stream counts. Do not force
four streams times twenty full intervals across a normal scale-in. Independently
read the actual current/retiring service boundaries, then identify which streams
belong to each. A partial summary or ECS stop/drain event is not a process-EOS
guarantee. Zero counters or scope expiry are not proof of historical recovery.
Local delivery operations and socket writes are not unique students, messages,
end-to-end ACKs or confirmed simultaneous multi-student monitoring loss.

These helpers do not evaluate or broaden the shutdown predicates. Keep the
existing rolling target-5xx, pool-failure/stall, genuine worker-failure and
confirmed multi-student-loss definitions, existing latency alarms, and original
guarded both-OFF Plan/Apply path. Missing telemetry/authentication/coverage or
session expiry alone must not switch either feature off.

Investigate reader timeouts using the failed native receipt and subsequent
fresh bounded reads. The historical timeouts' causes remain unknown; this
hardening does not claim that an AWS API delay was an application incident or
that its original failed capture later succeeded. Record actual dispatch spacing
and unverified coverage explicitly; scheduling is never authentication,
execution, continuous coverage, or an always-on guarantee.
