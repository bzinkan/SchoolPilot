# Release 2.9.7 build-security fallback

F3 corrects issue #625's six High build-dependency findings while retaining the
CP-AI credential boundary. The exact F3 backend and separate compatible C
frontend were independently selected. The [current release index](releases/release297/current-release.json)
and generated [operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md) are the
current status records. This packet identifies the reviewed artifacts and next
operations; it is not an operational authorization receipt.

Application reference A3 is `2001e8888992674493c3084981fa8aae27d70e1d`. PR #629
merged the reviewed tooling at `6e33a19662fec14e719a806e73160a84816f120e` from
`dbf00dbb29945fd316150af047aa55194f59d892`. Exact resulting-main CI passed with
19 successful checks and two known skips, and real Git inventories preserve A3's
564 backend and 637 frontend inputs. Every eventual operation still requires
fresh exact-main CI, clean source and the reviewed frozen script bytes.

| Artifact role | Exact source | Artifact identities |
| --- | --- | --- |
| Serving backend A3 | `2001e8888992674493c3084981fa8aae27d70e1d` | Index `88d012d047e47a4bc33352290baf1800772777ee4260a4be64f5caacd7a249cc`; platform `5e061a32ad491557e7685bfcb8876b031a197c76594e1b03be76c55774e543fb`; config `ae1680620e484439e10298b7cac433ab501f2a00ce4ecbc2251a9c3b0ee5c943`; archive `b228d66a208de3e49f0bb0751ad2d1501d3f1185fceece754adcdaa5c723ec6e` |
| Matched frontend A3 | Same A3 | ZIP `ca200bf37c33277a49c0cd83707ddfa2c123634eaf1d881b417778b334adb41d`; 171-file inventory `3035336e3f9836c437a893b368e3aba7b7e4a118b51dfca2ac5dfd2cf25733f3` |
| Fallback backend F3 | `392970b7ccfea365faadf1eba07da4ad26964c09` | Index `6a039cf5ec60efcfa054bde5166e04dd62d70dbdd8e9785a6954accf7eeb684e`; platform `4073299e7bdea7ac0886c9875ae29989c1007769565424328b63f66a7bdbb41a`; config `2452ce7a09e2e97765a1217670ba69cd6a72350efa4e054c85e8b0a31079343b`; archive `e74e71e1d73af9aa8ecc5210ba012b78aca4aab12a4e54ec03d7d95dcbc1b06b` |
| Compatible recovery frontend C | `cce3f7b4eae30df13378337c01dc4ff2d5db3997` | ZIP `8d6379613dbb1c88783ee0f141ed41c34164fac5142172daee7da7f8d27cd72a`; 171-file inventory `3484fa4f9848dc9e48e4e3bfeb384e959f17deccd10125e8b362fb094f29451e` |
| Unchanged ClassPilot 2.9.7 | Main `03a9c3633d1e1f7d763ea5cf910f870994400e02` | ZIP `82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`; no new Store upload |

The [v5 binding](release-bindings/release-297-current-school-cp-protected-build-fallback-v5.json)
separates candidate and fallback roles. F3 is an exact child of F2 with only
`package.json` and `package-lock.json` changed; its binary patch SHA-256 is
`2184fac4c1fa58736afe999f5da094a9e478467e7c86e5f7d906523aa55688d0`.
F2 output before/after the unused alias transform and F3 output have the same
1,574 paths, sizes and hashes. F3's older application tree is retained only as a
recovery source and must not be merged into main.

F3's image scan reports zero High/Critical and one Medium finding. Its full npm
audit reports zero High/Critical and seven Moderate findings; production
dependencies report three Moderate findings. The source checks, nine actual
native Linux/musl processing/IP checks, 53 compiled-image credential fixtures and
unforced cleanup passed. C's production dependency audit has no advisories; its
reported development findings remain one High and one Low under the existing
production/reachability policy, without a waiver. Precise-resource matching and
the opaque teacher-command contract are unchanged.

| Original release gate | Current outcome | Actual evidence |
| --- | --- | --- |
| DeSales 133-client campaign | Passed | Eight fixed-order 60-second runs; 6,384 offers, successful responses and persisted rows; all nine approved amended criteria |
| Capability-on normal load | Passed | 340 clients for 60 seconds with persistence, error, safety and cleanup review |
| Mixed classroom endurance | Passed | Three consecutive 900-second runs, 45 rounds and 36,309 successful/persisted heartbeats; full continuous ordinary-heartbeat p95 32.437478 / 34.635894 / 34.942394 ms |
| Ordinary recovery | Passed | Exact A3→F3→A3, eight API/worker processes and eight graceful drains, queried restricted migration roles and retained 53-entry ledger |
| Restricted restoration | Passed | Six fresh actual rounds bound to the same A3/F3 ordinary replay |
| Screenshot/native processing | Passed | Source-bound actual processing and scan evidence, separate from preparation receipts |
| Accepted 250-client headroom | Failed | Run `21f119c74dbd`: p95 544.682706 ms exceeds the approved 400 ms limit; all 1,500 requests succeeded/persisted, CPU 0.423284, other checks and cleanup passed. Remaining two attempts held. |

Every passed original gate has a separate native result and independent review
linked from the index. Mixed p95 figures above use each full 900-second continuous
ordinary-heartbeat sample; sealed first-60-second round samples remain separately
labeled. The [startup correction completion](releases/release297/fixed133-baseline-startup-completion-20261009.json)
preserves the original zero-round failure/custody limitation, then records actual
corrected protocol and full baseline startup plus the successful eight-run block.
Five baseline latency failures remain retained; the superseded comparison gate
was not revived. No thresholds, run order or production flags changed.

Ordinary recovery retains migrations **43→53** and admission
**121→125→126→127→128→129**. The historical 54-entry rehearsal is separate.
Current production already admits 129; the bounded operational path clones its
exact emergency-API/worker definitions into inactive 129 candidate/fallback pairs,
preserving existing capability modes, environment, secrets and desired counts.
Both new Usage modes stay off. The separately omitted daily-rollup setting
continues to default to shadow; this does not establish zero rollup workload.

[Exact selection](release-evidence/release297/cp-protected-build/exact-F3-C-successor-selection.json)
and [C preparation](release-evidence/release297/cp-protected-build/fallback-frontend-C-preparation.json)
identify one F3 backend and the compatible recovery frontend. Current A2/A3
pages-view/cursor behavior is incompatible with F3. Before backend deployment,
establish the strict actual recovery proof and bounded C recovery Plan after
publication/registration. If F3 recovery is needed, publish exact C and reload
already-open A2/A3 pages/reset history cursors. C uses F3's earlier Focus and
Waypoint UI without A3's current-tab shortcut or activeTabRef status projection;
the server-enforced opaque Focus command contract remains intact.

The operator's remaining sequence is explicit:

1. Preserve the headroom failure and establish a reviewed, falsifiable correction before any new attempt. After the required fresh headroom confirmation passes, review/merge the state-only evidence successor and verify
   its exact resulting-main CI and application/script equivalence.
2. Refresh production health, catalog/admission, backups, flags and task state.
   Review exact publication and inactive-registration Plans/windows; publish the
   bound A3/F3 artifacts, register inactive129 pairs and establish C recovery proof.
3. Run migration-first backend/worker deployment, converge on the exact candidate,
   then publish the matched A3 frontend. Retain all actual operation/readback and
   public-byte evidence, including any uncertain outcome.
4. Collect already-open page adoption and sample-bearing live acceptance: sign-in,
   IXL Entire Website, precise resources, mixed Flight Paths, Focus/Attention,
   Classroom commands, messaging, reconnect and relevant PassPilot/GoPilot flows.

The user authorized necessary correction merges/publication/registration and
backend/frontend deployment through "fix this and deploy." Execution remains
gated; runtime/pilot activation, Store submission and GitHub settings are separate.
Managed-device validation stays `waived_not_passed`. Public bytes, synthetic
campaigns and task health do not establish managed adoption or live acceptance.
Later global promotion retains the existing per-capability windows and freshness.

C578/F1 failed scans, F2's six-High audit, earlier A/A2 artifacts/recovery and the
initial failed startup remain historical. [The merged dbf00 snapshot](release-bindings/history/release297-2001e888-f3-dbf00dbb/index.json)
preserves the previous packet/profile/index/observation; prior
[A](release-bindings/history/release297-ecf6ce01-f3-8293939d/index.json) and
[A2](release-bindings/history/release297-55f91b62-f3-25964241/index.json)
snapshots remain intact. None certifies changed application inputs or actual live
production state.
