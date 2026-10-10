# Current release record

The [current-release index](current-release.json) records the dated matched B5/A3 deployment, exact artifact identities, original acceptance, later source observations and remaining activation/adoption work. The [deployment completion](matched-deployment-completion-20261010-b5.json) and independently authored review retain the operation receipts' exact private hashes. The [operator handoff](../../RELEASE_297_OPERATOR_HANDOFF.md) provides the concise operational context.

The dated completed runtime B5 was `e22c790aee125a5312c0b4ec37ea594ff56ed999`, with the exact tested A3 application and frontend. Later observed remote main `96f136e6953c60b8ca2effeea88f0cbdef5e91c7` contains separate backend/frontend changes. A subsequent production observation recorded API 186 / worker 202 at that source; current frontend identity and release acceptance remain unknown. See the [separate production observation](latest-production-observation-20261010.json). Dated B5 CI/equivalence and A3 acceptance do not establish validation of that later source. Its future applicability remains pending, including review of the temporary_room rollback floor before any future F3 reuse.

Historical records are immutable. The [predeployment index](history/current-release-e22c790a-predeployment-20261010.json), whole earlier handoff/README/packet/checklist and their hashes retain at-the-time next actions. Earlier C578/F1 scan failures, F2 audit failure, startup failures and headroom failure keep their actual outcomes. Current annotations link later corrections without rewriting those records.

Each gitBlobSha256 identifies canonical UTF-8 Git text with LF line endings. It does not replace raw artifact, archive, scan, native-receipt or private-capture hashes. Public metadata contains source, artifact and aggregate outcomes only; identifiers, credentials, environments and raw provider responses remain private.

Generate and check the operator checklist offline:

```text
node scripts/release297-current-state.mjs
node scripts/release297-current-state.mjs --check
node --test tests/release297-current-state.test.mjs tests/release297-build-security-state.test.mjs tests/release297-operational-state.test.mjs tests/release297-deployment-reconciliation.test.mjs
```

The checker verifies retained content, source identities, evidence applicability and the generated section. It performs no provider calls and grants no operational authority. Passing documentation tests is separate from candidate acceptance and deployed-runtime verification. Unknown facts remain unknown; managed-device validation remains waived_not_passed, and page adoption and sample-bearing live acceptance remain pending.
