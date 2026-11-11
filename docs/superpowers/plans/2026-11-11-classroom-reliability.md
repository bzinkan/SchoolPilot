# Focus, Flight Path, and WebSocket reliability implementation plan

User-approved specification, November 11, 2026. Subsequent explicit instructions:
verify CI, merge, deploy, remove only task branches, prepare ClassPilot **3.0.6**
in `C:\GitHub\ClassPilot\dist`, preserve the 3.0.5 archive. No paid AWS load tests
or additional AWS infrastructure. Preserve screenshot quality/cadence and
existing features. Store upload and managed-device adoption are separate.

## Focus

- Share strict 64-entry/64-character capability parsing across realtime writes,
  cache decoding and public projections; reject malformed/oversize fields,
  retain valid explicit accepted-empty evidence, never truncate into a flag.
- Keep raw advertisements separate from negotiated authorization and preserve
  smaller purpose-specific endpoint limits. Test the actual 43-entry 3.0.5 list.
- Disabled padlock hit areas cannot open previews, select students or issue
  commands. Preserve native disabled semantics and visible/accessibly described
  unavailable reasons. Enabled mouse/keyboard actions execute once.
- Card opens preview; checkbox selects. Add selection instructions/counts and
  correct misleading all-shown copy. Canonical screen-only unlock preserves all
  independent controls. Distinguish accepted pending cleanup from not queued;
  refusal says "Stop Focus was not queued; retry when the browser reconnects."

## Flight Path and Classroom

- Retain every allowed work tab without URL changes/reloads, including above
  the tab limit. Keep allowed foreground; otherwise activate existing allowed
  work. Remove disallowed tabs before considering a landing page; no duplicates.
- Re-read tab URL/identity and current policy immediately before update/remove.
- Internal preserve-existing mode covers apply/sync/reconnect/restore/retries.
  Enforce-existing is only for explicit teacher limit actions or verified actual
  administrator limit changes. Same-value/initial settings restore preserves.
- Reject only a newly created excess tab, protect bounded SSO popups, and fence
  delayed created events for tabs retained during reconciliation. No durable
  browsing/grandfather registry.
- Exactly normalized classroom.google.com website entries add docs.google.com,
  drive.google.com, sheets.google.com, slides.google.com, forms.google.com and
  forms.gle. Other files in those apps are allowed; all Google/unrelated sites
  are not. Redirect destinations still obey policy. Preserve block/SSO priority.
- Preserve stored selections and precise resource scope. One server helper
  projects effective domains at next manual/automatic application. Add read/
  preview effectiveAllowedDomains; retain allowedDomains wire shape and active
  snapshot revisions. Clearly disclose app-wide access in teacher UI.

## WebSocket recovery

- Typed closed/superseded cancellation unwinds the authority transaction and
  preserves rollback, including prepared Focus retirement. Catch only that
  exact cancellation after unwind; SQL/commit/serialization/send errors alert.
- Capture immutable connection/auth epoch/exact binding and negotiated caps;
  fence admission, queued execution, preparation awaits and final locked send.
- Coalesce one queued/running recovery per connection/epoch before the serial
  frame queue. Token-owned cleanup cannot clear a replacement epoch's state.
- Reuse current fresh-auth/heartbeat recovery and existing backoff/cadence;
  never reroute prepared old state or add retry amplification.
- Bounded aggregate cancellation/coalescing/completion/failure diagnostics;
  server delivery is not browser application evidence. Retain genuine alarms.

## Gates and release

RED-to-GREEN behavior tests, real disposable local database rollback/cache
integration, native mouse/keyboard/browser work-preservation and race tests,
source/compatibility/exact-ZIP gates, independent whole-change review and green
required CI. Deploy compatible backend then dashboard while retaining existing
capacity/settings. Package reviewed/tagged 3.0.6, record SHA/source and gate
evidence, preserve 3.0.5, verify actual installed version for managed acceptance.
Check ordinary production service health, latency, recovery and preview freshness;
fewer alerts alone do not establish recovery. Clean only this task's branches.
