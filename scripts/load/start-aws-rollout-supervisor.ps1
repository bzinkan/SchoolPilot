#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [ValidateSet("Validate", "Run")]
    [string]$Mode = "Validate",

    [ValidateSet("Load", "MonitorOnly")]
    [string]$SupervisionKind = "Load"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$harnessScript = Join-Path $PSScriptRoot "classpilot-load-test.mjs"
$monitorScript = Join-Path $PSScriptRoot "aws-rollout-monitor.ps1"
$script:GeneratorIpTestIndex = 0
$script:RollbackWatchdogDiagnostic = "not_checked"

function Resolve-ExternalPath {
    param([string]$Path, [string]$Name, [switch]$AllowMissing)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw "$Name must be an absolute path outside the repository."
    }
    $absolute = [IO.Path]::GetFullPath($Path)
    $root = $repositoryRoot.TrimEnd('\', '/')
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
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $absolute)) { throw "$Name does not exist." }
    return $absolute
}

function Get-RequiredProperty {
    param($Object, [string]$Name)
    $property = if ($null -eq $Object) { $null } else { $Object.PSObject.Properties[$Name] }
    if ($null -eq $property -or $null -eq $property.Value -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
        throw "Supervisor config requires '$Name'."
    }
    return $property.Value
}

function Get-AtomicJsonMutexName {
    param([string]$Path)
    $canonicalPath = [IO.Path]::GetFullPath($Path).ToLowerInvariant()
    $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonicalPath)))
    return "SchoolPilot.Rollout.AtomicJson.$digest"
}

function Invoke-WithAtomicJsonMutex {
    param([string]$Path, [scriptblock]$Operation)
    $mutex = [Threading.Mutex]::new($false, (Get-AtomicJsonMutexName -Path $Path))
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(15)) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw "Timed out waiting for the atomic JSON lock for '$Path'." }
        return & $Operation
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Write-AtomicJson {
    param([string]$Path, $Value)
    $json = $Value | ConvertTo-Json -Depth 40
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    Invoke-WithAtomicJsonMutex -Path $Path -Operation {
        $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
        $backup = "$Path.$([Guid]::NewGuid().ToString('N')).bak"
        try {
            $stream = [IO.FileStream]::new(
                $temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None,
                4096, [IO.FileOptions]::WriteThrough
            )
            try {
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush($true)
            }
            finally { $stream.Dispose() }

            $replaceDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
            while ($true) {
                try {
                    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, $backup, $true) }
                    else { [IO.File]::Move($temporary, $Path) }
                    break
                }
                catch {
                    $failure = $_.Exception
                    $sharingFailure = $false
                    while ($null -ne $failure) {
                        if ($failure -is [IO.IOException] -or $failure -is [UnauthorizedAccessException]) {
                            $sharingFailure = $true
                            break
                        }
                        $failure = $failure.InnerException
                    }
                    if (-not $sharingFailure) { throw }
                    if ([DateTimeOffset]::UtcNow -ge $replaceDeadline) {
                        throw "Atomic JSON replacement remained blocked for '$Path' after 10 seconds."
                    }
                    Start-Sleep -Milliseconds 25
                }
            }
        }
        finally {
            if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
            if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
        }
    } | Out-Null
}

function Read-AtomicJson {
    param([string]$Path, [int]$Depth = 40)
    return Invoke-WithAtomicJsonMutex -Path $Path -Operation {
        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
        try {
            $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true, 4096, $true)
            try { $text = $reader.ReadToEnd() }
            finally { $reader.Dispose() }
        }
        finally { $stream.Dispose() }
        return $text | ConvertFrom-Json -Depth $Depth
    }
}

function Set-SleepPrevention {
    param([bool]$Enabled)
    if (-not $IsWindows) { return }
    if (-not ("SchoolPilot.PowerState" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace SchoolPilot {
    public static class PowerState {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint SetThreadExecutionState(uint flags);
    }
}
"@
    }
    $flags = if ($Enabled) {
        [Convert]::ToUInt32("80000041", 16)
    }
    else {
        [Convert]::ToUInt32("80000000", 16)
    }
    if ([SchoolPilot.PowerState]::SetThreadExecutionState($flags) -eq 0) {
        throw "Windows rejected the temporary sleep-prevention request."
    }
}

function Stop-BoundProcess {
    param($Process)
    if ($null -eq $Process) { return }
    try {
        if ($Process.HasExited) { return }
        if ($IsWindows) {
            & taskkill.exe /PID ([string]$Process.Id) /T /F 2>$null | Out-Null
            if ($LASTEXITCODE -notin @(0, 128)) { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue }
        }
        else { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
}

function Quote-ProcessArgument {
    param([string]$Value)
    if ($Value.Contains('"')) { throw "Process arguments must not contain quote characters." }
    return '"' + $Value + '"'
}

function Send-SupervisorNotification {
    param($Config, [string]$Message)
    try {
        & aws sns publish --region $Config.resources.region --topic-arn $Config.notificationTopicArn `
            --subject "SchoolPilot rollout supervisor INVALID" --message $Message --output json | Out-Null
    }
    catch { }
}

function Test-IsInsideDirectory {
    param([string]$Path, [string]$Directory)
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    return $candidate -eq $root -or $candidate.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-Ipv4Literal {
    param([string]$Value, [string]$Name)
    $address = $null
    if (-not [Net.IPAddress]::TryParse($Value, [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw "$Name must be an IPv4 literal."
    }
    return $Value
}

function Resolve-GeneratorPublicIp {
    param($Config)
    if ($testMode) {
        $sequenceMember = $Config.PSObject.Properties["testGeneratorPublicIpSequence"]
        if ($null -eq $sequenceMember -or @($sequenceMember.Value).Count -lt 1) {
            return Assert-Ipv4Literal -Value ([string]$Config.expectedGeneratorPublicIp) -Name "expectedGeneratorPublicIp"
        }
        $sequence = @($sequenceMember.Value)
        $index = [math]::Min($script:GeneratorIpTestIndex, $sequence.Count - 1)
        $script:GeneratorIpTestIndex++
        return Assert-Ipv4Literal -Value ([string]$sequence[$index]) -Name "testGeneratorPublicIpSequence"
    }
    try { $resolved = ([string](Invoke-RestMethod -Uri "https://checkip.amazonaws.com" -TimeoutSec 10)).Trim() }
    catch { throw "The generator public IPv4 could not be resolved from the AWS-owned check endpoint." }
    return Assert-Ipv4Literal -Value $resolved -Name "resolved generator public IP"
}

function Invoke-StaticMonitorValidation {
    param($Config, [string]$EvidenceDirectory, [string]$PwshPath)
    New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
    $staticPath = Join-Path $EvidenceDirectory "$runId-static-monitor-config.json"
    if (Test-Path -LiteralPath $staticPath) { throw "Static validation artifact already exists: $staticPath" }
    $staticConfig = ($Config | ConvertTo-Json -Depth 40 | ConvertFrom-Json -Depth 40)
    if ($SupervisionKind -eq "Load") {
        $self = Get-Process -Id $PID
        $staticConfig | Add-Member -NotePropertyName artifactsNotBeforeUtc -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString("o")) -Force
        $staticConfig | Add-Member -NotePropertyName harnessProcessId -NotePropertyValue $PID -Force
        $staticConfig | Add-Member -NotePropertyName harnessProcessStartedAtUtc `
            -NotePropertyValue ([DateTimeOffset]$self.StartTime).ToUniversalTime().ToString("o") -Force
        $staticConfig | Add-Member -NotePropertyName harnessProcessPath -NotePropertyValue ([IO.Path]::GetFullPath($self.Path)) -Force
    }
    try {
        Write-AtomicJson -Path $staticPath -Value $staticConfig
        & $PwshPath -NoProfile -File $monitorScript -ConfigPath $staticPath -Mode Validate | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "The static AWS monitor/rollback configuration failed validation." }
    }
    finally { if (Test-Path -LiteralPath $staticPath) { Remove-Item -LiteralPath $staticPath -Force } }
}

function Invoke-HarnessConfigurationPreflight {
    param($Config, [string]$NodePath, [string]$HarnessPath)
    $previousRunId = $env:LOAD_RUN_ID
    try {
        $env:LOAD_RUN_ID = $runId
        $raw = @(& $NodePath $HarnessPath "--validate-config" 2>$null)
    }
    finally {
        if ($null -eq $previousRunId) { Remove-Item Env:LOAD_RUN_ID -ErrorAction SilentlyContinue }
        else { $env:LOAD_RUN_ID = $previousRunId }
    }
    if ($LASTEXITCODE -ne 0 -or $raw.Count -lt 1) {
        throw "The load harness --validate-config preflight failed before traffic."
    }
    # The production harness emits its preflight contract as pretty-printed
    # JSON. PowerShell returns each stdout line as a separate array element, so
    # parse the complete document instead of only its closing line.
    try { $result = (($raw -join [Environment]::NewLine).Trim() | ConvertFrom-Json -Depth 20 -NoEnumerate) }
    catch { throw "The load harness --validate-config preflight did not return valid JSON." }
    if ($result -is [Array] -or $result -isnot [pscustomobject]) {
        throw "The load harness --validate-config preflight must return exactly one JSON object."
    }
    if ($result.ok -ne $true -or $result.trafficStarted -ne $false -or
        [string]$result.runId -ne $runId -or [string]$result.gateProfile -cne "launch" -or
        $result.thresholdsEnforced -ne $true -or [string]$result.networkFamily -cne "IPv4") {
        throw "The load harness preflight did not prove the bound runId, launch profile, enforced thresholds, IPv4-only traffic, and trafficStarted=false."
    }
    if (-not $testMode) {
        $contract = $result.launchContract
        if ($null -eq $contract -or [int]$contract.totalSockets -ne [int]$Config.workload.devices -or
            [int]$contract.durationSeconds -ne [int]$Config.workload.durationSeconds -or
            [int]$contract.screenshotBytes -ne [int]$Config.workload.screenshotBytes) {
            throw "The harness preflight launch contract does not match the immutable monitored workload."
        }
    }
}

function Get-RollbackWatchdogState {
    param([string]$Path, [DateTimeOffset]$Now, [int]$StaleSeconds)
    $heartbeat = $null
    $lastReadError = ""
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try { $heartbeat = Read-AtomicJson -Path $Path -Depth 20; break }
            catch { $lastReadError = $_.Exception.Message }
        }
        Start-Sleep -Milliseconds 100
    }
    if ($null -eq $heartbeat) { $script:RollbackWatchdogDiagnostic = if ($lastReadError) { "unreadable:$lastReadError" } else { "missing" }; return $null }
    try { $heartbeatTimestamp = ([DateTimeOffset]$heartbeat.timestamp).ToUniversalTime() }
    catch { $script:RollbackWatchdogDiagnostic = "invalid_timestamp"; return $null }
    $age = ($Now - $heartbeatTimestamp).TotalSeconds
    $deadline = ([DateTimeOffset]$heartbeat.deadlineUtc).ToUniversalTime()
    $status = [string]$heartbeat.status
    if ([string]$heartbeat.runId -ne $runId) { $script:RollbackWatchdogDiagnostic = "run_id_mismatch"; return $null }
    if ([string]$heartbeat.action -notin @("Application", "Oom", "Waf", "PublicEcs", "NatRemoved", "Redis")) { $script:RollbackWatchdogDiagnostic = "action_invalid"; return $null }
    if ($status -notin @("running", "completed")) { $script:RollbackWatchdogDiagnostic = "status_invalid"; return $null }
    if ($age -gt $StaleSeconds) { $script:RollbackWatchdogDiagnostic = "stale:$([math]::Round($age,1))"; return $null }
    if ($status -eq "running" -and $deadline -le $Now) { $script:RollbackWatchdogDiagnostic = "deadline_reached"; return $null }
    $script:RollbackWatchdogDiagnostic = "healthy"
    return [ordered]@{ action = [string]$heartbeat.action; step = [string]$heartbeat.step; status = $status; deadlineUtc = $deadline; ageSeconds = $age }
}

$resolvedConfigPath = Resolve-ExternalPath -Path $ConfigPath -Name "ConfigPath"
try { $config = Get-Content -LiteralPath $resolvedConfigPath -Raw | ConvertFrom-Json -Depth 40 }
catch { throw "ConfigPath must contain valid JSON." }
$runId = [string](Get-RequiredProperty $config "runId")
if ($runId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or $runId.EndsWith('.')) { throw "runId is not filename-safe." }
$evidenceDirectory = Resolve-ExternalPath -Path ([string](Get-RequiredProperty $config "evidenceDirectory")) -Name "evidenceDirectory" -AllowMissing
[void](Get-RequiredProperty $config "deadlineUtc")
$testModeProperty = $config.PSObject.Properties["testMode"]
$testMode = if ($null -eq $testModeProperty) { $false } else { $testModeProperty.Value }
if ($testMode -isnot [bool]) { throw "testMode must be a JSON boolean." }
$progressPath = $null
$summaryPath = $null
$expectedGeneratorPublicIp = $null
if ($SupervisionKind -eq "Load") {
    $progressPath = Resolve-ExternalPath -Path ([string](Get-RequiredProperty $config "loadProgressPath")) -Name "loadProgressPath" -AllowMissing
    $summaryPath = Resolve-ExternalPath -Path ([string](Get-RequiredProperty $config "loadSummaryPath")) -Name "loadSummaryPath" -AllowMissing
    if ([string]::Equals($progressPath, $summaryPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "loadProgressPath and loadSummaryPath must be different files."
    }
    [void](Get-RequiredProperty $config "workload")
    $expectedGeneratorPublicIp = Assert-Ipv4Literal -Value ([string](Get-RequiredProperty $config "expectedGeneratorPublicIp")) -Name "expectedGeneratorPublicIp"
}

else {
    foreach ($loadOnlyProperty in @("loadProgressPath", "loadSummaryPath", "workload", "harnessProcessId", "harnessProcessStartedAtUtc", "harnessProcessPath")) {
        $property = $config.PSObject.Properties[$loadOnlyProperty]
        if ($null -ne $property -and $null -ne $property.Value) {
            throw "MonitorOnly supervision forbids load-only property '$loadOnlyProperty'."
        }
    }
    if ([string](Get-RequiredProperty $config "phase") -ne "PublicEcs") {
        throw "MonitorOnly supervision is reserved for the PublicEcs soak."
    }
    if ([int](Get-RequiredProperty $config.resources "expectedNatGatewayCount") -ne 2) {
        throw "MonitorOnly PublicEcs supervision requires exactly two retained NAT gateways."
    }
    if (-not $testMode) {
        $thresholds = Get-RequiredProperty $config "thresholds"
        $natGate = $thresholds.PSObject.Properties["requireNatSixHourAcceptance"]
        if ([int](Get-RequiredProperty $config "minimumWallClockSeconds") -ne 86400 -or
            $null -eq $natGate -or $natGate.Value -ne $true) {
            throw "Production MonitorOnly supervision requires exactly 24 hours and the final-six-hour NAT gate."
        }
        $deadline = ([DateTimeOffset]$config.deadlineUtc).ToUniversalTime()
        if ($deadline -le [DateTimeOffset]::UtcNow.AddHours(24)) {
            throw "Production MonitorOnly deadlineUtc must extend beyond the full 24-hour soak."
        }
    }
}

if ($testMode) {
    $sentinel = $config.PSObject.Properties["testEnvironmentSentinel"]
    if ($null -eq $sentinel -or [string]$sentinel.Value -ne "SCHOOLPILOT_ROLLOUT_TEST_ONLY" -or
        [string]$env:SCHOOLPILOT_ROLLOUT_TEST_MODE -ne "I_UNDERSTAND_TEST_ONLY") {
        throw "testMode requires the explicit config and environment sentinels."
    }
    foreach ($candidate in @($resolvedConfigPath, $evidenceDirectory, $progressPath, $summaryPath) | Where-Object { $_ }) {
        if (-not (Test-IsInsideDirectory -Path $candidate -Directory ([IO.Path]::GetTempPath()))) {
            throw "testMode paths must stay under the operating-system temporary directory."
        }
    }
    if (($config | ConvertTo-Json -Depth 40 -Compress) -match '(?i)schoolpilot[-_]?production|production[-_]?schoolpilot') {
        throw "testMode must not reference production resource identifiers."
    }
    $topicMember = $config.PSObject.Properties["notificationTopicArn"]
    if ($null -eq $topicMember -or [string]$topicMember.Value -notmatch '^arn:aws:sns:[a-z0-9-]+:000000000000:test[-A-Za-z0-9_.]*$') {
        throw "testMode notifications must use the reserved mock account and test-prefixed topic."
    }
}

$watchdogMember = $config.PSObject.Properties["supervisorWatchdog"]
$watchdog = if ($null -eq $watchdogMember -or $null -eq $watchdogMember.Value) { [pscustomobject]@{} } else { $watchdogMember.Value }
$monitorHeartbeatStaleSeconds = if ($null -eq $watchdog.PSObject.Properties["monitorHeartbeatStaleSeconds"]) { 180 } else { [int]$watchdog.monitorHeartbeatStaleSeconds }
$rollbackHeartbeatStaleSeconds = if ($null -eq $watchdog.PSObject.Properties["rollbackHeartbeatStaleSeconds"]) { 45 } else { [int]$watchdog.rollbackHeartbeatStaleSeconds }
$supervisorPollSeconds = if ($null -eq $watchdog.PSObject.Properties["pollSeconds"]) { 5 } else { [int]$watchdog.pollSeconds }
$generatorIpCheckSeconds = if ($null -eq $watchdog.PSObject.Properties["generatorIpCheckSeconds"]) { 60 } else { [int]$watchdog.generatorIpCheckSeconds }
if ($monitorHeartbeatStaleSeconds -lt 1 -or $rollbackHeartbeatStaleSeconds -lt 1 -or $supervisorPollSeconds -lt 1 -or $generatorIpCheckSeconds -lt 1) {
    throw "Supervisor watchdog intervals must be positive."
}
if (-not $testMode -and ($monitorHeartbeatStaleSeconds -ne 180 -or $rollbackHeartbeatStaleSeconds -ne 45 -or $supervisorPollSeconds -ne 5 -or $generatorIpCheckSeconds -ne 60)) {
    throw "Production supervisor watchdog thresholds are immutable."
}

$runtimeHarnessScript = $harnessScript
$runtimeMonitorScript = $monitorScript
$generatorSequenceMember = $config.PSObject.Properties["testGeneratorPublicIpSequence"]
if ($null -ne $generatorSequenceMember -and $null -ne $generatorSequenceMember.Value) {
    if (-not $testMode) { throw "testGeneratorPublicIpSequence is forbidden outside isolated testMode." }
    foreach ($candidateIp in @($generatorSequenceMember.Value)) { [void](Assert-Ipv4Literal ([string]$candidateIp) "testGeneratorPublicIpSequence") }
}
foreach ($testHook in @("testRuntimeHarnessScriptPath", "testRuntimeMonitorScriptPath")) {
    $member = $config.PSObject.Properties[$testHook]
    if ($null -ne $member -and $member.Value) {
        if (-not $testMode) { throw "$testHook is forbidden outside isolated testMode." }
        $resolvedHook = Resolve-ExternalPath -Path ([string]$member.Value) -Name $testHook
        if (-not (Test-IsInsideDirectory -Path $resolvedHook -Directory ([IO.Path]::GetTempPath()))) {
            throw "$testHook must remain under the operating-system temporary directory."
        }
        if ($testHook -eq "testRuntimeHarnessScriptPath") { $runtimeHarnessScript = $resolvedHook }
        else { $runtimeMonitorScript = $resolvedHook }
    }
}

$node = if ($SupervisionKind -eq "Load") { Get-Command node -ErrorAction Stop } else { $null }
$pwsh = (Get-Process -Id $PID).Path
if (-not (Test-Path -LiteralPath $monitorScript -PathType Leaf) -or -not (Test-Path -LiteralPath $runtimeMonitorScript -PathType Leaf) -or
    ($SupervisionKind -eq "Load" -and -not (Test-Path -LiteralPath $runtimeHarnessScript -PathType Leaf))) {
    throw "The required harness or monitor script is missing."
}

[ordered]@{
    valid = $true
    schemaVersion = 1
    runId = $runId
    mode = $Mode
    supervisionKind = $SupervisionKind
    nodePath = if ($null -eq $node) { $null } else { $node.Source }
    evidenceDirectory = $evidenceDirectory
} | ConvertTo-Json
if ($Mode -eq "Validate") {
    Invoke-StaticMonitorValidation -Config $config -EvidenceDirectory $evidenceDirectory -PwshPath $pwsh
    if ($SupervisionKind -eq "Load") {
        Invoke-HarnessConfigurationPreflight -Config $config -NodePath $node.Source -HarnessPath $runtimeHarnessScript
        $validationIp = Resolve-GeneratorPublicIp -Config $config
        if ($validationIp -ne $expectedGeneratorPublicIp) { throw "Generator public IPv4 does not match expectedGeneratorPublicIp." }
    }
    exit 0
}


# Validate the complete monitor and every reachable rollback before sleep is
# disabled and, critically, before any load traffic process is started.
Invoke-StaticMonitorValidation -Config $config -EvidenceDirectory $evidenceDirectory -PwshPath $pwsh
if ($SupervisionKind -eq "Load") {
    Invoke-HarnessConfigurationPreflight -Config $config -NodePath $node.Source -HarnessPath $runtimeHarnessScript
}
$initialGeneratorPublicIp = if ($SupervisionKind -eq "Load") { Resolve-GeneratorPublicIp -Config $config } else { $null }
if ($SupervisionKind -eq "Load" -and $initialGeneratorPublicIp -ne $expectedGeneratorPublicIp) {
    throw "Generator public IPv4 does not match expectedGeneratorPublicIp before traffic."
}

if ($SupervisionKind -eq "Load") {
    foreach ($path in @($progressPath, $summaryPath)) {
        if (Test-Path -LiteralPath $path) { throw "Long-run artifacts must not preexist: $path" }
    }
}
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
$heartbeatPath = Join-Path $evidenceDirectory "$runId-supervisor-heartbeat.json"
$supervisorResultPath = Join-Path $evidenceDirectory "$runId-supervisor-result.json"
$boundConfigPath = Join-Path $evidenceDirectory "$runId-bound-monitor-config.json"
$harnessStdout = if ($SupervisionKind -eq "Load") { Join-Path $evidenceDirectory "$runId-harness.stdout.log" } else { $null }
$harnessStderr = if ($SupervisionKind -eq "Load") { Join-Path $evidenceDirectory "$runId-harness.stderr.log" } else { $null }
$monitorStdout = Join-Path $evidenceDirectory "$runId-monitor.stdout.log"
$monitorStderr = Join-Path $evidenceDirectory "$runId-monitor.stderr.log"
$generatorIpEvidencePath = if ($SupervisionKind -eq "Load") { Join-Path $evidenceDirectory "$runId-generator-public-ip.json" } else { $null }
$supervisorArtifacts = @($heartbeatPath, $supervisorResultPath, $boundConfigPath, $monitorStdout, $monitorStderr)
if ($SupervisionKind -eq "Load") { $supervisorArtifacts += @($harnessStdout, $harnessStderr, $generatorIpEvidencePath) }
foreach ($path in $supervisorArtifacts) {
    if (Test-Path -LiteralPath $path) { throw "Supervisor artifact already exists: $path" }
}

$harness = $null
$monitor = $null
$sleepPreventionEnabled = $false
try {
    Set-SleepPrevention -Enabled $true
    $sleepPreventionEnabled = $true
    $launchedAt = [DateTimeOffset]::UtcNow
    Write-AtomicJson -Path $heartbeatPath -Value ([ordered]@{
        runId = $runId; timestamp = $launchedAt.ToString("o"); status = "starting"; supervisionKind = $SupervisionKind
    })
    if ($SupervisionKind -eq "Load") {
        Write-AtomicJson -Path $generatorIpEvidencePath -Value ([ordered]@{
            runId=$runId;timestamp=$launchedAt.ToString("o");expectedPublicIp=$expectedGeneratorPublicIp;actualPublicIp=$initialGeneratorPublicIp
        })
    }
    if ($SupervisionKind -eq "Load") {
        $harness = Start-Process -FilePath $node.Source -ArgumentList @((Quote-ProcessArgument $runtimeHarnessScript)) -Environment @{ LOAD_RUN_ID = $runId } -PassThru -NoNewWindow `
            -RedirectStandardOutput $harnessStdout -RedirectStandardError $harnessStderr
        Start-Sleep -Milliseconds 250
        $harness.Refresh()
        if ($harness.HasExited) { throw "The load harness exited during startup." }

        $config | Add-Member -NotePropertyName artifactsNotBeforeUtc -NotePropertyValue $launchedAt.ToString("o") -Force
        $config | Add-Member -NotePropertyName harnessProcessId -NotePropertyValue $harness.Id -Force
        $config | Add-Member -NotePropertyName harnessProcessStartedAtUtc `
            -NotePropertyValue ([DateTimeOffset]$harness.StartTime).ToUniversalTime().ToString("o") -Force
        $config | Add-Member -NotePropertyName harnessProcessPath -NotePropertyValue ([IO.Path]::GetFullPath($harness.Path)) -Force
    }
    $heartbeatProperty = $config.PSObject.Properties["supervisedHeartbeatPaths"]
    $existingHeartbeats = if ($null -eq $heartbeatProperty) { @() } else { @($heartbeatProperty.Value) }
    $heartbeats = @($existingHeartbeats) + @($heartbeatPath) | Sort-Object -Unique
    $config | Add-Member -NotePropertyName supervisedHeartbeatPaths -NotePropertyValue $heartbeats -Force
    if ($SupervisionKind -eq "Load") {
        $config | Add-Member -NotePropertyName generatorIpEvidencePath -NotePropertyValue $generatorIpEvidencePath -Force
    }
    Write-AtomicJson -Path $boundConfigPath -Value $config

    & $pwsh -NoProfile -File $monitorScript -ConfigPath $boundConfigPath -Mode Validate | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The bound monitor configuration failed validation." }
    $monitor = Start-Process -FilePath $pwsh -ArgumentList @("-NoProfile", "-File", (Quote-ProcessArgument $runtimeMonitorScript), "-ConfigPath", (Quote-ProcessArgument $boundConfigPath), "-Mode", "Monitor") `
        -PassThru -NoNewWindow -RedirectStandardOutput $monitorStdout -RedirectStandardError $monitorStderr
    $monitorStartedAt = [DateTimeOffset]::UtcNow

    $monitorHeartbeatPath = Join-Path $evidenceDirectory "$runId-monitor-heartbeat.json"
    $rollbackHeartbeatPath = Join-Path $evidenceDirectory "$runId-rollback-heartbeat.json"
    $lastHeartbeatWrite = [DateTimeOffset]::MinValue
    $lastGeneratorIpCheck = $launchedAt
    while (-not $monitor.HasExited) {
        $now = [DateTimeOffset]::UtcNow
        if (($now - $lastHeartbeatWrite).TotalSeconds -ge 30) {
            $heartbeat = [ordered]@{
                runId = $runId; timestamp = $now.ToString("o"); status = "running";
                supervisionKind = $SupervisionKind; monitorProcessId = $monitor.Id
            }
            if ($SupervisionKind -eq "Load") { $heartbeat.harnessProcessId = $harness.Id }
            Write-AtomicJson -Path $heartbeatPath -Value $heartbeat
            $lastHeartbeatWrite = $now
        }
        $monitorHeartbeatUnhealthy = $false
        if (Test-Path -LiteralPath $monitorHeartbeatPath) {
            $age = ($now - [DateTimeOffset](Get-Item -LiteralPath $monitorHeartbeatPath).LastWriteTimeUtc).TotalSeconds
            $monitorHeartbeatUnhealthy = $age -gt $monitorHeartbeatStaleSeconds
        }
        elseif (($now - $monitorStartedAt).TotalSeconds -gt $monitorHeartbeatStaleSeconds) { $monitorHeartbeatUnhealthy = $true }
        if ($monitorHeartbeatUnhealthy) {
            $rollbackState = Get-RollbackWatchdogState -Path $rollbackHeartbeatPath -Now $now -StaleSeconds $rollbackHeartbeatStaleSeconds
            if ($null -eq $rollbackState) {
                throw "The AWS monitor heartbeat is stale and no fresh, bounded rollback heartbeat is active ($script:RollbackWatchdogDiagnostic)."
            }
            Write-AtomicJson -Path $heartbeatPath -Value ([ordered]@{
                runId = $runId; timestamp = $now.ToString("o"); status = "rollback_running";
                supervisionKind = $SupervisionKind; monitorProcessId = $monitor.Id;
                rollbackAction = $rollbackState.action; rollbackStep = $rollbackState.step;
                rollbackStatus = $rollbackState.status; rollbackDeadlineUtc = $rollbackState.deadlineUtc.ToString("o")
            })
        }
        if ($SupervisionKind -eq "Load" -and ($now - $lastGeneratorIpCheck).TotalSeconds -ge $generatorIpCheckSeconds) {
            $actualGeneratorIp = Resolve-GeneratorPublicIp -Config $config
            Write-AtomicJson -Path $generatorIpEvidencePath -Value ([ordered]@{
                runId=$runId;timestamp=$now.ToString("o");expectedPublicIp=$expectedGeneratorPublicIp;actualPublicIp=$actualGeneratorIp
            })
            $lastGeneratorIpCheck = $now
            if ($actualGeneratorIp -ne $expectedGeneratorPublicIp) {
                throw "Generator public IPv4 changed during the supervised load run."
            }
        }
        Start-Sleep -Seconds $supervisorPollSeconds
        $monitor.Refresh()
    }
    $monitor.WaitForExit()
    if ($monitor.ExitCode -ne 0) { throw "The AWS monitor exited with code $($monitor.ExitCode)." }
    if ($SupervisionKind -eq "Load") {
        $harness.Refresh()
        if (-not $harness.HasExited) { $harness.WaitForExit(30000) | Out-Null }
        $harness.Refresh()
        if (-not $harness.HasExited) { throw "The load harness did not exit after monitor acceptance." }
        if ($harness.ExitCode -ne 0) { throw "The load harness exited with code $($harness.ExitCode)." }
    }
    Write-AtomicJson -Path $supervisorResultPath -Value ([ordered]@{
        runId = $runId; status = "completed"; supervisionKind = $SupervisionKind;
        timestamp = [DateTimeOffset]::UtcNow.ToString("o"); monitorExitCode = 0;
        harnessExitCode = if ($SupervisionKind -eq "Load") { 0 } else { $null }
    })
}
catch {
    Stop-BoundProcess -Process $harness
    Stop-BoundProcess -Process $monitor
    $termination = if ($SupervisionKind -eq "Load") { "Traffic was terminated" } else { "Monitor-only supervision was terminated" }
    $message = "Run $runId became invalid because $($_.Exception.Message). $termination; no infrastructure mutation was attempted by the supervisor."
    Send-SupervisorNotification -Config $config -Message $message
    Write-AtomicJson -Path $supervisorResultPath -Value ([ordered]@{
        runId = $runId; status = "failed"; timestamp = [DateTimeOffset]::UtcNow.ToString("o"); error = $_.Exception.Message
    })
    throw
}
finally {
    Stop-BoundProcess -Process $harness
    Stop-BoundProcess -Process $monitor
    if ($sleepPreventionEnabled) { try { Set-SleepPrevention -Enabled $false } catch { } }
}
