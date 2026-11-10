# Preview freshness and WAF recovery implementation plan

> For agentic workers: execute with bounded delegated file ownership, test-first changes and fresh independent review. The operator has opted out of further design approvals; continue through review, deployment and verification within the authorized scope.

**Goal:** Resolve diagnosable preview-health defects and the WAF drift without feature, performance or security cuts, while preserving honest 2,000-student/$300 acceptance limits.
**Architecture:** Additive fixed-label client diagnostics in existing logs; unchanged pixels and recovery scheduling; full narrowly reviewed Terraform convergence of unused templates plus the device-ingest limit.
**Stack:** Existing React/Vite, Express/TypeScript, Node 22, local Windows Chromium/PostgreSQL/Redis, Terraform/AWS CLI.
**Spec:** ../specs/2026-11-10-preview-freshness-waf-recovery.md

## Global constraints and review focus

- Preserve the spec's capture, feature, authorization, privacy, sizing and schedule boundaries; no paid AWS load tests.
- Keep legacy version-1 client buckets/counters and EMF names/dimensions identical. New qualified diagnostics are optional, bounded, strict and log-only; no identities or new metric streams.
- Online observed/current rows with absent, invalid or old screenshots remain failures in the qualified denominator; idle/current rows qualify. Explicit denial, missing observation, background-only cadence and non-current monitoring are disjoint exclusions.
- Receipt of a notice is not proof that pixels refreshed. Any accounting fix must preserve missing-notice recovery, retry request times/counts, hidden pause and exact authority fences.
- No new Terraform plan inside the school-day restriction under an expanded resource scope. Review a new complete plan after 16:00 ET; never apply or rewrite the held plan.
- Reject serving services, capacity, schedules, network, roles, image, secrets, unrelated environment/rules or output changes. Prove unused template references from fresh complete inventories, not unchecked coverage assertions.

## Tasks and interfaces

1. **Backend optional health diagnostic (root).** Extend `src/services/classpilotClientHealth.ts` and its focused tests. Optional `previewEligibilityV1` contains `version:1`, six bounded `freshnessBuckets`, and fixed `excludedCounts` keys `readDenied`, `notObserved`, `backgroundCadence`, `monitoringNotCurrent`. Preserve old input compatibility and all original metric values, names and dimensions. Write RED schema/identity/bounds/log-only tests, implement the minimum extension, then run focused backend checks.
2. **Frontend qualified sampling (frontend owner).** New `lib/classpilotPreviewHealth.js` and focused test file; integrate with the existing preview-recovery health hook. Consume actual monitoring display, per-row observation and accepted cadence eligibility, never image age for eligibility. Preserve all original bucket/counter values. RED tests pin missing/stale online denominator, idle eligibility, disjoint/conserved exclusions, exact timestamp/binding boundaries and hidden/disabled behavior. Prove the actual hook emits the optional aggregate and leaves the original snapshot unchanged.
3. **Recovery episode accounting (same frontend owner, conditional).** Reproduce notice-before-new-pixels repeated counts in the real watchdog. If a minimal correction keeps HTTP start times/counts and all liveness/authority tests identical, implement and verify one episode until a genuine new timestamp/binding; a later independent stall counts again. Otherwise leave recovery behavior untouched and record why.
4. **WAF review and execution (root, infrastructure owner prepares read-only gates).** Independently review the private gate and adversarial fixtures. After 16:00 ET, take verified backups, create/review a new full saved plan with exactly two unused template replacements and one WAF update, collect fresh reference inventories, and apply only the reviewed plan. Verify unchanged serving source/revisions/capacity/schedules/security and fresh after-apply backups. Adopt 300,000 into canonical production tfvars only after observed apply success.
5. **Integration and release (root).** Run meaningful frontend/native/backend checks, type/build/lint and current-source CI; obtain a fresh whole-branch review. Merge and deploy exact reviewed main from the clean deployment clone; backend before the additive frontend payload. Extension source/runtime is unchanged unless a separate client defect is reproduced. If changed, prepare a distinct versioned ZIP/tag and full packaged gate; no Store publication.
6. **Observation and cleanup (root).** Verify exact running source, targets, alarms, scaling and lease; collect ordinary post-deployment observations using the correct custom-metric interval clocks. Preserve old and qualified denominators separately. Update cost assumptions without claiming fleet acceptance. Delete only this task's merged branches and preserve operator evidence and unrelated work.

## Progress ledger

- Base SchoolPilot 6f2b11dc; ClassPilot main 9afdcb94, release tag source 2705ae7c. New task branch `codex/preview-freshness-waf-20261110`; primary dirty checkouts are preserved.
- Investigation complete: private backend publication/authority proofs, native Dashboard missing-notice proof, and 17 Redis image/cache regressions pass. The first Redis attempt lacked local fixture authentication and failed NOAUTH; corrected authenticated run passed 17/17 with no skips or production traffic.
- Ruling: no speculative backend or extension pixel change; authority mismatches and clock/cache reuse do not justify weakening claims or forcing full images.
- Ruling: new user instruction authorizes resolving the known unused-template drift, but does not require stretching the earlier sole-WAF daytime exception. Prepare now; plan/apply the broader narrow scope after 16:00 ET.
- Private WAF gate/proposal prepared; independent adversarial review pending. No new Terraform plan/apply or credential load in this continuation yet.
- Backend optional diagnostic: four new unit cases failed against the old schema, then all seven passed; strict nested identity/amplification rejection and unchanged legacy EMF were verified. Type check and build passed on Node 22. Native HTTP checks await the final frozen source.
- Ruling: defer the optional episode-counter cleanup. Native A/B preserved one request schedule, but independent review found successful-null and unrelated-cohort rekey lifetime defects. Keep the deployed notice, scheduler and counter byte-identical; ship only additive qualified diagnostics. This avoids changing live recovery for a nonessential aggregate interpretation.
- WAF independent review rejected the first private reviewer for incomplete evidence, no-op unknown and pinned-version false accepts. A new live-inventory producer/reviewer is being tested and must pass fresh independent review before any new plan.
