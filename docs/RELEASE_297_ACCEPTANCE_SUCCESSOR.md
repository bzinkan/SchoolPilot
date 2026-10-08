# Current-source classroom acceptance preparation

The `release297-current-school-acceptance-ecf6ce01-v1` local preparation contract
binds application reference `ecf6ce0100e758f5668c5a26427c1c0ea82ea0a2`, the retained
comparison baseline `7af9d0dd5bc2bd3e13b96d35a577725e07f8b678`, and the unchanged
fallback `d75fc1c48d0a3918857508d3965904c69023a153`. It admits no other sources or
fallback identities. It never authorizes publication, registration, deployment,
activation or a release-ready claim.

Historical profiles and their canonical hashes remain unchanged. The DDC lower
contract still requires its historical 54-entry ledger. Only the explicitly
validated successor accepts ordinary 53-entry evidence, with all 129 forced RLS
tables and exact completed migration vectors retained. Historical receipts are
never rewritten or relabeled.

## Prerequisites

`acceptance-successor.mjs` rejects preparation unless all of these inputs are
hash-pinned, source-specific and present:

- Clean exact application and baseline checkouts, independently captured
  image/config/platform identities, and corresponding schema dumps and receipts.
- Fresh scans of the exact candidate and exact fallback with zero High/Critical
  findings. Counts are independently recomputed from hash-pinned Trivy JSON;
  lower-severity findings stay explicit. A failed fallback scan holds execution.
  Raw scan receipt timestamps and the Version 2 database download/update/expiry
  timeline must be current; a newly dated wrapper cannot refresh an old scan.
- A clean committed host harness with a complete tracked workload-tool byte
  inventory; each newly built helper must bind that same inventory and host SHA.
- Fresh candidate screenshot/private-file/PDF preparation and actual ordinary
  candidate→fallback→candidate recovery, with 43→53 migrations,
  121→125→126→127→128→129 admission, capability equality, private-chat floors,
  RLS/function/Focus/history checks, unforced cleanup and zero named SQL connections.
- The unchanged approved amended policy receipt
  `965328a337fe35eaa505610ade00633075f7014fab610da8a869f6b514688f95`, plus an explicit
  applicability review of the new exact candidate. Approval of historical
  artifacts does not automatically establish this applicability.
- Captured flags and explicit synthetic scope mappings. Both new Usage modes
  stay off; daily-rollup setting and effective behavior are recorded independently.
  The comparison continues using the existing verified 2.9.6 advertisement;
  classroom capability validation uses unchanged ClassPilot 2.9.7.
- A source/tool-bound local synthetic quiet window, with no concurrent builds or
  loads and enough lifetime for the whole attempt. A measured mixed attempt
  reserves 20 minutes; other attempts reserve 10 minutes. Every block stays on
  its declared school-local fixture date.

Unknown inputs must remain null in non-executable templates. Such templates
cannot pass validation or launch a workload. Evidence wrappers must describe
actual hash-pinned raw evidence; their booleans are not substitutes for a run.
Native probe intervals must be contained in their actual execution. Recovery
execution, restricted migration review, aggregate and independent review must
occur in that order within the preparation evidence window. Recovery consumes
the actual eight service/drain pairs and the sealed, query-backed restricted
migration proof; it does not invent a different producer schema.

## Bounded execution and evidence

`execute-successor.mjs` takes a preparation file and its SHA-256. The preparation
binds the reviewed contract, exact options templates, driver hash, output path
and quiet-window file/hash. It supports only these existing profiles:

| Block | Existing profile | Required block |
| --- | --- | --- |
| `fixed133` | `release297-blackbox-sole-133-v2` | A,A,A,B,B,A,A,B |
| `boundary` | `release297-classroom-133-loss-boundary-preparation-v1` | One fresh preparation proof |
| `normal` | `release297-classroom-normal-34-native-v3` | One capability-on 2,040-offer run |
| `classroom` | `release297-classroom-133-1-3-2-native-v3` | Three consecutive 900-second runs |
| `headroom250` | `release297-usage-off-one-api-250-heartbeat-envelope-v1` | Three fresh passes with accepted headroom |

Normal and mixed blocks require the fresh source/image/helper-bound loss proof.
The three mixed receipts must have distinct run, manifest and reservation
identities, occur chronologically without overlap and belong to the same
declared campaign. Lower-load preparation additionally replays its closed
three-attempt campaign journal; a repeated successful receipt cannot qualify.
The 250 block additionally requires fresh exact-source normal, mixed and ordinary
recovery prerequisites. It retains CPU/p95 headroom, scoped teacher reads, native
persistence/RLS custody, complete final monitor/error logs and unforced cleanup.
It claims only the accepted heartbeat envelope, never higher-fleet classroom or
survival capacity.

The fixed 133 block retains every original run result and a separate strict
comparison result. Its approved-policy evaluation uses all five baselines and
all three candidate runs, the fixed pairing, every numerical threshold and the
conservative max-candidate/min-baseline comparisons. Only baseline absolute
latency receives the recorded exception. Any failed candidate, unexplained
offer, authority/tenancy/persistence defect, incomplete error capture or forced
cleanup holds all remaining attempts. Strict failures remain failed even if the
separate amended-policy evaluation passes.

Each attempt records its reservation before execution. Missing, partial or
invalid receipts remain recorded failures; later attempts are held. Closure
replays original native receipts and supplemental unforced/persistence custody
before making a synthetic acceptance claim. Every result reports
`releaseReady: false` and `operationalAuthorization: false`.

Preparation remains subject to independent review and normal CI. The coordinator
has pure rejection, numerical-policy and real temporary-Git regression coverage;
those tests establish tooling behavior only. They do not establish native
recovery or classroom acceptance. See [the operator handoff](./RELEASE_297_OPERATOR_HANDOFF.md)
for the separately required release and live gates.
