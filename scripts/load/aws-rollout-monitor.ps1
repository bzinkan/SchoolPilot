#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

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
    param($RawConfig, [string]$ExpectedPhase, [AllowNull()][string]$ExpectedStage, [bool]$ExpectedLoad, [int]$MinimumPostureSeconds = 0)
    $predecessorPath = Assert-ExternalPath -Path (Get-RequiredString $RawConfig "predecessorResultPath") `
        -Name "predecessorResultPath"
    $expectedHash = (Get-RequiredString $RawConfig "predecessorResultSha256").ToLowerInvariant()
    if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or
        (Get-FileHash -LiteralPath $predecessorPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw "predecessorResultPath does not match predecessorResultSha256."
    }
    try { $predecessor = Get-Content -LiteralPath $predecessorPath -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "predecessorResultPath must contain valid monitor result JSON." }
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
    if ($null -ne $progress) {
        $workloadObject = $config.workload
        $workloadStage = Assert-SafeIdentifier -Value (Get-RequiredString $workloadObject "stage") -Name "workload.stage"
        $workload = [pscustomobject]@{
            Stage = $workloadStage
            Devices = Get-RequiredInteger $workloadObject "devices" 1 2000
            DurationSeconds = Get-RequiredInteger $workloadObject "durationSeconds" 1 86400
            ScreenshotBytes = Get-RequiredInteger $workloadObject "screenshotBytes" 1024 1048576
            CanaryDevices = Get-RequiredInteger $workloadObject "canaryDevices" 0 1000
        }
        if (-not $testMode) {
            $approved = [ordered]@{
                "510:1800:40960:10" = "500"
                "810:5400:40960:10" = "800"
                "1010:600:51200:10" = "burst"
                "810:28800:40960:10" = "endurance"
            }
            $signature = "$($workload.Devices):$($workload.DurationSeconds):$($workload.ScreenshotBytes):$($workload.CanaryDevices)"
            if (-not $approved.Contains($signature) -or $workload.Stage -ne [string]$approved[$signature]) {
                throw "workload stage/name/signature does not match an approved immutable launch-gate profile."
            }
            $allowedStages = @{
                Waf = @("500", "800")
                PublicEcs = @("800")
                NatRemoved = @("800")
                Redis = @("500", "800", "burst")
                Final = @("endurance")
            }
            if (-not $allowedStages.ContainsKey($phase) -or $workload.Stage -notin $allowedStages[$phase]) {
                throw "workload stage '$($workload.Stage)' is not authorized during phase '$phase'."
            }
        }
        if ($minimumWallClockSeconds -gt $workload.DurationSeconds + 900) {
            throw "minimumWallClockSeconds cannot exceed the workload duration by more than 15 minutes."
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

    if (-not $testMode) {
        $stageKey = if ($null -eq $workload) { "no-load" } else { [string]$workload.Stage }
        $progressionKey = "$phase`:$stageKey"
        $predecessorContract = switch ($progressionKey) {
            "Application:no-load" { $null }
            "Waf:500" { $null }
            "Waf:800" { [ordered]@{ phase="Waf"; stage="500"; load=$true; postureSeconds=0 } }
            "PublicEcs:800" { [ordered]@{ phase="Waf"; stage="800"; load=$true; postureSeconds=0 } }
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
                -ExpectedLoad ([bool]$predecessorContract.load) -MinimumPostureSeconds ([int]$predecessorContract.postureSeconds)
        }
    }

    $rollbackConfig = $null
    $automaticRollbackValue = Get-OptionalValue $config "automaticRollback" $false
    if ($automaticRollbackValue -isnot [bool]) { throw "automaticRollback must be a JSON boolean." }
    if (-not $testMode -and -not [bool]$automaticRollbackValue) {
        throw "Production monitoring requires automaticRollback=true."
    }
    if ($automaticRollbackValue) {
        $rollbackConfig = Assert-ExternalPath -Path (Get-RequiredString $config "rollbackConfigPath") -Name "rollbackConfigPath"
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
    $telemetryExpectedSeconds = $minimumWallClockSeconds
    if ($testMode -and $null -ne $config.PSObject.Properties["testTelemetryExpectedSeconds"]) {
        $telemetryExpectedSeconds = Get-RequiredInteger $config "testTelemetryExpectedSeconds" 0 86400
    }
    $telemetryMetricNames = @(
        "ecs_api_cpu", "ecs_api_memory", "ecs_worker_cpu", "ecs_worker_memory",
        "rds_cpu", "rds_connections", "rds_storage_headroom", "rds_free_memory", "rds_swap",
        "rds_cpu_credit", "rds_surplus_charged", "redis_cpu", "redis_memory", "redis_free",
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
        Assert-WafMetricIdentity -Resources $resources
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
        PollSeconds = $pollSeconds
        MaxIterations = $maxIterations
        MinimumWallClockSeconds = $minimumWallClockSeconds
        TelemetryExpectedSeconds = $telemetryExpectedSeconds
        TelemetryMetricNames = $telemetryMetricNames
        DeadlineUtc = $deadlineUtc
        TestMode = $testMode
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

function Assert-WafMetricIdentity {
    param($Resources)
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
    $metrics = @{}
    foreach ($result in @($response.MetricDataResults)) {
        if ([string]$result.StatusCode -notin @("Complete", "PartialData")) { continue }
        $points = for ($index = 0; $index -lt @($result.Timestamps).Count; $index++) {
            [pscustomobject]@{
                Timestamp = ([DateTimeOffset]$result.Timestamps[$index]).ToUniversalTime()
                Value = [double]$result.Values[$index]
            }
        }
        $latest = @($points | Sort-Object Timestamp | Select-Object -Last 1)
        $id = [string]$result.Id
        $isCompleteSparseWafZero = [string]$result.StatusCode -eq "Complete" -and $latest.Count -eq 0 -and
            $id -in @("waf_device_blocked", "waf_api_blocked")
        $metrics[$id] = if ($isCompleteSparseWafZero) {
            [pscustomobject]@{ Timestamp = $end; Value = 0.0; SparseZero = $true }
        } elseif ($latest.Count -eq 0) { $null } else { $latest[0] }
    }
    return $metrics
}

function Get-BatchMetric {
    param([hashtable]$Metrics, [string]$Id)
    if (-not $Metrics.ContainsKey($Id)) { return $null }
    return $Metrics[$Id]
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
    if ($taskArns.Count -gt 0) {
        for ($offset = 0; $offset -lt $taskArns.Count; $offset += 100) {
            $last = [math]::Min($taskArns.Count - 1, $offset + 99)
            $described = Invoke-AwsJson -Arguments (@(
                "ecs", "describe-tasks", "--region", $r.region, "--cluster", $r.cluster, "--tasks"
            ) + @($taskArns[$offset..$last]))
            foreach ($task in @($described.tasks)) {
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
        $script:SeenStoppedTasks[$taskArn] = $true
        $stoppedAt = if ($task.stoppedAt) { [DateTimeOffset]$task.stoppedAt } else { [DateTimeOffset]::MinValue }
        if ($stoppedAt -lt $script:StartedAt.AddSeconds(-5)) { continue }
        $containerReasons = @($task.containers | ForEach-Object { [string]$_.reason } | Where-Object { $_ })
        $exitCodes = @($task.containers | ForEach-Object { if ($null -ne $_.exitCode) { [int]$_.exitCode } })
        $reasonText = (([string]$task.stoppedReason) + " " + ($containerReasons -join " ")).ToLowerInvariant()
        $expectedScaleOrDeploymentStop = (
            [string]$task.stopCode -eq "ServiceSchedulerInitiated" -and
            $reasonText -match '(scaling activity|deployment|rolling update|desired count)' -and
            $reasonText -notmatch '(unhealthy|failed|failure|essential container|error|out.?of.?memory)'
        )
        $recent += [ordered]@{
            taskArnSuffix = $taskArn.Split('/')[-1]
            service = ([string]$task.group -replace '^service:', '')
            stoppedAt = $stoppedAt.ToString("o")
            stopCode = [string]$task.stopCode
            stoppedReason = [string]$task.stoppedReason
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
        allocatedStorageGiB = [int]$instance.AllocatedStorage
        maxAllocatedStorageGiB = [int]$instance.MaxAllocatedStorage
        pendingModifiedValues = $instance.PendingModifiedValues
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
    return [ordered]@{
        status = [string]$group.Status
        nodeType = [string]$group.CacheNodeType
        pendingModifiedValues = $group.PendingModifiedValues
    }
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
    param($Config, [hashtable]$Metrics)
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
        $queries.Add((New-MetricQuery "ecs_$($service.Suffix)_cpu" "AWS/ECS" "CPUUtilization" $dimensions "Maximum"))
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
    param($NatState, [hashtable]$Metrics)
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
    return [ordered]@{ exists = $true; staleSeconds = $stale; parseError = $false; incompleteTail = -not $hasTerminatedTail; summaryPending = $false; event = $event; summary = $summary }
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
        }
    }
    $series = $script:AcceptanceSeries[$Name]
    $timestamp = ([DateTimeOffset]$Metric.Timestamp).ToUniversalTime().ToString("o")
    if ($series.timestamps.Add($timestamp)) { $series.values.Add([double]$Metric.Value) }
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

function Assert-TelemetryCoverage {
    param($Config, [string[]]$MetricNames)
    if ($Config.TelemetryExpectedSeconds -le 0) { return }
    $fiveMinuteMetrics = @("rds_cpu_credit", "rds_surplus_charged", "redis_cpu_credit")
    foreach ($name in $MetricNames) {
        $periodSeconds = if ($name -in $fiveMinuteMetrics) { 300.0 } else { 60.0 }
        $maximumGapSeconds = if ($periodSeconds -eq 300.0) { 360.0 } else { [double]$Config.Thresholds.telemetryMaximumGapSeconds }
        $expectedPoints = [math]::Floor([double]$Config.TelemetryExpectedSeconds / $periodSeconds)
        if ($expectedPoints -lt 1) { continue }
        $minimumPoints = [math]::Ceiling($expectedPoints * ([double]$Config.Thresholds.telemetryMinimumCoveragePercent / 100.0))
        $minimumSpan = [math]::Max(0.0, [double]$Config.TelemetryExpectedSeconds - $maximumGapSeconds)
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
    if ($rdsConnections.maximum -ge [double]$t.rdsConnectionsMaximum) { Add-AcceptanceViolation "rds_connections_peak" }
    if ($rdsHeadroom.minimum -le [double]$t.rdsStorageHeadroomMinimumPercent) { Add-AcceptanceViolation "rds_storage_headroom_minimum" }
    $rdsFreeMemory = Get-SeriesSummary "rds_free_memory"
    $rdsCpuCredit = Get-SeriesSummary "rds_cpu_credit"
    $rdsSurplus = Get-SeriesSummary "rds_surplus_charged"
    if ($rdsFreeMemory.count -gt 0 -and $rdsFreeMemory.minimum -le [double]$t.rdsFreeableMemoryMinimumBytes) { Add-AcceptanceViolation "rds_freeable_memory_minimum" }
    if ($rdsCpuCredit.count -gt 0 -and $rdsCpuCredit.minimum -le [double]$t.rdsCpuCreditMinimum) { Add-AcceptanceViolation "rds_cpu_credit_minimum" }
    if ($rdsSurplus.count -gt 0 -and $rdsSurplus.maximum -gt 0) { Add-AcceptanceViolation "rds_surplus_credits_charged" }
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

    $ecs = Get-EcsState -Config $Config
    $ecsNetwork = Get-EcsNetworkState -Config $Config -ServiceState $ecs
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
        $memoryPercent = Get-BatchMetric $metricBatch "ecs_$($service.Suffix)_memory"
        $serviceName = $service.Name
        $ecsMetrics[$serviceName] = [ordered]@{
            cpuPercent = Get-MetricNumber $cpuPercent
            memoryPercent = Get-MetricNumber $memoryPercent
        }
        Add-MetricFinding $immediate $consecutive "ecs_cpu:$serviceName" $cpuPercent { param($v) $v -ge [double]$t.ecsCpuMaximumPercent } $required
        Add-MetricFinding $immediate $consecutive "ecs_memory:$serviceName" $memoryPercent { param($v) $v -ge [double]$t.ecsMemoryMaximumPercent } $required
        Add-AcceptanceDatapoint "ecs_$($service.Suffix)_cpu" $cpuPercent
        Add-AcceptanceDatapoint "ecs_$($service.Suffix)_memory" $memoryPercent
    }

    $rdsState = Get-RdsState -Config $Config
    if ($rdsState.status -ne "available") { $immediate.Add("rds_unavailable") }
    if (Test-HasObjectMembers $rdsState.pendingModifiedValues) { $immediate.Add("rds_pending_modifications") }
    $rdsCpu = Get-BatchMetric $metricBatch "rds_cpu"
    $rdsConnections = Get-BatchMetric $metricBatch "rds_connections"
    $rdsFreeStorage = Get-BatchMetric $metricBatch "rds_free_storage"
    $rdsFreeMemory = Get-BatchMetric $metricBatch "rds_free_memory"
    $rdsSwap = Get-BatchMetric $metricBatch "rds_swap"
    $rdsCpuCredit = Get-BatchMetric $metricBatch "rds_cpu_credit"
    $rdsSurplusCharged = Get-BatchMetric $metricBatch "rds_surplus_charged"
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
    $redisCpu = Get-BatchMetric $metricBatch "redis_cpu"
    $redisMemory = Get-BatchMetric $metricBatch "redis_memory"
    $redisFree = Get-BatchMetric $metricBatch "redis_free"
    $redisEvictions = Get-BatchMetric $metricBatch "redis_evictions"
    $redisRejected = Get-BatchMetric $metricBatch "redis_rejected"
    $redisCpuCredit = Get-BatchMetric $metricBatch "redis_cpu_credit"

    Add-MetricFinding $immediate $consecutive "rds_cpu" $rdsCpu { param($v) $v -ge [double]$t.rdsCpuMaximumPercent } $required
    Add-MetricFinding $immediate $consecutive "rds_connections" $rdsConnections { param($v) $v -ge [double]$t.rdsConnectionsMaximum } $required
    Add-MetricFinding $immediate $consecutive "rds_storage_headroom" $rdsStorageHeadroomPercent { param($v) $v -le [double]$t.rdsStorageHeadroomMinimumPercent } $required
    Add-MetricFinding $immediate $consecutive "rds_free_memory" $rdsFreeMemory { param($v) $v -le [double]$t.rdsFreeableMemoryMinimumBytes } $required
    Add-MetricFinding $immediate $consecutive "rds_cpu_credit" $rdsCpuCredit { param($v) $v -lt [double]$t.rdsCpuCreditMinimum } $required `
        -FreshnessMaximumSeconds ([double]$t.fiveMinuteMetricFreshnessMaximumSeconds)
    Add-MetricFinding $immediate $consecutive "rds_surplus_credits_charged" $rdsSurplusCharged { param($v) $v -gt 0 } $required `
        -FreshnessMaximumSeconds ([double]$t.fiveMinuteMetricFreshnessMaximumSeconds)
    Add-MetricFinding $immediate $consecutive "rds_swap_telemetry" $rdsSwap { param($v) $false } $required
    Add-GrowthMetricFinding $consecutive "rds_swap_growing" $rdsSwap ([double]$t.rdsSwapGrowthMaximumBytesPerMinute) $required
    Add-MetricFinding $immediate $consecutive "redis_cpu" $redisCpu { param($v) $v -ge [double]$t.redisCpuMaximumPercent } $required
    Add-MetricFinding $immediate $consecutive "redis_memory" $redisMemory { param($v) $v -ge [double]$t.redisMemoryMaximumPercent } $required
    Add-MetricFinding $immediate $consecutive "redis_free_memory" $redisFree { param($v) $v -le [double]$t.redisFreeMemoryMinimumBytes } $required
    Add-MetricFinding $immediate $consecutive "redis_evictions" $redisEvictions { param($v) $v -gt 0 } $required -ImmediateOnBreach
    Add-MetricFinding $immediate $consecutive "redis_rejected_connections" $redisRejected { param($v) $v -gt 0 } $required -ImmediateOnBreach
    Add-MetricFinding $immediate $consecutive "redis_cpu_credit" $redisCpuCredit { param($v) $v -lt [double]$t.redisCpuCreditMinimum } $required `
        -FreshnessMaximumSeconds ([double]$t.fiveMinuteMetricFreshnessMaximumSeconds)
    foreach ($entry in @(
        @("rds_cpu", $rdsCpu), @("rds_connections", $rdsConnections), @("rds_storage_headroom", $rdsStorageHeadroomPercent),
        @("rds_free_memory", $rdsFreeMemory), @("rds_swap", $rdsSwap), @("rds_cpu_credit", $rdsCpuCredit), @("rds_surplus_charged", $rdsSurplusCharged),
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

    $progress = Get-LoadProgress -Config $Config
    $generatorIp = Get-GeneratorIpState -Config $Config
    if ($null -ne $generatorIp) {
        if (-not $generatorIp.exists -or $generatorIp.parseError -or -not $generatorIp.matched -or
            $generatorIp.staleSeconds -gt [double]$t.supervisedHeartbeatStaleSeconds) {
            $immediate.Add("generator_public_ip_unverifiable_or_changed")
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
            $fatal = Get-OptionalValue $progress.event "fatalGate"
            $codes = @((Get-OptionalValue $fatal "reasonCodes" @()) | ForEach-Object { [string]$_ })
            if ($codes.Count -eq 0) { $immediate.Add("load_fatal_gate") }
            else { foreach ($code in $codes) { $immediate.Add("load:$code") } }
        }
        if ($progress.event -and [string]$progress.event.event -eq "final" -and -not $progress.summaryPending) {
            if ($null -eq $progress.summary -or [string](Get-OptionalValue $progress.summary "runId" "") -ne $Config.RunId) {
                $immediate.Add("load_summary_invalid")
            }
            else {
                $summary = $progress.summary
                $summaryRun = Get-OptionalValue $summary "run"
                $fixture = Get-OptionalValue $summary "screenshotFixture"
                $contractValid = (
                    [string](Get-OptionalValue $summary "stage" "") -eq $Config.Workload.Stage -and
                    [int](Get-OptionalValue $summary "devices" -1) -eq $Config.Workload.Devices -and
                    [int](Get-OptionalValue $summary "declaredSecondSchoolCanaryDevices" -1) -eq $Config.Workload.CanaryDevices -and
                    [int](Get-OptionalValue $fixture "decodedBytes" -1) -eq $Config.Workload.ScreenshotBytes -and
                    [double](Get-OptionalValue $summaryRun "plannedTrafficSeconds" -1) -eq $Config.Workload.DurationSeconds -and
                    [double](Get-OptionalValue $summaryRun "actualTrafficSeconds" -1) -ge $Config.Workload.DurationSeconds -and
                    (Get-OptionalValue $summaryRun "completedConfiguredDuration" $false) -eq $true
                )
                if (-not $contractValid) { $immediate.Add("load_workload_contract_mismatch") }
                else { $loadCompleted = $true }
                $summaryThresholds = Get-OptionalValue $progress.summary "thresholds"
                $summaryPassed = Get-OptionalValue $summaryThresholds "passed" $false
                $summaryFatal = Get-OptionalValue $progress.summary "fatalGate"
                if ($null -ne $summaryFatal) {
                    $summaryCodes = @((Get-OptionalValue $summaryFatal "reasonCodes" @()) | ForEach-Object { [string]$_ })
                    if ($summaryCodes.Count -eq 0) { $immediate.Add("load_fatal_gate") }
                    else { foreach ($code in $summaryCodes) { $immediate.Add("load:$code") } }
                }
                if ($Config.RequireLoadAcceptance -and $summaryPassed -ne $true) { $immediate.Add("load_acceptance_failed") }
            }
        }
        if ($progress.exists -and -not $loadCompleted -and $progress.staleSeconds -gt [double]$t.progressStaleSeconds) {
            $immediate.Add("load_progress_stale")
        }
        $commitPending = $progress.summaryPending -or ($progress.incompleteTail -and $progress.staleSeconds -le [double]$t.summaryCommitGraceSeconds)
        if (-not $loadCompleted -and -not $commitPending -and $Config.HarnessProcessId -gt 0 -and $null -eq (Get-BoundHarnessProcess -Config $Config)) {
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
    if ($Failure -in @(
        'load:cross-school-delivery', 'load:cross-school-http-response',
        'load:tenant-isolation-probe-failed', 'load:command-target-scope',
        'load:invalid-teacher-response'
    )) { return [ordered]@{ action = "Application"; priority = 110 } }
    if ($Failure -match '^ecs_api_oom:') { return [ordered]@{ action = "Oom"; priority = 100 } }
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

    $phaseAction = switch ($Config.Phase) {
        "Application" { "Application" }
        "Waf" { "Application" }
        "PublicEcs" { "PublicEcs" }
        "NatRemoved" { "NatRemoved" }
        { $_ -in @("Redis", "Final") } { "Redis" }
        default { $null }
    }
    if ($phaseAction -and ($Failure -match '^(ecs_task_stopped:|alb_unhealthy$|ecs_unstable:|ecs_network_contract_mismatch$)' -or
        $Failure -match '^(rds_|redis_|nat_|route53_|ecs_cpu:|ecs_memory:)')) {
        return [ordered]@{ action = $phaseAction; priority = 80 }
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
    $winner = @($candidates | Sort-Object @{ Expression = "priority"; Descending = $true }, @{ Expression = "action"; Descending = $false } | Select-Object -First 1)
    return [ordered]@{
        approved = $winner.Count -eq 1
        ambiguous = $false
        action = if ($winner.Count -eq 1) { [string]$winner[0].action } else { $null }
        priority = if ($winner.Count -eq 1) { [int]$winner[0].priority } else { $null }
        approvedReasons = if ($winner.Count -eq 1) {
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
    [void]$actions.Add("Oom")
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
Assert-RollbackPreflight -Config $config
$safeValidation = [ordered]@{
    valid = $true
    schemaVersion = 1
    runId = $config.RunId
    phase = $config.Phase
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
            if ($config.AutomaticRollback -and $rollbackDecision.approved) {
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
                    devices = $config.Workload.Devices
                    durationSeconds = $config.Workload.DurationSeconds
                    screenshotBytes = $config.Workload.ScreenshotBytes
                    canaryDevices = $config.Workload.CanaryDevices
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
