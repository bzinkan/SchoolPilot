# Linux Usage runner implementation successor

Recorded October 12, 2026. PR [#647](https://github.com/bzinkan/SchoolPilot/pull/647)
was independently reviewed and merged as
`e9d50caef006ff39b4e1b6183a0cd2b899ce16bc`. The owner then explicitly authorized
implementing its runner plan with a **$15 pre-tax cap**, keeping production Usage
off and every acceptance threshold unchanged. This is the bounded runner exception
requested by the [historical proposal](USAGE_LINUX_ACCEPTANCE_RUNNER_PLAN.md).
Its original unapproved status, receipts and binding summary remain historical.

## Implemented controls

The [runner tools and operating procedure](../scripts/load/usage/linux-runner/README.md)
provide one-attempt cloud lifecycle control, absolute host and owner stop
controls, private encrypted input/return custody, guarded staging, Linux admission,
fresh fixture preparation and durable serial execution of the original eight stages
and 30 attempts. Cleanup requires fresh independent replay of two private copies;
it reconciles partial deletions and proves resource absence before claiming completion.
Unproven stop, recovery, custody or cleanup remains an incident with raw evidence.

The October 12 read-only price refresh retains the proposal's **$13.20** estimate,
including eight active hours, 20 GiB export, seven days of retained disks and stated
contingencies. The ceiling is $15 pre-tax for one VM/attempt. There is no automatic
retry, replacement, extra storage, paid IOPS or retrieval VM. Stop timers bound
compute; final billed cost still requires reconciliation. A custody failure retains
the only evidence copy, with the proposal's day-six escalation/seven-day decision.

A separately bound later launch may shorten the planned interval to any positive
duration of at most eight hours while preserving the approved absolute stop. The
pricing ceiling still reserves eight active hours. The unused October 12 a4 proposal
selected 15:45–22:45 Eastern (19:45–02:45 UTC), a seven-hour subset of the owner's
14:45–22:45 Eastern attended window. Its launch grant expired unused; these times
do not authorize a later launch or extend the owner's absolute stop.
Its launch grant ends at the earlier of ten minutes after the bound start and the
absolute stop. Admission still requires at least 240 quiet minutes plus export and
cleanup margin. The separate service/browser rehearsal remains required. This scheduling exception does not establish
that every remaining stage will fit; insufficient time leaves the campaign incomplete.

The owner subsequently requested a fully unattended overnight run and explicitly
delegated urgent incident handling to Codex. This supersedes the reachable-owner
condition for this synthetic runner attempt. Notifications remain in this chat;
an owner reply is not required for bounded incident containment. The single unused
attempt, $15 pre-tax cap, eight-hour maximum, unchanged thresholds and production
Usage-off restriction remain binding. Do not create a replacement VM, extend paid
time, retry a failed campaign, discard failures or activate production Usage.

The selected overnight proposal is October 12 at 21:00 through October 13 at 05:00
Eastern (October 13, 01:00–09:00 UTC). Complete host and recovery preparation first;
generate the fresh fixtures after midnight and admit the measured campaign only
within one school-local date, with at least 240 quiet minutes plus evidence-export
and cleanup margin. Both MFA sessions must cover the absolute stop plus 15 minutes.
This proposal starts no VM and does not satisfy CI or native admission. If those
gates or the remaining window cannot be proven, retain the unused attempt.

For unattended incidents, stop measured work and request compute stop when a gate
fails, the deadline/cost bound is uncertain, isolation or evidence custody fails,
or recovery cannot prove convergence. Reconcile uncertain resource outcomes by
exact run ownership, retain all failures, and prove native stopped state. Keep
the existing host shutdown timer and independent owner-side deadline monitor.
Destroy resources only after the existing two-copy independent custody gate;
otherwise retain the sole evidence copy under the bounded retention policy.

The initial implementation packet bound these immutable historical identities:

| Binding | Exact identity |
| --- | --- |
| Baseline source | `d54827aefd7b7fdccae63a7d81c888c294a195f7` |
| Candidate source | `cc98ab83b81b7a4a3767d5d801daae5ab279381a` |
| Canonical harness source | `b9383a63ebe9065da01e7f0cbebdb40a008ad7c3` |
| Freeze SHA-256 | `4647a9c6e800514b47ddb1a4c6161042f9702368c5ed0560d276fa64417fdfbe` |
| Baseline image root | `sha256:8d208dd1986a9d57490cc9e98c62c0efb96026b9b5bcea65b71e9701f42b20ee` |
| Candidate image root | `sha256:c0a256aea0ccc1fc65c135a98faecd00c4118f30ac65fa971a5584220fd9790f` |

Helper images, selected OCI descriptors, migration checksums, schema, frontend and
synthetic-client bindings remain in the original
[binding summary](releases/usage-activation/linux-runner-plan-bindings.json).
All seven local images were exported without rebuilding or publishing them.
Independent verification checked the frozen roots and complete selected Linux/amd64
graphs. Omitted foreign-platform blobs and the resulting strict full-graph failure
are retained; native Linux import must still prove the canonical image assertions.

### Current-production source successor

Production advanced before the attended window. Its actual API190 and worker206
task definitions declare source `30bd7048c08e4d55eefa6cf4471504baeffcbf0a` and
image `sha256:4bbc9d48887852db21f6f191f8d9f3dc2071ab5f9e569dc155d56c325802651c`.
PR #646 was updated against that source; its CPU candidate is
`42d5e209f6d7ff4845a35b0c81c49e95924f7d2e`, image
`sha256:c186373bd432771b1c1a0c84decbb0bfe16835f3fbf6d10aa23fdebed7fb6a1e`.
Both now have independently reviewed native 53-migration/129-table proofs and
canonical security scans with zero High/Critical findings. The earlier candidate
layer-hash refusal remains failed; a separately reviewed preparation successor
proved all runtime contents equal except the expected CPU JavaScript/source-map
change and enumerated COPY timestamps. This grants no performance acceptance.

Harness `d9c45a6ed21ff508045fd6c137e9535f6f8a46ae` adds the separately reviewed
baseline ledger to paired declarations, arm-A reservations and receipt reloads.
The controller now requires both source envelopes and verifies each source's
checkout, complete ledger, schema, image binding and helper preparation. Historical
unbound-baseline contracts remain available in their original harness. All 192
canonical harness tests pass, and all 19 exact-head harness CI checks passed.
The application/harness freeze is sealed as
`3b2768c1227bdf6f69a00366b84da60f6776a0c4963e03174de4093e8929de8d`.
The controller still requires its updated exact-head CI and separately reviewed
input/launch packet. Workloads, paired ordering,
concurrent workers and acceptance thresholds are unchanged.

Source restoration now requires an explicit native receipt and independent review.
Admission uses the pinned root-owned Git binary with isolated configuration,
verifies exact generated metadata and all transferred objects, and checks canonical
index modes separately from private 0600 working files. The two Android `gradlew`
entries retain their original Git 100755 modes; `core.fileMode=false` preserves
private working permissions. Exactly the three frozen heads form declared shallow
boundaries, with literal parent identities retained and parent history excluded.
This is a transport boundary, not a source rewrite or native restoration pass.

The preceding harness CI failed while removing a disposable unit-test Git
directory with `ENOTEMPTY`; that run remains failed. The successor disables
optional background Git housekeeping in that fixture and permits only three
filesystem retries with a 100-millisecond base delay during guarded teardown. All 19
release-binding tests passed independently with concurrency four. This change
does not alter release assertions or native acceptance cleanup requirements.

The fresh standard candidate frontend is built from the exact candidate source
without production configuration. Its 171 files and native build provenance passed
independent archive replay. This does not identify the currently served frontend
or complete the required browser recovery rehearsal. Older frontend receipts,
the unsuccessful public identity request and all prior failures remain retained.

## Verification and remaining admission

The actual owner-side age canary passed both input and return roundtrips with
distinct private identities. Two private copies passed fresh independent replay
and complete rehash. This proves local custody tooling; it does not prove SSM/SFTP,
Linux recovery, capacity, production readiness or human operational approval.

Post-merge main CI found a load-harness test timeout. The test now uses the existing
cold-start handshake before its unchanged five-second execution/shutdown watchdog.
Its accounting assertions and harness behavior remain unchanged. Focused checks
passed normally and with an injected 4.5-second child startup delay. Full CI for the
implementation remains required.

**As of October 12 at 19:03 UTC, no paid VM or production change has been made.**
The owner MFA device and temporary owner session have been verified, Session Manager
client version 1.2.896 is installed, and the runner-scoped IAM setup for the prior
preparation window was installed.
The latest direct runner-role session remains unproven: its authentication dialog
stopped before an STS request after its native access snapshot expired at 18:52 UTC
and its launch grant expired at 18:55 UTC. Neither expired binding authorizes a launch.
The independently reviewed failure and resource-absence assessment has SHA-256
`e45766cf263ce005d658dfc31b129e80933e0bfe32eb4fd87f65823642c4d793`;
the single paid attempt remains unused. Production Usage remains off/off.
The initial lack of an MFA device, temporary profile and installed client is historical.

The later direct runner-role sign-in succeeded at 19:27 UTC. Its a4 launch grant
expired unused at 19:55 UTC; that successful authentication does not revive the
expired grant. The exact expired a1/a2 IAM installations have since been removed
with independently replayed native absence proof. No paid VM has started. A new
reviewed launch scope must preserve the owner's 02:45 UTC October 13 absolute stop,
the single unused attempt and $15 pre-tax ceiling. No further authentication
should be requested until its concrete source and launch packet are ready.

Provisioning still requires a fresh, reviewed scope, verified direct runner-role
session and exact source/CI bindings for the selected shorter window.
The fixed read-only discovery operation captures installed AMI facts on the one
authorized VM under its original stop deadline. Complete native package and SSM-agent
pins and the exact reviewed implementation packet before bootstrap. Scoped operator
access is a separate prerequisite; rendering its policy
does not narrow the existing deployment identity's permissions. The cloud guard
requires installed owner tool hashes.

After authenticated preparation, require native encrypted-volume, isolation,
durability, exact image import, full dist inventory, fresh fixture/restricted-restore,
transport and dual-copy evidence proofs. Establish the actual dated quiet window and
fresh source/production-off captures before measured admission. The service/browser
candidate-to-baseline-to-candidate rehearsal remains independently required. No
historical failure is promoted to a pass, no old fixture is redated, and no CPU
benefit is asserted before the unchanged Linux comparisons pass.

This successor authorizes no production deployment, Usage activation, schema change,
Terraform apply or ClassPilot extension publication. Each production activation
still needs its exact separately approved plan and window.
