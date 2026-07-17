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
    "Get-SeriesSummary","Add-AcceptanceViolation","Assert-TelemetryCoverage",
    "Get-RdsCreditSlopeResult","Get-AcceptanceResult"
)) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing monitor function $name." }
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
    Thresholds=$thresholds;TelemetryExpectedSeconds=0;TelemetryMetricNames=@();Workload=[pscustomobject]@{Stage="800"}
    ExpectedRdsInstanceClass="db.t4g.medium"
}

$assertions = 0
Reset-AcceptanceState
$medium = Get-AcceptanceResult -Config $baseConfig
Assert-Condition ($medium.passed -and @($medium.violations | Where-Object { $_ -match 'latency|queue|iops' }).Count -eq 0) `
    "High capacity-only latency, queue, and IOPS observations must remain evidence-only on db.t4g.medium."
$assertions++

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

"AWS rollout RDS capacity-gate tests: PASS ($assertions assertions)"
