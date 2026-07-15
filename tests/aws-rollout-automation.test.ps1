[CmdletBinding()]
param([switch]$AtomicJsonRaceOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$testClock = [Diagnostics.Stopwatch]::StartNew()
$script:AssertionCount = 0
$previousRolloutTestSentinel = $env:SCHOOLPILOT_ROLLOUT_TEST_MODE
$env:SCHOOLPILOT_ROLLOUT_TEST_MODE = "I_UNDERSTAND_TEST_ONLY"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    $script:AssertionCount++
    if (-not $Condition) { throw $Message }
}

function Get-AtomicJsonFunctionSource {
    param([string]$ScriptPath)
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$errors)
    Assert-Condition ($errors.Count -eq 0) "$ScriptPath must parse before atomic JSON stress extraction."
    $required = @("Get-AtomicJsonMutexName", "Invoke-WithAtomicJsonMutex", "Write-AtomicJson")
    $definitions = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $required
    }, $true))
    foreach ($name in $required) {
        $matches = @($definitions | Where-Object Name -eq $name)
        Assert-Condition ($matches.Count -eq 1) "$ScriptPath must define exactly one $name function."
    }
    return ($required | ForEach-Object { @($definitions | Where-Object Name -eq $_)[0].Extent.Text }) -join [Environment]::NewLine
}

function Invoke-AtomicJsonRaceRegression {
    param([string[]]$ScriptPaths, [string]$Root)
    $iterations = 12
    $readerCount = 3
    foreach ($scriptPath in $ScriptPaths) {
        $caseName = [IO.Path]::GetFileNameWithoutExtension($scriptPath)
        $caseRoot = Join-Path $Root "atomic-json-$caseName"
        [void][IO.Directory]::CreateDirectory($caseRoot)
        $destination = Join-Path $caseRoot "heartbeat.json"
        $auditPath = Join-Path $caseRoot "writer-audit.txt"
        [IO.File]::WriteAllText($destination, '{"sequence":0}', [Text.UTF8Encoding]::new($false))

        $functionSource = Get-AtomicJsonFunctionSource -ScriptPath $scriptPath
        $writerTemplate = @'
param([string]$Path,[string]$CaseRoot,[string]$AuditPath,[int]$Iterations,[int]$ReaderCount)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
__FUNCTIONS__
for($iteration=1;$iteration -le $Iterations;$iteration++){
  for($reader=1;$reader -le $ReaderCount;$reader++){
    $ready=Join-Path $CaseRoot "ready-$reader-$iteration"
    $deadline=[DateTimeOffset]::UtcNow.AddSeconds(10)
    while(-not [IO.File]::Exists($ready)){
      if([DateTimeOffset]::UtcNow -ge $deadline){throw "Reader $reader did not hold iteration $iteration."}
      Start-Sleep -Milliseconds 2
    }
  }
  Write-AtomicJson -Path $Path -Value ([ordered]@{sequence=$iteration;writerProcessId=$PID})
  [IO.File]::AppendAllText($AuditPath,"$iteration$([Environment]::NewLine)",[Text.UTF8Encoding]::new($false))
  for($reader=1;$reader -le $ReaderCount;$reader++){
    [IO.File]::WriteAllText((Join-Path $CaseRoot "ack-$reader-$iteration"),"ok",[Text.UTF8Encoding]::new($false))
  }
}
'@
        $writerSource = $writerTemplate.Replace("__FUNCTIONS__", $functionSource)
        $writerPath = Join-Path $caseRoot "writer.ps1"
        [IO.File]::WriteAllText($writerPath, $writerSource, [Text.UTF8Encoding]::new($false))
        $readerPath = Join-Path $caseRoot "reader.ps1"
        $readerSource = @'
param([string]$Path,[string]$CaseRoot,[int]$ReaderId,[int]$Iterations)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
for($iteration=1;$iteration -le $Iterations;$iteration++){
  $stream=$null
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds(10)
  while($null -eq $stream){
    try{$stream=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
    catch [IO.IOException]{
      if([DateTimeOffset]::UtcNow -ge $deadline){throw}
      Start-Sleep -Milliseconds 2
    }
  }
  try{
    $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false),$true,4096,$true)
    try{$record=$reader.ReadToEnd()|ConvertFrom-Json -Depth 10}
    finally{$reader.Dispose()}
    if($null -eq $record.sequence){throw "Observed incomplete JSON at iteration $iteration."}
    [IO.File]::WriteAllText((Join-Path $CaseRoot "ready-$ReaderId-$iteration"),"held",[Text.UTF8Encoding]::new($false))
    Start-Sleep -Milliseconds 100
  }
  finally{$stream.Dispose()}
  $ack=Join-Path $CaseRoot "ack-$ReaderId-$iteration"
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds(10)
  while(-not [IO.File]::Exists($ack)){
    if([DateTimeOffset]::UtcNow -ge $deadline){throw "Writer did not acknowledge iteration $iteration."}
    Start-Sleep -Milliseconds 2
  }
}
'@
        [IO.File]::WriteAllText($readerPath, $readerSource, [Text.UTF8Encoding]::new($false))

        $pwshPath = (Get-Process -Id $PID).Path
        $readers = @()
        for ($readerId=1; $readerId -le $readerCount; $readerId++) {
            $readers += Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile","-File",$readerPath,$destination,$caseRoot,[string]$readerId,[string]$iterations) `
                -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $caseRoot "reader-$readerId.out") -RedirectStandardError (Join-Path $caseRoot "reader-$readerId.err")
        }
        $writer = Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile","-File",$writerPath,$destination,$caseRoot,$auditPath,[string]$iterations,[string]$readerCount) `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $caseRoot "writer.out") -RedirectStandardError (Join-Path $caseRoot "writer.err")
        Assert-Condition ($writer.WaitForExit(60000)) "$caseName atomic writer timed out."
        foreach ($reader in $readers) { Assert-Condition ($reader.WaitForExit(60000)) "$caseName atomic reader timed out." }
        $writerError = Get-Content -LiteralPath (Join-Path $caseRoot "writer.err") -Raw -ErrorAction SilentlyContinue
        Assert-Condition ($writer.ExitCode -eq 0) "$caseName atomic writer failed: $writerError"
        for ($readerIndex=0; $readerIndex -lt $readers.Count; $readerIndex++) {
            $reader = $readers[$readerIndex]
            $readerError = Get-Content -LiteralPath (Join-Path $caseRoot "reader-$($readerIndex + 1).err") -Raw -ErrorAction SilentlyContinue
            Assert-Condition ($reader.ExitCode -eq 0) "$caseName concurrent atomic reader failed: $readerError"
        }
        $final = Get-Content -LiteralPath $destination -Raw | ConvertFrom-Json -Depth 10
        $audit = @(Get-Content -LiteralPath $auditPath)
        Assert-Condition ([int]$final.sequence -eq $iterations -and $audit.Count -eq $iterations -and [int]$audit[-1] -eq $iterations) "$caseName lost an atomic heartbeat overwrite under concurrent readers."
        Assert-Condition (@(Get-ChildItem -LiteralPath $caseRoot -Filter "*.tmp" -File).Count -eq 0) "$caseName left an atomic JSON temporary file behind."
    }
}

function Get-ArgumentValue {
    param([string[]]$Arguments, [string]$Name)
    $index = [Array]::IndexOf($Arguments, $Name)
    if ($index -lt 0 -or $index + 1 -ge $Arguments.Count) { return $null }
    return $Arguments[$index + 1]
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$monitorScript = Join-Path $repositoryRoot "scripts\load\aws-rollout-monitor.ps1"
$rollbackScript = Join-Path $repositoryRoot "scripts\load\aws-rollout-rollback.ps1"
$supervisorScript = Join-Path $repositoryRoot "scripts\load\start-aws-rollout-supervisor.ps1"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("schoolpilot-rollout-test-" + [Guid]::NewGuid().ToString("N"))
$evidenceDirectory = Join-Path $tempRoot "evidence"
$global:SchoolPilotTestAwsCalls = [System.Collections.Generic.List[string]]::new()
$global:SchoolPilotTestTerraformCalls = [System.Collections.Generic.List[string]]::new()
$global:SchoolPilotTestWafUpdate = $null
$global:SchoolPilotTestNetworkPayloads = [System.Collections.Generic.List[object]]::new()
$global:SchoolPilotTestDeploymentPayloads = [System.Collections.Generic.List[object]]::new()
$global:SchoolPilotTestTaskUpdateObservations = [System.Collections.Generic.List[object]]::new()
$global:SchoolPilotTestUpdateServiceCallCount = 0
$global:SchoolPilotTestFailUpdateServiceCalls = @()
$global:SchoolPilotTestServiceState = @{
    api = [ordered]@{ taskDefinition = "api-current"; desired = 1; running = 1; pending = 0; subnets = @("subnet-public-a", "subnet-public-b"); securityGroups = @("sg-ecs"); assignPublicIp = "ENABLED"; deploymentConfiguration = [ordered]@{ deploymentCircuitBreaker = [ordered]@{ enable = $true; rollback = $true }; maximumPercent = 200; minimumHealthyPercent = 100; strategy = "ROLLING" } }
    worker = [ordered]@{ taskDefinition = "worker-current"; desired = 1; running = 1; pending = 0; subnets = @("subnet-public-a", "subnet-public-b"); securityGroups = @("sg-ecs"); assignPublicIp = "ENABLED"; deploymentConfiguration = [ordered]@{ deploymentCircuitBreaker = [ordered]@{ enable = $true; rollback = $true }; maximumPercent = 200; minimumHealthyPercent = 100; strategy = "ROLLING" } }
}
$global:SchoolPilotTestWafCount = $false
$global:SchoolPilotTestMetricQueryIds = @()
$global:SchoolPilotTestMetricQueryPeriods = @{}
$global:SchoolPilotTestMetricQueryStatistics = @{}
$global:SchoolPilotTestMetricLookbackSeconds = $null
$global:SchoolPilotTestEcsCpuAverage = 20.0
$global:SchoolPilotTestEcsCpuMaximum = 20.0
$global:SchoolPilotTestOmitEcsCpuMaximum = $false
$global:SchoolPilotTestEcsCpuMaximumTimestamp = $null
$global:SchoolPilotTestRouteLatency = $true
$global:SchoolPilotTestRedisNodeType = "cache.t4g.small"
$global:SchoolPilotTestPublicIpv4 = $true
$global:SchoolPilotTestAutomatedSnapshotAfter = $null
$global:SchoolPilotTestTerraformLineage = "test-lineage"
$global:SchoolPilotTestNatAvailable = $true
$global:SchoolPilotTestPlanShapeInvalid = $false
$global:SchoolPilotTestStoppedTaskLifecycle = $false
$global:SchoolPilotTestStoppedTaskDescribeCalls = 0

function global:aws {
    $arguments = @($args | ForEach-Object { [string]$_ })
    $global:SchoolPilotTestAwsCalls.Add($arguments -join " ")
    $global:LASTEXITCODE = 0
    $service = $arguments[0]
    $operation = $arguments[1]

    if ($service -eq "ecs" -and $operation -eq "describe-services") {
        return (@{
            services = @(
                @{ serviceName = "api"; desiredCount = $global:SchoolPilotTestServiceState.api.desired; runningCount = $global:SchoolPilotTestServiceState.api.running; pendingCount = $global:SchoolPilotTestServiceState.api.pending; taskDefinition = $global:SchoolPilotTestServiceState.api.taskDefinition; deploymentConfiguration = $global:SchoolPilotTestServiceState.api.deploymentConfiguration; deployments = @(@{ status = "PRIMARY" }); networkConfiguration = @{ awsvpcConfiguration = @{ subnets = $global:SchoolPilotTestServiceState.api.subnets; securityGroups = $global:SchoolPilotTestServiceState.api.securityGroups; assignPublicIp = $global:SchoolPilotTestServiceState.api.assignPublicIp } } },
                @{ serviceName = "worker"; desiredCount = $global:SchoolPilotTestServiceState.worker.desired; runningCount = $global:SchoolPilotTestServiceState.worker.running; pendingCount = $global:SchoolPilotTestServiceState.worker.pending; taskDefinition = $global:SchoolPilotTestServiceState.worker.taskDefinition; deploymentConfiguration = $global:SchoolPilotTestServiceState.worker.deploymentConfiguration; deployments = @(@{ status = "PRIMARY" }); networkConfiguration = @{ awsvpcConfiguration = @{ subnets = $global:SchoolPilotTestServiceState.worker.subnets; securityGroups = $global:SchoolPilotTestServiceState.worker.securityGroups; assignPublicIp = $global:SchoolPilotTestServiceState.worker.assignPublicIp } } }
            )
        } | ConvertTo-Json -Depth 8 -Compress)
    }
    if ($service -eq "ecs" -and $operation -eq "list-tasks") {
        $desired = Get-ArgumentValue -Arguments $arguments -Name "--desired-status"
        $serviceName = Get-ArgumentValue -Arguments $arguments -Name "--service-name"
        if ($desired -eq "RUNNING") { return (@{taskArns=@("arn:aws:ecs:us-east-1:000000000000:task/cluster/$serviceName-running")}|ConvertTo-Json -Compress) }
        return '{"taskArns":["arn:aws:ecs:us-east-1:000000000000:task/cluster/scale-in-task"]}'
    }
    if ($service -eq "ecs" -and $operation -eq "describe-tasks") {
        if (($arguments -join " ") -match '-running') {
            $tasks = @($arguments | Where-Object { $_ -match '-running$' } | ForEach-Object {
                $suffix = ($_ -split '/')[-1]
                @{taskArn=$_;attachments=@(@{type="ElasticNetworkInterface";details=@(@{name="networkInterfaceId";value="eni-$suffix"})})}
            })
            return (@{tasks=$tasks}|ConvertTo-Json -Depth 8 -Compress)
        }
        $global:SchoolPilotTestStoppedTaskDescribeCalls++
        $stoppedTask = [ordered]@{
            taskArn = "arn:aws:ecs:us-east-1:123456789012:task/cluster/scale-in-task"
            group = "service:api"
            stopCode = "ServiceSchedulerInitiated"
            stoppedReason = "Scaling activity initiated by deployment ecs-svc/test"
            containers = @(@{ exitCode = 0; reason = "" })
        }
        if (-not $global:SchoolPilotTestStoppedTaskLifecycle -or $global:SchoolPilotTestStoppedTaskDescribeCalls -gt 1) {
            $stoppedTask.stoppedAt = [DateTimeOffset]::UtcNow.ToString("o")
        }
        return (@{ tasks = @($stoppedTask) } | ConvertTo-Json -Depth 8 -Compress)
    }
    if ($service -eq "elbv2" -and $operation -eq "describe-target-health") {
        return '{"TargetHealthDescriptions":[{"TargetHealth":{"State":"healthy"}}]}'
    }
    if ($service -eq "rds" -and $operation -eq "describe-db-instances") {
        return '{"DBInstances":[{"DBInstanceStatus":"available","AllocatedStorage":100,"MaxAllocatedStorage":1000,"PendingModifiedValues":{}}]}'
    }
    if ($service -eq "elasticache" -and $operation -eq "describe-replication-groups") {
        return (@{ReplicationGroups=@(@{Status="available";CacheNodeType=$global:SchoolPilotTestRedisNodeType;PendingModifiedValues=@{}})}|ConvertTo-Json -Depth 5 -Compress)
    }
    if ($service -eq "elasticache" -and $operation -eq "describe-snapshots") {
        $snapshots = if ($null -eq $global:SchoolPilotTestAutomatedSnapshotAfter) { @() } else {
            @(@{SnapshotName="automatic-after-resize";SnapshotStatus="available";NodeSnapshots=@(@{SnapshotCreateTime=$global:SchoolPilotTestAutomatedSnapshotAfter})})
        }
        return (@{Snapshots=$snapshots}|ConvertTo-Json -Depth 8 -Compress)
    }
    if ($service -eq "elasticache" -and $operation -in @("modify-replication-group", "wait")) { return '{}' }
    if ($service -eq "ec2" -and $operation -eq "describe-nat-gateways") {
        if (-not $global:SchoolPilotTestNatAvailable) { return '{"NatGateways":[]}' }
        return '{"NatGateways":[{"NatGatewayId":"nat-1","State":"available","NatGatewayAddresses":[{"AssociationId":"eipassoc-1"}]},{"NatGatewayId":"nat-2","State":"available","NatGatewayAddresses":[{"AssociationId":"eipassoc-2"}]}]}'
    }
    if ($service -eq "ec2" -and $operation -eq "describe-route-tables") {
        return '{"RouteTables":[{"RouteTableId":"rtb-private-a","Routes":[{"DestinationCidrBlock":"0.0.0.0/0","NatGatewayId":"nat-1","State":"active"}]},{"RouteTableId":"rtb-private-b","Routes":[{"DestinationCidrBlock":"0.0.0.0/0","NatGatewayId":"nat-2","State":"active"}]}]}'
    }
    if ($service -eq "ec2" -and $operation -eq "describe-network-interfaces") {
        $ids = @($arguments | Where-Object { $_ -match '^eni-' })
        return (@{NetworkInterfaces=@($ids|ForEach-Object { @{NetworkInterfaceId=$_;Association=if($global:SchoolPilotTestPublicIpv4){@{PublicIp="198.51.100.10"}}else{@{}}} })}|ConvertTo-Json -Depth 8 -Compress)
    }
    if ($service -eq "route53" -and $operation -eq "get-health-check-status") {
        return '{"HealthCheckObservations":[{"StatusReport":{"Status":"Success: HTTP Status Code 200"}}]}'
    }
    if ($service -eq "route53" -and $operation -eq "get-health-check") {
        return (@{ HealthCheck = @{ HealthCheckConfig = @{ Type = "HTTPS"; ResourcePath = "/health"; MeasureLatency = $global:SchoolPilotTestRouteLatency } } } | ConvertTo-Json -Depth 5 -Compress)
    }
    if ($service -eq "cloudwatch" -and $operation -eq "describe-alarms") {
        return '{"MetricAlarms":[{"AlarmName":"route53-alarm","StateValue":"OK"}]}'
    }
    if ($service -eq "cloudwatch" -and $operation -eq "get-metric-data") {
        $metricStartArgument = Get-ArgumentValue -Arguments $arguments -Name "--start-time"
        $metricEndArgument = Get-ArgumentValue -Arguments $arguments -Name "--end-time"
        if ($null -ne $metricStartArgument -and $null -ne $metricEndArgument) {
            $metricStart = [DateTimeOffset]$metricStartArgument
            $metricEnd = [DateTimeOffset]$metricEndArgument
            $global:SchoolPilotTestMetricLookbackSeconds = ($metricEnd - $metricStart).TotalSeconds
        }
        $inputReference = Get-ArgumentValue -Arguments $arguments -Name "--metric-data-queries"
        $inputPath = $inputReference.Substring("file://".Length)
        $queries = @(Get-Content -LiteralPath $inputPath -Raw | ConvertFrom-Json -Depth 20)
        $global:SchoolPilotTestMetricQueryIds = @($queries.Id)
        $global:SchoolPilotTestMetricQueryPeriods = @{}
        $global:SchoolPilotTestMetricQueryStatistics = @{}
        foreach ($query in $queries) {
            $global:SchoolPilotTestMetricQueryPeriods[[string]$query.Id] = [int]$query.MetricStat.Period
            $global:SchoolPilotTestMetricQueryStatistics[[string]$query.Id] = [string]$query.MetricStat.Stat
        }
        $timestamp = [DateTimeOffset]::UtcNow.ToString("o")
        $results = @($queries | ForEach-Object {
            $metricId = [string]$_.Id
            if ($global:SchoolPilotTestOmitEcsCpuMaximum -and $metricId -match '^ecs_.*_cpu_maximum$') {
                @{ Id = $metricId; StatusCode = "Complete"; Timestamps = @(); Values = @() }
            }
            else {
                $value = switch -Regex ($metricId) {
                    '^ecs_.*_cpu_maximum$' { $global:SchoolPilotTestEcsCpuMaximum; break }
                    '^ecs_.*_cpu$' { $global:SchoolPilotTestEcsCpuAverage; break }
                    '^ecs_.*_memory$' { 20; break }
                    '^rds_cpu$' { 10; break }
                    '^rds_connections$' { 20; break }
                    '^rds_free_storage$' { 85899345920; break }
                    '^rds_free_memory$' { 1073741824; break }
                    '^rds_cpu_credit$' { 100; break }
                    '^redis_cpu$' { 10; break }
                    '^redis_memory$' { 20; break }
                    '^redis_free$' { 209715200; break }
                    '^redis_cpu_credit$' { 100; break }
                    default { 0 }
                }
                $metricTimestamp = if ($null -ne $global:SchoolPilotTestEcsCpuMaximumTimestamp -and
                    $metricId -match '^ecs_.*_cpu_maximum$') {
                    [string]$global:SchoolPilotTestEcsCpuMaximumTimestamp
                } else { $timestamp }
                @{ Id = $metricId; StatusCode = "Complete"; Timestamps = @($metricTimestamp); Values = @($value) }
            }
        })
        return (@{ MetricDataResults = $results } | ConvertTo-Json -Depth 8 -Compress)
    }
    if ($service -eq "sns" -and $operation -eq "publish") { return '{"MessageId":"mock-message"}' }
    if ($service -eq "wafv2" -and $operation -eq "list-web-acls") {
        return '{"WebACLs":[{"Name":"acl","Id":"acl-id"}]}'
    }
    if ($service -eq "wafv2" -and $operation -eq "get-web-acl") {
        $rateAction = if ($global:SchoolPilotTestWafCount) { @{ Count = @{} } } else { @{ Block = @{} } }
        return (@{
            LockToken = "mock-lock"
            WebACL = @{
                DefaultAction = @{ Allow = @{} }
                Description = ""
                Rules = @(
                    @{ Name = "Managed"; Priority = 1; OverrideAction = @{ None = @{} }; Statement = @{ ManagedRuleGroupStatement = @{ Name = "Managed"; VendorName = "AWS" } }; VisibilityConfig = @{ SampledRequestsEnabled = $true; CloudWatchMetricsEnabled = $true; MetricName = "managed" } },
                    @{ Name = "DeviceIngestRateLimit"; Priority = 30; Action = $rateAction; Statement = @{ RateBasedStatement = @{ Limit = 100000; AggregateKeyType = "IP" } }; VisibilityConfig = @{ SampledRequestsEnabled = $true; CloudWatchMetricsEnabled = $true; MetricName = "device" } },
                    @{ Name = "ApiRateLimit"; Priority = 40; Action = $rateAction; Statement = @{ RateBasedStatement = @{ Limit = 50000; AggregateKeyType = "IP" } }; VisibilityConfig = @{ SampledRequestsEnabled = $true; CloudWatchMetricsEnabled = $true; MetricName = "api" } }
                )
                VisibilityConfig = @{ SampledRequestsEnabled = $true; CloudWatchMetricsEnabled = $true; MetricName = "acl" }
            }
        } | ConvertTo-Json -Depth 20 -Compress)
    }
    if ($service -eq "wafv2" -and $operation -eq "update-web-acl") {
        $inputReference = Get-ArgumentValue -Arguments $arguments -Name "--cli-input-json"
        $inputPath = $inputReference.Substring("file://".Length)
        $global:SchoolPilotTestWafUpdate = Get-Content -LiteralPath $inputPath -Raw | ConvertFrom-Json -Depth 30
        $global:SchoolPilotTestWafCount = $true
        return '{}'
    }
    if ($service -eq "ecs" -and $operation -eq "update-service") {
        $global:SchoolPilotTestUpdateServiceCallCount++
        if ($global:SchoolPilotTestUpdateServiceCallCount -in @($global:SchoolPilotTestFailUpdateServiceCalls)) {
            throw "Mock update-service failure at call $($global:SchoolPilotTestUpdateServiceCallCount)."
        }
        $serviceName = Get-ArgumentValue -Arguments $arguments -Name "--service"
        $taskDefinition = Get-ArgumentValue -Arguments $arguments -Name "--task-definition"
        if ($taskDefinition) {
            $global:SchoolPilotTestTaskUpdateObservations.Add([pscustomobject]@{
                service = $serviceName
                taskDefinition = $taskDefinition
                desired = [int]$global:SchoolPilotTestServiceState[$serviceName].desired
                deploymentConfiguration = ($global:SchoolPilotTestServiceState[$serviceName].deploymentConfiguration | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20)
            })
            $global:SchoolPilotTestServiceState[$serviceName].taskDefinition = $taskDefinition
        }
        $deploymentReference = Get-ArgumentValue -Arguments $arguments -Name "--deployment-configuration"
        if ($deploymentReference) {
            $deploymentPath = $deploymentReference.Substring("file://".Length)
            $deploymentPayload = Get-Content -LiteralPath $deploymentPath -Raw | ConvertFrom-Json -Depth 20
            $global:SchoolPilotTestDeploymentPayloads.Add([pscustomobject]@{
                service = $serviceName
                configuration = $deploymentPayload
            })
            $global:SchoolPilotTestServiceState[$serviceName].deploymentConfiguration = $deploymentPayload
        }
        $networkReference = Get-ArgumentValue -Arguments $arguments -Name "--network-configuration"
        if ($networkReference) {
            $networkPath = $networkReference.Substring("file://".Length)
            $payload = Get-Content -LiteralPath $networkPath -Raw | ConvertFrom-Json -Depth 10
            $global:SchoolPilotTestNetworkPayloads.Add($payload)
            $global:SchoolPilotTestServiceState[$serviceName].subnets = @($payload.awsvpcConfiguration.subnets)
            $global:SchoolPilotTestServiceState[$serviceName].securityGroups = @($payload.awsvpcConfiguration.securityGroups)
            $global:SchoolPilotTestServiceState[$serviceName].assignPublicIp = [string]$payload.awsvpcConfiguration.assignPublicIp
        }
        return '{}'
    }
    if ($service -eq "ecs" -and $operation -eq "wait") { return '{}' }
    throw "Unexpected mocked AWS call: $($arguments -join ' ')"
}

function global:terraform {
    $arguments = @($args | ForEach-Object { [string]$_ })
    $global:SchoolPilotTestTerraformCalls.Add($arguments -join " ")
    $global:LASTEXITCODE = 0
    if (($arguments -join " ") -eq "state pull") {
        return (@{version=4;terraform_version="1.12.2";serial=1;lineage=$global:SchoolPilotTestTerraformLineage;outputs=@{};resources=@()}|ConvertTo-Json -Depth 5 -Compress)
    }
    if ($arguments.Count -ge 2 -and $arguments[0] -eq "show" -and $arguments[1] -eq "-json") {
        $addresses = @(
            "module.vpc.aws_eip.nat[0]", "module.vpc.aws_eip.nat[1]",
            "module.vpc.aws_nat_gateway.main[0]", "module.vpc.aws_nat_gateway.main[1]",
            "module.vpc.aws_route.private_nat[0]", "module.vpc.aws_route.private_nat[1]"
        )
        $changes = @($addresses | ForEach-Object { @{address=$_;change=@{actions=@("create")}} })
        if ($global:SchoolPilotTestPlanShapeInvalid) { $changes += @{address="module.vpc.aws_security_group.unreviewed";change=@{actions=@("update")}} }
        return (@{format_version="1.2";resource_changes=$changes}|ConvertTo-Json -Depth 8 -Compress)
    }
}

try {
    [void][IO.Directory]::CreateDirectory($evidenceDirectory)
    Invoke-AtomicJsonRaceRegression -ScriptPaths @($monitorScript,$rollbackScript,$supervisorScript) -Root $tempRoot
    if ($AtomicJsonRaceOnly) {
        $testClock.Stop()
        Write-Host ("AWS rollout atomic JSON race tests: PASS ({0} assertions, {1:N1}s)" -f $script:AssertionCount,$testClock.Elapsed.TotalSeconds)
        return
    }

    $monitorConfigPath = Join-Path $tempRoot "monitor.json"
    $monitorConfig = @{
        schemaVersion = 1
        testEnvironmentSentinel = "SCHOOLPILOT_ROLLOUT_TEST_ONLY"
        runId = "monitor-test"
        phase = "PublicEcs"
        evidenceDirectory = $evidenceDirectory
        automaticRollback = $false
        notificationTopicArn = "arn:aws:sns:us-east-1:000000000000:test-alerts"
        pollSeconds = 1
        testMode = $true
        maxIterations = 1
        minimumWallClockSeconds = 0
        deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
        resources = @{
            region = "us-east-1"
            cluster = "cluster"
            apiService = "api"
            workerService = "worker"
            targetGroupArn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/test/123"
            rdsInstanceId = "db"
            redisCacheClusterId = "redis-001"
            redisReplicationGroupId = "redis"
            vpcId = "vpc-1"
            route53HealthCheckId = "health-1"
            wafWebAclName = "web-acl"
            wafDeviceRuleMetricName = "device"
            wafApiRuleMetricName = "api"
            route53AlarmName = "route53-alarm"
            expectedNatGatewayCount = 2
            expectedRoute53MeasureLatency = $true
            expectedEcsAssignPublicIp = $true
            ecsTaskSubnetIds = @("subnet-public-a", "subnet-public-b")
            expectedRedisNodeType = "cache.t4g.small"
        }
    }
    [IO.File]::WriteAllText($monitorConfigPath, ($monitorConfig | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    & $monitorScript -ConfigPath $monitorConfigPath -Mode Monitor | Out-Null

    $monitorResultPath = Join-Path $evidenceDirectory "monitor-test-monitor-result.json"
    Assert-Condition (Test-Path -LiteralPath $monitorResultPath) "Monitor should write an atomic result."
    $monitorResult = Get-Content -LiteralPath $monitorResultPath -Raw | ConvertFrom-Json
    Assert-Condition ($monitorResult.status -eq "completed") "Healthy mocked telemetry should complete (result: $($monitorResult | ConvertTo-Json -Compress -Depth 10))."
    Assert-Condition (($global:SchoolPilotTestAwsCalls -join "`n").Contains("ecs describe-tasks")) "Healthy monitor test must exercise expected autoscaling/deployment stop classification."
    $monitorCalls = $global:SchoolPilotTestAwsCalls -join "`n"
    foreach ($expected in @("ecs describe-services", "elbv2 describe-target-health", "rds describe-db-instances", "elasticache describe-replication-groups", "cloudwatch get-metric-data", "ec2 describe-nat-gateways", "route53 get-health-check-status", "sns publish")) {
        Assert-Condition ($monitorCalls.Contains($expected)) "Monitor did not poll or notify through '$expected'."
    }
    Assert-Condition ($global:SchoolPilotTestMetricQueryIds -contains "waf_device_blocked" -and $global:SchoolPilotTestMetricQueryIds -contains "waf_api_blocked") "Monitor did not poll both WAF rate-rule metrics."
    Assert-Condition ([double]$global:SchoolPilotTestMetricLookbackSeconds -eq 900) "CloudWatch metric lookback must retain 15 minutes of credit telemetry for three stale confirmations."
    foreach ($fiveMinuteMetric in @("rds_cpu_credit", "rds_surplus_charged", "redis_cpu_credit")) {
        Assert-Condition ([int]$global:SchoolPilotTestMetricQueryPeriods[$fiveMinuteMetric] -eq 300) "Five-minute metric '$fiveMinuteMetric' must use a 300-second CloudWatch period."
    }
    foreach ($oneMinuteMetric in @("ecs_api_cpu", "ecs_api_cpu_maximum", "ecs_worker_cpu", "ecs_worker_cpu_maximum", "waf_device_blocked", "waf_api_blocked")) {
        Assert-Condition ([int]$global:SchoolPilotTestMetricQueryPeriods[$oneMinuteMetric] -eq 60) "One-minute metric '$oneMinuteMetric' must retain a 60-second CloudWatch period."
    }
    Assert-Condition ($global:SchoolPilotTestMetricQueryStatistics["ecs_api_cpu"] -eq "Average" -and
        $global:SchoolPilotTestMetricQueryStatistics["ecs_worker_cpu"] -eq "Average") "ECS CPU gate series must use CloudWatch one-minute Average."
    Assert-Condition ($global:SchoolPilotTestMetricQueryStatistics["ecs_api_cpu_maximum"] -eq "Maximum" -and
        $global:SchoolPilotTestMetricQueryStatistics["ecs_worker_cpu_maximum"] -eq "Maximum") "ECS CPU peak-evidence series must retain CloudWatch one-minute Maximum."

    $global:SchoolPilotTestEcsCpuAverage = 20.0
    $global:SchoolPilotTestEcsCpuMaximum = 99.0
    $ecsCpuEvidenceConfig = $monitorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $ecsCpuEvidenceConfig.runId = "ecs-cpu-maximum-evidence-only"
    $ecsCpuEvidenceConfig.maxIterations = 4
    $ecsCpuEvidenceConfig.minimumWallClockSeconds = 3
    $ecsCpuEvidenceConfigPath = Join-Path $tempRoot "ecs-cpu-maximum-evidence-only.json"
    [IO.File]::WriteAllText($ecsCpuEvidenceConfigPath, ($ecsCpuEvidenceConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    & $monitorScript -ConfigPath $ecsCpuEvidenceConfigPath -Mode Monitor | Out-Null
    $ecsCpuEvidenceResult = Get-Content -LiteralPath (Join-Path $evidenceDirectory "ecs-cpu-maximum-evidence-only-monitor-result.json") -Raw | ConvertFrom-Json -Depth 30
    $ecsCpuEvidenceSample = Get-Content -LiteralPath (Join-Path $evidenceDirectory "ecs-cpu-maximum-evidence-only-aws-monitor.jsonl") -Tail 1 | ConvertFrom-Json -Depth 30
    Assert-Condition ($ecsCpuEvidenceResult.status -eq "completed" -and $ecsCpuEvidenceResult.acceptance.passed -and
        -not ($ecsCpuEvidenceResult.acceptance.violations -contains "ecs_api_cpu_steady") -and
        -not ($ecsCpuEvidenceResult.acceptance.violations -contains "ecs_api_cpu_p95")) "A high ECS Maximum with a healthy Average must remain evidence-only and must not trip runtime, steady, or p95 gates."
    Assert-Condition ([double]$ecsCpuEvidenceSample.metrics.ecs.api.cpuPercent -eq 20.0 -and
        [double]$ecsCpuEvidenceSample.metrics.ecs.api.cpuMaximumPercent -eq 99.0) "Per-sample ECS evidence must distinguish Average gate CPU from Maximum peak CPU."
    Assert-Condition ([double]$ecsCpuEvidenceResult.acceptance.metrics.ecs_api_cpu.p95 -eq 20.0 -and
        [double]$ecsCpuEvidenceResult.acceptance.metrics.ecs_api_cpu_maximum.maximum -eq 99.0) "Acceptance evidence must compute p95 from Average while retaining the separate Maximum series."
    $global:SchoolPilotTestEcsCpuMaximum = 20.0

    foreach ($maximumEvidenceCase in @(
        [pscustomobject]@{
            name = "missing"
            omit = $true
            timestamp = $null
        },
        [pscustomobject]@{
            name = "stale"
            omit = $false
            timestamp = [DateTimeOffset]::UtcNow.AddMinutes(-10).ToString("o")
        }
    )) {
        $global:SchoolPilotTestOmitEcsCpuMaximum = [bool]$maximumEvidenceCase.omit
        $global:SchoolPilotTestEcsCpuMaximumTimestamp = $maximumEvidenceCase.timestamp
        $maximumEvidenceConfig = $monitorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $maximumEvidenceConfig.runId = "ecs-cpu-maximum-$($maximumEvidenceCase.name)-invalid"
        $maximumEvidenceConfig.maxIterations = 4
        $maximumEvidenceConfig.minimumWallClockSeconds = 3
        $maximumEvidenceConfig | Add-Member -NotePropertyName testTelemetryExpectedSeconds -NotePropertyValue 120
        $maximumEvidenceConfig | Add-Member -NotePropertyName testTelemetryMetricNames -NotePropertyValue @(
            "ecs_api_cpu_maximum", "ecs_worker_cpu_maximum"
        )
        $maximumEvidenceConfigPath = Join-Path $tempRoot "$($maximumEvidenceConfig.runId).json"
        [IO.File]::WriteAllText($maximumEvidenceConfigPath, ($maximumEvidenceConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        & $monitorScript -ConfigPath $maximumEvidenceConfigPath -Mode Monitor | Out-Null
        $maximumEvidenceExitCode = $LASTEXITCODE
        $global:SchoolPilotTestOmitEcsCpuMaximum = $false
        $global:SchoolPilotTestEcsCpuMaximumTimestamp = $null

        $maximumEvidenceResult = Get-Content -LiteralPath (Join-Path $evidenceDirectory "$($maximumEvidenceConfig.runId)-monitor-result.json") -Raw | ConvertFrom-Json -Depth 30
        Assert-Condition ($maximumEvidenceExitCode -eq 2 -and $maximumEvidenceResult.status -eq "failed" -and
            $maximumEvidenceResult.failures -contains "run_acceptance_failed") "Missing/stale ECS Maximum telemetry must invalidate the completed run."
        foreach ($series in @("ecs_api_cpu_maximum", "ecs_worker_cpu_maximum")) {
            Assert-Condition ($maximumEvidenceResult.acceptance.violations -contains "telemetry_coverage:$series") "Missing/stale ECS Maximum telemetry must fail mandatory coverage for $series."
        }
        Assert-Condition (-not $maximumEvidenceResult.rollback.approved -and -not $maximumEvidenceResult.rollback.attempted -and
            $maximumEvidenceResult.rollback.reason -match "cumulative acceptance") "Missing/stale ECS Maximum evidence must invalidate without guessing at an infrastructure rollback."
    }

    $global:SchoolPilotTestStoppedTaskLifecycle = $true
    $global:SchoolPilotTestStoppedTaskDescribeCalls = 0
    $stoppingTaskConfig = $monitorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $stoppingTaskConfig.runId = "stopping-task-lifecycle-test"
    $stoppingTaskConfig.maxIterations = 2
    # Keep completion deliberately out of reach so a slower CI runner cannot
    # satisfy the wall clock after the first sample and skip the lifecycle's
    # second observation. The bounded iteration-limit exit is expected here;
    # this case verifies that the transition itself never triggers a gate.
    $stoppingTaskConfig.minimumWallClockSeconds = 3600
    $stoppingTaskConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddHours(2).ToString("o")
    $stoppingTaskConfigPath = Join-Path $tempRoot "stopping-task-lifecycle.json"
    [IO.File]::WriteAllText($stoppingTaskConfigPath, ($stoppingTaskConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    & $monitorScript -ConfigPath $stoppingTaskConfigPath -Mode Monitor | Out-Null
    $stoppingTaskExitCode = $LASTEXITCODE
    $stoppingTaskResult = Get-Content -LiteralPath (Join-Path $evidenceDirectory "stopping-task-lifecycle-test-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
    $stoppingTaskSamples = @(Get-Content -LiteralPath (Join-Path $evidenceDirectory "stopping-task-lifecycle-test-aws-monitor.jsonl") | ForEach-Object { $_ | ConvertFrom-Json -Depth 30 })
    Assert-Condition ($stoppingTaskExitCode -eq 2 -and $stoppingTaskResult.status -eq "failed" -and
        $stoppingTaskResult.failures -contains "monitor_iteration_limit_reached_before_acceptance" -and
        $stoppingTaskSamples.Count -eq 2) "The bounded lifecycle test must end only at its deliberate iteration limit after two samples."
    Assert-Condition (@($stoppingTaskSamples | Where-Object { $_.triggered -or $_.immediateFailures -contains "monitor_exception" }).Count -eq 0) "A DEACTIVATING task without stoppedAt must not crash or trigger a monitoring gate."
    Assert-Condition (@($stoppingTaskSamples[0].stoppedTasks).Count -eq 0) "An incomplete ECS stop transition must remain pending until stoppedAt is published."
    Assert-Condition (@($stoppingTaskSamples[1].stoppedTasks).Count -eq 1 -and $stoppingTaskSamples[1].stoppedTasks[0].expectedScaleOrDeploymentStop) "The completed scale-in must be observed and classified on the next sample."
    $global:SchoolPilotTestStoppedTaskLifecycle = $false
    $global:SchoolPilotTestStoppedTaskDescribeCalls = 0

    $isolatedConfig = $monitorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $isolatedConfig.runId = "missing-test-sentinel"
    $isolatedConfig.PSObject.Properties.Remove("testEnvironmentSentinel")
    $isolatedConfigPath = Join-Path $tempRoot "missing-test-sentinel.json"
    [IO.File]::WriteAllText($isolatedConfigPath, ($isolatedConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $testModeBypassRejected = $false
    try { & $monitorScript -ConfigPath $isolatedConfigPath -Mode Validate | Out-Null }
    catch { $testModeBypassRejected = $_.Exception.Message -match "test-only config sentinel" }
    Assert-Condition $testModeBypassRejected "testMode must not bypass production locks without both explicit isolation sentinels."

    $dummyRollbackPath = Join-Path $tempRoot "production-lock-dummy-rollback.json"
    [IO.File]::WriteAllText($dummyRollbackPath, '{}', [Text.UTF8Encoding]::new($false))
    $production800 = @{
        schemaVersion=1;runId="production-800-missing-predecessor";phase="Waf";evidenceDirectory=(Join-Path $tempRoot "production-800-evidence");
        loadProgressPath=(Join-Path $tempRoot "production-800-progress.jsonl");loadSummaryPath=(Join-Path $tempRoot "production-800-summary.json");
        artifactsNotBeforeUtc=[DateTimeOffset]::UtcNow.ToString("o");
        expectedGeneratorPublicIp="203.0.113.10";
        minimumWallClockSeconds=5400;deadlineUtc=[DateTimeOffset]::UtcNow.AddHours(2).ToString("o");
        workload=@{stage="800";devices=810;durationSeconds=5400;screenshotBytes=40960;canaryDevices=10}
    }
    $production800Path = Join-Path $tempRoot "production-800-missing-predecessor.json"
    [IO.File]::WriteAllText($production800Path, ($production800|ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $predecessorRequired = $false
    $predecessorError = ""
    try { & $monitorScript -ConfigPath $production800Path -Mode Validate | Out-Null }
    catch { $predecessorError=$_.Exception.Message;$predecessorRequired = $predecessorError -match "predecessorResultPath" }
    Assert-Condition $predecessorRequired "The immutable Waf500→Waf800 progression must require hashed predecessor acceptance evidence (actual: $predecessorError)."

    $publicEcsLoadResultPath = Join-Path $tempRoot "public-ecs-800-result.json"
    $publicEcsLoadResult = @{runId="public-800";phase="PublicEcs";status="completed";loadAccepted=$true;postureAccepted=$true;
        minimumWallClockSeconds=5400;workload=@{stage="800"};acceptance=@{passed=$true}}
    [IO.File]::WriteAllText($publicEcsLoadResultPath, ($publicEcsLoadResult|ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $natProgression = $production800 | ConvertTo-Json -Depth 12 | ConvertFrom-Json -Depth 12
    $natProgression.runId = "nat-requires-public-soak"
    $natProgression.phase = "NatRemoved"
    $natProgression | Add-Member -NotePropertyName predecessorResultPath -NotePropertyValue $publicEcsLoadResultPath -Force
    $natProgression | Add-Member -NotePropertyName predecessorResultSha256 -NotePropertyValue ((Get-FileHash $publicEcsLoadResultPath -Algorithm SHA256).Hash.ToLowerInvariant()) -Force
    $natProgressionPath = Join-Path $tempRoot "nat-requires-public-soak.json"
    [IO.File]::WriteAllText($natProgressionPath, ($natProgression|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $natRejectedLoadOnlyPredecessor = $false
    try { & $monitorScript -ConfigPath $natProgressionPath -Mode Validate | Out-Null }
    catch { $natRejectedLoadOnlyPredecessor = $_.Exception.Message -match "PublicEcs no-load posture" }
    Assert-Condition $natRejectedLoadOnlyPredecessor "NatRemoved 800 must require the accepted 24-hour PublicEcs soak, not merely the earlier PublicEcs 800 load result."

    $productionLoadAcceptance = $production800 | ConvertTo-Json -Depth 12 | ConvertFrom-Json -Depth 12
    $productionLoadAcceptance.runId = "production-load-acceptance-lock"
    $productionLoadAcceptance.workload = [pscustomobject]@{stage="500";devices=510;durationSeconds=1800;screenshotBytes=40960;canaryDevices=10}
    $productionLoadAcceptance.minimumWallClockSeconds = 1800
    $productionLoadAcceptance.deadlineUtc = [DateTimeOffset]::UtcNow.AddHours(1).ToString("o")
    $productionLoadAcceptance | Add-Member -NotePropertyName artifactsNotBeforeUtc -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString("o")) -Force
    $productionLoadAcceptance | Add-Member -NotePropertyName automaticRollback -NotePropertyValue $true -Force
    $productionLoadAcceptance | Add-Member -NotePropertyName rollbackConfigPath -NotePropertyValue $dummyRollbackPath -Force
    $productionLoadAcceptance | Add-Member -NotePropertyName requireLoadAcceptance -NotePropertyValue $false -Force
    $productionLoadAcceptancePath = Join-Path $tempRoot "production-load-acceptance-lock.json"
    [IO.File]::WriteAllText($productionLoadAcceptancePath, ($productionLoadAcceptance|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $acceptanceWeakeningRejected = $false
    try { & $monitorScript -ConfigPath $productionLoadAcceptancePath -Mode Validate | Out-Null }
    catch { $acceptanceWeakeningRejected = $_.Exception.Message -match "requireLoadAcceptance=true" }
    Assert-Condition $acceptanceWeakeningRejected "Production load runs must not weaken requireLoadAcceptance=true."

    $productionShortTelemetry = $productionLoadAcceptance | ConvertTo-Json -Depth 12 | ConvertFrom-Json -Depth 12
    $productionShortTelemetry.runId = "production-load-duration-lock"
    $productionShortTelemetry.minimumWallClockSeconds = 60
    $productionShortTelemetry.requireLoadAcceptance = $true
    $productionShortTelemetryPath = Join-Path $tempRoot "production-load-duration-lock.json"
    [IO.File]::WriteAllText($productionShortTelemetryPath, ($productionShortTelemetry|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $shortTelemetryRejected = $false
    try { & $monitorScript -ConfigPath $productionShortTelemetryPath -Mode Validate | Out-Null }
    catch { $shortTelemetryRejected = $_.Exception.Message -match "minimumWallClockSeconds to equal workload.durationSeconds" }
    Assert-Condition $shortTelemetryRejected "Production load telemetry must cover the full immutable workload duration."

    $productionThresholdConfig = @{
        schemaVersion=1;runId="production-threshold-lock";phase="Application";evidenceDirectory=(Join-Path $tempRoot "production-threshold-evidence");
        automaticRollback=$true;rollbackConfigPath=$dummyRollbackPath;notificationTopicArn="arn:aws:sns:us-east-1:123456789012:production-alerts";
        minimumWallClockSeconds=60;deadlineUtc=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o");pollSeconds=60;maxIterations=0;
        thresholds=@{ecsCpuMaximumPercent=71};resources=@{region="us-east-1";cluster="schoolpilot";apiService="api";workerService="worker";
          targetGroupArn="target";rdsInstanceId="db";redisCacheClusterId="redis-001";redisReplicationGroupId="redis";vpcId="vpc";
          wafWebAclName="acl";wafDeviceRuleMetricName="device";wafApiRuleMetricName="api";route53HealthCheckId="health";route53AlarmName="route";
          expectedNatGatewayCount=2;expectedRoute53MeasureLatency=$true;expectedEcsAssignPublicIp=$false;ecsTaskSubnetIds=@("private-a","private-b");expectedRedisNodeType="cache.t4g.small"}
    }
    $productionThresholdPath = Join-Path $tempRoot "production-threshold-lock.json"
    [IO.File]::WriteAllText($productionThresholdPath, ($productionThresholdConfig|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $thresholdWeakeningRejected = $false
    try { & $monitorScript -ConfigPath $productionThresholdPath -Mode Validate | Out-Null }
    catch { $thresholdWeakeningRejected = $_.Exception.Message -match "threshold 'ecsCpuMaximumPercent' is immutable" }
    Assert-Condition $thresholdWeakeningRejected "Production reviewed resource/stale/cadence thresholds must be immutable."

    $productionRdsFreshnessConfig = $productionThresholdConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $productionRdsFreshnessConfig.runId = "production-rds-cpu-freshness-lock"
    $productionRdsFreshnessConfig.thresholds = @{rdsCpuMetricFreshnessMaximumSeconds=241}
    $productionRdsFreshnessPath = Join-Path $tempRoot "production-rds-cpu-freshness-lock.json"
    [IO.File]::WriteAllText($productionRdsFreshnessPath, ($productionRdsFreshnessConfig|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $rdsFreshnessWeakeningRejected = $false
    try { & $monitorScript -ConfigPath $productionRdsFreshnessPath -Mode Validate | Out-Null }
    catch { $rdsFreshnessWeakeningRejected = $_.Exception.Message -match "threshold 'rdsCpuMetricFreshnessMaximumSeconds' is immutable" }
    Assert-Condition $rdsFreshnessWeakeningRejected "Production RDS CPU publication-lag allowance must remain immutable."

    $global:SchoolPilotTestRouteLatency = $false
    $routeConfig = $monitorConfig | ConvertTo-Json -Depth 12 | ConvertFrom-Json -Depth 12
    $routeConfig.runId = "route53-three-ok-test"
    $routeConfig.phase = "Route53"
    $routeConfig.maxIterations = 3
    $routeConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
    $routeConfig.resources.expectedRoute53MeasureLatency = $false
    $routeConfigPath = Join-Path $tempRoot "route53-monitor.json"
    [IO.File]::WriteAllText($routeConfigPath, ($routeConfig | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    & $monitorScript -ConfigPath $routeConfigPath -Mode Monitor | Out-Null
    $routeResult = Get-Content -LiteralPath (Join-Path $evidenceDirectory "route53-three-ok-test-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
    Assert-Condition ($routeResult.status -eq "completed" -and $routeResult.iterations -eq 3) "Route53 phase must require three exact HTTP-200/alarm-OK periods."
    $global:SchoolPilotTestRouteLatency = $true

    $global:SchoolPilotTestNatAvailable = $false
    $earlyNatZero = $monitorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $earlyNatZero.runId = "early-nat-zero-contract"
    $earlyNatZero.phase = "NatRemoved"
    $earlyNatZero.resources.expectedNatGatewayCount = 0
    $earlyNatZeroPath = Join-Path $tempRoot "early-nat-zero.json"
    [IO.File]::WriteAllText($earlyNatZeroPath, ($earlyNatZero|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    & $monitorScript -ConfigPath $earlyNatZeroPath -Mode Monitor | Out-Null
    $earlyNatResult = Get-Content -LiteralPath (Join-Path $evidenceDirectory "early-nat-zero-contract-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
    $global:SchoolPilotTestNatAvailable = $true
    Assert-Condition ($earlyNatResult.status -eq "completed") "Zero-NAT monitor contract failed: $($earlyNatResult|ConvertTo-Json -Compress -Depth 20)."

    $supervisorConfigPath = Join-Path $tempRoot "supervisor.json"
    $supervisorConfig = $monitorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $supervisorConfig.runId = "supervisor-validate"
    $supervisorConfig.evidenceDirectory = Join-Path $tempRoot "supervisor-validate-evidence"
    $supervisorConfig | Add-Member -NotePropertyName loadProgressPath -NotePropertyValue (Join-Path $tempRoot "supervisor-progress.jsonl") -Force
    $supervisorConfig | Add-Member -NotePropertyName loadSummaryPath -NotePropertyValue (Join-Path $tempRoot "supervisor-summary.json") -Force
    $supervisorConfig | Add-Member -NotePropertyName workload -NotePropertyValue ([pscustomobject]@{ stage = "test"; devices = 1; durationSeconds = 1; screenshotBytes = 1024; canaryDevices = 0 }) -Force
    $validateHarness = Join-Path $tempRoot "validate-only-harness.mjs"
    [IO.File]::WriteAllText($validateHarness, 'if(process.env.LOAD_RUN_ID!=="supervisor-validate")process.exit(8);console.log(JSON.stringify({ok:true,trafficStarted:false,runId:process.env.LOAD_RUN_ID,gateProfile:"launch",thresholdsEnforced:true,networkFamily:"IPv4"},null,2));', [Text.UTF8Encoding]::new($false))
    $supervisorConfig | Add-Member -NotePropertyName testRuntimeHarnessScriptPath -NotePropertyValue $validateHarness -Force
    $supervisorConfig | Add-Member -NotePropertyName expectedGeneratorPublicIp -NotePropertyValue "203.0.113.10" -Force
    $supervisorConfig | Add-Member -NotePropertyName testGeneratorPublicIpSequence -NotePropertyValue @("203.0.113.10") -Force
    $supervisorConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddHours(1).ToString("o")
    [IO.File]::WriteAllText($supervisorConfigPath, ($supervisorConfig | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    & $supervisorScript -ConfigPath $supervisorConfigPath -Mode Validate | Out-Null
    Assert-Condition ($LASTEXITCODE -eq 0) "Supervisor validation should accept a unique external long-run contract."

    foreach ($collisionCase in @(
        [pscustomobject]@{ id="progress-monitor-result"; field="loadProgressPath"; generatedSuffix="MONITOR-RESULT.JSON" },
        [pscustomobject]@{ id="summary-rollback-evidence"; field="loadSummaryPath"; generatedSuffix="ROLLBACK.JSONL" }
    )) {
        $collisionConfig = $supervisorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $collisionConfig.runId = "collision-$($collisionCase.id)"
        $collisionConfig.evidenceDirectory = Join-Path $tempRoot "collision-$($collisionCase.id)-evidence"
        $collisionConfig.loadProgressPath = Join-Path $tempRoot "collision-$($collisionCase.id)-progress.jsonl"
        $collisionConfig.loadSummaryPath = Join-Path $tempRoot "collision-$($collisionCase.id)-summary.json"
        $collisionConfig.($collisionCase.field) = Join-Path $collisionConfig.evidenceDirectory `
            "$($collisionConfig.runId.ToUpperInvariant())-$($collisionCase.generatedSuffix)"
        $collisionConfigPath = Join-Path $tempRoot "collision-$($collisionCase.id)-supervisor.json"
        [IO.File]::WriteAllText($collisionConfigPath, ($collisionConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $collisionRejected = $false
        try { & $supervisorScript -ConfigPath $collisionConfigPath -Mode Validate | Out-Null }
        catch { $collisionRejected = $_.Exception.Message -match "must not collide with generated supervisor, monitor, or rollback artifact" }
        Assert-Condition $collisionRejected "Supervisor must reject case-insensitive $($collisionCase.field) collisions with generated evidence artifacts."
    }

    $productionDelayHookConfig = $supervisorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $productionDelayHookConfig.testMode = $false
    $productionDelayHookConfig.PSObject.Properties.Remove("testGeneratorPublicIpSequence")
    $productionDelayHookConfig | Add-Member -NotePropertyName testPreReleaseGeneratorPublicIpDelayMilliseconds -NotePropertyValue 100 -Force
    $productionDelayHookPath = Join-Path $tempRoot "production-delay-hook-supervisor.json"
    [IO.File]::WriteAllText($productionDelayHookPath, ($productionDelayHookConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $productionDelayHookRejected = $false
    try { & $supervisorScript -ConfigPath $productionDelayHookPath -Mode Validate | Out-Null }
    catch { $productionDelayHookRejected = $_.Exception.Message -match "testPreReleaseGeneratorPublicIpDelayMilliseconds is forbidden outside isolated testMode" }
    Assert-Condition $productionDelayHookRejected "The deterministic pre-release IP-delay hook must remain confined to isolated testMode."

    $validPreflightExpression = '{ok:true,trafficStarted:false,runId:process.env.LOAD_RUN_ID,gateProfile:"launch",thresholdsEnforced:true,networkFamily:"IPv4"}'
    foreach ($invalidDocument in @(
        [pscustomobject]@{ id="root-array"; source="console.log(JSON.stringify([$validPreflightExpression]));"; expected="exactly one JSON object" },
        [pscustomobject]@{ id="leading-noise"; source="console.log('noise');console.log(JSON.stringify($validPreflightExpression));"; expected="did not return valid JSON" },
        [pscustomobject]@{ id="two-documents"; source="console.log(JSON.stringify($validPreflightExpression));console.log(JSON.stringify($validPreflightExpression));"; expected="did not return valid JSON" }
    )) {
        $invalidDocumentHarness = Join-Path $tempRoot "$($invalidDocument.id)-document.mjs"
        [IO.File]::WriteAllText($invalidDocumentHarness, $invalidDocument.source, [Text.UTF8Encoding]::new($false))
        $invalidDocumentConfig = $supervisorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $invalidDocumentConfig.runId = "document-$($invalidDocument.id)"
        $invalidDocumentConfig.evidenceDirectory = Join-Path $tempRoot "document-$($invalidDocument.id)-evidence"
        $invalidDocumentConfig.loadProgressPath = Join-Path $tempRoot "document-$($invalidDocument.id)-progress.jsonl"
        $invalidDocumentConfig.loadSummaryPath = Join-Path $tempRoot "document-$($invalidDocument.id)-summary.json"
        $invalidDocumentConfig.testRuntimeHarnessScriptPath = $invalidDocumentHarness
        $invalidDocumentConfigPath = Join-Path $tempRoot "document-$($invalidDocument.id)-supervisor.json"
        [IO.File]::WriteAllText($invalidDocumentConfigPath, ($invalidDocumentConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $invalidDocumentRejected = $false
        try { & $supervisorScript -ConfigPath $invalidDocumentConfigPath -Mode Validate | Out-Null }
        catch { $invalidDocumentRejected = $_.Exception.Message -match [regex]::Escape($invalidDocument.expected) }
        Assert-Condition $invalidDocumentRejected "Supervisor must reject the $($invalidDocument.id) preflight stdout document shape."
    }

    foreach ($invalidPreflight in @(
        [pscustomobject]@{ id="wrong-run-id"; runIdExpression='process.env.LOAD_RUN_ID+"-wrong"'; gateProfile='launch'; thresholds='true'; family='IPv4' },
        [pscustomobject]@{ id="partial-profile"; runIdExpression='process.env.LOAD_RUN_ID'; gateProfile='partial'; thresholds='true'; family='IPv4' },
        [pscustomobject]@{ id="thresholds-disabled"; runIdExpression='process.env.LOAD_RUN_ID'; gateProfile='launch'; thresholds='false'; family='IPv4' },
        [pscustomobject]@{ id="ipv6-family"; runIdExpression='process.env.LOAD_RUN_ID'; gateProfile='launch'; thresholds='true'; family='IPv6' }
    )) {
        $invalidHarnessPath = Join-Path $tempRoot "$($invalidPreflight.id)-preflight.mjs"
        $invalidHarnessSource = 'console.log(JSON.stringify({{ok:true,trafficStarted:false,runId:{0},gateProfile:"{1}",thresholdsEnforced:{2},networkFamily:"{3}"}}));' -f `
            $invalidPreflight.runIdExpression,$invalidPreflight.gateProfile,$invalidPreflight.thresholds,$invalidPreflight.family
        [IO.File]::WriteAllText($invalidHarnessPath, $invalidHarnessSource, [Text.UTF8Encoding]::new($false))
        $invalidPreflightConfig = $supervisorConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $invalidPreflightConfig.runId = "preflight-$($invalidPreflight.id)"
        $invalidPreflightConfig.evidenceDirectory = Join-Path $tempRoot "preflight-$($invalidPreflight.id)-evidence"
        $invalidPreflightConfig.loadProgressPath = Join-Path $tempRoot "preflight-$($invalidPreflight.id)-progress.jsonl"
        $invalidPreflightConfig.loadSummaryPath = Join-Path $tempRoot "preflight-$($invalidPreflight.id)-summary.json"
        $invalidPreflightConfig.testRuntimeHarnessScriptPath = $invalidHarnessPath
        $invalidPreflightConfigPath = Join-Path $tempRoot "preflight-$($invalidPreflight.id)-supervisor.json"
        [IO.File]::WriteAllText($invalidPreflightConfigPath, ($invalidPreflightConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $invalidPreflightRejected = $false
        try { & $supervisorScript -ConfigPath $invalidPreflightConfigPath -Mode Validate | Out-Null }
        catch { $invalidPreflightRejected = $_.Exception.Message -match "did not prove the bound runId, launch profile" }
        Assert-Condition $invalidPreflightRejected "Supervisor must reject the $($invalidPreflight.id) harness preflight contract."
    }

    # A test-only runtime monitor simulates a rollback that outlives the
    # monitor heartbeat. The supervisor must honor the fresh bounded rollback
    # heartbeat instead of applying its stale-monitor watchdog.
    $fakeHarnessOk = Join-Path $tempRoot "fake-harness-ok.mjs"
    $fakeHarnessFail = Join-Path $tempRoot "fake-harness-fail.mjs"
    $fakeHarnessPreflightFail = Join-Path $tempRoot "fake-harness-preflight-fail.mjs"
    $fakeSlowRollbackMonitor = Join-Path $tempRoot "fake-slow-rollback-monitor.ps1"
    $fakeLostHeartbeatMonitor = Join-Path $tempRoot "fake-lost-heartbeat-monitor.ps1"
    $fakeHealthyMonitor = Join-Path $tempRoot "fake-healthy-monitor.ps1"
    $fakeExitBeforeReleaseMonitor = Join-Path $tempRoot "fake-exit-before-release-monitor.ps1"
    $fakeHarnessPreamble = @'
import fs from "node:fs";
if(!process.env.LOAD_RUN_ID)process.exit(8);
if(process.argv.includes("--validate-config")){
  console.log(JSON.stringify({ok:true,trafficStarted:false,runId:process.env.LOAD_RUN_ID,gateProfile:"launch",thresholdsEnforced:true,networkFamily:"IPv4"}));
  process.exit(0);
}
const readyPath=process.env.LOAD_SUPERVISOR_READY_PATH;
const gatePath=process.env.LOAD_SUPERVISOR_START_GATE_PATH;
if(!readyPath||!gatePath)process.exit(9);
fs.writeFileSync(readyPath,JSON.stringify({schemaVersion:1,type:"load_supervisor_ready",runId:process.env.LOAD_RUN_ID,stage:process.env.LOAD_STAGE,harnessProcessId:process.pid,readyAt:new Date().toISOString(),trafficStarted:false}));
while(!fs.existsSync(gatePath))await new Promise(resolve=>setTimeout(resolve,25));
'@
    [IO.File]::WriteAllText($fakeHarnessOk, $fakeHarnessPreamble + "`nsetTimeout(() => process.exit(0), 4500);", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fakeHarnessFail, $fakeHarnessPreamble + "`nsetTimeout(() => process.exit(7), 1000);", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fakeHarnessPreflightFail, 'if(process.argv.includes("--validate-config")){process.exit(9)}setTimeout(() => process.exit(0), 5000);', [Text.UTF8Encoding]::new($false))
    $fakeMonitorPreamble = @'
param([string]$ConfigPath,[string]$Mode)
$c=Get-Content -LiteralPath $ConfigPath -Raw|ConvertFrom-Json -Depth 30
function W([string]$p,$v){
  $temporary="$p.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temporary,($v|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary,$p,$true)
  }
  finally {if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
}
$mh=Join-Path $c.evidenceDirectory "$($c.runId)-monitor-heartbeat.json"
$rh=Join-Path $c.evidenceDirectory "$($c.runId)-rollback-heartbeat.json"
'@
    [IO.File]::WriteAllText($fakeSlowRollbackMonitor, $fakeMonitorPreamble + "`n" + @'
$gate=Join-Path $c.evidenceDirectory "$($c.runId)-harness-start.json"
$gateDeadline=[DateTimeOffset]::UtcNow.AddSeconds(30)
$iteration=0
do {
  $iteration++
  W $mh @{runId=$c.runId;phase=$c.phase;timestamp=[DateTimeOffset]::UtcNow.ToString("o");iteration=$iteration;triggered=$false}
  if(Test-Path -LiteralPath $gate -PathType Leaf){break}
  Start-Sleep -Milliseconds 100
} while([DateTimeOffset]::UtcNow -lt $gateDeadline)
if(-not (Test-Path -LiteralPath $gate -PathType Leaf)){exit 91}
W $rh @{runId=$c.runId;action="NatRemoved";status="running";step="slow-test";timestamp=[DateTimeOffset]::UtcNow.ToString("o");deadlineUtc=[DateTimeOffset]::UtcNow.AddMinutes(1).ToString("o")}
Start-Sleep -Seconds 4
exit 0
'@, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fakeLostHeartbeatMonitor, $fakeMonitorPreamble + "`nW `$mh @{runId=`$c.runId;phase=`$c.phase;timestamp=[DateTimeOffset]::UtcNow.ToString(`"o`");iteration=1;triggered=`$false}`nStart-Sleep -Seconds 4`nexit 0`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fakeHealthyMonitor, $fakeMonitorPreamble + "`n" + @'
for($i=0;$i-lt 4;$i++){W $mh @{runId=$c.runId;phase=$c.phase;timestamp=[DateTimeOffset]::UtcNow.ToString("o");iteration=($i+1);triggered=$false};Start-Sleep -Milliseconds 500}
exit 0
'@, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fakeExitBeforeReleaseMonitor, $fakeMonitorPreamble + "`n" + @'
W $mh @{runId=$c.runId;phase=$c.phase;timestamp=[DateTimeOffset]::UtcNow.ToString("o");iteration=1;triggered=$false}
Start-Sleep -Milliseconds 500
exit 42
'@, [Text.UTF8Encoding]::new($false))

    function New-SupervisorRuntimeConfig {
        param([string]$RunId,[string]$MonitorPath,[string]$HarnessPath)
        $runtime = $supervisorConfig | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30
        $runtime.runId = $RunId
        $runtime.evidenceDirectory = Join-Path $tempRoot "$RunId-evidence"
        $runtime.loadProgressPath = Join-Path $tempRoot "$RunId-progress.jsonl"
        $runtime.loadSummaryPath = Join-Path $tempRoot "$RunId-summary.json"
        $runtime | Add-Member -NotePropertyName supervisorWatchdog -NotePropertyValue ([pscustomobject]@{monitorHeartbeatStaleSeconds=2;rollbackHeartbeatStaleSeconds=10;pollSeconds=1;generatorIpCheckSeconds=1}) -Force
        $runtime | Add-Member -NotePropertyName testRuntimeMonitorScriptPath -NotePropertyValue $MonitorPath -Force
        $runtime | Add-Member -NotePropertyName testRuntimeHarnessScriptPath -NotePropertyValue $HarnessPath -Force
        $runtime.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(2).ToString("o")
        $path = Join-Path $tempRoot "$RunId-supervisor.json"
        [IO.File]::WriteAllText($path, ($runtime|ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
        return $path
    }

    $slowSupervisorPath = New-SupervisorRuntimeConfig "slow-rollback-watchdog" $fakeSlowRollbackMonitor $fakeHarnessOk
    try { & $supervisorScript -ConfigPath $slowSupervisorPath -Mode Run | Out-Null }
    catch {
        $slowDebug = @(
            "supervisor=$($_.Exception.Message)",
            "monitor.stderr=$((Get-Content -LiteralPath (Join-Path $tempRoot 'slow-rollback-watchdog-evidence\slow-rollback-watchdog-monitor.stderr.log') -Raw -ErrorAction SilentlyContinue))",
            "monitor.heartbeat=$((Get-Content -LiteralPath (Join-Path $tempRoot 'slow-rollback-watchdog-evidence\slow-rollback-watchdog-monitor-heartbeat.json') -Raw -ErrorAction SilentlyContinue))",
            "rollback.heartbeat=$((Get-Content -LiteralPath (Join-Path $tempRoot 'slow-rollback-watchdog-evidence\slow-rollback-watchdog-rollback-heartbeat.json') -Raw -ErrorAction SilentlyContinue))",
            "artifacts=$((Get-ChildItem -LiteralPath (Join-Path $tempRoot 'slow-rollback-watchdog-evidence') -ErrorAction SilentlyContinue).Name -join ',')"
        ) -join " | "
        throw $slowDebug
    }
    $slowSupervisorResult = Get-Content -LiteralPath (Join-Path $tempRoot "slow-rollback-watchdog-evidence\slow-rollback-watchdog-supervisor-result.json") -Raw | ConvertFrom-Json
    Assert-Condition ($slowSupervisorResult.status -eq "completed") "A fresh bounded rollback heartbeat must protect a slow rollback from the stale-monitor watchdog."

    $changedIpSupervisorPath = New-SupervisorRuntimeConfig "generator-ip-changed" $fakeHealthyMonitor $fakeHarnessOk
    $changedIpConfig = Get-Content -LiteralPath $changedIpSupervisorPath -Raw | ConvertFrom-Json -Depth 30
    $changedIpConfig.testGeneratorPublicIpSequence = @("203.0.113.10","203.0.113.11")
    [IO.File]::WriteAllText($changedIpSupervisorPath, ($changedIpConfig|ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    $changedIpRejected = $false
    $changedIpError = ""
    try { & $supervisorScript -ConfigPath $changedIpSupervisorPath -Mode Run | Out-Null }
    catch { $changedIpError=$_.Exception.Message;$changedIpRejected = $changedIpError -match "changed during" }
    Assert-Condition $changedIpRejected "Supervisor must stop traffic without an infrastructure mutation if the generator public IPv4 changes (actual: $changedIpError)."

    $exitBeforeReleaseSupervisorPath = New-SupervisorRuntimeConfig "monitor-exit-before-release" $fakeExitBeforeReleaseMonitor $fakeHarnessOk
    $exitBeforeReleaseConfig = Get-Content -LiteralPath $exitBeforeReleaseSupervisorPath -Raw | ConvertFrom-Json -Depth 30
    $exitBeforeReleaseConfig | Add-Member -NotePropertyName testPreReleaseGeneratorPublicIpDelayMilliseconds -NotePropertyValue 1500 -Force
    [IO.File]::WriteAllText($exitBeforeReleaseSupervisorPath, ($exitBeforeReleaseConfig|ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    $exitBeforeReleaseRejected = $false
    $exitBeforeReleaseError = ""
    try { & $supervisorScript -ConfigPath $exitBeforeReleaseSupervisorPath -Mode Run | Out-Null }
    catch {
        $exitBeforeReleaseError = $_.Exception.Message
        $exitBeforeReleaseRejected = $exitBeforeReleaseError -match "AWS monitor exited before releasing the load harness"
    }
    $exitBeforeReleaseGate = Join-Path $tempRoot "monitor-exit-before-release-evidence\monitor-exit-before-release-harness-start.json"
    Assert-Condition ($exitBeforeReleaseRejected -and -not (Test-Path -LiteralPath $exitBeforeReleaseGate)) "Supervisor must recheck monitor liveness after the generator-IP lookup and keep the traffic gate closed (actual: $exitBeforeReleaseError)."

    $lostSupervisorPath = New-SupervisorRuntimeConfig "lost-monitor-heartbeat" $fakeLostHeartbeatMonitor $fakeHarnessOk
    $lostRejected = $false
    try { & $supervisorScript -ConfigPath $lostSupervisorPath -Mode Run | Out-Null }
    catch { $lostRejected = $_.Exception.Message -match "no fresh, bounded rollback heartbeat" }
    Assert-Condition $lostRejected "Supervisor must fail closed and terminate traffic when monitor and rollback heartbeats are both lost."

    $badHarnessSupervisorPath = New-SupervisorRuntimeConfig "bad-harness-exit" $fakeHealthyMonitor $fakeHarnessFail
    $badHarnessRejected = $false
    $badHarnessError = ""
    try { & $supervisorScript -ConfigPath $badHarnessSupervisorPath -Mode Run | Out-Null }
    catch { $badHarnessError=$_.Exception.Message;$badHarnessRejected = $badHarnessError -match "load harness exited with code 7" }
    Assert-Condition $badHarnessRejected "Supervisor success must require harness exit code zero (actual: $badHarnessError)."

    $preflightFailSupervisorPath = New-SupervisorRuntimeConfig "harness-preflight-fail" $fakeHealthyMonitor $fakeHarnessPreflightFail
    $preflightFailureRejected = $false
    try { & $supervisorScript -ConfigPath $preflightFailSupervisorPath -Mode Run | Out-Null }
    catch { $preflightFailureRejected = $_.Exception.Message -match "--validate-config preflight failed" }
    Assert-Condition ($preflightFailureRejected -and -not (Test-Path -LiteralPath (Join-Path $tempRoot "harness-preflight-fail-evidence\harness-preflight-fail-harness.stdout.log"))) "Harness --validate-config must pass before sleep prevention or any traffic process starts."
    $monitorOnlyProductionPath = Join-Path $tempRoot "monitor-only-production.json"
    $monitorOnlyProduction = @{
        schemaVersion=1;runId="public-ecs-24h-soak";phase="PublicEcs";evidenceDirectory=(Join-Path $tempRoot "monitor-only-production-evidence");
        automaticRollback=$false;notificationTopicArn="arn:aws:sns:us-east-1:123456789012:test";pollSeconds=60;testMode=$false;maxIterations=0;
        minimumWallClockSeconds=86400;deadlineUtc=[DateTimeOffset]::UtcNow.AddHours(25).ToString("o");
        predecessorResultPath=$publicEcsLoadResultPath;predecessorResultSha256=(Get-FileHash $publicEcsLoadResultPath -Algorithm SHA256).Hash.ToLowerInvariant();
        thresholds=@{requireNatSixHourAcceptance=$true};resources=@{region="us-east-1";cluster="cluster";apiService="api";workerService="worker";
          targetGroupArn="target";rdsInstanceId="db";redisCacheClusterId="redis-001";redisReplicationGroupId="redis";vpcId="vpc";
          wafWebAclName="acl";wafDeviceRuleMetricName="device";wafApiRuleMetricName="api";route53HealthCheckId="health";
          route53AlarmName="route";expectedNatGatewayCount=2;expectedRoute53MeasureLatency=$true}
    }
    [IO.File]::WriteAllText($monitorOnlyProductionPath, ($monitorOnlyProduction|ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $productionRollbackLockRejected = $false
    try { & $supervisorScript -ConfigPath $monitorOnlyProductionPath -Mode Validate -SupervisionKind MonitorOnly 2>$null | Out-Null }
    catch { $productionRollbackLockRejected = $_.Exception.Message -match "static AWS monitor/rollback" }
    Assert-Condition $productionRollbackLockRejected "Production monitoring must reject automaticRollback=false even for an exact 24-hour soak."
    $invalidMonitorOnly = $monitorOnlyProduction | ConvertTo-Json -Depth 10 | ConvertFrom-Json -Depth 10
    $invalidMonitorOnly.runId = "invalid-short-public-soak"
    $invalidMonitorOnly.minimumWallClockSeconds = 3600
    $invalidMonitorOnlyPath = Join-Path $tempRoot "invalid-monitor-only.json"
    [IO.File]::WriteAllText($invalidMonitorOnlyPath, ($invalidMonitorOnly|ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $invalidMonitorOnlyRejected = $false
    try { & $supervisorScript -ConfigPath $invalidMonitorOnlyPath -Mode Validate -SupervisionKind MonitorOnly | Out-Null }
    catch { $invalidMonitorOnlyRejected = $_.Exception.Message -match "exactly 24 hours" }
    Assert-Condition $invalidMonitorOnlyRejected "MonitorOnly must reject shortened production PublicEcs soaks."

    $reparseTarget = Join-Path $tempRoot "reparse-target"
    $reparseEvidence = Join-Path $tempRoot "reparse-evidence"
    [void][IO.Directory]::CreateDirectory($reparseTarget)
    New-Item -ItemType Junction -Path $reparseEvidence -Target $reparseTarget | Out-Null
    $reparseConfig = $supervisorConfig | ConvertTo-Json -Depth 10 | ConvertFrom-Json -Depth 10
    $reparseConfig.runId = "reparse-rejected"
    $reparseConfig.evidenceDirectory = $reparseEvidence
    $reparseConfigPath = Join-Path $tempRoot "reparse-supervisor.json"
    [IO.File]::WriteAllText($reparseConfigPath, ($reparseConfig|ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $reparseRejected = $false
    try { & $supervisorScript -ConfigPath $reparseConfigPath -Mode Validate | Out-Null }
    catch { $reparseRejected = $_.Exception.Message -match "reparse point" }
    Assert-Condition $reparseRejected "Supervisor must reject evidence paths traversing a junction/reparse point before writing artifacts."

    foreach ($phaseUnderTest in @("PublicEcs", "Final")) {
        $preflightRunId = "preflight-$($phaseUnderTest.ToLowerInvariant())-missing-waf"
        $preflightRollbackPath = Join-Path $tempRoot "$preflightRunId-rollback.json"
        $preflightRollback = @{
            schemaVersion=1;testMode=$true;testEnvironmentSentinel="SCHOOLPILOT_ROLLOUT_TEST_ONLY";testAccountId="000000000000";
            runId=$preflightRunId;region="us-east-1";cluster="cluster";apiService="api";workerService="worker";
            evidenceDirectory=$evidenceDirectory;previousApiTaskDefinition="api-prev";previousWorkerTaskDefinition="worker-prev";
            emergencyApiTaskDefinition="arn:aws:ecs:us-east-1:000000000000:task-definition/test-emergency:1";
            emergencyApiTaskDefinitionFamily="test-emergency";emergencyApiContainerName="api";targetGroupArn="target";
            privateSubnetIds=@("private-a","private-b");ecsSecurityGroupIds=@("sg-1");privateRouteTableIds=@("rtb-a","rtb-b");
            vpcId="vpc";expectedNatGatewayCount=2;redisReplicationGroupId="redis";
            emergencyTaskDefinitionEvidence=@{
              currentTaskDefinition=@{executionRoleArn="exec";taskRoleArn="task";networkMode="awsvpc";requiresCompatibilities=@("FARGATE");containerDefinitions=@(@{name="api";image="repo@sha256:$('a'*64)"})};
              emergencyTaskDefinition=@{status="ACTIVE";family="test-emergency";taskDefinitionArn="arn:aws:ecs:us-east-1:000000000000:task-definition/test-emergency:1";
                cpu="512";memory="2048";networkMode="awsvpc";requiresCompatibilities=@("FARGATE");executionRoleArn="exec";taskRoleArn="task";
                containerDefinitions=@(@{name="api";image="repo@sha256:$('a'*64)";memory=2048})}
            }
        }
        [IO.File]::WriteAllText($preflightRollbackPath, ($preflightRollback|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $preflightConfigPath = Join-Path $tempRoot "$preflightRunId-monitor.json"
        $preflightExpectedNat = if ($phaseUnderTest -eq "PublicEcs") { 2 } else { 0 }
        $preflightConfig = @{
            schemaVersion=1;runId=$preflightRunId;phase=$phaseUnderTest;evidenceDirectory=$evidenceDirectory;testEnvironmentSentinel="SCHOOLPILOT_ROLLOUT_TEST_ONLY";
            loadProgressPath=(Join-Path $tempRoot "$preflightRunId-progress.jsonl");loadSummaryPath=(Join-Path $tempRoot "$preflightRunId-summary.json");
            artifactsNotBeforeUtc=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o");automaticRollback=$true;rollbackConfigPath=$preflightRollbackPath;
            notificationTopicArn="arn:aws:sns:us-east-1:000000000000:test";pollSeconds=1;testMode=$true;maxIterations=1;minimumWallClockSeconds=0;
            deadlineUtc=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o");harnessProcessId=$PID;
            harnessProcessStartedAtUtc=([DateTimeOffset](Get-Process -Id $PID).StartTime).ToUniversalTime().ToString("o");
            harnessProcessPath=(Get-Process -Id $PID).Path;workload=@{stage="preflight";devices=1;durationSeconds=1;screenshotBytes=1024;canaryDevices=0};
            resources=@{region="us-east-1";cluster="cluster";apiService="api";workerService="worker";targetGroupArn="target";rdsInstanceId="db";
              redisCacheClusterId="redis-001";redisReplicationGroupId="redis";vpcId="vpc";wafWebAclName="acl";wafDeviceRuleMetricName="device";
              wafApiRuleMetricName="api";route53HealthCheckId="health";route53AlarmName="route";
              expectedNatGatewayCount=$preflightExpectedNat;expectedRoute53MeasureLatency=$true;expectedEcsAssignPublicIp=$true;
              ecsTaskSubnetIds=@("subnet-public-a","subnet-public-b");expectedRedisNodeType="cache.t4g.small"}
        }
        if ($phaseUnderTest -eq "Final") {
            $preflightConfig.redisResizeCompletedAtUtc = [DateTimeOffset]::UtcNow.AddHours(-1).ToString("o")
        }
        [IO.File]::WriteAllText($preflightConfigPath, ($preflightConfig|ConvertTo-Json -Depth 15), [Text.UTF8Encoding]::new($false))
        $preflightFailed = $false
        $preflightError = ""
        try { & $monitorScript -ConfigPath $preflightConfigPath -Mode Validate 2>$null | Out-Null }
        catch { $preflightError = $_.Exception.Message; $preflightFailed = $preflightError -match "preflight failed for action Waf" }
        Assert-Condition $preflightFailed "$phaseUnderTest load validation must preflight correlated WAF rollback even outside phase=Waf (actual: $preflightError)."
    }

    # Exercise a hard gate in a child pwsh so the monitor's required nonzero
    # exit cannot terminate this test host. The PATH-scoped aws.ps1 mock also
    # proves fatal-final reason propagation and typed WAF rollback dispatch.
    $childRoot = Join-Path $tempRoot "child-fatal"
    $childEvidence = Join-Path $childRoot "evidence"
    [void][IO.Directory]::CreateDirectory($childEvidence)
    $childAws = Join-Path $childRoot "aws.ps1"
    $wafFlag = Join-Path $childRoot "waf-count.flag"
    $childAwsSource = @'
$arguments = @($args | ForEach-Object { [string]$_ })
$service = $arguments[0]
$operation = $arguments[1]
function Arg([string]$name) { $index = [Array]::IndexOf($arguments, $name); if ($index -ge 0) { return $arguments[$index + 1] }; return $null }
if ($service -eq "ecs" -and $operation -eq "describe-services") {
  if ($env:SCHOOLPILOT_TEST_SAMPLE_BARRIER_ARM -and $env:SCHOOLPILOT_TEST_SAMPLE_BARRIER_READY -and
      $env:SCHOOLPILOT_TEST_SAMPLE_BARRIER_RELEASE -and $env:SCHOOLPILOT_TEST_SAMPLE_BARRIER_CONSUMED -and
      (Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_SAMPLE_BARRIER_ARM) -and
      -not (Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_SAMPLE_BARRIER_CONSUMED)) {
    [IO.File]::WriteAllText($env:SCHOOLPILOT_TEST_SAMPLE_BARRIER_CONSUMED,"1")
    [IO.File]::WriteAllText($env:SCHOOLPILOT_TEST_SAMPLE_BARRIER_READY,"1")
    $barrierDeadline=[DateTimeOffset]::UtcNow.AddSeconds(20)
    while(-not (Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_SAMPLE_BARRIER_RELEASE)){
      if([DateTimeOffset]::UtcNow -ge $barrierDeadline){throw "Timed out waiting for the test sample barrier release."}
      Start-Sleep -Milliseconds 10
    }
  }
  $apiTask=if($env:SCHOOLPILOT_TEST_API_TASK_FLAG -and (Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_API_TASK_FLAG)){Get-Content -LiteralPath $env:SCHOOLPILOT_TEST_API_TASK_FLAG -Raw}else{"api-current"}
  $workerTask=if($env:SCHOOLPILOT_TEST_WORKER_TASK_FLAG -and (Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_WORKER_TASK_FLAG)){Get-Content -LiteralPath $env:SCHOOLPILOT_TEST_WORKER_TASK_FLAG -Raw}else{"worker-current"}
  @{ services = @(
    @{ serviceName="api"; desiredCount=1; runningCount=1; pendingCount=0; taskDefinition=$apiTask; deployments=@(@{status="PRIMARY"}); networkConfiguration=@{awsvpcConfiguration=@{subnets=@("private-a","private-b");securityGroups=@("sg-1");assignPublicIp="DISABLED"}} },
    @{ serviceName="worker"; desiredCount=1; runningCount=1; pendingCount=0; taskDefinition=$workerTask; deployments=@(@{status="PRIMARY"}); networkConfiguration=@{awsvpcConfiguration=@{subnets=@("private-a","private-b");securityGroups=@("sg-1");assignPublicIp="DISABLED"}} }
  )} | ConvertTo-Json -Depth 12 -Compress; exit 0
}
if ($service -eq "ecs" -and $operation -eq "update-service") { $td=Arg "--task-definition";$name=Arg "--service";if($env:SCHOOLPILOT_TEST_UPDATE_LOG){[IO.File]::AppendAllText($env:SCHOOLPILOT_TEST_UPDATE_LOG,($arguments -join " ")+[Environment]::NewLine)};if($td){$flag=if($name -eq "worker"){$env:SCHOOLPILOT_TEST_WORKER_TASK_FLAG}else{$env:SCHOOLPILOT_TEST_API_TASK_FLAG};[IO.File]::WriteAllText($flag,$td)};'{}';exit 0 }
if ($service -eq "ecs" -and $operation -eq "wait") { '{}';exit 0 }
if ($service -eq "ecs" -and $operation -eq "list-tasks") {
  if ((Arg "--desired-status") -eq "RUNNING") { $name=Arg "--service-name"; @{taskArns=@("arn:aws:ecs:us-east-1:000000000000:task/cluster/$name-running")}|ConvertTo-Json -Compress; exit 0 }
  if ($env:SCHOOLPILOT_TEST_OOM_FLAG -and (Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_OOM_FLAG)) { '{"taskArns":["arn:aws:ecs:us-east-1:000000000000:task/cluster/api-oom"]}';exit 0 }
  '{"taskArns":[]}'; exit 0
}
if ($service -eq "ecs" -and $operation -eq "describe-tasks") {
  if (($arguments -join " ") -match 'api-oom') {@{tasks=@(@{taskArn="arn:aws:ecs:us-east-1:000000000000:task/cluster/api-oom";group="service:api";stoppedAt=[DateTimeOffset]::UtcNow.ToString("o");stopCode="EssentialContainerExited";stoppedReason="OutOfMemoryError";containers=@(@{exitCode=137;reason="OutOfMemoryError"})})}|ConvertTo-Json -Depth 8 -Compress;exit 0}
  $running=@($arguments|Where-Object {$_ -match '-running$'});$tasks=@($running|ForEach-Object {$suffix=($_ -split '/')[-1];@{taskArn=$_;attachments=@(@{type="ElasticNetworkInterface";details=@(@{name="networkInterfaceId";value="eni-$suffix"})})}})
  @{tasks=$tasks}|ConvertTo-Json -Depth 8 -Compress;exit 0
}
if ($service -eq "elbv2") { '{"TargetHealthDescriptions":[{"TargetHealth":{"State":"healthy"}}]}'; exit 0 }
if ($service -eq "rds") { $pending=if($env:SCHOOLPILOT_TEST_PENDING){@{DBInstanceClass="db.t4g.small"}}else{@{}};@{DBInstances=@(@{DBInstanceStatus="available";AllocatedStorage=100;MaxAllocatedStorage=1000;PendingModifiedValues=$pending})}|ConvertTo-Json -Depth 6 -Compress; exit 0 }
if ($service -eq "elasticache" -and $operation -eq "describe-snapshots") {
  $snapshotTime=$env:SCHOOLPILOT_TEST_SNAPSHOT_TIME
  if($env:SCHOOLPILOT_TEST_SNAPSHOT_TIME_FILE -and (Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_SNAPSHOT_TIME_FILE)){$snapshotTime=(Get-Content -LiteralPath $env:SCHOOLPILOT_TEST_SNAPSHOT_TIME_FILE -Raw).Trim()}
  $snapshots=if($snapshotTime){@(@{SnapshotName="auto-test";SnapshotStatus="available";NodeSnapshots=@(@{SnapshotCreateTime=$snapshotTime})})}else{@()}
  @{Snapshots=$snapshots}|ConvertTo-Json -Depth 8 -Compress;exit 0
}
if ($service -eq "elasticache") { $node=if($env:SCHOOLPILOT_TEST_REDIS_TYPE){$env:SCHOOLPILOT_TEST_REDIS_TYPE}else{"cache.t4g.small"};$pending=if($env:SCHOOLPILOT_TEST_PENDING){@{CacheNodeType="cache.t4g.micro"}}else{@{}};@{ReplicationGroups=@(@{Status="available";CacheNodeType=$node;PendingModifiedValues=$pending})}|ConvertTo-Json -Depth 5 -Compress;exit 0 }
if ($service -eq "ec2" -and $operation -eq "describe-nat-gateways") {
  if($env:SCHOOLPILOT_TEST_NAT_ZERO -eq "1"){'{"NatGateways":[]}';exit 0}
  $gateways=@(
    @{NatGatewayId="nat-1";State="available";NatGatewayAddresses=@(@{AssociationId="eipassoc-1"})},
    @{NatGatewayId="nat-2";State="available";NatGatewayAddresses=@(@{AssociationId="eipassoc-2"})}
  )
  @{NatGateways=$gateways}|ConvertTo-Json -Depth 5 -Compress;exit 0
}
if ($service -eq "ec2" -and $operation -eq "describe-route-tables") {
  @{RouteTables=@(
    @{RouteTableId="rtb-private-a";Routes=@(@{DestinationCidrBlock="0.0.0.0/0";NatGatewayId="nat-1";State="active"})},
    @{RouteTableId="rtb-private-b";Routes=@(@{DestinationCidrBlock="0.0.0.0/0";NatGatewayId="nat-2";State="active"})}
  )}|ConvertTo-Json -Depth 8 -Compress;exit 0
}
if ($service -eq "ec2" -and $operation -eq "describe-network-interfaces") { $ids=@($arguments|Where-Object {$_ -match '^eni-'});@{NetworkInterfaces=@($ids|ForEach-Object {$association=if($env:SCHOOLPILOT_TEST_PUBLIC_IP -eq "1"){@{PublicIp="198.51.100.20"}}else{@{}};@{NetworkInterfaceId=$_;Association=$association}})}|ConvertTo-Json -Depth 6 -Compress;exit 0 }
if ($service -eq "route53" -and $operation -eq "get-health-check-status") { '{"HealthCheckObservations":[{"StatusReport":{"Status":"Success: HTTP Status Code 200"}}]}'; exit 0 }
if ($service -eq "route53" -and $operation -eq "get-health-check") { '{"HealthCheck":{"HealthCheckConfig":{"Type":"HTTPS","ResourcePath":"/health","MeasureLatency":true}}}'; exit 0 }
if ($service -eq "cloudwatch" -and $operation -eq "describe-alarms") { '{"MetricAlarms":[{"StateValue":"OK"}]}'; exit 0 }
if ($service -eq "cloudwatch" -and $operation -eq "get-metric-data") {
  $path = (Arg "--metric-data-queries").Substring(7)
  $queries = @(Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 20)
  $timestamp = if($env:SCHOOLPILOT_TEST_METRIC_TIMESTAMP){$env:SCHOOLPILOT_TEST_METRIC_TIMESTAMP}elseif($env:SCHOOLPILOT_TEST_METRIC_STEP_FILE){$n=if(Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_METRIC_STEP_FILE){[int](Get-Content -LiteralPath $env:SCHOOLPILOT_TEST_METRIC_STEP_FILE -Raw)}else{0};$n++;[IO.File]::WriteAllText($env:SCHOOLPILOT_TEST_METRIC_STEP_FILE,[string]$n);$stepIndex=[Math]::Min($n,2);([DateTimeOffset]$env:SCHOOLPILOT_TEST_METRIC_STEP_START).AddSeconds($stepIndex*[int]$env:SCHOOLPILOT_TEST_METRIC_STEP_SECONDS).ToString("o")}else{[DateTimeOffset]::UtcNow.ToString("o")}
  $swapValue=0
  if($env:SCHOOLPILOT_TEST_SWAP_COUNTER){$n=if(Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_SWAP_COUNTER){[int](Get-Content -LiteralPath $env:SCHOOLPILOT_TEST_SWAP_COUNTER -Raw)}else{0};$n++;[IO.File]::WriteAllText($env:SCHOOLPILOT_TEST_SWAP_COUNTER,[string]$n);$swapValue=$n*20971520}
  $results = @($queries | ForEach-Object {
    $metricId = [string]$_.Id
    if (($env:SCHOOLPILOT_TEST_WAF_SPARSE_ZERO -or $env:SCHOOLPILOT_TEST_WAF_PARTIAL_EMPTY) -and
        $metricId -in @("waf_device_blocked", "waf_api_blocked")) {
      $status = if ($env:SCHOOLPILOT_TEST_WAF_PARTIAL_EMPTY) { "PartialData" } else { "Complete" }
      @{Id=$metricId;StatusCode=$status;Timestamps=@();Values=@()}
    }
    else {
      $metricTimestamp = if ($env:SCHOOLPILOT_TEST_FIVE_MINUTE_METRIC_AGE_SECONDS -and
          $metricId -in @("rds_cpu_credit", "rds_surplus_charged", "redis_cpu_credit")) {
        [DateTimeOffset]::UtcNow.AddSeconds(-[int]$env:SCHOOLPILOT_TEST_FIVE_MINUTE_METRIC_AGE_SECONDS).ToString("o")
      } elseif ($env:SCHOOLPILOT_TEST_RDS_CPU_METRIC_AGE_SECONDS -and $metricId -eq "rds_cpu") {
        [DateTimeOffset]::UtcNow.AddSeconds(-[int]$env:SCHOOLPILOT_TEST_RDS_CPU_METRIC_AGE_SECONDS).ToString("o")
      } elseif ($env:SCHOOLPILOT_TEST_FAST_METRIC_AGE_SECONDS -and
          $metricId -notin @("rds_cpu_credit", "rds_surplus_charged", "redis_cpu_credit")) {
        [DateTimeOffset]::UtcNow.AddSeconds(-[int]$env:SCHOOLPILOT_TEST_FAST_METRIC_AGE_SECONDS).ToString("o")
      } elseif ($env:SCHOOLPILOT_TEST_METRIC_STEP_FILE -and
          $metricId -notin @("rds_cpu_credit", "rds_surplus_charged", "redis_cpu_credit")) {
        [DateTimeOffset]::UtcNow.ToString("o")
      } else { $timestamp }
      $value = switch -Regex ($metricId) {
        '^waf_device_blocked$' { if($env:SCHOOLPILOT_TEST_WAF_DEVICE_BLOCK -or ($env:SCHOOLPILOT_TEST_WAF_DEVICE_BLOCK_FILE -and (Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_WAF_DEVICE_BLOCK_FILE))){1}else{0}; break }
        '^waf_api_blocked$' { if($env:SCHOOLPILOT_TEST_WAF_API_BLOCK){1}else{0}; break }
        '^ecs_.*_(cpu_maximum|cpu|memory)$' { 10; break }
        '^rds_cpu$' { 10; break }
        '^rds_connections$' { 20; break }
        '^rds_free_storage$' { 85899345920; break }
        '^rds_free_memory$' { if($env:SCHOOLPILOT_TEST_AUX_BREACH){1}else{1073741824}; break }
        '^rds_swap$' { $swapValue; break }
        '^rds_cpu_credit$' { if($env:SCHOOLPILOT_TEST_AUX_BREACH){0}else{100}; break }
        '^rds_surplus_charged$' { if($env:SCHOOLPILOT_TEST_AUX_BREACH){1}else{0}; break }
        '^redis_cpu$' { 10; break }
        '^redis_memory$' { 20; break }
        '^redis_free$' { 209715200; break }
        '^redis_cpu_credit$' { if($env:SCHOOLPILOT_TEST_AUX_BREACH){0}else{100}; break }
        default { 0 }
      }
      if($metricId -eq "rds_cpu" -and $env:SCHOOLPILOT_TEST_RDS_CPU_BOUNDARY_STEP_FILE){
        $boundaryStep=if(Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_RDS_CPU_BOUNDARY_STEP_FILE){[int](Get-Content -LiteralPath $env:SCHOOLPILOT_TEST_RDS_CPU_BOUNDARY_STEP_FILE -Raw)}else{0}
        $boundaryStep++;[IO.File]::WriteAllText($env:SCHOOLPILOT_TEST_RDS_CPU_BOUNDARY_STEP_FILE,[string]$boundaryStep)
        $base=[DateTimeOffset]$env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE
        $boundaryTimes=@($base.AddMinutes(-1).ToString("o"),$base.ToString("o"),$base.AddMinutes(1).ToString("o"),$base.AddMinutes(2).ToString("o"))
        $boundaryCount=[Math]::Min($boundaryStep,4)
        @{Id=$metricId;StatusCode="Complete";Timestamps=@($boundaryTimes[0..($boundaryCount-1)]);Values=@(1..$boundaryCount|ForEach-Object{70})}
      } elseif($metricId -eq "rds_cpu" -and $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN){
        $base=[DateTimeOffset]$env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE
        if($env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN -eq "gapped"){
          $runtimeTimes=@($base.ToString("o"),$base.AddMinutes(1).ToString("o"),$base.AddMinutes(3).ToString("o"));$runtimeValues=@(70,70,70)
        } else {
          $runtimeTimes=@($base.ToString("o"),$base.AddMinutes(1).ToString("o"),$base.AddMinutes(2).ToString("o"),$base.AddMinutes(3).ToString("o"))
          $runtimeValues=if($env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN -eq "three"){@(10,70,70,70)}elseif($env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN -eq "historical"){@(70,70,70,10)}else{@(10,70,10,10)}
        }
        @{Id=$metricId;StatusCode="Complete";Timestamps=$runtimeTimes;Values=$runtimeValues}
      } elseif($metricId -eq "rds_cpu" -and $env:SCHOOLPILOT_TEST_RDS_CPU_LOAD_WINDOW_START){
        $base=[DateTimeOffset]$env:SCHOOLPILOT_TEST_RDS_CPU_LOAD_WINDOW_START
        @{Id=$metricId;StatusCode="Complete";Timestamps=@($base.AddMinutes(-1).ToString("o"),$base.ToString("o"),$base.AddMinutes(1).ToString("o"),$base.AddMinutes(2).ToString("o"),$base.AddMinutes(3).ToString("o"),$base.AddMinutes(4).ToString("o"),[DateTimeOffset]::UtcNow.AddMinutes(1).ToString("o"));Values=@(99,10,70,10,11,98,97)}
      } elseif($metricId -eq "rds_cpu" -and $env:SCHOOLPILOT_TEST_RDS_CPU_BACKFILL){
        $pointTime=[DateTimeOffset]$metricTimestamp
        $earlier=$pointTime.AddMilliseconds(-10).ToString("o")
        $beforeWindow=$pointTime.AddMinutes(-3).ToString("o")
        $afterCollection=$pointTime.AddMinutes(3).ToString("o")
        $backfillValue=if($env:SCHOOLPILOT_TEST_RDS_CPU_BACKFILL_SPIKE){70}else{12}
        @{Id=$metricId;StatusCode="Complete";Timestamps=@($metricTimestamp,$earlier,$beforeWindow,$afterCollection);Values=@($value,$backfillValue,99,98)}
      } else {
        @{Id=$metricId;StatusCode="Complete";Timestamps=@($metricTimestamp);Values=@($value)}
      }
    }
  })
  @{MetricDataResults=$results}|ConvertTo-Json -Depth 8 -Compress; exit 0
}
if ($service -eq "sns") { '{"MessageId":"test"}'; exit 0 }
if ($service -eq "wafv2" -and $operation -eq "get-web-acl") {
  $count = Test-Path -LiteralPath $env:SCHOOLPILOT_TEST_WAF_FLAG
  $action = if ($count) { @{Count=@{}} } else { @{Block=@{}} }
  @{LockToken="lock";WebACL=@{Description="";DefaultAction=@{Allow=@{}};Rules=@(
    @{Name="Managed";Priority=1;OverrideAction=@{None=@{}};Statement=@{ManagedRuleGroupStatement=@{Name="Managed";VendorName="AWS"}};VisibilityConfig=@{SampledRequestsEnabled=$true;CloudWatchMetricsEnabled=$true;MetricName="managed"}},
    @{Name="DeviceIngestRateLimit";Priority=30;Action=$action;Statement=@{RateBasedStatement=@{Limit=100000;AggregateKeyType="IP"}};VisibilityConfig=@{SampledRequestsEnabled=$true;CloudWatchMetricsEnabled=$true;MetricName="device"}},
    @{Name="ApiRateLimit";Priority=40;Action=$action;Statement=@{RateBasedStatement=@{Limit=50000;AggregateKeyType="IP"}};VisibilityConfig=@{SampledRequestsEnabled=$true;CloudWatchMetricsEnabled=$true;MetricName="api"}}
  );VisibilityConfig=@{SampledRequestsEnabled=$true;CloudWatchMetricsEnabled=$true;MetricName="acl"}}}|ConvertTo-Json -Depth 20 -Compress; exit 0
}
if ($service -eq "wafv2" -and $operation -eq "update-web-acl") { if($env:SCHOOLPILOT_TEST_WAF_DELAY){Start-Sleep -Seconds ([int]$env:SCHOOLPILOT_TEST_WAF_DELAY)};[IO.File]::WriteAllText($env:SCHOOLPILOT_TEST_WAF_FLAG,"count"); '{}'; exit 0 }
throw "Unexpected child AWS call: $($arguments -join ' ')"
'@
    [IO.File]::WriteAllText($childAws, $childAwsSource, [Text.UTF8Encoding]::new($false))
    $immediateFatalHarness = Join-Path $childRoot "immediate-fatal-after-start-gate.mjs"
    $immediateFatalHarnessSource = @'
import fs from "node:fs";
import path from "node:path";
if(process.argv.includes("--validate-config")){
  console.log(JSON.stringify({ok:true,trafficStarted:false,runId:process.env.LOAD_RUN_ID,gateProfile:"launch",thresholdsEnforced:true,networkFamily:"IPv4"}));
  process.exit(0);
}
const runId=process.env.LOAD_RUN_ID;
const stage=process.env.LOAD_STAGE;
const readyPath=process.env.LOAD_SUPERVISOR_READY_PATH;
const gatePath=process.env.LOAD_SUPERVISOR_START_GATE_PATH;
const progressPath=process.env.LOAD_EXTERNAL_PROGRESS_PATH;
const summaryPath=process.env.LOAD_EXTERNAL_SUMMARY_PATH;
const reason=process.env.SCHOOLPILOT_TEST_FATAL_REASON;
if(!runId||!stage||!readyPath||!gatePath||!progressPath||!summaryPath||!reason)process.exit(10);
fs.writeFileSync(readyPath,JSON.stringify({schemaVersion:1,type:"load_supervisor_ready",runId,stage,harnessProcessId:process.pid,readyAt:new Date().toISOString(),trafficStarted:false}));
while(!fs.existsSync(gatePath))await new Promise(resolve=>setTimeout(resolve,10));
const gate=JSON.parse(fs.readFileSync(gatePath,"utf8"));
const monitorHeartbeatPath=path.join(path.dirname(gatePath),`${runId}-monitor-heartbeat.json`);
if(!fs.existsSync(monitorHeartbeatPath))process.exit(11);
const monitorHeartbeat=JSON.parse(fs.readFileSync(monitorHeartbeatPath,"utf8"));
fs.writeFileSync(progressPath,JSON.stringify({schemaVersion:1,type:"progress",event:"start",runId,stage,timestamp:new Date().toISOString()})+"\n");
if(process.env.SCHOOLPILOT_TEST_FATAL_OBSERVED_PATH){
  fs.writeFileSync(process.env.SCHOOLPILOT_TEST_FATAL_OBSERVED_PATH,JSON.stringify({runId,reason,gate,monitorHeartbeat,observedAt:new Date().toISOString()}));
}
const fatalGate={reasonCodes:[reason],observedAt:new Date().toISOString(),kind:"tenant-isolation-probe"};
fs.appendFileSync(progressPath,JSON.stringify({schemaVersion:1,type:"fatal_gate",event:"fatal",runId,stage,timestamp:new Date().toISOString(),fatalGate})+"\n");
const summary={runId,stage,devices:1,declaredSecondSchoolCanaryDevices:0,run:{plannedTrafficSeconds:1,actualTrafficSeconds:1,completedConfiguredDuration:true},screenshotFixture:{decodedBytes:1024},thresholds:{passed:false},fatalGate};
fs.appendFileSync(progressPath,JSON.stringify({schemaVersion:1,type:"progress",event:"final",runId,stage,timestamp:new Date().toISOString(),fatalGate})+"\n");
if(process.env.SCHOOLPILOT_TEST_FINAL_WRITTEN_PATH)fs.writeFileSync(process.env.SCHOOLPILOT_TEST_FINAL_WRITTEN_PATH,"1");
const summaryDelayMilliseconds=Number.parseInt(process.env.SCHOOLPILOT_TEST_SUMMARY_DELAY_MS||"0",10);
if(Number.isFinite(summaryDelayMilliseconds)&&summaryDelayMilliseconds>0)await new Promise(resolve=>setTimeout(resolve,summaryDelayMilliseconds));
fs.writeFileSync(summaryPath,JSON.stringify(summary));
process.exit(1);
'@
    [IO.File]::WriteAllText($immediateFatalHarness, $immediateFatalHarnessSource, [Text.UTF8Encoding]::new($false))
    $sampleBarrierCoordinator = Join-Path $childRoot "sample-barrier-coordinator.ps1"
    $sampleBarrierCoordinatorSource = @'
param(
  [string]$MonitorHeartbeatPath,
  [string]$ArmPath,
  [string]$ReadyPath,
  [string]$ReleasePath,
  [string]$TerminalProgressPath,
  [string]$CompletedPath
)
$ErrorActionPreference="Stop"
function Wait-ForPath([string]$Path,[string]$Label){
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds(30)
  while(-not (Test-Path -LiteralPath $Path)){
    if([DateTimeOffset]::UtcNow -ge $deadline){throw "Timed out waiting for $Label."}
    Start-Sleep -Milliseconds 10
  }
}
Wait-ForPath $MonitorHeartbeatPath "the first monitor heartbeat"
[IO.File]::WriteAllText($ArmPath,"1")
Wait-ForPath $ReadyPath "the monitor to enter mocked AWS collection"
Wait-ForPath $TerminalProgressPath "the harness to commit terminal progress"
[IO.File]::WriteAllText($ReleasePath,"1")
[IO.File]::WriteAllText($CompletedPath,"1")
'@
    [IO.File]::WriteAllText($sampleBarrierCoordinator, $sampleBarrierCoordinatorSource, [Text.UTF8Encoding]::new($false))
    $childProgress = Join-Path $childRoot "progress.jsonl"
    $childSummary = Join-Path $childRoot "summary.json"
    $childRollbackConfigPath = Join-Path $childRoot "rollback.json"
    $childRunId = "fatal-waf-test"
    $sleepProcess = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 60") -PassThru -NoNewWindow
    Start-Sleep -Milliseconds 200
    $childRollback = @{
        schemaVersion=1;testMode=$true;testEnvironmentSentinel="SCHOOLPILOT_ROLLOUT_TEST_ONLY";testAccountId="000000000000";
        runId=$childRunId;region="us-east-1";cluster="cluster";apiService="api";workerService="worker";
        evidenceDirectory=$childEvidence;previousApiTaskDefinition="api-prev";previousWorkerTaskDefinition="worker-prev";
        emergencyApiTaskDefinition="arn:aws:ecs:us-east-1:000000000000:task-definition/test-emergency:1";
        emergencyApiTaskDefinitionFamily="test-emergency";emergencyApiContainerName="api";targetGroupArn="target";wafName="acl";wafId="id";wafScope="CLOUDFRONT";
        wafDeviceMetricName="device";wafApiMetricName="api";wafDeviceLimit=100000;wafApiLimit=50000;
        rollbackHeartbeatIntervalSeconds=1;emergencyTaskDefinitionEvidence=@{
          currentTaskDefinition=@{executionRoleArn="exec";taskRoleArn="task";networkMode="awsvpc";requiresCompatibilities=@("FARGATE");containerDefinitions=@(@{name="api";image="repo@sha256:$('b'*64)"})};
          emergencyTaskDefinition=@{status="ACTIVE";family="test-emergency";taskDefinitionArn="arn:aws:ecs:us-east-1:000000000000:task-definition/test-emergency:1";
            cpu="512";memory="2048";networkMode="awsvpc";requiresCompatibilities=@("FARGATE");executionRoleArn="exec";taskRoleArn="task";
            containerDefinitions=@(@{name="api";image="repo@sha256:$('b'*64)";memory=2048})}
        }
    }
    [IO.File]::WriteAllText($childRollbackConfigPath, ($childRollback|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $childConfigPath = Join-Path $childRoot "monitor.json"
    $childStartedAt = [DateTimeOffset]::UtcNow.AddSeconds(-1)
    $childConfig = @{
        schemaVersion=1;runId=$childRunId;phase="Waf";evidenceDirectory=$childEvidence;testEnvironmentSentinel="SCHOOLPILOT_ROLLOUT_TEST_ONLY";
        loadProgressPath=$childProgress;loadSummaryPath=$childSummary;
        artifactsNotBeforeUtc=$childStartedAt.ToString("o");automaticRollback=$true;rollbackConfigPath=$childRollbackConfigPath;
        notificationTopicArn="arn:aws:sns:us-east-1:000000000000:test";pollSeconds=1;testMode=$true;maxIterations=10;
        minimumWallClockSeconds=0;deadlineUtc=[DateTimeOffset]::UtcNow.AddMinutes(1).ToString("o");harnessProcessId=$sleepProcess.Id;
        harnessProcessStartedAtUtc=([DateTimeOffset]$sleepProcess.StartTime).ToUniversalTime().ToString("o");harnessProcessPath=$sleepProcess.Path;
        requireLoadAcceptance=$true;workload=@{stage="fatal-stage";devices=1;durationSeconds=1;screenshotBytes=1024;canaryDevices=0};
        resources=@{region="us-east-1";cluster="cluster";apiService="api";workerService="worker";targetGroupArn="target";rdsInstanceId="db";
          redisCacheClusterId="redis-001";redisReplicationGroupId="redis";vpcId="vpc";wafWebAclName="acl";wafDeviceRuleMetricName="device";
          wafApiRuleMetricName="api";route53HealthCheckId="health";route53AlarmName="route-alarm";expectedNatGatewayCount=2;expectedRoute53MeasureLatency=$true;
          expectedEcsAssignPublicIp=$false;ecsTaskSubnetIds=@("private-a","private-b");expectedRedisNodeType="cache.t4g.small"}
    }
    [IO.File]::WriteAllText($childConfigPath, ($childConfig|ConvertTo-Json -Depth 15), [Text.UTF8Encoding]::new($false))
    $oldPath = $env:PATH
    $oldFlag = $env:SCHOOLPILOT_TEST_WAF_FLAG
    $oldOomFlag = $env:SCHOOLPILOT_TEST_OOM_FLAG
    $oomFlag = Join-Path $childRoot "oom.flag"
    $oldApiTaskFlag = $env:SCHOOLPILOT_TEST_API_TASK_FLAG
    $apiTaskFlag = Join-Path $childRoot "api-task.flag"
    $oldWorkerTaskFlag = $env:SCHOOLPILOT_TEST_WORKER_TASK_FLAG
    $workerTaskFlag = Join-Path $childRoot "worker-task.flag"
    $oldUpdateLog = $env:SCHOOLPILOT_TEST_UPDATE_LOG
    $updateLog = Join-Path $childRoot "ecs-update.log"
    $env:PATH = "$childRoot$([IO.Path]::PathSeparator)$oldPath"
    $env:SCHOOLPILOT_TEST_WAF_FLAG = $wafFlag
    $env:SCHOOLPILOT_TEST_OOM_FLAG = $oomFlag
    $env:SCHOOLPILOT_TEST_API_TASK_FLAG = $apiTaskFlag
    $env:SCHOOLPILOT_TEST_WORKER_TASK_FLAG = $workerTaskFlag
    $env:SCHOOLPILOT_TEST_UPDATE_LOG = $updateLog
    $childMonitor = $null
    $oomOnlyMonitor = $null
    $oomOnlyHarness = $null
    $limitMonitor = $null
    $loadWindowMonitor = $null
    $loadWindowHarness = $null
    $futureFinalMonitor = $null
    $futureFinalHarness = $null
    $completedWaitMonitor = $null
    $completedWaitHarness = $null
    try {
        $childMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$childConfigPath,"-Mode","Monitor") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "monitor.out") -RedirectStandardError (Join-Path $childRoot "monitor.err")
        $evidencePath = Join-Path $childEvidence "$childRunId-aws-monitor.jsonl"
        $waitDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
        while (-not (Test-Path -LiteralPath $evidencePath) -and [DateTimeOffset]::UtcNow -lt $waitDeadline) { Start-Sleep -Milliseconds 100 }
        Assert-Condition (Test-Path -LiteralPath $evidencePath) "Child monitor did not begin sampling."
        $fatal = @{reasonCodes=@("valid-http-403","cross-school-http-response","tenant-isolation-probe-unavailable","command-target-scope","invalid-teacher-response");observedAt=[DateTimeOffset]::UtcNow.ToString("o")}
        $summary = @{runId=$childRunId;stage="fatal-stage";devices=1;declaredSecondSchoolCanaryDevices=0;
          run=@{plannedTrafficSeconds=1;actualTrafficSeconds=1;completedConfiguredDuration=$true};screenshotFixture=@{decodedBytes=1024};
          thresholds=@{passed=$false};fatalGate=$fatal}
        [IO.File]::WriteAllText($childSummary, ($summary|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $progress = @{schemaVersion=1;type="progress";event="final";runId=$childRunId;stage="fatal-stage";timestamp=[DateTimeOffset]::UtcNow.ToString("o");fatalGate=$fatal}
        [IO.File]::WriteAllText($childProgress, ($progress|ConvertTo-Json -Compress -Depth 12)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($oomFlag, "oom")
        Assert-Condition ($childMonitor.WaitForExit(30000)) "Child monitor did not fail fast."
        $childErrorText = Get-Content -LiteralPath (Join-Path $childRoot "monitor.err") -Raw -ErrorAction SilentlyContinue
        $childResult = Get-Content -LiteralPath (Join-Path $childEvidence "$childRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
        Assert-Condition ($childMonitor.ExitCode -eq 2) "Hard-gate monitor should exit 2 after a successful rollback (exit=$($childMonitor.ExitCode), stderr=$childErrorText, result=$($childResult|ConvertTo-Json -Compress -Depth 20))."
        $childEvidenceTail = Get-Content -LiteralPath $evidencePath -Tail 1 -ErrorAction SilentlyContinue
        Assert-Condition ($childResult.failures -contains "load:valid-http-403" -and $childResult.failures -contains "load:cross-school-http-response" -and $childResult.failures -contains "load:tenant-isolation-probe-unavailable" -and $childResult.failures -contains "load:command-target-scope" -and $childResult.failures -contains "load:invalid-teacher-response") "Final summary fatal reason codes must be preserved (actual: $($childResult|ConvertTo-Json -Compress -Depth 20); sample: $childEvidenceTail; stderr: $childErrorText)."
        Assert-Condition (@($childResult.failures | Where-Object { $_ -like "ecs_api_oom:*" }).Count -gt 0) "Priority test must observe the simultaneous API OOM."
        Assert-Condition ($childResult.rollback.attempted -and $childResult.rollback.action -eq "Application" -and $childResult.rollback.exitCode -eq 0) "Tenant-isolation regression must outrank a simultaneous OOM and restore the previous API/worker revisions."
        $sleepProcess.Refresh()
        Assert-Condition $sleepProcess.HasExited "Hard gate must terminate the bound harness process."

        $oomOnlyRunId = "oom-already-emergency-monitor"
        $oomOnlyEvidence = Join-Path $childRoot "$oomOnlyRunId-evidence"
        [void][IO.Directory]::CreateDirectory($oomOnlyEvidence)
        $oomOnlyProgress = Join-Path $childRoot "$oomOnlyRunId-progress.jsonl"
        $oomOnlySummary = Join-Path $childRoot "$oomOnlyRunId-summary.json"
        $oomOnlyRollbackPath = Join-Path $childRoot "$oomOnlyRunId-rollback.json"
        $oomOnlyRollback = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $oomOnlyRollback.runId = $oomOnlyRunId
        $oomOnlyRollback.evidenceDirectory = $oomOnlyEvidence
        [IO.File]::WriteAllText($oomOnlyRollbackPath, ($oomOnlyRollback | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $oomOnlyHarness = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 60") -PassThru -NoNewWindow
        Start-Sleep -Milliseconds 200
        $oomOnlyConfig = $childConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $oomOnlyConfig.runId = $oomOnlyRunId
        $oomOnlyConfig.evidenceDirectory = $oomOnlyEvidence
        $oomOnlyConfig.loadProgressPath = $oomOnlyProgress
        $oomOnlyConfig.loadSummaryPath = $oomOnlySummary
        $oomOnlyConfig.rollbackConfigPath = $oomOnlyRollbackPath
        $oomOnlyConfig.artifactsNotBeforeUtc = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o")
        $oomOnlyConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(1).ToString("o")
        $oomOnlyConfig.harnessProcessId = $oomOnlyHarness.Id
        $oomOnlyConfig.harnessProcessStartedAtUtc = ([DateTimeOffset]$oomOnlyHarness.StartTime).ToUniversalTime().ToString("o")
        $oomOnlyConfig.harnessProcessPath = $oomOnlyHarness.Path
        $oomOnlyConfigPath = Join-Path $childRoot "$oomOnlyRunId-monitor.json"
        [IO.File]::WriteAllText($oomOnlyConfigPath, ($oomOnlyConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($apiTaskFlag, [string]$childRollback.emergencyApiTaskDefinition, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($oomFlag, "oom", [Text.UTF8Encoding]::new($false))
        $updatesBeforeOomOnly = @(Get-Content -LiteralPath $updateLog -ErrorAction SilentlyContinue).Count
        $oomOnlyMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$oomOnlyConfigPath,"-Mode","Monitor") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "$oomOnlyRunId.out") -RedirectStandardError (Join-Path $childRoot "$oomOnlyRunId.err")
        Assert-Condition ($oomOnlyMonitor.WaitForExit(30000)) "Emergency-active OOM monitor did not fail fast."
        $oomOnlyResult = Get-Content -LiteralPath (Join-Path $oomOnlyEvidence "$oomOnlyRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
        $updatesAfterOomOnly = @(Get-Content -LiteralPath $updateLog -ErrorAction SilentlyContinue).Count
        $oomOnlyHarness.Refresh()
        Assert-Condition ($oomOnlyMonitor.ExitCode -eq 3 -and $oomOnlyResult.status -eq "failed" -and
            @($oomOnlyResult.failures | Where-Object { $_ -like "ecs_api_oom:*" }).Count -gt 0 -and
            $oomOnlyResult.rollback.attempted -and $oomOnlyResult.rollback.action -eq "Oom" -and $oomOnlyResult.rollback.exitCode -eq 1 -and
            $oomOnlyResult.rollback.error -match "already uses the reviewed emergency revision" -and
            $updatesAfterOomOnly -eq $updatesBeforeOomOnly -and $oomOnlyHarness.HasExited) `
            "An OOM on the active emergency revision must stop traffic and block progression without an ECS update."

        # The supervisor must arm the real monitor before releasing even the
        # first synthetic request. Exercise both immediate tenant exposure and
        # immediate probe availability failure through the full start-gate path.
        Remove-Item -LiteralPath $oomFlag -ErrorAction SilentlyContinue
        $oldImmediateFatalReason = $env:SCHOOLPILOT_TEST_FATAL_REASON
        $oldImmediateObservedPath = $env:SCHOOLPILOT_TEST_FATAL_OBSERVED_PATH
        try {
            foreach ($startGateCase in @(
                [pscustomobject]@{ label="cross-school"; reason="cross-school-http-response"; expectApplicationRollback=$true },
                [pscustomobject]@{ label="probe-unavailable"; reason="tenant-isolation-probe-unavailable"; expectApplicationRollback=$false }
            )) {
                Remove-Item -LiteralPath $apiTaskFlag,$workerTaskFlag -ErrorAction SilentlyContinue
                $caseRunId = "start-gate-$($startGateCase.label)"
                $caseEvidence = Join-Path $childRoot "$caseRunId-evidence"
                [void][IO.Directory]::CreateDirectory($caseEvidence)
                $caseProgress = Join-Path $childRoot "$caseRunId-progress.jsonl"
                $caseSummary = Join-Path $childRoot "$caseRunId-summary.json"
                $caseObserved = Join-Path $childRoot "$caseRunId-observed.json"
                $caseRollbackPath = Join-Path $childRoot "$caseRunId-rollback.json"

                $caseRollback = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
                $caseRollback.runId = $caseRunId
                $caseRollback.evidenceDirectory = $caseEvidence
                [IO.File]::WriteAllText($caseRollbackPath, ($caseRollback|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))

                $caseConfig = $childConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
                $caseConfig.runId = $caseRunId
                $caseConfig.evidenceDirectory = $caseEvidence
                $caseConfig.loadProgressPath = $caseProgress
                $caseConfig.loadSummaryPath = $caseSummary
                $caseConfig.rollbackConfigPath = $caseRollbackPath
                $caseConfig.maxIterations = 10
                $caseConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(1).ToString("o")
                $caseConfig | Add-Member -NotePropertyName expectedGeneratorPublicIp -NotePropertyValue "203.0.113.10" -Force
                $caseConfig | Add-Member -NotePropertyName testGeneratorPublicIpSequence -NotePropertyValue @("203.0.113.10") -Force
                $caseConfig | Add-Member -NotePropertyName testRuntimeHarnessScriptPath -NotePropertyValue $immediateFatalHarness -Force
                if ($startGateCase.label -eq "cross-school") {
                    # Release traffic while the next monitor sample is inside its
                    # mocked AWS calls. The final progress refresh must still retain
                    # the immediate tenant-isolation reason and rollback priority.
                    $caseConfig | Add-Member -NotePropertyName testPreReleaseGeneratorPublicIpDelayMilliseconds -NotePropertyValue 1500 -Force
                }
                $caseConfig | Add-Member -NotePropertyName supervisorWatchdog -NotePropertyValue ([pscustomobject]@{
                    monitorHeartbeatStaleSeconds=10;rollbackHeartbeatStaleSeconds=10;pollSeconds=1;generatorIpCheckSeconds=1
                }) -Force
                $caseConfigPath = Join-Path $childRoot "$caseRunId-supervisor.json"
                [IO.File]::WriteAllText($caseConfigPath, ($caseConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))

                $env:SCHOOLPILOT_TEST_FATAL_REASON = $startGateCase.reason
                $env:SCHOOLPILOT_TEST_FATAL_OBSERVED_PATH = $caseObserved
                $barrierCoordinatorProcess = $null
                $barrierCoordinatorExitCode = $null
                $barrierCompleted = $null
                $barrierReady = $null
                $barrierConsumed = $null
                $barrierEnvironment = [ordered]@{}
                if ($startGateCase.label -eq "cross-school") {
                    $barrierArm = Join-Path $childRoot "$caseRunId-sample-barrier-arm.flag"
                    $barrierReady = Join-Path $childRoot "$caseRunId-sample-barrier-ready.flag"
                    $barrierRelease = Join-Path $childRoot "$caseRunId-sample-barrier-release.flag"
                    $barrierConsumed = Join-Path $childRoot "$caseRunId-sample-barrier-consumed.flag"
                    $barrierCompleted = Join-Path $childRoot "$caseRunId-sample-barrier-completed.flag"
                    $terminalProgressWritten = Join-Path $childRoot "$caseRunId-terminal-progress-written.flag"
                    $caseMonitorHeartbeat = Join-Path $caseEvidence "$caseRunId-monitor-heartbeat.json"
                    $barrierPaths = [ordered]@{
                        SCHOOLPILOT_TEST_SAMPLE_BARRIER_ARM = $barrierArm
                        SCHOOLPILOT_TEST_SAMPLE_BARRIER_READY = $barrierReady
                        SCHOOLPILOT_TEST_SAMPLE_BARRIER_RELEASE = $barrierRelease
                        SCHOOLPILOT_TEST_SAMPLE_BARRIER_CONSUMED = $barrierConsumed
                        SCHOOLPILOT_TEST_FINAL_WRITTEN_PATH = $terminalProgressWritten
                        SCHOOLPILOT_TEST_SUMMARY_DELAY_MS = "10000"
                    }
                    foreach ($entry in $barrierPaths.GetEnumerator()) {
                        $barrierEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
                        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
                    }
                    $barrierCoordinatorProcess = Start-Process -FilePath (Get-Process -Id $PID).Path `
                        -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$sampleBarrierCoordinator,
                            "-MonitorHeartbeatPath",$caseMonitorHeartbeat,"-ArmPath",$barrierArm,"-ReadyPath",$barrierReady,
                            "-ReleasePath",$barrierRelease,"-TerminalProgressPath",$terminalProgressWritten,"-CompletedPath",$barrierCompleted) `
                        -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "$caseRunId-barrier.out") `
                        -RedirectStandardError (Join-Path $childRoot "$caseRunId-barrier.err")
                }
                $supervisorRejected = $false
                $supervisorFailure = ""
                try { & $supervisorScript -ConfigPath $caseConfigPath -Mode Run | Out-Null }
                catch {
                    $supervisorFailure = $_.Exception.Message
                    $supervisorRejected = $supervisorFailure -match "AWS monitor exited with code 2"
                }
                finally {
                    if ($null -ne $barrierCoordinatorProcess) {
                        if (-not $barrierCoordinatorProcess.WaitForExit(5000)) {
                            Stop-Process -Id $barrierCoordinatorProcess.Id -Force -ErrorAction SilentlyContinue
                        }
                        $barrierCoordinatorProcess.Refresh()
                        if ($barrierCoordinatorProcess.HasExited) { $barrierCoordinatorExitCode = $barrierCoordinatorProcess.ExitCode }
                    }
                    foreach ($entry in $barrierEnvironment.GetEnumerator()) {
                        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
                    }
                }
                Assert-Condition $supervisorRejected "$caseRunId must fail through the armed monitor, not before monitor startup (actual: $supervisorFailure)."
                Assert-Condition (Test-Path -LiteralPath $caseObserved) "$caseRunId harness never observed the released start gate."
                if ($startGateCase.label -eq "cross-school") {
                    $barrierError = Get-Content -LiteralPath (Join-Path $childRoot "$caseRunId-barrier.err") -Raw -ErrorAction SilentlyContinue
                    Assert-Condition ($barrierCoordinatorExitCode -eq 0 -and (Test-Path -LiteralPath $barrierCompleted) -and
                        (Test-Path -LiteralPath $barrierReady) -and (Test-Path -LiteralPath $barrierConsumed) -and
                        (Test-Path -LiteralPath $terminalProgressWritten)) `
                        "$caseRunId did not exercise the deterministic in-sample AWS barrier (exit=$barrierCoordinatorExitCode; stderr=$barrierError)."
                    Assert-Condition ((Get-Item -LiteralPath $barrierReady).LastWriteTimeUtc -le (Get-Item -LiteralPath $terminalProgressWritten).LastWriteTimeUtc) `
                        "$caseRunId terminal evidence must be committed while the monitor is inside mocked AWS collection."
                    Assert-Condition (-not (Test-Path -LiteralPath $caseSummary)) `
                        "$caseRunId must preserve and act on terminal fatal evidence before the atomic summary exists."
                }

                $caseObservation = Get-Content -LiteralPath $caseObserved -Raw | ConvertFrom-Json -Depth 20
                Assert-Condition ($caseObservation.reason -eq $startGateCase.reason) "$caseRunId observed the wrong immediate fatal reason."
                Assert-Condition ($caseObservation.gate.runId -eq $caseRunId -and $caseObservation.monitorHeartbeat.runId -eq $caseRunId) "$caseRunId gate and monitor heartbeat identities must match."
                Assert-Condition ([DateTimeOffset]$caseObservation.gate.releasedAt -ge [DateTimeOffset]$caseObservation.monitorHeartbeat.timestamp) "$caseRunId traffic gate opened before the first monitor heartbeat."

                $caseMonitorResultPath = Join-Path $caseEvidence "$caseRunId-monitor-result.json"
                Assert-Condition (Test-Path -LiteralPath $caseMonitorResultPath) "$caseRunId monitor did not write its failure result."
                $caseMonitorResult = Get-Content -LiteralPath $caseMonitorResultPath -Raw | ConvertFrom-Json -Depth 20
                Assert-Condition ($caseMonitorResult.failures -contains "load:$($startGateCase.reason)") "$caseRunId monitor did not preserve the immediate fatal reason (result=$($caseMonitorResult|ConvertTo-Json -Compress -Depth 20))."
                if ($startGateCase.expectApplicationRollback) {
                    Assert-Condition ($caseMonitorResult.rollback.attempted -and $caseMonitorResult.rollback.action -eq "Application" -and $caseMonitorResult.rollback.exitCode -eq 0) "$caseRunId must invoke the pre-approved Application rollback."
                }
                else {
                    Assert-Condition (-not $caseMonitorResult.rollback.attempted) "$caseRunId availability-indeterminate failure must stop without guessing at an infrastructure mutation."
                }
            }
        }
        finally {
            if ($null -eq $oldImmediateFatalReason) { Remove-Item Env:SCHOOLPILOT_TEST_FATAL_REASON -ErrorAction SilentlyContinue }
            else { $env:SCHOOLPILOT_TEST_FATAL_REASON = $oldImmediateFatalReason }
            if ($null -eq $oldImmediateObservedPath) { Remove-Item Env:SCHOOLPILOT_TEST_FATAL_OBSERVED_PATH -ErrorAction SilentlyContinue }
            else { $env:SCHOOLPILOT_TEST_FATAL_OBSERVED_PATH = $oldImmediateObservedPath }
        }

        $slowRollbackConfig = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $slowRollbackConfig.runId = "slow-waf-rollback-heartbeat"
        [IO.File]::WriteAllText($childRollbackConfigPath, ($slowRollbackConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        Remove-Item -LiteralPath $wafFlag -ErrorAction SilentlyContinue
        $env:SCHOOLPILOT_TEST_WAF_DELAY = "3"
        $slowRollbackProcess = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$rollbackScript,"-ConfigPath",$childRollbackConfigPath,"-Action","Waf","-Mode","Execute") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "slow-rollback.out") -RedirectStandardError (Join-Path $childRoot "slow-rollback.err")
        $slowHeartbeatPath = Join-Path $childEvidence "slow-waf-rollback-heartbeat-rollback-heartbeat.json"
        $slowHeartbeatDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
        while (-not (Test-Path -LiteralPath $slowHeartbeatPath) -and [DateTimeOffset]::UtcNow -lt $slowHeartbeatDeadline) { Start-Sleep -Milliseconds 100 }
        $slowRollbackError = Get-Content -LiteralPath (Join-Path $childRoot "slow-rollback.err") -Raw -ErrorAction SilentlyContinue
        $slowRollbackOut = Get-Content -LiteralPath (Join-Path $childRoot "slow-rollback.out") -Raw -ErrorAction SilentlyContinue
        $slowStateDebugPath = Join-Path $childEvidence "slow-waf-rollback-heartbeat-rollback-state.json"
        $slowStateDebug = Get-Content -LiteralPath $slowStateDebugPath -Raw -ErrorAction SilentlyContinue
        $slowRollbackProcess.Refresh()
        Assert-Condition (Test-Path -LiteralPath $slowHeartbeatPath) "Slow rollback did not create its independent heartbeat (exited=$($slowRollbackProcess.HasExited); state=$slowStateDebug; stdout=$slowRollbackOut; stderr=$slowRollbackError)."
        $firstSlowHeartbeatWrite = (Get-Item -LiteralPath $slowHeartbeatPath).LastWriteTimeUtc
        Start-Sleep -Milliseconds 1500
        $secondSlowHeartbeatWrite = (Get-Item -LiteralPath $slowHeartbeatPath).LastWriteTimeUtc
        Assert-Condition ($secondSlowHeartbeatWrite -gt $firstSlowHeartbeatWrite) "Rollback heartbeat must keep advancing while a slow AWS mutation blocks the monitor process."
        Assert-Condition ($slowRollbackProcess.WaitForExit(15000) -and $slowRollbackProcess.ExitCode -eq 0) "Slow WAF rollback must complete within its bounded action deadline."
        $slowState = Get-Content -LiteralPath (Join-Path $childEvidence "slow-waf-rollback-heartbeat-rollback-state.json") -Raw | ConvertFrom-Json
        Assert-Condition ($slowState.status -eq "completed") "Rollback progress state must end in completed after the slow action."
        Remove-Item Env:SCHOOLPILOT_TEST_WAF_DELAY -ErrorAction SilentlyContinue

        Remove-Item -LiteralPath $oomFlag -ErrorAction SilentlyContinue
        $uncorrelatedRunId = "uncorrelated-valid-403"
        $uncorrelatedHarness = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile","-Command","Start-Sleep -Seconds 30") -PassThru -NoNewWindow
        $uncorrelatedRollback = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $uncorrelatedRollback.runId = $uncorrelatedRunId
        [IO.File]::WriteAllText($childRollbackConfigPath, ($uncorrelatedRollback|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $uncorrelatedProgress = Join-Path $childRoot "uncorrelated-progress.jsonl"
        $uncorrelatedSummary = Join-Path $childRoot "uncorrelated-summary.json"
        $uncorrelatedStarted = [DateTimeOffset]::UtcNow.AddSeconds(-1)
        $uncorrelatedConfig = $childConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $uncorrelatedConfig.runId = $uncorrelatedRunId
        $uncorrelatedConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
        $uncorrelatedConfig.loadProgressPath = $uncorrelatedProgress
        $uncorrelatedConfig.loadSummaryPath = $uncorrelatedSummary
        $uncorrelatedConfig.rollbackConfigPath = $childRollbackConfigPath
        $uncorrelatedConfig.artifactsNotBeforeUtc = $uncorrelatedStarted.ToString("o")
        $uncorrelatedConfig.harnessProcessId = $uncorrelatedHarness.Id
        $uncorrelatedConfig.harnessProcessStartedAtUtc = ([DateTimeOffset]$uncorrelatedHarness.StartTime).ToUniversalTime().ToString("o")
        $uncorrelatedConfig.harnessProcessPath = $uncorrelatedHarness.Path
        $uncorrelatedConfigPath = Join-Path $childRoot "uncorrelated-monitor.json"
        [IO.File]::WriteAllText($uncorrelatedConfigPath, ($uncorrelatedConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $uncorrelatedMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$uncorrelatedConfigPath,"-Mode","Monitor") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "uncorrelated.out") -RedirectStandardError (Join-Path $childRoot "uncorrelated.err")
        $uncorrelatedEvidencePath = Join-Path $childEvidence "$uncorrelatedRunId-aws-monitor.jsonl"
        $uncorrelatedStartDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
        while (-not (Test-Path -LiteralPath $uncorrelatedEvidencePath) -and [DateTimeOffset]::UtcNow -lt $uncorrelatedStartDeadline) { Start-Sleep -Milliseconds 100 }
        Assert-Condition (Test-Path -LiteralPath $uncorrelatedEvidencePath) "Uncorrelated valid-403 monitor did not start."
        $uncorrelatedFatal = @{reasonCodes=@("uncorrelated-valid-http-403");observedAt=[DateTimeOffset]::UtcNow.ToString("o")}
        $uncorrelatedSummaryValue = @{runId=$uncorrelatedRunId;stage="fatal-stage";devices=1;declaredSecondSchoolCanaryDevices=0;
          run=@{plannedTrafficSeconds=1;actualTrafficSeconds=1;completedConfiguredDuration=$true};screenshotFixture=@{decodedBytes=1024};thresholds=@{passed=$false};fatalGate=$uncorrelatedFatal}
        [IO.File]::WriteAllText($uncorrelatedSummary, ($uncorrelatedSummaryValue|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $uncorrelatedProgressValue = @{schemaVersion=1;type="progress";event="final";runId=$uncorrelatedRunId;stage="fatal-stage";timestamp=[DateTimeOffset]::UtcNow.ToString("o");fatalGate=$uncorrelatedFatal}
        [IO.File]::WriteAllText($uncorrelatedProgress, ($uncorrelatedProgressValue|ConvertTo-Json -Compress -Depth 12)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Assert-Condition ($uncorrelatedMonitor.WaitForExit(30000)) "Uncorrelated valid-403 monitor timed out."
        $uncorrelatedResult = Get-Content -LiteralPath (Join-Path $childEvidence "$uncorrelatedRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
        Assert-Condition ($uncorrelatedResult.rollback.action -eq "Application" -and $uncorrelatedResult.rollback.exitCode -eq 0) "A valid synthetic 403 without a fresh rate-rule BlockedRequests datapoint must restore the application, not weaken WAF."

        $genericRejectedRunId = "generic-valid-401"
        $genericRejectedHarness = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile","-Command","Start-Sleep -Seconds 30") -PassThru -NoNewWindow
        $genericRejectedRollback = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $genericRejectedRollback.runId = $genericRejectedRunId
        [IO.File]::WriteAllText($childRollbackConfigPath, ($genericRejectedRollback|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $genericRejectedProgress = Join-Path $childRoot "generic-rejected-progress.jsonl"
        $genericRejectedSummary = Join-Path $childRoot "generic-rejected-summary.json"
        $genericRejectedStarted = [DateTimeOffset]::UtcNow.AddSeconds(-1)
        $genericRejectedConfig = $childConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $genericRejectedConfig.runId = $genericRejectedRunId
        $genericRejectedConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
        $genericRejectedConfig.loadProgressPath = $genericRejectedProgress
        $genericRejectedConfig.loadSummaryPath = $genericRejectedSummary
        $genericRejectedConfig.rollbackConfigPath = $childRollbackConfigPath
        $genericRejectedConfig.artifactsNotBeforeUtc = $genericRejectedStarted.ToString("o")
        $genericRejectedConfig.harnessProcessId = $genericRejectedHarness.Id
        $genericRejectedConfig.harnessProcessStartedAtUtc = ([DateTimeOffset]$genericRejectedHarness.StartTime).ToUniversalTime().ToString("o")
        $genericRejectedConfig.harnessProcessPath = $genericRejectedHarness.Path
        $genericRejectedConfigPath = Join-Path $childRoot "generic-rejected-monitor.json"
        [IO.File]::WriteAllText($genericRejectedConfigPath, ($genericRejectedConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $genericRejectedMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$genericRejectedConfigPath,"-Mode","Monitor") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "generic-rejected.out") -RedirectStandardError (Join-Path $childRoot "generic-rejected.err")
        $genericRejectedEvidencePath = Join-Path $childEvidence "$genericRejectedRunId-aws-monitor.jsonl"
        $genericRejectedStartDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
        while (-not (Test-Path -LiteralPath $genericRejectedEvidencePath) -and [DateTimeOffset]::UtcNow -lt $genericRejectedStartDeadline) { Start-Sleep -Milliseconds 100 }
        Assert-Condition (Test-Path -LiteralPath $genericRejectedEvidencePath) "Generic valid-401 monitor did not start."
        $genericRejectedFatal = @{reasonCodes=@("valid-http-401");observedAt=[DateTimeOffset]::UtcNow.ToString("o")}
        $genericRejectedSummaryValue = @{runId=$genericRejectedRunId;stage="fatal-stage";devices=1;declaredSecondSchoolCanaryDevices=0;
          run=@{plannedTrafficSeconds=1;actualTrafficSeconds=1;completedConfiguredDuration=$true};screenshotFixture=@{decodedBytes=1024};thresholds=@{passed=$false};fatalGate=$genericRejectedFatal}
        [IO.File]::WriteAllText($genericRejectedSummary, ($genericRejectedSummaryValue|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $genericRejectedProgressValue = @{schemaVersion=1;type="progress";event="final";runId=$genericRejectedRunId;stage="fatal-stage";timestamp=[DateTimeOffset]::UtcNow.ToString("o");fatalGate=$genericRejectedFatal}
        [IO.File]::WriteAllText($genericRejectedProgress, ($genericRejectedProgressValue|ConvertTo-Json -Compress -Depth 12)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Assert-Condition ($genericRejectedMonitor.WaitForExit(30000)) "Generic valid-401 monitor timed out."
        $genericRejectedResult = Get-Content -LiteralPath (Join-Path $childEvidence "$genericRejectedRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
        Assert-Condition ($genericRejectedResult.rollback.action -eq "Application" -and $genericRejectedResult.rollback.exitCode -eq 0) "Any valid workload 401 must invoke the reviewed application rollback."

        $combinedRunId = "combined-valid-401-rds-cpu"
        $combinedHarness = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile","-Command","Start-Sleep -Seconds 30") -PassThru -NoNewWindow
        $combinedRollbackPath = Join-Path $childRoot "combined-valid-401-rds-rollback.json"
        $combinedRollback = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $combinedRollback.runId = $combinedRunId
        $combinedRollback | Add-Member -NotePropertyName privateSubnetIds -NotePropertyValue @("private-a","private-b") -Force
        $combinedRollback | Add-Member -NotePropertyName ecsSecurityGroupIds -NotePropertyValue @("sg-1") -Force
        $combinedRollback | Add-Member -NotePropertyName privateRouteTableIds -NotePropertyValue @("rtb-private-a","rtb-private-b") -Force
        $combinedRollback | Add-Member -NotePropertyName vpcId -NotePropertyValue "vpc" -Force
        $combinedRollback | Add-Member -NotePropertyName expectedNatGatewayCount -NotePropertyValue 2 -Force
        [IO.File]::WriteAllText($combinedRollbackPath, ($combinedRollback|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $combinedProgress = Join-Path $childRoot "combined-valid-401-rds-progress.jsonl"
        $combinedSummary = Join-Path $childRoot "combined-valid-401-rds-summary.json"
        $combinedStarted = [DateTimeOffset]::UtcNow.AddSeconds(-1)
        $combinedConfig = $childConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $combinedConfig.runId = $combinedRunId
        $combinedConfig.phase = "PublicEcs"
        $combinedConfig.loadProgressPath = $combinedProgress
        $combinedConfig.loadSummaryPath = $combinedSummary
        $combinedConfig.rollbackConfigPath = $combinedRollbackPath
        $combinedConfig.artifactsNotBeforeUtc = $combinedStarted.ToString("o")
        $combinedConfig.harnessProcessId = $combinedHarness.Id
        $combinedConfig.harnessProcessStartedAtUtc = ([DateTimeOffset]$combinedHarness.StartTime).ToUniversalTime().ToString("o")
        $combinedConfig.harnessProcessPath = $combinedHarness.Path
        $combinedConfig.maxIterations = 1
        $combinedConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
        $combinedNow = [DateTimeOffset]::UtcNow.ToUniversalTime()
        $combinedMinuteTicks = [TimeSpan]::TicksPerMinute
        $combinedRuntimeBase = [DateTimeOffset]::new(
            $combinedNow.Ticks - ($combinedNow.Ticks % $combinedMinuteTicks),
            [TimeSpan]::Zero
        ).AddMinutes(-3)
        $combinedConfig | Add-Member -NotePropertyName testRuntimeSeriesNotBeforeUtc -NotePropertyValue $combinedRuntimeBase.ToString("o") -Force
        $combinedConfigPath = Join-Path $childRoot "combined-valid-401-rds-monitor.json"
        [IO.File]::WriteAllText($combinedConfigPath, ($combinedConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $combinedFatal = @{reasonCodes=@("valid-http-401");observedAt=[DateTimeOffset]::UtcNow.ToString("o")}
        # Commit terminal progress before monitor startup, but deliberately leave
        # the atomic summary absent. This models the real fatal-gate commit
        # window while allowing config validation to require a unique summary.
        $combinedProgressValue = @{schemaVersion=1;type="progress";event="final";runId=$combinedRunId;stage="fatal-stage";timestamp=[DateTimeOffset]::UtcNow.ToString("o");fatalGate=$combinedFatal}
        [IO.File]::WriteAllText($combinedProgress, ($combinedProgressValue|ConvertTo-Json -Compress -Depth 12)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        $oldCombinedRuntimeBase = $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE
        $oldCombinedRuntimePattern = $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN
        $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE = $combinedRuntimeBase.ToString("o")
        $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN = "three"
        try {
            $combinedMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
                -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$combinedConfigPath,"-Mode","Monitor") `
                -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "combined-valid-401-rds.out") -RedirectStandardError (Join-Path $childRoot "combined-valid-401-rds.err")
            Assert-Condition ($combinedMonitor.WaitForExit(30000)) "Combined valid-401/RDS monitor timed out."
        }
        finally {
            if ($null -eq $oldCombinedRuntimeBase) { Remove-Item Env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE -ErrorAction SilentlyContinue }
            else { $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE = $oldCombinedRuntimeBase }
            if ($null -eq $oldCombinedRuntimePattern) { Remove-Item Env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN -ErrorAction SilentlyContinue }
            else { $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN = $oldCombinedRuntimePattern }
        }
        $combinedResultPath = Join-Path $childEvidence "$combinedRunId-monitor-result.json"
        $combinedError = Get-Content -LiteralPath (Join-Path $childRoot "combined-valid-401-rds.err") -Raw -ErrorAction SilentlyContinue
        Assert-Condition (Test-Path -LiteralPath $combinedResultPath) "Combined valid-401/RDS monitor did not write a result (stderr=$combinedError)."
        $combinedResult = Get-Content -LiteralPath $combinedResultPath -Raw | ConvertFrom-Json -Depth 20
        Assert-Condition ($combinedResult.failures -contains "load:valid-http-401" -and $combinedResult.failures -contains "rds_cpu") "Combined regression must observe both the valid workload 401 and three consecutive RDS CPU breaches."
        Assert-Condition ($combinedResult.rollback.attempted -and $combinedResult.rollback.action -eq "PublicEcs" -and $combinedResult.rollback.exitCode -eq 0) "An active-phase RDS breach must outrank a simultaneous generic 401 application rollback (actual=$($combinedResult.rollback|ConvertTo-Json -Compress -Depth 20); stderr=$combinedError)."

        $correlatedWafBlockFlag = Join-Path $childRoot "correlated-waf-block.flag"
        $env:SCHOOLPILOT_TEST_WAF_DEVICE_BLOCK_FILE = $correlatedWafBlockFlag
        $correlatedRunId = "correlated-valid-403"
        $correlatedHarness = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile","-Command","Start-Sleep -Seconds 30") -PassThru -NoNewWindow
        $correlatedRollback = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $correlatedRollback.runId = $correlatedRunId
        [IO.File]::WriteAllText($childRollbackConfigPath, ($correlatedRollback|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $correlatedProgress = Join-Path $childRoot "correlated-progress.jsonl"
        $correlatedSummary = Join-Path $childRoot "correlated-summary.json"
        $correlatedConfig = $childConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $correlatedConfig.runId = $correlatedRunId
        $correlatedConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
        $correlatedConfig.loadProgressPath = $correlatedProgress
        $correlatedConfig.loadSummaryPath = $correlatedSummary
        $correlatedConfig.rollbackConfigPath = $childRollbackConfigPath
        $correlatedConfig.artifactsNotBeforeUtc = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o")
        $correlatedConfig.harnessProcessId = $correlatedHarness.Id
        $correlatedConfig.harnessProcessStartedAtUtc = ([DateTimeOffset]$correlatedHarness.StartTime).ToUniversalTime().ToString("o")
        $correlatedConfig.harnessProcessPath = $correlatedHarness.Path
        $correlatedConfigPath = Join-Path $childRoot "correlated-monitor.json"
        [IO.File]::WriteAllText($correlatedConfigPath, ($correlatedConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $correlatedMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$correlatedConfigPath,"-Mode","Monitor") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "correlated.out") -RedirectStandardError (Join-Path $childRoot "correlated.err")
        $correlatedEvidencePath = Join-Path $childEvidence "$correlatedRunId-aws-monitor.jsonl"
        $correlatedStartDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
        while (-not (Test-Path -LiteralPath $correlatedEvidencePath) -and [DateTimeOffset]::UtcNow -lt $correlatedStartDeadline) { Start-Sleep -Milliseconds 100 }
        Assert-Condition (Test-Path -LiteralPath $correlatedEvidencePath) "Correlated valid-403 monitor did not start."
        [IO.File]::WriteAllText($correlatedWafBlockFlag, "blocked")
        $correlatedFatal = @{reasonCodes=@("valid-http-403");observedAt=[DateTimeOffset]::UtcNow.ToString("o")}
        $correlatedSummaryValue = @{runId=$correlatedRunId;stage="fatal-stage";devices=1;declaredSecondSchoolCanaryDevices=0;
          run=@{plannedTrafficSeconds=1;actualTrafficSeconds=1;completedConfiguredDuration=$true};screenshotFixture=@{decodedBytes=1024};thresholds=@{passed=$false};fatalGate=$correlatedFatal}
        [IO.File]::WriteAllText($correlatedSummary, ($correlatedSummaryValue|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $correlatedProgressValue = @{schemaVersion=1;type="progress";event="final";runId=$correlatedRunId;stage="fatal-stage";timestamp=[DateTimeOffset]::UtcNow.ToString("o");fatalGate=$correlatedFatal}
        [IO.File]::WriteAllText($correlatedProgress, ($correlatedProgressValue|ConvertTo-Json -Compress -Depth 12)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Assert-Condition ($correlatedMonitor.WaitForExit(30000)) "Correlated valid-403 monitor timed out."
        $correlatedResult = Get-Content -LiteralPath (Join-Path $childEvidence "$correlatedRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
        Assert-Condition ($correlatedResult.rollback.action -eq "Waf" -and $correlatedResult.rollback.exitCode -eq 0) "A valid synthetic 403 corroborated by fresh device-rate BlockedRequests must switch only the reviewed WAF rate rules to COUNT."
        Remove-Item Env:SCHOOLPILOT_TEST_WAF_DEVICE_BLOCK_FILE -ErrorAction SilentlyContinue

        foreach ($raceKind in @("summary-pending", "partial-tail")) {
            $raceRunId = "load-$raceKind-race"
            $raceHarness = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile","-Command","Start-Sleep -Seconds 60") -PassThru -NoNewWindow
            Start-Sleep -Milliseconds 200
            $raceHarness.Refresh()
            $raceConfig = $childConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
            $raceConfig.runId = $raceRunId
            $raceConfig.automaticRollback = $false
            $raceConfig.PSObject.Properties.Remove("rollbackConfigPath")
            $raceConfig.maxIterations = 2
            $raceConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
            $raceConfig.loadProgressPath = Join-Path $childRoot "$raceRunId-progress.jsonl"
            $raceConfig.loadSummaryPath = Join-Path $childRoot "$raceRunId-summary.json"
            $raceConfig.artifactsNotBeforeUtc = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o")
            $raceConfig.harnessProcessId = $raceHarness.Id
            $raceConfig.harnessProcessStartedAtUtc = ([DateTimeOffset]$raceHarness.StartTime).ToUniversalTime().ToString("o")
            $raceConfig.harnessProcessPath = (Get-Process -Id $PID).Path
            $raceConfigPath = Join-Path $childRoot "$raceRunId-monitor.json"
            [IO.File]::WriteAllText($raceConfigPath, ($raceConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
            $raceMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
                -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$raceConfigPath,"-Mode","Monitor") `
                -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "$raceRunId.out") -RedirectStandardError (Join-Path $childRoot "$raceRunId.err")
            $raceEvidencePath = Join-Path $childEvidence "$raceRunId-aws-monitor.jsonl"
            $raceStartDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
            while (-not (Test-Path -LiteralPath $raceEvidencePath) -and [DateTimeOffset]::UtcNow -lt $raceStartDeadline) { Start-Sleep -Milliseconds 100 }
            $raceMonitor.Refresh()
            $raceStartError = Get-Content -LiteralPath (Join-Path $childRoot "$raceRunId.err") -Raw -ErrorAction SilentlyContinue
            Assert-Condition (Test-Path -LiteralPath $raceEvidencePath) "$raceKind race monitor did not start (exited=$($raceMonitor.HasExited); exit=$($raceMonitor.ExitCode); stderr=$raceStartError)."
            if ($raceKind -eq "summary-pending") {
                $raceEvent = @{schemaVersion=1;type="progress";event="final";runId=$raceRunId;stage="fatal-stage";timestamp=[DateTimeOffset]::UtcNow.ToString("o")}
                [IO.File]::WriteAllText($raceConfig.loadProgressPath, ($raceEvent|ConvertTo-Json -Compress -Depth 10)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
            }
            else {
                $completeEvent = @{schemaVersion=1;type="progress";event="progress";runId=$raceRunId;stage="fatal-stage";timestamp=[DateTimeOffset]::UtcNow.ToString("o")}
                [IO.File]::WriteAllText($raceConfig.loadProgressPath, ($completeEvent|ConvertTo-Json -Compress -Depth 10)+[Environment]::NewLine+'{"event":"final"', [Text.UTF8Encoding]::new($false))
            }
            Assert-Condition ($raceMonitor.WaitForExit(30000)) "$raceKind race monitor timed out."
            $raceResult = Get-Content -LiteralPath (Join-Path $childEvidence "$raceRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
            Assert-Condition ($raceResult.failures -contains "monitor_iteration_limit_reached_before_acceptance" -and
                $raceResult.failures -notcontains "load_progress_parse_error" -and $raceResult.failures -notcontains "load_summary_invalid" -and
                $raceResult.failures -notcontains "load_generator_process_lost") "$raceKind commit window must be retried within grace instead of invalidating the run."
            if (-not $raceHarness.HasExited) { Stop-Process -Id $raceHarness.Id -Force }
        }

        $limitRunId = "limit-fail-test"
        $limitConfigPath = Join-Path $childRoot "limit-monitor.json"
        $limitConfig = @{
            schemaVersion=1;runId=$limitRunId;phase="Application";evidenceDirectory=$childEvidence;automaticRollback=$false;
            testEnvironmentSentinel="SCHOOLPILOT_ROLLOUT_TEST_ONLY";notificationTopicArn="arn:aws:sns:us-east-1:000000000000:test";pollSeconds=1;testMode=$true;maxIterations=1;
            minimumWallClockSeconds=10;deadlineUtc=[DateTimeOffset]::UtcNow.AddMinutes(1).ToString("o");
            resources=@{region="us-east-1";cluster="cluster";apiService="api";workerService="worker";targetGroupArn="target";rdsInstanceId="db";
              redisCacheClusterId="redis-001";redisReplicationGroupId="redis";vpcId="vpc";wafWebAclName="acl";wafDeviceRuleMetricName="device";
              wafApiRuleMetricName="api";route53HealthCheckId="health";route53AlarmName="route-alarm";expectedNatGatewayCount=2;expectedRoute53MeasureLatency=$true;
              expectedEcsAssignPublicIp=$false;ecsTaskSubnetIds=@("private-a","private-b");expectedRedisNodeType="cache.t4g.small"}
        }
        [IO.File]::WriteAllText($limitConfigPath, ($limitConfig|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $limitMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$limitConfigPath,"-Mode","Monitor") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "limit.out") -RedirectStandardError (Join-Path $childRoot "limit.err")
        Assert-Condition ($limitMonitor.WaitForExit(30000)) "Iteration-limit monitor did not fail closed."
        $limitResult = Get-Content -LiteralPath (Join-Path $childEvidence "$limitRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
        Assert-Condition ($limitMonitor.ExitCode -eq 2 -and $limitResult.failures -contains "monitor_iteration_limit_reached_before_acceptance") "maxIterations must be a fail-closed ceiling, never a success condition."
        Assert-Condition (-not $limitResult.rollback.attempted) "Monitoring completeness failures must not mutate infrastructure."

        function Invoke-ChildMonitorCase {
            param([string]$CaseId, $CaseConfig)
            $CaseConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
            $casePath = Join-Path $childRoot "$CaseId.json"
            [IO.File]::WriteAllText($casePath, ($CaseConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
            $process = Start-Process -FilePath (Get-Process -Id $PID).Path `
                -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$casePath,"-Mode","Monitor") `
                -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "$CaseId.out") -RedirectStandardError (Join-Path $childRoot "$CaseId.err")
            Assert-Condition ($process.WaitForExit(30000)) "$CaseId monitor timed out."
            $resultPath = Join-Path $childEvidence "$CaseId-monitor-result.json"
            $caseError = Get-Content -LiteralPath (Join-Path $childRoot "$CaseId.err") -Raw -ErrorAction SilentlyContinue
            $caseOutput = Get-Content -LiteralPath (Join-Path $childRoot "$CaseId.out") -Raw -ErrorAction SilentlyContinue
            Assert-Condition (Test-Path -LiteralPath $resultPath -PathType Leaf) "$CaseId monitor did not write a result (exit=$($process.ExitCode); stdout=$caseOutput; stderr=$caseError)."
            $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json -Depth 30
            $lastEvidence = Get-Content -LiteralPath (Join-Path $childEvidence "$CaseId-aws-monitor.jsonl") -Tail 1 -ErrorAction SilentlyContinue
            return [pscustomobject]@{ process=$process; result=$result; lastEvidence=$lastEvidence }
        }

        $sparseWafConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $sparseWafConfig.runId = "sparse-waf-zero"
        $sparseWafConfig.minimumWallClockSeconds = 3
        $sparseWafConfig.maxIterations = 5
        $env:SCHOOLPILOT_TEST_WAF_SPARSE_ZERO = "1"
        $sparseWafCase = Invoke-ChildMonitorCase "sparse-waf-zero" $sparseWafConfig
        Remove-Item Env:SCHOOLPILOT_TEST_WAF_SPARSE_ZERO -ErrorAction SilentlyContinue
        $sparseWafSample = $sparseWafCase.lastEvidence | ConvertFrom-Json -Depth 30
        Assert-Condition ($sparseWafCase.process.ExitCode -eq 0 -and $sparseWafCase.result.status -eq "completed") "Sparse zero-event WAF counters must not invalidate a healthy monitor sample."
        Assert-Condition ($sparseWafSample.waf.deviceBlockedSparseZero -eq $true -and $sparseWafSample.waf.apiBlockedSparseZero -eq $true) "Sparse WAF zero substitution must remain explicit in monitor evidence."

        $partialWafConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $partialWafConfig.runId = "partial-waf-unavailable"
        $partialWafConfig.minimumWallClockSeconds = 10
        $partialWafConfig.maxIterations = 4
        $env:SCHOOLPILOT_TEST_WAF_PARTIAL_EMPTY = "1"
        $partialWafCase = Invoke-ChildMonitorCase "partial-waf-unavailable" $partialWafConfig
        Remove-Item Env:SCHOOLPILOT_TEST_WAF_PARTIAL_EMPTY -ErrorAction SilentlyContinue
        Assert-Condition ($partialWafCase.process.ExitCode -eq 2 -and
            $partialWafCase.result.failures -contains "missing_metric:waf_device_blocked" -and
            $partialWafCase.result.failures -contains "missing_metric:waf_api_blocked") "Partial WAF telemetry must remain fail-closed instead of being converted to a sparse zero."

        $slowFreshConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $slowFreshConfig.runId = "five-minute-runtime-freshness"
        $slowFreshConfig.minimumWallClockSeconds = 3
        $slowFreshConfig.maxIterations = 5
        $env:SCHOOLPILOT_TEST_FIVE_MINUTE_METRIC_AGE_SECONDS = "600"
        $slowFreshCase = Invoke-ChildMonitorCase "five-minute-runtime-freshness" $slowFreshConfig
        Remove-Item Env:SCHOOLPILOT_TEST_FIVE_MINUTE_METRIC_AGE_SECONDS -ErrorAction SilentlyContinue
        Assert-Condition ($slowFreshCase.process.ExitCode -eq 0 -and $slowFreshCase.result.status -eq "completed") "A healthy five-minute credit datapoint 600 seconds old must remain fresh while one-minute metrics stay current."

        $slowStaleConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $slowStaleConfig.runId = "five-minute-runtime-stale"
        $slowStaleConfig.minimumWallClockSeconds = 10
        $slowStaleConfig.maxIterations = 4
        $env:SCHOOLPILOT_TEST_FIVE_MINUTE_METRIC_AGE_SECONDS = "720"
        $slowStaleCase = Invoke-ChildMonitorCase "five-minute-runtime-stale" $slowStaleConfig
        Remove-Item Env:SCHOOLPILOT_TEST_FIVE_MINUTE_METRIC_AGE_SECONDS -ErrorAction SilentlyContinue
        foreach ($slowMetric in @("rds_cpu_credit", "rds_surplus_credits_charged", "redis_cpu_credit")) {
            Assert-Condition ($slowStaleCase.result.failures -contains "stale_metric:$slowMetric") "Five-minute metric '$slowMetric' older than 660 seconds must fail closed after three checks."
        }

        $rdsCpuLagConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $rdsCpuLagConfig.runId = "rds-cpu-publication-lag"
        $rdsCpuLagConfig.minimumWallClockSeconds = 10
        $rdsCpuLagConfig.maxIterations = 3
        $env:SCHOOLPILOT_TEST_RDS_CPU_METRIC_AGE_SECONDS = "210"
        $rdsCpuLagCase = Invoke-ChildMonitorCase "rds-cpu-publication-lag" $rdsCpuLagConfig
        Remove-Item Env:SCHOOLPILOT_TEST_RDS_CPU_METRIC_AGE_SECONDS -ErrorAction SilentlyContinue
        Assert-Condition ($rdsCpuLagCase.process.ExitCode -eq 2 -and
            $rdsCpuLagCase.result.failures -contains "monitor_iteration_limit_reached_before_acceptance" -and
            $rdsCpuLagCase.result.failures -notcontains "stale_metric:rds_cpu") "A live RDS CPU series with one additional period of publication lag must remain runtime-valid without padding cumulative in-run evidence."

        $rdsCpuStaleConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $rdsCpuStaleConfig.runId = "rds-cpu-truly-stale"
        $rdsCpuStaleConfig.minimumWallClockSeconds = 10
        $rdsCpuStaleConfig.maxIterations = 4
        $env:SCHOOLPILOT_TEST_RDS_CPU_METRIC_AGE_SECONDS = "300"
        $rdsCpuStaleCase = Invoke-ChildMonitorCase "rds-cpu-truly-stale" $rdsCpuStaleConfig
        Remove-Item Env:SCHOOLPILOT_TEST_RDS_CPU_METRIC_AGE_SECONDS -ErrorAction SilentlyContinue
        $rdsCpuStaleFailures = @($rdsCpuStaleCase.result.failures | Where-Object { $_ -like "stale_metric:*" })
        Assert-Condition ($rdsCpuStaleCase.process.ExitCode -eq 2 -and
            $rdsCpuStaleFailures.Count -eq 1 -and
            $rdsCpuStaleFailures[0] -eq "stale_metric:rds_cpu") "An RDS CPU series older than four raw minutes must still fail closed without implicating current metrics."

        $fastStaleConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $fastStaleConfig.runId = "one-minute-runtime-stale"
        $fastStaleConfig.minimumWallClockSeconds = 10
        $fastStaleConfig.maxIterations = 4
        $env:SCHOOLPILOT_TEST_FAST_METRIC_AGE_SECONDS = "330"
        $fastStaleCase = Invoke-ChildMonitorCase "one-minute-runtime-stale" $fastStaleConfig
        Remove-Item Env:SCHOOLPILOT_TEST_FAST_METRIC_AGE_SECONDS -ErrorAction SilentlyContinue
        Assert-Condition (@($fastStaleCase.result.failures | Where-Object { $_ -like "stale_metric:ecs_*" }).Count -gt 0) "One-minute metrics must retain the 180-second fail-closed freshness gate."

        foreach ($wafSignal in @(
            [pscustomobject]@{ id="device-blocked-no-valid403"; env="SCHOOLPILOT_TEST_WAF_DEVICE_BLOCK"; failure="waf_device_blocked" },
            [pscustomobject]@{ id="api-blocked-no-valid403"; env="SCHOOLPILOT_TEST_WAF_API_BLOCK"; failure="waf_api_blocked" }
        )) {
            $signalRollback = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
            $signalRollback.runId = $wafSignal.id
            [IO.File]::WriteAllText($childRollbackConfigPath, ($signalRollback|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
            $signalConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
            $signalConfig.runId = $wafSignal.id
            $signalConfig.phase = "Waf"
            $signalConfig.minimumWallClockSeconds = 0
            $signalConfig.automaticRollback = $true
            $signalConfig | Add-Member -NotePropertyName rollbackConfigPath -NotePropertyValue $childRollbackConfigPath -Force
            [Environment]::SetEnvironmentVariable($wafSignal.env, "1", "Process")
            $signalCase = Invoke-ChildMonitorCase $wafSignal.id $signalConfig
            [Environment]::SetEnvironmentVariable($wafSignal.env, $null, "Process")
            Assert-Condition ($signalCase.result.failures -contains $wafSignal.failure -and -not $signalCase.result.rollback.attempted) "Fresh $($wafSignal.failure) without a valid synthetic 403 must stop/alert for manual triage without weakening WAF."
        }

        $wafResourceRunId = "waf-resource-regression"
        $wafResourceRollback = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $wafResourceRollback.runId = $wafResourceRunId
        [IO.File]::WriteAllText($childRollbackConfigPath, ($wafResourceRollback|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $wafResourceConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $wafResourceConfig.runId = $wafResourceRunId
        $wafResourceConfig.phase = "Waf"
        $wafResourceConfig.minimumWallClockSeconds = 0
        $wafResourceConfig.automaticRollback = $true
        $wafResourceConfig | Add-Member -NotePropertyName rollbackConfigPath -NotePropertyValue $childRollbackConfigPath -Force
        $env:SCHOOLPILOT_TEST_PENDING = "1"
        $wafResourceCase = Invoke-ChildMonitorCase $wafResourceRunId $wafResourceConfig
        Remove-Item Env:SCHOOLPILOT_TEST_PENDING -ErrorAction SilentlyContinue
        Assert-Condition ($wafResourceCase.result.rollback.action -eq "Application" -and $wafResourceCase.result.rollback.exitCode -eq 0) "Week-1 ECS/RDS/Redis resource regressions must restore the application, never switch WAF to COUNT."

        $publicContract = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $publicContract.runId = "public-ip-contract"
        $publicContract.phase = "PublicEcs"
        $publicContract.minimumWallClockSeconds = 0
        $publicContract.resources.expectedEcsAssignPublicIp = $true
        $publicIpCase = Invoke-ChildMonitorCase "public-ip-contract" $publicContract
        Assert-Condition ($publicIpCase.process.ExitCode -eq 2 -and $publicIpCase.result.failures -contains "ecs_network_contract_mismatch") "Public-ECS gate must reject services/tasks without the expected public IPv4 contract."

        $pendingConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $pendingConfig.runId = "pending-modification-gate"
        $pendingConfig.minimumWallClockSeconds = 0
        $env:SCHOOLPILOT_TEST_PENDING = "1"
        $pendingCase = Invoke-ChildMonitorCase "pending-modification-gate" $pendingConfig
        Assert-Condition ($pendingCase.result.failures -contains "rds_pending_modifications" -and $pendingCase.result.failures -contains "redis_pending_modifications") "Load/soak posture must fail closed on non-empty RDS or Redis pending modifications."
        Remove-Item Env:SCHOOLPILOT_TEST_PENDING -ErrorAction SilentlyContinue

        $env:SCHOOLPILOT_TEST_NAT_ZERO = "1"
        $natZero = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $natZero.runId = "nat-zero-contract"
        $natZero.phase = "NatRemoved"
        $natZero.minimumWallClockSeconds = 0
        $natZero.resources.expectedNatGatewayCount = 0
        $natZeroCase = Invoke-ChildMonitorCase "nat-zero-contract" $natZero
        $natZeroEvidence = Get-Content -LiteralPath (Join-Path $childEvidence "nat-zero-contract-aws-monitor.jsonl") -Tail 1 -ErrorAction SilentlyContinue
        Assert-Condition ($natZeroCase.process.ExitCode -eq 0 -and $natZeroCase.result.status -eq "completed") "Post-removal gate must accept exactly zero NAT gateways (actual: $($natZeroCase.result|ConvertTo-Json -Compress -Depth 20); sample: $natZeroEvidence)."
        Remove-Item Env:SCHOOLPILOT_TEST_NAT_ZERO -ErrorAction SilentlyContinue

        $cadenceConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $cadenceConfig.runId = "telemetry-cadence-contract"
        $cadenceConfig.minimumWallClockSeconds = 0
        $cadenceConfig | Add-Member -NotePropertyName testTelemetryExpectedSeconds -NotePropertyValue 180 -Force
        $cadenceCase = Invoke-ChildMonitorCase "telemetry-cadence-contract" $cadenceConfig
        Assert-Condition ($cadenceCase.process.ExitCode -eq 2 -and $cadenceCase.result.acceptance.violations -contains "telemetry_coverage:ecs_api_cpu" -and
            $cadenceCase.result.acceptance.violations -contains "telemetry_cadence:ecs_api_cpu") "Acceptance must reject sparse/repeated telemetry that lacks unique 60-second coverage and span."

        $rdsBackfillConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $rdsBackfillConfig.runId = "rds-cpu-publication-backfill"
        $rdsBackfillConfig.minimumWallClockSeconds = 0
        $rdsBackfillConfig.maxIterations = 1
        $rdsBackfillConfig | Add-Member -NotePropertyName testTelemetryExpectedSeconds -NotePropertyValue 120 -Force
        $rdsBackfillConfig | Add-Member -NotePropertyName testTelemetryMetricNames -NotePropertyValue @("rds_cpu") -Force
        $env:SCHOOLPILOT_TEST_RDS_CPU_BACKFILL = "1"
        $rdsBackfillCase = Invoke-ChildMonitorCase "rds-cpu-publication-backfill" $rdsBackfillConfig
        Assert-Condition ($rdsBackfillCase.process.ExitCode -eq 0 -and $rdsBackfillCase.result.status -eq "completed" -and
            $rdsBackfillCase.result.acceptance.metrics.rds_cpu.count -eq 2 -and
            $rdsBackfillCase.result.acceptance.metrics.rds_cpu.maximum -eq 12) "Delayed RDS CPU datapoints returned in one poll must backfill strict one-minute acceptance coverage."

        $rdsSpikeConfig = $rdsBackfillConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $rdsSpikeConfig.runId = "rds-cpu-publication-backfill-spike"
        $env:SCHOOLPILOT_TEST_RDS_CPU_BACKFILL_SPIKE = "1"
        $rdsSpikeCase = Invoke-ChildMonitorCase "rds-cpu-publication-backfill-spike" $rdsSpikeConfig
        $rdsSpikeSample = $rdsSpikeCase.lastEvidence | ConvertFrom-Json -Depth 30
        Assert-Condition ($rdsSpikeCase.process.ExitCode -eq 2 -and
            $rdsSpikeCase.result.acceptance.violations -contains "rds_cpu_peak" -and
            $rdsSpikeCase.result.acceptance.metrics.rds_cpu.maximum -eq 70 -and
            $rdsSpikeSample.metrics.rdsCpuPercent -eq 10 -and
            $rdsSpikeCase.result.failures -notcontains "rds_cpu") "A delayed RDS CPU spike must remain visible to cumulative acceptance without replacing the latest-only runtime sample."
        Remove-Item Env:SCHOOLPILOT_TEST_RDS_CPU_BACKFILL,Env:SCHOOLPILOT_TEST_RDS_CPU_BACKFILL_SPIKE -ErrorAction SilentlyContinue

        $runtimeBaseNow = [DateTimeOffset]::UtcNow.ToUniversalTime()
        $runtimeMinuteTicks = [TimeSpan]::TicksPerMinute
        $runtimeBase = [DateTimeOffset]::new(
            $runtimeBaseNow.Ticks - ($runtimeBaseNow.Ticks % $runtimeMinuteTicks),
            [TimeSpan]::Zero
        ).AddMinutes(-3)
        $runtimeSeriesConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $runtimeSeriesConfig.minimumWallClockSeconds = 10
        $runtimeSeriesConfig.maxIterations = 1
        $runtimeSeriesConfig | Add-Member -NotePropertyName testRuntimeSeriesNotBeforeUtc -NotePropertyValue $runtimeBase.ToString("o") -Force
        $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE = $runtimeBase.ToString("o")

        $runtimeSeriesConfig.runId = "rds-cpu-delayed-single-runtime"
        $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN = "one"
        $singleRuntimeCase = Invoke-ChildMonitorCase "rds-cpu-delayed-single-runtime" $runtimeSeriesConfig
        Assert-Condition ($singleRuntimeCase.result.failures -contains "monitor_iteration_limit_reached_before_acceptance" -and
            $singleRuntimeCase.result.failures -notcontains "rds_cpu") "One delayed RDS CPU spike must not trigger the three-consecutive-minute runtime gate."

        $runtimeSeriesConfig.runId = "rds-cpu-delayed-three-runtime"
        $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN = "three"
        $threeRuntimeCase = Invoke-ChildMonitorCase "rds-cpu-delayed-three-runtime" $runtimeSeriesConfig
        Assert-Condition ($threeRuntimeCase.process.ExitCode -eq 2 -and
            $threeRuntimeCase.result.failures -contains "rds_cpu") "Three consecutive delayed RDS CPU breach datapoints returned together must trigger the runtime gate."

        $runtimeSeriesConfig.runId = "rds-cpu-delayed-gap-runtime"
        $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN = "gapped"
        $gappedRuntimeCase = Invoke-ChildMonitorCase "rds-cpu-delayed-gap-runtime" $runtimeSeriesConfig
        Assert-Condition ($gappedRuntimeCase.result.failures -contains "monitor_iteration_limit_reached_before_acceptance" -and
            $gappedRuntimeCase.result.failures -notcontains "rds_cpu") "A missing one-minute RDS datapoint must reset the consecutive runtime breach counter."

        $historicalRuntimeConfig = $runtimeSeriesConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $historicalRuntimeConfig.runId = "rds-cpu-pre-monitor-history"
        $historicalRuntimeConfig.testRuntimeSeriesNotBeforeUtc = $runtimeBase.AddMinutes(3).ToString("o")
        $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN = "historical"
        $historicalRuntimeCase = Invoke-ChildMonitorCase "rds-cpu-pre-monitor-history" $historicalRuntimeConfig
        $historicalRuntimeSample = $historicalRuntimeCase.lastEvidence | ConvertFrom-Json -Depth 30
        Assert-Condition ($historicalRuntimeCase.result.failures -contains "monitor_iteration_limit_reached_before_acceptance" -and
            $historicalRuntimeCase.result.failures -notcontains "rds_cpu" -and
            $historicalRuntimeSample.metrics.rdsCpuPercent -eq 10) "Pre-monitor RDS breach history must not trigger the active phase rollback when the current datapoint is healthy."

        $boundaryRuntimeBase = $runtimeBase.AddMinutes(1)
        $boundaryStepFile = Join-Path $childRoot "rds-cpu-boundary-step.txt"
        $boundaryRuntimeConfig = $runtimeSeriesConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $boundaryRuntimeConfig.testRuntimeSeriesNotBeforeUtc = $boundaryRuntimeBase.ToString("o")
        $boundaryRuntimeConfig.maxIterations = 3
        $env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE = $boundaryRuntimeBase.ToString("o")
        $env:SCHOOLPILOT_TEST_RDS_CPU_BOUNDARY_STEP_FILE = $boundaryStepFile
        Remove-Item -LiteralPath $boundaryStepFile -ErrorAction SilentlyContinue
        $boundaryRuntimeConfig.runId = "rds-cpu-boundary-two-post-start"
        $boundaryTwoCase = Invoke-ChildMonitorCase "rds-cpu-boundary-two-post-start" $boundaryRuntimeConfig
        Assert-Condition ($boundaryTwoCase.result.failures -contains "monitor_iteration_limit_reached_before_acceptance" -and
            $boundaryTwoCase.result.failures -notcontains "rds_cpu") "A pre-monitor RDS breach plus only two post-start breaches must not trigger rollback."

        Remove-Item -LiteralPath $boundaryStepFile -ErrorAction SilentlyContinue
        $boundaryRuntimeConfig.runId = "rds-cpu-boundary-three-post-start"
        $boundaryRuntimeConfig.maxIterations = 4
        $boundaryThreeCase = Invoke-ChildMonitorCase "rds-cpu-boundary-three-post-start" $boundaryRuntimeConfig
        Assert-Condition ($boundaryThreeCase.process.ExitCode -eq 2 -and
            $boundaryThreeCase.result.failures -contains "rds_cpu") "The third consecutive post-start RDS breach must trigger even when an earlier pre-monitor breach was ignored."
        Remove-Item Env:SCHOOLPILOT_TEST_RDS_CPU_BOUNDARY_STEP_FILE -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $boundaryStepFile -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE,Env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN -ErrorAction SilentlyContinue

        $loadWindowRunId = "rds-cpu-load-window-boundaries"
        $loadWindowProgress = Join-Path $childRoot "$loadWindowRunId-progress.jsonl"
        $loadWindowSummary = Join-Path $childRoot "$loadWindowRunId-summary.json"
        $loadWindowNow = [DateTimeOffset]::UtcNow.ToUniversalTime()
        $loadWindowStart = [DateTimeOffset]::new(
            $loadWindowNow.Ticks - ($loadWindowNow.Ticks % $runtimeMinuteTicks),
            [TimeSpan]::Zero
        ).AddMinutes(-4)
        $loadWindowStartEvent = @{schemaVersion=1;type="progress";event="start";runId=$loadWindowRunId;stage="window";timestamp=$loadWindowStart.ToString("o")}
        [IO.File]::WriteAllText($loadWindowProgress, ($loadWindowStartEvent|ConvertTo-Json -Compress -Depth 10)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Remove-Item -LiteralPath $loadWindowSummary -ErrorAction SilentlyContinue
        $loadWindowHarness = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile","-Command","Start-Sleep -Seconds 60") -PassThru -NoNewWindow
        Start-Sleep -Milliseconds 200
        $loadWindowConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $loadWindowConfig.runId = $loadWindowRunId
        $loadWindowConfig.phase = "Waf"
        $loadWindowConfig.minimumWallClockSeconds = 2
        $loadWindowConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
        $loadWindowConfig.maxIterations = 10
        $loadWindowConfig | Add-Member -NotePropertyName loadProgressPath -NotePropertyValue $loadWindowProgress -Force
        $loadWindowConfig | Add-Member -NotePropertyName loadSummaryPath -NotePropertyValue $loadWindowSummary -Force
        $loadWindowConfig | Add-Member -NotePropertyName artifactsNotBeforeUtc -NotePropertyValue $loadWindowStart.AddSeconds(-1).ToString("o") -Force
        $loadWindowConfig | Add-Member -NotePropertyName harnessProcessId -NotePropertyValue $loadWindowHarness.Id -Force
        $loadWindowConfig | Add-Member -NotePropertyName harnessProcessStartedAtUtc -NotePropertyValue ([DateTimeOffset]$loadWindowHarness.StartTime).ToUniversalTime().ToString("o") -Force
        $loadWindowConfig | Add-Member -NotePropertyName harnessProcessPath -NotePropertyValue $loadWindowHarness.Path -Force
        $loadWindowConfig | Add-Member -NotePropertyName requireLoadAcceptance -NotePropertyValue $true -Force
        $loadWindowConfig | Add-Member -NotePropertyName workload -NotePropertyValue @{stage="window";devices=1;durationSeconds=180;screenshotBytes=1024;canaryDevices=0} -Force
        $loadWindowConfig | Add-Member -NotePropertyName testTelemetryMetricNames -NotePropertyValue @("rds_cpu") -Force
        $loadWindowConfigPath = Join-Path $childRoot "$loadWindowRunId-monitor.json"
        [IO.File]::WriteAllText($loadWindowConfigPath, ($loadWindowConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $env:SCHOOLPILOT_TEST_RDS_CPU_LOAD_WINDOW_START = $loadWindowStart.ToString("o")
        $loadWindowMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$loadWindowConfigPath,"-Mode","Monitor") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "$loadWindowRunId.out") -RedirectStandardError (Join-Path $childRoot "$loadWindowRunId.err")
        $loadWindowEvidencePath = Join-Path $childEvidence "$loadWindowRunId-aws-monitor.jsonl"
        $loadWindowStartDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
        while (-not (Test-Path -LiteralPath $loadWindowEvidencePath) -and -not $loadWindowMonitor.HasExited -and [DateTimeOffset]::UtcNow -lt $loadWindowStartDeadline) { Start-Sleep -Milliseconds 100 }
        $loadWindowStartError = Get-Content -LiteralPath (Join-Path $childRoot "$loadWindowRunId.err") -Raw -ErrorAction SilentlyContinue
        Assert-Condition (Test-Path -LiteralPath $loadWindowEvidencePath) "Load-window boundary monitor did not start (exited=$($loadWindowMonitor.HasExited); stderr=$loadWindowStartError)."
        $loadWindowSummaryValue = @{runId=$loadWindowRunId;stage="window";devices=1;declaredSecondSchoolCanaryDevices=0;
          run=@{plannedTrafficSeconds=180;actualTrafficSeconds=181;completedConfiguredDuration=$true};screenshotFixture=@{decodedBytes=1024};thresholds=@{passed=$true};fatalGate=$null}
        [IO.File]::WriteAllText($loadWindowSummary, ($loadWindowSummaryValue|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $loadWindowFinalEvent = @{schemaVersion=1;type="progress";event="final";runId=$loadWindowRunId;stage="window";timestamp=[DateTimeOffset]::UtcNow.ToString("o")}
        [IO.File]::AppendAllText($loadWindowProgress, ($loadWindowFinalEvent|ConvertTo-Json -Compress -Depth 10)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Assert-Condition ($loadWindowMonitor.WaitForExit(90000)) "Load-window boundary monitor did not finish."
        $loadWindowResult = Get-Content -LiteralPath (Join-Path $childEvidence "$loadWindowRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 30
        Assert-Condition ($loadWindowMonitor.ExitCode -eq 2 -and
            $loadWindowResult.failures -contains "run_acceptance_failed" -and
            $loadWindowResult.failures -notcontains "rds_cpu" -and
            $loadWindowResult.acceptance.violations -contains "rds_cpu_peak" -and
            $loadWindowResult.acceptance.metrics.rds_cpu.count -eq 4 -and
            $loadWindowResult.acceptance.metrics.rds_cpu.maximum -eq 70) "Load telemetry must use the full actual traffic window, retain its delayed tail spike, and exclude pre-start, post-stop, and future RDS points across later polls."
        Remove-Item Env:SCHOOLPILOT_TEST_RDS_CPU_LOAD_WINDOW_START -ErrorAction SilentlyContinue
        if (-not $loadWindowHarness.HasExited) { Stop-Process -Id $loadWindowHarness.Id -Force }

        $futureFinalRunId = "load-future-final-rejected"
        $futureFinalProgress = Join-Path $childRoot "$futureFinalRunId-progress.jsonl"
        $futureFinalSummary = Join-Path $childRoot "$futureFinalRunId-summary.json"
        $futureFinalStartedAt = [DateTimeOffset]::UtcNow
        $futureFinalStartEvent = @{schemaVersion=1;type="progress";event="start";runId=$futureFinalRunId;stage="future";timestamp=$futureFinalStartedAt.ToString("o")}
        [IO.File]::WriteAllText($futureFinalProgress, ($futureFinalStartEvent|ConvertTo-Json -Compress -Depth 10)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Remove-Item -LiteralPath $futureFinalSummary -ErrorAction SilentlyContinue
        $futureFinalHarness = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile","-Command","Start-Sleep -Seconds 60") -PassThru -NoNewWindow
        Start-Sleep -Milliseconds 200
        $futureFinalConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $futureFinalConfig.runId = $futureFinalRunId
        $futureFinalConfig.phase = "Waf"
        $futureFinalConfig.minimumWallClockSeconds = 0
        $futureFinalConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
        $futureFinalConfig.maxIterations = 10
        $futureFinalConfig | Add-Member -NotePropertyName loadProgressPath -NotePropertyValue $futureFinalProgress -Force
        $futureFinalConfig | Add-Member -NotePropertyName loadSummaryPath -NotePropertyValue $futureFinalSummary -Force
        $futureFinalConfig | Add-Member -NotePropertyName artifactsNotBeforeUtc -NotePropertyValue $futureFinalStartedAt.AddSeconds(-1).ToString("o") -Force
        $futureFinalConfig | Add-Member -NotePropertyName harnessProcessId -NotePropertyValue $futureFinalHarness.Id -Force
        $futureFinalConfig | Add-Member -NotePropertyName harnessProcessStartedAtUtc -NotePropertyValue ([DateTimeOffset]$futureFinalHarness.StartTime).ToUniversalTime().ToString("o") -Force
        $futureFinalConfig | Add-Member -NotePropertyName harnessProcessPath -NotePropertyValue $futureFinalHarness.Path -Force
        $futureFinalConfig | Add-Member -NotePropertyName requireLoadAcceptance -NotePropertyValue $true -Force
        $futureFinalConfig | Add-Member -NotePropertyName workload -NotePropertyValue @{stage="future";devices=1;durationSeconds=1;screenshotBytes=1024;canaryDevices=0} -Force
        $futureFinalConfigPath = Join-Path $childRoot "$futureFinalRunId-monitor.json"
        [IO.File]::WriteAllText($futureFinalConfigPath, ($futureFinalConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $futureFinalMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$futureFinalConfigPath,"-Mode","Monitor") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "$futureFinalRunId.out") -RedirectStandardError (Join-Path $childRoot "$futureFinalRunId.err")
        $futureFinalEvidencePath = Join-Path $childEvidence "$futureFinalRunId-aws-monitor.jsonl"
        $futureFinalStartDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
        while (-not (Test-Path -LiteralPath $futureFinalEvidencePath) -and -not $futureFinalMonitor.HasExited -and [DateTimeOffset]::UtcNow -lt $futureFinalStartDeadline) { Start-Sleep -Milliseconds 100 }
        $futureFinalStartError = Get-Content -LiteralPath (Join-Path $childRoot "$futureFinalRunId.err") -Raw -ErrorAction SilentlyContinue
        Assert-Condition (Test-Path -LiteralPath $futureFinalEvidencePath) "Future-final rejection monitor did not start (exited=$($futureFinalMonitor.HasExited); stderr=$futureFinalStartError)."
        $futureFinalSummaryValue = @{runId=$futureFinalRunId;stage="future";devices=1;declaredSecondSchoolCanaryDevices=0;
          run=@{plannedTrafficSeconds=1;actualTrafficSeconds=1;completedConfiguredDuration=$true};screenshotFixture=@{decodedBytes=1024};thresholds=@{passed=$true};fatalGate=$null}
        [IO.File]::WriteAllText($futureFinalSummary, ($futureFinalSummaryValue|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $futureFinalEvent = @{schemaVersion=1;type="progress";event="final";runId=$futureFinalRunId;stage="future";timestamp=[DateTimeOffset]::UtcNow.AddMinutes(10).ToString("o")}
        [IO.File]::AppendAllText($futureFinalProgress, ($futureFinalEvent|ConvertTo-Json -Compress -Depth 10)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Assert-Condition ($futureFinalMonitor.WaitForExit(90000)) "Future-final rejection monitor did not finish."
        $futureFinalResult = Get-Content -LiteralPath (Join-Path $childEvidence "$futureFinalRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 30
        Assert-Condition ($futureFinalMonitor.ExitCode -eq 2 -and
            $futureFinalResult.failures -contains "load_workload_contract_mismatch" -and
            -not $futureFinalResult.rollback.attempted) "A future-dated final progress record must fail closed without extending telemetry or guessing at rollback."
        if (-not $futureFinalHarness.HasExited) { Stop-Process -Id $futureFinalHarness.Id -Force }

        $fiveMinuteConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $fiveMinuteConfig.runId = "five-minute-telemetry-complete"
        $fiveMinuteConfig.minimumWallClockSeconds = 2
        $fiveMinuteConfig.maxIterations = 5
        $fiveMinuteConfig | Add-Member -NotePropertyName testTelemetryExpectedSeconds -NotePropertyValue 600 -Force
        $fiveMinuteConfig | Add-Member -NotePropertyName testTelemetryMetricNames -NotePropertyValue @("rds_cpu_credit","rds_surplus_charged","redis_cpu_credit") -Force
        $env:SCHOOLPILOT_TEST_METRIC_STEP_FILE = Join-Path $childRoot "five-minute-complete-counter.txt"
        $env:SCHOOLPILOT_TEST_METRIC_STEP_START = [DateTimeOffset]::UtcNow.AddSeconds(-600).ToString("o")
        $env:SCHOOLPILOT_TEST_METRIC_STEP_SECONDS = "300"
        $fiveMinuteCase = Invoke-ChildMonitorCase "five-minute-telemetry-complete" $fiveMinuteConfig
        Assert-Condition ($fiveMinuteCase.process.ExitCode -eq 0) "Healthy five-minute credit/surplus telemetry must use proportional coverage and a bounded 360-second gap (actual: $($fiveMinuteCase.result|ConvertTo-Json -Compress -Depth 30))."

        $gappedFiveMinute = $fiveMinuteConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $gappedFiveMinute.runId = "five-minute-telemetry-gapped"
        $env:SCHOOLPILOT_TEST_METRIC_STEP_FILE = Join-Path $childRoot "five-minute-gapped-counter.txt"
        $env:SCHOOLPILOT_TEST_METRIC_STEP_START = [DateTimeOffset]::UtcNow.AddSeconds(-800).ToString("o")
        $env:SCHOOLPILOT_TEST_METRIC_STEP_SECONDS = "400"
        $gappedFiveMinuteCase = Invoke-ChildMonitorCase "five-minute-telemetry-gapped" $gappedFiveMinute
        Assert-Condition ($gappedFiveMinuteCase.result.acceptance.violations -contains "telemetry_cadence:rds_cpu_credit") "A >360-second gap in five-minute credit telemetry must fail acceptance."
        Remove-Item Env:SCHOOLPILOT_TEST_METRIC_STEP_FILE,Env:SCHOOLPILOT_TEST_METRIC_STEP_START,Env:SCHOOLPILOT_TEST_METRIC_STEP_SECONDS -ErrorAction SilentlyContinue

        $auxConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $auxConfig.runId = "auxiliary-resource-gates"
        $auxConfig.minimumWallClockSeconds = 10
        $auxConfig.maxIterations = 5
        $env:SCHOOLPILOT_TEST_AUX_BREACH = "1"
        $auxCase = Invoke-ChildMonitorCase "auxiliary-resource-gates" $auxConfig
        foreach ($expectedGate in @("rds_free_memory", "rds_cpu_credit", "rds_surplus_credits_charged", "redis_cpu_credit")) {
            Assert-Condition ($auxCase.result.failures -contains $expectedGate) "Runtime monitoring must enforce three consecutive minutes for $expectedGate."
        }
        Remove-Item Env:SCHOOLPILOT_TEST_AUX_BREACH -ErrorAction SilentlyContinue

        $swapConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $swapConfig.runId = "rds-swap-growth-gate"
        $swapConfig.minimumWallClockSeconds = 10
        $swapConfig.maxIterations = 5
        $env:SCHOOLPILOT_TEST_SWAP_COUNTER = Join-Path $childRoot "swap-counter.txt"
        $swapCase = Invoke-ChildMonitorCase "rds-swap-growth-gate" $swapConfig
        Assert-Condition ($swapCase.result.failures -contains "rds_swap_growing") "RDS SwapUsage growth must be a three-consecutive-datapoint runtime gate."
        Remove-Item Env:SCHOOLPILOT_TEST_SWAP_COUNTER -ErrorAction SilentlyContinue

        $freshnessConfig = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $freshnessConfig.runId = "metric-freshness-gate"
        $freshnessConfig.minimumWallClockSeconds = 10
        $freshnessConfig.maxIterations = 4
        $env:SCHOOLPILOT_TEST_METRIC_TIMESTAMP = [DateTimeOffset]::UtcNow.AddMinutes(-10).ToString("o")
        $freshnessCase = Invoke-ChildMonitorCase "metric-freshness-gate" $freshnessConfig
        Assert-Condition (@($freshnessCase.result.failures | Where-Object { $_ -like "stale_metric:*" }).Count -gt 0) "Runtime telemetry must fail closed after three stale one-minute checks."
        Remove-Item Env:SCHOOLPILOT_TEST_METRIC_TIMESTAMP -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_WAF_SPARSE_ZERO,Env:SCHOOLPILOT_TEST_WAF_PARTIAL_EMPTY,Env:SCHOOLPILOT_TEST_FIVE_MINUTE_METRIC_AGE_SECONDS,Env:SCHOOLPILOT_TEST_FAST_METRIC_AGE_SECONDS,Env:SCHOOLPILOT_TEST_RDS_CPU_METRIC_AGE_SECONDS -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_WAF_DELAY -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_WAF_ZERO -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_WAF_DEVICE_BLOCK,Env:SCHOOLPILOT_TEST_WAF_API_BLOCK -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_METRIC_STEP_FILE,Env:SCHOOLPILOT_TEST_METRIC_STEP_START,Env:SCHOOLPILOT_TEST_METRIC_STEP_SECONDS -ErrorAction SilentlyContinue
        if (Get-Variable slowRollbackProcess -ErrorAction SilentlyContinue) { if (-not $slowRollbackProcess.HasExited) { Stop-Process -Id $slowRollbackProcess.Id -Force } }
        if (Get-Variable uncorrelatedMonitor -ErrorAction SilentlyContinue) { if (-not $uncorrelatedMonitor.HasExited) { Stop-Process -Id $uncorrelatedMonitor.Id -Force } }
        if (Get-Variable uncorrelatedHarness -ErrorAction SilentlyContinue) { if (-not $uncorrelatedHarness.HasExited) { Stop-Process -Id $uncorrelatedHarness.Id -Force } }
        if (Get-Variable correlatedMonitor -ErrorAction SilentlyContinue) { if (-not $correlatedMonitor.HasExited) { Stop-Process -Id $correlatedMonitor.Id -Force } }
        if (Get-Variable correlatedHarness -ErrorAction SilentlyContinue) { if (-not $correlatedHarness.HasExited) { Stop-Process -Id $correlatedHarness.Id -Force } }

        $env:SCHOOLPILOT_TEST_REDIS_TYPE = "cache.t4g.micro"
        $env:SCHOOLPILOT_TEST_SNAPSHOT_TIME = [DateTimeOffset]::UtcNow.ToString("o")
        $finalSnapshot = $limitConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $finalSnapshot.runId = "final-automated-snapshot"
        $finalSnapshot.phase = "Final"
        $finalSnapshot.minimumWallClockSeconds = 0
        $finalSnapshot.resources.expectedRedisNodeType = "cache.t4g.micro"
        $finalSnapshot | Add-Member -NotePropertyName redisResizeCompletedAtUtc -NotePropertyValue ([DateTimeOffset]::UtcNow.AddHours(-1).ToString("o")) -Force
        $finalSnapshotCase = Invoke-ChildMonitorCase "final-automated-snapshot" $finalSnapshot
        Assert-Condition ($finalSnapshotCase.process.ExitCode -eq 0 -and $finalSnapshotCase.result.automatedRedisSnapshot.accepted) "Final gate must verify cache.t4g.micro and a later available automated snapshot."

        Remove-Item Env:SCHOOLPILOT_TEST_SNAPSHOT_TIME -ErrorAction SilentlyContinue
        $missingSnapshot = $finalSnapshot | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $missingSnapshot.runId = "final-missing-snapshot"
        $missingSnapshotCase = Invoke-ChildMonitorCase "final-missing-snapshot" $missingSnapshot
        Assert-Condition ($missingSnapshotCase.process.ExitCode -eq 2 -and $missingSnapshotCase.result.failures -contains "monitor_iteration_limit_reached_before_acceptance") "Final acceptance must wait for an available automated snapshot created after resize (actual: $($missingSnapshotCase.result|ConvertTo-Json -Compress -Depth 30); evidence: $($missingSnapshotCase.lastEvidence))."

        $completedWaitRunId = "final-completed-awaits-snapshot"
        $completedWaitProgress = Join-Path $childRoot "$completedWaitRunId-progress.jsonl"
        $completedWaitSummary = Join-Path $childRoot "$completedWaitRunId-summary.json"
        $completedWaitSnapshotFile = Join-Path $childRoot "$completedWaitRunId-snapshot-time.txt"
        $completedWaitRollbackEvidence = Join-Path $childEvidence "$completedWaitRunId-rollback.jsonl"
        Remove-Item -LiteralPath $completedWaitSummary,$completedWaitSnapshotFile,$completedWaitRollbackEvidence -ErrorAction SilentlyContinue
        # Keep the bound dummy generator alive beyond every observation wait;
        # the test stops it explicitly after snapshot acceptance.
        $completedWaitHarness = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile","-Command","Start-Sleep -Seconds 180") -PassThru -NoNewWindow
        Start-Sleep -Milliseconds 200
        $completedWaitStarted = [DateTimeOffset]::UtcNow.AddSeconds(-1)
        $completedWaitMetricTimestamp = [DateTimeOffset]::UtcNow
        $initialCompletedWaitProgress = @{schemaVersion=1;type="progress";event="start";runId=$completedWaitRunId;stage="endurance";timestamp=$completedWaitMetricTimestamp.ToString("o")}
        [IO.File]::WriteAllText($completedWaitProgress, ($initialCompletedWaitProgress|ConvertTo-Json -Compress -Depth 10)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))

        $completedWaitRollback = $childRollback | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $completedWaitRollback.runId = $completedWaitRunId
        $completedWaitRollback | Add-Member -NotePropertyName redisReplicationGroupId -NotePropertyValue "redis" -Force
        [IO.File]::WriteAllText($childRollbackConfigPath, ($completedWaitRollback|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        $completedWaitConfig = $childConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $completedWaitConfig.runId = $completedWaitRunId
        $completedWaitConfig.phase = "Final"
        $completedWaitConfig.loadProgressPath = $completedWaitProgress
        $completedWaitConfig.loadSummaryPath = $completedWaitSummary
        $completedWaitConfig.artifactsNotBeforeUtc = $completedWaitStarted.ToString("o")
        $completedWaitConfig.rollbackConfigPath = $childRollbackConfigPath
        $completedWaitConfig.minimumWallClockSeconds = 0
        $completedWaitConfig.maxIterations = 15
        $completedWaitConfig.deadlineUtc = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString("o")
        $completedWaitConfig.harnessProcessId = $completedWaitHarness.Id
        $completedWaitConfig.harnessProcessStartedAtUtc = ([DateTimeOffset]$completedWaitHarness.StartTime).ToUniversalTime().ToString("o")
        $completedWaitConfig.harnessProcessPath = $completedWaitHarness.Path
        $completedWaitConfig.workload = @{stage="endurance";devices=810;durationSeconds=1;screenshotBytes=40960;canaryDevices=10}
        $completedWaitConfig.resources.expectedRedisNodeType = "cache.t4g.micro"
        $completedWaitConfig | Add-Member -NotePropertyName redisResizeCompletedAtUtc -NotePropertyValue ([DateTimeOffset]::UtcNow.AddHours(-1).ToString("o")) -Force
        $completedWaitConfig | Add-Member -NotePropertyName thresholds -NotePropertyValue @{progressStaleSeconds=5} -Force
        $completedWaitConfigPath = Join-Path $childRoot "$completedWaitRunId-monitor.json"
        [IO.File]::WriteAllText($completedWaitConfigPath, ($completedWaitConfig|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        # Bind this one-second synthetic workload to a datapoint inside its
        # acceptance window. Otherwise a minute rollover between progress
        # completion and the mock CloudWatch poll can exclude only RDS CPU.
        $env:SCHOOLPILOT_TEST_METRIC_TIMESTAMP = $completedWaitMetricTimestamp.ToString("o")
        $env:SCHOOLPILOT_TEST_SNAPSHOT_TIME_FILE = $completedWaitSnapshotFile
        $completedWaitMonitor = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$monitorScript,"-ConfigPath",$completedWaitConfigPath,"-Mode","Monitor") `
            -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $childRoot "$completedWaitRunId.out") -RedirectStandardError (Join-Path $childRoot "$completedWaitRunId.err")
        Remove-Item Env:SCHOOLPILOT_TEST_METRIC_TIMESTAMP -ErrorAction SilentlyContinue
        $completedWaitEvidencePath = Join-Path $childEvidence "$completedWaitRunId-aws-monitor.jsonl"
        $completedWaitStartDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
        while (-not (Test-Path -LiteralPath $completedWaitEvidencePath) -and [DateTimeOffset]::UtcNow -lt $completedWaitStartDeadline) { Start-Sleep -Milliseconds 100 }
        $completedWaitStartError = Get-Content -LiteralPath (Join-Path $childRoot "$completedWaitRunId.err") -Raw -ErrorAction SilentlyContinue
        Assert-Condition (Test-Path -LiteralPath $completedWaitEvidencePath) "Completed-final snapshot-wait monitor did not start (stderr: $completedWaitStartError)."

        $completedWaitSummaryValue = @{runId=$completedWaitRunId;stage="endurance";devices=810;declaredSecondSchoolCanaryDevices=10;
          run=@{plannedTrafficSeconds=1;actualTrafficSeconds=1;completedConfiguredDuration=$true};screenshotFixture=@{decodedBytes=40960};thresholds=@{passed=$true};fatalGate=$null}
        [IO.File]::WriteAllText($completedWaitSummary, ($completedWaitSummaryValue|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $completedWaitFinalProgress = @{schemaVersion=1;type="progress";event="final";runId=$completedWaitRunId;stage="endurance";timestamp=[DateTimeOffset]::UtcNow.ToString("o")}
        [IO.File]::AppendAllText($completedWaitProgress, ($completedWaitFinalProgress|ConvertTo-Json -Compress -Depth 10)+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        (Get-Item -LiteralPath $completedWaitProgress).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(-10)

        $completedWaitSample = $null
        # A Windows mock-AWS sweep launches enough short-lived pwsh processes
        # that the semantic sample after the progress->final transition can
        # legitimately take longer than 15 seconds on a busy runner.
        $completedWaitSampleDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
        while (
            $null -eq $completedWaitSample -and
            -not $completedWaitMonitor.HasExited -and
            [DateTimeOffset]::UtcNow -lt $completedWaitSampleDeadline
        ) {
            foreach ($line in @(Get-Content -LiteralPath $completedWaitEvidencePath -ErrorAction SilentlyContinue)) {
                try { $candidate = $line | ConvertFrom-Json -Depth 30 }
                catch { continue }
                if ($candidate.type -eq "aws_rollout_sample" -and $candidate.loadCompleted -eq $true -and $candidate.automatedRedisSnapshot.accepted -eq $false) {
                    $completedWaitSample = $candidate
                }
            }
            if ($null -eq $completedWaitSample) { Start-Sleep -Milliseconds 100 }
        }
        $completedWaitMonitor.Refresh()
        $completedWaitExitCode = if ($completedWaitMonitor.HasExited) { $completedWaitMonitor.ExitCode } else { $null }
        $completedWaitDiagnosticResult = Get-Content -LiteralPath (Join-Path $childEvidence "$completedWaitRunId-monitor-result.json") -Raw -ErrorAction SilentlyContinue
        $completedWaitDiagnosticError = Get-Content -LiteralPath (Join-Path $childRoot "$completedWaitRunId.err") -Raw -ErrorAction SilentlyContinue
        $completedWaitDiagnosticEvidence = @(Get-Content -LiteralPath $completedWaitEvidencePath -Tail 3 -ErrorAction SilentlyContinue)
        Assert-Condition (
            $null -ne $completedWaitSample -and
            $completedWaitSample.immediateFailures -notcontains "load_progress_stale"
        ) "A valid completed final workload must remain accepted after its progress artifact becomes old while the automated snapshot is pending (monitorExited=$($completedWaitMonitor.HasExited); exitCode=$completedWaitExitCode; sample=$($completedWaitSample|ConvertTo-Json -Compress -Depth 20); result=$completedWaitDiagnosticResult; stderr=$completedWaitDiagnosticError; evidence=$($completedWaitDiagnosticEvidence -join ' || '))."
        Start-Sleep -Milliseconds 1200
        $completedWaitMonitor.Refresh()
        $earlyCompletedWaitResult = Get-Content -LiteralPath (Join-Path $childEvidence "$completedWaitRunId-monitor-result.json") -Raw -ErrorAction SilentlyContinue
        Assert-Condition (-not $completedWaitMonitor.HasExited -and -not (Test-Path -LiteralPath $completedWaitRollbackEvidence)) "The final monitor must keep waiting without Redis rollback after traffic completes and before the post-resize automated snapshot appears (result: $earlyCompletedWaitResult)."

        [IO.File]::WriteAllText($completedWaitSnapshotFile, [DateTimeOffset]::UtcNow.ToString("o"), [Text.UTF8Encoding]::new($false))
        Assert-Condition ($completedWaitMonitor.WaitForExit(60000)) "Completed-final monitor did not accept the later automated snapshot."
        # Timed WaitForExit can leave redirected-stream completion and the native
        # exit code stale on Windows. Drain once, then refresh before asserting.
        $completedWaitMonitor.WaitForExit()
        $completedWaitMonitor.Refresh()
        $completedWaitFinalExitCode = $completedWaitMonitor.ExitCode
        $completedWaitResult = Get-Content -LiteralPath (Join-Path $childEvidence "$completedWaitRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 30
        Assert-Condition ($completedWaitFinalExitCode -eq 0 -and $completedWaitResult.status -eq "completed" -and $completedWaitResult.automatedRedisSnapshot.accepted -and
            -not (Test-Path -LiteralPath $completedWaitRollbackEvidence)) "An old, valid completed progress artifact must remain accepted until a qualifying post-resize automated snapshot arrives, with no Redis rollback (exit=$completedWaitFinalExitCode; result=$($completedWaitResult|ConvertTo-Json -Compress -Depth 30); stderr=$completedWaitDiagnosticError)."
        if (-not $completedWaitHarness.HasExited) { Stop-Process -Id $completedWaitHarness.Id -Force }
        Remove-Item Env:SCHOOLPILOT_TEST_SNAPSHOT_TIME_FILE -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_REDIS_TYPE -ErrorAction SilentlyContinue

        $monitorOnlyRunId = "monitor-only-lifecycle"
        $monitorOnlyEvidence = Join-Path $childRoot "monitor-only-evidence"
        $monitorOnlyConfigPath = Join-Path $childRoot "monitor-only-lifecycle.json"
        $monitorOnlyConfig = @{
            schemaVersion=1;runId=$monitorOnlyRunId;phase="PublicEcs";evidenceDirectory=$monitorOnlyEvidence;automaticRollback=$false;
            testEnvironmentSentinel="SCHOOLPILOT_ROLLOUT_TEST_ONLY";notificationTopicArn="arn:aws:sns:us-east-1:000000000000:test";pollSeconds=1;testMode=$true;maxIterations=1;
            minimumWallClockSeconds=0;deadlineUtc=[DateTimeOffset]::UtcNow.AddMinutes(1).ToString("o");
            resources=@{region="us-east-1";cluster="cluster";apiService="api";workerService="worker";targetGroupArn="target";rdsInstanceId="db";
              redisCacheClusterId="redis-001";redisReplicationGroupId="redis";vpcId="vpc";wafWebAclName="acl";wafDeviceRuleMetricName="device";
              wafApiRuleMetricName="api";route53HealthCheckId="health";route53AlarmName="route-alarm";expectedNatGatewayCount=2;expectedRoute53MeasureLatency=$true;
              expectedEcsAssignPublicIp=$false;ecsTaskSubnetIds=@("private-a","private-b");expectedRedisNodeType="cache.t4g.small"}
        }
        [IO.File]::WriteAllText($monitorOnlyConfigPath, ($monitorOnlyConfig|ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        & $supervisorScript -ConfigPath $monitorOnlyConfigPath -Mode Run -SupervisionKind MonitorOnly | Out-Null
        $monitorOnlySupervisorResult = Get-Content -LiteralPath (Join-Path $monitorOnlyEvidence "$monitorOnlyRunId-supervisor-result.json") -Raw | ConvertFrom-Json -Depth 10
        $monitorOnlyMonitorResult = Get-Content -LiteralPath (Join-Path $monitorOnlyEvidence "$monitorOnlyRunId-monitor-result.json") -Raw | ConvertFrom-Json -Depth 20
        Assert-Condition ($monitorOnlySupervisorResult.status -eq "completed" -and $monitorOnlySupervisorResult.supervisionKind -eq "MonitorOnly") "MonitorOnly supervisor lifecycle must complete with watcher evidence."
        Assert-Condition ($monitorOnlyMonitorResult.status -eq "completed") "MonitorOnly lifecycle must supervise the AWS monitor to completion."
        Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $monitorOnlyEvidence "$monitorOnlyRunId-harness.stdout.log"))) "MonitorOnly lifecycle must never launch or create artifacts for load traffic."
    }
    finally {
        $env:PATH = $oldPath
        $env:SCHOOLPILOT_TEST_WAF_FLAG = $oldFlag
        $env:SCHOOLPILOT_TEST_OOM_FLAG = $oldOomFlag
        $env:SCHOOLPILOT_TEST_API_TASK_FLAG = $oldApiTaskFlag
        $env:SCHOOLPILOT_TEST_WORKER_TASK_FLAG = $oldWorkerTaskFlag
        $env:SCHOOLPILOT_TEST_UPDATE_LOG = $oldUpdateLog
        Remove-Item Env:SCHOOLPILOT_TEST_NAT_ZERO -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_REDIS_TYPE -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_SNAPSHOT_TIME -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_SNAPSHOT_TIME_FILE -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_PUBLIC_IP -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_AUX_BREACH -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_SWAP_COUNTER -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_METRIC_TIMESTAMP -ErrorAction SilentlyContinue
        Remove-Item Env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_BASE,Env:SCHOOLPILOT_TEST_RDS_CPU_RUNTIME_PATTERN,Env:SCHOOLPILOT_TEST_RDS_CPU_BOUNDARY_STEP_FILE,Env:SCHOOLPILOT_TEST_RDS_CPU_LOAD_WINDOW_START -ErrorAction SilentlyContinue
        if ($childMonitor -and -not $childMonitor.HasExited) { Stop-Process -Id $childMonitor.Id -Force }
        if ($oomOnlyMonitor -and -not $oomOnlyMonitor.HasExited) { Stop-Process -Id $oomOnlyMonitor.Id -Force }
        if ($oomOnlyHarness -and -not $oomOnlyHarness.HasExited) { Stop-Process -Id $oomOnlyHarness.Id -Force }
        if ($limitMonitor -and -not $limitMonitor.HasExited) { Stop-Process -Id $limitMonitor.Id -Force }
        if ($loadWindowMonitor -and -not $loadWindowMonitor.HasExited) { Stop-Process -Id $loadWindowMonitor.Id -Force }
        if ($loadWindowHarness -and -not $loadWindowHarness.HasExited) { Stop-Process -Id $loadWindowHarness.Id -Force }
        if ($futureFinalMonitor -and -not $futureFinalMonitor.HasExited) { Stop-Process -Id $futureFinalMonitor.Id -Force }
        if ($futureFinalHarness -and -not $futureFinalHarness.HasExited) { Stop-Process -Id $futureFinalHarness.Id -Force }
        if ($completedWaitMonitor -and -not $completedWaitMonitor.HasExited) { Stop-Process -Id $completedWaitMonitor.Id -Force }
        if ($completedWaitHarness -and -not $completedWaitHarness.HasExited) { Stop-Process -Id $completedWaitHarness.Id -Force }
        if (-not $sleepProcess.HasExited) { Stop-Process -Id $sleepProcess.Id -Force }
    }

    $exactGitSha = ([string](@(& git -C $repositoryRoot rev-parse --verify HEAD) | Select-Object -First 1)).Trim().ToLowerInvariant()
    $natPlanPath = Join-Path $tempRoot "20260711T120000Z-$exactGitSha-nat-restore.tfplan"
    [IO.File]::WriteAllBytes($natPlanPath, [Text.Encoding]::UTF8.GetBytes("reviewed-nat-plan"))
    $terraformStatePath = Join-Path $tempRoot "terraform.tfstate"
    [IO.File]::WriteAllText($terraformStatePath, '{"version":4,"serial":1,"lineage":"test-lineage","outputs":{},"resources":[]}', [Text.UTF8Encoding]::new($false))
    $stateBackupDirectory = Join-Path $tempRoot "state-backups"
    $oldOneDrive = $env:OneDrive
    $env:OneDrive = Join-Path $tempRoot "onedrive"
    $stateRecoveryDirectory = Join-Path $env:OneDrive "SchoolPilot-Recovery"
    [void][IO.Directory]::CreateDirectory($stateRecoveryDirectory)
    $credentialPath = Join-Path $tempRoot "recovery-credential.dpapi.txt"
    $testRecoveryPassphrase = ConvertTo-SecureString "test-only-recovery-passphrase-123" -AsPlainText -Force
    [IO.File]::WriteAllText($credentialPath, (ConvertFrom-SecureString $testRecoveryPassphrase), [Text.UTF8Encoding]::new($false))
    $testRecoveryPassphrase.Dispose()
    $rollbackConfigPath = Join-Path $tempRoot "rollback.json"
    $rollbackConfig = @{
        schemaVersion = 1
        testMode = $true
        testEnvironmentSentinel = "SCHOOLPILOT_ROLLOUT_TEST_ONLY"
        testAccountId = "000000000000"
        runId = "rollback-test"
        region = "us-east-1"
        cluster = "cluster"
        apiService = "api"
        workerService = "worker"
        evidenceDirectory = $evidenceDirectory
        previousApiTaskDefinition = "api-previous"
        previousWorkerTaskDefinition = "worker-previous"
        emergencyApiTaskDefinition = "arn:aws:ecs:us-east-1:000000000000:task-definition/test-emergency:1"
        emergencyApiTaskDefinitionFamily = "test-emergency"
        emergencyApiContainerName = "api"
        targetGroupArn = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/123"
        wafName = "acl"
        wafId = "acl-id"
        wafScope = "CLOUDFRONT"
        wafDeviceMetricName = "device"
        wafApiMetricName = "api"
        wafDeviceLimit = 100000
        wafApiLimit = 50000
        privateSubnetIds = @("subnet-private-a", "subnet-private-b")
        ecsSecurityGroupIds = @("sg-ecs")
        natRollbackPlanPath = $natPlanPath
        natRollbackPlanPhase = "nat-restore"
        natRollbackPlanSha256 = (Get-FileHash -LiteralPath $natPlanPath -Algorithm SHA256).Hash.ToLowerInvariant()
        vpcId = "vpc-1"
        expectedNatGatewayCount = 2
        privateRouteTableIds = @("rtb-private-a", "rtb-private-b")
        terraformStatePath = $terraformStatePath
        terraformStateLineage = "test-lineage"
        stateBackupOutputDirectory = $stateBackupDirectory
        stateRecoveryDirectory = $stateRecoveryDirectory
        recoveryCredentialPath = $credentialPath
        recoveryCredentialSha256 = (Get-FileHash -LiteralPath $credentialPath -Algorithm SHA256).Hash.ToLowerInvariant()
        recoveryCredentialPreparedInteractively = $true
        redisReplicationGroupId = "redis"
        rollbackHeartbeatIntervalSeconds = 1
        emergencyTaskDefinitionEvidence = @{
            currentTaskDefinition = @{executionRoleArn="exec";taskRoleArn="task";networkMode="awsvpc";requiresCompatibilities=@("FARGATE");containerDefinitions=@(@{name="api";image="repo@sha256:$('c'*64)"})}
            emergencyTaskDefinition = @{status="ACTIVE";family="test-emergency";taskDefinitionArn="arn:aws:ecs:us-east-1:000000000000:task-definition/test-emergency:1";
                cpu="512";memory="2048";networkMode="awsvpc";requiresCompatibilities=@("FARGATE");executionRoleArn="exec";taskRoleArn="task";
                containerDefinitions=@(@{name="api";image="repo@sha256:$('c'*64)";memory=2048})}
        }
    }
    $rollbackEvidencePaths = @()
    $publicPreconditionConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $publicPreconditionConfig.runId = "public-ecs-missing-nat-precondition"
    [IO.File]::WriteAllText($rollbackConfigPath, ($publicPreconditionConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $networkCallsBeforePrecondition = $global:SchoolPilotTestNetworkPayloads.Count
    $global:SchoolPilotTestNatAvailable = $false
    $publicPreconditionRejected = $false
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action PublicEcs -Mode Execute | Out-Null }
    catch { $publicPreconditionRejected = $_.Exception.Message -match "expected available gateways" }
    $global:SchoolPilotTestNatAvailable = $true
    Assert-Condition ($publicPreconditionRejected -and $global:SchoolPilotTestNetworkPayloads.Count -eq $networkCallsBeforePrecondition) "Public-ECS rollback must verify retained NAT gateways/private default routes before any ECS network mutation."

    $connectionSafeConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $connectionSafeConfig.runId = "connection-safe-application-six"
    [IO.File]::WriteAllText($rollbackConfigPath, ($connectionSafeConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $global:SchoolPilotTestServiceState.api.taskDefinition = "api-current"
    $global:SchoolPilotTestServiceState.api.desired = 6
    $global:SchoolPilotTestServiceState.api.running = 6
    $global:SchoolPilotTestServiceState.api.pending = 0
    $global:SchoolPilotTestServiceState.worker.taskDefinition = "worker-current"
    $global:SchoolPilotTestServiceState.worker.desired = 1
    $global:SchoolPilotTestServiceState.worker.running = 1
    $global:SchoolPilotTestServiceState.worker.pending = 0
    $capturedApiDeploymentJson = $global:SchoolPilotTestServiceState.api.deploymentConfiguration | ConvertTo-Json -Compress -Depth 20
    $capturedWorkerDeploymentJson = $global:SchoolPilotTestServiceState.worker.deploymentConfiguration | ConvertTo-Json -Compress -Depth 20
    $deploymentPayloadStart = $global:SchoolPilotTestDeploymentPayloads.Count
    $taskObservationStart = $global:SchoolPilotTestTaskUpdateObservations.Count
    & $rollbackScript -ConfigPath $rollbackConfigPath -Action Application -Mode Execute | Out-Null

    $connectionSafePayloads = @($global:SchoolPilotTestDeploymentPayloads | Select-Object -Skip $deploymentPayloadStart)
    Assert-Condition ($connectionSafePayloads.Count -eq 4) "Six-task Application rollback must install and then restore captured API/worker deployment configurations."
    Assert-Condition (
        $connectionSafePayloads[0].service -eq "api" -and
        [int]$connectionSafePayloads[0].configuration.maximumPercent -eq 100 -and
        [int]$connectionSafePayloads[0].configuration.minimumHealthyPercent -eq 83
    ) "Six-task Application rollback must cap API replacement capacity at desired count while keeping five tasks available."
    Assert-Condition (
        $connectionSafePayloads[1].service -eq "worker" -and
        [int]$connectionSafePayloads[1].configuration.maximumPercent -eq 100 -and
        [int]$connectionSafePayloads[1].configuration.minimumHealthyPercent -eq 0
    ) "Six-task Application rollback must prevent the singleton worker from overlapping its replacement."
    Assert-Condition (
        ($connectionSafePayloads[2].configuration | ConvertTo-Json -Compress -Depth 20) -ceq $capturedApiDeploymentJson -and
        ($connectionSafePayloads[3].configuration | ConvertTo-Json -Compress -Depth 20) -ceq $capturedWorkerDeploymentJson
    ) "Six-task Application rollback must restore the exact captured deployment configurations."

    $connectionSafeTaskUpdates = @($global:SchoolPilotTestTaskUpdateObservations | Select-Object -Skip $taskObservationStart)
    Assert-Condition (
        $connectionSafeTaskUpdates.Count -eq 2 -and
        $connectionSafeTaskUpdates[0].service -eq "api" -and
        $connectionSafeTaskUpdates[1].service -eq "worker"
    ) "Connection-safe Application rollback must stabilize the API revision before replacing the worker revision."
    Assert-Condition (@($connectionSafeTaskUpdates | Where-Object {
        [int]$_.deploymentConfiguration.maximumPercent -ne 100
    }).Count -eq 0) "No six-task Application task-definition update may use an overlapping deployment maximum."
    Assert-Condition (
        ($global:SchoolPilotTestServiceState.api.deploymentConfiguration | ConvertTo-Json -Compress -Depth 20) -ceq $capturedApiDeploymentJson -and
        ($global:SchoolPilotTestServiceState.worker.deploymentConfiguration | ConvertTo-Json -Compress -Depth 20) -ceq $capturedWorkerDeploymentJson
    ) "Application rollback postconditions must verify both captured deployment configurations were restored."
    $connectionSafeEvidencePath = Join-Path $evidenceDirectory "$($connectionSafeConfig.runId)-rollback.jsonl"
    $connectionSafeEvidence = @(Get-Content -LiteralPath $connectionSafeEvidencePath | ForEach-Object { $_ | ConvertFrom-Json -Depth 30 })
    $connectionSafeCompleted = @($connectionSafeEvidence | Where-Object status -eq "completed")
    Assert-Condition (
        $connectionSafeCompleted.Count -eq 1 -and
        $connectionSafeCompleted[0].details.postcondition.connectionSafeDeployment -eq $true -and
        [int]$connectionSafeCompleted[0].details.postcondition.apiDesired -eq 6
    ) "Completed rollback evidence must record the connection-safe six-task path."

    $secondConfigurationFailureConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $secondConfigurationFailureConfig.runId = "connection-safe-second-config-failure"
    [IO.File]::WriteAllText($rollbackConfigPath, ($secondConfigurationFailureConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $global:SchoolPilotTestServiceState.api.taskDefinition = "api-current"
    $global:SchoolPilotTestServiceState.worker.taskDefinition = "worker-current"
    $secondConfigurationCallStart = $global:SchoolPilotTestUpdateServiceCallCount
    $secondConfigurationPayloadStart = $global:SchoolPilotTestDeploymentPayloads.Count
    $secondConfigurationTaskStart = $global:SchoolPilotTestTaskUpdateObservations.Count
    $global:SchoolPilotTestFailUpdateServiceCalls = @($secondConfigurationCallStart + 2)
    $secondConfigurationError = $null
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action Application -Mode Execute | Out-Null }
    catch { $secondConfigurationError = $_ }
    finally { $global:SchoolPilotTestFailUpdateServiceCalls = @() }
    Assert-Condition (
        $null -ne $secondConfigurationError -and
        $secondConfigurationError.Exception.Message -eq "Mock update-service failure at call $($secondConfigurationCallStart + 2)."
    ) "Failure on the second temporary deployment update must preserve the original rollback exception."
    $secondConfigurationPayloads = @($global:SchoolPilotTestDeploymentPayloads | Select-Object -Skip $secondConfigurationPayloadStart)
    Assert-Condition (
        $secondConfigurationPayloads.Count -eq 3 -and
        $secondConfigurationPayloads[1].service -eq "api" -and
        $secondConfigurationPayloads[2].service -eq "worker"
    ) "A partial temporary-configuration failure must best-effort restore both captured service configurations."
    Assert-Condition (
        ($global:SchoolPilotTestServiceState.api.deploymentConfiguration | ConvertTo-Json -Compress -Depth 20) -ceq $capturedApiDeploymentJson -and
        ($global:SchoolPilotTestServiceState.worker.deploymentConfiguration | ConvertTo-Json -Compress -Depth 20) -ceq $capturedWorkerDeploymentJson -and
        $global:SchoolPilotTestTaskUpdateObservations.Count -eq $secondConfigurationTaskStart
    ) "Second-configuration failure compensation must restore both policies before any task revision changes."
    $secondConfigurationEvidence = @(Get-Content -LiteralPath (Join-Path $evidenceDirectory "$($secondConfigurationFailureConfig.runId)-rollback.jsonl") |
        ForEach-Object { $_ | ConvertFrom-Json -Depth 30 })
    $secondConfigurationFailed = @($secondConfigurationEvidence | Where-Object status -eq "failed")
    Assert-Condition (
        $secondConfigurationFailed.Count -eq 1 -and
        $secondConfigurationFailed[0].details.deploymentConfigurationRestoration.success -eq $true -and
        @($secondConfigurationFailed[0].details.deploymentConfigurationRestoration.services).Count -eq 2
    ) "Failed rollback evidence must record successful best-effort policy compensation."

    $taskFailureConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $taskFailureConfig.runId = "connection-safe-task-update-failure"
    [IO.File]::WriteAllText($rollbackConfigPath, ($taskFailureConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $global:SchoolPilotTestServiceState.api.taskDefinition = "api-current"
    $global:SchoolPilotTestServiceState.worker.taskDefinition = "worker-current"
    $taskFailureCallStart = $global:SchoolPilotTestUpdateServiceCallCount
    $taskFailurePayloadStart = $global:SchoolPilotTestDeploymentPayloads.Count
    $taskFailureObservationStart = $global:SchoolPilotTestTaskUpdateObservations.Count
    $global:SchoolPilotTestFailUpdateServiceCalls = @(($taskFailureCallStart + 3), ($taskFailureCallStart + 4))
    $taskFailureError = $null
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action Application -Mode Execute | Out-Null }
    catch { $taskFailureError = $_ }
    finally { $global:SchoolPilotTestFailUpdateServiceCalls = @() }
    Assert-Condition (
        $null -ne $taskFailureError -and
        $taskFailureError.Exception.Message -eq "Mock update-service failure at call $($taskFailureCallStart + 3)."
    ) "Task-update failure must remain the surfaced rollback exception when policy compensation also fails."
    $taskFailurePayloads = @($global:SchoolPilotTestDeploymentPayloads | Select-Object -Skip $taskFailurePayloadStart)
    Assert-Condition (
        $taskFailurePayloads.Count -eq 3 -and
        $taskFailurePayloads[2].service -eq "worker" -and
        $global:SchoolPilotTestTaskUpdateObservations.Count -eq $taskFailureObservationStart
    ) "Task-update failure compensation must still attempt the worker policy after the API policy restore fails."
    $taskFailureEvidence = @(Get-Content -LiteralPath (Join-Path $evidenceDirectory "$($taskFailureConfig.runId)-rollback.jsonl") |
        ForEach-Object { $_ | ConvertFrom-Json -Depth 30 })
    $taskFailureFailed = @($taskFailureEvidence | Where-Object status -eq "failed")
    $taskFailureRestoration = $taskFailureFailed[0].details.deploymentConfigurationRestoration
    Assert-Condition (
        $taskFailureFailed.Count -eq 1 -and
        $taskFailureRestoration.success -eq $false -and
        @($taskFailureRestoration.services).Count -eq 2 -and
        $taskFailureRestoration.services[0].service -eq "api" -and
        $taskFailureRestoration.services[0].success -eq $false -and
        $taskFailureRestoration.services[1].service -eq "worker" -and
        $taskFailureRestoration.services[1].success -eq $true -and
        $taskFailureRestoration.errors[0] -match "Mock update-service failure at call $($taskFailureCallStart + 4)"
    ) "Failed compensation details must be recorded without replacing the original rollback failure."

    $global:SchoolPilotTestServiceState.api.deploymentConfiguration = $capturedApiDeploymentJson | ConvertFrom-Json -Depth 20
    $global:SchoolPilotTestServiceState.worker.deploymentConfiguration = $capturedWorkerDeploymentJson | ConvertFrom-Json -Depth 20

    $global:SchoolPilotTestServiceState.api.taskDefinition = "api-current"
    $global:SchoolPilotTestServiceState.api.desired = 1
    $global:SchoolPilotTestServiceState.api.running = 1
    $global:SchoolPilotTestServiceState.worker.taskDefinition = "worker-current"

    $badOomConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $badOomConfig.runId = "bad-emergency-digest"
    $badOomConfig.emergencyTaskDefinitionEvidence.emergencyTaskDefinition.containerDefinitions[0].image = "repo@sha256:$('d'*64)"
    [IO.File]::WriteAllText($rollbackConfigPath, ($badOomConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $badOomRejected = $false
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action Oom -Mode Validate | Out-Null }
    catch { $badOomRejected = $_.Exception.Message -match "non-digest-matched image" }
    Assert-Condition $badOomRejected "OOM preflight must reject an emergency revision that does not match the current immutable image digest."

    $smallHardCapConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $smallHardCapConfig.runId = "bad-emergency-hard-cap"
    $smallHardCapConfig.emergencyTaskDefinitionEvidence.emergencyTaskDefinition.containerDefinitions[0].memory = 1024
    [IO.File]::WriteAllText($rollbackConfigPath, ($smallHardCapConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $smallHardCapRejected = $false
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action Oom -Mode Validate | Out-Null }
    catch { $smallHardCapRejected = $_.Exception.Message -match "memory contract" }
    Assert-Condition $smallHardCapRejected "OOM preflight must reject a defined 1024 MiB hard container cap on the 2048 MiB emergency task."

    $misconfiguredCloneConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $misconfiguredCloneConfig.runId = "bad-emergency-clone"
    $misconfiguredCloneConfig.emergencyTaskDefinitionEvidence.emergencyTaskDefinition.containerDefinitions[0] | Add-Member -NotePropertyName command -NotePropertyValue @("unsafe") -Force
    [IO.File]::WriteAllText($rollbackConfigPath, ($misconfiguredCloneConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $misconfiguredCloneRejected = $false
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action Oom -Mode Validate | Out-Null }
    catch { $misconfiguredCloneRejected = $_.Exception.Message -match "not a configuration clone" }
    Assert-Condition $misconfiguredCloneRejected "OOM preflight must canonical-compare the full task/container configuration, not only image and roles."

    $alreadyEmergencyConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $alreadyEmergencyConfig.runId = "oom-already-emergency"
    [IO.File]::WriteAllText($rollbackConfigPath, ($alreadyEmergencyConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $global:SchoolPilotTestServiceState.api.taskDefinition = $alreadyEmergencyConfig.emergencyApiTaskDefinition
    $updateCallsBeforeEmergencyBlock = @($global:SchoolPilotTestAwsCalls | Where-Object { $_ -like "ecs update-service*" }).Count
    $alreadyEmergencyRejected = $false
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action Oom -Mode Execute | Out-Null }
    catch { $alreadyEmergencyRejected = $_.Exception.Message -match "already uses the reviewed emergency revision" }
    $updateCallsAfterEmergencyBlock = @($global:SchoolPilotTestAwsCalls | Where-Object { $_ -like "ecs update-service*" }).Count
    Assert-Condition ($alreadyEmergencyRejected -and $updateCallsAfterEmergencyBlock -eq $updateCallsBeforeEmergencyBlock) "OOM rollback must block without an ECS mutation when the API already runs the emergency revision."
    $global:SchoolPilotTestServiceState.api.taskDefinition = "api-current"

    $badLineageConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $badLineageConfig.runId = "bad-state-lineage"
    $badLineageConfig.terraformStateLineage = "wrong-lineage"
    [IO.File]::WriteAllText($rollbackConfigPath, ($badLineageConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $badLineageRejected = $false
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action NatRemoved -Mode Validate | Out-Null }
    catch { $badLineageRejected = $_.Exception.Message -match "does not match the local state" }
    Assert-Condition $badLineageRejected "NAT rollback must bind the reviewed plan to the exact Terraform state lineage."

    $invalidPlanShapeConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $invalidPlanShapeConfig.runId = "invalid-plan-shape"
    [IO.File]::WriteAllText($rollbackConfigPath, ($invalidPlanShapeConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $global:SchoolPilotTestPlanShapeInvalid = $true
    $invalidPlanShapeRejected = $false
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action NatRemoved -Mode Validate | Out-Null }
    catch { $invalidPlanShapeRejected = $_.Exception.Message -match "exactly six create-only|update/delete/non-create|unreviewed" }
    $global:SchoolPilotTestPlanShapeInvalid = $false
    Assert-Condition $invalidPlanShapeRejected "NAT rollback must reject any extra, updated, or unreviewed Terraform plan change."

    $longNatRunIdConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $longNatRunIdConfig.runId = "r" * 45
    [IO.File]::WriteAllText($rollbackConfigPath, ($longNatRunIdConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $longNatRunIdRejected = $false
    try { & $rollbackScript -ConfigPath $rollbackConfigPath -Action NatRemoved -Mode Validate | Out-Null }
    catch { $longNatRunIdRejected = $_.Exception.Message -match "at most 44" }
    Assert-Condition $longNatRunIdRejected "NatRemoved validation must reject runIds whose derived backup phase exceeds 64 characters."

    foreach ($action in @("Application", "Oom", "Waf", "PublicEcs", "Redis", "NatRemoved")) {
        $actionConfig = $rollbackConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $actionConfig.runId = "rollback-test-$($action.ToLowerInvariant())"
        [IO.File]::WriteAllText($rollbackConfigPath, ($actionConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        & $rollbackScript -ConfigPath $rollbackConfigPath -Action $action -Mode Execute | Out-Null
        $rollbackEvidencePaths += Join-Path $evidenceDirectory "$($actionConfig.runId)-rollback.jsonl"
    }

    $rollbackCalls = $global:SchoolPilotTestAwsCalls -join "`n"
    Assert-Condition ($rollbackCalls.Contains("--task-definition api-previous")) "Application rollback must restore the prior API revision."
    Assert-Condition ($rollbackCalls.Contains("--task-definition worker-previous")) "Application rollback must restore the prior worker revision."
    Assert-Condition ($rollbackCalls.Contains("--task-definition arn:aws:ecs:us-east-1:000000000000:task-definition/test-emergency:1")) "OOM rollback must deploy the emergency API revision."
    Assert-Condition ($rollbackCalls.Contains("--cache-node-type cache.t4g.small")) "Redis rollback must restore cache.t4g.small."
    Assert-Condition ($global:SchoolPilotTestNetworkPayloads.Count -ge 4) "Public ECS and NAT rollbacks must restore both service network configurations."
    foreach ($payload in $global:SchoolPilotTestNetworkPayloads) {
        Assert-Condition ($payload.awsvpcConfiguration.assignPublicIp -eq "DISABLED") "Rollback must disable public task IPs."
        Assert-Condition (@($payload.awsvpcConfiguration.subnets).Count -eq 2) "Rollback must restore both captured private subnets."
    }
    Assert-Condition ($null -ne $global:SchoolPilotTestWafUpdate) "WAF rollback must submit an update."
    $rateRules = @($global:SchoolPilotTestWafUpdate.Rules | Where-Object { $_.Name -in @("DeviceIngestRateLimit", "ApiRateLimit") })
    Assert-Condition ($rateRules.Count -eq 2) "WAF rollback must find exactly the two reviewed rate rules."
    Assert-Condition (@($rateRules | Where-Object { $null -ne $_.Action.Count }).Count -eq 2) "Both rate rules must switch to COUNT."
    Assert-Condition (@($global:SchoolPilotTestWafUpdate.Rules | Where-Object Name -eq "Managed").Count -eq 1) "Managed WAF rules must remain attached."
    $terraformApplyCalls = @($global:SchoolPilotTestTerraformCalls | Where-Object { $_ -like 'apply *' })
    Assert-Condition ($terraformApplyCalls.Count -eq 1) "NAT rollback must apply exactly one reviewed Terraform plan."
    Assert-Condition ($terraformApplyCalls[0].Contains($natPlanPath)) "NAT rollback must apply the digest-verified saved plan."
    Assert-Condition (-not (Test-Path -LiteralPath $natPlanPath)) "Applied NAT rollback plans must be deleted."

    $rollbackEvidence = @($rollbackEvidencePaths | ForEach-Object { Get-Content -LiteralPath $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-Condition ($rollbackEvidence.Count -eq 12) "Each of six rollback drills must record start and completion evidence."
    Assert-Condition (@($rollbackEvidence | Where-Object status -eq "failed").Count -eq 0) "Mock rollback drills must have no failure evidence."
    $aesCopies = @(Get-ChildItem -LiteralPath $stateRecoveryDirectory -Filter "*.aesgcm" -File)
    $dpapiCopies = @(Get-ChildItem -LiteralPath $stateBackupDirectory -Filter "*.dpapi" -File)
    Assert-Condition ($aesCopies.Count -eq 2 -and $dpapiCopies.Count -eq 2) "NAT rollback must create before/after DPAPI and real AES-GCM recovery copies."
    $natCompletedEvidence = @($rollbackEvidence | Where-Object { $_.action -eq "NatRemoved" -and $_.status -eq "completed" })
    Assert-Condition ($natCompletedEvidence.Count -eq 1 -and $natCompletedEvidence[0].details.postcondition.afterStateBackup.recoveryDecryptionVerified -eq $true) "NAT rollback evidence must prove AES-GCM decrypt-and-compare verification."

    $testClock.Stop()
    Write-Host ("AWS rollout monitor and rollback automation tests: PASS ({0} assertions, {1:N1}s)" -f $script:AssertionCount,$testClock.Elapsed.TotalSeconds)
}
finally {
    if ($null -ne $previousRolloutTestSentinel) { $env:SCHOOLPILOT_ROLLOUT_TEST_MODE = $previousRolloutTestSentinel } else { Remove-Item Env:SCHOOLPILOT_ROLLOUT_TEST_MODE -ErrorAction SilentlyContinue }
    if (Get-Variable oldOneDrive -ErrorAction SilentlyContinue) { $env:OneDrive = $oldOneDrive }
    Remove-Item Function:\global:aws -ErrorAction SilentlyContinue
    Remove-Item Function:\global:terraform -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestAwsCalls -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestTerraformCalls -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestWafUpdate -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestNetworkPayloads -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestDeploymentPayloads -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestTaskUpdateObservations -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestUpdateServiceCallCount -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestFailUpdateServiceCalls -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestServiceState -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestWafCount -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestMetricQueryIds -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestMetricQueryPeriods -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestMetricLookbackSeconds -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable SchoolPilotTestRouteLatency -Scope Global -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
