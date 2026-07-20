#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [string]$ExpectedConfigSha256 = "",

    [ValidateSet("Validate", "Monitor")]
    [string]$Mode = "Validate"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:StartedAt = [DateTimeOffset]::UtcNow
$script:ConsecutiveBreaches = @{}
$script:MissingMetrics = @{}
$script:SeenStoppedTasks = @{}
$script:LastMetricTimestamps = @{}
$script:AcceptanceSeries = @{}
$script:AcceptanceViolations = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$script:NatSamples = [System.Collections.Generic.List[object]]::new()
$script:Route53AlarmOkPeriods = 0
$script:PreviousMetricDatapoints = @{}
$script:MetricFreshnessMaximumSeconds = 180
$script:TrafficStartedAtUtc = $null
$script:TrafficStoppedAtUtc = $null
$script:RequiredWorkloadSchemaVersion = "classpilot-tile-batch-v1"
$script:RequiredWorkloadEndpointShapeSha256 = "8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"
$normalizedConfigSha = $null
if ($ExpectedConfigSha256) {
    $normalizedConfigSha = $ExpectedConfigSha256.ToLowerInvariant()
    if ($normalizedConfigSha -notmatch '^[0-9a-f]{64}$' -or
        (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $normalizedConfigSha) {
        throw "Bound monitor config SHA-256 validation failed."
    }
}

function Get-AbsolutePath {
    param([string]$Path, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Name must not be empty." }
    if ($Path.StartsWith("\\?\") -or $Path.StartsWith("\\.\")) {
        throw "$Name must not use a device-namespace path."
    }
    try { return [System.IO.Path]::GetFullPath($Path) }
    catch { throw "$Name must be a valid absolute path." }
}

function Test-IsInsideRepository {
    param([string]$Path)
    $repo = $script:RepositoryRoot.TrimEnd('\', '/')
    $candidate = $Path.TrimEnd('\', '/')
    if ([string]::Equals($repo, $candidate, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $candidate.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Test-IsInsideDirectory {
    param([string]$Path, [string]$Directory)
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    return $candidate -eq $root -or $candidate.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-TestModeIsolation {
    param($RawConfig, [string[]]$Paths)
    if ([string](Get-OptionalValue $RawConfig "testEnvironmentSentinel" "") -ne "SCHOOLPILOT_ROLLOUT_TEST_ONLY" -or
        [string]$env:SCHOOLPILOT_ROLLOUT_TEST_MODE -ne "I_UNDERSTAND_TEST_ONLY") {
        throw "testMode requires both the test-only config sentinel and SCHOOLPILOT_ROLLOUT_TEST_MODE environment sentinel."
    }
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    foreach ($candidate in $Paths | Where-Object { $_ }) {
        if (-not (Test-IsInsideDirectory -Path $candidate -Directory $tempRoot)) {
            throw "testMode paths must stay under the operating-system temporary directory."
        }
    }
    $serialized = $RawConfig | ConvertTo-Json -Depth 40 -Compress
    if ($serialized -match '(?i)schoolpilot[-_]?production|production[-_]?schoolpilot') {
        throw "testMode must not reference production resource identifiers."
    }
    $topic = [string](Get-OptionalValue $RawConfig "notificationTopicArn" "")
    if ($topic -and $topic -notmatch '^arn:aws:sns:[a-z0-9-]+:000000000000:test[-A-Za-z0-9_.]*$') {
        throw "testMode notifications must use the reserved 000000000000 mock account and a test-prefixed topic."
    }
}

function Assert-ExternalPath {
    param([string]$Path, [string]$Name, [switch]$AllowMissing)
    $absolute = Get-AbsolutePath -Path $Path -Name $Name
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "$Name must be absolute." }
    if (Test-IsInsideRepository -Path $absolute) { throw "$Name must be outside the repository." }
    $cursor = $absolute
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Name must not traverse a symbolic link or junction."
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $absolute)) {
        throw "$Name does not exist."
    }
    return $absolute
}

function Assert-SafeIdentifier {
    param([string]$Value, [string]$Name, [int]$MaximumLength = 128)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt $MaximumLength -or
        $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $Value.EndsWith('.')) {
        throw "$Name must be filename-safe, start with a letter or number, and be at most $MaximumLength characters."
    }
    return $Value
}

function Join-ContainedPath {
    param([string]$Directory, [string]$FileName, [string]$Name)
    $candidate = [IO.Path]::GetFullPath((Join-Path $Directory $FileName))
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    if (-not $candidate.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name escaped its configured directory."
    }
    return $candidate
}

function Get-RequiredInteger {
    param($Object, [string]$Property, [int]$Minimum, [int]$Maximum)
    $member = if ($null -eq $Object) { $null } else { $Object.PSObject.Properties[$Property] }
    if ($null -eq $member -or $member.Value -isnot [long] -and $member.Value -isnot [int]) {
        throw "Monitor config requires integer '$Property'."
    }
    $value = [long]$member.Value
    if ($value -lt $Minimum -or $value -gt $Maximum) {
        throw "Monitor config '$Property' must be between $Minimum and $Maximum."
    }
    return [int]$value
}

function Get-RequiredUtcTimestamp {
    param($Object, [string]$Property)
    $member = if ($null -eq $Object) { $null } else { $Object.PSObject.Properties[$Property] }
    if ($null -eq $member -or $null -eq $member.Value) { throw "Monitor config requires '$Property'." }
    if ($member.Value -is [DateTimeOffset]) { return ([DateTimeOffset]$member.Value).ToUniversalTime() }
    if ($member.Value -is [DateTime]) { return ([DateTimeOffset]([DateTime]$member.Value)).ToUniversalTime() }
    $raw = [string]$member.Value
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($raw, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
        throw "Monitor config '$Property' must be an ISO-8601 timestamp."
    }
    return $parsed.ToUniversalTime()
}

function Get-RequiredString {
    param($Object, [string]$Property)
    $member = $Object.PSObject.Properties[$Property]
    $value = if ($null -eq $member) { $null } else { $member.Value }
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) {
        throw "Monitor config requires '$Property'."
    }
    return [string]$value
}

function Get-RequiredStringArray {
    param($Object, [string]$Property)
    $member = if ($null -eq $Object) { $null } else { $Object.PSObject.Properties[$Property] }
    $values = if ($null -eq $member -or $null -eq $member.Value) { @() } else { @($member.Value) }
    $clean = @($values | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($clean.Count -lt 1 -or @($clean | Sort-Object -Unique).Count -ne $clean.Count) {
        throw "Monitor config requires a non-empty, unique '$Property' array."
    }
    return $clean
}

function Get-RequiredBoolean {
    param($Object, [string]$Property)
    $member = if ($null -eq $Object) { $null } else { $Object.PSObject.Properties[$Property] }
    if ($null -eq $member -or $member.Value -isnot [bool]) {
        throw "Monitor config requires JSON boolean '$Property'."
    }
    return [bool]$member.Value
}

function Test-ValidIpv4Literal {
    param([string]$Value)
    $address = $null
    return [Net.IPAddress]::TryParse($Value, [ref]$address) -and $address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork
}

function Get-OptionalValue {
    param($Object, [string]$Property, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $member = $Object.PSObject.Properties[$Property]
    if ($null -eq $member -or $null -eq $member.Value) { return $Default }
    return $member.Value
}

function ConvertTo-Hashtable {
    param($Value)
    $result = @{}
    if ($null -eq $Value) { return $result }
    foreach ($property in $Value.PSObject.Properties) { $result[$property.Name] = $property.Value }
    return $result
}

function Get-VerifiedPredecessorEvidence {
    param(
        $RawConfig,
        [string]$ExpectedPhase,
        [AllowNull()][string]$ExpectedStage,
        [bool]$ExpectedLoad,
        [int]$MinimumPostureSeconds = 0,
        [bool]$RequireSupervisorSeal = $true
    )
    $predecessorPath = Assert-ExternalPath -Path (Get-RequiredString $RawConfig "predecessorResultPath") `
        -Name "predecessorResultPath"
    $expectedHash = (Get-RequiredString $RawConfig "predecessorResultSha256").ToLowerInvariant()
    if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or
        (Get-FileHash -LiteralPath $predecessorPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw "predecessorResultPath does not match predecessorResultSha256."
    }
    try { $predecessorEnvelope = Get-Content -LiteralPath $predecessorPath -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "predecessorResultPath must contain valid supervisor terminal JSON." }

    $predecessor = $predecessorEnvelope
    $monitorResultPath = $predecessorPath
    $monitorResultSha256 = $expectedHash
    if ($RequireSupervisorSeal) {
        if ([int](Get-OptionalValue $predecessorEnvelope "schemaVersion" 0) -ne 2 -or
            [string](Get-OptionalValue $predecessorEnvelope "type" "") -ne "certification_supervisor_terminal" -or
            (Get-OptionalValue $predecessorEnvelope "supervisorSealed" $false) -ne $true -or
            [string](Get-OptionalValue $predecessorEnvelope "status" "") -ne "completed") {
            throw "predecessorResultPath must be a supervisor-sealed terminal result; raw monitor results and historical evidence cannot seed the chain."
        }
        $terminal = Get-OptionalValue $predecessorEnvelope "terminalMonitorResult"
        $monitorResultPath = Assert-ExternalPath -Path (Get-RequiredString $terminal "path") -Name "terminalMonitorResult.path"
        $monitorResultSha256 = (Get-RequiredString $terminal "sha256").ToLowerInvariant()
        if ($monitorResultSha256 -notmatch '^[0-9a-f]{64}$' -or
            (Get-FileHash -LiteralPath $monitorResultPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $monitorResultSha256) {
            throw "The supervisor-sealed terminal monitor result is missing or has been tampered with."
        }
        try { $predecessor = Get-Content -LiteralPath $monitorResultPath -Raw | ConvertFrom-Json -Depth 40 }
        catch { throw "The supervisor-sealed terminal monitor result is invalid JSON." }
        if ([string](Get-OptionalValue $terminal "runId" "") -ne [string](Get-OptionalValue $predecessor "runId" "") -or
            [string](Get-OptionalValue $predecessorEnvelope "runId" "") -ne [string](Get-OptionalValue $predecessor "runId" "") -or
            [string](Get-OptionalValue $terminal "phase" "") -ne [string](Get-OptionalValue $predecessor "phase" "")) {
            throw "The supervisor terminal envelope does not bind the enclosed monitor result identity."
        }
    }
    elseif ([string](Get-OptionalValue $predecessorEnvelope "type" "") -eq "certification_supervisor_terminal") {
        $terminal = Get-OptionalValue $predecessorEnvelope "terminalMonitorResult"
        $monitorResultPath = Assert-ExternalPath -Path (Get-RequiredString $terminal "path") -Name "terminalMonitorResult.path"
        $monitorResultSha256 = (Get-RequiredString $terminal "sha256").ToLowerInvariant()
        if ((Get-FileHash -LiteralPath $monitorResultPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $monitorResultSha256) {
            throw "The test supervisor terminal envelope does not match its monitor result."
        }
        $predecessor = Get-Content -LiteralPath $monitorResultPath -Raw | ConvertFrom-Json -Depth 40
    }
    $predecessorWorkload = Get-OptionalValue $predecessor "workload"
    $actualStage = [string](Get-OptionalValue $predecessorWorkload "stage" "")
    $loadAccepted = Get-OptionalValue $predecessor "loadAccepted" $false
    $postureAccepted = Get-OptionalValue $predecessor "postureAccepted" $false
    $acceptancePassed = Get-OptionalValue (Get-OptionalValue $predecessor "acceptance") "passed" $false
    $identityValid = (
        [string](Get-OptionalValue $predecessor "status" "") -eq "completed" -and
        [string](Get-OptionalValue $predecessor "phase" "") -eq $ExpectedPhase -and
        $postureAccepted -eq $true -and $acceptancePassed -eq $true
    )
    $loadValid = if ($ExpectedLoad) {
        $loadAccepted -eq $true -and $actualStage -eq $ExpectedStage
    } else {
        $loadAccepted -eq $false -and [string]::IsNullOrWhiteSpace($actualStage) -and
        [int](Get-OptionalValue $predecessor "minimumWallClockSeconds" 0) -ge $MinimumPostureSeconds
    }
    if (-not $identityValid -or -not $loadValid) {
        $expectedDescription = if ($ExpectedLoad) { "$ExpectedPhase/$ExpectedStage load" } else { "$ExpectedPhase no-load posture" }
        throw "predecessorResultPath is not cryptographically accepted evidence for $expectedDescription."
    }
    return [ordered]@{
        path = $predecessorPath
        sha256 = $expectedHash
        supervisorSealed = $RequireSupervisorSeal
        terminalMonitorResultPath = $monitorResultPath
        terminalMonitorResultSha256 = $monitorResultSha256
        runId = [string](Get-OptionalValue $predecessor "runId" "")
        phase = $ExpectedPhase
        stage = if ($ExpectedLoad) { $ExpectedStage } else { $null }
        postureSeconds = if ($ExpectedLoad) { $null } else { [int]$predecessor.minimumWallClockSeconds }
    }
}

function Read-Configuration {
    $path = Assert-ExternalPath -Path $ConfigPath -Name "ConfigPath"
    try { $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 30 }
    catch { throw "ConfigPath must contain valid JSON." }
    if ([int]$config.schemaVersion -ne 1) { throw "Monitor config schemaVersion must be 1." }

    $runId = Assert-SafeIdentifier -Value (Get-RequiredString $config "runId") -Name "runId"
    $phase = Get-RequiredString -Object $config -Property "phase"
    if ($phase -notin @("Application", "Waf", "PublicEcs", "NatRemoved", "Route53", "Redis", "Final")) {
        throw "Monitor config phase is invalid."
    }
    $evidence = Assert-ExternalPath -Path (Get-RequiredString $config "evidenceDirectory") -Name "evidenceDirectory" -AllowMissing
    $progress = $null
    if (Get-OptionalValue $config "loadProgressPath") {
        $progress = Assert-ExternalPath -Path ([string]$config.loadProgressPath) -Name "loadProgressPath" -AllowMissing
    }
    $summary = $null
    if (Get-OptionalValue $config "loadSummaryPath") {
        $summary = Assert-ExternalPath -Path ([string]$config.loadSummaryPath) -Name "loadSummaryPath" -AllowMissing
    }
    if (($null -eq $progress) -ne ($null -eq $summary)) {
        throw "loadProgressPath and loadSummaryPath must be configured together."
    }

    $testModeValue = Get-OptionalValue $config "testMode" $false
    if ($testModeValue -isnot [bool]) { throw "testMode must be a JSON boolean." }
    $testMode = [bool]$testModeValue
    $diagnosticOnlyValue = Get-OptionalValue $config "diagnosticOnly" $false
    if ($diagnosticOnlyValue -isnot [bool]) { throw "diagnosticOnly must be a JSON boolean." }
    $diagnosticOnly = [bool]$diagnosticOnlyValue
    if ($diagnosticOnly -and $testMode) {
        throw "diagnosticOnly is reserved for the governed production Waf/800 diagnostic path."
    }

    $expectedGeneratorPublicIp = $null
    $generatorIpEvidencePath = $null
    if ($null -ne $progress) {
        $expectedGeneratorPublicIp = [string](Get-OptionalValue $config "expectedGeneratorPublicIp" "")
        if (-not $testMode -and [string]::IsNullOrWhiteSpace($expectedGeneratorPublicIp)) {
            throw "Production Load monitoring requires expectedGeneratorPublicIp."
        }
        if ($expectedGeneratorPublicIp -and -not (Test-ValidIpv4Literal $expectedGeneratorPublicIp)) {
            throw "expectedGeneratorPublicIp must be an IPv4 literal."
        }
        if (Get-OptionalValue $config "generatorIpEvidencePath") {
            $generatorIpEvidencePath = Assert-ExternalPath -Path ([string]$config.generatorIpEvidencePath) -Name "generatorIpEvidencePath" -AllowMissing
        }
        if ($Mode -eq "Monitor" -and $expectedGeneratorPublicIp -and -not $generatorIpEvidencePath) {
            throw "Bound Load monitoring requires generatorIpEvidencePath."
        }
    }

    $minimumAllowedWallClockSeconds = if ($testMode) { 0 } else { 60 }
    $minimumWallClockSeconds = Get-RequiredInteger -Object $config -Property "minimumWallClockSeconds" `
        -Minimum $minimumAllowedWallClockSeconds -Maximum 90000
    $deadlineUtc = Get-RequiredUtcTimestamp -Object $config -Property "deadlineUtc"
    if ($deadlineUtc -le $script:StartedAt.AddSeconds($minimumWallClockSeconds)) {
        throw "deadlineUtc must be later than the required minimum wall-clock duration."
    }

    $workload = $null
    $predecessorEvidence = $null
    $artifactsNotBeforeUtc = $null
    $rawResources = Get-OptionalValue $config "resources"
    $progressionRdsClass = [string](Get-OptionalValue $rawResources "expectedRdsInstanceClass" "")
    if ($null -ne $progress) {
        $workloadObject = $config.workload
        $workloadStage = Assert-SafeIdentifier -Value (Get-RequiredString $workloadObject "stage") -Name "workload.stage"
        $workloadSchemaVersion = [string](Get-OptionalValue $workloadObject "workloadSchemaVersion" "")
        $workloadEndpointShapeSha256 = [string](Get-OptionalValue $workloadObject "endpointShapeSha256" "").ToLowerInvariant()
        $workload = [pscustomobject]@{
            Stage = $workloadStage
            Devices = Get-RequiredInteger $workloadObject "devices" 1 2000
            DurationSeconds = Get-RequiredInteger $workloadObject "durationSeconds" 1 86400
            ScreenshotBytes = Get-RequiredInteger $workloadObject "screenshotBytes" 1024 1048576
            CanaryDevices = Get-RequiredInteger $workloadObject "canaryDevices" 0 1000
            WorkloadSchemaVersion = $workloadSchemaVersion
            EndpointShapeSha256 = $workloadEndpointShapeSha256
        }
        if (-not $testMode) {
            if ($workload.WorkloadSchemaVersion -cne $script:RequiredWorkloadSchemaVersion -or
                $workload.EndpointShapeSha256 -cne $script:RequiredWorkloadEndpointShapeSha256) {
                throw "Production load monitoring requires the reviewed tile-batch workload schema and endpoint shape."
            }
            $signature = "$($workload.Devices):$($workload.DurationSeconds):$($workload.ScreenshotBytes):$($workload.CanaryDevices)"
            if ($diagnosticOnly) {
                if ($phase -ne "Waf" -or $workload.Stage -ne "800" -or $signature -ne "810:1800:40960:10") {
                    throw "Diagnostic-only monitoring permits only the exact private Waf/800 810-device, 1800-second, 40-KiB, 10-canary profile."
                }
            }
            else {
                $approved = [ordered]@{
                    "510:1800:40960:10" = "500"
                    "810:5400:40960:10" = "800"
                    "1010:600:51200:10" = "burst"
                    "810:28800:40960:10" = "endurance"
                }
                if (-not $approved.Contains($signature) -or $workload.Stage -ne [string]$approved[$signature]) {
                    throw "workload stage/name/signature does not match an approved immutable launch-gate profile."
                }
            }
            $allowedStages = @{
                Waf = @("500", "800", "endurance")
                PublicEcs = @("800")
                NatRemoved = @("800")
                Redis = @("500", "800", "burst")
                Final = @("endurance")
            }
            if (-not $allowedStages.ContainsKey($phase) -or $workload.Stage -notin $allowedStages[$phase]) {
                throw "workload stage '$($workload.Stage)' is not authorized during phase '$phase'."
            }
            if ($phase -eq "Waf" -and $workload.Stage -eq "endurance" -and $progressionRdsClass -ne "db.t4g.xlarge") {
                throw "Private Waf/endurance is authorized only after observing resources.expectedRdsInstanceClass=db.t4g.xlarge."
            }
        }
        if ($minimumWallClockSeconds -gt $workload.DurationSeconds + 900) {
            throw "minimumWallClockSeconds cannot exceed the workload duration by more than 15 minutes."
        }
        if (-not $testMode -and $minimumWallClockSeconds -ne $workload.DurationSeconds) {
            throw "Production load monitoring requires minimumWallClockSeconds to equal workload.durationSeconds."
        }
        $artifactsNotBeforeUtc = Get-RequiredUtcTimestamp -Object $config -Property "artifactsNotBeforeUtc"
        if ($artifactsNotBeforeUtc -gt [DateTimeOffset]::UtcNow.AddMinutes(1)) {
            throw "artifactsNotBeforeUtc cannot be in the future."
        }
        if (Test-Path -LiteralPath $summary) {
            throw "loadSummaryPath already exists; each monitored run requires a unique summary path."
        }
        if (Test-Path -LiteralPath $progress) {
            $item = Get-Item -LiteralPath $progress
            if ([DateTimeOffset]$item.CreationTimeUtc -lt $artifactsNotBeforeUtc.AddSeconds(-2)) {
                throw "loadProgressPath predates artifactsNotBeforeUtc; use a unique progress path."
            }
        }
    }

    if (-not $testMode -and -not $diagnosticOnly) {
        $stageKey = if ($null -eq $workload) { "no-load" } else { [string]$workload.Stage }
        $progressionKey = "$phase`:$stageKey"
        $predecessorContract = switch ($progressionKey) {
            "Application:no-load" { $null }
            "Waf:500" { $null }
            "Waf:800" { [ordered]@{ phase="Waf"; stage="500"; load=$true; postureSeconds=0 } }
            "Waf:endurance" {
                if ($progressionRdsClass -ne "db.t4g.xlarge") {
                    throw "Waf/endurance requires the resized db.t4g.xlarge capacity track."
                }
                [ordered]@{ phase="Waf"; stage="800"; load=$true; postureSeconds=0 }
            }
            "PublicEcs:800" {
                if ($progressionRdsClass -eq "db.t4g.xlarge") {
                    [ordered]@{ phase="Waf"; stage="endurance"; load=$true; postureSeconds=0 }
                }
                elseif ($progressionRdsClass -eq "db.t4g.medium") {
                    [ordered]@{ phase="Waf"; stage="800"; load=$true; postureSeconds=0 }
                }
                else { throw "PublicEcs/800 requires an exact expected RDS class before resolving its predecessor." }
            }
            "PublicEcs:no-load" { [ordered]@{ phase="PublicEcs"; stage="800"; load=$true; postureSeconds=0 } }
            "NatRemoved:800" { [ordered]@{ phase="PublicEcs"; stage=$null; load=$false; postureSeconds=86400 } }
            "Route53:no-load" { [ordered]@{ phase="NatRemoved"; stage="800"; load=$true; postureSeconds=0 } }
            "Redis:500" { [ordered]@{ phase="Route53"; stage=$null; load=$false; postureSeconds=0 } }
            "Redis:800" { [ordered]@{ phase="Redis"; stage="500"; load=$true; postureSeconds=0 } }
            "Redis:burst" { [ordered]@{ phase="Redis"; stage="800"; load=$true; postureSeconds=0 } }
            "Final:endurance" { [ordered]@{ phase="Redis"; stage="burst"; load=$true; postureSeconds=0 } }
            default { throw "Phase/stage combination '$progressionKey' is outside the immutable rollout progression." }
        }
        if ($null -eq $predecessorContract) {
            if (Get-OptionalValue $config "predecessorResultPath") {
                throw "$progressionKey must not declare predecessor evidence."
            }
        }
        else {
            $predecessorEvidence = Get-VerifiedPredecessorEvidence -RawConfig $config `
                -ExpectedPhase $predecessorContract.phase -ExpectedStage $predecessorContract.stage `
                -ExpectedLoad ([bool]$predecessorContract.load) -MinimumPostureSeconds ([int]$predecessorContract.postureSeconds) `
                -RequireSupervisorSeal (-not $testMode)
        }
    }
    elseif ($diagnosticOnly -and (Get-OptionalValue $config "predecessorResultPath")) {
        throw "Diagnostic-only evidence must not declare or consume predecessor evidence."
    }

    $rollbackConfig = $null
    $automaticRollbackValue = Get-OptionalValue $config "automaticRollback" $false
    if ($automaticRollbackValue -isnot [bool]) { throw "automaticRollback must be a JSON boolean." }
    if (-not $testMode -and -not $diagnosticOnly -and -not [bool]$automaticRollbackValue) {
        throw "Production monitoring requires automaticRollback=true."
    }
    if ($diagnosticOnly -and [bool]$automaticRollbackValue) {
        throw "Diagnostic-only monitoring must not mutate application, WAF, or infrastructure rollback posture."
    }
    if ($automaticRollbackValue) {
        $rollbackConfig = Assert-ExternalPath -Path (Get-RequiredString $config "rollbackConfigPath") -Name "rollbackConfigPath"
    }
    $expectedRollbackConfigSha256 = [string](Get-OptionalValue $config "expectedRollbackConfigSha256" "")
    if ($expectedRollbackConfigSha256) {
        $expectedRollbackConfigSha256 = $expectedRollbackConfigSha256.ToLowerInvariant()
        if ($expectedRollbackConfigSha256 -notmatch '^[0-9a-f]{64}$' -or -not $rollbackConfig -or
            (Get-FileHash -LiteralPath $rollbackConfig -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedRollbackConfigSha256) {
            throw "Bound rollback config SHA-256 validation failed."
        }
    }
    $requireLoadAcceptanceValue = Get-OptionalValue $config "requireLoadAcceptance" $true
    if ($requireLoadAcceptanceValue -isnot [bool]) { throw "requireLoadAcceptance must be a JSON boolean." }
    if (-not $testMode -and $null -ne $progress -and -not [bool]$requireLoadAcceptanceValue) {
        throw "Production load monitoring requires requireLoadAcceptance=true."
    }

    $pollSeconds = [int](Get-OptionalValue $config "pollSeconds" 60)
    if (($testMode -and ($pollSeconds -lt 1 -or $pollSeconds -gt 300)) -or (-not $testMode -and $pollSeconds -ne 60)) {
        throw "pollSeconds must be 60 outside testMode."
    }
    $maxIterations = [int](Get-OptionalValue $config "maxIterations" 0)
    if ($maxIterations -lt 0) { throw "maxIterations must be zero or positive." }
    $minuteTicks = [TimeSpan]::TicksPerMinute
    $runtimeSeriesNotBeforeUtc = [DateTimeOffset]::new(
        $script:StartedAt.Ticks - ($script:StartedAt.Ticks % $minuteTicks),
        [TimeSpan]::Zero
    )
    if ($null -ne $config.PSObject.Properties["testRuntimeSeriesNotBeforeUtc"]) {
        if (-not $testMode) { throw "testRuntimeSeriesNotBeforeUtc is test-only." }
        $runtimeSeriesNotBeforeUtc = Get-RequiredUtcTimestamp $config "testRuntimeSeriesNotBeforeUtc"
    }
    $telemetryExpectedSeconds = if ($null -eq $workload) { $minimumWallClockSeconds } else { $workload.DurationSeconds }
    if ($testMode -and $null -ne $config.PSObject.Properties["testTelemetryExpectedSeconds"]) {
        $telemetryExpectedSeconds = Get-RequiredInteger $config "testTelemetryExpectedSeconds" 0 86400
    }
    $telemetryMetricNames = @(
        "ecs_api_cpu", "ecs_api_cpu_maximum", "ecs_api_memory",
        "ecs_worker_cpu", "ecs_worker_cpu_maximum", "ecs_worker_memory",
        "rds_cpu", "rds_connections", "rds_storage_headroom", "rds_free_memory", "rds_swap",
        "rds_cpu_credit", "rds_surplus_charged", "rds_read_latency_ms", "rds_write_latency_ms",
        "rds_disk_queue_depth", "rds_read_iops", "rds_write_iops", "rds_total_iops", "redis_cpu", "redis_memory", "redis_free",
        "redis_evictions", "redis_rejected", "redis_cpu_credit"
    )
    if ($testMode -and $null -ne $config.PSObject.Properties["testTelemetryMetricNames"]) {
        $requestedMetrics = @(Get-RequiredStringArray $config "testTelemetryMetricNames")
        if (@($requestedMetrics | Where-Object { $_ -notin $telemetryMetricNames }).Count -gt 0) {
            throw "testTelemetryMetricNames contains an unknown metric."
        }
        $telemetryMetricNames = $requestedMetrics
    }

    $resources = $config.resources
    foreach ($name in @(
        "region", "cluster", "apiService", "workerService", "rdsInstanceId", "redisCacheClusterId", "redisReplicationGroupId", "vpcId",
        "wafWebAclName", "wafDeviceRuleMetricName", "wafApiRuleMetricName", "route53HealthCheckId", "route53AlarmName"
    )) {
        [void](Get-RequiredString -Object $resources -Property $name)
    }
    [void](Get-RequiredString -Object $resources -Property "targetGroupArn")
    $expectedNatGatewayCount = Get-RequiredInteger -Object $resources -Property "expectedNatGatewayCount" -Minimum 0 -Maximum 4
    $expectedRoute53MeasureLatencyValue = Get-RequiredBoolean $resources "expectedRoute53MeasureLatency"
    $expectedEcsAssignPublicIp = Get-RequiredBoolean $resources "expectedEcsAssignPublicIp"
    $ecsTaskSubnetIds = @(Get-RequiredStringArray $resources "ecsTaskSubnetIds")
    $expectedRedisNodeType = Get-RequiredString $resources "expectedRedisNodeType"
    if ($diagnosticOnly) {
        [void](Get-RequiredString $resources "wafDeviceClassifierMetricName")
        $cloudFrontDistributionId = Get-RequiredString $resources "cloudFrontDistributionId"
        if ($cloudFrontDistributionId -notmatch '^E[A-Z0-9]{8,20}$') {
            throw "Diagnostic resources.cloudFrontDistributionId must bind the exact production distribution."
        }
    }
    $expectedRdsInstanceClass = [string](Get-OptionalValue $resources "expectedRdsInstanceClass" "")
    if ($expectedRdsInstanceClass -and $expectedRdsInstanceClass -notin @("db.t4g.medium", "db.t4g.xlarge")) {
        throw "resources.expectedRdsInstanceClass must be db.t4g.medium or db.t4g.xlarge."
    }
    $expectedRdsPosture = $null
    $rawExpectedRdsPosture = Get-OptionalValue $resources "expectedRdsPosture"
    if ($null -ne $rawExpectedRdsPosture) {
        $expectedRdsPosture = [ordered]@{
            engine=Get-RequiredString $rawExpectedRdsPosture "engine"
            engineVersion=Get-RequiredString $rawExpectedRdsPosture "engineVersion"
            allocatedStorageGiB=Get-RequiredInteger $rawExpectedRdsPosture "allocatedStorageGiB" 1 65536
            maxAllocatedStorageGiB=Get-RequiredInteger $rawExpectedRdsPosture "maxAllocatedStorageGiB" 1 65536
            storageType=Get-RequiredString $rawExpectedRdsPosture "storageType"
            storageEncrypted=Get-RequiredBoolean $rawExpectedRdsPosture "storageEncrypted"
            multiAz=Get-RequiredBoolean $rawExpectedRdsPosture "multiAz"
            publiclyAccessible=Get-RequiredBoolean $rawExpectedRdsPosture "publiclyAccessible"
            performanceInsightsEnabled=Get-RequiredBoolean $rawExpectedRdsPosture "performanceInsightsEnabled"
            dbSubnetGroupName=Get-RequiredString $rawExpectedRdsPosture "dbSubnetGroupName"
            vpcSecurityGroupIds=@((Get-RequiredStringArray $rawExpectedRdsPosture "vpcSecurityGroupIds")|Sort-Object -Unique)
        }
        if ($expectedRdsPosture.engine -ne "postgres" -or
            $expectedRdsPosture.maxAllocatedStorageGiB -lt $expectedRdsPosture.allocatedStorageGiB -or
            $expectedRdsPosture.storageEncrypted -ne $true -or $expectedRdsPosture.publiclyAccessible -ne $false -or
            $expectedRdsPosture.performanceInsightsEnabled -ne $true -or
            @($expectedRdsPosture.vpcSecurityGroupIds|Where-Object{$_ -notmatch '^sg-[0-9a-f]+$'}).Count -gt 0) {
            throw "resources.expectedRdsPosture must define exact encrypted private PostgreSQL storage, networking, and PI posture."
        }
    }
    if (-not $testMode -and $expectedRdsInstanceClass -eq "db.t4g.xlarge" -and $null -eq $expectedRdsPosture) {
        throw "The production resized capacity track requires resources.expectedRdsPosture."
    }
    # These series are always collected and retained in sample evidence, but
    # their acceptance thresholds are authorized only on the resized capacity
    # track. Do not silently add new baseline gates to the medium certification.
    if ($expectedRdsInstanceClass -ne "db.t4g.xlarge") {
        $capacityOnlyTelemetry = @(
            "rds_read_latency_ms","rds_write_latency_ms","rds_disk_queue_depth",
            "rds_read_iops","rds_write_iops","rds_total_iops"
        )
        $telemetryMetricNames = @($telemetryMetricNames | Where-Object { $_ -notin $capacityOnlyTelemetry })
    }
    $expectedActiveApiTaskDefinitionArn = [string](Get-OptionalValue $resources "expectedActiveApiTaskDefinitionArn" "")
    $expectedActiveWorkerTaskDefinitionArn = [string](Get-OptionalValue $resources "expectedActiveWorkerTaskDefinitionArn" "")
    foreach ($expectedTaskIdentity in @(
        @("expectedActiveApiTaskDefinitionArn",$expectedActiveApiTaskDefinitionArn),
        @("expectedActiveWorkerTaskDefinitionArn",$expectedActiveWorkerTaskDefinitionArn)
    )) {
        if ($expectedTaskIdentity[1] -and
            $expectedTaskIdentity[1] -notmatch '^arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition/[A-Za-z0-9_-]+:\d+$') {
            throw "resources.$($expectedTaskIdentity[0]) must be a full revisioned ECS task-definition ARN."
        }
    }
    if ($expectedRedisNodeType -notin @("cache.t4g.small", "cache.t4g.micro")) {
        throw "resources.expectedRedisNodeType must be cache.t4g.small or cache.t4g.micro."
    }
    if ($phase -eq "Route53" -and $expectedRoute53MeasureLatencyValue) {
        throw "The Route53 phase must expect latency measurement to be disabled."
    }
    if (-not $testMode) {
        $phaseContract = switch ($phase) {
            { $_ -in @("Application", "Waf") } { [ordered]@{ nat = 2; public = $false; redis = "cache.t4g.small"; latency = $true } }
            "PublicEcs" { [ordered]@{ nat = 2; public = $true; redis = "cache.t4g.small"; latency = $true } }
            "NatRemoved" { [ordered]@{ nat = 0; public = $true; redis = "cache.t4g.small"; latency = $true } }
            "Route53" { [ordered]@{ nat = 0; public = $true; redis = "cache.t4g.small"; latency = $false } }
            { $_ -in @("Redis", "Final") } { [ordered]@{ nat = 0; public = $true; redis = "cache.t4g.micro"; latency = $false } }
        }
        if ($expectedNatGatewayCount -ne $phaseContract.nat -or
            $expectedEcsAssignPublicIp -ne $phaseContract.public -or
            $expectedRedisNodeType -ne $phaseContract.redis -or
            [bool]$expectedRoute53MeasureLatencyValue -ne $phaseContract.latency) {
            throw "AWS resource expectations do not match the immutable $phase phase contract."
        }
        Assert-WafMetricIdentity -Resources $resources -RequireDiagnosticContract:$diagnosticOnly
        if ($diagnosticOnly) { [void](Assert-DiagnosticRedisIdentity -Resources $resources -ExpectedNodeType $expectedRedisNodeType) }
    }

    $redisResizeCompletedAtUtc = $null
    if ($phase -eq "Final") {
        $redisResizeCompletedAtUtc = Get-RequiredUtcTimestamp $config "redisResizeCompletedAtUtc"
        if ($redisResizeCompletedAtUtc -gt [DateTimeOffset]::UtcNow.AddMinutes(1)) {
            throw "redisResizeCompletedAtUtc cannot be in the future."
        }
    }

    $notificationTopicArn = Get-RequiredString $config "notificationTopicArn"
    if ($notificationTopicArn -notmatch '^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_.-]+$') {
        throw "notificationTopicArn must be an SNS topic ARN."
    }
    if ($testMode) {
        Assert-TestModeIsolation -RawConfig $config -Paths @($path, $evidence, $progress, $summary, $rollbackConfig, $generatorIpEvidencePath)
    }

    $supervisedHeartbeatPaths = @()
    foreach ($heartbeatPath in @(Get-OptionalValue $config "supervisedHeartbeatPaths" @())) {
        $supervisedHeartbeatPaths += Assert-ExternalPath -Path ([string]$heartbeatPath) -Name "supervisedHeartbeatPaths" -AllowMissing
    }

    $harnessProcessId = [int](Get-OptionalValue $config "harnessProcessId" 0)
    $harnessProcessStartedAtUtc = $null
    $harnessProcessPath = $null
    if ($null -ne $progress -and $harnessProcessId -le 0) {
        throw "harnessProcessId must identify the supervised load generator when load artifacts are configured."
    }
    if ($null -ne $progress) {
        $harnessProcessStartedAtUtc = Get-RequiredUtcTimestamp $config "harnessProcessStartedAtUtc"
        $harnessProcessPath = [IO.Path]::GetFullPath((Get-RequiredString $config "harnessProcessPath"))
        if (-not (Test-Path -LiteralPath $harnessProcessPath -PathType Leaf)) {
            throw "harnessProcessPath does not exist."
        }
    }

    $thresholdDefaults = @{
        ecsCpuMaximumPercent = 70.0
        ecsMemoryMaximumPercent = 75.0
        rdsCpuMaximumPercent = 65.0
        rdsConnectionsMaximum = 150.0
        redisCpuMaximumPercent = 70.0
        redisMemoryMaximumPercent = 70.0
        redisFreeMemoryMinimumBytes = 104857600.0
        rdsStorageHeadroomMinimumPercent = 20.0
        rdsFreeableMemoryMinimumBytes = 536870912.0
        rdsCpuCreditMinimum = 24.0
        rdsLatencyP95MaximumMilliseconds = 20.0
        rdsLatencyPeakMaximumMilliseconds = 50.0
        rdsQueueDepthP95Maximum = 1.0
        rdsQueueDepthConsecutiveMaximum = 2.0
        rdsIopsP95Maximum = 2400.0
        rdsIopsPeakMaximum = 3000.0
        redisCpuCreditMinimum = 10.0
        rdsSwapGrowthMaximumBytesPerMinute = 16777216.0
        ecsCpuSteadyMaximumPercent = 60.0
        redisSteadyMaximumPercent = 60.0
        natSixHourMaximumBytes = 1048576.0
        requireNatSixHourAcceptance = $false
        consecutiveMinutes = 3
        progressStaleSeconds = 150
        supervisedHeartbeatStaleSeconds = 150
        summaryCommitGraceSeconds = 30
        metricFreshnessMaximumSeconds = 180
        # AWS/RDS CPU datapoints can arrive one additional one-minute period
        # behind the other RDS series while still advancing every minute. Keep
        # all other one-minute metrics on the stricter 180-second ceiling.
        rdsCpuMetricFreshnessMaximumSeconds = 240
        # Credit metrics are timestamped on a five-minute cadence and can remain
        # invisible until after the following period starts. Allow two complete
        # periods plus one bounded poll interval, while still failing closed when
        # two consecutive credit periods are absent.
        fiveMinuteMetricFreshnessMaximumSeconds = 660
        telemetryMinimumCoveragePercent = 95.0
        telemetryMaximumGapSeconds = 120
        natSixHourRequiredSamples = 360
    }
    $thresholds = ConvertTo-Hashtable (Get-OptionalValue $config "thresholds")
    foreach ($key in $thresholdDefaults.Keys) {
        if (-not $thresholds.ContainsKey($key)) { $thresholds[$key] = $thresholdDefaults[$key] }
    }
    if ($thresholds.requireNatSixHourAcceptance -isnot [bool]) {
        throw "thresholds.requireNatSixHourAcceptance must be a JSON boolean."
    }
    if ([int]$thresholds.consecutiveMinutes -lt 1 -or [int]$thresholds.consecutiveMinutes -gt 10) {
        throw "consecutiveMinutes must be between 1 and 10."
    }
    if (-not $testMode) {
        foreach ($key in $thresholdDefaults.Keys) {
            if ($key -eq "requireNatSixHourAcceptance") { continue }
            if ([double]$thresholds[$key] -ne [double]$thresholdDefaults[$key]) {
                throw "Production threshold '$key' is immutable and cannot be weakened or changed."
            }
        }
        $expectedNatGate = $phase -eq "PublicEcs" -and $null -eq $progress
        if ([bool]$thresholds.requireNatSixHourAcceptance -ne $expectedNatGate) {
            throw "requireNatSixHourAcceptance does not match the immutable phase contract."
        }
    }
    if (-not $testMode -and $phase -eq "PublicEcs" -and $null -eq $progress) {
        if ($minimumWallClockSeconds -ne 86400 -or -not [bool]$thresholds.requireNatSixHourAcceptance) {
            throw "A production PublicEcs soak without a load harness must run exactly 24 hours and require the final-six-hour NAT gate."
        }
    }
    if (-not $testMode -and [string]::IsNullOrWhiteSpace($expectedRdsInstanceClass)) {
        throw "Production monitoring requires resources.expectedRdsInstanceClass."
    }
    if ($diagnosticOnly -and ($expectedRdsInstanceClass -ne "db.t4g.medium" -or
        $expectedRedisNodeType -ne "cache.t4g.small" -or $expectedNatGatewayCount -ne 2 -or
        $expectedEcsAssignPublicIp -ne $false)) {
        throw "Diagnostic-only Waf/800 requires db.t4g.medium, cache.t4g.small, two NAT gateways, and private ECS tasks."
    }
    if (-not $testMode -and ([string]::IsNullOrWhiteSpace($expectedActiveApiTaskDefinitionArn) -or
        [string]::IsNullOrWhiteSpace($expectedActiveWorkerTaskDefinitionArn))) {
        throw "Production monitoring requires exact active API and worker task-definition ARNs."
    }

    return [pscustomobject]@{
        Raw = $config
        ConfigPath = $path
        RunId = $runId
        Phase = $phase
        EvidenceDirectory = $evidence
        LoadProgressPath = $progress
        LoadSummaryPath = $summary
        ExpectedGeneratorPublicIp = $expectedGeneratorPublicIp
        GeneratorIpEvidencePath = $generatorIpEvidencePath
        RollbackConfigPath = $rollbackConfig
        ExpectedRollbackConfigSha256 = if ($expectedRollbackConfigSha256) { $expectedRollbackConfigSha256 } else { $null }
        PollSeconds = $pollSeconds
        MaxIterations = $maxIterations
        MinimumWallClockSeconds = $minimumWallClockSeconds
        TelemetryExpectedSeconds = $telemetryExpectedSeconds
        TelemetryMetricNames = $telemetryMetricNames
        RuntimeSeriesNotBeforeUtc = $runtimeSeriesNotBeforeUtc
        DeadlineUtc = $deadlineUtc
        TestMode = $testMode
        DiagnosticOnly = $diagnosticOnly
        HarnessProcessId = $harnessProcessId
        HarnessProcessStartedAtUtc = $harnessProcessStartedAtUtc
        HarnessProcessPath = $harnessProcessPath
        ArtifactsNotBeforeUtc = $artifactsNotBeforeUtc
        Workload = $workload
        PredecessorEvidence = $predecessorEvidence
        RequireLoadAcceptance = [bool]$requireLoadAcceptanceValue
        AutomaticRollback = [bool]$automaticRollbackValue
        NotificationTopicArn = $notificationTopicArn
        SupervisedHeartbeatPaths = $supervisedHeartbeatPaths
        Resources = $resources
        ExpectedNatGatewayCount = $expectedNatGatewayCount
        ExpectedRoute53MeasureLatency = [bool]$expectedRoute53MeasureLatencyValue
        ExpectedEcsAssignPublicIp = $expectedEcsAssignPublicIp
        EcsTaskSubnetIds = $ecsTaskSubnetIds
        ExpectedRedisNodeType = $expectedRedisNodeType
        ExpectedRdsInstanceClass = if ($expectedRdsInstanceClass) { $expectedRdsInstanceClass } else { $null }
        ExpectedRdsPosture = $expectedRdsPosture
        ExpectedActiveApiTaskDefinitionArn = if ($expectedActiveApiTaskDefinitionArn) { $expectedActiveApiTaskDefinitionArn } else { $null }
        ExpectedActiveWorkerTaskDefinitionArn = if ($expectedActiveWorkerTaskDefinitionArn) { $expectedActiveWorkerTaskDefinitionArn } else { $null }
        RedisResizeCompletedAtUtc = $redisResizeCompletedAtUtc
        Thresholds = $thresholds
    }
}

function Invoke-AwsJson {
    param([string[]]$Arguments)
    $raw = & aws @Arguments --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "AWS CLI request failed for $($Arguments[0]) $($Arguments[1])." }
    $text = ($raw | Out-String).Trim()
    if (-not $text) { return $null }
    return $text | ConvertFrom-Json -Depth 40
}

function Get-WafDeviceLabelMatch {
    param($Statement)
    $label = Get-OptionalValue $Statement "LabelMatchStatement"
    if ($null -eq $label -or [string](Get-OptionalValue $label "Scope" "") -cne "LABEL") { return $null }
    $key = [string](Get-OptionalValue $label "Key" "")
    if ($key -cne "device-ingest") { return $null }
    return $label
}

function Assert-DiagnosticWafDeviceIngestClassifierContract {
    param([object[]]$Rules, $Resources)
    $matches = @($Rules | Where-Object Name -eq "DeviceIngestClassifier")
    if ($matches.Count -ne 1) { throw "Diagnostic WAF requires exactly one DeviceIngestClassifier rule." }
    $rule = $matches[0]
    $action = Get-OptionalValue $rule "Action"
    $actionNames = @(if ($null -eq $action) { @() } else { @($action.PSObject.Properties.Name) })
    $countAction = Get-OptionalValue $action "Count"
    $statement = Get-OptionalValue $rule "Statement"
    $statementNames = @(if ($null -eq $statement) { @() } else { @($statement.PSObject.Properties.Name) })
    $and = Get-OptionalValue $statement "AndStatement"
    $statements = @((Get-OptionalValue $and "Statements" @()))
    $visibility = Get-OptionalValue $rule "VisibilityConfig"
    $labels = @((Get-OptionalValue $rule "RuleLabels" @()))
    if ($actionNames.Count -ne 1 -or [string]$actionNames[0] -cne "Count" -or $null -eq $countAction -or
        @($countAction.PSObject.Properties).Count -ne 0 -or [int](Get-OptionalValue $rule "Priority" -1) -ne 25 -or
        $statementNames.Count -ne 1 -or [string]$statementNames[0] -cne "AndStatement" -or
        $null -eq $and -or $statements.Count -ne 2 -or $labels.Count -ne 1 -or
        [string](Get-OptionalValue $labels[0] "Name" "") -cne "device-ingest" -or
        [string](Get-OptionalValue $visibility "MetricName" "") -cne [string]$Resources.wafDeviceClassifierMetricName -or
        (Get-OptionalValue $visibility "CloudWatchMetricsEnabled" $false) -ne $true -or
        (Get-OptionalValue $visibility "SampledRequestsEnabled" $false) -ne $true) {
        throw "Diagnostic DeviceIngestClassifier no longer matches its exact priority-25 COUNT, device-ingest label, AND statement, and metric contract."
    }

    $byteStatements = @($statements | ForEach-Object { Get-OptionalValue $_ "ByteMatchStatement" } | Where-Object { $null -ne $_ })
    $regexStatements = @($statements | ForEach-Object { Get-OptionalValue $_ "RegexMatchStatement" } | Where-Object { $null -ne $_ })
    if ($byteStatements.Count -ne 1 -or $regexStatements.Count -ne 1) {
        throw "Diagnostic DeviceIngestClassifier must contain exactly one method match and one URI-path regex match."
    }
    $byte = $byteStatements[0]
    $byteField = Get-OptionalValue $byte "FieldToMatch"
    $byteFieldNames = @(if ($null -eq $byteField) { @() } else { @($byteField.PSObject.Properties.Name) })
    $byteTransforms = @((Get-OptionalValue $byte "TextTransformations" @()))
    if ([string](Get-OptionalValue $byte "SearchString" "") -notin @("POST", "UE9TVA==") -or
        $byteFieldNames.Count -ne 1 -or [string]$byteFieldNames[0] -cne "Method" -or
        $null -eq (Get-OptionalValue $byteField "Method") -or
        [string](Get-OptionalValue $byte "PositionalConstraint" "") -cne "EXACTLY" -or
        $byteTransforms.Count -ne 1 -or [int](Get-OptionalValue $byteTransforms[0] "Priority" -1) -ne 0 -or
        [string](Get-OptionalValue $byteTransforms[0] "Type" "") -cne "NONE") {
        throw "Diagnostic DeviceIngestClassifier must match the exact POST method with no text transformation."
    }

    $regex = $regexStatements[0]
    $regexField = Get-OptionalValue $regex "FieldToMatch"
    $regexFieldNames = @(if ($null -eq $regexField) { @() } else { @($regexField.PSObject.Properties.Name) })
    $regexTransforms = @((Get-OptionalValue $regex "TextTransformations" @()))
    if ([string](Get-OptionalValue $regex "RegexString" "") -cne '^/api/(classpilot/)?device/(heartbeat|screenshot)$' -or
        $regexFieldNames.Count -ne 1 -or [string]$regexFieldNames[0] -cne "UriPath" -or
        $null -eq (Get-OptionalValue $regexField "UriPath") -or
        $regexTransforms.Count -ne 1 -or [int](Get-OptionalValue $regexTransforms[0] "Priority" -1) -ne 0 -or
        [string](Get-OptionalValue $regexTransforms[0] "Type" "") -cne "NONE") {
        throw "Diagnostic DeviceIngestClassifier must match the exact reviewed device-ingest URI regex with no text transformation."
    }
}

function Assert-DiagnosticWafRateRuleContract {
    param([object[]]$Rules, $Resources)
    $contracts = @(
        [pscustomobject]@{Name="DeviceIngestRateLimit";Priority=30;Limit=100000;Metric=[string]$Resources.wafDeviceRuleMetricName},
        [pscustomobject]@{Name="ApiRateLimit";Priority=40;Limit=50000;Metric=[string]$Resources.wafApiRuleMetricName}
    )
    $validated = @{}
    foreach ($contract in $contracts) {
        $matches = @($Rules | Where-Object Name -eq $contract.Name)
        if ($matches.Count -ne 1) { throw "Diagnostic WAF requires exactly one $($contract.Name) rule." }
        $rule = $matches[0]
        $action = Get-OptionalValue $rule "Action"
        $actionNames = @(if ($null -eq $action) { @() } else { @($action.PSObject.Properties.Name) })
        $visibility = Get-OptionalValue $rule "VisibilityConfig"
        $rate = Get-OptionalValue (Get-OptionalValue $rule "Statement") "RateBasedStatement"
        $scope = Get-OptionalValue $rate "ScopeDownStatement"
        if ($actionNames.Count -ne 1 -or [string]$actionNames[0] -cne "Block" -or
            [int](Get-OptionalValue $rule "Priority" -1) -ne $contract.Priority -or $null -eq $rate -or
            [int](Get-OptionalValue $rate "Limit" -1) -ne $contract.Limit -or
            [int](Get-OptionalValue $rate "EvaluationWindowSec" 300) -ne 300 -or
            [string](Get-OptionalValue $rate "AggregateKeyType" "") -cne "IP" -or $null -eq $scope -or
            [string](Get-OptionalValue $visibility "MetricName" "") -cne $contract.Metric -or
            (Get-OptionalValue $visibility "CloudWatchMetricsEnabled" $false) -ne $true -or
            (Get-OptionalValue $visibility "SampledRequestsEnabled" $false) -ne $true) {
            throw "$($contract.Name) does not match its exact diagnostic BLOCK, priority, IP/5-minute limit, scope, and metric contract."
        }
        $validated[$contract.Name] = [pscustomobject]@{rate=$rate;scope=$scope}
    }
    $deviceLabel = Get-WafDeviceLabelMatch $validated.DeviceIngestRateLimit.scope
    $and = Get-OptionalValue $validated.ApiRateLimit.scope "AndStatement"
    $statements = @((Get-OptionalValue $and "Statements" @()))
    $byteStatements = @($statements | ForEach-Object { Get-OptionalValue $_ "ByteMatchStatement" } | Where-Object { $null -ne $_ })
    $notStatements = @($statements | ForEach-Object { Get-OptionalValue $_ "NotStatement" } | Where-Object { $null -ne $_ })
    if ($null -eq $deviceLabel -or $null -eq $and -or $statements.Count -ne 2 -or
        $byteStatements.Count -ne 1 -or $notStatements.Count -ne 1) {
        throw "Diagnostic WAF rate-rule scopes no longer match the reviewed device/API split."
    }
    $byte = $byteStatements[0]
    $search = [string](Get-OptionalValue $byte "SearchString" "")
    $transforms = @((Get-OptionalValue $byte "TextTransformations" @()))
    $uriPath = Get-OptionalValue (Get-OptionalValue $byte "FieldToMatch") "UriPath"
    $excludedLabel = Get-WafDeviceLabelMatch (Get-OptionalValue $notStatements[0] "Statement")
    if ($search -notin @("/api/", "L2FwaS8=") -or $null -eq $uriPath -or
        [string](Get-OptionalValue $byte "PositionalConstraint" "") -cne "STARTS_WITH" -or
        $transforms.Count -ne 1 -or [int](Get-OptionalValue $transforms[0] "Priority" -1) -ne 0 -or
        [string](Get-OptionalValue $transforms[0] "Type" "") -cne "NONE" -or $null -eq $excludedLabel -or
        [string](Get-OptionalValue $excludedLabel "Key" "") -cne [string](Get-OptionalValue $deviceLabel "Key" "")) {
        throw "Diagnostic ApiRateLimit no longer scopes /api/ while excluding the exact device-ingest label."
    }
}

function Assert-WafMetricIdentity {
    param($Resources, [switch]$RequireDiagnosticContract)
    $region = [string]$Resources.region
    $listed = Invoke-AwsJson -Arguments @("wafv2", "list-web-acls", "--region", $region, "--scope", "CLOUDFRONT")
    $matches = @($listed.WebACLs | Where-Object Name -eq ([string]$Resources.wafWebAclName))
    if ($matches.Count -ne 1) {
        throw "wafWebAclName must be the exact deployed CloudFront WebACL resource name."
    }
    $acl = Invoke-AwsJson -Arguments @(
        "wafv2", "get-web-acl", "--region", $region, "--scope", "CLOUDFRONT",
        "--name", ([string]$matches[0].Name), "--id", ([string]$matches[0].Id)
    )
    $expected = @{
        DeviceIngestRateLimit = [string]$Resources.wafDeviceRuleMetricName
        ApiRateLimit = [string]$Resources.wafApiRuleMetricName
    }
    foreach ($ruleName in $expected.Keys) {
        $rules = @($acl.WebACL.Rules | Where-Object Name -eq $ruleName)
        if ($rules.Count -ne 1 -or [string]$rules[0].VisibilityConfig.MetricName -ne $expected[$ruleName]) {
            throw "WAF rule metric identity for $ruleName does not match the deployed WebACL."
        }
    }
    if ($RequireDiagnosticContract) {
        [void](Assert-DiagnosticWafDeviceIngestClassifierContract -Rules @($acl.WebACL.Rules) -Resources $Resources)
        [void](Assert-DiagnosticWafRateRuleContract -Rules @($acl.WebACL.Rules) -Resources $Resources)
        $webAclArn = [string](Get-OptionalValue $acl.WebACL "ARN" "")
        if ($webAclArn -notmatch '^arn:aws:wafv2:us-east-1:135775632425:global/webacl/') {
            throw "Diagnostic WAF must remain a production-account CloudFront-scope WebACL."
        }
        $distribution = Invoke-AwsJson -Arguments @("cloudfront","get-distribution-config","--id",[string]$Resources.cloudFrontDistributionId)
        $distributionConfig = Get-OptionalValue $distribution "DistributionConfig"
        $aliases = @((Get-OptionalValue (Get-OptionalValue $distributionConfig "Aliases") "Items" @()) | ForEach-Object { [string]$_ })
        if ([string](Get-OptionalValue $distributionConfig "WebACLId" "") -cne $webAclArn -or "school-pilot.net" -notin $aliases) {
            throw "Diagnostic CloudFront distribution is not associated with the reviewed WAF WebACL."
        }
        $association = Invoke-AwsJson -Arguments @("cloudfront","list-distributions-by-web-acl-id","--web-acl-id",$webAclArn)
        $associatedIds = @((Get-OptionalValue (Get-OptionalValue $association "DistributionList") "Items" @()) |
            ForEach-Object { [string](Get-OptionalValue $_ "Id" "") })
        if ([string]$Resources.cloudFrontDistributionId -notin $associatedIds) {
            throw "CloudFront did not report the bound production distribution in the WebACL association set."
        }
    }
}

function Assert-DiagnosticRedisIdentity {
    param($Resources, [string]$ExpectedNodeType)
    $groupResponse = Invoke-AwsJson -Arguments @("elasticache","describe-replication-groups","--region",$Resources.region,
        "--replication-group-id",$Resources.redisReplicationGroupId)
    $groups = @($groupResponse.ReplicationGroups)
    $clusterResponse = Invoke-AwsJson -Arguments @("elasticache","describe-cache-clusters","--region",$Resources.region,
        "--cache-cluster-id",$Resources.redisCacheClusterId,"--show-cache-node-info")
    $clusters = @($clusterResponse.CacheClusters)
    if ($groups.Count -ne 1 -or $clusters.Count -ne 1) { throw "Diagnostic Redis group/member resources were not uniquely resolved." }
    $group = $groups[0]; $cluster = $clusters[0]
    $members = @((Get-OptionalValue $group "MemberClusters" @()) | ForEach-Object { [string]$_ })
    if ([string](Get-OptionalValue $group "ReplicationGroupId" "") -cne [string]$Resources.redisReplicationGroupId -or
        [string](Get-OptionalValue $group "Status" "") -cne "available" -or
        [string](Get-OptionalValue $group "CacheNodeType" "") -cne $ExpectedNodeType -or
        [string]$Resources.redisCacheClusterId -notin $members -or
        [string](Get-OptionalValue $cluster "CacheClusterId" "") -cne [string]$Resources.redisCacheClusterId -or
        [string](Get-OptionalValue $cluster "ReplicationGroupId" "") -cne [string]$Resources.redisReplicationGroupId -or
        [string](Get-OptionalValue $cluster "CacheClusterStatus" "") -cne "available" -or
        [string](Get-OptionalValue $cluster "CacheNodeType" "") -cne $ExpectedNodeType) {
        throw "Diagnostic redisCacheClusterId is not an available expected-node-type member of the bound replication group."
    }
    return [ordered]@{replicationGroupId=[string]$Resources.redisReplicationGroupId;cacheClusterId=[string]$Resources.redisCacheClusterId;
        groupNodeType=[string]$group.CacheNodeType;clusterNodeType=[string]$cluster.CacheNodeType;memberClusterIds=$members}
}

function New-MetricQuery {
    param(
        [string]$Id,
        [string]$Namespace,
        [string]$MetricName,
        [hashtable]$Dimensions,
        [ValidateSet("Average", "Maximum", "Minimum", "Sum")]
        [string]$Statistic,
        [ValidateSet(60, 300)]
        [int]$Period = 60
    )
    if ($Id -notmatch '^[a-z][a-z0-9_]{0,254}$') { throw "CloudWatch query id '$Id' is invalid." }
    $dimensionList = @($Dimensions.GetEnumerator() | Sort-Object Name | ForEach-Object {
        [ordered]@{ Name = [string]$_.Name; Value = [string]$_.Value }
    })
    return [ordered]@{
        Id = $Id
        ReturnData = $true
        MetricStat = [ordered]@{
            Metric = [ordered]@{
                Namespace = $Namespace
                MetricName = $MetricName
                Dimensions = $dimensionList
            }
            Period = $Period
            Stat = $Statistic
        }
    }
}

function New-MetricMathQuery {
    param([string]$Id, [string]$Expression, [string]$Label)
    if ($Id -notmatch '^[a-z][a-z0-9_]{0,254}$' -or [string]::IsNullOrWhiteSpace($Expression)) {
        throw "CloudWatch metric-math query is invalid."
    }
    return [ordered]@{Id=$Id;Expression=$Expression;Label=$Label;ReturnData=$true}
}

function Invoke-CloudWatchMetricBatch {
    param([string]$Region, [object[]]$Queries)
    if ($Queries.Count -lt 1 -or $Queries.Count -gt 500) { throw "CloudWatch metric batch must contain 1-500 queries." }
    $end = [DateTimeOffset]::UtcNow
    # Burstable-credit metrics are published every five minutes and can arrive
    # after the next five-minute boundary. Keep enough lookback to distinguish
    # a delayed healthy datapoint from genuinely missing telemetry and to retain
    # it through all three fail-closed stale confirmations.
    $start = $end.AddMinutes(-15)
    $queryPath = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-metrics-$([Guid]::NewGuid().ToString('N')).json"
    try {
        [IO.File]::WriteAllText($queryPath, ($Queries | ConvertTo-Json -Depth 15), [Text.UTF8Encoding]::new($false))
        $response = Invoke-AwsJson -Arguments @(
            "cloudwatch", "get-metric-data", "--region", $Region,
            "--metric-data-queries", "file://$queryPath",
            "--start-time", $start.ToString("yyyy-MM-ddTHH:mm:ssZ"),
            "--end-time", $end.ToString("yyyy-MM-ddTHH:mm:ssZ"),
            "--scan-by", "TimestampDescending", "--max-datapoints", "5000"
        )
    }
    finally {
        if (Test-Path -LiteralPath $queryPath) { Remove-Item -LiteralPath $queryPath -Force }
    }
    $collectedThroughUtc = [DateTimeOffset]::UtcNow
    $latestMetrics = @{}
    $series = @{}
    foreach ($result in @($response.MetricDataResults)) {
        if ([string]$result.StatusCode -notin @("Complete", "PartialData")) { continue }
        $points = for ($index = 0; $index -lt @($result.Timestamps).Count; $index++) {
            [pscustomobject]@{
                Timestamp = ([DateTimeOffset]$result.Timestamps[$index]).ToUniversalTime()
                Value = [double]$result.Values[$index]
            }
        }
        $orderedPoints = @($points | Sort-Object Timestamp)
        $latest = @($orderedPoints | Where-Object Timestamp -le $collectedThroughUtc | Select-Object -Last 1)
        $id = [string]$result.Id
        $series[$id] = $orderedPoints
        $isCompleteSparseWafZero = [string]$result.StatusCode -eq "Complete" -and $latest.Count -eq 0 -and
            $id -in @("waf_device_blocked", "waf_api_blocked")
        $latestMetrics[$id] = if ($isCompleteSparseWafZero) {
            [pscustomobject]@{ Timestamp = $end; Value = 0.0; SparseZero = $true }
        } elseif ($latest.Count -eq 0) { $null } else { $latest[0] }
    }
    return [pscustomobject]@{
        Latest = $latestMetrics
        Series = $series
        CollectedThroughUtc = $collectedThroughUtc
    }
}

function Get-BatchMetric {
    param($Metrics, [string]$Id)
    if (-not $Metrics.Latest.ContainsKey($Id)) { return $null }
    return $Metrics.Latest[$Id]
}

function Get-BatchSeries {
    param($Metrics, [string]$Id)
    if (-not $Metrics.Series.ContainsKey($Id)) { return @() }
    return @($Metrics.Series[$Id])
}

function Get-MetricNumber {
    param($Metric)
    if ($null -eq $Metric) { return $null }
    return [double]$Metric.Value
}

function Test-HasObjectMembers {
    param($Value)
    if ($null -eq $Value) { return $false }
    if ($Value -is [Collections.IDictionary]) { return $Value.Count -gt 0 }
    return @($Value.PSObject.Properties).Count -gt 0
}

function Get-EcsState {
    param($Config)
    $r = $Config.Resources
    $response = Invoke-AwsJson -Arguments @(
        "ecs", "describe-services", "--region", $r.region, "--cluster", $r.cluster,
        "--services", $r.apiService, $r.workerService
    )
    $states = @{}
    foreach ($service in @($response.services)) {
        $states[$service.serviceName] = [ordered]@{
            desired = [int]$service.desiredCount
            running = [int]$service.runningCount
            pending = [int]$service.pendingCount
            taskDefinition = [string]$service.taskDefinition
            deploymentCount = @($service.deployments).Count
            subnets = @($service.networkConfiguration.awsvpcConfiguration.subnets | ForEach-Object { [string]$_ } | Sort-Object)
            assignPublicIp = [string]$service.networkConfiguration.awsvpcConfiguration.assignPublicIp
        }
    }
    return $states
}

function Get-EcsNetworkState {
    param($Config, $ServiceState)
    $r = $Config.Resources
    $expectedAssign = if ($Config.ExpectedEcsAssignPublicIp) { "ENABLED" } else { "DISABLED" }
    $expectedSubnets = @($Config.EcsTaskSubnetIds | Sort-Object)
    $expectedRunningTasks = 0
    $serviceMismatches = [System.Collections.Generic.List[string]]::new()
    $taskArns = [System.Collections.Generic.List[string]]::new()
    foreach ($serviceName in @($r.apiService, $r.workerService)) {
        $state = $ServiceState[$serviceName]
        if ($null -ne $state) { $expectedRunningTasks += [int]$state.running }
        if ($null -eq $state -or [string]$state.assignPublicIp -ne $expectedAssign -or
            @(Compare-Object $expectedSubnets @($state.subnets | Sort-Object)).Count -gt 0) {
            $serviceMismatches.Add($serviceName)
        }
        $listed = Invoke-AwsJson -Arguments @(
            "ecs", "list-tasks", "--region", $r.region, "--cluster", $r.cluster,
            "--service-name", $serviceName, "--desired-status", "RUNNING"
        )
        foreach ($taskArn in @($listed.taskArns)) { $taskArns.Add([string]$taskArn) }
    }

    $networkInterfaceIds = [System.Collections.Generic.List[string]]::new()
    $taskDefinitionMismatches = [System.Collections.Generic.List[object]]::new()
    if ($taskArns.Count -gt 0) {
        for ($offset = 0; $offset -lt $taskArns.Count; $offset += 100) {
            $last = [math]::Min($taskArns.Count - 1, $offset + 99)
            $described = Invoke-AwsJson -Arguments (@(
                "ecs", "describe-tasks", "--region", $r.region, "--cluster", $r.cluster, "--tasks"
            ) + @($taskArns[$offset..$last]))
            foreach ($task in @($described.tasks)) {
                $taskService = ([string](Get-OptionalValue $task "group" "") -replace '^service:', '')
                $expectedTaskDefinition = if ($taskService -eq [string]$r.apiService) {
                    $Config.ExpectedActiveApiTaskDefinitionArn
                }
                elseif ($taskService -eq [string]$r.workerService) {
                    $Config.ExpectedActiveWorkerTaskDefinitionArn
                }
                else { $null }
                if ($expectedTaskDefinition -and
                    ([string](Get-OptionalValue $task "taskDefinitionArn" "") -ne [string]$expectedTaskDefinition -or
                    [string](Get-OptionalValue $task "lastStatus" "") -ne "RUNNING")) {
                    $taskDefinitionMismatches.Add([ordered]@{
                        taskArn=[string](Get-OptionalValue $task "taskArn" "")
                        service=$taskService
                        expectedTaskDefinitionArn=[string]$expectedTaskDefinition
                        actualTaskDefinitionArn=[string](Get-OptionalValue $task "taskDefinitionArn" "")
                        lastStatus=[string](Get-OptionalValue $task "lastStatus" "")
                    })
                }
                foreach ($attachment in @($task.attachments | Where-Object type -eq "ElasticNetworkInterface")) {
                    $eni = @($attachment.details | Where-Object name -eq "networkInterfaceId" | Select-Object -First 1)
                    if ($eni.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$eni[0].value)) {
                        $networkInterfaceIds.Add([string]$eni[0].value)
                    }
                }
            }
        }
    }
    $interfaces = @()
    if ($networkInterfaceIds.Count -gt 0) {
        $networkResponse = Invoke-AwsJson -Arguments (@(
            "ec2", "describe-network-interfaces", "--region", $r.region, "--network-interface-ids"
        ) + @($networkInterfaceIds | Sort-Object -Unique))
        $interfaces = @($networkResponse.NetworkInterfaces)
    }
    $publicCount = @($interfaces | Where-Object {
        $associationMember = $_.PSObject.Properties["Association"]
        if ($null -eq $associationMember -or $null -eq $associationMember.Value) { return $false }
        $publicIpMember = $associationMember.Value.PSObject.Properties["PublicIp"]
        return $null -ne $publicIpMember -and -not [string]::IsNullOrWhiteSpace([string]$publicIpMember.Value)
    }).Count
    $uniqueEnis = @($networkInterfaceIds | Sort-Object -Unique)
    $allInterfacesReturned = $interfaces.Count -eq $uniqueEnis.Count
    $publicIpContractSatisfied = $allInterfacesReturned -and $taskArns.Count -eq $expectedRunningTasks -and
        $interfaces.Count -eq $taskArns.Count -and (
        ($Config.ExpectedEcsAssignPublicIp -and $publicCount -eq $interfaces.Count) -or
        (-not $Config.ExpectedEcsAssignPublicIp -and $publicCount -eq 0)
    )
    return [ordered]@{
        expectedAssignPublicIp = $expectedAssign
        expectedSubnets = $expectedSubnets
        serviceMismatches = @($serviceMismatches)
        runningTaskCount = $taskArns.Count
        expectedRunningTaskCount = $expectedRunningTasks
        eniCount = $interfaces.Count
        publicIpv4Count = $publicCount
        allInterfacesReturned = $allInterfacesReturned
        taskDefinitionMismatches = @($taskDefinitionMismatches)
        satisfied = $serviceMismatches.Count -eq 0 -and $publicIpContractSatisfied
    }
}

function Get-NewStoppedTasks {
    param($Config)
    $r = $Config.Resources
    $taskArns = @()
    foreach ($serviceName in @($r.apiService, $r.workerService)) {
        $response = Invoke-AwsJson -Arguments @(
            "ecs", "list-tasks", "--region", $r.region, "--cluster", $r.cluster,
            "--service-name", $serviceName, "--desired-status", "STOPPED"
        )
        $taskArns += @($response.taskArns)
    }
    $taskArns = @($taskArns | Sort-Object -Unique)
    if ($taskArns.Count -eq 0) { return @() }

    $allTasks = @()
    for ($offset = 0; $offset -lt $taskArns.Count; $offset += 100) {
        $last = [math]::Min($taskArns.Count - 1, $offset + 99)
        $batch = @($taskArns[$offset..$last])
        $arguments = @(
            "ecs", "describe-tasks", "--region", $r.region, "--cluster", $r.cluster, "--tasks"
        ) + $batch
        $details = Invoke-AwsJson -Arguments $arguments
        $allTasks += @($details.tasks)
    }
    $recent = @()
    foreach ($task in $allTasks) {
        $taskArn = [string]$task.taskArn
        if ($script:SeenStoppedTasks.ContainsKey($taskArn)) { continue }
        # ECS can return a task from list-tasks --desired-status STOPPED while
        # it is still DEACTIVATING. describe-tasks does not include stoppedAt
        # until the transition completes, so leave it unseen and retry it on
        # the next sample instead of treating a normal scale-in as bad data.
        $stoppedAtValue = Get-OptionalValue $task "stoppedAt"
        if ($null -eq $stoppedAtValue -or [string]::IsNullOrWhiteSpace([string]$stoppedAtValue)) { continue }
        $stoppedAt = [DateTimeOffset]$stoppedAtValue
        $script:SeenStoppedTasks[$taskArn] = $true
        if ($stoppedAt -lt $script:StartedAt.AddSeconds(-5)) { continue }
        $containers = @(Get-OptionalValue $task "containers" @())
        $containerReasons = @($containers | ForEach-Object { [string](Get-OptionalValue $_ "reason" "") } | Where-Object { $_ })
        $exitCodes = @($containers | ForEach-Object {
            $exitCode = Get-OptionalValue $_ "exitCode"
            if ($null -ne $exitCode) { [int]$exitCode }
        })
        $stopCode = [string](Get-OptionalValue $task "stopCode" "")
        $stoppedReason = [string](Get-OptionalValue $task "stoppedReason" "")
        $reasonText = ($stoppedReason + " " + ($containerReasons -join " ")).ToLowerInvariant()
        $expectedScaleOrDeploymentStop = (
            $stopCode -eq "ServiceSchedulerInitiated" -and
            $reasonText -match '(scaling activity|deployment|rolling update|desired count)' -and
            $reasonText -notmatch '(unhealthy|failed|failure|essential container|error|out.?of.?memory)'
        )
        $recent += [ordered]@{
            taskArnSuffix = $taskArn.Split('/')[-1]
            service = ([string](Get-OptionalValue $task "group" "") -replace '^service:', '')
            stoppedAt = $stoppedAt.ToString("o")
            stopCode = $stopCode
            stoppedReason = $stoppedReason
            exitCodes = $exitCodes
            oom = $reasonText.Contains("outofmemory") -or $reasonText.Contains("out of memory") -or $exitCodes -contains 137
            expectedScaleOrDeploymentStop = $expectedScaleOrDeploymentStop
        }
    }
    return $recent
}

function Get-RdsState {
    param($Config)
    $r = $Config.Resources
    $response = Invoke-AwsJson -Arguments @(
        "rds", "describe-db-instances", "--region", $r.region,
        "--db-instance-identifier", $r.rdsInstanceId
    )
    $instance = @($response.DBInstances)[0]
    return [ordered]@{
        status = [string]$instance.DBInstanceStatus
        instanceClass = [string](Get-OptionalValue $instance "DBInstanceClass" "")
        dbInstanceArn = [string](Get-OptionalValue $instance "DBInstanceArn" "")
        engine = [string](Get-OptionalValue $instance "Engine" "")
        engineVersion = [string](Get-OptionalValue $instance "EngineVersion" "")
        allocatedStorageGiB = [int]$instance.AllocatedStorage
        maxAllocatedStorageGiB = [int]$instance.MaxAllocatedStorage
        storageType = [string](Get-OptionalValue $instance "StorageType" "")
        storageEncrypted = [bool](Get-OptionalValue $instance "StorageEncrypted" $false)
        multiAz = [bool](Get-OptionalValue $instance "MultiAZ" $false)
        publiclyAccessible = [bool](Get-OptionalValue $instance "PubliclyAccessible" $false)
        performanceInsightsEnabled = [bool](Get-OptionalValue $instance "PerformanceInsightsEnabled" $false)
        dbSubnetGroup = [string](Get-OptionalValue (Get-OptionalValue $instance "DBSubnetGroup") "DBSubnetGroupName" "")
        vpcSecurityGroupIds = @((Get-OptionalValue $instance "VpcSecurityGroups" @()) | ForEach-Object { [string]$_.VpcSecurityGroupId } | Sort-Object)
        pendingModifiedValues = $instance.PendingModifiedValues
    }
}

function Convert-MetricScale {
    param($Metric, [double]$Multiplier)
    if ($null -eq $Metric) { return $null }
    return [pscustomobject]@{
        Timestamp = ([DateTimeOffset]$Metric.Timestamp).ToUniversalTime()
        Value = [double]$Metric.Value * $Multiplier
    }
}

function Get-RedisState {
    param($Config)
    $r = $Config.Resources
    $response = Invoke-AwsJson -Arguments @(
        "elasticache", "describe-replication-groups", "--region", $r.region,
        "--replication-group-id", $r.redisReplicationGroupId
    )
    $group = @($response.ReplicationGroups)[0]
    $state = [ordered]@{
        status = [string]$group.Status
        nodeType = [string]$group.CacheNodeType
        pendingModifiedValues = $group.PendingModifiedValues
        replicationGroupId = [string](Get-OptionalValue $group "ReplicationGroupId" "")
        memberClusterIds = @((Get-OptionalValue $group "MemberClusters" @()) | ForEach-Object { [string]$_ })
    }
    if ($Config.DiagnosticOnly) {
        $clusterResponse = Invoke-AwsJson -Arguments @(
            "elasticache", "describe-cache-clusters", "--region", $r.region,
            "--cache-cluster-id", $r.redisCacheClusterId, "--show-cache-node-info"
        )
        $clusters = @($clusterResponse.CacheClusters)
        if ($clusters.Count -ne 1) {
            $state.clusterIdentityValid = $false
            return [pscustomobject]$state
        }
        $cluster = $clusters[0]
        $state.cacheClusterId = [string](Get-OptionalValue $cluster "CacheClusterId" "")
        $state.clusterStatus = [string](Get-OptionalValue $cluster "CacheClusterStatus" "")
        $state.clusterNodeType = [string](Get-OptionalValue $cluster "CacheNodeType" "")
        $state.clusterReplicationGroupId = [string](Get-OptionalValue $cluster "ReplicationGroupId" "")
        $state.clusterIdentityValid = (
            $state.replicationGroupId -ceq [string]$r.redisReplicationGroupId -and
            [string]$r.redisCacheClusterId -in @($state.memberClusterIds) -and
            $state.cacheClusterId -ceq [string]$r.redisCacheClusterId -and
            $state.clusterReplicationGroupId -ceq [string]$r.redisReplicationGroupId -and
            $state.clusterStatus -ceq "available" -and
            $state.clusterNodeType -ceq [string]$Config.ExpectedRedisNodeType
        )
    }
    return [pscustomobject]$state
}

function Get-AutomatedRedisSnapshotState {
    param($Config)
    if ($Config.Phase -ne "Final") { return $null }
    $response = Invoke-AwsJson -Arguments @(
        "elasticache", "describe-snapshots", "--region", $Config.Resources.region,
        "--replication-group-id", $Config.Resources.redisReplicationGroupId,
        "--snapshot-source", "automated"
    )
    $snapshots = @($response.Snapshots | Where-Object { $null -ne $_ })
    $eligible = @($snapshots | Where-Object {
        [string]$_.SnapshotStatus -eq "available" -and
        $null -ne $_.NodeSnapshots -and
        @($_.NodeSnapshots | Where-Object {
            $null -ne $_.SnapshotCreateTime -and
            ([DateTimeOffset]$_.SnapshotCreateTime).ToUniversalTime() -gt $Config.RedisResizeCompletedAtUtc
        }).Count -gt 0
    } | Sort-Object { [DateTimeOffset]($_.NodeSnapshots[0].SnapshotCreateTime) } -Descending)
    return [ordered]@{
        resizeCompletedAtUtc = $Config.RedisResizeCompletedAtUtc.ToString("o")
        qualifyingAvailableCount = $eligible.Count
        accepted = $eligible.Count -gt 0
        snapshotName = if ($eligible.Count -gt 0) { [string]$eligible[0].SnapshotName } else { $null }
    }
}

function Get-TargetState {
    param($Config)
    $response = Invoke-AwsJson -Arguments @(
        "elbv2", "describe-target-health", "--region", $Config.Resources.region,
        "--target-group-arn", $Config.Resources.targetGroupArn
    )
    $descriptions = @($response.TargetHealthDescriptions)
    return [ordered]@{
        healthy = @($descriptions | Where-Object { $_.TargetHealth.State -eq "healthy" }).Count
        unhealthy = @($descriptions | Where-Object { $_.TargetHealth.State -eq "unhealthy" }).Count
        total = $descriptions.Count
    }
}

function Get-Route53State {
    param($Config)
    if (-not $Config.Resources.route53HealthCheckId) { return $null }
    $response = Invoke-AwsJson -Arguments @(
        "route53", "get-health-check-status", "--health-check-id", $Config.Resources.route53HealthCheckId
    )
    $observations = @($response.HealthCheckObservations)
    $healthCheck = Invoke-AwsJson -Arguments @(
        "route53", "get-health-check", "--health-check-id", $Config.Resources.route53HealthCheckId
    )
    $alarmResponse = Invoke-AwsJson -Arguments @(
        "cloudwatch", "describe-alarms", "--region", $Config.Resources.region,
        "--alarm-names", $Config.Resources.route53AlarmName
    )
    $alarms = @($alarmResponse.MetricAlarms)
    $statuses = @($observations | ForEach-Object { [string]$_.StatusReport.Status })
    $exact200 = @($statuses | Where-Object { $_ -match '^Success: HTTP Status Code 200(?:\b|$)' }).Count
    $configuration = $healthCheck.HealthCheck.HealthCheckConfig
    return [ordered]@{
        successful = $exact200
        total = $observations.Count
        statuses = $statuses
        type = [string]$configuration.Type
        resourcePath = [string]$configuration.ResourcePath
        measureLatency = [bool]$configuration.MeasureLatency
        alarmFound = $alarms.Count -eq 1
        alarmState = if ($alarms.Count -eq 1) { [string]$alarms[0].StateValue } else { $null }
    }
}

function Get-NatState {
    param($Config)
    $r = $Config.Resources
    $response = Invoke-AwsJson -Arguments @(
        "ec2", "describe-nat-gateways", "--region", $r.region,
        "--filter", "Name=vpc-id,Values=$($r.vpcId)", "Name=state,Values=available,pending,failed"
    )
    $gateways = @($response.NatGateways)
    return [ordered]@{
        available = @($gateways | Where-Object State -eq "available").Count
        pending = @($gateways | Where-Object State -eq "pending").Count
        failed = @($gateways | Where-Object State -eq "failed").Count
        gatewayIds = @($gateways | Where-Object State -eq "available" | ForEach-Object { [string]$_.NatGatewayId } | Sort-Object)
    }
}

function Get-WafState {
    param($Config, $Metrics)
    $deviceBlocked = Get-BatchMetric $Metrics "waf_device_blocked"
    $apiBlocked = Get-BatchMetric $Metrics "waf_api_blocked"
    $deviceCounted = Get-BatchMetric $Metrics "waf_device_counted"
    $apiCounted = Get-BatchMetric $Metrics "waf_api_counted"
    $freshCutoff = [DateTimeOffset]::UtcNow.AddSeconds(-[double]$Config.Thresholds.metricFreshnessMaximumSeconds)
    $freshBlocked = @(@($deviceBlocked, $apiBlocked) | Where-Object { $null -ne $_ -and $_.Timestamp -ge $freshCutoff })
    return [ordered]@{
        deviceRateBlocked = Get-MetricNumber $deviceBlocked
        apiRateBlocked = Get-MetricNumber $apiBlocked
        deviceRateCounted = Get-MetricNumber $deviceCounted
        apiRateCounted = Get-MetricNumber $apiCounted
        blockedObserved = @($freshBlocked | Where-Object Value -gt 0).Count -gt 0
        deviceBlockedFresh = $null -ne $deviceBlocked -and $deviceBlocked.Timestamp -ge $freshCutoff
        apiBlockedFresh = $null -ne $apiBlocked -and $apiBlocked.Timestamp -ge $freshCutoff
        deviceBlockedSparseZero = $null -ne $deviceBlocked -and
            $null -ne $deviceBlocked.PSObject.Properties["SparseZero"] -and [bool]$deviceBlocked.SparseZero
        apiBlockedSparseZero = $null -ne $apiBlocked -and
            $null -ne $apiBlocked.PSObject.Properties["SparseZero"] -and [bool]$apiBlocked.SparseZero
        latestBlockedTimestamp = [string](@($freshBlocked | Where-Object Value -gt 0 |
            Sort-Object Timestamp | Select-Object -Last 1 | ForEach-Object { $_.Timestamp.ToString("o") }) | Select-Object -First 1)
    }
}

function Get-MetricQueries {
    param($Config, $NatState)
    $r = $Config.Resources
    $queries = [System.Collections.Generic.List[object]]::new()
    $serviceIds = @(
        [pscustomobject]@{ Suffix = "api"; Name = [string]$r.apiService },
        [pscustomobject]@{ Suffix = "worker"; Name = [string]$r.workerService }
    )
    foreach ($service in $serviceIds) {
        $dimensions = @{ ClusterName = $r.cluster; ServiceName = $service.Name }
        # Gate on AWS/ECS's one-minute Average. Retain Maximum separately so a
        # peak remains reviewable evidence without redefining steady/p95 CPU.
        $queries.Add((New-MetricQuery "ecs_$($service.Suffix)_cpu" "AWS/ECS" "CPUUtilization" $dimensions "Average"))
        $queries.Add((New-MetricQuery "ecs_$($service.Suffix)_cpu_maximum" "AWS/ECS" "CPUUtilization" $dimensions "Maximum"))
        $queries.Add((New-MetricQuery "ecs_$($service.Suffix)_memory" "AWS/ECS" "MemoryUtilization" $dimensions "Maximum"))
    }
    $rdsDimensions = @{ DBInstanceIdentifier = $r.rdsInstanceId }
    $queries.Add((New-MetricQuery "rds_cpu" "AWS/RDS" "CPUUtilization" $rdsDimensions "Maximum"))
    $queries.Add((New-MetricQuery "rds_connections" "AWS/RDS" "DatabaseConnections" $rdsDimensions "Maximum"))
    $queries.Add((New-MetricQuery "rds_free_storage" "AWS/RDS" "FreeStorageSpace" $rdsDimensions "Minimum"))
    $queries.Add((New-MetricQuery "rds_free_memory" "AWS/RDS" "FreeableMemory" $rdsDimensions "Minimum"))
    $queries.Add((New-MetricQuery "rds_swap" "AWS/RDS" "SwapUsage" $rdsDimensions "Maximum"))
    $queries.Add((New-MetricQuery "rds_cpu_credit" "AWS/RDS" "CPUCreditBalance" $rdsDimensions "Minimum" -Period 300))
    $queries.Add((New-MetricQuery "rds_surplus_charged" "AWS/RDS" "CPUSurplusCreditsCharged" $rdsDimensions "Maximum" -Period 300))
    $queries.Add((New-MetricQuery "rds_read_latency_seconds" "AWS/RDS" "ReadLatency" $rdsDimensions "Maximum"))
    $queries.Add((New-MetricQuery "rds_write_latency_seconds" "AWS/RDS" "WriteLatency" $rdsDimensions "Maximum"))
    $queries.Add((New-MetricQuery "rds_disk_queue_depth" "AWS/RDS" "DiskQueueDepth" $rdsDimensions "Maximum"))
    $queries.Add((New-MetricQuery "rds_read_iops" "AWS/RDS" "ReadIOPS" $rdsDimensions "Maximum"))
    $queries.Add((New-MetricQuery "rds_write_iops" "AWS/RDS" "WriteIOPS" $rdsDimensions "Maximum"))
    $queries.Add((New-MetricMathQuery "rds_total_iops" "rds_read_iops+rds_write_iops" "Total read + write IOPS"))

    $redisDimensions = @{ CacheClusterId = $r.redisCacheClusterId }
    $queries.Add((New-MetricQuery "redis_cpu" "AWS/ElastiCache" "EngineCPUUtilization" $redisDimensions "Maximum"))
    $queries.Add((New-MetricQuery "redis_memory" "AWS/ElastiCache" "DatabaseMemoryUsagePercentage" $redisDimensions "Maximum"))
    $queries.Add((New-MetricQuery "redis_free" "AWS/ElastiCache" "FreeableMemory" $redisDimensions "Minimum"))
    $queries.Add((New-MetricQuery "redis_evictions" "AWS/ElastiCache" "Evictions" $redisDimensions "Sum"))
    $queries.Add((New-MetricQuery "redis_rejected" "AWS/ElastiCache" "RejectedConnections" $redisDimensions "Sum"))
    $queries.Add((New-MetricQuery "redis_cpu_credit" "AWS/ElastiCache" "CPUCreditBalance" $redisDimensions "Minimum" -Period 300))

    $wafBase = @{ WebACL = $r.wafWebAclName }
    foreach ($definition in @(
        @("waf_device_blocked", "BlockedRequests", $r.wafDeviceRuleMetricName),
        @("waf_api_blocked", "BlockedRequests", $r.wafApiRuleMetricName),
        @("waf_device_counted", "CountedRequests", $r.wafDeviceRuleMetricName),
        @("waf_api_counted", "CountedRequests", $r.wafApiRuleMetricName)
    )) {
        $queries.Add((New-MetricQuery $definition[0] "AWS/WAFV2" $definition[1] `
            @{ WebACL = $wafBase.WebACL; Rule = $definition[2] } "Sum"))
    }

    for ($index = 0; $index -lt @($NatState.gatewayIds).Count; $index++) {
        $dimensions = @{ NatGatewayId = $NatState.gatewayIds[$index] }
        $queries.Add((New-MetricQuery "nat_${index}_bytes_source" "AWS/NATGateway" "BytesInFromSource" $dimensions "Sum"))
        $queries.Add((New-MetricQuery "nat_${index}_bytes_destination" "AWS/NATGateway" "BytesInFromDestination" $dimensions "Sum"))
        $queries.Add((New-MetricQuery "nat_${index}_drops" "AWS/NATGateway" "PacketsDropCount" $dimensions "Sum"))
        $queries.Add((New-MetricQuery "nat_${index}_ports" "AWS/NATGateway" "ErrorPortAllocation" $dimensions "Sum"))
    }
    return @($queries)
}

function Add-NatMetrics {
    param($NatState, $Metrics)
    $bytes = 0.0
    $drops = 0.0
    $ports = 0.0
    $timestamps = [System.Collections.Generic.List[DateTimeOffset]]::new()
    for ($index = 0; $index -lt @($NatState.gatewayIds).Count; $index++) {
        foreach ($suffix in @("bytes_source", "bytes_destination")) {
            $metric = Get-BatchMetric $Metrics "nat_${index}_$suffix"
            if ($null -ne $metric) { $bytes += $metric.Value; $timestamps.Add($metric.Timestamp) }
        }
        $dropMetric = Get-BatchMetric $Metrics "nat_${index}_drops"
        $portMetric = Get-BatchMetric $Metrics "nat_${index}_ports"
        if ($null -ne $dropMetric) { $drops += $dropMetric.Value; $timestamps.Add($dropMetric.Timestamp) }
        if ($null -ne $portMetric) { $ports += $portMetric.Value; $timestamps.Add($portMetric.Timestamp) }
    }
    $latestTimestamp = @($timestamps | Sort-Object | Select-Object -Last 1)
    $NatState.bytesLastMinute = $bytes
    $NatState.packetDropsLastMinute = $drops
    $NatState.portAllocationErrorsLastMinute = $ports
    $NatState.metricTimestamp = if ($latestTimestamp.Count -eq 1) { $latestTimestamp[0].ToString("o") } else { $null }
    return $NatState
}

function Get-LoadProgress {
    param($Config)
    if (-not $Config.LoadProgressPath) { return $null }
    if (-not (Test-Path -LiteralPath $Config.LoadProgressPath)) {
        return [ordered]@{
            exists = $false
            staleSeconds = [math]::Floor(([DateTimeOffset]::UtcNow - $script:StartedAt).TotalSeconds)
            parseError = $false
            incompleteTail = $false
            summaryPending = $false
            event = $null
            summary = $null
        }
    }
    $item = Get-Item -LiteralPath $Config.LoadProgressPath
    $stale = [math]::Max(0, [math]::Floor(([DateTimeOffset]::UtcNow - [DateTimeOffset]$item.LastWriteTimeUtc).TotalSeconds))
    $stream = [IO.File]::Open($Config.LoadProgressPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true, 4096, $true)
        try { $content = $reader.ReadToEnd() }
        finally { $reader.Dispose() }
    }
    finally { $stream.Dispose() }
    $hasTerminatedTail = $content.EndsWith("`n")
    $lines = @($content -split "\r?\n")
    if (-not $hasTerminatedTail -and $lines.Count -gt 0) {
        $lines = if ($lines.Count -gt 1) { @($lines[0..($lines.Count - 2)]) } else { @() }
    }
    $completeLines = @($lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($completeLines.Count -eq 0) {
        return [ordered]@{ exists = $true; staleSeconds = $stale; parseError = $false; incompleteTail = -not $hasTerminatedTail; summaryPending = $false; event = $null; summary = $null }
    }
    if ($null -eq $script:TrafficStartedAtUtc) {
        foreach ($candidateLine in $completeLines) {
            try { $candidate = $candidateLine | ConvertFrom-Json -Depth 30 }
            catch { continue }
            if ([string](Get-OptionalValue $candidate "type" "") -ne "progress" -or
                [string](Get-OptionalValue $candidate "event" "") -ne "start" -or
                [string](Get-OptionalValue $candidate "runId" "") -ne $Config.RunId -or
                [string](Get-OptionalValue $candidate "stage" "") -ne $Config.Workload.Stage) {
                continue
            }
            try { $candidateStartedAt = ([DateTimeOffset](Get-OptionalValue $candidate "timestamp" "")).ToUniversalTime() }
            catch { continue }
            if ($candidateStartedAt -lt $Config.ArtifactsNotBeforeUtc -or
                $candidateStartedAt -gt [DateTimeOffset]::UtcNow.AddSeconds(5)) {
                continue
            }
            $script:TrafficStartedAtUtc = $candidateStartedAt
            break
        }
    }
    $line = [string]$completeLines[-1]
    try { $event = $line | ConvertFrom-Json -Depth 30 }
    catch {
        return [ordered]@{ exists = $true; staleSeconds = $stale; parseError = $true; incompleteTail = -not $hasTerminatedTail; summaryPending = $false; event = $null; summary = $null }
    }
    $summary = $null
    $summaryPending = $false
    if ([string]$event.event -eq "final") {
        if (-not (Test-Path -LiteralPath $Config.LoadSummaryPath -PathType Leaf)) {
            $summaryPending = $stale -le [double]$Config.Thresholds.summaryCommitGraceSeconds
            return [ordered]@{ exists = $true; staleSeconds = $stale; parseError = -not $summaryPending; incompleteTail = -not $hasTerminatedTail; summaryPending = $summaryPending; event = $event; summary = $null }
        }
        try { $summary = Get-Content -LiteralPath $Config.LoadSummaryPath -Raw | ConvertFrom-Json -Depth 40 }
        catch {
            $summaryItem = Get-Item -LiteralPath $Config.LoadSummaryPath
            $summaryAge = [math]::Max(0, ([DateTimeOffset]::UtcNow - [DateTimeOffset]$summaryItem.LastWriteTimeUtc).TotalSeconds)
            $summaryPending = $summaryAge -le [double]$Config.Thresholds.summaryCommitGraceSeconds
            return [ordered]@{ exists = $true; staleSeconds = $stale; parseError = -not $summaryPending; incompleteTail = -not $hasTerminatedTail; summaryPending = $summaryPending; event = $event; summary = $null }
        }
    }
    return [ordered]@{
        exists = $true
        staleSeconds = $stale
        parseError = $false
        incompleteTail = -not $hasTerminatedTail
        summaryPending = $false
        event = $event
        summary = $summary
        trafficStartedAtUtc = if ($null -eq $script:TrafficStartedAtUtc) { $null } else { $script:TrafficStartedAtUtc.ToString("o") }
    }
}

function Get-LoadFatalGate {
    param($Progress)
    if ($null -eq $Progress -or $null -eq $Progress.event) { return $null }
    if ([string](Get-OptionalValue $Progress.event "type" "") -eq "fatal_gate") {
        return Get-OptionalValue $Progress.event "fatalGate"
    }
    if ([string](Get-OptionalValue $Progress.event "event" "") -eq "final") {
        $summaryFatal = if ($null -eq $Progress.summary) { $null } else { Get-OptionalValue $Progress.summary "fatalGate" }
        if ($null -ne $summaryFatal) { return $summaryFatal }
        return Get-OptionalValue $Progress.event "fatalGate"
    }
    return $null
}

function Add-LoadFatalGateFindings {
    param([System.Collections.Generic.List[string]]$Findings, $FatalGate)
    if ($null -eq $FatalGate) { return }
    $codes = @((Get-OptionalValue $FatalGate "reasonCodes" @()) | ForEach-Object { [string]$_ })
    if ($codes.Count -eq 0) {
        if (-not $Findings.Contains("load_fatal_gate")) { $Findings.Add("load_fatal_gate") }
        return
    }
    foreach ($code in $codes) {
        $finding = "load:$code"
        if (-not $Findings.Contains($finding)) { $Findings.Add($finding) }
    }
}

function Get-ValidatedLoadSummaryTiming {
    param($Config, $Progress)
    if ($null -eq $Progress -or $null -eq $Progress.event -or $null -eq $Progress.summary -or
        [string](Get-OptionalValue $Progress.event "event" "") -ne "final" -or
        $null -eq $script:TrafficStartedAtUtc) {
        return $null
    }
    $summary = $Progress.summary
    $summaryRun = Get-OptionalValue $summary "run"
    $fixture = Get-OptionalValue $summary "screenshotFixture"
    $tileBatch = Get-OptionalValue $summary "tileBatch"
    $screenshotRetrieval = Get-OptionalValue $summary "screenshotRetrieval"
    $actualTrafficSeconds = [double](Get-OptionalValue $summaryRun "actualTrafficSeconds" -1)
    if ([double]::IsNaN($actualTrafficSeconds) -or [double]::IsInfinity($actualTrafficSeconds)) { return $null }
    try { $finalProgressAtUtc = ([DateTimeOffset](Get-OptionalValue $Progress.event "timestamp" "")).ToUniversalTime() }
    catch { return $null }
    $trafficStoppedAtUtc = $script:TrafficStartedAtUtc.AddSeconds($actualTrafficSeconds)
    $requiresTileBatchContract = (
        [string]$Config.Workload.WorkloadSchemaVersion -ceq $script:RequiredWorkloadSchemaVersion -or
        [string]$Config.Workload.EndpointShapeSha256 -ceq $script:RequiredWorkloadEndpointShapeSha256
    )
    $validatedTileBatch = $null
    $tileBatchValid = -not $requiresTileBatchContract
    if ($requiresTileBatchContract) {
        $expectedStudentsPerCohort = if ([string]$Config.Workload.Stage -eq "500") { 25 } else { 40 }
        $teacherCohorts = [int](Get-OptionalValue $tileBatch "teacherCohorts" -1)
        $studentsPerCohort = [int](Get-OptionalValue $tileBatch "studentsPerCohort" -1)
        $teacherTileAssignments = [int](Get-OptionalValue $tileBatch "teacherTileAssignments" -1)
        $requestsPerCohortPerPoll = [int](Get-OptionalValue $tileBatch "requestsPerCohortPerPoll" -1)
        $logicalOperationsPerPoll = [int](Get-OptionalValue $tileBatch "logicalOperationsPerPoll" -1)
        $historyRequests = [int64](Get-OptionalValue $tileBatch "historyRequests" -1)
        $screenshotRequests = [int64](Get-OptionalValue $tileBatch "screenshotRequests" -1)
        $historyLogicalOperations = [int64](Get-OptionalValue $tileBatch "historyLogicalOperations" -1)
        $screenshotLogicalOperations = [int64](Get-OptionalValue $tileBatch "screenshotLogicalOperations" -1)
        $networkRequests = [int64](Get-OptionalValue $tileBatch "networkRequests" -1)
        $logicalOperations = [int64](Get-OptionalValue $tileBatch "logicalOperations" -1)
        $screenshotAttempts = [int64](Get-OptionalValue $screenshotRetrieval "attempts" -1)
        $screenshotSuccesses = [int64](Get-OptionalValue $screenshotRetrieval "successes" -1)
        $tileBatchValid = (
            [string](Get-OptionalValue $summary "workloadSchemaVersion" "") -ceq $script:RequiredWorkloadSchemaVersion -and
            [string](Get-OptionalValue $summary "workloadEndpointShapeSha256" "").ToLowerInvariant() -ceq $script:RequiredWorkloadEndpointShapeSha256 -and
            (Get-OptionalValue $tileBatch "configured" $false) -eq $true -and
            $teacherCohorts -eq 20 -and
            $studentsPerCohort -eq $expectedStudentsPerCohort -and
            $teacherTileAssignments -eq (20 * $expectedStudentsPerCohort) -and
            $requestsPerCohortPerPoll -eq 2 -and
            $logicalOperationsPerPoll -eq (2 * $teacherTileAssignments) -and
            $historyRequests -gt 0 -and
            $historyRequests -eq $screenshotRequests -and
            ($historyRequests % $teacherCohorts) -eq 0 -and
            $historyLogicalOperations -eq ($historyRequests * $studentsPerCohort) -and
            $screenshotLogicalOperations -eq ($screenshotRequests * $studentsPerCohort) -and
            $networkRequests -eq ($historyRequests + $screenshotRequests) -and
            $logicalOperations -eq ($historyLogicalOperations + $screenshotLogicalOperations) -and
            $screenshotAttempts -eq $screenshotLogicalOperations -and
            $screenshotSuccesses -ge 0 -and
            $screenshotSuccesses -le $screenshotAttempts
        )
        if ($tileBatchValid) {
            $validatedTileBatch = [ordered]@{
                teacherCohorts = $teacherCohorts
                studentsPerCohort = $studentsPerCohort
                teacherTileAssignments = $teacherTileAssignments
                requestsPerCohortPerPoll = $requestsPerCohortPerPoll
                logicalOperationsPerPoll = $logicalOperationsPerPoll
                pollsPerCohort = [int64]($historyRequests / $teacherCohorts)
                historyRequests = $historyRequests
                screenshotRequests = $screenshotRequests
                historyLogicalOperations = $historyLogicalOperations
                screenshotLogicalOperations = $screenshotLogicalOperations
                networkRequests = $networkRequests
                logicalOperations = $logicalOperations
                screenshotAttempts = $screenshotAttempts
                screenshotSuccesses = $screenshotSuccesses
            }
        }
    }
    $diagnosticContractValid = -not [bool](Get-OptionalValue $Config "DiagnosticOnly" $false) -or (
        (Get-OptionalValue $summary "diagnosticOnly" $false) -eq $true -and
        (Get-OptionalValue $summary "certificationEligible" $true) -eq $false
    )
    $valid = (
        [string](Get-OptionalValue $summary "runId" "") -eq $Config.RunId -and
        [string](Get-OptionalValue $summary "stage" "") -eq $Config.Workload.Stage -and
        [int](Get-OptionalValue $summary "devices" -1) -eq $Config.Workload.Devices -and
        [int](Get-OptionalValue $summary "declaredSecondSchoolCanaryDevices" -1) -eq $Config.Workload.CanaryDevices -and
        [int](Get-OptionalValue $fixture "decodedBytes" -1) -eq $Config.Workload.ScreenshotBytes -and
        [double](Get-OptionalValue $summaryRun "plannedTrafficSeconds" -1) -eq $Config.Workload.DurationSeconds -and
        $actualTrafficSeconds -ge $Config.Workload.DurationSeconds -and
        (Get-OptionalValue $summaryRun "completedConfiguredDuration" $false) -eq $true -and
        $diagnosticContractValid -and
        $tileBatchValid -and
        $finalProgressAtUtc -ge $script:TrafficStartedAtUtc -and
        $finalProgressAtUtc -le [DateTimeOffset]::UtcNow.AddSeconds(5) -and
        $trafficStoppedAtUtc -le $finalProgressAtUtc.AddSeconds(5)
    )
    if (-not $valid) { return $null }
    return [pscustomobject]@{
        ActualTrafficSeconds = $actualTrafficSeconds
        TrafficStoppedAtUtc = $trafficStoppedAtUtc
        FinalProgressAtUtc = $finalProgressAtUtc
        TileBatch = $validatedTileBatch
    }
}

function Get-SupervisedHeartbeatState {
    param($Config)
    $states = @()
    foreach ($path in @($Config.SupervisedHeartbeatPaths)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            $states += [ordered]@{ name = [IO.Path]::GetFileName($path); exists = $false; staleSeconds = $null }
            continue
        }
        $item = Get-Item -LiteralPath $path
        $stale = [math]::Max(0, [math]::Floor(([DateTimeOffset]::UtcNow - [DateTimeOffset]$item.LastWriteTimeUtc).TotalSeconds))
        $states += [ordered]@{ name = $item.Name; exists = $true; staleSeconds = $stale }
    }
    return $states
}

function Get-GeneratorIpState {
    param($Config)
    if (-not $Config.ExpectedGeneratorPublicIp) { return $null }
    if (-not (Test-Path -LiteralPath $Config.GeneratorIpEvidencePath -PathType Leaf)) {
        return [ordered]@{ exists=$false; matched=$false; staleSeconds=$null; actualPublicIp=$null; parseError=$false }
    }
    $item = Get-Item -LiteralPath $Config.GeneratorIpEvidencePath
    $stale = [math]::Max(0, ([DateTimeOffset]::UtcNow - [DateTimeOffset]$item.LastWriteTimeUtc).TotalSeconds)
    try { $record = Read-AtomicJson -Path $Config.GeneratorIpEvidencePath -Depth 10 }
    catch { return [ordered]@{ exists=$true; matched=$false; staleSeconds=$stale; actualPublicIp=$null; parseError=$true } }
    $matched = [string]$record.runId -eq $Config.RunId -and
        [string]$record.expectedPublicIp -eq $Config.ExpectedGeneratorPublicIp -and
        [string]$record.actualPublicIp -eq $Config.ExpectedGeneratorPublicIp
    return [ordered]@{ exists=$true; matched=$matched; staleSeconds=$stale; actualPublicIp=[string]$record.actualPublicIp; parseError=$false }
}

function Update-ConsecutiveBreach {
    param([string]$Name, [bool]$Breached, [int]$Required)
    if ($Breached) { $script:ConsecutiveBreaches[$Name] = 1 + [int]($script:ConsecutiveBreaches[$Name] ?? 0) }
    else { $script:ConsecutiveBreaches[$Name] = 0 }
    return [int]$script:ConsecutiveBreaches[$Name] -ge $Required
}

function Update-DatapointBreach {
    param([string]$Name, [bool]$Breached, [string]$Timestamp, [int]$Required)
    if ([string]::IsNullOrWhiteSpace($Timestamp)) { return $false }
    if ($script:LastMetricTimestamps[$Name] -eq $Timestamp) { return $false }
    $script:LastMetricTimestamps[$Name] = $Timestamp
    return Update-ConsecutiveBreach -Name $Name -Breached $Breached -Required $Required
}

function Add-MetricFinding {
    param(
        [System.Collections.Generic.List[string]]$Immediate,
        [System.Collections.Generic.List[string]]$Consecutive,
        [string]$Name,
        $Value,
        [scriptblock]$IsBreached,
        [int]$Required,
        [switch]$ImmediateOnBreach,
        [double]$FreshnessMaximumSeconds = $script:MetricFreshnessMaximumSeconds
    )
    if ($null -eq $Value) {
        $script:MissingMetrics[$Name] = 1 + [int]($script:MissingMetrics[$Name] ?? 0)
        if ([int]$script:MissingMetrics[$Name] -ge $Required) { $Consecutive.Add("missing_metric:$Name") }
        return
    }
    $script:MissingMetrics[$Name] = 0
    $metricTimestamp = ([DateTimeOffset]$Value.Timestamp).ToUniversalTime().ToString("o")
    $metricAgeSeconds = ([DateTimeOffset]::UtcNow - ([DateTimeOffset]$Value.Timestamp).ToUniversalTime()).TotalSeconds
    if ($metricAgeSeconds -gt $FreshnessMaximumSeconds) {
        if (Update-ConsecutiveBreach -Name "stale_metric:$Name" -Breached $true -Required $Required) {
            $Consecutive.Add("stale_metric:$Name")
        }
        return
    }
    [void](Update-ConsecutiveBreach -Name "stale_metric:$Name" -Breached $false -Required $Required)
    if ($script:LastMetricTimestamps[$Name] -eq $metricTimestamp) { return }
    $script:LastMetricTimestamps[$Name] = $metricTimestamp
    $breached = [bool](& $IsBreached ([double]$Value.Value))
    if ($ImmediateOnBreach -and $breached) { $Immediate.Add($Name); return }
    if (Update-ConsecutiveBreach -Name $Name -Breached $breached -Required $Required) { $Consecutive.Add($Name) }
}

function Add-MetricSeriesFindings {
    param(
        [System.Collections.Generic.List[string]]$Immediate,
        [System.Collections.Generic.List[string]]$Consecutive,
        [string]$Name,
        $MetricBatch,
        [scriptblock]$IsBreached,
        [int]$Required,
        [DateTimeOffset]$NotBeforeUtc,
        [double]$FreshnessMaximumSeconds
    )
    $latest = Get-BatchMetric $MetricBatch $Name
    if ($null -eq $latest) {
        Add-MetricFinding $Immediate $Consecutive $Name $null $IsBreached $Required `
            -FreshnessMaximumSeconds $FreshnessMaximumSeconds
        return
    }

    $collectedThroughUtc = $MetricBatch.CollectedThroughUtc.ToUniversalTime()
    $now = [DateTimeOffset]::UtcNow
    $lastTimestamp = $null
    if ($script:LastMetricTimestamps.ContainsKey($Name) -and $script:LastMetricTimestamps[$Name]) {
        $lastTimestamp = ([DateTimeOffset]$script:LastMetricTimestamps[$Name]).ToUniversalTime()
    }
    $freshUnseen = @(
        (Get-BatchSeries $MetricBatch $Name) |
            Where-Object {
                $timestamp = ([DateTimeOffset]$_.Timestamp).ToUniversalTime()
                $timestamp -le $collectedThroughUtc -and
                $timestamp -ge $NotBeforeUtc.ToUniversalTime() -and
                ($null -eq $lastTimestamp -or $timestamp -gt $lastTimestamp) -and
                ($now - $timestamp).TotalSeconds -le $FreshnessMaximumSeconds
            } |
            Sort-Object Timestamp
    )
    if ($freshUnseen.Count -eq 0) {
        $latestTimestamp = ([DateTimeOffset]$latest.Timestamp).ToUniversalTime()
        if ($latestTimestamp -lt $NotBeforeUtc.ToUniversalTime()) {
            [void](Update-ConsecutiveBreach -Name $Name -Breached $false -Required $Required)
            Add-MetricFinding $Immediate $Consecutive $Name $latest { param($v) $false } $Required `
                -FreshnessMaximumSeconds $FreshnessMaximumSeconds
        }
        else {
            Add-MetricFinding $Immediate $Consecutive $Name $latest $IsBreached $Required `
                -FreshnessMaximumSeconds $FreshnessMaximumSeconds
        }
        return
    }

    $previousTimestamp = $lastTimestamp
    foreach ($point in $freshUnseen) {
        $pointTimestamp = ([DateTimeOffset]$point.Timestamp).ToUniversalTime()
        if ($null -ne $previousTimestamp -and ($pointTimestamp - $previousTimestamp).TotalSeconds -gt 90) {
            [void](Update-ConsecutiveBreach -Name $Name -Breached $false -Required $Required)
        }
        Add-MetricFinding $Immediate $Consecutive $Name $point $IsBreached $Required `
            -FreshnessMaximumSeconds $FreshnessMaximumSeconds
        $previousTimestamp = $pointTimestamp
        if ($Immediate.Contains($Name) -or $Consecutive.Contains($Name)) { break }
    }
}

function Add-GrowthMetricFinding {
    param(
        [System.Collections.Generic.List[string]]$Consecutive,
        [string]$Name,
        $Metric,
        [double]$MaximumGrowthPerMinute,
        [int]$Required
    )
    if ($null -eq $Metric) { return }
    $timestamp = ([DateTimeOffset]$Metric.Timestamp).ToUniversalTime()
    $previous = $script:PreviousMetricDatapoints[$Name]
    $breached = $false
    if ($null -ne $previous -and $timestamp -le $previous.Timestamp) { return }
    if ($null -ne $previous -and $timestamp -gt $previous.Timestamp) {
        $minutes = [math]::Max(1.0 / 60.0, ($timestamp - $previous.Timestamp).TotalMinutes)
        $breached = ([double]$Metric.Value - [double]$previous.Value) -gt ($MaximumGrowthPerMinute * $minutes)
    }
    $script:PreviousMetricDatapoints[$Name] = [pscustomobject]@{ Timestamp = $timestamp; Value = [double]$Metric.Value }
    if (Update-ConsecutiveBreach -Name $Name -Breached $breached -Required $Required) { $Consecutive.Add($Name) }
}

function Add-AcceptanceDatapoint {
    param([string]$Name, $Metric)
    if ($null -eq $Metric) { return }
    if (-not $script:AcceptanceSeries.ContainsKey($Name)) {
        $script:AcceptanceSeries[$Name] = [ordered]@{
            timestamps = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            values = [System.Collections.Generic.List[double]]::new()
            points = @{}
        }
    }
    $series = $script:AcceptanceSeries[$Name]
    $timestamp = ([DateTimeOffset]$Metric.Timestamp).ToUniversalTime().ToString("o")
    if ($series.timestamps.Add($timestamp)) {
        $series.values.Add([double]$Metric.Value)
        $series.points[$timestamp] = [double]$Metric.Value
    }
}

function Get-RdsCreditSlopeResult {
    param($Config)
    $result = [ordered]@{
        required = $false
        pointCount = 0
        spanSeconds = 0.0
        firstBalance = $null
        lastBalance = $null
        delta = $null
        slopePerHour = $null
        passed = $false
    }
    if ($Config.ExpectedRdsInstanceClass -ne "db.t4g.xlarge" -or
        $null -eq $Config.Workload -or $Config.Workload.Stage -ne "endurance" -or
        $Config.TelemetryExpectedSeconds -lt 28800) {
        $result.passed = $true
        return $result
    }
    $result.required = $true
    $trafficStart = if ($null -ne $script:TrafficStartedAtUtc) {
        ([DateTimeOffset]$script:TrafficStartedAtUtc).ToUniversalTime()
    } else { $script:StartedAt.ToUniversalTime() }
    $windowStart = $trafficStart.AddHours(2)
    $windowEnd = $trafficStart.AddHours(8)
    if (-not $script:AcceptanceSeries.ContainsKey("rds_cpu_credit")) { return $result }
    $series = $script:AcceptanceSeries["rds_cpu_credit"]
    $points = @($series.points.GetEnumerator() | ForEach-Object {
        [pscustomobject]@{ Timestamp = ([DateTimeOffset]$_.Key).ToUniversalTime(); Value = [double]$_.Value }
    } | Where-Object { $_.Timestamp -ge $windowStart -and $_.Timestamp -le $windowEnd } | Sort-Object Timestamp)
    $result.pointCount = $points.Count
    if ($points.Count -lt 2) { return $result }
    $result.spanSeconds = [math]::Round(($points[-1].Timestamp - $points[0].Timestamp).TotalSeconds, 1)
    $result.firstBalance = [double]$points[0].Value
    $result.lastBalance = [double]$points[-1].Value
    $result.delta = [double]$points[-1].Value - [double]$points[0].Value
    $xValues = @($points | ForEach-Object { ($_.Timestamp - $points[0].Timestamp).TotalHours })
    $meanX = [double](($xValues | Measure-Object -Average).Average)
    $meanY = [double](($points.Value | Measure-Object -Average).Average)
    $numerator = 0.0; $denominator = 0.0
    for ($index = 0; $index -lt $points.Count; $index++) {
        $xDelta = [double]$xValues[$index] - $meanX
        $numerator += $xDelta * ([double]$points[$index].Value - $meanY)
        $denominator += $xDelta * $xDelta
    }
    $result.slopePerHour = if ($denominator -gt 0) { $numerator / $denominator } else { $null }
    # CloudWatch's five-minute series may place the first and last samples just
    # inside the exact hour-2/hour-8 boundaries. Require at least 5h50m so the
    # gate represents the full six-hour observation, allowing no more than one
    # five-minute boundary alignment interval at each edge.
    $result.passed = $result.spanSeconds -ge 21000.0 -and $null -ne $result.slopePerHour -and $result.slopePerHour -ge 0.0
    return $result
}

function Get-TelemetryAcceptanceWindow {
    param($Config, [DateTimeOffset]$CollectedThroughUtc)
    $logicalStart = if ($Config.LoadProgressPath) { $script:TrafficStartedAtUtc } else { $script:StartedAt }
    if ($null -eq $logicalStart) { return $null }
    $logicalStart = ([DateTimeOffset]$logicalStart).ToUniversalTime()
    $logicalEnd = if ($Config.LoadProgressPath -and $null -ne $script:TrafficStoppedAtUtc) {
        $script:TrafficStoppedAtUtc
    } elseif ($Config.TelemetryExpectedSeconds -gt 0) {
        $logicalStart.AddSeconds([double]$Config.TelemetryExpectedSeconds)
    } else {
        $CollectedThroughUtc.ToUniversalTime()
    }
    $minuteTicks = [TimeSpan]::TicksPerMinute
    $startTicks = $logicalStart.Ticks - ($logicalStart.Ticks % $minuteTicks)
    $endFloorTicks = $logicalEnd.Ticks - ($logicalEnd.Ticks % $minuteTicks)
    $endExclusiveTicks = if ($logicalEnd.Ticks -eq $endFloorTicks) { $endFloorTicks } else { $endFloorTicks + $minuteTicks }
    if ($endExclusiveTicks -le $startTicks) { $endExclusiveTicks = $startTicks + $minuteTicks }
    return [pscustomobject]@{
        StartInclusive = [DateTimeOffset]::new($startTicks, [TimeSpan]::Zero)
        EndExclusive = [DateTimeOffset]::new($endExclusiveTicks, [TimeSpan]::Zero)
    }
}

function Add-AcceptanceSeriesDatapoints {
    param([string]$Name, $MetricBatch, $Config)
    $window = Get-TelemetryAcceptanceWindow -Config $Config -CollectedThroughUtc $MetricBatch.CollectedThroughUtc
    if ($null -eq $window) { return }
    foreach ($point in @((Get-BatchSeries $MetricBatch $Name) | Sort-Object Timestamp)) {
        $timestamp = ([DateTimeOffset]$point.Timestamp).ToUniversalTime()
        if ($timestamp -lt $window.StartInclusive -or $timestamp -ge $window.EndExclusive -or
            $timestamp -gt $MetricBatch.CollectedThroughUtc) {
            continue
        }
        Add-AcceptanceDatapoint -Name $Name -Metric $point
    }
}

function Get-SeriesSummary {
    param([string]$Name)
    if (-not $script:AcceptanceSeries.ContainsKey($Name)) {
        return [ordered]@{ count = 0; minimum = $null; maximum = $null; average = $null; p95 = $null; sum = $null; spanSeconds = 0; maximumGapSeconds = $null }
    }
    $values = @($script:AcceptanceSeries[$Name].values | Sort-Object)
    if ($values.Count -eq 0) {
        return [ordered]@{ count = 0; minimum = $null; maximum = $null; average = $null; p95 = $null; sum = $null; spanSeconds = 0; maximumGapSeconds = $null }
    }
    $p95Index = [math]::Min($values.Count - 1, [math]::Max(0, [math]::Ceiling($values.Count * 0.95) - 1))
    $measure = $values | Measure-Object -Minimum -Maximum -Average -Sum
    $timestamps = @($script:AcceptanceSeries[$Name].timestamps | ForEach-Object { [DateTimeOffset]$_ } | Sort-Object)
    $maximumGap = $null
    if ($timestamps.Count -ge 2) {
        $maximumGap = 0.0
        for ($index = 1; $index -lt $timestamps.Count; $index++) {
            $maximumGap = [math]::Max($maximumGap, ($timestamps[$index] - $timestamps[$index - 1]).TotalSeconds)
        }
    }
    return [ordered]@{
        count = $values.Count
        minimum = [double]$measure.Minimum
        maximum = [double]$measure.Maximum
        average = [double]$measure.Average
        p95 = [double]$values[$p95Index]
        sum = [double]$measure.Sum
        spanSeconds = if ($timestamps.Count -ge 2) { [math]::Round(($timestamps[-1] - $timestamps[0]).TotalSeconds, 1) } else { 0.0 }
        maximumGapSeconds = $maximumGap
    }
}

function Get-DiagnosticRdsCpuCoverageResult {
    param($Config)
    $requiredPoints = 30
    if (-not $Config.DiagnosticOnly) {
        return [ordered]@{required=$false;requiredPointCount=$requiredPoints;observedPointCount=0;
            coveragePercent=$null;maximumGapSeconds=$null;spanSeconds=$null;maximumPercent=$null;
            fullCoverage=$true;allPointsBelowMaximum=$true;passed=$true}
    }
    $summary = Get-SeriesSummary "rds_cpu"
    $coveragePercent = [math]::Round([math]::Min(100.0, 100.0 * [double]$summary.count / $requiredPoints), 3)
    $fullCoverage = $summary.count -ge $requiredPoints -and $summary.spanSeconds -ge 1740.0 -and
        $null -ne $summary.maximumGapSeconds -and $summary.maximumGapSeconds -le 60.0
    $allBelow = $summary.count -ge $requiredPoints -and $null -ne $summary.maximum -and
        [double]$summary.maximum -lt [double]$Config.Thresholds.rdsCpuMaximumPercent
    return [ordered]@{required=$true;requiredPointCount=$requiredPoints;observedPointCount=[int]$summary.count;
        coveragePercent=$coveragePercent;maximumGapSeconds=$summary.maximumGapSeconds;spanSeconds=$summary.spanSeconds;
        maximumPercent=$summary.maximum;maximumAllowedExclusivePercent=[double]$Config.Thresholds.rdsCpuMaximumPercent;
        fullCoverage=$fullCoverage;allPointsBelowMaximum=$allBelow;passed=($fullCoverage -and $allBelow)}
}

function Assert-TelemetryCoverage {
    param($Config, [string[]]$MetricNames)
    if ($Config.TelemetryExpectedSeconds -le 0) { return }
    $fiveMinuteMetrics = @("rds_cpu_credit", "rds_surplus_charged", "redis_cpu_credit")
    foreach ($name in $MetricNames) {
        $periodSeconds = if ($name -in $fiveMinuteMetrics) { 300.0 } else { 60.0 }
        $diagnosticRdsCpu = $Config.DiagnosticOnly -and $name -eq "rds_cpu"
        $maximumGapSeconds = if ($diagnosticRdsCpu) { 60.0 } elseif ($periodSeconds -eq 300.0) { 360.0 } else { [double]$Config.Thresholds.telemetryMaximumGapSeconds }
        $expectedPoints = [math]::Floor([double]$Config.TelemetryExpectedSeconds / $periodSeconds)
        if ($expectedPoints -lt 1) { continue }
        $minimumPoints = if ($diagnosticRdsCpu) { $expectedPoints } else { [math]::Ceiling($expectedPoints * ([double]$Config.Thresholds.telemetryMinimumCoveragePercent / 100.0)) }
        $minimumSpan = if ($diagnosticRdsCpu) { [math]::Max(0.0, ($expectedPoints - 1) * $periodSeconds) } else { [math]::Max(0.0, [double]$Config.TelemetryExpectedSeconds - $maximumGapSeconds) }
        $summary = Get-SeriesSummary $name
        if ($summary.count -lt $minimumPoints) { Add-AcceptanceViolation "telemetry_coverage:$name" }
        if ($summary.spanSeconds -lt $minimumSpan) { Add-AcceptanceViolation "telemetry_span:$name" }
        if (($expectedPoints -gt 1 -and $null -eq $summary.maximumGapSeconds) -or
            ($null -ne $summary.maximumGapSeconds -and $summary.maximumGapSeconds -gt $maximumGapSeconds)) {
            Add-AcceptanceViolation "telemetry_cadence:$name"
        }
    }
}

function Add-AcceptanceViolation {
    param([string]$Reason)
    [void]$script:AcceptanceViolations.Add($Reason)
}

function Get-AcceptanceResult {
    param($Config)
    $t = $Config.Thresholds
    $summaries = [ordered]@{}
    foreach ($name in $script:AcceptanceSeries.Keys | Sort-Object) {
        $summaries[$name] = Get-SeriesSummary $name
    }
    Assert-TelemetryCoverage -Config $Config -MetricNames $Config.TelemetryMetricNames
    foreach ($service in @("api", "worker")) {
        $cpu = Get-SeriesSummary "ecs_${service}_cpu"
        $memory = Get-SeriesSummary "ecs_${service}_memory"
        if ($cpu.count -lt 1 -or $memory.count -lt 1) { Add-AcceptanceViolation "missing_acceptance_metric:ecs_$service"; continue }
        if ($cpu.average -ge [double]$t.ecsCpuSteadyMaximumPercent) { Add-AcceptanceViolation "ecs_${service}_cpu_steady" }
        if ($cpu.p95 -ge [double]$t.ecsCpuMaximumPercent) { Add-AcceptanceViolation "ecs_${service}_cpu_p95" }
        if ($memory.maximum -ge [double]$t.ecsMemoryMaximumPercent) { Add-AcceptanceViolation "ecs_${service}_memory_peak" }
    }
    $rdsCpu = Get-SeriesSummary "rds_cpu"
    $rdsConnections = Get-SeriesSummary "rds_connections"
    $rdsHeadroom = Get-SeriesSummary "rds_storage_headroom"
    if ($rdsCpu.count -lt 1 -or $rdsConnections.count -lt 1 -or $rdsHeadroom.count -lt 1) {
        Add-AcceptanceViolation "missing_acceptance_metric:rds"
    }
    if ($rdsCpu.maximum -ge [double]$t.rdsCpuMaximumPercent) { Add-AcceptanceViolation "rds_cpu_peak" }
    $diagnosticRdsCpuCoverage = Get-DiagnosticRdsCpuCoverageResult -Config $Config
    if ($diagnosticRdsCpuCoverage.required -and -not $diagnosticRdsCpuCoverage.fullCoverage) {
        Add-AcceptanceViolation "diagnostic_rds_cpu_30_of_30_coverage"
    }
    if ($diagnosticRdsCpuCoverage.required -and -not $diagnosticRdsCpuCoverage.allPointsBelowMaximum) {
        Add-AcceptanceViolation "diagnostic_rds_cpu_every_minute_below_65"
    }
    if ($rdsConnections.maximum -ge [double]$t.rdsConnectionsMaximum) { Add-AcceptanceViolation "rds_connections_peak" }
    if ($rdsHeadroom.minimum -le [double]$t.rdsStorageHeadroomMinimumPercent) { Add-AcceptanceViolation "rds_storage_headroom_minimum" }
    $rdsFreeMemory = Get-SeriesSummary "rds_free_memory"
    $rdsCpuCredit = Get-SeriesSummary "rds_cpu_credit"
    $rdsSurplus = Get-SeriesSummary "rds_surplus_charged"
    if ($rdsFreeMemory.count -gt 0 -and $rdsFreeMemory.minimum -le [double]$t.rdsFreeableMemoryMinimumBytes) { Add-AcceptanceViolation "rds_freeable_memory_minimum" }
    if ($rdsCpuCredit.count -gt 0 -and $rdsCpuCredit.minimum -le [double]$t.rdsCpuCreditMinimum) { Add-AcceptanceViolation "rds_cpu_credit_minimum" }
    if ($rdsSurplus.count -gt 0 -and $rdsSurplus.maximum -gt 0) { Add-AcceptanceViolation "rds_surplus_credits_charged" }
    if ($Config.ExpectedRdsInstanceClass -eq "db.t4g.xlarge") {
        foreach ($latencyName in @("rds_read_latency_ms", "rds_write_latency_ms")) {
            $latency = Get-SeriesSummary $latencyName
            if ($latency.count -lt 1) { Add-AcceptanceViolation "missing_acceptance_metric:$latencyName"; continue }
            if ($latency.p95 -ge [double]$t.rdsLatencyP95MaximumMilliseconds) {
                Add-AcceptanceViolation "${latencyName}_p95"
            }
            if ($latency.maximum -ge [double]$t.rdsLatencyPeakMaximumMilliseconds) {
                Add-AcceptanceViolation "${latencyName}_peak"
            }
        }
        $rdsQueue = Get-SeriesSummary "rds_disk_queue_depth"
        if ($rdsQueue.count -lt 1) { Add-AcceptanceViolation "missing_acceptance_metric:rds_disk_queue_depth" }
        elseif ($rdsQueue.p95 -ge [double]$t.rdsQueueDepthP95Maximum) { Add-AcceptanceViolation "rds_disk_queue_depth_p95" }
        $totalIops = Get-SeriesSummary "rds_total_iops"
        if ($totalIops.count -lt 1) { Add-AcceptanceViolation "missing_acceptance_metric:rds_total_iops" }
        else {
            if ($totalIops.p95 -ge [double]$t.rdsIopsP95Maximum) { Add-AcceptanceViolation "rds_total_iops_p95" }
            if ($totalIops.maximum -ge [double]$t.rdsIopsPeakMaximum) { Add-AcceptanceViolation "rds_total_iops_peak" }
        }
    }
    $rdsCreditSlope = Get-RdsCreditSlopeResult -Config $Config
    if ($rdsCreditSlope.required -and -not $rdsCreditSlope.passed) {
        Add-AcceptanceViolation "rds_cpu_credit_hours_2_8_slope"
    }
    if ($script:AcceptanceSeries.ContainsKey("rds_swap") -and $script:AcceptanceSeries["rds_swap"].values.Count -ge 3) {
        $swapValues = $script:AcceptanceSeries["rds_swap"].values
        if ($swapValues[$swapValues.Count - 1] -gt $swapValues[0] + 67108864.0) { Add-AcceptanceViolation "rds_swap_growing" }
    }

    $redisCpu = Get-SeriesSummary "redis_cpu"
    $redisMemory = Get-SeriesSummary "redis_memory"
    $redisFree = Get-SeriesSummary "redis_free"
    $redisEvictions = Get-SeriesSummary "redis_evictions"
    $redisRejected = Get-SeriesSummary "redis_rejected"
    if ($redisCpu.count -lt 1 -or $redisMemory.count -lt 1 -or $redisFree.count -lt 1 -or
        $redisEvictions.count -lt 1 -or $redisRejected.count -lt 1) {
        Add-AcceptanceViolation "missing_acceptance_metric:redis"
    }
    if ($redisCpu.average -ge [double]$t.redisSteadyMaximumPercent) { Add-AcceptanceViolation "redis_cpu_steady" }
    if ($redisCpu.maximum -ge [double]$t.redisCpuMaximumPercent) { Add-AcceptanceViolation "redis_cpu_peak" }
    if ($redisMemory.average -ge [double]$t.redisSteadyMaximumPercent) { Add-AcceptanceViolation "redis_memory_steady" }
    if ($redisMemory.maximum -ge [double]$t.redisMemoryMaximumPercent) { Add-AcceptanceViolation "redis_memory_peak" }
    if ($redisFree.minimum -le [double]$t.redisFreeMemoryMinimumBytes) { Add-AcceptanceViolation "redis_free_memory_minimum" }
    if ($redisEvictions.sum -gt 0) { Add-AcceptanceViolation "redis_evictions_observed" }
    if ($redisRejected.sum -gt 0) { Add-AcceptanceViolation "redis_rejections_observed" }
    $redisCpuCredit = Get-SeriesSummary "redis_cpu_credit"
    if ($redisCpuCredit.count -gt 0 -and $redisCpuCredit.minimum -le [double]$t.redisCpuCreditMinimum) {
        Add-AcceptanceViolation "redis_cpu_credit_minimum"
    }

    $natWindow = [ordered]@{ required = [bool]$t.requireNatSixHourAcceptance; sampleCount = 0; totalBytes = 0.0; upwardTrend = $false }
    if ($natWindow.required) {
        $cutoff = [DateTimeOffset]::UtcNow.AddHours(-6)
        $samples = @($script:NatSamples | Where-Object { $_.timestamp -ge $cutoff } | Sort-Object timestamp)
        $natWindow.sampleCount = $samples.Count
        $natWindow.totalBytes = [double](($samples | Measure-Object bytes -Sum).Sum ?? 0)
        if ($samples.Count -lt [int]$t.natSixHourRequiredSamples) { Add-AcceptanceViolation "nat_final_six_hours_incomplete" }
        if ($samples.Count -ge 2) {
            for ($index = 1; $index -lt $samples.Count; $index++) {
                if (($samples[$index].timestamp - $samples[$index - 1].timestamp).TotalSeconds -gt [double]$t.telemetryMaximumGapSeconds) {
                    Add-AcceptanceViolation "nat_final_six_hours_cadence"
                    break
                }
            }
            if (($samples[-1].timestamp - $samples[0].timestamp).TotalSeconds -lt (21600 - [double]$t.telemetryMaximumGapSeconds)) {
                Add-AcceptanceViolation "nat_final_six_hours_span"
            }
        }
        if ($natWindow.totalBytes -ge [double]$t.natSixHourMaximumBytes) { Add-AcceptanceViolation "nat_final_six_hours_bytes" }
        if ($samples.Count -ge 4) {
            $half = [math]::Floor($samples.Count / 2)
            $firstAverage = [double](($samples[0..($half - 1)] | Measure-Object bytes -Average).Average)
            $lastAverage = [double](($samples[$half..($samples.Count - 1)] | Measure-Object bytes -Average).Average)
            $natWindow.upwardTrend = $lastAverage -gt ($firstAverage + 1024.0)
            if ($natWindow.upwardTrend) { Add-AcceptanceViolation "nat_final_six_hours_upward_trend" }
        }
    }
    return [ordered]@{
        passed = $script:AcceptanceViolations.Count -eq 0
        violations = @($script:AcceptanceViolations | Sort-Object)
        metrics = $summaries
        diagnosticRdsCpuCoverage = $diagnosticRdsCpuCoverage
        rdsCpuCreditHours2Through8 = $rdsCreditSlope
        natFinalSixHours = $natWindow
    }
}

function Get-Sample {
    param($Config)
    $r = $Config.Resources
    $t = $Config.Thresholds
    $required = [int]$t.consecutiveMinutes
    $script:MetricFreshnessMaximumSeconds = [double]$t.metricFreshnessMaximumSeconds
    $immediate = [System.Collections.Generic.List[string]]::new()
    $consecutive = [System.Collections.Generic.List[string]]::new()
    # Parse the immutable harness start record before metric backfill so load
    # acceptance can be bounded to the actual traffic window.
    $progress = Get-LoadProgress -Config $Config
    $progressAtSampleStart = $progress
    $validatedLoadTiming = Get-ValidatedLoadSummaryTiming -Config $Config -Progress $progress
    if ($null -ne $validatedLoadTiming) {
        if ($null -eq $script:TrafficStoppedAtUtc) {
            $script:TrafficStoppedAtUtc = $validatedLoadTiming.TrafficStoppedAtUtc
        }
        elseif ([math]::Abs(($script:TrafficStoppedAtUtc - $validatedLoadTiming.TrafficStoppedAtUtc).TotalMilliseconds) -gt 1) {
            $immediate.Add("load_workload_contract_mismatch")
        }
    }

    $ecs = Get-EcsState -Config $Config
    if ($Config.ExpectedActiveApiTaskDefinitionArn -and
        [string]$ecs[$r.apiService].taskDefinition -ne $Config.ExpectedActiveApiTaskDefinitionArn) {
        $immediate.Add("ecs_active_api_task_definition_mismatch")
    }
    if ($Config.ExpectedActiveWorkerTaskDefinitionArn -and
        [string]$ecs[$r.workerService].taskDefinition -ne $Config.ExpectedActiveWorkerTaskDefinitionArn) {
        $immediate.Add("ecs_active_worker_task_definition_mismatch")
    }
    $ecsNetwork = Get-EcsNetworkState -Config $Config -ServiceState $ecs
    if (@($ecsNetwork.taskDefinitionMismatches).Count -gt 0) {
        $immediate.Add("ecs_active_running_task_revision_mismatch")
    }
    if (-not $ecsNetwork.satisfied) { $immediate.Add("ecs_network_contract_mismatch") }
    foreach ($serviceName in @($r.apiService, $r.workerService)) {
        $state = $ecs[$serviceName]
        $unstable = $null -eq $state -or $state.running -lt $state.desired -or $state.pending -gt 0 -or $state.deploymentCount -ne 1
        if (Update-ConsecutiveBreach -Name "ecs_unstable:$serviceName" -Breached $unstable -Required $required) {
            $consecutive.Add("ecs_unstable:$serviceName")
        }
    }
    $stoppedTasks = @(Get-NewStoppedTasks -Config $Config)
    foreach ($task in $stoppedTasks) {
        if ($task.expectedScaleOrDeploymentStop) { continue }
        elseif ($task.oom -and $task.service -eq $r.apiService -and
            $Config.ExpectedActiveApiTaskDefinitionArn -and
            [string]$ecs[$r.apiService].taskDefinition -eq $Config.ExpectedActiveApiTaskDefinitionArn -and
            $Config.ExpectedActiveApiTaskDefinitionArn -match '/[A-Za-z0-9_-]*api-emergency:\d+$') {
            $immediate.Add("ecs_active_emergency_api_oom:$($task.taskArnSuffix)")
        }
        elseif ($task.oom -and $task.service -eq $r.apiService) { $immediate.Add("ecs_api_oom:$($task.taskArnSuffix)") }
        else { $immediate.Add("ecs_task_stopped:$($task.taskArnSuffix)") }
    }
    $target = Get-TargetState -Config $Config
    if ($target.healthy -lt 1 -or $target.unhealthy -gt 0) { $immediate.Add("alb_unhealthy") }

    $nat = Get-NatState -Config $Config
    if ($nat.failed -gt 0) { $immediate.Add("nat_failed") }
    if ($nat.available -ne $Config.ExpectedNatGatewayCount -or $nat.pending -gt 0) {
        $immediate.Add("nat_count_mismatch")
    }
    $metricQueries = Get-MetricQueries -Config $Config -NatState $nat
    $metricBatch = Invoke-CloudWatchMetricBatch -Region $r.region -Queries $metricQueries
    $nat = Add-NatMetrics -NatState $nat -Metrics $metricBatch
    $waf = Get-WafState -Config $Config -Metrics $metricBatch
    Add-MetricFinding $immediate $consecutive "waf_device_blocked" (Get-BatchMetric $metricBatch "waf_device_blocked") { param($v) $v -gt 0 } $required -ImmediateOnBreach
    Add-MetricFinding $immediate $consecutive "waf_api_blocked" (Get-BatchMetric $metricBatch "waf_api_blocked") { param($v) $v -gt 0 } $required -ImmediateOnBreach

    $ecsMetrics = [ordered]@{}
    foreach ($service in @(
        [pscustomobject]@{ Suffix = "api"; Name = [string]$r.apiService },
        [pscustomobject]@{ Suffix = "worker"; Name = [string]$r.workerService }
    )) {
        $cpuPercent = Get-BatchMetric $metricBatch "ecs_$($service.Suffix)_cpu"
        $cpuMaximumPercent = Get-BatchMetric $metricBatch "ecs_$($service.Suffix)_cpu_maximum"
        $memoryPercent = Get-BatchMetric $metricBatch "ecs_$($service.Suffix)_memory"
        $serviceName = $service.Name
        $ecsMetrics[$serviceName] = [ordered]@{
            cpuPercent = Get-MetricNumber $cpuPercent
            cpuMaximumPercent = Get-MetricNumber $cpuMaximumPercent
            memoryPercent = Get-MetricNumber $memoryPercent
        }
        Add-MetricFinding $immediate $consecutive "ecs_cpu:$serviceName" $cpuPercent { param($v) $v -ge [double]$t.ecsCpuMaximumPercent } $required
        Add-MetricFinding $immediate $consecutive "ecs_memory:$serviceName" $memoryPercent { param($v) $v -ge [double]$t.ecsMemoryMaximumPercent } $required
        Add-AcceptanceDatapoint "ecs_$($service.Suffix)_cpu" $cpuPercent
        Add-AcceptanceDatapoint "ecs_$($service.Suffix)_cpu_maximum" $cpuMaximumPercent
        Add-AcceptanceDatapoint "ecs_$($service.Suffix)_memory" $memoryPercent
    }

    $rdsState = Get-RdsState -Config $Config
    if ($rdsState.status -ne "available") { $immediate.Add("rds_unavailable") }
    if ($Config.ExpectedRdsInstanceClass -and $rdsState.instanceClass -ne $Config.ExpectedRdsInstanceClass) {
        $immediate.Add("rds_instance_class_mismatch")
    }
    if ($null -ne $Config.ExpectedRdsPosture) {
        $observedRdsPosture = [ordered]@{
            engine=$rdsState.engine;engineVersion=$rdsState.engineVersion
            allocatedStorageGiB=$rdsState.allocatedStorageGiB;maxAllocatedStorageGiB=$rdsState.maxAllocatedStorageGiB
            storageType=$rdsState.storageType;storageEncrypted=$rdsState.storageEncrypted;multiAz=$rdsState.multiAz
            publiclyAccessible=$rdsState.publiclyAccessible;performanceInsightsEnabled=$rdsState.performanceInsightsEnabled
            dbSubnetGroupName=$rdsState.dbSubnetGroup;vpcSecurityGroupIds=@($rdsState.vpcSecurityGroupIds|Sort-Object -Unique)
        }
        if (($observedRdsPosture|ConvertTo-Json -Depth 10 -Compress) -cne
            ($Config.ExpectedRdsPosture|ConvertTo-Json -Depth 10 -Compress)) {
            $immediate.Add("rds_exact_posture_mismatch")
        }
    }
    if (Test-HasObjectMembers $rdsState.pendingModifiedValues) { $immediate.Add("rds_pending_modifications") }
    $rdsCpu = Get-BatchMetric $metricBatch "rds_cpu"
    $rdsConnections = Get-BatchMetric $metricBatch "rds_connections"
    $rdsFreeStorage = Get-BatchMetric $metricBatch "rds_free_storage"
    $rdsFreeMemory = Get-BatchMetric $metricBatch "rds_free_memory"
    $rdsSwap = Get-BatchMetric $metricBatch "rds_swap"
    $rdsCpuCredit = Get-BatchMetric $metricBatch "rds_cpu_credit"
    $rdsSurplusCharged = Get-BatchMetric $metricBatch "rds_surplus_charged"
    $rdsReadLatencySeconds = Get-BatchMetric $metricBatch "rds_read_latency_seconds"
    $rdsWriteLatencySeconds = Get-BatchMetric $metricBatch "rds_write_latency_seconds"
    $rdsReadLatencyMs = Convert-MetricScale $rdsReadLatencySeconds 1000.0
    $rdsWriteLatencyMs = Convert-MetricScale $rdsWriteLatencySeconds 1000.0
    $rdsDiskQueueDepth = Get-BatchMetric $metricBatch "rds_disk_queue_depth"
    $rdsReadIops = Get-BatchMetric $metricBatch "rds_read_iops"
    $rdsWriteIops = Get-BatchMetric $metricBatch "rds_write_iops"
    $rdsTotalIops = Get-BatchMetric $metricBatch "rds_total_iops"
    $rdsStorageHeadroomPercent = if ($null -ne $rdsFreeStorage -and $rdsState.allocatedStorageGiB -gt 0) {
        [pscustomobject]@{
            Value = 100.0 * $rdsFreeStorage.Value / ([double]$rdsState.allocatedStorageGiB * 1GB)
            Timestamp = $rdsFreeStorage.Timestamp
        }
    } else { $null }

    $redisState = Get-RedisState -Config $Config
    if ($redisState.status -ne "available") { $immediate.Add("redis_unavailable") }
    if (Test-HasObjectMembers $redisState.pendingModifiedValues) { $immediate.Add("redis_pending_modifications") }
    if ($redisState.nodeType -ne $Config.ExpectedRedisNodeType) { $immediate.Add("redis_node_type_mismatch") }
    if ($Config.DiagnosticOnly -and (Get-OptionalValue $redisState "clusterIdentityValid" $false) -ne $true) {
        $immediate.Add("redis_group_member_identity_mismatch")
    }
    $redisCpu = Get-BatchMetric $metricBatch "redis_cpu"
    $redisMemory = Get-BatchMetric $metricBatch "redis_memory"
    $redisFree = Get-BatchMetric $metricBatch "redis_free"
    $redisEvictions = Get-BatchMetric $metricBatch "redis_evictions"
    $redisRejected = Get-BatchMetric $metricBatch "redis_rejected"
    $redisCpuCredit = Get-BatchMetric $metricBatch "redis_cpu_credit"

    Add-MetricSeriesFindings $immediate $consecutive "rds_cpu" $metricBatch `
        { param($v) $v -ge [double]$t.rdsCpuMaximumPercent } $required `
        -NotBeforeUtc $Config.RuntimeSeriesNotBeforeUtc `
        -FreshnessMaximumSeconds ([double]$t.rdsCpuMetricFreshnessMaximumSeconds)
    Add-MetricFinding $immediate $consecutive "rds_connections" $rdsConnections { param($v) $v -ge [double]$t.rdsConnectionsMaximum } $required
    Add-MetricFinding $immediate $consecutive "rds_storage_headroom" $rdsStorageHeadroomPercent { param($v) $v -le [double]$t.rdsStorageHeadroomMinimumPercent } $required
    Add-MetricFinding $immediate $consecutive "rds_free_memory" $rdsFreeMemory { param($v) $v -le [double]$t.rdsFreeableMemoryMinimumBytes } $required
    Add-MetricFinding $immediate $consecutive "rds_cpu_credit" $rdsCpuCredit { param($v) $v -le [double]$t.rdsCpuCreditMinimum } $required `
        -FreshnessMaximumSeconds ([double]$t.fiveMinuteMetricFreshnessMaximumSeconds)
    Add-MetricFinding $immediate $consecutive "rds_surplus_credits_charged" $rdsSurplusCharged { param($v) $v -gt 0 } $required `
        -FreshnessMaximumSeconds ([double]$t.fiveMinuteMetricFreshnessMaximumSeconds)
    if ($Config.ExpectedRdsInstanceClass -eq "db.t4g.xlarge") {
        Add-MetricFinding $immediate $consecutive "rds_read_latency_peak" $rdsReadLatencyMs `
            { param($v) $v -ge [double]$t.rdsLatencyPeakMaximumMilliseconds } $required -ImmediateOnBreach
        Add-MetricFinding $immediate $consecutive "rds_write_latency_peak" $rdsWriteLatencyMs `
            { param($v) $v -ge [double]$t.rdsLatencyPeakMaximumMilliseconds } $required -ImmediateOnBreach
        Add-MetricFinding $immediate $consecutive "rds_disk_queue_depth" $rdsDiskQueueDepth `
            { param($v) $v -ge [double]$t.rdsQueueDepthConsecutiveMaximum } $required
        Add-MetricFinding $immediate $consecutive "rds_total_iops_peak" $rdsTotalIops `
            { param($v) $v -ge [double]$t.rdsIopsPeakMaximum } $required -ImmediateOnBreach
    }
    Add-MetricFinding $immediate $consecutive "rds_swap_telemetry" $rdsSwap { param($v) $false } $required
    Add-GrowthMetricFinding $consecutive "rds_swap_growing" $rdsSwap ([double]$t.rdsSwapGrowthMaximumBytesPerMinute) $required
    Add-MetricFinding $immediate $consecutive "redis_cpu" $redisCpu { param($v) $v -ge [double]$t.redisCpuMaximumPercent } $required
    Add-MetricFinding $immediate $consecutive "redis_memory" $redisMemory { param($v) $v -ge [double]$t.redisMemoryMaximumPercent } $required
    Add-MetricFinding $immediate $consecutive "redis_free_memory" $redisFree { param($v) $v -le [double]$t.redisFreeMemoryMinimumBytes } $required
    Add-MetricFinding $immediate $consecutive "redis_evictions" $redisEvictions { param($v) $v -gt 0 } $required -ImmediateOnBreach
    Add-MetricFinding $immediate $consecutive "redis_rejected_connections" $redisRejected { param($v) $v -gt 0 } $required -ImmediateOnBreach
    Add-MetricFinding $immediate $consecutive "redis_cpu_credit" $redisCpuCredit { param($v) $v -lt [double]$t.redisCpuCreditMinimum } $required `
        -FreshnessMaximumSeconds ([double]$t.fiveMinuteMetricFreshnessMaximumSeconds)
    Add-AcceptanceSeriesDatapoints -Name "rds_cpu" -MetricBatch $metricBatch -Config $Config
    foreach ($entry in @(
        @("rds_connections", $rdsConnections), @("rds_storage_headroom", $rdsStorageHeadroomPercent),
        @("rds_free_memory", $rdsFreeMemory), @("rds_swap", $rdsSwap), @("rds_cpu_credit", $rdsCpuCredit), @("rds_surplus_charged", $rdsSurplusCharged),
        @("rds_read_latency_ms", $rdsReadLatencyMs), @("rds_write_latency_ms", $rdsWriteLatencyMs),
        @("rds_disk_queue_depth", $rdsDiskQueueDepth), @("rds_read_iops", $rdsReadIops), @("rds_write_iops", $rdsWriteIops), @("rds_total_iops", $rdsTotalIops),
        @("redis_cpu", $redisCpu), @("redis_memory", $redisMemory), @("redis_free", $redisFree),
        @("redis_evictions", $redisEvictions), @("redis_rejected", $redisRejected), @("redis_cpu_credit", $redisCpuCredit)
    )) { Add-AcceptanceDatapoint $entry[0] $entry[1] }

    if ($null -ne $nat.metricTimestamp) {
        $natTimestamp = [DateTimeOffset]$nat.metricTimestamp
        if (-not ($script:NatSamples | Where-Object { $_.timestamp -eq $natTimestamp })) {
            $script:NatSamples.Add([pscustomobject]@{ timestamp = $natTimestamp; bytes = [double]$nat.bytesLastMinute })
        }
    }
    if ($nat.packetDropsLastMinute -gt 0) { Add-AcceptanceViolation "nat_packet_drop_observed" }
    if ($nat.portAllocationErrorsLastMinute -gt 0) { Add-AcceptanceViolation "nat_port_allocation_error_observed" }

    $generatorIp = Get-GeneratorIpState -Config $Config
    if ($null -ne $generatorIp) {
        if (-not $generatorIp.exists -or $generatorIp.parseError -or -not $generatorIp.matched -or
            $generatorIp.staleSeconds -gt [double]$t.supervisedHeartbeatStaleSeconds) {
            $immediate.Add("generator_public_ip_unverifiable_or_changed")
        }
    }

    # Metric collection can overlap a fail-fast harness committing its terminal
    # evidence. Refresh the cheap local snapshot after the AWS calls so rollback
    # priority is based on the latest fatal/final record from this same sample.
    $harnessProcessLost = $Config.HarnessProcessId -gt 0 -and $null -eq (Get-BoundHarnessProcess -Config $Config)
    $refreshedProgress = Get-LoadProgress -Config $Config
    if (-not $harnessProcessLost -and $Config.HarnessProcessId -gt 0 -and $null -eq (Get-BoundHarnessProcess -Config $Config)) {
        $harnessProcessLost = $true
        # Once the process is confirmed gone, its synchronous evidence writes are
        # closed; take one final snapshot before classifying the exit.
        $refreshedProgress = Get-LoadProgress -Config $Config
    }
    $refreshedFatalGate = Get-LoadFatalGate -Progress $refreshedProgress
    $initialFinalCommitted = $null -ne $progressAtSampleStart -and $null -ne $progressAtSampleStart.event -and
        [string](Get-OptionalValue $progressAtSampleStart.event "event" "") -eq "final" -and
        -not $progressAtSampleStart.summaryPending
    $deferRefreshedCleanFinal = $false
    if ($harnessProcessLost -or $null -ne $refreshedFatalGate) {
        $progress = $refreshedProgress
        Add-LoadFatalGateFindings -Findings $immediate -FatalGate $refreshedFatalGate
        $refreshedFinalCommitted = $null -ne $progress -and $null -ne $progress.event -and
            [string](Get-OptionalValue $progress.event "event" "") -eq "final" -and -not $progress.summaryPending
        # Fatal evidence must affect rollback priority immediately. A clean final
        # still waits for the next normal sample so delayed CloudWatch datapoints
        # receive the same backfill opportunity as before this refresh existed.
        $deferRefreshedCleanFinal = $refreshedFinalCommitted -and $null -eq $refreshedFatalGate -and -not $initialFinalCommitted
        $validatedLoadTiming = Get-ValidatedLoadSummaryTiming -Config $Config -Progress $progress
        if ($null -ne $validatedLoadTiming -and -not $deferRefreshedCleanFinal) {
            if ($null -eq $script:TrafficStoppedAtUtc) {
                $script:TrafficStoppedAtUtc = $validatedLoadTiming.TrafficStoppedAtUtc
            }
            elseif ([math]::Abs(($script:TrafficStoppedAtUtc - $validatedLoadTiming.TrafficStoppedAtUtc).TotalMilliseconds) -gt 1 -and
                -not $immediate.Contains("load_workload_contract_mismatch")) {
                $immediate.Add("load_workload_contract_mismatch")
            }
        }
    }
    $loadCompleted = $false
    if ($progress) {
        if ($progress.parseError) { $immediate.Add("load_progress_parse_error") }
        elseif (-not $progress.exists -and ([DateTimeOffset]::UtcNow - $script:StartedAt).TotalSeconds -gt [double]$t.progressStaleSeconds) {
            $immediate.Add("load_progress_missing")
        }
        if ($progress.event -and [string](Get-OptionalValue $progress.event "runId" "") -ne $Config.RunId) {
            $immediate.Add("load_progress_run_id_mismatch")
        }
        if ($progress.event -and [string](Get-OptionalValue $progress.event "stage" "") -ne $Config.Workload.Stage) {
            $immediate.Add("load_progress_stage_mismatch")
        }
        if ($progress.event -and $progress.event.type -eq "fatal_gate") {
            Add-LoadFatalGateFindings -Findings $immediate -FatalGate (Get-OptionalValue $progress.event "fatalGate")
        }
        if ($progress.event -and [string]$progress.event.event -eq "final" -and -not $progress.summaryPending -and -not $deferRefreshedCleanFinal) {
            if ($null -eq $progress.summary -or [string](Get-OptionalValue $progress.summary "runId" "") -ne $Config.RunId) {
                $immediate.Add("load_summary_invalid")
            }
            else {
                $summary = $progress.summary
                $contractValid = $null -ne $validatedLoadTiming
                if (-not $contractValid) { $immediate.Add("load_workload_contract_mismatch") }
                else { $loadCompleted = $true }
                $summaryThresholds = Get-OptionalValue $progress.summary "thresholds"
                $summaryPassed = Get-OptionalValue $summaryThresholds "passed" $false
                $summaryFatal = Get-OptionalValue $progress.summary "fatalGate"
                Add-LoadFatalGateFindings -Findings $immediate -FatalGate $summaryFatal
                if ($Config.RequireLoadAcceptance -and $summaryPassed -ne $true) { $immediate.Add("load_acceptance_failed") }
            }
        }
        if ($progress.exists -and -not $loadCompleted -and $progress.staleSeconds -gt [double]$t.progressStaleSeconds) {
            $immediate.Add("load_progress_stale")
        }
        $commitPending = $deferRefreshedCleanFinal -or $progress.summaryPending -or
            ($progress.incompleteTail -and $progress.staleSeconds -le [double]$t.summaryCommitGraceSeconds)
        if (-not $loadCompleted -and -not $commitPending -and $harnessProcessLost) {
            $immediate.Add("load_generator_process_lost")
        }
    }

    $supervisedHeartbeats = @(Get-SupervisedHeartbeatState -Config $Config)
    foreach ($heartbeat in $supervisedHeartbeats) {
        $pastStartupGrace = ([DateTimeOffset]::UtcNow - $script:StartedAt).TotalSeconds -gt [double]$t.supervisedHeartbeatStaleSeconds
        if (($heartbeat.exists -and $heartbeat.staleSeconds -gt [double]$t.supervisedHeartbeatStaleSeconds) -or (-not $heartbeat.exists -and $pastStartupGrace)) {
            $immediate.Add("supervised_heartbeat_lost:$($heartbeat.name)")
        }
    }

    if (Update-DatapointBreach -Name "nat_packet_drops" -Breached ($nat.packetDropsLastMinute -gt 0) -Timestamp $nat.metricTimestamp -Required $required) {
        $consecutive.Add("nat_packet_drops")
    }
    if (Update-DatapointBreach -Name "nat_port_allocation_errors" -Breached ($nat.portAllocationErrorsLastMinute -gt 0) -Timestamp $nat.metricTimestamp -Required $required) {
        $consecutive.Add("nat_port_allocation_errors")
    }
    $route53 = Get-Route53State -Config $Config
    $route53Breached = (
        $null -eq $route53 -or $route53.total -lt 1 -or $route53.successful -lt $route53.total -or
        $route53.type -ne "HTTPS" -or $route53.resourcePath -ne "/health" -or
        $route53.measureLatency -ne $Config.ExpectedRoute53MeasureLatency -or
        -not $route53.alarmFound -or $route53.alarmState -ne "OK"
    )
    if (-not $route53Breached) { $script:Route53AlarmOkPeriods++ } else { $script:Route53AlarmOkPeriods = 0 }
    if (Update-ConsecutiveBreach -Name "route53_checker_failure" -Breached $route53Breached -Required $required) {
        $consecutive.Add("route53_checker_failure")
    }
    $automatedRedisSnapshot = Get-AutomatedRedisSnapshotState -Config $Config

    return [ordered]@{
        type = "aws_rollout_sample"
        schemaVersion = 1
        runId = $Config.RunId
        phase = $Config.Phase
        timestamp = [DateTimeOffset]::UtcNow.ToString("o")
        ecs = $ecs
        ecsNetwork = $ecsNetwork
        stoppedTasks = $stoppedTasks
        alb = $target
        metrics = [ordered]@{
            ecs = $ecsMetrics
            rdsCpuPercent = Get-MetricNumber $rdsCpu
            rdsConnections = Get-MetricNumber $rdsConnections
            rdsFreeStorageBytes = Get-MetricNumber $rdsFreeStorage
            rdsStorageHeadroomPercent = Get-MetricNumber $rdsStorageHeadroomPercent
            rdsFreeableMemoryBytes = Get-MetricNumber $rdsFreeMemory
            rdsSwapUsageBytes = Get-MetricNumber $rdsSwap
            rdsCpuCreditBalance = Get-MetricNumber $rdsCpuCredit
            rdsSurplusCreditsCharged = Get-MetricNumber $rdsSurplusCharged
            rdsReadLatencyMilliseconds = Get-MetricNumber $rdsReadLatencyMs
            rdsWriteLatencyMilliseconds = Get-MetricNumber $rdsWriteLatencyMs
            rdsReadLatencySeconds = Get-MetricNumber $rdsReadLatencySeconds
            rdsWriteLatencySeconds = Get-MetricNumber $rdsWriteLatencySeconds
            rdsDiskQueueDepth = Get-MetricNumber $rdsDiskQueueDepth
            rdsReadIops = Get-MetricNumber $rdsReadIops
            rdsWriteIops = Get-MetricNumber $rdsWriteIops
            rdsTotalIops = Get-MetricNumber $rdsTotalIops
            redisCpuPercent = Get-MetricNumber $redisCpu
            redisMemoryPercent = Get-MetricNumber $redisMemory
            redisFreeMemoryBytes = Get-MetricNumber $redisFree
            redisEvictions = Get-MetricNumber $redisEvictions
            redisRejectedConnections = Get-MetricNumber $redisRejected
            redisCpuCreditBalance = Get-MetricNumber $redisCpuCredit
        }
        rds = $rdsState
        redis = $redisState
        waf = $waf
        nat = $nat
        route53 = $route53
        automatedRedisSnapshot = $automatedRedisSnapshot
        route53ConsecutiveOkPeriods = $script:Route53AlarmOkPeriods
        load = $progress
        validatedTileBatch = if ($null -eq $validatedLoadTiming) { $null } else { $validatedLoadTiming.TileBatch }
        generatorPublicIp = $generatorIp
        supervisedHeartbeats = $supervisedHeartbeats
        loadCompleted = $loadCompleted
        immediateFailures = @($immediate)
        consecutiveFailures = @($consecutive)
        triggered = ($immediate.Count + $consecutive.Count) -gt 0
    }
}

function Write-JsonLine {
    param([string]$Path, $Value)
    $json = $Value | ConvertTo-Json -Compress -Depth 40
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($json + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
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

function Get-BoundHarnessProcess {
    param($Config)
    if ($Config.HarnessProcessId -le 0) { return $null }
    $process = Get-Process -Id $Config.HarnessProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    try {
        $actualStartedAt = ([DateTimeOffset]$process.StartTime).ToUniversalTime()
        $actualPath = [IO.Path]::GetFullPath([string]$process.Path)
    }
    catch { return $null }
    if ([math]::Abs(($actualStartedAt - $Config.HarnessProcessStartedAtUtc).TotalSeconds) -gt 2) { return $null }
    if (-not [string]::Equals($actualPath, $Config.HarnessProcessPath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    return $process
}

function Stop-Harness {
    param($Config)
    if ($Config.HarnessProcessId -le 0) { return }
    $process = Get-BoundHarnessProcess -Config $Config
    if ($process) {
        if ($IsWindows) {
            & taskkill.exe /PID ([string]$process.Id) /T /F 2>$null | Out-Null
            if ($LASTEXITCODE -notin @(0, 128)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        }
        else { Stop-Process -Id $process.Id -Force }
    }
}

function Send-Notification {
    param($Config, [string]$Subject, [string]$Message)
    & aws sns publish --region $Config.Resources.region --topic-arn $Config.NotificationTopicArn `
        --subject $Subject --message $Message --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to publish the rollout notification." }
}

function Get-ApprovedActionForFailure {
    param($Config, $Sample, [string]$Failure)
    # Database capacity, credits, latency, queue depth, I/O, availability, and
    # telemetry failures are evidence-preserving hard stops. They must never be
    # translated into an unrelated application, WAF, networking, or Redis
    # mutation merely because one of those phases happens to be active.
    if ($Failure -match '^(?:rds_|missing_metric:rds_|stale_metric:rds_)') { return $null }
    if ($Failure -match '^(?:missing_metric:|stale_metric:)') { return $null }
    if ($Failure -match '^ecs_active_emergency_api_oom:') { return $null }
    if ($Failure -in @(
        'load:cross-school-delivery', 'load:cross-school-http-response',
        'load:tenant-isolation-probe-failed', 'load:command-target-scope',
        'load:invalid-teacher-response'
    )) { return [ordered]@{ action = "Application"; priority = 110 } }
    if ($Failure -match '^ecs_api_oom:') { return [ordered]@{ action = "Oom"; priority = 100 } }
    if ($Failure -match '^(?:ecs_active_(?:api|worker)_task_definition_mismatch$|ecs_active_running_task_revision_mismatch$|ecs_cpu:|ecs_memory:)') {
        return [ordered]@{ action = "Application"; priority = 80 }
    }
    # A stopped task, unstable service, or unhealthy target is an observed
    # symptom, not proof of an application regression. In particular, each can
    # be caused by the PublicEcs/NatRemoved networking change. Leave these
    # unclassified so they hard-stop on their own; a separate, cause-specific
    # finding (for example a task-definition mismatch or exact network-contract
    # mismatch) may still select only its corresponding reviewed recovery.
    if ($Failure -match '^(?:ecs_task_stopped:|alb_unhealthy$|ecs_unstable:)') { return $null }
    if ($Failure -match '^load:.*(?:valid-http-429|valid-429)$') {
        return [ordered]@{ action = "Application"; priority = 90 }
    }
    if ($Failure -match '^load:.*valid.*403$') {
        if ($Sample.waf.blockedObserved -and -not [string]::IsNullOrWhiteSpace([string]$Sample.waf.latestBlockedTimestamp)) {
            $blockedAt = [DateTimeOffset]$Sample.waf.latestBlockedTimestamp
            $sampleAt = [DateTimeOffset]$Sample.timestamp
            if ([math]::Abs(($sampleAt - $blockedAt).TotalMinutes) -le 3) {
                return [ordered]@{ action = "Waf"; priority = 85 }
            }
        }
        return [ordered]@{ action = "Application"; priority = 84 }
    }
    if ($Failure -match '^load:.*valid-http-(?:3\d\d|4\d\d)$') {
        # A generic valid-traffic rejection restores the application by itself,
        # but an independently confirmed active-phase resource breach must win
        # so the infrastructure phase is not left in its failed posture.
        return [ordered]@{ action = "Application"; priority = 79 }
    }

    # Infrastructure recovery is cause-first. A stage name never relabels an
    # unrelated failure into that stage's rollback action.
    if ($Failure -eq "ecs_network_contract_mismatch") {
        if ($Config.Phase -eq "PublicEcs") { return [ordered]@{ action = "PublicEcs"; priority = 80 } }
        if ($Config.Phase -eq "NatRemoved") { return [ordered]@{ action = "NatRemoved"; priority = 80 } }
        return $null
    }
    if ($Failure -match '^nat_(?:failed|count_mismatch|packet_drops|port_allocation_errors)$') {
        if ($Config.Phase -eq "NatRemoved") { return [ordered]@{ action = "NatRemoved"; priority = 80 } }
        return $null
    }
    if ($Failure -match '^redis_') {
        if ($Config.Phase -in @("Redis","Final") -and
            [string]$Config.ExpectedRedisNodeType -eq "cache.t4g.micro") {
            return [ordered]@{ action = "Redis"; priority = 80 }
        }
        return $null
    }
    if ($Failure -match '^load:(?:load-fatal-gate|fatal-gate|application-regression)$') {
        return [ordered]@{ action = "Application"; priority = 70 }
    }
    return $null
}

function Resolve-ApprovedRollback {
    param($Config, $Sample)
    $reasons = @($Sample.immediateFailures) + @($Sample.consecutiveFailures)
    $candidates = [System.Collections.Generic.List[object]]::new()
    foreach ($reason in $reasons) {
        $candidate = Get-ApprovedActionForFailure -Config $Config -Sample $Sample -Failure ([string]$reason)
        if ($candidate) {
            $candidates.Add([pscustomobject]@{ action = [string]$candidate.action; priority = [int]$candidate.priority; reason = [string]$reason })
        }
    }
    $highestPriority = if ($candidates.Count -gt 0) { [int](($candidates | Measure-Object priority -Maximum).Maximum) } else { $null }
    $topCandidates = if ($null -eq $highestPriority) { @() } else { @($candidates | Where-Object priority -eq $highestPriority) }
    $topActions = @($topCandidates | ForEach-Object action | Sort-Object -Unique)
    $ambiguous = $topActions.Count -gt 1
    $winner = @(if ($topActions.Count -eq 1) { $topCandidates | Sort-Object reason | Select-Object -First 1 })
    return [ordered]@{
        approved = $winner.Count -eq 1 -and -not $ambiguous
        ambiguous = $ambiguous
        action = if ($winner.Count -eq 1) { [string]$winner[0].action } else { $null }
        priority = if ($winner.Count -eq 1) { [int]$winner[0].priority } else { $null }
        approvedReasons = if ($winner.Count -eq 1 -and -not $ambiguous) {
            @($candidates | Where-Object action -eq $winner[0].action | ForEach-Object reason)
        } else { @() }
        candidates = @($candidates)
        allReasons = @($reasons)
    }
}

function Assert-RollbackPreflight {
    param($Config)
    if (-not $Config.AutomaticRollback) { return }
    try { $rollback = Get-Content -LiteralPath $Config.RollbackConfigPath -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "rollbackConfigPath must contain valid JSON." }
    $rollbackTestMode = Get-OptionalValue $rollback "testMode" $false
    if ($rollbackTestMode -isnot [bool] -or [bool]$rollbackTestMode -ne $Config.TestMode) {
        throw "Rollback testMode must be a JSON boolean matching the monitor config."
    }
    foreach ($identity in @(
        @("runId", $Config.RunId), @("region", [string]$Config.Resources.region),
        @("cluster", [string]$Config.Resources.cluster), @("apiService", [string]$Config.Resources.apiService),
        @("workerService", [string]$Config.Resources.workerService)
    )) {
        if ([string](Get-OptionalValue $rollback $identity[0] "") -ne [string]$identity[1]) {
            throw "Rollback identity '$($identity[0])' does not match the monitor config."
        }
    }
    $rollbackEvidence = Assert-ExternalPath -Path (Get-RequiredString $rollback "evidenceDirectory") `
        -Name "rollback evidenceDirectory" -AllowMissing
    if (-not [string]::Equals($rollbackEvidence, $Config.EvidenceDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Rollback evidenceDirectory must match the monitor evidenceDirectory."
    }
    $actions = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    # OOM detection is always active, including monitor-only soaks. Load runs
    # can also dispatch application rollback and a correlated WAF rollback in
    # every rollout phase, not only while phase=Waf.
    if (-not ($Config.ExpectedActiveApiTaskDefinitionArn -and
        $Config.ExpectedActiveApiTaskDefinitionArn -match '/[A-Za-z0-9_-]*api-emergency:\d+$')) {
        [void]$actions.Add("Oom")
    }
    if ($Config.LoadProgressPath) {
        [void]$actions.Add("Application")
        [void]$actions.Add("Waf")
    }
    if ($Config.Phase -eq "Application") { [void]$actions.Add("Application") }
    if ($Config.Phase -eq "Waf") { [void]$actions.Add("Application") }
    if ($Config.Phase -in @("Waf", "PublicEcs", "NatRemoved", "Redis")) { [void]$actions.Add($Config.Phase) }
    if ($Config.Phase -eq "Final") { [void]$actions.Add("Redis") }
    $controller = Join-Path $PSScriptRoot "aws-rollout-rollback.ps1"
    $pwsh = (Get-Process -Id $PID).Path
    foreach ($action in $actions) {
        & $pwsh -NoProfile -File $controller -Mode Validate -Action $action -ConfigPath $Config.RollbackConfigPath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Rollback preflight failed for action $action." }
    }
}

$config = Read-Configuration
if (-not $config.TestMode -and [string]::IsNullOrWhiteSpace($ExpectedConfigSha256)) {
    throw "Production monitor Validate and Monitor modes require ExpectedConfigSha256 from the rollout supervisor."
}
if ($normalizedConfigSha -and
    (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $normalizedConfigSha) {
    throw "Bound monitor config changed while it was being parsed."
}
Assert-RollbackPreflight -Config $config
$safeValidation = [ordered]@{
    valid = $true
    schemaVersion = 1
    runId = $config.RunId
    phase = $config.Phase
    diagnosticOnly = $config.DiagnosticOnly
    certificationEligible = -not $config.DiagnosticOnly
    pollSeconds = $config.PollSeconds
    automaticRollback = $config.AutomaticRollback
    evidenceDirectory = $config.EvidenceDirectory
}
if ($Mode -eq "Validate") {
    $safeValidation | ConvertTo-Json -Depth 5
    exit 0
}

New-Item -ItemType Directory -Path $config.EvidenceDirectory -Force | Out-Null
$evidencePath = Join-ContainedPath $config.EvidenceDirectory "$($config.RunId)-aws-monitor.jsonl" "evidence path"
$heartbeatPath = Join-ContainedPath $config.EvidenceDirectory "$($config.RunId)-monitor-heartbeat.json" "heartbeat path"
$resultPath = Join-ContainedPath $config.EvidenceDirectory "$($config.RunId)-monitor-result.json" "result path"
foreach ($uniquePath in @($evidencePath, $heartbeatPath, $resultPath)) {
    if (Test-Path -LiteralPath $uniquePath) { throw "Run evidence already exists at $uniquePath; use a unique runId." }
}
if ($config.LoadProgressPath) {
    if ($null -eq (Get-BoundHarnessProcess -Config $config)) { throw "The configured load generator process binding is not live." }
    if (Test-Path -LiteralPath $config.LoadProgressPath) {
        $firstLine = Get-Content -LiteralPath $config.LoadProgressPath -TotalCount 1
        try { $firstEvent = $firstLine | ConvertFrom-Json -Depth 20 }
        catch { throw "The initial load progress record is invalid JSON." }
        if ([string](Get-OptionalValue $firstEvent "runId" "") -ne $config.RunId -or
            [string](Get-OptionalValue $firstEvent "stage" "") -ne $config.Workload.Stage -or
            [DateTimeOffset](Get-OptionalValue $firstEvent "timestamp" [DateTimeOffset]::MinValue) -lt $config.ArtifactsNotBeforeUtc) {
            throw "The initial load progress record does not match this run's immutable identity."
        }
    }
}
$iteration = 0
$nextHourlyReportAt = [DateTimeOffset]::UtcNow.AddHours(1)
$monotonicClock = [Diagnostics.Stopwatch]::StartNew()
$nextPollElapsedSeconds = 0.0

try {
    while ($config.MaxIterations -eq 0 -or $iteration -lt $config.MaxIterations) {
        $sampleStartedElapsedSeconds = $monotonicClock.Elapsed.TotalSeconds
        $iteration++
        try {
            $sample = Get-Sample -Config $config
        }
        catch {
            $sample = [ordered]@{
                type = "aws_rollout_sample"
                schemaVersion = 1
                runId = $config.RunId
                phase = $config.Phase
                timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                triggered = $true
                immediateFailures = @("monitor_exception")
                consecutiveFailures = @()
                error = $_.Exception.Message
            }
        }
        Write-JsonLine -Path $evidencePath -Value $sample
        Write-AtomicJson -Path $heartbeatPath -Value ([ordered]@{
            runId = $config.RunId
            phase = $config.Phase
            timestamp = [DateTimeOffset]::UtcNow.ToString("o")
            iteration = $iteration
            triggered = $sample.triggered
        })

        if ([DateTimeOffset]::UtcNow -ge $nextHourlyReportAt) {
            $hourly = [ordered]@{
                type = "aws_rollout_hourly"
                schemaVersion = 1
                runId = $config.RunId
                phase = $config.Phase
                timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                iteration = $iteration
                status = "running"
            }
            try {
                Send-Notification -Config $config -Subject "SchoolPilot $($config.Phase) gate running" `
                    -Message "Run $($config.RunId) is healthy after $iteration one-minute checks."
            }
            catch {
                $sample.triggered = $true
                $sample.immediateFailures = @($sample.immediateFailures) + @("notification_delivery_failed")
                $hourly.status = "notification_failed"
            }
            Write-JsonLine -Path $evidencePath -Value $hourly
            if ($sample.triggered) {
                Write-JsonLine -Path $evidencePath -Value ([ordered]@{
                    type = "aws_rollout_monitor_failure"
                    runId = $config.RunId
                    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                    failures = @($sample.immediateFailures)
                })
                Write-AtomicJson -Path $heartbeatPath -Value ([ordered]@{
                    runId = $config.RunId
                    phase = $config.Phase
                    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                    iteration = $iteration
                    triggered = $true
                })
            }
            $nextHourlyReportAt = $nextHourlyReportAt.AddHours(1)
        }

        if ($sample.triggered) {
            Stop-Harness -Config $config
            $failures = @($sample.immediateFailures) + @($sample.consecutiveFailures)
            $rollbackDecision = Resolve-ApprovedRollback -Config $config -Sample $sample
            $rollback = [ordered]@{
                approved = $rollbackDecision.approved
                ambiguous = $rollbackDecision.ambiguous
                attempted = $false
                action = $null
                exitCode = $null
                error = $null
                notificationError = $null
            }
            try {
                Send-Notification -Config $config -Subject "SchoolPilot $($config.Phase) gate FAILED" `
                    -Message "Run $($config.RunId) stopped. Gates: $($failures -join ', '). Approved unambiguous rollback: $($rollbackDecision.approved); automatic rollback enabled: $($config.AutomaticRollback)."
            }
            catch { $rollback.notificationError = $_.Exception.Message }
            if ($config.AutomaticRollback -and $config.ExpectedRollbackConfigSha256 -and
                (Get-FileHash -LiteralPath $config.RollbackConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.ExpectedRollbackConfigSha256) {
                $rollback.approved = $false
                $rollback.error = "Bound rollback config changed after arming; no automatic mutation was attempted."
                $failures += "rollback_config_sha256_mismatch"
            }
            if ($config.AutomaticRollback -and $rollbackDecision.approved -and -not $rollback.error) {
                $action = $rollbackDecision.action
                $controller = Join-Path $PSScriptRoot "aws-rollout-rollback.ps1"
                $rollback.attempted = $true
                $rollback.action = $action
                try {
                    & $controller -Mode Execute -Action $action -ConfigPath $config.RollbackConfigPath | Out-Null
                    $rollback.exitCode = 0
                }
                catch {
                    $rollback.exitCode = 1
                    $rollback.error = $_.Exception.Message
                }
            }
            $result = [ordered]@{
                runId = $config.RunId
                phase = $config.Phase
                diagnosticOnly = $config.DiagnosticOnly
                certificationEligible = -not $config.DiagnosticOnly
                status = "failed"
                timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                failures = $failures
                rollback = $rollback
            }
            Write-AtomicJson -Path $resultPath -Value $result
            if ($rollback.attempted -and $rollback.exitCode -ne 0) { exit 3 }
            exit 2
        }

        $elapsedSeconds = $monotonicClock.Elapsed.TotalSeconds
        $durationSatisfied = $elapsedSeconds -ge $config.MinimumWallClockSeconds
        $loadSatisfied = if ($config.LoadProgressPath) { [bool]$sample.loadCompleted } else { $true }
        $route53Satisfied = $config.Phase -ne "Route53" -or $script:Route53AlarmOkPeriods -ge 3
        $automatedSnapshotSatisfied = $config.Phase -ne "Final" -or [bool]$sample.automatedRedisSnapshot.accepted
        if ($durationSatisfied -and $loadSatisfied -and $route53Satisfied -and $automatedSnapshotSatisfied) {
            $acceptance = Get-AcceptanceResult -Config $config
            if (-not $acceptance.passed) {
                Stop-Harness -Config $config
                $failedResult = [ordered]@{
                    runId = $config.RunId
                    phase = $config.Phase
                    diagnosticOnly = $config.DiagnosticOnly
                    certificationEligible = -not $config.DiagnosticOnly
                    status = "failed"
                    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                    failures = @("run_acceptance_failed") + @($acceptance.violations)
                    rollback = [ordered]@{ approved = $false; attempted = $false; action = $null; reason = "cumulative acceptance is not an automatic mutation trigger" }
                    acceptance = $acceptance
                }
                Write-AtomicJson -Path $resultPath -Value $failedResult
                try {
                    Send-Notification -Config $config -Subject "SchoolPilot $($config.Phase) acceptance FAILED" `
                        -Message "Run $($config.RunId) completed traffic but failed cumulative acceptance: $($acceptance.violations -join ', '). No infrastructure rollback was attempted."
                }
                catch { }
                exit 2
            }
            $result = [ordered]@{
                runId = $config.RunId
                phase = $config.Phase
                diagnosticOnly = $config.DiagnosticOnly
                certificationEligible = -not $config.DiagnosticOnly
                status = "completed"
                timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                iterations = $iteration
                elapsedSeconds = [math]::Round($elapsedSeconds, 1)
                loadAccepted = if ($config.LoadProgressPath) { $loadSatisfied } else { $false }
                postureAccepted = $true
                minimumWallClockSeconds = $config.MinimumWallClockSeconds
                acceptance = $acceptance
                workload = if ($null -eq $config.Workload) { $null } else { [ordered]@{
                    stage = $config.Workload.Stage
                    diagnosticOnly = $config.DiagnosticOnly
                    certificationEligible = -not $config.DiagnosticOnly
                    devices = $config.Workload.Devices
                    durationSeconds = $config.Workload.DurationSeconds
                    screenshotBytes = $config.Workload.ScreenshotBytes
                    canaryDevices = $config.Workload.CanaryDevices
                    workloadSchemaVersion = $config.Workload.WorkloadSchemaVersion
                    endpointShapeSha256 = $config.Workload.EndpointShapeSha256
                    tileBatch = $sample.validatedTileBatch
                } }
                predecessorEvidence = $config.PredecessorEvidence
                automatedRedisSnapshot = $sample.automatedRedisSnapshot
            }
            Write-AtomicJson -Path $resultPath -Value $result
            try {
                Send-Notification -Config $config -Subject "SchoolPilot $($config.Phase) gate passed" `
                    -Message "Run $($config.RunId) completed all monitored acceptance gates."
            }
            catch {
                Write-JsonLine -Path $evidencePath -Value ([ordered]@{
                    type = "aws_rollout_notification_failure"
                    runId = $config.RunId
                    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                    status = "completed_notification_failed"
                })
            }
            exit 0
        }

        $iterationLimitReached = $config.MaxIterations -gt 0 -and $iteration -ge $config.MaxIterations
        $deadlineReached = [DateTimeOffset]::UtcNow -ge $config.DeadlineUtc
        if ($iterationLimitReached -or $deadlineReached) {
            Stop-Harness -Config $config
            $reason = if ($deadlineReached) { "monitor_deadline_reached_before_acceptance" } else { "monitor_iteration_limit_reached_before_acceptance" }
            $failedResult = [ordered]@{
                runId = $config.RunId
                phase = $config.Phase
                diagnosticOnly = $config.DiagnosticOnly
                certificationEligible = -not $config.DiagnosticOnly
                status = "failed"
                timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                failures = @($reason)
                rollback = [ordered]@{ approved = $false; attempted = $false; action = $null; reason = "monitoring completeness failures never mutate infrastructure" }
            }
            Write-AtomicJson -Path $resultPath -Value $failedResult
            try {
                Send-Notification -Config $config -Subject "SchoolPilot $($config.Phase) monitoring INVALID" `
                    -Message "Run $($config.RunId) stopped because $reason. The full stage must be repeated; no infrastructure rollback was attempted."
            }
            catch { }
            exit 2
        }
        $nextPollElapsedSeconds = $sampleStartedElapsedSeconds + [double]$config.PollSeconds
        $remainingSeconds = $nextPollElapsedSeconds - $monotonicClock.Elapsed.TotalSeconds
        if ($remainingSeconds -gt 0) { Start-Sleep -Milliseconds ([int][math]::Ceiling($remainingSeconds * 1000)) }
    }
}
finally {
    # No credentials are persisted by this process; evidence contains metrics only.
}
