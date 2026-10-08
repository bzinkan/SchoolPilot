# CP-AI-001: ClassPilot browser request credential boundary

Implementation preparation dated October 8, 2026. The original
[October 7 source/synthetic finding](CLASSPILOT_AI_CLAIM_AUDIT.md) remains an
unchanged historical record. This change addresses browser credentials/tokens
at the ClassPilot Gemini request boundary; it does not establish production
exposure, anonymity, provider-account guarantees or completed AI/privacy review.

The selected policy retains ordinary email addresses and search terms as
classification context. It therefore does not resolve the broader personal-data
minimization question in CLAIM-003 or close SOC2-002/SP-CONF-002.

## Versioned policy

`src/services/classpilotAiRequestInput.ts` exports
`CLASSPILOT_AI_REQUEST_INPUT_POLICY_VERSION` with value
`classpilot-ai-request-input-2026-10-08.1`. The pure preparation helper returns
either `{ kind: 'ready', url, title, policyVersion }` or
`{ kind: 'unavailable', reasonCode }`, with a fixed non-content reason code.
No raw input, extracted value or rewritten snippet is logged.

| Browser input | Provider representation / result |
|---|---|
| HTTP(S) URL username/password | Remove exact userinfo bytes; retain the actual destination hostname. |
| Clearly separable authentication query fields | Replace values with `[REDACTED_CREDENTIAL]`; preserve unrelated raw bytes, parameter order and duplicates. |
| Plain key/value fragment | Apply the same field policy while retaining unrelated fragment content. |
| Credential assignment, including quoted/JSON-style keys, or authorization/Bearer form in a title, path, nested URL or hash route | Unavailable; no provider call. |
| Quoted, structured, separator-bearing or Basic-scheme values in an otherwise redaction-eligible credential field | Unavailable because the value cannot be treated as a separable scalar credential. |
| Ambiguous authentication assignments, signed links, SAML payloads, contextual OAuth code | Unavailable; no provider call. |
| Ordinary `code`, `key`, `id`, `state`, email addresses and search terms | Retain existing classification context. |
| Ordinary prose mentioning tokens/passwords | Retain; recognition targets explicit assignments and authorization/Bearer forms. |
| Malformed, ambiguous, oversized or unresolved credential encoding | Unavailable; do not truncate or retry with raw input. |

The redaction allowlist is `access_token`, `id_token`, `refresh_token`,
`oauth_token`, `api_key`, `apikey`, `client_secret`, `password`, `passwd`, `pwd`
and `authorization`. Match complete decoded names case-insensitively and accept
hyphen/underscore aliases. Ambiguous assignment names `token`, `auth`, `secret`,
`signature` and `sig` withhold the request. AWS/Google signed-link fields, SAML
payloads and OAuth authorization codes with authentication context also withhold.
An ordinary resource code alone is not an OAuth credential.
Quoted assignment keys, including JSON-shaped credential fields, are not a way
to evade recognition. Where a redaction-eligible scalar uses a Bearer form, the
Bearer payload is also an extracted credential for the final residual check;
echoing that payload elsewhere withholds the complete request.

Provider fallback requires an absolute HTTP(S) URL, an original URL at most
4,096 characters and an original title at most 512 characters. Inspection copies
use at most two percent-decoding passes; form-style `+` decoding applies only to
parameter components. The helper must establish exact replacement spans and
recheck the complete prepared payload for extracted credential values, including
supported encoded forms. A remaining credential value withholds the request.

After redaction, retain a non-authentication path, noncredential parameter or
fragment, or non-placeholder title. Login, OAuth, SSO, SAML and callback routes
with credentials remain unavailable. This bounded eligibility policy is not a
guarantee of universal secret detection or unchanged model judgment.

## Classification and restriction separation

Existing local domain, school-domain, NWEA and search rules run before this
provider-only preparation. Missing provider credentials and disabled fallback
still avoid a model call. The Gemini builder accepts only prepared input, after
preparation and before provider queue admission. Withholding returns the existing
`unknown` classification, `source: 'unknown'`, with no safety alert; it completes
the ordinary heartbeat classification lifecycle.

Cache and in-flight identity retain the hash of the exact original URL/title,
existing school/model/ruleset context and the input-policy version. Different
original observations do not share classification results merely because they
redact to identical provider text. Cache lifetime/capacity and provider
concurrency, queue and timeout limits retain their existing values.

Original navigation continues to supply local search classification, teacher
intent, safety evidence and precise-resource matching. Provider-prepared strings
are not restriction-matching inputs. Unknown classification issues no closure or
restriction commands and produces no model-derived after-hours safety alert.
The common URL classifier covers ordinary heartbeat and configured after-hours
classification without broadening monitoring. MailPilot, chat, imports, public
API shape, schema, capabilities and extension protocol are outside this change.

## Synthetic evidence matrix

The tests install mocked provider fetch before importing the real classifier.
All values are synthetic. Do not load an application `.env`, use live provider
credentials, call a real provider or use student/production data for this block.

| Fixture group | Required observation |
|---|---|
| Userinfo, query and plain fragment credentials | Actual outgoing provider request contains the fixed marker or removed userinfo, and no tested credential value. |
| Repeated/mixed-case fields and supported encodings | Correct exact-span redaction or unavailable; unrelated raw context survives. |
| Sensitive titles, paths, nested redirects and hash routes | Zero provider calls and normal unavailable result. |
| Ambiguous assignments, signed links, SAML and OAuth context | Zero provider calls; ordinary resource identifiers remain allowed. |
| Malformed/oversized input and encoding ambiguity | Zero provider calls, no truncation, throw or sensitive diagnostic output. |
| Email and ordinary search context | Actual outgoing request retains deliberately allowed context. |
| Educational, harmful-intent and prevention context | Supported redaction retains unrelated classification evidence; local rules keep normative fixtures. |
| Cache/in-flight isolation | Identical originals reuse/coalesce; distinct originals remain separate even with identical prepared text. |
| Known education/school sites, NWEA, local search and disabled fallback | Existing branches make no unnecessary provider call. |
| Provider HTTP/transport/response/timeout/queue failures | Normal unavailable outcome, fixed diagnostics only and a successful subsequent classification. |
| Heartbeat/after-hours and precise-resource integration | Pending delivery completes, no model-derived alert on withholding, and original restrictions/resources retain existing semantics. |

Required source tests include:

```sh
node --import tsx --test --test-concurrency=1 tests/classpilot-ai-request-input.test.ts tests/classpilot-provider-boundary-audit.test.ts tests/gemini-url-classification.test.ts tests/ai-classification.test.ts tests/soc2-ai-privacy-evidence.test.ts
npm run check
npm run build
npm run soc2:check
npm run soc2:ai-privacy-evidence
node scripts/release297-current-state.mjs --check
```

The review packet records the exact committed tested source, applicable caller,
database/CI results, failures and skips. Presence of a test/source hash in the
AI/privacy collector is a pointer, not an execution result. Generated collector
packets remain ignored in `soc2-evidence/ai-privacy/`. Private provider account,
retention/deletion/training, access/logging and agreement evidence stays in
`SchoolPilot-SOC2-Evidence/ai/reviews/`; mocks do not approve those guarantees.

## Release and deployment prerequisites

1. Review the exact source change and synthetic results, then separately merge
   and verify resulting-main CI. The observed planning baseline is
   `bb8db8c59f8ecd099b8c5b6c236498c341cf7fff`; later main movement requires recheck.
2. Select and freeze a new tested application reference. Backend code and
   `docs/soc2` are image inputs, so the prior A
   `a5161eb14939132776e0b77eac8e3c485091432c` application-equivalence proof no
   longer covers this change. Build/identify a fresh candidate image and scan;
   refresh applicable native, recovery and classroom acceptance evidence.
3. Keep C578 and its October 7 failed scan, fallback F
   `d75fc1c48d0a3918857508d3965904c69023a153`, and the actual A→F→A ordinary
   migration/admission receipts unchanged. They remain exact historical
   preparation evidence, not evidence for a changed application reference.
   Rollback to unchanged F restores the previous Gemini browser boundary and
   this credential-egress risk. F selection requires explicit applicability
   review; a future source-changing fallback fix needs its own reviewed artifact.
4. Obtain fresh production health, task/environment, schema/admission, backup
   and flag observations before separately authorized publication, registration
   and migration-first matched backend/API-worker deployment. Deploying this
   backend change is necessary for production protection; source tests alone do
   not establish live behavior.
5. Verify the exact serving task/image identities and approved sample-bearing
   live acceptance after deployment. Retain the DeSales 133-client audience,
   both new Usage modes off, daily-rollup mode independently recorded and managed
   validation `waived_not_passed`. Classroom campaigns and activation remain
   separate release gates.

ClassPilot 2.9.7 is unchanged; this backend boundary change requires no new
Chrome Web Store upload. The current release index/checklist distinguishes
implementation, review, deployment and live verification. Preparation confers no
merge, cloud publication, registration, deployment or activation authorization.
