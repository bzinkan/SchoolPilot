# Linux runner for the full Usage acceptance campaign

Status: **proposed for review; execution and spending are not authorized**.
Planning date: October 11, 2026, America/New_York. Public price research was
captured October 12 UTC. This proposal prepares an isolated synthetic runner;
production Usage remains `off`/`off`, and every existing acceptance limit stays
fixed. No resource, workflow, fixture, load run or production operation is created
by this document.

The [activation policy](CLASSPILOT_USAGE_ACTIVATION.md) and
[original readiness contract](RELEASE_297_DEPLOY_READINESS.md) remain authoritative.
Readiness currently says “do not provision paid resources.” This proposal requires
a **later explicit, bounded exception for this runner**, plus approval of its exact
implementation and quiet window. Neither accepting this document nor passing
synthetic acceptance authorizes deployment, production queries, Usage activation,
Terraform, extension publication or a merge.

## Decision proposed for review

Use one short-lived **EC2 On-Demand `m7i.4xlarge`, Linux x86-64, us-east-1**:
16 vCPU, 64 GiB RAM, a 30 GiB root and 200 GiB data gp3 volume, both encrypted.
Use the included gp3 baseline of 3,000 IOPS / 125 MiB/s on each volume. Allow eight
active hours, one public IPv4, no NAT gateway, no new registry, S3 bucket, customer
managed KMS key or paid log pipeline. Use the AWS-managed EBS key, binding its
actual identity privately. Keep all campaign state and Docker data on the data
volume, including private service journals needed after root-volume deletion.

The retained campaign's peak container limits sum to 11 CPU and 13.25 GiB. This
size leaves room for the host and controller without changing any container quota.
Check imported image, fixture, restore and evidence peak storage before admission;
200 GiB is a budget to verify, not a measured requirement. This VM is exclusive to
the workflow, on shared tenancy. It is not a dedicated physical host or a guarantee
of stable controls. The unchanged comparison rules determine whether it passes.

| Option | Capacity and operating limit | Estimated compute | Disposition |
| --- | --- | --- | --- |
| EC2 `m7i.4xlarge` | 16 vCPU / 64 GiB; proposed eight-hour limit | $0.8064/hour | Preferred for an attended, durable campaign |
| GitHub larger Linux runner | 16 vCPU / 64 GB / 600 GB; six-hour job limit | $0.042/minute: $10.08 for four hours, $15.12 for six | Requires an eligible Team/Enterprise organization; eligibility is unverified and the six-hour limit does not fit this eight-hour budget |
| Standard GitHub public Linux runner | 4 vCPU / 16 GB / 14 GB | Free standard public-repository jobs | Insufficient CPU and disk headroom for this frozen campaign |

GitHub larger runners are charged even for public repositories. Capacity, access
and job limits come from [GitHub runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[larger runner access](https://docs.github.com/en/actions/concepts/runners/larger-runners),
[Actions limits](https://docs.github.com/en/actions/reference/limits) and
[current runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing).

## Cost and expiry

The quote uses Linux shared-tenancy On-Demand pricing in us-east-1, no Spot,
reservation, credits or account-wide free-transfer assumption. Refresh the quote
at approval. The exact public EC2 price row is rate
`NQPHP68K4VGS8SQ7.JRTCKXETXF.6YS6EN2CT7`; regional storage is $0.08/GB-month.
Use the [captured AWS regional price list](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json)
and [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/).

| Charge | Four active hours | Eight active hours |
| --- | ---: | ---: |
| Compute, $0.8064/hour | $3.2256 | $6.4512 |
| 230 GiB gp3, $0.08/GB-month, 720-hour planning month | $0.1022 | $0.2044 |
| Public IPv4, $0.005/hour | $0.0200 | $0.0400 |
| Base subtotal | **$3.35** | **$6.70** |

Reserve a further **$2.00** for at most 20 GiB charged Internet outbound
(`20 × 2^30 / 10^9 × $0.09 = $1.9327`), **$3.7333** for a failure-only additional
seven-day hold of the 200 GiB data volume, and **$0.10** contingency for KMS
requests if applicable. These eight-hour charges and reserves total **$12.53**.
Also reserve **$0.56** if custody prevents prompt deletion of the 30 GiB root for
seven days, and **$0.11** if separately priced account-level SSM just-in-time node
access is already enabled. With both contingencies, plan for **$13.20** and propose
a **$15 total pre-tax approval ceiling** for one attempt, including custody failure.
This excludes existing account/support/subscription fees and applicable taxes.
No automatic repeat, extra volume, paid IOPS/throughput, snapshot or replacement
instance is included. A later retrieval VM would need a new quote/approval.

The gp3 rate comes from the [captured AWS storage price list](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ebs.json).
Storage proration follows the 30-day example in [EBS pricing](https://aws.amazon.com/ebs/pricing/).
The address rate is in [VPC pricing](https://aws.amazon.com/vpc/pricing/); the
outbound rate is in the [captured AWS data-transfer price list](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/datatransfer/USD/current/datatransfer.json).
[Session Manager and Run Command](https://aws.amazon.com/systems-manager/pricing/)
have no additional standard EC2 session/command charge; account-level optional
features have not been queried. Paid service additions require a revised quote.
Retained price snapshot and research hashes are in the binding summary. If actual
evidence exceeds the 20 GiB export budget, preserve it and obtain a revised transfer
approval; never discard records or call a partial return complete to fit the quote.

Implement a host shutdown timer and an independent operator-side deadline monitor
before admission. Bind EC2 instance-initiated shutdown behavior to `stop`; verify
that it stops billing for compute rather than merely halting the guest. Reserve
the last hour for drain, encrypted export and custody verification. At eight hours,
stop compute even if custody is incomplete. A separately scoped operator operation
may detach the exact data volume and terminate the instance/root/address after
proving all evidence is on that volume. Set the data volume's
`DeleteOnTermination=false` before execution; never make expiry delete the only
copy of a failed run. Alerts and cost estimates are not an AWS-enforced billing cap.

Record an exact UTC retention deadline no later than seven days after the stop,
the accountable owner and a reachable escalation route. Escalate unresolved custody
by day six for an explicit retrieval, retention-budget or deletion decision before
the deadline. This plan grants neither indefinite storage nor automatic deletion
of unexported evidence. A delay or timer failure is an incident/approval exception,
retained as a blocker. Verify actual resource deletion and final cost separately.

## Frozen source and artifact bindings

The [public binding summary](releases/usage-activation/linux-runner-plan-bindings.json)
contains full SHA values and content-free provenance hashes. It is **not** an
executable source binding or an approval. The complete inventory, source reviews,
private paths, migration ledger, image provenance and fixtures remain outside Git.

| Role | Git SHA | Bound image identity |
| --- | --- | --- |
| Planning main / original frontend source | `e179d1554f44d9b2fca17a2745b987f1c813f176` | Frontend tar SHA-256 `f2562d6ba46c5f1d261611bd4024a54d1ff061f03a1872429b1996c33247f264` |
| A: retained production-source / compatible recovery candidate | `d54827aefd7b7fdccae63a7d81c888c294a195f7` | Registry index / local ID `sha256:8d208dd1986a9d57490cc9e98c62c0efb96026b9b5bcea65b71e9701f42b20ee` |
| B: CPU remediation [PR #646](https://github.com/bzinkan/SchoolPilot/pull/646) | `cc98ab83b81b7a4a3767d5d801daae5ab279381a` | Local ID `sha256:c0a256aea0ccc1fc65c135a98faecd00c4118f30ac65fa971a5584220fd9790f` |
| Harness [PR #645](https://github.com/bzinkan/SchoolPilot/pull/645) | `b9383a63ebe9065da01e7f0cbebdb40a008ad7c3` | Contract/profile hashes in the binding summary |

At the read-only planning checkpoint, #646 and #645 are open; #646 has 18 passing
checks and the expected AWS safety skip, and #645 has 19 passing checks. Neither
has a recorded formal review approving execution. These are prospective candidate
bindings, not final-main release certification. Refresh PR/review/CI/main state
before execution. After merges, bind exact resulting-main CI and application,
frontend, migration and recovery artifacts; refresh affected acceptance. Any claim
of unchanged application bytes needs its own reviewed derivation. Do not alias a
new SHA to an old pass.

A has a proven amd64 manifest
`sha256:70588efc74652d13b42e23acee02183369aba8e141394b04026493c89586f5b6`
and OCI config
`sha256:aa6798fd1e339804a07ff2a3927bd2d46d105239ef8ab681ee598de06b603ff0`.
B's actual OCI config is
`sha256:4849647dfeeb6816b95dc08403c07692b31f3bf75295eb1c15d2d333078f0183`;
its retained record proves no registry publication. Helper, PostgreSQL and Redis
local IDs are also recorded. Missing actual index/platform/config/archive custody
proof is an execution hold. Registry publication and pull references can remain
explicitly not applicable when exact archive transfer is selected; this proposal
does not require publishing B or helpers. A bare local SHA is not a pull reference.

For Linux transfer, export existing immutable images with index, platform manifest,
config and layers intact; hash archives before/after transfer and independently
verify imported descriptors and actual `image.Id` / `container.Image`. The existing
helper field `helperConfigDigest` stores `container.Image`, not an extracted OCI
config digest. Do not flatten indexes, rebuild images, pull moving tags or substitute
config digests to make the canonical assertions pass. A store mismatch requires a
separately reviewed tooling remedy and fresh affected evidence before measurement.

B uses the reviewed **expand** stage, all **53 exact migration/checksum rows**,
zero contract-ledger rows and the 129-table admission inventory. The migration
manifest hash is `02fed8ccc8937d5568d3e25ff4054a523f96dd352aaf5ed23e04621e32dcd1bd`.
Validate every ledger entry, registry, privilege and native schema fingerprint;
neither a count nor a historical 54-migration fixture is sufficient. A retains its
own separate baseline schema and strict native fingerprint. No production catalog
parity is claimed.

Preserve raw source archive member bytes, including CRLF/LF, exact Git objects,
HEAD/tree and clean detached checkout state. The source-binding validator checks
raw working inputs in addition to Git identity. Install locked host dependencies
on Linux and bind actual executable/dependency hashes; do not transplant Windows
`node_modules`. Reuse the exact bound frontend tar with its 171-file inventory and
reviewed unchanged-input derivation. The paired client's pinned 2.9.6 advertisement
is a synthetic comparison input, not a claim about the live 2.9.7 Store release or
managed-device adoption. No extension upload is proposed.

Create a separately reviewed, append-only **Linux relocation sidecar**: original
record hash and path, resolved destination, byte length and raw before/after hash
for every input, plus field-level path/endpoint changes. Keep sealed Windows
records unchanged. New Linux launcher/controller/admission/options, reservations,
run IDs and output roots must have new hashes. The old launcher has absolute
Windows imports; copying it alone cannot run the campaign. Review a Linux-native
or PowerShell 7 successor, proving unchanged profiles, ordering, concurrency,
deadlines and all 30 attempts. Bind a local Unix Docker endpoint accepted by the
canonical runner; never mount the Docker socket into measured containers.

The host implementation packet must bind an exact AMI ID and owner, architecture,
OS/kernel, CPU topology, memory/swap, cgroup controllers and effective quotas,
Docker/client/API/containerd/runc/image store, clock, host Node/npm/locked dependencies,
PowerShell if used, SSM agent/plugin, OpenSSH and age binary versions/checksums.
Container Node remains the retained `v22.23.3`. Linux host values are unresolved in
the summary and block launch; historical Windows Node/Docker values do not fill them.

## Fresh fixtures and quiet windows

Generate a new canonical exact-source fixture for the selected school-local date
after implementation review. The retained snapshot was prepared for **2026-10-11
America/New_York**; its earliest control expiry is **2026-10-12T07:19:17.759Z**.
The snapshot's database export/restore timezone is separately `UTC`. It is
historical evidence, not an approved Linux fixture. Never redate it or extend
its control/session leases. Independently check every authority horizon, including
school/license/control/teaching/session expiry, through the actual run horizon.

Retain and rehash all nine snapshot payloads, native restricted restore, exact
ledger/admissions/RLS/schema proof, two synthetic schools with one million stored
observations each, original ingest checks, SQL/error capture and unforced cleanup.
Every cold run restores afresh with no other clients and rechecks current date and
authority. Distinct64 uses another fresh restore and the three accepted cold receipts.
Cold means PostgreSQL restart/buffers; do not claim host filesystem caches are cold.

No dates are declared by this planning review. Later record an attended operator,
second reviewer, owner notification route, exact UTC/EDT start/end, exclusive runner
reservation, source/fixture/helper freeze and the owned resource baseline. Reserve
eight hours: up to two for bootstrap/import/preparation, at least four for the
serial campaign, one for export/replay and one contingency/drain hour. Stage timing
is a planning estimate; do not shorten runs to fit it. Start only with **at least
240 quiet minutes remaining plus export/cleanup margin**, fresh readiness inputs
within the launcher's ten-minute limit, and valid fixtures through late stages.
Do not cross school-local midnight without a reviewed valid fixture strategy.

The existing source/production-off readiness capture stays on the separately
authorized operator path. Give the runner only reviewed, bounded nonsecret metadata,
never production credentials. This task performs no new production inspection.
Schedule service/browser recovery serially in a separate approved slot if it cannot
fit; additional paid time needs a new approval. Declare actual windows only after
all admission holds below are cleared.

## Secure execution and evidence custody

Use a new isolated VPC/subnet/security group with no inbound rules, peering,
production private-network routes or production secrets. A public IPv4 supports
management transport. Bind host outbound rules for approved SSM endpoints, DNS and
time, and close bootstrap download access before measurement. Do not claim the
host lacks an Internet route. Enforce separate container denial of Internet,
host-management and metadata access before any API starts.

Preserve the frozen `--network container:<owned PostgreSQL ID>` topology, loopback
API ports 4001–4003 and every resource/role argument. Use reviewed host INPUT and
Docker forwarding rules, including the effective DOCKER-USER path where applicable,
to block all measured network paths to management, external forwarding and
`169.254.169.254`; disable IPv6 or block its paths including `fd00:ec2::254`.
Include DNS-mediated egress in the negative probes. Require IMDSv2 and hop limit
one for host SSM, with actual container denial proof. Neither empty inbound rules
nor an internal bridge is sufficient isolation. Capture preflight denials and
successful canonical inter-role traffic without changing measured topology.
See [Docker firewall behavior](https://docs.docker.com/engine/network/firewall-iptables/)
and [EC2 metadata options](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html).

The owner uses short-lived MFA-backed operator credentials. Review a minimal
SSM instance policy for the pinned agent's required channels/registration; do not
blindly attach a broad policy that also grants Parameter Store access. The instance
receives no secrets, ECR, S3, provisioning, termination or production-service role.
Scope operator access to the exact tagged instance and approved SSM documents;
constrain IAM PassRole to that role and EC2. Bind the separate provision/cleanup
permissions and account/region/resource identities privately before approval.

Transfer ciphertext through **`AWS-StartPortForwardingSession` to that instance's
local port 22**, then SFTP to an sshd listening only on `127.0.0.1`. Deny the
ToRemoteHost document and public SSH. Use a dedicated nonroot SFTP-only account,
internal-sftp, no shell/PTY/password/root login, Docker membership or SSH forwarding.
Keep its ephemeral SSH private key on the owner's Windows machine. Independently
pin the server host-key fingerprint through the authenticated SSM identity channel;
never disable host-key checks. SFTP cannot launch the campaign: a separately scoped,
reviewed SSM command/document verifies the exact launch hashes and starts a durable
systemd unit with a private working directory and `umask 0077`.

The execution principal must match frozen helpers' UID 1000, or use an independently
reviewed exact ownership mapping. Use directories `0700`, private files `0600` and
no symlinks/path escapes. The separate SFTP account stages ciphertext only; controlled
privileged placement assigns execution ownership. Docker access is root-equivalent
and belongs only to the trusted attended controller, never a measured role. A
management connection drop must not kill the measurement or lose its private journal.

Use verified [age recipient encryption](https://github.com/FiloSottile/age) in both
directions. Provision an ephemeral input-decryption identity on encrypted data
storage; the owner encrypts the approved input bundle to its independently pinned
recipient. The **return recipient's private identity stays on Windows**, outside
the runner. Pin both recipient fingerprints and tool checksums before transfer.
Permit no real student/staff content, production dump, `.env`, cloud credential,
unreviewed Docker environment or existing development secret in a bundle. Use newly
generated synthetic secrets with no external authority. Do not print secret-bearing
argv, environment, inspect output or SQL bodies to PR/CI/chat/SSM output.

Before/after transfers occur outside measured intervals. Seal each bundle with a
private manifest of resolved relative paths, sizes and SHA-256 values. Include raw
logs, all attempts and errors, per-offer/SQL/CPU data, source/host/import/fixture
bindings, original outcomes, reservations, cleanup records and closure/reviewer
results. Assign unique campaign/run IDs, append-only receipt names and no-clobber
destination writes. Record both plaintext-manifest and ciphertext hashes, sender,
recipient, byte counts and authenticated transfer/session identity. Hashes prove
bytes; the authenticated custody record establishes their provenance.

After return, the owner decrypts into an ACL-checked private evidence root. A second
reviewer independently rehashes every member, verifies completeness against the
remote manifest, reloads receipts and replays the unchanged closures. Retain a
second encrypted copy in an existing owner-approved private repository with a
named retention/access policy; repository upload alone is not custody proof.
Record both storage references and successful decrypt/replay hashes privately.
Only content-free outcomes and hashes go into Git. No raw GitHub Actions artifact
or public log upload is part of this plan.

[SSM SSH/port forwarding](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html)
does **not log tunnel contents**. Retain CloudTrail session-control events and
separate private launch/file journals; do not represent them as a complete command
transcript. CloudTrail logging configuration/access and any added logging cost must
be verified in the implementation packet. Use an existing approved trail, without
creating a new paid pipeline under this quote.

## Acceptance remains unchanged

Run the complete eight-stage campaign serially on the same frozen Linux host. The
binding summary pins every selected profile and original controller/launcher hash.
The relocated successor must retain **30 actual attempts**, stopping on the first
failed or inconclusive stage, retaining it and leaving later stages unstarted.
No automatic retry or favorable subset selection is authorized.

| Order | Stage | Required attempts and workload |
| --- | --- | --- |
| 1 | Strict `sole-133` A/B | Eight in `A,A,A,B,B,A,A,B`; 133 clients, 798 offers, 13.3/s, 60 seconds, one API |
| 2 | Strict `normal-34` A/B | Same eight-attempt order; 340 clients, 2,040 offers, 34/s, 60 seconds, one API |
| 3 | Native capability-on classroom baseline | One canonical 34/s run with native command/private-message verification; Usage off |
| 4 | Native mixed classroom | Three consecutive 15-minute runs; 133 clients with five-minute one/three/two-API phases and actual loss; Usage off |
| 5 | Cold Usage | Three consecutive three-API runs; two million stored observations, 6,000 offers at 100/s, concurrent reports and workers |
| 6 | Distinct64 | One separate 64-distinct-endpoint campaign, bound to all three accepted cold receipts and a fresh restore |
| 7 | Ordinary 800 | Three consecutive 15-minute runs, 800 active clients, actual three-to-two loss and measured ordinary reconnect traffic |
| 8 | Concentrated 800 | Three consecutive 15-minute runs; all lost-task reconnects target one survivor, measured separately from ordinary traffic |

Preserve both control guards: CPU max/min **<=1.05** and p95 spread **<=50 ms**.
Median paired CPU/success ratio stays **<=1.05**, median p95 ratio **<=1.10** with
increase **<=50 ms**; each pair stays within **10% CPU increase / 100 ms p95
increase**. Every strict paired receipt retains p95 **<=500 ms**; the applicable
non-Usage CPU guard is **strictly below 60% quota in the exact 60,000 ms window**.
Paired CPU/success uses the whole owned API CPU, including the final classification
flush, as required by the canonical validator. Usage profiles retain recorded
CPU/p95 observations and their existing capacity deadlines; the validator does
not apply the non-Usage CPU/500 ms SLO to them. Reports stay **<=20 seconds**, heavy
workers **<=48 seconds**.
Keep all original correctness, persistence, authority/tenancy, acquisition,
statement, CPU/timing, drain and unforced-cleanup checks and native post-load
command/private-message checks. The 800 profiles retain 80 ordinary offers/s and
640 lost reconnect offers over eight seconds after their one-second delay, with
the original per-task distribution assertions. Reload each applicable campaign
closure, including the combined 800 closure, independently.

Production remains both-off. Synthetic Usage profiles deliberately enable Usage
inside the isolated test services; otherwise they cannot establish Usage capacity.
Do not reduce traffic, serialize concurrent workers, omit database errors, widen
budgets, pool controls across hosts or add profilers/observers to accepted intervals.
Clock/quota/canary defects require retained failed/inconclusive evidence and a
reviewed remedy, never a presumed host-interference waiver.

The two existing Windows comparisons remain inconclusive (CPU-control spreads
7.9583546% and 9.2613344%, above 5%); sixteen individually passing runs establish
zero accepted comparisons. The three failed browser recovery attempts also remain
release blockers. CPU cause/benefit is not established by moving hosts. Independently
review every new gate; a failed Linux gate keeps Usage off and produces a blocker
report. Any new remediation needs a separate reviewed change and refreshed checks.

After acceptance, separately rehearse **candidate -> compatible baseline ->
candidate** service/browser recovery with exact artifacts, native migration/RLS
continuity, graceful shutdown, real error/busy states and the unchanged administrator
walkthrough. Verify recovery compatibility before using A as fallback; source
ancestry alone is not proof. Preserve all failed rehearsal receipts. Production
guarded-off rehearsal and ledger observation remain later, separately approved
operations under the activation policy; a Linux recovery pass cannot satisfy them.

## Admission, implementation and review packet

Before requesting execution approval, complete the following in order:

1. Review the source/CPU change and harness change, refresh exact-head CI, resolve
   their source inclusion and bind the chosen final artifacts. Implement Linux
   relocation, admission, durable launch, permissions, firewall, transfer and
   expiry/cleanup in a separately reviewed change. Run canonical harness and
   portability/security negative checks without altering acceptance.
2. Produce the private exact implementation manifest: account/region/AZ, resource
   plan and tags, AMI/runtime/tool hashes, IAM/document policies, host/network/data
   controls, immutable transport/import proof, all source/schema/frontend/client
   bindings, reviewed scripts and independent review hashes. Resolve every `null`
   hold in the public summary in this new private record; never edit old receipts.
3. Bind the owner/operator/reviewer, MFA and notification route, input/output key
   fingerprints, two verified evidence destinations and retention/deletion dates.
   Validate local encryption/decrypt/replay, no-clobber writes and the static/mocked
   implementation controls before requesting paid provisioning. The actual host
   demonstrations follow provisioning approval in step 5. Preparation failures
   remain recorded. Cleanup must use exact resource IDs; no broad prune/delete.
4. Refresh the quote, storage/export size and time estimates. Obtain the explicit
   paid-provisioning exception with **one VM, eight active hours, $15 pre-tax,
   20 GiB outbound and seven-day failure-only data hold**, approved scope and
   exact deadline response. Scope this approval to provisioning and preparation;
   it does not admit measured traffic. A planning review supplies no such approval.
5. After authorized provisioning, demonstrate actual transfer/decrypt/hash/replay
   with a harmless canary, denied container management/IMDS/egress, UID permissions,
   connection-loss durability, quota/timing accounting and custody-safe expiry.
   Independently verify actual host, images, fixture generation/native restore,
   readiness freshness, exclusive ownership and full horizon. Any difference
   returns to review before load. Obtain the separate exact dated quiet-window and
   measurement admission approval against those receipts, within the existing
   eight-hour compute limit. Run the unchanged campaign and separately scheduled
   recovery; seal failures before deciding what can run next. Waiting for approval
   cannot extend the paid deadline automatically.
6. Decrypt, independently replay and establish both private custody copies before
   destructive closeout. Record actual resource absence, encrypted volume/key
   disposition, final charges and exact retained receipt hashes. Publish only a
   sanitized review summary, keeping activation and unresolved release gates closed.

Review completion for this proposal means the document, binding summary, price
snapshot references and independent design review are consistent. Runner launch
readiness, paid authorization, final-main acceptance and production readiness are
separate pending decisions. The Usage successor's historical/current gate records
are not promoted by this planning PR.
