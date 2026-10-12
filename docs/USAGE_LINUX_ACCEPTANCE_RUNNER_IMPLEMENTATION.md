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
provide one-attempt cloud lifecycle control, absolute eight-hour host and owner stop
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

The immutable application identities remain:

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

**No paid resources or production changes have been created by this preparation.**
Provisioning awaits an MFA-backed temporary session: the current deployment identity
has no attached MFA device. The owner selected an existing MFA-backed session; its
managed sign-in method is still needed because neither local profile is temporary.
The fixed read-only discovery operation captures installed AMI facts on the one
authorized VM under its original stop deadline. Complete native package and SSM-agent
pins and the exact reviewed implementation packet before bootstrap. Scoped operator
access is a separate prerequisite; rendering its policy
does not narrow the existing deployment identity's permissions.
The signed, pinned Session Manager Windows installer is staged; the client is not
installed in this non-administrator process. [AWS requires administrator rights](https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-windows.html)
for that installer. Complete that local prerequisite
before paid launch. The cloud guard requires installed owner tool hashes.

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
