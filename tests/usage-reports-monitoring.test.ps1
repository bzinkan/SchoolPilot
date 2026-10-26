#requires -Version 7.5
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Assertions = 0
function Assert-Condition([bool]$Condition, [string]$Message) {
    $script:Assertions++
    if (-not $Condition) { throw $Message }
}
function Assert-Rejected([scriptblock]$Action, [string]$Pattern) {
    $caught = $null
    try { & $Action | Out-Null } catch { $caught = $_ }
    Assert-Condition ($null -ne $caught -and $caught.ToString() -match $Pattern) "Expected rejection: $Pattern; actual: $caught"
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $root 'scripts/private-permissions.ps1')
$module = Import-Module (Join-Path $root 'scripts/operations/usage-reports-monitoring.psm1') -Force -PassThru
$temp = Join-Path ([IO.Path]::GetTempPath()) ('usage-monitoring-tests-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temp)
Set-PrivatePathPermissions -Path $temp -Directory
function Write-Fixture([string]$Name, [string]$Text) {
    $path = Join-Path $temp $Name
    [IO.File]::WriteAllText($path, $Text, [Text.UTF8Encoding]::new($false))
    Set-PrivatePathPermissions -Path $path
    return Get-UsageMonitoringFileBinding -Path $path -Private
}
function Write-JsonFixture([string]$Name, $Value) { return Write-Fixture $Name (ConvertTo-Json -InputObject $Value -Depth 60) }
function New-Event([string]$Id, [string]$Stream, [string]$Start, [string]$End, [double]$Seconds) {
    $counters = @{}
    foreach ($key in @('poolAcquisitionFailure','apiPoolReadinessStalled','studentChatFanOutMissed','studentChatFanOutDelivered','fabSyncLocalDeliveryMissed','fabSyncPendingMarked','fabSyncPendingMarkFallback','fabSyncPendingServed','fabSyncPendingTakeUnavailable')) { $counters[$key] = 0 }
    return @{ eventId = $Id; logStreamName = $Stream; timestamp = ([DateTimeOffset]$End).ToUnixTimeMilliseconds(); ingestionTime = 1; message = (ConvertTo-Json -Compress -Depth 10 -InputObject @{ intervalStartedAtUtc = $Start; intervalEndedAtUtc = $End; intervalSeconds = $Seconds; counters = $counters }) }
}
try {
    foreach ($review in @(@{ passed = $true; unresolvedFindings = 0 }, @{ passed = $true; unresolvedFindings = @(); executeNow = $false }, @{ result = 'PASS'; findings = @() })) {
        Assert-UsageMonitoringReview $review
        $script:Assertions++
    }
    foreach ($value in @('0', $false, $null, @{ count = 0 }, 1, @('finding'))) {
        Assert-Rejected { Assert-UsageMonitoringReview @{ passed = $true; unresolvedFindings = $value } } 'MONITORING_'
    }
    Assert-Rejected { Assert-UsageMonitoringReview @{ passed = $false; result = 'PASS'; findings = @() } } 'NOT_PASSED'
    Assert-Rejected { Assert-UsageMonitoringReview @{ passed = $true; result = 'FAIL'; findings = @() } } 'CONTRADICTORY'
    Assert-Rejected { Assert-UsageMonitoringReview @{ passed = $true; findings = @(); executeNow = $true } } 'READ_ONLY'

    # Ordinary source/config files must not acquire a private-evidence ACL rule.
    $ordinary = Join-Path $temp 'ordinary.toml'
    [IO.File]::WriteAllText($ordinary, 'name = "test"')
    if ($IsWindows) {
        $security = Get-Acl -LiteralPath $ordinary
        $security.SetAccessRuleProtection($false, $true)
        Set-Acl -LiteralPath $ordinary -AclObject $security
    } else { [IO.File]::SetUnixFileMode($ordinary, [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::GroupRead) }
    $ordinaryBinding = Get-UsageMonitoringFileBinding $ordinary
    Assert-Condition ($ordinaryBinding.bytes -gt 0) 'Ordinary file hashing should work without private ACLs.'
    Assert-Rejected { Get-UsageMonitoringFileBinding $ordinary -Private } 'accessible only|owner-only'
    $json = Write-Fixture 'date.json' '{"at":"2026-10-26T20:06:46.223Z","nested":{"value":0}}'
    $read = Read-UsageMonitoringJson $json -Private
    Assert-Condition ($read -is [System.Collections.IDictionary] -and $read.at -is [string]) 'Dates must remain strings in hashtables.'
    [IO.File]::AppendAllText($json.path, ' ')
    Assert-Rejected { Read-UsageMonitoringJson $json -Private } 'BINDING_CHANGED'

    $stdout = Write-Fixture 'ok.stdout.json' '{"events":[]}'
    $stderr = Write-Fixture 'empty.stderr.txt' ''
    $native = @{ exitCode = 0; timedOut = $false; reaped = $true; stdoutComplete = $true; stderrComplete = $true; stdout = $stdout; stderr = $stderr }
    $nr = Write-JsonFixture 'ok.native.json' $native
    Assert-Condition ((Read-UsageMonitoringCapture $nr).data.events.Count -eq 0) 'A genuinely complete empty collection is valid.'
    # Missing stdout cannot even be opened when native metadata already failed.
    foreach ($variant in @(@{ timedOut = $true }, @{ reaped = $false }, @{ stdoutComplete = $false }, @{ stderrComplete = $false }, @{ exitCode = $null }, @{ exitCode = 1 }, @{ exitCode = '0' })) {
        $bad = $native.Clone()
        foreach ($key in $variant.Keys) { $bad[$key] = $variant[$key] }
        $bad.stdout = @{ path = (Join-Path $temp 'must-not-be-read'); sha256 = ('0' * 64) }
        $badRef = Write-JsonFixture (([Guid]::NewGuid().ToString('N')) + '.native.json') $bad
        Assert-Rejected { Read-UsageMonitoringCapture $badRef } 'MONITORING_CAPTURE_(INCOMPLETE|FAILED)'
    }
    $page = Write-Fixture 'page.stdout.json' '{"events":[],"nextToken":"another-page"}'
    $pagination = $native.Clone(); $pagination.stdout = $page
    $pageRef = Write-JsonFixture 'page.native.json' $pagination
    Assert-Rejected { Read-UsageMonitoringCapture $pageRef } 'PAGINATION_INCOMPLETE'
    $errorRef = Write-Fixture 'nonempty.stderr.txt' 'reader failed'
    $withError = $native.Clone(); $withError.stderr = $errorRef
    $errorNative = Write-JsonFixture 'stderr.native.json' $withError
    Assert-Rejected { Read-UsageMonitoringCapture $errorNative } 'STDERR_NOT_EMPTY'
    $legacy = $native.Clone(); $legacy.stderr = @{ path = $stderr.path; sha256 = $stderr.sha256 }
    $legacyRef = Write-JsonFixture 'legacy.native.json' $legacy
    Assert-Condition ((Read-UsageMonitoringCapture $legacyRef).data.events.Count -eq 0) 'Legacy raw hash-only bindings remain verifiable.'

    $full = New-Event 'one' 'current' '2026-10-26T20:05:00.000Z' '2026-10-26T20:06:00.000Z' 60
    $partial = New-Event 'two' 'retiring' '2026-10-26T20:06:00.000Z' '2026-10-26T20:06:46.223Z' 46.223
    $summary = Get-UsageMonitoringProcessSummary @($full, $partial, $full)
    Assert-Condition ($summary.uniqueEvents -eq 2 -and $summary.explicitTrueFieldCountEach -eq 2) 'Repeated whole EventIDs count once.'
    Assert-Condition ($summary.partialIntervals.Count -eq 1 -and $summary.partialIntervals[0].endUtc -ceq '2026-10-26T20:06:46.223Z') 'Preserve exact partial milliseconds rather than force four full streams.'
    $unaligned = New-Event 'unaligned' 'current' '2026-10-26T20:05:00.0000001Z' '2026-10-26T20:06:00.0000001Z' 60
    Assert-Condition ((Get-UsageMonitoringProcessSummary @($unaligned)).partialIntervals.Count -eq 1) 'Sub-millisecond start offsets are not aligned minute buckets.'
    $changed = $full.Clone(); $changed.ingestionTime = 2
    Assert-Rejected { Get-UsageMonitoringProcessSummary @($full, $changed) } 'WHOLE_RECORD_CHANGED'
    $alias = $full.Clone(); $alias.eventId = 'alias'
    $body = $alias.message | ConvertFrom-Json -AsHashtable -DateKind String
    [void]$body.counters.Remove('studentChatFanOutMissed'); $body.counters.chatMissed = 0
    $alias.message = ConvertTo-Json -InputObject $body -Compress -Depth 10
    Assert-Rejected { Get-UsageMonitoringProcessSummary @($alias) } 'REQUIRED_COUNTER_MISSING'
    $fab = $full.Clone(); $fab.eventId = 'fab'
    $body = $fab.message | ConvertFrom-Json -AsHashtable -DateKind String
    $body.counters.fabSyncLocalDeliveryMissed = 20; $body.counters.fabSyncPendingMarked = 20
    $fab.message = ConvertTo-Json -InputObject $body -Compress -Depth 10
    Assert-Condition ((Get-UsageMonitoringProcessSummary @($fab)).trueFieldTotals.fabSyncLocalDeliveryMissed -eq 20) 'Nonzero Fab operations are retained, not refused by a blanket zero assumption.'

    $oldData = @{ MetricDataResults = @(@{ Id = 'target_requests'; StatusCode = 'Complete'; Timestamps = @('2026-10-26T20:08:00Z'); Values = @(71) }, @{ Id = 'target_5xx'; StatusCode = 'Complete'; Timestamps = @(); Values = @() }) }
    $freshData = @{ MetricDataResults = @(@{ Id = 'target_requests'; StatusCode = 'Complete'; Timestamps = @('2026-10-26T16:08:00-04:00'); Values = @(164) }, @{ Id = 'target_5xx'; StatusCode = 'Complete'; Timestamps = @(); Values = @() }) }
    $merged = Merge-UsageMonitoringMetrics @(@{ startedAtUtc = '2026-10-26T20:11:00Z'; data = $freshData }, @{ startedAtUtc = '2026-10-26T20:09:00Z'; data = $oldData })
    Assert-Condition ($merged.points.Count -eq 1 -and $merged.points[0].value -eq 164 -and $merged.revisions.Count -eq 1) 'Select actual latest value once per UTC epoch; never sum overlapping requests.'
    Assert-Condition ($merged.target5xxValuesCount -eq 0 -and $null -eq $merged.target5xxSum) 'Sparse absent 5xx values mean null, not measured zero.'
    $duplicate = @{ MetricDataResults = @($oldData.MetricDataResults[0], $freshData.MetricDataResults[0]) }
    Assert-Rejected { Merge-UsageMonitoringMetrics @(@{ startedAtUtc = '2026-10-26T20:12:00Z'; data = $duplicate }) } 'DUPLICATE_METRIC_EPOCH'
    foreach ($value in @('0', $false, [double]::NaN, [double]::PositiveInfinity)) {
        $badMetric = @{ MetricDataResults = @(@{ Id = 'target_5xx'; StatusCode = 'Complete'; Timestamps = @('2026-10-26T20:08:00Z'); Values = @($value) }) }
        Assert-Rejected { Merge-UsageMonitoringMetrics @(@{ startedAtUtc = '2026-10-26T20:12:00Z'; data = $badMetric }) } 'INVALID_METRIC_VALUE'
    }
    $measuredZero = @{ MetricDataResults = @(@{ Id = 'target_5xx'; StatusCode = 'Complete'; Timestamps = @('2026-10-26T20:08:00Z'); Values = @(0) }) }
    Assert-Condition ((Merge-UsageMonitoringMetrics @(@{ startedAtUtc = '2026-10-26T20:12:00Z'; data = $measuredZero })).target5xxSum -eq 0) 'An actual numeric zero remains distinguishable from an absent point.'

    # A cancellation-resistant copy is a bounded failure, never a finalized raw
    # binding. The fixture settles its task afterward without starting a child.
    $pending = [Threading.Tasks.TaskCompletionSource[bool]]::new()
    $cts = [Threading.CancellationTokenSource]::new()
    try {
        $pipeState = & $module { param($task,$token) Wait-UsageMonitoringPipeCopies $task $task $token 1 1 } $pending.Task $cts
        Assert-Condition (-not $pipeState.copiesSettled -and -not $pipeState.stdoutComplete) 'An unsettled delayed copy must remain incomplete after cancellation.'
        $unsettled = & $module { param($path) Get-UsageMonitoringOutputReference $path $false } $stdout.path
        Assert-Condition (-not $unsettled.finalized -and -not $unsettled.ContainsKey('sha256')) 'Never hash a file while a pipe copy may still change it.'
    } finally { [void]$pending.TrySetResult($true); $cts.Dispose() }

    # Internal capture fixtures are harmless local pwsh scripts; the production
    # entry point separately rejects every non-whitelisted source hash.
    $exe = Get-UsageMonitoringFileBinding (Get-Process -Id $PID).Path
    $ok = Write-Fixture 'success.ps1' '[Console]::Out.Write(''{"events":[]}'')'
    $captured = & $module { param($directory,$reader,$executable) Invoke-UsageMonitoringCaptureInternal $directory 'success' $reader $executable 5 } $temp $ok $exe
    Assert-Condition ((Read-UsageMonitoringCapture $captured).data.events.Count -eq 0) 'Capture succeeds only after original child and both pipes complete.'
    Assert-Rejected { & $module { param($directory,$reader,$executable) Invoke-UsageMonitoringCaptureInternal $directory 'success' $reader $executable 5 } $temp $ok $exe } 'already exists|exists'
    Assert-Rejected { Invoke-UsageMonitoringReader -ReaderBinding $ok -PowerShellBinding $exe -EvidenceDirectory $temp -Label 'not-approved' } 'READER_NOT_APPROVED'
    Assert-Rejected { Invoke-UsageMonitoringReader -ReaderBinding $ok -PowerShellBinding $exe -EvidenceDirectory $root -Label 'inside-repo' } 'OUTSIDE_REPOSITORY'
    [void](Write-JsonFixture 'orphan-native.native.json' @{ historical = $true })
    Assert-Rejected { & $module { param($directory,$reader,$executable) Invoke-UsageMonitoringCaptureInternal $directory 'orphan-native' $reader $executable 5 } $temp $ok $exe } 'LABEL_ALREADY_EXISTS'
    Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $temp 'orphan-native.intent.json'))) 'An existing native without an intent must refuse before any new claim or child.'
    $slow = Write-Fixture 'slow.ps1' '[Console]::Out.Write(''{"partial":true}''); Start-Sleep -Seconds 30'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $slowRef = & $module { param($directory,$reader,$executable) Invoke-UsageMonitoringCaptureInternal $directory 'timeout' $reader $executable 1 } $temp $slow $exe
    $slowNative = Read-UsageMonitoringJson $slowRef -Private
    Assert-Condition ($slowNative.timedOut -and $slowNative.reaped -and $timer.Elapsed.TotalSeconds -lt 10) 'Timeout must kill/reap its owned reader within a bound.'
    Assert-Rejected { Read-UsageMonitoringCapture $slowRef } 'CAPTURE_FAILED'
    $failed = Write-Fixture 'failure.ps1' '[Console]::Out.Write(''{"looksValid":true}''); exit 2'
    $failedRef = & $module { param($directory,$reader,$executable) Invoke-UsageMonitoringCaptureInternal $directory 'nonzero' $reader $executable 5 } $temp $failed $exe
    Assert-Rejected { Read-UsageMonitoringCapture $failedRef } 'CAPTURE_FAILED'
    # Every file handle must be closed before callers can parse or archive it.
    foreach ($file in Get-ChildItem -LiteralPath $temp -File) {
        $handle = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $handle.Dispose()
    }
    Write-Host "Usage Reports monitoring tests: PASS ($script:Assertions assertions)"
} finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^usage-monitoring-tests-[a-f0-9]{32}$') { throw 'Refuse cleanup outside exact test directory.' }
    [IO.Directory]::Delete($resolved, $true)
    Remove-Module $module
}
