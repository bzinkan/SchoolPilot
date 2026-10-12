# Linux Usage acceptance runner

This is the implementation successor to the [reviewed runner plan](../../../../docs/USAGE_LINUX_ACCEPTANCE_RUNNER_PLAN.md). The owner authorized one attempt with a **$15 pre-tax cap** on October 12, 2026. Production Usage remains `off/off`. No command in this directory deploys SchoolPilot, changes a product switch, publishes an extension, or applies Terraform.

The retained Windows comparisons and failed browser rehearsals remain failures/inconclusive evidence. A Linux VM does not establish a CPU improvement or release readiness. The frozen canonical harness remains `b9383a63ebe9065da01e7f0cbebdb40a008ad7c3`; candidate `cc98ab83b81b7a4a3767d5d801daae5ab279381a`, baseline `d54827aefd7b7fdccae63a7d81c888c294a195f7`, source/schema/image contracts and all thresholds are unchanged. Synthetic Usage profiles enable their existing synthetic Usage settings; production stays off.

## What runs where

| Tool | Principal and purpose |
| --- | --- |
| `acquire-session.ps1` | Owner, PowerShell 7.5: acquire a temporary session using an already attached MFA device. It does not enroll MFA or overwrite global credentials. |
| `cloud.mjs` | Owner: validate the private packet, provision one isolated VM, send the exact bootstrap document, inspect, stop, and reconcile exact owned cleanup. |
| `operator-scope.mjs` | Pure renderer: exact per-run IAM trust, managed identity grants, operator and SSM-only instance boundaries; validate independently captured native IAM policy/session bindings. No AWS calls or credentials. |
| `discovery.mjs` | Fixed read-only SSM operation: capture the exact AMI's installed package and SSM Snap baseline on that same VM before final bootstrap pins. No install or load. |
| `bootstrap.sh` | Root, Ubuntu: verify pinned packages/tools, mount exact encrypted data storage, install isolation, loopback SFTP, durable execution and management-finalization units. It never starts a campaign. |
| `evidence.mjs` | Owner/root: streamed, no-clobber bundles, pinned age encryption, strict permissions, complete manifests and fresh independent replay. |
| `canary.mjs`, `canary-replay.mjs` | Owner: actual two-key age roundtrips and two private custody copies of one harmless retained failure. This proves local tooling, not Linux transport or capacity. |
| `stage-input.mjs` | Linux root: copy exact SFTP-owned ciphertext without following links, decrypt/verify in root-private staging, then place approved members under UID 1000. No archive execution or image import. |
| `relocation.mjs` | Linux UID 1000: verify append-only path relocation against immutable original bytes. |
| `prepare-fixture.mjs` | Linux UID 1000: generate a new canonical fixture and collect native restricted-restore facts. Never redate an old snapshot. |
| `preflight.mjs` | Linux UID 1000: independently reload source, Git objects, image descriptors/imports, native fixture and separately reviewed host/readiness proofs. |
| `run-campaign.sh`, `run-campaign.mjs` | Durable systemd unit, UID 1000: verify fixed controller/admission bindings, then run the original eight stages and 30 attempts serially. |

All private JSON inputs use absolute paths and SHA-256 pins. Receipts stay outside the public repository. Windows mode bits are never accepted in place of the repository's actual ACL checks. Set `SCHOOLPILOT_CUSTODY_PWSH_PATH` to the pinned installed PowerShell 7 executable on Windows.

## Paid preparation packet

The cloud CLI is:

```text
node scripts/load/usage/linux-runner/cloud.mjs <action> <absolute-private-request.json> --request-sha256 <reviewed-sha256>
```

Actions are `validate`, `provision`, `discover-ami`, `collect-discovery`, `prepare-bootstrap`, `bootstrap`, `inspect`, `stop`, `cleanup` and the detached `watch-deadline`. `validate` creates no cloud resources. A fresh immutable request is required when adding an exact saved state or custody inputs; preserve the previous request. Containment reuses the pinned tool/session and exact resource identities without requiring unrelated price, source or review files to remain available.

The request's base schema is enforced by `validatePlan` in `cloud-plan.mjs`. It fixes us-east-1, one On-Demand m7i.4xlarge, the exact Canonical-owned AMI, encrypted 30/200 GiB gp3 with baseline IOPS/throughput, at most eight hours, 20 GiB export, seven failure-hold days and $15. A separately bound later launch may shorten the window while retaining its approved absolute stop. `activeHours` remains eight for the conservative pricing ceiling, and the launch grant expires at the earlier of ten minutes after the start or the stop. `stopUserData(plan)` produces the only accepted initial user-data bytes. It installs the absolute host stop timer before bootstrap. Both disks have `DeleteOnTermination=false` until custody permits exact deletion, including failed preparation evidence on root.

The private packet additionally pins:

- AWS executable, separate `usage_linux_assumed_operator_session` receipt and actual AssumeRole response; the exact account/caller and assumed-role ID must match native STS. The receipt binds the original MFA session, exact rendered scope, native IAM snapshot and expiration. Credential expiry must cover the stop deadline plus fifteen minutes. The broad `schoolpilot` MFA profile is the attended setup/read route and is never the runner's effective principal.
- Implementation manifest, a matching independent review with no unresolved findings, and the owner's one-attempt authorization bound to that run and implementation. A hash of a failed or unrelated review cannot admit provisioning.
- `operatorAccess`: a private `usage_linux_scoped_operator_access` review, bound to the exact run/caller and hash-bound native policy inputs, rendered scope and native IAM snapshot, with `effectiveScope:runner_only`, no findings, named reviewer and capture within ten minutes. Native proof requires the exact attached identity-policy chunks, no inline grants, immutable version-1 policies, both fixed boundaries and the MFA-only trust. An MFA session alone does not narrow broad deployment privileges.
- The exact AWS-managed EBS key ARN, private native `DescribeKey` response and native `ListAliases` proof that `alias/aws/ebs` targets that key. Both launch mappings explicitly name this key, and both native volumes must match it; a regional default that later drifts cannot silently choose another key. Identity and boundary allow only its EBS encryption operations through EC2 in this account/region, with AWS-resource grants; direct KMS calls and customer-key administration remain unavailable.
- Refreshed raw price snapshots and calculations, complete tool/package bindings, the nonsecret bootstrap template and its reviewed fixed controller config.
- Installed hash-bound owner tools: `aws`, `node`, `age`, `ageKeygen`, `ssh`, `sftp`, `sessionManagerPlugin`, plus `pwsh` on Windows. A downloaded installer is not an installed client; resolve local prerequisites before starting paid time.
- Actual local age input/return roundtrip chains, both independent custody replays and both still-valid private copies.

`verifyPacket` defines the exact private record fields. Installed executables are regular non-reparse hash-bound files; secret receipts separately require owner-only permissions. Hash all source bytes after checkout/line-ending conversion. Linux shell files are committed with LF. Do not substitute example hashes, guessed AMI Snap revisions, package counts or `passed:true` summaries for raw evidence.

Provisioning records every request/result privately and uses one RunInstances call with a unique ClientToken. It adds no ingress, NAT, peering, bucket, registry, customer KMS key or paid log pipeline. The instance role has only SSM registration and message-channel actions, with a separately created fixed permissions boundary that the operator cannot change or remove. Before RunInstances, reload its exact boundary, trust, inline policy, empty managed attachments and profile membership. The separately rendered operator grants restrict mutations to the run's four exact tags, account, region, IAM names and document closure. Only the named owner with MFA can assume its nine-hour role, and the role cannot edit itself, its managed grants or either boundary.

AWS IAM does not enforce an aggregate dollar ceiling, total volume capacity or one invocation of RunInstances. The immutable controller's one-call/one-instance ClientToken, exact two-volume mappings, eight-hour stop and owner monitor remain necessary. The IAM launch grant additionally expires after the initial ten-minute window. Exact EC2 Describe metadata actions require `Resource:*`; the private scope explicitly records this read-only exception. No user data, console output, secrets or command outputs are granted. The fixed cleanup lease expires at the seven-day retention deadline.

A detached owner monitor must authenticate and acknowledge its exact request before paid launch. At the absolute deadline it discovers uncertain launch outcomes by exact run tags and requests stop with bounded retries. It reports stopped only after native state proves it. Timer/transport/state failures remain incidents; a stop request alone is not proof of stopped compute. Never extend the deadline or create a replacement VM automatically.

## Preparation and transfer

Provision only with `preparationStage:ami_discovery`, `tools.linux.phase:pending_native_ami_discovery`, `ssmAgent:null`, `unresolvedPins:[ssmAgent,ubuntuDebClosure]` and no bootstrap template. The exact AMI, known tools/source/controller, custody, scope and cost are already bound; missing installed-AMl facts remain explicit. After SSM registration, `discover-ami` sends the fixed parameter-free identity/package query. AWS cannot resource-scope `GetCommandInvocation`, so the runner role receives no such grant. An attended owner read captures only this exact command/instance response through the separate source profile. `collect-discovery` consumes the private hash-bound `ownerCommandCapture`, native request, caller, invocation and independent review within ten minutes, then checks the exact command, instance, document version/hash, success and bounded compressed output. It installs nothing and starts no traffic. Resolve/review the package closure against that actual baseline, then create a new `bootstrap_ready` packet (`tools.linux.phase:bootstrap_ready`, no unresolved pins, exact bootstrap template, original saved state and pinned `amiDiscovery` invocation). `prepare-bootstrap` binds the bootstrap document for that **same** instance, volumes and original deadline. It never calls RunInstances or extends paid time.

The bootstrap document is parameter-free and bound to its immutable AWS document version and SHA-256. `bootstrap` re-fetches those exact bytes before sending it. After its command is complete, invoke the separately reviewed fixed operation that starts `usage-management-finalization.service` asynchronously. That unit moves SSM state/logs to retained data storage and restarts the agent. Prove a **new** authenticated command succeeds before admission; the unit's local receipt is not that proof.

The custom Session document uses the same Port transport as `AWS-StartPortForwardingSession`, fixing owner loopback port 2222 to runner loopback SSH port 22. This narrows the standard document's arbitrary-port parameters. Public SSH and ToRemoteHost are not allowed. Independently obtain the server's full public host key and input age recipient through the pinned authenticated SSM identity channel. Verify those fingerprints before SFTP. Never use `StrictHostKeyChecking=no` or accept an unauthenticated keyscan as trust.

The SFTP account sees ciphertext only. Upload the exact approved bundle, then invoke reviewed privileged placement using `stage-input.mjs`. All privileged copies and ownership changes stay under root-private staging. A mandatory native syscall probe precedes atomic, no-replace publication into the executor's work directory; no privileged writes follow publication. Its return private identity always stays on the owner machine. Safe archive/Git-object extraction, immutable image import, native descriptor comparison, locked Linux dependency installation and fixture generation all precede measurement. Retain their raw failures and inventories. The pinned Docker containerd image store must preserve the frozen OCI roots and canonical `image.Id`/`container.Image` assertions; an import mismatch is a hold.

The static root-owned controller config names `/srv/usage/work/active-request.json` and `/srv/usage/control/launch-admission.json`. The separate root-owned admission record binds the fresh request hash after actual host/fixture/window review. Create a new parameter-free launch document with `launchDocument()` only at that point; it checks the static config, fresh admission record, bootstrap and deadline hashes before starting the unit. Provisioning deliberately does not create a campaign launch document. Place the reviewed wrapper/config and UID1000 controller modules through an exact hash-bound privileged operation, not an arbitrary SFTP shell.

## Measurement and closeout

The measurement CLIs are:

```text
node relocation.mjs verify <request.json> --request-sha256 <reviewed-sha256>
node prepare-fixture.mjs prepare <request.json> --request-sha256 <reviewed-sha256>
node preflight.mjs verify <request.json> --request-sha256 <reviewed-sha256>
node run-campaign.mjs execute <request.json> --request-sha256 <reviewed-sha256>
```

The campaign requires separate reviewed intent and actual dated admission records. Preserve the eight-attempt paired order `A,A,A,B,B,A,A,B`, all CPU/p95 limits, concurrent reports/workers, 20/48-second report/worker limits, three cold runs, distinct64, and both three-run 800-client variants with actual server loss. Stop at the first failed/inconclusive gate. The service/browser candidate→baseline→candidate rehearsal remains a separate required operation; a successful capacity run does not close that blocker.

No measured entry is admitted with missing native host-isolation/durability/import proof, stale fixture, stale source/production-off capture, unreviewed source change, insufficient quiet time or missing/unreviewed custody and blocker proof for the failed recovery pack. Capacity cannot clear the separate recovery release blocker. Resolve the full Ubuntu package closure and actual pinned SSM Snap state before bootstrap. If actual host facts differ, stop and review within the existing paid deadline. No example request authorizes load.

Before `cleanup`, export all raw host/campaign/recovery outcomes in encrypted return bundles, decrypt/hash and independently replay two private copies. The cleanup request supplies `custody.copies` (root, pinned manifest, canonical manifest hash), a pinned replay script and private `custody.replayReview`. The schema-1 `usage_linux_cleanup_replay_review` binds the script's `subjectSha256`, both `manifestSha256` values, named reviewer, review time within 24 hours, `passed:true` and zero unresolved findings. Cleanup rechecks the script before and after fresh invocation for each copy; a pre-filled successful receipt is insufficient. The harmless canary replayer cannot approve campaign evidence.

Cleanup first reconciles exact unique-run tags, including uncertain Create responses and pre-instance failures. It requires stopped/terminated compute, then verified detachment/custody before deleting each exact disk. Every completed deletion is retained; a retry re-reads current exact-tag inventory and handles proven absence. Network, instance IAM and all nine permitted SSM document names are freshly rechecked. The scoped operator cannot delete its own role/grants: the result remains `runner_resources_deleted_operator_scope_closeout_and_cost_pending` until the attended owner separately deletes and proves absence of the exact setup-created operator role, managed identity policies and both boundaries. Cost reconciliation also remains pending until actual charges are recorded. A custody failure stops compute and retains disks, with day-six escalation and a seven-day decision deadline; expiry never deletes the only copy.

## Verification

```text
node --test scripts/load/usage/linux-runner/*.test.mjs
node --test scripts/load/usage/release-gates-v2/*.test.mjs
```

These tests use private files, mocked AWS/firewall operations and contract fixtures. They provision nothing and run no database/load traffic. CI runs both suites. Actual MFA acquisition, Linux bootstrap/transfer/denial probes, restricted restore, measured campaign, recovery, resource deletion and final billing each need their own native receipts.
