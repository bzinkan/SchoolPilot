# Legacy ClassPilot TURN — parking and restart

Legacy TURN is parked/stopped. It is not removed.

## Current status

- **Legacy.** The two coturn nodes were provisioned for the retired ClassPilot
  Live View architecture. Live View is no longer an active SchoolPilot product
  feature.
- **Parked.** Both EC2 instances are stopped (EC2 `StopInstances`, 2026-09-28).
  Nothing was terminated or destroyed.
- **Retained for rollback and dependency verification:** both Elastic IPs, both
  `turn-*.school-pilot.net` Route 53 records, the TURN REST secret, the security
  group, the IAM role and instance profile, the relay port range, the TLS
  configuration, the CloudWatch alarms and dashboard, and the Terraform module.
- **Present to Class** will use a separately designed SFU media architecture
  (`teacherPresentationV1`, not `liveViewIceServersV1`) and does not assume these
  nodes will be reused. Keeping them running for it is not a reason to run them.
- **Roadmap and audit.** `SCHOOLPILOT_COMPETITIVE_ROADMAP.md` tracks the
  Phase 0/0A status, including the saved TURN Terraform plan and the
  `live-view-retire` runtime profile (both applied on 2026-09-29), and
  `CLASSPILOT_LEGACY_MEDIA_AUDIT.md` classifies every Live View and TURN item
  with its protection status.

| Node | Terraform address | Instance | AZ | Elastic IP | DNS |
|---|---|---|---|---|---|
| TURN A | `module.turn[0].aws_instance.turn["a"]` | `i-0685f7c1550bf6b6a` | us-east-1a | 3.218.94.198 | `turn-a.school-pilot.net` |
| TURN B | `module.turn[0].aws_instance.turn["b"]` | `i-0b69609a16334733e` | us-east-1b | 18.232.14.43 | `turn-b.school-pilot.net` |

Both nodes run `ami-052355af2a014bd2c` (Canonical
`ubuntu-noble-24.04-amd64-server-20260714`), security group
`sg-0967b001117a0449b`, and instance profile
`schoolpilot-production-classpilot-turn`. The REST secret is created by
`module.turn[0].aws_cloudformation_stack.rest_secret`; Terraform records only
its ARN.

### What `enable_classpilot_turn = true` means now

It means Terraform retains ownership of the legacy TURN infrastructure. It does
not mean TURN should be running, that Live View is enabled, or that TURN is part
of the active ClassPilot product. `classpilot_turn_parked = true` is the running
state: the module declares `aws_ec2_instance_state` `stopped` for both nodes.
Never set `enable_classpilot_turn = false` to pause TURN; that is a destroy plan
for the whole module.

### Terraform safety

- `classpilot_turn_parked = true` keeps both nodes stopped through
  `aws_ec2_instance_state`. It never replaces a node or detaches its Elastic IP.
- `classpilot_turn_ami_id` pins the verified deployed image. Canonical's moving
  Ubuntu parameter is read only when no image is pinned (new environments).
- `aws_instance.turn` has `prevent_destroy = true`. Any plan that would destroy
  or replace a node fails loudly. Replacement triggers include the image, user
  data (`user_data_replace_on_change = true`, which embeds the TLS email and the
  certificate-refresh and relay-metrics scripts), subnet, public-IP association
  and root volume encryption. There is no `ignore_changes`.
- The August 2026 one-time node-replacement exception in
  `CLASSPILOT_TURN_OPERATIONS.md` is superseded by parking. Executing it would
  first require a reviewed PR that removes `prevent_destroy`.
- Every production plan that touches the TURN module must set
  `TF_VAR_classpilot_turn_tls_email` to the operator's existing address, as
  `CLASSPILOT_TURN_OPERATIONS.md` describes. Without it the rendered user data
  changes, and `prevent_destroy` stops the plan.

While parked, the two node alarms that treat missing data as breaching
(`...-turn-a/b-status-check`, `...-turn-a/b-log-storage`) have actions disabled
and treat missing data as not breaching.

## Why

Idle EC2 cost. The cost review of 2026-09-28 found both nodes idle (about
12 MB/day of background traffic each, no ICE sessions in the previous 14 days).
Stopping them saves about $34 a month in compute and node metrics. The Elastic
IPs remain billed (about $7 a month) so DNS stays stable.

## Live View status (verified 2026-09-28)

- The teacher dashboard hard-codes `LIVE_VIEW_UI_ENABLED = false`
  (`schoolpilot-app/src/products/classpilot/pages/Dashboard.jsx`), so no teacher
  can start Live View.
- TURN credentials are issued only inside an active Live View negotiation
  (`createClasspilotIceConfiguration` in `src/routes/classpilot/devices.ts`),
  so nothing requests them.
- Screenshots and ordinary student monitoring use the ClassPilot API and
  WebSocket, not TURN. PassPilot and GoPilot have no TURN or ICE dependency.
- **Capability retirement:** the runtime-config tool retired
  `liveViewIceServersV1` on 2026-09-29. No profile turns it on or carries TURN
  inputs, and recovery after a containment `off` no longer needs TURN running.
  A production runtime written before the retirement still has it on, with
  `CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1=true`; one reviewed
  `live-view-retire` Plan and Apply turns off that entry and flag and nothing
  else. `CLASSPILOT_TURN_HOSTS`, `CLASSPILOT_STUN_URLS` and the TURN secret
  reference stay provisioned until decommission. See "Live View ICE is retired"
  in `CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md`.

## Restart conditions

Restart only if an unexpected production dependency on legacy TURN is
discovered, or an explicitly reviewed engineering test requires it. Restarting
the nodes does not enable any product capability. Never enable
`liveViewIceServersV1` because the nodes were restarted; starting
infrastructure and enabling a capability are separate actions.

## Restart procedure

Run each step and stop at the first failure.

1. **Identify both nodes.** `aws ec2 describe-instances --region us-east-1
   --instance-ids i-0685f7c1550bf6b6a i-0b69609a16334733e` must show the names
   `schoolpilot-production-classpilot-turn-a` and `-turn-b`, tag
   `Role=classpilot-turn`, state `stopped`, and image `ami-052355af2a014bd2c`.
2. **Confirm the retained Elastic IPs.** `aws ec2 describe-addresses --region
   us-east-1 --filters Name=instance-id,Values=i-0685f7c1550bf6b6a,i-0b69609a16334733e`
   must show 3.218.94.198 on TURN A and 18.232.14.43 on TURN B.
3. **Confirm DNS.** `turn-a.school-pilot.net` resolves to 3.218.94.198 and
   `turn-b.school-pilot.net` to 18.232.14.43.
4. **Start TURN A.** Preferred: a reviewed PR sets `classpilot_turn_parked = false`
   and a saved plan shows only the two `aws_ec2_instance_state` changes and the
   four alarm updates. Emergency only: `aws ec2 start-instances --region
   us-east-1 --instance-ids i-0685f7c1550bf6b6a`, then record the drift and follow
   up with that PR.
5. **Start TURN B** the same way (`i-0b69609a16334733e`).
6. **Wait for EC2 status checks:** `aws ec2 wait instance-status-ok --region
   us-east-1 --instance-ids i-0685f7c1550bf6b6a i-0b69609a16334733e`.
7. **Verify coturn** on each node through SSM Session Manager:
   `systemctl is-active coturn certbot.timer classpilot-turn-relay-metrics.timer`.
8. **Verify UDP/3478** authenticates and relays with a short-lived REST
   credential (see `CLASSPILOT_TURN_OPERATIONS.md`).
9. **Verify TCP/3478** the same way.
10. **Verify TURNS/443** the same way.
11. **Verify certificates:** each node presents a valid, unexpired certificate
    for its own `turn-*.school-pilot.net` name.
12. **Verify the relay range** 49152–49252 is reachable and bounded.
13. **Verify CloudWatch health:** both `Node` dimensions publish
    `SchoolPilot/ClassPilotTURN` metrics again, the node alarms return to `OK`,
    and their actions are re-enabled (`classpilot_turn_parked = false` does this;
    after an emergency start, run `aws cloudwatch enable-alarm-actions` for the
    four alarms).
14. **Verify no unexpected Terraform drift:** a fresh plan against production
    shows no replacement, destroy, Elastic IP, DNS, secret, security group or IAM
    change.

## Future decommission

Stopped does not mean safe to delete. Removal happens later, in its own
reviewed change, only after all of the following hold:

- Live View is confirmed permanently retired.
- The nodes have stayed stopped without product failures.
- No supported extension version requires them.
- No backend process consumes their credentials.
- The Present to Class SFU architecture does not depend on them.
- Historical evidence requirements are preserved.
- A reviewed Terraform destroy plan exists, after a PR removes
  `prevent_destroy`.

That later work may remove the TURN EC2 instances, Elastic IPs, Route 53 TURN
records, security group, IAM resources, TURN REST secret, CloudWatch alarms and
dashboard, legacy Live View routes, old capabilities, old runtime variables, old
extension Live View code, and the Terraform TURN module. None of that belongs to
parking.

That later work is Lane D (PR 19–21) of `SCHOOLPILOT_COMPETITIVE_ROADMAP.md`,
in the deletion order recorded in `CLASSPILOT_LEGACY_MEDIA_AUDIT.md`.
