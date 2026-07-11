#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $true)]
    [ValidateSet("Application", "Oom", "Waf", "PublicEcs", "NatRemoved", "Redis")]
    [string]$Action,

    [ValidateSet("Validate", "Execute", "Heartbeat")]
    [string]$Mode = "Validate",

    [int]$ParentProcessId = 0,
    [string]$ParentProcessStartedAtUtc = "",
    [string]$RollbackHeartbeatPath = "",
    [string]$HeartbeatStatePath = "",
    [string]$RollbackDeadlineUtc = "",
    [int]$HeartbeatIntervalSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:RollbackDeadline = [DateTimeOffset]::MaxValue
$script:RollbackProgressStatePath = $null
$script:RollbackRunId = ""
$script:RollbackFailureDetails = $null

function Test-IsInsideDirectory {
    param([string]$Path, [string]$Directory)
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    return $candidate -eq $root -or $candidate.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
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

function Set-RollbackProgress {
    param([string]$Status, [string]$Step, [string]$ErrorMessage = "")
    if (-not $script:RollbackProgressStatePath) { return }
    $state = [ordered]@{
        runId = [string]$script:RollbackRunId
        action = $Action
        status = $Status
        step = $Step
        timestamp = [DateTimeOffset]::UtcNow.ToString("o")
        deadlineUtc = $script:RollbackDeadline.ToString("o")
    }
    if ($ErrorMessage) { $state.error = $ErrorMessage }
    Write-AtomicJson -Path $script:RollbackProgressStatePath -Value $state
}

function Assert-RollbackDeadline {
    param([string]$Step)
    if ([DateTimeOffset]::UtcNow -ge $script:RollbackDeadline) {
        throw "Rollback action deadline reached before '$Step'."
    }
    Set-RollbackProgress -Status "running" -Step $Step
}

function Get-ExternalPath {
    param([string]$Path, [string]$Name, [switch]$AllowMissing, [switch]$AllowOneDrivePlaceholder)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw "$Name must be an absolute path outside the repository."
    }
    if ($Path.StartsWith("\\?\") -or $Path.StartsWith("\\.\")) {
        throw "$Name must not use a device-namespace path."
    }
    $absolute = [IO.Path]::GetFullPath($Path)
    $repo = $script:RepositoryRoot.TrimEnd('\', '/')
    if ($absolute -eq $repo -or $absolute.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name must be outside the repository."
    }
    $cursor = $absolute
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                $oneDriveRoots = @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                    ForEach-Object { [IO.Path]::GetFullPath([string]$_).TrimEnd('\', '/') }
                $isOneDrivePlaceholder = $false
                if ($AllowOneDrivePlaceholder -and [string]::IsNullOrWhiteSpace([string]$item.LinkType) -and
                    [string]::IsNullOrWhiteSpace([string]$item.LinkTarget)) {
                    foreach ($root in $oneDriveRoots) {
                        if ($cursor -eq $root -or $cursor.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                            $isOneDrivePlaceholder = $true
                            break
                        }
                    }
                }
                if (-not $isOneDrivePlaceholder) { throw "$Name must not traverse a symbolic link or junction." }
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $absolute)) { throw "$Name does not exist." }
    return $absolute
}

function Get-RequiredString {
    param($Object, [string]$Property)
    $member = $Object.PSObject.Properties[$Property]
    $value = if ($null -eq $member) { $null } else { $member.Value }
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) {
        throw "Rollback config requires '$Property' for action $Action."
    }
    return [string]$value
}

function Get-RequiredStringArray {
    param($Object, [string]$Property)
    $propertyValue = $Object.PSObject.Properties[$Property]
    $values = if ($null -eq $propertyValue) { @() } else { @($propertyValue.Value) }
    $clean = @($values | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($clean.Count -lt 1) { throw "Rollback config requires a non-empty '$Property' for action $Action." }
    return $clean
}

function Assert-SafeIdentifier {
    param([string]$Value, [string]$Name, [int]$MaximumLength = 128)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt $MaximumLength -or
        $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $Value.EndsWith('.')) {
        throw "$Name must be a filename-safe identifier of at most $MaximumLength characters."
    }
    return $Value
}

function Join-ContainedPath {
    param([string]$Directory, [string]$FileName)
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $FileName))
    if (-not $candidate.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Rollback evidence path escaped its configured directory."
    }
    return $candidate
}

function Invoke-HeartbeatWorker {
    if ($ParentProcessId -le 0 -or $HeartbeatIntervalSeconds -lt 1 -or
        [string]::IsNullOrWhiteSpace($ParentProcessStartedAtUtc) -or
        [string]::IsNullOrWhiteSpace($RollbackDeadlineUtc)) {
        throw "Heartbeat mode requires a bound parent, interval, and deadline."
    }
    $heartbeatPath = Get-ExternalPath -Path $RollbackHeartbeatPath -Name "RollbackHeartbeatPath" -AllowMissing
    $statePath = Get-ExternalPath -Path $HeartbeatStatePath -Name "HeartbeatStatePath"
    $parentStarted = ([DateTimeOffset]$ParentProcessStartedAtUtc).ToUniversalTime()
    $deadline = ([DateTimeOffset]$RollbackDeadlineUtc).ToUniversalTime()
    do {
        $parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
        $bound = $false
        if ($null -ne $parent) {
            try { $bound = [math]::Abs((([DateTimeOffset]$parent.StartTime).ToUniversalTime() - $parentStarted).TotalSeconds) -le 2 }
            catch { $bound = $false }
        }
        try { $state = Read-AtomicJson -Path $statePath -Depth 20 }
        catch { $state = [pscustomobject]@{ runId = "unknown"; status = "state_unreadable"; step = "heartbeat" } }
        $status = if ($bound) { [string]$state.status } else { "orphaned" }
        Write-AtomicJson -Path $heartbeatPath -Value ([ordered]@{
            runId = [string]$state.runId
            action = $Action
            status = $status
            step = [string]$state.step
            timestamp = [DateTimeOffset]::UtcNow.ToString("o")
            deadlineUtc = $deadline.ToString("o")
            rollbackProcessId = $ParentProcessId
        })
        if (-not $bound -or $status -in @("completed", "failed") -or [DateTimeOffset]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds $HeartbeatIntervalSeconds
    } while ($true)
    if (-not $bound -or [DateTimeOffset]::UtcNow -ge $deadline) { exit 2 }
    exit 0
}

if ($Mode -eq "Heartbeat") {
    Invoke-HeartbeatWorker
}

function Read-Config {
    $path = Get-ExternalPath -Path $ConfigPath -Name "ConfigPath"
    try { $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "ConfigPath must contain valid JSON." }
    if ([int]$config.schemaVersion -ne 1) { throw "Rollback config schemaVersion must be 1." }
    $testModeProperty = $config.PSObject.Properties["testMode"]
    $testMode = if ($null -eq $testModeProperty) { $false } else { $testModeProperty.Value }
    if ($testMode -isnot [bool]) { throw "Rollback config testMode must be a JSON boolean." }
    $config | Add-Member -NotePropertyName resolvedTestMode -NotePropertyValue ([bool]$testMode) -Force
    $maximumRunIdLength = if ($Action -eq "NatRemoved") { 44 } else { 128 }
    $safeRunId = Assert-SafeIdentifier -Value (Get-RequiredString -Object $config -Property "runId") -Name "runId" -MaximumLength $maximumRunIdLength
    $config.runId = $safeRunId
    foreach ($name in @("region", "cluster", "apiService", "workerService")) {
        [void](Get-RequiredString -Object $config -Property $name)
    }
    $resolvedEvidenceDirectory = Get-ExternalPath -Path (Get-RequiredString $config "evidenceDirectory") -Name "evidenceDirectory" -AllowMissing
    $config | Add-Member -NotePropertyName resolvedEvidenceDirectory -NotePropertyValue $resolvedEvidenceDirectory -Force
    $timeoutDefaults = [ordered]@{
        Application = 900
        Oom = 900
        Waf = 600
        PublicEcs = 900
        NatRemoved = 2700
        Redis = 2400
    }
    $timeoutObject = $config.PSObject.Properties["rollbackMaximumSeconds"]
    $timeoutValue = if ($null -eq $timeoutObject -or $null -eq $timeoutObject.Value) {
        [int]$timeoutDefaults[$Action]
    } else {
        $actionMember = $timeoutObject.Value.PSObject.Properties[$Action]
        if ($null -eq $actionMember -or $actionMember.Value -isnot [int] -and $actionMember.Value -isnot [long]) {
            throw "rollbackMaximumSeconds requires integer action '$Action'."
        }
        [int]$actionMember.Value
    }
    if ($timeoutValue -lt 1 -or $timeoutValue -gt 3600) { throw "rollbackMaximumSeconds.$Action is outside the allowed bound." }
    if (-not $config.resolvedTestMode -and $timeoutValue -ne [int]$timeoutDefaults[$Action]) {
        throw "Production rollbackMaximumSeconds.$Action is immutable."
    }
    $heartbeatMember = $config.PSObject.Properties["rollbackHeartbeatIntervalSeconds"]
    $heartbeatInterval = if ($null -eq $heartbeatMember -or $null -eq $heartbeatMember.Value) { 15 } else { [int]$heartbeatMember.Value }
    if (($config.resolvedTestMode -and ($heartbeatInterval -lt 1 -or $heartbeatInterval -gt 15)) -or
        (-not $config.resolvedTestMode -and $heartbeatInterval -ne 15)) {
        throw "rollbackHeartbeatIntervalSeconds must be 15 outside testMode."
    }
    $config | Add-Member -NotePropertyName resolvedRollbackMaximumSeconds -NotePropertyValue $timeoutValue -Force
    $config | Add-Member -NotePropertyName resolvedRollbackHeartbeatIntervalSeconds -NotePropertyValue $heartbeatInterval -Force
    switch ($Action) {
        "Application" {
            [void](Get-RequiredString $config "previousApiTaskDefinition")
            [void](Get-RequiredString $config "previousWorkerTaskDefinition")
            [void](Get-RequiredString $config "targetGroupArn")
        }
        "Oom" {
            [void](Get-RequiredString $config "emergencyApiTaskDefinition")
            [void](Get-RequiredString $config "emergencyApiTaskDefinitionFamily")
            [void](Get-RequiredString $config "emergencyApiContainerName")
            [void](Get-RequiredString $config "targetGroupArn")
            Assert-EmergencyTaskDefinition -Config $config
        }
        "Waf" {
            foreach ($name in @("wafName", "wafId", "wafScope")) { [void](Get-RequiredString $config $name) }
            if ($config.wafScope -notin @("CLOUDFRONT", "REGIONAL")) { throw "wafScope must be CLOUDFRONT or REGIONAL." }
            foreach ($name in @("wafDeviceMetricName", "wafApiMetricName")) { [void](Get-RequiredString $config $name) }
            if ([int]$config.wafDeviceLimit -ne 100000 -or [int]$config.wafApiLimit -ne 50000) {
                throw "WAF rollback config must retain the reviewed 100000/50000 limits."
            }
        }
        "PublicEcs" {
            [void](Get-RequiredStringArray $config "privateSubnetIds")
            [void](Get-RequiredStringArray $config "ecsSecurityGroupIds")
            [void](Get-RequiredStringArray $config "privateRouteTableIds")
            [void](Get-RequiredString $config "vpcId")
            if ([int]$config.expectedNatGatewayCount -ne 2) {
                throw "PublicEcs rollback requires exactly two retained NAT gateways."
            }
            [void](Get-RequiredString $config "targetGroupArn")
        }
        "NatRemoved" {
            $plan = Get-ExternalPath -Path (Get-RequiredString $config "natRollbackPlanPath") -Name "natRollbackPlanPath"
            $expectedPlanHash = (Get-RequiredString $config "natRollbackPlanSha256").ToLowerInvariant()
            if ($expectedPlanHash -notmatch '^[0-9a-f]{64}$') { throw "natRollbackPlanSha256 must be a SHA-256 hex digest." }
            $actualPlanHash = (Get-FileHash -LiteralPath $plan -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualPlanHash -ne $expectedPlanHash) { throw "The NAT rollback plan hash does not match the reviewed plan." }
            [void](Get-RequiredString $config "vpcId")
            [void](Get-RequiredStringArray $config "privateSubnetIds")
            [void](Get-RequiredStringArray $config "ecsSecurityGroupIds")
            [void](Get-RequiredStringArray $config "privateRouteTableIds")
            [void](Get-RequiredString $config "targetGroupArn")
            if ([int]$config.expectedNatGatewayCount -lt 1 -or [int]$config.expectedNatGatewayCount -gt 4) {
                throw "expectedNatGatewayCount must be between 1 and 4."
            }
            $terraformDirectory = [IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot "infra"))
            if (-not (Test-Path -LiteralPath $terraformDirectory -PathType Container)) { throw "Terraform directory is missing." }
            $config | Add-Member -NotePropertyName resolvedNatRollbackPlanPath -NotePropertyValue $plan -Force
            $statePath = [IO.Path]::GetFullPath((Get-RequiredString $config "terraformStatePath"))
            if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw "terraformStatePath does not exist." }
            $expectedStatePath = [IO.Path]::GetFullPath((Join-Path $terraformDirectory "terraform.tfstate"))
            if (-not $config.resolvedTestMode -and -not [string]::Equals($statePath, $expectedStatePath, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Production NAT rollback requires the exact infra/terraform.tfstate path."
            }
            $stateLineage = Get-RequiredString $config "terraformStateLineage"
            try { $localState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -Depth 20 }
            catch { throw "terraformStatePath must contain valid Terraform state JSON." }
            if ([string]$localState.lineage -ne $stateLineage) { throw "terraformStateLineage does not match the local state." }
            $gitSha = (@(& git -C $script:RepositoryRoot rev-parse --verify HEAD 2>$null) | Select-Object -First 1).Trim().ToLowerInvariant()
            if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch '^[0-9a-f]{40}$') { throw "Unable to resolve the exact repository Git SHA." }
            $planPhase = Assert-SafeIdentifier -Value (Get-RequiredString $config "natRollbackPlanPhase") -Name "natRollbackPlanPhase"
            $expectedPlanPattern = '^\d{8}T\d{6}Z-' + [regex]::Escape($gitSha) + '-' + [regex]::Escape($planPhase) + '\.tfplan$'
            if ([IO.Path]::GetFileName($plan) -cnotmatch $expectedPlanPattern) {
                throw "natRollbackPlanPath must be named <UTC>-<exact git SHA>-<phase>.tfplan."
            }
            Assert-NatRollbackPlanShape -PlanPath $plan
            $backupDirectory = Get-ExternalPath -Path (Get-RequiredString $config "stateBackupOutputDirectory") `
                -Name "stateBackupOutputDirectory" -AllowMissing
            $recoveryDirectory = Get-ExternalPath -Path (Get-RequiredString $config "stateRecoveryDirectory") `
                -Name "stateRecoveryDirectory" -AllowMissing -AllowOneDrivePlaceholder
            $credentialPath = Get-ExternalPath -Path (Get-RequiredString $config "recoveryCredentialPath") `
                -Name "recoveryCredentialPath"
            if (-not $config.resolvedTestMode) {
                $oneDriveRoots = @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                    ForEach-Object { [IO.Path]::GetFullPath((Join-Path ([string]$_) "SchoolPilot-Recovery")).TrimEnd('\', '/') }
                $insideOneDrive = @($oneDriveRoots | Where-Object {
                    $recoveryDirectory -eq $_ -or $recoveryDirectory.StartsWith($_ + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
                }).Count -gt 0
                if (-not $insideOneDrive) { throw "stateRecoveryDirectory must be under the configured OneDrive recovery root." }
            }
            $credentialHash = (Get-RequiredString $config "recoveryCredentialSha256").ToLowerInvariant()
            if ($credentialHash -notmatch '^[0-9a-f]{64}$' -or
                (Get-FileHash -LiteralPath $credentialPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $credentialHash) {
                throw "The external DPAPI recovery credential failed its SHA-256 check."
            }
            $interactiveMember = $config.PSObject.Properties["recoveryCredentialPreparedInteractively"]
            if ($null -eq $interactiveMember -or $interactiveMember.Value -isnot [bool] -or -not [bool]$interactiveMember.Value) {
                throw "recoveryCredentialPreparedInteractively=true is required for the external DPAPI SecureString credential."
            }
            $config | Add-Member -NotePropertyName resolvedTerraformStatePath -NotePropertyValue $statePath -Force
            $config | Add-Member -NotePropertyName resolvedTerraformStateLineage -NotePropertyValue $stateLineage -Force
            $config | Add-Member -NotePropertyName resolvedStateBackupOutputDirectory -NotePropertyValue $backupDirectory -Force
            $config | Add-Member -NotePropertyName resolvedStateRecoveryDirectory -NotePropertyValue $recoveryDirectory -Force
            $config | Add-Member -NotePropertyName resolvedRecoveryCredentialPath -NotePropertyValue $credentialPath -Force
        }
        "Redis" { [void](Get-RequiredString $config "redisReplicationGroupId") }
    }
    if ($config.resolvedTestMode) {
        $sentinelMember = $config.PSObject.Properties["testEnvironmentSentinel"]
        $accountMember = $config.PSObject.Properties["testAccountId"]
        if ($null -eq $sentinelMember -or [string]$sentinelMember.Value -ne "SCHOOLPILOT_ROLLOUT_TEST_ONLY" -or
            [string]$env:SCHOOLPILOT_ROLLOUT_TEST_MODE -ne "I_UNDERSTAND_TEST_ONLY" -or
            $null -eq $accountMember -or [string]$accountMember.Value -ne "000000000000") {
            throw "testMode requires the explicit config/environment sentinel and reserved mock account."
        }
        $testPaths = @($path, $resolvedEvidenceDirectory)
        foreach ($name in @("resolvedNatRollbackPlanPath", "resolvedTerraformStatePath", "resolvedStateBackupOutputDirectory", "resolvedStateRecoveryDirectory", "resolvedRecoveryCredentialPath")) {
            $member = $config.PSObject.Properties[$name]
            if ($null -ne $member -and $member.Value) { $testPaths += [string]$member.Value }
        }
        foreach ($candidate in $testPaths) {
            if (-not (Test-IsInsideDirectory -Path $candidate -Directory ([IO.Path]::GetTempPath()))) {
                throw "testMode paths must stay under the operating-system temporary directory."
            }
        }
        if (($config | ConvertTo-Json -Depth 40 -Compress) -match '(?i)schoolpilot[-_]?production|production[-_]?schoolpilot') {
            throw "testMode must not reference production resource identifiers."
        }
    }
    return $config
}

function Write-RollbackEvidence {
    param($Config, [string]$Status, [string]$ErrorMessage = "", $Details = $null)
    New-Item -ItemType Directory -Path $Config.resolvedEvidenceDirectory -Force | Out-Null
    $path = Join-ContainedPath $Config.resolvedEvidenceDirectory "$($Config.runId)-rollback.jsonl"
    $record = [ordered]@{
        type = "aws_rollout_rollback"
        schemaVersion = 1
        runId = [string]$Config.runId
        action = $Action
        status = $Status
        timestamp = [DateTimeOffset]::UtcNow.ToString("o")
    }
    if ($ErrorMessage) { $record.error = $ErrorMessage }
    if ($null -ne $Details) { $record.details = $Details }
    $line = ($record | ConvertTo-Json -Compress -Depth 10) + [Environment]::NewLine
    $stream = [IO.File]::Open($path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($line)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
}

function Invoke-Aws {
    param([string[]]$Arguments)
    & aws @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "AWS CLI rollback request failed for $($Arguments[0]) $($Arguments[1])." }
}

function Invoke-AwsJson {
    param([string[]]$Arguments)
    $raw = & aws @Arguments --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "AWS CLI rollback verification failed for $($Arguments[0]) $($Arguments[1])." }
    $text = ($raw | Out-String).Trim()
    if (-not $text) { return $null }
    return $text | ConvertFrom-Json -Depth 60
}

function Assert-NatRollbackPlanShape {
    param([string]$PlanPath)
    Push-Location (Join-Path $script:RepositoryRoot "infra")
    try { $raw = (& terraform show -json $PlanPath 2>$null | Out-String).Trim() }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        throw "terraform show -json failed for the reviewed NAT rollback plan."
    }
    try { $plan = $raw | ConvertFrom-Json -Depth 80 }
    catch { throw "The reviewed NAT rollback plan did not produce valid Terraform plan JSON." }
    $expectedAddresses = @(
        "module.vpc.aws_eip.nat[0]", "module.vpc.aws_eip.nat[1]",
        "module.vpc.aws_nat_gateway.main[0]", "module.vpc.aws_nat_gateway.main[1]",
        "module.vpc.aws_route.private_nat[0]", "module.vpc.aws_route.private_nat[1]"
    ) | Sort-Object
    $changes = @($plan.resource_changes)
    if ($changes.Count -ne 6) { throw "NAT rollback plan must contain exactly six create-only resource changes." }
    foreach ($change in $changes) {
        $actions = @($change.change.actions)
        if ($actions.Count -ne 1 -or [string]$actions[0] -ne "create") {
            throw "NAT rollback plan contains an update/delete/non-create action."
        }
    }
    $actualAddresses = @($changes | ForEach-Object { [string]$_.address } | Sort-Object)
    if (@(Compare-Object $expectedAddresses $actualAddresses).Count -gt 0 -or @($actualAddresses | Sort-Object -Unique).Count -ne 6) {
        throw "NAT rollback plan contains an unreviewed or missing resource address."
    }
}

function ConvertTo-CanonicalValue {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [Collections.IDictionary] -and $Value -isnot [pscustomobject]) {
        return @($Value | ForEach-Object { ConvertTo-CanonicalValue $_ })
    }
    $properties = if ($Value -is [Collections.IDictionary]) {
        @($Value.Keys | ForEach-Object { [pscustomobject]@{ Name=[string]$_; Value=$Value[$_] } })
    } else {
        @($Value.PSObject.Properties | ForEach-Object { [pscustomobject]@{ Name=$_.Name; Value=$_.Value } })
    }
    $result = [ordered]@{}
    foreach ($property in $properties | Sort-Object Name) {
        if ($null -ne $property.Value) { $result[$property.Name] = ConvertTo-CanonicalValue $property.Value }
    }
    return $result
}

function Get-TaskCloneContractJson {
    param($TaskDefinition, [string]$ApiContainerName)
    $contract = [ordered]@{}
    foreach ($field in @(
        "taskRoleArn", "executionRoleArn", "networkMode", "volumes", "placementConstraints",
        "requiresCompatibilities", "runtimePlatform", "ipcMode", "pidMode", "proxyConfiguration",
        "inferenceAccelerators", "ephemeralStorage"
    )) {
        $member = $TaskDefinition.PSObject.Properties[$field]
        if ($null -ne $member -and $null -ne $member.Value) { $contract[$field] = $member.Value }
    }
    $containers = @()
    foreach ($container in @($TaskDefinition.containerDefinitions)) {
        $copy = $container | ConvertTo-Json -Depth 60 | ConvertFrom-Json -Depth 60
        if ([string]$copy.name -eq $ApiContainerName) { $copy.PSObject.Properties.Remove("memory") }
        $containers += $copy
    }
    $contract.containerDefinitions = $containers
    return (ConvertTo-CanonicalValue $contract | ConvertTo-Json -Compress -Depth 60)
}

function Assert-EmergencyTaskDefinition {
    param($Config)
    if ($Config.resolvedTestMode) {
        $evidenceMember = $Config.PSObject.Properties["emergencyTaskDefinitionEvidence"]
        if ($null -eq $evidenceMember -or $null -eq $evidenceMember.Value) {
            throw "testMode OOM preflight requires emergencyTaskDefinitionEvidence."
        }
        $current = $evidenceMember.Value.currentTaskDefinition
        $emergency = $evidenceMember.Value.emergencyTaskDefinition
    }
    else {
        $serviceResponse = Invoke-AwsJson -Arguments @(
            "ecs", "describe-services", "--region", $Config.region, "--cluster", $Config.cluster,
            "--services", $Config.apiService
        )
        $services = @($serviceResponse.services)
        if ($services.Count -ne 1) { throw "OOM preflight could not resolve the current API service." }
        $currentResponse = Invoke-AwsJson -Arguments @(
            "ecs", "describe-task-definition", "--region", $Config.region,
            "--task-definition", ([string]$services[0].taskDefinition)
        )
        $emergencyResponse = Invoke-AwsJson -Arguments @(
            "ecs", "describe-task-definition", "--region", $Config.region,
            "--task-definition", $Config.emergencyApiTaskDefinition
        )
        $current = $currentResponse.taskDefinition
        $emergency = $emergencyResponse.taskDefinition
    }
    if ($null -eq $current -or $null -eq $emergency -or [string]$emergency.status -ne "ACTIVE" -or
        [string]$emergency.family -ne [string]$Config.emergencyApiTaskDefinitionFamily -or
        [string]$emergency.taskDefinitionArn -ne [string]$Config.emergencyApiTaskDefinition -or
        [int]$emergency.cpu -ne 512 -or [int]$emergency.memory -ne 2048 -or
        [string]$emergency.networkMode -ne "awsvpc" -or "FARGATE" -notin @($emergency.requiresCompatibilities) -or
        [string]$emergency.executionRoleArn -ne [string]$current.executionRoleArn -or
        [string]$emergency.taskRoleArn -ne [string]$current.taskRoleArn) {
        throw "OOM preflight rejected the emergency task definition identity, size, roles, or Fargate contract."
    }
    $containerName = [string]$Config.emergencyApiContainerName
    $currentContainers = @($current.containerDefinitions | Where-Object name -eq $containerName)
    $emergencyContainers = @($emergency.containerDefinitions | Where-Object name -eq $containerName)
    if ($currentContainers.Count -ne 1 -or $emergencyContainers.Count -ne 1) {
        throw "OOM preflight requires the reviewed API container in both task definitions."
    }
    $currentImage = [string]$currentContainers[0].image
    $emergencyImage = [string]$emergencyContainers[0].image
    $memoryMember = $emergencyContainers[0].PSObject.Properties["memory"]
    $containerMemoryInvalid = $null -ne $memoryMember -and $null -ne $memoryMember.Value -and [int]$memoryMember.Value -ne 2048
    $reservationMember = $emergencyContainers[0].PSObject.Properties["memoryReservation"]
    $reservationTooLarge = $null -ne $reservationMember -and $null -ne $reservationMember.Value -and [int]$reservationMember.Value -gt 2048
    if ($currentImage -notmatch '@sha256:[0-9a-f]{64}$' -or $emergencyImage -ne $currentImage -or
        $containerMemoryInvalid -or $reservationTooLarge) {
        throw "OOM preflight rejected a non-digest-matched image or the emergency container memory contract."
    }
    $currentCloneContract = Get-TaskCloneContractJson -TaskDefinition $current -ApiContainerName $containerName
    $emergencyCloneContract = Get-TaskCloneContractJson -TaskDefinition $emergency -ApiContainerName $containerName
    if ($currentCloneContract -cne $emergencyCloneContract) {
        throw "OOM preflight rejected an emergency revision that is not a configuration clone of the current API task."
    }
}

function Get-ServiceSnapshot {
    param($Config)
    $response = Invoke-AwsJson -Arguments @(
        "ecs", "describe-services", "--region", $Config.region, "--cluster", $Config.cluster,
        "--services", $Config.apiService, $Config.workerService
    )
    return @($response.services | ForEach-Object {
        [ordered]@{
            serviceName = [string]$_.serviceName
            taskDefinition = [string]$_.taskDefinition
            desired = [int]$_.desiredCount
            running = [int]$_.runningCount
            pending = [int]$_.pendingCount
            subnets = @($_.networkConfiguration.awsvpcConfiguration.subnets)
            securityGroups = @($_.networkConfiguration.awsvpcConfiguration.securityGroups)
            assignPublicIp = [string]$_.networkConfiguration.awsvpcConfiguration.assignPublicIp
        }
    })
}

function Assert-HealthyTarget {
    param($Config)
    $response = Invoke-AwsJson -Arguments @(
        "elbv2", "describe-target-health", "--region", $Config.region,
        "--target-group-arn", $Config.targetGroupArn
    )
    $targets = @($response.TargetHealthDescriptions)
    if (@($targets | Where-Object { $_.TargetHealth.State -eq "healthy" }).Count -lt 1 -or
        @($targets | Where-Object { $_.TargetHealth.State -eq "unhealthy" }).Count -gt 0) {
        throw "Rollback postcondition failed: ALB has no healthy target or still has an unhealthy target."
    }
}

function Assert-ServiceTaskDefinitions {
    param($Config, [string]$ApiTaskDefinition, [string]$WorkerTaskDefinition = "")
    $services = @(Get-ServiceSnapshot -Config $Config)
    $api = @($services | Where-Object serviceName -eq $Config.apiService)
    if ($api.Count -ne 1 -or $api[0].taskDefinition -ne $ApiTaskDefinition -or
        $api[0].running -ne $api[0].desired -or $api[0].pending -ne 0) {
        throw "Rollback postcondition failed for the API service task definition."
    }
    if ($WorkerTaskDefinition) {
        $worker = @($services | Where-Object serviceName -eq $Config.workerService)
        if ($worker.Count -ne 1 -or $worker[0].taskDefinition -ne $WorkerTaskDefinition -or
            $worker[0].running -ne $worker[0].desired -or $worker[0].pending -ne 0) {
            throw "Rollback postcondition failed for the worker service task definition."
        }
    }
    Assert-HealthyTarget -Config $Config
    return $services
}

function Wait-Services {
    param($Config, [string[]]$Services)
    $arguments = @("ecs", "wait", "services-stable", "--region", $Config.region, "--cluster", $Config.cluster, "--services") + $Services
    Invoke-Aws -Arguments $arguments
}

function Restore-Application {
    param($Config)
    Assert-RollbackDeadline -Step "restore-previous-api-revision"
    Invoke-Aws -Arguments @("ecs", "update-service", "--region", $Config.region, "--cluster", $Config.cluster,
        "--service", $Config.apiService, "--task-definition", $Config.previousApiTaskDefinition, "--force-new-deployment")
    Invoke-Aws -Arguments @("ecs", "update-service", "--region", $Config.region, "--cluster", $Config.cluster,
        "--service", $Config.workerService, "--task-definition", $Config.previousWorkerTaskDefinition, "--force-new-deployment")
    Assert-RollbackDeadline -Step "wait-application-services-stable"
    Wait-Services -Config $Config -Services @($Config.apiService, $Config.workerService)
    return Assert-ServiceTaskDefinitions -Config $Config -ApiTaskDefinition $Config.previousApiTaskDefinition `
        -WorkerTaskDefinition $Config.previousWorkerTaskDefinition
}

function Restore-Oom {
    param($Config)
    Assert-RollbackDeadline -Step "deploy-emergency-api-revision"
    Invoke-Aws -Arguments @("ecs", "update-service", "--region", $Config.region, "--cluster", $Config.cluster,
        "--service", $Config.apiService, "--task-definition", $Config.emergencyApiTaskDefinition, "--force-new-deployment")
    Wait-Services -Config $Config -Services @($Config.apiService)
    return Assert-ServiceTaskDefinitions -Config $Config -ApiTaskDefinition $Config.emergencyApiTaskDefinition
}

function Restore-PrivateEcs {
    param($Config)
    Assert-RollbackDeadline -Step "restore-captured-private-network"
    $networkPath = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-network-$([Guid]::NewGuid().ToString('N')).json"
    try {
        $network = [ordered]@{
            awsvpcConfiguration = [ordered]@{
                subnets = @($Config.privateSubnetIds)
                securityGroups = @($Config.ecsSecurityGroupIds)
                assignPublicIp = "DISABLED"
            }
        }
        [IO.File]::WriteAllText($networkPath, ($network | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        foreach ($service in @($Config.apiService, $Config.workerService)) {
            Invoke-Aws -Arguments @("ecs", "update-service", "--region", $Config.region, "--cluster", $Config.cluster,
                "--service", $service, "--network-configuration", "file://$networkPath", "--force-new-deployment")
        }
        Wait-Services -Config $Config -Services @($Config.apiService, $Config.workerService)
        $services = @(Get-ServiceSnapshot -Config $Config)
        foreach ($service in $services) {
            if ($service.running -ne $service.desired -or $service.pending -ne 0 -or $service.assignPublicIp -ne "DISABLED") {
                throw "Rollback postcondition failed: service $($service.serviceName) is not stable on private networking."
            }
            if (@(Compare-Object @($Config.privateSubnetIds | Sort-Object) @($service.subnets | Sort-Object)).Count -gt 0 -or
                @(Compare-Object @($Config.ecsSecurityGroupIds | Sort-Object) @($service.securityGroups | Sort-Object)).Count -gt 0) {
                throw "Rollback postcondition failed: service $($service.serviceName) did not restore the captured network configuration."
            }
        }
        Assert-HealthyTarget -Config $Config
        return $services
    }
    finally { if (Test-Path -LiteralPath $networkPath) { Remove-Item -LiteralPath $networkPath -Force } }
}

function Restore-PublicEcsWithNatPrecondition {
    param($Config)
    Assert-RollbackDeadline -Step "verify-retained-nat-and-private-routes"
    $nat = Assert-NatAndRoutesRestored -Config $Config
    Assert-RollbackDeadline -Step "restore-private-ecs"
    return [ordered]@{
        natPrecondition = $nat
        services = Restore-PrivateEcs -Config $Config
    }
}

function Set-WafRateRulesToCount {
    param($Config)
    Assert-RollbackDeadline -Step "read-reviewed-waf"
    $get = & aws wafv2 get-web-acl --region $Config.region --scope $Config.wafScope --name $Config.wafName --id $Config.wafId --output json
    if ($LASTEXITCODE -ne 0) { throw "Unable to read the current WAF before rollback." }
    $response = $get | ConvertFrom-Json -Depth 60
    $expectedRules = @{
        DeviceIngestRateLimit = [ordered]@{ limit = 100000; metric = [string]$Config.wafDeviceMetricName }
        ApiRateLimit = [ordered]@{ limit = 50000; metric = [string]$Config.wafApiMetricName }
    }
    $rateNames = @($expectedRules.Keys)
    foreach ($rule in @($response.WebACL.Rules)) {
        if ($rule.Name -in $rateNames) {
            $expected = $expectedRules[[string]$rule.Name]
            if ($null -eq $rule.Statement.RateBasedStatement -or
                [int]$rule.Statement.RateBasedStatement.Limit -ne [int]$expected.limit -or
                [string]$rule.VisibilityConfig.MetricName -ne [string]$expected.metric) {
                throw "WAF rollback refused because $($rule.Name) no longer matches the reviewed rate rule contract."
            }
            $rule.Action = [pscustomobject]@{ Count = [pscustomobject]@{} }
        }
    }
    $found = @($response.WebACL.Rules | Where-Object { $_.Name -in $rateNames }).Count
    if ($found -ne 2) { throw "WAF rollback requires both reviewed rate rules; found $found." }

    $input = [ordered]@{
        Name = $Config.wafName
        Scope = $Config.wafScope
        Id = $Config.wafId
        DefaultAction = $response.WebACL.DefaultAction
        Rules = $response.WebACL.Rules
        VisibilityConfig = $response.WebACL.VisibilityConfig
        LockToken = $response.LockToken
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$response.WebACL.Description)) {
        $input["Description"] = [string]$response.WebACL.Description
    }
    foreach ($optional in @("CustomResponseBodies", "CaptchaConfig", "ChallengeConfig", "TokenDomains", "AssociationConfig", "OnSourceDDoSProtectionConfig", "DataProtectionConfig", "ApplicationConfig")) {
        $property = $response.WebACL.PSObject.Properties[$optional]
        if ($null -ne $property -and $null -ne $property.Value) { $input[$optional] = $property.Value }
    }
    $inputPath = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-waf-$([Guid]::NewGuid().ToString('N')).json"
    try {
        [IO.File]::WriteAllText($inputPath, ($input | ConvertTo-Json -Depth 60), [Text.UTF8Encoding]::new($false))
        Invoke-Aws -Arguments @("wafv2", "update-web-acl", "--region", $Config.region, "--cli-input-json", "file://$inputPath")
    }
    finally { if (Test-Path -LiteralPath $inputPath) { Remove-Item -LiteralPath $inputPath -Force } }
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(2)
    $verifiedRules = @()
    do {
        Assert-RollbackDeadline -Step "wait-waf-count-postcondition"
        $verified = Invoke-AwsJson -Arguments @(
            "wafv2", "get-web-acl", "--region", $Config.region, "--scope", $Config.wafScope,
            "--name", $Config.wafName, "--id", $Config.wafId
        )
        $verifiedRules = @($verified.WebACL.Rules | Where-Object { $_.Name -in $rateNames })
        if ($verifiedRules.Count -eq 2 -and @($verifiedRules | Where-Object { $null -eq $_.Action.Count }).Count -eq 0) { break }
        Start-Sleep -Seconds 5
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if ($verifiedRules.Count -ne 2 -or @($verifiedRules | Where-Object { $null -eq $_.Action.Count }).Count -gt 0) {
        throw "WAF rollback postcondition failed: both reviewed rate rules did not reach COUNT within two minutes."
    }
    return [ordered]@{ rateRules = @($verifiedRules | ForEach-Object { [ordered]@{ name = $_.Name; action = "COUNT" } }) }
}

function New-RollbackStateBackup {
    param($Config, [ValidateSet("before", "after")][string]$Usage)
    New-Item -ItemType Directory -Path $Config.resolvedStateBackupOutputDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $Config.resolvedStateRecoveryDirectory -Force | Out-Null
    $existing = @(Get-ChildItem -LiteralPath $Config.resolvedStateBackupOutputDirectory -File -Filter "*.dpapi" `
        -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    $backupScript = Join-Path $script:RepositoryRoot "scripts\terraform-state-backup.ps1"
    $phase = "$($Config.runId)-nat-rollback-$Usage"
    $timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
    $gitSha = [string](@(& git -C $script:RepositoryRoot rev-parse --verify HEAD 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch '^[0-9a-fA-F]{40}$') { throw "Unable to name the rollback backup with the exact Git SHA." }
    $recoveryPath = Join-Path $Config.resolvedStateRecoveryDirectory "$timestamp-$($gitSha.ToLowerInvariant())-$phase.aesgcm"
    $credentialText = (Get-Content -LiteralPath $Config.resolvedRecoveryCredentialPath -Raw).Trim()
    $passphrase = $null
    $restorePath = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-state-verify-$([Guid]::NewGuid().ToString('N')).tfstate"
    try {
        $passphrase = ConvertTo-SecureString -String $credentialText
        & $backupScript -Mode Backup -StatePath $Config.resolvedTerraformStatePath `
            -OutputDirectory $Config.resolvedStateBackupOutputDirectory -Phase $phase `
            -Usage ([Globalization.CultureInfo]::InvariantCulture.TextInfo.ToTitleCase($Usage)) `
            -RecoveryPath $recoveryPath -RecoveryPassphrase $passphrase | Out-Null
        if ($LASTEXITCODE -notin @(0, $null)) { throw "Terraform state $Usage-backup failed." }
        $created = @(Get-ChildItem -LiteralPath $Config.resolvedStateBackupOutputDirectory -File -Filter "*.dpapi" |
            ForEach-Object { $_.FullName } |
            Where-Object { $_ -notin $existing } | Sort-Object)
        if ($created.Count -ne 1 -or -not (Test-Path -LiteralPath $recoveryPath -PathType Leaf)) {
            throw "Terraform state $Usage-backup did not create exactly one DPAPI and one AES-GCM artifact."
        }
        $dpapiMagic = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($created[0])[0..11])
        $aesMagic = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($recoveryPath)[0..12])
        if ($dpapiMagic -ne "SPTFDPAPI01`n" -or $aesMagic -ne "SPTFAESGCM01`n") {
            throw "Rollback state backup envelope magic is invalid."
        }
        & $backupScript -Mode Restore -BackupPath $recoveryPath -RestorePath $restorePath -RecoveryPassphrase $passphrase | Out-Null
        if ($LASTEXITCODE -notin @(0, $null) -or
            (Get-FileHash -LiteralPath $restorePath -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $Config.resolvedTerraformStatePath -Algorithm SHA256).Hash) {
            throw "AES-GCM rollback recovery copy failed explicit decrypt-and-compare verification."
        }
        return [ordered]@{
            dpapiPath = $created[0]
            dpapiSha256 = (Get-FileHash -LiteralPath $created[0] -Algorithm SHA256).Hash.ToLowerInvariant()
            recoveryPath = $recoveryPath
            recoverySha256 = (Get-FileHash -LiteralPath $recoveryPath -Algorithm SHA256).Hash.ToLowerInvariant()
            recoveryDecryptionVerified = $true
        }
    }
    finally {
        if (Test-Path -LiteralPath $restorePath) { Remove-Item -LiteralPath $restorePath -Force }
        if ($null -ne $passphrase) { $passphrase.Dispose() }
    }
}

function Assert-NatAndRoutesRestored {
    param($Config)
    $nat = Invoke-AwsJson -Arguments @(
        "ec2", "describe-nat-gateways", "--region", $Config.region,
        "--filter", "Name=vpc-id,Values=$($Config.vpcId)", "Name=state,Values=available"
    )
    $gateways = @($nat.NatGateways)
    if ($gateways.Count -ne [int]$Config.expectedNatGatewayCount -or
        @($gateways | Where-Object { @($_.NatGatewayAddresses | Where-Object { $_.AssociationId }).Count -lt 1 }).Count -gt 0) {
        throw "NAT rollback postcondition failed: expected available gateways with associated EIPs were not found."
    }
    $routeArguments = @(
        "ec2", "describe-route-tables", "--region", $Config.region, "--route-table-ids"
    ) + @($Config.privateRouteTableIds)
    $routes = Invoke-AwsJson -Arguments $routeArguments
    if (@($routes.RouteTables).Count -ne @($Config.privateRouteTableIds).Count) {
        throw "NAT rollback postcondition failed: one or more captured private route tables were not returned."
    }
    $gatewayIds = @($gateways | ForEach-Object { [string]$_.NatGatewayId })
    foreach ($table in @($routes.RouteTables)) {
        $defaultRoutes = @($table.Routes | Where-Object { $_.DestinationCidrBlock -eq "0.0.0.0/0" -and $_.State -eq "active" })
        if ($defaultRoutes.Count -ne 1 -or [string]$defaultRoutes[0].NatGatewayId -notin $gatewayIds) {
            throw "NAT rollback postcondition failed for route table $($table.RouteTableId)."
        }
    }
    return [ordered]@{ natGatewayIds = $gatewayIds; routeTableIds = @($routes.RouteTables.RouteTableId) }
}

function Assert-TerraformStateLineage {
    param($Config)
    try { $local = Get-Content -LiteralPath $Config.resolvedTerraformStatePath -Raw | ConvertFrom-Json -Depth 20 }
    catch { throw "Unable to parse the exact Terraform state during NAT rollback." }
    if ([string]$local.lineage -ne [string]$Config.resolvedTerraformStateLineage) {
        throw "The exact Terraform state lineage changed; NAT rollback refused."
    }
    Push-Location (Join-Path $script:RepositoryRoot "infra")
    try { $pulledRaw = (& terraform state pull 2>$null | Out-String).Trim() }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($pulledRaw)) {
        throw "terraform state pull failed during lineage verification."
    }
    try { $pulled = $pulledRaw | ConvertFrom-Json -Depth 20 }
    catch { throw "terraform state pull did not return valid state JSON." }
    if ([string]$pulled.lineage -ne [string]$Config.resolvedTerraformStateLineage) {
        throw "Pulled Terraform state lineage does not match the reviewed rollback plan."
    }
    return [ordered]@{ lineage = [string]$pulled.lineage; serial = [int]$pulled.serial }
}

function Restore-NatThenPrivateEcs {
    param($Config)
    Assert-RollbackDeadline -Step "verify-terraform-state-lineage-before"
    $lineageBefore = Assert-TerraformStateLineage -Config $Config
    Assert-RollbackDeadline -Step "backup-state-before-nat-restore"
    $beforeBackup = New-RollbackStateBackup -Config $Config -Usage before
    Push-Location (Join-Path $script:RepositoryRoot "infra")
    try {
        Assert-RollbackDeadline -Step "apply-reviewed-nat-rollback-plan"
        & terraform apply -input=false $Config.resolvedNatRollbackPlanPath
        if ($LASTEXITCODE -ne 0) { throw "Terraform NAT rollback plan failed." }
    }
    finally { Pop-Location }
    Assert-RollbackDeadline -Step "backup-state-immediately-after-nat-apply"
    $afterBackup = New-RollbackStateBackup -Config $Config -Usage after
    $script:RollbackFailureDetails = [ordered]@{
        beforeStateBackup = $beforeBackup
        afterStateBackup = $afterBackup
        terraformApplySucceeded = $true
    }
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(20)
    $available = 0
    do {
        Assert-RollbackDeadline -Step "wait-recreated-nat-available"
        $raw = & aws ec2 describe-nat-gateways --region $Config.region --filter "Name=vpc-id,Values=$($Config.vpcId)" "Name=state,Values=available" --output json
        if ($LASTEXITCODE -ne 0) { throw "Unable to verify recreated NAT gateways." }
        $available = @(($raw | ConvertFrom-Json).NatGateways).Count
        if ($available -ge [int]$Config.expectedNatGatewayCount) { break }
        Start-Sleep -Seconds 15
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if ($available -lt [int]$Config.expectedNatGatewayCount) { throw "Recreated NAT gateways did not become available in 20 minutes." }
    $natPostcondition = Assert-NatAndRoutesRestored -Config $Config
    Assert-RollbackDeadline -Step "restore-private-ecs-after-nat"
    $servicePostcondition = Restore-PrivateEcs -Config $Config
    $lineageAfter = Assert-TerraformStateLineage -Config $Config
    Remove-Item -LiteralPath $Config.resolvedNatRollbackPlanPath -Force
    return [ordered]@{
        beforeStateBackup = $beforeBackup
        afterStateBackup = $afterBackup
        nat = $natPostcondition
        services = $servicePostcondition
        terraformStateLineageBefore = $lineageBefore
        terraformStateLineageAfter = $lineageAfter
    }
}

function Restore-Redis {
    param($Config)
    Assert-RollbackDeadline -Step "restore-redis-small"
    Invoke-Aws -Arguments @("elasticache", "modify-replication-group", "--region", $Config.region,
        "--replication-group-id", $Config.redisReplicationGroupId, "--cache-node-type", "cache.t4g.small", "--apply-immediately")
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(30)
    do {
        Assert-RollbackDeadline -Step "wait-redis-small-available"
        $response = Invoke-AwsJson -Arguments @(
            "elasticache", "describe-replication-groups", "--region", $Config.region,
            "--replication-group-id", $Config.redisReplicationGroupId
        )
        $group = @($response.ReplicationGroups)[0]
        if ([string]$group.Status -eq "available" -and [string]$group.CacheNodeType -eq "cache.t4g.small") {
            return [ordered]@{ status = "available"; nodeType = "cache.t4g.small" }
        }
        Start-Sleep -Seconds 15
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Redis rollback postcondition failed: cache.t4g.small did not become available within 30 minutes."
}

function Get-ActionSnapshot {
    param($Config)
    switch ($Action) {
        { $_ -in @("Application", "Oom", "PublicEcs", "NatRemoved") } {
            return [ordered]@{ services = @(Get-ServiceSnapshot -Config $Config) }
        }
        "Waf" {
            $response = Invoke-AwsJson -Arguments @(
                "wafv2", "get-web-acl", "--region", $Config.region, "--scope", $Config.wafScope,
                "--name", $Config.wafName, "--id", $Config.wafId
            )
            return [ordered]@{
                rateRules = @($response.WebACL.Rules | Where-Object { $_.Name -in @("DeviceIngestRateLimit", "ApiRateLimit") } |
                    ForEach-Object { [ordered]@{ name = $_.Name; action = @($_.Action.PSObject.Properties.Name) } })
                lockToken = [string]$response.LockToken
            }
        }
        "Redis" {
            $response = Invoke-AwsJson -Arguments @(
                "elasticache", "describe-replication-groups", "--region", $Config.region,
                "--replication-group-id", $Config.redisReplicationGroupId
            )
            $group = @($response.ReplicationGroups)[0]
            return [ordered]@{ status = [string]$group.Status; nodeType = [string]$group.CacheNodeType }
        }
    }
}

$config = Read-Config
[ordered]@{
    valid = $true
    action = $Action
    mode = $Mode
    schemaVersion = 1
} | ConvertTo-Json
if ($Mode -eq "Validate") { exit 0 }

$script:RollbackRunId = [string]$config.runId
New-Item -ItemType Directory -Path $config.resolvedEvidenceDirectory -Force | Out-Null
$script:RollbackProgressStatePath = Join-ContainedPath $config.resolvedEvidenceDirectory "$($config.runId)-rollback-state.json"
$rollbackHeartbeatPath = Join-ContainedPath $config.resolvedEvidenceDirectory "$($config.runId)-rollback-heartbeat.json"
if (Test-Path -LiteralPath $script:RollbackProgressStatePath) { throw "Rollback heartbeat state already exists; use a unique runId." }
$script:RollbackDeadline = [DateTimeOffset]::UtcNow.AddSeconds([int]$config.resolvedRollbackMaximumSeconds)
Set-RollbackProgress -Status "running" -Step "starting"
$pwsh = (Get-Process -Id $PID).Path
$parentStartedAt = ([DateTimeOffset](Get-Process -Id $PID).StartTime).ToUniversalTime().ToString("o")
$heartbeatArguments = @(
    "-NoProfile", "-File", $PSCommandPath,
    "-Mode", "Heartbeat", "-Action", $Action, "-ConfigPath", $ConfigPath,
    "-ParentProcessId", [string]$PID, "-ParentProcessStartedAtUtc", $parentStartedAt,
    "-RollbackHeartbeatPath", $rollbackHeartbeatPath,
    "-HeartbeatStatePath", $script:RollbackProgressStatePath,
    "-RollbackDeadlineUtc", $script:RollbackDeadline.ToString("o"),
    "-HeartbeatIntervalSeconds", [string]$config.resolvedRollbackHeartbeatIntervalSeconds
)
$heartbeatStartInfo = [Diagnostics.ProcessStartInfo]::new()
$heartbeatStartInfo.FileName = $pwsh
$heartbeatStartInfo.UseShellExecute = $false
$heartbeatStartInfo.CreateNoWindow = $true
foreach ($argument in $heartbeatArguments) { [void]$heartbeatStartInfo.ArgumentList.Add([string]$argument) }
$heartbeatProcess = [Diagnostics.Process]::Start($heartbeatStartInfo)
$heartbeatStartupDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
while (-not (Test-Path -LiteralPath $rollbackHeartbeatPath) -and -not $heartbeatProcess.HasExited -and [DateTimeOffset]::UtcNow -lt $heartbeatStartupDeadline) {
    Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $rollbackHeartbeatPath)) {
    try { if (-not $heartbeatProcess.HasExited) { $heartbeatProcess.Kill($true) } } catch { }
    throw "Rollback heartbeat worker did not start before the approved mutation."
}
try {
    Assert-RollbackDeadline -Step "capture-before-state"
    $beforeSnapshot = Get-ActionSnapshot -Config $config
    Write-RollbackEvidence -Config $config -Status "started" -Details ([ordered]@{ before = $beforeSnapshot; deadlineUtc = $script:RollbackDeadline.ToString("o") })
    $postcondition = switch ($Action) {
        "Application" { Restore-Application -Config $config }
        "Oom" { Restore-Oom -Config $config }
        "Waf" { Set-WafRateRulesToCount -Config $config }
        "PublicEcs" { Restore-PublicEcsWithNatPrecondition -Config $config }
        "NatRemoved" { Restore-NatThenPrivateEcs -Config $config }
        "Redis" { Restore-Redis -Config $config }
    }
    Assert-RollbackDeadline -Step "write-completion-evidence"
    Write-RollbackEvidence -Config $config -Status "completed" -Details ([ordered]@{
        before = $beforeSnapshot
        postcondition = $postcondition
    })
    Set-RollbackProgress -Status "completed" -Step "completed"
}
catch {
    Set-RollbackProgress -Status "failed" -Step "failed" -ErrorMessage $_.Exception.Message
    Write-RollbackEvidence -Config $config -Status "failed" -ErrorMessage $_.Exception.Message -Details $script:RollbackFailureDetails
    throw
}
finally {
    try {
        if ($null -ne $heartbeatProcess -and -not $heartbeatProcess.HasExited) {
            $heartbeatProcess.WaitForExit(([int]$config.resolvedRollbackHeartbeatIntervalSeconds + 2) * 1000) | Out-Null
        }
    } catch { }
    try { if ($null -ne $heartbeatProcess -and -not $heartbeatProcess.HasExited) { Stop-Process -Id $heartbeatProcess.Id -Force } } catch { }
}

[ordered]@{
    status = "completed"
    action = $Action
    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
} | ConvertTo-Json
