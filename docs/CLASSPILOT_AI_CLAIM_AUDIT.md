# ClassPilot public claims and provider-boundary audit

Reviewed October 7, 2026 against SchoolPilot source
`56df7a4f390b45a2f97ee435c01381ddede5dc2e`. This is engineering source review and
local synthetic evidence, not a production observation, legal conclusion,
provider-account verification, or approval to deploy or activate features.

## Claim to implementation

| Public claim | Implementation authority | Corrected disclosure |
|---|---|---|
| Classification happens only during a class session | `src/routes/classpilot/devices.ts` heartbeat classification; `src/services/classpilotAfterHoursSafety.ts` and `classpilotMonitoringPolicy.ts` | Authorized monitoring can include configured after-hours safety. No broader collection is enabled by this copy change. |
| Privacy Policy limits monitoring to school hours/assigned classes and describes Live View as available | `classpilotMonitoringPolicy.ts`; `CLAUDE.md` Teacher Dashboard Commands and Screenshot pipeline; `docs/CLASSPILOT_SAFETY_CENTER.md` | School policy governs after-hours modes; current classroom/supervision/administrator-observation authority governs previews. Live View is retired; screenshots are separate. The source review corrects disclosure without changing collection. |
| Educational, non-educational, and unsafe are one category list | `AiClassification` and Gemini response schema in `src/services/aiClassification.ts` | Educational/non-educational/unknown are separate from safety concerns. Unknown includes unavailable classification. Neither category nor alert confirms learning or harm. |
| An unsafe classification immediately closes the tab; known unsafe domains instantly block | `resolveImmediateUrlClassification` in `aiClassification.ts`; `src/services/safetyCenter.ts`; `src/services/safetyNotifications.ts`; `docs/CLASSPILOT_SAFETY_CENTER.md` | Detection feeds administrator review/notification. Classification does not issue closure commands or add website blocks; explicit restrictions remain separate. Alert suppression, deduplication and delivery mean immediate notification is not promised. |
| Teacher intent always overrides classification | `src/services/classpilotTeacherIntent.ts`; `docs/CLASSPILOT_SAFETY_CENTER.md`; `CLAUDE.md` AI classification contract | Teacher intent affects off-task categorization; safety approvals and explicit school restrictions remain independent. |
| URL/title-only means no student or personal information leaves | `classifyUrlWithGemini` in `src/services/aiClassification.ts` | The request adds no roster identity fields, screenshots, page bodies or full history. Original URL/title strings can contain identity, search terms, credentials or tokens. Those values may reach the provider. |
| A hashed cache or local deletion proves provider-side minimization/deletion | `classifyUrl` page fingerprint/cache; provider account evidence remains private | Hashing the cache key does not redact the model request. Local deletion does not delete provider-held copies. No zero-retention or provider training/deletion guarantee is inferred. |

The changed surfaces are AI Transparency, Subprocessors and Privacy Policy.
Existing MailPilot/assistant disclosures and the paused My Desk status remain.
This review does not certify other AI flows or alter contractual policy promises.

## Bounded synthetic audit

Run without an application `.env` or live credentials:

```sh
node --import tsx --test --test-concurrency=1 tests/classpilot-provider-boundary-audit.test.ts
```

The test replaces `fetch` before importing the real classifier and supplies a fake
Gemini key. All hosts, identities, values and responses are synthetic. No provider,
production system or real student data is used. It observes the outgoing request
at the model boundary, not just a hash or upstream helper.

| Case | Current source behavior / expected characterization |
|---|---|
| Email query value | Original encoded email-bearing URL reaches the mocked provider body. |
| Query access token | Synthetic token is retained in the mocked provider body. |
| URL username/password | Synthetic userinfo is retained in the mocked provider body. |
| Fragment access token | Synthetic fragment is retained in the mocked provider body. |
| Search terms | Original synthetic query is retained on a host requiring model fallback. Reviewed known search rules can bypass the model. |
| Identity/token in title | Synthetic title is retained in the mocked provider body. |
| Repeated identical request | Cache avoids a second call; the first call still disclosed the original strings. |
| Known educational/school site or disabled fallback | No model request in these tested branches. |
| Provider HTTP error | Request has already been issued; classifier returns unknown, does not read the response body, and makes no console call in the tested path. |
| Transport exception | Classifier returns unknown and makes no console call with the thrown message in the tested path. |

Passing these characterization tests establishes the findings, **not successful
minimization**. The test expectations must be revised when a separately reviewed
remediation changes the provider boundary. They do not establish that a real
student token or identity was sent in production, or that every logging path is safe.

Local result on October 7: all nine audit cases, eight existing Gemini
classification cases, six AI/privacy-evidence cases and nine governance-evidence
cases passed, with zero skipped tests. `soc2:check` and `soc2:ai-privacy-evidence`
completed; their existing open-evidence and pending-human-review warnings remain.
Generated packets stay in ignored `soc2-evidence/`, not in this document.

## Existing controls and remaining decisions

The classifier sends fixed instructions plus one URL/title pair. Reviewed domain,
school-domain and search rules may avoid the model. Exact model results use a
SHA-256 URL/title fingerprint, school-domain/model/ruleset context, a 30-minute
cache lifetime and a shared 5,000-entry cache bound; matching in-flight requests
coalesce. These are reuse and capacity controls, not anonymization. Provider
exceptions emit fixed-name counters/timings without their message in this helper.
SchoolPilot heartbeat and safety-record retention remains governed by the existing
school retention/cleanup contracts; provider retention is a separate question.

**Finding CP-AI-001 — remediation pending:** the current model-request boundary
does not remove synthetic URL userinfo, token-bearing query/fragment fields,
email/search values or sensitive titles. Engineering and the Security & Privacy
Officer must review a narrow minimization policy and its classification tradeoffs.
Do not resolve this finding by relabeling input anonymous, changing precise-resource
matching, stripping all query parameters, or treating a failed provider call as
proof no data left. A follow-up should redact confirmed credentials at the model
request boundary, preserve deliberately required classification semantics, and
return classification unavailable when safe meaning cannot be retained. It needs
separate synthetic semantic/error/cache tests and review before deployment.

Account tier, region/routing, provider retention/deletion, training-use terms,
logging/access settings and applicable agreements require private provider/account
verification. Source and these mocks cannot prove them. CLAIM-003 remains Needs
remediation; SOC2-002 stays In progress and SP-CONF-002 stays Implementing. No risk
acceptance or regulatory-compliance approval is supplied here.

## Release impact

Public wording changes on a later authorized frontend deployment. Runtime
classification, precise resources, monitoring scopes, flags, API contracts,
schema/RLS, extension and enforcement behavior do not change. A frontend rebuild
is required. Backend executable/build source is unchanged, but `Dockerfile` copies
`docs/soc2`, so the changed governance files are backend image-content inputs;
do not claim an identical rebuilt image or reuse an old digest as the new image.
Image preparation requires its own source/digest evidence; no settings are
activated and no production result is claimed by this slice. Rollback of the frontend is technically independent, but
would restore the inaccurate disclosures; prefer a corrected copy forward change.
