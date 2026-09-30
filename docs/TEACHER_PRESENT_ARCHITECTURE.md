# Present to Class: hosting, security and cost decision

Status: DRAFT FOR BRIAN'S DECISION, 2026-09-30. No hosting choice, privacy approval,
spend, provisioning or media implementation is approved. This document prepares
the decision required by the canonical competitive roadmap; it is not a second
roadmap. All presentation flags/capabilities remain off and unimplemented.

## Recommendation and approval record

Recommend a one-school LiveKit Cloud Ship pilot with a proposed USD 75/month
incremental media budget, excluding tax, after privacy and revocation acceptance.
This is an engineering recommendation based on the estimates below, not an
approved subscription. A managed SFU avoids new always-running AWS media capacity
and provides a stronger documented revocation primitive. Revisit hosting if
residency requirements, measured costs or operating requirements invalidate it.

| Decision | Proposed value | Approval |
|---|---|---|
| Topology | Teacher screen -> SFU -> frozen authorized student audience | Fixed by product scope |
| Host/plan | LiveKit Cloud Ship; one school, no agents/telephony/recording | PENDING Brian |
| Monthly budget | USD 75 incremental media service, exclusive of tax | PENDING Brian |
| Privacy | Signed/reviewed DPA, subprocessor/disclosure review, region routing accepted | PENDING privacy review |
| Security | Explicit revocation cutoff, refreshed-token replay and room-stop tests | PENDING implementation/acceptance |
| Initial limits | Up to four concurrent classrooms, at most 40 recipients/room, 15-minute hard session deadline | PROPOSED; not configured |
| Media source | Explicit screen capture, video only in v1; no camera, microphone or screen audio | PROPOSED v1 default |

If school policy requires region pinning, Ship is not an assumed solution: recheck
the provider plan and regional contract, obtain a new quote and reopen the budget
decision. Do not silently buy Scale. Approval of this ADR precedes a separate
presentation implementation plan and PRs.

## Workload and dated price inputs

One initial school has 133 students. Presentations are occasional, normally
3-15 minutes. Classroom sizes, sessions/month and simultaneous classrooms below
are planning assumptions, not telemetry. Use 720p, 5-10 FPS and adaptive 400-800
Kbps targets; capacity and readability still require Chromebook measurements.

Prices were checked against official sources on 2026-09-30, in USD before tax.
Recheck before provisioning. For pure browser media, the relevant Cloud meters
are participant time and downstream bytes, not AI-agent minutes:

| Input | Current published value | Source |
|---|---|---|
| Cloud Build | USD 0/month, 5,000 WebRTC minutes, 50 GB, 100 concurrent connections; included allowances are hard limits | [LiveKit pricing](https://livekit.com/pricing), [quotas](https://docs.livekit.io/deploy/admin/quotas-and-limits/) |
| Cloud Ship | USD 50/month starting price; 150,000 WebRTC minutes, then USD 0.0005/minute; 250 GB, then USD 0.12/GB; 1,000 connections | [LiveKit pricing](https://livekit.com/pricing) |
| Cloud Scale | USD 500/month starting price; not proposed for the initial school | [LiveKit pricing](https://livekit.com/pricing) |
| EC2 c6i.large, Linux, us-east-1 On-Demand | USD 0.085/hour; 2 vCPU, 4 GiB; illustrative unbenchmarked node | [AWS current regional price data](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json), [pricing](https://aws.amazon.com/ec2/pricing/on-demand/) |
| Public IPv4 | USD 0.005/address/hour, including retained idle addresses | [AWS VPC pricing](https://aws.amazon.com/vpc/pricing/) |
| gp3 baseline storage | USD 0.08/GB-month in the illustrated region; 20 GB = USD 1.60 | [AWS EBS volume types](https://aws.amazon.com/ebs/volume-types/) |
| Internet egress | Illustrative first paid tier USD 0.09/GB; shared account allowance must not be allocated twice | [AWS VPC pricing example](https://aws.amazon.com/vpc/pricing/), [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/) |

Cloud Build is not a production cost guarantee: four classes containing all 133
students plus teachers exceed its connection limit. Ship avoids that immediate
constraint. Transcoding, recording, agents and telephony are not part of this
workload and must remain disabled. Billing uses its documented time/data minimums;
reconcile estimates against actual provider usage rather than rounding each room
into invented billable blocks. [LiveKit billing](https://docs.livekit.io/deploy/admin/billing/)

### Reproducible estimate

For N receiving students, T minutes, S sessions and bitrate B bits/second:

```text
participantMinutes = (N + 1 teacher) * T * S
mediaGB = N * T * S * 60 * B / 8 / 1,000,000,000
planningGB = mediaGB * 1.25  # allowance for overhead/reconnects, not a guarantee
shipUSD = 50 + max(0, participantMinutes - 150000) * 0.0005
             + max(0, planningGB - 250) * 0.12
```

At 800 Kbps, using 20 school days/month:

| Scenario | Sessions/month | Participant minutes | Media GB / planning GB | Ship estimate | Illustrative AWS single-node estimate |
|---|---:|---:|---:|---:|---:|
| Two 10-minute sessions/day, 25 students | 40 | 10,400 | 60 / 75 | USD 50.00 | USD 79.55 |
| Four 15-minute sessions/day, 40 students | 80 | 49,200 | 288 / 360 | USD 63.20 | USD 105.20 |
| Stress: twenty 15-minute sessions/day, 40 students | 400 | 246,000 | 1,440 / 1,800 | USD 284.00 | USD 234.80 |

AWS illustration: 730 * (0.085 compute + 0.005 one IPv4) + 20 * 0.08 storage
+ 0.50 DNS allowance + 5.00 logging/monitoring reserve + planningGB * 0.09.
Its idle floor is USD 72.80/month. DNS and monitoring values are budget allowances,
not published quotes. This excludes load balancers, extra TURN endpoints/IPs,
Redis, snapshots, cross-AZ traffic, redundancy and engineering/on-call time.
It does not certify that c6i.large can serve this load. No account-wide free
egress credit is assumed. Add an approved itemized quote before choosing AWS.

## Hosting alternatives

| Dimension | LiveKit Cloud | Self-hosted LiveKit on AWS |
|---|---|---|
| Idle cost | Plan subscription, without customer-managed SFU instances | Compute/IP/storage remain billable while idle; stopped compute still leaves retained resources |
| Networking | Provider SFU/TURN; verify restrictive school networks and routing | Public media ports, trusted certificates and TURN/TLS endpoint required; do not route media through the existing Express/ALB service |
| Operations | Provider capacity/upgrades; own integration, usage and incident response | Own upgrades, patching, drain/restart, certificates, abuse controls, capacity and failures |
| Cold start | No customer EC2 boot orchestration; join latency must be measured | On-demand start saves compute but adds boot/readiness delay; not classroom-ready until measured |
| Scaling | Account/plan quotas plus application limits | Room placement, bandwidth/CPU sizing and later multi-node routing; avoid premature clusters |
| Revocation | Explicit Cloud cutoff supports strict replay rejection, subject to tests | Removal does not revoke cached tokens; a concrete join-admission enforcement design is required |
| Residency/privacy | Review DPA, route regions and plan restrictions before approval | More regional control, with customer operational responsibility and AWS privacy review |
| Availability | Provider dependency; service failure leaves ordinary classroom controls working | A single node has no HA; redundancy raises the initial budget and operating scope |

The AWS comparison starts with a separate compute-optimized VM and bounded
capacity, not media in Express or an always-running ECS/Fargate media cluster.
LiveKit recommends host networking and describes integrated TURN/TLS; its example
uses Redis for production. Do not assume the current SchoolPilot Redis has room
for media coordination. A single-node trial may evaluate Redis-free operation;
production topology, 443 TLS routing and any Redis addition need measured evidence
and a revised quote. Distributed LiveKit uses Redis for multi-node coordination.
[Deployment](https://docs.livekit.io/transport/self-hosting/deployment/),
[distributed operation](https://docs.livekit.io/transport/self-hosting/distributed/)

S3 screenshots/frame relay and per-student teacher peer uploads do not meet the
selected SFU topology. The parked legacy coturn fleet is not restarted or reused
by this ADR. New SFU TURN is a separate approved hosting concern.

## Security, privacy and termination acceptance

SchoolPilot remains the authority for entitlement, immutable teaching/supervision
ownership, school, frozen audience and exact student-session binding. The SFU
handles media only. Metadata is not an authorization check. Opaque room/participant
identities contain no student names, email addresses or device IDs.

The implementation must issue short-lived, room-scoped credentials after current
authority checks. Teacher grants allow only `screen_share` publication; student
grants allow subscription and prohibit media/data publication. Client grants have
no room-admin, recording, ingress or metadata-update authority. Browser capture
requires a deliberate user action; camera/microphone/screen audio stay disabled.
[LiveKit grants](https://docs.livekit.io/frontends/reference/tokens-grants/)

On sign-out, ownership/class change, entitlement loss, expiry, teacher stop or
source-ended, first prevent new credentials, then remove participants/stop media,
persist termination and notify exact targets. Retry failed SFU removal from bounded
server work; do not report successful termination before confirmation. Set a hard
15-minute deadline and stop presentation-owned Focus without clearing unrelated
Focus or browsing restrictions.

Token expiry governs joining, not live-session termination. Cloud's default
revocation buffer can admit recently refreshed tokens; use an explicit
`revoke_token_ts` and test cached/refreshed-token replay after removal, including
an already disconnected participant. Self-hosted removal leaves tokens valid;
short TTL and refusing backend refresh alone do not meet strict rejoin prevention.
AWS approval requires a concrete enforcement mechanism and adversarial proof.
[Token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/)

No automatic recording, Egress, media storage, student webcam/microphone,
conferencing or arbitrary teacher HTML. Logs retain bounded opaque operational
metadata only; no tokens, media, names or tab URLs. Review public privacy/terms/
subprocessor wording as a later approved release change. Ship region routing,
metadata retention and provider contractual handling require explicit acceptance;
do not advertise region pinning or zero retention without evidence.

## Proposed budget guardrails and shutdown

For approval: one school; four rooms maximum; 40 recipients each; 15-minute hard
deadline; 800 Kbps target; 100,000 participant minutes and 350 planning GB/month.
At current Ship rates those usage limits estimate USD 62 before tax, leaving
headroom within the proposed USD 75 budget. Reserve each session's full remaining
allowance atomically before credentials; release unused reservation only after
reconciled termination. Retry/reconnect must not create a second presentation.

Warn at USD 60 estimated incremental spend; refuse new starts at USD 70 or when
the reviewed usage quota is exhausted. Reconcile actual usage daily and refuse
starts when accounting is stale or uncertain. Provider lag, unexpected bitrate
and tax mean an application estimate is not a provider-enforced hard invoice cap.
Confirm available provider account limits/alerts before purchase; increasing
limits or plan requires approval. No high-cardinality paid custom metrics.

Rollback disables new presentations, revokes current participants and ends rooms,
then restores the previous application/extension candidate. Existing monitoring,
screenshots and classroom restrictions remain independent. Subscription cancellation
is a separate operator action; a capability kill switch does not cancel billing.

## Approval and implementation gates

Before media implementation: Brian records host/plan/budget decision and privacy
acceptance above. Keep this document in proposed state until actual approval.

After approval, separate PRs cover server sessions/grants/revocation, teacher
publisher, extension receiver, presentation-owned Focus, hosting/operations and
validation. Reuse official SDKs and existing control notifications; do not move
legacy Live View SDP handlers into SFU signaling.

Acceptance covers 10/25/40 recipients for 5/15 minutes, static text and changing
screens, four simultaneous rooms, five simultaneous reconnects, sleep/wake,
extension restart, blocked UDP/TURN-TLS, capture cancellation, source-ended,
class/ownership changes, denied publish attempts, foreign-school tokens, revoked
cached/refreshed tokens and shutdown with an unavailable provider API. Measure
join delay, readable quality, actual bandwidth, CPU/memory and cost. The exact
candidate must run on managed Chromebooks; simulated tests are separate evidence.

No production load, real student fixtures, provisioning, Store upload or legacy
decommission is authorized by this decision draft.
