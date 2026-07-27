#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$monitorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\aws-rollout-monitor.ps1"))
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($monitorPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Unable to parse rollout monitor." }
foreach ($name in @(
    "Get-BatchSeries","Get-BatchSeriesStatus","Add-AcceptanceDatapoint","Get-TelemetryAcceptanceWindow",
    "Add-AcceptanceSeriesDatapoints","Add-NatAcceptanceSeriesDatapoints",
    "Add-SparseAcceptanceSourceCoverage","Test-SparseAcceptanceCoverageReady",
    "Test-AcceptanceWindowSeriesBreach","Test-AcceptanceTelemetryCoverageReady",
    "Get-SeriesSummary","Get-DiagnosticRdsCpuCoverageResult","Get-EngineeringRdsCpuCoverageResult",
    "Add-AcceptanceViolation","Assert-TelemetryCoverage",
    "Get-RdsCreditSlopeResult","Get-AcceptanceResult"
    ,"Get-OptionalValue","Get-BoundControllerProcess","Get-StringSha256",
    "Test-EngineeringApplicationRollbackRequired",
    "Test-EngineeringControllerLossApplicationRollbackRequired",
    "Invoke-EngineeringApplicationRollback"
)) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing monitor function $name." }
    Invoke-Expression $definition.Extent.Text
}
$monitorSource = Get-Content -LiteralPath $monitorPath -Raw
$durableIntentMarker = $monitorSource.IndexOf(
    "Commit rollback intent before the first ECS mutation"
)
$durableIntentWrite = $monitorSource.IndexOf(
    "Write-AtomicJson -Path `$resultPath", $durableIntentMarker
)
$durableIntentMutation = $monitorSource.IndexOf(
    "Invoke-EngineeringApplicationRollback", $durableIntentMarker
)
Assert-Condition ($durableIntentMarker -ge 0 -and
    $durableIntentWrite -gt $durableIntentMarker -and
    $durableIntentMutation -gt $durableIntentWrite) `
    "The monitor must durably commit rollback intent before its first ECS mutation."
$assertions = 1

$runnerPath = [IO.Path]::GetFullPath((
    Join-Path $PSScriptRoot "..\scripts\load\start-classpilot-capacity-acceptance.ps1"
))
$runnerTokens = $null
$runnerParseErrors = $null
$runnerAst = [Management.Automation.Language.Parser]::ParseFile(
    $runnerPath, [ref]$runnerTokens, [ref]$runnerParseErrors
)
if ($runnerParseErrors.Count -gt 0) { throw "Unable to parse capacity-acceptance runner." }
foreach ($name in @("Get-Value", "Test-ApplicationFailure")) {
    $definition = $runnerAst.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing runner function $name." }
    Invoke-Expression $definition.Extent.Text
}

function New-Series {
    param([double[]]$Values)
    $timestamps = [System.Collections.Generic.List[DateTimeOffset]]::new()
    $valueList = [System.Collections.Generic.List[double]]::new()
    $points = [ordered]@{}
    $start = [DateTimeOffset]::Parse("2026-07-18T00:00:00Z")
    for ($index=0; $index -lt $Values.Count; $index++) {
        $timestamp = $start.AddMinutes($index)
        $timestamps.Add($timestamp)
        $valueList.Add([double]$Values[$index])
        $points[$timestamp.ToString("o")] = [double]$Values[$index]
    }
    return [pscustomobject]@{values=$valueList;timestamps=$timestamps;points=$points}
}

function Reset-AcceptanceState {
    $script:AcceptanceViolations = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $script:AcceptanceSeries = @{}
    $script:AcceptanceSourceStatuses = @{}
    $script:AcceptanceSourceCoverage = @{}
    $script:AcceptanceSparseCoverageRequired =
        [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @(
        @("ecs_api_cpu",10),@("ecs_api_memory",10),@("ecs_worker_cpu",10),@("ecs_worker_memory",10),
        @("rds_cpu",10),@("rds_connections",10),@("rds_storage_headroom",50),@("rds_free_memory",1073741824),
        @("rds_cpu_credit",30),@("rds_surplus_charged",0),@("rds_swap",0),
        @("redis_cpu",10),@("redis_memory",10),@("redis_free",209715200),
        @("redis_evictions",0),@("redis_rejected",0),@("redis_cpu_credit",20),
        @("rds_read_latency_ms",75),@("rds_write_latency_ms",75),@("rds_disk_queue_depth",3),
        @("rds_read_iops",2000),@("rds_write_iops",2000),@("rds_total_iops",4000)
    )) { $script:AcceptanceSeries[$entry[0]] = New-Series @([double]$entry[1],[double]$entry[1],[double]$entry[1]) }
    $script:NatSamples = [System.Collections.Generic.List[object]]::new()
    $script:StartedAt = [DateTimeOffset]::Parse("2026-07-18T00:00:00Z")
    $script:TrafficStartedAtUtc = $script:StartedAt
    $script:TrafficStoppedAtUtc = $null
}

$thresholds = [pscustomobject]@{
    telemetryMaximumGapSeconds=120;telemetryMinimumCoveragePercent=95
    ecsCpuSteadyMaximumPercent=60;ecsCpuMaximumPercent=70;ecsMemoryMaximumPercent=75
    rdsCpuMaximumPercent=65;rdsConnectionsMaximum=150;rdsStorageHeadroomMinimumPercent=20
    rdsFreeableMemoryMinimumBytes=536870912;rdsCpuCreditMinimum=24
    rdsLatencyP95MaximumMilliseconds=20;rdsLatencyPeakMaximumMilliseconds=50
    rdsQueueDepthP95Maximum=1;rdsIopsP95Maximum=2400;rdsIopsPeakMaximum=3000
    redisSteadyMaximumPercent=60;redisCpuMaximumPercent=70;redisMemoryMaximumPercent=70
    redisFreeMemoryMinimumBytes=104857600;redisCpuCreditMinimum=10
    requireNatSixHourAcceptance=$false;natSixHourRequiredSamples=360;natSixHourMaximumBytes=1048576
}
$baseConfig = [pscustomobject]@{
    Thresholds=$thresholds;TelemetryExpectedSeconds=0;TelemetryMetricNames=@();Workload=[pscustomobject]@{Stage="800";DurationSeconds=5400}
    ExpectedRdsInstanceClass="db.t4g.medium";DiagnosticOnly=$false;EngineeringAcceptance=$false
}

Reset-AcceptanceState
$medium = Get-AcceptanceResult -Config $baseConfig
Assert-Condition ($medium.passed -and @($medium.violations | Where-Object { $_ -match 'latency|queue|iops' }).Count -eq 0) `
    "High capacity-only latency, queue, and IOPS observations must remain evidence-only on db.t4g.medium."
$assertions++

Reset-AcceptanceState
$engineeringConfig = $baseConfig.PSObject.Copy()
$engineeringConfig.EngineeringAcceptance = $true
$engineeringConfig.Workload = [pscustomobject]@{Stage="500";DurationSeconds=1800}
$script:AcceptanceSeries["rds_cpu"] = New-Series ([double[]](1..29 | ForEach-Object { 40.0 }))
$engineeringMissingMinute = Get-EngineeringRdsCpuCoverageResult -Config $engineeringConfig
Assert-Condition (-not $engineeringMissingMinute.fullCoverage -and $engineeringMissingMinute.requiredPointCount -eq 30) `
    "Engineering Waf/500 must require all 30 one-minute RDS CPU points."
$assertions++
$script:AcceptanceSeries["rds_cpu"] = New-Series ([double[]](1..30 | ForEach-Object { 40.0 }))
$engineeringComplete = Get-EngineeringRdsCpuCoverageResult -Config $engineeringConfig
Assert-Condition ($engineeringComplete.passed -and $engineeringComplete.coveragePercent -eq 100.0) `
    "Thirty contiguous sub-65 RDS CPU points must satisfy engineering Waf/500."
$assertions++
$engineeringCpuValues = [double[]](1..30 | ForEach-Object { 40.0 })
$engineeringCpuValues[-1] = 65.0
$script:AcceptanceSeries["rds_cpu"] = New-Series $engineeringCpuValues
$engineeringBreached = Get-EngineeringRdsCpuCoverageResult -Config $engineeringConfig
Assert-Condition (-not $engineeringBreached.allPointsBelowMaximum) `
    "An engineering acceptance RDS CPU minute at exactly 65 percent must fail."
$assertions++

Reset-AcceptanceState
$engineering800Config = $baseConfig.PSObject.Copy()
$engineering800Config.EngineeringAcceptance = $true
$engineering800Config.Workload = [pscustomobject]@{Stage="800";DurationSeconds=5400}
$script:AcceptanceSeries["rds_cpu"] = New-Series ([double[]](1..89 | ForEach-Object { 40.0 }))
$engineering800MissingMinute = Get-EngineeringRdsCpuCoverageResult -Config $engineering800Config
Assert-Condition (-not $engineering800MissingMinute.fullCoverage -and
    $engineering800MissingMinute.requiredPointCount -eq 90) `
    "Engineering Waf/800 must reject 89 of 90 one-minute RDS CPU points."
$assertions++
$script:AcceptanceSeries["rds_cpu"] = New-Series ([double[]](1..90 | ForEach-Object { 40.0 }))
$engineering800Complete = Get-EngineeringRdsCpuCoverageResult -Config $engineering800Config
Assert-Condition ($engineering800Complete.passed -and
    $engineering800Complete.observedPointCount -eq 90 -and
    $engineering800Complete.coveragePercent -eq 100.0) `
    "Engineering Waf/800 must accept exactly 90 contiguous sub-65 RDS CPU points."
$assertions++

foreach ($windowCase in @(
    [pscustomobject]@{
        Name="Waf/500";Config=$engineeringConfig;Minutes=30;RequiredBuckets=31
    },
    [pscustomobject]@{
        Name="Waf/800";Config=$engineering800Config;Minutes=90;RequiredBuckets=91
    }
)) {
    Reset-AcceptanceState
    $script:TrafficStartedAtUtc =
        [DateTimeOffset]::Parse("2026-07-18T00:00:30+00:00")
    $script:TrafficStoppedAtUtc =
        $script:TrafficStartedAtUtc.AddMinutes($windowCase.Minutes)
    $missingEdgeValues = [double[]](
        1..($windowCase.RequiredBuckets - 1) | ForEach-Object { 40.0 }
    )
    $script:AcceptanceSeries["rds_cpu"] = New-Series $missingEdgeValues
    $missingEdge = Get-EngineeringRdsCpuCoverageResult -Config $windowCase.Config
    Assert-Condition (-not $missingEdge.fullCoverage -and
        $missingEdge.requiredPointCount -eq $windowCase.RequiredBuckets) `
        "$($windowCase.Name) must require every nonaligned overlapping RDS CPU minute bucket."
    $assertions++

    $completeValues = [double[]](
        1..$windowCase.RequiredBuckets | ForEach-Object { 40.0 }
    )
    $script:AcceptanceSeries["rds_cpu"] = New-Series $completeValues
    $completeWindow = Get-EngineeringRdsCpuCoverageResult -Config $windowCase.Config
    Assert-Condition ($completeWindow.passed -and
        $completeWindow.observedPointCount -eq $windowCase.RequiredBuckets) `
        "$($windowCase.Name) must accept only a complete nonaligned RDS CPU bucket set."
    $assertions++

    $completeValues[-1] = 65.0
    $script:AcceptanceSeries["rds_cpu"] = New-Series $completeValues
    $breachedEdge = Get-EngineeringRdsCpuCoverageResult -Config $windowCase.Config
    Assert-Condition (-not $breachedEdge.allPointsBelowMaximum) `
        "$($windowCase.Name) must reject an edge bucket at exactly 65 percent."
    $assertions++
}
Reset-AcceptanceState

Assert-Condition (
    Test-EngineeringApplicationRollbackRequired @(
        "rds_cpu", "load:cross-school-delivery"
    ) $null
) "A hard cross-school signal must require the exact engineering application rollback even with a capacity failure."
$assertions++
Assert-Condition (
    Test-EngineeringApplicationRollbackRequired @(
        "load:valid-http-401"
    ) $null
) "An uncorrelated valid HTTP 401 must require engineering application rollback."
$assertions++
foreach ($nonApplicationFailures in @(
    @("controller_process_lost"),
    @("rds_cpu","ecs_api_cpu"),
    @("waf_device_blocked","load:valid-http-403"),
    @("evidence_unavailable","telemetry_incomplete")
)) {
    Assert-Condition (-not (
        Test-EngineeringApplicationRollbackRequired $nonApplicationFailures $null
    )) "Controller, capacity, WAF-correlated 403, provider, and evidence failures must remain scaling-only."
    $assertions++
}

$summaryApplicationFailures = @(
    "HTTP 5xx rate exceeded 0.1%",
    "network error rate exceeded 0.1%",
    "admission-timeout 503 responses were observed",
    "valid traffic received 1 HTTP 4xx responses",
    "HTTP requests remained unfinished",
    "inspected HTTP responses could not be parsed completely",
    "heartbeat p95 exceeded the threshold",
    "screenshot success fell below 99%",
    "teacher/dashboard history batch failed",
    "teacher command delivery failed",
    "WebSocket auth did not complete",
    "WebSocket reconnect failed",
    "final pre-shutdown WebSocket state was incomplete",
    "only 799/800 device sockets were authenticated at final pre-shutdown",
    "forced reconnects were requested but not completed",
    "command validation produced no sent targets",
    "configured class bodies produced sent command targets",
    "class bodies reached 39 sent targets",
    "teacher WebSockets authenticated below target",
    "teacher WebSockets closed unexpectedly",
    "GET /api/students-aggregated emitted no completed samples",
    "POST /api/classpilot/tiles/history p95 exceeds 1000ms",
    "POST /api/classpilot/tiles/screenshots p95 exceeds 750ms",
    "POST /api/classpilot/commands emitted no completed samples",
    "command responses or update owners were incomplete",
    "server command target statuses regressed",
    "command targets sent completed ACKs below target",
    "server did not report received",
    "unfinished-http-requests"
)
foreach ($summaryFailure in $summaryApplicationFailures) {
    $summary = [pscustomobject]@{
        fatalGate = [pscustomobject]@{ reasonCodes = @() }
        thresholds = [pscustomobject]@{ failures = @($summaryFailure) }
    }
    $sample = [pscustomobject]@{
        load = [pscustomobject]@{ summary = $summary }
    }
    $runnerDecision = Test-ApplicationFailure (
        [pscustomobject]@{ failures = @() }
    ) $summary
    $monitorDecision = Test-EngineeringApplicationRollbackRequired @() $sample
    Assert-Condition ($runnerDecision -and $monitorDecision -and
        $runnerDecision -eq $monitorDecision) `
        "Monitor rollback classification must match the runner for '$summaryFailure'."
    $assertions++
}

foreach ($precedenceCase in @(
    [pscustomobject]@{
        Name = "RDS capacity suppresses derivative HTTP failure"
        MonitorFailures = @("rds_cpu")
        SummaryFailures = @("HTTP 5xx rate exceeded 0.1%")
        FatalReasons = @()
        Expected = $false
    },
    [pscustomobject]@{
        Name = "WAF enforcement suppresses correlated HTTP failure"
        MonitorFailures = @("waf_device_blocked")
        SummaryFailures = @("valid traffic received 1 HTTP 4xx responses")
        FatalReasons = @()
        Expected = $false
    },
    [pscustomobject]@{
        Name = "provider evidence suppresses derivative endpoint failure"
        MonitorFailures = @("evidence_unavailable")
        SummaryFailures = @("POST /api/classpilot/tiles/history p95 exceeds 1000ms")
        FatalReasons = @()
        Expected = $false
    },
    [pscustomobject]@{
        Name = "fatal isolation failure overrides capacity"
        MonitorFailures = @("rds_cpu")
        SummaryFailures = @()
        FatalReasons = @("cross-school-delivery")
        Expected = $true
    }
)) {
    $summary = [pscustomobject]@{
        fatalGate = [pscustomobject]@{ reasonCodes = $precedenceCase.FatalReasons }
        thresholds = [pscustomobject]@{ failures = $precedenceCase.SummaryFailures }
    }
    $sample = [pscustomobject]@{
        load = [pscustomobject]@{ summary = $summary }
    }
    $runnerDecision = Test-ApplicationFailure (
        [pscustomobject]@{ failures = $precedenceCase.MonitorFailures }
    ) $summary
    $monitorDecision = Test-EngineeringApplicationRollbackRequired `
        $precedenceCase.MonitorFailures $sample
    Assert-Condition (
        $runnerDecision -eq $precedenceCase.Expected -and
        $monitorDecision -eq $precedenceCase.Expected -and
        $runnerDecision -eq $monitorDecision
    ) "Monitor and runner precedence diverged: $($precedenceCase.Name)."
    $assertions++
}

$script:rollbackAwsCalls = [System.Collections.Generic.List[string]]::new()
function Invoke-AwsJson {
    param([string[]]$Arguments)
    $script:rollbackAwsCalls.Add(($Arguments -join " "))
    return [pscustomobject]@{}
}
function Get-EcsState {
    param($Config)
    return @{
        api=[pscustomobject]@{
            desired=6;running=6;pending=0;taskDefinition=$rollbackApiArn
        }
        worker=[pscustomobject]@{
            desired=1;running=1;pending=0;taskDefinition=$rollbackWorkerArn
        }
    }
}
$rollbackApiArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/api:10"
$rollbackWorkerArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/worker:10"
$rollbackConfig = [pscustomobject]@{
    EngineeringScalingRestoration=[pscustomobject]@{
        RollbackApiTaskDefinitionArn=$rollbackApiArn
        RollbackWorkerTaskDefinitionArn=$rollbackWorkerArn
    }
    Resources=[pscustomobject]@{
        region="us-east-1";cluster="cluster";apiService="api";workerService="worker"
    }
}
$monitorRollback = Invoke-EngineeringApplicationRollback $rollbackConfig
Assert-Condition ($monitorRollback.completed -and $monitorRollback.exitCode -eq 0 -and
    $monitorRollback.apiTaskDefinitionSha256 -ceq (Get-StringSha256 $rollbackApiArn) -and
    $monitorRollback.workerTaskDefinitionSha256 -ceq (Get-StringSha256 $rollbackWorkerArn) -and
    @($script:rollbackAwsCalls | Where-Object {
        $_ -match 'update-service.+--service api.+--task-definition.+api:10'
    }).Count -eq 1 -and
    @($script:rollbackAwsCalls | Where-Object {
        $_ -match 'update-service.+--service worker.+--task-definition.+worker:10'
    }).Count -eq 1) `
    "Monitor-owned rollback must update and verify the exact bound prior API/worker revisions."
$assertions++

function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }
foreach ($partialCase in @(
    [pscustomobject]@{
        Name="API updated before worker failure";FailingService="worker"
    },
    [pscustomobject]@{
        Name="worker updated before API failure";FailingService="api"
    }
)) {
    $script:partialCalls = [Collections.Generic.List[string]]::new()
    $script:partialFailureConsumed = $false
    $script:currentApiTask = "arn:aws:ecs:us-east-1:135775632425:task-definition/api:11"
    $script:currentWorkerTask = "arn:aws:ecs:us-east-1:135775632425:task-definition/worker:11"
    function Invoke-AwsJson {
        param([string[]]$Arguments)
        $joined = $Arguments -join " "
        $script:partialCalls.Add($joined)
        if ($Arguments[0] -ceq "ecs" -and $Arguments[1] -ceq "update-service") {
            $serviceIndex = [Array]::IndexOf($Arguments, "--service")
            $taskIndex = [Array]::IndexOf($Arguments, "--task-definition")
            $service = [string]$Arguments[$serviceIndex + 1]
            $task = [string]$Arguments[$taskIndex + 1]
            if ($service -ceq $partialCase.FailingService -and
                -not $script:partialFailureConsumed) {
                $script:partialFailureConsumed = $true
                throw "simulated transient partial rollback"
            }
            if ($service -ceq "api") { $script:currentApiTask = $task }
            if ($service -ceq "worker") { $script:currentWorkerTask = $task }
        }
        return [pscustomobject]@{}
    }
    function Get-EcsState {
        param($Config)
        return @{
            api=[pscustomobject]@{
                desired=6;running=6;pending=0;taskDefinition=$script:currentApiTask
            }
            worker=[pscustomobject]@{
                desired=1;running=1;pending=0;taskDefinition=$script:currentWorkerTask
            }
        }
    }
    $partialRollback = Invoke-EngineeringApplicationRollback $rollbackConfig
    Assert-Condition (
        $partialRollback.completed -and $partialRollback.attemptCount -eq 2 -and
        $script:currentApiTask -ceq $rollbackApiArn -and
        $script:currentWorkerTask -ceq $rollbackWorkerArn -and
        @($script:partialCalls | Where-Object {
            $_ -match 'update-service.+--service api.+--task-definition.+api:10'
        }).Count -eq 2 -and
        @($script:partialCalls | Where-Object {
            $_ -match 'update-service.+--service worker.+--task-definition.+worker:10'
        }).Count -eq 2
    ) "Partial rollback must idempotently converge both prior revisions: $($partialCase.Name)."
    $assertions++
}
Remove-Item Function:\Invoke-AwsJson -ErrorAction SilentlyContinue
Remove-Item Function:\Get-EcsState -ErrorAction SilentlyContinue
Remove-Item Function:\Start-Sleep -ErrorAction SilentlyContinue

# Exercise the actual monitor classifier/rollback functions across a real
# controller process death. This closes the gap where a committed harness
# failure could be discarded merely because the controller vanished before
# the monitor's next poll.
$hostDefinitions = @(
    "Get-OptionalValue",
    "Get-BoundControllerProcess",
    "Get-StringSha256",
    "Test-EngineeringApplicationRollbackRequired",
    "Invoke-EngineeringApplicationRollback"
) | ForEach-Object {
    $functionName = $_
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    $definition.Extent.Text
}
$hostScriptText = @'
#requires -Version 7.5
param(
    [string]$Mode,
    [int]$ControllerProcessId,
    [string]$ControllerStartedAtUtc,
    [string]$ControllerPath,
    [string]$ReadyPath,
    [string]$ResultPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
'@ + [Environment]::NewLine +
    ($hostDefinitions -join ([Environment]::NewLine + [Environment]::NewLine)) +
    [Environment]::NewLine + @'

$activeApi = "arn:aws:ecs:us-east-1:135775632425:task-definition/api:20"
$activeWorker = "arn:aws:ecs:us-east-1:135775632425:task-definition/worker:20"
$priorApi = "arn:aws:ecs:us-east-1:135775632425:task-definition/api:19"
$priorWorker = "arn:aws:ecs:us-east-1:135775632425:task-definition/worker:19"
$script:AwsCalls = [Collections.Generic.List[string]]::new()
function Invoke-AwsJson {
    param([string[]]$Arguments)
    $script:AwsCalls.Add(($Arguments -join " "))
    return [pscustomobject]@{}
}
function Get-EcsState {
    param($Config)
    return @{
        api=[pscustomobject]@{
            desired=1;running=1;pending=0;taskDefinition=$priorApi
        }
        worker=[pscustomobject]@{
            desired=1;running=1;pending=0;taskDefinition=$priorWorker
        }
    }
}
$config = [pscustomobject]@{
    EngineeringAcceptance=$true
    ControllerProcessId=$ControllerProcessId
    ControllerProcessStartedAtUtc=[DateTimeOffset]::Parse($ControllerStartedAtUtc)
    ControllerProcessPath=$ControllerPath
    EngineeringScalingRestoration=[pscustomobject]@{
        RollbackApiTaskDefinitionArn=$priorApi
        RollbackWorkerTaskDefinitionArn=$priorWorker
    }
    Resources=[pscustomobject]@{
        region="us-east-1";cluster="cluster";apiService="api";workerService="worker"
    }
}
$summaryFailures = if ($Mode -ceq "hard-application") {
    @("server command target statuses regressed")
} else {
    @()
}
$sample = [ordered]@{
    immediateFailures=@()
    consecutiveFailures=@()
    load=[ordered]@{
        summary=[ordered]@{
            fatalGate=[ordered]@{reasonCodes=@()}
            thresholds=[ordered]@{failures=$summaryFailures}
        }
    }
}
[IO.File]::WriteAllText($ReadyPath, "latched", [Text.UTF8Encoding]::new($false))
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
while ($null -ne (Get-BoundControllerProcess -Config $config) -and
    [DateTimeOffset]::UtcNow -lt $deadline) {
    [Threading.Thread]::Sleep(25)
}
if ($null -ne (Get-BoundControllerProcess -Config $config)) {
    throw "The controller did not terminate during the host regression."
}
$rollbackRequired = Test-EngineeringApplicationRollbackRequired `
    -Failures @() -Sample $sample
$rollback = $null
if ($rollbackRequired) {
    $rollback = Invoke-EngineeringApplicationRollback -Config $config
}
$result = [ordered]@{
    mode=$Mode
    controllerLost=$true
    rollbackRequired=[bool]$rollbackRequired
    rollback=$rollback
    awsCalls=@($script:AwsCalls)
    finalApiTaskDefinition=if ($rollbackRequired) {$priorApi} else {$activeApi}
    finalWorkerTaskDefinition=if ($rollbackRequired) {$priorWorker} else {$activeWorker}
    scalingRestored=$true
}
[IO.File]::WriteAllText(
    $ResultPath,
    ($result | ConvertTo-Json -Depth 20),
    [Text.UTF8Encoding]::new($false)
)
'@
$hostTempRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "schoolpilot-monitor-controller-loss-{0}" -f [Guid]::NewGuid().ToString("N")
)
New-Item -ItemType Directory -Path $hostTempRoot | Out-Null
$hostScriptPath = Join-Path $hostTempRoot "monitor-host.ps1"
[IO.File]::WriteAllText(
    $hostScriptPath, $hostScriptText, [Text.UTF8Encoding]::new($false)
)
$pwshPath = (Get-Command pwsh).Source
function Start-ControllerLossTestProcess {
    param([string[]]$Arguments)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $pwshPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
    return [Diagnostics.Process]::Start($startInfo)
}
try {
    foreach ($mode in @("hard-application", "controller-loss-only")) {
        $controller = Start-ControllerLossTestProcess @(
            "-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 30"
        )
        try {
            $controllerStartedAt = ([DateTimeOffset]$controller.StartTime).ToUniversalTime()
            $readyPath = Join-Path $hostTempRoot "$mode.ready"
            $resultPath = Join-Path $hostTempRoot "$mode.result.json"
            $monitorProcess = Start-ControllerLossTestProcess @(
                "-NoLogo", "-NoProfile", "-File", $hostScriptPath,
                "-Mode", $mode,
                "-ControllerProcessId", [string]$controller.Id,
                "-ControllerStartedAtUtc", $controllerStartedAt.ToString("o"),
                "-ControllerPath", $pwshPath,
                "-ReadyPath", $readyPath,
                "-ResultPath", $resultPath
            )
            try {
                $readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
                while (-not (Test-Path -LiteralPath $readyPath) -and
                    [DateTimeOffset]::UtcNow -lt $readyDeadline -and
                    -not $monitorProcess.HasExited) {
                    [Threading.Thread]::Sleep(25)
                }
                $startupError = if ($monitorProcess.HasExited) {
                    $monitorProcess.StandardError.ReadToEnd()
                } else { "" }
                Assert-Condition (Test-Path -LiteralPath $readyPath) `
                    "The monitor host did not latch '$mode' before controller loss: $startupError"
                $controller.Kill($true)
                [void]$controller.WaitForExit(5000)
                Assert-Condition ($monitorProcess.WaitForExit(15000) -and
                    $monitorProcess.ExitCode -eq 0 -and
                    (Test-Path -LiteralPath $resultPath)) `
                    "The monitor host did not seal '$mode' after real controller loss."
                $hostResult = Get-Content -LiteralPath $resultPath -Raw |
                    ConvertFrom-Json -DateKind String -Depth 20
                if ($mode -ceq "hard-application") {
                    Assert-Condition (
                        $hostResult.rollbackRequired -eq $true -and
                        $hostResult.rollback.completed -eq $true -and
                        $hostResult.finalApiTaskDefinition -match 'api:19$' -and
                        $hostResult.finalWorkerTaskDefinition -match 'worker:19$' -and
                        $hostResult.scalingRestored -eq $true -and
                        @($hostResult.awsCalls | Where-Object {
                            $_ -match 'update-service.+api.+api:19'
                        }).Count -eq 1 -and
                        @($hostResult.awsCalls | Where-Object {
                            $_ -match 'update-service.+worker.+worker:19'
                        }).Count -eq 1
                    ) "A latched hard application failure must restore prior tasks and scaling after controller loss."
                }
                else {
                    Assert-Condition (
                        $hostResult.rollbackRequired -eq $false -and
                        $null -eq $hostResult.rollback -and
                        $hostResult.finalApiTaskDefinition -match 'api:20$' -and
                        $hostResult.finalWorkerTaskDefinition -match 'worker:20$' -and
                        $hostResult.scalingRestored -eq $true -and
                        @($hostResult.awsCalls).Count -eq 0
                    ) "Controller loss alone must restore scaling without rolling application revisions back."
                }
                $assertions++
            }
            finally {
                if (-not $monitorProcess.HasExited) { $monitorProcess.Kill($true) }
                $monitorProcess.Dispose()
            }
        }
        finally {
            if (-not $controller.HasExited) { $controller.Kill($true) }
            $controller.Dispose()
        }
    }
}
finally {
    Remove-Item Function:\Start-ControllerLossTestProcess -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $hostTempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Reset-AcceptanceState
$xlargeConfig = $baseConfig.PSObject.Copy()
$xlargeConfig.ExpectedRdsInstanceClass = "db.t4g.xlarge"
$xlarge = Get-AcceptanceResult -Config $xlargeConfig
foreach ($expected in @(
    "rds_read_latency_ms_p95","rds_read_latency_ms_peak","rds_write_latency_ms_p95","rds_write_latency_ms_peak",
    "rds_disk_queue_depth_p95","rds_total_iops_p95","rds_total_iops_peak"
)) {
    Assert-Condition ($xlarge.violations -contains $expected) "The resized track must enforce capacity threshold '$expected'."
    $assertions++
}

Reset-AcceptanceState
$creditPoints = [ordered]@{}
foreach ($entry in @(
    @("2026-07-18T02:00:00Z",30.0),@("2026-07-18T03:00:00Z",30.0),@("2026-07-18T04:00:00Z",30.0),
    @("2026-07-18T05:00:00Z",20.0),@("2026-07-18T06:00:00Z",20.0),@("2026-07-18T07:00:00Z",20.0),
    @("2026-07-18T08:00:00Z",30.0)
)) { $creditPoints[[DateTimeOffset]::Parse($entry[0]).ToString("o")] = [double]$entry[1] }
$script:AcceptanceSeries["rds_cpu_credit"].points = $creditPoints
$enduranceMedium = $baseConfig.PSObject.Copy()
$enduranceMedium.Workload = [pscustomobject]@{Stage="endurance"}
$enduranceMedium.TelemetryExpectedSeconds = 28800
$mediumSlope = Get-RdsCreditSlopeResult -Config $enduranceMedium
Assert-Condition (-not $mediumSlope.required -and $mediumSlope.passed) "The hours-2-8 credit slope must not become a baseline medium gate."
$assertions++
$enduranceXlarge = $enduranceMedium.PSObject.Copy()
$enduranceXlarge.ExpectedRdsInstanceClass = "db.t4g.xlarge"
$xlargeSlope = Get-RdsCreditSlopeResult -Config $enduranceXlarge
Assert-Condition ($xlargeSlope.required -and -not $xlargeSlope.passed -and $xlargeSlope.delta -eq 0 -and $xlargeSlope.slopePerHour -lt 0) `
    "The resized endurance track must use regression and reject a negative hours-2-8 slope even when endpoints match."
$assertions++

$shortCreditPoints = [ordered]@{}
foreach ($entry in @(
    @("2026-07-18T02:00:00Z",30.0),@("2026-07-18T04:45:00Z",30.0),@("2026-07-18T07:30:00Z",30.0)
)) { $shortCreditPoints[[DateTimeOffset]::Parse($entry[0]).ToString("o")] = [double]$entry[1] }
$script:AcceptanceSeries["rds_cpu_credit"].points = $shortCreditPoints
$shortSlope = Get-RdsCreditSlopeResult -Config $enduranceXlarge
Assert-Condition ($shortSlope.required -and -not $shortSlope.passed -and $shortSlope.spanSeconds -eq 19800) `
    "A nonnegative 5.5-hour series must not stand in for the full hours-2-8 credit observation."
$assertions++

$fullCreditPoints = [ordered]@{}
foreach ($entry in @(
    @("2026-07-18T02:05:00Z",30.0),@("2026-07-18T05:00:00Z",30.0),@("2026-07-18T07:55:00Z",30.0)
)) { $fullCreditPoints[[DateTimeOffset]::Parse($entry[0]).ToString("o")] = [double]$entry[1] }
$script:AcceptanceSeries["rds_cpu_credit"].points = $fullCreditPoints
$fullSlope = Get-RdsCreditSlopeResult -Config $enduranceXlarge
Assert-Condition ($fullSlope.required -and $fullSlope.passed -and $fullSlope.spanSeconds -eq 21000) `
    "A nonnegative 5h50m boundary-aligned series must satisfy the full hours-2-8 credit observation."
$assertions++

# Full CloudWatch batches, including delayed points, must be filtered to the
# exact traffic interval for every acceptance series rather than sampling only
# the latest point returned by each poll.
$trafficStart = [DateTimeOffset]::Parse("2026-07-18T10:00:00Z")
$script:StartedAt = $trafficStart.AddMinutes(-10)
$script:TrafficStartedAtUtc = $trafficStart
$script:TrafficStoppedAtUtc = $trafficStart.AddMinutes(30)
$script:AcceptanceSeries = @{}
$script:AcceptanceSourceStatuses = @{}
$script:AcceptanceSourceCoverage = @{}
$script:AcceptanceSparseCoverageRequired =
    [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$script:NatSamples = [System.Collections.Generic.List[object]]::new()
$windowConfig = $baseConfig.PSObject.Copy()
$windowConfig.EngineeringAcceptance = $true
$windowConfig | Add-Member -NotePropertyName LoadProgressPath -NotePropertyValue "bound-progress.jsonl"
$windowConfig.TelemetryExpectedSeconds = 1800
$windowConfig.TelemetryMetricNames = @(
    "rds_cpu","ecs_api_cpu","redis_cpu","rds_cpu_credit"
)
$windowConfig.Workload = [pscustomobject]@{Stage="500";DurationSeconds=1800}

function New-BatchPoints {
    param([int]$Count, [double]$Value, [int]$PeriodMinutes = 1)
    return @(
        for ($index = 0; $index -lt $Count; $index++) {
            [pscustomobject]@{
                Timestamp = $trafficStart.AddMinutes($index * $PeriodMinutes)
                Value = $Value
            }
        }
    )
}
$firstBatch = [pscustomobject]@{
    CollectedThroughUtc = $trafficStart.AddMinutes(31)
    Status = @{
        rds_cpu="Complete";ecs_api_cpu="Complete";redis_cpu="Complete";rds_cpu_credit="Complete"
    }
    Series = @{
        rds_cpu = @(
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(-1);Value=99.0}
        ) + @(New-BatchPoints 29 40.0) + @(
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(30);Value=99.0}
        )
        ecs_api_cpu = @(
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(-1);Value=99.0}
        ) + @(New-BatchPoints 30 20.0) + @(
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(30);Value=99.0}
        )
        redis_cpu = @(New-BatchPoints 30 15.0)
        rds_cpu_credit = @(New-BatchPoints 6 30.0 5)
    }
}
foreach ($metric in $windowConfig.TelemetryMetricNames) {
    Add-AcceptanceSeriesDatapoints -Name $metric -MetricBatch $firstBatch -Config $windowConfig
}
Assert-Condition (-not (Test-AcceptanceTelemetryCoverageReady -Config $windowConfig)) `
    "A delayed final RDS CPU minute must keep engineering telemetry pending."
$assertions++
Assert-Condition ((Get-SeriesSummary "ecs_api_cpu").maximum -eq 20.0 -and
    (Get-SeriesSummary "ecs_api_cpu").count -eq 30) `
    "Pretraffic and post-traffic ECS points must be excluded from acceptance."
$assertions++

$delayedBatch = [pscustomobject]@{
    CollectedThroughUtc = $trafficStart.AddMinutes(33)
    Status = @{
        rds_cpu="Complete";ecs_api_cpu="Complete";redis_cpu="Complete";rds_cpu_credit="Complete"
    }
    Series = @{
        rds_cpu = @(New-BatchPoints 30 40.0)
        ecs_api_cpu = @(New-BatchPoints 30 20.0)
        redis_cpu = @(New-BatchPoints 30 15.0)
        rds_cpu_credit = @(New-BatchPoints 6 30.0 5)
    }
}
foreach ($metric in $windowConfig.TelemetryMetricNames) {
    Add-AcceptanceSeriesDatapoints -Name $metric -MetricBatch $delayedBatch -Config $windowConfig
}
Assert-Condition ((Test-AcceptanceTelemetryCoverageReady -Config $windowConfig) -and
    (Get-EngineeringRdsCpuCoverageResult -Config $windowConfig).observedPointCount -eq 30) `
    "A delayed complete 30-minute batch must satisfy exact engineering coverage."
$assertions++

$script:AcceptanceSeries = @{}
$script:AcceptanceSourceStatuses = @{}
$script:AcceptanceSourceCoverage = @{}
$script:AcceptanceSparseCoverageRequired =
    [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$script:TrafficStoppedAtUtc = $trafficStart.AddMinutes(90)
$window800Config = $windowConfig.PSObject.Copy()
$window800Config.TelemetryExpectedSeconds = 5400
$window800Config.TelemetryMetricNames = @("rds_cpu")
$window800Config.Workload = [pscustomobject]@{Stage="800";DurationSeconds=5400}
$batch800 = [pscustomobject]@{
    CollectedThroughUtc = $trafficStart.AddMinutes(93)
    Status = @{rds_cpu="Complete"}
    Series = @{rds_cpu=@(New-BatchPoints 90 40.0)}
}
Add-AcceptanceSeriesDatapoints -Name "rds_cpu" -MetricBatch $batch800 -Config $window800Config
Assert-Condition ((Test-AcceptanceTelemetryCoverageReady -Config $window800Config) -and
    (Get-EngineeringRdsCpuCoverageResult -Config $window800Config).observedPointCount -eq 90) `
    "A delayed complete 90-minute batch must satisfy exact engineering coverage."
$assertions++

$script:TrafficStoppedAtUtc = $trafficStart.AddMinutes(30)
$pretrafficOnly = [pscustomobject]@{
    CollectedThroughUtc=$trafficStart.AddMinutes(2)
    Status=@{waf_device_blocked="Complete"}
    Series=@{
        waf_device_blocked=@(
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(-1);Value=1.0},
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(1);Value=0.0}
        )
    }
}
Assert-Condition (-not (Test-AcceptanceWindowSeriesBreach -MetricBatch $pretrafficOnly `
    -Config $windowConfig -SourceName "waf_device_blocked" `
    -IsBreached {param($value) $value -gt 0})) `
    "A pretraffic WAF datapoint must not reject the engineering workload."
$assertions++
$delayedBreach = [pscustomobject]@{
    CollectedThroughUtc=$trafficStart.AddMinutes(3)
    Status=@{waf_device_blocked="Complete";nat_0_drops="Complete"}
    Series=@{
        waf_device_blocked=@(
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(1);Value=1.0},
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(2);Value=0.0}
        )
        nat_0_drops=@(
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(1);Value=1.0},
            [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(2);Value=0.0}
        )
    }
}
Assert-Condition ((Test-AcceptanceWindowSeriesBreach -MetricBatch $delayedBreach `
    -Config $windowConfig -SourceName "waf_device_blocked" `
    -IsBreached {param($value) $value -gt 0}) -and
    (Test-AcceptanceWindowSeriesBreach -MetricBatch $delayedBreach `
    -Config $windowConfig -SourceName "nat_0_drops" `
    -IsBreached {param($value) $value -gt 0})) `
    "A delayed in-window WAF/NAT breach must reject even when the newest point is zero."
$assertions++
$script:AcceptanceSourceStatuses = @{}
$script:AcceptanceSourceCoverage = @{}
$script:AcceptanceSparseCoverageRequired =
    [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$agedPartial = [pscustomobject]@{
    CollectedThroughUtc=$trafficStart.AddMinutes(15)
    QueryStartUtc=$trafficStart
    QueryEndUtc=$trafficStart.AddMinutes(15)
    Status=@{waf_device_blocked="PartialData"}
    Series=@{waf_device_blocked=@()}
}
$laterCompleteEmpty = [pscustomobject]@{
    CollectedThroughUtc=$trafficStart.AddMinutes(31)
    QueryStartUtc=$trafficStart.AddMinutes(15)
    QueryEndUtc=$trafficStart.AddMinutes(30)
    Status=@{waf_device_blocked="Complete"}
    Series=@{waf_device_blocked=@()}
}
[void](Test-AcceptanceWindowSeriesBreach -MetricBatch $agedPartial -Config $windowConfig `
    -SourceName "waf_device_blocked" -IsBreached {param($value) $value -gt 0})
[void](Test-AcceptanceWindowSeriesBreach -MetricBatch $laterCompleteEmpty -Config $windowConfig `
    -SourceName "waf_device_blocked" -IsBreached {param($value) $value -gt 0})
Assert-Condition (-not (Test-SparseAcceptanceCoverageReady -Config $windowConfig)) `
    "A PartialData interval must remain unavailable after it ages out of a later Complete-empty query."
$assertions++
$partialWaf = [pscustomobject]@{
    CollectedThroughUtc=$trafficStart.AddMinutes(3)
    Status=@{waf_device_blocked="PartialData"}
    Series=@{waf_device_blocked=@(
        [pscustomobject]@{Timestamp=$trafficStart.AddMinutes(2);Value=0.0}
    )}
}
[void](Test-AcceptanceWindowSeriesBreach -MetricBatch $partialWaf -Config $windowConfig `
    -SourceName "waf_device_blocked" -IsBreached {param($value) $value -gt 0})
Assert-Condition ($script:AcceptanceSourceStatuses["waf_device_blocked"] -ceq "PartialData" -and
    -not (Test-AcceptanceTelemetryCoverageReady -Config $windowConfig)) `
    "Partial WAF evidence must remain incomplete rather than being interpreted as zero."
$assertions++

"AWS rollout RDS capacity-gate tests: PASS ($assertions assertions)"
