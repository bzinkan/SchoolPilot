# SchoolPilot / ClassPilot 2.9.7 release inventory

This is an inclusion inventory, not merge, deployment, or activation evidence. The structured record preserves full commits, base dependencies and inclusion proofs. Checkpoint 60bb2338157a9f0c313ebffae3f42a69ac3e3345 is based on main 996d965f0b044f8fc4d4bbc399c5ab3781fbac04. Preserve original review branches; reconcile their PRs only after the single integration PR lands.

[Operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md) · [Exact commits and proofs](release-evidence/release-2.9.7-pr-inventory.json)

| PR | Disposition | Exact reviewed head | Dependency base | Scope |
|---|---|---|---|---|
| [SchoolPilot #547](https://github.com/bzinkan/SchoolPilot/pull/547) | already merged | `45dd3333ffb043c797ac095387c0c87e5d31a238` | main | Keep the AI assistant's Flight Path list to the teacher's own paths |
| [SchoolPilot #548](https://github.com/bzinkan/SchoolPilot/pull/548) | already merged | `22c183c450b5d1f1a1aef72ba4772f546e3132ab` | main | Harden the shadow daily usage rollup so set-based can be promoted (roadmap PR 10a) |
| [SchoolPilot #549](https://github.com/bzinkan/SchoolPilot/pull/549) | already merged | `eda5c1f2576c06608de16fe8ca5296c954d716d8` | main | Add the competitive roadmap and the legacy Live View/TURN media audit |
| [SchoolPilot #550](https://github.com/bzinkan/SchoolPilot/pull/550) | already merged | `1dae1ff1e8ca30aca4fde3185f65bfdd0e2eccc3` | main | Withhold precise restriction resources so a rollback past PR 2 never widens a Waypoint (roadmap PR 2-pre) |
| [SchoolPilot #551](https://github.com/bzinkan/SchoolPilot/pull/551) | already merged | `7efe17119507edfe9e0be3274e35eb77d5bba346` | main | Guard retained TURN identity with prevent_destroy and refuse legacy Live View signaling by default |
| [SchoolPilot #552](https://github.com/bzinkan/SchoolPilot/pull/552) | already merged | `f63e5d87524d4d0cf591de58e0caea5bd1d82174` | main | Add a governed production setter for the wave-1 product flags |
| [SchoolPilot #553](https://github.com/bzinkan/SchoolPilot/pull/553) | already merged | `eb4293011bb8cc73dfad4339d67689de7bd59969` | main | Add a School Library for shared and official Flight Paths and Block Lists |
| [SchoolPilot #554](https://github.com/bzinkan/SchoolPilot/pull/554) | already merged | `296b7f204b47be1aafb04ddd875e72b8c01750e4` | main | PassPilot issuance rules: capacity, daily/period limits, encounter restrictions, admin override (roadmap PR 7) |
| [SchoolPilot #555](https://github.com/bzinkan/SchoolPilot/pull/555) | already merged | `87fdeb128b9a7531e6f159754687982876b757be` | main | Add precise restriction resources and preciseRestrictionResourcesV1 on the server (roadmap PR 2) |
| [SchoolPilot #556](https://github.com/bzinkan/SchoolPilot/pull/556) | already merged | `c94dff4b4e1250f8d97a0afbc7ed44fca9545dcf` | main | Add Monitored Browser Time rollups, retention and the admin Digital Usage API (dark) |
| [SchoolPilot #557](https://github.com/bzinkan/SchoolPilot/pull/557) | already merged | `cebf305b9fdcd994bd51a64a4f5acf030b40a8d0` | main | Move the transitive engine.io to 6.6.11 for GHSA-2gc4-cqfq-p2gv |
| [SchoolPilot #558](https://github.com/bzinkan/SchoolPilot/pull/558) | already merged | `fe89219c2dca7a85a73e9de2381a376c03ad6362` | main | Record wave-1 roadmap status and the real PR 2-pre activation rule |
| [SchoolPilot #559](https://github.com/bzinkan/SchoolPilot/pull/559) | already merged | `a84101283819f0fb34ffde525666669cbf7dadc1` | main | Harden the precise restriction matcher and clear CLI (roadmap PR 2 follow-up) |
| [SchoolPilot #560](https://github.com/bzinkan/SchoolPilot/pull/560) | superseded | `aafdddd98ca575f4bbc377e4c4bef80ee3c224f4` | main | Reconcile remaining roadmap and release preparation gates |
| [SchoolPilot #561](https://github.com/bzinkan/SchoolPilot/pull/561) | included | `2798431612be182aeca42a5bf3fe65be20cfada6` | main | Propose Present to Class hosting security and budget decision |
| [SchoolPilot #562](https://github.com/bzinkan/SchoolPilot/pull/562) | superseded | `ac4675e828cdde8f3b825be191e90e2a442b793c` | main | Refresh transitive Axios to clear current security advisories |
| [SchoolPilot #563](https://github.com/bzinkan/SchoolPilot/pull/563) | included | `69a191ddd50af030ceee6a7490016a263143ff28` | codex/roadmap-stacked-ci | Fix Monitored Browser Time coverage and processed cutoffs |
| [SchoolPilot #564](https://github.com/bzinkan/SchoolPilot/pull/564) | included | `157da0c1249ad279628b48e78f0f23a0e2b6b320` | main | Run CI and security checks for stacked roadmap PRs |
| [SchoolPilot #565](https://github.com/bzinkan/SchoolPilot/pull/565) | included | `7f413fd564f6370e4374570486dd208daefc1f6a` | codex/roadmap-corrected-base | Define Focus and Bring Forward server and extension contract |
| [SchoolPilot #566](https://github.com/bzinkan/SchoolPilot/pull/566) | included | `9055393d016d21ca96703a3ff90e0caeee1d7e90` | codex/roadmap-stacked-ci | Conceal retained encounter overrides in all public pass responses |
| [SchoolPilot #567](https://github.com/bzinkan/SchoolPilot/pull/567) | included | `ccdbb755f079fd2ebc9dd4e3156ba99e32a7cfb1` | codex/roadmap-corrected-base | Preview normalized restriction scopes and broader website access |
| [SchoolPilot #568](https://github.com/bzinkan/SchoolPilot/pull/568) | included | `34c93eb86e7ce72b7af611254609b96ca882d809` | codex/roadmap-corrected-base | Add administrator Monitored Browser Time page with truthful coverage |
| [SchoolPilot #569](https://github.com/bzinkan/SchoolPilot/pull/569) | included | `16a50cd33f5acff85a0de101c96076bc4d4e934d` | codex/roadmap-corrected-base | Measure corrected usage rollups with guarded local synthetic load |
| [SchoolPilot #570](https://github.com/bzinkan/SchoolPilot/pull/570) | included | `b47355358a5d9bc7e29cc047104c2b281c538dbb` | codex/roadmap-corrected-base | Add atomic manual PassPilot appointments and retained lifecycle |
| [SchoolPilot #571](https://github.com/bzinkan/SchoolPilot/pull/571) | included | `ae2dc2fa9e62906b4d76227d174c8278ae04b570` | codex/precise-restriction-previews | Review precise resource and Classroom scopes before authoring |
| [SchoolPilot #572](https://github.com/bzinkan/SchoolPilot/pull/572) | included | `cae164a2a578c4a0886531d6dd0a25e6878d6769` | codex/focus-command-contract | Add exact Focus commands and atomic Open + Focus continuation |
| [SchoolPilot #573](https://github.com/bzinkan/SchoolPilot/pull/573) | included | `91eead05e8a3d5c822426bcd4b5279dd55f05011` | codex/passpilot-appointments-api | Serialize appointment eligibility with attendance and dismissal |
| [SchoolPilot #574](https://github.com/bzinkan/SchoolPilot/pull/574) | included | `9250fab903d16b41769d86ec12086dfef21f9a12` | codex/passpilot-appointments-api | Add PassPilot-only canonical school-year setup |
| [SchoolPilot #575](https://github.com/bzinkan/SchoolPilot/pull/575) | included | `e7d0a7b470d8e8b95c7936a14cb43c98dd4e602b` | codex/focus-commands-api | Add exact teacher Focus and Bring Forward controls |
| [SchoolPilot #576](https://github.com/bzinkan/SchoolPilot/pull/576) | included | `0f58534af0ec8c168ebcd9fba271e7f8acf3bd22` | codex/roadmap-corrected-base | Drain Student Information browser handlers before teardown |
| [SchoolPilot #577](https://github.com/bzinkan/SchoolPilot/pull/577) | included | `173f768a9f8ca83ca641eb6496cf17ef92921c45` | codex/classroom-actions-interface-base | Add reviewed Classroom actions with pinned policy and confirmed students |
| [SchoolPilot #578](https://github.com/bzinkan/SchoolPilot/pull/578) | already merged | `d2c047c27698990b25892bbce79200ba91920f8b` | main | Tolerate a replaced task's draining ALB target and require CI in the deploy gate |
| [SchoolPilot #579](https://github.com/bzinkan/SchoolPilot/pull/579) | included | `6efc27f4de187b4e43c923df31d6139c081727f7` | codex/passpilot-staff-interface-base | Add staff appointment scheduling and current-class reminders |
| [SchoolPilot #580](https://github.com/bzinkan/SchoolPilot/pull/580) | already merged | `27879128ccfe09ae1469d0b6252ea5b37e36059f` | main | Refresh transitive Axios to 1.20.0 for current security advisories |
| [SchoolPilot #581](https://github.com/bzinkan/SchoolPilot/pull/581) | included | `5e2fb408413abe50be6e79a5dd43071286de077b` | codex/roadmap-corrected-base | Keep kiosk metrics HTTP assertions within one minute |
| [SchoolPilot #582](https://github.com/bzinkan/SchoolPilot/pull/582) | included | `7b2ecdfaf9f5b38c89bb7a2fb974067843c92a83` | codex/focus-commands-api | Fence reviewed Classroom lessons and acknowledged opening |
| [SchoolPilot #583](https://github.com/bzinkan/SchoolPilot/pull/583) | included | `d1069bdd55e8a5b52231aef08dda5fdd257a229c` | codex/passpilot-staff-interface-base | PassPilot Reports v2: scoped aggregates and audited CSV |
| [SchoolPilot #584](https://github.com/bzinkan/SchoolPilot/pull/584) | included | `b1e4e6ea1e13ef81349a18bf697338c3b48ff8bd` | codex/passpilot-reports-v2-api | Add scoped server-backed PassPilot Reports v2 interface |
| [SchoolPilot #585](https://github.com/bzinkan/SchoolPilot/pull/585) | included | `a65a82283c4c44fcb8d1e32746010117ac7d6810` | codex/passpilot-reports-v2-api | test(passpilot): keep restricted reminder fixture stable at midnight |
| [SchoolPilot #586](https://github.com/bzinkan/SchoolPilot/pull/586) | included | `157c47baef24f65176da5bbc694309fe6cdeff03` | codex/usage-synthetic-load | Reduce usage attribution and report query work |
| [SchoolPilot #587](https://github.com/bzinkan/SchoolPilot/pull/587) | included | `b9fdbf3a46d0eda49b6c3d6e69eed8b1efd47eb9` | codex/roadmap-corrected-base | Keep kiosk issuance fixtures inside an active schedule window |
| [SchoolPilot #588](https://github.com/bzinkan/SchoolPilot/pull/588) | included | `328a814993e9c6ce79c172817e6d8e83c58b426b` | codex/roadmap-corrected-base | Fence preview fixture phases after paint and native capture completion |
| [SchoolPilot #589](https://github.com/bzinkan/SchoolPilot/pull/589) | included | `ed03deef647c80f59c9e9b35d56d66d0d08aecab` | codex/roadmap-corrected-base | Keep narrow Class tools usable and await actual browser state |
| [SchoolPilot #590](https://github.com/bzinkan/SchoolPilot/pull/590) | included | `f4742aaa87c1c8decc6c0b2a8dd368958a82a66f` | codex/roadmap-corrected-base | Make load harness fixture readiness and latency cohorts explicit |
| [SchoolPilot #591](https://github.com/bzinkan/SchoolPilot/pull/591) | included | `5d628383f6df9c7fad6d27e7a11e4d7af4ec28e7` | codex/usage-query-performance-api | Measure capped two-school usage profiles and preserve capacity limits |
| [SchoolPilot #592](https://github.com/bzinkan/SchoolPilot/pull/592) | included | `53e9a426d642046ec042d0cd157a8ca01b0062b3` | codex/usage-school-day-profile | Seed canonical primary assignments in usage fixtures |
| [SchoolPilot #593](https://github.com/bzinkan/SchoolPilot/pull/593) | included | `deecce0c3478b8b34424fef5748fd8df826515e5` | codex/roadmap-corrected-base | Fix concurrent ClassPilot device creation without rebinding |
| [SchoolPilot #594](https://github.com/bzinkan/SchoolPilot/pull/594) | included | `708bdd6fca9ecfa66ff1cfca97a9d9ce1b929bd5` | codex/student-device-upsert-concurrency | test(classpilot): retain auth fixture lifecycle roots |
| [SchoolPilot #595](https://github.com/bzinkan/SchoolPilot/pull/595) | included | `cffd1ed55fdda7f71f1ab1d7c94d769f26d4d015` | main | Freeze recipients for classroom actions and never widen a cleared selection |
| [SchoolPilot #596](https://github.com/bzinkan/SchoolPilot/pull/596) | included | `a7cb6f941e5f3a965a12c6eab6f9f18fce3fffe8` | main | Let teachers start a message with any student |
| [SchoolPilot #597](https://github.com/bzinkan/SchoolPilot/pull/597) | included | `dbaa4cdda517da49ede343043aa9ad994ac37a28` | main | Show the class roster in Messages |
| [SchoolPilot #598](https://github.com/bzinkan/SchoolPilot/pull/598) | already merged | `37c2dbacd9169477c03f961cecfc25cb73de7e75` | main | Record public ECS tasks and NAT removal in the production Terraform profile |
| [SchoolPilot #599](https://github.com/bzinkan/SchoolPilot/pull/599) | already merged | `13e3401c6c7f4797a534ca53d6357100e13db2f1` | main | Accept the AWS provider's computed leaves in the NatRollback inverse check |
| [SchoolPilot #600](https://github.com/bzinkan/SchoolPilot/pull/600) | already merged | `da1689f3704746993174eaea1c0c801c8b24b3f2` | main | Record that production has no NAT gateways and what that requires |
| [SchoolPilot #601](https://github.com/bzinkan/SchoolPilot/pull/601) | included | `f13cc336a028509bee57026a9770ce7e09ba3200` | main | Refuse live teacher replies while messaging is switched off |
| [SchoolPilot #602](https://github.com/bzinkan/SchoolPilot/pull/602) | included | `6990e10b3bc620ca3c07a4e9df8cb87b1e109f7a` | main | Hold the denial refresh until the Observe denial banner is seen |
| [ClassPilot #119](https://github.com/bzinkan/ClassPilot/pull/119) | included | `fffac0e0dc90704bccafcb9f230b9639ec9bba52` | main | Enforce precise resources with atomic policy rollback |
| [ClassPilot #120](https://github.com/bzinkan/ClassPilot/pull/120) | included | `d6cb334a6546cc06c744870382bdb5710f9d5934` | codex/precise-focus-candidate | Implement exact Focus and Bring Forward lifecycle |
| [ClassPilot #121](https://github.com/bzinkan/ClassPilot/pull/121) | included | `3a9ece517d521632f1accbb5a51ff3fcf1934162` | codex/focus-enforcement | Prepare precise and Focus candidate 2.10.0 |
| [ClassPilot #122](https://github.com/bzinkan/ClassPilot/pull/122) | included | `2aa6df988a78cb5860cef2c0866cab46566ffec5` | codex/precise-focus-release | Fix 2.10.0 Attention and lesson regressions and harden teacher chat delivery |

The coordinated review containers are [SchoolPilot #603](https://github.com/bzinkan/SchoolPilot/pull/603) and [ClassPilot #123](https://github.com/bzinkan/ClassPilot/pull/123). They are additional to the 60 source PRs above. Their open/draft state is recorded in the structured inventory; neither is merged. The exact 2.9.7 packaged source is `065be165b5df704d84eb716e3fb914c1fed17f98`, independently of later documentation-only ClassPilot commits.

#597 incorporates #595/#596 and their conflict resolutions once. The final integration retains #601/#602 and the complete roadmap. #574 and #586 have explicit conflict/fixture equivalence records. #562 is superseded by merged #580. #560 is reconciled by current release documentation while its historical evidence remains intact. #561 is a decision document only. ClassPilot #119→#120→#121→#122 remain intact in the separate 2.9.7 lineage.

Original checkouts and draft Observe work are excluded from mutations. SFU implementation, TURN changes, paid provisioning and legacy deletion remain excluded.
