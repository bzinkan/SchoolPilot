#requires -Version 7.5

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = Join-Path ([IO.Path]::GetTempPath()) ("schoolpilot-plan-validator-" + [Guid]::NewGuid().ToString("N"))
$validator = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\validate-rollout-plan.ps1"))
$script:Assertions = 0
$global:SchoolPilotPlanJson = @{}

function Assert-Condition([bool]$Condition,[string]$Message) { $script:Assertions++; if(-not $Condition){throw $Message} }
function Write-TestFile([string]$Name,[string]$Text="plan") {
    $path=Join-Path $root $Name
    [IO.File]::WriteAllText($path,$Text,[Text.UTF8Encoding]::new($false))
    return $path
}
function Get-Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function New-Change([string]$Address,[string[]]$Actions,$Before,$After,$AfterUnknown=[pscustomobject]@{}) {
    [pscustomobject]@{address=$Address;change=[pscustomobject]@{actions=$Actions;before=$Before;after=$After;after_unknown=$AfterUnknown}}
}
function Register-Plan([string]$Name,[object[]]$Changes,$Configuration=$null) {
    $path=Write-TestFile "$Name.tfplan" $Name
    $global:SchoolPilotPlanJson[$path]=[pscustomobject]@{format_version="1.2";errored=$false;complete=$true;applyable=$true;deferred_changes=@();resource_drift=@();checks=@();resource_changes=$Changes;configuration=$Configuration}
    return $path
}
function global:terraform {
    $arguments=@($args|ForEach-Object{[string]$_})
    $global:LASTEXITCODE=0
    if($arguments[0] -eq "show" -and $arguments[1] -eq "-json") {
        return ($global:SchoolPilotPlanJson[$arguments[2]]|ConvertTo-Json -Depth 60 -Compress)
    }
    throw "Unexpected terraform mock call: $($arguments -join ' ')"
}

try {
    [void][IO.Directory]::CreateDirectory($root)
    $serviceBase=[pscustomobject]@{name="service";cluster="cluster";desired_count=1;task_definition="task:1";network_configuration=@([pscustomobject]@{assign_public_ip=$false;security_groups=@("sg-1");subnets=@("subnet-11","subnet-22")})}
    $servicePublic=$serviceBase|ConvertTo-Json -Depth 10|ConvertFrom-Json -Depth 10
    $servicePublic.network_configuration[0].assign_public_ip=$true
    $servicePublic.network_configuration[0].subnets=@("subnet-a1","subnet-b2")
    $publicPlan=Register-Plan "public" @(
        (New-Change "module.ecs.aws_ecs_service.api" @("update") $serviceBase $servicePublic),
        (New-Change "module.ecs.aws_ecs_service.worker" @("update") $serviceBase $servicePublic),
        (New-Change "module.alb.aws_lb.main" @("no-op") ([pscustomobject]@{subnets=@("subnet-a1","subnet-b2")}) ([pscustomobject]@{subnets=@("subnet-a1","subnet-b2")}))
    )
    $subnetEvidencePath=Join-Path $root "public-subnets.json"
    $subnetEvidence=[ordered]@{schemaVersion=1;type="reviewed_public_ecs_subnets";observedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");accountId="135775632425";region="us-east-1";subnets=@(@{subnetId="subnet-a1";availabilityZone="us-east-1a"},@{subnetId="subnet-b2";availabilityZone="us-east-1b"})}
    [IO.File]::WriteAllText($subnetEvidencePath,($subnetEvidence|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $publicArgs=@{Phase="PublicEcs";PlanPath=$publicPlan;PlanSha256=Get-Sha $publicPlan;PublicSubnetEvidencePath=$subnetEvidencePath;PublicSubnetEvidenceSha256=Get-Sha $subnetEvidencePath}
    $publicResult=& $validator @publicArgs|ConvertFrom-Json
    Assert-Condition ($publicResult.valid -eq $true -and [string]$publicResult.shape.network.canonicalNetworkSha256 -match '^[0-9a-f]{64}$') "PublicEcs exact networking-only plan should validate and emit its canonical network hash."

    $badPublicAfter=$servicePublic|ConvertTo-Json -Depth 10|ConvertFrom-Json -Depth 10
    $badPublicAfter.desired_count=2
    $badPublic=Register-Plan "public-bad" @(
        (New-Change "module.ecs.aws_ecs_service.api" @("update") $serviceBase $badPublicAfter),
        (New-Change "module.ecs.aws_ecs_service.worker" @("update") $serviceBase $servicePublic),
        (New-Change "module.alb.aws_lb.main" @("no-op") ([pscustomobject]@{subnets=@("subnet-a1","subnet-b2")}) ([pscustomobject]@{subnets=@("subnet-a1","subnet-b2")}))
    )
    $badPublicRejected=$false
    try { & $validator -Phase PublicEcs -PlanPath $badPublic -PlanSha256 (Get-Sha $badPublic) -PublicSubnetEvidencePath $subnetEvidencePath -PublicSubnetEvidenceSha256 (Get-Sha $subnetEvidencePath)|Out-Null } catch { $badPublicRejected=$_.Exception.Message -match "unreviewed fields" }
    Assert-Condition $badPublicRejected "PublicEcs must reject desired-count drift hidden inside the right action/address count."

    $timestampLikeBefore=[pscustomobject]@{
        name="service";cluster="cluster";desired_count=1
        task_definition="2026-07-22T15:58:03+00:00"
        network_configuration=@([pscustomobject]@{assign_public_ip=$false;security_groups=@("sg-1");subnets=@("subnet-11","subnet-22")})
    }
    $timestampLikeAfter=[pscustomobject]@{
        name="service";cluster="cluster";desired_count=1
        task_definition="2026-07-22T15:58:03.0000000+00:00"
        network_configuration=@([pscustomobject]@{assign_public_ip=$true;security_groups=@("sg-1");subnets=@("subnet-a1","subnet-b2")})
    }
    $timestampLikePlan=Register-Plan "public-timestamp-string-drift" @(
        (New-Change "module.ecs.aws_ecs_service.api" @("update") $timestampLikeBefore $timestampLikeAfter),
        (New-Change "module.ecs.aws_ecs_service.worker" @("update") $serviceBase $servicePublic),
        (New-Change "module.alb.aws_lb.main" @("no-op") ([pscustomobject]@{subnets=@("subnet-a1","subnet-b2")}) ([pscustomobject]@{subnets=@("subnet-a1","subnet-b2")}))
    )
    $timestampLikeDriftRejected=$false
    try {
        & $validator -Phase PublicEcs -PlanPath $timestampLikePlan -PlanSha256 (Get-Sha $timestampLikePlan) `
            -PublicSubnetEvidencePath $subnetEvidencePath -PublicSubnetEvidenceSha256 (Get-Sha $subnetEvidencePath) | Out-Null
    }
    catch { $timestampLikeDriftRejected=$_.Exception.Message -match "unreviewed fields" }
    Assert-Condition $timestampLikeDriftRejected `
        "Terraform JSON ingestion must preserve lexically distinct timestamp-shaped strings instead of normalizing them into an equal DateTime value."

    $natAddresses=@(
        "module.vpc.aws_eip.nat[0]","module.vpc.aws_eip.nat[1]",
        "module.vpc.aws_nat_gateway.main[0]","module.vpc.aws_nat_gateway.main[1]",
        "module.vpc.aws_route.private_nat[0]","module.vpc.aws_route.private_nat[1]"
    )
    $natValue={param([string]$address,[bool]$rollback=$false)
        $index=if($address -match '\[1\]$'){1}else{0}
        if($address -match 'aws_eip'){
            return [pscustomobject]@{domain="vpc";tags=[pscustomobject]@{Name="schoolpilot-nat-$index"};id=if($rollback){$null}else{"eip-$index"}}
        }
        if($address -match 'aws_nat_gateway'){
            return [pscustomobject]@{
                connectivity_type="public";subnet_id=@("subnet-a1","subnet-b2")[$index]
                allocation_id=if($rollback){$null}else{"eipalloc-$index"};tags=[pscustomobject]@{Name="schoolpilot-nat-$index"}
                id=if($rollback){$null}else{"nat-$index"}
            }
        }
        return [pscustomobject]@{
            destination_cidr_block="0.0.0.0/0";route_table_id=@("rtb-a1","rtb-b2")[$index]
            nat_gateway_id=if($rollback){$null}else{"nat-$index"};id=if($rollback){$null}else{"route-$index"}
        }
    }
    $natDestroy=Register-Plan "nat-destroy" @($natAddresses|ForEach-Object{New-Change $_ @("delete") (&$natValue $_ $false) $null})
    $natConfiguration=[pscustomobject]@{root_module=[pscustomobject]@{module_calls=[pscustomobject]@{vpc=[pscustomobject]@{module=[pscustomobject]@{resources=@(
        [pscustomobject]@{address="aws_nat_gateway.main";expressions=[pscustomobject]@{allocation_id=[pscustomobject]@{references=@("aws_eip.nat","aws_eip.nat.id")}}},
        [pscustomobject]@{address="aws_route.private_nat";expressions=[pscustomobject]@{nat_gateway_id=[pscustomobject]@{references=@("aws_nat_gateway.main","aws_nat_gateway.main.id")}}}
    )}}}}}
    $natCreateChanges=@($natAddresses|ForEach-Object{
        $unknown=if($_ -match 'aws_eip'){
            [pscustomobject]@{id=$true;allocation_id=$true;public_ip=$true}
        }elseif($_ -match 'aws_nat_gateway'){
            [pscustomobject]@{id=$true;allocation_id=$true;network_interface_id=$true;private_ip=$true;public_ip=$true}
        }else{
            [pscustomobject]@{id=$true;nat_gateway_id=$true}
        }
        New-Change $_ @("create") $null (&$natValue $_ $true) $unknown
    })
    $natCreate=Register-Plan "nat-create" $natCreateChanges $natConfiguration
    $natResult=& $validator -Phase NatRemoved -PlanPath $natDestroy -PlanSha256 (Get-Sha $natDestroy)|ConvertFrom-Json
    Assert-Condition ($natResult.valid -eq $true -and $natResult.shape.destroy -eq 6 -and
        $natResult.shape.preDestroyRecoveryContract.type -eq "nat_pre_destroy_recovery_contract" -and
        $natResult.shape.preDestroyRecoveryContract.forwardPlanSha256 -eq (Get-Sha $natDestroy) -and
        @($natResult.shape.preDestroyRecoveryContract.resourceAddresses).Count -eq 6 -and
        @($natResult.shape.preDestroyRecoveryContract.exactForwardTopology.natGateways).Count -eq 2 -and
        @($natResult.shape.preDestroyRecoveryContract.exactForwardTopology.routes).Count -eq 2) `
        "NatRemoved must emit a sealed pre-destroy recovery contract for the exact six-add inverse."
    $natRollbackResult=& $validator -Phase NatRollback -PlanPath $natCreate -PlanSha256 (Get-Sha $natCreate) -ForwardPlanPath $natDestroy -ForwardPlanSha256 (Get-Sha $natDestroy)|ConvertFrom-Json
    Assert-Condition ($natRollbackResult.valid -eq $true -and $natRollbackResult.shape.rollback.add -eq 6 -and $natRollbackResult.shape.forward.destroy -eq 6) "NatRollback must validate the post-destroy six-add plan as an exact inverse of its hashed forward plan."

    $crossWiredChanges=@($natCreateChanges|ForEach-Object{$_|ConvertTo-Json -Depth 30|ConvertFrom-Json -Depth 30})
    ($crossWiredChanges|Where-Object address -eq 'module.vpc.aws_nat_gateway.main[0]').change.after.subnet_id='subnet-b2'
    $crossWired=Register-Plan "nat-cross-wired" $crossWiredChanges $natConfiguration
    $crossWiredRejected=$false
    try { & $validator -Phase NatRollback -PlanPath $crossWired -PlanSha256 (Get-Sha $crossWired) -ForwardPlanPath $natDestroy -ForwardPlanSha256 (Get-Sha $natDestroy)|Out-Null } catch { $crossWiredRejected=$_.Exception.Message -match 'changed stable field' }
    Assert-Condition $crossWiredRejected "NatRollback must reject cross-wired subnet recovery even when the action count remains exact."

    $healthBefore=[pscustomobject]@{id="hc-old";type="HTTPS";fqdn="school-pilot.net";port=443;resource_path="/health";request_interval=30;failure_threshold=3;measure_latency=$true}
    $healthAfter=$healthBefore|ConvertTo-Json|ConvertFrom-Json;$healthAfter.id=$null;$healthAfter.measure_latency=$false
    $alarmBefore=[pscustomobject]@{alarm_name="health";namespace="AWS/Route53";metric_name="HealthCheckStatus";comparison_operator="LessThanThreshold";threshold=1;period=60;evaluation_periods=3;treat_missing_data="breaching";alarm_actions=@("topic");dimensions=[pscustomobject]@{HealthCheckId="old"}}
    $alarmAfter=$alarmBefore|ConvertTo-Json -Depth 5|ConvertFrom-Json -Depth 5;$alarmAfter.dimensions.HealthCheckId=$null
    $routePlan=Register-Plan "route53" @(
        (New-Change "aws_route53_health_check.schoolpilot_public_health[0]" @("create","delete") $healthBefore $healthAfter ([pscustomobject]@{id=$true})),
        (New-Change "aws_cloudwatch_metric_alarm.synthetic_public_health[0]" @("update") $alarmBefore $alarmAfter ([pscustomobject]@{dimensions=[pscustomobject]@{HealthCheckId=$true}}))
    )
    Assert-Condition ((& $validator -Phase Route53 -PlanPath $routePlan -PlanSha256 (Get-Sha $routePlan)|ConvertFrom-Json).valid) "Route53 reviewed replacement/alarm plan should validate."

    $routeWrongOrder=Register-Plan "route53-wrong-order" @(
        (New-Change "aws_route53_health_check.schoolpilot_public_health[0]" @("delete","create") $healthBefore $healthAfter ([pscustomobject]@{id=$true})),
        (New-Change "aws_cloudwatch_metric_alarm.synthetic_public_health[0]" @("update") $alarmBefore $alarmAfter ([pscustomobject]@{dimensions=[pscustomobject]@{HealthCheckId=$true}}))
    )
    $routeOrderRejected=$false
    try { & $validator -Phase Route53 -PlanPath $routeWrongOrder -PlanSha256 (Get-Sha $routeWrongOrder)|Out-Null } catch { $routeOrderRejected=$_.Exception.Message -match 'expected.+create,delete' }
    Assert-Condition $routeOrderRejected "Route53 must reject destroy-before-create replacement ordering."

    $redisBefore=[pscustomobject]@{replication_group_id="redis";engine="redis";engine_version="7.1";port=6379;subnet_group_name="private";security_group_ids=@("sg");at_rest_encryption_enabled=$true;transit_encryption_enabled=$true;automatic_failover_enabled=$false;multi_az_enabled=$false;node_type="cache.t4g.small";apply_immediately=$true}
    $redisAfter=$redisBefore|ConvertTo-Json|ConvertFrom-Json;$redisAfter.node_type="cache.t4g.micro"
    $redisPlan=Register-Plan "redis" @((New-Change "module.redis.aws_elasticache_replication_group.main" @("update") $redisBefore $redisAfter))
    Assert-Condition ((& $validator -Phase Redis -PlanPath $redisPlan -PlanSha256 (Get-Sha $redisPlan)|ConvertFrom-Json).valid) "Redis exact micro resize should validate."

    $rdsBase=[pscustomobject]@{identifier="db";engine="postgres";engine_version="16.3";allocated_storage=100;max_allocated_storage=1000;storage_type="gp3";storage_encrypted=$true;multi_az=$false;publicly_accessible=$false;db_subnet_group_name="private";vpc_security_group_ids=@("sg");instance_class="db.t4g.medium";apply_immediately=$false}
    $rdsLarge=$rdsBase|ConvertTo-Json|ConvertFrom-Json;$rdsLarge.instance_class="db.t4g.xlarge";$rdsLarge.apply_immediately=$true
    $resizePlan=Register-Plan "rds-resize" @((New-Change "module.rds.aws_db_instance.main" @("update") $rdsBase $rdsLarge))
    $pricePath=Join-Path $root "price.json"
    $priceEvidence=[ordered]@{schemaVersion=1;type="aws_rds_price_evidence";observedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");accountId="135775632425";region="us-east-1";currency="USD";targetRdsInstanceClass="db.t4g.xlarge";hourlyOnDemandUsd=0.29;estimatedMonthlyUsd=211.70;sourceUrl="https://aws.amazon.com/rds/pricing/"}
    [IO.File]::WriteAllText($pricePath,($priceEvidence|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $projectionPath=Join-Path $root "projection.json"
    $projectionEvidence=[ordered]@{schemaVersion=1;type="rds_cost_explorer_projection";generatedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");accountId="135775632425";region="us-east-1";currency="USD";targetRdsInstanceClass="db.t4g.xlarge";monthlyEstimateUsd=365.25;monthlyBudgetUsd=350}
    [IO.File]::WriteAllText($projectionPath,($projectionEvidence|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $snapshotPath=Join-Path $root "snapshot.json"
    $snapshotEvidence=[ordered]@{schemaVersion=1;type="rds_manual_snapshot_evidence";observedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");snapshotCreateTimeUtc=[DateTimeOffset]::UtcNow.AddMinutes(-5).ToString("o");accountId="135775632425";region="us-east-1";snapshotArn="arn:aws:rds:us-east-1:135775632425:snapshot:test";sourceDbInstanceIdentifier="schoolpilot-production-db";sourceDbInstanceClass="db.t4g.medium";engine="postgres";status="available";encrypted=$true;kmsKeyId="arn:aws:kms:us-east-1:135775632425:key/test"}
    [IO.File]::WriteAllText($snapshotPath,($snapshotEvidence|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $ackPath=Join-Path $root "budget.json"
    $resizePlanSha=Get-Sha $resizePlan
    $ack=[ordered]@{schemaVersion=1;type="rds_resize_budget_acknowledgement";approved=$true;approver="Founder";acknowledgedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");targetRdsInstanceClass="db.t4g.xlarge";resizePlanSha256=$resizePlanSha;accountId="135775632425";region="us-east-1";currency="USD";monthlyBudgetUsd=350;temporaryBudgetBreachAcknowledged=$true;pendingOsUpdateHandledSeparately=$true;orderabilityVerified=$true;pointInTimeRecoveryVerified=$true;manualSnapshotEncrypted=$true;manualSnapshotArn="arn:aws:rds:us-east-1:135775632425:snapshot:test";manualSnapshotEvidence=@{path=$snapshotPath;sha256=Get-Sha $snapshotPath};awsPriceEvidence=@{path=$pricePath;sha256=Get-Sha $pricePath};costExplorerProjectionEvidence=@{path=$projectionPath;sha256=Get-Sha $projectionPath}}
    [IO.File]::WriteAllText($ackPath,($ack|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    Assert-Condition ((& $validator -Phase RdsResize -PlanPath $resizePlan -PlanSha256 $resizePlanSha -BudgetAcknowledgementPath $ackPath -BudgetAcknowledgementSha256 (Get-Sha $ackPath)|ConvertFrom-Json).valid) "RDS resize exact shape and explicit budget acknowledgement should validate."

    $staleBudgetAck=$ack|ConvertTo-Json -Depth 10|ConvertFrom-Json -Depth 10;$staleBudgetAck.acknowledgedAtUtc=[DateTimeOffset]::UtcNow.AddHours(-25).ToString("o")
    [IO.File]::WriteAllText($ackPath,($staleBudgetAck|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $staleBudgetAckRejected=$false
    try { & $validator -Phase RdsResize -PlanPath $resizePlan -PlanSha256 $resizePlanSha -BudgetAcknowledgementPath $ackPath -BudgetAcknowledgementSha256 (Get-Sha $ackPath)|Out-Null } catch { $staleBudgetAckRejected=$_.Exception.Message -match 'fresh within 24 hours' }
    Assert-Condition $staleBudgetAckRejected "RDS resize must reject an approval timestamp older than 24 hours even when the acknowledgement hash is recomputed."

    $futureBudgetAck=$ack|ConvertTo-Json -Depth 10|ConvertFrom-Json -Depth 10;$futureBudgetAck.acknowledgedAtUtc=[DateTimeOffset]::UtcNow.AddMinutes(6).ToString("o")
    [IO.File]::WriteAllText($ackPath,($futureBudgetAck|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $futureBudgetAckRejected=$false
    try { & $validator -Phase RdsResize -PlanPath $resizePlan -PlanSha256 $resizePlanSha -BudgetAcknowledgementPath $ackPath -BudgetAcknowledgementSha256 (Get-Sha $ackPath)|Out-Null } catch { $futureBudgetAckRejected=$_.Exception.Message -match 'five minutes in the future' }
    Assert-Condition $futureBudgetAckRejected "RDS resize must reject an approval timestamp more than five minutes in the future even when the acknowledgement hash is recomputed."

    [IO.File]::WriteAllText($ackPath,($ack|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))

    $stalePrice=$priceEvidence|ConvertTo-Json -Depth 10|ConvertFrom-Json -Depth 10;$stalePrice.observedAtUtc=[DateTimeOffset]::UtcNow.AddDays(-2).ToString("o")
    [IO.File]::WriteAllText($pricePath,($stalePrice|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $staleAck=$ack|ConvertTo-Json -Depth 10|ConvertFrom-Json -Depth 10;$staleAck.awsPriceEvidence=[pscustomobject]@{path=$pricePath;sha256=Get-Sha $pricePath}
    [IO.File]::WriteAllText($ackPath,($staleAck|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $stalePriceRejected=$false
    try { & $validator -Phase RdsResize -PlanPath $resizePlan -PlanSha256 $resizePlanSha -BudgetAcknowledgementPath $ackPath -BudgetAcknowledgementSha256 (Get-Sha $ackPath)|Out-Null } catch { $stalePriceRejected=$_.Exception.Message -match 'fresh within 24 hours' }
    Assert-Condition $stalePriceRejected "RDS resize must reject stale price evidence even when every hash is recomputed."

    $rdsNormalized=$rdsLarge|ConvertTo-Json|ConvertFrom-Json;$rdsNormalized.apply_immediately=$false
    $normalizePlan=Register-Plan "rds-normalize" @((New-Change "module.rds.aws_db_instance.main" @("update") $rdsLarge $rdsNormalized))
    Assert-Condition ((& $validator -Phase RdsNormalize -PlanPath $normalizePlan -PlanSha256 (Get-Sha $normalizePlan)|ConvertFrom-Json).valid) "RDS normalization must accept only apply_immediately true to false."

    $tamperRejected=$false
    try { & $validator -Phase Redis -PlanPath $redisPlan -PlanSha256 ("0"*64)|Out-Null } catch { $tamperRejected=$_.Exception.Message -match "does not match" }
    Assert-Condition $tamperRejected "Saved-plan digest tampering must be rejected before shape inspection."
    Write-Host "AWS rollout saved-plan validator tests: PASS ($script:Assertions assertions)"
}
finally {
    Remove-Item Function:\terraform -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotPlanJson -Scope Global -ErrorAction SilentlyContinue
    if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}
}
