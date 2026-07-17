#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$supervisorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\start-aws-rollout-supervisor.ps1"))
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($supervisorPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Unable to parse rollout supervisor." }
foreach ($name in @(
    "Get-CertificationValue",
    "Get-CertificationTextSha256",
    "Get-CertificationExpectedRdsPosture",
    "Get-CertificationTaskPreflight"
)) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing supervisor function $name." }
    Invoke-Expression $definition.Extent.Text
}

$script:BadScalableTarget = $false
$script:MixedTaskRevision = $false
$script:ScalableTargetCalls = 0
$script:DuplicateEcrManifestRows = $false
$script:ConflictingEcrManifest = $false
$script:ConflictingEcrMediaType = $false
$script:WrongEcrDigest = $false
$script:BlankEcrMediaType = $false
$script:EcrManifestFailure = $false
$apiArn = "arn:aws:ecs:us-east-1:123456789012:task-definition/api:17"
$workerArn = "arn:aws:ecs:us-east-1:123456789012:task-definition/worker:37"
$rollbackApiArn = "arn:aws:ecs:us-east-1:123456789012:task-definition/api-emergency:13"
$rollbackWorkerArn = "arn:aws:ecs:us-east-1:123456789012:task-definition/worker:35"
$activeDigest = "sha256:" + ("1" * 64)
$rollbackApiDigest = "sha256:" + ("2" * 64)
$rollbackWorkerDigest = "sha256:" + ("3" * 64)

function Invoke-CertificationAwsJson {
    param([string[]]$Arguments)
    $service = $Arguments[0]
    $operation = $Arguments[1]
    if ($service -eq "ecs" -and $operation -eq "describe-services") {
        return [pscustomobject]@{services=@(
            [pscustomobject]@{serviceName="api";taskDefinition=$apiArn;desiredCount=6;runningCount=6;pendingCount=0;
                deployments=@([pscustomobject]@{taskDefinition=$apiArn;rolloutState="COMPLETED"});
                networkConfiguration=[pscustomobject]@{awsvpcConfiguration=[pscustomobject]@{subnets=@("subnet-a");assignPublicIp="DISABLED"}}},
            [pscustomobject]@{serviceName="worker";taskDefinition=$workerArn;desiredCount=1;runningCount=1;pendingCount=0;
                deployments=@([pscustomobject]@{taskDefinition=$workerArn;rolloutState="COMPLETED"});
                networkConfiguration=[pscustomobject]@{awsvpcConfiguration=[pscustomobject]@{subnets=@("subnet-a");assignPublicIp="DISABLED"}}}
        )}
    }
    if ($service -eq "ecs" -and $operation -eq "describe-task-definition") {
        $arn = $Arguments[[Array]::IndexOf($Arguments,"--task-definition") + 1]
        $binding = switch ($arn) {
            $apiArn { @("api",$activeDigest,512,2048) }
            $workerArn { @("scheduler-worker",$activeDigest,256,512) }
            $rollbackApiArn { @("api",$rollbackApiDigest,512,2048) }
            $rollbackWorkerArn { @("scheduler-worker",$rollbackWorkerDigest,256,512) }
            default { throw "Unexpected task definition $arn" }
        }
        return [pscustomobject]@{taskDefinition=[pscustomobject]@{
            status="ACTIVE";taskDefinitionArn=$arn;cpu=[string]$binding[2];memory=[string]$binding[3]
            containerDefinitions=@([pscustomobject]@{name=$binding[0];image="123456789012.dkr.ecr.us-east-1.amazonaws.com/schoolpilot@$($binding[1])"})
        }}
    }
    if ($service -eq "ecr" -and $operation -eq "batch-get-image") {
        $digest = ($Arguments[[Array]::IndexOf($Arguments,"--image-ids") + 1] -split '=',2)[1]
        $imageManifest = "{}`n$digest"
        $mediaType = "application/vnd.docker.distribution.manifest.v2+json"
        $images = @([pscustomobject]@{
            imageId=[pscustomobject]@{imageDigest=if($script:WrongEcrDigest){"sha256:"+("f"*64)}else{$digest};imageTag="provenance"}
            imageManifest=$imageManifest;imageManifestMediaType=if($script:BlankEcrMediaType){""}else{$mediaType}
        })
        if ($script:DuplicateEcrManifestRows) {
            $images += [pscustomobject]@{
                imageId=[pscustomobject]@{imageDigest=$digest;imageTag="latest"}
                imageManifest=if($script:ConflictingEcrManifest){"{}`nconflict"}else{$imageManifest}
                imageManifestMediaType=if($script:ConflictingEcrMediaType){"application/vnd.oci.image.manifest.v1+json"}else{$mediaType}
            }
        }
        return [pscustomobject]@{images=$images;failures=if($script:EcrManifestFailure){@([pscustomobject]@{failureCode="ImageNotFound"})}else{@()}}
    }
    if ($service -eq "ecr" -and $operation -eq "describe-images") {
        $tag = ($Arguments[[Array]::IndexOf($Arguments,"--image-ids") + 1] -split '=',2)[1]
        $digest = if($tag -eq ("1"*12)){$activeDigest}elseif($tag -eq ("2"*12)){$rollbackApiDigest}else{$rollbackWorkerDigest}
        return [pscustomobject]@{imageDetails=@([pscustomobject]@{imageDigest=$digest;imageTags=@($tag)})}
    }
    if ($service -eq "cloudwatch" -and $operation -eq "describe-alarms") {
        return [pscustomobject]@{MetricAlarms=@(
            [pscustomobject]@{AlarmName="alarm-a";StateValue="OK";ActionsEnabled=$true},
            [pscustomobject]@{AlarmName="alarm-b";StateValue="OK";ActionsEnabled=$true}
        )}
    }
    if ($service -eq "application-autoscaling" -and $operation -eq "describe-scheduled-actions") {
        return [pscustomobject]@{ScheduledActions=@(
            [pscustomobject]@{ScheduledActionName="school-open";Schedule="cron(0 7 ? * MON-FRI *)";Timezone="America/New_York";ScalableTargetAction=[pscustomobject]@{MinCapacity=2;MaxCapacity=8}},
            [pscustomobject]@{ScheduledActionName="school-close";Schedule="cron(0 17 ? * MON-FRI *)";Timezone="America/New_York";ScalableTargetAction=[pscustomobject]@{MinCapacity=1;MaxCapacity=8}}
        )}
    }
    if ($service -eq "application-autoscaling" -and $operation -eq "describe-scalable-targets") {
        $script:ScalableTargetCalls++
        return [pscustomobject]@{ScalableTargets=@([pscustomobject]@{
            ResourceId="service/cluster/api";ScalableDimension="ecs:service:DesiredCount"
            MinCapacity=if($script:BadScalableTarget){5}else{6};MaxCapacity=8
        })}
    }
    if ($service -eq "elbv2" -and $operation -eq "describe-target-health") {
        return [pscustomobject]@{TargetHealthDescriptions=@(1..6 | ForEach-Object {
            [pscustomobject]@{Target=[pscustomobject]@{Id="10.0.0.$_";Port=3000};TargetHealth=[pscustomobject]@{State="healthy"}}
        })}
    }
    if ($service -eq "elbv2" -and $operation -eq "describe-target-groups") {
        return [pscustomobject]@{TargetGroups=@([pscustomobject]@{TargetGroupArn="arn:target";Port=3000})}
    }
    if ($service -eq "ecs" -and $operation -eq "list-tasks") {
        $name = $Arguments[[Array]::IndexOf($Arguments,"--service-name") + 1]
        return [pscustomobject]@{taskArns=if($name -eq "api"){@(1..6|ForEach-Object{"arn:task/api-$_"})}else{@("arn:task/worker-1")}}
    }
    if ($service -eq "ecs" -and $operation -eq "describe-tasks") {
        $index = [Array]::IndexOf($Arguments,"--tasks")
        $arns = @($Arguments[($index+1)..($Arguments.Count-1)])
        return [pscustomobject]@{tasks=@($arns | ForEach-Object {
            $isApi = $_ -match '/api-'
            $taskDefinition = if ($isApi) {$apiArn} else {$workerArn}
            if ($script:MixedTaskRevision -and $_ -eq "arn:task/api-6") { $taskDefinition = $rollbackApiArn }
            $suffix=[int](($_ -split '-')[-1]);$ip=if($isApi){"10.0.0.$suffix"}else{"10.0.1.$suffix"}
            [pscustomobject]@{taskArn=$_;taskDefinitionArn=$taskDefinition;lastStatus="RUNNING";attachments=@([pscustomobject]@{type="ElasticNetworkInterface";details=@([pscustomobject]@{name="privateIPv4Address";value=$ip})})}
        })}
    }
    if ($service -eq "rds" -and $operation -eq "describe-db-instances") {
        return [pscustomobject]@{DBInstances=@([pscustomobject]@{
            DBInstanceStatus="available";DBInstanceClass="db.t4g.medium";PubliclyAccessible=$false;PendingModifiedValues=[pscustomobject]@{}
            DBInstanceArn="arn:rds:db";Engine="postgres";EngineVersion="16.4";AllocatedStorage=100;MaxAllocatedStorage=1000
            StorageType="gp3";StorageEncrypted=$true;MultiAZ=$false;PerformanceInsightsEnabled=$true
            DBSubnetGroup=[pscustomobject]@{DBSubnetGroupName="schoolpilot-production-db-subnets"}
            VpcSecurityGroups=@([pscustomobject]@{VpcSecurityGroupId="sg-1234abcd"})
        })}
    }
    if ($service -eq "elasticache" -and $operation -eq "describe-replication-groups") {
        return [pscustomobject]@{ReplicationGroups=@([pscustomobject]@{
            Status="available";CacheNodeType="cache.t4g.small";PendingModifiedValues=[pscustomobject]@{};ARN="arn:redis"
        })}
    }
    throw "Unexpected mock AWS request: $service $operation"
}

$contract = [pscustomobject]@{
    ActiveApiArn=$apiArn;ActiveWorkerArn=$workerArn;RollbackApiArn=$rollbackApiArn;RollbackWorkerArn=$rollbackWorkerArn
    DeployedImageDigest=$activeDigest;RollbackApiImageDigest=$rollbackApiDigest;RollbackWorkerImageDigest=$rollbackWorkerDigest
    ApplicationGitSha=("1"*40);RollbackApiGitSha=("2"*40);RollbackWorkerGitSha=("3"*40)
    Raw=[pscustomobject]@{alarmNames=@("alarm-a","alarm-b");scheduleNames=@("school-open","school-close")}
}
$config = [pscustomobject]@{
    phase="Waf";workload=[pscustomobject]@{stage="500"}
    resources=[pscustomobject]@{
        region="us-east-1";cluster="cluster";apiService="api";workerService="worker";targetGroupArn="arn:target"
        rdsInstanceId="db";redisReplicationGroupId="redis";expectedRdsInstanceClass="db.t4g.medium";expectedRedisNodeType="cache.t4g.small"
    }
}

$assertions = 0
$valid = Get-CertificationTaskPreflight -Config $config -Contract $contract
Assert-Condition ($valid.posture.loadStability.healthyTargetCount -eq 6 -and
    @($valid.posture.loadStability.tasks.api).Count -eq 6 -and
    @($valid.posture.loadStability.tasks.worker).Count -eq 1) "The night preflight must attest exact capacity, targets, and task revisions."
$assertions++

$script:DuplicateEcrManifestRows = $true
$duplicateManifestResult = Get-CertificationTaskPreflight -Config $config -Contract $contract
Assert-Condition (
    [string]$duplicateManifestResult.taskDefinitions.activeApi.imageManifestSha256 -eq
    (Get-CertificationTextSha256 ("{}`n$activeDigest"))
) "ECR may return one identical manifest row per tag for the same immutable digest."
$assertions++

$script:ConflictingEcrManifest = $true
$conflictingManifestRejected = $false
try { Get-CertificationTaskPreflight -Config $config -Contract $contract | Out-Null }
catch { $conflictingManifestRejected = $_.Exception.Message -match "one immutable ECR manifest" }
Assert-Condition $conflictingManifestRejected "Conflicting ECR manifests for one digest must fail closed."
$assertions++
$script:ConflictingEcrManifest = $false

$script:ConflictingEcrMediaType = $true
$conflictingMediaTypeRejected = $false
try { Get-CertificationTaskPreflight -Config $config -Contract $contract | Out-Null }
catch { $conflictingMediaTypeRejected = $_.Exception.Message -match "one immutable ECR manifest" }
Assert-Condition $conflictingMediaTypeRejected "Conflicting ECR media types for one digest must fail closed."
$assertions++
$script:ConflictingEcrMediaType = $false
$script:DuplicateEcrManifestRows = $false

$script:WrongEcrDigest = $true
$wrongDigestRejected = $false
try { Get-CertificationTaskPreflight -Config $config -Contract $contract | Out-Null }
catch { $wrongDigestRejected = $_.Exception.Message -match "one immutable ECR manifest" }
Assert-Condition $wrongDigestRejected "A mismatched ECR digest row must fail closed."
$assertions++
$script:WrongEcrDigest = $false

$script:BlankEcrMediaType = $true
$blankMediaTypeRejected = $false
try { Get-CertificationTaskPreflight -Config $config -Contract $contract | Out-Null }
catch { $blankMediaTypeRejected = $_.Exception.Message -match "one immutable ECR manifest" }
Assert-Condition $blankMediaTypeRejected "A blank ECR manifest media type must fail closed."
$assertions++
$script:BlankEcrMediaType = $false

$script:EcrManifestFailure = $true
$ecrFailureRejected = $false
try { Get-CertificationTaskPreflight -Config $config -Contract $contract | Out-Null }
catch { $ecrFailureRejected = $_.Exception.Message -match "one immutable ECR manifest" }
Assert-Condition $ecrFailureRejected "An explicit ECR manifest resolution failure must fail closed."
$assertions++
$script:EcrManifestFailure = $false

$script:BadScalableTarget = $true
$badTargetRejected = $false
try { Get-CertificationTaskPreflight -Config $config -Contract $contract | Out-Null }
catch { $badTargetRejected = $_.Exception.Message -match "min=6/max=8" }
Assert-Condition $badTargetRejected "Night Waf preflight must reject any scalable-target lease other than min6/max8."
$assertions++
$script:BadScalableTarget = $false

$script:MixedTaskRevision = $true
$mixedRejected = $false
try { Get-CertificationTaskPreflight -Config $config -Contract $contract | Out-Null }
catch { $mixedRejected = $_.Exception.Message -match "mixed or non-running" }
Assert-Condition $mixedRejected "Night Waf preflight must reject a mixed running-task revision."
$assertions++
$script:MixedTaskRevision = $false

$script:ScalableTargetCalls = 0
$endurance = $config.PSObject.Copy()
$endurance.workload = [pscustomobject]@{stage="endurance"}
$enduranceResult = Get-CertificationTaskPreflight -Config $endurance -Contract $contract
Assert-Condition ($script:ScalableTargetCalls -eq 0 -and $null -eq $enduranceResult.posture.loadStability.scalableTarget) `
    "Private endurance must retain live schedule/dynamic scaling and must not acquire the night min6 lease."
$assertions++

"AWS rollout certification-preflight tests: PASS ($assertions assertions)"
