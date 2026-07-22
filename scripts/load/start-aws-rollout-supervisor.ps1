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
$script:RequiredWorkloadSchemaVersion = "classpilot-tile-batch-v1"
$script:RequiredWorkloadEndpointShapeSha256 = "8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"
$script:RequiredPollAccountingVersion = "staggered-deadline-v1"
$script:RequiredHistoryFallbackQueryIdentityVersion = "history-fallback-queryid-v1"
$script:RequiredHistoryFallbackPiEvidenceVersion = "queryid-sqlstats-v1"
$script:RequiredHistoryFallbackPiLinkVersion = "history-fallback-pi-link-v2"
$script:RequiredDatabaseInsightsLeaseVersion = "database-insights-monitoring-lease-v2"
$script:RequiredDatabaseInsightsDurableRestoreGuardVersion = "aws-scheduler-ssm-recurring-restore-v1"
$script:RequiredDatabaseInsightsDurableRestoreAutomationVersion = "ssm-rds-monitoring-restore-v1"

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
    $managedEnvironment = [ordered]@{
        LOAD_RUN_ID = $runId
        LOAD_DIAGNOSTIC_ONLY = "false"
        LOAD_WORKLOAD_SCHEMA_VERSION = $script:RequiredWorkloadSchemaVersion
        LOAD_TILE_HISTORY_PATH = "/api/classpilot/tiles/history"
        LOAD_TILE_SCREENSHOTS_PATH = "/api/classpilot/tiles/screenshots"
        LOAD_TEACHER_PATHS = "/api/students-aggregated"
        LOAD_DASHBOARD_PATHS = ""
        LOAD_SCREENSHOT_GET_PATH_TEMPLATE = ""
    }
    $previousEnvironment = @{}
    try {
        foreach ($entry in $managedEnvironment.GetEnumerator()) {
            $previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
            [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
        }
        $raw = @(& $NodePath $HarnessPath "--validate-config" 2>$null)
    }
    finally {
        foreach ($entry in $previousEnvironment.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
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
    if (-not $testMode -and (
        [string]$result.workloadSchemaVersion -cne $script:RequiredWorkloadSchemaVersion -or
        [string]$result.workloadEndpointShapeSha256 -cne $script:RequiredWorkloadEndpointShapeSha256 -or
        [string]$Config.workload.workloadSchemaVersion -cne $script:RequiredWorkloadSchemaVersion -or
        [string]$Config.workload.endpointShapeSha256 -cne $script:RequiredWorkloadEndpointShapeSha256)) {
        throw "The load harness preflight did not prove the reviewed tile-batch workload schema and endpoint shape."
    }
    if (-not $testMode) {
        $contract = $result.launchContract
        $expectedPrimary = [int]$Config.workload.devices - [int]$Config.workload.canaryDevices
        $expectedTargets = if ($expectedPrimary -eq 500) { 25 } elseif ($expectedPrimary -in @(800,1000)) { 40 } else { 0 }
        if ($null -eq $contract -or
            [string]$contract.workloadSchemaVersion -cne $script:RequiredWorkloadSchemaVersion -or
            [string]$contract.endpointShapeSha256 -cne $script:RequiredWorkloadEndpointShapeSha256 -or
            [int]$contract.tileBatchRequestsPerCohort -ne 2 -or
            [int]$contract.tileLogicalOperationsPerPoll -ne (2 * $expectedPrimary) -or
            [int]$contract.totalSockets -ne [int]$Config.workload.devices -or
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
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    $member = $Object.PSObject.Properties[$Name]
    if ($null -eq $member) { return $Default }
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

function Get-CertificationCanonicalSha256 {
    param($Value)
    return Get-CertificationTextSha256 ($Value | ConvertTo-Json -Depth 60 -Compress)
}

function Test-CertificationFiniteNonnegativeNumber {
    param($Value)
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [char] -or
        $Value -isnot [ValueType]) {
        return $false
    }
    try { $number = [double]$Value } catch { return $false }
    return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number) -and
        $number -ge 0
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

function New-CertificationTerminalFailureException {
    param([string]$FailureCode, [string]$FailureStage, [string]$Message)
    $failure = [InvalidOperationException]::new($Message)
    $failure.Data["failureCode"] = $FailureCode
    $failure.Data["failureStage"] = $FailureStage
    return $failure
}

function Assert-CertificationPrivateFileAcl {
    param([string]$Path, [string]$Name)
    if (-not $IsWindows) { throw "$Name requires Windows ACL enforcement." }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $item = Get-Item -LiteralPath $Path
    $acl = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, [Security.AccessControl.AccessControlSections]::Access
    )
    if (-not $acl.AreAccessRulesProtected) { throw "$Name must disable inherited file access." }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 1) { throw "$Name must be readable only by the current certification operator." }
    $rule = $rules[0]
    if ($rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.IdentityReference.Value -cne $currentSid -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw "$Name must have one exact current-operator FullControl rule."
    }
}

function Get-CertificationHistoryFallbackQueryIdentity {
    param($Certification, [string]$ApplicationGitSha, [string]$DeployedImageDigest, [string]$ActiveApiArn, [string]$ActiveWorkerArn)
    $piEvidenceVersion = [string](Get-RequiredProperty $Certification "historyFallbackPiEvidenceVersion")
    if ($piEvidenceVersion -cne $script:RequiredHistoryFallbackPiEvidenceVersion) {
        throw "Certification must bind the deterministic queryid SQL-statistics PI evidence version."
    }
    $reference = Assert-CertificationEvidenceReference `
        (Get-RequiredProperty $Certification "historyFallbackQueryIdentity") `
        "certification.historyFallbackQueryIdentity"
    Assert-CertificationPrivateFileAcl $reference.path "certification.historyFallbackQueryIdentity"
    try { $receipt = Get-Content -LiteralPath $reference.path -Raw | ConvertFrom-Json -Depth 30 }
    catch { throw "The history fallback query-identity receipt must contain valid JSON." }

    $version = [string](Get-CertificationValue $receipt "identityVersion" "")
    $queryIdentifier = [string](Get-CertificationValue $receipt "queryIdentifier" "")
    $queryIdentifierSha256 = Assert-CertificationSha256 `
        ([string](Get-CertificationValue $receipt "queryIdentifierSha256" "")) `
        "historyFallbackQueryIdentity.queryIdentifierSha256"
    $compiledSqlSha256 = Assert-CertificationSha256 `
        ([string](Get-CertificationValue $receipt "compiledSqlSha256" "")) `
        "historyFallbackQueryIdentity.compiledSqlSha256"
    $parameterTypeSignatureSha256 = Assert-CertificationSha256 `
        ([string](Get-CertificationValue $receipt "parameterTypeSignatureSha256" "")) `
        "historyFallbackQueryIdentity.parameterTypeSignatureSha256"
    $schemaIdentitySha256 = Assert-CertificationSha256 `
        ([string](Get-CertificationValue $receipt "schemaIdentitySha256" "")) `
        "historyFallbackQueryIdentity.schemaIdentitySha256"
    $expectedParameterSignatureSha256 = Get-CertificationTextSha256 `
        '["$1:text[]:student_ids","$2:text[]:device_ids","$3:text:school_id","$4:bigint:history_limit"]'
    $queryId = [Numerics.BigInteger]::Zero
    if ([int](Get-CertificationValue $receipt "schemaVersion" 0) -ne 1 -or
        [string](Get-CertificationValue $receipt "type" "") -cne "history_fallback_query_identity_receipt" -or
        $version -cne $script:RequiredHistoryFallbackQueryIdentityVersion -or
        $queryIdentifier -notmatch '^-?(?:[1-9][0-9]{0,18})$' -or
        -not [Numerics.BigInteger]::TryParse($queryIdentifier, [ref]$queryId) -or
        $queryId -eq [Numerics.BigInteger]::Zero -or
        $queryId -lt [Numerics.BigInteger]::Parse("-9223372036854775808") -or
        $queryId -gt [Numerics.BigInteger]::Parse("9223372036854775807") -or
        $queryIdentifierSha256 -cne (Get-CertificationTextSha256 $queryIdentifier) -or
        $parameterTypeSignatureSha256 -cne $expectedParameterSignatureSha256) {
        throw "The history fallback query identifier must be one exact nonzero signed PostgreSQL 64-bit identifier with a matching hash."
    }
    $engineVersion = [string](Get-CertificationValue $receipt "engineVersion" "")
    $databaseResourceId = [string](Get-CertificationValue $receipt "databaseResourceId" "")
    if ($engineVersion -notmatch '^[0-9]+(?:\.[0-9]+){0,2}$' -or
        $databaseResourceId -notmatch '^db-[A-Z0-9]{20,64}$' -or
        (Get-CertificationValue $receipt "trackIoTiming" $false) -ne $true -or
        [string](Get-CertificationValue $receipt "applicationGitSha" "") -cne $ApplicationGitSha -or
        [string](Get-CertificationValue $receipt "deployedImageDigest" "") -cne $DeployedImageDigest -or
        [string](Get-CertificationValue $receipt "activeApiTaskDefinitionArn" "") -cne $ActiveApiArn -or
        [string](Get-CertificationValue $receipt "activeWorkerTaskDefinitionArn" "") -cne $ActiveWorkerArn) {
        throw "The history fallback query-identity receipt is not bound to the exact database, release, and active task revisions."
    }
    return [pscustomobject]@{
        Public = [ordered]@{
            # The receipt is ACL-restricted because it contains the native
            # signed query identifier.  Public attestations bind its content
            # and location without publishing the private filesystem path.
            receiptSha256 = $reference.sha256
            receiptPathSha256 = Get-CertificationTextSha256 $reference.path
            version = $version
            queryIdentifierSha256 = $queryIdentifierSha256
            compiledSqlSha256 = $compiledSqlSha256
            parameterTypeSignatureSha256 = $parameterTypeSignatureSha256
            engineVersion = $engineVersion
            schemaIdentitySha256 = $schemaIdentitySha256
            trackIoTiming = $true
            databaseResourceIdSha256 = Get-CertificationTextSha256 $databaseResourceId
            piEvidenceVersion = $piEvidenceVersion
        }
        Receipt = $reference
        DatabaseResourceId = $databaseResourceId
        EngineVersion = $engineVersion
    }
}

function Get-CertificationDatabaseInsightsLease {
    param($Config, $HistoryFallbackQueryIdentity, [string]$ExpectedRdsClass)
    $leaseConfig = Get-RequiredProperty $Config "databaseInsightsLease"
    if ([string](Get-RequiredProperty $leaseConfig "version") -cne $script:RequiredDatabaseInsightsLeaseVersion) {
        throw "Certification must bind the reviewed Database Insights monitoring lease version."
    }
    $reference = Assert-CertificationEvidenceReference ([pscustomobject]@{
        path = [string](Get-RequiredProperty $leaseConfig "receiptPath")
        sha256 = [string](Get-RequiredProperty $leaseConfig "receiptSha256")
    }) "databaseInsightsLease"
    Assert-CertificationPrivateFileAcl $reference.path "databaseInsightsLease.receipt"
    try { $receipt = Get-Content -LiteralPath $reference.path -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "The Database Insights monitoring lease receipt must contain valid JSON." }

    $capturedAt = [DateTimeOffset]::MinValue
    $expiresAt = [DateTimeOffset]::MinValue
    $deadline = [DateTimeOffset]::MinValue
    $leaseId = [string](Get-CertificationValue $receipt "leaseId" "")
    $initial = Get-CertificationValue $receipt "initialPosture"
    $requested = Get-CertificationValue $receipt "requestedPosture"
    $durableGuard = Get-CertificationValue $receipt "durableRestoreGuard"
    if ($null -eq $durableGuard) {
        throw "The Database Insights lease is not the exact certification-purpose Standard/7 to Advanced/465 lease for this database."
    }
    $parameterStatuses = @(
        @(Get-CertificationValue $initial "parameterApplyStatuses" @()) |
            ForEach-Object { [string]$_ }
    )
    $performanceInsightsKmsKeyId = [string](Get-CertificationValue $initial "performanceInsightsKmsKeyId" "")
    $monitoringInterval = [int](Get-CertificationValue $initial "monitoringInterval" -1)
    $monitoringRoleArn = [string](Get-CertificationValue $initial "monitoringRoleArn" "")
    $enabledLogExports = @(
        @(Get-CertificationValue $initial "enabledCloudwatchLogsExports" @()) |
            ForEach-Object { [string]$_ } |
            Sort-Object -Unique
    )
    $preservedMonitoringPosture = [ordered]@{
        performanceInsightsKmsKeyId=$performanceInsightsKmsKeyId
        monitoringInterval=$monitoringInterval
        monitoringRoleArn=$monitoringRoleArn
        enabledCloudwatchLogsExports=$enabledLogExports
    }
    $preservedMonitoringPostureSha256 = Get-CertificationTextSha256 `
        ($preservedMonitoringPosture | ConvertTo-Json -Depth 10 -Compress)
    if (-not [DateTimeOffset]::TryParse([string](Get-CertificationValue $receipt "capturedAtUtc" ""), [ref]$capturedAt) -or
        -not [DateTimeOffset]::TryParse([string](Get-CertificationValue $receipt "expiresAtUtc" ""), [ref]$expiresAt) -or
        -not [DateTimeOffset]::TryParse([string](Get-RequiredProperty $Config "deadlineUtc"), [ref]$deadline) -or
        $expiresAt -le $capturedAt -or $expiresAt -gt $capturedAt.AddHours(12) -or
        $expiresAt.ToUniversalTime() -le [DateTimeOffset]::UtcNow -or
        $expiresAt.ToUniversalTime() -le $deadline.ToUniversalTime()) {
        throw "The certification Database Insights lease must remain valid through the bound stage deadline."
    }
    $durableExpiresAt = $expiresAt.ToUniversalTime().ToString("o")
    $durableDatabaseIdentitySha256 = Get-CertificationTextSha256 `
        "135775632425|us-east-1|schoolpilot-production-db"
    $durableScheduleName = "db-insights-restore-$($durableDatabaseIdentitySha256.Substring(0, 24))"
    $durableLeaseIdSha256 = Get-CertificationTextSha256 $leaseId
    $durableDescriptionBindingSha256 = Get-CertificationTextSha256 `
        "135775632425|us-east-1|schoolpilot-production-db|$durableExpiresAt|$durableLeaseIdSha256"
    $automationDocumentName = "schoolpilot-production-db-insights-restore-v1"
    $automationDocumentVersion = "1"
    $automationDocumentContentSha256 = Assert-CertificationSha256 `
        ([string](Get-CertificationValue $durableGuard "automationDocumentContentSha256" "")) `
        "databaseInsightsLease.durableRestoreGuard.automationDocumentContentSha256"
    $automationDefinitionArn = `
        'arn:aws:ssm:us-east-1:135775632425:automation-definition/schoolpilot-production-db-insights-restore-v1:1'
    $automationRoleArn = `
        "arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore-automation"
    $automationFailureRuleArn = `
        "arn:aws:events:us-east-1:135775632425:rule/schoolpilot-production-db-insights-restore-failed"
    $expectedLogExportsJson = @($enabledLogExports) | ConvertTo-Json -Compress -AsArray
    $durableTargetInput = [ordered]@{
        DocumentName = $automationDocumentName
        DocumentVersion = $automationDocumentVersion
        Parameters = [ordered]@{
            AutomationAssumeRole = @($automationRoleArn)
            DBInstanceIdentifier = @("schoolpilot-production-db")
            ExpectedDBInstanceArn = @("arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db")
            ExpectedDatabaseResourceId = @([string]$initial.databaseResourceId)
            ExpectedDBInstanceClass = @([string]$initial.instanceClass)
            ExpectedEngineVersion = @([string]$initial.engineVersion)
            ExpectedPerformanceInsightsKmsKeyId = @($performanceInsightsKmsKeyId)
            ExpectedMonitoringInterval = @([string]$monitoringInterval)
            ExpectedMonitoringRoleArn = @($monitoringRoleArn)
            ExpectedLogExportsJson = @($expectedLogExportsJson)
            FailureQueueUrl = @("https://sqs.us-east-1.amazonaws.com/135775632425/schoolpilot-production-db-insights-restore-dlq")
            RestoreScheduleName = @($durableScheduleName)
            RestoreScheduleGroupName = @("schoolpilot-production-db-insights-leases")
            AutomationDocumentContentSha256 = @($automationDocumentContentSha256)
            LeaseIdSha256 = @($durableLeaseIdSha256)
            ExpiresAtUtc = @($durableExpiresAt)
            RestoreMode = @("scheduled")
        }
    } | ConvertTo-Json -Depth 20 -Compress
    $expectedDurableGuard = [ordered]@{
        version=$script:RequiredDatabaseInsightsDurableRestoreGuardVersion
        accountId="135775632425";region="us-east-1";dbInstanceIdentifier="schoolpilot-production-db"
        dbInstanceArn="arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db"
        expiresAtUtc=$durableExpiresAt;scheduleName=$durableScheduleName
        scheduleGroupName="schoolpilot-production-db-insights-leases"
        scheduleArn="arn:aws:scheduler:us-east-1:135775632425:schedule/schoolpilot-production-db-insights-leases/$durableScheduleName"
        scheduleExpression="rate(15 minutes)";scheduleStartAtUtc=$durableExpiresAt
        scheduleExpressionTimezone="UTC";actionAfterCompletion="NONE";state="ENABLED"
        description="SchoolPilot db-insights restore v2 lease=$durableLeaseIdSha256 binding=$durableDescriptionBindingSha256"
        targetArn="arn:aws:scheduler:::aws-sdk:ssm:startAutomationExecution"
        automationVersion=$script:RequiredDatabaseInsightsDurableRestoreAutomationVersion
        automationDocumentName=$automationDocumentName
        automationDocumentVersion=$automationDocumentVersion
        automationDocumentContentSha256=$automationDocumentContentSha256
        automationDefinitionArn=$automationDefinitionArn
        automationRoleArn=$automationRoleArn
        automationFailureRuleArn=$automationFailureRuleArn
        targetRoleArn="arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore"
        deadLetterQueueArn="arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq"
        targetInput=$durableTargetInput;maximumEventAgeInSeconds=60;maximumRetryAttempts=0
    }
    $expectedDurableGuardBindingSha256 = Get-CertificationTextSha256 `
        ($expectedDurableGuard | ConvertTo-Json -Depth 20 -Compress)
    $observedDurableExpiresAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse(
        [string](Get-CertificationValue $durableGuard "expiresAtUtc" ""),
        [ref]$observedDurableExpiresAt
    )) {
        throw "The certification Database Insights durable restore guard has an invalid expiration."
    }
    $observedDurableGuard = [ordered]@{
        version=[string](Get-CertificationValue $durableGuard "version" "")
        accountId=[string](Get-CertificationValue $durableGuard "accountId" "")
        region=[string](Get-CertificationValue $durableGuard "region" "")
        dbInstanceIdentifier=[string](Get-CertificationValue $durableGuard "dbInstanceIdentifier" "")
        dbInstanceArn=[string](Get-CertificationValue $durableGuard "dbInstanceArn" "")
        expiresAtUtc=$observedDurableExpiresAt.ToUniversalTime().ToString("o")
        scheduleName=[string](Get-CertificationValue $durableGuard "scheduleName" "")
        scheduleGroupName=[string](Get-CertificationValue $durableGuard "scheduleGroupName" "")
        scheduleArn=[string](Get-CertificationValue $durableGuard "scheduleArn" "")
        scheduleExpression=[string](Get-CertificationValue $durableGuard "scheduleExpression" "")
        scheduleStartAtUtc=(ConvertTo-CertificationUtcTimestamp `
            (Get-CertificationValue $durableGuard "scheduleStartAtUtc" "") `
            "databaseInsightsLease.durableRestoreGuard.scheduleStartAtUtc").ToString("o")
        scheduleExpressionTimezone=[string](Get-CertificationValue $durableGuard "scheduleExpressionTimezone" "")
        actionAfterCompletion=[string](Get-CertificationValue $durableGuard "actionAfterCompletion" "")
        state=[string](Get-CertificationValue $durableGuard "state" "")
        description=[string](Get-CertificationValue $durableGuard "description" "")
        targetArn=[string](Get-CertificationValue $durableGuard "targetArn" "")
        automationVersion=[string](Get-CertificationValue $durableGuard "automationVersion" "")
        automationDocumentName=[string](Get-CertificationValue $durableGuard "automationDocumentName" "")
        automationDocumentVersion=[string](Get-CertificationValue $durableGuard "automationDocumentVersion" "")
        automationDocumentContentSha256=[string](Get-CertificationValue $durableGuard "automationDocumentContentSha256" "")
        automationDefinitionArn=[string](Get-CertificationValue $durableGuard "automationDefinitionArn" "")
        automationRoleArn=[string](Get-CertificationValue $durableGuard "automationRoleArn" "")
        automationFailureRuleArn=[string](Get-CertificationValue $durableGuard "automationFailureRuleArn" "")
        targetRoleArn=[string](Get-CertificationValue $durableGuard "targetRoleArn" "")
        deadLetterQueueArn=[string](Get-CertificationValue $durableGuard "deadLetterQueueArn" "")
        targetInput=[string](Get-CertificationValue $durableGuard "targetInput" "")
        maximumEventAgeInSeconds=[int](Get-CertificationValue $durableGuard "maximumEventAgeInSeconds" 0)
        maximumRetryAttempts=[int](Get-CertificationValue $durableGuard "maximumRetryAttempts" -1)
    }
    $observedDurableGuardBindingSha256 = Get-CertificationTextSha256 `
        ($observedDurableGuard | ConvertTo-Json -Depth 20 -Compress)
    if ([int](Get-CertificationValue $receipt "schemaVersion" 0) -ne 2 -or
        [string](Get-CertificationValue $receipt "type" "") -cne "database_insights_monitoring_lease" -or
        [string](Get-CertificationValue $receipt "leaseVersion" "") -cne $script:RequiredDatabaseInsightsLeaseVersion -or
        $leaseId -notmatch '^[0-9a-f]{32}$' -or
        [string](Get-CertificationValue $receipt "leasePurpose" "") -cne "certification" -or
        [string](Get-CertificationValue $receipt "accountId" "") -cne "135775632425" -or
        [string](Get-CertificationValue $receipt "region" "") -cne "us-east-1" -or
        [string](Get-CertificationValue $receipt "dbInstanceIdentifier" "") -cne "schoolpilot-production-db" -or
        [string](Get-CertificationValue $receipt "expectedRdsInstanceClass" "") -cne $ExpectedRdsClass -or
        [string](Get-CertificationValue $initial "dbInstanceIdentifier" "") -cne "schoolpilot-production-db" -or
        [string](Get-CertificationValue $initial "databaseResourceId" "") -cne [string]$HistoryFallbackQueryIdentity.DatabaseResourceId -or
        [string](Get-CertificationValue $initial "status" "") -cne "available" -or
        [string](Get-CertificationValue $initial "instanceClass" "") -cne $ExpectedRdsClass -or
        [string](Get-CertificationValue $initial "engine" "") -cne "postgres" -or
        [string](Get-CertificationValue $initial "engineVersion" "") -cne [string]$HistoryFallbackQueryIdentity.EngineVersion -or
        [string](Get-CertificationValue $initial "databaseInsightsMode" "") -cne "standard" -or
        (Get-CertificationValue $initial "performanceInsightsEnabled" $false) -ne $true -or
        [int](Get-CertificationValue $initial "performanceInsightsRetentionPeriod" 0) -ne 7 -or
        [string]::IsNullOrWhiteSpace($performanceInsightsKmsKeyId) -or
        $monitoringInterval -lt 0 -or $monitoringInterval -gt 60 -or
        ($monitoringInterval -gt 0 -and [string]::IsNullOrWhiteSpace($monitoringRoleArn)) -or
        @($enabledLogExports | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or
        (Get-CertificationValue $initial "pendingModifiedValuesAbsent" $false) -ne $true -or
        [string](Get-CertificationValue $initial "dbInstanceArn" "") -notmatch '^arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db$' -or
        $parameterStatuses.Count -lt 1 -or @($parameterStatuses | Where-Object { $_ -cne "in-sync" }).Count -gt 0 -or
        [string](Get-CertificationValue $requested "databaseInsightsMode" "") -cne "advanced" -or
        (Get-CertificationValue $requested "performanceInsightsEnabled" $false) -ne $true -or
        [int](Get-CertificationValue $requested "performanceInsightsRetentionPeriod" 0) -ne 465 -or
        [string](Get-CertificationValue $requested "preservedMonitoringPostureSha256" "") -cne $preservedMonitoringPostureSha256 -or
        [string](Get-CertificationValue $durableGuard "bindingSha256" "") -cne $expectedDurableGuardBindingSha256 -or
        $observedDurableGuardBindingSha256 -cne $expectedDurableGuardBindingSha256) {
        throw "The Database Insights lease is not the exact certification-purpose Standard/7 to Advanced/465 lease for this database."
    }
    return [pscustomobject]@{
        Public = [ordered]@{
            receipt = [ordered]@{
                sha256=$reference.sha256
                pathSha256=Get-CertificationTextSha256 $reference.path
            }
            version = $script:RequiredDatabaseInsightsLeaseVersion
            leaseIdSha256 = Get-CertificationTextSha256 $leaseId
            leasePurpose = "certification"
            accountId = "135775632425"
            region = "us-east-1"
            dbInstanceIdentifier = "schoolpilot-production-db"
            expectedRdsInstanceClass = $ExpectedRdsClass
            databaseResourceIdSha256 = Get-CertificationTextSha256 ([string]$initial.databaseResourceId)
            initialPosture = [ordered]@{
                databaseInsightsMode = "standard"
                performanceInsightsEnabled = $true
                performanceInsightsRetentionPeriod = 7
                performanceInsightsKmsKeyIdSha256 = Get-CertificationTextSha256 $performanceInsightsKmsKeyId
                monitoringInterval = $monitoringInterval
                monitoringRoleArnSha256 = if($monitoringRoleArn){Get-CertificationTextSha256 $monitoringRoleArn}else{$null}
                enabledCloudwatchLogsExports = $enabledLogExports
                preservedMonitoringPostureSha256 = $preservedMonitoringPostureSha256
            }
            requestedPosture = [ordered]@{
                databaseInsightsMode = "advanced"
                performanceInsightsEnabled = $true
                performanceInsightsRetentionPeriod = 465
                preservedMonitoringPostureSha256 = $preservedMonitoringPostureSha256
            }
            durableRestoreGuard = [ordered]@{
                version=$script:RequiredDatabaseInsightsDurableRestoreGuardVersion
                bindingSha256=$expectedDurableGuardBindingSha256
                scheduleArnSha256=Get-CertificationTextSha256 ([string]$expectedDurableGuard.scheduleArn)
                targetRoleArnSha256=Get-CertificationTextSha256 ([string]$expectedDurableGuard.targetRoleArn)
                deadLetterQueueArnSha256=Get-CertificationTextSha256 ([string]$expectedDurableGuard.deadLetterQueueArn)
                automationDocumentVersion=$automationDocumentVersion
                automationDocumentContentSha256=$automationDocumentContentSha256
                automationDefinitionArnSha256=Get-CertificationTextSha256 ([string]$expectedDurableGuard.automationDefinitionArn)
                automationRoleArnSha256=Get-CertificationTextSha256 ([string]$expectedDurableGuard.automationRoleArn)
                automationFailureRuleArnSha256=Get-CertificationTextSha256 ([string]$expectedDurableGuard.automationFailureRuleArn)
            }
        }
        Receipt = $reference
    }
}

function Assert-CertificationDatabaseInsightsLeaseCommandResult {
    param($Result, $Contract, [ValidateSet("Validate", "Restore")][string]$Mode)
    $lease = $Contract.DatabaseInsightsLease
    $expectedState = if ($Mode -eq "Validate") { "active_validated" } else { "restored" }
    $expectedReceiptPath = [IO.Path]::GetFullPath([string]$Contract.DatabaseInsightsLeaseReceipt.path)
    $expectedStatusPath = [IO.Path]::GetFullPath("$expectedReceiptPath.status.json")
    $expectedWatchdogPath = [IO.Path]::GetFullPath("$expectedReceiptPath.watchdog.json")
    $durableGuard = $lease.durableRestoreGuard
    $expectedDurableState = if ($Mode -eq "Validate") { "armed" } else { "removed" }
    if ([string](Get-CertificationValue $Result "state" "") -cne $expectedState -or
        [string](Get-CertificationValue $Result "receiptPathSha256" "") -cne (Get-CertificationTextSha256 $expectedReceiptPath) -or
        [string](Get-CertificationValue $Result "receiptSha256" "") -cne [string]$lease.receipt.sha256 -or
        [string](Get-CertificationValue $Result "statusPathSha256" "") -cne (Get-CertificationTextSha256 $expectedStatusPath) -or
        [string](Get-CertificationValue $Result "watchdogPathSha256" "") -cne (Get-CertificationTextSha256 $expectedWatchdogPath) -or
        [string](Get-CertificationValue $Result "durableRestoreGuardVersion" "") -cne [string]$durableGuard.version -or
        [string](Get-CertificationValue $Result "durableRestoreGuardBindingSha256" "") -cne [string]$durableGuard.bindingSha256 -or
        [string](Get-CertificationValue $Result "durableRestoreGuardState" "") -cne $expectedDurableState -or
        (Get-CertificationValue $Result "rawPathsPersisted" $true) -ne $false) {
        throw "The Database Insights lease helper returned an identity-mismatched result."
    }
    if ($Mode -eq "Validate") {
        $watchdogHeartbeatSha256 = [string](Get-CertificationValue $Result "watchdogHeartbeatSha256" "")
        [void](Assert-CertificationSha256 $watchdogHeartbeatSha256 "databaseInsightsLease.watchdogHeartbeatSha256")
        if ([string](Get-CertificationValue $Result "watchdogState" "") -notmatch '^(armed|monitoring)$') {
            throw "The Database Insights lease helper did not prove a live bounded watchdog."
        }
        if ([string](Get-CertificationValue $Result "durableRestoreScheduleArnSha256" "") -cne [string]$durableGuard.scheduleArnSha256 -or
            [string](Get-CertificationValue $Result "durableRestoreTargetRoleArnSha256" "") -cne [string]$durableGuard.targetRoleArnSha256 -or
            [string](Get-CertificationValue $Result "durableRestoreDeadLetterQueueArnSha256" "") -cne [string]$durableGuard.deadLetterQueueArnSha256 -or
            [string](Get-CertificationValue $Result "durableRestoreAutomationDefinitionArnSha256" "") -cne [string]$durableGuard.automationDefinitionArnSha256 -or
            [string](Get-CertificationValue $Result "durableRestoreAutomationRoleArnSha256" "") -cne [string]$durableGuard.automationRoleArnSha256 -or
            [string](Get-CertificationValue $Result "durableRestoreAutomationFailureRuleArnSha256" "") -cne [string]$durableGuard.automationFailureRuleArnSha256 -or
            [string](Get-CertificationValue $Result "durableRestoreAutomationDocumentVersion" "") -cne [string]$durableGuard.automationDocumentVersion -or
            [string](Get-CertificationValue $Result "durableRestoreAutomationDocumentContentSha256" "") -cne [string]$durableGuard.automationDocumentContentSha256) {
            throw "The Database Insights lease helper did not prove the exact AWS-native restore schedule, Automation, roles, failure rule, and DLQ."
        }
        return [ordered]@{
            state = "active_validated"
            leaseVersion = $lease.version
            receiptSha256 = $lease.receipt.sha256
            watchdogHeartbeatSha256 = $watchdogHeartbeatSha256
            watchdogState = [string]$Result.watchdogState
            durableRestoreGuardVersion = [string]$durableGuard.version
            durableRestoreGuardBindingSha256 = [string]$durableGuard.bindingSha256
            durableRestoreScheduleArnSha256 = [string]$durableGuard.scheduleArnSha256
            durableRestoreTargetRoleArnSha256 = [string]$durableGuard.targetRoleArnSha256
            durableRestoreDeadLetterQueueArnSha256 = [string]$durableGuard.deadLetterQueueArnSha256
            durableRestoreAutomationDefinitionArnSha256 = [string]$durableGuard.automationDefinitionArnSha256
            durableRestoreAutomationRoleArnSha256 = [string]$durableGuard.automationRoleArnSha256
            durableRestoreAutomationFailureRuleArnSha256 = [string]$durableGuard.automationFailureRuleArnSha256
            durableRestoreAutomationDocumentVersion = [string]$durableGuard.automationDocumentVersion
            durableRestoreAutomationDocumentContentSha256 = [string]$durableGuard.automationDocumentContentSha256
            durableRestoreGuardState = "armed"
            validatedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            nonMutating = $true
        }
    }
    $posture = Get-CertificationValue $Result "posture"
    $parameterStatuses = @(
        @(Get-CertificationValue $posture "parameterApplyStatuses" @()) |
            ForEach-Object { [string]$_ }
    )
    $restoredLogExports = @(
        @(Get-CertificationValue $posture "enabledCloudwatchLogsExports" @()) |
            ForEach-Object { [string]$_ } |
            Sort-Object -Unique
    )
    $restoredKmsHash = Get-CertificationTextSha256 ([string](Get-CertificationValue $posture "performanceInsightsKmsKeyId" ""))
    $restoredRole = [string](Get-CertificationValue $posture "monitoringRoleArn" "")
    $restoredRoleHash = if($restoredRole){Get-CertificationTextSha256 $restoredRole}else{$null}
    if ([string](Get-CertificationValue $posture "dbInstanceIdentifier" "") -cne [string]$lease.dbInstanceIdentifier -or
        (Get-CertificationTextSha256 ([string](Get-CertificationValue $posture "databaseResourceId" ""))) -cne [string]$lease.databaseResourceIdSha256 -or
        [string](Get-CertificationValue $posture "status" "") -cne "available" -or
        [string](Get-CertificationValue $posture "instanceClass" "") -cne [string]$lease.expectedRdsInstanceClass -or
        [string](Get-CertificationValue $posture "engine" "") -cne "postgres" -or
        [string](Get-CertificationValue $posture "engineVersion" "") -cne [string]$Contract.HistoryFallbackQueryIdentity.engineVersion -or
        [string](Get-CertificationValue $posture "databaseInsightsMode" "") -cne "standard" -or
        (Get-CertificationValue $posture "performanceInsightsEnabled" $false) -ne $true -or
        [int](Get-CertificationValue $posture "performanceInsightsRetentionPeriod" 0) -ne 7 -or
        $restoredKmsHash -cne [string]$lease.initialPosture.performanceInsightsKmsKeyIdSha256 -or
        [int](Get-CertificationValue $posture "monitoringInterval" -1) -ne [int]$lease.initialPosture.monitoringInterval -or
        [string]$restoredRoleHash -cne [string]$lease.initialPosture.monitoringRoleArnSha256 -or
        (ConvertTo-CertificationComparableJson $restoredLogExports) -cne
            (ConvertTo-CertificationComparableJson @($lease.initialPosture.enabledCloudwatchLogsExports)) -or
        (Get-CertificationValue $posture "pendingModifiedValuesAbsent" $false) -ne $true -or
        $parameterStatuses.Count -lt 1 -or @($parameterStatuses | Where-Object { $_ -cne "in-sync" }).Count -gt 0) {
        throw "Database Insights restoration did not prove the exact healthy Standard/7 posture."
    }
    return [ordered]@{
        state = "restored"
        leaseVersion = $lease.version
        receiptSha256 = $lease.receipt.sha256
        durableRestoreGuardVersion = [string]$durableGuard.version
        durableRestoreGuardBindingSha256 = [string]$durableGuard.bindingSha256
        durableRestoreGuardState = "removed"
        restoredAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        observedPosture = [ordered]@{
            dbInstanceIdentifier = [string]$posture.dbInstanceIdentifier
            databaseResourceIdSha256 = Get-CertificationTextSha256 ([string]$posture.databaseResourceId)
            status = "available"
            instanceClass = [string]$posture.instanceClass
            engine = "postgres"
            engineVersion = [string]$posture.engineVersion
            databaseInsightsMode = "standard"
            performanceInsightsEnabled = $true
            performanceInsightsRetentionPeriod = 7
            performanceInsightsKmsKeyIdSha256 = $restoredKmsHash
            monitoringInterval = [int]$posture.monitoringInterval
            monitoringRoleArnSha256 = $restoredRoleHash
            enabledCloudwatchLogsExports = $restoredLogExports
            pendingModifiedValuesAbsent = $true
            parameterApplyStatuses = $parameterStatuses
        }
    }
}

function Invoke-CertificationDatabaseInsightsLeaseCommand {
    param($Config, $Contract, [ValidateSet("Validate", "Restore")][string]$Mode)
    if ($null -eq $Contract) { return $null }
    $lease = $Contract.DatabaseInsightsLease
    $leaseScript = Join-Path $PSScriptRoot "database-insights-lease.ps1"
    $output = & $pwsh -NoProfile -File $leaseScript `
        -Mode $Mode `
        -DbInstanceIdentifier ([string]$lease.dbInstanceIdentifier) `
        -ReceiptPath ([string]$Contract.DatabaseInsightsLeaseReceipt.path) `
        -ExpectedReceiptSha256 ([string]$lease.receipt.sha256) `
        -Region ([string]$lease.region) `
        -ExpectedAccountId ([string]$lease.accountId) `
        -ExpectedRdsInstanceClass ([string]$lease.expectedRdsInstanceClass) `
        -LeasePurpose certification `
        -PollSeconds 15 `
        -TimeoutSeconds 900 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "The certification Database Insights lease $Mode operation failed; provider output was discarded."
    }
    try { $result = (($output | Out-String).Trim() | ConvertFrom-Json -Depth 40) }
    catch { throw "The certification Database Insights lease helper returned malformed JSON." }
    return Assert-CertificationDatabaseInsightsLeaseCommandResult $result $Contract $Mode
}

function Set-CertificationPrivateFileAcl {
    param([string]$Path)
    if (-not $IsWindows) { throw "Private certification evidence requires Windows ACL enforcement." }
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $item = Get-Item -LiteralPath $Path
    $security = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, [Security.AccessControl.AccessControlSections]::Access
    )
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($security.GetAccessRules(
            $true, $true, [Security.Principal.SecurityIdentifier]
        ))) {
        [void]$security.RemoveAccessRuleSpecific($existingRule)
    }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $current.User,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]::None,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
    Assert-CertificationPrivateFileAcl $Path "private certification evidence"
}

function Write-CertificationPrivateImmutableJson {
    param([string]$Path, $Value)
    if (Test-Path -LiteralPath $Path) {
        throw "Private certification evidence already exists; use a fresh runId."
    }
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    $stagingDirectory = Join-Path $parent `
        ".$([IO.Path]::GetFileName($Path)).private.$([Guid]::NewGuid().ToString('N'))"
    $temporary = Join-Path $stagingDirectory "payload.json"
    try {
        # Protect an empty staging directory and file before materializing any
        # private evidence beneath a potentially permissive caller-owned parent.
        [void](New-Item -ItemType Directory -Path $stagingDirectory)
        Set-CertificationPrivateFileAcl $stagingDirectory
        $empty = [IO.File]::Open(
            $temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None
        )
        $empty.Dispose()
        Set-CertificationPrivateFileAcl $temporary
        [IO.File]::WriteAllText(
            $temporary,
            ($Value | ConvertTo-Json -Depth 60),
            [Text.UTF8Encoding]::new($false)
        )
        [IO.File]::Move($temporary,$Path)
        Assert-CertificationPrivateFileAcl $Path "private certification evidence"
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
        if (Test-Path -LiteralPath $stagingDirectory -PathType Container) {
            Remove-Item -LiteralPath $stagingDirectory -Force
        }
    }
}

function Get-CertificationCoherentTrafficWindow {
    param([string]$ProgressPath, [string]$SummaryPath, [string]$ExpectedRunId,
        [string]$ExpectedStage, [int]$ExpectedDurationSeconds)
    if (-not (Test-Path -LiteralPath $ProgressPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $SummaryPath -PathType Leaf)) {
        throw "History-fallback PI evidence requires committed progress and summary artifacts."
    }
    $progressText = Get-Content -LiteralPath $ProgressPath -Raw
    if (-not $progressText.EndsWith("`n", [StringComparison]::Ordinal)) {
        throw "The load progress journal does not have a committed terminal newline."
    }
    $events = @()
    foreach ($line in @($progressText -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        try { $events += ,($line | ConvertFrom-Json -Depth 40) }
        catch { throw "The load progress journal contains malformed committed JSON." }
    }
    $starts = @($events | Where-Object {
        [string](Get-CertificationValue $_ "type" "") -ceq "progress" -and
        [string](Get-CertificationValue $_ "event" "") -ceq "start" -and
        [string](Get-CertificationValue $_ "runId" "") -ceq $ExpectedRunId -and
        [string](Get-CertificationValue $_ "stage" "") -ceq $ExpectedStage
    })
    $finals = @($events | Where-Object {
        [string](Get-CertificationValue $_ "event" "") -ceq "final" -and
        [string](Get-CertificationValue $_ "runId" "") -ceq $ExpectedRunId -and
        [string](Get-CertificationValue $_ "stage" "") -ceq $ExpectedStage
    })
    if ($starts.Count -ne 1 -or $finals.Count -ne 1) {
        throw "The load journal must contain exactly one bound start and one bound terminal record."
    }
    try {
        $start = ([DateTimeOffset]([string](Get-CertificationValue $starts[0] "timestamp" ""))).ToUniversalTime()
        $final = ([DateTimeOffset]([string](Get-CertificationValue $finals[0] "timestamp" ""))).ToUniversalTime()
        $summary = Get-Content -LiteralPath $SummaryPath -Raw | ConvertFrom-Json -Depth 60
    }
    catch { throw "The committed load timing evidence is malformed." }
    $run = Get-CertificationValue $summary "run"
    $actualRaw = Get-CertificationValue $run "actualTrafficMilliseconds"
    $plannedRaw = Get-CertificationValue $run "plannedTrafficMilliseconds"
    $targetRaw = Get-CertificationValue $run "runtimeTargetTrafficSeconds"
    $numericTypes = @(
        [TypeCode]::Byte,[TypeCode]::SByte,[TypeCode]::Int16,[TypeCode]::UInt16,
        [TypeCode]::Int32,[TypeCode]::UInt32,[TypeCode]::Int64,[TypeCode]::UInt64,
        [TypeCode]::Single,[TypeCode]::Double,[TypeCode]::Decimal
    )
    if ([Convert]::GetTypeCode($actualRaw) -notin $numericTypes -or
        [Convert]::GetTypeCode($plannedRaw) -notin $numericTypes -or
        [Convert]::GetTypeCode($targetRaw) -notin $numericTypes) {
        throw "The load summary timing fields must be JSON numbers."
    }
    $actualMs = [double]$actualRaw
    $expectedMs = [double]$ExpectedDurationSeconds * 1000.0
    if ([string](Get-CertificationValue $summary "runId" "") -cne $ExpectedRunId -or
        [string](Get-CertificationValue $summary "stage" "") -cne $ExpectedStage -or
        [string](Get-CertificationValue $run "durationClock" "") -cne "monotonic-hrtime-v1" -or
        [string](Get-CertificationValue $run "shutdownReason" "") -cne "duration" -or
        (Get-CertificationValue $run "completedConfiguredDuration" $false) -ne $true -or
        [double]$targetRaw -ne [double]$ExpectedDurationSeconds -or
        [double]$plannedRaw -ne $expectedMs -or
        [double]::IsNaN($actualMs) -or [double]::IsInfinity($actualMs) -or
        $actualMs -lt $expectedMs -or $actualMs -ne [math]::Truncate($actualMs)) {
        throw "The load summary does not prove the exact completed monotonic traffic duration."
    }
    $end = $start.AddMilliseconds($actualMs)
    # The terminal wall timestamp is identity/freshness metadata only.  It is
    # deliberately not compared with the monotonic end: Date.now() may move
    # backward while hrtime continues to prove the complete traffic interval.
    if ($end -le $start -or ($end - $start).TotalHours -gt 2 -or
        $final -gt [DateTimeOffset]::UtcNow.AddSeconds(5)) {
        throw "The coherent traffic window is inconsistent with the committed timing evidence."
    }
    return [ordered]@{ coherent=$true;startUtc=$start.ToString("o");endUtc=$end.ToString("o") }
}

function Get-CertificationApiCloudWatchBinding {
    param($Config, $Contract)
    $region = [string]$Config.resources.region
    $response = Invoke-CertificationAwsJson @(
        "ecs","describe-task-definition","--region",$region,"--task-definition",$Contract.ActiveApiArn
    )
    $task = Get-CertificationValue $response "taskDefinition"
    $containers = @((Get-CertificationValue $task "containerDefinitions" @()) | Where-Object {
        [string](Get-CertificationValue $_ "name" "") -ceq "api"
    })
    if ([string](Get-CertificationValue $task "taskDefinitionArn" "") -cne $Contract.ActiveApiArn -or
        $containers.Count -ne 1) {
        throw "The active API logging identity could not be bound to one exact task revision."
    }
    $logConfiguration = Get-CertificationValue $containers[0] "logConfiguration"
    $options = Get-CertificationValue $logConfiguration "options"
    $driver = [string](Get-CertificationValue $logConfiguration "logDriver" "")
    $logRegion = [string](Get-CertificationValue $options "awslogs-region" "")
    $logGroup = [string](Get-CertificationValue $options "awslogs-group" "")
    $streamPrefix = [string](Get-CertificationValue $options "awslogs-stream-prefix" "")
    if ($driver -cne "awslogs" -or $logRegion -cne $region -or
        $logGroup -notmatch '^[A-Za-z0-9_.\-/#]{1,512}$' -or
        $streamPrefix -notmatch '^[A-Za-z0-9_.\-/#]{1,128}$') {
        throw "The active API task revision has an unsupported CloudWatch log binding."
    }
    return [ordered]@{
        logDriver=$driver;logRegion=$logRegion;logGroupName=$logGroup
        awslogsStreamPrefix=$streamPrefix;apiLogStreamNamePrefix="$streamPrefix/api/"
    }
}

function Assert-CertificationHistoryFallbackPiFinalizationRequest {
    param($Reference, $Contract, $Config, [string]$ExpectedRunId, [string]$ExpectedStage)
    $bound = Assert-CertificationEvidenceReference ([pscustomobject]@{
        path=[string](Get-CertificationValue $Reference "path" "")
        sha256=[string](Get-CertificationValue $Reference "sha256" "")
    }) "historyFallbackPiFinalizationRequest"
    Assert-CertificationPrivateFileAcl $bound.path "historyFallbackPiFinalizationRequest"
    $rawText = Get-Content -LiteralPath $bound.path -Raw
    if ($rawText -match '"queryIdentifier"\s*:') {
        throw "The history-fallback PI request leaked the protected raw query identifier."
    }
    try { $request = $rawText | ConvertFrom-Json -Depth 60 -DateKind String }
    catch { throw "The history-fallback PI request contains malformed JSON." }
    $queryIdentity = $Contract.HistoryFallbackQueryIdentity
    $requestIdentity = Get-CertificationValue $request "historyFallbackSqlIdentity"
    $privateIdentity = Get-CertificationValue $request "historyFallbackQueryIdentity"
    $tasks = Get-CertificationValue $request "taskDefinitions"
    $runtimeBinding = Get-CertificationValue $request "ecsRuntimeBinding"
    $rds = Get-CertificationValue $request "rds"
    $fallback = Get-CertificationValue $request "applicationFallbackDatabaseReadEvidence"
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $privateIdentityPath = [IO.Path]::GetFullPath([string](Get-CertificationValue $privateIdentity "path" ""))
    if ([int](Get-CertificationValue $request "schemaVersion" 0) -ne 1 -or
        [string](Get-CertificationValue $request "type" "") -cne "history_fallback_pi_finalization_request" -or
        [string](Get-CertificationValue $request "historyFallbackPiEvidenceVersion" "") -cne $script:RequiredHistoryFallbackPiEvidenceVersion -or
        [string](Get-CertificationValue $request "evidenceCollectorVersion" "") -cne "post-traffic-v2" -or
        [string](Get-CertificationValue $request "runId" "") -cne $ExpectedRunId -or
        [string](Get-CertificationValue $request "chainId" "") -cne $Contract.ChainId -or
        [string](Get-CertificationValue $request "phase" "") -cne "Waf" -or
        [string](Get-CertificationValue $request "stage" "") -cne $ExpectedStage -or
        [string](Get-CertificationValue $request "applicationGitSha" "") -cne $Contract.ApplicationGitSha -or
        [string](Get-CertificationValue $request "deployedImageDigest" "") -cne $Contract.DeployedImageDigest -or
        [string](Get-CertificationValue $tasks "api" "") -cne $Contract.ActiveApiArn -or
        [string](Get-CertificationValue $tasks "worker" "") -cne $Contract.ActiveWorkerArn -or
        [string](Get-CertificationValue $runtimeBinding "clusterName" "") -cne [string]$Config.resources.cluster -or
        [string](Get-CertificationValue $runtimeBinding "apiServiceName" "") -cne [string]$Config.resources.apiService -or
        [string](Get-CertificationValue $runtimeBinding "workerServiceName" "") -cne [string]$Config.resources.workerService -or
        [string](Get-CertificationValue $rds "databaseResourceId" "") -cne $Contract.HistoryFallbackDatabaseResourceId -or
        [string](Get-CertificationValue $rds "engineVersion" "") -cne $queryIdentity.engineVersion -or
        [string](Get-CertificationValue $rds "expectedInstanceClass" "") -cne "db.t4g.medium" -or
        [string](Get-CertificationValue $rds "region" "") -cne $Contract.DatabaseInsightsLease.region -or
        [string](Get-CertificationValue $rds "accountId" "") -cne $Contract.DatabaseInsightsLease.accountId -or
        [string](Get-CertificationValue $rds "dbInstanceIdentifier" "") -cne $Contract.DatabaseInsightsLease.dbInstanceIdentifier -or
        -not [string]::Equals($privateIdentityPath,
            [IO.Path]::GetFullPath([string]$Contract.HistoryFallbackQueryIdentityReceipt.path),$comparison) -or
        [string](Get-CertificationValue $privateIdentity "sha256" "") -cne $Contract.HistoryFallbackQueryIdentityReceipt.sha256 -or
        [string](Get-CertificationValue $requestIdentity "version" "") -cne $queryIdentity.version -or
        [string](Get-CertificationValue $requestIdentity "queryIdentifierSha256" "") -cne $queryIdentity.queryIdentifierSha256 -or
        [string](Get-CertificationValue $requestIdentity "compiledSqlSha256" "") -cne $queryIdentity.compiledSqlSha256 -or
        [string](Get-CertificationValue $requestIdentity "parameterTypeSignatureSha256" "") -cne $queryIdentity.parameterTypeSignatureSha256 -or
        [string](Get-CertificationValue $requestIdentity "schemaIdentitySha256" "") -cne $queryIdentity.schemaIdentitySha256 -or
        (Get-CertificationValue $requestIdentity "trackIoTiming" $false) -ne $true -or
        [string](Get-CertificationValue $fallback "sourceEvent" "") -cne "classpilot_heartbeat_hot_path_summary" -or
        [string](Get-CertificationValue $fallback "historyFallbackSqlIdentityVersion" "") -cne $queryIdentity.version -or
        [string](Get-CertificationValue $fallback "historyFallbackSqlIdentitySha256" "") -cne $queryIdentity.compiledSqlSha256) {
        throw "The history-fallback PI request is not bound to the exact run, query, release, tasks, and database."
    }
    $window = Get-CertificationValue $request "trafficWindow"
    try {
        $start = ([DateTimeOffset]([string](Get-CertificationValue $window "startUtc" ""))).ToUniversalTime()
        $end = ([DateTimeOffset]([string](Get-CertificationValue $window "endUtc" ""))).ToUniversalTime()
    }
    catch { throw "The history-fallback PI request traffic window is malformed." }
    if ((Get-CertificationValue $window "coherent" $false) -ne $true -or $end -le $start -or
        ($end-$start).TotalHours -gt 2) {
        throw "The history-fallback PI request does not contain a coherent bounded traffic window."
    }
    $trafficWindowSha256 = Get-CertificationCanonicalSha256 ([ordered]@{
        startUtc=$start.ToString("o");endUtc=$end.ToString("o");coherent=$true
    })
    return [pscustomobject]@{
        Reference=$bound;Request=$request;TrafficWindowSha256=$trafficWindowSha256
    }
}

function Assert-CertificationHistoryFallbackPiBucketCoverage {
    param($Coverage, $EvidenceWindow, [object[]]$FallbackIntervals, [long]$ExpectedDatabaseReadCount)
    try {
        $rawEvidenceStart = [DateTimeOffset]([string](Get-CertificationValue $EvidenceWindow "startUtc" ""))
        $rawEvidenceEnd = [DateTimeOffset]([string](Get-CertificationValue $EvidenceWindow "endUtc" ""))
        $evidenceStart = $rawEvidenceStart.ToUniversalTime()
        $evidenceEnd = $rawEvidenceEnd.ToUniversalTime()
    }
    catch { throw "The deterministic PI minute-bucket evidence window is malformed." }
    $durationSeconds = ($evidenceEnd-$evidenceStart).TotalSeconds
    if ($rawEvidenceStart.Offset -ne [TimeSpan]::Zero -or $rawEvidenceEnd.Offset -ne [TimeSpan]::Zero -or
        $evidenceEnd -le $evidenceStart -or $durationSeconds -ne [math]::Floor($durationSeconds) -or
        ([long]$durationSeconds % 60) -ne 0 -or
        ($evidenceStart.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or
        ($evidenceEnd.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or
        [string](Get-CertificationValue $EvidenceWindow "alignment" "") -cne "utc-minute-interior-v1" -or
        [string](Get-CertificationValue $EvidenceWindow "periodAlignment" "") -cne "START_TIME") {
        throw "The deterministic PI minute-bucket evidence window is not exact and aligned."
    }
    $expectedBuckets = [Collections.Generic.List[string]]::new()
    for ($cursor=$evidenceStart; $cursor -lt $evidenceEnd; $cursor=$cursor.AddSeconds(60)) {
        $expectedBuckets.Add($cursor.ToString("o"))
    }
    if ($expectedBuckets.Count -lt 1) { throw "The deterministic PI minute lattice is empty." }

    $ordinalSets = [ordered]@{}
    foreach ($entry in @(
        [pscustomobject]@{Name="observedBucketOrdinals";Key="observed"},
        [pscustomobject]@{Name="positiveCallBucketOrdinals";Key="positive"},
        [pscustomobject]@{Name="applicationActiveBucketOrdinals";Key="active"}
    )) {
        $values = @(Get-CertificationValue $Coverage $entry.Name @())
        $list = [Collections.Generic.List[int]]::new()
        $previous = -1
        foreach ($value in $values) {
            if (-not (Test-CertificationFiniteNonnegativeNumber $value) -or
                [double]$value -ne [math]::Floor([double]$value) -or
                [double]$value -ge $expectedBuckets.Count -or [int]$value -le $previous) {
                throw "The deterministic PI minute-bucket ordinals are malformed or noncanonical."
            }
            $previous = [int]$value
            $list.Add([int]$value)
        }
        $ordinalSets[$entry.Key] = $list
    }
    $observedSet = [Collections.Generic.HashSet[int]]::new([int[]]@($ordinalSets.observed))
    $positiveSet = [Collections.Generic.HashSet[int]]::new([int[]]@($ordinalSets.positive))
    foreach ($ordinal in $positiveSet) {
        if (-not $observedSet.Contains($ordinal)) {
            throw "Positive PI call buckets must be a subset of observed buckets."
        }
    }

    $recomputedActiveSet = [Collections.Generic.HashSet[int]]::new()
    $coveredApplicationWindows = 0
    $positiveCallCoveredApplicationWindows = 0
    $applicationReadCount = 0L
    foreach ($interval in @($FallbackIntervals)) {
        try {
            $rawIntervalStart = [DateTimeOffset]([string](Get-CertificationValue $interval "startUtc" ""))
            $rawIntervalEnd = [DateTimeOffset]([string](Get-CertificationValue $interval "endUtc" ""))
            $intervalStart = $rawIntervalStart.ToUniversalTime()
            $intervalEnd = $rawIntervalEnd.ToUniversalTime()
            $intervalReads = [long](Get-CertificationValue $interval "databaseReadCount")
        }
        catch { throw "The application fallback minute-bucket evidence is malformed." }
        if ($rawIntervalStart.Offset -ne [TimeSpan]::Zero -or $rawIntervalEnd.Offset -ne [TimeSpan]::Zero -or
            $intervalStart -lt $evidenceStart -or $intervalEnd -gt $evidenceEnd -or
            ($intervalEnd-$intervalStart).TotalMilliseconds -ne 60000.0 -or
            ($intervalStart.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or
            ($intervalEnd.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or $intervalReads -le 0) {
            throw "The application fallback minute-bucket evidence is outside the exact evidence window."
        }
        $applicationReadCount += $intervalReads
        $windowCovered = $false
        $windowPositive = $false
        for ($ordinal=0; $ordinal -lt $expectedBuckets.Count; $ordinal++) {
            $bucketStart = [DateTimeOffset]$expectedBuckets[$ordinal]
            $bucketEnd = $bucketStart.AddSeconds(60)
            if ($bucketStart -lt $intervalEnd -and $bucketEnd -gt $intervalStart) {
                [void]$recomputedActiveSet.Add($ordinal)
                if ($observedSet.Contains($ordinal)) { $windowCovered = $true }
                if ($positiveSet.Contains($ordinal)) { $windowPositive = $true }
            }
        }
        if ($windowCovered) { $coveredApplicationWindows++ }
        if ($windowPositive) { $positiveCallCoveredApplicationWindows++ }
    }
    if ($FallbackIntervals.Count -lt 1 -or $applicationReadCount -ne $ExpectedDatabaseReadCount) {
        throw "Application fallback minute buckets do not reconcile to the exact database-read count."
    }
    $recomputedActiveOrdinals = @($recomputedActiveSet | Sort-Object)
    if (@(Compare-Object @($ordinalSets.active) $recomputedActiveOrdinals -SyncWindow 0).Count -ne 0) {
        throw "The claimed application-active PI minute buckets do not match the fallback intervals."
    }
    $missingMiddleCount = 0
    if ($ordinalSets.observed.Count -gt 1) {
        for ($ordinal=$ordinalSets.observed[0]; $ordinal -le $ordinalSets.observed[-1]; $ordinal++) {
            if (-not $observedSet.Contains($ordinal)) { $missingMiddleCount++ }
        }
    }
    $unobservedActiveCount = @($recomputedActiveOrdinals | Where-Object { -not $observedSet.Contains($_) }).Count
    $zeroCallActiveCount = @($recomputedActiveOrdinals | Where-Object {
        $observedSet.Contains($_) -and -not $positiveSet.Contains($_)
    }).Count
    $expectedBucketTexts = @($expectedBuckets)
    $observedBucketTexts = @($ordinalSets.observed | ForEach-Object { $expectedBuckets[$_] })
    $positiveBucketTexts = @($ordinalSets.positive | ForEach-Object { $expectedBuckets[$_] })
    $activeBucketTexts = @($recomputedActiveOrdinals | ForEach-Object { $expectedBuckets[$_] })
    if ([string](Get-CertificationValue $Coverage "coverageContractVersion" "") -cne "queryid-minute-sparse-v1" -or
        [int](Get-CertificationValue $Coverage "periodSeconds" 0) -ne 60 -or
        [int](Get-CertificationValue $Coverage "expectedBucketCount" -1) -ne $expectedBuckets.Count -or
        [int](Get-CertificationValue $Coverage "observedBucketCount" -1) -ne $ordinalSets.observed.Count -or
        [int](Get-CertificationValue $Coverage "positiveCallBucketCount" -1) -ne $ordinalSets.positive.Count -or
        [int](Get-CertificationValue $Coverage "omittedSparseBucketCount" -1) -ne ($expectedBuckets.Count-$ordinalSets.observed.Count) -or
        [int](Get-CertificationValue $Coverage "missingMiddleBucketCount" -1) -ne $missingMiddleCount -or
        [int](Get-CertificationValue $Coverage "applicationFallbackWindowCount" -1) -ne $FallbackIntervals.Count -or
        [int](Get-CertificationValue $Coverage "coveredApplicationFallbackWindowCount" -1) -ne $coveredApplicationWindows -or
        [int](Get-CertificationValue $Coverage "positiveCallCoveredApplicationFallbackWindowCount" -1) -ne $positiveCallCoveredApplicationWindows -or
        [int](Get-CertificationValue $Coverage "applicationActiveBucketCount" -1) -ne $recomputedActiveSet.Count -or
        [int](Get-CertificationValue $Coverage "unobservedApplicationActiveBucketCount" -1) -ne $unobservedActiveCount -or
        [int](Get-CertificationValue $Coverage "zeroCallApplicationActiveBucketCount" -1) -ne $zeroCallActiveCount -or
        $missingMiddleCount -ne 0 -or $unobservedActiveCount -ne 0 -or $zeroCallActiveCount -ne 0 -or
        $coveredApplicationWindows -ne $FallbackIntervals.Count -or
        $positiveCallCoveredApplicationWindows -ne $FallbackIntervals.Count -or
        (Get-CertificationValue $Coverage "positiveCallCoveragePassed" $false) -ne $true -or
        (Get-CertificationValue $Coverage "sparseBucketsPermittedOnlyWithoutApplicationActivity" $false) -ne $true -or
        (Get-CertificationValue $Coverage "complete" $false) -ne $true -or
        [string](Get-CertificationValue $Coverage "expectedBucketSetSha256" "") -cne
            (Get-CertificationCanonicalSha256 ([ordered]@{buckets=$expectedBucketTexts})) -or
        [string](Get-CertificationValue $Coverage "observedBucketSetSha256" "") -cne
            (Get-CertificationCanonicalSha256 ([ordered]@{buckets=$observedBucketTexts})) -or
        [string](Get-CertificationValue $Coverage "positiveCallBucketSetSha256" "") -cne
            (Get-CertificationCanonicalSha256 ([ordered]@{buckets=$positiveBucketTexts})) -or
        [string](Get-CertificationValue $Coverage "applicationActiveBucketSetSha256" "") -cne
            (Get-CertificationCanonicalSha256 ([ordered]@{buckets=$activeBucketTexts}))) {
        throw "The deterministic PI sparse-minute coverage and positive-call reconciliation is incomplete."
    }
}

function Assert-CertificationHistoryFallbackPiGateEvidence {
    param($Evidence, $Receipt, $RequestValidation, $Contract)
    $queryIdentity = $Contract.HistoryFallbackQueryIdentity
    $hotPath = Get-CertificationValue $Evidence "hotPathLogEvidence"
    $sql = Get-CertificationValue $Evidence "sqlStatistics"
    $sampled = Get-CertificationValue $Evidence "sampledLoad"
    $expectedDatabaseHash = Get-CertificationTextSha256 $Contract.HistoryFallbackDatabaseResourceId
    $expectedApiTaskHash = Get-CertificationTextSha256 $Contract.ActiveApiArn
    if ($null -eq $Evidence -or $null -eq $hotPath -or $null -eq $sql -or $null -eq $sampled -or
        [string](Get-CertificationValue $Evidence "historyFallbackPiEvidenceVersion" "") -cne $script:RequiredHistoryFallbackPiEvidenceVersion -or
        [string](Get-CertificationValue $Evidence "evidenceCollectorVersion" "") -cne "post-traffic-v2" -or
        (Get-CertificationValue $Evidence "sanitized" $false) -ne $true -or
        (Get-CertificationValue $Evidence "rawSqlPersisted" $true) -ne $false -or
        (Get-CertificationValue $Evidence "rawIdentifiersPersisted" $true) -ne $false -or
        [string](Get-CertificationValue $Evidence "queryIdentifierSha256" "") -cne $queryIdentity.queryIdentifierSha256 -or
        [string](Get-CertificationValue $Evidence "compiledSqlSha256" "") -cne $queryIdentity.compiledSqlSha256 -or
        [string](Get-CertificationValue $Evidence "parameterTypeSignatureSha256" "") -cne $queryIdentity.parameterTypeSignatureSha256 -or
        [string](Get-CertificationValue $Evidence "schemaIdentitySha256" "") -cne $queryIdentity.schemaIdentitySha256 -or
        [string](Get-CertificationValue $Evidence "apiRuntimeTaskDefinitionSha256" "") -cne $expectedApiTaskHash -or
        (Get-CertificationValue $Evidence "trackIoTiming" $false) -ne $true -or
        [string](Get-CertificationValue $Evidence "releaseIdentitySha256" "") -cne [string]$Receipt.releaseIdentitySha256 -or
        [string](Get-CertificationValue $Evidence "trafficWindowSha256" "") -cne $RequestValidation.TrafficWindowSha256 -or
        (Get-CertificationValue $Evidence "passed" $false) -ne $true) {
        throw "The deterministic PI snapshot identity and traffic-window binding is incomplete."
    }
    $hotPathHash = [string](Get-CertificationValue $Evidence "hotPathLogEvidenceSha256" "")
    $fallbackPositive = Get-CertificationValue $hotPath "fallbackPositiveSummaryCount"
    $databaseReads = Get-CertificationValue $hotPath "derivedDatabaseReadCount"
    $fallbackItems = Get-CertificationValue $hotPath "fallbackItems"
    $fallbackIntervals = @(Get-CertificationValue $hotPath "fallbackPositiveIntervals" @())
    $fallbackIntervalsValid = $true
    $intervalFallbackItems = 0L
    $intervalDatabaseReads = 0L
    try {
        $evidenceStart = ([DateTimeOffset]([string](Get-CertificationValue $hotPath "evidenceStartUtc" ""))).ToUniversalTime()
        $evidenceEnd = ([DateTimeOffset]([string](Get-CertificationValue $hotPath "evidenceEndUtc" ""))).ToUniversalTime()
        if ($evidenceEnd -le $evidenceStart) { $fallbackIntervalsValid = $false }
        foreach ($interval in $fallbackIntervals) {
            $rawStart = [DateTimeOffset]([string](Get-CertificationValue $interval "startUtc" ""))
            $rawEnd = [DateTimeOffset]([string](Get-CertificationValue $interval "endUtc" ""))
            $duration = Get-CertificationValue $interval "durationMilliseconds"
            $intervalItems = Get-CertificationValue $interval "fallbackItems"
            $intervalReads = Get-CertificationValue $interval "databaseReadCount"
            $start = $rawStart.ToUniversalTime()
            $end = $rawEnd.ToUniversalTime()
            if ($rawStart.Offset -ne [TimeSpan]::Zero -or $rawEnd.Offset -ne [TimeSpan]::Zero -or
                -not (Test-CertificationFiniteNonnegativeNumber $duration) -or [double]$duration -ne 60000.0 -or
                ($end-$start).TotalMilliseconds -ne 60000.0 -or
                ($start.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or
                ($end.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or
                $start -lt $evidenceStart -or $end -gt $evidenceEnd -or
                -not (Test-CertificationFiniteNonnegativeNumber $intervalItems) -or
                [double]$intervalItems -lt 1 -or [double]$intervalItems -ne [math]::Floor([double]$intervalItems) -or
                -not (Test-CertificationFiniteNonnegativeNumber $intervalReads) -or
                [double]$intervalReads -lt 1 -or [double]$intervalReads -ne [math]::Floor([double]$intervalReads)) {
                $fallbackIntervalsValid = $false
            }
            $intervalFallbackItems += [long]$intervalItems
            $intervalDatabaseReads += [long]$intervalReads
        }
    }
    catch { $fallbackIntervalsValid = $false }
    if ($hotPathHash -notmatch '^[0-9a-f]{64}$' -or
        $hotPathHash -cne (Get-CertificationCanonicalSha256 $hotPath) -or
        (Get-CertificationValue $hotPath "passed" $false) -ne $true -or
        -not (Test-CertificationFiniteNonnegativeNumber $fallbackPositive) -or
        [double]$fallbackPositive -lt 1 -or [double]$fallbackPositive -ne [math]::Floor([double]$fallbackPositive) -or
        -not (Test-CertificationFiniteNonnegativeNumber $databaseReads) -or
        [double]$databaseReads -lt 1 -or [double]$databaseReads -ne [math]::Floor([double]$databaseReads) -or
        -not (Test-CertificationFiniteNonnegativeNumber $fallbackItems) -or
        [double]$fallbackItems -lt 1 -or [double]$fallbackItems -ne [math]::Floor([double]$fallbackItems) -or
        -not $fallbackIntervalsValid -or $fallbackIntervals.Count -ne [int]([double]$fallbackPositive) -or
        $intervalFallbackItems -ne [long]([double]$fallbackItems) -or
        $intervalDatabaseReads -ne [long]([double]$databaseReads) -or
        [string](Get-CertificationValue $hotPath "historyFallbackSqlIdentityVersion" "") -cne $queryIdentity.version -or
        [string](Get-CertificationValue $hotPath "historyFallbackSqlIdentitySha256" "") -cne $queryIdentity.compiledSqlSha256 -or
        (Get-CertificationValue $hotPath "rawMessagesPersisted" $true) -ne $false -or
        (Get-CertificationValue $hotPath "rawIdentifiersPersisted" $true) -ne $false -or
        @(Get-CertificationValue $hotPath "failureReasons" @()).Count -ne 0) {
        throw "The deterministic PI receipt does not prove a sanitized fallback-positive application interval."
    }
    $evidenceWindow = Get-CertificationValue $Evidence "evidenceWindow"
    try {
        $windowStart = ([DateTimeOffset]([string](Get-CertificationValue $evidenceWindow "startUtc" ""))).ToUniversalTime()
        $windowEnd = ([DateTimeOffset]([string](Get-CertificationValue $evidenceWindow "endUtc" ""))).ToUniversalTime()
    }
    catch { throw "The deterministic PI evidence window is malformed." }
    if ($windowStart -ne $evidenceStart -or $windowEnd -ne $evidenceEnd) {
        throw "The deterministic PI evidence window does not match the fallback log window."
    }
    Assert-CertificationHistoryFallbackPiBucketCoverage `
        -Coverage (Get-CertificationValue $sql "bucketCoverage") `
        -EvidenceWindow $evidenceWindow -FallbackIntervals $fallbackIntervals `
        -ExpectedDatabaseReadCount ([long]$databaseReads)
    $integratedCalls = Get-CertificationValue $sql "integratedCalls"
    $applicationReads = Get-CertificationValue $sql "applicationDatabaseReadCount"
    $totalTime = Get-CertificationValue $sql "totalTimePerSecondSum"
    $blockReadTime = Get-CertificationValue $sql "blockReadTimePerSecondSum"
    $blockShare = Get-CertificationValue $sql "blockReadTimeSharePercent"
    $sharedBlocks = Get-CertificationValue $sql "sharedBlocksReadPerSecondSum"
    $tempRead = Get-CertificationValue $sql "tempBlocksReadPerSecondSum"
    $tempWritten = Get-CertificationValue $sql "tempBlocksWrittenPerSecondSum"
    $metricCounts = Get-CertificationValue $sql "metricPointCounts"
    $completeMetricCoverage = $true
    $firstMetricCount = $null
    foreach ($name in @("calls","totalTime","blockReadTime","sharedBlocksRead","tempBlocksRead","tempBlocksWritten")) {
        $count = Get-CertificationValue $metricCounts $name
        if (-not (Test-CertificationFiniteNonnegativeNumber $count) -or [double]$count -lt 1 -or
            [double]$count -ne [math]::Floor([double]$count)) { $completeMetricCoverage = $false }
        elseif ($null -eq $firstMetricCount) { $firstMetricCount = [double]$count }
        elseif ([double]$count -ne $firstMetricCount) { $completeMetricCoverage = $false }
    }
    $recomputedBlockShare = if ((Test-CertificationFiniteNonnegativeNumber $totalTime) -and
        [double]$totalTime -gt 0 -and (Test-CertificationFiniteNonnegativeNumber $blockReadTime)) {
        [math]::Round(([double]$blockReadTime / [double]$totalTime) * 100.0,6)
    } else { $null }
    if ([int](Get-CertificationValue $sql "identityCount" 0) -ne 1 -or
        (Get-CertificationValue $sql "exactQueryIdentifierMatched" $false) -ne $true -or
        (Get-CertificationValue $sql "statementMarkersMatched" $false) -ne $true -or
        [string](Get-CertificationValue $sql "queryIdentifierSha256" "") -cne $queryIdentity.queryIdentifierSha256 -or
        [string](Get-CertificationValue $sql "compiledSqlSha256" "") -cne $queryIdentity.compiledSqlSha256 -or
        [string](Get-CertificationValue $sql "parameterTypeSignatureSha256" "") -cne $queryIdentity.parameterTypeSignatureSha256 -or
        [string](Get-CertificationValue $sql "schemaIdentitySha256" "") -cne $queryIdentity.schemaIdentitySha256 -or
        [string](Get-CertificationValue $sql "releaseIdentitySha256" "") -cne [string]$Receipt.releaseIdentitySha256 -or
        [string](Get-CertificationValue $sql "databaseResourceIdSha256" "") -cne $expectedDatabaseHash -or
        [string](Get-CertificationValue $sql "tokenSha256" "") -notmatch '^[0-9a-f]{64}$' -or
        [string](Get-CertificationValue $sql "statementSha256" "") -notmatch '^[0-9a-f]{64}$' -or
        [int](Get-CertificationValue $sql "periodSeconds" 0) -ne 60 -or
        -not (Test-CertificationFiniteNonnegativeNumber (Get-CertificationValue $sql "pageCount")) -or
        [double](Get-CertificationValue $sql "pageCount") -lt 1 -or
        [double](Get-CertificationValue $sql "pageCount") -ne
            [math]::Floor([double](Get-CertificationValue $sql "pageCount")) -or
        (Get-CertificationValue $sql "positiveCallsObserved" $false) -ne $true -or
        -not (Test-CertificationFiniteNonnegativeNumber $integratedCalls) -or [double]$integratedCalls -le 0 -or
        -not (Test-CertificationFiniteNonnegativeNumber $applicationReads) -or
        [double]$applicationReads -ne [double]$databaseReads -or
        [double]$applicationReads -ne [math]::Floor([double]$applicationReads) -or
        [double]$integratedCalls -lt [double]$applicationReads -or
        (Get-CertificationValue $sql "callsCoverApplicationReads" $false) -ne $true -or
        -not (Test-CertificationFiniteNonnegativeNumber $totalTime) -or [double]$totalTime -le 0 -or
        -not (Test-CertificationFiniteNonnegativeNumber $blockReadTime) -or
        -not (Test-CertificationFiniteNonnegativeNumber $blockShare) -or [double]$blockShare -ge 50.0 -or
        $null -eq $recomputedBlockShare -or
        [math]::Abs([double]$blockShare - [double]$recomputedBlockShare) -gt 0.000001 -or
        -not (Test-CertificationFiniteNonnegativeNumber $sharedBlocks) -or
        -not (Test-CertificationFiniteNonnegativeNumber $tempRead) -or [double]$tempRead -ne 0.0 -or
        -not (Test-CertificationFiniteNonnegativeNumber $tempWritten) -or [double]$tempWritten -ne 0.0 -or
        (Get-CertificationValue $sql "temporaryIoAbsent" $false) -ne $true -or
        [double](Get-CertificationValue $sql "dominanceThresholdPercent" -1) -ne 50.0 -or
        -not $completeMetricCoverage -or @(Get-CertificationValue $sql "failureReasons" @()).Count -ne 0 -or
        (Get-CertificationValue $sql "passed" $false) -ne $true) {
        throw "The deterministic PI SQL-statistics call and I/O gates are incomplete or rejected."
    }
    $sampledStatus = [string](Get-CertificationValue $sampled "status" "")
    $sampledLoad = Get-CertificationValue $sampled "sampledDbLoad"
    if ($sampledStatus -ceq "not_applicable_zero_sampled_load") {
        $ratioProperty = $sampled.PSObject.Properties["dataFileReadSharePercent"]
        if (-not (Test-CertificationFiniteNonnegativeNumber $sampledLoad) -or [double]$sampledLoad -ne 0.0 -or
            [int](Get-CertificationValue $sampled "tokenCount" -1) -notin @(0,1) -or
            -not (Test-CertificationFiniteNonnegativeNumber (Get-CertificationValue $sampled "pageCount")) -or
            [double](Get-CertificationValue $sampled "pageCount") -lt 1 -or
            [double](Get-CertificationValue $sampled "pageCount") -ne
                [math]::Floor([double](Get-CertificationValue $sampled "pageCount")) -or
            ([int](Get-CertificationValue $sampled "tokenCount" 0) -eq 1 -and
                [string](Get-CertificationValue $sampled "tokenSha256" "") -cne
                    [string](Get-CertificationValue $sql "tokenSha256" "")) -or
            (Get-CertificationValue $sampled "filteredWaitEventEvidenceRequired" $true) -ne $false -or
            (Get-CertificationValue $sampled "filteredWaitEventEvidenceComplete" $false) -ne $true -or
            $null -eq $ratioProperty -or $null -ne $ratioProperty.Value) {
            throw "Zero sampled load was not represented with the required not-applicable evidence."
        }
    }
    elseif ($sampledStatus -ceq "sampled_load_wait_events_required") {
        $dataFileShare = Get-CertificationValue $sampled "dataFileReadSharePercent"
        $waitLoad = Get-CertificationValue $sampled "filteredWaitEventDbLoad"
        $dataFileLoad = Get-CertificationValue $sampled "dataFileReadDbLoad"
        $coverage = Get-CertificationValue $sampled "coveragePercent"
        $coverageTolerance = Get-CertificationValue $sampled "coverageTolerancePercent"
        $recomputedDataFileShare = if ((Test-CertificationFiniteNonnegativeNumber $waitLoad) -and
            [double]$waitLoad -gt 0 -and (Test-CertificationFiniteNonnegativeNumber $dataFileLoad)) {
            [math]::Round(([double]$dataFileLoad / [double]$waitLoad) * 100.0,6)
        } else { $null }
        $recomputedCoverage = if ((Test-CertificationFiniteNonnegativeNumber $sampledLoad) -and
            [double]$sampledLoad -gt 0 -and (Test-CertificationFiniteNonnegativeNumber $waitLoad)) {
            [math]::Round(([double]$waitLoad / [double]$sampledLoad) * 100.0,6)
        } else { $null }
        if (-not (Test-CertificationFiniteNonnegativeNumber $sampledLoad) -or [double]$sampledLoad -le 0 -or
            [int](Get-CertificationValue $sampled "tokenCount" 0) -ne 1 -or
            [string](Get-CertificationValue $sampled "tokenSha256" "") -cne [string](Get-CertificationValue $sql "tokenSha256" "") -or
            -not (Test-CertificationFiniteNonnegativeNumber (Get-CertificationValue $sampled "pageCount")) -or
            [double](Get-CertificationValue $sampled "pageCount") -lt 1 -or
            -not (Test-CertificationFiniteNonnegativeNumber (Get-CertificationValue $sampled "waitPageCount")) -or
            [double](Get-CertificationValue $sampled "waitPageCount") -lt 1 -or
            -not (Test-CertificationFiniteNonnegativeNumber (Get-CertificationValue $sampled "waitEventCount")) -or
            [double](Get-CertificationValue $sampled "waitEventCount") -lt 1 -or
            (Get-CertificationValue $sampled "filteredWaitEventEvidenceRequired" $false) -ne $true -or
            (Get-CertificationValue $sampled "filteredWaitEventEvidenceComplete" $false) -ne $true -or
            -not (Test-CertificationFiniteNonnegativeNumber $waitLoad) -or [double]$waitLoad -le 0 -or
            -not (Test-CertificationFiniteNonnegativeNumber $dataFileLoad) -or [double]$dataFileLoad -gt [double]$waitLoad -or
            -not (Test-CertificationFiniteNonnegativeNumber $dataFileShare) -or [double]$dataFileShare -ge 50.0 -or
            $null -eq $recomputedDataFileShare -or
            [math]::Abs([double]$dataFileShare - [double]$recomputedDataFileShare) -gt 0.000001 -or
            -not (Test-CertificationFiniteNonnegativeNumber $coverage) -or $null -eq $recomputedCoverage -or
            [math]::Abs([double]$coverage - [double]$recomputedCoverage) -gt 0.000001 -or
            -not (Test-CertificationFiniteNonnegativeNumber $coverageTolerance) -or
            [double]$coverageTolerance -ne 0.5 -or
            [math]::Abs([double]$waitLoad - [double]$sampledLoad) -gt
                [math]::Max(0.000001,[double]$sampledLoad * 0.005)) {
            throw "Positive sampled load does not have complete sub-50-percent wait-event evidence."
        }
    }
    else { throw "The deterministic PI sampled-load status is unsupported." }
    if ([double](Get-CertificationValue $sampled "dominanceThresholdPercent" -1) -ne 50.0 -or
        @(Get-CertificationValue $sampled "failureReasons" @()).Count -ne 0 -or
        (Get-CertificationValue $sampled "passed" $false) -ne $true) {
        throw "The deterministic PI sampled-load gate did not pass."
    }
}

function Assert-CertificationHistoryFallbackPiReceipt {
    param($Reference, $RequestValidation, $Contract, [string]$ExpectedRunId,
        [string]$ExpectedStage)
    $bound = Assert-CertificationEvidenceReference ([pscustomobject]@{
        path=[string](Get-CertificationValue $Reference "path" "")
        sha256=[string](Get-CertificationValue $Reference "sha256" "")
    }) "historyFallbackPiEvidenceReceipt"
    Assert-CertificationPrivateFileAcl $bound.path "historyFallbackPiEvidenceReceipt"
    $rawReceipt = Get-Content -LiteralPath $bound.path -Raw
    if ($rawReceipt -match '"queryIdentifier"\s*:') {
        throw "The history-fallback PI receipt leaked the protected raw query identifier."
    }
    try { $receipt = $rawReceipt | ConvertFrom-Json -Depth 60 -DateKind String }
    catch { throw "The history-fallback PI evidence receipt contains malformed JSON." }
    $expectedReleaseHash = Get-CertificationCanonicalSha256 ([ordered]@{
        applicationGitSha=$Contract.ApplicationGitSha;deployedImageDigest=$Contract.DeployedImageDigest
        apiTaskDefinitionArn=$Contract.ActiveApiArn;workerTaskDefinitionArn=$Contract.ActiveWorkerArn
    })
    $queryIdentity = $Contract.HistoryFallbackQueryIdentity
    $evidence = Get-CertificationValue $receipt "evidence"
    $attemptCount = Get-CertificationValue $receipt "attemptCount"
    $completedAt = [DateTimeOffset]::MinValue
    if ([int](Get-CertificationValue $receipt "schemaVersion" 0) -ne 1 -or
        [string](Get-CertificationValue $receipt "type" "") -cne "history_fallback_pi_evidence_receipt" -or
        [string](Get-CertificationValue $receipt "historyFallbackPiEvidenceVersion" "") -cne $script:RequiredHistoryFallbackPiEvidenceVersion -or
        [string](Get-CertificationValue $receipt "evidenceCollectorVersion" "") -cne "post-traffic-v2" -or
        [string](Get-CertificationValue $receipt "runId" "") -cne $ExpectedRunId -or
        [string](Get-CertificationValue $receipt "chainId" "") -cne $Contract.ChainId -or
        [string](Get-CertificationValue $receipt "phase" "") -cne "Waf" -or
        [string](Get-CertificationValue $receipt "stage" "") -cne $ExpectedStage -or
        [string](Get-CertificationValue $receipt "requestSha256" "") -cne $RequestValidation.Reference.sha256 -or
        [string](Get-CertificationValue $receipt "queryIdentityReceiptSha256" "") -cne $Contract.HistoryFallbackQueryIdentityReceipt.sha256 -or
        [string](Get-CertificationValue $receipt "queryIdentifierSha256" "") -cne $queryIdentity.queryIdentifierSha256 -or
        [string](Get-CertificationValue $receipt "compiledSqlSha256" "") -cne $queryIdentity.compiledSqlSha256 -or
        [string](Get-CertificationValue $receipt "parameterTypeSignatureSha256" "") -cne $queryIdentity.parameterTypeSignatureSha256 -or
        [string](Get-CertificationValue $receipt "schemaIdentitySha256" "") -cne $queryIdentity.schemaIdentitySha256 -or
        [string](Get-CertificationValue $receipt "apiRuntimeTaskDefinitionSha256" "") -cne
            (Get-CertificationTextSha256 $Contract.ActiveApiArn) -or
        (Get-CertificationValue $receipt "trackIoTiming" $false) -ne $true -or
        [string](Get-CertificationValue $receipt "releaseIdentitySha256" "") -cne $expectedReleaseHash -or
        [string](Get-CertificationValue $receipt "databaseResourceIdSha256" "") -cne
            (Get-CertificationTextSha256 $Contract.HistoryFallbackDatabaseResourceId) -or
        [string](Get-CertificationValue $receipt "state" "") -cne "completed" -or
        (Get-CertificationValue $receipt "collected" $false) -ne $true -or
        (Get-CertificationValue $receipt "passed" $false) -ne $true -or
        (Get-CertificationValue $receipt "rawSqlPersisted" $true) -ne $false -or
        (Get-CertificationValue $receipt "rawIdentifiersPersisted" $true) -ne $false -or
        (Get-CertificationValue $receipt "rawErrorPersisted" $true) -ne $false -or
        -not (Test-CertificationFiniteNonnegativeNumber $attemptCount) -or [double]$attemptCount -lt 1 -or
        [double]$attemptCount -ne [math]::Floor([double]$attemptCount) -or
        -not [DateTimeOffset]::TryParse([string](Get-CertificationValue $receipt "completedAtUtc" ""),[ref]$completedAt) -or
        $completedAt.ToUniversalTime() -gt [DateTimeOffset]::UtcNow.AddSeconds(5) -or
        [string](Get-CertificationValue $receipt "stableSnapshotSha256" "") -notmatch '^[0-9a-f]{64}$' -or
        [string](Get-CertificationValue $receipt "stableSnapshotSha256" "") -cne
            (Get-CertificationCanonicalSha256 $evidence)) {
        throw "The history-fallback PI receipt is not accepted evidence for this exact run, query, release, request, and database."
    }
    Assert-CertificationHistoryFallbackPiGateEvidence -Evidence $evidence -Receipt $receipt `
        -RequestValidation $RequestValidation -Contract $Contract
    return [pscustomobject]@{
        Reference=$bound;Receipt=$receipt;ReleaseIdentitySha256=$expectedReleaseHash
    }
}

function Assert-CertificationHistoryFallbackPiEvidence {
    param($Reference, [string]$ExpectedPath, $RequestValidation, $Contract,
        [string]$ExpectedRunId, [string]$ExpectedStage)
    if ($null -eq $Reference) { throw "The history-fallback PI finalizer did not return a receipt reference." }
    $path = [IO.Path]::GetFullPath([string](Get-CertificationValue $Reference "path" ""))
    if (-not [string]::Equals($path,[IO.Path]::GetFullPath($ExpectedPath),[StringComparison]::OrdinalIgnoreCase)) {
        throw "The history-fallback PI finalizer returned an unexpected receipt path."
    }
    $accepted = Assert-CertificationHistoryFallbackPiReceipt -Reference ([ordered]@{
        path=$path;sha256=[string](Get-CertificationValue $Reference "sha256" "")
    }) -RequestValidation $RequestValidation -Contract $Contract -ExpectedRunId $ExpectedRunId `
        -ExpectedStage $ExpectedStage
    $receipt = $accepted.Receipt
    $queryIdentity = $Contract.HistoryFallbackQueryIdentity
    if ([string](Get-CertificationValue $Reference "historyFallbackPiEvidenceVersion" "") -cne $script:RequiredHistoryFallbackPiEvidenceVersion -or
        (Get-CertificationValue $Reference "collected" $false) -ne $true -or
        (Get-CertificationValue $Reference "passed" $false) -ne $true -or
        [string](Get-CertificationValue $Reference "queryIdentifierSha256" "") -cne $queryIdentity.queryIdentifierSha256 -or
        [string](Get-CertificationValue $Reference "releaseIdentitySha256" "") -cne $accepted.ReleaseIdentitySha256) {
        throw "The history-fallback PI receipt reference is inconsistent with its private receipt."
    }
    return [pscustomobject]@{
        PrivateReference=$accepted.Reference
        RequestReference=$RequestValidation.Reference
        Public=[ordered]@{
            schemaVersion=1;type="history_fallback_pi_evidence_binding"
            historyFallbackPiEvidenceVersion=$script:RequiredHistoryFallbackPiEvidenceVersion
            evidenceCollectorVersion="post-traffic-v2";receiptSha256=$accepted.Reference.sha256
            receiptPathSha256=Get-CertificationTextSha256 $accepted.Reference.path
            requestSha256=$RequestValidation.Reference.sha256
            requestPathSha256=Get-CertificationTextSha256 $RequestValidation.Reference.path
            trafficWindowSha256=$RequestValidation.TrafficWindowSha256
            queryIdentifierSha256=$queryIdentity.queryIdentifierSha256
            compiledSqlSha256=$queryIdentity.compiledSqlSha256
            parameterTypeSignatureSha256=$queryIdentity.parameterTypeSignatureSha256
            schemaIdentitySha256=$queryIdentity.schemaIdentitySha256
            apiRuntimeTaskDefinitionSha256=Get-CertificationTextSha256 $Contract.ActiveApiArn
            trackIoTiming=$true
            databaseResourceIdSha256=Get-CertificationTextSha256 $Contract.HistoryFallbackDatabaseResourceId
            releaseIdentitySha256=$accepted.ReleaseIdentitySha256
            stableSnapshotSha256=[string]$receipt.stableSnapshotSha256
            collected=$true;passed=$true
        }
    }
}

function New-CertificationHistoryFallbackPiRejectedBundle {
    param([string]$ExpectedPath, $RequestValidation, $Contract, [string]$DiscardedMessage)
    $privateReference = $null
    $observedSha = $null
    if (Test-Path -LiteralPath $ExpectedPath -PathType Leaf) {
        # A malformed or insecure receipt is still represented by a sanitized
        # public failure binding.  Only expose the private reference to the
        # local exception path when its operator-only ACL is itself valid.
        try {
            Assert-CertificationPrivateFileAcl $ExpectedPath "rejected historyFallbackPiEvidenceReceipt"
            $observedSha = Get-CertificationSha256 $ExpectedPath
            $privateReference = [ordered]@{path=[IO.Path]::GetFullPath($ExpectedPath);sha256=$observedSha}
        }
        catch {
            try { $observedSha = Get-CertificationSha256 $ExpectedPath } catch { $observedSha = $null }
        }
    }
    $releaseHash = Get-CertificationCanonicalSha256 ([ordered]@{
        applicationGitSha=$Contract.ApplicationGitSha;deployedImageDigest=$Contract.DeployedImageDigest
        apiTaskDefinitionArn=$Contract.ActiveApiArn;workerTaskDefinitionArn=$Contract.ActiveWorkerArn
    })
    return [pscustomobject]@{
        PrivateReference=$privateReference;RequestReference=$RequestValidation.Reference
        Public=[ordered]@{
            schemaVersion=1;type="history_fallback_pi_evidence_binding"
            historyFallbackPiEvidenceVersion=$script:RequiredHistoryFallbackPiEvidenceVersion
            evidenceCollectorVersion="post-traffic-v2";receiptSha256=$observedSha
            receiptPathSha256=Get-CertificationTextSha256 ([IO.Path]::GetFullPath($ExpectedPath))
            requestSha256=$RequestValidation.Reference.sha256
            requestPathSha256=Get-CertificationTextSha256 $RequestValidation.Reference.path
            trafficWindowSha256=$RequestValidation.TrafficWindowSha256
            queryIdentifierSha256=$Contract.HistoryFallbackQueryIdentity.queryIdentifierSha256
            compiledSqlSha256=$Contract.HistoryFallbackQueryIdentity.compiledSqlSha256
            parameterTypeSignatureSha256=$Contract.HistoryFallbackQueryIdentity.parameterTypeSignatureSha256
            schemaIdentitySha256=$Contract.HistoryFallbackQueryIdentity.schemaIdentitySha256
            apiRuntimeTaskDefinitionSha256=Get-CertificationTextSha256 $Contract.ActiveApiArn
            trackIoTiming=$true
            databaseResourceIdSha256=Get-CertificationTextSha256 $Contract.HistoryFallbackDatabaseResourceId
            releaseIdentitySha256=$releaseHash;stableSnapshotSha256=$null
            collected=$false;passed=$false;failureCode="history_fallback_pi_receipt_rejected"
            failureStage="receipt_validation"
            discardedMessageSha256=Get-CertificationTextSha256 $DiscardedMessage
            rawErrorPersisted=$false
        }
    }
}

function Get-CertificationHistoryFallbackPiFailureBinding {
    param($Reference, [string]$ExpectedPath, $RequestValidation, $Contract,
        [string]$ExpectedRunId, [string]$ExpectedStage)
    if ($null -eq $Reference) { throw "The failed PI finalizer did not return a receipt reference." }
    $path = [IO.Path]::GetFullPath([string](Get-CertificationValue $Reference "path" ""))
    if (-not [string]::Equals($path,[IO.Path]::GetFullPath($ExpectedPath),[StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "The failed PI finalizer returned an unexpected receipt path."
    }
    Assert-CertificationPrivateFileAcl $path "failed historyFallbackPiEvidenceReceipt"
    $sha = Assert-CertificationSha256 ([string](Get-CertificationValue $Reference "sha256" "")) `
        "failed historyFallbackPiEvidence.sha256"
    if ((Get-CertificationSha256 $path) -cne $sha) { throw "The failed PI receipt changed after collection." }
    $rawReceipt = Get-Content -LiteralPath $path -Raw
    if ($rawReceipt -match '"queryIdentifier"\s*:') { throw "The failed PI receipt leaked a raw query identifier." }
    try { $receipt = $rawReceipt | ConvertFrom-Json -Depth 60 -DateKind String }
    catch { throw "The failed PI receipt contains malformed JSON." }
    $queryIdentity = $Contract.HistoryFallbackQueryIdentity
    $expectedReleaseHash = Get-CertificationCanonicalSha256 ([ordered]@{
        applicationGitSha=$Contract.ApplicationGitSha;deployedImageDigest=$Contract.DeployedImageDigest
        apiTaskDefinitionArn=$Contract.ActiveApiArn;workerTaskDefinitionArn=$Contract.ActiveWorkerArn
    })
    $state = [string](Get-CertificationValue $receipt "state" "")
    $collected = Get-CertificationValue $receipt "collected" $false
    $failureCode = [string](Get-CertificationValue $receipt "failureCode" "")
    $failureStage = [string](Get-CertificationValue $receipt "failureStage" "")
    $allowedCollectorStages = @("aws_preflight","hot_path_log_windows","fallback_sql_stats",
        "fallback_sampled_load","snapshot_stabilization","aws_request","aws_response",
        "snapshot_collection","collector_runtime")
    $gateFailure = $state -ceq "completed" -and $collected -eq $true -and
        $failureCode -ceq "history_fallback_pi_gate_failed" -and $failureStage -ceq "history_fallback_gate"
    $collectorFailure = $state -ceq "failed" -and $collected -eq $false -and
        $failureCode -ceq "performance_insights_evidence_unavailable" -and $failureStage -in $allowedCollectorStages
    $runtimeFailure = $state -ceq "failed" -and $collected -eq $false -and
        $failureCode -ceq "controller_runtime_failure" -and $failureStage -ceq "collector_runtime"
    $attemptCount = Get-CertificationValue $receipt "attemptCount"
    $discarded = Get-CertificationValue $receipt "discardedMessageSha256"
    $completedAt = [DateTimeOffset]::MinValue
    if ([int](Get-CertificationValue $receipt "schemaVersion" 0) -ne 1 -or
        [string](Get-CertificationValue $receipt "type" "") -cne "history_fallback_pi_evidence_receipt" -or
        [string](Get-CertificationValue $receipt "historyFallbackPiEvidenceVersion" "") -cne $script:RequiredHistoryFallbackPiEvidenceVersion -or
        [string](Get-CertificationValue $receipt "evidenceCollectorVersion" "") -cne "post-traffic-v2" -or
        [string](Get-CertificationValue $receipt "runId" "") -cne $ExpectedRunId -or
        [string](Get-CertificationValue $receipt "chainId" "") -cne $Contract.ChainId -or
        [string](Get-CertificationValue $receipt "phase" "") -cne "Waf" -or
        [string](Get-CertificationValue $receipt "stage" "") -cne $ExpectedStage -or
        [string](Get-CertificationValue $receipt "requestSha256" "") -cne $RequestValidation.Reference.sha256 -or
        [string](Get-CertificationValue $receipt "queryIdentityReceiptSha256" "") -cne $Contract.HistoryFallbackQueryIdentityReceipt.sha256 -or
        [string](Get-CertificationValue $receipt "queryIdentifierSha256" "") -cne $queryIdentity.queryIdentifierSha256 -or
        [string](Get-CertificationValue $receipt "compiledSqlSha256" "") -cne $queryIdentity.compiledSqlSha256 -or
        [string](Get-CertificationValue $receipt "parameterTypeSignatureSha256" "") -cne $queryIdentity.parameterTypeSignatureSha256 -or
        [string](Get-CertificationValue $receipt "schemaIdentitySha256" "") -cne $queryIdentity.schemaIdentitySha256 -or
        [string](Get-CertificationValue $receipt "apiRuntimeTaskDefinitionSha256" "") -cne
            (Get-CertificationTextSha256 $Contract.ActiveApiArn) -or
        (Get-CertificationValue $receipt "trackIoTiming" $false) -ne $true -or
        [string](Get-CertificationValue $receipt "releaseIdentitySha256" "") -cne $expectedReleaseHash -or
        [string](Get-CertificationValue $receipt "databaseResourceIdSha256" "") -cne
            (Get-CertificationTextSha256 $Contract.HistoryFallbackDatabaseResourceId) -or
        (Get-CertificationValue $receipt "rawSqlPersisted" $true) -ne $false -or
        (Get-CertificationValue $receipt "rawIdentifiersPersisted" $true) -ne $false -or
        (Get-CertificationValue $receipt "rawErrorPersisted" $true) -ne $false -or
        (Get-CertificationValue $receipt "passed" $true) -ne $false -or
        -not (Test-CertificationFiniteNonnegativeNumber $attemptCount) -or
        [double]$attemptCount -lt 1 -or
        [double]$attemptCount -ne [math]::Floor([double]$attemptCount) -or
        -not [DateTimeOffset]::TryParse([string](Get-CertificationValue $receipt "completedAtUtc" ""),[ref]$completedAt) -or
        $completedAt.ToUniversalTime() -gt [DateTimeOffset]::UtcNow.AddSeconds(5) -or
        (-not $gateFailure -and -not $collectorFailure -and -not $runtimeFailure) -or
        (($collectorFailure -or $runtimeFailure) -and [string]$discarded -notmatch '^[0-9a-f]{64}$') -or
        ($gateFailure -and ([string](Get-CertificationValue $receipt "stableSnapshotSha256" "") -notmatch '^[0-9a-f]{64}$' -or
            [string](Get-CertificationValue $receipt "stableSnapshotSha256" "") -cne
                (Get-CertificationCanonicalSha256 (Get-CertificationValue $receipt "evidence"))))) {
        throw "The failed PI receipt does not have one allowlisted, identity-bound terminal shape."
    }
    return [pscustomobject]@{
        PrivateReference=[ordered]@{path=$path;sha256=$sha}
        RequestReference=$RequestValidation.Reference
        Public=[ordered]@{
            schemaVersion=1;type="history_fallback_pi_evidence_binding"
            historyFallbackPiEvidenceVersion=$script:RequiredHistoryFallbackPiEvidenceVersion
            evidenceCollectorVersion="post-traffic-v2";receiptSha256=$sha
            receiptPathSha256=Get-CertificationTextSha256 $path
            requestSha256=$RequestValidation.Reference.sha256
            requestPathSha256=Get-CertificationTextSha256 $RequestValidation.Reference.path
            trafficWindowSha256=$RequestValidation.TrafficWindowSha256
            queryIdentifierSha256=$queryIdentity.queryIdentifierSha256
            compiledSqlSha256=$queryIdentity.compiledSqlSha256
            parameterTypeSignatureSha256=$queryIdentity.parameterTypeSignatureSha256
            schemaIdentitySha256=$queryIdentity.schemaIdentitySha256
            apiRuntimeTaskDefinitionSha256=Get-CertificationTextSha256 $Contract.ActiveApiArn
            trackIoTiming=$true
            databaseResourceIdSha256=Get-CertificationTextSha256 $Contract.HistoryFallbackDatabaseResourceId
            releaseIdentitySha256=$expectedReleaseHash
            stableSnapshotSha256=Get-CertificationValue $receipt "stableSnapshotSha256"
            collected=[bool]$collected;passed=$false;failureCode=$failureCode;failureStage=$failureStage
            discardedMessageSha256=$discarded;rawErrorPersisted=$false
        }
    }
}

function Invoke-CertificationHistoryFallbackPiFinalizer {
    param($Config, $Contract, [string]$ProgressPath, [string]$SummaryPath,
        [string]$RequestPath, [string]$ReceiptPath)
    $stage = [string]$Config.workload.stage
    $trafficWindow = Get-CertificationCoherentTrafficWindow -ProgressPath $ProgressPath `
        -SummaryPath $SummaryPath -ExpectedRunId $runId -ExpectedStage $stage `
        -ExpectedDurationSeconds ([int]$Config.workload.durationSeconds)
    $logBinding = Get-CertificationApiCloudWatchBinding -Config $Config -Contract $Contract
    $request = [ordered]@{
        schemaVersion=1;type="history_fallback_pi_finalization_request"
        historyFallbackPiEvidenceVersion=$script:RequiredHistoryFallbackPiEvidenceVersion
        evidenceCollectorVersion="post-traffic-v2";runId=$runId;chainId=$Contract.ChainId
        phase="Waf";stage=$stage;applicationGitSha=$Contract.ApplicationGitSha
        deployedImageDigest=$Contract.DeployedImageDigest
        taskDefinitions=[ordered]@{api=$Contract.ActiveApiArn;worker=$Contract.ActiveWorkerArn}
        ecsRuntimeBinding=[ordered]@{
            clusterName=[string]$Config.resources.cluster
            apiServiceName=[string]$Config.resources.apiService
            workerServiceName=[string]$Config.resources.workerService
        }
        rds=[ordered]@{
            region=[string]$Config.resources.region;accountId=[string]$Contract.DatabaseInsightsLease.accountId
            dbInstanceIdentifier=[string]$Contract.DatabaseInsightsLease.dbInstanceIdentifier
            databaseResourceId=$Contract.HistoryFallbackDatabaseResourceId
            engineVersion=$Contract.HistoryFallbackQueryIdentity.engineVersion
            expectedInstanceClass=[string]$Config.resources.expectedRdsInstanceClass
        }
        trafficWindow=$trafficWindow;apiCloudWatchBinding=$logBinding
        historyFallbackQueryIdentity=$Contract.HistoryFallbackQueryIdentityReceipt
        historyFallbackSqlIdentity=[ordered]@{
            version=$Contract.HistoryFallbackQueryIdentity.version
            queryIdentifierSha256=$Contract.HistoryFallbackQueryIdentity.queryIdentifierSha256
            compiledSqlSha256=$Contract.HistoryFallbackQueryIdentity.compiledSqlSha256
            parameterTypeSignatureSha256=$Contract.HistoryFallbackQueryIdentity.parameterTypeSignatureSha256
            schemaIdentitySha256=$Contract.HistoryFallbackQueryIdentity.schemaIdentitySha256
            trackIoTiming=$true
        }
        applicationFallbackDatabaseReadEvidence=[ordered]@{
            sourceEvent="classpilot_heartbeat_hot_path_summary"
            historyFallbackSqlIdentityVersion=$Contract.HistoryFallbackQueryIdentity.version
            historyFallbackSqlIdentitySha256=$Contract.HistoryFallbackQueryIdentity.compiledSqlSha256
        }
    }
    Write-CertificationPrivateImmutableJson -Path $RequestPath -Value $request
    $requestSha = Get-CertificationSha256 $RequestPath
    $requestValidation = Assert-CertificationHistoryFallbackPiFinalizationRequest -Reference ([ordered]@{
        path=[IO.Path]::GetFullPath($RequestPath);sha256=$requestSha
    }) -Contract $Contract -Config $Config -ExpectedRunId $runId -ExpectedStage $stage
    $finalizer = Join-Path $PSScriptRoot "finalize-history-fallback-pi-evidence.ps1"
    $null = & $pwsh -NoProfile -File $finalizer -Mode Validate -RequestPath $RequestPath `
        -ExpectedRequestSha256 $requestSha -OutputPath $ReceiptPath 2>$null
    if ($LASTEXITCODE -ne 0) { throw "The history-fallback PI finalization request failed validation." }
    $rawReference = & $pwsh -NoProfile -File $finalizer -Mode Collect -RequestPath $RequestPath `
        -ExpectedRequestSha256 $requestSha -OutputPath $ReceiptPath 2>$null
    $exitCode = $LASTEXITCODE
    $reference = $null
    try { $reference = (($rawReference | Out-String).Trim() | ConvertFrom-Json -Depth 30) }
    catch {
        if ($exitCode -eq 0) { throw "The history-fallback PI finalizer returned malformed evidence." }
    }
    if ($exitCode -ne 0) {
        try {
            $failureBinding = Get-CertificationHistoryFallbackPiFailureBinding -Reference $reference `
                -ExpectedPath $ReceiptPath -RequestValidation $requestValidation -Contract $Contract `
                -ExpectedRunId $runId -ExpectedStage $stage
        }
        catch {
            $failureBinding = New-CertificationHistoryFallbackPiRejectedBundle `
                -ExpectedPath $ReceiptPath -RequestValidation $requestValidation -Contract $Contract `
                -DiscardedMessage $_.Exception.Message
        }
        $failure = [InvalidOperationException]::new(
            "The deterministic history-fallback PI evidence gate did not pass."
        )
        $failure.Data["historyFallbackPiEvidence"] = $failureBinding.Public
        $failure.Data["historyFallbackPiFinalizationRequest"] = $failureBinding.RequestReference
        if ($null -ne $failureBinding.PrivateReference) {
            $failure.Data["historyFallbackPiEvidenceReceipt"] = $failureBinding.PrivateReference
        }
        throw $failure
    }
    try {
        return Assert-CertificationHistoryFallbackPiEvidence -Reference $reference -ExpectedPath $ReceiptPath `
            -RequestValidation $requestValidation -Contract $Contract -ExpectedRunId $runId `
            -ExpectedStage $stage
    }
    catch {
        $rejected = New-CertificationHistoryFallbackPiRejectedBundle -ExpectedPath $ReceiptPath `
            -RequestValidation $requestValidation -Contract $Contract -DiscardedMessage $_.Exception.Message
        $failure = [InvalidOperationException]::new(
            "The deterministic history-fallback PI receipt failed supervisor validation."
        )
        $failure.Data["historyFallbackPiEvidence"] = $rejected.Public
        $failure.Data["historyFallbackPiFinalizationRequest"] = $rejected.RequestReference
        if ($null -ne $rejected.PrivateReference) {
            $failure.Data["historyFallbackPiEvidenceReceipt"] = $rejected.PrivateReference
        }
        throw $failure
    }
}

function Assert-CertificationPredecessorHistoryFallbackPiEvidence {
    param($Config, $Envelope, $Contract)
    $binding = Get-CertificationValue $Envelope "historyFallbackPiEvidence"
    $predecessorRunId = [string](Get-CertificationValue $Envelope "runId" "")
    $requestReference = Get-RequiredProperty $Config "predecessorHistoryFallbackPiRequest"
    $receiptConfigReference = Get-RequiredProperty $Config "predecessorHistoryFallbackPiEvidence"
    $requestValidation = Assert-CertificationHistoryFallbackPiFinalizationRequest `
        -Reference $requestReference `
        -Contract $Contract -Config $Config -ExpectedRunId $predecessorRunId -ExpectedStage "500"
    $receiptReference = Assert-CertificationEvidenceReference `
        ([pscustomobject]@{
            path=[string](Get-CertificationValue $receiptConfigReference "path" "")
            sha256=[string](Get-CertificationValue $receiptConfigReference "sha256" "")
        }) `
        "predecessor.historyFallbackPiEvidenceReceipt"
    $expectedReleaseHash = Get-CertificationCanonicalSha256 ([ordered]@{
        applicationGitSha=$Contract.ApplicationGitSha;deployedImageDigest=$Contract.DeployedImageDigest
        apiTaskDefinitionArn=$Contract.ActiveApiArn;workerTaskDefinitionArn=$Contract.ActiveWorkerArn
    })
    $receiptSha = Assert-CertificationSha256 ([string](Get-CertificationValue $binding "receiptSha256" "")) `
        "predecessor.historyFallbackPiEvidence.receiptSha256"
    if ([string](Get-CertificationValue $binding "type" "") -cne "history_fallback_pi_evidence_binding" -or
        [string](Get-CertificationValue $binding "historyFallbackPiEvidenceVersion" "") -cne $script:RequiredHistoryFallbackPiEvidenceVersion -or
        [string](Get-CertificationValue $binding "evidenceCollectorVersion" "") -cne "post-traffic-v2" -or
        [string](Get-CertificationValue $binding "receiptPathSha256" "") -cne (Get-CertificationTextSha256 $receiptReference.path) -or
        [string](Get-CertificationValue $binding "requestSha256" "") -cne $requestValidation.Reference.sha256 -or
        [string](Get-CertificationValue $binding "requestPathSha256" "") -cne (Get-CertificationTextSha256 $requestValidation.Reference.path) -or
        [string](Get-CertificationValue $binding "trafficWindowSha256" "") -cne $requestValidation.TrafficWindowSha256 -or
        [string](Get-CertificationValue $binding "queryIdentifierSha256" "") -cne $Contract.HistoryFallbackQueryIdentity.queryIdentifierSha256 -or
        [string](Get-CertificationValue $binding "compiledSqlSha256" "") -cne $Contract.HistoryFallbackQueryIdentity.compiledSqlSha256 -or
        [string](Get-CertificationValue $binding "parameterTypeSignatureSha256" "") -cne $Contract.HistoryFallbackQueryIdentity.parameterTypeSignatureSha256 -or
        [string](Get-CertificationValue $binding "schemaIdentitySha256" "") -cne $Contract.HistoryFallbackQueryIdentity.schemaIdentitySha256 -or
        [string](Get-CertificationValue $binding "apiRuntimeTaskDefinitionSha256" "") -cne
            (Get-CertificationTextSha256 $Contract.ActiveApiArn) -or
        (Get-CertificationValue $binding "trackIoTiming" $false) -ne $true -or
        [string](Get-CertificationValue $binding "databaseResourceIdSha256" "") -cne
            (Get-CertificationTextSha256 $Contract.HistoryFallbackDatabaseResourceId) -or
        [string](Get-CertificationValue $binding "releaseIdentitySha256" "") -cne $expectedReleaseHash -or
        [string](Get-CertificationValue $binding "stableSnapshotSha256" "") -notmatch '^[0-9a-f]{64}$' -or
        (Get-CertificationValue $binding "collected" $false) -ne $true -or
        (Get-CertificationValue $binding "passed" $false) -ne $true -or
        $receiptReference.sha256 -cne $receiptSha) {
        throw "The predecessor does not bind an accepted deterministic history-fallback PI receipt."
    }
    $accepted = Assert-CertificationHistoryFallbackPiReceipt -Reference $receiptReference `
        -RequestValidation $requestValidation -Contract $Contract -ExpectedRunId $predecessorRunId `
        -ExpectedStage "500"
    if ([string]$accepted.Receipt.stableSnapshotSha256 -cne
        [string](Get-CertificationValue $binding "stableSnapshotSha256" "")) {
        throw "The predecessor PI snapshot hash differs from its supervisor binding."
    }
    return [pscustomobject]@{
        Receipt=$accepted.Reference;Request=$requestValidation.Reference
        ReceiptPathSha256=Get-CertificationTextSha256 $receiptReference.path
        RequestPathSha256=Get-CertificationTextSha256 $requestValidation.Reference.path
        TrafficWindowSha256=$requestValidation.TrafficWindowSha256
    }
}

function Get-CertificationControllerHashes {
    $paths = [ordered]@{
        supervisor = $PSCommandPath
        monitor = $monitorScript
        rollback = Join-Path $PSScriptRoot "aws-rollout-rollback.ps1"
        harness = $harnessScript
        monotonicDeadline = Join-Path $PSScriptRoot "monotonic-deadline.mjs"
        tilePollAccounting = Join-Path $PSScriptRoot "tile-poll-accounting.mjs"
        preparer = Join-Path $PSScriptRoot "prepare-classpilot-load-test.mjs"
        savedPlanValidator = Join-Path $PSScriptRoot "validate-rollout-plan.ps1"
        databaseInsightsLease = Join-Path $PSScriptRoot "database-insights-lease.ps1"
        historyFallbackPiFinalizer = Join-Path $PSScriptRoot "finalize-history-fallback-pi-evidence.ps1"
        historyFallbackPiFinalizerModule = Join-Path $PSScriptRoot "history-fallback-pi-finalizer.psm1"
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
    $authorizationPlanCohorts = Get-RequiredProperty $counts "authorizationPlanCohorts"
    $gates = Get-RequiredProperty $Verification "gates"
    $officeStaff = Get-RequiredProperty $counts "officeStaff"
    $coTeacherStudents = Get-RequiredProperty $authorizationPlanCohorts "coTeacherStudents"
    $officeSupervisionStudents = Get-RequiredProperty $authorizationPlanCohorts "officeSupervisionStudents"
    if ([int]$counts.schools -ne 2 -or [int]$counts.teachers -ne 20 -or [int]$officeStaff -ne 1 -or
        [int]$counts.students -ne 1010 -or
        [int]$counts.classes -ne 20 -or [int]$counts.classRosterStudents -ne 800 -or
        [int]$counts.devices -ne 1010 -or [int]$counts.activeDeviceSessions -ne 1010 -or
        [int]$counts.activeSessions -ne 20 -or [int]$counts.commandBodies -ne 20 -or
        [int]$coTeacherStudents -ne 40 -or
        [int]$officeSupervisionStudents -ne 40 -or
        [int]$liveAuth.commandAdministrators -ne 1 -or [int]$liveAuth.teachers -ne 20) {
        throw "Fixture live verification does not prove the exact owned two-school, 20-class, 1010-device and authorization-plan cohort certification inventory."
    }
    foreach ($gate in @(
        "autoEnrollDisabled","trackingDisabled","schedulesDisabled","exactSchoolTimezones",
        "classRostersExactAndDisjoint","authorizationPlanCohortsExact",
        "authorizationPlanOfficeStudentsOutsideTeacherRosters","allDeviceTokensLive","allStaffAuthArtifactsLive"
    )) {
        if ((Get-CertificationValue $gates $gate $false) -ne $true) {
            throw "Fixture live verification gate '$gate' is not proven."
        }
    }
}

function Get-CertificationContract {
    param($Config, [bool]$TestMode, [bool]$BindHarnessArtifacts = $false)
    if ((Get-CertificationValue $Config "diagnosticOnly" $false) -ne $false) {
        throw "Diagnostic-only runs can never enter or seed the certification supervisor."
    }
    $certification = Get-CertificationValue $Config "certification"
    if ($null -eq $certification) {
        if ($TestMode) { return $null }
        throw "Production supervision requires the certification chain contract."
    }
    if ([int](Get-CertificationValue $certification "schemaVersion" 0) -ne 1) {
        throw "certification.schemaVersion must be 1."
    }
    $workload = Get-RequiredProperty $Config "workload"
    $workloadSchemaVersion = [string](Get-RequiredProperty $workload "workloadSchemaVersion")
    $workloadEndpointShapeSha256 = Assert-CertificationSha256 `
        ([string](Get-RequiredProperty $workload "endpointShapeSha256")) "workload.endpointShapeSha256"
    if ($workloadSchemaVersion -cne $script:RequiredWorkloadSchemaVersion -or
        $workloadEndpointShapeSha256 -cne $script:RequiredWorkloadEndpointShapeSha256) {
        throw "Certification workload must bind the reviewed student-ID tile-batch schema and endpoint shape."
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
    $expectedRdsClass = [string](Get-RequiredProperty $Config.resources "expectedRdsInstanceClass")
    $historyFallbackQueryIdentityReceipt = Get-CertificationHistoryFallbackQueryIdentity `
        $certification $appSha $imageDigest $activeApiArn $activeWorkerArn
    $databaseInsightsLease = Get-CertificationDatabaseInsightsLease `
        $Config $historyFallbackQueryIdentityReceipt $expectedRdsClass
    Assert-CertificationProductionRollbackTaskIdentities $rollbackApiArn $rollbackWorkerArn $TestMode
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
        WorkloadSchemaVersion = $workloadSchemaVersion
        WorkloadEndpointShapeSha256 = $workloadEndpointShapeSha256
        HistoryFallbackQueryIdentity = $historyFallbackQueryIdentityReceipt.Public
        HistoryFallbackQueryIdentityReceipt = $historyFallbackQueryIdentityReceipt.Receipt
        HistoryFallbackDatabaseResourceId = $historyFallbackQueryIdentityReceipt.DatabaseResourceId
        HistoryFallbackPiEvidenceVersion = $script:RequiredHistoryFallbackPiEvidenceVersion
        DatabaseInsightsLease = $databaseInsightsLease.Public
        DatabaseInsightsLeaseReceipt = $databaseInsightsLease.Receipt
        ControllerHashes = Get-CertificationControllerHashes
    }
}

function Invoke-CertificationAwsJson {
    param([string[]]$Arguments)
    $raw = & aws @Arguments --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Certification AWS preflight failed for $($Arguments[0]) $($Arguments[1])." }
    return (($raw | Out-String).Trim() | ConvertFrom-Json -Depth 60)
}

function Get-CertificationTrackIoTimingPreflight {
    param($DbInstance, [string]$Region)
    $groups = @((Get-RequiredProperty $DbInstance "DBParameterGroups"))
    if ($groups.Count -ne 1 -or
        [string](Get-RequiredProperty $groups[0] "ParameterApplyStatus") -cne "in-sync") {
        throw "Certification preflight requires one exact in-sync database parameter group."
    }
    $groupName = [string](Get-RequiredProperty $groups[0] "DBParameterGroupName")
    if ($groupName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$') {
        throw "Certification preflight returned a malformed database parameter-group identity."
    }
    $parameters = [System.Collections.Generic.List[object]]::new()
    $seenMarkers = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $marker = $null
    $pageCount = 0
    do {
        $arguments = @(
            "rds","describe-db-parameters","--region",$Region,
            "--db-parameter-group-name",$groupName,
            "--filters","Name=parameter-name,Values=track_io_timing"
        )
        if ($marker) { $arguments += @("--marker",$marker) }
        $page = Invoke-CertificationAwsJson $arguments
        $pageCount++
        if ($pageCount -gt 100) { throw "Certification track_io_timing preflight exceeded the bounded pagination limit." }
        foreach ($parameter in @((Get-CertificationValue $page "Parameters" @()))) {
            $parameters.Add($parameter)
        }
        $next = [string](Get-CertificationValue $page "Marker" "")
        if ($next) {
            if (-not $seenMarkers.Add($next)) {
                throw "Certification track_io_timing preflight detected a pagination cycle."
            }
            $marker = $next
        }
        else { $marker = $null }
    } while ($marker)
    if ($parameters.Count -ne 1 -or
        [string](Get-RequiredProperty $parameters[0] "ParameterName") -cne "track_io_timing") {
        throw "Certification preflight did not resolve one exact track_io_timing parameter."
    }
    $value = ([string](Get-RequiredProperty $parameters[0] "ParameterValue")).Trim().ToLowerInvariant()
    if ($value -notin @("1","on","true")) {
        throw "Certification traffic requires effective track_io_timing=true."
    }
    return [ordered]@{
        enabled=$true
        evidenceVersion="rds-parameter-track-io-timing-v1"
        parameterGroupSha256=Get-CertificationTextSha256 $groupName
        pageCount=$pageCount
        rawIdentifiersPersisted=$false
    }
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
        $db.PubliclyAccessible -ne $false -or @($db.PendingModifiedValues.PSObject.Properties).Count -gt 0 -or
        [string]$db.DbiResourceId -cne [string]$Contract.HistoryFallbackDatabaseResourceId -or
        [string]$db.EngineVersion -cne [string]$Contract.HistoryFallbackQueryIdentity.engineVersion -or
        [string]$db.DatabaseInsightsMode -cne "advanced" -or $db.PerformanceInsightsEnabled -ne $true -or
        [int]$db.PerformanceInsightsRetentionPeriod -ne 465 -or
        @($db.DBParameterGroups).Count -ne 1 -or
        @($db.DBParameterGroups | Where-Object { [string]$_.ParameterApplyStatus -cne "in-sync" }).Count -gt 0) {
        throw "Certification preflight rejected the exact RDS identity, class, healthy Advanced/465 monitoring lease, private posture, or pending modifications."
    }
    $trackIoTimingEvidence = Get-CertificationTrackIoTimingPreflight -DbInstance $db -Region $region
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
            rds=[ordered]@{arn=[string]$db.DBInstanceArn;class=[string]$db.DBInstanceClass;databaseResourceIdSha256=Get-CertificationTextSha256 ([string]$db.DbiResourceId);databaseInsightsMode=[string]$db.DatabaseInsightsMode;performanceInsightsRetentionPeriod=[int]$db.PerformanceInsightsRetentionPeriod;trackIoTiming=$trackIoTimingEvidence;exactPosture=$observedRdsPosture;expectedExactPosture=$expectedRdsPosture}
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
        historyFallbackQueryIdentity=$Contract.HistoryFallbackQueryIdentity
        historyFallbackPiEvidenceVersion=$Contract.HistoryFallbackPiEvidenceVersion
        databaseInsightsLease=$Contract.DatabaseInsightsLease
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
        if ((ConvertTo-CertificationComparableJson $receipt.databaseInsightsLease) -cne
            (ConvertTo-CertificationComparableJson $Contract.DatabaseInsightsLease)) {
            throw "Validation receipt is bound to a different Database Insights monitoring lease."
        }
        if ([int]$receipt.schemaVersion -ne 1 -or [string]$receipt.type -ne "certification_validation_receipt" -or
            [string]$receipt.runId -ne $runId -or [string]$receipt.chainId -ne $Contract.ChainId -or
            [string]$receipt.nonce -notmatch '^[0-9a-f]{32}$' -or
            [string]$receipt.configSha256 -ne (Get-CertificationConfigHash) -or
            [string]$receipt.controllerGitSha -ne $Contract.ControllerGitSha -or
            [string]$receipt.applicationGitSha -ne $Contract.ApplicationGitSha -or
            [string]$receipt.deployedImageDigest -ne $Contract.DeployedImageDigest -or
            [string]$receipt.historyFallbackPiEvidenceVersion -cne $Contract.HistoryFallbackPiEvidenceVersion -or
            (ConvertTo-CertificationComparableJson $receipt.historyFallbackQueryIdentity) -cne
                (ConvertTo-CertificationComparableJson $Contract.HistoryFallbackQueryIdentity) -or
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
            workloadSchemaVersion=$Contract.WorkloadSchemaVersion;workloadEndpointShapeSha256=$Contract.WorkloadEndpointShapeSha256
            historyFallbackQueryIdentity=$Contract.HistoryFallbackQueryIdentity;historyFallbackPiEvidenceVersion=$Contract.HistoryFallbackPiEvidenceVersion
            databaseInsightsLease=$Contract.DatabaseInsightsLease
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
        [string]$rootJson.capacityTrack -ne $Contract.CapacityTrack -or
        [string]$rootJson.workloadSchemaVersion -cne $Contract.WorkloadSchemaVersion -or
        [string]$rootJson.workloadEndpointShapeSha256 -cne $Contract.WorkloadEndpointShapeSha256 -or
        [string]$rootJson.historyFallbackPiEvidenceVersion -cne $Contract.HistoryFallbackPiEvidenceVersion -or
        (ConvertTo-CertificationComparableJson $rootJson.historyFallbackQueryIdentity) -cne
            (ConvertTo-CertificationComparableJson $Contract.HistoryFallbackQueryIdentity) -or
        (ConvertTo-CertificationComparableJson $rootJson.databaseInsightsLease) -cne
            (ConvertTo-CertificationComparableJson $Contract.DatabaseInsightsLease)) {
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
        [string]$receipt.historyFallbackPiEvidenceVersion -cne $Contract.HistoryFallbackPiEvidenceVersion -or
        (ConvertTo-CertificationComparableJson $receipt.historyFallbackQueryIdentity) -cne
            (ConvertTo-CertificationComparableJson $Contract.HistoryFallbackQueryIdentity) -or
        (ConvertTo-CertificationComparableJson $receipt.databaseInsightsLease) -cne
            (ConvertTo-CertificationComparableJson $Contract.DatabaseInsightsLease) -or
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
    if ([string]$Attestation.historyFallbackPiEvidenceVersion -cne $Contract.HistoryFallbackPiEvidenceVersion -or
        (ConvertTo-CertificationComparableJson $Attestation.historyFallbackQueryIdentity) -cne
            (ConvertTo-CertificationComparableJson $Contract.HistoryFallbackQueryIdentity) -or
        (ConvertTo-CertificationComparableJson $Attestation.databaseInsightsLease) -cne
            (ConvertTo-CertificationComparableJson $Contract.DatabaseInsightsLease)) {
        throw "$Name does not bind the exact deterministic history-fallback identity, PI evidence version, and monitoring lease."
    }
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

function Test-CertificationTerminalTileBatchContract {
    param(
        $Workload,
        [string]$ExpectedStage,
        [string]$ExpectedSchemaVersion,
        [string]$ExpectedEndpointShapeSha256
    )
    if ($null -eq $Workload -or $ExpectedStage -notin @("500","800","endurance","burst")) { return $false }
    $tileBatch = Get-CertificationValue $Workload "tileBatch"
    if ($null -eq $tileBatch) { return $false }
    try {
        $expectedStudentsPerCohort = if ($ExpectedStage -eq "500") { 25 } else { 40 }
        $teacherCohorts = [int](Get-CertificationValue $tileBatch "teacherCohorts" -1)
        $studentsPerCohort = [int](Get-CertificationValue $tileBatch "studentsPerCohort" -1)
        $teacherTileAssignments = [int](Get-CertificationValue $tileBatch "teacherTileAssignments" -1)
        $requestsPerCohortPerPoll = [int](Get-CertificationValue $tileBatch "requestsPerCohortPerPoll" -1)
        $logicalOperationsPerPoll = [int](Get-CertificationValue $tileBatch "logicalOperationsPerPoll" -1)
        $historyRequests = [int64](Get-CertificationValue $tileBatch "historyRequests" -1)
        $screenshotRequests = [int64](Get-CertificationValue $tileBatch "screenshotRequests" -1)
        $historyLogicalOperations = [int64](Get-CertificationValue $tileBatch "historyLogicalOperations" -1)
        $screenshotLogicalOperations = [int64](Get-CertificationValue $tileBatch "screenshotLogicalOperations" -1)
        $networkRequests = [int64](Get-CertificationValue $tileBatch "networkRequests" -1)
        $logicalOperations = [int64](Get-CertificationValue $tileBatch "logicalOperations" -1)
        $screenshotAttempts = [int64](Get-CertificationValue $tileBatch "screenshotAttempts" -1)
        $screenshotSuccesses = [int64](Get-CertificationValue $tileBatch "screenshotSuccesses" -1)
        $historyRequestsByCohort = @((Get-CertificationValue $tileBatch "historyRequestsByCohort" @()))
        $screenshotRequestsByCohort = @((Get-CertificationValue $tileBatch "screenshotRequestsByCohort" @()))
        if ($historyRequestsByCohort.Count -ne 20 -or $screenshotRequestsByCohort.Count -ne 20) { return $false }
        $jsonNumberTypeCodes = @(
            [TypeCode]::Byte, [TypeCode]::SByte, [TypeCode]::Int16, [TypeCode]::UInt16,
            [TypeCode]::Int32, [TypeCode]::UInt32, [TypeCode]::Int64, [TypeCode]::UInt64,
            [TypeCode]::Single, [TypeCode]::Double, [TypeCode]::Decimal
        )
        $historyCounts = [Collections.Generic.List[int64]]::new()
        $screenshotCounts = [Collections.Generic.List[int64]]::new()
        for ($index = 0; $index -lt 20; $index++) {
            $historyRaw = $historyRequestsByCohort[$index]
            $screenshotRaw = $screenshotRequestsByCohort[$index]
            if ([Convert]::GetTypeCode($historyRaw) -notin $jsonNumberTypeCodes -or
                [Convert]::GetTypeCode($screenshotRaw) -notin $jsonNumberTypeCodes) { return $false }
            $historyDouble = [double]$historyRaw
            $screenshotDouble = [double]$screenshotRaw
            if ([double]::IsNaN($historyDouble) -or [double]::IsInfinity($historyDouble) -or
                [double]::IsNaN($screenshotDouble) -or [double]::IsInfinity($screenshotDouble) -or
                $historyDouble -lt 1 -or $screenshotDouble -lt 1 -or
                $historyDouble -ne [math]::Truncate($historyDouble) -or
                $screenshotDouble -ne [math]::Truncate($screenshotDouble) -or
                $historyDouble -gt [int64]::MaxValue -or $screenshotDouble -gt [int64]::MaxValue) { return $false }
            $historyCount = [int64]$historyDouble
            $screenshotCount = [int64]$screenshotDouble
            if ($historyCount -ne $screenshotCount) { return $false }
            $historyCounts.Add($historyCount)
            $screenshotCounts.Add($screenshotCount)
        }
        $minimumRounds = [int64](($historyCounts | Measure-Object -Minimum).Minimum)
        $maximumRounds = [int64](($historyCounts | Measure-Object -Maximum).Maximum)
        if (($maximumRounds - $minimumRounds) -gt 1) { return $false }
        $partialFinalRoundCohorts = @($historyCounts | Where-Object { $_ -gt $minimumRounds }).Count
        for ($index = 0; $index -lt 20; $index++) {
            $expectedCount = if ($index -lt $partialFinalRoundCohorts) { $maximumRounds } else { $minimumRounds }
            if ($historyCounts[$index] -ne $expectedCount) { return $false }
        }
        $historyCohortSum = [int64](($historyCounts | Measure-Object -Sum).Sum)
        $screenshotCohortSum = [int64](($screenshotCounts | Measure-Object -Sum).Sum)
        $completeRoundsClaim = [int64](Get-CertificationValue $tileBatch "completeRoundsPerCohort" -1)
        $maximumRoundsClaim = [int64](Get-CertificationValue $tileBatch "maximumRoundsPerCohort" -1)
        $partialCohortsClaim = [int](Get-CertificationValue $tileBatch "partialFinalRoundCohorts" -1)
    }
    catch { return $false }
    return (
        [string](Get-CertificationValue $Workload "stage" "") -ceq $ExpectedStage -and
        [string](Get-CertificationValue $Workload "workloadSchemaVersion" "") -ceq $ExpectedSchemaVersion -and
        [string](Get-CertificationValue $Workload "endpointShapeSha256" "") -ceq $ExpectedEndpointShapeSha256 -and
        [string](Get-CertificationValue $tileBatch "pollAccountingVersion" "") -ceq $script:RequiredPollAccountingVersion -and
        $teacherCohorts -eq 20 -and
        $studentsPerCohort -eq $expectedStudentsPerCohort -and
        $teacherTileAssignments -eq (20 * $expectedStudentsPerCohort) -and
        $requestsPerCohortPerPoll -eq 2 -and
        $logicalOperationsPerPoll -eq (2 * $teacherTileAssignments) -and
        $historyRequests -gt 0 -and
        $historyRequests -eq $screenshotRequests -and
        $historyCohortSum -eq $historyRequests -and
        $screenshotCohortSum -eq $screenshotRequests -and
        $completeRoundsClaim -eq $minimumRounds -and
        $maximumRoundsClaim -eq $maximumRounds -and
        $partialCohortsClaim -eq $partialFinalRoundCohorts -and
        $historyLogicalOperations -eq ($historyCohortSum * $studentsPerCohort) -and
        $screenshotLogicalOperations -eq ($screenshotCohortSum * $studentsPerCohort) -and
        $networkRequests -eq ($historyRequests + $screenshotRequests) -and
        $logicalOperations -eq ($historyLogicalOperations + $screenshotLogicalOperations) -and
        $screenshotAttempts -eq $screenshotLogicalOperations -and
        $screenshotSuccesses -ge 0 -and
        $screenshotSuccesses -le $screenshotAttempts
    )
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
        [string]$root.workloadSchemaVersion -cne $Contract.WorkloadSchemaVersion -or
        [string]$root.workloadEndpointShapeSha256 -cne $Contract.WorkloadEndpointShapeSha256 -or
        [string]$root.historyFallbackPiEvidenceVersion -cne $Contract.HistoryFallbackPiEvidenceVersion -or
        (ConvertTo-CertificationComparableJson $root.historyFallbackQueryIdentity) -cne
            (ConvertTo-CertificationComparableJson $Contract.HistoryFallbackQueryIdentity) -or
        (ConvertTo-CertificationComparableJson $root.databaseInsightsLease) -cne
            (ConvertTo-CertificationComparableJson $Contract.DatabaseInsightsLease) -or
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
    $predecessorLeaseRestoration = Get-CertificationValue $envelope "databaseInsightsRestoration"
    if ([int]$envelope.schemaVersion -ne 3 -or [string]$envelope.type -ne "certification_supervisor_terminal" -or
        [string](Get-CertificationValue $envelope "linkVersion" "") -cne $script:RequiredHistoryFallbackPiLinkVersion -or
        $envelope.supervisorSealed -ne $true -or [string]$envelope.status -ne "completed" -or
        [string]$envelope.chainId -ne $Contract.ChainId -or
        [string]$envelope.applicationGitSha -ne $Contract.ApplicationGitSha -or
        [string]$envelope.deployedImageDigest -ne $Contract.DeployedImageDigest -or
        [string]$envelope.workloadSchemaVersion -cne $Contract.WorkloadSchemaVersion -or
        [string]$envelope.workloadEndpointShapeSha256 -cne $Contract.WorkloadEndpointShapeSha256 -or
        [string]$envelope.historyFallbackPiEvidenceVersion -cne $Contract.HistoryFallbackPiEvidenceVersion -or
        (ConvertTo-CertificationComparableJson $envelope.historyFallbackQueryIdentity) -cne
            (ConvertTo-CertificationComparableJson $Contract.HistoryFallbackQueryIdentity) -or
        (ConvertTo-CertificationComparableJson $envelope.databaseInsightsLease) -cne
            (ConvertTo-CertificationComparableJson $Contract.DatabaseInsightsLease) -or
        [string](Get-CertificationValue $predecessorLeaseRestoration "state" "") -cne "retained_for_waf800" -or
        (Get-CertificationValue $predecessorLeaseRestoration "required" $true) -ne $false -or
        [string](Get-CertificationValue $predecessorLeaseRestoration "receiptSha256" "") -cne
            [string]$Contract.DatabaseInsightsLease.receipt.sha256 -or
        [string]$envelope.controllerGitSha -ne $Contract.ControllerGitSha -or
        (ConvertTo-CertificationComparableJson $envelope.controllerHashes) -cne (ConvertTo-CertificationComparableJson $Contract.ControllerHashes) -or
        [string]$envelope.supervisionKind -cne "Load") {
        throw "Predecessor is not a supervisor-sealed accepted terminal result."
    }
    $predecessorPiReceipt = Assert-CertificationPredecessorHistoryFallbackPiEvidence `
        -Config $Config -Envelope $envelope -Contract $Contract
    $envelopeRoot = Assert-CertificationEvidenceReference $envelope.chainRoot "predecessor.chainRoot"
    $envelopeStage = Assert-CertificationEvidenceReference $envelope.stageAttestation "predecessor.stageAttestation"
    $terminal = Assert-CertificationEvidenceReference $envelope.terminalMonitorResult "predecessor.terminalMonitorResult"
    if ($envelopeRoot.sha256 -ne $rootBinding.sha256) { throw "Predecessor belongs to a different chain root." }
    $priorPredecessorSha = [string](Get-CertificationValue $envelope "predecessorSupervisorResultSha256" "")
    $linkInput = (@(
        $rootBinding.sha256,
        $(if($priorPredecessorSha){$priorPredecessorSha}else{"0"*64}),
        $envelopeStage.sha256,
        $terminal.sha256,
        $predecessorPiReceipt.Receipt.sha256,
        $predecessorPiReceipt.ReceiptPathSha256,
        $predecessorPiReceipt.Request.sha256,
        $predecessorPiReceipt.RequestPathSha256,
        $predecessorPiReceipt.TrafficWindowSha256
    ) -join "`n")
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
        [string]$attestation.workloadSchemaVersion -cne $Contract.WorkloadSchemaVersion -or
        [string]$attestation.workloadEndpointShapeSha256 -cne $Contract.WorkloadEndpointShapeSha256 -or
        [string]$attestation.historyFallbackPiEvidenceVersion -cne $Contract.HistoryFallbackPiEvidenceVersion -or
        (ConvertTo-CertificationComparableJson $attestation.historyFallbackQueryIdentity) -cne
            (ConvertTo-CertificationComparableJson $Contract.HistoryFallbackQueryIdentity) -or
        (ConvertTo-CertificationComparableJson $attestation.databaseInsightsLease) -cne
            (ConvertTo-CertificationComparableJson $Contract.DatabaseInsightsLease) -or
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
        foreach($field in @("workloadSchemaVersion","workloadEndpointShapeSha256","historyFallbackQueryIdentity","historyFallbackPiEvidenceVersion","databaseInsightsLease","operatorConfigSha256","boundRuntimeConfigSha256","rollbackConfig","validationReceipt","taskDefinitions","fixture","generatorPublicIpv4","datastorePosture","networkPosture","alarms","schedules","rollbackIdentities")){
            if((ConvertTo-CertificationComparableJson (Get-CertificationValue $root $field)) -cne
                (ConvertTo-CertificationComparableJson (Get-CertificationValue $attestation $field))){
                throw "Waf/500 chain root field '$field' differs from its supervisor-sealed stage attestation."
            }
        }
    }
    if ([string]$monitor.runId -ne [string]$envelope.runId -or [string]$monitor.phase -ne [string]$envelope.phase -or
        [string]$monitor.status -ne "completed" -or $monitor.postureAccepted -ne $true -or $monitor.acceptance.passed -ne $true -or
        (Get-CertificationValue $monitor "diagnosticOnly" $false) -ne $false -or
        (Get-CertificationValue $monitor "certificationEligible" $true) -ne $true -or
        [string]$envelope.terminalMonitorResult.runId -ne [string]$monitor.runId -or
        [string]$envelope.terminalMonitorResult.phase -ne [string]$monitor.phase -or
        [string](Get-CertificationValue $monitor.workload "stage" "") -ne [string](Get-CertificationValue $envelope "stage" "") -or
        [string](Get-CertificationValue $monitor.workload "workloadSchemaVersion" "") -cne $Contract.WorkloadSchemaVersion -or
        [string](Get-CertificationValue $monitor.workload "endpointShapeSha256" "") -cne $Contract.WorkloadEndpointShapeSha256 -or
        -not (Test-CertificationTerminalTileBatchContract $monitor.workload ([string]$envelope.stage) $Contract.WorkloadSchemaVersion $Contract.WorkloadEndpointShapeSha256)) {
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
        workloadSchemaVersion=$Contract.WorkloadSchemaVersion;workloadEndpointShapeSha256=$Contract.WorkloadEndpointShapeSha256
        historyFallbackQueryIdentity=$Contract.HistoryFallbackQueryIdentity;historyFallbackPiEvidenceVersion=$Contract.HistoryFallbackPiEvidenceVersion
        databaseInsightsLease=$Contract.DatabaseInsightsLease
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

$diagnosticOnlyValue = Get-CertificationValue $config "diagnosticOnly" $false
$automaticRollbackValue = Get-CertificationValue $config "automaticRollback" $false
if ($diagnosticOnlyValue -isnot [bool]) { throw "diagnosticOnly must be a JSON boolean." }
if ($automaticRollbackValue -isnot [bool]) { throw "automaticRollback must be a JSON boolean." }
# Preserve the production rollback lock before recovering the private
# certification lease binding. Diagnostic-only supervision deliberately owns
# no application rollback authority, while every other production supervisor
# must still fail on this static contract even when another certification
# field is also malformed or absent. Test-only hook validation remains ahead
# of this check so a forbidden hook cannot be masked by another invalid field.
if (-not $testMode -and -not [bool]$diagnosticOnlyValue -and -not [bool]$automaticRollbackValue) {
    throw "The static AWS monitor/rollback configuration failed validation."
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
$historyFallbackPiRequestPath = Join-Path $evidenceDirectory "$runId-history-fallback-pi-request.private.json"
$historyFallbackPiReceiptPath = Join-Path $evidenceDirectory "$runId-history-fallback-pi-evidence.private.json"

if ($SupervisionKind -eq "Load") {
    $generatedArtifactPaths = @(
        $staticMonitorConfigPath, $heartbeatPath, $supervisorResultPath, $boundConfigPath, $boundRollbackConfigPath,
        $harnessStdout, $harnessStderr, $monitorStdout, $monitorStderr,
        $generatorIpEvidencePath, $harnessReadyPath, $harnessStartGatePath,
        $awsMonitorEvidencePath, $monitorHeartbeatPath, $monitorResultPath,
        $rollbackEvidencePath, $rollbackStatePath, $rollbackHeartbeatPath,
        $validationReceiptPath, $validationReceiptSealPath, $consumedValidationReceiptPath,
        $chainRootOutputPath, $stageAttestationPath,
        $historyFallbackPiRequestPath, $historyFallbackPiReceiptPath
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
    evidenceDirectoryPathSha256 = Get-CertificationTextSha256 $evidenceDirectory
    rawEvidenceDirectoryPersisted = $false
} | ConvertTo-Json
if ($Mode -eq "Validate") {
    $certificationContract = $null
    try {
        # Recover the private lease binding first so every later validation
        # failure can restore Advanced/465 immediately instead of relying only
        # on the detached expiry watchdog.
        $certificationContract = Get-CertificationContract -Config $config -TestMode $testMode -BindHarnessArtifacts:($SupervisionKind -eq "Load")
        Invoke-StaticMonitorValidation -Config $config -EvidenceDirectory $evidenceDirectory -PwshPath $pwsh
        # Mode=Validate remains non-mutating on success. Its lease validation
        # proves both Advanced/465 and a fresh bound watchdog heartbeat.
        [void](Invoke-CertificationDatabaseInsightsLeaseCommand -Config $config -Contract $certificationContract -Mode Validate)
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
    }
    catch {
        $validationFailure = $_
        if ($null -ne $certificationContract) {
            try {
                [void](Invoke-CertificationDatabaseInsightsLeaseCommand -Config $config -Contract $certificationContract -Mode Restore)
            }
            catch {
                throw "Certification validation failed and exact Database Insights restoration also failed; progression is blocked."
            }
        }
        throw $validationFailure
    }
    exit 0
}

$harness = $null
$monitor = $null
$sleepPreventionEnabled = $false
$certificationLeaseValidation = $null
$certificationLeaseRestoration = $null
$certificationLeaseRestoreAttempted = $false
$boundRollbackConfigBinding = $null
$chainRootBinding = $null
$stageAttestationBinding = $null
$historyFallbackPiEvidence = $null
$historyFallbackPiPrivateReference = $null
$historyFallbackPiRequestReference = $null
$historyFallbackPiFinalizationAttempted = $false
$boundRuntimeConfigSha256 = $null
try {
    # Validate the complete monitor and every reachable rollback before sleep
    # is disabled and, critically, before any load traffic process is started.
    # Once the immutable certification contract has been recovered, all run
    # failures are inside this try so the bounded monitoring lease can be
    # restored fail-closed.
    $certificationContract = Get-CertificationContract -Config $config -TestMode $testMode -BindHarnessArtifacts:($SupervisionKind -eq "Load")
    Invoke-StaticMonitorValidation -Config $config -EvidenceDirectory $evidenceDirectory -PwshPath $pwsh
    if ($SupervisionKind -eq "Load") {
        Invoke-HarnessConfigurationPreflight -Config $config -NodePath $node.Source -HarnessPath $runtimeHarnessScript
    }
    $certificationLeaseValidation = Invoke-CertificationDatabaseInsightsLeaseCommand `
        -Config $config -Contract $certificationContract -Mode Validate
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
    if ($null -ne $certificationContract) {
        $supervisorArtifacts += @($historyFallbackPiRequestPath,$historyFallbackPiReceiptPath)
    }
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
            LOAD_DIAGNOSTIC_ONLY                 = "false"
            LOAD_STAGE                           = [string]$config.workload.stage
            LOAD_EXTERNAL_PROGRESS_PATH          = $progressPath
            LOAD_EXTERNAL_SUMMARY_PATH           = $summaryPath
            LOAD_SUPERVISOR_READY_PATH            = $harnessReadyPath
            LOAD_SUPERVISOR_START_GATE_PATH       = $harnessStartGatePath
            LOAD_SUPERVISOR_START_GATE_TIMEOUT_MS = [string](($monitorHeartbeatStaleSeconds + 30) * 1000)
            LOAD_WORKLOAD_SCHEMA_VERSION            = $script:RequiredWorkloadSchemaVersion
            LOAD_TILE_HISTORY_PATH                  = "/api/classpilot/tiles/history"
            LOAD_TILE_SCREENSHOTS_PATH              = "/api/classpilot/tiles/screenshots"
            LOAD_TEACHER_PATHS                      = "/api/students-aggregated"
            LOAD_DASHBOARD_PATHS                    = ""
            LOAD_SCREENSHOT_GET_PATH_TEMPLATE       = ""
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
            $certificationLeaseValidation = Invoke-CertificationDatabaseInsightsLeaseCommand `
                -Config $config -Contract $certificationContract -Mode Validate
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
    if ($monitor.ExitCode -ne 0) {
        throw (New-CertificationTerminalFailureException "monitor_rejected" "monitor_terminal" `
            "The AWS monitor exited with code $($monitor.ExitCode).")
    }
    if ($SupervisionKind -eq "Load") {
        $harness.Refresh()
        if (-not $harness.HasExited) { $harness.WaitForExit(30000) | Out-Null }
        $harness.Refresh()
        if (-not $harness.HasExited) {
            throw (New-CertificationTerminalFailureException "harness_terminal_missing" "harness_terminal" `
                "The load harness did not exit after monitor acceptance.")
        }
        if ($harness.ExitCode -ne 0) {
            throw (New-CertificationTerminalFailureException "harness_rejected" "harness_terminal" `
                "The load harness exited with code $($harness.ExitCode).")
        }
    }
    if (-not (Test-Path -LiteralPath $monitorResultPath -PathType Leaf)) {
        throw (New-CertificationTerminalFailureException "monitor_terminal_missing" "monitor_terminal" `
            "The monitor exited successfully without a terminal monitor result.")
    }
    $terminalMonitor = Get-Content -LiteralPath $monitorResultPath -Raw | ConvertFrom-Json -Depth 60
    if ([string]$terminalMonitor.runId -ne $runId -or [string]$terminalMonitor.phase -ne [string]$config.phase -or
        [string]$terminalMonitor.status -ne "completed" -or $terminalMonitor.postureAccepted -ne $true -or
        $terminalMonitor.acceptance.passed -ne $true -or
        (Get-CertificationValue $terminalMonitor "diagnosticOnly" $false) -ne $false -or
        (Get-CertificationValue $terminalMonitor "certificationEligible" $true) -ne $true) {
        throw (New-CertificationTerminalFailureException "monitor_gate_rejected" "monitor_terminal" `
            "The monitor terminal result is not accepted evidence for this exact supervised stage.")
    }
    if ($null -ne $certificationContract -and -not (Test-CertificationTerminalTileBatchContract `
        $terminalMonitor.workload ([string]$config.workload.stage) `
        $certificationContract.WorkloadSchemaVersion $certificationContract.WorkloadEndpointShapeSha256)) {
        throw (New-CertificationTerminalFailureException "workload_contract_rejected" "workload_terminal" `
            "The monitor terminal result does not prove the exact reviewed tile-batch workload contract.")
    }
    if ($null -ne $certificationContract -and ($null -eq $chainRootBinding -or $null -eq $stageAttestationBinding)) {
        throw (New-CertificationTerminalFailureException "certification_attestation_missing" "certification_binding" `
            "Certification stage/root attestations were not sealed before traffic.")
    }
    if ($null -ne $certificationContract) {
        $acceptedStage = [string](Get-CertificationValue (Get-CertificationValue $config "workload") "stage" "")
        # SQL-statistics publication trails traffic.  Finalize the deterministic
        # query-id evidence while the bounded Advanced/465 lease is still
        # active, after the monitor has already sealed workload/posture and
        # restoration evidence.  No workload is kept alive for this wait.
        if ([string]$config.phase -eq "Waf" -and $acceptedStage -in @("500","800")) {
            if ($SupervisionKind -ne "Load") {
                throw "Waf/500 and Waf/800 deterministic PI evidence requires supervised load traffic."
            }
            $historyFallbackPiFinalizationAttempted = $true
            try {
                $piFinalization = Invoke-CertificationHistoryFallbackPiFinalizer `
                    -Config $config -Contract $certificationContract -ProgressPath $progressPath `
                    -SummaryPath $summaryPath -RequestPath $historyFallbackPiRequestPath `
                    -ReceiptPath $historyFallbackPiReceiptPath
            }
            catch {
                if ($_.Exception.Data.Contains("historyFallbackPiEvidence")) {
                    $historyFallbackPiEvidence = $_.Exception.Data["historyFallbackPiEvidence"]
                }
                if ($_.Exception.Data.Contains("historyFallbackPiEvidenceReceipt")) {
                    $historyFallbackPiPrivateReference = $_.Exception.Data["historyFallbackPiEvidenceReceipt"]
                }
                if ($_.Exception.Data.Contains("historyFallbackPiFinalizationRequest")) {
                    $historyFallbackPiRequestReference = $_.Exception.Data["historyFallbackPiFinalizationRequest"]
                }
                throw
            }
            $historyFallbackPiEvidence = $piFinalization.Public
            $historyFallbackPiPrivateReference = $piFinalization.PrivateReference
            $historyFallbackPiRequestReference = $piFinalization.RequestReference
        }
        if ([string]$config.phase -eq "Waf" -and $acceptedStage -eq "500") {
            # The certification lease spans the accepted Waf/500 -> Waf/800
            # chain. It is intentionally retained only after a sealed Waf/500
            # success; predecessor validation requires this exact state.
            $certificationLeaseRestoration = [ordered]@{
                required = $false
                state = "retained_for_waf800"
                leaseVersion = $certificationContract.DatabaseInsightsLease.version
                receiptSha256 = $certificationContract.DatabaseInsightsLease.receipt.sha256
                durableRestoreGuardVersion = $certificationContract.DatabaseInsightsLease.durableRestoreGuard.version
                durableRestoreGuardBindingSha256 = $certificationContract.DatabaseInsightsLease.durableRestoreGuard.bindingSha256
                durableRestoreGuardState = "armed"
                retainedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            }
        }
        else {
            $certificationLeaseRestoreAttempted = $true
            try {
                $restoredLease = Invoke-CertificationDatabaseInsightsLeaseCommand `
                    -Config $config -Contract $certificationContract -Mode Restore
                $certificationLeaseRestoration = [ordered]@{
                    required = $true
                    state = $restoredLease.state
                    leaseVersion = $restoredLease.leaseVersion
                    receiptSha256 = $restoredLease.receiptSha256
                    durableRestoreGuardVersion = $restoredLease.durableRestoreGuardVersion
                    durableRestoreGuardBindingSha256 = $restoredLease.durableRestoreGuardBindingSha256
                    durableRestoreGuardState = $restoredLease.durableRestoreGuardState
                    restoredAtUtc = $restoredLease.restoredAtUtc
                    observedPosture = $restoredLease.observedPosture
                }
            }
            catch {
                $certificationLeaseRestoration = [ordered]@{
                    required = $true
                    state = "restore_failed"
                    leaseVersion = $certificationContract.DatabaseInsightsLease.version
                    receiptSha256 = $certificationContract.DatabaseInsightsLease.receipt.sha256
                    durableRestoreGuardVersion = $certificationContract.DatabaseInsightsLease.durableRestoreGuard.version
                    durableRestoreGuardBindingSha256 = $certificationContract.DatabaseInsightsLease.durableRestoreGuard.bindingSha256
                    durableRestoreGuardState = "restore_failed"
                    completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
                    discardedMessageSha256 = Get-CertificationTextSha256 $_.Exception.Message
                    rawErrorPersisted = $false
                }
                throw
            }
        }
    }
    $monitorResultSha256 = Get-CertificationSha256 $monitorResultPath
    $predecessorSha = [string](Get-CertificationValue $config "predecessorResultSha256" "")
    $linkInput = (@(
        [string](Get-CertificationValue $chainRootBinding "sha256" ("0"*64)),
        $(if ($predecessorSha) { $predecessorSha } else { "0"*64 }),
        [string](Get-CertificationValue $stageAttestationBinding "sha256" ("0"*64)),
        $monitorResultSha256,
        [string](Get-CertificationValue $historyFallbackPiEvidence "receiptSha256" ("0"*64)),
        [string](Get-CertificationValue $historyFallbackPiEvidence "receiptPathSha256" ("0"*64)),
        [string](Get-CertificationValue $historyFallbackPiEvidence "requestSha256" ("0"*64)),
        [string](Get-CertificationValue $historyFallbackPiEvidence "requestPathSha256" ("0"*64)),
        [string](Get-CertificationValue $historyFallbackPiEvidence "trafficWindowSha256" ("0"*64))
    ) -join "`n")
    Write-AtomicJson -Path $supervisorResultPath -Value ([ordered]@{
        schemaVersion = 3; type = "certification_supervisor_terminal"; linkVersion = $script:RequiredHistoryFallbackPiLinkVersion; supervisorSealed = $null -ne $certificationContract
        runId = $runId; phase = [string]$config.phase
        stage = if ($null -eq (Get-CertificationValue $config "workload")) { $null } else { [string]$config.workload.stage }
        chainId = if ($null -eq $certificationContract) { $null } else { $certificationContract.ChainId }
        applicationGitSha = if ($null -eq $certificationContract) { $null } else { $certificationContract.ApplicationGitSha }
        deployedImageDigest = if ($null -eq $certificationContract) { $null } else { $certificationContract.DeployedImageDigest }
        workloadSchemaVersion = if ($null -eq $certificationContract) { $null } else { $certificationContract.WorkloadSchemaVersion }
        workloadEndpointShapeSha256 = if ($null -eq $certificationContract) { $null } else { $certificationContract.WorkloadEndpointShapeSha256 }
        historyFallbackQueryIdentity = if ($null -eq $certificationContract) { $null } else { $certificationContract.HistoryFallbackQueryIdentity }
        historyFallbackPiEvidenceVersion = if ($null -eq $certificationContract) { $null } else { $certificationContract.HistoryFallbackPiEvidenceVersion }
        historyFallbackPiEvidence = $historyFallbackPiEvidence
        databaseInsightsLease = if ($null -eq $certificationContract) { $null } else { $certificationContract.DatabaseInsightsLease }
        databaseInsightsLeaseValidation = $certificationLeaseValidation
        databaseInsightsRestoration = $certificationLeaseRestoration
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
    $runFailure = $_.Exception
    Stop-BoundProcess -Process $harness
    Stop-BoundProcess -Process $monitor
    $terminalMonitorFailureBinding = $null
    $terminalMonitorForFailure = $null
    if (Test-Path -LiteralPath $monitorResultPath -PathType Leaf) {
        try {
            $terminalMonitorForFailure = Get-Content -LiteralPath $monitorResultPath -Raw | ConvertFrom-Json -Depth 60
            if ([string](Get-CertificationValue $terminalMonitorForFailure "runId" "") -cne $runId -or
                [string](Get-CertificationValue $terminalMonitorForFailure "phase" "") -cne [string]$config.phase -or
                [string](Get-CertificationValue $terminalMonitorForFailure "status" "") -notin @("completed","failed")) {
                throw "The terminal monitor result was not identity-bound to this run."
            }
            $monitorFailures = @(Get-CertificationValue $terminalMonitorForFailure "failures" @())
            $rollback = Get-CertificationValue $terminalMonitorForFailure "rollback"
            $terminalMonitorFailureBinding = [ordered]@{
                pathSha256=Get-CertificationTextSha256 ([IO.Path]::GetFullPath($monitorResultPath))
                sha256=Get-CertificationSha256 $monitorResultPath
                runId=$runId;phase=[string]$config.phase
                status=[string](Get-CertificationValue $terminalMonitorForFailure "status" "")
                failureCount=$monitorFailures.Count
                failuresSha256=Get-CertificationCanonicalSha256 @($monitorFailures)
                rollbackAttempted=[bool](Get-CertificationValue $rollback "attempted" $false)
                rollbackExitCode=Get-CertificationValue $rollback "exitCode"
                rawPathsPersisted=$false
            }
        }
        catch {
            $terminalBindingFailureMessage = $_.Exception.Message
            $observedTerminalSha = $null
            try { $observedTerminalSha = Get-CertificationSha256 $monitorResultPath } catch { }
            $terminalMonitorForFailure = $null
            $terminalMonitorFailureBinding = [ordered]@{
                pathSha256=Get-CertificationTextSha256 ([IO.Path]::GetFullPath($monitorResultPath))
                sha256=$observedTerminalSha
                runId=$runId;phase=[string]$config.phase;status="rejected"
                discardedMessageSha256=Get-CertificationTextSha256 $terminalBindingFailureMessage
                rawPathsPersisted=$false
            }
        }
    }
    $piFinalizationFailureSha256 = $null
    $stageForFailure = if ($null -eq (Get-CertificationValue $config "workload")) { "" } else {
        [string](Get-CertificationValue $config.workload "stage" "")
    }
    $eligibleForPostFailurePi = (
        $null -ne $certificationContract -and $SupervisionKind -eq "Load" -and
        [string]$config.phase -ceq "Waf" -and $stageForFailure -in @("500","800") -and
        $null -ne $terminalMonitorForFailure -and
        (Test-Path -LiteralPath $progressPath -PathType Leaf) -and
        (Test-Path -LiteralPath $summaryPath -PathType Leaf)
    )
    if ($eligibleForPostFailurePi -and -not $historyFallbackPiFinalizationAttempted) {
        # A rejected harness or monitor does not erase a coherent terminal
        # traffic window.  Wait until the monitor/rollback terminal is sealed,
        # then collect the independent SQL-statistics evidence while the
        # bounded Advanced lease remains active.  The original failure remains
        # primary regardless of the PI outcome.
        $historyFallbackPiFinalizationAttempted = $true
        try {
            $piFinalization = Invoke-CertificationHistoryFallbackPiFinalizer `
                -Config $config -Contract $certificationContract -ProgressPath $progressPath `
                -SummaryPath $summaryPath -RequestPath $historyFallbackPiRequestPath `
                -ReceiptPath $historyFallbackPiReceiptPath
            $historyFallbackPiEvidence = $piFinalization.Public
            $historyFallbackPiPrivateReference = $piFinalization.PrivateReference
            $historyFallbackPiRequestReference = $piFinalization.RequestReference
        }
        catch {
            $piFinalizationFailureSha256 = Get-CertificationTextSha256 $_.Exception.Message
            if ($_.Exception.Data.Contains("historyFallbackPiEvidence")) {
                $historyFallbackPiEvidence = $_.Exception.Data["historyFallbackPiEvidence"]
            }
            if ($_.Exception.Data.Contains("historyFallbackPiEvidenceReceipt")) {
                $historyFallbackPiPrivateReference = $_.Exception.Data["historyFallbackPiEvidenceReceipt"]
            }
            if ($_.Exception.Data.Contains("historyFallbackPiFinalizationRequest")) {
                $historyFallbackPiRequestReference = $_.Exception.Data["historyFallbackPiFinalizationRequest"]
            }
        }
    }
    if ($null -ne $certificationContract -and -not $certificationLeaseRestoreAttempted) {
        $certificationLeaseRestoreAttempted = $true
        try {
            $restoredLease = Invoke-CertificationDatabaseInsightsLeaseCommand `
                -Config $config -Contract $certificationContract -Mode Restore
            $certificationLeaseRestoration = [ordered]@{
                required = $true
                state = $restoredLease.state
                leaseVersion = $restoredLease.leaseVersion
                receiptSha256 = $restoredLease.receiptSha256
                durableRestoreGuardVersion = $restoredLease.durableRestoreGuardVersion
                durableRestoreGuardBindingSha256 = $restoredLease.durableRestoreGuardBindingSha256
                durableRestoreGuardState = $restoredLease.durableRestoreGuardState
                restoredAtUtc = $restoredLease.restoredAtUtc
                observedPosture = $restoredLease.observedPosture
            }
        }
        catch {
            $certificationLeaseRestoration = [ordered]@{
                required = $true
                state = "restore_failed"
                leaseVersion = $certificationContract.DatabaseInsightsLease.version
                receiptSha256 = $certificationContract.DatabaseInsightsLease.receipt.sha256
                durableRestoreGuardVersion = $certificationContract.DatabaseInsightsLease.durableRestoreGuard.version
                durableRestoreGuardBindingSha256 = $certificationContract.DatabaseInsightsLease.durableRestoreGuard.bindingSha256
                durableRestoreGuardState = "restore_failed"
                completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
                discardedMessageSha256 = Get-CertificationTextSha256 $_.Exception.Message
                rawErrorPersisted = $false
            }
        }
    }
    elseif ($null -ne $certificationContract -and $certificationLeaseRestoreAttempted -and $null -eq $certificationLeaseRestoration) {
        $certificationLeaseRestoration = [ordered]@{
            required = $true
            state = "restore_failed"
            leaseVersion = $certificationContract.DatabaseInsightsLease.version
            receiptSha256 = $certificationContract.DatabaseInsightsLease.receipt.sha256
            durableRestoreGuardVersion = $certificationContract.DatabaseInsightsLease.durableRestoreGuard.version
            durableRestoreGuardBindingSha256 = $certificationContract.DatabaseInsightsLease.durableRestoreGuard.bindingSha256
            durableRestoreGuardState = "restore_failed"
            completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            rawErrorPersisted = $false
        }
    }
    $termination = if ($SupervisionKind -eq "Load") { "Traffic was terminated" } else { "Monitor-only supervision was terminated" }
    $restorationMessage = if ($null -eq $certificationContract) {
        "No certification monitoring lease was bound."
    }
    elseif ([string](Get-CertificationValue $certificationLeaseRestoration "state" "") -eq "restored") {
        "The bounded Database Insights lease was restored to its exact Standard/7 posture."
    }
    else {
        "Exact Database Insights lease restoration failed or could not be proven; progression is blocked."
    }
    $failureCode = if ($runFailure.Data.Contains("failureCode")) {
        [string]$runFailure.Data["failureCode"]
    }
    elseif ($null -ne $historyFallbackPiEvidence -and
        (Get-CertificationValue $historyFallbackPiEvidence "passed" $false) -ne $true) {
        "history_fallback_pi_evidence_rejected"
    }
    else { "certification_supervision_failed" }
    $failureStage = if ($runFailure.Data.Contains("failureStage")) {
        [string]$runFailure.Data["failureStage"]
    }
    elseif ($failureCode -eq "history_fallback_pi_evidence_rejected") {
        [string](Get-CertificationValue $historyFallbackPiEvidence "failureStage" "history_fallback_gate")
    }
    else { "supervisor" }
    $discardedFailureMessageSha256 = Get-CertificationTextSha256 $runFailure.Message
    $settledFindings = [System.Collections.Generic.List[object]]::new()
    $settledFindings.Add([ordered]@{
        kind="primary_failure";failureCode=$failureCode;failureStage=$failureStage
        discardedMessageSha256=$discardedFailureMessageSha256;rawErrorPersisted=$false
    })
    if ($null -ne $historyFallbackPiEvidence) {
        $piPassed = (Get-CertificationValue $historyFallbackPiEvidence "passed" $false) -eq $true
        $settledFindings.Add([ordered]@{
            kind="history_fallback_pi_evidence"
            failureCode=if($piPassed){$null}else{[string](Get-CertificationValue $historyFallbackPiEvidence "failureCode" "history_fallback_pi_evidence_rejected")}
            failureStage=if($piPassed){$null}else{[string](Get-CertificationValue $historyFallbackPiEvidence "failureStage" "history_fallback_gate")}
            collected=(Get-CertificationValue $historyFallbackPiEvidence "collected" $false)
            passed=$piPassed
            receiptSha256=Get-CertificationValue $historyFallbackPiEvidence "receiptSha256"
            requestSha256=Get-CertificationValue $historyFallbackPiEvidence "requestSha256"
            rawErrorPersisted=$false
        })
    }
    elseif ($historyFallbackPiFinalizationAttempted) {
        $settledFindings.Add([ordered]@{
            kind="history_fallback_pi_evidence";failureCode="performance_insights_evidence_unavailable"
            failureStage="coherent_window_or_request_validation";collected=$false;passed=$false
            discardedMessageSha256=$piFinalizationFailureSha256;rawErrorPersisted=$false
        })
    }
    if ($null -ne $certificationContract -and
        [string](Get-CertificationValue $certificationLeaseRestoration "state" "") -ne "restored") {
        $settledFindings.Add([ordered]@{
            kind="database_insights_restoration";failureCode="database_insights_restoration_failed"
            failureStage="database_insights_restoration";collected=$false;passed=$false;rawErrorPersisted=$false
        })
    }
    $message = "Run $runId became invalid ($failureCode/$failureStage; discarded-message SHA-256 $discardedFailureMessageSha256). $termination. $restorationMessage No other infrastructure mutation was attempted by the supervisor."
    Send-SupervisorNotification -Config $config -Message $message
    Write-AtomicJson -Path $supervisorResultPath -Value ([ordered]@{
        schemaVersion=3;type="certification_supervisor_terminal";linkVersion=$script:RequiredHistoryFallbackPiLinkVersion;supervisorSealed=$false
        runId = $runId; phase=[string]$config.phase; status = "failed"; timestamp = [DateTimeOffset]::UtcNow.ToString("o")
        failureCode=$failureCode;failureStage=$failureStage
        discardedMessageSha256=$discardedFailureMessageSha256;rawErrorPersisted=$false
        settledFindings=@($settledFindings)
        terminalMonitorResult=$terminalMonitorFailureBinding
        historyFallbackQueryIdentity = if ($null -eq $certificationContract) { $null } else { $certificationContract.HistoryFallbackQueryIdentity }
        historyFallbackPiEvidenceVersion = if ($null -eq $certificationContract) { $null } else { $certificationContract.HistoryFallbackPiEvidenceVersion }
        historyFallbackPiEvidence = $historyFallbackPiEvidence
        databaseInsightsLease = if ($null -eq $certificationContract) { $null } else { $certificationContract.DatabaseInsightsLease }
        databaseInsightsLeaseValidation = $certificationLeaseValidation
        databaseInsightsRestoration = $certificationLeaseRestoration
    })
    if ($null -ne $certificationContract -and
        [string](Get-CertificationValue $certificationLeaseRestoration "state" "") -ne "restored") {
        throw "Certification failed and exact Database Insights Standard/7 restoration was not proven; progression is blocked."
    }
    throw $runFailure
}
finally {
    Stop-BoundProcess -Process $harness
    Stop-BoundProcess -Process $monitor
    if ($sleepPreventionEnabled) { try { Set-SleepPrevention -Enabled $false } catch { } }
}
