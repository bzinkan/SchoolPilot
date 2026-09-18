# ClassPilot runtime-config operations

`scripts/deploy-classpilot-runtime-config.ps1` is the only governed way to change the
`CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` registry on the production API and
scheduler-worker services. Each capability's own doc carries its profile recipe; this
page covers capacity, the terminal states, and manual recovery.

## Capacity

- An ordinary (non-`off`) Plan admits an API desired count of 1–3; only an admitted
  protected-window run (`-ConfirmProtectedWindowProductionMutation`, weekday
  04:45–05:59 ET) admits 4–6. Apply at any admitted count: there is no
  "one task only" rule.
- Ordinary runs keep the reviewed `100/200` ECS rolling configuration. ECS starts
  every replacement before it drains an incumbent, so `aws elbv2 describe-target-health`
  showing up to twice the desired count of healthy targets mid-rollout is expected.
  The tool's converging health gate is derived from the live deployment configuration
  with ECS rounding, `[max(1, N-1), floor(N × maximumPercent / 100)]`: `[max(1, N-1), 2N]`
  under `100/200` and `[max(1, N-1), N]` under the no-growth containment bounds that
  `off` mode and protected-window runs install. The gates before mutation and after
  convergence require exactly N healthy targets.
- Plan and Apply belong to one sitting: a merge to `main` in between changes the tool
  SHA and forces a new plan.

## Terminal states (`result.json`)

| Status | Meaning | Next step |
| --- | --- | --- |
| `applied` | The candidate pair converged; deployment bounds and autoscaling were restored; the lease was released. | Verify per the capability doc. |
| `apply_failed_no_service_mutation` | Failed before any `update-service`; nothing changed. | Fix the cause, re-plan. |
| `apply_failed_rolled_back` | The mutation failed; the prior pair was restored and proven, autoscaling restored, the lease released. | Read the recorded failure, re-plan. |
| `apply_failed_manual_intervention` | The rollback could not be proven, or bounds/scaling could not be restored. Autoscaling stays suspended and the DynamoDB lease stays `mutating` by design. | Manual recovery below. `-Operation Rollback` refuses this evidence. |
| `rolled_back`, `rollback_failed_*` | The `-Operation Rollback` equivalents of the rows above. | Same rules. |

## Manual recovery after `apply_failed_manual_intervention`

Proven on 2026-09-17 (run `20260917T195138259Z-04a7782fa7c7`). Read `plan.json`,
`checkpoint.json` and `result.json` from the run directory first.

1. Confirm both services converged on the prior pair:
   `aws ecs describe-services --cluster schoolpilot-production-cluster --services schoolpilot-production-api schoolpilot-production-scheduler-worker --region us-east-1 --query 'services[].[serviceName,taskDefinition,desiredCount,runningCount,length(deployments),deployments[0].rolloutState]'`
   must show `priorApiTaskDefinitionArn` / `priorWorkerTaskDefinitionArn` from
   `plan.json` with one `COMPLETED` deployment each. If `checkpoint.json` shows the
   rollback `update-service` calls never ran, issue them by hand inside the live
   families first and wait for convergence.
2. Restore autoscaling (the reconciled minimum is `3` during 05:45–15:59 ET on
   weekdays, otherwise `1`; if scheduled scaling was already suspended before the
   run, restore the captured minimum instead):
   `aws application-autoscaling register-scalable-target --service-namespace ecs --scalable-dimension ecs:service:DesiredCount --resource-id service/schoolpilot-production-cluster/schoolpilot-production-api --min-capacity 1 --max-capacity 6 --suspended-state DynamicScalingInSuspended=false,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=false --region us-east-1`
3. Release the fenced lease in table `schoolpilot-terraform-locks`, key
   `LockID = schoolpilot/production/classpilot-runtime-config-v1`. Read the item
   first; the update is conditioned on the owner, fence and state the failed run
   recorded, so a concurrent operator can never be clobbered:
   `aws dynamodb update-item --table-name schoolpilot-terraform-locks --region us-east-1 --key file://lease-key.json --condition-expression "OwnerToken = :owner AND FenceToken = :fence AND OperationState = :mutating" --update-expression "SET OwnerToken = :released, LeaseExpiresAt = :zero, ReleasedAt = :now, OperationState = :released REMOVE PlanSha256, AcquiredAt, MutationStartedAt" --expression-attribute-values file://lease-values.json`
   where `:owner` is the run's `OwnerToken` (`<runId>-<hex>`), `:fence` its
   `FenceToken` (a number), `:mutating` / `:released` the strings `mutating` /
   `released`, `:zero` the number `0`, and `:now` the current Unix time. Run it from
   PowerShell on Windows so the `file://` paths are not mangled.
4. Only then start a new Plan.
