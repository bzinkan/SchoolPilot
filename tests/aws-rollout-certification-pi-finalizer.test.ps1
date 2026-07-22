#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Get-TestSha256 {
    param([string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.UTF8Encoding]::new($false).GetBytes($Text)
    )).ToLowerInvariant()
}

function Set-TestPrivateAcl {
    param([string]$Path)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $discarded = & icacls.exe $Path /inheritance:r /grant:r "$identity`:(F)" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not apply the test private ACL." }
}

$modulePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\history-fallback-pi-finalizer.psm1"))
$wrapperPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\finalize-history-fallback-pi-evidence.ps1"))
$diagnosticCollectorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\start-waf800-batch-diagnostic.ps1"))
Import-Module $modulePath -Force

$statement = "WITH requested_tiles AS MATERIALIZED (SELECT 1) SELECT * FROM requested_tiles CROSS JOIN LATERAL (SELECT * FROM heartbeats LIMIT 10) h"
$queryIdentifier = "-9223372036854775808"
$parameterTypeSignatureJson = '["$1:text[]:student_ids","$2:text[]:device_ids","$3:text:school_id","$4:bigint:history_limit"]'
$identity = [pscustomobject]@{
    QueryIdentifier=$queryIdentifier;QueryIdentifierSha256=Get-TestSha256 $queryIdentifier
    CompiledSqlSha256="a"*64;ParameterTypeSignatureSha256=Get-TestSha256 $parameterTypeSignatureJson
    SchemaIdentitySha256="b"*64;IdentityVersion="history-fallback-queryid-v1"
}
$start = [DateTimeOffset]::Parse("2026-07-22T01:15:00.000Z")
$config = [pscustomobject]@{
    Identity=$identity;TrafficStart=$start;TrafficEnd=$start.AddMinutes(90)
    EvidenceStart=$start;EvidenceEnd=$start.AddMinutes(90)
    ApplicationDatabaseReadCount=120L;ReleaseIdentitySha256="c"*64
    ApplicationFallbackWindows=@([pscustomobject]@{
        startUtc=$start.AddMinutes(1).ToString("o");endUtc=$start.AddMinutes(2).ToString("o")
        durationMilliseconds=60000;fallbackItems=480;databaseReadCount=120
    })
    DatabaseResourceId="db-JX7VX4P2ZHF5JXA6N5EREVL54I"
    ApiTaskDefinitionSha256="f"*64
    LogDriver="awslogs";LogRegion="us-east-1";LogGroupName="/ecs/schoolpilot-production-api"
    ApiLogStreamNamePrefix="ecs/api/"
}

function New-TestMetricList {
    param([double]$BlockReadTime = 49.999, [double]$TempRead = 0.0,
        [double]$TempWritten = 0.0, [string]$DbId = $queryIdentifier,
        [string]$TokenId = "support-token-1", [string]$Sql = $statement,
        [double]$Calls = 2.0)
    $values = [ordered]@{
        "db.sql_tokenized.stats.calls_per_sec.avg"=$Calls
        "db.sql_tokenized.stats.total_time_per_sec.avg"=100.0
        "db.sql_tokenized.stats.blk_read_time_per_sec.avg"=$BlockReadTime
        "db.sql_tokenized.stats.shared_blks_read_per_sec.avg"=3.0
        "db.sql_tokenized.stats.temp_blks_read_per_sec.avg"=$TempRead
        "db.sql_tokenized.stats.temp_blks_written_per_sec.avg"=$TempWritten
    }
    return @($values.GetEnumerator() | ForEach-Object {
        [pscustomobject]@{
            Key=[pscustomobject]@{Metric=[string]$_.Key;Dimensions=[pscustomobject]@{
                "db.sql_tokenized.db_id"=$DbId;"db.sql_tokenized.id"=$TokenId
                "db.sql_tokenized.statement"=$Sql
            }}
            DataPoints=@([pscustomobject]@{Timestamp=$start.AddMinutes(1).ToString("o");Value=[double]$_.Value})
        }
    })
}

$assertions = 0

$acceptedStats = Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList (New-TestMetricList)
Assert-Condition ($acceptedStats.Evidence.passed -eq $true -and
    $acceptedStats.Evidence.integratedCalls -eq 120.0 -and
    $acceptedStats.Evidence.blockReadTimeSharePercent -eq 49.999 -and
    $acceptedStats.Evidence.temporaryIoAbsent -eq $true -and
    $acceptedStats.Evidence.bucketCoverage.coverageContractVersion -ceq "queryid-minute-sparse-v1" -and
    $acceptedStats.Evidence.bucketCoverage.expectedBucketCount -eq 90 -and
    $acceptedStats.Evidence.bucketCoverage.observedBucketCount -eq 1 -and
    $acceptedStats.Evidence.bucketCoverage.omittedSparseBucketCount -eq 89 -and
    $acceptedStats.Evidence.bucketCoverage.positiveCallCoveragePassed -eq $true -and
    @($acceptedStats.Evidence.bucketCoverage.observedBucketOrdinals) -join ',' -ceq '1' -and
    @($acceptedStats.Evidence.bucketCoverage.applicationActiveBucketOrdinals) -join ',' -ceq '1') `
    "Call-based SQL statistics must accept exact sparse-minute coverage with a raw 49.999% block-read ratio."
$assertions++

$zeroActiveBucket = Resolve-HistoryFallbackPiSqlStatistics -Config $config `
    -MetricList (New-TestMetricList -Calls 0.0)
Assert-Condition ($zeroActiveBucket.Evidence.passed -eq $false -and
    $zeroActiveBucket.Evidence.bucketCoverage.zeroCallApplicationActiveBucketCount -eq 1 -and
    $zeroActiveBucket.Evidence.bucketCoverage.positiveCallCoveragePassed -eq $false -and
    "application_active_bucket_without_positive_calls" -in @($zeroActiveBucket.Evidence.failureReasons)) `
    "An observed application-active minute with zero PI calls must be a deterministic collected rejection."
$assertions++

$missingActiveBucketMetrics = New-TestMetricList
foreach ($series in $missingActiveBucketMetrics) {
    $series.DataPoints[0].Timestamp = $start.AddMinutes(2).ToString("o")
}
$missingActiveBucketRejected = $false
try { Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList $missingActiveBucketMetrics | Out-Null }
catch { $missingActiveBucketRejected = $_.Exception.Message -match "application-active sparse" }
Assert-Condition $missingActiveBucketRejected `
    "A missing PI bucket overlapping a fallback-positive application interval must fail closed."
$assertions++

$missingMiddleMetrics = New-TestMetricList
foreach ($series in $missingMiddleMetrics) {
    $firstPoint = $series.DataPoints[0]
    $series.DataPoints = @(
        $firstPoint,
        [pscustomobject]@{Timestamp=$start.AddMinutes(3).ToString("o");Value=$firstPoint.Value}
    )
}
$missingMiddleRejected = $false
try { Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList $missingMiddleMetrics | Out-Null }
catch { $missingMiddleRejected = $_.Exception.Message -match "missing-middle" }
Assert-Condition $missingMiddleRejected `
    "A missing interior minute between observed SQL-statistics buckets must fail closed."
$assertions++

$groupedWithAwsTotals = @()
foreach ($metricResult in (New-TestMetricList)) {
    $groupedWithAwsTotals += [pscustomobject]@{
        Key=[pscustomobject]@{Metric=$metricResult.Key.Metric}
        DataPoints=$metricResult.DataPoints
    }
    $groupedWithAwsTotals += $metricResult
}
$acceptedWithAwsTotals = Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList $groupedWithAwsTotals
Assert-Condition ($acceptedWithAwsTotals.Evidence.passed -eq $true -and
    $acceptedWithAwsTotals.Evidence.integratedCalls -eq 120.0 -and
    $acceptedWithAwsTotals.Evidence.ignoredUngroupedTotalSeriesCount -eq 6) `
    "AWS dimensionless total series must be ignored rather than mistaken for an identity mismatch or integrated twice."
$assertions++

$repeatedAwsTotals = @($groupedWithAwsTotals) + @([pscustomobject]@{
    Key=[pscustomobject]@{Metric="db.sql_tokenized.stats.calls_per_sec.avg"}
    DataPoints=@([pscustomobject]@{Timestamp=$start.AddMinutes(1).ToString("o");Value=2.0})
})
$repeatedAwsTotalAccepted = Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList $repeatedAwsTotals
Assert-Condition ($repeatedAwsTotalAccepted.Evidence.passed -eq $true -and
    $repeatedAwsTotalAccepted.Evidence.repeatedUngroupedTotalSeriesCount -eq 1) `
    "Identical AWS dimensionless totals repeated across pages must be deduplicated without entering gate totals."
$assertions++

$conflictingAwsTotals = @($groupedWithAwsTotals) + @([pscustomobject]@{
    Key=[pscustomobject]@{Metric="db.sql_tokenized.stats.calls_per_sec.avg"}
    DataPoints=@([pscustomobject]@{Timestamp=$start.AddMinutes(1).ToString("o");Value=999.0})
})
$conflictingAwsTotalRejected = $false
try { Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList $conflictingAwsTotals | Out-Null }
catch { $conflictingAwsTotalRejected = $_.Exception.Message -match "conflicting duplicate ungrouped total" }
Assert-Condition $conflictingAwsTotalRejected `
    "Conflicting AWS dimensionless total series must fail closed."
$assertions++

$exactThreshold = Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList (New-TestMetricList -BlockReadTime 50.0)
Assert-Condition ($exactThreshold.Evidence.passed -eq $false -and
    "block_read_time_dominant" -in @($exactThreshold.Evidence.failureReasons)) `
    "An exact 50.000% call-time block-read ratio must fail closed."
$assertions++

$temporaryIo = Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList `
    (New-TestMetricList -TempRead 0.001)
Assert-Condition ($temporaryIo.Evidence.passed -eq $false -and
    "temporary_io_observed" -in @($temporaryIo.Evidence.failureReasons)) `
    "Any temporary-block I/O must fail the deterministic SQL-statistics gate."
$assertions++

$undercount = Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList (New-TestMetricList -Calls 1.999)
Assert-Condition ($undercount.Evidence.passed -eq $false -and
    "pi_call_undercount" -in @($undercount.Evidence.failureReasons)) `
    "Integrated PI calls below the application database-read count must fail."
$assertions++

$endBoundaryMetricList = New-TestMetricList
foreach ($metricResult in $endBoundaryMetricList) {
    $metricResult.DataPoints[0].Timestamp = $config.EvidenceEnd.ToString("o")
}
$endBoundaryRejected = $false
try {
    Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList $endBoundaryMetricList | Out-Null
}
catch { $endBoundaryRejected = $_.Exception.Message -match "out-of-window metric timestamp" }
Assert-Condition $endBoundaryRejected `
    "PI datapoints stamped at the exclusive EvidenceEnd boundary must not enter integrated totals."
$assertions++

$ambiguousList = @((New-TestMetricList)) + @((New-TestMetricList -TokenId "support-token-2"))
$ambiguous = Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList $ambiguousList
Assert-Condition ($ambiguous.Evidence.passed -eq $false -and
    $ambiguous.Evidence.identityCount -eq 2 -and
    "ambiguous_query_identity" -in @($ambiguous.Evidence.failureReasons)) `
    "More than one tokenized identity must become a collected gate failure."
$assertions++

$wrongNative = Resolve-HistoryFallbackPiSqlStatistics -Config $config -MetricList `
    (New-TestMetricList -DbId "9223372036854775807")
Assert-Condition ($wrongNative.Evidence.passed -eq $false -and
    "native_query_identifier_mismatch" -in @($wrongNative.Evidence.failureReasons)) `
    "The returned native database query identifier must exactly match the protected receipt."
$assertions++

$zeroSampled = Resolve-HistoryFallbackPiSampledLoad -Config $config -SqlStatistics $acceptedStats
Assert-Condition ($zeroSampled.status -ceq "not_applicable_zero_sampled_load" -and
    $zeroSampled.passed -eq $true -and $null -eq $zeroSampled.dataFileReadSharePercent) `
    "A fast query with positive call evidence and zero sampled AAS must not fabricate a wait ratio."
$assertions++

$sampledKey = [pscustomobject]@{Total=1.0;Dimensions=[pscustomobject]@{
    "db.sql_tokenized.db_id"=$queryIdentifier;"db.sql_tokenized.id"=$acceptedStats.TokenId
    "db.sql_tokenized.statement"=$statement
}}
$acceptedWaits = @(
    [pscustomobject]@{Total=0.49999;Dimensions=[pscustomobject]@{
        "db.wait_event.type"="IO";"db.wait_event.name"="DataFileRead"}},
    [pscustomobject]@{Total=0.50001;Dimensions=[pscustomobject]@{
        "db.wait_event.type"="CPU";"db.wait_event.name"="CPU"}}
)
$acceptedSampled = Resolve-HistoryFallbackPiSampledLoad -Config $config -SqlStatistics $acceptedStats `
    -SampledKeys @($sampledKey) -WaitKeys $acceptedWaits -SampledPageCount 1 -WaitPageCount 1
Assert-Condition ($acceptedSampled.passed -eq $true -and
    $acceptedSampled.dataFileReadSharePercent -eq 49.999) `
    "Positive sampled AAS must require complete filtered waits and accept 49.999% DataFileRead."
$assertions++

$thresholdWaits = @(
    [pscustomobject]@{Total=0.5;Dimensions=[pscustomobject]@{
        "db.wait_event.type"="IO";"db.wait_event.name"="DataFileRead"}},
    [pscustomobject]@{Total=0.5;Dimensions=[pscustomobject]@{
        "db.wait_event.type"="CPU";"db.wait_event.name"="CPU"}}
)
$rejectedSampled = Resolve-HistoryFallbackPiSampledLoad -Config $config -SqlStatistics $acceptedStats `
    -SampledKeys @($sampledKey) -WaitKeys $thresholdWaits
Assert-Condition ($rejectedSampled.passed -eq $false -and
    "sampled_data_file_read_dominant" -in @($rejectedSampled.failureReasons)) `
    "An exact 50.000% sampled-wait DataFileRead ratio must fail."
$assertions++

$serializedEvidence = $acceptedStats.Evidence | ConvertTo-Json -Depth 30 -Compress
Assert-Condition (-not $serializedEvidence.Contains($queryIdentifier) -and
    -not $serializedEvidence.Contains($acceptedStats.TokenId) -and
    -not $serializedEvidence.Contains($statement)) `
    "Sanitized SQL-statistics evidence must not expose raw PI, query, or statement identifiers."
$assertions++

$hotPathPayload = [ordered]@{
    event="classpilot_heartbeat_hot_path_summary";intervalSeconds=60
    intervalStartedAtUtc=$start.ToString("o");intervalEndedAtUtc=$start.AddMinutes(1).ToString("o")
    historyFallbackSqlIdentityVersion="history-fallback-queryid-v1"
    historyFallbackSqlIdentitySha256="a"*64
    apiRuntimeTaskDefinitionSha256="f"*64
    counters=[ordered]@{tileBatchHistoryFallbackItems=480}
    timings=[ordered]@{tileBatchHistoryDatabaseMs=[ordered]@{count=120;totalMs=300.0;maxMs=3.0}}
}
$hotPathEvent = [pscustomobject]@{
    eventId="event-1";timestamp=$start.AddMinutes(1).ToUnixTimeMilliseconds()
    logStreamName="ecs/api/task-1";message=($hotPathPayload | ConvertTo-Json -Depth 20 -Compress)
}
$hotPath = Resolve-HistoryFallbackHotPathLogEvidence -Config $config -Events @($hotPathEvent) -PageCount 1
Assert-Condition ($hotPath.HasPositive -eq $true -and $hotPath.DatabaseReadCount -eq 120 -and
    $hotPath.Evidence.passed -eq $true -and
    @($hotPath.Evidence.fallbackPositiveIntervals).Count -eq 1 -and
    $hotPath.Evidence.fallbackPositiveIntervals[0].durationMilliseconds -eq 60000 -and
    $hotPath.Evidence.fallbackPositiveIntervals[0].fallbackItems -eq 480 -and
    $hotPath.Evidence.fallbackPositiveIntervals[0].databaseReadCount -eq 120) `
    "The certification finalizer must independently derive the positive fallback database-read count and seal its exact 60-second interval."
$assertions++

foreach ($invalidMilliseconds in @(59999, 60001)) {
    $invalidDurationPayload = [ordered]@{} + $hotPathPayload
    $invalidDurationPayload.intervalEndedAtUtc = $start.AddMilliseconds($invalidMilliseconds).ToString("o")
    $invalidDurationRejected = $false
    try {
        Resolve-HistoryFallbackHotPathLogEvidence -Config $config -Events @([pscustomobject]@{
            eventId="event-duration-$invalidMilliseconds";timestamp=$hotPathEvent.timestamp
            logStreamName=$hotPathEvent.logStreamName
            message=($invalidDurationPayload | ConvertTo-Json -Depth 20 -Compress)
        }) | Out-Null
    }
    catch { $invalidDurationRejected = $_.Exception.Message -match "exact .*60-second interval" }
    Assert-Condition $invalidDurationRejected `
        "A claimed $invalidMilliseconds-millisecond hot-path interval must fail closed."
    $assertions++
}

$unalignedPayload = [ordered]@{} + $hotPathPayload
$unalignedPayload.intervalStartedAtUtc = $start.AddMinutes(1).AddMilliseconds(1).ToString("o")
$unalignedPayload.intervalEndedAtUtc = $start.AddMinutes(2).AddMilliseconds(1).ToString("o")
$unalignedRejected = $false
try {
    Resolve-HistoryFallbackHotPathLogEvidence -Config $config -Events @([pscustomobject]@{
        eventId="event-unaligned";timestamp=$hotPathEvent.timestamp
        logStreamName=$hotPathEvent.logStreamName
        message=($unalignedPayload | ConvertTo-Json -Depth 20 -Compress)
    }) | Out-Null
}
catch { $unalignedRejected = $_.Exception.Message -match "UTC-minute-aligned" }
Assert-Condition $unalignedRejected `
    "An exact 60-second interval with non-minute-aligned bounds must fail closed."
$assertions++

$wrongRuntimePayload = [ordered]@{} + $hotPathPayload
$wrongRuntimePayload.apiRuntimeTaskDefinitionSha256 = "0"*64
$wrongRuntimeRejected = $false
try {
    Resolve-HistoryFallbackHotPathLogEvidence -Config $config -Events @([pscustomobject]@{
        eventId="event-wrong-runtime";timestamp=$hotPathEvent.timestamp
        logStreamName=$hotPathEvent.logStreamName
        message=($wrongRuntimePayload | ConvertTo-Json -Depth 20 -Compress)
    }) | Out-Null
}
catch { $wrongRuntimeRejected = $_.Exception.Message -match "API runtime identities" }
Assert-Condition $wrongRuntimeRejected `
    "Every fallback-positive interval must bind the exact API runtime task-definition hash."
$assertions++

$untrustedCountConfig = $config.PSObject.Copy()
$untrustedCountConfig | Add-Member -NotePropertyName RequestedApplicationDatabaseReadCount -NotePropertyValue 1L -Force
$derivedHotPath = Resolve-HistoryFallbackHotPathLogEvidence -Config $untrustedCountConfig -Events @($hotPathEvent)
Assert-Condition ($derivedHotPath.DatabaseReadCount -eq 120 -and $derivedHotPath.Evidence.passed -eq $true -and
    -not $derivedHotPath.Evidence.Contains("requestedDatabaseReadCount")) `
    "A request-supplied fallback count must never become authoritative or enter sealed evidence."
$assertions++

$boundaryPayload = [ordered]@{} + $hotPathPayload
$boundaryPayload.intervalStartedAtUtc = $start.AddMinutes(-1).ToString("o")
$boundaryPayload.intervalEndedAtUtc = $start.ToString("o")
$boundaryEvent = [pscustomobject]@{eventId="event-boundary";timestamp=$hotPathEvent.timestamp
    logStreamName=$hotPathEvent.logStreamName;message=($boundaryPayload | ConvertTo-Json -Depth 20 -Compress)}
$boundaryHotPath = Resolve-HistoryFallbackHotPathLogEvidence -Config $config -Events @($boundaryEvent)
Assert-Condition ($boundaryHotPath.DatabaseReadCount -eq 0 -and
    $boundaryHotPath.Evidence.boundaryExcludedFallbackPositiveSummaryCount -eq 1) `
    "Only explicit hot-path intervals fully contained by the minute-aligned evidence subwindow may count."
$assertions++

$zeroPayload = [ordered]@{} + $hotPathPayload
$zeroPayload.counters = [ordered]@{tileBatchHistoryFallbackItems=0}
$zeroEvent = [pscustomobject]@{eventId="event-zero";timestamp=$hotPathEvent.timestamp
    logStreamName=$hotPathEvent.logStreamName;message=($zeroPayload | ConvertTo-Json -Depth 20 -Compress)}
$zeroHotPath = Resolve-HistoryFallbackHotPathLogEvidence -Config $config -Events @($zeroEvent)
Assert-Condition ($zeroHotPath.HasPositive -eq $false -and $zeroHotPath.DatabaseReadCount -eq 0 -and
    "missing_fallback_positive_log_evidence" -in @($zeroHotPath.Evidence.failureReasons)) `
    "A complete log snapshot with no fallback-positive interval must become a collected gate failure."
$assertions++

$malformedLogRejected = $false
try {
    Resolve-HistoryFallbackHotPathLogEvidence -Config $config -Events @([pscustomobject]@{
        eventId="broken";timestamp=$hotPathEvent.timestamp;logStreamName=$hotPathEvent.logStreamName;message="not-json"
    }) | Out-Null
}
catch { $malformedLogRejected = $_.Exception.Message -match "malformed hot-path" }
Assert-Condition $malformedLogRejected "Malformed API log evidence must fail closed as evidence unavailable."
$assertions++

$module = Get-Module history-fallback-pi-finalizer
$unexpectedRuntimeClassification = & $module {
    Get-HfCollectorFailureClassification ([InvalidOperationException]::new('unexpected programming failure'))
}
Assert-Condition ($unexpectedRuntimeClassification.failureCode -ceq 'controller_runtime_failure' -and
    $unexpectedRuntimeClassification.failureStage -ceq 'collector_runtime' -and
    $unexpectedRuntimeClassification.attemptCount -eq 1) `
    'An uncategorized collector programming fault must remain a controller runtime failure.'
$assertions++
$providerClassification = & $module {
    $failure = New-HfCollectorException 'provider unavailable' 'aws_request' `
        'performance_insights_evidence_unavailable' 4
    Get-HfCollectorFailureClassification $failure
}
Assert-Condition ($providerClassification.failureCode -ceq 'performance_insights_evidence_unavailable' -and
    $providerClassification.failureStage -ceq 'aws_request' -and
    $providerClassification.attemptCount -eq 4) `
    'An allowlisted provider failure must retain its PI-unavailable classification.'
$assertions++
$stabilized = & $module {
    param($TestConfig)
    $script:HfTestNow = $TestConfig.TrafficEnd.AddMinutes(5)
    function Get-HfNow { return $script:HfTestNow }
    function Wait-HfDelay { param([int]$Seconds) $script:HfTestNow = $script:HfTestNow.AddSeconds($Seconds) }
    function Get-HfSnapshot { param($Ignored) return [ordered]@{schemaVersion=1;passed=$true;value=17} }
    return Get-HfStabilizedSnapshot $TestConfig
} $config
Assert-Condition ($stabilized.AttemptCount -eq 2 -and $stabilized.Evidence.passed -eq $true -and
    $stabilized.CanonicalSha256 -match '^[0-9a-f]{64}$') `
    "Publication-delayed collection must require two identical snapshots separated by 60 seconds."
$assertions++

$paginationCycleRejected = & $module {
    $script:HfPageCalls = 0
    function Invoke-HfAwsJson {
        param([string[]]$Arguments)
        $script:HfPageCalls++
        return [pscustomobject]@{Keys=@();NextToken="cycle-token"}
    }
    try {
        Invoke-HfAwsJsonPages -Arguments @("pi","describe-dimension-keys") -ItemsProperty "Keys" `
            -TokenProperty "NextToken" -Identity { param($item) "unused" } | Out-Null
        return $false
    }
    catch { return $_.Exception.Message -match "token cycle" }
}
Assert-Condition $paginationCycleRejected "Explicit PI pagination must detect token cycles."
$assertions++

$retryClassification = & $module {
    return [ordered]@{
        throttling=(Test-HfAwsRetryableFailure "ThrottlingException")
        timeout=(Test-HfAwsRetryableFailure "" $true)
        permission=(Test-HfAwsRetryableFailure "AccessDeniedException")
        validation=(Test-HfAwsRetryableFailure "ValidationException")
    }
}
Assert-Condition ($retryClassification.throttling -eq $true -and $retryClassification.timeout -eq $true -and
    $retryClassification.permission -eq $false -and $retryClassification.validation -eq $false) `
    "Only allowlisted transient, connection, throttling, and timeout failures may retry."
$assertions++

$trackIoTimingPreflight = & $module {
    $script:HfTrackIoTestValue = "on"
    $script:HfTrackIoTestCalls = 0
    function Invoke-HfAwsJson {
        param([string[]]$Arguments)
        $script:HfTrackIoTestCalls++
        if ($script:HfTrackIoTestValue -ceq "on" -and $script:HfTrackIoTestCalls -eq 1) {
            return [pscustomobject]@{Parameters=@([pscustomobject]@{
                ParameterName="track_io_timing";ParameterValue="on"
            });Marker="page-two"}
        }
        return [pscustomobject]@{Parameters=@([pscustomobject]@{
            ParameterName="track_io_timing";ParameterValue=$script:HfTrackIoTestValue
        })}
    }
    $instance = [pscustomobject]@{DBParameterGroups=@([pscustomobject]@{
        DBParameterGroupName="schoolpilot-production-postgres16";ParameterApplyStatus="in-sync"
    })}
    $config = [pscustomobject]@{Region="us-east-1"}
    $enabled = Get-HfTrackIoTimingParameterEvidence $instance $config
    $script:HfTrackIoTestValue = "off"
    $script:HfTrackIoTestCalls = 0
    $disabledRejected = $false
    try { Get-HfTrackIoTimingParameterEvidence $instance $config | Out-Null }
    catch { $disabledRejected = $_.Exception.Message -match "requires effective track_io_timing" }
    return [pscustomobject]@{Enabled=$enabled;DisabledRejected=$disabledRejected}
}
Assert-Condition ($trackIoTimingPreflight.Enabled.enabled -eq $true -and
    $trackIoTimingPreflight.Enabled.pageCount -eq 2 -and
    $trackIoTimingPreflight.DisabledRejected -eq $true) `
    "Certification preflight must explicitly page the active parameter group and fail unless track_io_timing is effectively on."
$assertions++

$ecsRuntimePreflight = & $module {
    $apiArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:27"
    $workerArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:45"
    $digest = "sha256:" + ("e" * 64)
    $script:HfEcsWrongRevision = $false
    function Invoke-HfAwsJson {
        param([string[]]$Arguments)
        $operation = "$($Arguments[0]) $($Arguments[1])"
        switch ($operation) {
            "ecs describe-services" {
                return [pscustomobject]@{failures=@();services=@(
                    [pscustomobject]@{serviceName="schoolpilot-production-api";status="ACTIVE";
                        taskDefinition=$apiArn;desiredCount=1;runningCount=1;pendingCount=0;deployments=@(
                            [pscustomobject]@{status="PRIMARY";taskDefinition=$apiArn;rolloutState="COMPLETED"})},
                    [pscustomobject]@{serviceName="schoolpilot-production-scheduler-worker";status="ACTIVE";
                        taskDefinition=$workerArn;desiredCount=1;runningCount=1;pendingCount=0;deployments=@(
                            [pscustomobject]@{status="PRIMARY";taskDefinition=$workerArn;rolloutState="COMPLETED"})}
                )}
            }
            "ecs list-tasks" {
                $serviceIndex = [Array]::IndexOf($Arguments, "--service-name")
                $service = $Arguments[$serviceIndex + 1]
                return [pscustomobject]@{taskArns=@("arn:aws:ecs:us-east-1:135775632425:task/test/$service")}
            }
            "ecs describe-tasks" {
                $taskArn = $Arguments[-1]
                $api = $taskArn.EndsWith("schoolpilot-production-api", [StringComparison]::Ordinal)
                $expectedArn = if($api){$apiArn}else{$workerArn}
                $container = if($api){"api"}else{"scheduler-worker"}
                if ($script:HfEcsWrongRevision -and $api) { $expectedArn = $workerArn }
                return [pscustomobject]@{failures=@();tasks=@([pscustomobject]@{
                    taskDefinitionArn=$expectedArn;lastStatus="RUNNING";desiredStatus="RUNNING"
                    containers=@([pscustomobject]@{name=$container;imageDigest=$digest;lastStatus="RUNNING"})
                })}
            }
            default { throw "Unexpected ECS test operation $operation" }
        }
    }
    $config = [pscustomobject]@{Region="us-east-1";EcsClusterName="schoolpilot-production"
        ApiServiceName="schoolpilot-production-api";WorkerServiceName="schoolpilot-production-scheduler-worker"
        ApiTaskDefinitionArn=$apiArn;WorkerTaskDefinitionArn=$workerArn;ImageDigest=$digest}
    $accepted = Get-HfEcsRuntimeBindingEvidence $config
    $script:HfEcsWrongRevision = $true
    $driftRejected = $false
    try { Get-HfEcsRuntimeBindingEvidence $config | Out-Null }
    catch { $driftRejected = $_.Exception.Message -match "outside its exact revision" }
    return [pscustomobject]@{Accepted=$accepted;DriftRejected=$driftRejected;ApiArn=$apiArn;WorkerArn=$workerArn}
}
$ecsRuntimeJson = $ecsRuntimePreflight.Accepted | ConvertTo-Json -Depth 20 -Compress
Assert-Condition ($ecsRuntimePreflight.Accepted.passed -eq $true -and
    $ecsRuntimePreflight.Accepted.api.runningTaskCount -eq 1 -and
    $ecsRuntimePreflight.Accepted.worker.runningTaskCount -eq 1 -and
    $ecsRuntimePreflight.DriftRejected -eq $true -and
    -not $ecsRuntimeJson.Contains($ecsRuntimePreflight.ApiArn) -and
    -not $ecsRuntimeJson.Contains($ecsRuntimePreflight.WorkerArn)) `
    "Certification preflight must prove stable services and every running task revision/digest while sealing hashes only."
$assertions++

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-cert-pi-finalizer-$([Guid]::NewGuid().ToString('N'))"
[void][IO.Directory]::CreateDirectory($tempRoot)
try {
    $identityPath = Join-Path $tempRoot "history-query-identity.json"
    $applicationSha = "d"*40
    $imageDigest = "sha256:" + ("e"*64)
    $apiArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:27"
    $workerArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:45"
    $identityReceipt = [ordered]@{
        schemaVersion=1;type="history_fallback_query_identity_receipt";identityVersion="history-fallback-queryid-v1"
        queryIdentifier=$queryIdentifier;queryIdentifierSha256=Get-TestSha256 $queryIdentifier
        compiledSqlSha256="a"*64;parameterTypeSignatureSha256=Get-TestSha256 $parameterTypeSignatureJson
        engineVersion="16.4";schemaIdentitySha256="b"*64;trackIoTiming=$true
        databaseResourceId="db-JX7VX4P2ZHF5JXA6N5EREVL54I"
        applicationGitSha=$applicationSha;deployedImageDigest=$imageDigest
        activeApiTaskDefinitionArn=$apiArn;activeWorkerTaskDefinitionArn=$workerArn
    }
    [IO.File]::WriteAllText($identityPath, ($identityReceipt | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    Set-TestPrivateAcl $identityPath
    $requestPath = Join-Path $tempRoot "request.json"
    $request = [ordered]@{
        schemaVersion=1;type="history_fallback_pi_finalization_request"
        historyFallbackPiEvidenceVersion="queryid-sqlstats-v1";evidenceCollectorVersion="post-traffic-v2"
        runId="waf500-queryid-r1";chainId="medium-queryid-r1";phase="Waf";stage="500"
        applicationGitSha=$applicationSha;deployedImageDigest=$imageDigest
        taskDefinitions=[ordered]@{api=$apiArn;worker=$workerArn}
        ecsRuntimeBinding=[ordered]@{clusterName="schoolpilot-production";apiServiceName="schoolpilot-production-api"
            workerServiceName="schoolpilot-production-scheduler-worker"}
        rds=[ordered]@{region="us-east-1";accountId="135775632425";dbInstanceIdentifier="schoolpilot-production-db"
            databaseResourceId=$identityReceipt.databaseResourceId;engineVersion="16.4";expectedInstanceClass="db.t4g.medium"}
        trafficWindow=[ordered]@{coherent=$true;startUtc=$start.AddSeconds(10).ToString("o")
            endUtc=$start.AddMinutes(45).AddSeconds(20).ToString("o")}
        apiCloudWatchBinding=[ordered]@{logDriver="awslogs";logRegion="us-east-1";logGroupName="/ecs/schoolpilot-production-api"
            awslogsStreamPrefix="ecs";apiLogStreamNamePrefix="ecs/api/"}
        historyFallbackQueryIdentity=[ordered]@{path=$identityPath;sha256=(Get-FileHash $identityPath -Algorithm SHA256).Hash.ToLowerInvariant()}
        historyFallbackSqlIdentity=[ordered]@{version="history-fallback-queryid-v1"
            queryIdentifierSha256=$identityReceipt.queryIdentifierSha256;compiledSqlSha256=$identityReceipt.compiledSqlSha256
            parameterTypeSignatureSha256=$identityReceipt.parameterTypeSignatureSha256
            schemaIdentitySha256=$identityReceipt.schemaIdentitySha256;trackIoTiming=$true}
        applicationFallbackDatabaseReadEvidence=[ordered]@{sourceEvent="classpilot_heartbeat_hot_path_summary"
            historyFallbackSqlIdentityVersion="history-fallback-queryid-v1"
            historyFallbackSqlIdentitySha256=$identityReceipt.compiledSqlSha256}
    }
    [IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 40), [Text.UTF8Encoding]::new($false))
    Set-TestPrivateAcl $requestPath
    $requestSha = (Get-FileHash $requestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $validated = Test-HistoryFallbackPiFinalizationRequest -RequestPath $requestPath -ExpectedRequestSha256 $requestSha
    Assert-Condition ($validated.valid -eq $true -and
        $validated.queryIdentifierSha256 -eq $identityReceipt.queryIdentifierSha256 -and
        $validated.historyFallbackPiEvidenceVersion -ceq "queryid-sqlstats-v1" -and
        $validated.trackIoTiming -eq $true -and
        $validated.apiRuntimeTaskDefinitionSha256 -eq (Get-TestSha256 $apiArn) -and
        [DateTimeOffset]$validated.evidenceStartUtc -eq $start.AddMinutes(1) -and
        [DateTimeOffset]$validated.evidenceEndUtc -eq $start.AddMinutes(45)) `
        "The reusable finalizer must validate a private request and private raw-ID receipt by exact hash."
    $assertions++

    [IO.File]::AppendAllText($requestPath, " ")
    $tamperRejected = $false
    try { Test-HistoryFallbackPiFinalizationRequest -RequestPath $requestPath -ExpectedRequestSha256 $requestSha | Out-Null }
    catch { $tamperRejected = $_.Exception.Message -match "changed after its hash" }
    Assert-Condition $tamperRejected "Request tampering after hash capture must fail before any AWS evidence read."
    $assertions++

    $immutablePath = Join-Path $tempRoot "immutable-receipt.json"
    & $module { param($Path) Write-HfPrivateImmutableJson $Path ([ordered]@{schemaVersion=1;passed=$true}) } $immutablePath
    $immutableRejected = & $module {
        param($Path)
        try { Write-HfPrivateImmutableJson $Path ([ordered]@{schemaVersion=1;passed=$false}); return $false }
        catch { return $_.Exception.Message -match "already exists" }
    } $immutablePath
    Assert-Condition $immutableRejected "A PI finalization receipt path must be single-write immutable."
    $assertions++
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

$moduleSource = Get-Content -LiteralPath $modulePath -Raw
$wrapperSource = Get-Content -LiteralPath $wrapperPath -Raw
$diagnosticCollectorSource = Get-Content -LiteralPath $diagnosticCollectorPath -Raw
foreach ($requiredToken in @(
    'db.sql_tokenized.db_id','db.sql_tokenized.stats.calls_per_sec.avg',
    'db.sql_tokenized.stats.total_time_per_sec.avg','db.sql_tokenized.stats.blk_read_time_per_sec.avg',
    'db.sql_tokenized.stats.shared_blks_read_per_sec.avg','db.sql_tokenized.stats.temp_blks_read_per_sec.avg',
    'db.sql_tokenized.stats.temp_blks_written_per_sec.avg','--no-paginate',
    '--period-alignment', 'START_TIME', 'AlignedStartTime', 'AlignedEndTime',
    'intervalStartedAtUtc', 'intervalEndedAtUtc', 'utc-minute-interior-v1',
    'HfAwsTimeoutSeconds = 60','HfAwsMaximumAttempts = 4','@(0, 1, 2, 4)',
    'HfInitialDelayMinutes = 5','HfDeadlineMinutes = 15','HfPollSeconds = 60',
    'not_applicable_zero_sampled_load','performance_insights_evidence_unavailable','controller_runtime_failure',
    'history_fallback_pi_gate_failed','rawIdentifiersPersisted=$false','Write-HfPrivateImmutableJson'
)) {
    Assert-Condition $moduleSource.Contains($requiredToken) "The PI finalizer is missing required contract token '$requiredToken'."
    $assertions++
}
Assert-Condition (-not $moduleSource.Contains('integratedCalls + 0.001')) `
    "PI call coverage must compare integrated calls to independently derived reads without tolerance."
$assertions++

$expectedSqlStatsMetrics = @(
    'db.sql_tokenized.stats.calls_per_sec.avg',
    'db.sql_tokenized.stats.total_time_per_sec.avg',
    'db.sql_tokenized.stats.blk_read_time_per_sec.avg',
    'db.sql_tokenized.stats.shared_blks_read_per_sec.avg',
    'db.sql_tokenized.stats.temp_blks_read_per_sec.avg',
    'db.sql_tokenized.stats.temp_blks_written_per_sec.avg'
) | Sort-Object
foreach ($collector in @(
    [pscustomobject]@{Name='certification';Source=$moduleSource},
    [pscustomobject]@{Name='diagnostic';Source=$diagnosticCollectorSource}
)) {
    $observedMetrics = @([regex]::Matches($collector.Source,
        'db\.sql_tokenized\.stats\.[a-z_]+_per_sec\.avg') | ForEach-Object Value | Sort-Object -Unique)
    Assert-Condition (@(Compare-Object $expectedSqlStatsMetrics $observedMetrics -SyncWindow 0).Count -eq 0) `
        "$($collector.Name) collector SQL-statistics metric set drifted."
    Assert-Condition ($collector.Source.Contains('queryid-sqlstats-v1') -and
        $collector.Source.Contains('history-fallback-queryid-v1') -and
        $collector.Source.Contains('post-traffic-v2') -and
        $collector.Source.Contains('START_TIME') -and
        $collector.Source.Contains('requested_tiles') -and
        $collector.Source.Contains('heartbeats') -and
        $collector.Source.Contains('lateral') -and
        $collector.Source.Contains('apiRuntimeTaskDefinitionSha256') -and
        $collector.Source.Contains('trackIoTiming')) `
        "$($collector.Name) collector version, alignment, or identity markers drifted."
    $assertions += 2
}
Assert-Condition ($moduleSource -match 'HfPeriodSeconds\s*=\s*60' -and
    $diagnosticCollectorSource -match 'HistoryFallbackSqlStatsPeriodSeconds\s*=\s*60' -and
    $moduleSource -match 'HfIoThresholdPercent\s*=\s*50\.0' -and
    $diagnosticCollectorSource -match 'HistoryIoDominanceThresholdPercent\s*=\s*50\.0' -and
    $moduleSource -match '\$timestamp\s+-ge\s+\$Config\.EvidenceEnd' -and
    $diagnosticCollectorSource -match '\$timestamp\s+-ge\s+\$trafficEnd' -and
    $moduleSource.Contains('ignoredUngroupedTotalSeriesCount') -and
    $diagnosticCollectorSource.Contains('ignoredUngroupedTotalSeriesCount')) `
    'Diagnostic and certification collectors must retain parity for 60-second START_TIME buckets, exclusive 50% thresholding, EndTime exclusion, and dimensionless-total handling.'
$assertions++
Assert-Condition ($wrapperSource.Contains('ValidateSet("Validate", "Collect")') -and
    $wrapperSource.Contains('history_fallback_pi_finalization_failed')) `
    "The CLI wrapper must support read-only validation and sanitized collection failure output."
$assertions++

$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($modulePath, [ref]$tokens, [ref]$parseErrors)
Assert-Condition ($parseErrors.Count -eq 0) "The reusable PI finalizer module must parse cleanly."
$assertions++
[void][Management.Automation.Language.Parser]::ParseFile($wrapperPath, [ref]$tokens, [ref]$parseErrors)
Assert-Condition ($parseErrors.Count -eq 0) "The PI finalizer CLI wrapper must parse cleanly."
$assertions++

Write-Host "AWS rollout certification PI finalizer tests: PASS ($assertions assertions)"
