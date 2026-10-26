#requires -Version 7.5
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../private-permissions.ps1')

# These are the reviewed read-only readers, not a general command runner. The
# superseded three-day worker query and every Plan/Apply wrapper are excluded.
$script:UsageReaderHashes = @(
    '7b5af335151ec381d8f48ccbf680ac8aa2dbced89f9409dc8eb441504d18dc31',
    'f4cb8586a655613f9fe2857a83ebda10e98b4aab4c891a0c2824e5593cf05ee3',
    '9423e9a625f09105bb8eb59d0b3bb48d249538b0081e269e2fb31e151d786a02',
    '9514202a1f3c69b967edae05da2c7706b56e74d892631eb79996286c7935036b',
    '8ed5ba85afa6ddd8c0020554fb9d01c2589bf793de5c3008060b4bdd6faeaba4'
)
$script:UsageCounterNames = @(
    'poolAcquisitionFailure', 'apiPoolReadinessStalled',
    'studentChatFanOutMissed', 'studentChatFanOutDelivered',
    'fabSyncLocalDeliveryMissed', 'fabSyncPendingMarked',
    'fabSyncPendingMarkFallback', 'fabSyncPendingServed',
    'fabSyncPendingTakeUnavailable'
)

function Get-UsageMonitoringFileBinding {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path, [switch]$Private)
    Assert-NoReparsePointInExistingPath -Path $Path
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) { throw 'MONITORING_EXPECTED_FILE' }
    # Source files, executables and live automation TOML are ordinary files.
    # Never change their ACLs in order to read or hash them.
    if ($Private) { Assert-PrivatePathPermissions -Path $item.FullName }
    return @{ path = $item.FullName; sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = $item.Length }
}

function Assert-UsageMonitoringFileBinding {
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Binding, [switch]$Private)
    if (-not $Binding.Contains('path') -or -not $Binding.Contains('sha256') -or
        $Binding.path -isnot [string] -or $Binding.sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'MONITORING_INVALID_FILE_BINDING'
    }
    $actual = Get-UsageMonitoringFileBinding -Path $Binding.path -Private:$Private
    # Legacy native-07 raw references have a hash but no byte-length field.
    # Measure their actual length; do not invent an original length assertion.
    if ($actual.sha256 -cne $Binding.sha256 -or
        ($Binding.Contains('bytes') -and $actual.bytes -ne $Binding.bytes)) {
        throw 'MONITORING_FILE_BINDING_CHANGED'
    }
    return $actual
}

function Read-UsageMonitoringJson {
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Binding, [switch]$Private)
    $actual = Assert-UsageMonitoringFileBinding -Binding $Binding -Private:$Private
    $value = [IO.File]::ReadAllText($actual.path) | ConvertFrom-Json -AsHashtable -DateKind String
    if ($value -isnot [System.Collections.IDictionary]) { throw 'MONITORING_EXPECTED_JSON_OBJECT' }
    return $value
}

function Assert-UsageMonitoringReview {
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Review)
    if ($Review.Contains('passed')) {
        if ($Review.passed -isnot [bool] -or -not $Review.passed) { throw 'MONITORING_REVIEW_NOT_PASSED' }
    } elseif (-not $Review.Contains('result') -or $Review.result -cne 'PASS') {
        throw 'MONITORING_REVIEW_NOT_PASSED'
    }
    if ($Review.Contains('result') -and $Review.result -cne 'PASS') { throw 'MONITORING_REVIEW_CONTRADICTORY_RESULT' }
    $hasFindings = $false
    foreach ($name in @('findings', 'unresolvedFindings')) {
        if (-not $Review.Contains($name)) { continue }
        $hasFindings = $true
        $value = $Review[$name]
        # A numeric zero is a count, not a one-element findings array.
        if ($value -is [int] -or $value -is [long]) {
            if ($value -ne 0) { throw 'MONITORING_REVIEW_HAS_FINDINGS' }
        } elseif ($value -is [System.Collections.IList]) {
            if ($value.Count -ne 0) { throw 'MONITORING_REVIEW_HAS_FINDINGS' }
        } else { throw 'MONITORING_INVALID_FINDINGS_TYPE' }
    }
    if (-not $hasFindings) { throw 'MONITORING_MISSING_FINDINGS' }
    if ($Review.Contains('executeNow') -and ($Review.executeNow -isnot [bool] -or $Review.executeNow)) {
        throw 'MONITORING_REVIEW_IS_NOT_READ_ONLY'
    }
}

function Write-UsageMonitoringPrivateFile {
    param([string]$Path, [byte[]]$Bytes)
    Assert-NoReparsePointInExistingPath -Path $Path
    Assert-PrivatePathPermissions -Path ([IO.Path]::GetDirectoryName($Path)) -Directory
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        Set-PrivatePathPermissions -Path $Path
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}

function Write-UsageMonitoringPrivateJson {
    param([string]$Path, [System.Collections.IDictionary]$Value)
    Write-UsageMonitoringPrivateFile -Path $Path -Bytes ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Value -Depth 60)))
    return Get-UsageMonitoringFileBinding -Path $Path -Private
}

function Wait-UsageMonitoringPipeCopies {
    param($OutTask, $ErrTask, [Threading.CancellationTokenSource]$Cancellation,
        [int]$DrainMilliseconds = 5000, [int]$CancelDrainMilliseconds = 1000)
    $completed = @{}
    foreach ($pipe in @(@{ task = $OutTask; name = 'stdout' }, @{ task = $ErrTask; name = 'stderr' })) {
        $ok = $false
        if ($null -ne $pipe.task) {
            try { $ok = $pipe.task.Wait($DrainMilliseconds) -and $pipe.task.IsCompletedSuccessfully } catch { $ok = $false }
        }
        $completed[$pipe.name] = $ok
    }
    if (-not $completed.stdout -or -not $completed.stderr) {
        $Cancellation.Cancel()
        foreach ($task in @($OutTask, $ErrTask)) { if ($null -ne $task) { try { [void]$task.Wait($CancelDrainMilliseconds) } catch {} } }
    }
    return @{
        stdoutComplete = $completed.stdout; stderrComplete = $completed.stderr
        copiesSettled = ($null -eq $OutTask -or $OutTask.IsCompleted) -and ($null -eq $ErrTask -or $ErrTask.IsCompleted)
    }
}

function Get-UsageMonitoringOutputReference {
    param([string]$Path, [bool]$CopiesSettled)
    if (-not $CopiesSettled) {
        # A still-running copy might change the file. Do not bind a transient
        # hash/length or let this quarantined output masquerade as finalized.
        return @{ path = $Path; finalized = $false }
    }
    return Get-UsageMonitoringFileBinding -Path $Path -Private
}

function Invoke-UsageMonitoringCaptureInternal {
    param([string]$EvidenceDirectory, [string]$Label, $Reader, $PowerShell, [int]$TimeoutSeconds)
    Assert-NoReparsePointInExistingPath -Path $EvidenceDirectory
    Assert-PrivatePathPermissions -Path $EvidenceDirectory -Directory
    $prefix = Join-Path $EvidenceDirectory $Label
    foreach ($suffix in @('.intent.json', '.native.json', '.stdout.json', '.stderr.txt')) {
        if (Test-Path -LiteralPath ($prefix + $suffix)) { throw 'MONITORING_CAPTURE_LABEL_ALREADY_EXISTS' }
    }
    $arguments = @('-NoProfile', '-NonInteractive', '-File', $Reader.path)
    $started = [DateTimeOffset]::UtcNow
    # Claim the label before starting a child. CreateNew forbids retries/replay.
    [void](Write-UsageMonitoringPrivateJson ($prefix + '.intent.json') @{
        schemaVersion = 1; source = $Reader; executable = $PowerShell
        argv = $arguments; startedAtUtc = $started.ToString('o'); timeoutSeconds = $TimeoutSeconds; noAutomaticRetry = $true
    })
    foreach ($suffix in @('.stdout.json', '.stderr.txt')) { Write-UsageMonitoringPrivateFile ($prefix + $suffix) ([byte[]]@()) }
    $outFile = [IO.FileStream]::new($prefix + '.stdout.json', [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $errFile = [IO.FileStream]::new($prefix + '.stderr.txt', [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $info = [Diagnostics.ProcessStartInfo]::new($PowerShell.path)
    $info.WorkingDirectory = $EvidenceDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $arguments) { [void]$info.ArgumentList.Add($argument) }
    foreach ($key in @($info.Environment.Keys)) {
        if ($key -match '^(AWS_|GIT_|NODE_|PYTHON)') { [void]$info.Environment.Remove($key) }
    }
    $process = $null; $outTask = $null; $errTask = $null
    $cancel = [Threading.CancellationTokenSource]::new()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $reaped = $false; $timedOut = $false; $outComplete = $false; $errComplete = $false
    $exitCode = $null; $failure = $null; $creation = $null; $childId = $null; $copiesSettled = $false
    try {
        $process = [Diagnostics.Process]::Start($info)
        $childId = $process.Id
        $creation = $process.StartTime.ToUniversalTime().ToString('o')
        $outTask = $process.StandardOutput.BaseStream.CopyToAsync($outFile, $cancel.Token)
        $errTask = $process.StandardError.BaseStream.CopyToAsync($errFile, $cancel.Token)
        while (-not $process.WaitForExit(100)) {
            if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) { $timedOut = $true; break }
        }
    } catch { $failure = 'process_start_or_capture_failed' }
    finally {
        if ($null -ne $process) {
            if (-not $process.HasExited) {
                try { $process.Kill($true) } catch { $failure = 'owned_process_termination_uncertain' }
            }
            $reaped = $process.WaitForExit(5000)
            if ($reaped) { $exitCode = $process.ExitCode }
        }
        # Drain both pipes after the ORIGINAL child is reaped. A complete stdout
        # alone cannot turn a timeout/nonzero/uncertain capture into success.
        $pipes = Wait-UsageMonitoringPipeCopies $outTask $errTask $cancel
        $outComplete = $pipes.stdoutComplete; $errComplete = $pipes.stderrComplete; $copiesSettled = $pipes.copiesSettled
        if ($copiesSettled) { $outFile.Flush($true); $errFile.Flush($true) }
        else { $failure = 'pipe_copies_unsettled' }
        $outFile.Dispose(); $errFile.Dispose(); $cancel.Dispose()
        if ($null -ne $process) { $process.Dispose() }
    }
    return Write-UsageMonitoringPrivateJson ($prefix + '.native.json') @{
        schemaVersion = 2; kind = 'usage_reports_original_reader_capture'; source = $Reader; executable = $PowerShell
        argv = $arguments; startedAtUtc = $started.ToString('o'); finishedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        pid = $childId; creationUtc = $creation; exitCode = $exitCode; timedOut = $timedOut; reaped = $reaped
        stdoutComplete = $outComplete; stderrComplete = $errComplete; pipeCopiesSettled = $copiesSettled; captureFailure = $failure
        stdout = (Get-UsageMonitoringOutputReference ($prefix + '.stdout.json') $copiesSettled)
        stderr = (Get-UsageMonitoringOutputReference ($prefix + '.stderr.txt') $copiesSettled)
        maximumProcessSeconds = $TimeoutSeconds; ownedReapSeconds = 5; eachDrainSeconds = 5; noAutomaticRetry = $true
    }
}

function Invoke-UsageMonitoringReader {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$ReaderBinding,
        [Parameter(Mandatory)][System.Collections.IDictionary]$PowerShellBinding,
        [Parameter(Mandatory)][string]$EvidenceDirectory,
        [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]{1,100}$')][string]$Label,
        [ValidateRange(1, 60)][int]$TimeoutSeconds = 60
    )
    if (-not [IO.Path]::IsPathRooted($EvidenceDirectory)) { throw 'MONITORING_ABSOLUTE_EVIDENCE_DIRECTORY_REQUIRED' }
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    if ([IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar) -ceq $repository -or
        (Test-IsPathWithin -Candidate $EvidenceDirectory -Parent $repository)) { throw 'MONITORING_EVIDENCE_MUST_STAY_OUTSIDE_REPOSITORY' }
    $reader = Assert-UsageMonitoringFileBinding -Binding $ReaderBinding -Private
    if ($reader.sha256 -cnotin $script:UsageReaderHashes) { throw 'MONITORING_READER_NOT_APPROVED' }
    $powerShell = Assert-UsageMonitoringFileBinding -Binding $PowerShellBinding
    if ($powerShell.sha256 -cne '362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139') {
        throw 'MONITORING_EXECUTABLE_NOT_APPROVED'
    }
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($reader.path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw 'MONITORING_READER_PARSE_ERROR' }
    return Invoke-UsageMonitoringCaptureInternal -EvidenceDirectory $EvidenceDirectory -Label $Label -Reader $reader -PowerShell $powerShell -TimeoutSeconds $TimeoutSeconds
}

function Read-UsageMonitoringCapture {
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Collections.IDictionary]$NativeBinding)
    $native = Read-UsageMonitoringJson -Binding $NativeBinding -Private
    foreach ($flag in @('reaped', 'stdoutComplete', 'stderrComplete')) {
        if (-not $native.Contains($flag) -or $native[$flag] -isnot [bool] -or -not $native[$flag]) { throw 'MONITORING_CAPTURE_INCOMPLETE' }
    }
    if (-not $native.Contains('timedOut') -or $native.timedOut -isnot [bool] -or $native.timedOut -or
        -not $native.Contains('exitCode') -or ($native.exitCode -isnot [int] -and $native.exitCode -isnot [long]) -or $native.exitCode -ne 0 -or
        ($native.Contains('captureFailure') -and $null -ne $native.captureFailure)) { throw 'MONITORING_CAPTURE_FAILED' }
    # Do not open failed/partial stdout, even if it happens to be valid JSON.
    $stderr = Assert-UsageMonitoringFileBinding -Binding $native.stderr -Private
    if ($stderr.bytes -ne 0) { throw 'MONITORING_CAPTURE_STDERR_NOT_EMPTY' }
    $data = Read-UsageMonitoringJson -Binding $native.stdout -Private
    foreach ($key in @('nextToken', 'NextToken')) {
        if ($data.Contains($key) -and $null -ne $data[$key] -and $data[$key] -cne '') { throw 'MONITORING_PAGINATION_INCOMPLETE' }
    }
    return @{ native = $native; data = $data }
}

function ConvertTo-UsageMonitoringCanonicalValue {
    param([AllowNull()]$Value)
    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        $keys = [string[]]@($Value.Keys); [Array]::Sort($keys, [StringComparer]::Ordinal)
        foreach ($key in $keys) { $result[$key] = ConvertTo-UsageMonitoringCanonicalValue $Value[$key] }
        return $result
    }
    if ($Value -is [System.Collections.IList]) { return ,@($Value | ForEach-Object { ConvertTo-UsageMonitoringCanonicalValue $_ }) }
    return $Value
}

function Get-UsageMonitoringProcessSummary {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Events)
    $seen = @{}; $streams = @{}; $totals = @{}; $partials = [Collections.Generic.List[object]]::new()
    foreach ($counter in $script:UsageCounterNames) { $totals[$counter] = 0L }
    foreach ($event in $Events) {
        $canonical = ConvertTo-Json -InputObject (ConvertTo-UsageMonitoringCanonicalValue $event) -Compress -Depth 60
        if ($seen.ContainsKey($event.eventId)) {
            if ($seen[$event.eventId] -cne $canonical) { throw 'MONITORING_EVENT_ID_WHOLE_RECORD_CHANGED' }
            continue
        }
        $seen[$event.eventId] = $canonical
        $body = $event.message | ConvertFrom-Json -AsHashtable -DateKind String
        $start = [DateTimeOffset]$body.intervalStartedAtUtc; $end = [DateTimeOffset]$body.intervalEndedAtUtc
        $milliseconds = ($end - $start).TotalMilliseconds
        if ($milliseconds -le 0 -or [Math]::Abs($milliseconds - (1000 * $body.intervalSeconds)) -gt 0.01) { throw 'MONITORING_INTERVAL_DURATION_MISMATCH' }
        foreach ($counter in $script:UsageCounterNames) {
            if (-not $body.counters.Contains($counter) -or $body.counters[$counter] -isnot [long] -and $body.counters[$counter] -isnot [int] -or $body.counters[$counter] -lt 0) {
                throw ('MONITORING_REQUIRED_COUNTER_MISSING_OR_INVALID: ' + $counter)
            }
            $totals[$counter] += $body.counters[$counter]
        }
        if (-not $streams.ContainsKey($event.logStreamName)) { $streams[$event.logStreamName] = [Collections.Generic.List[object]]::new() }
        $interval = @{ eventId = $event.eventId; startUtc = $body.intervalStartedAtUtc; endUtc = $body.intervalEndedAtUtc; seconds = $body.intervalSeconds }
        $streams[$event.logStreamName].Add($interval)
        if ($milliseconds -ne 60000 -or ($start.UtcTicks % [TimeSpan]::TicksPerMinute) -ne 0) { $partials.Add($interval) }
    }
    return @{ uniqueEvents = $seen.Count; streams = $streams; trueFieldTotals = $totals; explicitTrueFieldCountEach = $seen.Count; partialIntervals = @($partials); noProcessEosOrStudentLossInference = $true }
}

function Merge-UsageMonitoringMetrics {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Snapshots)
    $points = @{}; $revisions = [Collections.Generic.List[object]]::new()
    foreach ($snapshot in @($Snapshots | Sort-Object { [DateTimeOffset]$_.startedAtUtc })) {
        $within = @{}
        foreach ($series in $snapshot.data.MetricDataResults) {
            if ($series.StatusCode -cne 'Complete' -or $series.Values.Count -ne $series.Timestamps.Count) { throw 'MONITORING_METRIC_INCOMPLETE' }
            for ($i = 0; $i -lt $series.Values.Count; $i++) {
                $epoch = ([DateTimeOffset]$series.Timestamps[$i]).ToUnixTimeSeconds()
                $key = $series.Id + '|' + $epoch
                if ($within.ContainsKey($key)) { throw 'MONITORING_DUPLICATE_METRIC_EPOCH' }
                $within[$key] = $true
                $value = $series.Values[$i]
                if (($value -isnot [int] -and $value -isnot [long] -and $value -isnot [double] -and $value -isnot [decimal]) -or
                    [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value)) { throw 'MONITORING_INVALID_METRIC_VALUE' }
                $fresh = @{ id = $series.Id; epoch = $epoch; value = $series.Values[$i] }
                if ($points.ContainsKey($key) -and $points[$key].value -ne $fresh.value) { $revisions.Add(@{ id = $series.Id; epoch = $epoch; prior = $points[$key].value; fresh = $fresh.value }) }
                $points[$key] = $fresh
            }
        }
    }
    $five = @($points.Values | Where-Object id -CEQ 'target_5xx')
    return @{ points = @($points.Values); revisions = @($revisions); target5xxValuesCount = $five.Count; target5xxSum = if ($five.Count) { ($five | ForEach-Object value | Measure-Object -Sum).Sum } else { $null } }
}

Export-ModuleMember -Function Get-UsageMonitoringFileBinding, Assert-UsageMonitoringFileBinding, Read-UsageMonitoringJson, Assert-UsageMonitoringReview, Invoke-UsageMonitoringReader, Read-UsageMonitoringCapture, Get-UsageMonitoringProcessSummary, Merge-UsageMonitoringMetrics
