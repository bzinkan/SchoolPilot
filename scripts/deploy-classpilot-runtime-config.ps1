#requires -Version 7.5

[CmdletBinding()]
param(
    [ValidateSet("Plan", "Apply", "Rollback")]
    [string]$Operation = "Plan",
    [string]$ProfilePath,
    [string]$TurnEvidencePath,
    [string]$SyntheticValidationPath,
    [string]$ManagedTestWaiverPath,
    [string]$TrackingPilotEvidencePath,
    [string]$StudentGatePilotEvidencePath,
    [string]$ExternalEvidenceRoot,
    [string]$PlanPath,
    [string]$ExpectedPlanSha256,
    [string]$ExpectedAppSha,
    [string]$ExpectedImageDigest,
    [string]$ExpectedApiTaskDefinitionArn,
    [string]$ExpectedWorkerTaskDefinitionArn,
    [switch]$ConfirmProductionMutation,
    [switch]$ConfirmSyntheticOnlyGlobalActivation,
    [switch]$ConfirmProtectedWindowProductionMutation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:Region = "us-east-1"
$script:AccountId = "135775632425"
$script:Cluster = "schoolpilot-production-cluster"
$script:ApiService = "schoolpilot-production-api"
$script:WorkerService = "schoolpilot-production-scheduler-worker"
$script:AllowedApiFamilies = @("schoolpilot-production-api", "schoolpilot-production-api-emergency")
$script:WorkerFamily = "schoolpilot-production-scheduler-worker"
$script:EcrRepository = "schoolpilot-production-api"
$script:OperationLockTable = "schoolpilot-terraform-locks"
$script:OperationLockId = "schoolpilot/production/classpilot-runtime-config-v1"
$script:Utf8NoBom = [Text.UTF8Encoding]::new($false)
$script:ApiServiceMutationStarted = $false
$script:WorkerServiceMutationStarted = $false
$script:ScalingHoldAcquired = $false
$script:PriorScalingState = $null
$script:DeploymentBoundsChanged = $false
$script:PriorDeploymentBounds = $null
$script:PriorDeploymentConfigurations = $null
$script:OperationLockHeld = $false
$script:OperationLockOwner = $null
$script:OperationLockFence = $null
$script:OperationLockExpiresAt = 0L
$script:OperationLockState = $null
$script:OperationLockLeaseSeconds = 300L

$script:ActivationOrder = @(
    "exactBindingAckV2",
    "exactTabCloseV2",
    "authBoundTelemetryV1",
    "studentChatIdempotencyV1",
    "screenshotObservationLeaseV1",
    "safetyEvidenceCaptureV1",
    "liveViewIceServersV1",
    "kioskLaunchTicketV2"
)
$script:RepairedCapabilities = @("scopedAuthorityChecksV1") + $script:ActivationOrder
$script:TrackingWindowCapability = "screenshotTrackingWindowLeaseV1"
$script:StudentGatePresenceCapability = "studentAuthGatePresenceV1"
$script:AdditiveCapabilities = @(
    $script:TrackingWindowCapability,
    $script:StudentGatePresenceCapability
)
$script:AllCapabilities = @($script:RepairedCapabilities) + @($script:AdditiveCapabilities) + @(
    "kioskLaunchTicketV1"
)
$script:CapabilityFlags = [ordered]@{
    scopedAuthorityChecksV1       = "CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1"
    authBoundTelemetryV1          = "CLASSPILOT_CAP_AUTH_BOUND_TELEMETRY_V1"
    exactBindingAckV2             = "CLASSPILOT_CAP_EXACT_BINDING_ACK_V2"
    exactTabCloseV2               = "CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2"
    studentChatIdempotencyV1      = "CLASSPILOT_CAP_STUDENT_CHAT_IDEMPOTENCY_V1"
    screenshotObservationLeaseV1 = "CLASSPILOT_CAP_SCREENSHOT_OBSERVATION_LEASE_V1"
    screenshotTrackingWindowLeaseV1 = "CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1"
    studentAuthGatePresenceV1    = "CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1"
    safetyEvidenceCaptureV1       = "CLASSPILOT_CAP_SAFETY_EVIDENCE_CAPTURE_V1"
    liveViewIceServersV1          = "CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1"
    kioskLaunchTicketV1           = "CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1"
    kioskLaunchTicketV2           = "CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V2"
}
$script:RuntimeEnvironmentNames = @(
    "CLASSPILOT_PROTOCOL_V3_ENABLED",
    "CLASSPILOT_CAPABILITY_ROLLOUTS_JSON"
) + @($script:CapabilityFlags.Values)
$script:TurnEnvironmentNames = @(
    "CLASSPILOT_TURN_HOSTS",
    "CLASSPILOT_STUN_URLS"
)
$script:AllowedEnvironmentNames = @($script:RuntimeEnvironmentNames) + @($script:TurnEnvironmentNames)
$script:AllowedSecretNames = @("CLASSPILOT_TURN_REST_SECRET")
$script:EvidenceRootMarkerName = ".schoolpilot-classpilot-runtime-evidence-v1"
$script:EvidenceRootMarkerBytes = [Text.Encoding]::UTF8.GetBytes("schoolpilot-classpilot-runtime-evidence-v1`n")
$script:ClassPilotReleaseTag = "v2.7.1"
$script:ClassPilotMergeSha = "a3b096d6a74ab6979f4e4c656d75e2397eb8648f"
$script:ClassPilotZipSha256 = "40fed2c455d5c50fe3a947d23e3798a0c81832a67e717a2767b62970c024307c"

function Get-Sha256Text {
    param([Parameter(Mandatory = $true)][string]$Value)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function ConvertTo-CanonicalValue {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
            $ordered[$key] = ConvertTo-CanonicalValue -Value $Value[$key]
        }
        return $ordered
    }
    if ($Value -is [Collections.IEnumerable]) {
        $items = @($Value | ForEach-Object { ConvertTo-CanonicalValue -Value $_ })
        return ,$items
    }
    $properties = @($Value.PSObject.Properties | Where-Object MemberType -in @("NoteProperty", "Property") | Sort-Object Name)
    if ($properties.Count -gt 0) {
        $ordered = [ordered]@{}
        foreach ($property in $properties) {
            $ordered[$property.Name] = ConvertTo-CanonicalValue -Value $property.Value
        }
        return $ordered
    }
    return [string]$Value
}

function Get-CanonicalJsonSha256 {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()]$Value)
    $canonical = ConvertTo-CanonicalValue -Value $Value
    return Get-Sha256Text -Value ($canonical | ConvertTo-Json -Depth 50 -Compress)
}

function ConvertFrom-StrictJsonText {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    try {
        $document = [Text.Json.JsonDocument]::Parse($Text)
        try {
            function Assert-NoDuplicateJsonProperties {
                param([Text.Json.JsonElement]$Element, [string]$Trail = "$")
                if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
                    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
                    foreach ($property in $Element.EnumerateObject()) {
                        if (-not $seen.Add($property.Name)) {
                            throw "Duplicate JSON property at $Trail.$($property.Name)."
                        }
                        Assert-NoDuplicateJsonProperties -Element $property.Value -Trail "$Trail.$($property.Name)"
                    }
                }
                elseif ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
                    $index = 0
                    foreach ($item in $Element.EnumerateArray()) {
                        Assert-NoDuplicateJsonProperties -Element $item -Trail "$Trail[$index]"
                        $index++
                    }
                }
            }
            Assert-NoDuplicateJsonProperties -Element $document.RootElement
        }
        finally { $document.Dispose() }
    }
    catch {
        throw "Invalid strict JSON in the private runtime configuration input: $($_.Exception.Message)"
    }
    return $Text | ConvertFrom-Json -Depth 50 -DateKind String
}

function Read-StrictJsonSnapshot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $stream = [IO.FileStream]::new(
        $resolved,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    $memory = [IO.MemoryStream]::new()
    try {
        $buffer = [byte[]]::new(8192)
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($memory.Length + $read -gt 65536) {
                throw "Runtime configuration JSON exceeds the 64 KiB bound."
            }
            $memory.Write($buffer, 0, $read)
        }
        $bytes = $memory.ToArray()
    }
    finally {
        $memory.Dispose()
        $stream.Dispose()
    }

    if ($env:SCHOOLPILOT_RUNTIME_CONFIG_TEST_MODE -ceq "I_UNDERSTAND_TEST_ONLY") {
        $handler = Get-Variable -Name SchoolPilotRuntimeConfigSnapshotReadHandler -Scope Global -ErrorAction SilentlyContinue
        if ($null -ne $handler -and $null -ne $handler.Value) {
            & $handler.Value $resolved
        }
    }

    $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { 3 } else { 0 }
    try {
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset)
    }
    catch {
        throw "Private runtime configuration input must be valid UTF-8."
    }
    return [pscustomobject]@{
        Path = $resolved
        Sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        Bytes = $bytes
        Value = ConvertFrom-StrictJsonText -Text $text
    }
}

function Read-StrictJson {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Read-StrictJsonSnapshot -Path $Path).Value
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Allowed,
        [Parameter(Mandatory = $true)][string]$Trail
    )
    if ($null -eq $Value -or $Value -isnot [psobject]) { throw "$Trail must be an object." }
    $unknown = @($Value.PSObject.Properties.Name | Where-Object { $_ -notin $Allowed })
    if ($unknown.Count -gt 0) { throw "$Trail contains unsupported fields." }
}

function ConvertTo-RuntimeConfiguration {
    param([Parameter(Mandatory = $true)]$Profile)
    Assert-ExactProperties -Value $Profile -Allowed @(
        "schemaVersion", "mode", "testSchoolId", "enabledCapabilities", "pilotSchoolId", "turn"
    ) -Trail "profile"
    $schemaVersion = [int]$Profile.schemaVersion
    $mode = [string]$Profile.mode
    $schemaOneModes = @("off", "test-school", "global-on")
    $schemaTwoModes = @("tracking-window-pilot", "tracking-window-global-on")
    $schemaThreeModes = @("student-gate-pilot", "student-gate-global-on", "student-gate-off")
    if (($schemaVersion -eq 1 -and $mode -cnotin $schemaOneModes) -or
        ($schemaVersion -eq 2 -and $mode -cnotin $schemaTwoModes) -or
        ($schemaVersion -eq 3 -and $mode -cnotin $schemaThreeModes) -or
        $schemaVersion -notin @(1, 2, 3)) {
        throw "Runtime profile schemaVersion and mode do not match a reviewed profile contract."
    }

    $schoolId = ""
    $pilotSchoolId = ""
    $enabledCapabilities = @()
    if ($mode -ceq "test-school") {
        $schoolId = [string]$Profile.testSchoolId
        if ($schoolId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
            throw "The test-school profile requires one canonical UUID school ID."
        }
        if ($Profile.enabledCapabilities -isnot [Array]) {
            throw "The test-school enabledCapabilities value must be an array."
        }
        $enabledCapabilities = @($Profile.enabledCapabilities)
        if ($enabledCapabilities.Count -gt $script:ActivationOrder.Count) {
            throw "The test-school capability prefix is too long."
        }
        for ($index = 0; $index -lt $enabledCapabilities.Count; $index++) {
            if ([string]$enabledCapabilities[$index] -cne $script:ActivationOrder[$index]) {
                throw "Test-school capabilities must be the exact ordered activation prefix."
            }
        }
    }
    else {
        if ($Profile.PSObject.Properties.Name -contains "testSchoolId" -or
            $Profile.PSObject.Properties.Name -contains "enabledCapabilities") {
            throw "$mode profiles must not contain test-school fields."
        }
    }
    if ($mode -cin @("tracking-window-pilot", "student-gate-pilot")) {
        $pilotSchoolId = [string]$Profile.pilotSchoolId
        if ($pilotSchoolId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
            throw "The selected pilot profile requires one canonical UUID school ID."
        }
    }
    elseif ($Profile.PSObject.Properties.Name -contains "pilotSchoolId") {
        throw "$mode profiles must not contain a pilot school field."
    }

    $turn = $null
    $turnRequired = $mode -cin @("global-on", "tracking-window-global-on") -or
        $enabledCapabilities -contains "liveViewIceServersV1"
    if ($mode -ceq "off" -and $Profile.PSObject.Properties.Name -contains "turn") {
        throw "The off profile must not mutate TURN runtime wiring."
    }
    if ($mode -cin $schemaThreeModes -and $Profile.PSObject.Properties.Name -contains "turn") {
        throw "Student-gate profiles must preserve existing TURN runtime wiring."
    }
    if ($mode -ceq "tracking-window-pilot" -and $Profile.PSObject.Properties.Name -contains "turn") {
        throw "The tracking-window-pilot profile must preserve existing TURN runtime wiring."
    }
    if ($Profile.PSObject.Properties.Name -contains "turn" -and $null -ne $Profile.turn) {
        Assert-ExactProperties -Value $Profile.turn -Allowed @("hosts", "secretArn") -Trail "profile.turn"
        if ($Profile.turn.hosts -isnot [Array]) { throw "TURN hosts must be an array." }
        $hosts = @($Profile.turn.hosts | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() })
        if ($hosts.Count -ne 2 -or @($hosts | Sort-Object -Unique).Count -ne 2) {
            throw "TURN runtime configuration requires exactly two unique hosts."
        }
        foreach ($hostName in $hosts) {
            if ($hostName -cnotmatch '^turn-[ab]\.school-pilot\.net$') {
                throw "TURN runtime configuration contains an unexpected host."
            }
        }
        $hosts = @($hosts | Sort-Object)
        $secretArn = [string]$Profile.turn.secretArn
        $expectedSecretPattern = '^arn:aws:secretsmanager:us-east-1:135775632425:secret:/schoolpilot/production/CLASSPILOT_TURN_REST_SECRET-[A-Za-z0-9/_+=.@-]+$'
        if ($secretArn -cnotmatch $expectedSecretPattern) {
            throw "TURN runtime configuration requires the exact production Secrets Manager ARN shape."
        }
        $turn = [pscustomobject]@{
            Hosts = $hosts
            SecretArn = $secretArn
            HostsSha256 = Get-Sha256Text -Value ($hosts -join ",")
            SecretArnSha256 = Get-Sha256Text -Value $secretArn
        }
    }
    if ($turnRequired -and $null -eq $turn) {
        throw "The selected profile requires verified TURN inputs."
    }

    if ($mode -cin $schemaThreeModes) {
        return [pscustomobject]@{
            Mode = $mode
            SchoolScopeCount = if ($mode -ceq "student-gate-pilot") { 1 } else { 0 }
            EnabledCapabilities = if ($mode -ceq "student-gate-off") { @() } else {
                @($script:StudentGatePresenceCapability)
            }
            Environment = [ordered]@{}
            Turn = $null
            RequiresSourceRuntime = $true
            PilotSchoolId = if ($mode -ceq "student-gate-pilot") { $pilotSchoolId } else { $null }
        }
    }

    $rollouts = [ordered]@{}
    foreach ($capability in $script:AllCapabilities) {
        $capabilityOn = $false
        if ($mode -cin @("global-on", "tracking-window-pilot", "tracking-window-global-on")) {
            $capabilityOn = $capability -in $script:RepairedCapabilities -or
                ($capability -ceq $script:TrackingWindowCapability -and
                    $mode -cin @("tracking-window-pilot", "tracking-window-global-on"))
        }
        elseif ($mode -ceq "test-school") {
            $capabilityOn = $capability -ceq "scopedAuthorityChecksV1" -or $capability -in $enabledCapabilities
        }
        $entry = [ordered]@{ mode = if ($capabilityOn) { "on" } else { "off" } }
        if ($capabilityOn -and $mode -ceq "test-school") { $entry.schoolIds = @($schoolId) }
        if ($capability -ceq $script:TrackingWindowCapability -and $mode -ceq "tracking-window-pilot") {
            $entry.schoolIds = @($pilotSchoolId)
        }
        $rollouts[$capability] = $entry
    }
    if ([string]$rollouts.kioskLaunchTicketV1.mode -cne "off") {
        throw "kioskLaunchTicketV1 must remain off."
    }

    $environment = [ordered]@{
        CLASSPILOT_PROTOCOL_V3_ENABLED = if ($mode -ceq "off") { "false" } else { "true" }
    }
    foreach ($capability in $script:AllCapabilities) {
        $enabledKillSwitch = if ($capability -cin $script:AdditiveCapabilities) {
            $capability -ceq $script:TrackingWindowCapability -and
                $mode -cin @("tracking-window-pilot", "tracking-window-global-on")
        }
        else {
            $mode -ne "off" -and $capability -ne "kioskLaunchTicketV1"
        }
        $environment[$script:CapabilityFlags[$capability]] = if ($enabledKillSwitch) { "true" } else { "false" }
    }
    $environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = $rollouts | ConvertTo-Json -Depth 8 -Compress
    if ($null -ne $turn) {
        $environment.CLASSPILOT_TURN_HOSTS = $turn.Hosts -join ","
        $environment.CLASSPILOT_STUN_URLS = @($turn.Hosts | ForEach-Object { "stun:$($_):3478" }) -join ","
    }

    return [pscustomobject]@{
        Mode = $mode
        SchoolScopeCount = if ($mode -cin @("test-school", "tracking-window-pilot")) { 1 } else { 0 }
        EnabledCapabilities = if ($mode -cin @("tracking-window-pilot", "tracking-window-global-on")) {
            @($script:RepairedCapabilities) + @($script:TrackingWindowCapability)
        } elseif ($mode -ceq "global-on") {
            @($script:RepairedCapabilities)
        } elseif ($mode -ceq "test-school") {
            @("scopedAuthorityChecksV1") + $enabledCapabilities
        } else { @() }
        Environment = $environment
        Turn = $turn
        RequiresSourceRuntime = $false
    }
}

function Resolve-SourcePreservingRuntimeConfiguration {
    param(
        [Parameter(Mandatory = $true)]$RuntimeIntent,
        [Parameter(Mandatory = $true)]$SourceTaskDefinition,
        [Parameter(Mandatory = $true)][string]$ContainerName
    )
    if (-not [bool]$RuntimeIntent.RequiresSourceRuntime) { return $RuntimeIntent }
    if ([string]$RuntimeIntent.Mode -cnotin @(
        "student-gate-pilot", "student-gate-global-on", "student-gate-off"
    )) {
        throw "The source-preserving runtime intent is unsupported."
    }

    $containers = @($SourceTaskDefinition.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($containers.Count -ne 1) { throw "Source-preserving runtime container is ambiguous." }
    $sourceEnvironment = @($containers[0].environment)
    $sourceState = Get-RuntimeActivationState -Environment $sourceEnvironment -AllowBaseline
    if ([string]$sourceState.Mode -cnotin @(
        "global-on", "tracking-window-pilot", "tracking-window-global-on"
    )) {
        throw "Student-gate rollout requires the completed global repaired-capability runtime."
    }

    $values = [ordered]@{}
    foreach ($entry in @($sourceEnvironment | Where-Object {
        [string]$_.name -cin $script:RuntimeEnvironmentNames
    })) {
        $values[[string]$entry.name] = [string]$entry.value
    }
    foreach ($capability in $script:AdditiveCapabilities) {
        $flag = [string]$script:CapabilityFlags[$capability]
        if (-not $values.Contains($flag)) { $values[$flag] = "false" }
    }

    $sourceRollouts = ConvertFrom-StrictJsonText -Text ([string]$values.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON)
    $rollouts = [ordered]@{}
    foreach ($capability in $script:AllCapabilities) {
        if (-not ($sourceRollouts.PSObject.Properties.Name -ccontains $capability)) {
            if ($capability -cnotin $script:AdditiveCapabilities) {
                throw "Source runtime rollout registry is incomplete."
            }
            $rollouts[$capability] = [ordered]@{ mode = "off" }
            continue
        }
        $entry = $sourceRollouts.$capability
        $copy = [ordered]@{ mode = [string]$entry.mode }
        if ($entry.PSObject.Properties.Name -contains "schoolIds") {
            $copy.schoolIds = @($entry.schoolIds | ForEach-Object { [string]$_ })
        }
        $rollouts[$capability] = $copy
    }

    $gateOn = [string]$RuntimeIntent.Mode -cne "student-gate-off"
    $gateEntry = [ordered]@{ mode = if ($gateOn) { "on" } else { "off" } }
    if ([string]$RuntimeIntent.Mode -ceq "student-gate-pilot") {
        $profileSchoolId = [string]$RuntimeIntent.PilotSchoolId
        if ($profileSchoolId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
            throw "Student-gate pilot intent has an invalid school scope."
        }
        $gateEntry.schoolIds = @($profileSchoolId)
    }
    $rollouts[$script:StudentGatePresenceCapability] = $gateEntry
    $values[[string]$script:CapabilityFlags[$script:StudentGatePresenceCapability]] = if ($gateOn) { "true" } else { "false" }
    $values.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = $rollouts | ConvertTo-Json -Depth 8 -Compress

    $environment = [ordered]@{}
    foreach ($name in $script:RuntimeEnvironmentNames) {
        if (-not $values.Contains([string]$name)) {
            throw "Source-preserving runtime environment is incomplete."
        }
        $environment[[string]$name] = [string]$values[[string]$name]
    }
    $enabledCapabilities = @($script:AllCapabilities | Where-Object {
        [string]$environment[[string]$script:CapabilityFlags[$_]] -ceq "true" -and
            [string]$rollouts.$_.mode -ceq "on"
    })
    return [pscustomobject]@{
        Mode = [string]$RuntimeIntent.Mode
        SchoolScopeCount = [int]$RuntimeIntent.SchoolScopeCount
        EnabledCapabilities = $enabledCapabilities
        Environment = $environment
        Turn = $null
        RequiresSourceRuntime = $false
        SourceMode = [string]$sourceState.Mode
        PilotSchoolId = if ([string]$RuntimeIntent.Mode -ceq "student-gate-pilot") {
            [string]$RuntimeIntent.PilotSchoolId
        } else { $null }
    }
}

function Get-FreshEvidenceTimestamp {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    try {
        $timestamp = [DateTimeOffset]::ParseExact(
            $Value,
            "o",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch {
        throw "$Label must use an exact ISO-8601 timestamp."
    }
    $age = $Now - $timestamp
    if ($age.TotalMinutes -lt -5 -or $age.TotalHours -gt 2) {
        throw "$Label must be no more than two hours old."
    }
    return $timestamp.ToUniversalTime().ToString("o")
}

function Test-IsJsonInteger {
    param($Value)
    return $Value -is [int] -or $Value -is [long]
}

function Assert-TurnEvidence {
    param(
        [Parameter(Mandatory = $true)]$RuntimeConfiguration,
        [string]$EvidencePath,
        $EvidenceSnapshot,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
        [switch]$SyntheticOnlyWaiver
    )
    if ($null -eq $RuntimeConfiguration.Turn) { return $null }
    if ($null -eq $EvidenceSnapshot) {
        if (-not $EvidencePath) { throw "TURN evidence is required." }
        $EvidenceSnapshot = Read-StrictJsonSnapshot -Path $EvidencePath
    }
    $evidence = $EvidenceSnapshot.Value
    Assert-ExactProperties -Value $evidence -Allowed @(
        "schemaVersion", "validatedAt", "hostsSha256", "secretArnSha256", "checks"
    ) -Trail "TURN evidence"
    $requiredChecks = @(
        "twoHealthyNodes", "distinctAvailabilityZones", "dnsMatchesElasticIps",
        "turnUdp3478", "turnTcp3478", "turnsTcp443", "tlsCertificatesCurrent",
        "relayRangeValidated", "aggregateTelemetryHealthy", "syntheticUdpBlockedFallbackPassed",
        "managedUdpBlockedLiveViewPassed"
    )
    Assert-ExactProperties -Value $evidence.checks -Allowed $requiredChecks -Trail "TURN evidence.checks"
    $presentChecks = @($evidence.checks.PSObject.Properties.Name)
    if (@($requiredChecks | Where-Object { $presentChecks -cnotcontains $_ }).Count -ne 0) {
        throw "TURN live evidence is incomplete."
    }
    if (-not (Test-IsJsonInteger -Value $evidence.schemaVersion) -or [long]$evidence.schemaVersion -ne 2) {
        throw "TURN evidence schemaVersion must be the integer 2."
    }
    foreach ($name in @("validatedAt", "hostsSha256", "secretArnSha256")) {
        if ($evidence.$name -isnot [string]) { throw "TURN evidence is incomplete." }
    }
    $validatedAt = Get-FreshEvidenceTimestamp -Value ([string]$evidence.validatedAt) `
        -Label "TURN evidence" -Now $Now
    if ([string]$evidence.hostsSha256 -cne [string]$RuntimeConfiguration.Turn.HostsSha256 -or
        [string]$evidence.secretArnSha256 -cne [string]$RuntimeConfiguration.Turn.SecretArnSha256) {
        throw "TURN evidence does not bind the requested runtime inputs."
    }
    foreach ($name in @($requiredChecks | Where-Object { $_ -cne "managedUdpBlockedLiveViewPassed" })) {
        $value = $evidence.checks.$name
        if ($value -isnot [bool] -or -not $value) { throw "TURN live evidence is incomplete." }
    }
    $managedPassed = $evidence.checks.managedUdpBlockedLiveViewPassed
    if ($managedPassed -isnot [bool]) { throw "TURN live evidence is incomplete." }
    if ($SyntheticOnlyWaiver) {
        if ($RuntimeConfiguration.Mode -cne "global-on" -or $managedPassed) {
            throw "Synthetic-only TURN evidence must record that managed UDP-blocked Live View has not passed."
        }
    }
    elseif (-not $managedPassed) {
        throw "Strict TURN evidence requires managed UDP-blocked Live View to pass."
    }
    return [pscustomobject]@{
        ValidatedAt = $validatedAt
        EvidenceSha256 = [string]$EvidenceSnapshot.Sha256
    }
}

function Assert-SyntheticValidationEvidence {
    param(
        [Parameter(Mandatory = $true)]$EvidenceSnapshot,
        [Parameter(Mandatory = $true)][string]$AppSha,
        [Parameter(Mandatory = $true)][string]$ImageDigest,
        [Parameter(Mandatory = $true)][string]$TurnEvidenceSha256,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    $evidence = $EvidenceSnapshot.Value
    $allowed = @(
        "schemaVersion", "validatedAt", "schoolPilotAppSha", "schoolPilotImageDigest",
        "classPilotTag", "classPilotMergeSha", "classPilotZipSha256", "turnEvidenceSha256", "checks"
    )
    Assert-ExactProperties -Value $evidence -Allowed $allowed -Trail "synthetic validation evidence"
    $present = @($evidence.PSObject.Properties.Name)
    if (@($allowed | Where-Object { $present -cnotcontains $_ }).Count -ne 0) {
        throw "Synthetic validation evidence is incomplete."
    }
    if (-not (Test-IsJsonInteger -Value $evidence.schemaVersion) -or [long]$evidence.schemaVersion -ne 1) {
        throw "Synthetic validation evidence schemaVersion must be the integer 1."
    }
    foreach ($name in @(
        "validatedAt", "schoolPilotAppSha", "schoolPilotImageDigest", "classPilotTag",
        "classPilotMergeSha", "classPilotZipSha256", "turnEvidenceSha256"
    )) {
        if ($evidence.$name -isnot [string]) { throw "Synthetic validation evidence is incomplete." }
    }
    $validatedAt = Get-FreshEvidenceTimestamp -Value ([string]$evidence.validatedAt) `
        -Label "Synthetic validation evidence" -Now $Now
    if ([string]$evidence.schoolPilotAppSha -cne $AppSha -or
        [string]$evidence.schoolPilotImageDigest -cne $ImageDigest -or
        [string]$evidence.classPilotTag -cne $script:ClassPilotReleaseTag -or
        [string]$evidence.classPilotMergeSha -cne $script:ClassPilotMergeSha -or
        [string]$evidence.classPilotZipSha256 -cne $script:ClassPilotZipSha256 -or
        [string]$evidence.turnEvidenceSha256 -cne $TurnEvidenceSha256) {
        throw "Synthetic validation evidence does not bind the exact reviewed release and TURN evidence."
    }
    $requiredChecks = @(
        "crossRepositoryContractPassed", "unpackedZipPassed", "identityTransitions10000Passed",
        "redisCrossProcessPassed", "allCapabilitiesSimultaneousPassed", "protocol2CompatibilityPassed",
        "markerless270LegacyPassed"
    )
    Assert-ExactProperties -Value $evidence.checks -Allowed $requiredChecks -Trail "synthetic validation evidence.checks"
    $presentChecks = @($evidence.checks.PSObject.Properties.Name)
    if (@($requiredChecks | Where-Object { $presentChecks -cnotcontains $_ }).Count -ne 0) {
        throw "Synthetic validation evidence is incomplete."
    }
    foreach ($name in $requiredChecks) {
        $value = $evidence.checks.$name
        if ($value -isnot [bool] -or -not $value) {
            throw "Synthetic validation evidence is incomplete."
        }
    }
    return [pscustomobject]@{
        ValidatedAt = $validatedAt
        EvidenceSha256 = [string]$EvidenceSnapshot.Sha256
    }
}

function Assert-ManagedTestWaiverEvidence {
    param(
        [Parameter(Mandatory = $true)]$EvidenceSnapshot,
        [Parameter(Mandatory = $true)][string]$SyntheticValidationSha256,
        [Parameter(Mandatory = $true)][string]$TurnEvidenceSha256,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    $evidence = $EvidenceSnapshot.Value
    $allowed = @(
        "schemaVersion", "approvedAt", "approvedBy", "reason", "syntheticValidationSha256",
        "turnEvidenceSha256", "managedValidation", "validationLevel"
    )
    Assert-ExactProperties -Value $evidence -Allowed $allowed -Trail "managed test waiver"
    $present = @($evidence.PSObject.Properties.Name)
    if (@($allowed | Where-Object { $present -cnotcontains $_ }).Count -ne 0) {
        throw "Managed test waiver is incomplete."
    }
    if (-not (Test-IsJsonInteger -Value $evidence.schemaVersion) -or [long]$evidence.schemaVersion -ne 1) {
        throw "Managed test waiver schemaVersion must be the integer 1."
    }
    foreach ($name in @(
        "approvedAt", "approvedBy", "reason", "syntheticValidationSha256", "turnEvidenceSha256",
        "managedValidation", "validationLevel"
    )) {
        if ($evidence.$name -isnot [string]) { throw "Managed test waiver is incomplete." }
    }
    $approvedAt = Get-FreshEvidenceTimestamp -Value ([string]$evidence.approvedAt) `
        -Label "Managed test waiver" -Now $Now
    if ([string]$evidence.approvedBy -cne "bzinkan@school-pilot.net" -or
        [string]$evidence.syntheticValidationSha256 -cne $SyntheticValidationSha256 -or
        [string]$evidence.turnEvidenceSha256 -cne $TurnEvidenceSha256 -or
        [string]$evidence.managedValidation -cne "waived_not_passed" -or
        [string]$evidence.validationLevel -cne "synthetic_only") {
        throw "Managed test waiver does not bind the exact approved synthetic-only activation evidence."
    }
    $reason = [string]$evidence.reason
    if ([string]::IsNullOrWhiteSpace($reason) -or $reason.Length -gt 1000) {
        throw "Managed test waiver requires a bounded non-empty reason."
    }
    return [pscustomobject]@{
        ApprovedAt = $approvedAt
        EvidenceSha256 = [string]$EvidenceSnapshot.Sha256
        ValidationLevel = "synthetic_only"
        ManagedValidation = "waived_not_passed"
    }
}

function Assert-TrackingWindowPilotEvidence {
    param(
        [Parameter(Mandatory = $true)]$EvidenceSnapshot,
        [Parameter(Mandatory = $true)][string]$PilotSchoolId,
        [Parameter(Mandatory = $true)][string]$ToolSha,
        [Parameter(Mandatory = $true)][string]$AppSha,
        [Parameter(Mandatory = $true)][string]$ImageDigest,
        [Parameter(Mandatory = $true)][string]$ApiTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$WorkerTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$RuntimeConfigurationSha256,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    $evidence = $EvidenceSnapshot.Value
    $allowed = @(
        "schemaVersion", "validatedAt", "observedFrom", "observedThrough", "pilotSchoolId",
        "schoolPilotToolSha", "schoolPilotAppSha", "schoolPilotImageDigest", "pilotApiTaskDefinitionArn",
        "pilotWorkerTaskDefinitionArn", "pilotRuntimeConfigurationSha256", "checks"
    )
    Assert-ExactProperties -Value $evidence -Allowed $allowed -Trail "tracking-window pilot evidence"
    $present = @($evidence.PSObject.Properties.Name)
    if (@($allowed | Where-Object { $present -cnotcontains $_ }).Count -ne 0) {
        throw "Tracking-window pilot evidence is incomplete."
    }
    if (-not (Test-IsJsonInteger -Value $evidence.schemaVersion) -or [long]$evidence.schemaVersion -ne 2) {
        throw "Tracking-window pilot evidence schemaVersion must be the integer 2."
    }
    foreach ($name in @(
        "validatedAt", "observedFrom", "observedThrough", "pilotSchoolId", "schoolPilotToolSha", "schoolPilotAppSha",
        "schoolPilotImageDigest", "pilotApiTaskDefinitionArn", "pilotWorkerTaskDefinitionArn",
        "pilotRuntimeConfigurationSha256"
    )) {
        if ($evidence.$name -isnot [string]) { throw "Tracking-window pilot evidence is incomplete." }
    }
    $validatedAtText = Get-FreshEvidenceTimestamp -Value ([string]$evidence.validatedAt) `
        -Label "Tracking-window pilot evidence" -Now $Now
    try {
        $validatedAt = [DateTimeOffset]::ParseExact(
            $validatedAtText, "o", [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        $observedFrom = [DateTimeOffset]::ParseExact(
            [string]$evidence.observedFrom, "o", [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        $observedThrough = [DateTimeOffset]::ParseExact(
            [string]$evidence.observedThrough, "o", [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch {
        throw "Tracking-window pilot observation timestamps must use exact ISO-8601 values."
    }
    $observationDuration = $observedThrough - $observedFrom
    $evidenceLag = $validatedAt - $observedThrough
    if ($observationDuration.TotalMinutes -lt 30 -or $observationDuration.TotalHours -gt 24 -or
        $evidenceLag.TotalMinutes -lt 0 -or $evidenceLag.TotalMinutes -gt 30) {
        throw "Tracking-window pilot evidence does not cover the reviewed recent observation window."
    }
    if ([string]$evidence.pilotSchoolId -cne $PilotSchoolId -or
        [string]$evidence.schoolPilotToolSha -cne $ToolSha -or
        [string]$evidence.schoolPilotAppSha -cne $AppSha -or
        [string]$evidence.schoolPilotImageDigest -cne $ImageDigest -or
        [string]$evidence.pilotApiTaskDefinitionArn -cne $ApiTaskDefinitionArn -or
        [string]$evidence.pilotWorkerTaskDefinitionArn -cne $WorkerTaskDefinitionArn -or
        [string]$evidence.pilotRuntimeConfigurationSha256 -cne $RuntimeConfigurationSha256) {
        throw "Tracking-window pilot evidence does not bind the exact pilot deployment authority."
    }
    $requiredChecks = @(
        "fullSchoolActivityWindowObserved", "managedCapabilityNegotiated",
        "teacherTabSwitchingPassed", "adminObserveTabSwitchingPassed",
        "newScreenshotWithinThirtySecondsPassed", "authorizationPurgePassed",
        "zeroScreenshotStoreErrors", "screenshotLatencyWithinBudget",
        "noAuthorizationOrPrivacyDefects"
    )
    Assert-ExactProperties -Value $evidence.checks -Allowed $requiredChecks `
        -Trail "tracking-window pilot evidence.checks"
    $presentChecks = @($evidence.checks.PSObject.Properties.Name)
    if (@($requiredChecks | Where-Object { $presentChecks -cnotcontains $_ }).Count -ne 0) {
        throw "Tracking-window pilot evidence checks are incomplete."
    }
    foreach ($name in $requiredChecks) {
        $value = $evidence.checks.$name
        if ($value -isnot [bool] -or -not $value) {
            throw "Tracking-window pilot evidence checks are incomplete."
        }
    }
    return [pscustomobject]@{
        ValidatedAt = $validatedAt.ToUniversalTime().ToString("o")
        ObservedFrom = $observedFrom.ToUniversalTime().ToString("o")
        ObservedThrough = $observedThrough.ToUniversalTime().ToString("o")
        EvidenceSha256 = [string]$EvidenceSnapshot.Sha256
    }
}

function Assert-StudentGatePilotEvidence {
    param(
        [Parameter(Mandatory = $true)]$EvidenceSnapshot,
        [Parameter(Mandatory = $true)][string]$PilotSchoolId,
        [Parameter(Mandatory = $true)][string]$ToolSha,
        [Parameter(Mandatory = $true)][string]$AppSha,
        [Parameter(Mandatory = $true)][string]$ImageDigest,
        [Parameter(Mandatory = $true)][string]$ApiTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$WorkerTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$RuntimeConfigurationSha256,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    $evidence = $EvidenceSnapshot.Value
    $allowed = @(
        "schemaVersion", "validatedAt", "observedFrom", "observedThrough", "pilotSchoolId",
        "schoolPilotToolSha", "schoolPilotAppSha", "schoolPilotImageDigest", "pilotApiTaskDefinitionArn",
        "pilotWorkerTaskDefinitionArn", "pilotRuntimeConfigurationSha256", "checks"
    )
    Assert-ExactProperties -Value $evidence -Allowed $allowed -Trail "student-gate pilot evidence"
    $present = @($evidence.PSObject.Properties.Name)
    if (@($allowed | Where-Object { $present -cnotcontains $_ }).Count -ne 0) {
        throw "Student-gate pilot evidence is incomplete."
    }
    if (-not (Test-IsJsonInteger -Value $evidence.schemaVersion) -or [long]$evidence.schemaVersion -ne 1) {
        throw "Student-gate pilot evidence schemaVersion must be the integer 1."
    }
    foreach ($name in @(
        "validatedAt", "observedFrom", "observedThrough", "pilotSchoolId", "schoolPilotToolSha", "schoolPilotAppSha",
        "schoolPilotImageDigest", "pilotApiTaskDefinitionArn", "pilotWorkerTaskDefinitionArn",
        "pilotRuntimeConfigurationSha256"
    )) {
        if ($evidence.$name -isnot [string]) { throw "Student-gate pilot evidence is incomplete." }
    }
    $validatedAtText = Get-FreshEvidenceTimestamp -Value ([string]$evidence.validatedAt) `
        -Label "Student-gate pilot evidence" -Now $Now
    try {
        $validatedAt = [DateTimeOffset]::ParseExact(
            $validatedAtText, "o", [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        $observedFrom = [DateTimeOffset]::ParseExact(
            [string]$evidence.observedFrom, "o", [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        $observedThrough = [DateTimeOffset]::ParseExact(
            [string]$evidence.observedThrough, "o", [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch {
        throw "Student-gate pilot observation timestamps must use exact ISO-8601 values."
    }
    $observationDuration = $observedThrough - $observedFrom
    $evidenceLag = $validatedAt - $observedThrough
    if ($observationDuration.TotalMinutes -lt 30 -or $observationDuration.TotalHours -gt 24 -or
        $evidenceLag.TotalMinutes -lt 0 -or $evidenceLag.TotalMinutes -gt 30) {
        throw "Student-gate pilot evidence does not cover the reviewed recent observation window."
    }
    if ([string]$evidence.pilotSchoolId -cne $PilotSchoolId -or
        [string]$evidence.schoolPilotToolSha -cne $ToolSha -or
        [string]$evidence.schoolPilotAppSha -cne $AppSha -or
        [string]$evidence.schoolPilotImageDigest -cne $ImageDigest -or
        [string]$evidence.pilotApiTaskDefinitionArn -cne $ApiTaskDefinitionArn -or
        [string]$evidence.pilotWorkerTaskDefinitionArn -cne $WorkerTaskDefinitionArn -or
        [string]$evidence.pilotRuntimeConfigurationSha256 -cne $RuntimeConfigurationSha256) {
        throw "Student-gate pilot evidence does not bind the exact pilot deployment authority."
    }
    $requiredChecks = @(
        "fullSchoolActivityWindowObserved", "managedCapabilityNegotiated",
        "freshActiveStudentHidden", "sameChromebookResumePassed",
        "crossChromebookPlainNamePassed", "correctPinTransferPassed",
        "wrongPinPreservedSession", "cancelSignOutHeartbeatRehides",
        "concurrentTransferSingleWinner", "runtimeAndRosterErrorsWithinBudget",
        "noAuthorizationOrPrivacyDefects"
    )
    Assert-ExactProperties -Value $evidence.checks -Allowed $requiredChecks `
        -Trail "student-gate pilot evidence.checks"
    $presentChecks = @($evidence.checks.PSObject.Properties.Name)
    if (@($requiredChecks | Where-Object { $presentChecks -cnotcontains $_ }).Count -ne 0) {
        throw "Student-gate pilot evidence checks are incomplete."
    }
    foreach ($name in $requiredChecks) {
        $value = $evidence.checks.$name
        if ($value -isnot [bool] -or -not $value) {
            throw "Student-gate pilot evidence checks are incomplete."
        }
    }
    return [pscustomobject]@{
        ValidatedAt = $validatedAt.ToUniversalTime().ToString("o")
        ObservedFrom = $observedFrom.ToUniversalTime().ToString("o")
        ObservedThrough = $observedThrough.ToUniversalTime().ToString("o")
        EvidenceSha256 = [string]$EvidenceSnapshot.Sha256
    }
}

function Get-RuntimeConfigurationSha256 {
    param([Parameter(Mandatory = $true)]$RuntimeConfiguration)
    $identity = [ordered]@{
        mode = [string]$RuntimeConfiguration.Mode
        schoolScopeCount = [int]$RuntimeConfiguration.SchoolScopeCount
        enabledCapabilities = @($RuntimeConfiguration.EnabledCapabilities)
        environment = $RuntimeConfiguration.Environment
        turn = if ($null -eq $RuntimeConfiguration.Turn) {
            $null
        }
        else {
            [ordered]@{
                hosts = @($RuntimeConfiguration.Turn.Hosts)
                secretArn = [string]$RuntimeConfiguration.Turn.SecretArn
            }
        }
    }
    return Get-CanonicalJsonSha256 -Value $identity
}

function Invoke-AwsJson {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    if ($env:SCHOOLPILOT_RUNTIME_CONFIG_TEST_MODE -ceq "I_UNDERSTAND_TEST_ONLY") {
        $handler = Get-Variable -Name SchoolPilotRuntimeConfigAwsHandler -Scope Global -ErrorAction SilentlyContinue
        if ($null -ne $handler -and $null -ne $handler.Value) {
            return & $handler.Value $Arguments
        }
    }
    $effectiveArguments = @($Arguments)
    if ($effectiveArguments -notcontains "--cli-connect-timeout") {
        $effectiveArguments += @("--cli-connect-timeout", "10")
    }
    if ($effectiveArguments -notcontains "--cli-read-timeout") {
        $effectiveArguments += @("--cli-read-timeout", "30")
    }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "aws"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment["AWS_PAGER"] = ""
    foreach ($argument in $effectiveArguments) { [void]$startInfo.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "AWS CLI did not start." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(45000)) {
            try { $process.Kill($true) } catch {}
            try { [void]$process.WaitForExit(5000) } catch {}
            try { [void]$stdoutTask.GetAwaiter().GetResult() } catch {}
            try { [void]$stderrTask.GetAwaiter().GetResult() } catch {}
            throw "AWS command timed out without applying a proven terminal result."
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "AWS command failed without applying a safe terminal result." }
    }
    catch {
        if ($_.Exception.Message -like "AWS command*") { throw }
        throw "AWS command failed without applying a safe terminal result."
    }
    finally { $process.Dispose() }
    $text = ([string]$stdout).Trim()
    if (-not $text) { return $null }
    return $text | ConvertFrom-Json -Depth 50 -DateKind String
}

function Write-PrivateAwsJsonInput {
    param([Parameter(Mandatory = $true)]$Value)
    $path = Join-Path ([IO.Path]::GetTempPath()) ("schoolpilot-runtime-aws-" + [Guid]::NewGuid().ToString("N") + ".json")
    [IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Depth 20 -Compress), $script:Utf8NoBom)
    Set-PrivatePathPermissions -Path $path
    return $path
}

function Assert-OperationLockTable {
    $response = Invoke-AwsJson -Arguments @(
        "dynamodb", "describe-table", "--table-name", $script:OperationLockTable,
        "--region", $script:Region, "--output", "json", "--no-cli-pager"
    )
    $keys = @($response.Table.KeySchema)
    if ([string]$response.Table.TableStatus -cne "ACTIVE" -or $keys.Count -ne 1 -or
        [string]$keys[0].AttributeName -cne "LockID" -or [string]$keys[0].KeyType -cne "HASH") {
        throw "The production operation-lock table does not match the reviewed contract."
    }
}

function Get-OperationLockItem {
    $keyPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        LockID = [ordered]@{ S = $script:OperationLockId }
    })
    try {
        return Invoke-AwsJson -Arguments @(
            "dynamodb", "get-item", "--table-name", $script:OperationLockTable,
            "--key", ("file://" + $keyPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--consistent-read", "--region", $script:Region, "--output", "json", "--no-cli-pager"
        )
    }
    finally { Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue }
}

function Get-OperationLockEpochSeconds {
    if ($env:SCHOOLPILOT_RUNTIME_CONFIG_TEST_MODE -ceq "I_UNDERSTAND_TEST_ONLY") {
        $handler = Get-Variable -Name SchoolPilotRuntimeConfigLeaseClockHandler -Scope Global -ErrorAction SilentlyContinue
        if ($null -ne $handler -and $null -ne $handler.Value) {
            return [long](& $handler.Value)
        }
    }
    return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
}

function Assert-OperationLockOwned {
    if (-not $script:OperationLockHeld -or [string]::IsNullOrWhiteSpace([string]$script:OperationLockOwner)) {
        throw "This process does not own the production runtime-config operation lock."
    }
    $response = Get-OperationLockItem
    $now = Get-OperationLockEpochSeconds
    if ($null -eq $response.Item -or [string]$response.Item.LockID.S -cne $script:OperationLockId -or
        [string]$response.Item.OwnerToken.S -cne [string]$script:OperationLockOwner -or
        [long]$response.Item.FenceToken.N -ne [long]$script:OperationLockFence -or
        [string]$response.Item.OperationState.S -cne [string]$script:OperationLockState -or
        [long]$response.Item.LeaseExpiresAt.N -le $now) {
        throw "The production runtime-config operation lock is no longer owned by this process."
    }
    $script:OperationLockExpiresAt = [long]$response.Item.LeaseExpiresAt.N
}

function Acquire-OperationLock {
    param(
        [Parameter(Mandatory = $true)][string]$RunId,
        [Parameter(Mandatory = $true)][string]$PlanSha256
    )
    if ($script:OperationLockHeld) { throw "This process already owns a runtime-config operation lock." }
    Assert-OperationLockTable
    $owner = $RunId + "-" + [Guid]::NewGuid().ToString("N")
    $now = Get-OperationLockEpochSeconds
    $expiresAt = $now + $script:OperationLockLeaseSeconds
    $keyPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        LockID = [ordered]@{ S = $script:OperationLockId }
    })
    $valuesPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        ":owner" = [ordered]@{ S = $owner }
        ":plan" = [ordered]@{ S = $PlanSha256 }
        ":now" = [ordered]@{ N = [string]$now }
        ":expires" = [ordered]@{ N = [string]$expiresAt }
        ":one" = [ordered]@{ N = "1" }
        ":preparing" = [ordered]@{ S = "preparing" }
        ":released" = [ordered]@{ S = "released" }
        ":terminal" = [ordered]@{ S = "terminal_safe" }
    })
    try {
        $response = Invoke-AwsJson -Arguments @(
            "dynamodb", "update-item", "--table-name", $script:OperationLockTable,
            "--key", ("file://" + $keyPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--condition-expression", "attribute_not_exists(LockID) OR (LeaseExpiresAt <= :now AND OperationState IN (:released, :preparing, :terminal))",
            "--update-expression", "SET OwnerToken = :owner, PlanSha256 = :plan, AcquiredAt = :now, LeaseExpiresAt = :expires, OperationState = :preparing REMOVE MutationStartedAt, TerminalSafeAt, ReleasedAt ADD FenceToken :one",
            "--expression-attribute-values", ("file://" + $valuesPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--return-values", "ALL_NEW",
            "--region", $script:Region, "--output", "json", "--no-cli-pager"
        )
    }
    finally {
        Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $valuesPath -Force -ErrorAction SilentlyContinue
    }
    if ([string]$response.Attributes.OwnerToken.S -cne $owner -or
        [long]$response.Attributes.LeaseExpiresAt.N -ne $expiresAt -or
        [string]$response.Attributes.OperationState.S -cne "preparing" -or
        [long]$response.Attributes.FenceToken.N -lt 1) {
        throw "The production runtime-config operation lease did not return an exact fence."
    }
    $script:OperationLockOwner = $owner
    $script:OperationLockFence = [long]$response.Attributes.FenceToken.N
    $script:OperationLockExpiresAt = $expiresAt
    $script:OperationLockState = "preparing"
    $script:OperationLockHeld = $true
    Assert-OperationLockOwned
}

function Start-OperationMutationWindow {
    if (-not $script:OperationLockHeld -or [string]$script:OperationLockState -cne "preparing") {
        throw "The production operation lease is not in the exact preparing state."
    }
    $now = Get-OperationLockEpochSeconds
    $expiresAt = $now + $script:OperationLockLeaseSeconds
    $keyPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        LockID = [ordered]@{ S = $script:OperationLockId }
    })
    $valuesPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        ":owner" = [ordered]@{ S = [string]$script:OperationLockOwner }
        ":fence" = [ordered]@{ N = [string]$script:OperationLockFence }
        ":now" = [ordered]@{ N = [string]$now }
        ":expires" = [ordered]@{ N = [string]$expiresAt }
        ":preparing" = [ordered]@{ S = "preparing" }
        ":mutating" = [ordered]@{ S = "mutating" }
    })
    try {
        $response = Invoke-AwsJson -Arguments @(
            "dynamodb", "update-item", "--table-name", $script:OperationLockTable,
            "--key", ("file://" + $keyPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--condition-expression", "OwnerToken = :owner AND FenceToken = :fence AND LeaseExpiresAt > :now AND OperationState = :preparing",
            "--update-expression", "SET OperationState = :mutating, MutationStartedAt = :now, LeaseExpiresAt = :expires",
            "--expression-attribute-values", ("file://" + $valuesPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--return-values", "ALL_NEW",
            "--region", $script:Region, "--output", "json", "--no-cli-pager"
        )
    }
    finally {
        Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $valuesPath -Force -ErrorAction SilentlyContinue
    }
    if ([string]$response.Attributes.OwnerToken.S -cne [string]$script:OperationLockOwner -or
        [long]$response.Attributes.FenceToken.N -ne [long]$script:OperationLockFence -or
        [long]$response.Attributes.LeaseExpiresAt.N -ne $expiresAt -or
        [string]$response.Attributes.OperationState.S -cne "mutating") {
        throw "The production operation mutation window did not acquire an exact durable fence."
    }
    $script:OperationLockExpiresAt = $expiresAt
    $script:OperationLockState = "mutating"
}

function Complete-OperationMutationWindow {
    if (-not $script:OperationLockHeld -or [string]$script:OperationLockState -cne "mutating") {
        throw "The production operation lease is not in the exact mutating state."
    }
    $now = Get-OperationLockEpochSeconds
    $expiresAt = $now + $script:OperationLockLeaseSeconds
    $keyPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        LockID = [ordered]@{ S = $script:OperationLockId }
    })
    $valuesPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        ":owner" = [ordered]@{ S = [string]$script:OperationLockOwner }
        ":fence" = [ordered]@{ N = [string]$script:OperationLockFence }
        ":now" = [ordered]@{ N = [string]$now }
        ":expires" = [ordered]@{ N = [string]$expiresAt }
        ":mutating" = [ordered]@{ S = "mutating" }
        ":terminal" = [ordered]@{ S = "terminal_safe" }
    })
    try {
        $response = Invoke-AwsJson -Arguments @(
            "dynamodb", "update-item", "--table-name", $script:OperationLockTable,
            "--key", ("file://" + $keyPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--condition-expression", "OwnerToken = :owner AND FenceToken = :fence AND LeaseExpiresAt > :now AND OperationState = :mutating",
            "--update-expression", "SET OperationState = :terminal, TerminalSafeAt = :now, LeaseExpiresAt = :expires",
            "--expression-attribute-values", ("file://" + $valuesPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--return-values", "ALL_NEW",
            "--region", $script:Region, "--output", "json", "--no-cli-pager"
        )
    }
    finally {
        Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $valuesPath -Force -ErrorAction SilentlyContinue
    }
    if ([string]$response.Attributes.OwnerToken.S -cne [string]$script:OperationLockOwner -or
        [long]$response.Attributes.FenceToken.N -ne [long]$script:OperationLockFence -or
        [long]$response.Attributes.LeaseExpiresAt.N -ne $expiresAt -or
        [string]$response.Attributes.OperationState.S -cne "terminal_safe") {
        throw "The production operation lease did not record an exact terminal-safe state."
    }
    $script:OperationLockExpiresAt = $expiresAt
    $script:OperationLockState = "terminal_safe"
}

function Renew-OperationLock {
    Assert-OperationLockOwned
    $keyPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        LockID = [ordered]@{ S = $script:OperationLockId }
    })
    $now = Get-OperationLockEpochSeconds
    $expiresAt = $now + $script:OperationLockLeaseSeconds
    $valuesPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        ":owner" = [ordered]@{ S = [string]$script:OperationLockOwner }
        ":fence" = [ordered]@{ N = [string]$script:OperationLockFence }
        ":now" = [ordered]@{ N = [string]$now }
        ":expires" = [ordered]@{ N = [string]$expiresAt }
        ":state" = [ordered]@{ S = [string]$script:OperationLockState }
    })
    try {
        $response = Invoke-AwsJson -Arguments @(
            "dynamodb", "update-item", "--table-name", $script:OperationLockTable,
            "--key", ("file://" + $keyPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--condition-expression", "OwnerToken = :owner AND FenceToken = :fence AND LeaseExpiresAt > :now AND OperationState = :state",
            "--update-expression", "SET LeaseExpiresAt = :expires",
            "--expression-attribute-values", ("file://" + $valuesPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--return-values", "ALL_NEW",
            "--region", $script:Region, "--output", "json", "--no-cli-pager"
        )
    }
    finally {
        Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $valuesPath -Force -ErrorAction SilentlyContinue
    }
    if ([string]$response.Attributes.OwnerToken.S -cne [string]$script:OperationLockOwner -or
        [long]$response.Attributes.FenceToken.N -ne [long]$script:OperationLockFence -or
        [long]$response.Attributes.LeaseExpiresAt.N -ne $expiresAt -or
        [string]$response.Attributes.OperationState.S -cne [string]$script:OperationLockState) {
        throw "The production runtime-config operation lease renewal did not converge exactly."
    }
    $script:OperationLockExpiresAt = $expiresAt
}

function Maintain-OperationLock {
    Assert-OperationLockOwned
    $now = Get-OperationLockEpochSeconds
    if ($script:OperationLockExpiresAt - $now -le 180) { Renew-OperationLock }
}

function Release-OperationLock {
    Assert-OperationLockOwned
    $keyPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        LockID = [ordered]@{ S = $script:OperationLockId }
    })
    $now = Get-OperationLockEpochSeconds
    $valuesPath = Write-PrivateAwsJsonInput -Value ([ordered]@{
        ":owner" = [ordered]@{ S = [string]$script:OperationLockOwner }
        ":fence" = [ordered]@{ N = [string]$script:OperationLockFence }
        ":now" = [ordered]@{ N = [string]$now }
        ":zero" = [ordered]@{ N = "0" }
        ":released" = [ordered]@{ S = "released" }
        ":terminal" = [ordered]@{ S = "terminal_safe" }
    })
    try {
        [void](Invoke-AwsJson -Arguments @(
            "dynamodb", "update-item", "--table-name", $script:OperationLockTable,
            "--key", ("file://" + $keyPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--condition-expression", "OwnerToken = :owner AND FenceToken = :fence AND LeaseExpiresAt > :now AND OperationState = :terminal",
            "--update-expression", "SET OwnerToken = :released, LeaseExpiresAt = :zero, ReleasedAt = :now, OperationState = :released REMOVE PlanSha256, AcquiredAt, MutationStartedAt, TerminalSafeAt",
            "--expression-attribute-values", ("file://" + $valuesPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)),
            "--region", $script:Region, "--output", "json", "--no-cli-pager"
        ))
        $script:OperationLockHeld = $false
        $script:OperationLockOwner = $null
        $script:OperationLockFence = $null
        $script:OperationLockExpiresAt = 0L
        $script:OperationLockState = $null
    }
    finally {
        Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $valuesPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-GitText {
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [Parameter(Mandatory = $true)][string]$RepositoryRoot)
    if ($env:SCHOOLPILOT_RUNTIME_CONFIG_TEST_MODE -ceq "I_UNDERSTAND_TEST_ONLY" -and
        $null -ne $global:SchoolPilotRuntimeConfigGitHandler) {
        return [string](& $global:SchoolPilotRuntimeConfigGitHandler $Arguments)
    }
    $output = & git -C $RepositoryRoot @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Git deployment identity check failed." }
    return ($output | Out-String).Trim()
}

function Get-RepositoryHeadSha {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)
    $head = Invoke-GitText -Arguments @("rev-parse", "HEAD") -RepositoryRoot $RepositoryRoot
    if ($head -cnotmatch '^[0-9a-f]{40}$') {
        throw "Reviewed runtime-tool SHA must be a full lowercase commit SHA."
    }
    return $head
}

function Assert-RepositoryIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [string]$ExpectedSha
    )
    if ($ExpectedSha -and $ExpectedSha -cnotmatch '^[0-9a-f]{40}$') {
        throw "Expected runtime-tool SHA must be a full lowercase commit SHA."
    }
    $branch = Invoke-GitText -Arguments @("branch", "--show-current") -RepositoryRoot $RepositoryRoot
    $head = Get-RepositoryHeadSha -RepositoryRoot $RepositoryRoot
    $originMain = Invoke-GitText -Arguments @("rev-parse", "origin/main") -RepositoryRoot $RepositoryRoot
    $dirty = Invoke-GitText -Arguments @("status", "--porcelain") -RepositoryRoot $RepositoryRoot
    if ($originMain -cnotmatch '^[0-9a-f]{40}$' -or $branch -cne "main" -or
        $head -cne $originMain -or ($ExpectedSha -and $head -cne $ExpectedSha) -or $dirty) {
        throw "Runtime configuration deployment requires clean main exactly equal to origin/main and the reviewed runtime-tool SHA."
    }
    return $head
}

function Get-EasternNow {
    param([DateTimeOffset]$UtcNow = [DateTimeOffset]::UtcNow)
    $zone = $null
    foreach ($zoneId in @("Eastern Standard Time", "America/New_York")) {
        try { $zone = [TimeZoneInfo]::FindSystemTimeZoneById($zoneId); break } catch {}
    }
    if ($null -eq $zone) { throw "America/New_York timezone data is unavailable." }
    return [TimeZoneInfo]::ConvertTime($UtcNow, $zone)
}

function Assert-ProductionDeploymentWindow {
    param([DateTimeOffset]$NowEastern = (Get-EasternNow))
    if ($NowEastern.DayOfWeek -in @([DayOfWeek]::Monday, [DayOfWeek]::Tuesday, [DayOfWeek]::Wednesday, [DayOfWeek]::Thursday, [DayOfWeek]::Friday)) {
        $minutes = $NowEastern.Hour * 60 + $NowEastern.Minute
        if ($minutes -ge (4 * 60 + 45) -and $minutes -le (10 * 60 + 14)) {
            throw "Production runtime configuration is blocked during the weekday arrival scaling window."
        }
    }
}

function Assert-RuntimeConfigMutationWindow {
    param(
        [DateTimeOffset]$NowEastern = (Get-EasternNow),
        [switch]$ConfirmProtectedWindowProductionMutation
    )
    $isWeekday = $NowEastern.DayOfWeek -in @(
        [DayOfWeek]::Monday, [DayOfWeek]::Tuesday, [DayOfWeek]::Wednesday,
        [DayOfWeek]::Thursday, [DayOfWeek]::Friday
    )
    $minutes = $NowEastern.Hour * 60 + $NowEastern.Minute
    $isProtectedWindow = $isWeekday -and $minutes -ge (4 * 60 + 45) -and $minutes -le (10 * 60 + 14)
    if ($ConfirmProtectedWindowProductionMutation) {
        if (-not $isProtectedWindow) {
            throw "Protected-window runtime configuration confirmation is valid only weekdays 04:45-10:14 America/New_York."
        }
    } elseif ($isProtectedWindow) {
        throw "Production runtime configuration is blocked during the weekday arrival scaling window."
    }
}

function Get-ServiceSnapshot {
    $response = Invoke-AwsJson -Arguments @(
        "ecs", "describe-services", "--cluster", $script:Cluster,
        "--services", $script:ApiService, $script:WorkerService,
        "--region", $script:Region, "--output", "json", "--no-cli-pager"
    )
    if (@($response.failures).Count -ne 0 -or @($response.services).Count -ne 2) {
        throw "Both production ECS services must resolve exactly."
    }
    $api = @($response.services | Where-Object serviceName -CEQ $script:ApiService)
    $worker = @($response.services | Where-Object serviceName -CEQ $script:WorkerService)
    if ($api.Count -ne 1 -or $worker.Count -ne 1) { throw "Production ECS service identity is ambiguous." }
    return [pscustomobject]@{ Api = $api[0]; Worker = $worker[0] }
}

function Get-ApiTargetGroupArn {
    param([Parameter(Mandatory = $true)]$ApiService)
    $loadBalancers = @($ApiService.loadBalancers)
    if ($loadBalancers.Count -ne 1) {
        throw "Production API must have exactly one reviewed ALB target group."
    }
    $arn = [string]$loadBalancers[0].targetGroupArn
    if ($arn -cnotmatch '^arn:aws:elasticloadbalancing:us-east-1:135775632425:targetgroup/[A-Za-z0-9-]+/[a-f0-9]+$') {
        throw "Production API target-group identity is malformed."
    }
    return $arn
}

function Get-ApiHealthyTargetCount {
    param([Parameter(Mandatory = $true)]$ApiService)
    $targetGroupArn = Get-ApiTargetGroupArn -ApiService $ApiService
    $response = Invoke-AwsJson -Arguments @(
        "elbv2", "describe-target-health", "--target-group-arn", $targetGroupArn,
        "--region", $script:Region, "--output", "json", "--no-cli-pager"
    )
    return @($response.TargetHealthDescriptions | Where-Object {
        [string]$_.TargetHealth.State -ceq "healthy"
    }).Count
}

function Assert-ApiTargetHealth {
    param(
        [Parameter(Mandatory = $true)]$ApiService,
        [Parameter(Mandatory = $true)][ValidateRange(1, 6)][int]$ExpectedDesiredCount,
        [ValidateSet("Exact", "Converging")][string]$Mode = "Exact"
    )
    $healthy = Get-ApiHealthyTargetCount -ApiService $ApiService
    $minimum = if ($Mode -ceq "Exact") { $ExpectedDesiredCount } else { [Math]::Max(1, $ExpectedDesiredCount - 1) }
    $maximum = if ($Mode -ceq "Converging" -and $ExpectedDesiredCount -eq 1) { 2 } else { $ExpectedDesiredCount }
    if ($healthy -lt $minimum -or $healthy -gt $maximum) {
        throw "Production API healthy targets left the reviewed runtime-config range."
    }
    return $healthy
}

function Assert-StableService {
    param(
        [Parameter(Mandatory = $true)]$Service,
        [Parameter(Mandatory = $true)][string]$ExpectedTaskDefinitionArn,
        [Parameter(Mandatory = $true)][int]$MinimumDesired,
        [Parameter(Mandatory = $true)][int]$MaximumDesired,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ([string]$Service.status -cne "ACTIVE" -or
        [string]$Service.deploymentController.type -cne "ECS" -or
        [int]$Service.desiredCount -lt $MinimumDesired -or [int]$Service.desiredCount -gt $MaximumDesired -or
        [int]$Service.runningCount -ne [int]$Service.desiredCount -or [int]$Service.pendingCount -ne 0 -or
        [string]$Service.taskDefinition -cne $ExpectedTaskDefinitionArn) {
        throw "$Label service is not at the exact stable release posture."
    }
    $deployments = @($Service.deployments)
    if ($deployments.Count -ne 1 -or [string]$deployments[0].status -cne "PRIMARY" -or
        [string]$deployments[0].rolloutState -cne "COMPLETED" -or
        [string]$deployments[0].taskDefinition -cne $ExpectedTaskDefinitionArn -or
        [int]$deployments[0].desiredCount -ne [int]$Service.desiredCount -or
        [int]$deployments[0].runningCount -ne [int]$Service.desiredCount -or
        [int]$deployments[0].pendingCount -ne 0 -or [int]$deployments[0].failedTasks -ne 0) {
        throw "$Label service deployment is not exactly converged."
    }
}

function Get-TaskDefinitionResponse {
    param([Parameter(Mandatory = $true)][string]$TaskDefinitionArn)
    return Invoke-AwsJson -Arguments @(
        "ecs", "describe-task-definition", "--task-definition", $TaskDefinitionArn,
        "--include", "TAGS", "--region", $script:Region, "--output", "json", "--no-cli-pager"
    )
}

function Assert-TaskDefinitionContract {
    param(
        [Parameter(Mandatory = $true)]$Response,
        [Parameter(Mandatory = $true)][string]$ExpectedArn,
        [Parameter(Mandatory = $true)][string]$ExpectedFamily,
        [Parameter(Mandatory = $true)][string]$ContainerName,
        [Parameter(Mandatory = $true)][string]$ExpectedDigest,
        [Parameter(Mandatory = $true)][string]$ExpectedCpu,
        [Parameter(Mandatory = $true)][string]$ExpectedMemory
    )
    $task = $Response.taskDefinition
    if ($null -eq $task -or [string]$task.taskDefinitionArn -cne $ExpectedArn -or
        [string]$task.status -cne "ACTIVE" -or [string]$task.family -cne $ExpectedFamily -or
        [string]$task.cpu -cne $ExpectedCpu -or [string]$task.memory -cne $ExpectedMemory) {
        throw "The exact source task definition has drifted from the reviewed release posture."
    }
    $containers = @($task.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($containers.Count -ne 1 -or [string]$containers[0].image -cne "135775632425.dkr.ecr.us-east-1.amazonaws.com/$($script:EcrRepository)@$ExpectedDigest") {
        throw "The exact source task definition is not pinned to the expected image digest."
    }
    if ($containers[0].PSObject.Properties.Name -contains "memory" -and [int]$containers[0].memory -lt [int]$ExpectedMemory) {
        throw "The runtime container retains a lower hard memory ceiling."
    }
    return $containers[0]
}

function Assert-TurnAwsReadiness {
    param([Parameter(Mandatory = $true)]$RuntimeConfiguration)
    if ($null -eq $RuntimeConfiguration.Turn) { return }
    $instancesResponse = Invoke-AwsJson -Arguments @(
        "ec2", "describe-instances", "--filters", "Name=tag:Role,Values=classpilot-turn",
        "Name=instance-state-name,Values=running", "--region", $script:Region,
        "--output", "json", "--no-cli-pager"
    )
    $instances = @($instancesResponse.Reservations | ForEach-Object { @($_.Instances) })
    if ($instances.Count -ne 2 -or @($instances.Placement.AvailabilityZone | Sort-Object -Unique).Count -ne 2) {
        throw "TURN requires exactly two running nodes in distinct availability zones."
    }
    $instanceIds = @($instances.InstanceId)
    $statusArguments = @(
        "ec2", "describe-instance-status", "--instance-ids"
    ) + $instanceIds + @(
        "--include-all-instances", "--region", $script:Region,
        "--output", "json", "--no-cli-pager"
    )
    $statusResponse = Invoke-AwsJson -Arguments $statusArguments
    $statuses = @($statusResponse.InstanceStatuses)
    if ($statuses.Count -ne 2 -or @($statuses | Where-Object {
        [string]$_.InstanceState.Name -cne "running" -or [string]$_.InstanceStatus.Status -cne "ok" -or [string]$_.SystemStatus.Status -cne "ok"
    }).Count -ne 0) {
        throw "Both TURN node and system status checks must be healthy."
    }
    $secret = Invoke-AwsJson -Arguments @(
        "secretsmanager", "describe-secret", "--secret-id", $RuntimeConfiguration.Turn.SecretArn,
        "--region", $script:Region, "--output", "json", "--no-cli-pager"
    )
    if ([string]$secret.ARN -cne [string]$RuntimeConfiguration.Turn.SecretArn -or
        ($secret.PSObject.Properties.Name -contains "DeletedDate" -and $null -ne $secret.DeletedDate)) {
        throw "The exact TURN REST secret is unavailable."
    }
}

function Get-ScalingSnapshot {
    $response = Invoke-AwsJson -Arguments @(
        "application-autoscaling", "describe-scalable-targets", "--service-namespace", "ecs",
        "--resource-ids", "service/$($script:Cluster)/$($script:ApiService)",
        "--scalable-dimension", "ecs:service:DesiredCount", "--region", $script:Region,
        "--output", "json", "--no-cli-pager"
    )
    $targets = @($response.ScalableTargets)
    if ($targets.Count -ne 1 -or [int]$targets[0].MinCapacity -notin @(1, 6) -or [int]$targets[0].MaxCapacity -ne 6) {
        throw "API autoscaling must retain the reviewed scheduled 1-or-6 minimum and six-task ceiling."
    }
    return [pscustomobject]@{
        Min = [int]$targets[0].MinCapacity
        Max = [int]$targets[0].MaxCapacity
        DynamicIn = [bool]$targets[0].SuspendedState.DynamicScalingInSuspended
        DynamicOut = [bool]$targets[0].SuspendedState.DynamicScalingOutSuspended
        Scheduled = [bool]$targets[0].SuspendedState.ScheduledScalingSuspended
    }
}

function Assert-ScheduledScalingContract {
    $response = Invoke-AwsJson -Arguments @(
        "application-autoscaling", "describe-scheduled-actions", "--service-namespace", "ecs",
        "--resource-id", "service/$($script:Cluster)/$($script:ApiService)",
        "--scalable-dimension", "ecs:service:DesiredCount", "--region", $script:Region,
        "--output", "json", "--no-cli-pager"
    )
    $actions = @($response.ScheduledActions)
    $up = @($actions | Where-Object ScheduledActionName -CEQ "schoolpilot-production-api-arrival-scale-up")
    $down = @($actions | Where-Object ScheduledActionName -CEQ "schoolpilot-production-api-arrival-scale-down")
    $upMaximum = if ($up.Count -eq 1 -and $up[0].ScalableTargetAction.PSObject.Properties.Name -contains "MaxCapacity") {
        $up[0].ScalableTargetAction.MaxCapacity
    } else { $null }
    $downMaximum = if ($down.Count -eq 1 -and $down[0].ScalableTargetAction.PSObject.Properties.Name -contains "MaxCapacity") {
        $down[0].ScalableTargetAction.MaxCapacity
    } else { $null }
    if ($actions.Count -ne 2 -or $up.Count -ne 1 -or $down.Count -ne 1 -or
        [string]$up[0].Schedule -cne "cron(45 5 ? * MON-FRI *)" -or [string]$up[0].Timezone -cne "America/New_York" -or
        [int]$up[0].ScalableTargetAction.MinCapacity -ne 6 -or
        [string]$down[0].Schedule -cne "cron(0 10 ? * MON-FRI *)" -or [string]$down[0].Timezone -cne "America/New_York" -or
        [int]$down[0].ScalableTargetAction.MinCapacity -ne 1 -or
        ($null -ne $upMaximum -and [int]$upMaximum -ne 6) -or
        ($null -ne $downMaximum -and [int]$downMaximum -ne 6) -or
        ($up[0].PSObject.Properties.Name -contains "StartTime" -and $null -ne $up[0].StartTime) -or
        ($up[0].PSObject.Properties.Name -contains "EndTime" -and $null -ne $up[0].EndTime) -or
        ($down[0].PSObject.Properties.Name -contains "StartTime" -and $null -ne $down[0].StartTime) -or
        ($down[0].PSObject.Properties.Name -contains "EndTime" -and $null -ne $down[0].EndTime)) {
        throw "Arrival scheduled scaling has drifted from the reviewed contract."
    }
}

function Set-ScalingSuspension {
    param([Parameter(Mandatory = $true)]$State)
    Maintain-OperationLock
    $suspended = "DynamicScalingInSuspended=$($State.DynamicIn.ToString().ToLowerInvariant()),DynamicScalingOutSuspended=$($State.DynamicOut.ToString().ToLowerInvariant()),ScheduledScalingSuspended=$($State.Scheduled.ToString().ToLowerInvariant())"
    [void](Invoke-AwsJson -Arguments @(
        "application-autoscaling", "register-scalable-target", "--service-namespace", "ecs",
        "--resource-id", "service/$($script:Cluster)/$($script:ApiService)",
        "--scalable-dimension", "ecs:service:DesiredCount", "--min-capacity", ([string]$State.Min),
        "--max-capacity", ([string]$State.Max), "--suspended-state", $suspended,
        "--region", $script:Region, "--output", "json", "--no-cli-pager"
    ))
}

function Get-ScheduledApiMinimum {
    param([Parameter(Mandatory = $true)][DateTimeOffset]$NowEastern)
    $weekday = $NowEastern.DayOfWeek -notin @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)
    $time = $NowEastern.TimeOfDay
    if ($weekday -and $time -ge [TimeSpan]::FromHours(5.75) -and $time -lt [TimeSpan]::FromHours(10)) {
        return 6
    }
    return 1
}

function Acquire-ScalingHold {
    $prior = Get-ScalingSnapshot
    if ($prior.DynamicIn -or $prior.DynamicOut -or $prior.Scheduled) {
        throw "Autoscaling is already suspended by another operation."
    }
    $hold = [pscustomobject]@{ Min = $prior.Min; Max = $prior.Max; DynamicIn = $true; DynamicOut = $true; Scheduled = $true }
    $script:PriorScalingState = $prior
    $script:ScalingHoldAcquired = $true
    Set-ScalingSuspension -State $hold
    $observed = Get-ScalingSnapshot
    foreach ($name in @("Min", "Max", "DynamicIn", "DynamicOut", "Scheduled")) {
        if ($observed.$name -ne $hold.$name) {
            throw "The API autoscaling hold did not converge exactly."
        }
    }
    if (-not $observed.DynamicIn -or -not $observed.DynamicOut -or -not $observed.Scheduled) {
        throw "The API autoscaling hold did not converge exactly."
    }
    return $prior
}

function Assert-ScalingHoldExact {
    $observed = Get-ScalingSnapshot
    $expected = [pscustomobject]@{
        Min = $script:PriorScalingState.Min
        Max = $script:PriorScalingState.Max
        DynamicIn = $true
        DynamicOut = $true
        Scheduled = $true
    }
    foreach ($name in @("Min", "Max", "DynamicIn", "DynamicOut", "Scheduled")) {
        if ($observed.$name -ne $expected.$name) {
            throw "The frozen autoscaling target drifted before service mutation."
        }
    }
    return $observed
}

function Sync-ScalingHoldExact {
    $hold = [pscustomobject]@{
        Min = $script:PriorScalingState.Min
        Max = $script:PriorScalingState.Max
        DynamicIn = $true
        DynamicOut = $true
        Scheduled = $true
    }
    Set-ScalingSuspension -State $hold
    return Assert-ScalingHoldExact
}

function Copy-EcsDeploymentConfiguration {
    param([Parameter(Mandatory = $true)]$DeploymentConfiguration)
    $allowedFields = @(
        "deploymentCircuitBreaker", "maximumPercent", "minimumHealthyPercent", "alarms", "strategy",
        "bakeTimeInMinutes", "lifecycleHooks", "linearConfiguration", "canaryConfiguration"
    )
    $unexpectedFields = @($DeploymentConfiguration.PSObject.Properties.Name | Where-Object { $_ -cnotin $allowedFields })
    if ($unexpectedFields.Count -ne 0) {
        throw "ECS deployment configuration contains an unreviewed field."
    }
    $copy = [ordered]@{}
    foreach ($field in $allowedFields) {
        $member = $DeploymentConfiguration.PSObject.Properties[$field]
        if ($null -ne $member -and $null -ne $member.Value) {
            $copy[$field] = ConvertTo-CanonicalValue -Value $member.Value
        }
    }
    if (-not $copy.Contains("minimumHealthyPercent") -or -not $copy.Contains("maximumPercent") -or
        -not $copy.Contains("strategy") -or [string]$copy.strategy -cne "ROLLING") {
        throw "Runtime-config deployment requires an explicit ECS ROLLING strategy and exact healthy percentages."
    }
    $minimum = [int]$copy.minimumHealthyPercent
    $maximum = [int]$copy.maximumPercent
    if ($minimum -lt 0 -or $minimum -gt 100 -or $maximum -lt 100 -or $maximum -gt 200 -or $minimum -gt $maximum) {
        throw "ECS rolling deployment bounds are outside the reviewed range."
    }
    if (-not $copy.Contains("deploymentCircuitBreaker") -or
        $copy.deploymentCircuitBreaker.enable -isnot [bool] -or
        $copy.deploymentCircuitBreaker.rollback -isnot [bool] -or
        -not $copy.deploymentCircuitBreaker.enable -or -not $copy.deploymentCircuitBreaker.rollback) {
        throw "Runtime-config deployment requires the reviewed enabled rollback circuit breaker."
    }
    return $copy
}

function Assert-NormalServiceDeploymentConfiguration {
    param([Parameter(Mandatory = $true)]$Service)
    $configuration = Copy-EcsDeploymentConfiguration -DeploymentConfiguration $Service.deploymentConfiguration
    $expectedFields = @("deploymentCircuitBreaker", "maximumPercent", "minimumHealthyPercent", "strategy", "bakeTimeInMinutes")
    $actualFields = @($configuration.Keys)
    if (@($actualFields | Where-Object { $_ -cnotin $expectedFields }).Count -ne 0 -or
        @($expectedFields | Where-Object { $_ -cnotin $actualFields }).Count -ne 0 -or
        [int]$configuration.minimumHealthyPercent -ne 100 -or
        [int]$configuration.maximumPercent -ne 200 -or
        [string]$configuration.strategy -cne "ROLLING" -or
        [int]$configuration.bakeTimeInMinutes -ne 0) {
        throw "Feature activation requires the exact reviewed 100/200 ECS rolling configuration."
    }
}

function Get-ServiceDeploymentBounds {
    param([Parameter(Mandatory = $true)]$Service)
    $configuration = Copy-EcsDeploymentConfiguration -DeploymentConfiguration $Service.deploymentConfiguration
    return [pscustomobject]@{
        Minimum = [int]$configuration.minimumHealthyPercent
        Maximum = [int]$configuration.maximumPercent
    }
}

function Get-ServiceDeploymentConfigurationSha256 {
    param([Parameter(Mandatory = $true)]$Service)
    return Get-CanonicalJsonSha256 -Value (Copy-EcsDeploymentConfiguration -DeploymentConfiguration $Service.deploymentConfiguration)
}

function Set-ServiceDeploymentConfiguration {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("api", "worker")][string]$Role,
        [Parameter(Mandatory = $true)]$Configuration
    )
    Maintain-OperationLock
    $service = if ($Role -ceq "api") { $script:ApiService } else { $script:WorkerService }
    $safeConfiguration = Copy-EcsDeploymentConfiguration -DeploymentConfiguration ([pscustomobject]$Configuration)
    $temporaryPath = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-runtime-deployment-$([Guid]::NewGuid().ToString('N')).json"
    try {
        [IO.File]::WriteAllText($temporaryPath, ($safeConfiguration | ConvertTo-Json -Depth 60), $script:Utf8NoBom)
        $awsInputPath = "file://" + $temporaryPath.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        [void](Invoke-AwsJson -Arguments @(
            "ecs", "update-service", "--cluster", $script:Cluster, "--service", $service,
            "--deployment-configuration", $awsInputPath,
            "--region", $script:Region, "--output", "json", "--no-cli-pager"
        ))
    }
    finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Assert-ServicePairDeploymentConfigurations {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)]$ExpectedSha256
    )
    $observed = [pscustomobject]@{
        Api = Get-ServiceDeploymentConfigurationSha256 -Service $Snapshot.Api
        Worker = Get-ServiceDeploymentConfigurationSha256 -Service $Snapshot.Worker
    }
    if ([string]$observed.Api -cne [string]$ExpectedSha256.Api -or
        [string]$observed.Worker -cne [string]$ExpectedSha256.Worker) {
        throw "ECS deployment configuration drifted from the exact reviewed pair."
    }
    return $observed
}

function Assert-ServicePairDeploymentBounds {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)]$Expected
    )
    $api = Get-ServiceDeploymentBounds -Service $Snapshot.Api
    $worker = Get-ServiceDeploymentBounds -Service $Snapshot.Worker
    foreach ($name in @("Minimum", "Maximum")) {
        if ($api.$name -ne $Expected.Api.$name -or $worker.$name -ne $Expected.Worker.$name) {
            throw "ECS rolling deployment bounds did not converge exactly."
        }
    }
}

function Set-OffContainmentDeploymentConfigurations {
    param(
        [Parameter(Mandatory = $true)]$PriorConfigurations,
        [Parameter(Mandatory = $true)][ValidateRange(1, 6)][int]$ApiDesiredCount
    )
    if ($ApiDesiredCount -eq 1) {
        $apiMinimum = 100
        $apiMaximum = 200
    }
    else {
        $apiMinimum = [int][Math]::Floor((($ApiDesiredCount - 1) * 100) / $ApiDesiredCount)
        $apiMaximum = 100
    }
    $apiConfiguration = Copy-EcsDeploymentConfiguration -DeploymentConfiguration ([pscustomobject]$PriorConfigurations.Api)
    $apiConfiguration.minimumHealthyPercent = $apiMinimum
    $apiConfiguration.maximumPercent = $apiMaximum
    $workerConfiguration = Copy-EcsDeploymentConfiguration -DeploymentConfiguration ([pscustomobject]$PriorConfigurations.Worker)
    $workerConfiguration.minimumHealthyPercent = 0
    $workerConfiguration.maximumPercent = 100
    Set-ServiceDeploymentConfiguration -Role api -Configuration $apiConfiguration
    Set-ServiceDeploymentConfiguration -Role worker -Configuration $workerConfiguration
    $expected = [pscustomobject]@{
        Api = Get-CanonicalJsonSha256 -Value $apiConfiguration
        Worker = Get-CanonicalJsonSha256 -Value $workerConfiguration
    }
    [void](Assert-ServicePairDeploymentConfigurations -Snapshot (Get-ServiceSnapshot) -ExpectedSha256 $expected)
    return [pscustomobject]@{
        Api = [pscustomobject]@{ Minimum = $apiMinimum; Maximum = $apiMaximum }
        Worker = [pscustomobject]@{ Minimum = 0; Maximum = 100 }
    }
}

function Acquire-OffContainmentDeploymentBounds {
    param([Parameter(Mandatory = $true)]$Snapshot)
    $priorConfigurations = [pscustomobject]@{
        Api = Copy-EcsDeploymentConfiguration -DeploymentConfiguration $Snapshot.Api.deploymentConfiguration
        Worker = Copy-EcsDeploymentConfiguration -DeploymentConfiguration $Snapshot.Worker.deploymentConfiguration
    }
    $prior = [pscustomobject]@{
        Api = Get-ServiceDeploymentBounds -Service $Snapshot.Api
        Worker = Get-ServiceDeploymentBounds -Service $Snapshot.Worker
    }
    $script:PriorDeploymentConfigurations = $priorConfigurations
    $script:PriorDeploymentBounds = $prior
    $script:DeploymentBoundsChanged = $true
    $apiDesiredCount = [int]$Snapshot.Api.desiredCount
    if ($apiDesiredCount -lt 1 -or $apiDesiredCount -gt 6) {
        throw "Emergency containment requires an API desired count from one through six."
    }
    [void](Set-OffContainmentDeploymentConfigurations -PriorConfigurations $priorConfigurations `
        -ApiDesiredCount $apiDesiredCount)
}

function Restore-OffContainmentDeploymentBounds {
    if (-not $script:DeploymentBoundsChanged) { return }
    Set-ServiceDeploymentConfiguration -Role api -Configuration $script:PriorDeploymentConfigurations.Api
    Set-ServiceDeploymentConfiguration -Role worker -Configuration $script:PriorDeploymentConfigurations.Worker
    $expected = [pscustomobject]@{
        Api = Get-CanonicalJsonSha256 -Value $script:PriorDeploymentConfigurations.Api
        Worker = Get-CanonicalJsonSha256 -Value $script:PriorDeploymentConfigurations.Worker
    }
    [void](Assert-ServicePairDeploymentConfigurations -Snapshot (Get-ServiceSnapshot) -ExpectedSha256 $expected)
    $script:DeploymentBoundsChanged = $false
}

function Get-CurrentDeploymentEasternTime {
    if ($env:SCHOOLPILOT_RUNTIME_CONFIG_TEST_MODE -ceq "I_UNDERSTAND_TEST_ONLY") {
        $handler = Get-Variable -Name SchoolPilotRuntimeConfigClockHandler -Scope Global -ErrorAction SilentlyContinue
        if ($null -ne $handler -and $null -ne $handler.Value) {
            return [DateTimeOffset](& $handler.Value)
        }
    }
    return Get-EasternNow
}

function Restore-ScalingHold {
    if (-not $script:ScalingHoldAcquired) {
        throw "This process cannot restore an autoscaling hold it does not own."
    }
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        $stageMinimum = Get-ScheduledApiMinimum -NowEastern (Get-CurrentDeploymentEasternTime)
        $stagedState = [pscustomobject]@{
            Min = $stageMinimum
            Max = $script:PriorScalingState.Max
            DynamicIn = $true
            DynamicOut = $true
            Scheduled = $true
        }
        Set-ScalingSuspension -State $stagedState
        $stagedObserved = Get-ScalingSnapshot
        foreach ($name in @("Min", "Max", "DynamicIn", "DynamicOut", "Scheduled")) {
            if ($stagedObserved.$name -ne $stagedState.$name) {
                throw "Autoscaling restoration could not stage the scheduled production state."
            }
        }
        if ($stageMinimum -eq 6) {
            [void](Wait-ApiCapacityExact -ExpectedDesiredCount 6)
        }
        $releaseMinimum = Get-ScheduledApiMinimum -NowEastern (Get-CurrentDeploymentEasternTime)
        if ($releaseMinimum -ne $stageMinimum) { continue }
        $releaseState = [pscustomobject]@{
            Min = $releaseMinimum
            Max = $script:PriorScalingState.Max
            DynamicIn = $script:PriorScalingState.DynamicIn
            DynamicOut = $script:PriorScalingState.DynamicOut
            Scheduled = $script:PriorScalingState.Scheduled
        }
        Set-ScalingSuspension -State $releaseState
        $releasedObserved = Get-ScalingSnapshot
        $afterReleaseMinimum = Get-ScheduledApiMinimum -NowEastern (Get-CurrentDeploymentEasternTime)
        $releaseMatches = $afterReleaseMinimum -eq $releaseMinimum
        foreach ($name in @("Min", "Max", "DynamicIn", "DynamicOut", "Scheduled")) {
            if ($releasedObserved.$name -ne $releaseState.$name) { $releaseMatches = $false }
        }
        if ($releaseMatches) {
            $script:ScalingHoldAcquired = $false
            return $true
        }
        $reholdState = [pscustomobject]@{
            Min = $afterReleaseMinimum
            Max = $script:PriorScalingState.Max
            DynamicIn = $true
            DynamicOut = $true
            Scheduled = $true
        }
        Set-ScalingSuspension -State $reholdState
        $reheldObserved = Get-ScalingSnapshot
        foreach ($name in @("Min", "Max", "DynamicIn", "DynamicOut", "Scheduled")) {
            if ($reheldObserved.$name -ne $reholdState.$name) {
                throw "Autoscaling restoration could not re-establish the hold across a schedule boundary."
            }
        }
    }
    throw "Autoscaling restoration crossed the scheduled boundary repeatedly."
}

function Assert-CanonicalScalingReleased {
    $observed = Get-ScalingSnapshot
    $expectedMinimum = Get-ScheduledApiMinimum -NowEastern (Get-CurrentDeploymentEasternTime)
    if ($observed.Min -ne $expectedMinimum -or $observed.Max -ne 6 -or
        $observed.DynamicIn -or $observed.DynamicOut -or $observed.Scheduled) {
        throw "Production autoscaling is not at the exact released scheduled posture."
    }
    return $true
}

function Get-TaskFingerprint {
    param(
        [Parameter(Mandatory = $true)]$TaskDefinition,
        [Parameter(Mandatory = $true)][string]$ContainerName
    )
    $copy = $TaskDefinition | ConvertTo-Json -Depth 50 | ConvertFrom-Json -Depth 50
    foreach ($key in @("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities", "registeredAt", "registeredBy", "deregisteredAt", "tags")) {
        if ($copy.PSObject.Properties.Name -contains $key) { $copy.PSObject.Properties.Remove($key) }
    }
    $container = @($copy.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($container.Count -ne 1) { throw "Task definition must contain one exact runtime container." }
    $container[0].environment = @($container[0].environment | Where-Object { [string]$_.name -cnotin $script:AllowedEnvironmentNames } | Sort-Object name)
    $container[0].secrets = @($container[0].secrets | Where-Object { [string]$_.name -cnotin $script:AllowedSecretNames } | Sort-Object name)
    return Get-CanonicalJsonSha256 -Value $copy
}

function Get-ManagedRuntimeFingerprint {
    param(
        [Parameter(Mandatory = $true)]$TaskDefinition,
        [Parameter(Mandatory = $true)][string]$ContainerName
    )
    $containers = @($TaskDefinition.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($containers.Count -ne 1) { throw "The managed runtime container is ambiguous." }
    $container = $containers[0]
    $environment = @($container.environment)
    $secrets = @($container.secrets)
    if (@($environment.name | Group-Object -CaseSensitive | Where-Object Count -gt 1).Count -gt 0 -or
        @($secrets.name | Group-Object -CaseSensitive | Where-Object Count -gt 1).Count -gt 0) {
        throw "The source runtime task contains duplicate environment or secret names."
    }
    if (@($secrets | Where-Object { [string]$_.name -cin $script:AllowedEnvironmentNames }).Count -gt 0 -or
        @($environment | Where-Object name -CEQ "CLASSPILOT_TURN_REST_SECRET").Count -gt 0) {
        throw "ClassPilot runtime values use an unsafe environment/secret channel."
    }
    $managed = [ordered]@{
        environment = @($environment | Where-Object { [string]$_.name -cin $script:AllowedEnvironmentNames } |
            Sort-Object name | ForEach-Object { [ordered]@{ name = [string]$_.name; value = [string]$_.value } })
        secrets = @($secrets | Where-Object { [string]$_.name -cin $script:AllowedSecretNames } |
            Sort-Object name | ForEach-Object { [ordered]@{ name = [string]$_.name; valueFromSha256 = Get-Sha256Text -Value ([string]$_.valueFrom) } })
    }
    return Get-CanonicalJsonSha256 -Value $managed
}

function Get-RuntimeActivationState {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Environment,
        [switch]$AllowBaseline
    )
    $wrongCase = @($Environment | Where-Object {
        [string]$_.name -iin $script:RuntimeEnvironmentNames -and
        [string]$_.name -cnotin $script:RuntimeEnvironmentNames
    })
    if ($wrongCase.Count -ne 0) { throw "Runtime configuration contains a mis-cased managed environment name." }
    $managed = @($Environment | Where-Object { [string]$_.name -cin $script:RuntimeEnvironmentNames })
    if ($managed.Count -eq 0 -and $AllowBaseline) {
        return [pscustomobject]@{
            Mode = "baseline"; SchoolId = $null; PrefixCount = -1
            StudentGateMode = "off"; StudentGateSchoolId = $null
        }
    }
    $absentAdditiveCapabilities = @($script:AdditiveCapabilities | Where-Object {
        $flagName = [string]$script:CapabilityFlags[$_]
        $AllowBaseline -and @($managed | Where-Object name -CEQ $flagName).Count -eq 0
    })
    $absentAdditiveFlags = @($absentAdditiveCapabilities | ForEach-Object {
        [string]$script:CapabilityFlags[$_]
    })
    $expectedEnvironmentNames = @($script:RuntimeEnvironmentNames | Where-Object {
        $_ -cnotin $absentAdditiveFlags
    })
    if ($managed.Count -ne $expectedEnvironmentNames.Count -or
        @($expectedEnvironmentNames | Where-Object { $managed.name -cnotcontains $_ }).Count -ne 0 -or
        @($managed.name | Group-Object -CaseSensitive | Where-Object Count -ne 1).Count -ne 0) {
        throw "Active runtime configuration is partial or duplicated."
    }
    $values = @{}
    foreach ($entry in $managed) { $values[[string]$entry.name] = [string]$entry.value }
    foreach ($capability in $absentAdditiveCapabilities) {
        $values[[string]$script:CapabilityFlags[$capability]] = "false"
    }
    $protocol = $values.CLASSPILOT_PROTOCOL_V3_ENABLED
    if ($protocol -cnotin @("true", "false")) { throw "Active protocol mode is invalid." }
    $rollouts = ConvertFrom-StrictJsonText -Text $values.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON
    $expectedRolloutCapabilities = @($script:AllCapabilities | Where-Object {
        $_ -cnotin $absentAdditiveCapabilities
    })
    Assert-ExactProperties -Value $rollouts -Allowed $expectedRolloutCapabilities -Trail "active rollout registry"
    $presentCapabilities = @($rollouts.PSObject.Properties.Name)
    if (@($expectedRolloutCapabilities | Where-Object { $presentCapabilities -cnotcontains $_ }).Count -ne 0) {
        throw "Active rollout registry is incomplete."
    }
    foreach ($capability in $absentAdditiveCapabilities) {
        $rollouts | Add-Member -NotePropertyName $capability `
            -NotePropertyValue ([pscustomobject]@{ mode = "off" })
    }
    foreach ($capability in $script:AllCapabilities) {
        $entry = $rollouts.$capability
        Assert-ExactProperties -Value $entry -Allowed @("mode", "schoolIds") -Trail "active rollout entry"
        if ([string]$entry.mode -cnotin @("on", "off")) { throw "Active rollout mode is invalid." }
        if ([string]$entry.mode -ceq "off" -and $entry.PSObject.Properties.Name -contains "schoolIds") {
            throw "Disabled active rollout entries must not retain school scope."
        }
    }

    if ($protocol -ceq "false") {
        foreach ($capability in $script:AllCapabilities) {
            if ([string]$values[$script:CapabilityFlags[$capability]] -cne "false" -or
                [string]$rollouts.$capability.mode -cne "off") {
                throw "Protocol-off runtime configuration is not fully contained."
            }
        }
        return [pscustomobject]@{
            Mode = "off"; SchoolId = $null; PrefixCount = -1
            StudentGateMode = "off"; StudentGateSchoolId = $null
        }
    }

    foreach ($capability in $script:RepairedCapabilities) {
        if ([string]$values[$script:CapabilityFlags[$capability]] -cne "true") {
            throw "Protocol-on runtime configuration has a disabled repaired kill switch."
        }
    }
    if ([string]$values[$script:CapabilityFlags.kioskLaunchTicketV1] -cne "false" -or
        [string]$rollouts.kioskLaunchTicketV1.mode -cne "off") {
        throw "Superseded kiosk ticket V1 must remain disabled."
    }
    if ([string]$rollouts.scopedAuthorityChecksV1.mode -cne "on") {
        throw "Protocol-on runtime configuration requires the repaired authority marker."
    }
    $trackingWindowFlag = [string]$script:CapabilityFlags[$script:TrackingWindowCapability]
    $trackingWindowFlagValue = [string]$values[$trackingWindowFlag]
    $trackingWindowRollout = $rollouts.$($script:TrackingWindowCapability)
    if ($trackingWindowFlagValue -cnotin @("true", "false")) {
        throw "Tracking-window screenshot kill switch is invalid."
    }
    if ($trackingWindowFlagValue -ceq "false") {
        if ([string]$trackingWindowRollout.mode -cne "off" -or
            $trackingWindowRollout.PSObject.Properties.Name -contains "schoolIds") {
            throw "Tracking-window screenshots require both matching activation controls."
        }
    }
    elseif ([string]$trackingWindowRollout.mode -cne "on") {
        throw "Tracking-window screenshots require both matching activation controls."
    }

    $studentGateFlag = [string]$script:CapabilityFlags[$script:StudentGatePresenceCapability]
    $studentGateFlagValue = [string]$values[$studentGateFlag]
    $studentGateRollout = $rollouts.$($script:StudentGatePresenceCapability)
    if ($studentGateFlagValue -cnotin @("true", "false")) {
        throw "Student auth-gate presence kill switch is invalid."
    }
    $studentGateMode = "off"
    $studentGateSchoolId = $null
    if ($studentGateFlagValue -ceq "false") {
        if ([string]$studentGateRollout.mode -cne "off" -or
            $studentGateRollout.PSObject.Properties.Name -contains "schoolIds") {
            throw "Student auth-gate presence requires both matching activation controls."
        }
    }
    elseif ([string]$studentGateRollout.mode -cne "on") {
        throw "Student auth-gate presence requires both matching activation controls."
    }
    elseif (-not ($studentGateRollout.PSObject.Properties.Name -contains "schoolIds")) {
        $studentGateMode = "global-on"
    }
    else {
        if ($studentGateRollout.schoolIds -isnot [Array]) {
            throw "Student auth-gate pilot school scope must be an array."
        }
        $studentGateSchoolIds = @($studentGateRollout.schoolIds)
        if ($studentGateSchoolIds.Count -ne 1 -or
            [string]$studentGateSchoolIds[0] -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
            throw "Student auth-gate pilot runtime configuration has invalid school scope."
        }
        $studentGateMode = "pilot"
        $studentGateSchoolId = [string]$studentGateSchoolIds[0]
    }

    $markerSchoolIds = @()
    if ($rollouts.scopedAuthorityChecksV1.PSObject.Properties.Name -contains "schoolIds") {
        if ($rollouts.scopedAuthorityChecksV1.schoolIds -isnot [Array]) {
            throw "Test-school runtime configuration school scope must be an array."
        }
        $markerSchoolIds = @($rollouts.scopedAuthorityChecksV1.schoolIds)
    }
    if ($markerSchoolIds.Count -eq 0) {
        foreach ($capability in $script:RepairedCapabilities) {
            if ([string]$rollouts.$capability.mode -cne "on" -or
                $rollouts.$capability.PSObject.Properties.Name -contains "schoolIds") {
                throw "Global runtime configuration must enable every repaired capability without school scope."
            }
        }
        if ($trackingWindowFlagValue -ceq "false") {
            return [pscustomobject]@{
                Mode = "global-on"; SchoolId = $null; PrefixCount = $script:ActivationOrder.Count
                StudentGateMode = $studentGateMode; StudentGateSchoolId = $studentGateSchoolId
            }
        }
        if (-not ($trackingWindowRollout.PSObject.Properties.Name -contains "schoolIds")) {
            return [pscustomobject]@{
                Mode = "tracking-window-global-on"; SchoolId = $null; PrefixCount = $script:ActivationOrder.Count
                StudentGateMode = $studentGateMode; StudentGateSchoolId = $studentGateSchoolId
            }
        }
        if ($trackingWindowRollout.schoolIds -isnot [Array]) {
            throw "Tracking-window pilot school scope must be an array."
        }
        $trackingWindowSchoolIds = @($trackingWindowRollout.schoolIds)
        if ($trackingWindowSchoolIds.Count -ne 1 -or
            [string]$trackingWindowSchoolIds[0] -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
            throw "Tracking-window pilot runtime configuration has invalid school scope."
        }
        return [pscustomobject]@{
            Mode = "tracking-window-pilot"
            SchoolId = [string]$trackingWindowSchoolIds[0]
            PrefixCount = $script:ActivationOrder.Count
            StudentGateMode = $studentGateMode
            StudentGateSchoolId = $studentGateSchoolId
        }
    }

    if ($trackingWindowFlagValue -cne "false" -or $studentGateMode -cne "off") {
        throw "Test-school activation must keep additive capabilities disabled."
    }

    if ($markerSchoolIds.Count -ne 1 -or [string]$markerSchoolIds[0] -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
        throw "Test-school runtime configuration has invalid school scope."
    }
    $schoolId = [string]$markerSchoolIds[0]
    $prefixCount = 0
    $encounteredOff = $false
    foreach ($capability in $script:ActivationOrder) {
        $entry = $rollouts.$capability
        if ([string]$entry.mode -ceq "on") {
            if ($encounteredOff) { throw "Test-school runtime configuration skipped an activation step." }
            $schoolIds = @()
            if ($entry.PSObject.Properties.Name -contains "schoolIds") {
                if ($entry.schoolIds -isnot [Array]) { throw "Test-school runtime configuration school scope must be an array." }
                $schoolIds = @($entry.schoolIds)
            }
            if ($schoolIds.Count -ne 1 -or [string]$schoolIds[0] -cne $schoolId) {
                throw "Test-school runtime configuration changed school scope."
            }
            $prefixCount++
        }
        else { $encounteredOff = $true }
    }
    return [pscustomobject]@{
        Mode = "test-school"; SchoolId = $schoolId; PrefixCount = $prefixCount
        StudentGateMode = "off"; StudentGateSchoolId = $null
    }
}

function Assert-AllowedRuntimeTransition {
    param(
        [Parameter(Mandatory = $true)]$SourceTaskDefinition,
        [Parameter(Mandatory = $true)][string]$ContainerName,
        [Parameter(Mandatory = $true)]$TargetRuntimeConfiguration,
        [switch]$AllowSyntheticOnlyGlobalActivation
    )
    $sourceContainer = @($SourceTaskDefinition.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($sourceContainer.Count -ne 1) { throw "Source runtime container is ambiguous." }
    $source = Get-RuntimeActivationState -Environment @($sourceContainer[0].environment) -AllowBaseline
    $targetEnvironment = @($TargetRuntimeConfiguration.Environment.GetEnumerator() | ForEach-Object {
        [pscustomobject]@{ name = [string]$_.Key; value = [string]$_.Value }
    })
    $target = Get-RuntimeActivationState -Environment $targetEnvironment
    if ([string]$TargetRuntimeConfiguration.Mode -cin @(
        "student-gate-pilot", "student-gate-global-on", "student-gate-off"
    )) {
        if ([string]$source.Mode -cne [string]$target.Mode -or
            [string]$source.SchoolId -cne [string]$target.SchoolId -or
            [int]$source.PrefixCount -ne [int]$target.PrefixCount) {
            throw "Student-gate rollout must preserve the existing repaired and screenshot runtime state."
        }
        if ($TargetRuntimeConfiguration.PSObject.Properties.Name -contains "SourceMode" -and
            [string]$TargetRuntimeConfiguration.SourceMode -cne [string]$source.Mode) {
            throw "Student-gate rollout source identity changed after resolution."
        }
        if ([string]$TargetRuntimeConfiguration.Mode -ceq "student-gate-pilot") {
            if ([string]$source.StudentGateMode -cne "off" -or
                [string]$target.StudentGateMode -cne "pilot" -or
                [string]$target.StudentGateSchoolId -cne [string]$TargetRuntimeConfiguration.PilotSchoolId) {
                throw "Student-gate activation must begin with one exact school-scoped pilot."
            }
            return
        }
        if ([string]$TargetRuntimeConfiguration.Mode -ceq "student-gate-global-on") {
            if ([string]$source.StudentGateMode -cne "pilot" -or
                [string]$target.StudentGateMode -cne "global-on") {
                throw "Student-gate global activation must advance from the school-scoped pilot."
            }
            return
        }
        if ([string]$source.StudentGateMode -cnotin @("pilot", "global-on") -or
            [string]$target.StudentGateMode -cne "off") {
            throw "Student-gate rollback requires an active student-gate rollout."
        }
        return
    }
    if ([string]$target.Mode -cin @("tracking-window-pilot", "tracking-window-global-on") -and
        [string]$source.StudentGateMode -cne "off") {
        throw "Tracking-window transitions require student auth-gate presence to be disabled independently first."
    }
    if ($target.Mode -ceq "off") { return }
    if ($target.Mode -ceq "test-school") {
        if ($source.Mode -cin @("baseline", "off")) {
            if ($target.PrefixCount -ne 0) { throw "Runtime activation must begin with the repaired marker only." }
            return
        }
        if ($source.Mode -cne "test-school" -or [string]$source.SchoolId -cne [string]$target.SchoolId -or
            $target.PrefixCount -ne ($source.PrefixCount + 1)) {
            throw "Runtime activation must advance exactly one step for the same test school."
        }
        return
    }
    if ($target.Mode -ceq "global-on" -and $source.Mode -ceq "test-school" -and
        $source.PrefixCount -eq $script:ActivationOrder.Count) {
        return
    }
    if ($target.Mode -ceq "global-on" -and
        $source.Mode -cin @("tracking-window-pilot", "tracking-window-global-on")) {
        return
    }
    if ($target.Mode -ceq "global-on" -and $AllowSyntheticOnlyGlobalActivation -and
        $source.Mode -cin @("baseline", "off", "test-school")) {
        return
    }
    if ($target.Mode -ceq "tracking-window-pilot" -and $source.Mode -ceq "global-on") {
        return
    }
    if ($target.Mode -ceq "tracking-window-global-on" -and $source.Mode -ceq "tracking-window-pilot") {
        return
    }
    throw "Runtime activation does not follow the reviewed staged transition."
}

function Get-TaskTagsFingerprint {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()]$Tags)
    $normalized = @($Tags | Sort-Object key | ForEach-Object {
        [ordered]@{ key = [string]$_.key; value = [string]$_.value }
    })
    if ($normalized.Count -eq 0) {
        return Get-Sha256Text -Value "[]"
    }
    return Get-CanonicalJsonSha256 -Value $normalized
}

function New-RuntimeTaskDefinitionRequest {
    param(
        [Parameter(Mandatory = $true)]$SourceResponse,
        [Parameter(Mandatory = $true)]$RuntimeConfiguration,
        [Parameter(Mandatory = $true)][string]$ExpectedDigest,
        [Parameter(Mandatory = $true)][string]$ExpectedArn,
        [Parameter(Mandatory = $true)][string]$ExpectedFamily,
        [Parameter(Mandatory = $true)][string]$ContainerName,
        [Parameter(Mandatory = $true)][string]$ExpectedCpu,
        [Parameter(Mandatory = $true)][string]$ExpectedMemory
    )
    $source = $SourceResponse.taskDefinition
    [void](Assert-TaskDefinitionContract -Response $SourceResponse -ExpectedArn $ExpectedArn `
        -ExpectedFamily $ExpectedFamily -ContainerName $ContainerName -ExpectedDigest $ExpectedDigest `
        -ExpectedCpu $ExpectedCpu -ExpectedMemory $ExpectedMemory)
    $sourceFingerprint = Get-TaskFingerprint -TaskDefinition $source -ContainerName $ContainerName
    $request = [ordered]@{}
    foreach ($name in @(
        "family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions",
        "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory",
        "runtimePlatform", "ephemeralStorage", "proxyConfiguration", "inferenceAccelerators",
        "pidMode", "ipcMode", "enableFaultInjection"
    )) {
        if ($source.PSObject.Properties.Name -contains $name -and $null -ne $source.$name) { $request[$name] = $source.$name }
    }
    if (@($SourceResponse.tags).Count -gt 0) { $request.tags = @($SourceResponse.tags) }
    $request = $request | ConvertTo-Json -Depth 50 | ConvertFrom-Json -Depth 50
    $container = @($request.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($container.Count -ne 1) { throw "Task clone has an ambiguous runtime container." }
    $target = $container[0]
    $existingEnvNames = @($target.environment | ForEach-Object { [string]$_.name })
    $existingSecretNames = @($target.secrets | ForEach-Object { [string]$_.name })
    if (@($existingEnvNames | Group-Object -CaseSensitive | Where-Object Count -gt 1).Count -gt 0 -or
        @($existingSecretNames | Group-Object -CaseSensitive | Where-Object Count -gt 1).Count -gt 0) {
        throw "Source task definition contains duplicate environment or secret names."
    }
    if ($existingEnvNames -ccontains "CLASSPILOT_TURN_REST_SECRET") {
        throw "TURN REST secret must never be inline environment data."
    }
    $environmentNamesToReplace = @($script:RuntimeEnvironmentNames)
    if ($null -ne $RuntimeConfiguration.Turn) { $environmentNamesToReplace += @($script:TurnEnvironmentNames) }
    $target.environment = @($target.environment | Where-Object { [string]$_.name -cnotin $environmentNamesToReplace })
    foreach ($entry in $RuntimeConfiguration.Environment.GetEnumerator()) {
        $target.environment += [pscustomobject]@{ name = [string]$entry.Key; value = [string]$entry.Value }
    }
    $target.environment = @($target.environment | Sort-Object name)
    if ($null -ne $RuntimeConfiguration.Turn) {
        $target.secrets = @($target.secrets | Where-Object { [string]$_.name -cnotin $script:AllowedSecretNames })
        $target.secrets += [pscustomobject]@{ name = "CLASSPILOT_TURN_REST_SECRET"; valueFrom = [string]$RuntimeConfiguration.Turn.SecretArn }
    }
    $target.secrets = @($target.secrets | Sort-Object name)
    if ((Get-TaskFingerprint -TaskDefinition $request -ContainerName $ContainerName) -cne $sourceFingerprint) {
        throw "Runtime configuration attempted a task mutation outside the allowlist."
    }
    return $request
}

function Register-RuntimeTaskDefinition {
    param(
        [Parameter(Mandatory = $true)]$Request,
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)]$RuntimeConfiguration,
        [Parameter(Mandatory = $true)][string]$ExpectedDigest,
        [Parameter(Mandatory = $true)][string]$SourceFingerprint,
        [Parameter(Mandatory = $true)][string]$SourceTagsFingerprint,
        [Parameter(Mandatory = $true)][string]$ExpectedFamily,
        [Parameter(Mandatory = $true)][string]$ContainerName,
        [Parameter(Mandatory = $true)][string]$ExpectedCpu,
        [Parameter(Mandatory = $true)][string]$ExpectedMemory
    )
    Maintain-OperationLock
    $path = Join-Path $Directory ("runtime-task-" + [Guid]::NewGuid().ToString("N") + ".json")
    [IO.File]::WriteAllText($path, ($Request | ConvertTo-Json -Depth 50), $script:Utf8NoBom)
    try {
        $awsInputPath = "file://" + $path.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        $response = Invoke-AwsJson -Arguments @(
            "ecs", "register-task-definition", "--cli-input-json", $awsInputPath,
            "--region", $script:Region, "--output", "json", "--no-cli-pager"
        )
        $arn = [string]$response.taskDefinition.taskDefinitionArn
        $familyPattern = [Regex]::Escape($ExpectedFamily)
        if ($arn -cnotmatch "^arn:aws:ecs:us-east-1:135775632425:task-definition/${familyPattern}:[1-9][0-9]*$") {
            throw "ECS returned an invalid runtime-config task definition."
        }
        $registered = Get-TaskDefinitionResponse -TaskDefinitionArn $arn
        [void](Assert-TaskDefinitionContract -Response $registered -ExpectedArn $arn -ExpectedFamily $ExpectedFamily `
            -ContainerName $ContainerName -ExpectedDigest $ExpectedDigest -ExpectedCpu $ExpectedCpu -ExpectedMemory $ExpectedMemory)
        if ((Get-TaskFingerprint -TaskDefinition $registered.taskDefinition -ContainerName $ContainerName) -cne $SourceFingerprint) {
            throw "Registered runtime task definition changed data outside the allowlist."
        }
        if ((Get-TaskTagsFingerprint -Tags @($registered.tags)) -cne $SourceTagsFingerprint) {
            throw "Registered runtime task definition changed its tags."
        }
        Assert-RuntimeTaskConfiguration -TaskDefinition $registered.taskDefinition -RuntimeConfiguration $RuntimeConfiguration -ContainerName $ContainerName
        return $arn
    }
    finally { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

function Assert-RuntimeTaskConfiguration {
    param(
        [Parameter(Mandatory = $true)]$TaskDefinition,
        [Parameter(Mandatory = $true)]$RuntimeConfiguration,
        [Parameter(Mandatory = $true)][string]$ContainerName
    )
    $container = @($TaskDefinition.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($container.Count -ne 1) { throw "Runtime task has an ambiguous runtime container." }
    $environment = @{}; foreach ($entry in @($container[0].environment)) {
        if ($environment.ContainsKey([string]$entry.name)) { throw "Runtime task contains duplicate environment names." }
        $environment[[string]$entry.name] = [string]$entry.value
    }
    foreach ($entry in $RuntimeConfiguration.Environment.GetEnumerator()) {
        if (-not $environment.ContainsKey([string]$entry.Key) -or $environment[[string]$entry.Key] -cne [string]$entry.Value) {
            throw "Registered runtime task does not contain the exact desired capability profile."
        }
    }
    $turnSecrets = @($container[0].secrets | Where-Object name -CEQ "CLASSPILOT_TURN_REST_SECRET")
    if ($null -ne $RuntimeConfiguration.Turn -and
        ($turnSecrets.Count -ne 1 -or [string]$turnSecrets[0].valueFrom -cne [string]$RuntimeConfiguration.Turn.SecretArn)) {
        throw "Runtime task does not contain the exact TURN secret reference."
    }
}

function Test-ServiceDeploymentComplete {
    param(
        [Parameter(Mandatory = $true)]$Service,
        [Parameter(Mandatory = $true)][string]$ExpectedTaskDefinitionArn,
        [Parameter(Mandatory = $true)][int]$ExpectedDesiredCount
    )
    $deployments = @($Service.deployments)
    return [string]$Service.taskDefinition -ceq $ExpectedTaskDefinitionArn -and
        [int]$Service.desiredCount -eq $ExpectedDesiredCount -and
        [int]$Service.runningCount -eq $ExpectedDesiredCount -and [int]$Service.pendingCount -eq 0 -and
        $deployments.Count -eq 1 -and [string]$deployments[0].status -ceq "PRIMARY" -and
        [string]$deployments[0].rolloutState -ceq "COMPLETED" -and
        [string]$deployments[0].taskDefinition -ceq $ExpectedTaskDefinitionArn -and
        [int]$deployments[0].desiredCount -eq $ExpectedDesiredCount -and
        [int]$deployments[0].runningCount -eq $ExpectedDesiredCount -and
        [int]$deployments[0].pendingCount -eq 0 -and [int]$deployments[0].failedTasks -eq 0
}

function Assert-RunningTasksExact {
    param(
        [Parameter(Mandatory = $true)][string]$ServiceName,
        [Parameter(Mandatory = $true)][string]$ExpectedTaskDefinitionArn,
        [Parameter(Mandatory = $true)][int]$ExpectedCount,
        [switch]$RequireHealthy
    )
    $list = Invoke-AwsJson -Arguments @(
        "ecs", "list-tasks", "--cluster", $script:Cluster, "--service-name", $ServiceName,
        "--desired-status", "RUNNING", "--region", $script:Region, "--output", "json", "--no-cli-pager"
    )
    $taskArns = @($list.taskArns)
    if ($taskArns.Count -ne $ExpectedCount) { throw "The exact running task count did not converge." }
    $tasks = Invoke-AwsJson -Arguments (@(
        "ecs", "describe-tasks", "--cluster", $script:Cluster, "--tasks"
    ) + $taskArns + @("--region", $script:Region, "--output", "json", "--no-cli-pager"))
    if (@($tasks.failures).Count -ne 0 -or @($tasks.tasks).Count -ne $taskArns.Count -or
        @($tasks.tasks | Where-Object {
            [string]$_.taskDefinitionArn -cne $ExpectedTaskDefinitionArn -or [string]$_.lastStatus -cne "RUNNING" -or
            ($RequireHealthy -and [string]$_.healthStatus -cne "HEALTHY")
        }).Count -ne 0) {
        throw "Every running service task must use the exact expected revision."
    }
}

function Wait-ExactServicePairConvergence {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedApiTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$ExpectedWorkerTaskDefinitionArn,
        [Parameter(Mandatory = $true)][ValidateRange(1, 6)][int]$ExpectedApiDesiredCount,
        [ValidateRange(1, 720)][int]$MaxAttempts = 720,
        [ValidateRange(0, 30)][int]$IntervalSeconds = 5,
        [ValidateRange(30, 3600)][int]$MaxWallClockSeconds = 3600
    )
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        Maintain-OperationLock
        if ($stopwatch.Elapsed.TotalSeconds -ge $MaxWallClockSeconds) {
            throw "Runtime-config service convergence exceeded its bounded safety deadline."
        }
        $snapshot = Get-ServiceSnapshot
        if ([int]$snapshot.Api.desiredCount -ne $ExpectedApiDesiredCount -or
            [int]$snapshot.Worker.desiredCount -ne 1) {
            throw "Service desired count drifted during runtime-config convergence."
        }
        [void](Assert-ApiTargetHealth -ApiService $snapshot.Api `
            -ExpectedDesiredCount $ExpectedApiDesiredCount -Mode Converging)
        $allDeployments = @($snapshot.Api.deployments) + @($snapshot.Worker.deployments)
        if (@($allDeployments | Where-Object { [int]$_.failedTasks -gt 0 -or [string]$_.rolloutState -ceq "FAILED" }).Count -gt 0) {
            throw "The runtime-config service deployment failed."
        }
        $apiComplete = Test-ServiceDeploymentComplete -Service $snapshot.Api `
            -ExpectedTaskDefinitionArn $ExpectedApiTaskDefinitionArn -ExpectedDesiredCount $ExpectedApiDesiredCount
        $workerComplete = Test-ServiceDeploymentComplete -Service $snapshot.Worker `
            -ExpectedTaskDefinitionArn $ExpectedWorkerTaskDefinitionArn -ExpectedDesiredCount 1
        if ($apiComplete -and $workerComplete) {
            [void](Assert-ApiTargetHealth -ApiService $snapshot.Api `
                -ExpectedDesiredCount $ExpectedApiDesiredCount -Mode Exact)
            Assert-RunningTasksExact -ServiceName $script:ApiService -ExpectedTaskDefinitionArn $ExpectedApiTaskDefinitionArn `
                -ExpectedCount $ExpectedApiDesiredCount -RequireHealthy
            Assert-RunningTasksExact -ServiceName $script:WorkerService -ExpectedTaskDefinitionArn $ExpectedWorkerTaskDefinitionArn `
                -ExpectedCount 1
            return $snapshot
        }
        if ($IntervalSeconds -gt 0) {
            $remainingSeconds = $MaxWallClockSeconds - $stopwatch.Elapsed.TotalSeconds
            if ($remainingSeconds -le 0) { throw "Runtime-config service convergence exceeded its bounded safety deadline." }
            Start-Sleep -Seconds ([Math]::Min($IntervalSeconds, [Math]::Floor($remainingSeconds)))
        }
    }
    throw "Runtime-config service convergence timed out."
}

function Wait-ApiCapacityExact {
    param(
        [Parameter(Mandatory = $true)][ValidateRange(1, 6)][int]$ExpectedDesiredCount,
        [ValidateRange(1, 720)][int]$MaxAttempts = 720,
        [ValidateRange(0, 30)][int]$IntervalSeconds = 5,
        [ValidateRange(30, 3600)][int]$MaxWallClockSeconds = 3600
    )
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $expectedTaskDefinitionArn = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        Maintain-OperationLock
        if ($stopwatch.Elapsed.TotalSeconds -ge $MaxWallClockSeconds) {
            throw "Runtime-config API capacity convergence exceeded its bounded safety deadline."
        }
        $snapshot = Get-ServiceSnapshot
        if ($null -eq $expectedTaskDefinitionArn) {
            $expectedTaskDefinitionArn = [string]$snapshot.Api.taskDefinition
        }
        if ([string]$snapshot.Api.taskDefinition -cne $expectedTaskDefinitionArn) {
            throw "API task definition drifted while restoring scheduled capacity."
        }
        if (Test-ServiceDeploymentComplete -Service $snapshot.Api `
                -ExpectedTaskDefinitionArn $expectedTaskDefinitionArn `
                -ExpectedDesiredCount $ExpectedDesiredCount) {
            [void](Assert-ApiTargetHealth -ApiService $snapshot.Api `
                -ExpectedDesiredCount $ExpectedDesiredCount -Mode Exact)
            Assert-RunningTasksExact -ServiceName $script:ApiService `
                -ExpectedTaskDefinitionArn $expectedTaskDefinitionArn `
                -ExpectedCount $ExpectedDesiredCount -RequireHealthy
            return $snapshot
        }
        if ($IntervalSeconds -gt 0) {
            $remainingSeconds = $MaxWallClockSeconds - $stopwatch.Elapsed.TotalSeconds
            if ($remainingSeconds -le 0) { throw "Runtime-config API capacity convergence exceeded its bounded safety deadline." }
            Start-Sleep -Seconds ([Math]::Min($IntervalSeconds, [Math]::Floor($remainingSeconds)))
        }
    }
    throw "Runtime-config API capacity convergence timed out."
}

function Invoke-RuntimeServiceUpdate {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("api", "worker")][string]$Role,
        [Parameter(Mandatory = $true)][string]$TaskDefinitionArn
    )
    Maintain-OperationLock
    $service = if ($Role -ceq "api") { $script:ApiService } else { $script:WorkerService }
    if ($Role -ceq "api") { $script:ApiServiceMutationStarted = $true } else { $script:WorkerServiceMutationStarted = $true }
    [void](Invoke-AwsJson -Arguments @(
        "ecs", "update-service", "--cluster", $script:Cluster, "--service", $service,
        "--task-definition", $TaskDefinitionArn, "--region", $script:Region,
        "--output", "json", "--no-cli-pager"
    ))
}

function Write-SanitizedJson {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    $temporaryPath = $Path + ".tmp-" + [Guid]::NewGuid().ToString("N")
    try {
        [IO.File]::WriteAllText($temporaryPath, ($Value | ConvertTo-Json -Depth 20), $script:Utf8NoBom)
        Set-PrivatePathPermissions -Path $temporaryPath
        [IO.File]::Move($temporaryPath, $Path, $true)
        Set-PrivatePathPermissions -Path $Path
    }
    finally { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
}

function Write-PrivateBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )
    $temporaryPath = $Path + ".tmp-" + [Guid]::NewGuid().ToString("N")
    try {
        [IO.File]::WriteAllBytes($temporaryPath, $Bytes)
        Set-PrivatePathPermissions -Path $temporaryPath
        [IO.File]::Move($temporaryPath, $Path, $true)
        Set-PrivatePathPermissions -Path $Path
    }
    finally { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
}

function Write-OperationCheckpoint {
    param(
        [Parameter(Mandatory = $true)]$Plan,
        [Parameter(Mandatory = $true)][string]$PlanSha256,
        [Parameter(Mandatory = $true)][ValidateSet(
            "apply_candidates_registered", "apply_scaling_hold_pending", "apply_scaling_hold_acquired",
            "apply_off_bounds_pending", "apply_off_bounds_acquired", "apply_off_bounds_restored",
            "apply_api_update_pending", "apply_worker_update_pending", "apply_pair_converged",
            "rollback_scaling_hold_pending", "rollback_scaling_hold_acquired", "rollback_api_update_pending",
            "rollback_worker_update_pending", "rollback_pair_converged", "rollback_candidate_recovery_pending",
            "rollback_candidate_pair_restored", "rollback_no_growth_bounds_pending",
            "rollback_no_growth_bounds_acquired", "rollback_no_growth_bounds_restored"
        )][string]$Stage,
        [string]$CandidateApiArn,
        [string]$CandidateWorkerArn
    )
    $checkpoint = [ordered]@{
        schemaVersion = 2
        runId = [string]$Plan.runId
        recordedAt = [DateTimeOffset]::UtcNow.ToString("o")
        stage = $Stage
        planSha256 = $PlanSha256
        validationLevel = [string]$Plan.validationLevel
        managedValidation = [string]$Plan.managedValidation
        protectedWindowProductionMutation = [bool]$Plan.protectedWindowProductionMutation
        toolSha = [string]$Plan.toolSha
        appSha = [string]$Plan.appSha
        imageDigest = [string]$Plan.imageDigest
        priorApiTaskDefinitionArn = [string]$Plan.priorApiTaskDefinitionArn
        priorWorkerTaskDefinitionArn = [string]$Plan.priorWorkerTaskDefinitionArn
        priorDeploymentBounds = $Plan.deploymentBounds
        priorDeploymentConfigurationSha256 = $Plan.deploymentConfigurationSha256
        candidateApiTaskDefinitionArn = $CandidateApiArn
        candidateWorkerTaskDefinitionArn = $CandidateWorkerArn
    }
    Write-SanitizedJson -Path ([string]$Plan.checkpointPath) -Value $checkpoint
}

function Test-IsPathWithin {
    param([Parameter(Mandatory = $true)][string]$Candidate, [Parameter(Mandatory = $true)][string]$Parent)
    $candidatePath = [IO.Path]::GetFullPath($Candidate)
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    return $candidatePath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePointInExistingPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Private runtime paths must not traverse a reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Set-PrivatePathPermissions {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Directory)
    if ($IsWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $ownerSid = $identity.User
        $systemSid = [Security.Principal.SecurityIdentifier]::new(
            [Security.Principal.WellKnownSidType]::LocalSystemSid, $null
        )
        $security = Get-Acl -LiteralPath $Path
        if ($Directory) {
            $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        else {
            $inheritance = [Security.AccessControl.InheritanceFlags]::None
        }
        $security.SetAccessRuleProtection($true, $false)
        foreach ($identityReference in @($security.Access | ForEach-Object { $_.IdentityReference } | Sort-Object Value -Unique)) {
            $security.PurgeAccessRules($identityReference)
        }
        foreach ($sid in @($ownerSid, $systemSid)) {
            [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
                [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow
            ))
        }
        if ($Directory) {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), [Security.AccessControl.DirectorySecurity]$security)
        }
        else {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path), [Security.AccessControl.FileSecurity]$security)
        }
        $observed = Get-Acl -LiteralPath $Path
        $allowedSids = @($ownerSid.Value, $systemSid.Value)
        if (-not $observed.AreAccessRulesProtected -or @($observed.Access | Where-Object {
            $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids
        }).Count -gt 0) {
            throw "Private runtime material permissions did not converge to operator-and-SYSTEM only."
        }
        return
    }
    $mode = if ($Directory) {
        [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute
    } else {
        [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite
    }
    [IO.File]::SetUnixFileMode($Path, $mode)
}

function Assert-PrivatePathPermissions {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Directory)
    if ($IsWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $ownerSid = $identity.User.Value
        $systemSid = [Security.Principal.SecurityIdentifier]::new(
            [Security.Principal.WellKnownSidType]::LocalSystemSid, $null
        ).Value
        $security = Get-Acl -LiteralPath $Path
        $allowedSids = @($ownerSid, $systemSid)
        $allowedRules = @($security.Access | Where-Object {
            $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
        })
        if (-not $security.AreAccessRulesProtected -or $allowedRules.Count -eq 0 -or
            @($allowedRules | Where-Object {
                $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids
            }).Count -gt 0 -or
            @($allowedRules | Where-Object {
                $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $ownerSid
            }).Count -eq 0) {
            throw "Private runtime material must be accessible only to the operator and SYSTEM."
        }
        return
    }
    $mode = [IO.File]::GetUnixFileMode($Path)
    $sharedBits = [IO.UnixFileMode]::GroupRead -bor [IO.UnixFileMode]::GroupWrite -bor [IO.UnixFileMode]::GroupExecute -bor
        [IO.UnixFileMode]::OtherRead -bor [IO.UnixFileMode]::OtherWrite -bor [IO.UnixFileMode]::OtherExecute
    if (($mode -band $sharedBits) -ne 0) {
        throw "Private runtime material must use owner-only permissions."
    }
}

function Assert-PrivateInputPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot
    )
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "Runtime configuration inputs require absolute paths." }
    Assert-NoReparsePointInExistingPath -Path $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Runtime configuration inputs must be regular private files."
    }
    if (Test-IsPathWithin -Candidate $item.FullName -Parent $RepositoryRoot) {
        throw "Runtime configuration inputs must stay outside the repository."
    }
    Assert-PrivatePathPermissions -Path $item.FullName
    return $item.FullName
}

function Assert-PrivateExternalRoot {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$RepositoryRoot)
    if (-not [IO.Path]::IsPathRooted($Root)) { throw "Runtime deployment evidence requires an absolute external root." }
    $repoPath = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $filesystemRoot = [IO.Path]::GetPathRoot($rootPath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if ([string]::IsNullOrWhiteSpace($rootPath) -or $rootPath -ieq $filesystemRoot) {
        throw "Runtime deployment evidence cannot use a filesystem root."
    }
    $repoBoundary = $repoPath + [IO.Path]::DirectorySeparatorChar
    $rootBoundary = $rootPath + [IO.Path]::DirectorySeparatorChar
    if ($rootBoundary.StartsWith($repoBoundary, [StringComparison]::OrdinalIgnoreCase) -or
        $repoBoundary.StartsWith($rootBoundary, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime deployment evidence must not overlap the repository in either direction."
    }
    $protectedPaths = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    foreach ($protectedPath in $protectedPaths) {
        $protectedPath = [IO.Path]::GetFullPath($protectedPath).TrimEnd(
            [IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar
        )
        $protectedBoundary = $protectedPath + [IO.Path]::DirectorySeparatorChar
        if ($rootPath -ieq $protectedPath -or $protectedBoundary.StartsWith($rootBoundary, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Runtime deployment evidence cannot use a broad protected or home path."
        }
    }
    Assert-NoReparsePointInExistingPath -Path $rootPath
    $markerPath = Join-Path $rootPath $script:EvidenceRootMarkerName
    if (Test-Path -LiteralPath $rootPath) {
        $rootItem = Get-Item -LiteralPath $rootPath -Force
        if (-not $rootItem.PSIsContainer) { throw "Runtime deployment evidence root must be a directory." }
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Runtime deployment evidence root must not be a reparse point."
        }
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
            -not [Linq.Enumerable]::SequenceEqual(
                [byte[]][IO.File]::ReadAllBytes($markerPath),
                [byte[]]$script:EvidenceRootMarkerBytes
            )) {
            throw "Existing runtime deployment evidence root is not a dedicated SchoolPilot directory."
        }
        Assert-PrivatePathPermissions -Path $rootPath -Directory
        Assert-PrivatePathPermissions -Path $markerPath
        return $rootPath
    }
    $parent = [IO.Directory]::GetParent($rootPath)
    if ($null -eq $parent -or -not $parent.Exists) {
        throw "Runtime deployment evidence requires one new dedicated leaf under an existing parent."
    }
    [void][IO.Directory]::CreateDirectory($rootPath)
    Set-PrivatePathPermissions -Path $rootPath -Directory
    Write-PrivateBytes -Path $markerPath -Bytes $script:EvidenceRootMarkerBytes
    return $rootPath
}

function Assert-ExpectedReleaseIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$AppSha,
        [Parameter(Mandatory = $true)][string]$ImageDigest,
        [Parameter(Mandatory = $true)][string]$ApiTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$WorkerTaskDefinitionArn
    )
    if ($AppSha -cnotmatch '^[0-9a-f]{40}$' -or $ImageDigest -cnotmatch '^sha256:[0-9a-f]{64}$' -or
        $WorkerTaskDefinitionArn -cnotmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:[1-9][0-9]*$') {
        throw "Exact production release identity inputs are malformed."
    }
    [void](Get-ApiFamilyFromTaskDefinitionArn -TaskDefinitionArn $ApiTaskDefinitionArn)
}

function Get-ApiFamilyFromTaskDefinitionArn {
    param([Parameter(Mandatory = $true)][string]$TaskDefinitionArn)
    foreach ($family in $script:AllowedApiFamilies) {
        $pattern = '^arn:aws:ecs:us-east-1:135775632425:task-definition/' +
            [Regex]::Escape($family) + ':[1-9][0-9]*$'
        if ($TaskDefinitionArn -cmatch $pattern) { return $family }
    }
    throw "API task definition must use one reviewed production family."
}

function Get-ValidatedProductionSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ToolSha,
        [Parameter(Mandatory = $true)][string]$AppSha,
        [Parameter(Mandatory = $true)][string]$ImageDigest,
        [Parameter(Mandatory = $true)][string]$ApiTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$WorkerTaskDefinitionArn,
        [Parameter(Mandatory = $true)]$RuntimeConfiguration,
        [switch]$SkipRepositoryCheck,
        [switch]$SkipEcrShaCheck,
        [ValidateRange(2, 6)][int]$MaximumApiDesiredCount = 2
    )
    Assert-ExpectedReleaseIdentity -AppSha $AppSha -ImageDigest $ImageDigest -ApiTaskDefinitionArn $ApiTaskDefinitionArn -WorkerTaskDefinitionArn $WorkerTaskDefinitionArn
    if ($ToolSha -cnotmatch '^[0-9a-f]{40}$') { throw "Reviewed runtime-tool SHA is malformed." }
    if (-not $SkipRepositoryCheck) {
        [void](Assert-RepositoryIdentity -RepositoryRoot $RepositoryRoot -ExpectedSha $ToolSha)
    }
    $identity = Invoke-AwsJson -Arguments @("sts", "get-caller-identity", "--output", "json", "--no-cli-pager")
    if ([string]$identity.Account -cne $script:AccountId) { throw "AWS identity is outside the production account." }
    $services = Get-ServiceSnapshot
    Assert-StableService -Service $services.Api -ExpectedTaskDefinitionArn $ApiTaskDefinitionArn -MinimumDesired 1 -MaximumDesired $MaximumApiDesiredCount -Label "API"
    Assert-StableService -Service $services.Worker -ExpectedTaskDefinitionArn $WorkerTaskDefinitionArn -MinimumDesired 1 -MaximumDesired 1 -Label "worker"
    [void](Assert-ApiTargetHealth -ApiService $services.Api -ExpectedDesiredCount ([int]$services.Api.desiredCount) -Mode Exact)
    if ($RuntimeConfiguration.Mode -cne "off") {
        Assert-NormalServiceDeploymentConfiguration -Service $services.Api
        Assert-NormalServiceDeploymentConfiguration -Service $services.Worker
    }
    $apiResponse = Get-TaskDefinitionResponse -TaskDefinitionArn $ApiTaskDefinitionArn
    $workerResponse = Get-TaskDefinitionResponse -TaskDefinitionArn $WorkerTaskDefinitionArn
    $apiFamily = Get-ApiFamilyFromTaskDefinitionArn -TaskDefinitionArn $ApiTaskDefinitionArn
    [void](Assert-TaskDefinitionContract -Response $apiResponse -ExpectedArn $ApiTaskDefinitionArn -ExpectedFamily $apiFamily -ContainerName "api" -ExpectedDigest $ImageDigest -ExpectedCpu "512" -ExpectedMemory "2048")
    [void](Assert-TaskDefinitionContract -Response $workerResponse -ExpectedArn $WorkerTaskDefinitionArn -ExpectedFamily $script:WorkerFamily -ContainerName "scheduler-worker" -ExpectedDigest $ImageDigest -ExpectedCpu "256" -ExpectedMemory "512")
    $apiManagedFingerprint = Get-ManagedRuntimeFingerprint -TaskDefinition $apiResponse.taskDefinition -ContainerName "api"
    $workerManagedFingerprint = Get-ManagedRuntimeFingerprint -TaskDefinition $workerResponse.taskDefinition -ContainerName "scheduler-worker"
    if ($apiManagedFingerprint -cne $workerManagedFingerprint) {
        throw "API and worker ClassPilot runtime configuration has drifted; recover the exact pair before activation."
    }
    if (-not $SkipEcrShaCheck) {
        $immutableImageTag = $AppSha.Substring(0, 12)
        $ecr = Invoke-AwsJson -Arguments @(
            "ecr", "describe-images", "--repository-name", $script:EcrRepository,
            "--image-ids", "imageTag=$immutableImageTag", "--region", $script:Region, "--output", "json", "--no-cli-pager"
        )
        if (@($ecr.imageDetails).Count -ne 1 -or [string]$ecr.imageDetails[0].imageDigest -cne $ImageDigest) {
            throw "The deployed app SHA tag does not resolve to the expected image digest."
        }
    }
    Assert-TurnAwsReadiness -RuntimeConfiguration $RuntimeConfiguration
    $scaling = Get-ScalingSnapshot
    if ($scaling.DynamicIn -or $scaling.DynamicOut -or $scaling.Scheduled) { throw "Autoscaling is already suspended." }
    Assert-ScheduledScalingContract
    return [pscustomobject]@{
        Services = $services
        ApiTask = $apiResponse
        WorkerTask = $workerResponse
        Scaling = $scaling
    }
}

function New-RuntimeConfigPlan {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$PrivateProfilePath,
        [string]$PrivateTurnEvidencePath,
        [string]$PrivateSyntheticValidationPath,
        [string]$PrivateManagedTestWaiverPath,
        [string]$PrivateTrackingPilotEvidencePath,
        [string]$PrivateStudentGatePilotEvidencePath,
        [Parameter(Mandatory = $true)][string]$EvidenceRoot,
        [Parameter(Mandatory = $true)][string]$AppSha,
        [Parameter(Mandatory = $true)][string]$ImageDigest,
        [Parameter(Mandatory = $true)][string]$ApiTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$WorkerTaskDefinitionArn,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
        [switch]$SkipRepositoryCheck,
        [switch]$ConfirmProductionMutation,
        [switch]$ConfirmSyntheticOnlyGlobalActivation,
        [switch]$ConfirmProtectedWindowProductionMutation
    )
    $hasSyntheticValidation = -not [string]::IsNullOrWhiteSpace($PrivateSyntheticValidationPath)
    $hasManagedTestWaiver = -not [string]::IsNullOrWhiteSpace($PrivateManagedTestWaiverPath)
    if ($hasSyntheticValidation -ne $hasManagedTestWaiver) {
        throw "Synthetic-only global activation requires both synthetic validation and managed test waiver evidence."
    }
    $syntheticOnlyWaiver = $hasSyntheticValidation -and $hasManagedTestWaiver
    if ($ConfirmSyntheticOnlyGlobalActivation -and -not $syntheticOnlyWaiver) {
        throw "Synthetic-only global activation confirmation requires both waiver evidence files."
    }
    if ($ConfirmProtectedWindowProductionMutation -and -not $ConfirmProductionMutation) {
        throw "Protected-window plan admission also requires -ConfirmProductionMutation."
    }
    if ($syntheticOnlyWaiver -and (-not $ConfirmProductionMutation -or
        -not $ConfirmSyntheticOnlyGlobalActivation -or -not $ConfirmProtectedWindowProductionMutation)) {
        throw "Synthetic-only global activation requires all three explicit production confirmations."
    }
    $PrivateProfilePath = Assert-PrivateInputPath -Path $PrivateProfilePath -RepositoryRoot $RepositoryRoot
    if ($PrivateTurnEvidencePath) {
        $PrivateTurnEvidencePath = Assert-PrivateInputPath -Path $PrivateTurnEvidencePath -RepositoryRoot $RepositoryRoot
    }
    if ($hasSyntheticValidation) {
        $PrivateSyntheticValidationPath = Assert-PrivateInputPath -Path $PrivateSyntheticValidationPath -RepositoryRoot $RepositoryRoot
        $PrivateManagedTestWaiverPath = Assert-PrivateInputPath -Path $PrivateManagedTestWaiverPath -RepositoryRoot $RepositoryRoot
    }
    $profileSnapshot = Read-StrictJsonSnapshot -Path $PrivateProfilePath
    $profile = $profileSnapshot.Value
    $runtimeIntent = ConvertTo-RuntimeConfiguration -Profile $profile
    $runtime = $runtimeIntent
    $toolSha = if ($SkipRepositoryCheck -or $runtime.Mode -ceq "off") {
        Get-RepositoryHeadSha -RepositoryRoot $RepositoryRoot
    }
    else {
        Assert-RepositoryIdentity -RepositoryRoot $RepositoryRoot
    }
    $trackingPilotEvidenceRequired = $runtime.Mode -ceq "tracking-window-global-on"
    if ($trackingPilotEvidenceRequired -and [string]::IsNullOrWhiteSpace($PrivateTrackingPilotEvidencePath)) {
        throw "Tracking-window global activation requires fresh pilot smoke and soak evidence."
    }
    if (-not $trackingPilotEvidenceRequired -and -not [string]::IsNullOrWhiteSpace($PrivateTrackingPilotEvidencePath)) {
        throw "Tracking-window pilot evidence is valid only for tracking-window-global-on activation."
    }
    $trackingPilotEvidenceSnapshot = $null
    if ($trackingPilotEvidenceRequired) {
        $PrivateTrackingPilotEvidencePath = Assert-PrivateInputPath -Path $PrivateTrackingPilotEvidencePath `
            -RepositoryRoot $RepositoryRoot
        $trackingPilotEvidenceSnapshot = Read-StrictJsonSnapshot -Path $PrivateTrackingPilotEvidencePath
    }
    $studentGatePilotEvidenceRequired = $runtime.Mode -ceq "student-gate-global-on"
    if ($studentGatePilotEvidenceRequired -and [string]::IsNullOrWhiteSpace($PrivateStudentGatePilotEvidencePath)) {
        throw "Student-gate global activation requires fresh pilot smoke and soak evidence."
    }
    if (-not $studentGatePilotEvidenceRequired -and
        -not [string]::IsNullOrWhiteSpace($PrivateStudentGatePilotEvidencePath)) {
        throw "Student-gate pilot evidence is valid only for student-gate-global-on activation."
    }
    $studentGatePilotEvidenceSnapshot = $null
    if ($studentGatePilotEvidenceRequired) {
        $PrivateStudentGatePilotEvidencePath = Assert-PrivateInputPath `
            -Path $PrivateStudentGatePilotEvidencePath -RepositoryRoot $RepositoryRoot
        $studentGatePilotEvidenceSnapshot = Read-StrictJsonSnapshot -Path $PrivateStudentGatePilotEvidencePath
    }
    if ($syntheticOnlyWaiver -and $runtime.Mode -cne "global-on") {
        throw "Synthetic-only waiver evidence is valid only for global-on activation."
    }
    if ($null -eq $runtime.Turn -and $PrivateTurnEvidencePath) {
        throw "TURN evidence must be omitted when the selected profile does not manage TURN wiring."
    }
    $turnEvidenceSnapshot = $null
    $turnEvidence = if ($null -ne $runtime.Turn) {
        if (-not $PrivateTurnEvidencePath) { throw "TURN evidence is required when the selected profile manages TURN wiring." }
        $turnEvidenceSnapshot = Read-StrictJsonSnapshot -Path $PrivateTurnEvidencePath
        Assert-TurnEvidence -RuntimeConfiguration $runtime -EvidenceSnapshot $turnEvidenceSnapshot -Now $Now `
            -SyntheticOnlyWaiver:$syntheticOnlyWaiver
    } else { $null }
    $syntheticValidationSnapshot = $null
    $syntheticValidation = $null
    $managedTestWaiverSnapshot = $null
    $managedTestWaiver = $null
    if ($syntheticOnlyWaiver) {
        $syntheticValidationSnapshot = Read-StrictJsonSnapshot -Path $PrivateSyntheticValidationPath
        $syntheticValidation = Assert-SyntheticValidationEvidence -EvidenceSnapshot $syntheticValidationSnapshot `
            -AppSha $AppSha -ImageDigest $ImageDigest -TurnEvidenceSha256 ([string]$turnEvidence.EvidenceSha256) -Now $Now
        $managedTestWaiverSnapshot = Read-StrictJsonSnapshot -Path $PrivateManagedTestWaiverPath
        $managedTestWaiver = Assert-ManagedTestWaiverEvidence -EvidenceSnapshot $managedTestWaiverSnapshot `
            -SyntheticValidationSha256 ([string]$syntheticValidation.EvidenceSha256) `
            -TurnEvidenceSha256 ([string]$turnEvidence.EvidenceSha256) -Now $Now
    }
    $snapshot = Get-ValidatedProductionSnapshot -RepositoryRoot $RepositoryRoot -ToolSha $toolSha `
        -AppSha $AppSha -ImageDigest $ImageDigest `
        -ApiTaskDefinitionArn $ApiTaskDefinitionArn -WorkerTaskDefinitionArn $WorkerTaskDefinitionArn `
        -RuntimeConfiguration $runtime -SkipRepositoryCheck:($SkipRepositoryCheck -or $runtime.Mode -ceq "off") `
        -SkipEcrShaCheck:($runtime.Mode -ceq "off") `
        -MaximumApiDesiredCount $(if ($runtime.Mode -ceq "off" -or $ConfirmProtectedWindowProductionMutation) { 6 } else { 2 })
    $runtime = Resolve-SourcePreservingRuntimeConfiguration -RuntimeIntent $runtimeIntent `
        -SourceTaskDefinition $snapshot.ApiTask.taskDefinition -ContainerName "api"
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $snapshot.ApiTask.taskDefinition -ContainerName "api" `
        -TargetRuntimeConfiguration $runtime -AllowSyntheticOnlyGlobalActivation:$syntheticOnlyWaiver
    $trackingPilotEvidence = $null
    if ($trackingPilotEvidenceRequired) {
        $sourceContainer = @($snapshot.ApiTask.taskDefinition.containerDefinitions | Where-Object name -CEQ "api")
        if ($sourceContainer.Count -ne 1) { throw "Pilot source runtime container is ambiguous." }
        $sourceState = Get-RuntimeActivationState -Environment @($sourceContainer[0].environment) -AllowBaseline
        $sourceRuntimeConfigurationSha256 = Get-ManagedRuntimeFingerprint `
            -TaskDefinition $snapshot.ApiTask.taskDefinition -ContainerName "api"
        $trackingPilotEvidence = Assert-TrackingWindowPilotEvidence `
            -EvidenceSnapshot $trackingPilotEvidenceSnapshot -PilotSchoolId ([string]$sourceState.SchoolId) `
            -ToolSha $toolSha -AppSha $AppSha -ImageDigest $ImageDigest -ApiTaskDefinitionArn $ApiTaskDefinitionArn `
            -WorkerTaskDefinitionArn $WorkerTaskDefinitionArn `
            -RuntimeConfigurationSha256 $sourceRuntimeConfigurationSha256 -Now $Now
    }
    $studentGatePilotEvidence = $null
    if ($studentGatePilotEvidenceRequired) {
        $sourceContainer = @($snapshot.ApiTask.taskDefinition.containerDefinitions | Where-Object name -CEQ "api")
        if ($sourceContainer.Count -ne 1) { throw "Student-gate pilot source runtime container is ambiguous." }
        $sourceState = Get-RuntimeActivationState -Environment @($sourceContainer[0].environment) -AllowBaseline
        if ([string]$sourceState.StudentGateMode -cne "pilot") {
            throw "Student-gate global activation requires the exact active school-scoped pilot."
        }
        $sourceRuntimeConfigurationSha256 = Get-ManagedRuntimeFingerprint `
            -TaskDefinition $snapshot.ApiTask.taskDefinition -ContainerName "api"
        $studentGatePilotEvidence = Assert-StudentGatePilotEvidence `
            -EvidenceSnapshot $studentGatePilotEvidenceSnapshot `
            -PilotSchoolId ([string]$sourceState.StudentGateSchoolId) `
            -ToolSha $toolSha -AppSha $AppSha -ImageDigest $ImageDigest `
            -ApiTaskDefinitionArn $ApiTaskDefinitionArn `
            -WorkerTaskDefinitionArn $WorkerTaskDefinitionArn `
            -RuntimeConfigurationSha256 $sourceRuntimeConfigurationSha256 -Now $Now
    }
    $root = Assert-PrivateExternalRoot -Root $EvidenceRoot -RepositoryRoot $RepositoryRoot
    $runId = $Now.ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ") + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
    $runDirectory = Join-Path $root $runId
    [void][IO.Directory]::CreateDirectory($runDirectory)
    Set-PrivatePathPermissions -Path $runDirectory -Directory
    $profileFile = "profile.json"
    $turnEvidenceFile = if ($null -ne $turnEvidenceSnapshot) { "turn-evidence.json" } else { $null }
    $syntheticValidationFile = if ($null -ne $syntheticValidationSnapshot) { "synthetic-validation.json" } else { $null }
    $managedTestWaiverFile = if ($null -ne $managedTestWaiverSnapshot) { "managed-test-waiver.json" } else { $null }
    $trackingPilotEvidenceFile = if ($null -ne $trackingPilotEvidenceSnapshot) { "tracking-pilot-evidence.json" } else { $null }
    $studentGatePilotEvidenceFile = if ($null -ne $studentGatePilotEvidenceSnapshot) {
        "student-gate-pilot-evidence.json"
    } else { $null }
    Write-PrivateBytes -Path (Join-Path $runDirectory $profileFile) -Bytes $profileSnapshot.Bytes
    if ($null -ne $turnEvidenceSnapshot) {
        Write-PrivateBytes -Path (Join-Path $runDirectory $turnEvidenceFile) -Bytes $turnEvidenceSnapshot.Bytes
    }
    if ($null -ne $syntheticValidationSnapshot) {
        Write-PrivateBytes -Path (Join-Path $runDirectory $syntheticValidationFile) -Bytes $syntheticValidationSnapshot.Bytes
        Write-PrivateBytes -Path (Join-Path $runDirectory $managedTestWaiverFile) -Bytes $managedTestWaiverSnapshot.Bytes
    }
    if ($null -ne $trackingPilotEvidenceSnapshot) {
        Write-PrivateBytes -Path (Join-Path $runDirectory $trackingPilotEvidenceFile) `
            -Bytes $trackingPilotEvidenceSnapshot.Bytes
    }
    if ($null -ne $studentGatePilotEvidenceSnapshot) {
        Write-PrivateBytes -Path (Join-Path $runDirectory $studentGatePilotEvidenceFile) `
            -Bytes $studentGatePilotEvidenceSnapshot.Bytes
    }
    $manifest = [ordered]@{
        schemaVersion = 2
        runId = $runId
        createdAt = $Now.ToUniversalTime().ToString("o")
        profileFile = $profileFile
        profileSha256 = [string]$profileSnapshot.Sha256
        profileMode = $runtime.Mode
        schoolScopeCount = $runtime.SchoolScopeCount
        enabledCapabilityCount = @($runtime.EnabledCapabilities).Count
        runtimeConfigurationSha256 = Get-RuntimeConfigurationSha256 -RuntimeConfiguration $runtime
        turnEvidenceFile = $turnEvidenceFile
        turnEvidenceSha256 = if ($null -ne $turnEvidence) { $turnEvidence.EvidenceSha256 } else { $null }
        syntheticValidationFile = $syntheticValidationFile
        syntheticValidationSha256 = if ($null -ne $syntheticValidation) { $syntheticValidation.EvidenceSha256 } else { $null }
        managedTestWaiverFile = $managedTestWaiverFile
        managedTestWaiverSha256 = if ($null -ne $managedTestWaiver) { $managedTestWaiver.EvidenceSha256 } else { $null }
        trackingPilotEvidenceFile = $trackingPilotEvidenceFile
        trackingPilotEvidenceSha256 = if ($null -ne $trackingPilotEvidence) { $trackingPilotEvidence.EvidenceSha256 } else { $null }
        studentGatePilotEvidenceFile = $studentGatePilotEvidenceFile
        studentGatePilotEvidenceSha256 = if ($null -ne $studentGatePilotEvidence) {
            $studentGatePilotEvidence.EvidenceSha256
        } else { $null }
        validationLevel = if ($syntheticOnlyWaiver) { "synthetic_only" } elseif ($runtime.Mode -cin @("global-on", "tracking-window-global-on", "student-gate-global-on")) { "managed" } else { "not_applicable" }
        managedValidation = if ($syntheticOnlyWaiver) { "waived_not_passed" } elseif ($runtime.Mode -cin @("global-on", "tracking-window-global-on", "student-gate-global-on")) { "passed" } else { "not_applicable" }
        protectedWindowProductionMutation = [bool]$ConfirmProtectedWindowProductionMutation
        repositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
        toolSha = $toolSha
        appSha = $AppSha
        imageDigest = $ImageDigest
        priorApiTaskDefinitionArn = $ApiTaskDefinitionArn
        priorWorkerTaskDefinitionArn = $WorkerTaskDefinitionArn
        scaling = $snapshot.Scaling
        deploymentBounds = [ordered]@{
            Api = Get-ServiceDeploymentBounds -Service $snapshot.Services.Api
            Worker = Get-ServiceDeploymentBounds -Service $snapshot.Services.Worker
        }
        deploymentConfigurationSha256 = [ordered]@{
            Api = Get-ServiceDeploymentConfigurationSha256 -Service $snapshot.Services.Api
            Worker = Get-ServiceDeploymentConfigurationSha256 -Service $snapshot.Services.Worker
        }
        checkpointFile = "checkpoint.json"
        resultFile = "result.json"
    }
    $plan = Join-Path $runDirectory "plan.json"
    Write-SanitizedJson -Path $plan -Value $manifest
    return [pscustomobject]@{
        PlanPath = $plan
        PlanRelativePath = Join-Path $runId "plan.json"
        PlanSha256 = Get-FileSha256 -Path $plan
        Mode = $runtime.Mode
        SchoolScopeCount = $runtime.SchoolScopeCount
    }
}

function Read-RuntimePlan {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$ExpectedSha256)
    $snapshot = Read-StrictJsonSnapshot -Path $Path
    if ($ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$' -or [string]$snapshot.Sha256 -cne $ExpectedSha256) {
        throw "Runtime plan hash does not match the exact private manifest."
    }
    $plan = $snapshot.Value
    Assert-ExactProperties -Value $plan -Allowed @(
        "schemaVersion", "runId", "createdAt", "profileFile", "profileSha256", "profileMode",
        "schoolScopeCount", "enabledCapabilityCount", "runtimeConfigurationSha256",
        "turnEvidenceFile", "turnEvidenceSha256", "syntheticValidationFile", "syntheticValidationSha256",
        "managedTestWaiverFile", "managedTestWaiverSha256", "validationLevel", "managedValidation",
        "trackingPilotEvidenceFile", "trackingPilotEvidenceSha256",
        "studentGatePilotEvidenceFile", "studentGatePilotEvidenceSha256",
        "protectedWindowProductionMutation",
        "repositoryRoot", "toolSha", "appSha", "imageDigest", "priorApiTaskDefinitionArn",
        "priorWorkerTaskDefinitionArn", "scaling", "deploymentBounds", "deploymentConfigurationSha256",
        "checkpointFile", "resultFile"
    ) -Trail "runtime plan"
    if ([int]$plan.schemaVersion -ne 2) { throw "Runtime plan schemaVersion must be 2." }
    if ([string]$plan.toolSha -cnotmatch '^[0-9a-f]{40}$' -or
        [string]$plan.appSha -cnotmatch '^[0-9a-f]{40}$' -or
        [string]$plan.imageDigest -cnotmatch '^sha256:[0-9a-f]{64}$') {
        throw "Runtime plan tool and deployed-image identities are invalid."
    }
    if ([string]$plan.runtimeConfigurationSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw "Runtime plan configuration identity is invalid."
    }
    Assert-ExactProperties -Value $plan.deploymentBounds -Allowed @("Api", "Worker") -Trail "runtime plan.deploymentBounds"
    foreach ($role in @("Api", "Worker")) {
        Assert-ExactProperties -Value $plan.deploymentBounds.$role -Allowed @("Minimum", "Maximum") -Trail "runtime plan.deploymentBounds.$role"
        $minimum = [int]$plan.deploymentBounds.$role.Minimum
        $maximum = [int]$plan.deploymentBounds.$role.Maximum
        if ($minimum -lt 0 -or $minimum -gt 100 -or $maximum -lt 100 -or $maximum -gt 200 -or $minimum -gt $maximum) {
            throw "Runtime plan deployment bounds are invalid."
        }
    }
    Assert-ExactProperties -Value $plan.deploymentConfigurationSha256 -Allowed @("Api", "Worker") -Trail "runtime plan.deploymentConfigurationSha256"
    foreach ($role in @("Api", "Worker")) {
        if ([string]$plan.deploymentConfigurationSha256.$role -cnotmatch '^[0-9a-f]{64}$') {
            throw "Runtime plan deployment-configuration identity is invalid."
        }
    }
    if ([string]$plan.profileFile -cne "profile.json" -or
        [string]$plan.checkpointFile -cne "checkpoint.json" -or
        [string]$plan.resultFile -cne "result.json") {
        throw "Runtime plan private filenames are invalid."
    }
    $hasTurnEvidence = [string]$plan.turnEvidenceSha256 -match '^[0-9a-f]{64}$'
    if (($hasTurnEvidence -and [string]$plan.turnEvidenceFile -cne "turn-evidence.json") -or
        (-not $hasTurnEvidence -and ($null -ne $plan.turnEvidenceFile -or $null -ne $plan.turnEvidenceSha256))) {
        throw "Runtime plan TURN evidence identity is invalid."
    }
    $hasSyntheticValidation = [string]$plan.syntheticValidationSha256 -match '^[0-9a-f]{64}$'
    $hasManagedTestWaiver = [string]$plan.managedTestWaiverSha256 -match '^[0-9a-f]{64}$'
    if ($hasSyntheticValidation -ne $hasManagedTestWaiver -or
        ($hasSyntheticValidation -and ([string]$plan.syntheticValidationFile -cne "synthetic-validation.json" -or
            [string]$plan.managedTestWaiverFile -cne "managed-test-waiver.json")) -or
        (-not $hasSyntheticValidation -and ($null -ne $plan.syntheticValidationFile -or
            $null -ne $plan.syntheticValidationSha256 -or $null -ne $plan.managedTestWaiverFile -or
            $null -ne $plan.managedTestWaiverSha256))) {
        throw "Runtime plan synthetic-only evidence identity is invalid."
    }
    $hasTrackingPilotEvidence = [string]$plan.trackingPilotEvidenceSha256 -match '^[0-9a-f]{64}$'
    if (($hasTrackingPilotEvidence -and ([string]$plan.profileMode -cne "tracking-window-global-on" -or
            [string]$plan.trackingPilotEvidenceFile -cne "tracking-pilot-evidence.json")) -or
        (-not $hasTrackingPilotEvidence -and ($null -ne $plan.trackingPilotEvidenceFile -or
            $null -ne $plan.trackingPilotEvidenceSha256 -or
            [string]$plan.profileMode -ceq "tracking-window-global-on"))) {
        throw "Runtime plan tracking-window pilot evidence identity is invalid."
    }
    $hasStudentGatePilotEvidence = [string]$plan.studentGatePilotEvidenceSha256 -match '^[0-9a-f]{64}$'
    if (($hasStudentGatePilotEvidence -and
            ([string]$plan.profileMode -cne "student-gate-global-on" -or
                [string]$plan.studentGatePilotEvidenceFile -cne "student-gate-pilot-evidence.json")) -or
        (-not $hasStudentGatePilotEvidence -and
            ($null -ne $plan.studentGatePilotEvidenceFile -or
                $null -ne $plan.studentGatePilotEvidenceSha256 -or
                [string]$plan.profileMode -ceq "student-gate-global-on"))) {
        throw "Runtime plan student-gate pilot evidence identity is invalid."
    }
    if ($plan.protectedWindowProductionMutation -isnot [bool]) {
        throw "Runtime plan protected-window authority is invalid."
    }
    if ($hasSyntheticValidation) {
        if (-not $hasTurnEvidence -or [string]$plan.profileMode -cne "global-on" -or
            [string]$plan.validationLevel -cne "synthetic_only" -or
            [string]$plan.managedValidation -cne "waived_not_passed" -or
            -not [bool]$plan.protectedWindowProductionMutation) {
            throw "Runtime plan synthetic-only activation authority is invalid."
        }
    }
    elseif ([string]$plan.profileMode -cin @("global-on", "tracking-window-global-on", "student-gate-global-on")) {
        if ([string]$plan.validationLevel -cne "managed" -or [string]$plan.managedValidation -cne "passed") {
            throw "Runtime plan strict managed activation authority is invalid."
        }
    }
    elseif ([string]$plan.validationLevel -cne "not_applicable" -or
        [string]$plan.managedValidation -cne "not_applicable") {
        throw "Runtime plan staged validation authority is invalid."
    }
    $runDirectory = Split-Path -Parent ([string]$snapshot.Path)
    $plan | Add-Member -NotePropertyName profilePath -NotePropertyValue (Join-Path $runDirectory "profile.json")
    $plan | Add-Member -NotePropertyName turnEvidencePath -NotePropertyValue $(
        if ($hasTurnEvidence) { Join-Path $runDirectory "turn-evidence.json" } else { $null }
    )
    $plan | Add-Member -NotePropertyName syntheticValidationPath -NotePropertyValue $(
        if ($hasSyntheticValidation) { Join-Path $runDirectory "synthetic-validation.json" } else { $null }
    )
    $plan | Add-Member -NotePropertyName managedTestWaiverPath -NotePropertyValue $(
        if ($hasManagedTestWaiver) { Join-Path $runDirectory "managed-test-waiver.json" } else { $null }
    )
    $plan | Add-Member -NotePropertyName trackingPilotEvidencePath -NotePropertyValue $(
        if ($hasTrackingPilotEvidence) { Join-Path $runDirectory "tracking-pilot-evidence.json" } else { $null }
    )
    $plan | Add-Member -NotePropertyName studentGatePilotEvidencePath -NotePropertyValue $(
        if ($hasStudentGatePilotEvidence) { Join-Path $runDirectory "student-gate-pilot-evidence.json" } else { $null }
    )
    $plan | Add-Member -NotePropertyName checkpointPath -NotePropertyValue (Join-Path $runDirectory "checkpoint.json")
    $plan | Add-Member -NotePropertyName resultPath -NotePropertyValue (Join-Path $runDirectory "result.json")
    return $plan
}

function Write-ResultEvidence {
    param(
        [Parameter(Mandatory = $true)]$Plan,
        [Parameter(Mandatory = $true)][string]$PlanSha256,
        [Parameter(Mandatory = $true)][string]$Status,
        [string]$CandidateApiArn,
        [string]$CandidateWorkerArn,
        [string]$RollbackApiArn,
        [string]$RollbackWorkerArn,
        [bool]$ScalingRestored
    )
    $result = [ordered]@{
        schemaVersion = 2
        runId = [string]$Plan.runId
        recordedAt = [DateTimeOffset]::UtcNow.ToString("o")
        status = $Status
        planSha256 = $PlanSha256
        profileSha256 = [string]$Plan.profileSha256
        profileMode = [string]$Plan.profileMode
        schoolScopeCount = [int]$Plan.schoolScopeCount
        enabledCapabilityCount = [int]$Plan.enabledCapabilityCount
        runtimeConfigurationSha256 = [string]$Plan.runtimeConfigurationSha256
        syntheticValidationSha256 = if ($null -ne $Plan.syntheticValidationSha256) { [string]$Plan.syntheticValidationSha256 } else { $null }
        managedTestWaiverSha256 = if ($null -ne $Plan.managedTestWaiverSha256) { [string]$Plan.managedTestWaiverSha256 } else { $null }
        trackingPilotEvidenceSha256 = if ($null -ne $Plan.trackingPilotEvidenceSha256) { [string]$Plan.trackingPilotEvidenceSha256 } else { $null }
        studentGatePilotEvidenceSha256 = if ($null -ne $Plan.studentGatePilotEvidenceSha256) {
            [string]$Plan.studentGatePilotEvidenceSha256
        } else { $null }
        validationLevel = [string]$Plan.validationLevel
        managedValidation = [string]$Plan.managedValidation
        protectedWindowProductionMutation = [bool]$Plan.protectedWindowProductionMutation
        toolSha = [string]$Plan.toolSha
        appSha = [string]$Plan.appSha
        imageDigest = [string]$Plan.imageDigest
        priorApiTaskDefinitionArn = [string]$Plan.priorApiTaskDefinitionArn
        priorWorkerTaskDefinitionArn = [string]$Plan.priorWorkerTaskDefinitionArn
        priorDeploymentBounds = $Plan.deploymentBounds
        priorDeploymentConfigurationSha256 = $Plan.deploymentConfigurationSha256
        candidateApiTaskDefinitionArn = $CandidateApiArn
        candidateWorkerTaskDefinitionArn = $CandidateWorkerArn
        rollbackApiTaskDefinitionArn = $RollbackApiArn
        rollbackWorkerTaskDefinitionArn = $RollbackWorkerArn
        scalingRestored = $ScalingRestored
    }
    if ($env:SCHOOLPILOT_RUNTIME_CONFIG_TEST_MODE -ceq "I_UNDERSTAND_TEST_ONLY") {
        $handler = Get-Variable -Name SchoolPilotRuntimeConfigResultWriteHandler -Scope Global -ErrorAction SilentlyContinue
        if ($null -ne $handler -and $null -ne $handler.Value) {
            & $handler.Value ([string]$Plan.resultPath) $result
        }
    }
    Write-SanitizedJson -Path ([string]$Plan.resultPath) -Value $result
    return $result
}

function Invoke-RuntimeConfigApply {
    param(
        [Parameter(Mandatory = $true)]$Plan,
        [Parameter(Mandatory = $true)][string]$PlanSha256,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
        [ValidateRange(1, 720)][int]$ConvergenceAttempts = 720,
        [ValidateRange(0, 30)][int]$ConvergenceIntervalSeconds = 5,
        [switch]$SkipRepositoryCheck,
        [switch]$ConfirmProductionMutation,
        [switch]$ConfirmSyntheticOnlyGlobalActivation,
        [switch]$ConfirmProtectedWindowProductionMutation
    )
    $syntheticOnlyWaiver = [string]$Plan.validationLevel -ceq "synthetic_only"
    $protectedWindowMutation = [bool]$Plan.protectedWindowProductionMutation
    if ($ConfirmProtectedWindowProductionMutation -ne $protectedWindowMutation) {
        throw "Protected-window apply confirmation must match the exact reviewed plan authority."
    }
    if ($protectedWindowMutation -and (-not $ConfirmProductionMutation -or
        -not $ConfirmProtectedWindowProductionMutation)) {
        throw "Protected-window apply requires both production mutation confirmations."
    }
    if ($syntheticOnlyWaiver -and (-not $ConfirmProductionMutation -or
        -not $ConfirmSyntheticOnlyGlobalActivation -or -not $ConfirmProtectedWindowProductionMutation)) {
        throw "Synthetic-only global activation requires all three explicit production confirmations."
    }
    if (-not $syntheticOnlyWaiver -and $ConfirmSyntheticOnlyGlobalActivation) {
        throw "Synthetic-only global activation confirmation does not match the reviewed plan."
    }
    $useNoGrowthDeploymentBounds = $Plan.profileMode -ceq "off" -or $protectedWindowMutation
    $maximumApiDesiredCount = if ($useNoGrowthDeploymentBounds) { 6 } else { 2 }
    $profileSnapshot = Read-StrictJsonSnapshot -Path ([string]$Plan.profilePath)
    if ([string]$profileSnapshot.Sha256 -cne [string]$Plan.profileSha256) {
        throw "Private runtime profile changed after planning."
    }
    $runtimeIntent = ConvertTo-RuntimeConfiguration -Profile $profileSnapshot.Value
    $runtime = $runtimeIntent
    if ($runtime.Mode -cne [string]$Plan.profileMode -or $runtime.SchoolScopeCount -ne [int]$Plan.schoolScopeCount) {
        throw "Runtime profile semantics changed after planning."
    }
    $runtimeMutationEasternTime = $null
    if ($runtime.Mode -cne "off") {
        $runtimeMutationEasternTime = Get-CurrentDeploymentEasternTime
        Assert-RuntimeConfigMutationWindow -NowEastern $runtimeMutationEasternTime `
            -ConfirmProtectedWindowProductionMutation:$protectedWindowMutation
    }
    if ($null -ne $runtime.Turn) {
        $turnEvidenceSnapshot = Read-StrictJsonSnapshot -Path ([string]$Plan.turnEvidencePath)
        if ([string]$turnEvidenceSnapshot.Sha256 -cne [string]$Plan.turnEvidenceSha256) {
            throw "TURN evidence changed after planning."
        }
        [void](Assert-TurnEvidence -RuntimeConfiguration $runtime -EvidenceSnapshot $turnEvidenceSnapshot -Now $Now `
            -SyntheticOnlyWaiver:$syntheticOnlyWaiver)
    }
    if ($syntheticOnlyWaiver) {
        $syntheticValidationSnapshot = Read-StrictJsonSnapshot -Path ([string]$Plan.syntheticValidationPath)
        if ([string]$syntheticValidationSnapshot.Sha256 -cne [string]$Plan.syntheticValidationSha256) {
            throw "Synthetic validation evidence changed after planning."
        }
        [void](Assert-SyntheticValidationEvidence -EvidenceSnapshot $syntheticValidationSnapshot `
            -AppSha ([string]$Plan.appSha) -ImageDigest ([string]$Plan.imageDigest) `
            -TurnEvidenceSha256 ([string]$Plan.turnEvidenceSha256) -Now $Now)
        $managedTestWaiverSnapshot = Read-StrictJsonSnapshot -Path ([string]$Plan.managedTestWaiverPath)
        if ([string]$managedTestWaiverSnapshot.Sha256 -cne [string]$Plan.managedTestWaiverSha256) {
            throw "Managed test waiver changed after planning."
        }
        [void](Assert-ManagedTestWaiverEvidence -EvidenceSnapshot $managedTestWaiverSnapshot `
            -SyntheticValidationSha256 ([string]$Plan.syntheticValidationSha256) `
            -TurnEvidenceSha256 ([string]$Plan.turnEvidenceSha256) -Now $Now)
    }
    $trackingPilotEvidenceSnapshot = $null
    if ($runtime.Mode -ceq "tracking-window-global-on") {
        $trackingPilotEvidenceSnapshot = Read-StrictJsonSnapshot -Path ([string]$Plan.trackingPilotEvidencePath)
        if ([string]$trackingPilotEvidenceSnapshot.Sha256 -cne [string]$Plan.trackingPilotEvidenceSha256) {
            throw "Tracking-window pilot evidence changed after planning."
        }
    }
    $studentGatePilotEvidenceSnapshot = $null
    if ($runtime.Mode -ceq "student-gate-global-on") {
        $studentGatePilotEvidenceSnapshot = Read-StrictJsonSnapshot `
            -Path ([string]$Plan.studentGatePilotEvidencePath)
        if ([string]$studentGatePilotEvidenceSnapshot.Sha256 -cne
            [string]$Plan.studentGatePilotEvidenceSha256) {
            throw "Student-gate pilot evidence changed after planning."
        }
    }
    $snapshot = Get-ValidatedProductionSnapshot -RepositoryRoot ([string]$Plan.repositoryRoot) `
        -ToolSha ([string]$Plan.toolSha) -AppSha ([string]$Plan.appSha) `
        -ImageDigest ([string]$Plan.imageDigest) -ApiTaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn) -RuntimeConfiguration $runtime `
        -SkipRepositoryCheck:($SkipRepositoryCheck -or $runtime.Mode -ceq "off") `
        -SkipEcrShaCheck:($runtime.Mode -ceq "off") -MaximumApiDesiredCount $maximumApiDesiredCount
    $runtime = Resolve-SourcePreservingRuntimeConfiguration -RuntimeIntent $runtimeIntent `
        -SourceTaskDefinition $snapshot.ApiTask.taskDefinition -ContainerName "api"
    if (@($runtime.EnabledCapabilities).Count -ne [int]$Plan.enabledCapabilityCount) {
        throw "Runtime profile enabled-capability semantics changed after planning."
    }
    if ((Get-RuntimeConfigurationSha256 -RuntimeConfiguration $runtime) -cne [string]$Plan.runtimeConfigurationSha256) {
        throw "Runtime profile authority changed after planning."
    }
    if ($runtime.Mode -cne "off" -and
        [int]$snapshot.Scaling.Min -ne (Get-ScheduledApiMinimum -NowEastern $runtimeMutationEasternTime)) {
        throw "Production API MinCapacity does not match the reviewed current 05:45/10:00 schedule."
    }
    Assert-ServicePairDeploymentBounds -Snapshot $snapshot.Services -Expected $Plan.deploymentBounds
    [void](Assert-ServicePairDeploymentConfigurations -Snapshot $snapshot.Services `
        -ExpectedSha256 $Plan.deploymentConfigurationSha256)
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $snapshot.ApiTask.taskDefinition `
        -ContainerName "api" -TargetRuntimeConfiguration $runtime `
        -AllowSyntheticOnlyGlobalActivation:$syntheticOnlyWaiver
    if ($runtime.Mode -ceq "tracking-window-global-on") {
        $sourceContainer = @($snapshot.ApiTask.taskDefinition.containerDefinitions | Where-Object name -CEQ "api")
        if ($sourceContainer.Count -ne 1) { throw "Pilot source runtime container is ambiguous." }
        $sourceState = Get-RuntimeActivationState -Environment @($sourceContainer[0].environment) -AllowBaseline
        [void](Assert-TrackingWindowPilotEvidence -EvidenceSnapshot $trackingPilotEvidenceSnapshot `
            -PilotSchoolId ([string]$sourceState.SchoolId) -ToolSha ([string]$Plan.toolSha) `
            -AppSha ([string]$Plan.appSha) `
            -ImageDigest ([string]$Plan.imageDigest) `
            -ApiTaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn) `
            -RuntimeConfigurationSha256 (Get-ManagedRuntimeFingerprint `
                -TaskDefinition $snapshot.ApiTask.taskDefinition -ContainerName "api") -Now $Now)
    }
    if ($runtime.Mode -ceq "student-gate-global-on") {
        $sourceContainer = @($snapshot.ApiTask.taskDefinition.containerDefinitions | Where-Object name -CEQ "api")
        if ($sourceContainer.Count -ne 1) { throw "Student-gate pilot source runtime container is ambiguous." }
        $sourceState = Get-RuntimeActivationState -Environment @($sourceContainer[0].environment) -AllowBaseline
        if ([string]$sourceState.StudentGateMode -cne "pilot") {
            throw "Student-gate global activation requires the exact active school-scoped pilot."
        }
        [void](Assert-StudentGatePilotEvidence -EvidenceSnapshot $studentGatePilotEvidenceSnapshot `
            -PilotSchoolId ([string]$sourceState.StudentGateSchoolId) `
            -ToolSha ([string]$Plan.toolSha) -AppSha ([string]$Plan.appSha) `
            -ImageDigest ([string]$Plan.imageDigest) `
            -ApiTaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn) `
            -RuntimeConfigurationSha256 (Get-ManagedRuntimeFingerprint `
                -TaskDefinition $snapshot.ApiTask.taskDefinition -ContainerName "api") -Now $Now)
    }
    $expectedApiDesiredCount = [int]$snapshot.Services.Api.desiredCount
    $apiSourceFingerprint = Get-TaskFingerprint -TaskDefinition $snapshot.ApiTask.taskDefinition -ContainerName "api"
    $workerSourceFingerprint = Get-TaskFingerprint -TaskDefinition $snapshot.WorkerTask.taskDefinition -ContainerName "scheduler-worker"
    $apiSourceTagsFingerprint = Get-TaskTagsFingerprint -Tags @($snapshot.ApiTask.tags)
    $workerSourceTagsFingerprint = Get-TaskTagsFingerprint -Tags @($snapshot.WorkerTask.tags)
    $apiFamily = Get-ApiFamilyFromTaskDefinitionArn -TaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn)
    $apiRequest = New-RuntimeTaskDefinitionRequest -SourceResponse $snapshot.ApiTask -RuntimeConfiguration $runtime `
        -ExpectedDigest ([string]$Plan.imageDigest) -ExpectedArn ([string]$Plan.priorApiTaskDefinitionArn) `
        -ExpectedFamily $apiFamily -ContainerName "api" -ExpectedCpu "512" -ExpectedMemory "2048"
    $workerRequest = New-RuntimeTaskDefinitionRequest -SourceResponse $snapshot.WorkerTask -RuntimeConfiguration $runtime `
        -ExpectedDigest ([string]$Plan.imageDigest) -ExpectedArn ([string]$Plan.priorWorkerTaskDefinitionArn) `
        -ExpectedFamily $script:WorkerFamily -ContainerName "scheduler-worker" -ExpectedCpu "256" -ExpectedMemory "512"
    Acquire-OperationLock -RunId ([string]$Plan.runId) -PlanSha256 $PlanSha256
    Start-OperationMutationWindow
    $runDirectory = Split-Path -Parent ([string]$Plan.resultPath)
    $candidateApiArn = Register-RuntimeTaskDefinition -Request $apiRequest -Directory $runDirectory -RuntimeConfiguration $runtime `
        -ExpectedDigest ([string]$Plan.imageDigest) -SourceFingerprint $apiSourceFingerprint `
        -SourceTagsFingerprint $apiSourceTagsFingerprint `
        -ExpectedFamily $apiFamily -ContainerName "api" -ExpectedCpu "512" -ExpectedMemory "2048"
    $candidateWorkerArn = Register-RuntimeTaskDefinition -Request $workerRequest -Directory $runDirectory -RuntimeConfiguration $runtime `
        -ExpectedDigest ([string]$Plan.imageDigest) -SourceFingerprint $workerSourceFingerprint `
        -SourceTagsFingerprint $workerSourceTagsFingerprint `
        -ExpectedFamily $script:WorkerFamily -ContainerName "scheduler-worker" -ExpectedCpu "256" -ExpectedMemory "512"
    Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_candidates_registered" `
        -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
    $rollbackSucceeded = $false
    $scalingRestored = $false
    $candidatePairConverged = $false
    $terminalCandidateSafe = $false
    $script:ApiServiceMutationStarted = $false
    $script:WorkerServiceMutationStarted = $false
    $script:DeploymentBoundsChanged = $false
    $script:PriorDeploymentBounds = $null
    $script:PriorDeploymentConfigurations = $null
    try {
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_scaling_hold_pending" `
            -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
        [void](Acquire-ScalingHold)
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_scaling_hold_acquired" `
            -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
        if ($runtime.Mode -cne "off") {
            $preMutationEasternTime = Get-CurrentDeploymentEasternTime
            Assert-RuntimeConfigMutationWindow -NowEastern $preMutationEasternTime `
                -ConfirmProtectedWindowProductionMutation:$protectedWindowMutation
            if ([int]$script:PriorScalingState.Min -ne (Get-ScheduledApiMinimum -NowEastern $preMutationEasternTime)) {
                throw "Scheduled API minimum changed before runtime-config service mutation."
            }
        }
        $before = Get-ServiceSnapshot
        Assert-StableService -Service $before.Api -ExpectedTaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn) -MinimumDesired 1 `
            -MaximumDesired $maximumApiDesiredCount -Label "API"
        Assert-StableService -Service $before.Worker -ExpectedTaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn) -MinimumDesired 1 -MaximumDesired 1 -Label "worker"
        [void](Assert-ApiTargetHealth -ApiService $before.Api -ExpectedDesiredCount $expectedApiDesiredCount -Mode Exact)
        if ([int]$before.Api.desiredCount -ne $expectedApiDesiredCount) {
            throw "API desired count changed after the exact deployment snapshot."
        }
        Assert-ServicePairDeploymentBounds -Snapshot $before -Expected $Plan.deploymentBounds
        [void](Assert-ServicePairDeploymentConfigurations -Snapshot $before `
            -ExpectedSha256 $Plan.deploymentConfigurationSha256)
        if ($useNoGrowthDeploymentBounds) {
            Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_off_bounds_pending" `
                -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
            Acquire-OffContainmentDeploymentBounds -Snapshot $before
            Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_off_bounds_acquired" `
                -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
        }
        [void](Assert-ScalingHoldExact)
        $mutationReady = Get-ServiceSnapshot
        Assert-StableService -Service $mutationReady.Api -ExpectedTaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn) -MinimumDesired 1 `
            -MaximumDesired $maximumApiDesiredCount -Label "API"
        Assert-StableService -Service $mutationReady.Worker -ExpectedTaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn) -MinimumDesired 1 -MaximumDesired 1 -Label "worker"
        [void](Assert-ApiTargetHealth -ApiService $mutationReady.Api -ExpectedDesiredCount $expectedApiDesiredCount -Mode Exact)
        if ([int]$mutationReady.Api.desiredCount -ne $expectedApiDesiredCount) {
            throw "API desired count changed under the autoscaling hold before service mutation."
        }
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_api_update_pending" `
            -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
        Invoke-RuntimeServiceUpdate -Role api -TaskDefinitionArn $candidateApiArn
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_worker_update_pending" `
            -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
        Invoke-RuntimeServiceUpdate -Role worker -TaskDefinitionArn $candidateWorkerArn
        [void](Wait-ExactServicePairConvergence -ExpectedApiTaskDefinitionArn $candidateApiArn -ExpectedWorkerTaskDefinitionArn $candidateWorkerArn `
            -ExpectedApiDesiredCount $expectedApiDesiredCount `
            -MaxAttempts $ConvergenceAttempts -IntervalSeconds $ConvergenceIntervalSeconds)
        $candidatePairConverged = $true
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_pair_converged" `
            -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
        if ($useNoGrowthDeploymentBounds) {
            Restore-OffContainmentDeploymentBounds
            Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_off_bounds_restored" `
                -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
        }
        [void](Restore-ScalingHold)
        $scalingRestored = $true
        $terminalCandidateSafe = $true
        Complete-OperationMutationWindow
        $result = Write-ResultEvidence -Plan $Plan -PlanSha256 $PlanSha256 -Status "applied" `
            -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn -ScalingRestored $true
        Release-OperationLock
        return $result
    }
    catch {
        $failure = $_.Exception
        if ($terminalCandidateSafe) {
            throw $failure
        }
        if ($useNoGrowthDeploymentBounds -and $candidatePairConverged) {
            $candidateRecoverySucceeded = $false
            try {
                [void](Wait-ExactServicePairConvergence -ExpectedApiTaskDefinitionArn $candidateApiArn `
                    -ExpectedWorkerTaskDefinitionArn $candidateWorkerArn `
                    -ExpectedApiDesiredCount $expectedApiDesiredCount `
                    -MaxAttempts $ConvergenceAttempts -IntervalSeconds $ConvergenceIntervalSeconds)
                Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_pair_converged" `
                    -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
                if ($script:DeploymentBoundsChanged) {
                    Restore-OffContainmentDeploymentBounds
                }
                else {
                    $restoredSnapshot = Get-ServiceSnapshot
                    Assert-ServicePairDeploymentBounds -Snapshot $restoredSnapshot -Expected $Plan.deploymentBounds
                    [void](Assert-ServicePairDeploymentConfigurations -Snapshot $restoredSnapshot `
                        -ExpectedSha256 $Plan.deploymentConfigurationSha256)
                }
                Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "apply_off_bounds_restored" `
                    -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn
                [void](Restore-ScalingHold)
                $scalingRestored = $true
                $terminalCandidateSafe = $true
                Complete-OperationMutationWindow
                $candidateRecoverySucceeded = $true
            }
            catch {
                $candidateRecoverySucceeded = $false
            }
            if ($candidateRecoverySucceeded) {
                $result = Write-ResultEvidence -Plan $Plan -PlanSha256 $PlanSha256 -Status "applied" `
                    -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn -ScalingRestored $true
                Release-OperationLock
                return $result
            }
            try {
                [void](Write-ResultEvidence -Plan $Plan -PlanSha256 $PlanSha256 `
                    -Status "apply_failed_manual_intervention" -CandidateApiArn $candidateApiArn `
                    -CandidateWorkerArn $candidateWorkerArn -ScalingRestored $scalingRestored)
            }
            catch { }
            throw $failure
        }
        $serviceMutationStarted = $script:ApiServiceMutationStarted -or $script:WorkerServiceMutationStarted
        $rollbackSafetyReady = $true
        $rollbackApiDesiredCount = $expectedApiDesiredCount
        if ($useNoGrowthDeploymentBounds -and $serviceMutationStarted) {
            try {
                [void](Sync-ScalingHoldExact)
                $recoverySnapshot = Get-ServiceSnapshot
                $rollbackApiDesiredCount = [int]$recoverySnapshot.Api.desiredCount
                if ($rollbackApiDesiredCount -lt 1 -or $rollbackApiDesiredCount -gt 6 -or
                    [int]$recoverySnapshot.Worker.desiredCount -ne 1) {
                    throw "Recovery observed desired capacity outside the reviewed frozen range."
                }
                [void](Set-OffContainmentDeploymentConfigurations `
                    -PriorConfigurations $script:PriorDeploymentConfigurations `
                    -ApiDesiredCount $rollbackApiDesiredCount)
                [void](Assert-ScalingHoldExact)
                $recoveryReady = Get-ServiceSnapshot
                if ([int]$recoveryReady.Api.desiredCount -ne $rollbackApiDesiredCount -or
                    [int]$recoveryReady.Worker.desiredCount -ne 1) {
                    throw "Recovery desired capacity changed after containment was re-established."
                }
            }
            catch {
                $rollbackSafetyReady = $false
            }
        }
        if ($serviceMutationStarted -and $rollbackSafetyReady) {
            try {
                Invoke-RuntimeServiceUpdate -Role api -TaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn)
                Invoke-RuntimeServiceUpdate -Role worker -TaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn)
                [void](Wait-ExactServicePairConvergence -ExpectedApiTaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn) `
                    -ExpectedWorkerTaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn) `
                    -ExpectedApiDesiredCount $rollbackApiDesiredCount `
                    -MaxAttempts $ConvergenceAttempts -IntervalSeconds $ConvergenceIntervalSeconds)
                $rollbackSucceeded = $true
            }
            catch { $rollbackSucceeded = $false }
        }
        $coherentServicePair = (-not $script:ApiServiceMutationStarted -and -not $script:WorkerServiceMutationStarted) -or $rollbackSucceeded
        $boundsRestored = -not $script:DeploymentBoundsChanged
        if ($coherentServicePair -and $script:DeploymentBoundsChanged) {
            try { Restore-OffContainmentDeploymentBounds; $boundsRestored = $true } catch { $boundsRestored = $false }
        }
        if ($coherentServicePair -and $boundsRestored) {
            try { [void](Restore-ScalingHold); $scalingRestored = $true } catch { $scalingRestored = $false }
        }
        $failureStatus = if (-not $boundsRestored -or -not $scalingRestored) {
            "apply_failed_manual_intervention"
        } elseif (-not $serviceMutationStarted) {
            "apply_failed_no_service_mutation"
        } elseif ($rollbackSucceeded) {
            "apply_failed_rolled_back"
        } else {
            "apply_failed_manual_intervention"
        }
        $rollbackApiArn = if ($rollbackSucceeded) { [string]$Plan.priorApiTaskDefinitionArn } else { $null }
        $rollbackWorkerArn = if ($rollbackSucceeded) { [string]$Plan.priorWorkerTaskDefinitionArn } else { $null }
        $terminalStateRecorded = $false
        if ($coherentServicePair -and $boundsRestored -and $scalingRestored) {
            try { Complete-OperationMutationWindow; $terminalStateRecorded = $true } catch { $terminalStateRecorded = $false }
        }
        $resultWritten = $false
        try {
            [void](Write-ResultEvidence -Plan $Plan -PlanSha256 $PlanSha256 `
                -Status $failureStatus -CandidateApiArn $candidateApiArn -CandidateWorkerArn $candidateWorkerArn `
                -RollbackApiArn $rollbackApiArn -RollbackWorkerArn $rollbackWorkerArn `
                -ScalingRestored $scalingRestored)
            $resultWritten = $true
        }
        catch { }
        if ($terminalStateRecorded -and $resultWritten) {
            Release-OperationLock
        }
        throw $failure
    }
}

function Invoke-RuntimeConfigRollback {
    param(
        [Parameter(Mandatory = $true)]$Plan,
        [Parameter(Mandatory = $true)][string]$PlanSha256,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
        [ValidateRange(1, 720)][int]$ConvergenceAttempts = 720,
        [ValidateRange(0, 30)][int]$ConvergenceIntervalSeconds = 5,
        [switch]$ConfirmProductionMutation,
        [switch]$ConfirmProtectedWindowProductionMutation
    )
    $protectedWindowMutation = [bool]$Plan.protectedWindowProductionMutation
    if ([bool]$ConfirmProtectedWindowProductionMutation -ne $protectedWindowMutation) {
        throw "Protected-window rollback confirmation must match the exact reviewed plan authority."
    }
    if ($protectedWindowMutation -and (-not $ConfirmProductionMutation -or
        -not $ConfirmProtectedWindowProductionMutation)) {
        throw "Protected-window rollback requires both production mutation confirmations."
    }
    $maximumApiDesiredCount = if ($protectedWindowMutation) { 6 } else { 2 }
    $rollbackAdmissionEasternTime = Get-CurrentDeploymentEasternTime
    Assert-RuntimeConfigMutationWindow -NowEastern $rollbackAdmissionEasternTime `
        -ConfirmProtectedWindowProductionMutation:$protectedWindowMutation
    $result = Read-StrictJson -Path ([string]$Plan.resultPath)
    Assert-ExactProperties -Value $result -Allowed @(
        "schemaVersion", "runId", "recordedAt", "status", "planSha256", "profileSha256",
        "profileMode", "schoolScopeCount", "enabledCapabilityCount", "runtimeConfigurationSha256",
        "syntheticValidationSha256", "managedTestWaiverSha256", "validationLevel", "managedValidation",
        "trackingPilotEvidenceSha256", "studentGatePilotEvidenceSha256",
        "protectedWindowProductionMutation",
        "toolSha", "appSha", "imageDigest",
        "priorApiTaskDefinitionArn", "priorWorkerTaskDefinitionArn", "priorDeploymentBounds",
        "priorDeploymentConfigurationSha256", "candidateApiTaskDefinitionArn",
        "candidateWorkerTaskDefinitionArn", "rollbackApiTaskDefinitionArn", "rollbackWorkerTaskDefinitionArn",
        "scalingRestored"
    ) -Trail "runtime result"
    if (-not (Test-IsJsonInteger -Value $result.schemaVersion) -or [long]$result.schemaVersion -ne 2 -or
        [string]$result.status -cnotin @("applied", "rollback_failed_candidate_restored", "rollback_failed_no_service_mutation") -or
        [string]$result.planSha256 -cne $PlanSha256) {
        throw "Rollback requires exact successful apply evidence."
    }
    if ($result.scalingRestored -isnot [bool] -or -not [bool]$result.scalingRestored) {
        throw "Rollback requires evidence that autoscaling was restored exactly."
    }
    if ([string]$result.runId -cne [string]$Plan.runId -or [string]$result.profileSha256 -cne [string]$Plan.profileSha256 -or
        [string]$result.runtimeConfigurationSha256 -cne [string]$Plan.runtimeConfigurationSha256 -or
        [string]$result.syntheticValidationSha256 -cne [string]$Plan.syntheticValidationSha256 -or
        [string]$result.managedTestWaiverSha256 -cne [string]$Plan.managedTestWaiverSha256 -or
        [string]$result.trackingPilotEvidenceSha256 -cne [string]$Plan.trackingPilotEvidenceSha256 -or
        [string]$result.studentGatePilotEvidenceSha256 -cne [string]$Plan.studentGatePilotEvidenceSha256 -or
        [string]$result.validationLevel -cne [string]$Plan.validationLevel -or
        [string]$result.managedValidation -cne [string]$Plan.managedValidation -or
        $result.protectedWindowProductionMutation -isnot [bool] -or
        [bool]$result.protectedWindowProductionMutation -ne [bool]$Plan.protectedWindowProductionMutation -or
        [string]$result.toolSha -cne [string]$Plan.toolSha -or
        [string]$result.appSha -cne [string]$Plan.appSha -or [string]$result.imageDigest -cne [string]$Plan.imageDigest -or
        [string]$result.priorApiTaskDefinitionArn -cne [string]$Plan.priorApiTaskDefinitionArn -or
        [string]$result.priorWorkerTaskDefinitionArn -cne [string]$Plan.priorWorkerTaskDefinitionArn -or
        (Get-CanonicalJsonSha256 -Value $result.priorDeploymentBounds) -cne (Get-CanonicalJsonSha256 -Value $Plan.deploymentBounds) -or
        (Get-CanonicalJsonSha256 -Value $result.priorDeploymentConfigurationSha256) -cne
            (Get-CanonicalJsonSha256 -Value $Plan.deploymentConfigurationSha256)) {
        throw "Rollback evidence does not bind the exact planned release identity."
    }
    $apiFamily = Get-ApiFamilyFromTaskDefinitionArn -TaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn)
    $candidateApiPattern = '^arn:aws:ecs:us-east-1:135775632425:task-definition/' +
        [Regex]::Escape($apiFamily) + ':[1-9][0-9]*$'
    if ([string]$result.candidateApiTaskDefinitionArn -cnotmatch $candidateApiPattern -or
        [string]$result.candidateWorkerTaskDefinitionArn -cnotmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:[1-9][0-9]*$') {
        throw "Rollback evidence contains malformed candidate task identities."
    }
    Assert-ExpectedReleaseIdentity -AppSha ([string]$Plan.appSha) -ImageDigest ([string]$Plan.imageDigest) `
        -ApiTaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn)
    $identity = Invoke-AwsJson -Arguments @("sts", "get-caller-identity", "--output", "json", "--no-cli-pager")
    if ([string]$identity.Account -cne $script:AccountId) { throw "AWS identity is outside the production account." }
    foreach ($contract in @(
        [pscustomobject]@{ Arn = [string]$Plan.priorApiTaskDefinitionArn; Family = $apiFamily; Container = "api"; Cpu = "512"; Memory = "2048" },
        [pscustomobject]@{ Arn = [string]$Plan.priorWorkerTaskDefinitionArn; Family = $script:WorkerFamily; Container = "scheduler-worker"; Cpu = "256"; Memory = "512" },
        [pscustomobject]@{ Arn = [string]$result.candidateApiTaskDefinitionArn; Family = $apiFamily; Container = "api"; Cpu = "512"; Memory = "2048" },
        [pscustomobject]@{ Arn = [string]$result.candidateWorkerTaskDefinitionArn; Family = $script:WorkerFamily; Container = "scheduler-worker"; Cpu = "256"; Memory = "512" }
    )) {
        $response = Get-TaskDefinitionResponse -TaskDefinitionArn $contract.Arn
        [void](Assert-TaskDefinitionContract -Response $response -ExpectedArn $contract.Arn -ExpectedFamily $contract.Family `
            -ContainerName $contract.Container -ExpectedDigest ([string]$Plan.imageDigest) `
            -ExpectedCpu $contract.Cpu -ExpectedMemory $contract.Memory)
    }
    $snapshot = Get-ServiceSnapshot
    Assert-StableService -Service $snapshot.Api -ExpectedTaskDefinitionArn ([string]$result.candidateApiTaskDefinitionArn) `
        -MinimumDesired 1 -MaximumDesired $maximumApiDesiredCount -Label "API"
    Assert-StableService -Service $snapshot.Worker -ExpectedTaskDefinitionArn ([string]$result.candidateWorkerTaskDefinitionArn) -MinimumDesired 1 -MaximumDesired 1 -Label "worker"
    [void](Assert-ApiTargetHealth -ApiService $snapshot.Api -ExpectedDesiredCount ([int]$snapshot.Api.desiredCount) -Mode Exact)
    Assert-ServicePairDeploymentBounds -Snapshot $snapshot -Expected $Plan.deploymentBounds
    [void](Assert-ServicePairDeploymentConfigurations -Snapshot $snapshot `
        -ExpectedSha256 $Plan.deploymentConfigurationSha256)
    $expectedApiDesiredCount = [int]$snapshot.Api.desiredCount
    Assert-ScheduledScalingContract
    $rollbackScaling = Get-ScalingSnapshot
    if ([int]$rollbackScaling.Min -ne (Get-ScheduledApiMinimum -NowEastern $rollbackAdmissionEasternTime)) {
        throw "Production API MinCapacity does not match the reviewed current 05:45/10:00 schedule."
    }
    Acquire-OperationLock -RunId ([string]$Plan.runId) -PlanSha256 $PlanSha256
    Start-OperationMutationWindow
    $script:ApiServiceMutationStarted = $false
    $script:WorkerServiceMutationStarted = $false
    $script:DeploymentBoundsChanged = $false
    $script:PriorDeploymentBounds = $null
    $script:PriorDeploymentConfigurations = $null
    $terminalRollbackSafe = $false
    try {
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_scaling_hold_pending" `
            -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
            -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
        [void](Acquire-ScalingHold)
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_scaling_hold_acquired" `
            -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
            -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
        $rollbackPreMutationEasternTime = Get-CurrentDeploymentEasternTime
        Assert-RuntimeConfigMutationWindow -NowEastern $rollbackPreMutationEasternTime `
            -ConfirmProtectedWindowProductionMutation:$protectedWindowMutation
        if ([int]$script:PriorScalingState.Min -ne (Get-ScheduledApiMinimum -NowEastern $rollbackPreMutationEasternTime)) {
            throw "Scheduled API minimum changed before runtime-config rollback mutation."
        }
        $before = Get-ServiceSnapshot
        Assert-StableService -Service $before.Api -ExpectedTaskDefinitionArn ([string]$result.candidateApiTaskDefinitionArn) `
            -MinimumDesired 1 -MaximumDesired $maximumApiDesiredCount -Label "API"
        Assert-StableService -Service $before.Worker -ExpectedTaskDefinitionArn ([string]$result.candidateWorkerTaskDefinitionArn) -MinimumDesired 1 -MaximumDesired 1 -Label "worker"
        [void](Assert-ApiTargetHealth -ApiService $before.Api -ExpectedDesiredCount $expectedApiDesiredCount -Mode Exact)
        if ([int]$before.Api.desiredCount -ne $expectedApiDesiredCount) { throw "API desired count changed before rollback mutation." }
        Assert-ServicePairDeploymentBounds -Snapshot $before -Expected $Plan.deploymentBounds
        [void](Assert-ServicePairDeploymentConfigurations -Snapshot $before `
            -ExpectedSha256 $Plan.deploymentConfigurationSha256)
        if ($protectedWindowMutation) {
            Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_no_growth_bounds_pending" `
                -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
                -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
            Acquire-OffContainmentDeploymentBounds -Snapshot $before
            Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_no_growth_bounds_acquired" `
                -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
                -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
        }
        [void](Assert-ScalingHoldExact)
        $mutationReady = Get-ServiceSnapshot
        Assert-StableService -Service $mutationReady.Api `
            -ExpectedTaskDefinitionArn ([string]$result.candidateApiTaskDefinitionArn) `
            -MinimumDesired 1 -MaximumDesired $maximumApiDesiredCount -Label "API"
        Assert-StableService -Service $mutationReady.Worker `
            -ExpectedTaskDefinitionArn ([string]$result.candidateWorkerTaskDefinitionArn) `
            -MinimumDesired 1 -MaximumDesired 1 -Label "worker"
        [void](Assert-ApiTargetHealth -ApiService $mutationReady.Api -ExpectedDesiredCount $expectedApiDesiredCount -Mode Exact)
        if ([int]$mutationReady.Api.desiredCount -ne $expectedApiDesiredCount) {
            throw "API desired count changed under the autoscaling hold before rollback mutation."
        }
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_api_update_pending" `
            -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
            -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
        Invoke-RuntimeServiceUpdate -Role api -TaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn)
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_worker_update_pending" `
            -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
            -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
        Invoke-RuntimeServiceUpdate -Role worker -TaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn)
        [void](Wait-ExactServicePairConvergence -ExpectedApiTaskDefinitionArn ([string]$Plan.priorApiTaskDefinitionArn) `
            -ExpectedWorkerTaskDefinitionArn ([string]$Plan.priorWorkerTaskDefinitionArn) `
            -ExpectedApiDesiredCount $expectedApiDesiredCount `
            -MaxAttempts $ConvergenceAttempts -IntervalSeconds $ConvergenceIntervalSeconds)
        Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_pair_converged" `
            -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
            -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
        if ($protectedWindowMutation) {
            Restore-OffContainmentDeploymentBounds
            Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_no_growth_bounds_restored" `
                -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
                -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
        }
        [void](Restore-ScalingHold)
        $terminalRollbackSafe = $true
        Complete-OperationMutationWindow
        $rollbackResult = Write-ResultEvidence -Plan $Plan -PlanSha256 $PlanSha256 -Status "rolled_back" `
            -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
            -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn) `
            -RollbackApiArn ([string]$Plan.priorApiTaskDefinitionArn) `
            -RollbackWorkerArn ([string]$Plan.priorWorkerTaskDefinitionArn) -ScalingRestored $true
        Release-OperationLock
        return $rollbackResult
    }
    catch {
        $failure = $_.Exception
        if ($terminalRollbackSafe) {
            throw $failure
        }
        $candidateRestored = $false
        $scalingRestored = $false
        $serviceMutationStarted = $script:ApiServiceMutationStarted -or $script:WorkerServiceMutationStarted
        $recoverySafetyReady = $true
        $recoveryExpectedApiDesiredCount = $expectedApiDesiredCount
        if ($protectedWindowMutation -and $serviceMutationStarted) {
            try {
                [void](Sync-ScalingHoldExact)
                $recoverySnapshot = Get-ServiceSnapshot
                $recoveryApiDesiredCount = [int]$recoverySnapshot.Api.desiredCount
                if ($recoveryApiDesiredCount -lt 1 -or $recoveryApiDesiredCount -gt 6 -or
                    [int]$recoverySnapshot.Worker.desiredCount -ne 1) {
                    throw "Protected rollback recovery observed desired capacity outside the reviewed frozen range."
                }
                $recoveryExpectedApiDesiredCount = $recoveryApiDesiredCount
                [void](Set-OffContainmentDeploymentConfigurations `
                    -PriorConfigurations $script:PriorDeploymentConfigurations `
                    -ApiDesiredCount $recoveryApiDesiredCount)
                [void](Assert-ScalingHoldExact)
            }
            catch { $recoverySafetyReady = $false }
        }
        if ($serviceMutationStarted -and $recoverySafetyReady) {
            try {
                Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_candidate_recovery_pending" `
                    -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
                    -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
                Invoke-RuntimeServiceUpdate -Role api -TaskDefinitionArn ([string]$result.candidateApiTaskDefinitionArn)
                Invoke-RuntimeServiceUpdate -Role worker -TaskDefinitionArn ([string]$result.candidateWorkerTaskDefinitionArn)
                [void](Wait-ExactServicePairConvergence -ExpectedApiTaskDefinitionArn ([string]$result.candidateApiTaskDefinitionArn) `
                    -ExpectedWorkerTaskDefinitionArn ([string]$result.candidateWorkerTaskDefinitionArn) `
                    -ExpectedApiDesiredCount $recoveryExpectedApiDesiredCount `
                    -MaxAttempts $ConvergenceAttempts -IntervalSeconds $ConvergenceIntervalSeconds)
                Write-OperationCheckpoint -Plan $Plan -PlanSha256 $PlanSha256 -Stage "rollback_candidate_pair_restored" `
                    -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
                    -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn)
                $candidateRestored = $true
            }
            catch { $candidateRestored = $false }
        }
        $coherentServicePair = -not $serviceMutationStarted -or $candidateRestored
        $boundsRestored = -not $script:DeploymentBoundsChanged
        if ($coherentServicePair -and $script:DeploymentBoundsChanged) {
            try { Restore-OffContainmentDeploymentBounds; $boundsRestored = $true } catch { $boundsRestored = $false }
        }
        if ($coherentServicePair -and $boundsRestored) {
            try {
                if ($script:ScalingHoldAcquired) { [void](Restore-ScalingHold) }
                else { [void](Assert-CanonicalScalingReleased) }
                $scalingRestored = $true
            }
            catch { $scalingRestored = $false }
        }
        $status = if (-not $boundsRestored -or -not $scalingRestored) {
            "rollback_failed_manual_intervention"
        } elseif (-not $serviceMutationStarted) {
            "rollback_failed_no_service_mutation"
        } elseif ($candidateRestored) {
            "rollback_failed_candidate_restored"
        } else {
            "rollback_failed_manual_intervention"
        }
        $terminalStateRecorded = $false
        if ($coherentServicePair -and $boundsRestored -and $scalingRestored) {
            try { Complete-OperationMutationWindow; $terminalStateRecorded = $true } catch { $terminalStateRecorded = $false }
        }
        $resultWritten = $false
        try {
            [void](Write-ResultEvidence -Plan $Plan -PlanSha256 $PlanSha256 -Status $status `
                -CandidateApiArn ([string]$result.candidateApiTaskDefinitionArn) `
                -CandidateWorkerArn ([string]$result.candidateWorkerTaskDefinitionArn) `
                -RollbackApiArn ([string]$Plan.priorApiTaskDefinitionArn) `
                -RollbackWorkerArn ([string]$Plan.priorWorkerTaskDefinitionArn) -ScalingRestored $scalingRestored)
            $resultWritten = $true
        }
        catch { }
        if ($terminalStateRecorded -and $resultWritten) {
            Release-OperationLock
        }
        throw $failure
    }
}

function Invoke-Main {
    $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    switch ($Operation) {
        "Plan" {
            foreach ($required in @{
                ProfilePath = $ProfilePath; ExternalEvidenceRoot = $ExternalEvidenceRoot;
                ExpectedAppSha = $ExpectedAppSha; ExpectedImageDigest = $ExpectedImageDigest;
                ExpectedApiTaskDefinitionArn = $ExpectedApiTaskDefinitionArn;
                ExpectedWorkerTaskDefinitionArn = $ExpectedWorkerTaskDefinitionArn
            }.GetEnumerator()) {
                if (-not [string]$required.Value) { throw "-$($required.Key) is required for Plan." }
            }
            $result = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $ProfilePath `
                -PrivateTurnEvidencePath $TurnEvidencePath -PrivateSyntheticValidationPath $SyntheticValidationPath `
                -PrivateManagedTestWaiverPath $ManagedTestWaiverPath `
                -PrivateTrackingPilotEvidencePath $TrackingPilotEvidencePath `
                -PrivateStudentGatePilotEvidencePath $StudentGatePilotEvidencePath `
                -EvidenceRoot $ExternalEvidenceRoot `
                -AppSha $ExpectedAppSha -ImageDigest $ExpectedImageDigest `
                -ApiTaskDefinitionArn $ExpectedApiTaskDefinitionArn -WorkerTaskDefinitionArn $ExpectedWorkerTaskDefinitionArn `
                -ConfirmProductionMutation:$ConfirmProductionMutation `
                -ConfirmSyntheticOnlyGlobalActivation:$ConfirmSyntheticOnlyGlobalActivation `
                -ConfirmProtectedWindowProductionMutation:$ConfirmProtectedWindowProductionMutation
            Write-Host "ClassPilot runtime plan created: mode=$($result.Mode) schoolScopeCount=$($result.SchoolScopeCount) planSha256=$($result.PlanSha256)"
            Write-Output $result.PlanRelativePath
        }
        "Apply" {
            if (-not $ConfirmProductionMutation) { throw "Apply requires -ConfirmProductionMutation." }
            if (-not $PlanPath -or -not $ExpectedPlanSha256) { throw "Apply requires -PlanPath and -ExpectedPlanSha256." }
            $plan = Read-RuntimePlan -Path $PlanPath -ExpectedSha256 $ExpectedPlanSha256
            $result = Invoke-RuntimeConfigApply -Plan $plan -PlanSha256 $ExpectedPlanSha256 `
                -ConfirmProductionMutation:$ConfirmProductionMutation `
                -ConfirmSyntheticOnlyGlobalActivation:$ConfirmSyntheticOnlyGlobalActivation `
                -ConfirmProtectedWindowProductionMutation:$ConfirmProtectedWindowProductionMutation
            Write-Host "ClassPilot runtime configuration applied: mode=$($result.profileMode) schoolScopeCount=$($result.schoolScopeCount) scalingRestored=$($result.scalingRestored)"
        }
        "Rollback" {
            if (-not $ConfirmProductionMutation) { throw "Rollback requires -ConfirmProductionMutation." }
            if (-not $PlanPath -or -not $ExpectedPlanSha256) { throw "Rollback requires -PlanPath and -ExpectedPlanSha256." }
            $plan = Read-RuntimePlan -Path $PlanPath -ExpectedSha256 $ExpectedPlanSha256
            $result = Invoke-RuntimeConfigRollback -Plan $plan -PlanSha256 $ExpectedPlanSha256 `
                -ConfirmProductionMutation:$ConfirmProductionMutation `
                -ConfirmProtectedWindowProductionMutation:$ConfirmProtectedWindowProductionMutation
            Write-Host "ClassPilot runtime rollback complete: scalingRestored=$($result.scalingRestored)"
        }
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    Invoke-Main
}
