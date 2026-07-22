#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedConfigSha256,

    [ValidateSet("Validate", "Run", "Restore")]
    [string]$Mode = "Validate"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:HarnessScript = Join-Path $PSScriptRoot "classpilot-load-test.mjs"
$script:MonotonicDeadlineScript = Join-Path $PSScriptRoot "monotonic-deadline.mjs"
$script:TilePollAccountingScript = Join-Path $PSScriptRoot "tile-poll-accounting.mjs"
$script:MonitorScript = Join-Path $PSScriptRoot "aws-rollout-monitor.ps1"
$script:DatabaseInsightsLeaseScript = Join-Path $PSScriptRoot "database-insights-lease.ps1"
$script:DatabaseInsightsLeaseVersion = "database-insights-monitoring-lease-v2"
$script:DatabaseInsightsDurableRestoreGuardVersion = "aws-scheduler-ssm-recurring-restore-v1"
$script:WorkloadSchemaVersion = "classpilot-tile-batch-v1"
$script:EndpointShapeSha256 = "8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"
$script:ExpectedAccountId = "135775632425"
$script:ExpectedRegion = "us-east-1"
$script:ScheduleBoundaryGuardSeconds = 7200
$script:AlbDeregistrationDelaySeconds = 300
$script:TargetHealthConvergenceTimeoutSeconds = $script:AlbDeregistrationDelaySeconds + 120
$script:TargetHealthPollSeconds = 5
$script:GeneratorIpCheckSeconds = 60
$script:MonitorHeartbeatStaleSeconds = 150
if ($script:GeneratorIpCheckSeconds -ge $script:MonitorHeartbeatStaleSeconds) {
    throw "The generator IP refresh interval must remain below the monitor freshness threshold."
}
$script:AuthSqlMarkers = @(
    "requested_students", "active_supervision", "active_staff_groups",
    "active_roster_students", "authorized_students", "resolved_students"
)
$script:HistoryFallbackSqlMarkers = @("requested_tiles", "heartbeats", "lateral")
$script:HistoryIoDominanceThresholdPercent = 50.0
$script:PerformanceInsightsCoverageTolerancePercent = 0.5
$script:HistoryFallbackSqlIdentityVersion = "history-fallback-queryid-v1"
$script:HistoryFallbackPiEvidenceVersion = "queryid-sqlstats-v1"
$script:HistoryFallbackParameterTypeSignatureJson = '["$1:text[]:student_ids","$2:text[]:device_ids","$3:text:school_id","$4:bigint:history_limit"]'
$script:HistoryFallbackSqlStatsPeriodSeconds = 60
$script:HistoryFallbackSqlStatsMetrics = [ordered]@{
    calls="db.sql_tokenized.stats.calls_per_sec.avg"
    totalTime="db.sql_tokenized.stats.total_time_per_sec.avg"
    blockReadTime="db.sql_tokenized.stats.blk_read_time_per_sec.avg"
    sharedBlocksRead="db.sql_tokenized.stats.shared_blks_read_per_sec.avg"
    tempBlocksRead="db.sql_tokenized.stats.temp_blks_read_per_sec.avg"
    tempBlocksWritten="db.sql_tokenized.stats.temp_blks_written_per_sec.avg"
}
$script:DurationClock = "monotonic-hrtime-v1"
$script:DiagnosticRuntimeTargetTrafficSeconds = 1800.0
$script:DiagnosticPlannedTrafficMilliseconds = 1800000L
$script:HotPathSummaryEvent = "classpilot_heartbeat_hot_path_summary"
$script:HotPathSummaryIntervalSeconds = 60
$script:EvidenceCollectorVersion = "post-traffic-v2"
$script:EvidenceAwsTimeoutSeconds = 60
$script:EvidenceAwsMaximumAttempts = 4
$script:EvidenceAwsRetryDelaysSeconds = @(0, 1, 2, 4)
$script:EvidenceMaximumPages = 100
$script:EvidenceMaximumRecords = 10000
$script:PerformanceInsightsInitialDelayMinutes = 5
$script:PerformanceInsightsStabilizationDeadlineMinutes = 15
$script:PerformanceInsightsPollSeconds = 60
$script:DatabaseInsightsLeaseMaximumAcquisitionAgeSeconds = 900
$script:DatabaseInsightsLeaseRestoreTimeoutSeconds = 900
$script:DatabaseInsightsLeaseSafetyMarginSeconds = 300
$script:DatabaseInsightsLeaseRequiredRemainingSeconds = [int](
    $script:DiagnosticPlannedTrafficMilliseconds / 1000L +
    ($script:PerformanceInsightsStabilizationDeadlineMinutes * 60) +
    $script:DatabaseInsightsLeaseRestoreTimeoutSeconds +
    $script:DatabaseInsightsLeaseSafetyMarginSeconds
)
$script:HarnessTerminalCommitTimeoutSeconds = 45
$script:HarnessTerminalCommitPollMilliseconds = 250

function Get-Value {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    if ($Object -is [Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Get-RequiredValue {
    param($Object, [string]$Name)
    $value = Get-Value $Object $Name
    if ($null -eq $value -or ($value -is [string] -and [string]::IsNullOrWhiteSpace([string]$value))) {
        throw "Diagnostic config requires '$Name'."
    }
    return $value
}

function Assert-SafeIdentifier {
    param([string]$Value, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 128 -or
        $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $Value.EndsWith('.')) {
        throw "$Name must be a filename-safe 1-128 character identifier."
    }
    return $Value
}

function Assert-Sha256 {
    param([string]$Value, [string]$Name, [switch]$ImageDigest)
    $normalized = $Value.Trim().ToLowerInvariant()
    $pattern = if ($ImageDigest) { '^sha256:[0-9a-f]{64}$' } else { '^[0-9a-f]{64}$' }
    if ($normalized -notmatch $pattern) { throw "$Name must be an exact lowercase SHA-256 value." }
    return $normalized
}

function Assert-HistoryFallbackSqlIdentity {
    param($Identity)
    if ($null -eq $Identity) { throw "Diagnostic config requires 'historyFallbackSqlIdentity'." }
    $version = [string](Get-RequiredValue $Identity "identityVersion")
    if ($version -cne $script:HistoryFallbackSqlIdentityVersion) {
        throw "historyFallbackSqlIdentity.identityVersion must bind the reviewed query-ID identity schema."
    }
    $queryIdentifier = ([string](Get-RequiredValue $Identity "queryIdentifier")).Trim()
    $parsedIdentifier = 0L
    if (-not [long]::TryParse($queryIdentifier, [Globalization.NumberStyles]::AllowLeadingSign,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$parsedIdentifier) -or
        $parsedIdentifier -eq 0 -or
        $queryIdentifier -cne $parsedIdentifier.ToString([Globalization.CultureInfo]::InvariantCulture)) {
        throw "historyFallbackSqlIdentity.queryIdentifier must be one canonical nonzero signed 64-bit decimal string."
    }
    $queryIdentifierSha256 = Assert-Sha256 ([string](Get-RequiredValue $Identity "queryIdentifierSha256")) `
        "historyFallbackSqlIdentity.queryIdentifierSha256"
    if ((Get-StringSha256 $queryIdentifier) -cne $queryIdentifierSha256) {
        throw "historyFallbackSqlIdentity query identifier hash validation failed."
    }
    $compiledSqlSha256 = Assert-Sha256 ([string](Get-RequiredValue $Identity "compiledSqlSha256")) `
        "historyFallbackSqlIdentity.compiledSqlSha256"
    $parameterTypeSignatureSha256 = Assert-Sha256 `
        ([string](Get-RequiredValue $Identity "parameterTypeSignatureSha256")) `
        "historyFallbackSqlIdentity.parameterTypeSignatureSha256"
    $databaseResourceId = [string](Get-RequiredValue $Identity "databaseResourceId")
    if ($databaseResourceId -notmatch '^db-[A-Z0-9]{20,64}$') {
        throw "historyFallbackSqlIdentity.databaseResourceId must be an exact RDS DBI resource identifier."
    }
    $engineVersion = [string](Get-RequiredValue $Identity "engineVersion")
    if ($engineVersion -notmatch '^[0-9]+(?:\.[0-9]+){0,2}$') {
        throw "historyFallbackSqlIdentity.engineVersion must be a bounded PostgreSQL version."
    }
    $schemaIdentitySha256 = Assert-Sha256 ([string](Get-RequiredValue $Identity "schemaIdentitySha256")) `
        "historyFallbackSqlIdentity.schemaIdentitySha256"
    if ((Get-Value $Identity "trackIoTiming" $false) -ne $true) {
        throw "historyFallbackSqlIdentity must bind track_io_timing=true."
    }
    return [pscustomobject]@{
        Version=$version;QueryIdentifier=$queryIdentifier;QueryIdentifierSha256=$queryIdentifierSha256
        CompiledSqlSha256=$compiledSqlSha256;ParameterTypeSignatureSha256=$parameterTypeSignatureSha256
        DatabaseResourceId=$databaseResourceId;EngineVersion=$engineVersion;SchemaIdentitySha256=$schemaIdentitySha256
        TrackIoTiming=$true
    }
}

function Assert-GitSha {
    param([string]$Value, [string]$Name)
    $normalized = $Value.Trim().ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{40}$') { throw "$Name must be a full 40-character Git SHA." }
    return $normalized
}

function Resolve-ExternalPath {
    param([string]$Path, [string]$Name, [switch]$AllowMissing)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path) -or
        $Path.StartsWith("\\?\") -or $Path.StartsWith("\\.\")) {
        throw "$Name must be an ordinary absolute path outside the repository."
    }
    $absolute = [IO.Path]::GetFullPath($Path)
    $root = $script:RepositoryRoot.TrimEnd('\', '/')
    if ($absolute -eq $root -or $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name must be outside the repository."
    }
    $cursor = $absolute
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Name must not traverse a symbolic link, junction, or reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $absolute -PathType Leaf)) {
        throw "$Name does not exist."
    }
    return $absolute
}

function Get-AtomicJsonMutexName {
    param([string]$Path)
    $canonical = [IO.Path]::GetFullPath($Path).ToLowerInvariant()
    $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical)))
    return "SchoolPilot.Waf800Diagnostic.AtomicJson.$digest"
}

function Invoke-WithAtomicJsonMutex {
    param([string]$Path, [scriptblock]$Operation)
    $mutex = [Threading.Mutex]::new($false, (Get-AtomicJsonMutexName $Path))
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(15)) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw "Timed out waiting for the evidence lock." }
        return & $Operation
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Write-AtomicJson {
    param([string]$Path, $Value)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 50))
    Invoke-WithAtomicJsonMutex -Path $Path -Operation {
        $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
        $backup = "$Path.$([Guid]::NewGuid().ToString('N')).bak"
        try {
            $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
            try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
            finally { $stream.Dispose() }
            if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, $backup, $true) }
            else { [IO.File]::Move($temporary, $Path) }
        }
        finally {
            if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
            if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
        }
    } | Out-Null
}

function Read-AtomicJson {
    param([string]$Path)
    return Invoke-WithAtomicJsonMutex -Path $Path -Operation {
        $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true, 4096, $true)
            try { $text = $reader.ReadToEnd() }
            finally { $reader.Dispose() }
        }
        finally { $stream.Dispose() }
        return $text | ConvertFrom-Json -Depth 50
    }
}

function Get-StableJsonSha256 {
    param($Value)
    $json = $Value | ConvertTo-Json -Depth 50 -Compress
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))).ToLowerInvariant()
}

function Get-StringSha256 {
    param([string]$Value)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
}

function Get-DiagnosticRunMutexName {
    param($Config)
    $identity = "$([IO.Path]::GetFullPath($Config.EvidenceDirectory).ToLowerInvariant())|$($Config.RunId.ToLowerInvariant())"
    return "SchoolPilot.Waf800Diagnostic.Run.$(Get-StringSha256 $identity)"
}

function Enter-DiagnosticRunLock {
    param($Config)
    $createdNew = $false
    $mutex = [Threading.Mutex]::new($true, (Get-DiagnosticRunMutexName $Config), [ref]$createdNew)
    if (-not $createdNew) {
        $mutex.Dispose()
        throw "Another controller already owns this exact diagnostic run/evidence identity."
    }
    return $mutex
}

function Exit-DiagnosticRunLock {
    param($Lock)
    if ($null -eq $Lock) { return }
    try { $Lock.ReleaseMutex() }
    finally { $Lock.Dispose() }
}

function Test-EvidenceAwsRetryableFailure {
    param([string]$StandardError, [bool]$TimedOut = $false)
    if ($TimedOut) { return $true }
    $lower = ([string]$StandardError).ToLowerInvariant()
    return $lower -match 'throttl|rate exceeded|requestlimitexceeded|service unavailable|temporar|timeout|timed out|connection|internalerror|internal failure'
}

function Invoke-AwsJson {
    param([string[]]$Arguments)
    $operation = "$($Arguments[0]) $($Arguments[1])"
    $aws = (Get-Command aws -ErrorAction Stop).Source
    $lastFailure = $null
    for ($attempt = 1; $attempt -le $script:EvidenceAwsMaximumAttempts; $attempt++) {
        if ($script:EvidenceAwsRetryDelaysSeconds[$attempt - 1] -gt 0) {
            Start-Sleep -Seconds $script:EvidenceAwsRetryDelaysSeconds[$attempt - 1]
        }
        $process = $null
        try {
            $startInfo = [Diagnostics.ProcessStartInfo]::new()
            $startInfo.FileName = $aws
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            foreach ($argument in @($Arguments) + @("--output", "json")) { [void]$startInfo.ArgumentList.Add($argument) }
            $startInfo.RedirectStandardOutput = $true
            $startInfo.RedirectStandardError = $true
            $process = [Diagnostics.Process]::new()
            $process.StartInfo = $startInfo
            if (-not $process.Start()) { throw "AWS CLI process could not start." }
            $stdoutTask = $process.StandardOutput.ReadToEndAsync()
            $stderrTask = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit($script:EvidenceAwsTimeoutSeconds * 1000)) {
                try { $process.Kill($true) } catch { }
                $lastFailure = "timeout"
                if ($attempt -lt $script:EvidenceAwsMaximumAttempts) { continue }
                throw "AWS CLI request timed out for $operation."
            }
            $stdout = $stdoutTask.GetAwaiter().GetResult()
            $stderr = $stderrTask.GetAwaiter().GetResult()
            if ($process.ExitCode -ne 0) {
                $retryable = Test-EvidenceAwsRetryableFailure ([string]$stderr)
                $lastFailure = if ($retryable) { "transient" } else { "non_retryable" }
                if ($retryable -and $attempt -lt $script:EvidenceAwsMaximumAttempts) { continue }
                throw "AWS CLI request failed for $operation ($lastFailure)."
            }
            $text = ([string]$stdout).Trim()
            if (-not $text) { return $null }
            try { return $text | ConvertFrom-Json -Depth 50 }
            catch { throw "AWS CLI returned malformed JSON for $operation." }
        }
        finally {
            if ($null -ne $process) { $process.Dispose() }
        }
    }
    throw "AWS CLI request failed for $operation ($lastFailure)."
}

function Test-DiagnosticEmptyObject {
    param($Value)
    if ($null -eq $Value) { return $true }
    if ($Value -is [Collections.IDictionary]) { return $Value.Count -eq 0 }
    return @($Value.PSObject.Properties).Count -eq 0
}

function ConvertTo-ExactUtcDateTimeOffset {
    param($Value, [string]$Name)
    if ($Value -is [DateTimeOffset]) {
        $parsed = [DateTimeOffset]$Value
    }
    elseif ($Value -is [DateTime]) {
        $dateTime = [DateTime]$Value
        if ($dateTime.Kind -ne [DateTimeKind]::Utc) { throw "$Name must be an exact UTC timestamp." }
        $parsed = [DateTimeOffset]::new($dateTime)
    }
    elseif ($Value -is [string]) {
        $parsed = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParse([string]$Value, [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) {
            throw "$Name must be a valid UTC timestamp."
        }
    }
    else { throw "$Name must be a valid UTC timestamp." }
    if ($parsed.Offset -ne [TimeSpan]::Zero) { throw "$Name must be an exact UTC timestamp." }
    return $parsed.ToUniversalTime()
}

function Get-PerformanceInsightsEvidenceWindow {
    param([string]$StartUtc, [string]$EndUtc)
    try {
        $coherentStart = ([DateTimeOffset]$StartUtc).ToUniversalTime()
        $coherentEnd = ([DateTimeOffset]$EndUtc).ToUniversalTime()
    }
    catch { throw "Performance Insights evidence requires a valid coherent UTC traffic window." }
    if ($coherentEnd -le $coherentStart) {
        throw "Performance Insights evidence requires a positive coherent traffic window."
    }
    $startFloor = [DateTimeOffset]::new($coherentStart.Year, $coherentStart.Month, $coherentStart.Day,
        $coherentStart.Hour, $coherentStart.Minute, 0, [TimeSpan]::Zero)
    $alignedStart = if ($coherentStart -gt $startFloor) { $startFloor.AddMinutes(1) } else { $startFloor }
    $alignedEnd = [DateTimeOffset]::new($coherentEnd.Year, $coherentEnd.Month, $coherentEnd.Day,
        $coherentEnd.Hour, $coherentEnd.Minute, 0, [TimeSpan]::Zero)
    if ($alignedEnd -le $alignedStart) {
        throw "The coherent traffic window does not contain a positive complete-minute Performance Insights evidence subwindow."
    }
    $coherentCanonical = [ordered]@{
        startUtc=$coherentStart.ToString("o");endUtc=$coherentEnd.ToString("o")
    }
    $alignedCanonical = [ordered]@{
        startUtc=$alignedStart.ToString("o");endUtc=$alignedEnd.ToString("o")
    }
    $coherentSeconds = ($coherentEnd - $coherentStart).TotalSeconds
    $alignedSeconds = ($alignedEnd - $alignedStart).TotalSeconds
    return [pscustomobject]@{
        CoherentStart=$coherentStart;CoherentEnd=$coherentEnd
        AlignedStart=$alignedStart;AlignedEnd=$alignedEnd
        Evidence=[ordered]@{
            alignment="utc-complete-minute-v1"
            coherentWindowSha256=(Get-StableJsonSha256 $coherentCanonical)
            alignedEvidenceWindowSha256=(Get-StableJsonSha256 $alignedCanonical)
            coherentDurationSeconds=[math]::Round($coherentSeconds,3)
            alignedDurationSeconds=[math]::Round($alignedSeconds,3)
            completeMinuteCount=[int]($alignedSeconds / 60.0)
            alignedCoveragePercent=[math]::Round(($alignedSeconds / $coherentSeconds) * 100.0,6)
        }
    }
}

function Assert-PerformanceInsightsResponseScope {
    param(
        $Response,
        [string]$ExpectedAlignedStartUtc,
        [string]$ExpectedAlignedEndUtc,
        [string]$ExpectedIdentifier = ""
    )
    if ($null -eq $Response) { throw "Performance Insights returned an empty response page." }
    try {
        $actualStart = ConvertTo-ExactUtcDateTimeOffset (Get-RequiredValue $Response "AlignedStartTime") "AlignedStartTime"
        $actualEnd = ConvertTo-ExactUtcDateTimeOffset (Get-RequiredValue $Response "AlignedEndTime") "AlignedEndTime"
        $expectedStart = ConvertTo-ExactUtcDateTimeOffset $ExpectedAlignedStartUtc "ExpectedAlignedStartTime"
        $expectedEnd = ConvertTo-ExactUtcDateTimeOffset $ExpectedAlignedEndUtc "ExpectedAlignedEndTime"
    }
    catch { throw "Performance Insights returned malformed aligned response bounds." }
    if ($actualStart -ne $expectedStart -or $actualEnd -ne $expectedEnd) {
        throw "Performance Insights returned response bounds outside the exact aligned evidence subwindow."
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedIdentifier) -and
        [string](Get-RequiredValue $Response "Identifier") -cne $ExpectedIdentifier) {
        throw "Performance Insights returned a response for a different database resource identity."
    }
}

function Invoke-EvidenceAwsJsonPages {
    param(
        [string[]]$Arguments,
        [string]$ItemsProperty,
        [string]$TokenProperty,
        [string]$TokenArgument = "--next-token",
        [scriptblock]$Identity,
        [string]$ExpectedAlignedStartUtc = "",
        [string]$ExpectedAlignedEndUtc = ""
    )
    $items = [Collections.Generic.List[object]]::new()
    $seenTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $seenItems = @{}
    $token = $null
    $pageCount = 0
    do {
        $pageCount++
        if ($pageCount -gt $script:EvidenceMaximumPages) { throw "AWS evidence pagination exceeded the page limit." }
        $pageArguments = @($Arguments) + @("--no-paginate")
        if (-not [string]::IsNullOrWhiteSpace([string]$token)) { $pageArguments += @($TokenArgument, [string]$token) }
        $page = Invoke-AwsJson $pageArguments
        if ($null -eq $page) { throw "AWS evidence pagination returned an empty page." }
        if (-not [string]::IsNullOrWhiteSpace($ExpectedAlignedStartUtc) -or
            -not [string]::IsNullOrWhiteSpace($ExpectedAlignedEndUtc)) {
            if ([string]::IsNullOrWhiteSpace($ExpectedAlignedStartUtc) -or
                [string]::IsNullOrWhiteSpace($ExpectedAlignedEndUtc)) {
                throw "Performance Insights pagination requires both aligned response bounds."
            }
            Assert-PerformanceInsightsResponseScope $page $ExpectedAlignedStartUtc $ExpectedAlignedEndUtc
        }
        foreach ($item in @((Get-Value $page $ItemsProperty @()))) {
            $identityValue = if ($null -ne $Identity) { [string](& $Identity $item) } else { Get-StableJsonSha256 $item }
            if ([string]::IsNullOrWhiteSpace($identityValue)) { throw "AWS evidence pagination returned an item without an identity." }
            $itemHash = Get-StableJsonSha256 $item
            if ($seenItems.ContainsKey($identityValue)) {
                if ([string]$seenItems[$identityValue] -cne $itemHash) { throw "AWS evidence pagination returned conflicting duplicate items." }
                continue
            }
            $seenItems[$identityValue] = $itemHash
            $items.Add($item)
            if ($items.Count -gt $script:EvidenceMaximumRecords) { throw "AWS evidence pagination exceeded the record limit." }
        }
        $token = [string](Get-Value $page $TokenProperty "")
        if (-not [string]::IsNullOrWhiteSpace($token) -and -not $seenTokens.Add($token)) {
            throw "AWS evidence pagination returned a token cycle."
        }
    } while (-not [string]::IsNullOrWhiteSpace($token))
    return [pscustomobject]@{Items=$items.ToArray();PageCount=$pageCount;RecordCount=$items.Count}
}

function New-StagedEvidenceException {
    param(
        [string]$Stage,
        [Management.Automation.ErrorRecord]$ErrorRecord,
        [string[]]$CompletedStages = @(),
        $PartialEvidence = $null
    )
    $exception = [InvalidOperationException]::new($ErrorRecord.Exception.Message, $ErrorRecord.Exception)
    $exception.Data["failureStage"] = $Stage
    $exception.Data["completedStages"] = @($CompletedStages)
    if ($null -ne $PartialEvidence) { $exception.Data["partialEvidence"] = $PartialEvidence }
    return $exception
}

function New-EvidenceEnvelope {
    param(
        [bool]$Collected,
        [bool]$Passed,
        [int]$AttemptCount,
        [string]$FailureCode,
        [string]$FailureStage,
        [string]$MessageSha256,
        $Evidence,
        [string[]]$CompletedStages = @(),
        $PartialEvidence = $null
    )
    $envelope = [ordered]@{
        evidenceCollectorVersion=$script:EvidenceCollectorVersion
        state=if($Collected){"completed"}else{"failed"}
        collected=$Collected;passed=$Passed;attemptCount=$AttemptCount
        completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
        failureCode=if($Collected){$null}else{$FailureCode}
        failureStage=if($Collected){$null}else{$FailureStage}
        messageSha256=if($Collected){$null}else{$MessageSha256}
        completedStages=@($CompletedStages)
        partial=$PartialEvidence
        rawErrorPersisted=$false
    }
    if ($null -ne $Evidence) {
        if ($Evidence -is [Collections.IDictionary]) {
            foreach ($key in $Evidence.Keys) {
                if (-not $envelope.Contains($key)) { $envelope[$key] = $Evidence[$key] }
            }
        } else {
            foreach ($property in $Evidence.PSObject.Properties) {
                if (-not $envelope.Contains($property.Name)) { $envelope[$property.Name] = $property.Value }
            }
        }
    }
    return $envelope
}

function Get-EvidenceUtcNow { return [DateTimeOffset]::UtcNow }

function Wait-EvidenceDelay {
    param([int]$Seconds)
    if ($Seconds -gt 0) { Start-Sleep -Seconds $Seconds }
}

function Test-EvidenceSourceNotStarted {
    param($Evidence)
    if ($null -eq $Evidence) { return $true }
    return [string](Get-Value $Evidence "state" "not_started") -ceq "not_started"
}

function Wait-HarnessTerminalEvidenceCommit {
    param(
        $Terminal,
        $Config,
        [string]$ProgressPath,
        [string]$SummaryPath,
        $HarnessProcess,
        [int]$TimeoutSeconds = $script:HarnessTerminalCommitTimeoutSeconds,
        [int]$PollMilliseconds = $script:HarnessTerminalCommitPollMilliseconds
    )
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    do {
        try {
            $observed = Get-ObservedTrafficWindow $Config $ProgressPath $SummaryPath
            $Terminal.observedTrafficWindow = $observed.Evidence
            if ($observed.Evidence.strictlyComplete -ne $true) {
                Add-TerminalFailure $Terminal "strict_traffic_duration_not_completed"
            }
            return $true
        }
        catch {
            # Progress JSONL and the atomic summary are committed by separate
            # writes. Their interim absence/mismatch is not terminal evidence.
        }
        if ($stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { break }
        if ($null -ne $HarnessProcess) {
            try { $HarnessProcess.Refresh() } catch { }
        }
        if ($PollMilliseconds -gt 0) { Start-Sleep -Milliseconds $PollMilliseconds }
    } while ($true)
    return $false
}

function Resolve-DiagnosticTerminalExitCode {
    param($Terminal, $Restoration, $DatabaseInsightsRestoration, [bool]$AcceptanceAdjudicated, [int]$CurrentExitCode)
    if ((Get-Value $Restoration "attempted" $false) -eq $true -and
        (Get-Value $Restoration "restored" $false) -ne $true) { return 4 }
    if ((Get-Value $DatabaseInsightsRestoration "attempted" $false) -eq $true -and
        (Get-Value $DatabaseInsightsRestoration "restored" $false) -ne $true) { return 4 }
    if ($AcceptanceAdjudicated -and @($Terminal.failures).Count -eq 0) { return 0 }
    if ($CurrentExitCode -eq 4) { return 4 }
    return 2
}

function Get-ControllerFailureClassification {
    param([string]$Stage, [Management.Automation.ErrorRecord]$ErrorRecord)
    $allowedStages = @(
        "capacity_pin","harness_launch","harness_ready","monitor_validation","monitor_launch",
        "monitor_arming","traffic_release","traffic_monitoring","terminal_commit","immediate_evidence",
        "scaling_restoration","delayed_evidence","database_insights_restoration","acceptance_adjudication","terminal_posture"
    )
    $failureId = [string]$ErrorRecord.FullyQualifiedErrorId
    $programmingFailure = $failureId -match 'CommandNotFound|PropertyNotFound|MethodNotFound|ParameterBinding|ParseException|TypeNotFound|VariableIsUndefined|NullArray' -or
        $ErrorRecord.Exception -is [NullReferenceException] -or
        $ErrorRecord.Exception -is [IndexOutOfRangeException] -or
        $ErrorRecord.Exception -is [InvalidCastException]
    $operational = $Stage -in $allowedStages -and -not $programmingFailure
    return [ordered]@{
        failureCode=if($operational){"controller_operational_failure"}else{"controller_runtime_failure"}
        failureStage=if($Stage -in $allowedStages){$Stage}else{"controller_framework"}
        messageSha256=(Get-StringSha256 $ErrorRecord.Exception.Message)
        rawErrorPersisted=$false
    }
}

function Test-ProcessLive {
    param($Process)
    if ($null -eq $Process) { return $false }
    try { $Process.Refresh() } catch { return $false }
    return -not $Process.HasExited
}

function Test-HarnessTerminalEvidencePresent {
    param($Config, [string]$ProgressPath, [string]$SummaryPath)
    if (-not (Test-Path -LiteralPath $ProgressPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $SummaryPath -PathType Leaf)) { return $false }
    try {
        $observed = Get-ObservedTrafficWindow $Config $ProgressPath $SummaryPath
        return (Get-Value $observed.Evidence "coherent" $false) -eq $true
    }
    catch { return $false }
}

function Get-ControllerCleanupDisposition {
    param(
        [bool]$ControllerExceptionOccurred,
        [bool]$HarnessLive,
        [bool]$MonitorLive,
        [bool]$TerminalEvidencePresent,
        [bool]$NaturallyTerminalChild
    )
    if ($TerminalEvidencePresent -or (-not $HarnessLive -and $NaturallyTerminalChild)) {
        return [ordered]@{mode="commit_grace";stopOrder=@("monitor","harness","restore")}
    }
    # If orchestration fails while both children are still live, the harness
    # must be stopped before its monitor. No unmonitored traffic is permitted
    # during the terminal-artifact commit grace period.
    if ($ControllerExceptionOccurred -and $HarnessLive -and $MonitorLive) {
        return [ordered]@{mode="immediate_harness_first";stopOrder=@("harness","monitor","restore")}
    }
    return [ordered]@{mode="immediate_harness_first";stopOrder=@("harness","monitor","restore")}
}

function Stop-ControllerChildrenImmediately {
    param($Terminal, $Harness, $Monitor)
    try { Stop-ProcessBounded $Harness }
    catch { Add-TerminalFailure $Terminal "harness_process_stop_failed" }
    try { Stop-ProcessBounded $Monitor }
    catch { Add-TerminalFailure $Terminal "monitor_process_stop_failed" }
}

function Invoke-AwsCommand {
    param([string[]]$Arguments)
    & aws @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "AWS CLI request failed for $($Arguments[0]) $($Arguments[1])." }
}

function Get-ControllerSha {
    # Keep the native command out of a PowerShell pipeline. In PowerShell 7.6,
    # a successful native-command pipeline can leave $LASTEXITCODE undefined
    # under StrictMode, which made a read-only validation fail before traffic.
    $output = @(& git -C $script:RepositoryRoot rev-parse HEAD 2>$null)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "Unable to resolve the diagnostic controller Git SHA." }
    if ($output.Count -ne 1) { throw "Diagnostic controller Git SHA resolution must return exactly one output line." }
    return Assert-GitSha ([string]$output[0]) "controller Git SHA"
}

function Read-DiagnosticConfiguration {
    $configPath = Resolve-ExternalPath $ConfigPath "ConfigPath"
    $expectedHash = Assert-Sha256 $ExpectedConfigSha256 "ExpectedConfigSha256"
    $actualHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -cne $expectedHash) { throw "Bound diagnostic config SHA-256 validation failed." }
    try { $raw = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -Depth 50 }
    catch { throw "ConfigPath must contain valid JSON." }
    if ([int](Get-Value $raw "schemaVersion" 0) -ne 1 -or (Get-Value $raw "diagnosticOnly" $false) -ne $true) {
        throw "The diagnostic config must declare schemaVersion=1 and diagnosticOnly=true."
    }
    if ((Get-Value $raw "certification") -or (Get-Value $raw "predecessorResultPath")) {
        throw "Diagnostic-only configuration cannot contain certification or predecessor fields."
    }
    $runId = Assert-SafeIdentifier ([string](Get-RequiredValue $raw "runId")) "runId"
    $evidenceDirectory = Resolve-ExternalPath ([string](Get-RequiredValue $raw "evidenceDirectory")) "evidenceDirectory" -AllowMissing
    $baseUrl = ([string](Get-RequiredValue $raw "baseUrl")).TrimEnd('/')
    if ($baseUrl -cne "https://school-pilot.net") { throw "Production diagnostics must target https://school-pilot.net through CloudFront." }

    $workload = Get-RequiredValue $raw "workload"
    if ([string](Get-Value $workload "stage" "") -cne "800" -or
        [int](Get-Value $workload "devices" 0) -ne 810 -or
        [int](Get-Value $workload "durationSeconds" 0) -ne 1800 -or
        [int](Get-Value $workload "screenshotBytes" 0) -ne 40960 -or
        [int](Get-Value $workload "canaryDevices" 0) -ne 10 -or
        [string](Get-Value $workload "workloadSchemaVersion" "") -cne $script:WorkloadSchemaVersion -or
        [string](Get-Value $workload "endpointShapeSha256" "").ToLowerInvariant() -cne $script:EndpointShapeSha256) {
        throw "Diagnostic workload must be the exact reviewed 810/1800/40960/10 tile-batch Waf/800 profile."
    }

    $identity = Get-RequiredValue $raw "deploymentIdentity"
    $applicationSha = Assert-GitSha ([string](Get-RequiredValue $identity "applicationGitSha")) "deploymentIdentity.applicationGitSha"
    $controllerSha = Assert-GitSha ([string](Get-RequiredValue $identity "controllerGitSha")) "deploymentIdentity.controllerGitSha"
    $digest = Assert-Sha256 ([string](Get-RequiredValue $identity "deployedImageDigest")) "deploymentIdentity.deployedImageDigest" -ImageDigest
    $apiArn = [string](Get-RequiredValue $identity "apiTaskDefinitionArn")
    $workerArn = [string](Get-RequiredValue $identity "workerTaskDefinitionArn")
    if ($apiArn -notmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api(?:-emergency)?:[1-9][0-9]*$' -or
        $workerArn -notmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:[1-9][0-9]*$') {
        throw "Deployment identity must bind exact revisioned production API and worker task-definition ARNs."
    }
    $actualControllerSha = Get-ControllerSha
    if ($controllerSha -cne $actualControllerSha -or $applicationSha -cne $controllerSha) {
        throw "The diagnostic controller and deployed application must bind the same current release commit."
    }

    $resources = Get-RequiredValue $raw "resources"
    foreach ($name in @(
        "region", "accountId", "cluster", "apiService", "workerService", "rdsInstanceId",
        "redisCacheClusterId", "redisReplicationGroupId", "vpcId", "wafWebAclName", "cloudFrontDistributionId",
        "wafDeviceClassifierMetricName", "wafDeviceRuleMetricName", "wafApiRuleMetricName", "targetGroupArn", "route53HealthCheckId",
        "route53AlarmName", "notificationTopicArn"
    )) { [void](Get-RequiredValue $resources $name) }
    if ([string]$resources.region -cne $script:ExpectedRegion -or [string]$resources.accountId -cne $script:ExpectedAccountId -or
        [string]$resources.cluster -cne "schoolpilot-production-cluster" -or
        [string]$resources.apiService -cne "schoolpilot-production-api" -or
        [string]$resources.workerService -cne "schoolpilot-production-scheduler-worker" -or
        [string](Get-Value $resources "expectedRdsInstanceClass" "") -cne "db.t4g.medium" -or
        [string](Get-Value $resources "expectedRedisNodeType" "") -cne "cache.t4g.small" -or
        [int](Get-Value $resources "expectedNatGatewayCount" -1) -ne 2 -or
        (Get-Value $resources "expectedEcsAssignPublicIp" $true) -ne $false -or
        (Get-Value $resources "expectedRoute53MeasureLatency" $false) -ne $true) {
        throw "Diagnostic AWS posture must remain the exact private medium/small Waf phase in production."
    }
    if ([string]$resources.cloudFrontDistributionId -notmatch '^E[A-Z0-9]{8,20}$') {
        throw "resources.cloudFrontDistributionId must bind the exact production CloudFront distribution."
    }
    $subnets = @((Get-RequiredValue $resources "ecsTaskSubnetIds") | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    if ($subnets.Count -lt 2 -or @($subnets | Where-Object { $_ -notmatch '^subnet-[0-9a-f]+$' }).Count -gt 0) {
        throw "resources.ecsTaskSubnetIds must bind the production private ECS subnets."
    }
    if ([string](Get-Value $resources "expectedActiveApiTaskDefinitionArn" "") -cne $apiArn -or
        [string](Get-Value $resources "expectedActiveWorkerTaskDefinitionArn" "") -cne $workerArn) {
        throw "Monitor resource task-definition bindings must match deploymentIdentity."
    }

    if ($null -ne (Get-Value $raw "historyFallbackSqlIdentity" $null)) {
        throw "Raw historyFallbackSqlIdentity content is forbidden in diagnostic configuration; bind the private receipt reference."
    }
    $historyFallbackPiEvidenceVersion = [string](Get-RequiredValue $raw "historyFallbackPiEvidenceVersion")
    $historyFallbackSqlIdentity = Read-HistoryFallbackQueryIdentityReceipt `
        (Get-RequiredValue $raw "historyFallbackQueryIdentity") `
        $applicationSha $digest $apiArn $workerArn $historyFallbackPiEvidenceVersion
    $databaseInsightsLease = Assert-DatabaseInsightsLeaseBinding (Get-RequiredValue $raw "databaseInsightsLease")

    $artifacts = @((Get-RequiredValue $raw "harnessArtifacts"))
    $expectedKinds = @("command-bodies", "device-manifest", "teacher-auth")
    $bindings = @()
    foreach ($artifact in $artifacts) {
        $kind = [string](Get-RequiredValue $artifact "kind")
        if ($kind -notin $expectedKinds -or @($bindings | Where-Object kind -eq $kind).Count -gt 0) {
            throw "harnessArtifacts must bind each reviewed private artifact kind exactly once."
        }
        $path = Resolve-ExternalPath ([string](Get-RequiredValue $artifact "path")) "harnessArtifacts.$kind.path"
        $sha = Assert-Sha256 ([string](Get-RequiredValue $artifact "sha256")) "harnessArtifacts.$kind.sha256"
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha) {
            throw "The $kind harness artifact hash does not match its binding."
        }
        $bindings += [pscustomobject]@{ kind=$kind; path=$path; sha256=$sha }
    }
    if ($bindings.Count -ne 3 -or @(Compare-Object $expectedKinds @($bindings.kind | Sort-Object)).Count -ne 0) {
        throw "harnessArtifacts must bind device-manifest, teacher-auth, and command-bodies exactly once."
    }

    $expectedGeneratorIp = [string](Get-RequiredValue $raw "expectedGeneratorPublicIp")
    $address = $null
    if (-not [Net.IPAddress]::TryParse($expectedGeneratorIp, [ref]$address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw "expectedGeneratorPublicIp must be an IPv4 literal."
    }
    return [pscustomobject]@{
        Raw=$raw; Path=$configPath; Sha256=$actualHash; RunId=$runId; EvidenceDirectory=$evidenceDirectory
        BaseUrl=$baseUrl; Workload=$workload; Resources=$resources; ExpectedGeneratorPublicIp=$expectedGeneratorIp
        ApplicationGitSha=$applicationSha; ControllerGitSha=$controllerSha; ImageDigest=$digest
        ApiTaskDefinitionArn=$apiArn; WorkerTaskDefinitionArn=$workerArn; HarnessArtifacts=$bindings
        HistoryFallbackSqlIdentity=$historyFallbackSqlIdentity;DatabaseInsightsLease=$databaseInsightsLease
    }
}

function Restore-TerminalDatabaseInsightsLease {
    param($Terminal, $Config, $CurrentRestoration)
    if ((Get-Value $CurrentRestoration "attempted" $false) -eq $true) { return $CurrentRestoration }
    try {
        $leaseEvidence = Invoke-DatabaseInsightsLeaseController -Config $Config -LeaseMode Restore
        $restoration = [ordered]@{
            attempted=$true;restored=$true;completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
            failureCode=$null;failureStage=$null;lease=$leaseEvidence;rawErrorPersisted=$false
        }
        $Terminal.databaseInsightsLease.restoration = $restoration
        return $restoration
    }
    catch {
        $restoration = [ordered]@{
            attempted=$true;restored=$false;completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
            failureCode="database_insights_lease_restoration_failed";failureStage="database_insights_restoration"
            messageSha256=(Get-StringSha256 $_.Exception.Message);rawErrorPersisted=$false
        }
        $Terminal.databaseInsightsLease.restoration = $restoration
        Add-TerminalFailure $Terminal "database_insights_lease_restoration_failed"
        return $restoration
    }
}

function Assert-DiagnosticPrivateFileAcl {
    param([string]$Path, [string]$Name)
    if (-not $IsWindows) { throw "$Name requires Windows ACL enforcement." }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { throw "$Name must disable inherited file access." }
    foreach ($rule in @($acl.Access)) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $currentSid) {
            throw "$Name must be readable only by the current diagnostic operator."
        }
    }
}

function Read-HistoryFallbackQueryIdentityReceipt {
    param(
        $Reference,
        [string]$ApplicationGitSha,
        [string]$DeployedImageDigest,
        [string]$ActiveApiTaskDefinitionArn,
        [string]$ActiveWorkerTaskDefinitionArn,
        [string]$PiEvidenceVersion
    )
    if ($null -eq $Reference) { throw "Diagnostic config requires 'historyFallbackQueryIdentity'." }
    if ($PiEvidenceVersion -cne $script:HistoryFallbackPiEvidenceVersion) {
        throw "historyFallbackPiEvidenceVersion must bind deterministic query-ID SQL statistics."
    }
    $path = Resolve-ExternalPath ([string](Get-RequiredValue $Reference "path")) `
        "historyFallbackQueryIdentity.path"
    $expectedSha256 = Assert-Sha256 ([string](Get-RequiredValue $Reference "sha256")) `
        "historyFallbackQueryIdentity.sha256"
    $actualSha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -cne $expectedSha256) {
        throw "The history fallback query-identity receipt changed after its hash was recorded."
    }
    Assert-DiagnosticPrivateFileAcl $path "historyFallbackQueryIdentity"
    try { $receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 30 }
    catch { throw "The history fallback query-identity receipt must contain valid JSON." }
    if ([int](Get-Value $receipt "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $receipt "type" "") -cne "history_fallback_query_identity_receipt") {
        throw "The history fallback query-identity receipt has an unsupported schema."
    }
    $identity = Assert-HistoryFallbackSqlIdentity $receipt
    $expectedParameterSignatureSha256 = Get-StringSha256 $script:HistoryFallbackParameterTypeSignatureJson
    if ($identity.ParameterTypeSignatureSha256 -cne $expectedParameterSignatureSha256 -or
        [string](Get-Value $receipt "applicationGitSha" "") -cne $ApplicationGitSha -or
        [string](Get-Value $receipt "deployedImageDigest" "") -cne $DeployedImageDigest -or
        [string](Get-Value $receipt "activeApiTaskDefinitionArn" "") -cne $ActiveApiTaskDefinitionArn -or
        [string](Get-Value $receipt "activeWorkerTaskDefinitionArn" "") -cne $ActiveWorkerTaskDefinitionArn) {
        throw "The history fallback query-identity receipt is not bound to the exact release and active task revisions."
    }
    $identity | Add-Member -NotePropertyName Receipt -NotePropertyValue ([pscustomobject]@{
        Path=$path;Sha256=$actualSha256
    }) -Force
    $identity | Add-Member -NotePropertyName PiEvidenceVersion -NotePropertyValue $PiEvidenceVersion -Force
    return $identity
}

function Assert-DatabaseInsightsLeaseBinding {
    param($Binding)
    if ($null -eq $Binding) { throw "Diagnostic config requires 'databaseInsightsLease'." }
    $version = [string](Get-RequiredValue $Binding "version")
    if ($version -cne $script:DatabaseInsightsLeaseVersion) {
        throw "databaseInsightsLease.version must bind the reviewed monitoring-lease schema."
    }
    $receiptPath = Resolve-ExternalPath ([string](Get-RequiredValue $Binding "receiptPath")) `
        "databaseInsightsLease.receiptPath"
    $receiptSha256 = Assert-Sha256 ([string](Get-RequiredValue $Binding "receiptSha256")) `
        "databaseInsightsLease.receiptSha256"
    if ((Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receiptSha256) {
        throw "The Database Insights lease receipt hash does not match its config binding."
    }
    try { $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "The Database Insights lease receipt is malformed." }
    $durableGuard = Get-Value $receipt "durableRestoreGuard" $null
    if ([string](Get-Value $durableGuard "version" "") -cne $script:DatabaseInsightsDurableRestoreGuardVersion) {
        throw "The Database Insights lease receipt does not bind the reviewed AWS-native durable restore guard."
    }
    $durableGuardBindingSha256 = Assert-Sha256 `
        ([string](Get-Value $durableGuard "bindingSha256" "")) `
        "databaseInsightsLease.durableRestoreGuard.bindingSha256"
    $durableScheduleArnSha256 = Get-StringSha256 ([string](Get-RequiredValue $durableGuard "scheduleArn"))
    $durableTargetRoleArnSha256 = Get-StringSha256 ([string](Get-RequiredValue $durableGuard "targetRoleArn"))
    $durableDeadLetterQueueArnSha256 = Get-StringSha256 ([string](Get-RequiredValue $durableGuard "deadLetterQueueArn"))
    $durableAutomationDefinitionArnSha256 = Get-StringSha256 `
        ([string](Get-RequiredValue $durableGuard "automationDefinitionArn"))
    $durableAutomationRoleArnSha256 = Get-StringSha256 `
        ([string](Get-RequiredValue $durableGuard "automationRoleArn"))
    $durableAutomationFailureRuleArnSha256 = Get-StringSha256 `
        ([string](Get-RequiredValue $durableGuard "automationFailureRuleArn"))
    $durableAutomationDocumentVersion = [string](Get-RequiredValue $durableGuard "automationDocumentVersion")
    if ($durableAutomationDocumentVersion -cne "1") {
        throw "The Database Insights lease does not pin the reviewed numeric Automation document version."
    }
    $durableAutomationDocumentContentSha256 = Assert-Sha256 `
        ([string](Get-RequiredValue $durableGuard "automationDocumentContentSha256")) `
        "databaseInsightsLease.durableRestoreGuard.automationDocumentContentSha256"
    $statusPath = "$receiptPath.status.json"
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
        throw "The Database Insights lease status journal is missing."
    }
    $watchdogPath = "$receiptPath.watchdog.json"
    if (-not (Test-Path -LiteralPath $watchdogPath -PathType Leaf)) {
        throw "The bounded Database Insights lease watchdog heartbeat is missing."
    }
    return [pscustomobject]@{
        Version=$version;ReceiptPath=$receiptPath;ReceiptSha256=$receiptSha256
        StatusPath=$statusPath;WatchdogPath=$watchdogPath
        DurableRestoreGuardVersion=$script:DatabaseInsightsDurableRestoreGuardVersion
        DurableRestoreGuardBindingSha256=$durableGuardBindingSha256
        DurableRestoreScheduleArnSha256=$durableScheduleArnSha256
        DurableRestoreTargetRoleArnSha256=$durableTargetRoleArnSha256
        DurableRestoreDeadLetterQueueArnSha256=$durableDeadLetterQueueArnSha256
        DurableRestoreAutomationDefinitionArnSha256=$durableAutomationDefinitionArnSha256
        DurableRestoreAutomationRoleArnSha256=$durableAutomationRoleArnSha256
        DurableRestoreAutomationFailureRuleArnSha256=$durableAutomationFailureRuleArnSha256
        DurableRestoreAutomationDocumentVersion=$durableAutomationDocumentVersion
        DurableRestoreAutomationDocumentContentSha256=$durableAutomationDocumentContentSha256
    }
}

function Get-DatabaseInsightsLeaseTimingEvidence {
    param(
        $Config,
        [string]$ValidatedExpiresAtUtc,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    $receiptPath = [string]$Config.DatabaseInsightsLease.ReceiptPath
    if ((Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
        [string]$Config.DatabaseInsightsLease.ReceiptSha256) {
        throw "The Database Insights lease receipt changed during timing validation."
    }
    Assert-DiagnosticPrivateFileAcl $receiptPath "databaseInsightsLease.receipt"
    $receiptDocument = $null
    try {
        $receiptDocument = [Text.Json.JsonDocument]::Parse((Get-Content -LiteralPath $receiptPath -Raw))
        $capturedAtText = $receiptDocument.RootElement.GetProperty("capturedAtUtc").GetString()
        $receiptExpiresAtText = $receiptDocument.RootElement.GetProperty("expiresAtUtc").GetString()
    }
    catch { throw "The Database Insights lease receipt must contain valid JSON string timing evidence." }
    finally { if ($null -ne $receiptDocument) { $receiptDocument.Dispose() } }
    try {
        $capturedAt = ConvertTo-ExactUtcDateTimeOffset $capturedAtText `
            "databaseInsightsLease.capturedAtUtc"
        $receiptExpiresAt = ConvertTo-ExactUtcDateTimeOffset $receiptExpiresAtText `
            "databaseInsightsLease.expiresAtUtc"
        $validatedExpiresAt = ConvertTo-ExactUtcDateTimeOffset $ValidatedExpiresAtUtc `
            "validated databaseInsightsLease.expiresAtUtc"
    }
    catch { throw "The Database Insights lease receipt has invalid UTC timing evidence." }
    $nowUtc = $Now.ToUniversalTime()
    if ($capturedAt -gt $nowUtc -or $receiptExpiresAt -ne $validatedExpiresAt) {
        throw "The Database Insights lease timing identity is inconsistent."
    }
    $acquisitionAgeSeconds = ($nowUtc - $capturedAt).TotalSeconds
    $remainingSeconds = ($receiptExpiresAt - $nowUtc).TotalSeconds
    if ($acquisitionAgeSeconds -gt $script:DatabaseInsightsLeaseMaximumAcquisitionAgeSeconds) {
        throw "The Database Insights lease is too old to authorize a fresh diagnostic traffic release."
    }
    if ($remainingSeconds -le $script:DatabaseInsightsLeaseRequiredRemainingSeconds) {
        throw "The Database Insights lease does not extend beyond traffic, PI publication, restoration, and safety headroom."
    }
    return [ordered]@{
        timingContractVersion="diagnostic-pi-lease-headroom-v1"
        maximumAcquisitionAgeSeconds=$script:DatabaseInsightsLeaseMaximumAcquisitionAgeSeconds
        acquisitionAgeSeconds=[math]::Round($acquisitionAgeSeconds,3)
        requiredRemainingSeconds=$script:DatabaseInsightsLeaseRequiredRemainingSeconds
        remainingSeconds=[math]::Round($remainingSeconds,3)
        trafficDurationSeconds=[int]($script:DiagnosticPlannedTrafficMilliseconds / 1000L)
        publicationDeadlineSeconds=$script:PerformanceInsightsStabilizationDeadlineMinutes * 60
        restorationTimeoutSeconds=$script:DatabaseInsightsLeaseRestoreTimeoutSeconds
        safetyMarginSeconds=$script:DatabaseInsightsLeaseSafetyMarginSeconds
        expiresAtUtc=$receiptExpiresAt.ToString("o")
        receiptSha256=[string]$Config.DatabaseInsightsLease.ReceiptSha256
        rawPathsPersisted=$false
    }
}

function Invoke-DatabaseInsightsLeaseController {
    param(
        $Config,
        [ValidateSet("Validate", "Restore")]
        [string]$LeaseMode
    )
    if (-not (Test-Path -LiteralPath $script:DatabaseInsightsLeaseScript -PathType Leaf)) {
        throw "The reviewed Database Insights lease controller is missing."
    }
    if ((Get-FileHash -LiteralPath $Config.DatabaseInsightsLease.ReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant() `
        -cne $Config.DatabaseInsightsLease.ReceiptSha256) {
        throw "The Database Insights lease receipt changed after diagnostic configuration validation."
    }
    $pwsh = (Get-Process -Id $PID).Path
    $output = @(& $pwsh -NoProfile -File $script:DatabaseInsightsLeaseScript `
        -Mode $LeaseMode `
        -DbInstanceIdentifier ([string]$Config.Resources.rdsInstanceId) `
        -ReceiptPath $Config.DatabaseInsightsLease.ReceiptPath `
        -ExpectedReceiptSha256 $Config.DatabaseInsightsLease.ReceiptSha256 `
        -Region ([string]$Config.Resources.region) `
        -ExpectedAccountId $script:ExpectedAccountId `
        -ExpectedRdsInstanceClass "db.t4g.medium" `
        -LeasePurpose "diagnostic" `
        -MaximumLeaseMinutes 90 2>&1)
    $leaseExitCode = $LASTEXITCODE
    if ($leaseExitCode -ne 0) {
        throw "Database Insights lease $LeaseMode failed; provider output was discarded."
    }
    try { $result = (($output -join "`n") | ConvertFrom-Json -Depth 40) }
    catch { throw "Database Insights lease $LeaseMode returned malformed JSON." }
    $expectedState = if ($LeaseMode -ceq "Validate") { "active_validated" } else { "restored" }
    $expectedDurableState = if ($LeaseMode -ceq "Validate") { "armed" } else { "removed" }
    if ([string](Get-Value $result "state" "") -cne $expectedState -or
        [string](Get-Value $result "receiptSha256" "").ToLowerInvariant() -cne $Config.DatabaseInsightsLease.ReceiptSha256 -or
        [string](Get-Value $result "receiptPathSha256" "") -cne (Get-StringSha256 $Config.DatabaseInsightsLease.ReceiptPath) -or
        [string](Get-Value $result "statusPathSha256" "") -cne (Get-StringSha256 $Config.DatabaseInsightsLease.StatusPath) -or
        [string](Get-Value $result "watchdogPathSha256" "") -cne (Get-StringSha256 $Config.DatabaseInsightsLease.WatchdogPath) -or
        [string](Get-Value $result "durableRestoreGuardVersion" "") -cne $Config.DatabaseInsightsLease.DurableRestoreGuardVersion -or
        [string](Get-Value $result "durableRestoreGuardBindingSha256" "") -cne $Config.DatabaseInsightsLease.DurableRestoreGuardBindingSha256 -or
        [string](Get-Value $result "durableRestoreGuardState" "") -cne $expectedDurableState -or
        (Get-Value $result "rawPathsPersisted" $true) -ne $false) {
        throw "Database Insights lease $LeaseMode did not return the exact bound receipt, journal, and state."
    }
    if (-not (Test-Path -LiteralPath $Config.DatabaseInsightsLease.StatusPath -PathType Leaf)) {
        throw "Database Insights lease $LeaseMode did not seal its status journal."
    }
    $leaseExpiresAt = [DateTimeOffset]::MinValue
    if ($LeaseMode -ceq "Validate" -and
        (-not [DateTimeOffset]::TryParse([string](Get-Value $result "expiresAtUtc" ""), [ref]$leaseExpiresAt) -or
        $leaseExpiresAt -le [DateTimeOffset]::UtcNow)) {
        throw "Database Insights lease validation did not return a live bounded expiration."
    }
    $timing = if ($LeaseMode -ceq "Validate") {
        Get-DatabaseInsightsLeaseTimingEvidence $Config $leaseExpiresAt.ToUniversalTime().ToString("o")
    } else { $null }
    $posture = Get-Value $result "posture" $null
    $restoredKmsKeyId = if($null -eq $posture){""}else{[string](Get-Value $posture "performanceInsightsKmsKeyId" "")}
    $restoredMonitoringInterval = if($null -eq $posture){-1}else{[int](Get-Value $posture "monitoringInterval" -1)}
    $restoredMonitoringRoleArn = if($null -eq $posture){""}else{[string](Get-Value $posture "monitoringRoleArn" "")}
    $restoredLogExports = if($null -eq $posture){@()}else{@(
        @(Get-Value $posture "enabledCloudwatchLogsExports" @()) |
            ForEach-Object { [string]$_ } | Sort-Object -Unique
    )}
    if ($LeaseMode -ceq "Restore" -and ($null -eq $posture -or
        [string](Get-Value $posture "databaseInsightsMode" "") -cne "standard" -or
        (Get-Value $posture "performanceInsightsEnabled" $false) -ne $true -or
        [int](Get-Value $posture "performanceInsightsRetentionPeriod" 0) -ne 7 -or
        [string]::IsNullOrWhiteSpace($restoredKmsKeyId) -or
        $restoredMonitoringInterval -lt 0 -or $restoredMonitoringInterval -gt 60 -or
        ($restoredMonitoringInterval -gt 0 -and [string]::IsNullOrWhiteSpace($restoredMonitoringRoleArn)) -or
        @($restoredLogExports | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or
        [string](Get-Value $posture "databaseResourceId" "") -cne $Config.HistoryFallbackSqlIdentity.DatabaseResourceId -or
        [string](Get-Value $posture "engineVersion" "") -cne $Config.HistoryFallbackSqlIdentity.EngineVersion)) {
        throw "Database Insights lease restoration did not prove the exact Standard/7 identity posture."
    }
    $durableScheduleArnSha256 = if($LeaseMode -ceq "Validate"){
        Assert-Sha256 ([string](Get-Value $result "durableRestoreScheduleArnSha256" "")) `
            "databaseInsightsLease.durableRestoreScheduleArnSha256"
    }else{$null}
    $durableTargetRoleArnSha256 = if($LeaseMode -ceq "Validate"){
        Assert-Sha256 ([string](Get-Value $result "durableRestoreTargetRoleArnSha256" "")) `
            "databaseInsightsLease.durableRestoreTargetRoleArnSha256"
    }else{$null}
    $durableDeadLetterQueueArnSha256 = if($LeaseMode -ceq "Validate"){
        Assert-Sha256 ([string](Get-Value $result "durableRestoreDeadLetterQueueArnSha256" "")) `
            "databaseInsightsLease.durableRestoreDeadLetterQueueArnSha256"
    }else{$null}
    $durableAutomationDefinitionArnSha256 = if($LeaseMode -ceq "Validate"){
        Assert-Sha256 ([string](Get-Value $result "durableRestoreAutomationDefinitionArnSha256" "")) `
            "databaseInsightsLease.durableRestoreAutomationDefinitionArnSha256"
    }else{$null}
    $durableAutomationRoleArnSha256 = if($LeaseMode -ceq "Validate"){
        Assert-Sha256 ([string](Get-Value $result "durableRestoreAutomationRoleArnSha256" "")) `
            "databaseInsightsLease.durableRestoreAutomationRoleArnSha256"
    }else{$null}
    $durableAutomationFailureRuleArnSha256 = if($LeaseMode -ceq "Validate"){
        Assert-Sha256 ([string](Get-Value $result "durableRestoreAutomationFailureRuleArnSha256" "")) `
            "databaseInsightsLease.durableRestoreAutomationFailureRuleArnSha256"
    }else{$null}
    $durableAutomationDocumentVersion = if($LeaseMode -ceq "Validate"){
        [string](Get-Value $result "durableRestoreAutomationDocumentVersion" "")
    }else{$null}
    $durableAutomationDocumentContentSha256 = if($LeaseMode -ceq "Validate"){
        Assert-Sha256 ([string](Get-Value $result "durableRestoreAutomationDocumentContentSha256" "")) `
            "databaseInsightsLease.durableRestoreAutomationDocumentContentSha256"
    }else{$null}
    if ($LeaseMode -ceq "Validate" -and (
        $durableScheduleArnSha256 -cne $Config.DatabaseInsightsLease.DurableRestoreScheduleArnSha256 -or
        $durableTargetRoleArnSha256 -cne $Config.DatabaseInsightsLease.DurableRestoreTargetRoleArnSha256 -or
        $durableDeadLetterQueueArnSha256 -cne $Config.DatabaseInsightsLease.DurableRestoreDeadLetterQueueArnSha256 -or
        $durableAutomationDefinitionArnSha256 -cne $Config.DatabaseInsightsLease.DurableRestoreAutomationDefinitionArnSha256 -or
        $durableAutomationRoleArnSha256 -cne $Config.DatabaseInsightsLease.DurableRestoreAutomationRoleArnSha256 -or
        $durableAutomationFailureRuleArnSha256 -cne $Config.DatabaseInsightsLease.DurableRestoreAutomationFailureRuleArnSha256 -or
        $durableAutomationDocumentVersion -cne $Config.DatabaseInsightsLease.DurableRestoreAutomationDocumentVersion -or
        $durableAutomationDocumentContentSha256 -cne $Config.DatabaseInsightsLease.DurableRestoreAutomationDocumentContentSha256)) {
        throw "Database Insights lease validation did not prove the receipt-bound durable schedule, Automation, roles, failure rule, and DLQ."
    }
    return [ordered]@{
        leaseVersion=$script:DatabaseInsightsLeaseVersion;state=$expectedState
        receiptSha256=$Config.DatabaseInsightsLease.ReceiptSha256
        receiptPathSha256=(Get-StringSha256 $Config.DatabaseInsightsLease.ReceiptPath)
        statusPathSha256=(Get-StringSha256 $Config.DatabaseInsightsLease.StatusPath)
        watchdogPathSha256=(Get-StringSha256 $Config.DatabaseInsightsLease.WatchdogPath)
        watchdogHeartbeatSha256=if($LeaseMode -ceq "Validate"){[string](Get-Value $result "watchdogHeartbeatSha256" "")}else{$null}
        durableRestoreGuardVersion=$Config.DatabaseInsightsLease.DurableRestoreGuardVersion
        durableRestoreGuardBindingSha256=$Config.DatabaseInsightsLease.DurableRestoreGuardBindingSha256
        durableRestoreScheduleArnSha256=if($LeaseMode -ceq "Validate"){$Config.DatabaseInsightsLease.DurableRestoreScheduleArnSha256}else{$null}
        durableRestoreTargetRoleArnSha256=if($LeaseMode -ceq "Validate"){$Config.DatabaseInsightsLease.DurableRestoreTargetRoleArnSha256}else{$null}
        durableRestoreDeadLetterQueueArnSha256=if($LeaseMode -ceq "Validate"){$Config.DatabaseInsightsLease.DurableRestoreDeadLetterQueueArnSha256}else{$null}
        durableRestoreAutomationDefinitionArnSha256=if($LeaseMode -ceq "Validate"){$Config.DatabaseInsightsLease.DurableRestoreAutomationDefinitionArnSha256}else{$null}
        durableRestoreAutomationRoleArnSha256=if($LeaseMode -ceq "Validate"){$Config.DatabaseInsightsLease.DurableRestoreAutomationRoleArnSha256}else{$null}
        durableRestoreAutomationFailureRuleArnSha256=if($LeaseMode -ceq "Validate"){$Config.DatabaseInsightsLease.DurableRestoreAutomationFailureRuleArnSha256}else{$null}
        durableRestoreAutomationDocumentVersion=if($LeaseMode -ceq "Validate"){$Config.DatabaseInsightsLease.DurableRestoreAutomationDocumentVersion}else{$null}
        durableRestoreAutomationDocumentContentSha256=if($LeaseMode -ceq "Validate"){$Config.DatabaseInsightsLease.DurableRestoreAutomationDocumentContentSha256}else{$null}
        durableRestoreGuardState=$expectedDurableState
        statusSha256=(Get-FileHash -LiteralPath $Config.DatabaseInsightsLease.StatusPath -Algorithm SHA256).Hash.ToLowerInvariant()
        expiresAtUtc=if($LeaseMode -ceq "Validate"){$leaseExpiresAt.ToUniversalTime().ToString("o")}else{$null}
        timing=if($LeaseMode -ceq "Validate"){$timing}else{$null}
        posture=if($LeaseMode -ceq "Restore"){
            [ordered]@{databaseInsightsMode="standard";performanceInsightsEnabled=$true;
                performanceInsightsRetentionPeriod=7;databaseResourceIdSha256=(Get-StringSha256 ([string]$posture.databaseResourceId));
                performanceInsightsKmsKeyIdSha256=(Get-StringSha256 $restoredKmsKeyId);
                monitoringInterval=$restoredMonitoringInterval;
                monitoringRoleArnSha256=if($restoredMonitoringRoleArn){Get-StringSha256 $restoredMonitoringRoleArn}else{$null};
                enabledCloudwatchLogsExports=$restoredLogExports;
                engineVersion=[string]$posture.engineVersion;instanceClass=[string]$posture.instanceClass;status=[string]$posture.status}
        }else{$null}
        rawPathsPersisted=$false;rawProviderOutputPersisted=$false
    }
}

function Get-HarnessArtifactPath {
    param($Config, [string]$Kind)
    return [string](@($Config.HarnessArtifacts | Where-Object kind -eq $Kind)[0].path)
}

function Get-HarnessEnvironment {
    param($Config, [string]$ProgressPath, [string]$SummaryPath, [string]$ReadyPath = "", [string]$StartGatePath = "")
    $environment = @{
        LOAD_BASE_URL=$Config.BaseUrl; LOAD_RUN_ID=$Config.RunId; LOAD_STAGE="800"; LOAD_DIAGNOSTIC_ONLY="true"
        LOAD_DEVICE_MANIFEST=(Get-HarnessArtifactPath $Config "device-manifest")
        LOAD_TEACHER_AUTH_FILE=(Get-HarnessArtifactPath $Config "teacher-auth")
        LOAD_COMMAND_BODIES_FILE=(Get-HarnessArtifactPath $Config "command-bodies")
        LOAD_DEVICE_COUNT="810"; LOAD_DURATION_SECONDS="1800"; LOAD_SCREENSHOT_PROFILE="standard"; LOAD_SCREENSHOT_BYTES="40960"
        LOAD_HEARTBEAT_INTERVAL_MS="10000"; LOAD_SCREENSHOT_INTERVAL_MS="30000"; LOAD_TEACHER_INTERVAL_MS="5000"
        LOAD_TEACHER_TEMPLATE_INTERVAL_MS="30000"; LOAD_TEACHER_TEMPLATE_DEVICE_COUNT="0"
        LOAD_TEACHER_HISTORY_WARMUP_MS="25000"; LOAD_SCREENSHOT_GET_INTERVAL_MS="30000"; LOAD_SCREENSHOT_GET_WARMUP_MS="45000"
        LOAD_TILE_HISTORY_PATH="/api/classpilot/tiles/history"; LOAD_TILE_SCREENSHOTS_PATH="/api/classpilot/tiles/screenshots"
        LOAD_WORKLOAD_SCHEMA_VERSION=$script:WorkloadSchemaVersion; LOAD_TEACHER_PATHS="/api/students-aggregated"
        LOAD_DASHBOARD_PATHS=""; LOAD_SCREENSHOT_GET_PATH_TEMPLATE=""
        LOAD_COMMAND_ENDPOINT="/api/classpilot/commands"; LOAD_EXPECTED_CLASS_BODIES="20"; LOAD_EXPECTED_TARGETS_PER_CLASS="40"
        LOAD_COMMAND_WARMUP_MS="30000"; LOAD_COMMAND_INTERVAL_MS="30000"; LOAD_COMMAND_SETTLE_MS="5000"
        LOAD_FORCE_RECONNECT_AT_SECONDS="120"; LOAD_FORCE_RECONNECT_STAGGER_MS="30000"
        LOAD_EXPECTED_CANARY_DEVICES="10"; LOAD_WAF_DEVICE_LIMIT="100000"; LOAD_WAF_GENERAL_LIMIT="50000"
        LOAD_SHARED_IP_LABEL="single-generator-egress"; LOAD_GATE_PROFILE="launch"; LOAD_ENFORCE_THRESHOLDS="true"
        LOAD_EXTERNAL_PROGRESS_PATH=$ProgressPath; LOAD_EXTERNAL_SUMMARY_PATH=$SummaryPath
    }
    if ($ReadyPath) {
        $environment.LOAD_SUPERVISOR_READY_PATH=$ReadyPath
        $environment.LOAD_SUPERVISOR_START_GATE_PATH=$StartGatePath
        $environment.LOAD_SUPERVISOR_START_GATE_TIMEOUT_MS="300000"
    }
    return $environment
}

function Get-ValidationScratchPaths {
    param($Config)
    $scratchRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not (Test-Path -LiteralPath $scratchRoot -PathType Container)) {
        throw "The operating-system validation scratch directory must already exist."
    }
    $nonce = [Guid]::NewGuid().ToString("N")
    $prefix = "schoolpilot-$($Config.RunId)-validate-$nonce"
    $progressPath = Resolve-ExternalPath (Join-Path $scratchRoot "$prefix-progress.jsonl") "validationScratch.progress" -AllowMissing
    $summaryPath = Resolve-ExternalPath (Join-Path $scratchRoot "$prefix-summary.json") "validationScratch.summary" -AllowMissing
    foreach ($path in @($progressPath, $summaryPath)) {
        if (Test-Path -LiteralPath $path) { throw "A supposedly fresh validation scratch path already exists." }
    }
    return [ordered]@{ProgressPath=$progressPath;SummaryPath=$summaryPath}
}

function Invoke-HarnessPreflight {
    param($Config, [string]$ProgressPath, [string]$SummaryPath, [switch]$PersistReceipt)
    $node = (Get-Command node -ErrorAction Stop).Source
    $stdout = Join-Path $Config.EvidenceDirectory "$($Config.RunId)-harness-preflight.stdout.log"
    $stderr = Join-Path $Config.EvidenceDirectory "$($Config.RunId)-harness-preflight.stderr.log"
    if ($PersistReceipt -and ((Test-Path -LiteralPath $stdout) -or (Test-Path -LiteralPath $stderr))) {
        throw "Diagnostic harness preflight evidence already exists for this run."
    }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $node
    [void]$startInfo.ArgumentList.Add($script:HarnessScript)
    [void]$startInfo.ArgumentList.Add("--validate-config")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($entry in (Get-HarnessEnvironment $Config $ProgressPath $SummaryPath).GetEnumerator()) {
        $startInfo.Environment[[string]$entry.Key] = [string]$entry.Value
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "Unable to launch the diagnostic harness preflight." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdoutText = $stdoutTask.GetAwaiter().GetResult()
        $stderrText = $stderrTask.GetAwaiter().GetResult()
        $preflightExitCode = $process.ExitCode
    }
    finally { $process.Dispose() }
    if ($preflightExitCode -ne 0) { throw "The exact diagnostic harness configuration failed preflight: $($stderrText.Trim())" }
    if ($PersistReceipt) {
        [IO.File]::WriteAllText($stdout, $stdoutText, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($stderr, $stderrText, [Text.UTF8Encoding]::new($false))
    }
    try { $receipt = $stdoutText | ConvertFrom-Json -Depth 30 }
    catch { throw "The diagnostic harness preflight receipt was invalid." }
    if ($receipt.ok -ne $true -or $receipt.trafficStarted -ne $false -or $receipt.diagnosticOnly -ne $true -or
        $receipt.certificationEligible -ne $false -or [int]$receipt.launchContract.totalSockets -ne 810 -or
        [int]$receipt.launchContract.primaryDevices -ne 800 -or [int]$receipt.launchContract.canaryDevices -ne 10 -or
        [int]$receipt.launchContract.durationSeconds -ne 1800 -or [int]$receipt.launchContract.teacherTileCohorts -ne 20 -or
        [int]$receipt.launchContract.teacherTileAssignments -ne 800 -or
        [string]$receipt.workloadSchemaVersion -cne $script:WorkloadSchemaVersion -or
        [string]$receipt.workloadEndpointShapeSha256 -cne $script:EndpointShapeSha256) {
        throw "Harness preflight did not prove the exact non-certifying Waf/800 batch contract."
    }
    return [ordered]@{
        persisted=[bool]$PersistReceipt
        path=if($PersistReceipt){$stdout}else{$null}
        sha256=Get-StringSha256 $stdoutText
    }
}

function Resolve-ApiAwslogsBinding {
    param($TaskDefinition, [string]$ExpectedTaskDefinitionArn, [string]$ExpectedRegion)
    if ($null -eq $TaskDefinition -or [string]$TaskDefinition.taskDefinitionArn -cne $ExpectedTaskDefinitionArn) {
        throw "The API awslogs binding did not come from the exact bound task definition."
    }
    $containers = @($TaskDefinition.containerDefinitions | Where-Object name -eq "api")
    if ($containers.Count -ne 1) {
        throw "The exact bound API task definition must contain one api container for log evidence."
    }
    $configuration = Get-Value $containers[0] "logConfiguration"
    $options = Get-Value $configuration "options"
    $logGroup = [string](Get-Value $options "awslogs-group" "")
    $logRegion = [string](Get-Value $options "awslogs-region" "")
    $logPrefix = [string](Get-Value $options "awslogs-stream-prefix" "")
    if ([string](Get-Value $configuration "logDriver" "") -cne "awslogs" -or
        $logGroup -cne "/ecs/schoolpilot-production-api" -or $logRegion -cne $ExpectedRegion -or
        $logPrefix -cne "api" -or $logGroup -notmatch '^[A-Za-z0-9_.\-/#]+$' -or
        $logPrefix -notmatch '^[A-Za-z0-9_.\-/#]+$') {
        throw "The exact bound API task definition does not use the reviewed production awslogs binding."
    }
    return [pscustomobject]@{
        TaskDefinitionArn=$ExpectedTaskDefinitionArn
        LogDriver="awslogs"
        LogGroup=$logGroup
        LogRegion=$logRegion
        LogPrefix=$logPrefix
        ApiStreamPrefix="$logPrefix/api/"
    }
}

function Get-BoundApiAwslogsBinding {
    param($Config)
    $response = Invoke-AwsJson @("ecs","describe-task-definition","--region",$script:ExpectedRegion,
        "--task-definition",$Config.ApiTaskDefinitionArn)
    return Resolve-ApiAwslogsBinding $response.taskDefinition $Config.ApiTaskDefinitionArn $script:ExpectedRegion
}

function Get-TaskDefinitionPosture {
    param([string]$Arn, [string]$ContainerName, [string]$ExpectedDigest, [string]$ExpectedCpu, [string]$ExpectedMemory)
    $response = Invoke-AwsJson @("ecs","describe-task-definition","--region",$script:ExpectedRegion,"--task-definition",$Arn)
    $definition = $response.taskDefinition
    $containers = @($definition.containerDefinitions | Where-Object name -eq $ContainerName)
    if ($containers.Count -ne 1 -or [string]$definition.taskDefinitionArn -ne $Arn -or
        [string]$definition.cpu -ne $ExpectedCpu -or [string]$definition.memory -ne $ExpectedMemory) {
        throw "Task definition $Arn does not match its exact reviewed CPU, memory, and container identity."
    }
    $image = [string]$containers[0].image
    if ($image -notmatch '@(sha256:[0-9a-f]{64})$' -or $Matches[1].ToLowerInvariant() -cne $ExpectedDigest) {
        throw "Task definition $Arn is not pinned to the bound deployed image digest."
    }
    $logging = $null
    if ($ContainerName -ceq "api") {
        $binding = Resolve-ApiAwslogsBinding $definition $Arn $script:ExpectedRegion
        $logging = [ordered]@{
            driver=$binding.LogDriver;region=$binding.LogRegion
            logGroupSha256=(Get-StringSha256 $binding.LogGroup)
            streamPrefixSha256=(Get-StringSha256 $binding.ApiStreamPrefix)
            rawIdentifiersPersisted=$false
        }
    }
    return [ordered]@{arn=$Arn;containerName=$ContainerName;cpu=[string]$definition.cpu;memory=[string]$definition.memory;
        imageDigest=$ExpectedDigest;logging=$logging}
}

function Get-ScalingSnapshot {
    param($Config)
    $r = $Config.Resources
    $resourceId = "service/$($r.cluster)/$($r.apiService)"
    $targets = Invoke-AwsJson @("application-autoscaling","describe-scalable-targets","--region",$r.region,
        "--service-namespace","ecs","--resource-ids",$resourceId,"--scalable-dimension","ecs:service:DesiredCount")
    $target = @($targets.ScalableTargets)
    if ($target.Count -ne 1) { throw "The API scalable target was not uniquely resolved." }
    $suspended = Get-Value $target[0] "SuspendedState"
    $scheduledResponse = Invoke-AwsJson @("application-autoscaling","describe-scheduled-actions","--region",$r.region,
        "--service-namespace","ecs","--resource-id",$resourceId,"--scalable-dimension","ecs:service:DesiredCount")
    $scheduled = @($scheduledResponse.ScheduledActions | Sort-Object ScheduledActionName | ForEach-Object {
        [ordered]@{name=[string]$_.ScheduledActionName;schedule=[string]$_.Schedule;timezone=[string]$_.Timezone;
            minCapacity=Get-Value $_.ScalableTargetAction "MinCapacity";maxCapacity=Get-Value $_.ScalableTargetAction "MaxCapacity"}
    })
    $policiesResponse = Invoke-AwsJson @("application-autoscaling","describe-scaling-policies","--region",$r.region,
        "--service-namespace","ecs","--resource-id",$resourceId,"--scalable-dimension","ecs:service:DesiredCount")
    $policies = @($policiesResponse.ScalingPolicies | Sort-Object PolicyName | ForEach-Object {
        [ordered]@{name=[string]$_.PolicyName;type=[string]$_.PolicyType;targetTracking=$_.TargetTrackingScalingPolicyConfiguration}
    })
    return [ordered]@{
        resourceId=$resourceId;minCapacity=[int]$target[0].MinCapacity;maxCapacity=[int]$target[0].MaxCapacity
        suspendedState=[ordered]@{
            DynamicScalingInSuspended=[bool](Get-Value $suspended "DynamicScalingInSuspended" $false)
            DynamicScalingOutSuspended=[bool](Get-Value $suspended "DynamicScalingOutSuspended" $false)
            ScheduledScalingSuspended=[bool](Get-Value $suspended "ScheduledScalingSuspended" $false)
        }
        scheduledActions=$scheduled;scheduledActionsSha256=(Get-StableJsonSha256 $scheduled)
        scalingPoliciesSha256=(Get-StableJsonSha256 $policies)
    }
}

function Get-ServicePosture {
    param($Config)
    $r = $Config.Resources
    $response = Invoke-AwsJson @("ecs","describe-services","--region",$r.region,"--cluster",$r.cluster,
        "--services",$r.apiService,$r.workerService)
    $services = @($response.services)
    if ($services.Count -ne 2) { throw "Both production ECS services must exist." }
    $result = @{}
    foreach ($binding in @(@("api",[string]$r.apiService,$Config.ApiTaskDefinitionArn),@("worker",[string]$r.workerService,$Config.WorkerTaskDefinitionArn))) {
        $service = @($services | Where-Object serviceName -eq $binding[1])
        if ($service.Count -ne 1 -or [string]$service[0].taskDefinition -ne [string]$binding[2] -or
            [int]$service[0].desiredCount -lt 1 -or [int]$service[0].runningCount -ne [int]$service[0].desiredCount -or
            [int]$service[0].pendingCount -ne 0 -or @($service[0].deployments).Count -ne 1 -or
            [string]$service[0].deployments[0].rolloutState -ne "COMPLETED") {
            throw "The $($binding[0]) service is not stable on its exact bound task definition."
        }
        $network = $service[0].networkConfiguration.awsvpcConfiguration
        $subnets = @($network.subnets | ForEach-Object { [string]$_ } | Sort-Object)
        $expectedSubnets = @($r.ecsTaskSubnetIds | ForEach-Object { [string]$_ } | Sort-Object)
        if ([string]$network.assignPublicIp -ne "DISABLED" -or @(Compare-Object $subnets $expectedSubnets).Count -ne 0) {
            throw "The $($binding[0]) service is not in the exact private ECS/NAT posture."
        }
        $result[$binding[0]] = [ordered]@{desired=[int]$service[0].desiredCount;running=[int]$service[0].runningCount;
            pending=[int]$service[0].pendingCount;taskDefinitionArn=[string]$service[0].taskDefinition;assignPublicIp="DISABLED";subnets=$subnets}
    }
    return [ordered]@{api=$result.api;worker=$result.worker}
}

function Get-TargetHealthSnapshot {
    param($Config)
    $response = Invoke-AwsJson @("elbv2","describe-target-health","--region",$Config.Resources.region,
        "--target-group-arn",$Config.Resources.targetGroupArn)
    $descriptions = @($response.TargetHealthDescriptions)
    $states = @($descriptions | ForEach-Object { [string](Get-Value $_.TargetHealth "State" "") })
    $healthy = @($states | Where-Object { $_ -eq "healthy" }).Count
    $initial = @($states | Where-Object { $_ -eq "initial" }).Count
    $draining = @($states | Where-Object { $_ -eq "draining" }).Count
    $prohibited = @($states | Where-Object { $_ -notin @("healthy","initial","draining") })
    return [ordered]@{
        total=$states.Count;healthy=$healthy;nonHealthy=($states.Count - $healthy);initial=$initial;draining=$draining
        prohibited=$prohibited.Count;states=@($states | Sort-Object)
    }
}

function Wait-TargetHealthConvergence {
    param(
        $Config,
        [int]$DesiredHealthyCount,
        [Parameter(Mandatory = $true)]
        [ValidateSet("initial","draining")]
        [string[]]$AllowedTransitionalStates,
        [int]$TimeoutSeconds = $script:TargetHealthConvergenceTimeoutSeconds,
        [int]$PollSeconds = $script:TargetHealthPollSeconds
    )
    if ($DesiredHealthyCount -lt 1) { throw "Target-health convergence requires at least one desired healthy target." }
    if ($TimeoutSeconds -lt 0 -or $PollSeconds -lt 0) { throw "Target-health convergence bounds must not be negative." }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $snapshot = Get-TargetHealthSnapshot $Config
        $prohibitedStates = @($snapshot.states | Where-Object { $_ -ne "healthy" -and $_ -notin $AllowedTransitionalStates })
        if ($prohibitedStates.Count -gt 0) {
            throw "Target-health convergence observed a prohibited non-transitional state: $($snapshot.states -join ',')."
        }
        if ([int]$snapshot.total -eq $DesiredHealthyCount -and [int]$snapshot.healthy -eq $DesiredHealthyCount -and
            [int]$snapshot.nonHealthy -eq 0) {
            return $snapshot
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            throw "Target health did not converge to exactly $DesiredHealthyCount healthy targets before the bounded timeout; observed $($snapshot.states -join ',')."
        }
        Start-Sleep -Seconds $PollSeconds
    } while ($true)
}

function Get-HealthyTargetCount {
    param($Config)
    $snapshot = Get-TargetHealthSnapshot $Config
    if ([int]$snapshot.nonHealthy -gt 0) {
        throw "The API target group contains a non-healthy target."
    }
    return [int]$snapshot.healthy
}

function Get-WafLabelMatch {
    param($Statement)
    $label = Get-Value $Statement "LabelMatchStatement"
    if ($null -eq $label -or [string](Get-Value $label "Scope" "") -cne "LABEL") { return $null }
    $key = [string](Get-Value $label "Key" "")
    if ($key -cne "device-ingest") { return $null }
    return $label
}

function Assert-WafDeviceIngestClassifierContract {
    param([object[]]$Rules, [string]$MetricName)
    $matches = @($Rules | Where-Object Name -eq "DeviceIngestClassifier")
    if ($matches.Count -ne 1) { throw "WAF must contain exactly one DeviceIngestClassifier rule." }
    $rule = $matches[0]
    $action = Get-Value $rule "Action"
    $actionNames = @(if ($null -eq $action) { @() } else { @($action.PSObject.Properties.Name) })
    $countAction = Get-Value $action "Count"
    $statement = Get-Value $rule "Statement"
    $statementNames = @(if ($null -eq $statement) { @() } else { @($statement.PSObject.Properties.Name) })
    $and = Get-Value $statement "AndStatement"
    $statements = @((Get-Value $and "Statements" @()))
    $visibility = Get-Value $rule "VisibilityConfig"
    $labels = @((Get-Value $rule "RuleLabels" @()))
    if ($actionNames.Count -ne 1 -or [string]$actionNames[0] -cne "Count" -or $null -eq $countAction -or
        @($countAction.PSObject.Properties).Count -ne 0 -or [int](Get-Value $rule "Priority" -1) -ne 25 -or
        $statementNames.Count -ne 1 -or [string]$statementNames[0] -cne "AndStatement" -or
        $null -eq $and -or $statements.Count -ne 2 -or $labels.Count -ne 1 -or
        [string](Get-Value $labels[0] "Name" "") -cne "device-ingest" -or
        [string](Get-Value $visibility "MetricName" "") -cne $MetricName -or
        (Get-Value $visibility "CloudWatchMetricsEnabled" $false) -ne $true -or
        (Get-Value $visibility "SampledRequestsEnabled" $false) -ne $true) {
        throw "DeviceIngestClassifier must retain its exact priority-25 COUNT, device-ingest label, AND statement, and metric contract."
    }

    $byteStatements = @($statements | ForEach-Object { Get-Value $_ "ByteMatchStatement" } | Where-Object { $null -ne $_ })
    $regexStatements = @($statements | ForEach-Object { Get-Value $_ "RegexMatchStatement" } | Where-Object { $null -ne $_ })
    if ($byteStatements.Count -ne 1 -or $regexStatements.Count -ne 1) {
        throw "DeviceIngestClassifier must contain exactly one method match and one URI-path regex match."
    }
    $byte = $byteStatements[0]
    $byteField = Get-Value $byte "FieldToMatch"
    $byteFieldNames = @(if ($null -eq $byteField) { @() } else { @($byteField.PSObject.Properties.Name) })
    $byteTransforms = @((Get-Value $byte "TextTransformations" @()))
    if ([string](Get-Value $byte "SearchString" "") -notin @("POST", "UE9TVA==") -or
        $byteFieldNames.Count -ne 1 -or [string]$byteFieldNames[0] -cne "Method" -or
        $null -eq (Get-Value $byteField "Method") -or
        [string](Get-Value $byte "PositionalConstraint" "") -cne "EXACTLY" -or
        $byteTransforms.Count -ne 1 -or [int](Get-Value $byteTransforms[0] "Priority" -1) -ne 0 -or
        [string](Get-Value $byteTransforms[0] "Type" "") -cne "NONE") {
        throw "DeviceIngestClassifier must match the exact POST method with no text transformation."
    }

    $regex = $regexStatements[0]
    $regexField = Get-Value $regex "FieldToMatch"
    $regexFieldNames = @(if ($null -eq $regexField) { @() } else { @($regexField.PSObject.Properties.Name) })
    $regexTransforms = @((Get-Value $regex "TextTransformations" @()))
    if ([string](Get-Value $regex "RegexString" "") -cne '^/api/(classpilot/)?device/(heartbeat|screenshot)$' -or
        $regexFieldNames.Count -ne 1 -or [string]$regexFieldNames[0] -cne "UriPath" -or
        $null -eq (Get-Value $regexField "UriPath") -or
        $regexTransforms.Count -ne 1 -or [int](Get-Value $regexTransforms[0] "Priority" -1) -ne 0 -or
        [string](Get-Value $regexTransforms[0] "Type" "") -cne "NONE") {
        throw "DeviceIngestClassifier must match the exact reviewed device-ingest URI regex with no text transformation."
    }
    return [ordered]@{name="DeviceIngestClassifier";priority=25;action="COUNT";label="device-ingest";
        metricName=$MetricName;statementSha256=(Get-StableJsonSha256 $statement)}
}

function Assert-WafRateRuleContract {
    param([object[]]$Rules, [string]$DeviceMetricName, [string]$ApiMetricName)
    $contracts = @(
        [pscustomobject]@{Name="DeviceIngestRateLimit";Priority=30;Limit=100000;Metric=$DeviceMetricName},
        [pscustomobject]@{Name="ApiRateLimit";Priority=40;Limit=50000;Metric=$ApiMetricName}
    )
    $validated = @{}
    foreach ($contract in $contracts) {
        $matches = @($Rules | Where-Object Name -eq $contract.Name)
        if ($matches.Count -ne 1) { throw "WAF must contain exactly one $($contract.Name) rule." }
        $rule = $matches[0]
        $action = Get-Value $rule "Action"
        $actionNames = @(if ($null -eq $action) { @() } else { @($action.PSObject.Properties.Name) })
        $visibility = Get-Value $rule "VisibilityConfig"
        $rate = Get-Value (Get-Value $rule "Statement") "RateBasedStatement"
        $scope = Get-Value $rate "ScopeDownStatement"
        if ($actionNames.Count -ne 1 -or [string]$actionNames[0] -cne "Block" -or
            [int](Get-Value $rule "Priority" -1) -ne $contract.Priority -or $null -eq $rate -or
            [int](Get-Value $rate "Limit" -1) -ne $contract.Limit -or
            [int](Get-Value $rate "EvaluationWindowSec" 300) -ne 300 -or
            [string](Get-Value $rate "AggregateKeyType" "") -cne "IP" -or $null -eq $scope -or
            [string](Get-Value $visibility "MetricName" "") -cne $contract.Metric -or
            (Get-Value $visibility "CloudWatchMetricsEnabled" $false) -ne $true -or
            (Get-Value $visibility "SampledRequestsEnabled" $false) -ne $true) {
            throw "$($contract.Name) must retain its exact BLOCK, priority, IP/5-minute limit, scope, and metric contract."
        }
        $validated[$contract.Name] = [pscustomobject]@{rule=$rule;rate=$rate;scope=$scope;contract=$contract}
    }

    $deviceLabel = Get-WafLabelMatch $validated.DeviceIngestRateLimit.scope
    if ($null -eq $deviceLabel) { throw "DeviceIngestRateLimit must remain scoped to the device-ingest classifier label." }
    $and = Get-Value $validated.ApiRateLimit.scope "AndStatement"
    $statements = @((Get-Value $and "Statements" @()))
    if ($null -eq $and -or $statements.Count -ne 2) {
        throw "ApiRateLimit must retain its exact API-path/non-device scope."
    }
    $byteStatements = @($statements | ForEach-Object { Get-Value $_ "ByteMatchStatement" } | Where-Object { $null -ne $_ })
    $notStatements = @($statements | ForEach-Object { Get-Value $_ "NotStatement" } | Where-Object { $null -ne $_ })
    if ($byteStatements.Count -ne 1 -or $notStatements.Count -ne 1) {
        throw "ApiRateLimit must retain one API-path match and one device-label exclusion."
    }
    $byte = $byteStatements[0]
    $search = [string](Get-Value $byte "SearchString" "")
    $transforms = @((Get-Value $byte "TextTransformations" @()))
    $uriPath = Get-Value (Get-Value $byte "FieldToMatch") "UriPath"
    $excludedLabel = Get-WafLabelMatch (Get-Value $notStatements[0] "Statement")
    if ($search -notin @("/api/", "L2FwaS8=") -or $null -eq $uriPath -or
        [string](Get-Value $byte "PositionalConstraint" "") -cne "STARTS_WITH" -or
        $transforms.Count -ne 1 -or [int](Get-Value $transforms[0] "Priority" -1) -ne 0 -or
        [string](Get-Value $transforms[0] "Type" "") -cne "NONE" -or $null -eq $excludedLabel -or
        [string](Get-Value $excludedLabel "Key" "") -cne [string](Get-Value $deviceLabel "Key" "")) {
        throw "ApiRateLimit must remain scoped to /api/ while excluding the exact device-ingest label."
    }
    return @($contracts | ForEach-Object {
        $entry = $validated[$_.Name]
        [ordered]@{name=$_.Name;priority=$_.Priority;action="BLOCK";limit=$_.Limit;evaluationWindowSeconds=300;
            aggregateKeyType="IP";metricName=$_.Metric;scopeDownStatementSha256=(Get-StableJsonSha256 $entry.scope)}
    })
}

function Assert-RedisReplicationIdentity {
    param($ReplicationGroup, $CacheCluster, $Resources, [string]$ExpectedNodeType = "cache.t4g.small")
    $memberIds = @((Get-Value $ReplicationGroup "MemberClusters" @()) | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    if ([string](Get-Value $ReplicationGroup "ReplicationGroupId" "") -cne [string]$Resources.redisReplicationGroupId -or
        [string](Get-Value $ReplicationGroup "Status" "") -cne "available" -or
        [string](Get-Value $ReplicationGroup "CacheNodeType" "") -cne $ExpectedNodeType -or
        [string]$Resources.redisCacheClusterId -notin $memberIds -or
        [string](Get-Value $CacheCluster "CacheClusterId" "") -cne [string]$Resources.redisCacheClusterId -or
        [string](Get-Value $CacheCluster "ReplicationGroupId" "") -cne [string]$Resources.redisReplicationGroupId -or
        [string](Get-Value $CacheCluster "CacheClusterStatus" "") -cne "available" -or
        [string](Get-Value $CacheCluster "CacheNodeType" "") -cne $ExpectedNodeType) {
        throw "redisCacheClusterId must be an available $ExpectedNodeType member of the exact validated replication group."
    }
    return [ordered]@{replicationGroupId=[string]$Resources.redisReplicationGroupId;groupStatus="available";
        groupNodeType=$ExpectedNodeType;memberClusterIds=$memberIds;cacheClusterId=[string]$Resources.redisCacheClusterId;
        clusterStatus="available";clusterNodeType=$ExpectedNodeType;clusterReplicationGroupId=[string]$Resources.redisReplicationGroupId}
}

function Get-DiagnosticTrackIoTimingPosture {
    param($Instance, $Config)
    $groups = @((Get-Value $Instance "DBParameterGroups" @()))
    if ($groups.Count -ne 1 -or
        [string](Get-RequiredValue $groups[0] "ParameterApplyStatus") -cne "in-sync") {
        throw "RDS must use one in-sync database parameter group for track_io_timing evidence."
    }
    $groupName = [string](Get-RequiredValue $groups[0] "DBParameterGroupName")
    if ($groupName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$') {
        throw "RDS returned a malformed database parameter-group identity."
    }
    $pages = Invoke-EvidenceAwsJsonPages -Arguments @(
        "rds", "describe-db-parameters", "--region", $Config.Resources.region,
        "--db-parameter-group-name", $groupName,
        "--filters", "Name=parameter-name,Values=track_io_timing"
    ) -ItemsProperty "Parameters" -TokenProperty "Marker" -TokenArgument "--marker" -Identity {
        param($parameter)
        return [string](Get-Value $parameter "ParameterName" "")
    }
    $parameters = @($pages.Items)
    if ($parameters.Count -ne 1 -or
        [string](Get-RequiredValue $parameters[0] "ParameterName") -cne "track_io_timing") {
        throw "RDS did not return one exact track_io_timing parameter."
    }
    $value = ([string](Get-RequiredValue $parameters[0] "ParameterValue")).Trim().ToLowerInvariant()
    if ($value -notin @("1", "on", "true")) {
        throw "RDS effective track_io_timing must be enabled."
    }
    return [ordered]@{
        enabled=$true;parameterGroupSha256=(Get-StringSha256 $groupName)
        pageCount=$pages.PageCount;rawIdentifiersPersisted=$false
    }
}

function Get-AwsPosture {
    param(
        $Config,
        [ValidateSet("advanced", "standard")]
        [string]$ExpectedDatabaseInsightsMode = "advanced"
    )
    $r = $Config.Resources
    $caller = Invoke-AwsJson @("sts","get-caller-identity","--region",$r.region)
    if ([string]$caller.Account -ne $script:ExpectedAccountId) { throw "AWS CLI is not authenticated to the reviewed production account." }
    $services = Get-ServicePosture $Config
    $apiTask = Get-TaskDefinitionPosture $Config.ApiTaskDefinitionArn "api" $Config.ImageDigest "512" "2048"
    $workerTask = Get-TaskDefinitionPosture $Config.WorkerTaskDefinitionArn "scheduler-worker" $Config.ImageDigest "256" "512"
    $healthyTargets = Get-HealthyTargetCount $Config
    if ($healthyTargets -ne [int]$services.api.desired) { throw "Every and only desired API target must be healthy." }

    $rdsResponse = Invoke-AwsJson @("rds","describe-db-instances","--region",$r.region,"--db-instance-identifier",$r.rdsInstanceId)
    $rds = @($rdsResponse.DBInstances)
    if ($rds.Count -ne 1) { throw "The production RDS instance was not uniquely resolved." }
    $pendingRebootParameterGroups = @((Get-Value $rds[0] "DBParameterGroups" @()) |
        Where-Object { [string](Get-Value $_ "ParameterApplyStatus" "") -ceq "pending-reboot" })
    $expectedPerformanceInsightsRetention = if ($ExpectedDatabaseInsightsMode -ceq "advanced") { 465 } else { 7 }
    if ([string]$rds[0].DBInstanceClass -ne "db.t4g.medium" -or
        [string]$rds[0].DBInstanceStatus -ne "available" -or $rds[0].PubliclyAccessible -ne $false -or
        $rds[0].PerformanceInsightsEnabled -ne $true -or
        [string](Get-Value $rds[0] "DatabaseInsightsMode" "") -cne $ExpectedDatabaseInsightsMode -or
        [int](Get-Value $rds[0] "PerformanceInsightsRetentionPeriod" 0) -ne $expectedPerformanceInsightsRetention -or
        [string](Get-Value $rds[0] "DbiResourceId" "") -cne $Config.HistoryFallbackSqlIdentity.DatabaseResourceId -or
        [string](Get-Value $rds[0] "EngineVersion" "") -cne $Config.HistoryFallbackSqlIdentity.EngineVersion -or
        $pendingRebootParameterGroups.Count -ne 0) {
        throw "RDS must be available, private, reboot-free, $ExpectedDatabaseInsightsMode-Insights-enabled db.t4g.medium with the bound history SQL identity."
    }
    $trackIoTiming = Get-DiagnosticTrackIoTimingPosture $rds[0] $Config
    $redisResponse = Invoke-AwsJson @("elasticache","describe-replication-groups","--region",$r.region,
        "--replication-group-id",$r.redisReplicationGroupId)
    $redis = @($redisResponse.ReplicationGroups)
    if ($redis.Count -ne 1) { throw "The Redis replication group was not uniquely resolved." }
    $clusterResponse = Invoke-AwsJson @("elasticache","describe-cache-clusters","--region",$r.region,
        "--cache-cluster-id",$r.redisCacheClusterId,"--show-cache-node-info")
    $clusters = @($clusterResponse.CacheClusters)
    if ($clusters.Count -ne 1) { throw "The Redis cache cluster was not uniquely resolved." }
    $redisIdentity = Assert-RedisReplicationIdentity $redis[0] $clusters[0] $r "cache.t4g.small"
    $natResponse = Invoke-AwsJson @("ec2","describe-nat-gateways","--region",$r.region,"--filter",
        "Name=vpc-id,Values=$($r.vpcId)","Name=state,Values=available")
    if (@($natResponse.NatGateways).Count -ne 2) { throw "The diagnostic requires the existing two-NAT private ECS posture." }

    $wafList = Invoke-AwsJson @("wafv2","list-web-acls","--region",$r.region,"--scope","CLOUDFRONT")
    $wafMatch = @($wafList.WebACLs | Where-Object Name -eq ([string]$r.wafWebAclName))
    if ($wafMatch.Count -ne 1) { throw "The production CloudFront WAF was not uniquely resolved." }
    $waf = Invoke-AwsJson @("wafv2","get-web-acl","--region",$r.region,"--scope","CLOUDFRONT",
        "--name",$wafMatch[0].Name,"--id",$wafMatch[0].Id)
    $wafClassifier = Assert-WafDeviceIngestClassifierContract @($waf.WebACL.Rules) ([string]$r.wafDeviceClassifierMetricName)
    $wafRules = Assert-WafRateRuleContract @($waf.WebACL.Rules) ([string]$r.wafDeviceRuleMetricName) ([string]$r.wafApiRuleMetricName)
    $webAclArn = [string](Get-Value $waf.WebACL "ARN" "")
    if ($webAclArn -notmatch '^arn:aws:wafv2:us-east-1:135775632425:global/webacl/') {
        throw "The reviewed WAF must remain a production-account CloudFront-scope WebACL."
    }
    $distribution = Invoke-AwsJson @("cloudfront","get-distribution-config","--id",$r.cloudFrontDistributionId)
    $distributionConfig = Get-Value $distribution "DistributionConfig"
    $aliases = @((Get-Value (Get-Value $distributionConfig "Aliases") "Items" @()) | ForEach-Object { [string]$_ })
    if ([string](Get-Value $distributionConfig "WebACLId" "") -cne $webAclArn -or "school-pilot.net" -notin $aliases) {
        throw "The exact production CloudFront distribution is not associated with the reviewed WAF WebACL."
    }
    $associations = Invoke-AwsJson @("cloudfront","list-distributions-by-web-acl-id","--web-acl-id",$webAclArn)
    $associatedIds = @((Get-Value (Get-Value $associations "DistributionList") "Items" @()) |
        ForEach-Object { [string](Get-Value $_ "Id" "") } | Sort-Object -Unique)
    if ([string]$r.cloudFrontDistributionId -notin $associatedIds) {
        throw "CloudFront did not report the exact production distribution in the WebACL association set."
    }
    $scaling = Get-ScalingSnapshot $Config
    return [ordered]@{
        observedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");accountId=$script:ExpectedAccountId;region=$script:ExpectedRegion
        services=$services;taskDefinitions=[ordered]@{api=$apiTask;worker=$workerTask};healthyApiTargets=$healthyTargets
        rds=[ordered]@{instanceClass=[string]$rds[0].DBInstanceClass;status=[string]$rds[0].DBInstanceStatus;
            publiclyAccessible=[bool]$rds[0].PubliclyAccessible;performanceInsightsEnabled=[bool]$rds[0].PerformanceInsightsEnabled;
            databaseInsightsMode=[string]$rds[0].DatabaseInsightsMode
            performanceInsightsRetentionPeriod=[int]$rds[0].PerformanceInsightsRetentionPeriod
            pendingReboot=$false;trackIoTiming=$trackIoTiming
            dbiResourceIdSha256=(Get-StringSha256 ([string]$rds[0].DbiResourceId))}
        redis=$redisIdentity
        nat=[ordered]@{availableCount=2};waf=[ordered]@{scope="CLOUDFRONT";webAclName=[string]$r.wafWebAclName;
            webAclId=[string]$waf.WebACL.Id;webAclArn=$webAclArn;distributionId=[string]$r.cloudFrontDistributionId;
            associatedDistributionIds=$associatedIds;deviceIngestClassifier=$wafClassifier;rateRules=$wafRules}
        scaling=$scaling
    }
}

function Assert-NoScheduledBoundaryOverlap {
    param(
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow,
        [int]$WorstCaseLifecycleSeconds = $script:ScheduleBoundaryGuardSeconds
    )
    if ($WorstCaseLifecycleSeconds -lt 5400) {
        throw "The schedule guard must cover at least 90 minutes of mutation, readiness, monitoring, terminal validation, and restoration."
    }
    try { $zone = [TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time") }
    catch { $zone = [TimeZoneInfo]::FindSystemTimeZoneById("America/New_York") }
    $nowUtc = $NowUtc.ToUniversalTime()
    $endUtc = $nowUtc.AddSeconds($WorstCaseLifecycleSeconds)
    $localNow = [TimeZoneInfo]::ConvertTime($nowUtc, $zone)
    foreach ($offset in 0..2) {
        $date = $localNow.Date.AddDays($offset)
        if ($date.DayOfWeek -in @([DayOfWeek]::Saturday,[DayOfWeek]::Sunday)) { continue }
        foreach ($time in @([TimeSpan]::FromHours(5.75),[TimeSpan]::FromHours(10))) {
            $localBoundary = [DateTime]::SpecifyKind($date.Add($time), [DateTimeKind]::Unspecified)
            $boundaryUtc = [TimeZoneInfo]::ConvertTimeToUtc($localBoundary, $zone)
            if ($boundaryUtc -ge $nowUtc.UtcDateTime -and $boundaryUtc -le $endUtc.UtcDateTime) {
                throw "The conservative diagnostic mutation/readiness/monitor/terminal/restoration window would cross an existing 05:45 or 10:00 ET scaling boundary."
            }
        }
    }
}

function Set-ScalingTarget {
    param($Config, [int]$Minimum, [int]$Maximum, $SuspendedState)
    $stateJson = $SuspendedState | ConvertTo-Json -Compress
    Invoke-AwsCommand @("application-autoscaling","register-scalable-target","--region",$Config.Resources.region,
        "--service-namespace","ecs","--resource-id","service/$($Config.Resources.cluster)/$($Config.Resources.apiService)",
        "--scalable-dimension","ecs:service:DesiredCount","--min-capacity",[string]$Minimum,"--max-capacity",[string]$Maximum,
        "--suspended-state",$stateJson)
}

function Set-DiagnosticCapacity {
    param($Config)
    $held = [ordered]@{DynamicScalingInSuspended=$true;DynamicScalingOutSuspended=$true;ScheduledScalingSuspended=$true}
    Set-ScalingTarget $Config 6 8 $held
    Invoke-AwsCommand @("ecs","update-service","--region",$Config.Resources.region,"--cluster",$Config.Resources.cluster,
        "--service",$Config.Resources.apiService,"--desired-count","6")
    Invoke-AwsCommand @("ecs","wait","services-stable","--region",$Config.Resources.region,"--cluster",$Config.Resources.cluster,
        "--services",$Config.Resources.apiService,$Config.Resources.workerService)
    $services = Get-ServicePosture $Config
    $targetHealth = Wait-TargetHealthConvergence $Config 6 -AllowedTransitionalStates @("initial")
    if ([int]$services.api.desired -ne 6 -or [int]$services.api.running -ne 6 -or [int]$services.worker.desired -ne 1 -or
        [int]$targetHealth.healthy -ne 6 -or [int]$targetHealth.nonHealthy -ne 0) {
        throw "Diagnostic capacity failed to converge to six exact API targets and one worker."
    }
    $scaling = Get-ScalingSnapshot $Config
    if ([int]$scaling.minCapacity -ne 6 -or [int]$scaling.maxCapacity -ne 8 -or
        -not [bool]$scaling.suspendedState.DynamicScalingInSuspended -or
        -not [bool]$scaling.suspendedState.DynamicScalingOutSuspended -or
        -not [bool]$scaling.suspendedState.ScheduledScalingSuspended) {
        throw "Diagnostic autoscaling pin was not observed exactly."
    }
    return [ordered]@{services=$services;healthyApiTargets=[int]$targetHealth.healthy;scaling=$scaling}
}

function Restore-ScalingCapture {
    param($Config, $Capture)
    $original = $Capture.original
    $allHeld = [ordered]@{DynamicScalingInSuspended=$true;DynamicScalingOutSuspended=$true;ScheduledScalingSuspended=$true}
    Set-ScalingTarget $Config ([int]$original.scaling.minCapacity) ([int]$original.scaling.maxCapacity) $allHeld
    Invoke-AwsCommand @("ecs","update-service","--region",$Config.Resources.region,"--cluster",$Config.Resources.cluster,
        "--service",$Config.Resources.apiService,"--desired-count",[string]$original.services.api.desired)
    Invoke-AwsCommand @("ecs","wait","services-stable","--region",$Config.Resources.region,"--cluster",$Config.Resources.cluster,
        "--services",$Config.Resources.apiService,$Config.Resources.workerService)
    # The target group uses a reviewed 300-second deregistration delay. Keep
    # all scaling modes held while the old targets drain, and allow only ALB's
    # draining transitional state until the exact target set exists.
    $targetHealth = Wait-TargetHealthConvergence $Config ([int]$original.services.api.desired) -AllowedTransitionalStates @("draining")
    Set-ScalingTarget $Config ([int]$original.scaling.minCapacity) ([int]$original.scaling.maxCapacity) $original.scaling.suspendedState
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(2)
    do {
        $observedScaling = Get-ScalingSnapshot $Config
        $observedServices = Get-ServicePosture $Config
        $targetHealth = Get-TargetHealthSnapshot $Config
        $prohibitedStates = @($targetHealth.states | Where-Object { $_ -notin @("healthy","draining") })
        if ($prohibitedStates.Count -gt 0) {
            throw "Scaling restoration observed a prohibited non-transitional target state: $($targetHealth.states -join ',')."
        }
        $matched = [int]$observedScaling.minCapacity -eq [int]$original.scaling.minCapacity -and
            [int]$observedScaling.maxCapacity -eq [int]$original.scaling.maxCapacity -and
            (Get-StableJsonSha256 $observedScaling.suspendedState) -ceq (Get-StableJsonSha256 $original.scaling.suspendedState) -and
            [string]$observedScaling.scheduledActionsSha256 -ceq [string]$original.scaling.scheduledActionsSha256 -and
            [string]$observedScaling.scalingPoliciesSha256 -ceq [string]$original.scaling.scalingPoliciesSha256 -and
            [int]$observedServices.api.desired -eq [int]$original.services.api.desired -and
            [int]$observedServices.api.running -eq [int]$original.services.api.desired -and
            [int]$observedServices.worker.desired -eq [int]$original.services.worker.desired -and
            [int]$targetHealth.total -eq [int]$original.services.api.desired -and
            [int]$targetHealth.healthy -eq [int]$original.services.api.desired -and [int]$targetHealth.nonHealthy -eq 0
        if ($matched) { break }
        Start-Sleep -Seconds 5
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if (-not $matched) { throw "Exact API scaling, schedule, policy, desired-count, or target-health restoration was not observed." }
    return [ordered]@{restored=$true;attempted=$true;restoredAtUtc=[DateTimeOffset]::UtcNow.ToString("o");services=$observedServices;
        healthyApiTargets=[int]$targetHealth.healthy;scaling=$observedScaling}
}

function Resolve-GeneratorPublicIp {
    try { $resolved = ([string](Invoke-RestMethod -Uri "https://checkip.amazonaws.com" -TimeoutSec 10)).Trim() }
    catch { throw "The generator public IPv4 could not be resolved from the AWS-owned endpoint." }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($resolved, [ref]$address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw "The resolved generator address was not IPv4."
    }
    return $resolved
}

function Update-GeneratorPublicIpEvidence {
    param($Config, [string]$Path, [string]$FailureMessage)
    $actualIp = Resolve-GeneratorPublicIp
    $observedAt = [DateTimeOffset]::UtcNow
    Write-AtomicJson -Path $Path -Value ([ordered]@{
        runId=$Config.RunId;timestamp=$observedAt.ToString("o")
        expectedPublicIp=$Config.ExpectedGeneratorPublicIp;actualPublicIp=$actualIp
    })
    if ($actualIp -cne $Config.ExpectedGeneratorPublicIp) { throw $FailureMessage }
    return $observedAt
}

function Assert-HealthyMonitorHeartbeat {
    param(
        $Heartbeat,
        [string]$ExpectedRunId,
        [string]$ExpectedPhase,
        [DateTimeOffset]$MonitorStartedAt,
        [DateTimeOffset]$Now
    )
    try { $heartbeatTimestamp = ([DateTimeOffset]$Heartbeat.timestamp).ToUniversalTime() }
    catch { throw "The diagnostic monitor heartbeat timestamp is invalid." }
    if ([string]$Heartbeat.runId -ne $ExpectedRunId -or [string]$Heartbeat.phase -ne $ExpectedPhase -or
        $Heartbeat.triggered -isnot [bool] -or $Heartbeat.triggered -ne $false -or
        [int]$Heartbeat.iteration -lt 1 -or $heartbeatTimestamp -lt $MonitorStartedAt -or
        $heartbeatTimestamp -gt $Now.AddSeconds(5) -or
        ($Now - $heartbeatTimestamp).TotalSeconds -gt $script:MonitorHeartbeatStaleSeconds) {
        throw "The diagnostic monitor did not publish a fresh, healthy heartbeat for the bound run."
    }
}

function Get-ObservedTrafficWindow {
    param($Config, [string]$ProgressPath, [string]$SummaryPath)
    if (-not (Test-Path -LiteralPath $ProgressPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $SummaryPath -PathType Leaf)) {
        throw "Observed traffic-window evidence is incomplete."
    }
    try {
        $records = @(Get-Content -LiteralPath $ProgressPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            ForEach-Object { $_ | ConvertFrom-Json -Depth 20 })
        $summary = Read-AtomicJson $SummaryPath
    }
    catch { throw "Observed traffic-window evidence is malformed." }
    $starts = @($records | Where-Object { [string]$_.event -eq "start" })
    $finals = @($records | Where-Object { [string]$_.event -eq "final" })
    if ($starts.Count -ne 1 -or $finals.Count -ne 1) {
        throw "Observed traffic-window evidence must contain exactly one start and one final record."
    }
    $startRecord = $starts[0]
    $finalRecord = $finals[0]
    $expectedRunId = [string]$Config.RunId
    foreach ($record in @($startRecord,$finalRecord)) {
        if ([string]$record.runId -cne $expectedRunId -or [string]$record.stage -cne "800" -or
            [int]$record.devices -ne 810 -or $record.diagnosticOnly -isnot [bool] -or
            $record.diagnosticOnly -ne $true -or $record.certificationEligible -isnot [bool] -or
            $record.certificationEligible -ne $false) {
            throw "Observed traffic-window progress identity does not match the exact diagnostic run."
        }
    }
    if ([string]$summary.runId -cne $expectedRunId -or [string]$summary.stage -cne "800" -or
        [int]$summary.devices -ne 810 -or $summary.diagnosticOnly -isnot [bool] -or
        $summary.diagnosticOnly -ne $true -or $summary.certificationEligible -isnot [bool] -or
        $summary.certificationEligible -ne $false -or
        [string]$summary.workloadSchemaVersion -cne $script:WorkloadSchemaVersion -or
        [string]$summary.workloadEndpointShapeSha256 -cne $script:EndpointShapeSha256) {
        throw "Observed traffic-window summary identity does not match the exact diagnostic workload."
    }
    $run = Get-Value $summary "run"
    if ($null -eq $run -or [string](Get-Value $run "durationClock" "") -cne $script:DurationClock) {
        throw "Observed traffic-window evidence is not bound to the reviewed monotonic clock."
    }
    $rawRuntimeTargetSeconds = Get-Value $run "runtimeTargetTrafficSeconds"
    $rawPlannedMilliseconds = Get-Value $run "plannedTrafficMilliseconds"
    $rawActualMilliseconds = Get-Value $run "actualTrafficMilliseconds"
    $rawPlannedSeconds = Get-Value $run "plannedTrafficSeconds"
    $rawActualSeconds = Get-Value $run "actualTrafficSeconds"
    foreach ($rawTimingValue in @($rawRuntimeTargetSeconds,$rawPlannedMilliseconds,$rawActualMilliseconds,$rawPlannedSeconds,$rawActualSeconds)) {
        if ($null -eq $rawTimingValue -or $rawTimingValue -isnot [ValueType] -or
            $rawTimingValue -is [bool] -or $rawTimingValue -is [char]) {
            throw "Observed traffic-window timing fields must be JSON numbers."
        }
    }
    $runtimeTargetSeconds = [double]$rawRuntimeTargetSeconds
    $plannedMilliseconds = [double]$rawPlannedMilliseconds
    $actualMilliseconds = [double]$rawActualMilliseconds
    $plannedSeconds = [double]$rawPlannedSeconds
    $actualSeconds = [double]$rawActualSeconds
    foreach ($timingValue in @($runtimeTargetSeconds,$plannedMilliseconds,$actualMilliseconds,$plannedSeconds,$actualSeconds)) {
        if ([double]::IsNaN($timingValue) -or [double]::IsInfinity($timingValue)) {
            throw "Observed traffic-window timing evidence is not finite."
        }
    }
    if ($runtimeTargetSeconds -ne $script:DiagnosticRuntimeTargetTrafficSeconds -or
        $plannedMilliseconds -ne [double]$script:DiagnosticPlannedTrafficMilliseconds -or
        $plannedSeconds -ne $script:DiagnosticRuntimeTargetTrafficSeconds -or
        $actualMilliseconds -le 0 -or $actualMilliseconds -ne [math]::Floor($actualMilliseconds) -or
        [math]::Abs(($actualSeconds * 1000.0) - $actualMilliseconds) -gt 0.5) {
        throw "Observed traffic-window timing evidence is incoherent."
    }
    try {
        $startedAt = ([DateTimeOffset]$startRecord.timestamp).ToUniversalTime()
        $finalAt = ([DateTimeOffset]$finalRecord.timestamp).ToUniversalTime()
    }
    catch { throw "Observed traffic-window progress timestamps are invalid." }
    $endedAt = $startedAt.AddMilliseconds($actualMilliseconds)
    # Progress wall-clock timestamps are labels only. Duration acceptance is
    # derived exclusively from the raw monotonic elapsed milliseconds so an
    # NTP/manual Date.now rollback cannot shorten or reject the run.
    $strictlyComplete = [string](Get-Value $run "shutdownReason" "") -ceq "duration" -and
        (Get-Value $run "completedConfiguredDuration" $null) -is [bool] -and
        (Get-Value $run "completedConfiguredDuration" $false) -eq $true -and
        $actualMilliseconds -ge [double]$script:DiagnosticPlannedTrafficMilliseconds -and
        $actualSeconds -ge $script:DiagnosticRuntimeTargetTrafficSeconds
    $evidence = [ordered]@{
        coherent=$true;strictlyComplete=$strictlyComplete;startUtc=$startedAt.ToString("o");endUtc=$endedAt.ToString("o")
        finalProgressUtc=$finalAt.ToString("o");durationClock=$script:DurationClock
        runtimeTargetTrafficSeconds=$runtimeTargetSeconds
        plannedTrafficMilliseconds=[long]$plannedMilliseconds;actualTrafficMilliseconds=[long]$actualMilliseconds
        plannedTrafficSeconds=$plannedSeconds;actualTrafficSeconds=$actualSeconds
        shutdownReason=[string](Get-Value $run "shutdownReason" "")
        completedConfiguredDuration=((Get-Value $run "completedConfiguredDuration" $false) -eq $true)
    }
    return [pscustomobject]@{Evidence=$evidence;Summary=$summary}
}

function Get-TrafficWindow {
    param($Config, [string]$ProgressPath, [string]$SummaryPath)
    $observed = Get-ObservedTrafficWindow $Config $ProgressPath $SummaryPath
    if ($observed.Evidence.strictlyComplete -ne $true) {
        throw "Load evidence is not an exact completed diagnostic-only traffic interval."
    }
    return [ordered]@{startUtc=$observed.Evidence.startUtc;endUtc=$observed.Evidence.endUtc;summary=$observed.Summary}
}

function Get-Postgres57014Evidence {
    param($Config, [string]$StartUtc, [string]$EndUtc)
    try {
        $start = ([DateTimeOffset]$StartUtc).ToUniversalTime()
        $end = ([DateTimeOffset]$EndUtc).ToUniversalTime()
    }
    catch { throw "The PostgreSQL timeout log query requires a valid UTC traffic interval." }
    if ($end -le $start) { throw "The PostgreSQL timeout log query requires a positive traffic interval." }
    $startMs = $start.ToUnixTimeMilliseconds()
    $endMs = $end.ToUnixTimeMilliseconds()
    $binding = Get-BoundApiAwslogsBinding $Config
    $pages = Invoke-EvidenceAwsJsonPages -Arguments @("logs","filter-log-events","--region",$binding.LogRegion,
        "--log-group-name",$binding.LogGroup,"--log-stream-name-prefix",$binding.ApiStreamPrefix,
        "--start-time",[string]$startMs,"--end-time",[string]$endMs,"--filter-pattern",'"57014"') `
        -ItemsProperty "events" -TokenProperty "nextToken" -Identity {
            param($event)
            $eventId = [string](Get-Value $event "eventId" "")
            if ($eventId) { return $eventId }
            return Get-StableJsonSha256 ([ordered]@{timestamp=(Get-Value $event "timestamp");stream=(Get-Value $event "logStreamName");message=(Get-Value $event "message")})
        }
    $events = @($pages.Items)
    foreach ($event in $events) {
        $timestamp = [long](Get-Value $event "timestamp" -1)
        $stream = [string](Get-Value $event "logStreamName" "")
        $message = [string](Get-Value $event "message" "")
        if ($timestamp -lt $startMs -or $timestamp -gt $endMs -or
            -not $stream.StartsWith($binding.ApiStreamPrefix, [StringComparison]::Ordinal) -or
            -not $message.Contains("57014", [StringComparison]::Ordinal)) {
            throw "CloudWatch Logs returned malformed or out-of-scope PostgreSQL timeout evidence."
        }
    }
    return [ordered]@{
        diagnosticOnly=$true;sanitized=$true;source="cloudwatch_logs";sqlState="57014"
        startUtc=$start.ToString("o");endUtc=$end.ToString("o");startTimeMs=$startMs;endTimeInclusiveMs=$endMs
        exactTaskDefinitionBound=$true;logDriver=$binding.LogDriver;logRegion=$binding.LogRegion
        logGroupSha256=(Get-StringSha256 $binding.LogGroup)
        streamPrefixSha256=(Get-StringSha256 $binding.ApiStreamPrefix)
        rawMessagesPersisted=$false;rawIdentifiersPersisted=$false;pageCount=$pages.PageCount
        matchCount=$events.Count;passed=($events.Count -eq 0)
    }
}

function Get-HistoryFallbackWaitEventEvidence {
    param($Config, [string]$StartUtc, [string]$EndUtc, [string]$DbiResourceId,
        [string]$QueryIdentifier, [string]$TokenId, [string]$TokenSha256, [double]$TokenLoad)
    if ($QueryIdentifier -notmatch '^-?(?:[1-9][0-9]{0,18})$' -or
        [string]::IsNullOrWhiteSpace($TokenId) -or $TokenLoad -le 0) {
        throw "History fallback wait-event evidence requires a nonzero bound native query identifier and SQL token."
    }
    $filter = ([ordered]@{
        "db.sql_tokenized.db_id"=$QueryIdentifier
        "db.sql_tokenized.id"=$TokenId
    } | ConvertTo-Json -Compress)
    $pages = Invoke-EvidenceAwsJsonPages -Arguments @("pi","describe-dimension-keys","--region",$Config.Resources.region,
        "--service-type","RDS","--identifier",$DbiResourceId,"--start-time",$StartUtc,"--end-time",$EndUtc,
        "--period-in-seconds","60","--metric","db.load.avg","--group-by","Group=db.wait_event,Limit=25",
        "--filter",$filter) -ItemsProperty "Keys" -TokenProperty "NextToken" `
        -ExpectedAlignedStartUtc $StartUtc -ExpectedAlignedEndUtc $EndUtc -Identity {
            param($key)
            return "$([string](Get-Value $key.Dimensions 'db.wait_event.type' ''))`:$([string](Get-Value $key.Dimensions 'db.wait_event.name' ''))"
        }
    $keys = @($pages.Items)
    if ($keys.Count -lt 1) {
        return [ordered]@{
            tokenSha256=$TokenSha256;dbLoad=[math]::Round($TokenLoad,6);waitEventCount=0;pageCount=$pages.PageCount
            filteredWaitEventDbLoad=0.0;coveragePercent=0.0
            coverageTolerancePercent=$script:PerformanceInsightsCoverageTolerancePercent;complete=$false
            dataFileReadDbLoad=0.0;dataFileReadSharePercent=$null
            dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
            failureReasons=@("missing_wait_event_coverage");passed=$false
        }
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $waitLoad = 0.0
    $dataFileReadLoad = 0.0
    foreach ($key in $keys) {
        $name = [string](Get-Value $key.Dimensions "db.wait_event.name" "")
        $type = [string](Get-Value $key.Dimensions "db.wait_event.type" "")
        $rawLoad = Get-Value $key "Total" $null
        if ($null -eq $rawLoad -or $rawLoad -isnot [ValueType] -or $rawLoad -is [bool] -or
            $rawLoad -is [char]) {
            throw "Performance Insights returned malformed filtered wait-event evidence for history fallback SQL."
        }
        try { $load = [double]$rawLoad }
        catch { throw "Performance Insights returned malformed filtered wait-event evidence for history fallback SQL." }
        $identity = "$type`:$name"
        if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($type) -or
            [double]::IsNaN($load) -or [double]::IsInfinity($load) -or $load -lt 0 -or
            -not $seen.Add($identity)) {
            throw "Performance Insights returned malformed filtered wait-event evidence for history fallback SQL."
        }
        $waitLoad += $load
        if (($type -ieq "IO" -and $name -ieq "DataFileRead") -or $name -ieq "IO:DataFileRead") {
            $dataFileReadLoad += $load
        }
    }
    $allowedDifference = [math]::Max(0.000001,
        $TokenLoad * ($script:PerformanceInsightsCoverageTolerancePercent / 100.0))
    $complete = [math]::Abs($waitLoad - $TokenLoad) -le $allowedDifference
    $coveragePercent = [math]::Round(($waitLoad / $TokenLoad) * 100.0, 3)
    $rawSharePercent = if($waitLoad -gt 0){($dataFileReadLoad / $waitLoad) * 100.0}else{$null}
    $sharePercent = if($waitLoad -gt 0){[math]::Round($rawSharePercent, 6)}else{$null}
    $failureReasons = @()
    if (-not $complete) { $failureReasons += "incomplete_wait_event_coverage" }
    if ($waitLoad -gt 0 -and $rawSharePercent -ge $script:HistoryIoDominanceThresholdPercent) {
        $failureReasons += "sampled_data_file_read_dominant"
    }
    return [ordered]@{
        tokenSha256=$TokenSha256;dbLoad=[math]::Round($TokenLoad,6);waitEventCount=$keys.Count;pageCount=$pages.PageCount
        filteredWaitEventDbLoad=[math]::Round($waitLoad,6);coveragePercent=$coveragePercent
        coverageTolerancePercent=$script:PerformanceInsightsCoverageTolerancePercent;complete=$complete
        dataFileReadDbLoad=[math]::Round($dataFileReadLoad,6);dataFileReadSharePercent=$sharePercent
        dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
        failureReasons=@($failureReasons);passed=($failureReasons.Count -eq 0)
    }
}

function Get-PerformanceInsightsTopTokens {
    param($Config, [string]$StartUtc, [string]$EndUtc, [string]$DbiResourceId)
    $pages = Invoke-EvidenceAwsJsonPages -Arguments @("pi","describe-dimension-keys","--region",$Config.Resources.region,
        "--service-type","RDS","--identifier",$DbiResourceId,"--start-time",$StartUtc,"--end-time",$EndUtc,
        "--period-in-seconds","60","--metric","db.load.avg","--group-by","Group=db.sql_tokenized,Limit=25") `
        -ItemsProperty "Keys" -TokenProperty "NextToken" -ExpectedAlignedStartUtc $StartUtc `
        -ExpectedAlignedEndUtc $EndUtc -Identity {
            param($key)
            return [string](Get-Value $key.Dimensions "db.sql_tokenized.id" "")
        }
    $rank = 0
    $internal = @()
    $sanitized = @()
    foreach ($key in @($pages.Items | Sort-Object Total -Descending)) {
        $rank++
        $statement = [string](Get-Value $key.Dimensions "db.sql_tokenized.statement" "")
        $tokenId = [string](Get-Value $key.Dimensions "db.sql_tokenized.id" "")
        $load = [double](Get-Value $key "Total" -1)
        if ([string]::IsNullOrWhiteSpace($statement) -or [string]::IsNullOrWhiteSpace($tokenId) -or
            [double]::IsNaN($load) -or [double]::IsInfinity($load) -or $load -lt 0) {
            throw "Performance Insights did not return the complete tokenized SQL dimension."
        }
        $lower = $statement.ToLowerInvariant()
        $isAuthorization = @($script:AuthSqlMarkers | Where-Object { $lower.Contains($_) }).Count -ge 2
        $tokenSha = Get-StableJsonSha256 ([ordered]@{id=$tokenId;statement=$statement})
        $category = if($isAuthorization){"tile_authorization"}else{"other"}
        $internal += [pscustomobject]@{Id=$tokenId;Sha256=$tokenSha;Load=$load;
            IsAuthorization=$isAuthorization}
        $sanitized += [ordered]@{rank=$rank;tokenSha256=$tokenSha;category=$category;dbLoad=[math]::Round($load,6)}
    }
    return [pscustomobject]@{Internal=$internal;Sanitized=$sanitized;PageCount=$pages.PageCount}
}

function New-DiagnosticHistoryFallbackSqlStatsGateResult {
    param($Config, [string[]]$FailureReasons, [int]$IdentityCount, [long]$ExpectedDatabaseReadCount)
    $identity = $Config.HistoryFallbackSqlIdentity
    return [pscustomobject]@{
        CanSample=$false;TokenId=$null;TokenSha256=$null;Statement=$null
        Evidence=[ordered]@{
            historyFallbackPiEvidenceVersion=$script:HistoryFallbackPiEvidenceVersion
            queryIdentifierSha256=$identity.QueryIdentifierSha256
            compiledSqlSha256=$identity.CompiledSqlSha256
            parameterTypeSignatureSha256=$identity.ParameterTypeSignatureSha256
            schemaIdentitySha256=$identity.SchemaIdentitySha256
            identityCount=$IdentityCount;exactQueryIdentifierMatched=$false;statementMarkersMatched=$false
            positiveCallsObserved=$false;positiveTotalTimeObserved=$false;integratedCalls=0.0
            applicationDatabaseReadCount=$ExpectedDatabaseReadCount;callsCoverApplicationReads=$false
            temporaryIoAbsent=$false;blockReadTimeSharePercent=$null
            dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
            failureReasons=@($FailureReasons);passed=$false
        }
    }
}

function Get-DiagnosticHistoryFallbackSqlStatsBucketCoverage {
    param(
        [string]$StartUtc,
        [string]$EndUtc,
        $CallMetricPoints,
        [object[]]$ApplicationFallbackWindows,
        [long]$ExpectedDatabaseReadCount
    )
    $start = ConvertTo-ExactUtcDateTimeOffset $StartUtc "SQL-statistics bucket start"
    $end = ConvertTo-ExactUtcDateTimeOffset $EndUtc "SQL-statistics bucket end"
    $expectedBuckets = [Collections.Generic.List[string]]::new()
    for ($cursor = $start; $cursor -lt $end; $cursor = $cursor.AddSeconds($script:HistoryFallbackSqlStatsPeriodSeconds)) {
        $expectedBuckets.Add($cursor.ToString("o"))
    }
    if ($expectedBuckets.Count -lt 1) { throw "SQL statistics require at least one expected minute bucket." }
    $expectedSet = [Collections.Generic.HashSet[string]]::new($expectedBuckets, [StringComparer]::Ordinal)
    $observedBuckets = @($CallMetricPoints.Keys | Sort-Object)
    foreach ($timestamp in $observedBuckets) {
        if (-not $expectedSet.Contains([string]$timestamp)) {
            throw "SQL statistics returned a datapoint outside the expected minute-bucket lattice."
        }
    }
    $observedSet = [Collections.Generic.HashSet[string]]::new([string[]]$observedBuckets, [StringComparer]::Ordinal)
    $positiveObservedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($timestamp in $observedBuckets) {
        if ([double]$CallMetricPoints[$timestamp].Value -gt 0.0) { [void]$positiveObservedSet.Add([string]$timestamp) }
    }
    $missingMiddle = [Collections.Generic.List[string]]::new()
    if ($observedBuckets.Count -gt 1) {
        $firstIndex = $expectedBuckets.IndexOf([string]$observedBuckets[0])
        $lastIndex = $expectedBuckets.IndexOf([string]$observedBuckets[-1])
        for ($index = $firstIndex; $index -le $lastIndex; $index++) {
            if (-not $observedSet.Contains($expectedBuckets[$index])) { $missingMiddle.Add($expectedBuckets[$index]) }
        }
    }
    $applicationActiveBuckets = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $coveredApplicationWindows = 0
    $positiveCallCoveredApplicationWindows = 0
    $applicationReadCount = 0L
    foreach ($window in @($ApplicationFallbackWindows)) {
        try {
            $windowStart = ConvertTo-ExactUtcDateTimeOffset (Get-RequiredValue $window "StartUtc") "fallback window start"
            $windowEnd = ConvertTo-ExactUtcDateTimeOffset (Get-RequiredValue $window "EndUtc") "fallback window end"
            $windowReads = [long](Get-RequiredValue $window "DatabaseReadCount")
        }
        catch { throw "Application fallback bucket evidence was malformed." }
        if ($windowStart -lt $start -or $windowEnd -gt $end -or $windowEnd -le $windowStart -or $windowReads -le 0) {
            throw "Application fallback bucket evidence was outside the exact SQL-statistics window."
        }
        $applicationReadCount += $windowReads
        $windowCovered = $false
        $windowPositiveCallCovered = $false
        foreach ($bucketText in $expectedBuckets) {
            $bucketStart = [DateTimeOffset]$bucketText
            $bucketEnd = $bucketStart.AddSeconds($script:HistoryFallbackSqlStatsPeriodSeconds)
            if ($bucketStart -lt $windowEnd -and $bucketEnd -gt $windowStart) {
                [void]$applicationActiveBuckets.Add($bucketText)
                if ($observedSet.Contains($bucketText)) { $windowCovered = $true }
                if ($positiveObservedSet.Contains($bucketText)) { $windowPositiveCallCovered = $true }
            }
        }
        if ($windowCovered) { $coveredApplicationWindows++ }
        if ($windowPositiveCallCovered) { $positiveCallCoveredApplicationWindows++ }
    }
    if ($applicationReadCount -ne $ExpectedDatabaseReadCount -or $ApplicationFallbackWindows.Count -lt 1) {
        throw "Application fallback bucket evidence did not reconcile to the bound database-read count."
    }
    $unobservedActiveBuckets = @($applicationActiveBuckets | Where-Object { -not $observedSet.Contains($_) } | Sort-Object)
    $zeroCallApplicationActiveBuckets = @($applicationActiveBuckets | Where-Object {
        $observedSet.Contains($_) -and -not $positiveObservedSet.Contains($_)
    } | Sort-Object)
    if ($missingMiddle.Count -gt 0 -or $unobservedActiveBuckets.Count -gt 0 -or
        $coveredApplicationWindows -ne $ApplicationFallbackWindows.Count) {
        throw "SQL statistics contained missing-middle or application-active sparse minute buckets."
    }
    $omittedBuckets = @($expectedBuckets | Where-Object { -not $observedSet.Contains($_) })
    return [ordered]@{
        coverageContractVersion="queryid-minute-sparse-v1";periodSeconds=$script:HistoryFallbackSqlStatsPeriodSeconds
        expectedBucketCount=$expectedBuckets.Count;observedBucketCount=$observedBuckets.Count
        positiveCallBucketCount=$positiveObservedSet.Count;omittedSparseBucketCount=$omittedBuckets.Count
        missingMiddleBucketCount=$missingMiddle.Count
        applicationFallbackWindowCount=$ApplicationFallbackWindows.Count
        coveredApplicationFallbackWindowCount=$coveredApplicationWindows
        positiveCallCoveredApplicationFallbackWindowCount=$positiveCallCoveredApplicationWindows
        applicationActiveBucketCount=$applicationActiveBuckets.Count
        unobservedApplicationActiveBucketCount=$unobservedActiveBuckets.Count
        zeroCallApplicationActiveBucketCount=$zeroCallApplicationActiveBuckets.Count
        positiveCallCoveragePassed=($positiveCallCoveredApplicationWindows -eq $ApplicationFallbackWindows.Count -and
            $zeroCallApplicationActiveBuckets.Count -eq 0)
        expectedBucketSetSha256=(Get-StableJsonSha256 ([ordered]@{buckets=@($expectedBuckets)}))
        observedBucketSetSha256=(Get-StableJsonSha256 ([ordered]@{buckets=@($observedBuckets)}))
        positiveCallBucketSetSha256=(Get-StableJsonSha256 ([ordered]@{buckets=@($positiveObservedSet | Sort-Object)}))
        applicationActiveBucketSetSha256=(Get-StableJsonSha256 ([ordered]@{buckets=@($applicationActiveBuckets | Sort-Object)}))
        sparseBucketsPermittedOnlyWithoutApplicationActivity=$true;complete=$true
    }
}

function Get-HistoryFallbackSqlStatsEvidence {
    param(
        $Config,
        [string]$StartUtc,
        [string]$EndUtc,
        [string]$DbiResourceId,
        [long]$ExpectedDatabaseReadCount,
        [object[]]$ApplicationFallbackWindows = @()
    )
    $identity = $Config.HistoryFallbackSqlIdentity
    if ($null -eq $identity -or [string]$identity.DatabaseResourceId -cne $DbiResourceId) {
        throw "History fallback SQL statistics require the exact bound DBI resource identity."
    }
    if ($ExpectedDatabaseReadCount -le 0) {
        throw "History fallback SQL statistics require a positive application database-read count."
    }
    try {
        $trafficStart = ([DateTimeOffset]$StartUtc).ToUniversalTime()
        $trafficEnd = ([DateTimeOffset]$EndUtc).ToUniversalTime()
    }
    catch { throw "History fallback SQL statistics require a valid UTC traffic interval." }
    if ($trafficEnd -le $trafficStart) { throw "History fallback SQL statistics require a positive traffic interval." }

    $dimensions = @("db.sql_tokenized.db_id", "db.sql_tokenized.id", "db.sql_tokenized.statement")
    $queries = @($script:HistoryFallbackSqlStatsMetrics.GetEnumerator() | ForEach-Object {
        [ordered]@{
            Metric=[string]$_.Value
            GroupBy=[ordered]@{Group="db.sql_tokenized";Dimensions=$dimensions;Limit=25}
            Filter=[ordered]@{"db.sql_tokenized.db_id"=[string]$identity.QueryIdentifier}
        }
    })
    $queryJson = $queries | ConvertTo-Json -Depth 10 -Compress
    $baseArguments = @("pi","get-resource-metrics","--region",$Config.Resources.region,"--service-type","RDS",
        "--identifier",$DbiResourceId,"--start-time",$StartUtc,"--end-time",$EndUtc,
        "--period-in-seconds",[string]$script:HistoryFallbackSqlStatsPeriodSeconds,
        "--period-alignment","START_TIME","--metric-queries",$queryJson)
    $expectedMetricNames = @($script:HistoryFallbackSqlStatsMetrics.Values)
    $metricPoints = @{}
    $ungroupedTotalSeriesHashes = @{}
    $repeatedUngroupedTotalSeriesCount = 0
    foreach ($metricName in $expectedMetricNames) {
        $metricPoints[$metricName] = @{}
    }
    $seenTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $identityKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $identityRecords = @{}
    $dimensionedSeries = [Collections.Generic.List[object]]::new()
    $pageToken = $null
    $pageCount = 0
    $recordCount = 0
    do {
        $pageCount++
        if ($pageCount -gt $script:EvidenceMaximumPages) {
            throw "History fallback SQL-statistics pagination exceeded the page limit."
        }
        $arguments = @($baseArguments) + @("--no-paginate")
        if (-not [string]::IsNullOrWhiteSpace([string]$pageToken)) {
            $arguments += @("--next-token", [string]$pageToken)
        }
        $page = Invoke-AwsJson $arguments
        if ($null -eq $page) { throw "History fallback SQL-statistics pagination returned an empty page." }
        Assert-PerformanceInsightsResponseScope $page $StartUtc $EndUtc $DbiResourceId
        foreach ($metricResult in @((Get-Value $page "MetricList" @()))) {
            $key = Get-Value $metricResult "Key" $null
            if ($null -eq $key -or $key -is [string]) {
                throw "History fallback SQL statistics returned an ungrouped metric."
            }
            $metricName = [string](Get-Value $key "Metric" "")
            if ($metricName -notin $expectedMetricNames) {
                throw "History fallback SQL statistics returned an unreviewed metric."
            }
            $returnedDimensions = Get-Value $key "Dimensions" $null
            # GetResourceMetrics returns a dimensionless aggregate alongside
            # GroupBy results. It cannot prove native/token identity and must
            # never enter call/I/O totals. Deduplicate identical repeats and
            # fail on conflicting totals across explicit service pages.
            if (Test-DiagnosticEmptyObject $returnedDimensions) {
                $totalHash = Get-StableJsonSha256 $metricResult
                if ($ungroupedTotalSeriesHashes.ContainsKey($metricName)) {
                    if ([string]$ungroupedTotalSeriesHashes[$metricName] -cne $totalHash) {
                        throw "History fallback SQL statistics returned conflicting duplicate ungrouped total series."
                    }
                    $repeatedUngroupedTotalSeriesCount++
                }
                else { $ungroupedTotalSeriesHashes[$metricName] = $totalHash }
                continue
            }
            $dbId = [string](Get-Value $returnedDimensions "db.sql_tokenized.db_id" "")
            $returnedTokenId = [string](Get-Value $returnedDimensions "db.sql_tokenized.id" "")
            $returnedStatement = [string](Get-Value $returnedDimensions "db.sql_tokenized.statement" "")
            $statementSha256 = Get-StringSha256 $returnedStatement
            $identityKey = "$dbId|$returnedTokenId|$statementSha256"
            [void]$identityKeys.Add($identityKey)
            if (-not $identityRecords.ContainsKey($identityKey)) {
                $identityRecords[$identityKey] = [pscustomobject]@{DbId=$dbId;TokenId=$returnedTokenId;Statement=$returnedStatement}
            }
            $dimensionedSeries.Add([pscustomobject]@{MetricName=$metricName;Dimensions=$returnedDimensions;
                DataPoints=@((Get-Value $metricResult "DataPoints" @()))})
        }
        $pageToken = [string](Get-Value $page "NextToken" "")
        if (-not [string]::IsNullOrWhiteSpace($pageToken) -and -not $seenTokens.Add($pageToken)) {
            throw "History fallback SQL-statistics pagination returned a token cycle."
        }
    } while (-not [string]::IsNullOrWhiteSpace($pageToken))

    if ($identityRecords.Count -eq 0) {
        return New-DiagnosticHistoryFallbackSqlStatsGateResult $Config @("missing_query_identity") 0 $ExpectedDatabaseReadCount
    }
    if ($identityRecords.Count -ne 1) {
        return New-DiagnosticHistoryFallbackSqlStatsGateResult $Config @("ambiguous_query_identity") `
            $identityRecords.Count $ExpectedDatabaseReadCount
    }
    $identityRecord = @($identityRecords.Values)[0]
    $tokenId = [string]$identityRecord.TokenId
    $statement = [string]$identityRecord.Statement
    $lowerStatement = $statement.ToLowerInvariant()
    if ([string]$identityRecord.DbId -cne [string]$identity.QueryIdentifier) {
        return New-DiagnosticHistoryFallbackSqlStatsGateResult $Config @("native_query_identifier_mismatch") 1 `
            $ExpectedDatabaseReadCount
    }
    if ([string]::IsNullOrWhiteSpace($tokenId) -or [string]::IsNullOrWhiteSpace($statement) -or
        @($script:HistoryFallbackSqlMarkers | Where-Object { $lowerStatement.Contains($_) }).Count -ne
            $script:HistoryFallbackSqlMarkers.Count) {
        return New-DiagnosticHistoryFallbackSqlStatsGateResult $Config @("statement_marker_mismatch") 1 `
            $ExpectedDatabaseReadCount
    }
    $metricIdentitySeen = @{}
    foreach ($metricName in $expectedMetricNames) { $metricIdentitySeen[$metricName] = $false }
    foreach ($series in $dimensionedSeries) {
        $returnedDimensions = $series.Dimensions
        if ([string](Get-Value $returnedDimensions "db.sql_tokenized.db_id" "") -cne [string]$identityRecord.DbId -or
            [string](Get-Value $returnedDimensions "db.sql_tokenized.id" "") -cne $tokenId -or
            [string](Get-Value $returnedDimensions "db.sql_tokenized.statement" "") -cne $statement) {
            throw "History fallback SQL statistics metric identity changed within a snapshot."
        }
        $metricName = [string]$series.MetricName
        $metricIdentitySeen[$metricName] = $true
        foreach ($point in @($series.DataPoints)) {
                $rawTimestamp = Get-Value $point "Timestamp" $null
                $rawValue = Get-Value $point "Value" $null
                if ($null -eq $rawTimestamp -or $null -eq $rawValue -or
                    $rawValue -isnot [ValueType] -or $rawValue -is [bool] -or $rawValue -is [char]) {
                    throw "History fallback SQL statistics returned a malformed datapoint."
                }
                try {
                    $timestamp = ConvertTo-ExactUtcDateTimeOffset $rawTimestamp "history fallback SQL-statistics timestamp"
                    $value = [double]$rawValue
                }
                catch { throw "History fallback SQL statistics returned a malformed datapoint." }
                if ($timestamp -lt $trafficStart -or $timestamp -ge $trafficEnd -or
                    [double]::IsNaN($value) -or [double]::IsInfinity($value) -or $value -lt 0) {
                    throw "History fallback SQL statistics returned an out-of-scope or non-finite datapoint."
                }
                $canonicalTimestamp = $timestamp.ToString("o")
                $pointHash = Get-StableJsonSha256 ([ordered]@{timestamp=$canonicalTimestamp;value=$value})
                if ($metricPoints[$metricName].ContainsKey($canonicalTimestamp)) {
                    if ([string]$metricPoints[$metricName][$canonicalTimestamp].Hash -cne $pointHash) {
                        throw "History fallback SQL statistics returned conflicting duplicate datapoints."
                    }
                    continue
                }
                $metricPoints[$metricName][$canonicalTimestamp] = [pscustomobject]@{Value=$value;Hash=$pointHash}
                $recordCount++
                if ($recordCount -gt $script:EvidenceMaximumRecords) {
                    throw "History fallback SQL-statistics pagination exceeded the record limit."
                }
            }
        }

    foreach ($metricName in $expectedMetricNames) {
        if ($metricIdentitySeen[$metricName] -ne $true -or $metricPoints[$metricName].Count -lt 1) {
            throw "History fallback SQL statistics did not return complete call and I/O metrics."
        }
    }
    $referenceMetricName = [string]$script:HistoryFallbackSqlStatsMetrics.calls
    $referenceTimestamps = @($metricPoints[$referenceMetricName].Keys | Sort-Object)
    foreach ($metricName in $expectedMetricNames) {
        $metricTimestamps = @($metricPoints[$metricName].Keys | Sort-Object)
        if (@(Compare-Object $referenceTimestamps $metricTimestamps -SyncWindow 0).Count -ne 0) {
            throw "History fallback SQL statistics did not return identical timestamp coverage for every metric."
        }
    }
    $bucketCoverage = Get-DiagnosticHistoryFallbackSqlStatsBucketCoverage $StartUtc $EndUtc `
        $metricPoints[[string]$script:HistoryFallbackSqlStatsMetrics.calls] @($ApplicationFallbackWindows) `
        $ExpectedDatabaseReadCount
    $totals = @{}
    $pointCounts = [ordered]@{}
    foreach ($entry in $script:HistoryFallbackSqlStatsMetrics.GetEnumerator()) {
        $metricName = [string]$entry.Value
        $metricSum = [double](($metricPoints[$metricName].Values.Value | Measure-Object -Sum).Sum)
        if ([double]::IsNaN($metricSum) -or [double]::IsInfinity($metricSum) -or $metricSum -lt 0) {
            throw "History fallback SQL statistics returned a malformed aggregate."
        }
        $totals[[string]$entry.Key] = $metricSum
        $pointCounts[[string]$entry.Key] = $metricPoints[$metricName].Count
    }
    $integratedCalls = $totals.calls * $script:HistoryFallbackSqlStatsPeriodSeconds
    if ([double]::IsNaN($integratedCalls) -or [double]::IsInfinity($integratedCalls) -or $integratedCalls -lt 0) {
        throw "History fallback SQL statistics returned a malformed integrated call count."
    }
    $positiveCallsObserved = $totals.calls -gt 0
    $positiveTotalTimeObserved = $totals.totalTime -gt 0
    $rawBlockReadTimeSharePercent = if($positiveTotalTimeObserved){
        ($totals.blockReadTime / $totals.totalTime) * 100.0
    }else{$null}
    $blockReadTimeSharePercent = if($positiveTotalTimeObserved){[math]::Round($rawBlockReadTimeSharePercent, 6)}else{$null}
    $callsCoverApplicationReads = $positiveCallsObserved -and $integratedCalls -ge [double]$ExpectedDatabaseReadCount
    $temporaryIoAbsent = $totals.tempBlocksRead -eq 0.0 -and $totals.tempBlocksWritten -eq 0.0
    $failureReasons = @()
    if (-not $positiveCallsObserved) { $failureReasons += "missing_positive_calls" }
    if (-not $positiveTotalTimeObserved) { $failureReasons += "missing_positive_total_time" }
    if (-not $callsCoverApplicationReads) { $failureReasons += "pi_call_undercount" }
    if ((Get-Value $bucketCoverage "positiveCallCoveragePassed" $false) -ne $true) {
        $failureReasons += "application_active_bucket_without_positive_calls"
    }
    if (-not $temporaryIoAbsent) { $failureReasons += "temporary_io_observed" }
    if ($positiveTotalTimeObserved -and
        $rawBlockReadTimeSharePercent -ge $script:HistoryIoDominanceThresholdPercent) {
        $failureReasons += "block_read_time_dominant"
    }
    $passed = $failureReasons.Count -eq 0
    $tokenSha256 = Get-StableJsonSha256 ([ordered]@{
        queryIdentifierSha256=$identity.QueryIdentifierSha256;supportId=$tokenId;statement=$statement
    })
    return [pscustomobject]@{
        CanSample=$true;TokenId=$tokenId;TokenSha256=$tokenSha256;Statement=$statement
        Evidence=[ordered]@{
            historyFallbackPiEvidenceVersion=$script:HistoryFallbackPiEvidenceVersion
            queryIdentifierSha256=$identity.QueryIdentifierSha256
            compiledSqlSha256=$identity.CompiledSqlSha256
            parameterTypeSignatureSha256=$identity.ParameterTypeSignatureSha256
            schemaIdentitySha256=$identity.SchemaIdentitySha256
            trackIoTiming=$identity.TrackIoTiming
            releaseIdentitySha256=(Get-StableJsonSha256 ([ordered]@{
                applicationGitSha=$Config.ApplicationGitSha;deployedImageDigest=$Config.ImageDigest
                apiTaskDefinitionArn=$Config.ApiTaskDefinitionArn;workerTaskDefinitionArn=$Config.WorkerTaskDefinitionArn
            }))
            databaseResourceIdSha256=(Get-StringSha256 $identity.DatabaseResourceId)
            engineVersion=$identity.EngineVersion;tokenSha256=$tokenSha256
            statementSha256=(Get-StringSha256 $statement);exactQueryIdentifierMatched=$true
            statementMarkersMatched=$true
            periodSeconds=$script:HistoryFallbackSqlStatsPeriodSeconds;pageCount=$pageCount
            ignoredUngroupedTotalSeriesCount=$ungroupedTotalSeriesHashes.Count
            repeatedUngroupedTotalSeriesCount=$repeatedUngroupedTotalSeriesCount
            metricPointCounts=$pointCounts;bucketCoverage=$bucketCoverage
            positiveCallsObserved=$positiveCallsObserved;positiveTotalTimeObserved=$positiveTotalTimeObserved
            integratedCalls=[math]::Round($integratedCalls,3)
            applicationDatabaseReadCount=$ExpectedDatabaseReadCount
            callsCoverApplicationReads=$callsCoverApplicationReads
            totalTimePerSecondSum=[math]::Round($totals.totalTime,6)
            blockReadTimePerSecondSum=[math]::Round($totals.blockReadTime,6)
            blockReadTimeSharePercent=$blockReadTimeSharePercent
            sharedBlocksReadPerSecondSum=[math]::Round($totals.sharedBlocksRead,6)
            tempBlocksReadPerSecondSum=[math]::Round($totals.tempBlocksRead,6)
            tempBlocksWrittenPerSecondSum=[math]::Round($totals.tempBlocksWritten,6)
            temporaryIoAbsent=$temporaryIoAbsent
            dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
            failureReasons=@($failureReasons);passed=$passed
        }
    }
}

function Get-HistoryFallbackSampledLoadEvidence {
    param($Config, [string]$StartUtc, [string]$EndUtc, [string]$DbiResourceId,
        [string]$ExpectedTokenId, [string]$ExpectedTokenSha256)
    $identity = $Config.HistoryFallbackSqlIdentity
    if ($null -eq $identity -or [string]$identity.DatabaseResourceId -cne $DbiResourceId) {
        throw "History fallback sampled-load evidence requires the exact bound DBI resource identity."
    }
    $filter = ([ordered]@{"db.sql_tokenized.db_id"=[string]$identity.QueryIdentifier} | ConvertTo-Json -Compress)
    $pages = Invoke-EvidenceAwsJsonPages -Arguments @("pi","describe-dimension-keys","--region",$Config.Resources.region,
        "--service-type","RDS","--identifier",$DbiResourceId,"--start-time",$StartUtc,"--end-time",$EndUtc,
        "--period-in-seconds","60","--metric","db.load.avg",
        "--group-by","Group=db.sql_tokenized,Dimensions=[db.sql_tokenized.db_id,db.sql_tokenized.id,db.sql_tokenized.statement],Limit=25",
        "--filter",$filter) -ItemsProperty "Keys" -TokenProperty "NextToken" `
        -ExpectedAlignedStartUtc $StartUtc -ExpectedAlignedEndUtc $EndUtc -Identity {
            param($key)
            $dimensions = Get-Value $key "Dimensions" $null
            return "$([string](Get-Value $dimensions 'db.sql_tokenized.db_id' ''))|$([string](Get-Value $dimensions 'db.sql_tokenized.id' ''))"
        }
    $keys = @($pages.Items)
    if ($keys.Count -eq 0) {
        return [ordered]@{
            status="not_applicable_zero_sampled_load";sampledDbLoad=0.0;tokenCount=0;pageCount=$pages.PageCount
            filteredWaitEventEvidenceRequired=$false;filteredWaitEventEvidenceComplete=$true
            dataFileReadSharePercent=$null;dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
            failureReasons=@();passed=$true
        }
    }
    if ($keys.Count -ne 1) {
        return [ordered]@{
            status="ambiguous_sampled_identity";sampledDbLoad=$null;tokenCount=$keys.Count;pageCount=$pages.PageCount
            filteredWaitEventEvidenceRequired=$false;filteredWaitEventEvidenceComplete=$false
            dataFileReadSharePercent=$null;dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
            failureReasons=@("ambiguous_sampled_identity");passed=$false
        }
    }
    $key = $keys[0]
    $dimensions = Get-Value $key "Dimensions" $null
    $dbId = [string](Get-Value $dimensions "db.sql_tokenized.db_id" "")
    $tokenId = [string](Get-Value $dimensions "db.sql_tokenized.id" "")
    $statement = [string](Get-Value $dimensions "db.sql_tokenized.statement" "")
    $rawLoad = Get-Value $key "Total" $null
    if ($null -eq $rawLoad -or $rawLoad -isnot [ValueType] -or $rawLoad -is [bool] -or $rawLoad -is [char]) {
        throw "History fallback sampled-load evidence returned a malformed load value."
    }
    try { $load = [double]$rawLoad }
    catch { throw "History fallback sampled-load evidence returned a malformed load value." }
    if ([double]::IsNaN($load) -or [double]::IsInfinity($load) -or $load -lt 0) {
        throw "History fallback sampled-load evidence returned a malformed load value."
    }
    if ($dbId -cne [string]$identity.QueryIdentifier -or $tokenId -cne $ExpectedTokenId -or
        [string]::IsNullOrWhiteSpace($statement)) {
        return [ordered]@{
            status="sampled_identity_mismatch";sampledDbLoad=[math]::Round($load,6)
            tokenCount=1;pageCount=$pages.PageCount;filteredWaitEventEvidenceRequired=($load -gt 0)
            filteredWaitEventEvidenceComplete=$false;dataFileReadSharePercent=$null
            dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
            failureReasons=@("sampled_identity_mismatch");passed=$false
        }
    }
    $lowerStatement = $statement.ToLowerInvariant()
    if (@($script:HistoryFallbackSqlMarkers | Where-Object { $lowerStatement.Contains($_) }).Count -ne
        $script:HistoryFallbackSqlMarkers.Count) {
        return [ordered]@{
            status="sampled_identity_mismatch";sampledDbLoad=[math]::Round($load,6);tokenCount=1;pageCount=$pages.PageCount
            filteredWaitEventEvidenceRequired=($load -gt 0);filteredWaitEventEvidenceComplete=$false
            dataFileReadSharePercent=$null;dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
            failureReasons=@("sampled_identity_mismatch");passed=$false
        }
    }
    $tokenSha256 = Get-StableJsonSha256 ([ordered]@{
        queryIdentifierSha256=$identity.QueryIdentifierSha256;supportId=$tokenId;statement=$statement
    })
    if ($tokenSha256 -cne $ExpectedTokenSha256) {
        return [ordered]@{
            status="sampled_identity_mismatch";sampledDbLoad=[math]::Round($load,6);tokenCount=1;pageCount=$pages.PageCount
            filteredWaitEventEvidenceRequired=($load -gt 0);filteredWaitEventEvidenceComplete=$false
            dataFileReadSharePercent=$null;dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
            failureReasons=@("sampled_identity_mismatch");passed=$false
        }
    }
    if ($load -eq 0.0) {
        return [ordered]@{
            status="not_applicable_zero_sampled_load";sampledDbLoad=0.0;tokenCount=1;pageCount=$pages.PageCount
            tokenSha256=$tokenSha256;filteredWaitEventEvidenceRequired=$false
            filteredWaitEventEvidenceComplete=$true;dataFileReadSharePercent=$null
            dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent;failureReasons=@();passed=$true
        }
    }
    try {
        $waitEvidence = Get-HistoryFallbackWaitEventEvidence $Config $StartUtc $EndUtc $DbiResourceId `
            ([string]$identity.QueryIdentifier) $tokenId $tokenSha256 $load
    }
    catch {
        $waitFailure = [InvalidOperationException]::new($_.Exception.Message, $_.Exception)
        $waitFailure.Data["historyFallbackFailureStage"] = "fallback_token_wait_events"
        throw $waitFailure
    }
    return [ordered]@{
        status="sampled_load_wait_events_required";sampledDbLoad=[math]::Round($load,6);tokenCount=1
        pageCount=$pages.PageCount;tokenSha256=$tokenSha256;filteredWaitEventEvidenceRequired=$true
        filteredWaitEventEvidenceComplete=((Get-Value $waitEvidence "complete" $false) -eq $true)
        dataFileReadSharePercent=$waitEvidence.dataFileReadSharePercent
        dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
        waitEvents=$waitEvidence
        failureReasons=if((Get-Value $waitEvidence "passed" $false) -eq $true){@()}else{
            @("sampled_wait_gate_failed") + @((Get-Value $waitEvidence "failureReasons" @()))
        }
        passed=((Get-Value $waitEvidence "passed" $false) -eq $true)
    }
}

function Get-HotPathFallbackEvidenceWindows {
    param($Config, [string]$StartUtc, [string]$EndUtc)
    $piWindow = Get-PerformanceInsightsEvidenceWindow $StartUtc $EndUtc
    $trafficStart = $piWindow.CoherentStart
    $trafficEnd = $piWindow.CoherentEnd
    $evidenceStart = $piWindow.AlignedStart
    $evidenceEnd = $piWindow.AlignedEnd
    $startMs = $trafficStart.ToUnixTimeMilliseconds()
    $endMs = $trafficEnd.ToUnixTimeMilliseconds()
    $binding = Get-BoundApiAwslogsBinding $Config
    $pages = Invoke-EvidenceAwsJsonPages -Arguments @("logs","filter-log-events","--region",$binding.LogRegion,
        "--log-group-name",$binding.LogGroup,"--log-stream-name-prefix",$binding.ApiStreamPrefix,
        "--start-time",[string]$startMs,"--end-time",[string]$endMs,
        "--filter-pattern",('"' + $script:HotPathSummaryEvent + '"')) -ItemsProperty "events" -TokenProperty "nextToken" -Identity {
            param($event)
            $eventId = [string](Get-Value $event "eventId" "")
            if ($eventId) { return $eventId }
            return Get-StableJsonSha256 ([ordered]@{timestamp=(Get-Value $event "timestamp");stream=(Get-Value $event "logStreamName");message=(Get-Value $event "message")})
        }
    $windows = @()
    $fallbackItems = 0L
    $databaseReadCount = 0L
    $matchingSummaryCount = 0
    $excludedEdgeSummaryCount = 0
    foreach ($event in @($pages.Items)) {
        $timestamp = [long](Get-Value $event "timestamp" -1)
        $stream = [string](Get-Value $event "logStreamName" "")
        $message = [string](Get-Value $event "message" "")
        if ($timestamp -lt $startMs -or $timestamp -gt $endMs -or
            -not $stream.StartsWith($binding.ApiStreamPrefix, [StringComparison]::Ordinal)) {
            throw "CloudWatch Logs returned out-of-scope hot-path summary evidence."
        }
        try { $payload = $message | ConvertFrom-Json -Depth 20 }
        catch { throw "CloudWatch Logs returned malformed hot-path summary evidence." }
        if ([string](Get-Value $payload "event" "") -cne $script:HotPathSummaryEvent -or
            [int](Get-Value $payload "intervalSeconds" -1) -ne $script:HotPathSummaryIntervalSeconds) {
            throw "CloudWatch Logs returned an unreviewed hot-path summary schema."
        }
        $matchingSummaryCount++
        $counters = Get-Value $payload "counters"
        $rawFallbackItems = Get-Value $counters "tileBatchHistoryFallbackItems" 0
        if ($rawFallbackItems -isnot [ValueType] -or $rawFallbackItems -is [bool] -or $rawFallbackItems -is [char]) {
            throw "CloudWatch Logs returned malformed fallback counters."
        }
        try { $eventFallbackItems = [double]$rawFallbackItems }
        catch { throw "CloudWatch Logs returned malformed fallback counters." }
        if ([double]::IsNaN($eventFallbackItems) -or [double]::IsInfinity($eventFallbackItems) -or
            $eventFallbackItems -lt 0 -or $eventFallbackItems -ne [math]::Floor($eventFallbackItems)) {
            throw "CloudWatch Logs returned malformed fallback counters."
        }
        if ($eventFallbackItems -eq 0) { continue }
        if ([string](Get-Value $payload "historyFallbackSqlIdentityVersion" "") -cne
                [string]$Config.HistoryFallbackSqlIdentity.Version -or
            [string](Get-Value $payload "historyFallbackSqlIdentitySha256" "").ToLowerInvariant() -cne
                [string]$Config.HistoryFallbackSqlIdentity.CompiledSqlSha256 -or
            [string](Get-Value $payload "apiRuntimeTaskDefinitionSha256" "").ToLowerInvariant() -cne
                (Get-StringSha256 ([string]$Config.ApiTaskDefinitionArn))) {
            throw "CloudWatch Logs fallback evidence did not bind the reviewed SQL and API runtime identities."
        }
        try {
            $intervalStart = ConvertTo-ExactUtcDateTimeOffset (Get-Value $payload "intervalStartedAtUtc" $null) "intervalStartedAtUtc"
            $intervalEnd = ConvertTo-ExactUtcDateTimeOffset (Get-Value $payload "intervalEndedAtUtc" $null) "intervalEndedAtUtc"
        }
        catch { throw "CloudWatch Logs fallback evidence did not contain valid UTC interval bounds." }
        if ($intervalEnd -le $intervalStart -or
            [math]::Abs(($intervalEnd - $intervalStart).TotalSeconds - $script:HotPathSummaryIntervalSeconds) -gt 0.000001 -or
            ($intervalStart.UtcDateTime.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or
            ($intervalEnd.UtcDateTime.Ticks % [TimeSpan]::TicksPerMinute) -ne 0) {
            throw "CloudWatch Logs fallback evidence did not contain one complete UTC summary interval."
        }
        $intervalStart = $intervalStart.ToUniversalTime()
        $intervalEnd = $intervalEnd.ToUniversalTime()
        if ($intervalEnd -le $trafficStart -or $intervalStart -ge $trafficEnd) {
            throw "CloudWatch Logs fallback evidence contained a summary interval outside the coherent traffic window."
        }
        $timings = Get-Value $payload "timings"
        $databaseTiming = Get-Value $timings "tileBatchHistoryDatabaseMs"
        $rawDatabaseReadCount = Get-Value $databaseTiming "count" -1
        $rawDatabaseTotalMs = Get-Value $databaseTiming "totalMs" -1
        $rawDatabaseMaxMs = Get-Value $databaseTiming "maxMs" -1
        foreach ($rawDatabaseTimingValue in @($rawDatabaseReadCount,$rawDatabaseTotalMs,$rawDatabaseMaxMs)) {
            if ($rawDatabaseTimingValue -isnot [ValueType] -or $rawDatabaseTimingValue -is [bool] -or
                $rawDatabaseTimingValue -is [char]) {
                throw "CloudWatch Logs returned malformed batch history database timing evidence."
            }
        }
        try {
            $eventDatabaseReadCount = [double]$rawDatabaseReadCount
            $eventDatabaseTotalMs = [double]$rawDatabaseTotalMs
            $eventDatabaseMaxMs = [double]$rawDatabaseMaxMs
        }
        catch { throw "CloudWatch Logs returned malformed batch history database timing evidence." }
        if ([double]::IsNaN($eventDatabaseReadCount) -or [double]::IsInfinity($eventDatabaseReadCount) -or
            $eventDatabaseReadCount -le 0 -or $eventDatabaseReadCount -ne [math]::Floor($eventDatabaseReadCount) -or
            [double]::IsNaN($eventDatabaseTotalMs) -or [double]::IsInfinity($eventDatabaseTotalMs) -or
            [double]::IsNaN($eventDatabaseMaxMs) -or [double]::IsInfinity($eventDatabaseMaxMs) -or
            $eventDatabaseTotalMs -lt 0 -or $eventDatabaseMaxMs -lt 0) {
            throw "CloudWatch Logs returned malformed batch history database timing evidence."
        }
        if ($intervalStart -lt $evidenceStart -or $intervalEnd -gt $evidenceEnd) {
            $excludedEdgeSummaryCount++
            continue
        }
        $fallbackItems += [long]$eventFallbackItems
        $databaseReadCount += [long]$eventDatabaseReadCount
        $windows += [pscustomobject]@{
            StartUtc=$intervalStart.ToString("o");EndUtc=$intervalEnd.ToString("o")
            ObservedSeconds=[math]::Round(($intervalEnd - $intervalStart).TotalSeconds,3)
            FallbackItems=[long]$eventFallbackItems;DatabaseReadCount=[long]$eventDatabaseReadCount
        }
    }
    $evidence = [ordered]@{
        source="cloudwatch_logs";sourceEvent=$script:HotPathSummaryEvent
        sourceIntervalSeconds=$script:HotPathSummaryIntervalSeconds;pageCount=$pages.PageCount;matchingSummaryCount=$matchingSummaryCount
        fallbackPositiveSummaryCount=$windows.Count;fallbackItems=$fallbackItems;evidenceWindowCount=$windows.Count
        batchHistoryDatabaseReadCount=$databaseReadCount
        excludedEdgeSummaryCount=$excludedEdgeSummaryCount
        coherentWindowSha256=$piWindow.Evidence.coherentWindowSha256
        alignedEvidenceWindowSha256=$piWindow.Evidence.alignedEvidenceWindowSha256
        alignedDurationSeconds=$piWindow.Evidence.alignedDurationSeconds
        completeMinuteCount=$piWindow.Evidence.completeMinuteCount
        alignedCoveragePercent=$piWindow.Evidence.alignedCoveragePercent
        historyFallbackSqlIdentityVersion=$Config.HistoryFallbackSqlIdentity.Version
        historyFallbackSqlIdentitySha256=$Config.HistoryFallbackSqlIdentity.CompiledSqlSha256
        apiRuntimeTaskDefinitionSha256=(Get-StringSha256 ([string]$Config.ApiTaskDefinitionArn))
        exactTaskDefinitionBound=$true;logDriver=$binding.LogDriver;logRegion=$binding.LogRegion
        logGroupSha256=(Get-StringSha256 $binding.LogGroup)
        streamPrefixSha256=(Get-StringSha256 $binding.ApiStreamPrefix)
        rawMessagesPersisted=$false;rawIdentifiersPersisted=$false
    }
    return [pscustomobject]@{Windows=$windows;Evidence=$evidence}
}

function Get-PerformanceInsightsMetricPoints {
    param($Config, [string]$StartUtc, [string]$EndUtc, [string]$DbiResourceId)
    $baseArguments = @("pi","get-resource-metrics","--region",$Config.Resources.region,"--service-type","RDS",
        "--identifier",$DbiResourceId,"--start-time",$StartUtc,"--end-time",$EndUtc,"--period-in-seconds","60",
        "--period-alignment","START_TIME","--metric-queries","Metric=db.load.avg")
    $seenTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $seenPoints = @{}
    $points = [Collections.Generic.List[object]]::new()
    $token = $null
    $pageCount = 0
    do {
        $pageCount++
        if ($pageCount -gt $script:EvidenceMaximumPages) { throw "Performance Insights metric pagination exceeded the page limit." }
        $arguments = @($baseArguments) + @("--no-paginate")
        if (-not [string]::IsNullOrWhiteSpace([string]$token)) { $arguments += @("--next-token", [string]$token) }
        $page = Invoke-AwsJson $arguments
        Assert-PerformanceInsightsResponseScope $page $StartUtc $EndUtc $DbiResourceId
        $metrics = @((Get-Value $page "MetricList" @()))
        $metricKey = if ($metrics.Count -eq 1) { Get-Value $metrics[0] "Key" $null } else { $null }
        $metricName = if ($metricKey -is [string]) { [string]$metricKey } else { [string](Get-Value $metricKey "Metric" "") }
        if ($metrics.Count -ne 1 -or $metricName -notmatch '^db\.load\.avg') {
            throw "Performance Insights returned an unexpected DB load metric shape."
        }
        foreach ($point in @((Get-Value $metrics[0] "DataPoints" @()))) {
            $rawTimestamp = Get-Value $point "Timestamp" $null
            $rawValue = Get-Value $point "Value" $null
            if ($null -eq $rawTimestamp -or $null -eq $rawValue -or
                $rawValue -isnot [ValueType] -or $rawValue -is [bool] -or $rawValue -is [char]) {
                throw "Performance Insights returned a malformed DB load datapoint."
            }
            try {
                $timestamp = ConvertTo-ExactUtcDateTimeOffset $rawTimestamp "DB load timestamp"
                $value = [double]$rawValue
                $scopeStart = ConvertTo-ExactUtcDateTimeOffset $StartUtc "DB load scope start"
                $scopeEnd = ConvertTo-ExactUtcDateTimeOffset $EndUtc "DB load scope end"
            }
            catch { throw "Performance Insights returned a malformed DB load datapoint." }
            if ($timestamp -lt $scopeStart -or $timestamp -ge $scopeEnd -or
                [double]::IsNaN($value) -or [double]::IsInfinity($value) -or $value -lt 0) {
                throw "Performance Insights returned an out-of-scope or non-finite DB load datapoint."
            }
            $canonicalTimestamp = $timestamp.ToString("o")
            $hash = Get-StableJsonSha256 ([ordered]@{timestamp=$canonicalTimestamp;value=$value})
            if ($seenPoints.ContainsKey($canonicalTimestamp)) {
                if ([string]$seenPoints[$canonicalTimestamp] -cne $hash) { throw "Performance Insights returned conflicting DB load datapoints." }
                continue
            }
            $seenPoints[$canonicalTimestamp] = $hash
            $points.Add([pscustomobject]@{Timestamp=$canonicalTimestamp;Value=$value})
            if ($points.Count -gt $script:EvidenceMaximumRecords) { throw "Performance Insights metric pagination exceeded the record limit." }
        }
        $token = [string](Get-Value $page "NextToken" "")
        if (-not [string]::IsNullOrWhiteSpace($token) -and -not $seenTokens.Add($token)) {
            throw "Performance Insights metric pagination returned a token cycle."
        }
    } while (-not [string]::IsNullOrWhiteSpace($token))
    return [pscustomobject]@{Points=$points.ToArray();PageCount=$pageCount}
}

function Get-PerformanceInsightsEvidence {
    param($Config, [string]$StartUtc, [string]$EndUtc, [string]$DbiResourceId)
    $completedStages = [Collections.Generic.List[string]]::new()
    $partialEvidence = [ordered]@{}
    try { $piWindow = Get-PerformanceInsightsEvidenceWindow $StartUtc $EndUtc }
    catch { throw (New-StagedEvidenceException "db_load_series" $_ @($completedStages) $partialEvidence) }
    $alignedStartUtc = $piWindow.AlignedStart.ToString("o")
    $alignedEndUtc = $piWindow.AlignedEnd.ToString("o")
    $partialEvidence["evidenceWindow"] = $piWindow.Evidence
    try { $metric = Get-PerformanceInsightsMetricPoints $Config $alignedStartUtc $alignedEndUtc $DbiResourceId }
    catch { throw (New-StagedEvidenceException "db_load_series" $_ @($completedStages) $partialEvidence) }
    $points = @($metric.Points | Where-Object { $null -ne (Get-Value $_ "Value" $null) })
    if ($points.Count -lt 1) {
        try { throw "Performance Insights returned no DB load datapoints for the traffic interval." }
        catch { throw (New-StagedEvidenceException "db_load_series" $_ @($completedStages) $partialEvidence) }
    }
    $averageDbLoad = [double](($points.Value | Measure-Object -Average).Average)
    $completedStages.Add("db_load_series")
    $partialEvidence["dbLoadSeries"] = [ordered]@{
        pointCount=$points.Count;pageCount=$metric.PageCount;averageDbLoad=[math]::Round($averageDbLoad,6)
    }
    try { $topTokens = Get-PerformanceInsightsTopTokens $Config $alignedStartUtc $alignedEndUtc $DbiResourceId }
    catch { throw (New-StagedEvidenceException "full_interval_top_tokens" $_ @($completedStages) $partialEvidence) }
    $entries = @($topTokens.Sanitized)
    $authLoad = 0.0
    $authTokenCount = 0
    foreach ($token in @($topTokens.Internal)) {
        if ($token.IsAuthorization) { $authLoad += [double]$token.Load; $authTokenCount++ }
    }
    if ($averageDbLoad -le 0 -or $entries.Count -lt 1) {
        try { throw "Performance Insights evidence was incomplete for a nonzero diagnostic workload." }
        catch { throw (New-StagedEvidenceException "full_interval_top_tokens" $_ @($completedStages) $partialEvidence) }
    }
    $rawAuthPercent = ($authLoad / $averageDbLoad) * 100.0
    $authPercent = [math]::Round($rawAuthPercent, 6)
    $authPassed = $rawAuthPercent -lt 50.0
    $completedStages.Add("full_interval_top_tokens")
    $partialEvidence["fullIntervalTopTokens"] = [ordered]@{
        pageCount=$topTokens.PageCount;topTokenCount=$entries.Count;tokens=$entries
        tileAuthorization=[ordered]@{tokenCount=$authTokenCount;dbLoad=[math]::Round($authLoad,6);
            sharePercent=$authPercent;dominanceThresholdPercent=50.0;passed=$authPassed}
    }
    try { $hotPath = Get-HotPathFallbackEvidenceWindows $Config $StartUtc $EndUtc }
    catch { throw (New-StagedEvidenceException "hot_path_log_windows" $_ @($completedStages) $partialEvidence) }
    $completedStages.Add("hot_path_log_windows")
    $partialEvidence["hotPathLogWindows"] = $hotPath.Evidence
    if ($hotPath.Windows.Count -lt 1 -or [long]$hotPath.Evidence.batchHistoryDatabaseReadCount -le 0) {
        $historyFallback = [ordered]@{
            historyFallbackPiEvidenceVersion=$script:HistoryFallbackPiEvidenceVersion
            queryIdentifierSha256=$Config.HistoryFallbackSqlIdentity.QueryIdentifierSha256
            source=$hotPath.Evidence;sqlStatistics=$null;sampledLoad=$null;passed=$false
        }
        return [ordered]@{
            diagnosticOnly=$true;sanitized=$true;tokenized=$true;rawSqlPersisted=$false;rawIdentifiersPersisted=$false
            metric="db.load.avg";startUtc=$alignedStartUtc;endUtc=$alignedEndUtc;periodSeconds=60;evidenceWindow=$piWindow.Evidence
            dbLoadPointCount=$points.Count;dbLoadPageCount=$metric.PageCount;averageDbLoad=[math]::Round($averageDbLoad,6)
            topTokenCount=$entries.Count;tokens=$entries
            tileAuthorization=[ordered]@{tokenCount=$authTokenCount;dbLoad=[math]::Round($authLoad,6);
                sharePercent=$authPercent;dominanceThresholdPercent=50.0;absentFromTopTokens=($authTokenCount -eq 0);passed=$authPassed}
            historyFallback=$historyFallback;passed=$false
        }
    }
    try {
        $sqlStats = Get-HistoryFallbackSqlStatsEvidence $Config $alignedStartUtc $alignedEndUtc $DbiResourceId `
            ([long]$hotPath.Evidence.batchHistoryDatabaseReadCount) @($hotPath.Windows)
    }
    catch { throw (New-StagedEvidenceException "fallback_window_top_tokens" $_ @($completedStages) $partialEvidence) }
    $partialEvidence["fallbackSqlStatistics"] = $sqlStats.Evidence
    if ((Get-Value $sqlStats "CanSample" $false) -eq $true) {
        try {
            $sampledLoad = Get-HistoryFallbackSampledLoadEvidence $Config $alignedStartUtc $alignedEndUtc $DbiResourceId `
                $sqlStats.TokenId $sqlStats.TokenSha256
        }
        catch {
            $sampledLoadStage = if ($_.Exception.Data.Contains("historyFallbackFailureStage")) {
                [string]$_.Exception.Data["historyFallbackFailureStage"]
            } else { "fallback_window_top_tokens" }
            if ($sampledLoadStage -ceq "fallback_token_wait_events") {
                $completedStages.Add("fallback_window_top_tokens")
            }
            throw (New-StagedEvidenceException $sampledLoadStage $_ @($completedStages) $partialEvidence)
        }
    } else {
        $sampledLoad = [ordered]@{
            status="not_evaluated_identity_gate_failed";sampledDbLoad=$null;tokenCount=0
            filteredWaitEventEvidenceRequired=$false;filteredWaitEventEvidenceComplete=$false
            dataFileReadSharePercent=$null;dominanceThresholdPercent=$script:HistoryIoDominanceThresholdPercent
            failureReasons=@("sql_identity_gate_failed");passed=$false
        }
    }
    $completedStages.Add("fallback_window_top_tokens")
    if ((Get-Value $sampledLoad "filteredWaitEventEvidenceRequired" $false) -eq $true) {
        $completedStages.Add("fallback_token_wait_events")
    }
    $historyPassed = (Get-Value $sqlStats.Evidence "passed" $false) -eq $true -and
        (Get-Value $sampledLoad "passed" $false) -eq $true
    return [ordered]@{
        diagnosticOnly=$true;sanitized=$true;tokenized=$true;rawSqlPersisted=$false;rawIdentifiersPersisted=$false;metric="db.load.avg"
        startUtc=$alignedStartUtc;endUtc=$alignedEndUtc;periodSeconds=60;evidenceWindow=$piWindow.Evidence
        dbLoadPointCount=$points.Count;dbLoadPageCount=$metric.PageCount
        averageDbLoad=[math]::Round($averageDbLoad,6);topTokenCount=$entries.Count;tokens=$entries
        tileAuthorization=[ordered]@{tokenCount=$authTokenCount;
            dbLoad=[math]::Round($authLoad,6);sharePercent=$authPercent;dominanceThresholdPercent=50.0;
            absentFromTopTokens=($authTokenCount -eq 0);passed=$authPassed}
        historyFallback=[ordered]@{
            historyFallbackPiEvidenceVersion=$script:HistoryFallbackPiEvidenceVersion
            queryIdentifierSha256=$Config.HistoryFallbackSqlIdentity.QueryIdentifierSha256
            compiledSqlSha256=$Config.HistoryFallbackSqlIdentity.CompiledSqlSha256
            sqlStatistics=$sqlStats.Evidence;sampledLoad=$sampledLoad;source=$hotPath.Evidence;passed=$historyPassed
        }
        passed=($authPassed -and $historyPassed)
    }
}

function Get-StabilizedPerformanceInsightsEvidence {
    param($Config, [string]$StartUtc, [string]$EndUtc, [string]$DbiResourceId)
    $trafficEnd = ([DateTimeOffset]$EndUtc).ToUniversalTime()
    $notBefore = $trafficEnd.AddMinutes($script:PerformanceInsightsInitialDelayMinutes)
    $deadline = $trafficEnd.AddMinutes($script:PerformanceInsightsStabilizationDeadlineMinutes)
    $now = Get-EvidenceUtcNow
    if ($now -ge $deadline) {
        $expired = [InvalidOperationException]::new("Performance Insights stabilization began at or after its evidence deadline.")
        $expired.Data["failureStage"] = "snapshot_stabilization"
        $expired.Data["attemptCount"] = 0
        $expired.Data["completedStages"] = @()
        $expired.Data["partialEvidence"] = $null
        throw $expired
    }
    if ($now -lt $notBefore) {
        $waitSeconds = [int][math]::Ceiling(($notBefore - $now).TotalSeconds)
        if ($waitSeconds -gt 0) { Wait-EvidenceDelay $waitSeconds }
        $now = Get-EvidenceUtcNow
        if ($now -ge $deadline) {
            $expired = [InvalidOperationException]::new("Performance Insights stabilization reached its deadline before the first snapshot.")
            $expired.Data["failureStage"] = "snapshot_stabilization"
            $expired.Data["attemptCount"] = 0
            $expired.Data["completedStages"] = @()
            $expired.Data["partialEvidence"] = $null
            throw $expired
        }
    }
    $attemptCount = 0
    $priorHash = $null
    $lastError = $null
    $lastCompleteSnapshot = $null
    $lastCompleteHash = $null
    $priorSnapshotCompletedAt = $null
    $minimumPollSeconds = [math]::Max(60, [int]$script:PerformanceInsightsPollSeconds)
    do {
        $snapshotStartedAt = Get-EvidenceUtcNow
        if ($snapshotStartedAt -ge $deadline) { break }
        $attemptCount++
        try {
            $snapshot = Get-PerformanceInsightsEvidence $Config $StartUtc $EndUtc $DbiResourceId
            $snapshotCompletedAt = Get-EvidenceUtcNow
            if ($snapshotCompletedAt -gt $deadline) {
                $late = [InvalidOperationException]::new("Performance Insights snapshot completed after its evidence deadline.")
                $late.Data["failureStage"] = "snapshot_stabilization"
                $late.Data["completedStages"] = @()
                $late.Data["partialEvidence"] = $null
                throw $late
            }
            $snapshotHash = Get-StableJsonSha256 $snapshot
            $lastCompleteSnapshot = $snapshot
            $lastCompleteHash = $snapshotHash
            $separationSeconds = if ($null -eq $priorSnapshotCompletedAt) { 0.0 } else {
                ($snapshotCompletedAt - $priorSnapshotCompletedAt).TotalSeconds
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$priorHash) -and $priorHash -ceq $snapshotHash -and
                $separationSeconds -ge 60.0) {
                return [pscustomobject]@{Evidence=$snapshot;AttemptCount=$attemptCount;CanonicalSha256=$snapshotHash}
            }
            $priorHash = $snapshotHash
            $priorSnapshotCompletedAt = $snapshotCompletedAt
            $lastError = $null
        }
        catch {
            $lastError = $_
            $priorHash = $null
            $priorSnapshotCompletedAt = $null
        }
        $now = Get-EvidenceUtcNow
        if ($now -ge $deadline) { break }
        $nextSnapshotAt = $now.AddSeconds($minimumPollSeconds)
        if ($null -ne $priorSnapshotCompletedAt) {
            $minimumSeparatedAt = $priorSnapshotCompletedAt.AddSeconds(60)
            if ($minimumSeparatedAt -gt $nextSnapshotAt) { $nextSnapshotAt = $minimumSeparatedAt }
        }
        $wakeAt = if ($nextSnapshotAt -lt $deadline) { $nextSnapshotAt } else { $deadline }
        $sleepSeconds = [int][math]::Ceiling(($wakeAt - $now).TotalSeconds)
        if ($sleepSeconds -gt 0) { Wait-EvidenceDelay $sleepSeconds }
    } while ($true)
    if ($null -ne $lastError) {
        $exception = [InvalidOperationException]::new("Performance Insights did not produce a complete stable snapshot.", $lastError.Exception)
        $failureStage = [string]$lastError.Exception.Data["failureStage"]
        if (-not [string]::IsNullOrWhiteSpace($failureStage)) { $exception.Data["failureStage"] = $failureStage }
        if ($lastError.Exception.Data.Contains("completedStages")) {
            $exception.Data["completedStages"] = @($lastError.Exception.Data["completedStages"])
        }
        if ($lastError.Exception.Data.Contains("partialEvidence")) {
            $exception.Data["partialEvidence"] = $lastError.Exception.Data["partialEvidence"]
        }
        $exception.Data["attemptCount"] = $attemptCount
        throw $exception
    }
    $unstable = [InvalidOperationException]::new("Performance Insights did not produce two consecutive identical snapshots.")
    $unstable.Data["failureStage"] = "snapshot_stabilization"
    $unstable.Data["attemptCount"] = $attemptCount
    $unstableCompletedStages = @("db_load_series","full_interval_top_tokens","hot_path_log_windows",
        "fallback_window_top_tokens")
    $lastSampledLoad = Get-Value (Get-Value $lastCompleteSnapshot "historyFallback" $null) "sampledLoad" $null
    if ((Get-Value $lastSampledLoad "filteredWaitEventEvidenceRequired" $false) -eq $true) {
        $unstableCompletedStages += "fallback_token_wait_events"
    }
    $unstable.Data["completedStages"] = $unstableCompletedStages
    $unstable.Data["partialEvidence"] = [ordered]@{
        lastCompleteSnapshot=$lastCompleteSnapshot;lastCompleteCanonicalSha256=$lastCompleteHash
        stableConsecutiveSnapshotCount=1
    }
    throw $unstable
}

function Add-TerminalFailure {
    param($Terminal, [string]$Failure)
    if ([string]::IsNullOrWhiteSpace($Failure)) { return }
    $existing = @($Terminal.failures)
    if ($existing -notcontains $Failure) { $Terminal.failures = @($existing) + @($Failure) }
}

function Remove-TerminalFailure {
    param($Terminal, [string]$Failure)
    if ([string]::IsNullOrWhiteSpace($Failure)) { return }
    $Terminal.failures = @($Terminal.failures | Where-Object { [string]$_ -cne $Failure })
}

function Attach-TerminalMonitorEvidence {
    param($Terminal, $Config, [string]$MonitorResultPath, $MonitorProcess)
    if (-not (Test-Path -LiteralPath $MonitorResultPath -PathType Leaf)) {
        Add-TerminalFailure $Terminal "monitor_terminal_result_missing"
        return $null
    }
    $sha256 = (Get-FileHash -LiteralPath $MonitorResultPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $priorSha256 = [string](Get-Value $Terminal.monitor "sha256" "")
    if (-not [string]::IsNullOrWhiteSpace($priorSha256) -and $priorSha256 -cne $sha256) {
        Add-TerminalFailure $Terminal "monitor_terminal_result_changed_after_attachment"
    }
    try { $result = Read-AtomicJson $MonitorResultPath }
    catch {
        $Terminal.monitor = [ordered]@{path=$MonitorResultPath;sha256=$sha256;result=$null;parseFailure=$true}
        Add-TerminalFailure $Terminal "monitor_terminal_result_malformed"
        return $null
    }
    $exitCode = $null
    if ($null -ne $MonitorProcess) {
        try {
            $MonitorProcess.Refresh()
            if ($MonitorProcess.HasExited) { $exitCode = [int]$MonitorProcess.ExitCode }
        } catch { }
    }
    $Terminal.monitor = [ordered]@{path=$MonitorResultPath;sha256=$sha256;exitCode=$exitCode;result=$result}
    Remove-TerminalFailure $Terminal "monitor_terminal_result_missing"
    Remove-TerminalFailure $Terminal "monitor_terminal_result_malformed"
    if ([string](Get-Value $result "runId" "") -cne [string]$Config.RunId -or
        (Get-Value $result "diagnosticOnly" $false) -ne $true -or
        (Get-Value $result "certificationEligible" $true) -ne $false) {
        Add-TerminalFailure $Terminal "monitor_terminal_result_identity_mismatch"
    } else {
        Remove-TerminalFailure $Terminal "monitor_terminal_result_identity_mismatch"
    }
    return $result
}

function Collect-TerminalPostTrafficEvidence {
    param(
        $Terminal,
        $Config,
        [string]$ProgressPath,
        [string]$SummaryPath,
        [string]$DbiResourceId,
        [ValidateSet("Immediate", "Delayed", "All")]
        [string]$Phase = "All"
    )
    if ($null -eq $Terminal.observedTrafficWindow -or $Terminal.observedTrafficWindow.coherent -ne $true) {
        try {
            $observed = Get-ObservedTrafficWindow $Config $ProgressPath $SummaryPath
            $Terminal.observedTrafficWindow = $observed.Evidence
            if ($observed.Evidence.strictlyComplete -ne $true) {
                Add-TerminalFailure $Terminal "strict_traffic_duration_not_completed"
            }
        }
        catch {
            # The final JSONL record and atomic summary can race each other.
            # Leave the window and all dependent sources unstarted until the
            # bounded terminal commit phase settles the harness outcome.
        }
    }
    if ($Phase -in @("Immediate", "All") -and (Test-EvidenceSourceNotStarted $Terminal.postTrafficAwsPosture)) {
        try {
            $posture = Get-AwsPosture $Config
            $Terminal.postTrafficAwsPosture = New-EvidenceEnvelope -Collected $true -Passed $true -AttemptCount 1 `
                -FailureCode $null -FailureStage $null -MessageSha256 $null -Evidence $posture `
                -CompletedStages @("post_traffic_aws_posture")
        }
        catch {
            $Terminal.postTrafficAwsPosture = New-EvidenceEnvelope -Collected $false -Passed $false -AttemptCount 1 `
                -FailureCode "post_traffic_aws_posture_unavailable" -FailureStage "post_traffic_aws_posture" `
                -MessageSha256 (Get-StringSha256 $_.Exception.Message) -Evidence $null
            Add-TerminalFailure $Terminal "post_traffic_aws_posture_unavailable"
        }
    }
    if ($Phase -notin @("Delayed", "All")) { return }
    $coherent = $null -ne $Terminal.observedTrafficWindow -and
        (Get-Value $Terminal.observedTrafficWindow "coherent" $false) -eq $true
    if (-not $coherent) {
        return
    }
    $startUtc = [string](Get-Value $Terminal.observedTrafficWindow "startUtc" "")
    $endUtc = [string](Get-Value $Terminal.observedTrafficWindow "endUtc" "")
    if (Test-EvidenceSourceNotStarted $Terminal.postgresStatementTimeouts) {
        try {
            $timeoutEvidence = Get-Postgres57014Evidence $Config $startUtc $endUtc
            $Terminal.postgresStatementTimeouts = New-EvidenceEnvelope -Collected $true `
                -Passed ((Get-Value $timeoutEvidence "passed" $false) -eq $true) -AttemptCount 1 `
                -FailureCode $null -FailureStage $null -MessageSha256 $null -Evidence $timeoutEvidence `
                -CompletedStages @("postgres_57014_logs")
        }
        catch {
            $Terminal.postgresStatementTimeouts = New-EvidenceEnvelope -Collected $false -Passed $false -AttemptCount 1 `
                -FailureCode "postgres_statement_timeout_evidence_unavailable" -FailureStage "postgres_57014_logs" `
                -MessageSha256 (Get-StringSha256 $_.Exception.Message) -Evidence $null
            Add-TerminalFailure $Terminal "postgres_statement_timeout_evidence_unavailable"
        }
    }
    if ((Get-Value $Terminal.postgresStatementTimeouts "collected" $false) -eq $true) {
        if ((Get-Value $Terminal.postgresStatementTimeouts "passed" $false) -ne $true) {
            Add-TerminalFailure $Terminal "postgres_statement_timeout_detected"
        }
    }
    if (Test-EvidenceSourceNotStarted $Terminal.performanceInsights) {
        try {
            $stabilized = Get-StabilizedPerformanceInsightsEvidence $Config $startUtc $endUtc $DbiResourceId
            $performanceInsightsCompletedStages = @("db_load_series","full_interval_top_tokens","hot_path_log_windows",
                "fallback_window_top_tokens")
            $stabilizedSampledLoad = Get-Value (Get-Value $stabilized.Evidence "historyFallback" $null) "sampledLoad" $null
            if ((Get-Value $stabilizedSampledLoad "filteredWaitEventEvidenceRequired" $false) -eq $true) {
                $performanceInsightsCompletedStages += "fallback_token_wait_events"
            }
            $performanceInsightsCompletedStages += "snapshot_stabilization"
            $Terminal.performanceInsights = New-EvidenceEnvelope -Collected $true `
                -Passed ((Get-Value $stabilized.Evidence "passed" $false) -eq $true) -AttemptCount $stabilized.AttemptCount `
                -FailureCode $null -FailureStage $null -MessageSha256 $null -Evidence $stabilized.Evidence `
                -CompletedStages $performanceInsightsCompletedStages
            $Terminal.performanceInsights["canonicalSha256"] = $stabilized.CanonicalSha256
        }
        catch {
            $attemptCount = 1
            if ($_.Exception.Data.Contains("attemptCount")) { $attemptCount = [int]$_.Exception.Data["attemptCount"] }
            $stage = "snapshot_stabilization"
            if ($_.Exception.Data.Contains("failureStage")) { $stage = [string]$_.Exception.Data["failureStage"] }
            $completedStages = @()
            if ($_.Exception.Data.Contains("completedStages")) { $completedStages = @($_.Exception.Data["completedStages"]) }
            $partialEvidence = $null
            if ($_.Exception.Data.Contains("partialEvidence")) { $partialEvidence = $_.Exception.Data["partialEvidence"] }
            $allowedStages = @("db_load_series","full_interval_top_tokens","hot_path_log_windows",
                "fallback_window_top_tokens","fallback_token_wait_events","snapshot_stabilization")
            if ($stage -notin $allowedStages) { $stage = "snapshot_stabilization" }
            $Terminal.performanceInsights = New-EvidenceEnvelope -Collected $false -Passed $false -AttemptCount $attemptCount `
                -FailureCode "performance_insights_evidence_unavailable" -FailureStage $stage `
                -MessageSha256 (Get-StringSha256 $_.Exception.Message) -Evidence $null `
                -CompletedStages $completedStages -PartialEvidence $partialEvidence
            Add-TerminalFailure $Terminal "performance_insights_evidence_unavailable"
        }
    }
    if ((Get-Value $Terminal.performanceInsights "collected" $false) -eq $true) {
        $tileAuthorization = Get-Value $Terminal.performanceInsights "tileAuthorization" $null
        if ($null -eq $tileAuthorization -or (Get-Value $tileAuthorization "passed" $false) -ne $true) {
            Add-TerminalFailure $Terminal "tile_authorization_pi_dominance_failed"
        }
        $historyFallback = Get-Value $Terminal.performanceInsights "historyFallback" $null
        if ($null -eq $historyFallback -or (Get-Value $historyFallback "passed" $false) -ne $true) {
            Add-TerminalFailure $Terminal "history_fallback_pi_evidence_failed"
        }
    }
}

function Set-TerminalEvidenceIntegrity {
    param($Terminal, [string]$RestorationPath)
    $embeddedHashes = [ordered]@{}
    foreach ($binding in @(
        [pscustomobject]@{Name="observedTrafficWindow";Value=$Terminal.observedTrafficWindow},
        [pscustomobject]@{Name="postgresStatementTimeouts";Value=$Terminal.postgresStatementTimeouts},
        [pscustomobject]@{Name="performanceInsights";Value=$Terminal.performanceInsights},
        [pscustomobject]@{Name="postTrafficAwsPosture";Value=$Terminal.postTrafficAwsPosture},
        [pscustomobject]@{Name="historyFallbackQueryIdentity";Value=(Get-Value $Terminal "historyFallbackQueryIdentity")},
        [pscustomobject]@{Name="databaseInsightsLease";Value=(Get-Value $Terminal "databaseInsightsLease")}
    )) {
        if ($null -ne $binding.Value) {
            $embeddedHashes[$binding.Name] = [ordered]@{storage="embedded";sha256=(Get-StableJsonSha256 $binding.Value)}
        }
    }
    $restorationIntegrity = $null
    if (Test-Path -LiteralPath $RestorationPath -PathType Leaf) {
        $restorationIntegrity = [ordered]@{storage="file";path=$RestorationPath;
            sha256=(Get-FileHash -LiteralPath $RestorationPath -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $monitorIntegrity = if ($null -ne $Terminal.monitor -and
        -not [string]::IsNullOrWhiteSpace([string]$Terminal.monitor.sha256)) {
        [ordered]@{storage="file";path=$Terminal.monitor.path;sha256=$Terminal.monitor.sha256}
    } else { $null }
    $Terminal.evidenceIntegrity = [ordered]@{
        algorithm="sha256";embeddedCanonicalization="powershell-convertto-json-depth-50-compress-utf8"
        monitor=$monitorIntegrity;embeddedObjects=$embeddedHashes;scalingRestoration=$restorationIntegrity
    }
}

function New-MonitorConfiguration {
    param($Config, [string]$ProgressPath, [string]$SummaryPath, [string]$GeneratorIpPath,
        [string]$CoordinatorHeartbeatPath, $Harness, [DateTimeOffset]$LaunchedAt)
    $resources = $Config.Resources | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30
    return [ordered]@{
        schemaVersion=1;runId=$Config.RunId;phase="Waf";diagnosticOnly=$true;evidenceDirectory=$Config.EvidenceDirectory
        loadProgressPath=$ProgressPath;loadSummaryPath=$SummaryPath;expectedGeneratorPublicIp=$Config.ExpectedGeneratorPublicIp
        generatorIpEvidencePath=$GeneratorIpPath;minimumWallClockSeconds=1800;deadlineUtc=$LaunchedAt.AddMinutes(50).ToString("o")
        artifactsNotBeforeUtc=$LaunchedAt.ToString("o");workload=[ordered]@{stage="800";devices=810;durationSeconds=1800;
            screenshotBytes=40960;canaryDevices=10;workloadSchemaVersion=$script:WorkloadSchemaVersion;endpointShapeSha256=$script:EndpointShapeSha256}
        automaticRollback=$false;requireLoadAcceptance=$true;pollSeconds=60;notificationTopicArn=[string]$resources.notificationTopicArn
        harnessProcessId=$Harness.Id;harnessProcessStartedAtUtc=([DateTimeOffset]$Harness.StartTime).ToUniversalTime().ToString("o")
        harnessProcessPath=[IO.Path]::GetFullPath($Harness.Path);supervisedHeartbeatPaths=@($CoordinatorHeartbeatPath)
        resources=$resources
    }
}

function Stop-ProcessBounded {
    param($Process)
    if ($null -eq $Process) { return }
    try { $Process.Refresh() } catch { return }
    if ($Process.HasExited) { return }
    Stop-Process -Id $Process.Id
    if (-not $Process.WaitForExit(15000)) { Stop-Process -Id $Process.Id -Force }
}

function Set-SleepPrevention {
    param([bool]$Enabled)
    if (-not $IsWindows) { return }
    if (-not ("SchoolPilot.DiagnosticPowerState" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace SchoolPilot { public static class DiagnosticPowerState {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint flags);
} }
"@
    }
    $flags = if($Enabled){[Convert]::ToUInt32("80000041",16)}else{[Convert]::ToUInt32("80000000",16)}
    if ([SchoolPilot.DiagnosticPowerState]::SetThreadExecutionState($flags) -eq 0) { throw "Unable to set diagnostic sleep prevention." }
}

$config = Read-DiagnosticConfiguration
$databaseInsightsLeaseValidation = $null

if ($Mode -eq "Validate") {
    try {
        $validationScratch = Get-ValidationScratchPaths $config
        try {
            $preflightReceipt = Invoke-HarnessPreflight -Config $config -ProgressPath $validationScratch.ProgressPath `
                -SummaryPath $validationScratch.SummaryPath -PersistReceipt:$false
        }
        finally {
            foreach ($scratchPath in @($validationScratch.ProgressPath, $validationScratch.SummaryPath)) {
                if (Test-Path -LiteralPath $scratchPath) { Remove-Item -LiteralPath $scratchPath -Force -ErrorAction SilentlyContinue }
            }
        }
        # Acquisition is performed by the external guarded preparation step.
        # Successful validation is AWS-read-only and retains the exact active
        # lease for Run. Any failed validation restores the captured posture.
        $databaseInsightsLeaseValidation = Invoke-DatabaseInsightsLeaseController -Config $config -LeaseMode Validate
        $awsPosture = Get-AwsPosture $config
        [ordered]@{valid=$true;diagnosticOnly=$true;certificationEligible=$false;nonMutating=$true;runId=$config.RunId;
            workload=[ordered]@{stage="800";devices=810;durationSeconds=1800;screenshotBytes=40960;canaryDevices=10;
                workloadSchemaVersion=$script:WorkloadSchemaVersion;endpointShapeSha256=$script:EndpointShapeSha256};
            deploymentIdentity=[ordered]@{applicationGitSha=$config.ApplicationGitSha;deployedImageDigest=$config.ImageDigest;
                apiTaskDefinitionArn=$config.ApiTaskDefinitionArn;workerTaskDefinitionArn=$config.WorkerTaskDefinitionArn};
            harnessPreflight=$preflightReceipt;databaseInsightsLease=$databaseInsightsLeaseValidation;awsPosture=$awsPosture} | ConvertTo-Json -Depth 40
        exit 0
    }
    catch {
        $validationError = $_
        try { [void](Invoke-DatabaseInsightsLeaseController -Config $config -LeaseMode Restore) }
        catch { throw "Diagnostic validation failed and exact Database Insights restoration also failed; progression is blocked." }
        throw $validationError
    }
}

$runLock = $null
try {
    $progressPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-load-progress.jsonl"
    $summaryPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-load-summary.json"
    $capturePath = Join-Path $config.EvidenceDirectory "$($config.RunId)-scaling-capture.json"
    $restorationPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-scaling-restoration.json"
    $resultPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-diagnostic-result.json"
    $heartbeatPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-coordinator-heartbeat.json"
    $monitorResultPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-monitor-result.json"
    $runLock = Enter-DiagnosticRunLock $config
}
catch {
    $pathOrLockError = $_
    if ($Mode -eq "Run") {
        try { [void](Invoke-DatabaseInsightsLeaseController -Config $config -LeaseMode Restore) }
        catch { throw "Diagnostic initialization failed before lease validation and exact Database Insights restoration also failed; progression is blocked." }
    }
    throw $pathOrLockError
}
if ($Mode -eq "Restore") {
    $restoreExitCode = 4
    New-Item -ItemType Directory -Path $config.EvidenceDirectory -Force | Out-Null
    $restoration = $null
    $databaseInsightsRestoration = $null
    try {
        try {
            if (-not (Test-Path -LiteralPath $capturePath)) { throw "No durable scaling capture exists for this run." }
            $capture = Read-AtomicJson $capturePath
            if ([string]$capture.runId -ne $config.RunId -or [string]$capture.configSha256 -cne $config.Sha256 -or $capture.mutationStarted -ne $true) {
                throw "The durable scaling capture does not authorize restoration for this exact config/run."
            }
            $restoration = Restore-ScalingCapture $config $capture
        }
        catch {
            $restoration = [ordered]@{restored=$false;attempted=$true;timestamp=[DateTimeOffset]::UtcNow.ToString("o");
                failureCode="scaling_restoration_failed";messageSha256=(Get-StringSha256 $_.Exception.Message);rawErrorPersisted=$false}
        }
        try {
            $lease = Invoke-DatabaseInsightsLeaseController -Config $config -LeaseMode Restore
            $databaseInsightsRestoration = [ordered]@{attempted=$true;restored=$true;
                completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");lease=$lease;rawErrorPersisted=$false}
        }
        catch {
            $databaseInsightsRestoration = [ordered]@{attempted=$true;restored=$false;
                completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");failureCode="database_insights_lease_restoration_failed";
                messageSha256=(Get-StringSha256 $_.Exception.Message);rawErrorPersisted=$false}
        }
        Write-AtomicJson $restorationPath $restoration
        if (-not (Test-Path -LiteralPath $resultPath)) {
            $restorationSha256 = (Get-FileHash -LiteralPath $restorationPath -Algorithm SHA256).Hash.ToLowerInvariant()
            Write-AtomicJson $resultPath ([ordered]@{type="waf800_batch_diagnostic_terminal";schemaVersion=1;runId=$config.RunId;
                diagnosticOnly=$true;certificationEligible=$false;supervisorSealed=$false;
                status=if($restoration.restored -eq $true -and $databaseInsightsRestoration.restored -eq $true){"interrupted_restored"}else{"restoration_failed"};
                timestamp=[DateTimeOffset]::UtcNow.ToString("o");scalingRestoration=$restoration;
                databaseInsightsLease=[ordered]@{version=$config.DatabaseInsightsLease.Version;
                    receiptSha256=$config.DatabaseInsightsLease.ReceiptSha256;restoration=$databaseInsightsRestoration};
                evidenceIntegrity=[ordered]@{algorithm="sha256";scalingRestoration=[ordered]@{
                    storage="file";path=$restorationPath;sha256=$restorationSha256}}})
        }
        if ($restoration.restored -eq $true -and $databaseInsightsRestoration.restored -eq $true) { $restoreExitCode = 0 }
    }
    finally { Exit-DiagnosticRunLock $runLock }
    exit $restoreExitCode
}

try {
    New-Item -ItemType Directory -Path $config.EvidenceDirectory -Force | Out-Null
    $preflightStdoutPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-harness-preflight.stdout.log"
    $preflightStderrPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-harness-preflight.stderr.log"
    foreach ($path in @($progressPath,$summaryPath,$capturePath,$restorationPath,$resultPath,$heartbeatPath,$preflightStdoutPath,$preflightStderrPath)) {
        if (Test-Path -LiteralPath $path) { throw "Diagnostic run artifact already exists: $path" }
    }
    $preflightReceipt = Invoke-HarnessPreflight $config $progressPath $summaryPath -PersistReceipt
    $databaseInsightsLeaseValidation = Invoke-DatabaseInsightsLeaseController -Config $config -LeaseMode Validate
    $awsPosture = Get-AwsPosture $config
    Assert-NoScheduledBoundaryOverlap
    $controllerHashes = [ordered]@{
        coordinator=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
        monitor=(Get-FileHash -LiteralPath $script:MonitorScript -Algorithm SHA256).Hash.ToLowerInvariant()
        harness=(Get-FileHash -LiteralPath $script:HarnessScript -Algorithm SHA256).Hash.ToLowerInvariant()
        monotonicDeadline=(Get-FileHash -LiteralPath $script:MonotonicDeadlineScript -Algorithm SHA256).Hash.ToLowerInvariant()
        tilePollAccounting=(Get-FileHash -LiteralPath $script:TilePollAccountingScript -Algorithm SHA256).Hash.ToLowerInvariant()
        databaseInsightsLease=(Get-FileHash -LiteralPath $script:DatabaseInsightsLeaseScript -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $capture = [ordered]@{schemaVersion=1;runId=$config.RunId;configSha256=$config.Sha256;capturedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");
        mutationStarted=$false;original=$awsPosture}
    Write-AtomicJson $capturePath $capture
}
catch {
    $initializationError = $_
    $databaseInsightsInitializationRestoreFailed = $false
    try { [void](Invoke-DatabaseInsightsLeaseController -Config $config -LeaseMode Restore) }
    catch { $databaseInsightsInitializationRestoreFailed = $true }
    Exit-DiagnosticRunLock $runLock
    if ($databaseInsightsInitializationRestoreFailed) {
        throw "Diagnostic initialization failed and exact Database Insights restoration also failed; progression is blocked."
    }
    throw $initializationError
}

$harness = $null
$monitor = $null
$sleepHeld = $false
$restoration = [ordered]@{restored=$false;attempted=$false}
$databaseInsightsRestoration = [ordered]@{restored=$false;attempted=$false}
$terminal = [ordered]@{
    type="waf800_batch_diagnostic_terminal";schemaVersion=1;runId=$config.RunId;diagnosticOnly=$true;
    certificationEligible=$false;supervisorSealed=$false;predecessor=$null;status="failed";
    evidenceCollectorVersion=$script:EvidenceCollectorVersion;
    timestamp=$null;failures=@();config=[ordered]@{pathSha256=(Get-StringSha256 $config.Path);sha256=$config.Sha256;
        rawPathPersisted=$false};
    deploymentIdentity=[ordered]@{applicationGitSha=$config.ApplicationGitSha;deployedImageDigest=$config.ImageDigest;
        apiTaskDefinitionArn=$config.ApiTaskDefinitionArn;workerTaskDefinitionArn=$config.WorkerTaskDefinitionArn};
    controller=[ordered]@{gitSha=$config.ControllerGitSha;hashes=$controllerHashes};harnessArtifacts=$config.HarnessArtifacts;
    workload=[ordered]@{stage="800";devices=810;durationSeconds=1800;screenshotBytes=40960;canaryDevices=10;
        workloadSchemaVersion=$script:WorkloadSchemaVersion;endpointShapeSha256=$script:EndpointShapeSha256};
    historyFallbackQueryIdentity=[ordered]@{receiptSha256=$config.HistoryFallbackSqlIdentity.Receipt.Sha256;
        version=$config.HistoryFallbackSqlIdentity.Version;
        queryIdentifierSha256=$config.HistoryFallbackSqlIdentity.QueryIdentifierSha256;
        compiledSqlSha256=$config.HistoryFallbackSqlIdentity.CompiledSqlSha256;
        parameterTypeSignatureSha256=$config.HistoryFallbackSqlIdentity.ParameterTypeSignatureSha256;
        engineVersion=$config.HistoryFallbackSqlIdentity.EngineVersion;
        schemaIdentitySha256=$config.HistoryFallbackSqlIdentity.SchemaIdentitySha256;
        trackIoTiming=$config.HistoryFallbackSqlIdentity.TrackIoTiming;
        apiRuntimeTaskDefinitionSha256=(Get-StringSha256 $config.ApiTaskDefinitionArn);
        piEvidenceVersion=$config.HistoryFallbackSqlIdentity.PiEvidenceVersion};
    databaseInsightsLease=[ordered]@{version=$config.DatabaseInsightsLease.Version;
        receiptSha256=$config.DatabaseInsightsLease.ReceiptSha256;validation=$databaseInsightsLeaseValidation;restoration=$null};
    initialAwsPosture=$awsPosture;pinnedAwsPosture=$null;preTrafficAwsPosture=$null;postTrafficAwsPosture=$null;terminalAwsPosture=$null;
    observedTrafficWindow=$null;monitor=$null;postgresStatementTimeouts=$null;performanceInsights=$null;scalingRestoration=$null;
    evidenceIntegrity=$null;controllerFailure=$null
}
$exitCode = 2
$acceptanceAdjudicated = $false
$terminalCommitAttempted = $false
$terminalCommitSucceeded = $false
$controllerExceptionOccurred = $false
$orchestrationStage = "capacity_pin"
try {
    $orchestrationStage = "capacity_pin"
    Set-SleepPrevention $true
    $sleepHeld = $true
    $capture.mutationStarted = $true
    $capture.mutationStartedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    Write-AtomicJson $capturePath $capture
    $terminal.pinnedAwsPosture = Set-DiagnosticCapacity $config

    $generatorIpPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-generator-ip.json"
    $readyPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-harness-ready.json"
    $startGatePath = Join-Path $config.EvidenceDirectory "$($config.RunId)-harness-start.json"
    $harnessStdout = Join-Path $config.EvidenceDirectory "$($config.RunId)-harness.stdout.log"
    $harnessStderr = Join-Path $config.EvidenceDirectory "$($config.RunId)-harness.stderr.log"
    $monitorStdout = Join-Path $config.EvidenceDirectory "$($config.RunId)-monitor.stdout.log"
    $monitorStderr = Join-Path $config.EvidenceDirectory "$($config.RunId)-monitor.stderr.log"
    $monitorConfigPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-monitor-config.json"
    foreach ($path in @($generatorIpPath,$readyPath,$startGatePath,$harnessStdout,$harnessStderr,$monitorStdout,$monitorStderr,$monitorConfigPath,$monitorResultPath)) {
        if (Test-Path -LiteralPath $path) { throw "Diagnostic child artifact already exists: $path" }
    }
    $launchedAt = Update-GeneratorPublicIpEvidence -Config $config -Path $generatorIpPath `
        -FailureMessage "Generator public IPv4 changed from its bound config value."
    $lastGeneratorIpCheck = $launchedAt
    Write-AtomicJson $heartbeatPath ([ordered]@{runId=$config.RunId;status="starting";timestamp=$launchedAt.ToString("o")})
    $orchestrationStage = "harness_launch"
    $node = (Get-Command node -ErrorAction Stop).Source
    $harness = Start-Process -FilePath $node -ArgumentList @($script:HarnessScript) -Environment `
        (Get-HarnessEnvironment $config $progressPath $summaryPath $readyPath $startGatePath) -PassThru -NoNewWindow `
        -RedirectStandardOutput $harnessStdout -RedirectStandardError $harnessStderr
    $orchestrationStage = "harness_ready"
    $readyDeadline = [DateTimeOffset]::UtcNow.AddMinutes(3)
    while (-not (Test-Path -LiteralPath $readyPath) -and [DateTimeOffset]::UtcNow -lt $readyDeadline) {
        $harness.Refresh(); if ($harness.HasExited) { throw "Harness exited before reaching its start gate." }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $readyPath)) { throw "Harness did not reach its start gate." }
    $ready = Read-AtomicJson $readyPath
    if ([string]$ready.runId -ne $config.RunId -or [int]$ready.harnessProcessId -ne $harness.Id -or $ready.trafficStarted -ne $false) {
        throw "Harness ready evidence did not bind the exact process/run."
    }
    $monitorConfig = New-MonitorConfiguration $config $progressPath $summaryPath $generatorIpPath $heartbeatPath $harness $launchedAt
    Write-AtomicJson $monitorConfigPath $monitorConfig
    $monitorConfigSha = (Get-FileHash $monitorConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $pwsh = (Get-Process -Id $PID).Path
    $orchestrationStage = "monitor_validation"
    & $pwsh -NoProfile -File $script:MonitorScript -ConfigPath $monitorConfigPath -ExpectedConfigSha256 $monitorConfigSha -Mode Validate | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Bound diagnostic monitor configuration failed validation." }
    $orchestrationStage = "monitor_launch"
    $monitorStartedAt = [DateTimeOffset]::UtcNow
    $monitor = Start-Process -FilePath $pwsh -ArgumentList @("-NoProfile","-File",$script:MonitorScript,"-ConfigPath",$monitorConfigPath,
        "-ExpectedConfigSha256",$monitorConfigSha,"-Mode","Monitor") -PassThru -NoNewWindow `
        -RedirectStandardOutput $monitorStdout -RedirectStandardError $monitorStderr
    $orchestrationStage = "monitor_arming"
    $monitorHeartbeatPath = Join-Path $config.EvidenceDirectory "$($config.RunId)-monitor-heartbeat.json"
    $armedDeadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
    while (-not (Test-Path -LiteralPath $monitorHeartbeatPath) -and [DateTimeOffset]::UtcNow -lt $armedDeadline) {
        $monitor.Refresh(); $harness.Refresh()
        if ($monitor.HasExited -or $harness.HasExited) { throw "Diagnostic child exited before the monitor armed traffic." }
        Write-AtomicJson $heartbeatPath ([ordered]@{runId=$config.RunId;status="arming";timestamp=[DateTimeOffset]::UtcNow.ToString("o");
            harnessProcessId=$harness.Id;monitorProcessId=$monitor.Id})
        Start-Sleep -Seconds 1
    }
    if (-not (Test-Path -LiteralPath $monitorHeartbeatPath)) { throw "Monitor did not arm the diagnostic within five minutes." }
    $monitorHeartbeat = Read-AtomicJson $monitorHeartbeatPath
    Assert-HealthyMonitorHeartbeat -Heartbeat $monitorHeartbeat -ExpectedRunId $config.RunId -ExpectedPhase "Waf" `
        -MonitorStartedAt $monitorStartedAt -Now ([DateTimeOffset]::UtcNow)
    # Re-read the complete immutable posture immediately before releasing
    # traffic. This closes the gap between the initial read-only validation and
    # the end of capacity/readiness convergence.
    $orchestrationStage = "traffic_release"
    $terminal.preTrafficAwsPosture = Get-AwsPosture $config
    $lastGeneratorIpCheck = Update-GeneratorPublicIpEvidence -Config $config -Path $generatorIpPath `
        -FailureMessage "Generator public IPv4 changed during diagnostic startup."
    $monitor.Refresh(); $harness.Refresh()
    if ($monitor.HasExited -or $harness.HasExited) { throw "Diagnostic child exited before traffic release." }
    if (-not (Test-Path -LiteralPath $monitorHeartbeatPath -PathType Leaf)) {
        throw "Diagnostic monitor heartbeat disappeared before traffic release."
    }
    $monitorHeartbeat = Read-AtomicJson $monitorHeartbeatPath
    Assert-HealthyMonitorHeartbeat -Heartbeat $monitorHeartbeat -ExpectedRunId $config.RunId -ExpectedPhase "Waf" `
        -MonitorStartedAt $monitorStartedAt -Now ([DateTimeOffset]::UtcNow)
    # Revalidate the bounded Advanced-mode lease at the last safe point. Its
    # immutable capture must still be fresh and its expiration must extend
    # past 30 minutes of traffic, the +15 minute PI publication deadline, a
    # full restoration timeout, and the fixed safety margin.
    $databaseInsightsLeaseValidation = Invoke-DatabaseInsightsLeaseController -Config $config -LeaseMode Validate
    $terminal.databaseInsightsLease.validation = $databaseInsightsLeaseValidation
    $monitor.Refresh(); $harness.Refresh()
    if ($monitor.HasExited -or $harness.HasExited) { throw "Diagnostic child exited during final lease validation." }
    $monitorHeartbeat = Read-AtomicJson $monitorHeartbeatPath
    Assert-HealthyMonitorHeartbeat -Heartbeat $monitorHeartbeat -ExpectedRunId $config.RunId -ExpectedPhase "Waf" `
        -MonitorStartedAt $monitorStartedAt -Now ([DateTimeOffset]::UtcNow)
    $releasedAt = [DateTimeOffset]::UtcNow
    Write-AtomicJson $startGatePath ([ordered]@{schemaVersion=1;type="load_supervisor_start";runId=$config.RunId;
        harnessProcessId=$harness.Id;monitorProcessId=$monitor.Id;releasedAt=$releasedAt.ToString("o")})
    $orchestrationStage = "traffic_monitoring"
    $deadline = $releasedAt.AddMinutes(50)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $monitor.Refresh(); $harness.Refresh()
        Write-AtomicJson $heartbeatPath ([ordered]@{runId=$config.RunId;status="running";timestamp=[DateTimeOffset]::UtcNow.ToString("o");
            harnessProcessId=$harness.Id;monitorProcessId=$monitor.Id;harnessExited=$harness.HasExited;monitorExited=$monitor.HasExited})
        if ($monitor.HasExited) { break }
        $now = [DateTimeOffset]::UtcNow
        if (($now - $lastGeneratorIpCheck).TotalSeconds -ge $script:GeneratorIpCheckSeconds) {
            $lastGeneratorIpCheck = Update-GeneratorPublicIpEvidence -Config $config -Path $generatorIpPath `
                -FailureMessage "Generator public IPv4 changed during the diagnostic load run."
            $monitor.Refresh(); $harness.Refresh()
            if ($monitor.HasExited) { break }
        }
        Start-Sleep -Seconds 30
    }
    $monitor.Refresh()
    if (-not $monitor.HasExited) { throw "Diagnostic monitor exceeded its bounded 50-minute deadline." }
    $orchestrationStage = "terminal_commit"
    $monitorResult = Attach-TerminalMonitorEvidence $terminal $config $monitorResultPath $monitor
    $terminalCommitAttempted = $true
    $terminalCommitSucceeded = Wait-HarnessTerminalEvidenceCommit $terminal $config $progressPath $summaryPath $harness
    if (-not $terminalCommitSucceeded) {
        Add-TerminalFailure $terminal "observed_traffic_window_unavailable"
        Add-TerminalFailure $terminal "harness_terminal_evidence_unavailable"
        Stop-ProcessBounded $harness
    } else {
        $harness.Refresh()
        if (-not $harness.HasExited -and -not $harness.WaitForExit(15000)) { Stop-ProcessBounded $harness }
    }
    $orchestrationStage = "immediate_evidence"
    Collect-TerminalPostTrafficEvidence $terminal $config $progressPath $summaryPath `
        ([string]$config.HistoryFallbackSqlIdentity.DatabaseResourceId) -Phase Immediate
    $orchestrationStage = "scaling_restoration"
    if ($capture.mutationStarted -eq $true -and (Get-Value $restoration "attempted" $false) -ne $true) {
        $restoration.attempted = $true
        try { $restoration = Restore-ScalingCapture $config $capture }
        catch {
            $restoration = [ordered]@{restored=$false;attempted=$true;timestamp=[DateTimeOffset]::UtcNow.ToString("o");
                failureCode="scaling_restoration_failed";messageSha256=(Get-StringSha256 $_.Exception.Message);rawErrorPersisted=$false}
            Add-TerminalFailure $terminal "scaling_restoration_failed"
            $exitCode = 4
        }
        Write-AtomicJson $restorationPath $restoration
        $terminal.scalingRestoration = $restoration
    }
    $orchestrationStage = "delayed_evidence"
    Collect-TerminalPostTrafficEvidence $terminal $config $progressPath $summaryPath `
        ([string]$config.HistoryFallbackSqlIdentity.DatabaseResourceId) -Phase Delayed
    # Keep Advanced mode only through publication-delayed PI sealing. Restore
    # the immutable lease's exact Standard/7 posture before adjudication.
    $orchestrationStage = "database_insights_restoration"
    $databaseInsightsRestoration = Restore-TerminalDatabaseInsightsLease $terminal $config $databaseInsightsRestoration
    if ($databaseInsightsRestoration.restored -ne $true) { $exitCode = 4 }
    $orchestrationStage = "acceptance_adjudication"
    $harness.Refresh()
    if (-not $harness.HasExited -or $harness.ExitCode -ne 0) {
        Add-TerminalFailure $terminal "diagnostic_harness_rejected"
    }
    $monitorAcceptance = Get-Value $monitorResult "acceptance"
    if ($monitor.ExitCode -ne 0 -or $null -eq $monitorResult -or
        [string](Get-Value $monitorResult "status" "") -ne "completed" -or
        (Get-Value $monitorResult "diagnosticOnly" $false) -ne $true -or
        (Get-Value $monitorResult "certificationEligible" $true) -ne $false -or
        (Get-Value $monitorAcceptance "passed" $false) -ne $true) {
        Add-TerminalFailure $terminal "diagnostic_monitor_rejected"
    }
    if ($null -ne $monitorResult) {
        $rdsCoverage = Get-Value $monitorAcceptance "diagnosticRdsCpuCoverage"
        if ($null -eq $rdsCoverage -or (Get-Value $rdsCoverage "required" $false) -ne $true -or
            (Get-Value $rdsCoverage "fullCoverage" $false) -ne $true -or
            (Get-Value $rdsCoverage "allPointsBelowMaximum" $false) -ne $true -or
            [int](Get-Value $rdsCoverage "requiredPointCount" 0) -ne 30 -or
            [int](Get-Value $rdsCoverage "observedPointCount" 0) -lt 30) {
            Add-TerminalFailure $terminal "diagnostic_rds_cpu_30_of_30_gate_failed"
        }
    }
    $acceptanceAdjudicated = $true
    $exitCode = Resolve-DiagnosticTerminalExitCode $terminal $restoration $databaseInsightsRestoration $acceptanceAdjudicated $exitCode
    $terminal.status = if ($exitCode -eq 0) { "completed" } else { "failed" }
}
catch {
    $controllerExceptionOccurred = $true
    $terminal.status = "failed"
    $terminal.controllerFailure = Get-ControllerFailureClassification $orchestrationStage $_
    Add-TerminalFailure $terminal $terminal.controllerFailure.failureCode
    $exitCode = 2
}
finally {
    try {
        $harnessLive = Test-ProcessLive $harness
        $monitorLive = Test-ProcessLive $monitor
        $terminalEvidencePresent = Test-HarnessTerminalEvidencePresent $config $progressPath $summaryPath
        $naturallyTerminalChild = (($null -ne $harness -and -not $harnessLive) -or
            ($null -ne $monitor -and -not $monitorLive))
        $cleanupDisposition = Get-ControllerCleanupDisposition $controllerExceptionOccurred $harnessLive $monitorLive `
            $terminalEvidencePresent $naturallyTerminalChild

        if ($cleanupDisposition.mode -ceq "immediate_harness_first") {
            # Safety ordering is intentional: stop the traffic source before
            # its observer, then restore capacity below. Commit grace is not
            # valid while both children were live without terminal evidence.
            Stop-ControllerChildrenImmediately $terminal $harness $monitor
            if (-not $terminalCommitAttempted) {
                $terminalCommitAttempted = $true
                $terminalCommitSucceeded = $false
                Add-TerminalFailure $terminal "observed_traffic_window_unavailable"
                Add-TerminalFailure $terminal "harness_terminal_evidence_unavailable"
            }
        }
        else {
            try { Stop-ProcessBounded $monitor }
            catch { Add-TerminalFailure $terminal "monitor_process_stop_failed" }
            if (-not $terminalCommitAttempted) {
                $terminalCommitAttempted = $true
                $terminalCommitSucceeded = Wait-HarnessTerminalEvidenceCommit $terminal $config $progressPath $summaryPath $harness
                if (-not $terminalCommitSucceeded) {
                    Add-TerminalFailure $terminal "observed_traffic_window_unavailable"
                    Add-TerminalFailure $terminal "harness_terminal_evidence_unavailable"
                }
            }
            try {
                if ($terminalCommitSucceeded -and $null -ne $harness) {
                    $harness.Refresh()
                    if (-not $harness.HasExited -and -not $harness.WaitForExit(15000)) { Stop-ProcessBounded $harness }
                } else { Stop-ProcessBounded $harness }
            }
            catch { Add-TerminalFailure $terminal "harness_process_stop_failed" }
        }
        try { [void](Attach-TerminalMonitorEvidence $terminal $config $monitorResultPath $monitor) }
        catch { Add-TerminalFailure $terminal "monitor_terminal_evidence_attachment_failed" }
        $orchestrationStage = "immediate_evidence"
        try {
            Collect-TerminalPostTrafficEvidence $terminal $config $progressPath $summaryPath `
                ([string]$config.HistoryFallbackSqlIdentity.DatabaseResourceId) -Phase Immediate
        }
        catch { Add-TerminalFailure $terminal "post_traffic_evidence_collection_failed" }
        $orchestrationStage = "scaling_restoration"
        if ($capture.mutationStarted -eq $true -and (Get-Value $restoration "attempted" $false) -ne $true) {
            $restoration.attempted = $true
            try {
                $restoration = Restore-ScalingCapture $config $capture
            }
            catch {
                $restoration = [ordered]@{restored=$false;attempted=$true;timestamp=[DateTimeOffset]::UtcNow.ToString("o");
                    failureCode="scaling_restoration_failed";messageSha256=(Get-StringSha256 $_.Exception.Message);rawErrorPersisted=$false}
                $terminal.status = "failed"
                Add-TerminalFailure $terminal "scaling_restoration_failed"
                $exitCode = 4
            }
            Write-AtomicJson $restorationPath $restoration
        }
        $terminal.scalingRestoration = $restoration
        $orchestrationStage = "delayed_evidence"
        try {
            Collect-TerminalPostTrafficEvidence $terminal $config $progressPath $summaryPath `
                ([string]$config.HistoryFallbackSqlIdentity.DatabaseResourceId) -Phase Delayed
        }
        catch { Add-TerminalFailure $terminal "post_traffic_evidence_collection_failed" }
        $orchestrationStage = "database_insights_restoration"
        $databaseInsightsRestoration = Restore-TerminalDatabaseInsightsLease $terminal $config $databaseInsightsRestoration
        if ($databaseInsightsRestoration.restored -ne $true) { $exitCode = 4 }
        $exitCode = Resolve-DiagnosticTerminalExitCode $terminal $restoration $databaseInsightsRestoration $acceptanceAdjudicated $exitCode
        $terminal.status = if ($exitCode -eq 0) { "completed" } else { "failed" }
        if ($capture.mutationStarted -eq $true) {
            $orchestrationStage = "terminal_posture"
            try {
                # Revalidate again after restoration, immediately before the
                # terminal envelope is committed. A success result therefore
                # binds the live WAF association/rules and Redis membership at
                # the actual terminal boundary, not merely after traffic.
                $terminal.terminalAwsPosture = Get-AwsPosture $config -ExpectedDatabaseInsightsMode "standard"
            }
            catch {
                Add-TerminalFailure $terminal "terminal_aws_posture_revalidation_failed"
                if ($terminal.status -eq "completed") {
                    $terminal.status = "failed"
                    $exitCode = 2
                }
            }
        }
        try { Set-TerminalEvidenceIntegrity $terminal $restorationPath }
        catch {
            $terminal.evidenceIntegrity = [ordered]@{algorithm="sha256";collected=$false;
                failureCode="terminal_evidence_integrity_failed";rawErrorPersisted=$false}
            Add-TerminalFailure $terminal "terminal_evidence_integrity_failed"
            $terminal.status = "failed"
            if ($exitCode -eq 0) { $exitCode = 2 }
        }
        $exitCode = Resolve-DiagnosticTerminalExitCode $terminal $restoration $databaseInsightsRestoration $acceptanceAdjudicated $exitCode
        $terminal.status = if ($exitCode -eq 0) { "completed" } else { "failed" }
        $terminal.timestamp = [DateTimeOffset]::UtcNow.ToString("o")
        Write-AtomicJson $resultPath $terminal
        Write-AtomicJson $heartbeatPath ([ordered]@{runId=$config.RunId;status=$terminal.status;timestamp=$terminal.timestamp;
            diagnosticOnly=$true;certificationEligible=$false;scalingRestored=$restoration.restored;
            databaseInsightsRestored=$databaseInsightsRestoration.restored})
    }
    finally {
        if ($sleepHeld) { try { Set-SleepPrevention $false } catch { } }
        Exit-DiagnosticRunLock $runLock
    }
}
exit $exitCode
