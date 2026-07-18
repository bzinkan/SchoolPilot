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
    if ($null -eq $property -or $null -eq $property.Value -or
        ($property.Value -is [string] -and [string]::IsNullOrWhiteSpace([string]$property.Value))) {
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
        $testLookupIndex = $script:GeneratorIpTestIndex
        $script:GeneratorIpTestIndex++
        $delayMember = $Config.PSObject.Properties["testPreReleaseGeneratorPublicIpDelayMilliseconds"]
        if ($testLookupIndex -gt 0 -and $null -ne $delayMember -and $null -ne $delayMember.Value -and
            [int]$delayMember.Value -gt 0) {
            Start-Sleep -Milliseconds ([int]$delayMember.Value)
        }
        if ($null -eq $sequenceMember -or @($sequenceMember.Value).Count -lt 1) {
            return Assert-Ipv4Literal -Value ([string]$Config.expectedGeneratorPublicIp) -Name "expectedGeneratorPublicIp"
        }
        $sequence = @($sequenceMember.Value)
        $index = [math]::Min($testLookupIndex, $sequence.Count - 1)
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
        $staticConfigSha256=Get-CertificationSha256 $staticPath
        & $PwshPath -NoProfile -File $monitorScript -ConfigPath $staticPath -ExpectedConfigSha256 $staticConfigSha256 -Mode Validate | Out-Null
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
        $expectedPrimary = [int]$Config.workload.devices - [int]$Config.workload.canaryDevices
        $expectedTargets = if ($expectedPrimary -eq 500) { 25 } elseif ($expectedPrimary -in @(800,1000)) { 40 } else { 0 }
        if ($null -eq $contract -or [int]$contract.totalSockets -ne [int]$Config.workload.devices -or
            [int]$contract.primaryDevices -ne $expectedPrimary -or
            [int]$contract.canaryDevices -ne [int]$Config.workload.canaryDevices -or
            [int]$contract.durationSeconds -ne [int]$Config.workload.durationSeconds -or
            [int]$contract.screenshotBytes -ne [int]$Config.workload.screenshotBytes -or
            [int]$contract.expectedClassBodies -ne 20 -or [int]$contract.expectedTargetsPerClass -ne $expectedTargets -or
            [int]$contract.teacherActors -ne 20 -or [int]$contract.teacherTileCohorts -ne 20 -or
            [int]$contract.teacherTileAssignments -ne $expectedPrimary) {
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

function Assert-HealthyMonitorArmingHeartbeat {
    param(
        $Heartbeat,
        [string]$ExpectedRunId,
        [string]$ExpectedPhase,
        [DateTimeOffset]$MonitorStartedAt,
        [DateTimeOffset]$Now,
        [int]$StaleSeconds
    )
    try { $heartbeatTimestamp = ([DateTimeOffset]$Heartbeat.timestamp).ToUniversalTime() }
    catch { throw "The AWS monitor heartbeat timestamp is invalid." }
    if ([string]$Heartbeat.runId -ne $ExpectedRunId -or [string]$Heartbeat.phase -ne $ExpectedPhase -or
        $Heartbeat.triggered -isnot [bool] -or $Heartbeat.triggered -ne $false -or
        [int]$Heartbeat.iteration -lt 1 -or $heartbeatTimestamp -lt $MonitorStartedAt -or
        $heartbeatTimestamp -gt $Now.AddSeconds(5) -or ($Now - $heartbeatTimestamp).TotalSeconds -gt $StaleSeconds) {
        throw "The AWS monitor did not publish a fresh, healthy arming heartbeat for the bound run."
    }
}

function ConvertTo-CertificationComparableJson {
    param($Value)
    # Certification controller hashes are emitted by this controller as a
    # stable ordered object. Round-trip both live and persisted values through
    # the same serializer before comparing them so PSObject/ordered-dictionary
    # adapter differences cannot weaken an exact identity check.
    return ($Value | ConvertTo-Json -Depth 60 -Compress)
}

function Get-CertificationValue {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $member = $Object.PSObject.Properties[$Name]
    if ($null -eq $member -or $null -eq $member.Value) { return $Default }
    return $member.Value
}

function Get-CertificationSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-CertificationTextSha256 {
    param([string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.UTF8Encoding]::new($false).GetBytes($Text)
    )).ToLowerInvariant()
}

function Assert-CertificationSha256 {
    param([string]$Value, [string]$Name)
    $normalized = $Value.ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{64}$') { throw "$Name must be an exact SHA-256 digest." }
    return $normalized
}

function Assert-CertificationGitSha {
    param([string]$Value, [string]$Name)
    $normalized = $Value.ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{40}$') { throw "$Name must be an exact 40-hex Git SHA." }
    return $normalized
}

function Assert-CertificationEvidenceReference {
    param($Reference, [string]$Name)
    if ($null -eq $Reference) { throw "$Name is required." }
    $path = Resolve-ExternalPath -Path ([string](Get-RequiredProperty $Reference "path")) -Name "$Name.path"
    $expected = Assert-CertificationSha256 -Value ([string](Get-RequiredProperty $Reference "sha256")) -Name "$Name.sha256"
    $actual = Get-CertificationSha256 -Path $path
    if ($actual -ne $expected) { throw "$Name was changed after its hash was recorded." }
    return [ordered]@{ path = $path; sha256 = $actual }
}

function Get-CertificationControllerHashes {
    $paths = [ordered]@{
        supervisor = $PSCommandPath
        monitor = $monitorScript
        rollback = Join-Path $PSScriptRoot "aws-rollout-rollback.ps1"
        harness = $harnessScript
        preparer = Join-Path $PSScriptRoot "prepare-classpilot-load-test.mjs"
        savedPlanValidator = Join-Path $PSScriptRoot "validate-rollout-plan.ps1"
    }
    $hashes = [ordered]@{}
    foreach ($name in $paths.Keys) {
        if (-not (Test-Path -LiteralPath $paths[$name] -PathType Leaf)) { throw "Certification controller component '$name' is missing." }
        $hashes[$name] = Get-CertificationSha256 -Path $paths[$name]
    }
    return $hashes
}

function Test-CertificationIntervalIncludesLocalTime {
    param([DateTimeOffset]$StartUtc, [int]$DurationSeconds, [string]$Timezone, [string]$LocalTime)
    try { $zone = [TimeZoneInfo]::FindSystemTimeZoneById($Timezone) }
    catch { throw "Fixture timezone '$Timezone' is not recognized by this controller." }
    $parts = @($LocalTime -split ':')
    if ($parts.Count -ne 2) { throw "Local time '$LocalTime' is invalid." }
    $hour = [int]$parts[0]; $minute = [int]$parts[1]
    $start = $StartUtc.ToUniversalTime()
    $end = $start.AddSeconds($DurationSeconds)
    $cursorTicks = $start.Ticks - ($start.Ticks % [TimeSpan]::TicksPerMinute)
    $cursor = [DateTimeOffset]::new($cursorTicks, [TimeSpan]::Zero)
    while ($cursor -le $end) {
        $local = [TimeZoneInfo]::ConvertTime($cursor, $zone)
        if ($local.Hour -eq $hour -and $local.Minute -eq $minute -and $cursor -ge $start -and $cursor -le $end) { return $true }
        $cursor = $cursor.AddMinutes(1)
    }
    return $false
}

function ConvertTo-CertificationUtcTimestamp {
    param($Value, [string]$Name)
    if ($Value -is [DateTimeOffset]) { return ([DateTimeOffset]$Value).ToUniversalTime() }
    if ($Value -is [DateTime]) {
        $dateTime = [DateTime]$Value
        if ($dateTime.Kind -eq [DateTimeKind]::Unspecified) { throw "$Name must include an explicit UTC offset." }
        return ([DateTimeOffset]$dateTime).ToUniversalTime()
    }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text) -or $text -notmatch '(?:Z|[+-]\d{2}:\d{2})$') {
        throw "$Name must be an ISO-8601 timestamp with an explicit UTC offset."
    }
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($text,[ref]$parsed)) {
        throw "$Name must be an ISO-8601 timestamp with an explicit UTC offset."
    }
    return $parsed.ToUniversalTime()
}

function Assert-CertificationFreshTimestamp {
    param($Value, [string]$Name)
    $utc=ConvertTo-CertificationUtcTimestamp $Value $Name;$now=[DateTimeOffset]::UtcNow
    if ($utc -gt $now.AddMinutes(5) -or $utc -lt $now.AddHours(-24)) { throw "$Name must be fresh within 24 hours." }
    return $utc
}

function Assert-CertificationFixtureVerificationTimestamp {
    param(
        $Value,
        [int]$MaximumAgeMinutes,
        [DateTimeOffset]$ObservedNowUtc = [DateTimeOffset]::UtcNow,
        [string]$Name = "Fixture live verification"
    )
    $verifiedAt = ConvertTo-CertificationUtcTimestamp $Value $Name
    $now = $ObservedNowUtc.ToUniversalTime()
    $verifiedTicks = $verifiedAt.UtcDateTime.Ticks
    $nowTicks = $now.UtcDateTime.Ticks
    if ($MaximumAgeMinutes -lt 1 -or $MaximumAgeMinutes -gt 120) {
        throw "Fixture maximumVerificationAgeMinutes must be between 1 and 120."
    }
    if ($verifiedTicks -gt $nowTicks) {
        throw "$Name timestamp is in the future (value=$($verifiedAt.ToString('o')); observedNowUtc=$($now.ToString('o'))); refresh and reverify the owned two-school fixture."
    }
    if (($nowTicks - $verifiedTicks) -gt [TimeSpan]::FromMinutes($MaximumAgeMinutes).Ticks) {
        throw "$Name is stale; refresh and reverify the owned two-school fixture."
    }
    return $verifiedAt
}

function Assert-CertificationProductionRollbackTaskIdentities {
    param([string]$ApiArn, [string]$WorkerArn, [bool]$TestMode)
    if ($TestMode) { return }
    if ($ApiArn -ne "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:13" -or
        $WorkerArn -ne "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:35") {
        throw "Rollback identities must be the exact reviewed full us-east-1 production API :13 and worker :35 ARNs."
    }
}

function Get-CertificationFixtureGenerationBinding {
    param(
        $State,
        $Verification,
        $Fixture,
        [DateTimeOffset]$VerifiedAt,
        [int]$MaximumAgeMinutes,
        [DateTimeOffset]$ObservedNowUtc = [DateTimeOffset]::UtcNow
    )
    $expectedFixtureId = [string](Get-RequiredProperty $Fixture "expectedFixtureId")
    if ($expectedFixtureId -notmatch '^[a-z0-9][a-z0-9-]{2,40}$' -or
        [int]$State.schemaVersion -ne 1 -or [int]$Verification.schemaVersion -ne 1 -or
        [string]$State.fixtureId -ne $expectedFixtureId -or [string]$Verification.fixtureId -ne $expectedFixtureId -or
        $Verification.passed -ne $true) {
        throw "Fixture state and verification must bind the exact expected fixture generation and accepted schema."
    }
    $generatedAt = ConvertTo-CertificationUtcTimestamp $State.generatedAt "Fixture state generatedAt"
    $refreshedAt = Assert-CertificationFixtureVerificationTimestamp `
        $State.refreshedAt $MaximumAgeMinutes $ObservedNowUtc "Fixture state refreshedAt"
    if ($generatedAt -gt $refreshedAt -or $refreshedAt -gt $VerifiedAt) {
        throw "Fixture generatedAt/refreshedAt/verifiedAt chronology is invalid."
    }
    return [ordered]@{fixtureId=$expectedFixtureId;generatedAtUtc=$generatedAt.ToString("o");refreshedAtUtc=$refreshedAt.ToString("o")}
}

function Get-CertificationHarnessArtifactBindings {
    param($References, [string]$Name)
    $requiredKinds = @("device-manifest", "teacher-auth", "command-bodies")
    $bindings = @()
    foreach ($reference in @($References)) {
        $kind = [string](Get-CertificationValue $reference "kind" "")
        if ($kind -notin $requiredKinds -or @($bindings | Where-Object { $_.kind -eq $kind }).Count -gt 0) {
            throw "$Name must contain each reviewed harness artifact kind exactly once."
        }
        $binding = Assert-CertificationEvidenceReference $reference $Name
        $bindings += [ordered]@{kind=$kind;path=$binding.path;sha256=$binding.sha256}
    }
    $observedKinds = @($bindings | ForEach-Object { [string]$_.kind } | Sort-Object -Unique)
    if ($bindings.Count -ne 3 -or @(Compare-Object $requiredKinds $observedKinds).Count -ne 0 -or
        @($bindings.path | Sort-Object -Unique).Count -ne 3 -or @($bindings.sha256 | Sort-Object -Unique).Count -ne 3) {
        throw "$Name must bind distinct device-manifest, teacher-auth, and command-bodies artifacts."
    }
    return @($bindings | Sort-Object { [string]$_.kind })
}

function Assert-CertificationHarnessArtifactContract {
    param($ArtifactBindings, [string]$Name)
    $byKind = @{}
    foreach ($binding in @($ArtifactBindings)) { $byKind[[string]$binding.kind] = $binding }
    try { $devices = @(Get-Content -LiteralPath $byKind["device-manifest"].path -Raw | ConvertFrom-Json -Depth 30) }
    catch { throw "$Name device manifest must contain valid JSON." }
    try { $auth = Get-Content -LiteralPath $byKind["teacher-auth"].path -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "$Name teacher-auth artifact must contain valid JSON." }
    try { $commands = @(Get-Content -LiteralPath $byKind["command-bodies"].path -Raw | ConvertFrom-Json -Depth 30) }
    catch { throw "$Name command-bodies artifact must contain valid JSON." }

    $primarySchoolId = [string](Get-CertificationValue $auth "schoolId" "")
    $teachers = @(Get-CertificationValue $auth "teacherAuth" @())
    $firstCanaries = @($devices | Select-Object -First 10)
    $primaryDevices = @($devices | Select-Object -Skip 10)
    $deviceIds = @($devices | ForEach-Object { [string]$_.deviceId })
    $deviceStudentIds = @($devices | ForEach-Object { [string]$_.studentId })
    $schoolIds = @($devices | ForEach-Object { [string]$_.schoolId } | Sort-Object -Unique)
    if ($devices.Count -ne 1010 -or $firstCanaries.Count -ne 10 -or $primaryDevices.Count -ne 1000 -or
        [string]::IsNullOrWhiteSpace($primarySchoolId) -or $schoolIds.Count -ne 2 -or
        @($deviceIds | Sort-Object -Unique).Count -ne 1010 -or
        @($deviceStudentIds | Sort-Object -Unique).Count -ne 1010 -or
        @($devices | Where-Object {
            [string]::IsNullOrWhiteSpace([string]$_.deviceId) -or
            [string]::IsNullOrWhiteSpace([string]$_.studentId) -or
            [string]::IsNullOrWhiteSpace([string]$_.studentToken) -or
            [string]::IsNullOrWhiteSpace([string]$_.schoolId)
        }).Count -gt 0 -or
        @($firstCanaries | ForEach-Object { [string]$_.schoolId } | Sort-Object -Unique).Count -ne 1 -or
        @($firstCanaries | Where-Object { [string]$_.schoolId -eq $primarySchoolId }).Count -gt 0 -or
        @($primaryDevices | Where-Object { [string]$_.schoolId -ne $primarySchoolId }).Count -gt 0) {
        throw "$Name device manifest does not prove the exact 10-canary plus 1000-primary fixture order."
    }

    $teacherIds = @($teachers | ForEach-Object { [string]$_.teacherId })
    $teacherSessionIds = @($teachers | ForEach-Object { [string]$_.teachingSessionId })
    $rosterStudentIds = @($teachers | ForEach-Object { @($_.studentIds) } | ForEach-Object { [string]$_ })
    if ([int](Get-CertificationValue $auth "schemaVersion" 0) -ne 2 -or $teachers.Count -ne 20 -or
        @($teacherIds | Sort-Object -Unique).Count -ne 20 -or
        @($teacherSessionIds | Sort-Object -Unique).Count -ne 20 -or
        $rosterStudentIds.Count -ne 800 -or @($rosterStudentIds | Sort-Object -Unique).Count -ne 800 -or
        @($teachers | Where-Object {
            [string]$_.schoolId -ne $primarySchoolId -or [string]$_.role -ne "teacher" -or
            @($_.studentIds).Count -ne 40 -or [string]::IsNullOrWhiteSpace([string]$_.teacherCookie) -or
            [string]::IsNullOrWhiteSpace([string]$_.csrfToken) -or
            [string]::IsNullOrWhiteSpace([string]$_.teacherToken)
        }).Count -gt 0) {
        throw "$Name teacher-auth artifact does not prove 20 live disjoint 40-student teacher cohorts."
    }
    $selectedWaf500StudentIds = @($primaryDevices | Select-Object -First 500 | ForEach-Object { [string]$_.studentId })
    $selectedPrimaryStudentIds = @($primaryDevices | Select-Object -First 800 | ForEach-Object { [string]$_.studentId })
    if ($selectedPrimaryStudentIds.Count -ne 800 -or
        @(Compare-Object @($rosterStudentIds | Sort-Object) @($selectedPrimaryStudentIds | Sort-Object)).Count -ne 0) {
        throw "$Name device manifest does not bind the selected Waf/800 primary devices to the 800 teacher-roster students."
    }
    foreach ($teacher in $teachers) {
        $teacherRosterStudentIds = @($teacher.studentIds | ForEach-Object { [string]$_ })
        $waf500TeacherTargets = @($selectedWaf500StudentIds | Where-Object { $_ -in $teacherRosterStudentIds })
        $waf800TeacherTargets = @($selectedPrimaryStudentIds | Where-Object { $_ -in $teacherRosterStudentIds })
        if ($waf500TeacherTargets.Count -ne 25 -or $waf800TeacherTargets.Count -ne 40) {
            throw "$Name device manifest must select exactly 25 roster students per class for Waf/500 and 40 per class for Waf/800."
        }
    }

    $commandSessionIds = @($commands | ForEach-Object { [string]$_.teachingSessionId })
    if ($commands.Count -ne 20 -or @($commandSessionIds | Sort-Object -Unique).Count -ne 20 -or
        @(Compare-Object @($teacherSessionIds | Sort-Object) @($commandSessionIds | Sort-Object)).Count -ne 0 -or
        @($commands | Where-Object {
            [string]$_.targetScope -ne "class" -or [string]$_.commandType -ne "open-tab" -or
            [string]::IsNullOrWhiteSpace([string]$_.commandPayload.url)
        }).Count -gt 0) {
        throw "$Name command-bodies artifact does not prove the exact 20 safe class-scoped command cohorts."
    }
}

function Assert-CertificationHarnessArtifactEnvironment {
    param($ArtifactBindings)
    $environmentByKind = [ordered]@{
        "device-manifest" = "LOAD_DEVICE_MANIFEST"
        "teacher-auth" = "LOAD_TEACHER_AUTH_FILE"
        "command-bodies" = "LOAD_COMMAND_BODIES_FILE"
    }
    foreach ($entry in $environmentByKind.GetEnumerator()) {
        $binding = @($ArtifactBindings | Where-Object { $_.kind -eq $entry.Key })
        $configured = [Environment]::GetEnvironmentVariable([string]$entry.Value, "Process")
        if ($binding.Count -ne 1 -or [string]::IsNullOrWhiteSpace($configured)) {
            throw "Certification load supervision requires the exact $($entry.Value) artifact binding."
        }
        $configuredPath = Resolve-ExternalPath -Path $configured -Name ([string]$entry.Value)
        $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
        if (-not [string]::Equals($configuredPath,[string]$binding[0].path,$comparison)) {
            throw "Certification $($entry.Value) differs from its role-tagged fixture artifact."
        }
    }
}

function Assert-CertificationFixtureVerificationContract {
    param($Verification)
    $counts = Get-RequiredProperty $Verification "counts"
    $liveAuth = Get-RequiredProperty $counts "liveAuth"
    $gates = Get-RequiredProperty $Verification "gates"
    if ([int]$counts.schools -ne 2 -or [int]$counts.teachers -ne 20 -or [int]$counts.students -ne 1010 -or
        [int]$counts.classes -ne 20 -or [int]$counts.classRosterStudents -ne 800 -or
        [int]$counts.devices -ne 1010 -or [int]$counts.activeDeviceSessions -ne 1010 -or
        [int]$counts.activeSessions -ne 20 -or [int]$counts.commandBodies -ne 20 -or
        [int]$liveAuth.commandAdministrators -ne 1 -or [int]$liveAuth.teachers -ne 20) {
        throw "Fixture live verification does not prove the exact owned two-school, 20-class, 1010-device certification inventory."
    }
    foreach ($gate in @(
        "autoEnrollDisabled","trackingDisabled","schedulesDisabled","exactSchoolTimezones",
        "classRostersExactAndDisjoint","allDeviceTokensLive","allStaffAuthArtifactsLive"
    )) {
        if ((Get-CertificationValue $gates $gate $false) -ne $true) {
            throw "Fixture live verification gate '$gate' is not proven."
        }
    }
}

function Get-CertificationContract {
    param($Config, [bool]$TestMode, [bool]$BindHarnessArtifacts = $false)
    $certification = Get-CertificationValue $Config "certification"
    if ($null -eq $certification) {
        if ($TestMode) { return $null }
        throw "Production supervision requires the certification chain contract."
    }
    if ([int](Get-CertificationValue $certification "schemaVersion" 0) -ne 1) {
        throw "certification.schemaVersion must be 1."
    }
    $chainId = [string](Get-RequiredProperty $certification "chainId")
    if ($chainId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "certification.chainId is invalid." }
    $appSha = Assert-CertificationGitSha ([string](Get-RequiredProperty $certification "deployedApplicationGitSha")) "deployedApplicationGitSha"
    $controllerSha = Assert-CertificationGitSha ([string](Get-RequiredProperty $certification "controllerGitSha")) "controllerGitSha"
    $actualControllerSha = if ($TestMode -and (Get-CertificationValue $certification "testActualControllerGitSha")) {
        Assert-CertificationGitSha ([string]$certification.testActualControllerGitSha) "testActualControllerGitSha"
    } else {
        $resolved = (& git -C $repositoryRoot rev-parse HEAD 2>$null | Select-Object -First 1).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0) { throw "Unable to resolve the controller Git SHA." }
        Assert-CertificationGitSha $resolved "actual controller Git SHA"
    }
    if ($actualControllerSha -ne $controllerSha) { throw "certification.controllerGitSha does not match the checked-out controller." }
    $imageDigest = [string](Get-RequiredProperty $certification "deployedImageDigest")
    if ($imageDigest -notmatch '^sha256:[0-9a-f]{64}$') { throw "deployedImageDigest must be an immutable sha256 digest." }

    $fixture = Get-RequiredProperty $certification "fixture"
    $state = Assert-CertificationEvidenceReference (Get-RequiredProperty $fixture "state") "fixture.state"
    $verification = Assert-CertificationEvidenceReference (Get-RequiredProperty $fixture "verification") "fixture.verification"
    $artifactReferences = @(Get-CertificationHarnessArtifactBindings `
        (Get-RequiredProperty $fixture "artifacts") "fixture.artifacts")
    Assert-CertificationHarnessArtifactContract $artifactReferences "fixture.artifacts"
    if ($BindHarnessArtifacts) {
        Assert-CertificationHarnessArtifactEnvironment $artifactReferences
    }
    try { $stateJson = Get-Content -LiteralPath $state.path -Raw | ConvertFrom-Json -Depth 30 }
    catch { throw "fixture.state must contain valid JSON." }
    try { $verificationJson = Get-Content -LiteralPath $verification.path -Raw | ConvertFrom-Json -Depth 30 }
    catch { throw "fixture.verification must contain valid JSON." }
    Assert-CertificationFixtureVerificationContract $verificationJson
    $expectedTimezone = [string](Get-RequiredProperty $fixture "expectedTimezone")
    if ($expectedTimezone -ne "America/New_York") { throw "Certification fixtures must use America/New_York." }
    foreach ($schoolKey in @("primary", "canary")) {
        $timezones = Get-CertificationValue (Get-CertificationValue $verificationJson "schoolTimezones") $schoolKey
        if ([string](Get-CertificationValue $timezones "schoolTimezone" "") -ne $expectedTimezone -or
            [string](Get-CertificationValue $timezones "schoolHoursTimezone" "") -ne $expectedTimezone) {
            throw "Live $schoolKey schoolTimezone and schoolHours.timezone must both equal America/New_York."
        }
    }
    $maximumAgeMinutes = [int](Get-CertificationValue $fixture "maximumVerificationAgeMinutes" 60)
    $fixtureObservedNowUtc = [DateTimeOffset]::UtcNow
    $verifiedAt = Assert-CertificationFixtureVerificationTimestamp `
        $verificationJson.verifiedAt $maximumAgeMinutes $fixtureObservedNowUtc "Fixture verification verifiedAt"
    $fixtureGeneration = Get-CertificationFixtureGenerationBinding `
        $stateJson $verificationJson $fixture $verifiedAt $maximumAgeMinutes $fixtureObservedNowUtc
    $stage = if ($null -eq (Get-CertificationValue $Config "workload")) { $null } else { [string]$Config.workload.stage }
    $plannedStart = $null
    if ([string]$Config.phase -eq "Waf" -and $stage -eq "800") {
        $plannedStart = ([DateTimeOffset](Get-RequiredProperty $fixture "plannedTrafficStartUtc")).ToUniversalTime()
        foreach ($requiredTime in @("01:30", "02:00")) {
            if (-not (Test-CertificationIntervalIncludesLocalTime $plannedStart ([int]$Config.workload.durationSeconds) $expectedTimezone $requiredTime)) {
                throw "The planned Waf/800 traffic interval does not include local $requiredTime."
            }
        }
    }

    $schemaCompatibility = Assert-CertificationEvidenceReference `
        (Get-RequiredProperty $certification "rollbackSchemaCompatibilityEvidence") "rollbackSchemaCompatibilityEvidence"
    try { $compatibilityJson = Get-Content -LiteralPath $schemaCompatibility.path -Raw | ConvertFrom-Json -Depth 20 }
    catch { throw "Rollback schema compatibility evidence must contain valid JSON." }
    $rollbackApiSha = Assert-CertificationGitSha ([string](Get-RequiredProperty $certification "rollbackApiGitSha")) "rollbackApiGitSha"
    $rollbackWorkerSha = Assert-CertificationGitSha ([string](Get-RequiredProperty $certification "rollbackWorkerGitSha")) "rollbackWorkerGitSha"
    $rollbackApiImageDigest = [string](Get-RequiredProperty $certification "rollbackApiImageDigest")
    $rollbackWorkerImageDigest = [string](Get-RequiredProperty $certification "rollbackWorkerImageDigest")
    foreach ($rollbackDigest in @($rollbackApiImageDigest,$rollbackWorkerImageDigest)) {
        if ($rollbackDigest -notmatch '^sha256:[0-9a-f]{64}$') { throw "Rollback image digests must be immutable sha256 digests." }
    }
    if (-not $TestMode -and ($rollbackApiSha -ne "3e1933534c4c49d5b056848e8c648c1a54571afa" -or
        $rollbackWorkerSha -ne "4377622408a96d3f1ffac6e8985b2554cefe502e")) {
        throw "Rollback Git identities must be the reviewed API and worker rollback-image SHAs."
    }
    if ([int]$compatibilityJson.schemaVersion -ne 1 -or [string]$compatibilityJson.type -ne "rollback_schema_compatibility" -or
        $compatibilityJson.compatible -ne $true -or $compatibilityJson.destructiveTableColumnConstraintChangesAbsent -ne $true -or
        [string]$compatibilityJson.deployedApplicationGitSha -ne $appSha -or
        [string]$compatibilityJson.rollbackApiGitSha -ne $rollbackApiSha -or
        [string]$compatibilityJson.rollbackWorkerGitSha -ne $rollbackWorkerSha) {
        throw "Rollback schema compatibility evidence does not prove the exact application and rollback identities."
    }

    $historical = @()
    foreach ($reference in @(Get-CertificationValue $certification "historicalEvidence" @())) {
        $kind = [string](Get-CertificationValue $reference "kind" "")
        if ((Get-CertificationValue $reference "diagnosticOnly" $false) -ne $true -or
            (Get-CertificationValue $reference "sanitized" $false) -ne $true -or
            $kind -notin @("endpoint-kind-status","rds-cpu-maximum","pi-top-sql") -or
            ($kind -eq "pi-top-sql" -and (Get-CertificationValue $reference "tokenized" $false) -ne $true)) {
            throw "Historical evidence must be an allowed sanitized diagnostic kind, with PI SQL tokenized."
        }
        $binding = Assert-CertificationEvidenceReference $reference "historicalEvidence"
        $historical += [ordered]@{path=$binding.path;sha256=$binding.sha256;kind=$kind;diagnosticOnly=$true;sanitized=$true;tokenized=if($kind -eq "pi-top-sql"){$true}else{$null}}
    }
    $predecessorPath = [string](Get-CertificationValue $Config "predecessorResultPath" "")
    if ($predecessorPath) {
        $prohibitedPaths = @([IO.Path]::GetFullPath($predecessorPath)); $prohibitedHashes = @()
        if (Test-Path -LiteralPath $predecessorPath -PathType Leaf) {
            $prohibitedHashes += Get-CertificationSha256 $predecessorPath
            try {
                $predecessorEnvelope = Get-Content -LiteralPath $predecessorPath -Raw | ConvertFrom-Json -Depth 60
                foreach ($name in @("chainRoot","stageAttestation","terminalMonitorResult")) {
                    $nested = Get-CertificationValue $predecessorEnvelope $name
                    if ($null -ne $nested) {
                        $nestedPath = [string](Get-CertificationValue $nested "path" "")
                        $nestedHash = [string](Get-CertificationValue $nested "sha256" "")
                        if ($nestedPath) { $prohibitedPaths += [IO.Path]::GetFullPath($nestedPath) }
                        if ($nestedHash) { $prohibitedHashes += $nestedHash.ToLowerInvariant() }
                    }
                }
            } catch { }
        }
        if (@($historical | Where-Object {
            $historicalPath = $_.path; $historicalHash = $_.sha256
            @($prohibitedPaths | Where-Object { [string]::Equals($_,$historicalPath,[StringComparison]::OrdinalIgnoreCase) }).Count -gt 0 -or
            $historicalHash -in $prohibitedHashes
        }).Count -gt 0) { throw "Historical diagnostic evidence cannot seed or appear inside the accepted certification chain." }
    }

    $activeApiArn = [string](Get-RequiredProperty $certification "activeApiTaskDefinitionArn")
    $activeWorkerArn = [string](Get-RequiredProperty $certification "activeWorkerTaskDefinitionArn")
    if ([string](Get-CertificationValue $Config.resources "expectedActiveApiTaskDefinitionArn" "") -ne $activeApiArn) {
        throw "resources.expectedActiveApiTaskDefinitionArn must bind the certification active API ARN."
    }
    if ([string](Get-CertificationValue $Config.resources "expectedActiveWorkerTaskDefinitionArn" "") -ne $activeWorkerArn) {
        throw "resources.expectedActiveWorkerTaskDefinitionArn must bind the certification active worker ARN."
    }
    $rollbackApiArn = [string](Get-RequiredProperty $certification "rollbackApiTaskDefinitionArn")
    $rollbackWorkerArn = [string](Get-RequiredProperty $certification "rollbackWorkerTaskDefinitionArn")
    foreach ($arn in @($activeApiArn, $activeWorkerArn, $rollbackApiArn, $rollbackWorkerArn)) {
        if ($arn -notmatch '^arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition/[A-Za-z0-9_-]+:\d+$') {
            throw "Certification task identities must be full revisioned ECS task-definition ARNs."
        }
    }
    Assert-CertificationProductionRollbackTaskIdentities $rollbackApiArn $rollbackWorkerArn $TestMode
    $expectedRdsClass = [string](Get-RequiredProperty $Config.resources "expectedRdsInstanceClass")
    $capacityTrack = if ($expectedRdsClass -eq "db.t4g.xlarge") { "rds-resized" } elseif ($expectedRdsClass -eq "db.t4g.medium") { "baseline" } else { throw "Unsupported expected RDS class." }
    $budgetAcknowledgement = $null
    if ($capacityTrack -eq "rds-resized") {
        $budgetAcknowledgement = Assert-CertificationEvidenceReference `
            (Get-RequiredProperty $certification "budgetAcknowledgement") "certification.budgetAcknowledgement"
        try { $budgetJson = Get-Content -LiteralPath $budgetAcknowledgement.path -Raw | ConvertFrom-Json -Depth 30 }
        catch { throw "Certification budget acknowledgement must contain valid JSON." }
        $budgetAcknowledgedAt = Assert-CertificationFreshTimestamp `
            ([string]$budgetJson.acknowledgedAtUtc) "Budget acknowledgement acknowledgedAtUtc"
        if ([int]$budgetJson.schemaVersion -ne 1 -or [string]$budgetJson.type -ne "rds_resize_budget_acknowledgement" -or $budgetJson.approved -ne $true -or
            [string]$budgetJson.targetRdsInstanceClass -ne "db.t4g.xlarge" -or
            [double]$budgetJson.monthlyBudgetUsd -ne 350.0 -or $budgetJson.temporaryBudgetBreachAcknowledged -ne $true -or
            [string]::IsNullOrWhiteSpace([string]$budgetJson.approver) -or
            [string]$budgetJson.resizePlanSha256 -ne [string](Get-RequiredProperty $certification "rdsResizePlanSha256") -or
            [string]$budgetJson.accountId -ne '135775632425' -or [string]$budgetJson.region -ne 'us-east-1' -or
            [string]$budgetJson.currency -ne "USD" -or $budgetJson.pendingOsUpdateHandledSeparately -ne $true -or
            $budgetJson.orderabilityVerified -ne $true -or $budgetJson.pointInTimeRecoveryVerified -ne $true -or
            $budgetJson.manualSnapshotEncrypted -ne $true -or
            [string]$budgetJson.manualSnapshotArn -notmatch '^arn:aws:rds:us-east-1:135775632425:snapshot:[A-Za-z0-9][A-Za-z0-9-]{0,254}$') {
            throw "The resized capacity track requires explicit approved $350 budget acknowledgement."
        }
        [void](Assert-CertificationSha256 ([string]$budgetJson.resizePlanSha256) "budgetAcknowledgement.resizePlanSha256")
        $priceBinding = Assert-CertificationEvidenceReference $budgetJson.awsPriceEvidence "budgetAcknowledgement.awsPriceEvidence"
        $projectionBinding = Assert-CertificationEvidenceReference $budgetJson.costExplorerProjectionEvidence "budgetAcknowledgement.costExplorerProjectionEvidence"
        $snapshotBinding = Assert-CertificationEvidenceReference $budgetJson.manualSnapshotEvidence "budgetAcknowledgement.manualSnapshotEvidence"
        try { $priceJson=Get-Content -LiteralPath $priceBinding.path -Raw|ConvertFrom-Json -Depth 30 } catch { throw "AWS price evidence must be valid JSON." }
        try { $projectionJson=Get-Content -LiteralPath $projectionBinding.path -Raw|ConvertFrom-Json -Depth 30 } catch { throw "Cost Explorer projection evidence must be valid JSON." }
        try { $snapshotJson=Get-Content -LiteralPath $snapshotBinding.path -Raw|ConvertFrom-Json -Depth 30 } catch { throw "Manual RDS snapshot evidence must be valid JSON." }
        [void](Assert-CertificationFreshTimestamp $priceJson.observedAtUtc "AWS price evidence observedAtUtc")
        [void](Assert-CertificationFreshTimestamp $projectionJson.generatedAtUtc "Cost Explorer projection generatedAtUtc")
        $snapshotObservedAt=Assert-CertificationFreshTimestamp $snapshotJson.observedAtUtc "Manual RDS snapshot evidence observedAtUtc"
        $snapshotCreatedAt=Assert-CertificationFreshTimestamp $snapshotJson.snapshotCreateTimeUtc "Manual RDS snapshot evidence snapshotCreateTimeUtc"
        if ([int]$priceJson.schemaVersion -ne 1 -or [string]$priceJson.type -ne "aws_rds_price_evidence" -or
            [string]$priceJson.accountId -ne [string]$budgetJson.accountId -or [string]$priceJson.region -ne [string]$budgetJson.region -or
            [string]$priceJson.currency -ne "USD" -or [string]$priceJson.targetRdsInstanceClass -ne "db.t4g.xlarge" -or
            [double]$priceJson.hourlyOnDemandUsd -le 0 -or [double]$priceJson.estimatedMonthlyUsd -le 0 -or
            [string]$priceJson.sourceUrl -notmatch '^https://aws\.amazon\.com/(?:rds|pricing)/') { throw "AWS price evidence is not exact typed fresh evidence." }
        if ([int]$projectionJson.schemaVersion -ne 1 -or [string]$projectionJson.type -ne "rds_cost_explorer_projection" -or
            [string]$projectionJson.accountId -ne [string]$budgetJson.accountId -or [string]$projectionJson.region -ne [string]$budgetJson.region -or
            [string]$projectionJson.currency -ne "USD" -or [string]$projectionJson.targetRdsInstanceClass -ne "db.t4g.xlarge" -or
            [double]$projectionJson.monthlyEstimateUsd -le 0 -or [double]$projectionJson.monthlyBudgetUsd -ne 350.0) { throw "Cost Explorer projection is not exact typed fresh evidence." }
        if ([int]$snapshotJson.schemaVersion -ne 1 -or [string]$snapshotJson.type -ne "rds_manual_snapshot_evidence" -or
            [string]$snapshotJson.accountId -ne '135775632425' -or [string]$snapshotJson.region -ne 'us-east-1' -or
            [string]$snapshotJson.snapshotArn -ne [string]$budgetJson.manualSnapshotArn -or
            [string]$snapshotJson.sourceDbInstanceIdentifier -ne 'schoolpilot-production-db' -or
            [string]$snapshotJson.sourceDbInstanceClass -ne 'db.t4g.medium' -or
            [string]$snapshotJson.engine -ne 'postgres' -or [string]$snapshotJson.status -ne 'available' -or
            $snapshotJson.encrypted -ne $true -or [string]::IsNullOrWhiteSpace([string]$snapshotJson.kmsKeyId) -or
            $snapshotCreatedAt -gt $snapshotObservedAt) { throw "Manual RDS snapshot evidence is not exact typed fresh evidence." }
        $budgetAcknowledgement = [ordered]@{path=$budgetAcknowledgement.path;sha256=$budgetAcknowledgement.sha256;resizePlanSha256=[string]$budgetJson.resizePlanSha256;acknowledgedAtUtc=$budgetAcknowledgedAt.ToString("o");awsPriceEvidence=$priceBinding;costExplorerProjectionEvidence=$projectionBinding;manualSnapshotEvidence=$snapshotBinding}
    }
    return [pscustomobject]@{
        Raw = $certification; ChainId = $chainId; ApplicationGitSha = $appSha; ControllerGitSha = $controllerSha
        DeployedImageDigest = $imageDigest; ActiveApiArn = $activeApiArn; ActiveWorkerArn = $activeWorkerArn
        RollbackApiArn = $rollbackApiArn; RollbackWorkerArn = $rollbackWorkerArn
        RollbackApiGitSha = $rollbackApiSha; RollbackWorkerGitSha = $rollbackWorkerSha
        RollbackApiImageDigest = $rollbackApiImageDigest
        RollbackWorkerImageDigest = $rollbackWorkerImageDigest
        Fixture = [ordered]@{ state=$state;verification=$verification;artifacts=$artifactReferences;fixtureId=$fixtureGeneration.fixtureId;generatedAtUtc=$fixtureGeneration.generatedAtUtc;refreshedAtUtc=$fixtureGeneration.refreshedAtUtc;verifiedAtUtc=$verifiedAt.ToString("o");timezone=$expectedTimezone;plannedTrafficStartUtc=if($null -eq $plannedStart){$null}else{$plannedStart.ToString("o")} }
        SchemaCompatibility = $schemaCompatibility; HistoricalEvidence = $historical; CapacityTrack = $capacityTrack
        BudgetAcknowledgement = $budgetAcknowledgement
        ControllerHashes = Get-CertificationControllerHashes
    }
}

function Invoke-CertificationAwsJson {
    param([string[]]$Arguments)
    $raw = & aws @Arguments --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Certification AWS preflight failed for $($Arguments[0]) $($Arguments[1])." }
    return (($raw | Out-String).Trim() | ConvertFrom-Json -Depth 60)
}

function Get-CertificationExpectedRdsPosture {
    param($Config)
    $expectedClass = [string]$Config.resources.expectedRdsInstanceClass
    $raw = Get-CertificationValue $Config.resources "expectedRdsPosture"
    if ($null -eq $raw) {
        if ($expectedClass -eq "db.t4g.xlarge") {
            throw "The resized certification track requires resources.expectedRdsPosture."
        }
        return $null
    }
    $securityGroups = @((Get-RequiredProperty $raw "vpcSecurityGroupIds") | ForEach-Object {[string]$_} | Sort-Object -Unique)
    $posture = [ordered]@{
        engine=[string](Get-RequiredProperty $raw "engine")
        engineVersion=[string](Get-RequiredProperty $raw "engineVersion")
        allocatedStorageGiB=[int](Get-RequiredProperty $raw "allocatedStorageGiB")
        maxAllocatedStorageGiB=[int](Get-RequiredProperty $raw "maxAllocatedStorageGiB")
        storageType=[string](Get-RequiredProperty $raw "storageType")
        storageEncrypted=(Get-RequiredProperty $raw "storageEncrypted")
        multiAz=(Get-RequiredProperty $raw "multiAz")
        publiclyAccessible=(Get-RequiredProperty $raw "publiclyAccessible")
        performanceInsightsEnabled=(Get-RequiredProperty $raw "performanceInsightsEnabled")
        dbSubnetGroupName=[string](Get-RequiredProperty $raw "dbSubnetGroupName")
        vpcSecurityGroupIds=$securityGroups
    }
    if ($posture.engine -ne "postgres" -or [string]::IsNullOrWhiteSpace($posture.engineVersion) -or
        $posture.allocatedStorageGiB -lt 1 -or $posture.maxAllocatedStorageGiB -lt $posture.allocatedStorageGiB -or
        [string]::IsNullOrWhiteSpace($posture.storageType) -or $posture.storageEncrypted -isnot [bool] -or
        $posture.multiAz -isnot [bool] -or $posture.publiclyAccessible -ne $false -or
        $posture.performanceInsightsEnabled -ne $true -or [string]::IsNullOrWhiteSpace($posture.dbSubnetGroupName) -or
        $securityGroups.Count -lt 1 -or @($securityGroups|Where-Object{$_ -notmatch '^sg-[0-9a-f]+$'}).Count -gt 0) {
        throw "resources.expectedRdsPosture must define the exact encrypted private PostgreSQL storage, networking, and PI posture."
    }
    return $posture
}

function Get-CertificationTaskPreflight {
    param($Config, $Contract)
    if ($null -eq $Contract) { return $null }
    $region = [string]$Config.resources.region
    $services = Invoke-CertificationAwsJson @("ecs","describe-services","--region",$region,"--cluster",([string]$Config.resources.cluster),"--services",([string]$Config.resources.apiService),([string]$Config.resources.workerService))
    $byName = @{}; foreach ($service in @($services.services)) { $byName[[string]$service.serviceName] = $service }
    if ([string]$byName[[string]$Config.resources.apiService].taskDefinition -ne $Contract.ActiveApiArn -or
        [string]$byName[[string]$Config.resources.workerService].taskDefinition -ne $Contract.ActiveWorkerArn) {
        throw "Active ECS services do not match the deployed application task-definition attestations."
    }
    $definitions = [ordered]@{}
    foreach ($entry in @(
        @("activeApi",$Contract.ActiveApiArn,"api",$Contract.DeployedImageDigest,512,2048,$Contract.ApplicationGitSha),
        @("activeWorker",$Contract.ActiveWorkerArn,"scheduler-worker",$Contract.DeployedImageDigest,256,512,$Contract.ApplicationGitSha),
        @("rollbackApi",$Contract.RollbackApiArn,"api",$Contract.RollbackApiImageDigest,512,2048,$Contract.RollbackApiGitSha),
        @("rollbackWorker",$Contract.RollbackWorkerArn,"scheduler-worker",$Contract.RollbackWorkerImageDigest,256,512,$Contract.RollbackWorkerGitSha)
    )) {
        $response = Invoke-CertificationAwsJson @("ecs","describe-task-definition","--region",$region,"--task-definition",$entry[1])
        $task = $response.taskDefinition
        $containers = @($task.containerDefinitions | Where-Object name -eq $entry[2])
        $mutableContainers = @($task.containerDefinitions | Where-Object { [string]$_.image -notmatch '@sha256:[0-9a-f]{64}$' })
        if ([string]$task.status -ne "ACTIVE" -or [string]$task.taskDefinitionArn -ne $entry[1] -or $containers.Count -ne 1 -or
            $mutableContainers.Count -gt 0 -or
            [string]$containers[0].image -notmatch '@sha256:[0-9a-f]{64}$' -or
            ([string]$containers[0].image -split '@')[-1] -ne $entry[3] -or [int]$task.cpu -ne [int]$entry[4] -or [int]$task.memory -ne [int]$entry[5]) {
            throw "Task definition '$($entry[0])' is not ACTIVE, exact, sized, and digest-pinned as attested."
        }
        $manifestImage = [string]$containers[0].image
        $repositoryUri = ($manifestImage -split '@')[0]
        $repositoryName = ($repositoryUri -split '/',2)[1]
        $manifest = Invoke-CertificationAwsJson @("ecr","batch-get-image","--region",$region,"--repository-name",$repositoryName,"--image-ids","imageDigest=$($entry[3])")
        $images = @(Get-CertificationValue $manifest "images" @())
        $manifestFailures = @(Get-CertificationValue $manifest "failures" @())
        $wrongDigestImages = @($images | Where-Object { [string]$_.imageId.imageDigest -cne [string]$entry[3] })
        $resolvedManifests = @($images | ForEach-Object { [string]$_.imageManifest })
        $resolvedMediaTypes = @($images | ForEach-Object { [string]$_.imageManifestMediaType })
        $manifestHashes = @($resolvedManifests | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            ForEach-Object { Get-CertificationTextSha256 $_ } | Sort-Object -Unique)
        $mediaTypeHashes = @($resolvedMediaTypes | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            ForEach-Object { Get-CertificationTextSha256 $_ } | Sort-Object -Unique)
        # ECR may return one row per tag even when queried by an immutable
        # digest. Accept that representation only when every row is the exact
        # same digest, manifest media type, and manifest bytes. Any failure,
        # mismatch, blank field, or conflicting duplicate remains fail-closed.
        if ($manifestFailures.Count -gt 0 -or $images.Count -lt 1 -or $wrongDigestImages.Count -gt 0 -or
            $resolvedManifests.Count -ne $images.Count -or $resolvedMediaTypes.Count -ne $images.Count -or
            @($resolvedManifests | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or
            @($resolvedMediaTypes | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or
            $manifestHashes.Count -ne 1 -or $mediaTypeHashes.Count -ne 1) {
            throw "Task definition '$($entry[0])' digest is not resolvable as one immutable ECR manifest."
        }
        $canonicalManifest = $resolvedManifests[0]
        $provenanceTag = ([string]$entry[6]).Substring(0,12)
        $tagLookup = Invoke-CertificationAwsJson @(
            "ecr","describe-images","--region",$region,"--repository-name",$repositoryName,
            "--image-ids","imageTag=$provenanceTag"
        )
        $taggedImages = @($tagLookup.imageDetails)
        if ($taggedImages.Count -ne 1 -or [string]$taggedImages[0].imageDigest -ne [string]$entry[3]) {
            throw "Task definition '$($entry[0])' Git provenance tag '$provenanceTag' does not resolve to its attested digest."
        }
        $definitions[$entry[0]] = [ordered]@{
            taskDefinitionArn=[string]$task.taskDefinitionArn;taskDefinitionJsonSha256=Get-CertificationTextSha256 ($task|ConvertTo-Json -Compress -Depth 60)
            image=$manifestImage;imageDigest=$entry[3];imageManifestSha256=Get-CertificationTextSha256 $canonicalManifest
            gitSha=[string]$entry[6];provenanceTag=$provenanceTag
            cpu=[int]$task.cpu;memory=[int]$task.memory;containerName=$entry[2]
        }
    }
    $alarmNames = @((Get-CertificationValue $Contract.Raw "alarmNames" @()) | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $alarmResponse = Invoke-CertificationAwsJson (@("cloudwatch","describe-alarms","--region",$region,"--alarm-names") + $alarmNames)
    $alarms = @($alarmResponse.MetricAlarms | Where-Object { [string]$_.AlarmName -in $alarmNames } | ForEach-Object {
        [ordered]@{name=[string]$_.AlarmName;state=[string]$_.StateValue;actionsEnabled=[bool]$_.ActionsEnabled}
    } | Sort-Object name)
    if ($alarms.Count -ne $alarmNames.Count -or @($alarms | Where-Object { $_.state -ne "OK" -or -not $_.actionsEnabled }).Count -gt 0) {
        throw "Certification preflight requires every named alarm to be present, enabled, and OK."
    }
    $scheduleNames = @((Get-CertificationValue $Contract.Raw "scheduleNames" @()) | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $resourceId = "service/$([string]$Config.resources.cluster)/$([string]$Config.resources.apiService)"
    $scheduleResponse = Invoke-CertificationAwsJson @("application-autoscaling","describe-scheduled-actions","--region",$region,"--service-namespace","ecs","--resource-id",$resourceId)
    $schedules = @($scheduleResponse.ScheduledActions | Where-Object { [string]$_.ScheduledActionName -in $scheduleNames } | ForEach-Object {
        [ordered]@{name=[string]$_.ScheduledActionName;schedule=[string]$_.Schedule;timezone=[string]$_.Timezone;minCapacity=Get-CertificationValue $_.ScalableTargetAction "MinCapacity";maxCapacity=Get-CertificationValue $_.ScalableTargetAction "MaxCapacity"}
    } | Sort-Object name)
    if ($schedules.Count -ne $scheduleNames.Count -or @($schedules | Where-Object timezone -ne "America/New_York").Count -gt 0) {
        throw "Certification preflight requires every named scaling schedule in America/New_York."
    }
    $workloadStage = if ($null -eq (Get-CertificationValue $Config "workload")) { "" } else { [string]$Config.workload.stage }
    $isNightWafGate = [string]$Config.phase -eq "Waf" -and $workloadStage -in @("500","800")
    $nightScalableTarget = $null
    if ($isNightWafGate) {
        $scalableResponse = Invoke-CertificationAwsJson @(
            "application-autoscaling","describe-scalable-targets","--region",$region,
            "--service-namespace","ecs","--resource-ids",$resourceId,
            "--scalable-dimension","ecs:service:DesiredCount"
        )
        $scalableTargets = @($scalableResponse.ScalableTargets | Where-Object {
            [string]$_.ResourceId -eq $resourceId -and [string]$_.ScalableDimension -eq "ecs:service:DesiredCount"
        })
        if ($scalableTargets.Count -ne 1 -or [int]$scalableTargets[0].MinCapacity -ne 6 -or
            [int]$scalableTargets[0].MaxCapacity -ne 8) {
            throw "Night Waf/500 and Waf/800 require the exact API scalable target min=6/max=8."
        }
        $nightScalableTarget = [ordered]@{resourceId=$resourceId;minCapacity=6;maxCapacity=8}
    }

    # Every stage, including MonitorOnly and dynamic endurance, must begin from
    # one completed exact deployment with no mixed tasks and an exact all-healthy
    # target set. Only the desired count itself is dynamic outside night Waf.
    $apiService = $byName[[string]$Config.resources.apiService]
    $workerService = $byName[[string]$Config.resources.workerService]
    $serviceBindings = @(
        @("api",[string]$Config.resources.apiService,$Contract.ActiveApiArn,$apiService),
        @("worker",[string]$Config.resources.workerService,$Contract.ActiveWorkerArn,$workerService)
    )
    $taskPosture = [ordered]@{}
    $apiTaskPrivateIps = @()
    foreach ($serviceBinding in $serviceBindings) {
        $serviceState = $serviceBinding[3]
        $desired = [int]$serviceState.desiredCount
        $deployments = @($serviceState.deployments)
        if ($desired -lt 1 -or [int]$serviceState.runningCount -ne $desired -or [int]$serviceState.pendingCount -ne 0 -or
            $deployments.Count -ne 1 -or [string]$deployments[0].taskDefinition -ne [string]$serviceBinding[2] -or
            [string]$deployments[0].rolloutState -ne "COMPLETED") {
            throw "Certification requires one completed exact $($serviceBinding[0]) deployment at desired=running, pending=0."
        }
        if ($isNightWafGate -and (($serviceBinding[0] -eq "api" -and $desired -ne 6) -or
            ($serviceBinding[0] -eq "worker" -and $desired -ne 1))) {
            throw "Night Waf certification requires stable API 6/6/0 and worker 1/1/0 capacity."
        }
        $listed = Invoke-CertificationAwsJson @(
            "ecs","list-tasks","--region",$region,"--cluster",([string]$Config.resources.cluster),
            "--service-name",$serviceBinding[1],"--desired-status","RUNNING"
        )
        $taskArns = @($listed.taskArns)
        if ($taskArns.Count -ne $desired) { throw "Certification found a running-task count mismatch for $($serviceBinding[0])." }
        $described = Invoke-CertificationAwsJson ((@(
            "ecs","describe-tasks","--region",$region,"--cluster",([string]$Config.resources.cluster),"--tasks"
        ) + $taskArns))
        $tasks = @($described.tasks)
        if ($tasks.Count -ne $desired -or @($tasks | Where-Object {
            [string]$_.lastStatus -ne "RUNNING" -or [string]$_.taskDefinitionArn -ne [string]$serviceBinding[2]
        }).Count -gt 0) { throw "Certification found a mixed or non-running $($serviceBinding[0]) task revision." }
        if ($serviceBinding[0] -eq "api") {
            foreach ($task in $tasks) {
                $privateIps = @($task.attachments | Where-Object type -eq "ElasticNetworkInterface" | ForEach-Object {
                    @($_.details | Where-Object name -eq "privateIPv4Address" | ForEach-Object { [string]$_.value })
                } | Where-Object { $_ })
                if ($privateIps.Count -ne 1) { throw "Certification could not bind an API task to exactly one private IPv4 target identity." }
                $apiTaskPrivateIps += $privateIps[0]
            }
        }
        $taskPosture[$serviceBinding[0]] = @($tasks | ForEach-Object {
            [ordered]@{taskArn=[string]$_.taskArn;taskDefinitionArn=[string]$_.taskDefinitionArn;lastStatus=[string]$_.lastStatus}
        } | Sort-Object taskArn)
    }
    $targetResponse = Invoke-CertificationAwsJson @(
        "elbv2","describe-target-health","--region",$region,"--target-group-arn",([string]$Config.resources.targetGroupArn)
    )
    $targetGroupResponse = Invoke-CertificationAwsJson @(
        "elbv2","describe-target-groups","--region",$region,"--target-group-arns",([string]$Config.resources.targetGroupArn)
    )
    $targetGroups = @($targetGroupResponse.TargetGroups)
    if ($targetGroups.Count -ne 1 -or [int]$targetGroups[0].Port -lt 1) { throw "Certification could not resolve the exact API target-group port." }
    $targetPort = [int]$targetGroups[0].Port
    $targets = @($targetResponse.TargetHealthDescriptions)
    if ($targets.Count -ne [int]$apiService.desiredCount -or
        @($targets | Where-Object { [string]$_.TargetHealth.State -ne "healthy" -or [int]$_.Target.Port -ne $targetPort }).Count -gt 0 -or
        @(Compare-Object @($apiTaskPrivateIps|Sort-Object) @($targets|ForEach-Object{[string]$_.Target.Id}|Sort-Object)).Count -ne 0) {
        throw "Certification requires every and only the desired API targets to be healthy."
    }
    $loadStabilityPosture = [ordered]@{
        scalableTarget=$nightScalableTarget
        api=[ordered]@{desired=[int]$apiService.desiredCount;running=[int]$apiService.runningCount;pending=[int]$apiService.pendingCount;taskDefinitionArn=$Contract.ActiveApiArn}
        worker=[ordered]@{desired=[int]$workerService.desiredCount;running=[int]$workerService.runningCount;pending=[int]$workerService.pendingCount;taskDefinitionArn=$Contract.ActiveWorkerArn}
        healthyTargetCount=$targets.Count;targetPort=$targetPort;apiTaskPrivateIpv4=@($apiTaskPrivateIps|Sort-Object);tasks=$taskPosture
    }
    $expectedRdsPosture = Get-CertificationExpectedRdsPosture $Config
    $rdsResponse = Invoke-CertificationAwsJson @("rds","describe-db-instances","--region",$region,"--db-instance-identifier",([string]$Config.resources.rdsInstanceId))
    $db = @($rdsResponse.DBInstances)[0]
    if ([string]$db.DBInstanceStatus -ne "available" -or [string]$db.DBInstanceClass -ne [string]$Config.resources.expectedRdsInstanceClass -or
        $db.PubliclyAccessible -ne $false -or @($db.PendingModifiedValues.PSObject.Properties).Count -gt 0) {
        throw "Certification preflight rejected the exact RDS class, availability, private posture, or pending modifications."
    }
    $observedRdsPosture = [ordered]@{
        engine=[string]$db.Engine;engineVersion=[string]$db.EngineVersion
        allocatedStorageGiB=[int]$db.AllocatedStorage;maxAllocatedStorageGiB=[int]$db.MaxAllocatedStorage
        storageType=[string]$db.StorageType;storageEncrypted=[bool]$db.StorageEncrypted;multiAz=[bool]$db.MultiAZ
        publiclyAccessible=[bool]$db.PubliclyAccessible;performanceInsightsEnabled=[bool]$db.PerformanceInsightsEnabled
        dbSubnetGroupName=[string]$db.DBSubnetGroup.DBSubnetGroupName
        vpcSecurityGroupIds=@($db.VpcSecurityGroups|ForEach-Object{[string]$_.VpcSecurityGroupId}|Sort-Object -Unique)
    }
    if ($null -ne $expectedRdsPosture -and
        (ConvertTo-CertificationComparableJson $observedRdsPosture) -cne (ConvertTo-CertificationComparableJson $expectedRdsPosture)) {
        throw "Certification preflight rejected the exact RDS engine/version/storage/networking/PI posture."
    }
    $redisResponse = Invoke-CertificationAwsJson @("elasticache","describe-replication-groups","--region",$region,"--replication-group-id",([string]$Config.resources.redisReplicationGroupId))
    $redis = @($redisResponse.ReplicationGroups)[0]
    if ([string]$redis.Status -ne "available" -or [string]$redis.CacheNodeType -ne [string]$Config.resources.expectedRedisNodeType -or
        @($redis.PendingModifiedValues.PSObject.Properties).Count -gt 0) {
        throw "Certification preflight rejected the Redis node type, availability, or pending modifications."
    }
    $servicePosture = @($services.services | ForEach-Object {
        [ordered]@{name=[string]$_.serviceName;taskDefinitionArn=[string]$_.taskDefinition;desired=[int]$_.desiredCount;running=[int]$_.runningCount;pending=[int]$_.pendingCount;subnets=@($_.networkConfiguration.awsvpcConfiguration.subnets|Sort-Object);assignPublicIp=[string]$_.networkConfiguration.awsvpcConfiguration.assignPublicIp}
    } | Sort-Object name)
    return [ordered]@{
        observedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");taskDefinitions=$definitions
        posture=[ordered]@{
            services=$servicePosture
            rds=[ordered]@{arn=[string]$db.DBInstanceArn;class=[string]$db.DBInstanceClass;exactPosture=$observedRdsPosture;expectedExactPosture=$expectedRdsPosture}
            redis=[ordered]@{arn=[string]$redis.ARN;nodeType=[string]$redis.CacheNodeType;status=[string]$redis.Status}
            alarms=$alarms;schedules=$schedules;loadStability=$loadStabilityPosture
        }
    }
}

function Get-CertificationConfigHash {
    return $script:OperatorConfigSha256
}

function Assert-CertificationOperatorConfigUnchanged {
    if ((Get-CertificationSha256 $resolvedConfigPath) -ne $script:OperatorConfigSha256) {
        throw "Operator config changed after certification validation; traffic remains blocked."
    }
}

function Assert-CertificationRollbackConfigBinding {
    param($Config, $Contract)
    if ($null -eq $Contract) { return }
    $rollbackPath = Resolve-ExternalPath -Path ([string](Get-RequiredProperty $Config "rollbackConfigPath")) -Name "rollbackConfigPath"
    try { $rollback = Get-Content -LiteralPath $rollbackPath -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "Certification rollbackConfigPath must contain valid JSON." }
    if ([string](Get-CertificationValue $rollback "previousApiTaskDefinition" "") -ne $Contract.RollbackApiArn -or
        [string](Get-CertificationValue $rollback "previousWorkerTaskDefinition" "") -ne $Contract.RollbackWorkerArn) {
        throw "Executable rollback config is not bound to the exact certification API and worker rollback ARNs."
    }
    return [ordered]@{path=$rollbackPath;sha256=Get-CertificationSha256 $rollbackPath;apiTaskDefinitionArn=$Contract.RollbackApiArn;workerTaskDefinitionArn=$Contract.RollbackWorkerArn}
}

function Copy-CertificationFileIfHashMatches {
    param([string]$Source, [string]$Destination, [string]$ExpectedSha256)
    if (Test-Path -LiteralPath $Destination) { throw "Immutable bound rollback config already exists." }
    $bytes = [IO.File]::ReadAllBytes($Source)
    $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    if ($actual -ne $ExpectedSha256) { throw "Rollback config changed after validation; traffic remains blocked." }
    $temporary = "$Destination.$([Guid]::NewGuid().ToString('N')).tmp"
    try { [IO.File]::WriteAllBytes($temporary,$bytes);[IO.File]::Move($temporary,$Destination) }
    finally { if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force} }
    if ((Get-CertificationSha256 $Destination) -ne $ExpectedSha256) { throw "Bound rollback config copy failed digest verification." }
    return [ordered]@{path=$Destination;sha256=$ExpectedSha256}
}

function Assert-CertificationReceiptLifetime {
    param($Receipt, [DateTimeOffset]$ReferenceTime, [switch]$RequireUnexpired)
    try {
        $issuedAt=ConvertTo-CertificationUtcTimestamp (Get-CertificationValue $Receipt "issuedAtUtc" "") "Validation receipt issuedAtUtc"
        $expiresAt=ConvertTo-CertificationUtcTimestamp (Get-CertificationValue $Receipt "expiresAtUtc" "") "Validation receipt expiresAtUtc"
    }
    catch { throw "Validation receipt issuance and expiry must be ISO-8601 timestamps." }
    $reference=$ReferenceTime.ToUniversalTime()
    if ($issuedAt -gt [DateTimeOffset]::UtcNow -or $issuedAt -gt $reference) {
        throw "Validation receipt issuedAtUtc cannot be in the future."
    }
    if (($expiresAt - $issuedAt).Ticks -ne [TimeSpan]::FromMinutes(30).Ticks) {
        throw "Validation receipt expiry must be exactly 30 minutes after issuance."
    }
    if ($reference -gt $expiresAt -or ($RequireUnexpired -and $expiresAt -le [DateTimeOffset]::UtcNow)) {
        throw "Validation receipt expired before it was consumed or attested."
    }
    return [ordered]@{issuedAtUtc=$issuedAt;expiresAtUtc=$expiresAt}
}

function Assert-CertificationTaskDefinitionAttestations {
    param($TaskDefinitions, $Contract, [string]$Name)
    $expected = @(
        @("activeApi",$Contract.ActiveApiArn,$Contract.DeployedImageDigest,$Contract.ApplicationGitSha,"api",512,2048),
        @("activeWorker",$Contract.ActiveWorkerArn,$Contract.DeployedImageDigest,$Contract.ApplicationGitSha,"scheduler-worker",256,512),
        @("rollbackApi",$Contract.RollbackApiArn,$Contract.RollbackApiImageDigest,$Contract.RollbackApiGitSha,"api",512,2048),
        @("rollbackWorker",$Contract.RollbackWorkerArn,$Contract.RollbackWorkerImageDigest,$Contract.RollbackWorkerGitSha,"scheduler-worker",256,512)
    )
    foreach ($entry in $expected) {
        $task = Get-CertificationValue $TaskDefinitions ([string]$entry[0])
        if ($null -eq $task -or [string]$task.taskDefinitionArn -ne [string]$entry[1] -or
            [string]$task.imageDigest -ne [string]$entry[2] -or [string]$task.gitSha -ne [string]$entry[3] -or
            [string]$task.provenanceTag -ne ([string]$entry[3]).Substring(0,12) -or
            [string]$task.containerName -ne [string]$entry[4] -or [int]$task.cpu -ne [int]$entry[5] -or [int]$task.memory -ne [int]$entry[6] -or
            [string]$task.image -notmatch ('@' + [regex]::Escape([string]$entry[2]) + '$')) {
            throw "$Name does not bind the exact ACTIVE/revisioned/digest-pinned '$($entry[0])' task identity."
        }
        [void](Assert-CertificationSha256 ([string]$task.taskDefinitionJsonSha256) "$Name.$($entry[0]).taskDefinitionJsonSha256")
        [void](Assert-CertificationSha256 ([string]$task.imageManifestSha256) "$Name.$($entry[0]).imageManifestSha256")
    }
}

function Assert-CertificationPreflightContract {
    param($Preflight, $Contract, [DateTimeOffset]$IssuedAt, [string]$Name)
    try { $observedAt=ConvertTo-CertificationUtcTimestamp (Get-CertificationValue $Preflight "observedAtUtc" "") "$Name.observedAtUtc" }
    catch { throw "$Name.observedAtUtc must be an ISO-8601 timestamp." }
    if ($observedAt -gt $IssuedAt -or $observedAt -lt $IssuedAt.AddHours(-24)) {
        throw "$Name must be observed before receipt issuance and no more than 24 hours earlier."
    }
    $tasks = Get-CertificationValue $Preflight "taskDefinitions"
    if($null -eq $tasks){throw "$Name.taskDefinitions is required."}
    Assert-CertificationTaskDefinitionAttestations $tasks $Contract "$Name.taskDefinitions"
    $posture = Get-CertificationValue $Preflight "posture"
    if($null -eq $posture){throw "$Name.posture is required."}
    $services = @(Get-CertificationValue $posture "services" @())
    if ($services.Count -ne 2) { throw "$Name must bind exactly the API and worker ECS services." }
    foreach ($expectedArn in @($Contract.ActiveApiArn,$Contract.ActiveWorkerArn)) {
        $matches = @($services | Where-Object { [string]$_.taskDefinitionArn -eq [string]$expectedArn })
        if ($matches.Count -ne 1 -or [int]$matches[0].desired -lt 1 -or
            [int]$matches[0].running -ne [int]$matches[0].desired -or [int]$matches[0].pending -ne 0 -or
            [string]$matches[0].assignPublicIp -notin @("ENABLED","DISABLED") -or @($matches[0].subnets).Count -lt 1) {
            throw "$Name ECS service posture is incomplete, mixed, or unstable."
        }
    }
    $rds=Get-RequiredProperty $posture "rds";$redis=Get-RequiredProperty $posture "redis"
    $expectedRdsClass=if([string]$Contract.CapacityTrack -eq "baseline"){"db.t4g.medium"}elseif([string]$Contract.CapacityTrack -eq "rds-resized"){"db.t4g.xlarge"}else{throw "$Name capacity track is unsupported."}
    if ([string]$rds.arn -notmatch '^arn:aws:rds:' -or [string]$rds.class -notin @("db.t4g.medium","db.t4g.xlarge") -or
        [string]$rds.class -ne $expectedRdsClass -or
        $null -eq (Get-CertificationValue $rds "exactPosture") -or
        ([string]$rds.class -eq "db.t4g.xlarge" -and $null -eq (Get-CertificationValue $rds "expectedExactPosture"))) {
        throw "$Name RDS class and exact datastore posture are incomplete."
    }
    if ([string]$redis.arn -notmatch '^arn:aws:elasticache:' -or [string]::IsNullOrWhiteSpace([string]$redis.nodeType) -or [string]$redis.status -ne "available") {
        throw "$Name Redis posture is incomplete or unavailable."
    }
    $alarms=@(Get-CertificationValue $posture "alarms" @());$schedules=@(Get-CertificationValue $posture "schedules" @())
    $expectedAlarmNames=@((Get-CertificationValue $Contract.Raw "alarmNames" @())|ForEach-Object{[string]$_}|Sort-Object -Unique)
    $expectedScheduleNames=@((Get-CertificationValue $Contract.Raw "scheduleNames" @())|ForEach-Object{[string]$_}|Sort-Object -Unique)
    $observedAlarmNames=@($alarms|ForEach-Object{[string]$_.name}|Sort-Object -Unique)
    $observedScheduleNames=@($schedules|ForEach-Object{[string]$_.name}|Sort-Object -Unique)
    if ($alarms.Count -lt 1 -or @($alarms|Where-Object{$_.state -ne "OK" -or $_.actionsEnabled -ne $true}).Count -gt 0 -or
        $schedules.Count -lt 1 -or @($schedules|Where-Object{$_.timezone -ne "America/New_York"}).Count -gt 0 -or
        $expectedAlarmNames.Count -lt 1 -or $expectedScheduleNames.Count -lt 1 -or
        @(Compare-Object $expectedAlarmNames $observedAlarmNames).Count -ne 0 -or
        @(Compare-Object $expectedScheduleNames $observedScheduleNames).Count -ne 0) {
        throw "$Name must bind enabled/OK alarms and America/New_York schedules."
    }
    $load=Get-CertificationValue $posture "loadStability"
    if($null -eq $load){throw "$Name.loadStability is required."}
    foreach ($service in @("api","worker")) {
        $value=Get-RequiredProperty $load $service
        if ([int]$value.desired -lt 1 -or [int]$value.running -ne [int]$value.desired -or [int]$value.pending -ne 0 -or
            [string]::IsNullOrWhiteSpace([string]$value.taskDefinitionArn)) { throw "$Name load-stability posture is incomplete for $service." }
    }
    [void](Get-RequiredProperty $load "tasks")
    if ([int]$load.healthyTargetCount -ne [int]$load.api.desired -or [int]$load.targetPort -lt 1 -or
        @($load.apiTaskPrivateIpv4).Count -ne [int]$load.api.desired) {
        throw "$Name load-stability target posture is incomplete."
    }
    return $Preflight
}

function Assert-CertificationFixtureAttestation {
    param($Fixture, [string]$Name)
    $stateBinding=Assert-CertificationEvidenceReference (Get-RequiredProperty $Fixture "state") "$Name.state"
    $verificationBinding=Assert-CertificationEvidenceReference (Get-RequiredProperty $Fixture "verification") "$Name.verification"
    $artifacts=@(Get-CertificationHarnessArtifactBindings (Get-RequiredProperty $Fixture "artifacts") "$Name.artifacts")
    Assert-CertificationHarnessArtifactContract $artifacts "$Name.artifacts"
    try{$state=Get-Content -LiteralPath $stateBinding.path -Raw|ConvertFrom-Json -Depth 60}catch{throw "$Name.state must contain valid JSON."}
    try{$verification=Get-Content -LiteralPath $verificationBinding.path -Raw|ConvertFrom-Json -Depth 60}catch{throw "$Name.verification must contain valid JSON."}
    Assert-CertificationFixtureVerificationContract $verification
    $fixtureId=[string](Get-RequiredProperty $Fixture "fixtureId")
    if([int]$state.schemaVersion -ne 1 -or [int]$verification.schemaVersion -ne 1 -or
        [string]$state.fixtureId -ne $fixtureId -or [string]$verification.fixtureId -ne $fixtureId -or $verification.passed -ne $true -or
        [string](Get-RequiredProperty $Fixture "timezone") -ne "America/New_York"){
        throw "$Name does not bind the exact accepted America/New_York fixture generation."
    }
    try {
        $generated=ConvertTo-CertificationUtcTimestamp $Fixture.generatedAtUtc "$Name.generatedAtUtc"
        $refreshed=ConvertTo-CertificationUtcTimestamp $Fixture.refreshedAtUtc "$Name.refreshedAtUtc"
        $verified=ConvertTo-CertificationUtcTimestamp $Fixture.verifiedAtUtc "$Name.verifiedAtUtc"
    }
    catch { throw "$Name fixture-generation chronology is invalid." }
    if($generated -gt $refreshed -or $refreshed -gt $verified){throw "$Name fixture-generation chronology is invalid."}
    return [ordered]@{state=$stateBinding;verification=$verificationBinding;artifacts=$artifacts;fixtureId=$fixtureId}
}

function New-CertificationValidationReceipt {
    param($Contract, $Preflight, $RollbackConfig, [string]$ReceiptPath, [string]$SealPath)
    if ($null -eq $Contract) { return }
    foreach ($path in @($ReceiptPath,$SealPath,"$ReceiptPath.consumed")) {
        if (Test-Path -LiteralPath $path) { throw "Validation receipt artifact already exists; use a fresh runId." }
    }
    $issuedAt = [DateTimeOffset]::UtcNow
    $receipt = [ordered]@{
        schemaVersion=1;type="certification_validation_receipt";runId=$runId;chainId=$Contract.ChainId
        issuedAtUtc=$issuedAt.ToString("o");expiresAtUtc=$issuedAt.AddMinutes(30).ToString("o")
        nonce=[Guid]::NewGuid().ToString("N");configSha256=Get-CertificationConfigHash
        controllerGitSha=$Contract.ControllerGitSha;controllerHashes=$Contract.ControllerHashes
        applicationGitSha=$Contract.ApplicationGitSha;deployedImageDigest=$Contract.DeployedImageDigest
        preflight=$Preflight;rollbackConfig=$RollbackConfig
    }
    Write-AtomicJson -Path $ReceiptPath -Value $receipt
    Write-AtomicJson -Path $SealPath -Value ([ordered]@{
        schemaVersion=1;type="certification_validation_receipt_seal";runId=$runId
        receiptSha256=Get-CertificationSha256 $ReceiptPath
    })
}

function Use-CertificationValidationReceipt {
    param($Contract, [string]$ReceiptPath, [string]$SealPath, [string]$ConsumedPath)
    if ($null -eq $Contract) { return $null }
    $expectedConsumedPath = [IO.Path]::GetFullPath("$ReceiptPath.consumed")
    if (-not [string]::Equals([IO.Path]::GetFullPath($ConsumedPath),$expectedConsumedPath,[StringComparison]::OrdinalIgnoreCase)) {
        throw "Validation receipt consumed path must be the exact receipt path with the .consumed suffix."
    }
    return Invoke-WithAtomicJsonMutex -Path $ReceiptPath -Operation {
        if (Test-Path -LiteralPath $ConsumedPath) { throw "Validation receipt was already consumed; replay is forbidden." }
        if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf) -or -not (Test-Path -LiteralPath $SealPath -PathType Leaf)) {
            throw "Run requires the fresh one-use receipt produced by Mode Validate."
        }
        $receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json -Depth 60
        $seal = Get-Content -LiteralPath $SealPath -Raw | ConvertFrom-Json -Depth 20
        $lifetime = Assert-CertificationReceiptLifetime $receipt ([DateTimeOffset]::UtcNow) -RequireUnexpired
        [void](Assert-CertificationPreflightContract $receipt.preflight $Contract $lifetime.issuedAtUtc "validationReceipt.preflight")
        $receiptRollback = Assert-CertificationEvidenceReference $receipt.rollbackConfig "validationReceipt.rollbackConfig"
        if ([int]$receipt.schemaVersion -ne 1 -or [string]$receipt.type -ne "certification_validation_receipt" -or
            [string]$receipt.runId -ne $runId -or [string]$receipt.chainId -ne $Contract.ChainId -or
            [string]$receipt.nonce -notmatch '^[0-9a-f]{32}$' -or
            [string]$receipt.configSha256 -ne (Get-CertificationConfigHash) -or
            [string]$receipt.controllerGitSha -ne $Contract.ControllerGitSha -or
            [string]$receipt.applicationGitSha -ne $Contract.ApplicationGitSha -or
            [string]$receipt.deployedImageDigest -ne $Contract.DeployedImageDigest -or
            (ConvertTo-CertificationComparableJson $receipt.controllerHashes) -cne
                (ConvertTo-CertificationComparableJson $Contract.ControllerHashes) -or
            [int]$seal.schemaVersion -ne 1 -or [string]$seal.type -ne "certification_validation_receipt_seal" -or
            [string]$seal.runId -ne $runId -or
            [string]$seal.receiptSha256 -ne (Get-CertificationSha256 $ReceiptPath)) {
            throw "Validation receipt is stale, tampered, or bound to a different configuration/controller."
        }
        [IO.File]::Move($ReceiptPath,$ConsumedPath)
        Remove-Item -LiteralPath $SealPath -Force
        return [ordered]@{path=$ConsumedPath;sha256=Get-CertificationSha256 $ConsumedPath;nonce=[string]$receipt.nonce;operatorConfigSha256=[string]$receipt.configSha256;rollbackConfig=$receiptRollback}
    }
}

function Get-CertificationChainRootBinding {
    param($Contract, $Preflight, $Receipt, [string]$GeneratorIp, [string]$OutputPath)
    if ($null -eq $Contract) { return $null }
    $isRootStage = [string]$config.phase -eq "Waf" -and [string]$config.workload.stage -eq "500" -and
        [string]::IsNullOrWhiteSpace([string](Get-CertificationValue $config "predecessorResultPath" ""))
    if ($isRootStage) {
        if($SupervisionKind -ne "Load"){throw "The certification chain root must be a supervised Waf/500 load stage."}
        if (Test-Path -LiteralPath $OutputPath) { throw "Chain-root output already exists; a prior chain cannot be replayed." }
        $root = [ordered]@{
            schemaVersion=1;type="certification_chain_root";runId=$runId;chainId=$Contract.ChainId;phase=[string]$config.phase;stage=[string]$config.workload.stage;supervisionKind=$SupervisionKind;createdAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
            capacityTrack=$Contract.CapacityTrack;applicationGitSha=$Contract.ApplicationGitSha;deployedImageDigest=$Contract.DeployedImageDigest
            controllerGitSha=$Contract.ControllerGitSha;controllerHashes=$Contract.ControllerHashes
            operatorConfigSha256=Get-CertificationConfigHash;boundRuntimeConfigSha256=$boundRuntimeConfigSha256;rollbackConfig=$boundRollbackConfigBinding;validationReceipt=$Receipt
            taskDefinitions=$Preflight.taskDefinitions;fixture=$Contract.Fixture;schemaCompatibility=$Contract.SchemaCompatibility;budgetAcknowledgement=$Contract.BudgetAcknowledgement
            generatorPublicIpv4=$GeneratorIp;historicalEvidenceDiagnosticOnly=$Contract.HistoricalEvidence
            datastorePosture=@{expectedRdsInstanceClass=[string]$config.resources.expectedRdsInstanceClass;expectedRedisNodeType=[string]$config.resources.expectedRedisNodeType;observedRds=$Preflight.posture.rds;observedRedis=$Preflight.posture.redis}
            networkPosture=@{expectedNatGatewayCount=[int]$config.resources.expectedNatGatewayCount;expectedEcsAssignPublicIp=[bool]$config.resources.expectedEcsAssignPublicIp;ecsTaskSubnetIds=@($config.resources.ecsTaskSubnetIds);observedServices=$Preflight.posture.services}
            alarms=$Preflight.posture.alarms;schedules=$Preflight.posture.schedules;rollbackIdentities=@{api=$Contract.RollbackApiArn;worker=$Contract.RollbackWorkerArn;schemaCompatibility=$Contract.SchemaCompatibility}
        }
        Write-AtomicJson -Path $OutputPath -Value $root
        return [ordered]@{path=$OutputPath;sha256=Get-CertificationSha256 $OutputPath;created=$true}
    }
    $rootReference = Get-RequiredProperty $Contract.Raw "chainRoot"
    $binding = Assert-CertificationEvidenceReference $rootReference "certification.chainRoot"
    $rootJson = Get-Content -LiteralPath $binding.path -Raw | ConvertFrom-Json -Depth 60
    if ([string]$rootJson.type -ne "certification_chain_root" -or [string]$rootJson.chainId -ne $Contract.ChainId -or
        [string]$rootJson.capacityTrack -ne $Contract.CapacityTrack) {
        throw "Configured chain root does not match this stage and capacity track."
    }
    return [ordered]@{path=$binding.path;sha256=$binding.sha256;created=$false}
}

function Assert-CertificationConsumedReceiptAttestation {
    param($ReceiptReference, $Attestation, $Contract, [DateTimeOffset]$AttestedAt, [string]$Name)
    $receiptBinding=Assert-CertificationEvidenceReference $ReceiptReference "$Name.validationReceipt"
    if(-not $receiptBinding.path.EndsWith(".consumed",[StringComparison]::Ordinal)){
        throw "$Name validation receipt must reference the atomically consumed .consumed artifact."
    }
    try{$receipt=Get-Content -LiteralPath $receiptBinding.path -Raw|ConvertFrom-Json -Depth 60}catch{throw "$Name validation receipt must contain valid JSON."}
    $lifetime=Assert-CertificationReceiptLifetime $receipt $AttestedAt
    [void](Assert-CertificationPreflightContract $receipt.preflight $Contract $lifetime.issuedAtUtc "$Name.validationReceipt.preflight")
    $receiptRollback=Assert-CertificationEvidenceReference $receipt.rollbackConfig "$Name.validationReceipt.rollbackConfig"
    $attestedRollback=Assert-CertificationEvidenceReference (Get-RequiredProperty $Attestation "rollbackConfig") "$Name.rollbackConfig"
    $referenceRollback=Get-RequiredProperty $ReceiptReference "rollbackConfig"
    if([int]$receipt.schemaVersion -ne 1 -or [string]$receipt.type -ne "certification_validation_receipt" -or
        [string]$receipt.runId -ne [string]$Attestation.runId -or [string]$receipt.chainId -ne $Contract.ChainId -or
        [string]$receipt.applicationGitSha -ne $Contract.ApplicationGitSha -or [string]$receipt.deployedImageDigest -ne $Contract.DeployedImageDigest -or
        [string]$receipt.controllerGitSha -ne $Contract.ControllerGitSha -or
        (ConvertTo-CertificationComparableJson $receipt.controllerHashes) -cne (ConvertTo-CertificationComparableJson $Contract.ControllerHashes) -or
        [string]$receipt.configSha256 -ne [string]$Attestation.operatorConfigSha256 -or
        [string]$receipt.nonce -notmatch '^[0-9a-f]{32}$' -or [string]$ReceiptReference.nonce -ne [string]$receipt.nonce -or
        [string]$ReceiptReference.operatorConfigSha256 -ne [string]$receipt.configSha256 -or
        [string]$referenceRollback.path -ne [string]$receiptRollback.path -or [string]$referenceRollback.sha256 -ne [string]$receiptRollback.sha256 -or
        [string]$attestedRollback.sha256 -ne [string]$receiptRollback.sha256){
        throw "$Name validation receipt is not completely bound to its run, chain, controller, operator config, nonce, and rollback config."
    }
    return [ordered]@{binding=$receiptBinding;receipt=$receipt;preflight=$receipt.preflight;rollbackConfig=$attestedRollback}
}

function Assert-CertificationAttestedStageEvidence {
    param($Attestation, $ReceiptEvidence, $Contract, [string]$Name, [bool]$RequireGeneratorIp)
    [void](Assert-CertificationSha256 ([string]$Attestation.operatorConfigSha256) "$Name.operatorConfigSha256")
    [void](Assert-CertificationSha256 ([string]$Attestation.boundRuntimeConfigSha256) "$Name.boundRuntimeConfigSha256")
    Assert-CertificationTaskDefinitionAttestations $Attestation.taskDefinitions $Contract "$Name.taskDefinitions"
    if((ConvertTo-CertificationComparableJson $Attestation.taskDefinitions) -cne (ConvertTo-CertificationComparableJson $ReceiptEvidence.preflight.taskDefinitions)){
        throw "$Name task-definition attestations differ from the consumed validation receipt."
    }
    [void](Assert-CertificationFixtureAttestation $Attestation.fixture "$Name.fixture")
    $datastore=Get-RequiredProperty $Attestation "datastorePosture";$network=Get-RequiredProperty $Attestation "networkPosture"
    $expectedCapacityClass=if([string]$Contract.CapacityTrack -eq "baseline"){"db.t4g.medium"}elseif([string]$Contract.CapacityTrack -eq "rds-resized"){"db.t4g.xlarge"}else{throw "$Name capacity track is unsupported."}
    if([string]$datastore.expectedRdsInstanceClass -ne $expectedCapacityClass -or
        [string]$datastore.expectedRdsInstanceClass -ne [string]$ReceiptEvidence.preflight.posture.rds.class -or
        [string]::IsNullOrWhiteSpace([string]$datastore.expectedRedisNodeType) -or
        [string]$datastore.expectedRedisNodeType -ne [string]$ReceiptEvidence.preflight.posture.redis.nodeType -or
        (ConvertTo-CertificationComparableJson $datastore.observedRds) -cne (ConvertTo-CertificationComparableJson $ReceiptEvidence.preflight.posture.rds) -or
        (ConvertTo-CertificationComparableJson $datastore.observedRedis) -cne (ConvertTo-CertificationComparableJson $ReceiptEvidence.preflight.posture.redis)){
        throw "$Name datastore posture differs from the complete consumed validation preflight."
    }
    if([int]$network.expectedNatGatewayCount -notin @(0,2) -or $network.expectedEcsAssignPublicIp -isnot [bool] -or
        @($network.ecsTaskSubnetIds).Count -lt 1 -or
        (ConvertTo-CertificationComparableJson $network.observedServices) -cne (ConvertTo-CertificationComparableJson $ReceiptEvidence.preflight.posture.services)){
        throw "$Name network posture differs from the complete consumed validation preflight."
    }
    $expectedAssignPublicIp=if([bool]$network.expectedEcsAssignPublicIp){"ENABLED"}else{"DISABLED"}
    foreach($service in @($network.observedServices)){
        if([string]$service.assignPublicIp -ne $expectedAssignPublicIp -or
            @(Compare-Object @($network.ecsTaskSubnetIds|Sort-Object) @($service.subnets|Sort-Object)).Count -ne 0){
            throw "$Name network posture does not bind the exact task subnets and public-IP mode."
        }
    }
    if((ConvertTo-CertificationComparableJson $Attestation.alarms) -cne (ConvertTo-CertificationComparableJson $ReceiptEvidence.preflight.posture.alarms) -or
        (ConvertTo-CertificationComparableJson $Attestation.schedules) -cne (ConvertTo-CertificationComparableJson $ReceiptEvidence.preflight.posture.schedules)){
        throw "$Name alarms or schedules differ from the consumed validation preflight."
    }
    $rollbackIdentities=Get-RequiredProperty $Attestation "rollbackIdentities"
    $schemaBinding=Assert-CertificationEvidenceReference $rollbackIdentities.schemaCompatibility "$Name.rollbackIdentities.schemaCompatibility"
    if([string]$rollbackIdentities.api -ne $Contract.RollbackApiArn -or [string]$rollbackIdentities.worker -ne $Contract.RollbackWorkerArn -or
        [string]$schemaBinding.sha256 -ne [string]$Contract.SchemaCompatibility.sha256){
        throw "$Name rollback task and schema-compatibility identities are incomplete or different."
    }
    $generator=[string](Get-CertificationValue $Attestation "generatorPublicIpv4" "")
    $parsedIp=$null
    if(($RequireGeneratorIp -and (-not [Net.IPAddress]::TryParse($generator,[ref]$parsedIp) -or $parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork)) -or
        (-not [string]::IsNullOrWhiteSpace($generator) -and (-not [Net.IPAddress]::TryParse($generator,[ref]$parsedIp) -or $parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork))){
        throw "$Name must bind the exact IPv4 load-generator identity for load supervision."
    }
}

function Assert-CertificationChainContinuity {
    param($Config, $Contract)
    if ($null -eq $Contract) { return }
    $stage = if ($null -eq (Get-CertificationValue $Config "workload")) { $null } else { [string]$Config.workload.stage }
    $isRootStage = [string]$Config.phase -eq "Waf" -and $stage -eq "500" -and
        [string]::IsNullOrWhiteSpace([string](Get-CertificationValue $Config "predecessorResultPath" ""))
    if ($isRootStage) {
        if (Get-CertificationValue $Contract.Raw "chainRoot") { throw "A root Waf/500 stage must create a fresh chain root, not import one." }
        if($SupervisionKind -ne "Load"){throw "The certification chain root must be validated and run as a supervised Waf/500 load stage."}
        return
    }
    $rootBinding = Assert-CertificationEvidenceReference (Get-RequiredProperty $Contract.Raw "chainRoot") "certification.chainRoot"
    $root = Get-Content -LiteralPath $rootBinding.path -Raw | ConvertFrom-Json -Depth 60
    if ([int]$root.schemaVersion -ne 1 -or [string]$root.type -ne "certification_chain_root" -or
        [string]$root.chainId -ne $Contract.ChainId -or [string]$root.runId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
        [string]$root.phase -ne "Waf" -or [string]$root.stage -ne "500" -or [string]$root.supervisionKind -ne "Load" -or
        [string]$root.capacityTrack -ne $Contract.CapacityTrack -or [string]$root.applicationGitSha -ne $Contract.ApplicationGitSha -or
        [string]$root.deployedImageDigest -ne $Contract.DeployedImageDigest -or [string]$root.controllerGitSha -ne $Contract.ControllerGitSha -or
        (ConvertTo-CertificationComparableJson $root.controllerHashes) -cne (ConvertTo-CertificationComparableJson $Contract.ControllerHashes)) {
        throw "Certification chain root identity/controller continuity failed."
    }
    try{$rootCreatedAt=ConvertTo-CertificationUtcTimestamp $root.createdAtUtc "Certification chain root createdAtUtc"}catch{throw "Certification chain root creation timestamp is invalid or in the future."}
    if($rootCreatedAt -gt [DateTimeOffset]::UtcNow){throw "Certification chain root creation timestamp is invalid or in the future."}
    $rootReceiptEvidence=Assert-CertificationConsumedReceiptAttestation $root.validationReceipt $root $Contract $rootCreatedAt "certification.chainRoot"
    Assert-CertificationAttestedStageEvidence $root $rootReceiptEvidence $Contract "certification.chainRoot" ([string]$root.supervisionKind -eq "Load")
    $predecessorPath = Resolve-ExternalPath -Path ([string](Get-RequiredProperty $Config "predecessorResultPath")) -Name "predecessorResultPath"
    $predecessorSha = Assert-CertificationSha256 ([string](Get-RequiredProperty $Config "predecessorResultSha256")) "predecessorResultSha256"
    if ((Get-CertificationSha256 $predecessorPath) -ne $predecessorSha) { throw "Predecessor supervisor result was tampered with." }
    $envelope = Get-Content -LiteralPath $predecessorPath -Raw | ConvertFrom-Json -Depth 60
    if ([int]$envelope.schemaVersion -ne 2 -or [string]$envelope.type -ne "certification_supervisor_terminal" -or
        $envelope.supervisorSealed -ne $true -or [string]$envelope.status -ne "completed" -or
        [string]$envelope.chainId -ne $Contract.ChainId -or
        [string]$envelope.applicationGitSha -ne $Contract.ApplicationGitSha -or
        [string]$envelope.deployedImageDigest -ne $Contract.DeployedImageDigest -or
        [string]$envelope.controllerGitSha -ne $Contract.ControllerGitSha -or
        (ConvertTo-CertificationComparableJson $envelope.controllerHashes) -cne (ConvertTo-CertificationComparableJson $Contract.ControllerHashes) -or
        [string]$envelope.supervisionKind -notin @("Load","MonitorOnly")) {
        throw "Predecessor is not a supervisor-sealed accepted terminal result."
    }
    $envelopeRoot = Assert-CertificationEvidenceReference $envelope.chainRoot "predecessor.chainRoot"
    $envelopeStage = Assert-CertificationEvidenceReference $envelope.stageAttestation "predecessor.stageAttestation"
    $terminal = Assert-CertificationEvidenceReference $envelope.terminalMonitorResult "predecessor.terminalMonitorResult"
    if ($envelopeRoot.sha256 -ne $rootBinding.sha256) { throw "Predecessor belongs to a different chain root." }
    $priorPredecessorSha = [string](Get-CertificationValue $envelope "predecessorSupervisorResultSha256" "")
    $linkInput = (@($rootBinding.sha256,$(if($priorPredecessorSha){$priorPredecessorSha}else{"0"*64}),$envelopeStage.sha256,$terminal.sha256) -join "`n")
    if ([string]$envelope.linkSha256 -ne (Get-CertificationTextSha256 $linkInput)) { throw "Predecessor supervisor link seal is invalid." }
    $attestation = Get-Content -LiteralPath $envelopeStage.path -Raw | ConvertFrom-Json -Depth 60
    $monitor = Get-Content -LiteralPath $terminal.path -Raw | ConvertFrom-Json -Depth 60
    if ([int]$attestation.schemaVersion -ne 1 -or [string]$attestation.type -ne "certification_stage_attestation" -or [string]$attestation.runId -ne [string]$envelope.runId -or
        [string]$attestation.chainId -ne $Contract.ChainId -or [string]$attestation.phase -ne [string]$envelope.phase -or
        [string](Get-CertificationValue $attestation "stage" "") -ne [string](Get-CertificationValue $envelope "stage" "") -or
        [string]$attestation.supervisionKind -ne [string]$envelope.supervisionKind -or
        [string]$attestation.chainRoot.sha256 -ne $rootBinding.sha256 -or
        [string]$attestation.applicationGitSha -ne $Contract.ApplicationGitSha -or
        [string]$attestation.deployedImageDigest -ne $Contract.DeployedImageDigest -or
        [string]$attestation.controllerGitSha -ne $Contract.ControllerGitSha -or
        (ConvertTo-CertificationComparableJson $attestation.controllerHashes) -cne (ConvertTo-CertificationComparableJson $Contract.ControllerHashes)) {
        throw "Predecessor stage attestation identity/root/controller continuity failed."
    }
    try{$attestedAt=ConvertTo-CertificationUtcTimestamp $attestation.attestedAtUtc "Predecessor stage attestedAtUtc"}catch{throw "Predecessor stage attestation timestamp is invalid or in the future."}
    if($attestedAt -gt [DateTimeOffset]::UtcNow){throw "Predecessor stage attestation timestamp is invalid or in the future."}
    $stageReceiptEvidence=Assert-CertificationConsumedReceiptAttestation $attestation.validationReceipt $attestation $Contract $attestedAt "predecessor.stageAttestation"
    Assert-CertificationAttestedStageEvidence $attestation $stageReceiptEvidence $Contract "predecessor.stageAttestation" ([string]$envelope.supervisionKind -eq "Load")
    [void](Assert-CertificationEvidenceReference $envelope.rollbackConfig "predecessor.rollbackConfig")
    if([string]$envelope.operatorConfigSha256 -ne [string]$attestation.operatorConfigSha256 -or
        [string]$envelope.boundRuntimeConfigSha256 -ne [string]$attestation.boundRuntimeConfigSha256 -or
        (ConvertTo-CertificationComparableJson $envelope.rollbackConfig) -cne (ConvertTo-CertificationComparableJson $attestation.rollbackConfig)){
        throw "Predecessor supervisor envelope is not bound to its attested operator, runtime, and rollback configuration."
    }
    $attestedPredecessorSha = [string](Get-CertificationValue (Get-CertificationValue $attestation "predecessor") "sha256" "")
    if ($attestedPredecessorSha -ne $priorPredecessorSha) { throw "Predecessor stage attestation link does not match its supervisor envelope." }
    if(-not $priorPredecessorSha){
        if([string]$envelope.phase -ne "Waf" -or [string]$envelope.stage -ne "500" -or [string]$envelope.supervisionKind -ne "Load" -or
            [string]$attestation.supervisionKind -ne "Load" -or [string]$root.runId -ne [string]$envelope.runId){
            throw "The first accepted predecessor must be the exact fresh Waf/500 chain-root stage."
        }
        foreach($field in @("operatorConfigSha256","boundRuntimeConfigSha256","rollbackConfig","validationReceipt","taskDefinitions","fixture","generatorPublicIpv4","datastorePosture","networkPosture","alarms","schedules","rollbackIdentities")){
            if((ConvertTo-CertificationComparableJson (Get-CertificationValue $root $field)) -cne
                (ConvertTo-CertificationComparableJson (Get-CertificationValue $attestation $field))){
                throw "Waf/500 chain root field '$field' differs from its supervisor-sealed stage attestation."
            }
        }
    }
    if ([string]$monitor.runId -ne [string]$envelope.runId -or [string]$monitor.phase -ne [string]$envelope.phase -or
        [string]$monitor.status -ne "completed" -or $monitor.postureAccepted -ne $true -or $monitor.acceptance.passed -ne $true -or
        [string]$envelope.terminalMonitorResult.runId -ne [string]$monitor.runId -or
        [string]$envelope.terminalMonitorResult.phase -ne [string]$monitor.phase -or
        [string](Get-CertificationValue $monitor.workload "stage" "") -ne [string](Get-CertificationValue $envelope "stage" "")) {
        throw "Predecessor terminal monitor result is not bound to its supervisor envelope and accepted stage."
    }
}

function Write-CertificationStageAttestation {
    param($Contract, $Preflight, $ChainRoot, $Receipt, [string]$GeneratorIp, [string]$Path)
    if ($null -eq $Contract) { return $null }
    if (Test-Path -LiteralPath $Path) { throw "Stage attestation already exists; stage replay is forbidden." }
    $alarms = @((Get-CertificationValue $Contract.Raw "alarmNames" @()) | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $schedules = @((Get-CertificationValue $Contract.Raw "scheduleNames" @()) | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    if ($alarms.Count -lt 1 -or $schedules.Count -lt 1) { throw "Certification requires explicit alarmNames and scheduleNames attestations." }
    $attestation = [ordered]@{
        schemaVersion=1;type="certification_stage_attestation";runId=$runId;chainId=$Contract.ChainId;supervisionKind=$SupervisionKind
        phase=[string]$config.phase;stage=if($null -eq (Get-CertificationValue $config "workload")){$null}else{[string]$config.workload.stage}
        attestedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");chainRoot=$ChainRoot;validationReceipt=$Receipt
        predecessor=if(Get-CertificationValue $config "predecessorResultPath"){@{path=[string]$config.predecessorResultPath;sha256=[string]$config.predecessorResultSha256}}else{$null}
        applicationGitSha=$Contract.ApplicationGitSha;deployedImageDigest=$Contract.DeployedImageDigest
        controllerGitSha=$Contract.ControllerGitSha;controllerHashes=$Contract.ControllerHashes
        operatorConfigSha256=Get-CertificationConfigHash;boundRuntimeConfigSha256=$boundRuntimeConfigSha256;rollbackConfig=$boundRollbackConfigBinding
        taskDefinitions=$Preflight.taskDefinitions;fixture=$Contract.Fixture;generatorPublicIpv4=$GeneratorIp
        datastorePosture=@{expectedRdsInstanceClass=[string]$config.resources.expectedRdsInstanceClass;expectedRedisNodeType=[string]$config.resources.expectedRedisNodeType;observedRds=$Preflight.posture.rds;observedRedis=$Preflight.posture.redis}
        networkPosture=@{expectedNatGatewayCount=[int]$config.resources.expectedNatGatewayCount;expectedEcsAssignPublicIp=[bool]$config.resources.expectedEcsAssignPublicIp;ecsTaskSubnetIds=@($config.resources.ecsTaskSubnetIds);observedServices=$Preflight.posture.services}
        alarms=$Preflight.posture.alarms;schedules=$Preflight.posture.schedules;rollbackIdentities=@{api=$Contract.RollbackApiArn;worker=$Contract.RollbackWorkerArn;schemaCompatibility=$Contract.SchemaCompatibility}
        budgetAcknowledgement=$Contract.BudgetAcknowledgement
        historicalEvidence=@{diagnosticOnly=$true;artifacts=$Contract.HistoricalEvidence}
    }
    Write-AtomicJson -Path $Path -Value $attestation
    return [ordered]@{path=$Path;sha256=Get-CertificationSha256 $Path}
}

function Assert-CertificationActualWaf800Window {
    param($Contract, [DateTimeOffset]$ActualStart)
    if ($null -eq $Contract -or [string]$config.phase -ne "Waf" -or [string]$config.workload.stage -ne "800") { return }
    foreach ($requiredTime in @("01:30","02:00")) {
        if (-not (Test-CertificationIntervalIncludesLocalTime $ActualStart ([int]$config.workload.durationSeconds) $Contract.Fixture.timezone $requiredTime)) {
            throw "The actual Waf/800 interval would not include local $requiredTime; traffic remains blocked."
        }
    }
}

$resolvedConfigPath = Resolve-ExternalPath -Path $ConfigPath -Name "ConfigPath"
try { $config = Get-Content -LiteralPath $resolvedConfigPath -Raw | ConvertFrom-Json -Depth 40 }
catch { throw "ConfigPath must contain valid JSON." }
$script:OperatorConfigSha256 = Get-CertificationSha256 $resolvedConfigPath
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
    foreach ($candidateIp in @($generatorSequenceMember.Value)) {
        [void](Assert-Ipv4Literal -Value ([string]$candidateIp) -Name "testGeneratorPublicIpSequence")
    }
}
$generatorDelayMember = $config.PSObject.Properties["testPreReleaseGeneratorPublicIpDelayMilliseconds"]
if ($null -ne $generatorDelayMember -and $null -ne $generatorDelayMember.Value) {
    if (-not $testMode) { throw "testPreReleaseGeneratorPublicIpDelayMilliseconds is forbidden outside isolated testMode." }
    $generatorDelay = 0
    if (-not [int]::TryParse([string]$generatorDelayMember.Value, [ref]$generatorDelay) -or
        $generatorDelay -lt 0 -or $generatorDelay -gt 5000) {
        throw "testPreReleaseGeneratorPublicIpDelayMilliseconds must be an integer from 0 through 5000."
    }
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

$certificationContract = $null

$node = if ($SupervisionKind -eq "Load") { Get-Command node -ErrorAction Stop } else { $null }
$pwsh = (Get-Process -Id $PID).Path
if (-not (Test-Path -LiteralPath $monitorScript -PathType Leaf) -or -not (Test-Path -LiteralPath $runtimeMonitorScript -PathType Leaf) -or
    ($SupervisionKind -eq "Load" -and -not (Test-Path -LiteralPath $runtimeHarnessScript -PathType Leaf))) {
    throw "The required harness or monitor script is missing."
}

$staticMonitorConfigPath = Join-Path $evidenceDirectory "$runId-static-monitor-config.json"
$heartbeatPath = Join-Path $evidenceDirectory "$runId-supervisor-heartbeat.json"
$supervisorResultPath = Join-Path $evidenceDirectory "$runId-supervisor-result.json"
$boundConfigPath = Join-Path $evidenceDirectory "$runId-bound-monitor-config.json"
$boundRollbackConfigPath = Join-Path $evidenceDirectory "$runId-bound-rollback-config.json"
$harnessStdout = if ($SupervisionKind -eq "Load") { Join-Path $evidenceDirectory "$runId-harness.stdout.log" } else { $null }
$harnessStderr = if ($SupervisionKind -eq "Load") { Join-Path $evidenceDirectory "$runId-harness.stderr.log" } else { $null }
$monitorStdout = Join-Path $evidenceDirectory "$runId-monitor.stdout.log"
$monitorStderr = Join-Path $evidenceDirectory "$runId-monitor.stderr.log"
$generatorIpEvidencePath = if ($SupervisionKind -eq "Load") { Join-Path $evidenceDirectory "$runId-generator-public-ip.json" } else { $null }
$harnessReadyPath = if ($SupervisionKind -eq "Load") { Join-Path $evidenceDirectory "$runId-harness-ready.json" } else { $null }
$harnessStartGatePath = if ($SupervisionKind -eq "Load") { Join-Path $evidenceDirectory "$runId-harness-start.json" } else { $null }
$awsMonitorEvidencePath = Join-Path $evidenceDirectory "$runId-aws-monitor.jsonl"
$monitorHeartbeatPath = Join-Path $evidenceDirectory "$runId-monitor-heartbeat.json"
$monitorResultPath = Join-Path $evidenceDirectory "$runId-monitor-result.json"
$rollbackEvidencePath = Join-Path $evidenceDirectory "$runId-rollback.jsonl"
$rollbackStatePath = Join-Path $evidenceDirectory "$runId-rollback-state.json"
$rollbackHeartbeatPath = Join-Path $evidenceDirectory "$runId-rollback-heartbeat.json"
$validationReceiptPath = Join-Path $evidenceDirectory "$runId-validation-receipt.json"
$validationReceiptSealPath = Join-Path $evidenceDirectory "$runId-validation-receipt-seal.json"
$consumedValidationReceiptPath = "$validationReceiptPath.consumed"
$chainRootOutputPath = Join-Path $evidenceDirectory "$runId-chain-root.json"
$stageAttestationPath = Join-Path $evidenceDirectory "$runId-stage-attestation.json"

if ($SupervisionKind -eq "Load") {
    $generatedArtifactPaths = @(
        $staticMonitorConfigPath, $heartbeatPath, $supervisorResultPath, $boundConfigPath, $boundRollbackConfigPath,
        $harnessStdout, $harnessStderr, $monitorStdout, $monitorStderr,
        $generatorIpEvidencePath, $harnessReadyPath, $harnessStartGatePath,
        $awsMonitorEvidencePath, $monitorHeartbeatPath, $monitorResultPath,
        $rollbackEvidencePath, $rollbackStatePath, $rollbackHeartbeatPath,
        $validationReceiptPath, $validationReceiptSealPath, $consumedValidationReceiptPath,
        $chainRootOutputPath, $stageAttestationPath
    ) | Where-Object { $_ }
    foreach ($loadArtifact in @(
        [pscustomobject]@{ Name = "loadProgressPath"; Path = $progressPath },
        [pscustomobject]@{ Name = "loadSummaryPath"; Path = $summaryPath }
    )) {
        foreach ($generatedArtifactPath in $generatedArtifactPaths) {
            if ([string]::Equals($loadArtifact.Path, $generatedArtifactPath, [StringComparison]::OrdinalIgnoreCase)) {
                throw "$($loadArtifact.Name) must not collide with generated supervisor, monitor, or rollback artifact '$generatedArtifactPath'."
            }
        }
    }
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
    $certificationContract = Get-CertificationContract -Config $config -TestMode $testMode -BindHarnessArtifacts:($SupervisionKind -eq "Load")
    Assert-CertificationChainContinuity -Config $config -Contract $certificationContract
    $validationRollbackBinding = Assert-CertificationRollbackConfigBinding -Config $config -Contract $certificationContract
    if ($SupervisionKind -eq "Load") {
        Invoke-HarnessConfigurationPreflight -Config $config -NodePath $node.Source -HarnessPath $runtimeHarnessScript
        $validationIp = Resolve-GeneratorPublicIp -Config $config
        if ($validationIp -ne $expectedGeneratorPublicIp) { throw "Generator public IPv4 does not match expectedGeneratorPublicIp." }
    }
    $validationPreflight = Get-CertificationTaskPreflight -Config $config -Contract $certificationContract
    New-CertificationValidationReceipt -Contract $certificationContract -Preflight $validationPreflight -RollbackConfig $validationRollbackBinding `
        -ReceiptPath $validationReceiptPath -SealPath $validationReceiptSealPath
    exit 0
}


# Validate the complete monitor and every reachable rollback before sleep is
# disabled and, critically, before any load traffic process is started.
Invoke-StaticMonitorValidation -Config $config -EvidenceDirectory $evidenceDirectory -PwshPath $pwsh
if ($SupervisionKind -eq "Load") {
    Invoke-HarnessConfigurationPreflight -Config $config -NodePath $node.Source -HarnessPath $runtimeHarnessScript
}
$certificationContract = Get-CertificationContract -Config $config -TestMode $testMode -BindHarnessArtifacts:($SupervisionKind -eq "Load")
Assert-CertificationChainContinuity -Config $config -Contract $certificationContract
$runRollbackBinding = Assert-CertificationRollbackConfigBinding -Config $config -Contract $certificationContract
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
$supervisorArtifacts = @($heartbeatPath, $supervisorResultPath, $boundConfigPath, $boundRollbackConfigPath, $monitorStdout, $monitorStderr)
if ($SupervisionKind -eq "Load") {
    $supervisorArtifacts += @(
        $harnessStdout, $harnessStderr, $generatorIpEvidencePath,
        $harnessReadyPath, $harnessStartGatePath
    )
}
foreach ($path in $supervisorArtifacts) {
    if (Test-Path -LiteralPath $path) { throw "Supervisor artifact already exists: $path" }
}

$validationReceiptBinding = Use-CertificationValidationReceipt -Contract $certificationContract `
    -ReceiptPath $validationReceiptPath -SealPath $validationReceiptSealPath -ConsumedPath $consumedValidationReceiptPath
$boundRollbackConfigBinding = $null
if ($null -ne $certificationContract) {
    Assert-CertificationOperatorConfigUnchanged
    if ($runRollbackBinding.sha256 -ne $validationReceiptBinding.rollbackConfig.sha256) {
        throw "Executable rollback config differs from the one-use validation receipt."
    }
    $boundRollbackConfigBinding = Copy-CertificationFileIfHashMatches `
        -Source $runRollbackBinding.path -Destination $boundRollbackConfigPath -ExpectedSha256 $runRollbackBinding.sha256
    $config.rollbackConfigPath = $boundRollbackConfigPath
    $config | Add-Member -NotePropertyName expectedRollbackConfigSha256 -NotePropertyValue $boundRollbackConfigBinding.sha256 -Force
}
$chainRootBinding = $null
$stageAttestationBinding = $null
$boundRuntimeConfigSha256 = $null

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
        $harnessEnvironment = @{
            LOAD_RUN_ID                          = $runId
            LOAD_STAGE                           = [string]$config.workload.stage
            LOAD_EXTERNAL_PROGRESS_PATH          = $progressPath
            LOAD_EXTERNAL_SUMMARY_PATH           = $summaryPath
            LOAD_SUPERVISOR_READY_PATH            = $harnessReadyPath
            LOAD_SUPERVISOR_START_GATE_PATH       = $harnessStartGatePath
            LOAD_SUPERVISOR_START_GATE_TIMEOUT_MS = [string](($monitorHeartbeatStaleSeconds + 30) * 1000)
        }
        $harness = Start-Process -FilePath $node.Source -ArgumentList @((Quote-ProcessArgument $runtimeHarnessScript)) -Environment $harnessEnvironment -PassThru -NoNewWindow `
            -RedirectStandardOutput $harnessStdout -RedirectStandardError $harnessStderr

        # The harness parses every private fixture and then blocks on an
        # operator-owned start gate before opening progress output or emitting
        # traffic. Prove that exact PID reached the gate before binding it into
        # the monitor configuration.
        $readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds($monitorHeartbeatStaleSeconds)
        $ready = $null
        while ($null -eq $ready -and [DateTimeOffset]::UtcNow -lt $readyDeadline) {
            $harness.Refresh()
            if ($harness.HasExited) { throw "The load harness exited before reaching the supervisor start gate." }
            if (Test-Path -LiteralPath $harnessReadyPath) {
                try { $ready = Read-AtomicJson -Path $harnessReadyPath }
                catch { throw "The load harness ready artifact is invalid: $($_.Exception.Message)" }
                if ([int]$ready.schemaVersion -ne 1 -or [string]$ready.type -ne "load_supervisor_ready" -or
                    [string]$ready.runId -ne $runId -or [int]$ready.harnessProcessId -ne $harness.Id -or
                    [string]$ready.stage -ne [string]$config.workload.stage -or $ready.trafficStarted -ne $false -or
                    ([DateTimeOffset]$ready.readyAt).ToUniversalTime() -lt $launchedAt) {
                    throw "The load harness ready artifact does not match the bound run and process identity."
                }
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if ($null -eq $ready) { throw "Timed out waiting for the load harness to reach the supervisor start gate." }

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
    if ($null -ne $certificationContract) { Assert-CertificationOperatorConfigUnchanged }
    Write-AtomicJson -Path $boundConfigPath -Value $config
    $boundRuntimeConfigSha256 = Get-CertificationSha256 $boundConfigPath

    & $pwsh -NoProfile -File $monitorScript -ConfigPath $boundConfigPath -ExpectedConfigSha256 $boundRuntimeConfigSha256 -Mode Validate | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The bound monitor configuration failed validation." }
    if ($SupervisionKind -eq "MonitorOnly" -and $null -ne $certificationContract) {
        $certificationContract = Get-CertificationContract -Config $config -TestMode $testMode -BindHarnessArtifacts:($SupervisionKind -eq "Load")
        Assert-CertificationOperatorConfigUnchanged
        $monitorOnlyRollbackBinding = Assert-CertificationRollbackConfigBinding -Config $config -Contract $certificationContract
        if ($monitorOnlyRollbackBinding.sha256 -ne $boundRollbackConfigBinding.sha256) { throw "Bound rollback config changed before MonitorOnly supervision." }
        Assert-CertificationChainContinuity -Config $config -Contract $certificationContract
        $monitorOnlyPreflight = Get-CertificationTaskPreflight -Config $config -Contract $certificationContract
        $chainRootBinding = Get-CertificationChainRootBinding -Contract $certificationContract -Preflight $monitorOnlyPreflight `
            -Receipt $validationReceiptBinding -GeneratorIp $null -OutputPath $chainRootOutputPath
        $stageAttestationBinding = Write-CertificationStageAttestation -Contract $certificationContract `
            -Preflight $monitorOnlyPreflight -ChainRoot $chainRootBinding -Receipt $validationReceiptBinding `
            -GeneratorIp $null -Path $stageAttestationPath
    }
    $monitorStartedAt = [DateTimeOffset]::UtcNow
    $monitor = Start-Process -FilePath $pwsh -ArgumentList @("-NoProfile", "-File", (Quote-ProcessArgument $runtimeMonitorScript), "-ConfigPath", (Quote-ProcessArgument $boundConfigPath), "-ExpectedConfigSha256", $boundRuntimeConfigSha256, "-Mode", "Monitor") `
        -PassThru -NoNewWindow -RedirectStandardOutput $monitorStdout -RedirectStandardError $monitorStderr

    if ($SupervisionKind -eq "Load") {
        # Do not release traffic merely because the monitor process exists. Its
        # first complete sample proves AWS access, immutable config, heartbeat
        # output, and the bound harness identity before the gate can open.
        $armedDeadline = [DateTimeOffset]::UtcNow.AddSeconds($monitorHeartbeatStaleSeconds)
        $armedHeartbeat = $null
        $lastArmingHeartbeatWrite = [DateTimeOffset]::MinValue
        while ($null -eq $armedHeartbeat -and [DateTimeOffset]::UtcNow -lt $armedDeadline) {
            $now = [DateTimeOffset]::UtcNow
            $monitor.Refresh()
            if ($monitor.HasExited) { throw "The AWS monitor exited before arming the load harness." }
            $harness.Refresh()
            if ($harness.HasExited) { throw "The load harness exited while waiting for the AWS monitor start gate." }
            if (($now - $lastArmingHeartbeatWrite).TotalSeconds -ge 30) {
                Write-AtomicJson -Path $heartbeatPath -Value ([ordered]@{
                    runId = $runId; timestamp = $now.ToString("o"); status = "arming";
                    supervisionKind = $SupervisionKind; monitorProcessId = $monitor.Id; harnessProcessId = $harness.Id
                })
                $lastArmingHeartbeatWrite = $now
            }
            if (Test-Path -LiteralPath $monitorHeartbeatPath) {
                try { $candidateHeartbeat = Read-AtomicJson -Path $monitorHeartbeatPath }
                catch { throw "The AWS monitor arming heartbeat is invalid: $($_.Exception.Message)" }
                Assert-HealthyMonitorArmingHeartbeat -Heartbeat $candidateHeartbeat -ExpectedRunId $runId `
                    -ExpectedPhase ([string]$config.phase) -MonitorStartedAt $monitorStartedAt `
                    -Now $now -StaleSeconds $monitorHeartbeatStaleSeconds
                $armedHeartbeat = $candidateHeartbeat
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if ($null -eq $armedHeartbeat) { throw "Timed out waiting for the AWS monitor to arm the load harness." }

        $preReleaseGeneratorIp = Resolve-GeneratorPublicIp -Config $config
        Write-AtomicJson -Path $generatorIpEvidencePath -Value ([ordered]@{
            runId=$runId;timestamp=[DateTimeOffset]::UtcNow.ToString("o");expectedPublicIp=$expectedGeneratorPublicIp;actualPublicIp=$preReleaseGeneratorIp
        })
        if ($preReleaseGeneratorIp -ne $expectedGeneratorPublicIp) {
            throw "Generator public IPv4 changed during supervised startup."
        }
        if ($null -ne $certificationContract) {
            # Re-read every hashed fixture/schema input and re-observe all four
            # active/rollback task identities immediately before traffic.
            $certificationContract = Get-CertificationContract -Config $config -TestMode $testMode -BindHarnessArtifacts:($SupervisionKind -eq "Load")
            Assert-CertificationOperatorConfigUnchanged
            $preTrafficRollbackBinding = Assert-CertificationRollbackConfigBinding -Config $config -Contract $certificationContract
            if ($preTrafficRollbackBinding.sha256 -ne $boundRollbackConfigBinding.sha256) { throw "Bound rollback config changed before traffic." }
            Assert-CertificationChainContinuity -Config $config -Contract $certificationContract
            Assert-CertificationActualWaf800Window -Contract $certificationContract -ActualStart ([DateTimeOffset]::UtcNow)
            $preTrafficPreflight = Get-CertificationTaskPreflight -Config $config -Contract $certificationContract
            $chainRootBinding = Get-CertificationChainRootBinding -Contract $certificationContract -Preflight $preTrafficPreflight `
                -Receipt $validationReceiptBinding -GeneratorIp $preReleaseGeneratorIp -OutputPath $chainRootOutputPath
            $stageAttestationBinding = Write-CertificationStageAttestation -Contract $certificationContract `
                -Preflight $preTrafficPreflight -ChainRoot $chainRootBinding -Receipt $validationReceiptBinding `
                -GeneratorIp $preReleaseGeneratorIp -Path $stageAttestationPath
        }
        $monitor.Refresh()
        if ($monitor.HasExited) { throw "The AWS monitor exited before releasing the load harness." }
        $harness.Refresh()
        if ($harness.HasExited) { throw "The load harness exited before the AWS monitor start gate could be released." }
        if (-not (Test-Path -LiteralPath $monitorHeartbeatPath -PathType Leaf)) {
            throw "The AWS monitor heartbeat disappeared before releasing the load harness."
        }
        try { $releaseHeartbeat = Read-AtomicJson -Path $monitorHeartbeatPath }
        catch { throw "The AWS monitor release heartbeat is invalid: $($_.Exception.Message)" }
        Assert-HealthyMonitorArmingHeartbeat -Heartbeat $releaseHeartbeat -ExpectedRunId $runId `
            -ExpectedPhase ([string]$config.phase) -MonitorStartedAt $monitorStartedAt `
            -Now ([DateTimeOffset]::UtcNow) -StaleSeconds $monitorHeartbeatStaleSeconds
        Write-AtomicJson -Path $harnessStartGatePath -Value ([ordered]@{
            schemaVersion = 1; type = "load_supervisor_start"; runId = $runId;
            harnessProcessId = $harness.Id; monitorProcessId = $monitor.Id;
            releasedAt = [DateTimeOffset]::UtcNow.ToString("o")
        })
    }

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
    if (-not (Test-Path -LiteralPath $monitorResultPath -PathType Leaf)) {
        throw "The monitor exited successfully without a terminal monitor result."
    }
    $terminalMonitor = Get-Content -LiteralPath $monitorResultPath -Raw | ConvertFrom-Json -Depth 60
    if ([string]$terminalMonitor.runId -ne $runId -or [string]$terminalMonitor.phase -ne [string]$config.phase -or
        [string]$terminalMonitor.status -ne "completed" -or $terminalMonitor.postureAccepted -ne $true -or
        $terminalMonitor.acceptance.passed -ne $true) {
        throw "The monitor terminal result is not accepted evidence for this exact supervised stage."
    }
    if ($null -ne $certificationContract -and ($null -eq $chainRootBinding -or $null -eq $stageAttestationBinding)) {
        throw "Certification stage/root attestations were not sealed before traffic."
    }
    $monitorResultSha256 = Get-CertificationSha256 $monitorResultPath
    $predecessorSha = [string](Get-CertificationValue $config "predecessorResultSha256" "")
    $linkInput = (@(
        [string](Get-CertificationValue $chainRootBinding "sha256" ("0"*64)),
        $(if ($predecessorSha) { $predecessorSha } else { "0"*64 }),
        [string](Get-CertificationValue $stageAttestationBinding "sha256" ("0"*64)),
        $monitorResultSha256
    ) -join "`n")
    Write-AtomicJson -Path $supervisorResultPath -Value ([ordered]@{
        schemaVersion = 2; type = "certification_supervisor_terminal"; supervisorSealed = $null -ne $certificationContract
        runId = $runId; phase = [string]$config.phase
        stage = if ($null -eq (Get-CertificationValue $config "workload")) { $null } else { [string]$config.workload.stage }
        chainId = if ($null -eq $certificationContract) { $null } else { $certificationContract.ChainId }
        applicationGitSha = if ($null -eq $certificationContract) { $null } else { $certificationContract.ApplicationGitSha }
        deployedImageDigest = if ($null -eq $certificationContract) { $null } else { $certificationContract.DeployedImageDigest }
        controllerGitSha = if ($null -eq $certificationContract) { $null } else { $certificationContract.ControllerGitSha }
        controllerHashes = if ($null -eq $certificationContract) { $null } else { $certificationContract.ControllerHashes }
        operatorConfigSha256 = if ($null -eq $certificationContract) { $null } else { Get-CertificationConfigHash }
        boundRuntimeConfigSha256 = $boundRuntimeConfigSha256
        rollbackConfig = $boundRollbackConfigBinding
        status = "completed"; supervisionKind = $SupervisionKind; timestamp = [DateTimeOffset]::UtcNow.ToString("o")
        monitorExitCode = 0; harnessExitCode = if ($SupervisionKind -eq "Load") { 0 } else { $null }
        chainRoot = $chainRootBinding; stageAttestation = $stageAttestationBinding
        predecessorSupervisorResultSha256 = if ($predecessorSha) { $predecessorSha } else { $null }
        terminalMonitorResult = [ordered]@{path=$monitorResultPath;sha256=$monitorResultSha256;runId=$runId;phase=[string]$config.phase}
        linkSha256 = Get-CertificationTextSha256 $linkInput
    })
}
catch {
    Stop-BoundProcess -Process $harness
    Stop-BoundProcess -Process $monitor
    $termination = if ($SupervisionKind -eq "Load") { "Traffic was terminated" } else { "Monitor-only supervision was terminated" }
    $message = "Run $runId became invalid because $($_.Exception.Message). $termination; no infrastructure mutation was attempted by the supervisor."
    Send-SupervisorNotification -Config $config -Message $message
    Write-AtomicJson -Path $supervisorResultPath -Value ([ordered]@{
        schemaVersion=2;type="certification_supervisor_terminal";supervisorSealed=$false
        runId = $runId; phase=[string]$config.phase; status = "failed"; timestamp = [DateTimeOffset]::UtcNow.ToString("o"); error = $_.Exception.Message
    })
    throw
}
finally {
    Stop-BoundProcess -Process $harness
    Stop-BoundProcess -Process $monitor
    if ($sleepPreventionEnabled) { try { Set-SleepPrevention -Enabled $false } catch { } }
}
