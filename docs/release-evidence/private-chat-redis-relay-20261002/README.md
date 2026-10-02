# Delayed private-chat Redis delivery regression

Evidence captured on 2026-10-02 in an isolated, fully converged 129-table local PostgreSQL database. The service suite invokes the actual `deliverClasspilotStudentBindingRedisMessage` receiver and registered, authenticated loopback WebSockets. There is no Redis/network mock standing in for the receiving adapter. A native ping/pong barrier drains preceding socket bytes before each inbox assertion.

## Proven failure and correction

The baseline application source is `7f2969ae9c8b23e11b5627485e1486262aefed19`. Its receiving-adapter blob, `bfb23820b8ddb8c4427b8dbf71e577b537be9875`, is identical to integrated source `37d01a4aab913533bf4fddf1d86265a44741707f`. Baseline test assertions positively observed actual private message receipt after End Chat and school/activity hard-off, despite the unchanged exact student binding. Forged/missing metadata and unsupported local sockets also received private frames. The hard-off race did not wait for the actual settings writer; a frame also arrived after expiry while its final native binding SELECT was held.

The correction is root commit `8cb02862d1edc42d62b95f995236491e527aca35`, cherry-picked locally as `e0afe5f6`. It validates durable message/outbox identity, content, current authority and lifecycle under the receiving transaction, derives the mandatory socket capability from the stamped frame, and checks expiry synchronously after the final binding read.

| Saved raw output | Result | SHA-256 of saved bytes |
| --- | --- | --- |
| [baseline-red.log](baseline-red.log) | 49 tests: 28 passed, 21 failed, zero skipped | `ef26177249367650d06cbced52d5eec5efbeeedad34047abec5ff8af2cded844` |
| [ordinary-green.log](ordinary-green.log) | 55 tests: all passed, zero skipped | `f0a3b916bbb5b896207ba5072953144e17f05cc9fbeb8f5bd480aa09df6c8c09` |
| [restricted-green.log](restricted-green.log) | 55 tests: all passed, zero skipped | `f0eb464212136bf30b77a49eaaa872c82e4e1d304d01be70f4bd7d64e013f269` |

Baseline comprises the 26 preceding lifecycle cases, two positive current live/scheduled receiver controls, six new receiver parent cases, 14 nested integrity variants and one final-binding expiry case. Green additionally includes the six-test hermetic FORCE-RLS ownership/parent suite. Both application-role runs completed all hooks and disposed their generated roles. The ordinary service run uses a privileged local fixture role; it is not evidence of application FORCE-RLS enforcement. The restricted service run uses a non-owner NOSUPERUSER/NOBYPASSRLS role. The separate hermetic ownership suite establishes its own role/catalog/invoker-policy assertions in either lane.

The regression checks current live and scheduled delivery, End, school/activity off then on without revival, separate ANNOUNCEMENTS, empty-envelope capability waiver attempts, forged generation/thread, announcement disguise, unknown/conflicting/missing IDs, wrong student/session/activity, extra activity, substituted content, wrong attempted binding, expiry, and an actual PostgreSQL hard-off lock wait. The expiry boundary delays dispatch of only the second real exact-binding SELECT, then executes that SELECT after PostgreSQL `clock_timestamp()` proves expiry. It neither fakes the query result nor changes a production deadline.

## Exact validation boundary

The saved green runs precede the final 12-line amendment to the existing first bridge test: an unstamped legacy frame is withheld while off and successfully delivered to an older socket after on, before first adoption. That amendment is **pending a final rerun**; these raw green logs must not be described as validating its added assertions. No production bytes changed in that amendment. A capacity quiet window was observed after it was added.

The unsafe-test-cast ratchet passed. The local test-type command exited 1 with two TS2741 increases in existing files assigning compiled `dist/services/storage` to the current source module type. The pre-correction dist declaration lacks the newly exported relay helper. Baseline debt blob `5fc2c47c4ae9172e4e498feac265914db8ec25e8` is unchanged and matches integrated source. A fresh backend build followed by the type check is pending after the capacity quiet window; no debt allowance or fixture weakening was introduced.

The independent ordinary-CI RLS fixture failure is separately corrected in `b4b6fed268e3b5f8c5e42fcde10bac1eb67281f4`: foreign insertion must produce either the exact invoker assignment-mismatch 23514 or this table's exact FORCE-RLS WITH CHECK 42501. A malformed same-school parent and immutable ownership/generation checks remain strict 23514. The saved green runs include this correction. Original root CI log is retained externally as `release-297-ci-db-second.log`, SHA-256 `5735a63aa0e1449a3d3018b130d0599cff4141590374418992a4b972fcb46652`; final current-head CI remains required.

No production deployment, merge, real-school mutation or operational activation occurred as part of these tests.
