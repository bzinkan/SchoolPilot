# Release 2.9.7 build-security fallback

The exact F3 recovery source removes the unused `tsc-alias` build transform and
its development-only dependency tree from F2. It retains the CP-AI credential
boundary on rollback. F3 is a separate recovery branch; its older application
tree must never be merged into main.

| Role | Exact source | Image index |
| --- | --- | --- |
| Current application reference A3 | `2001e8888992674493c3084981fa8aae27d70e1d` | `sha256:88d012d047e47a4bc33352290baf1800772777ee4260a4be64f5caacd7a249cc` |
| Historical tested application A2 | `55f91b620d2d48de5ed164a72250ec133450bc0f` | `sha256:8303500d39eb68531c30d4005b4b62eb4f4e0e202f10957d8dfe10cf1459a161` |
| Historical tested application A | `ecf6ce0100e758f5668c5a26427c1c0ea82ea0a2` | `sha256:23f729573155904217586ff4f951d7978f0b29926ce2b76a320ce2106a844c3a` |
| Previous protected fallback F2 | `6259e768553e55346ba14a6453340772198a3d6b` | `sha256:0eebe8c88bbc8304debaeb50644d008e1d3ad8212b0fee22a3a00eac1d04e264` |
| Build-security fallback F3 | `392970b7ccfea365faadf1eba07da4ad26964c09` | `sha256:6a039cf5ec60efcfa054bde5166e04dd62d70dbdd8e9785a6954accf7eeb684e` |

Current operational status is maintained in the [release index](releases/release297/current-release.json)
and generated [operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md). The [v5 binding](release-bindings/release-297-current-school-cp-protected-build-fallback-v5.json)
pins both artifact roles and the source actually tested. This document describes
the correction and evidence scope, rather than granting operational permission.
Main advanced to A2 with backend and frontend browsing-history changes before
operational preparation. The previous A/F3 preparation is retained at tooling
commit `8293939d1122c401a994450db48ea12f8f0da353` and in the [historical snapshot](release-bindings/history/release297-ecf6ce01-f3-8293939d/index.json).
A2 has its own exact image, native validation, source applicability and
recovery/restoration. PR #628 then changed five backend image inputs and the
frontend before any measured campaign. The exact A2/25964241 preparation is
preserved in its [historical manifest](release-bindings/history/release297-55f91b62-f3-25964241/index.json).
A3 has its own exact artifacts, fresh pair recovery and six fresh restricted
rounds. All six independently reviewed preparation leaves passed; original
candidate campaigns and exact successor selection remain pending. No A2 campaign
measurement started.

The F2-to-F3 difference contains only `package.json` and `package-lock.json`.
Its full Git binary patch SHA-256 is
`2184fac4c1fa58736afe999f5da094a9e478467e7c86e5f7d906523aa55688d0`.
The parent is exact F2. The existing eight CP-AI source/test changes are rechecked
against F1; application code, migrations, capability configuration, restriction
matching, Dockerfile, TypeScript configuration and frontend are unchanged from
F2. The new build command is `tsc`; the reviewed exception removes only the unused
alias transform and 34 development-only lockfile records.

Actual compiled inventories contain 1,574 files each. F2 output before and after
the alias transform and fresh F3 output match in paths, sizes and hashes. An
independent review rehashed all 1,574 retained F2 files and all 1,574 F3 files.
The private execution and three inventories remain separately hash-pinned.

Fresh F3 source checks passed: dependency installation, backend type/build,
1,820 unit passes with four explicit skips, and 175 synthetic CP-AI/unchanged
precise-resource regressions. The existing test type ratchet remains 438/534;
this is distinct from the zero-error application type/build result. Full npm
audit reports zero High/Critical and seven Moderate findings; the production
dependency audit reports zero High/Critical and three Moderate findings. The
previous F2 six-High audit remains failed and historical under issue #625.

The exact Linux/amd64 F3 image scan reports zero High/Critical and one Medium
finding. Native Linux/musl screenshot, image, private-file, PDF, Express IP and
rate-limit checks passed, with nine actual checks and graceful cleanup. The
compiled-image credential fixtures passed 53/53 using intercepted synthetic
provider requests; no external provider request occurred. These bounded fixtures
do not establish universal secret detection, private provider-account review,
managed-device adoption or live acceptance.

Historical local API/worker recovery passed A → F3 → A through ordinary migrations
43 → 53 and admission 121 → 125 → 126 → 127 → 128 → 129. Eight service processes
and eight graceful drains passed; the 53-entry ledger, screenshot function/ACL,
RLS, messaging history/expiry, Focus cleanup and compatibility floors remained
intact. Five fresh catalog queries verified the migration role has no superuser,
RLS bypass or inheritance privileges, owns all constructed application tables,
and has public-schema USAGE/CREATE without owning that schema. All named SQL
connections closed. Six actual restricted restoration rounds remain pinned to
their original replay, with explicit unchanged pair, canonical schema and ledger
comparisons to the fresh ownership-query replay. Both attempts and their scope
remain retained; no historical 54-entry rehearsal is substituted. These results
do not certify A2 → F3 → A2.

Historical A2 → F3 → A2 ordinary recovery and all six fresh restricted restoration
rounds passed independently. Eight actual API/worker processes and eight drains,
the 53-entry ledger and all five queried ownership checkpoints passed, with zero
named SQL connections and all 39 owned containers absent after graceful cleanup.
The raw pair JSON, both artifact roles and each actual execution reference are
replayed against the exact A2/F3 binding. An initial derived leaf referenced the
older A pair; that draft remains retained, and corrected leaves were separately
reviewed. No actual recovery run used the older A artifact. These outcomes retain
their historical A2 scope.

Fresh A3 → F3 → A3 ordinary recovery and six fresh restricted restoration rounds
passed independently. Eight actual API/worker processes and eight graceful drains,
the 53-entry ledger, five queried ownership checkpoints and all compatibility
floors passed, with zero named SQL connections and all 39 owned containers absent.
The actual raw pair JSON and execution references match the exact A3/F3 binding.
All six current preparation leaves pass. Exact A3 main CI also passed with 19
successful checks and two expected skips; its [completion supplement](releases/release297/a3-preparation-ci-completion-20261009.json)
preserves the original pending snapshot and failed Android dependency-resolution
attempt. Original campaigns, exact selection and resulting tooling-main CI remain
pending.

F3 retains the CP-AI boundary on rollback. It predates A2's optional browsing-history
`view=pages` filter: an A2 frontend paired temporarily with F3 can display all
observations while its page-only filter is selected. Exact successor selection
must record this known rollback limitation. No safety or restriction input is
changed by that filter behavior.

F3 configuration digest:
`sha256:2452ce7a09e2e97765a1217670ba69cd6a72350efa4e054c85e8b0a31079343b`.
Platform manifest:
`sha256:4073299e7bdea7ac0886c9875ae29989c1007769565424328b63f66a7bdbb41a`.
Archive SHA-256:
`e74e71e1d73af9aa8ecc5210ba012b78aca4aab12a4e54ec03d7d95dcbc1b06b`.

Schema version 5 accepts one binding ID,
`release-297-current-school-cp-protected-build-fallback-v5`. Historical schemas
1–4, C578/F1/F2 pins, failed scans and receipts are preserved. Preparation
requires six fresh independently reviewed leaves plus the raw full audit and
compiled-output proof. Operational Plans additionally require exact selection,
source/policy applicability and all original candidate campaigns. Preparation
alone returns `releaseReady: false` and `operationalAuthorization: false`.

Publication and registration retain the binding/validator hashes and artifact
roles through both publication paths and compatible fallback replay. Historical
unused121 and Anchor128 paths retain their original guards. Fresh production
metadata already shows admission 129 and existing enabled classroom capabilities;
v5 therefore uses the explicit `PlanCurrent129Anchor` / `RegisterInactiveCurrent129`
operation. It clones the stable current pair into unused definitions, changing
only the serving image and source identity. Hash-pinned private control captures
bind every existing capability/protocol value, including rollout targeting.
Fallback registration preserves that exact environment and 129-table admission.
This route cannot activate capabilities or substitute an older admission stage.
The v5 dependency set also hashes the reviewed deployment
validator and deployment script. The matched serving image remains the tested
application reference when a
later main commit proves equivalent application inputs. The deployment path
replays its exact reviewed publication receipt rather than rebuilding an image
from the tooling commit or claiming an unsigned artifact is signed by CI.

ClassPilot 2.9.7 remains unchanged. DeSales remains the 133-client audience, both
new Usage modes remain off, daily rollup is recorded separately, and the
managed-device gate remains `waived_not_passed`. Publication, registration,
deployment, live verification and later capability promotion each retain their
own applicable gates and evidence.

Automatic backend recovery runs before the matched frontend is published. Current production has externally adopted A2's frontend, so that order alone no longer establishes compatibility with F3. Deployment remains blocked pending a reviewed compatible frontend recovery action and exact artifact; the earlier A1 applicability claim retains historical scope. A later manual F3 rollback after matched frontend adoption likewise requires a separately reviewed compatible frontend and browsing-history cursor reset. F3 also lacks PR #628's opaque active-tab reference; A3 disables the current-tab Focus shortcut when that reference is absent. Reloading the newer frontend alone does not restore the older history contract.

The [historical A2 preparation observation](releases/release297/a2-artifact-preparation-20261009.json) retains exact-source type/build/test-type, 2,470 unit tests (2,466 passed; four explicit skips), 169 credential/precise/safety/history regressions, governance and exact-main CI. Its matched frontend02 was built explicitly in production mode; the 171-entry ZIP is `a107df178142707491f3797d9ebc3dd8270bbd1ad8349b964aeef90bff4e5ea9`, with inventory `d8452f43e010b6bac8e677922ffc3d49f9de8afe00862f82b2e7b292628b31a3`. Frontend01 remains ineligible because it inherited NODE_ENV=test. Raw failure/correction attempts and independent aggregate review are retained. These identities cannot certify the changed A3 inputs; see the separate [A3 preparation observation](releases/release297/a3-artifact-preparation-20261009.json).
