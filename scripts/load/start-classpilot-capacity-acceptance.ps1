#requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("Validate", "Run")]
    [string]$Mode,

    [Parameter(Mandatory)]
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:HarnessPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "classpilot-load-test.mjs"))
$script:MonitorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "aws-rollout-monitor.ps1"))
$script:FixtureToolPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "prepare-classpilot-load-test.mjs"))
$script:ExpectedAccountId = "135775632425"
$script:ExpectedRegion = "us-east-1"
$script:WorkloadSchemaVersion = "classpilot-tile-batch-v1"
$script:EndpointShapeSha256 = "8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"
$script:MonitorHeartbeatMaximumAgeSeconds = 180
$script:TargetHealthTimeoutSeconds = 900
$script:ChildExitGraceSeconds = 30
$script:StageProfiles = [ordered]@{
    "500" = [ordered]@{ devices = 510; durationSeconds = 1800; targetsPerClass = 25 }
    "800" = [ordered]@{ devices = 810; durationSeconds = 5400; targetsPerClass = 40 }
}

function Get-Value {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    if ($Object -is [Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    $member = $Object.PSObject.Properties[$Name]
    if ($null -eq $member) { return $Default }
    return $member.Value
}

function Assert-ExactKeys {
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string[]]$Required,
        [string[]]$Optional = @(),
        [Parameter(Mandatory)][string]$Name
    )
    if ($null -eq $Object -or $Object -is [string] -or $Object -is [ValueType]) {
        throw "$Name must be a JSON object."
    }
    $properties = @($Object.PSObject.Properties.Name)
    foreach ($requiredName in $Required) {
        if ($requiredName -notin $properties) { throw "$Name is missing '$requiredName'." }
    }
    $allowed = @($Required) + @($Optional)
    foreach ($property in $properties) {
        if ($property -notin $allowed) { throw "$Name contains unsupported field '$property'." }
    }
}

function Get-RequiredString {
    param($Object, [string]$Name, [string]$Owner = "Configuration")
    $value = Get-Value $Object $Name
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$value)) {
        throw "$Owner requires nonempty string '$Name'."
    }
    return [string]$value
}

function Get-RequiredBoolean {
    param($Object, [string]$Name, [string]$Owner = "Configuration")
    $value = Get-Value $Object $Name
    if ($value -isnot [bool]) { throw "$Owner requires JSON boolean '$Name'." }
    return [bool]$value
}

function Assert-SafeIdentifier {
    param([string]$Value, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 120 -or
        $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "$Name must be a filename-safe identifier of at most 120 characters."
    }
    return $Value
}

function Assert-Sha256 {
    param([string]$Value, [string]$Name, [switch]$ImageDigest)
    $pattern = if ($ImageDigest) { '^sha256:[0-9a-f]{64}$' } else { '^[0-9a-f]{64}$' }
    $normalized = $Value.ToLowerInvariant()
    if ($normalized -notmatch $pattern) { throw "$Name must be an exact lowercase SHA-256 value." }
    return $normalized
}

function Get-StringSha256 {
    param([AllowEmptyString()][string]$Value)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Get-CanonicalSha256 {
    param($Value)
    return Get-StringSha256 ($Value | ConvertTo-Json -Depth 50 -Compress)
}

function Get-CapacityRunMutexName {
    param($Config)
    # Capacity traffic is a production-wide singleton. Its lock must not vary
    # with a run ID, config hash, or evidence root because those are precisely
    # the values an overlapping invocation can change.
    $identity = "{0}|{1}|production-capacity" -f $script:ExpectedAccountId, $script:ExpectedRegion
    return "Local\SchoolPilotCapacityRun-$(Get-StringSha256 $identity)"
}

function Get-CapacityCampaignLockPath {
    $localAppData = [string]$env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData) -or
        -not [IO.Path]::IsPathRooted($localAppData)) {
        throw "LOCALAPPDATA is unavailable for the persistent production campaign lock."
    }
    $root = [IO.Path]::GetFullPath((Join-Path $localAppData "SchoolPilot\capacity-acceptance"))
    return [pscustomobject]@{
        Root = $root
        Path = Join-Path $root "production-campaign-lock.private.json"
    }
}

function Get-CapacityRunIdentity {
    param($Config)
    return [ordered]@{
        runId = [string]$Config.RunId
        configSha256 = [string]$Config.Sha256
        applicationGitSha = [string]$Config.ApplicationGitSha
        imageDigest = [string]$Config.ImageDigest
        apiTaskDefinitionArn = [string]$Config.ApiTaskDefinitionArn
        workerTaskDefinitionArn = [string]$Config.WorkerTaskDefinitionArn
        stageBindings = @($Config.Stages | ForEach-Object {
            [ordered]@{ stage = [string]$_.Stage; runId = [string]$_.RunId }
        })
    }
}

function Get-CapacityCampaignAdmission {
    param($Config)
    $identity = Get-CapacityRunIdentity $Config
    return [ordered]@{
        runId = [string]$Config.RunId
        configSha256 = [string]$Config.Sha256
        runIdentitySha256 = Get-CanonicalSha256 $identity
        admittedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    }
}

function Assert-CapacityCampaignAdmission {
    param($Config, $Admission)
    Assert-ExactKeys $Admission @(
        "runId", "configSha256", "runIdentitySha256", "admittedAtUtc"
    ) @() "production campaign admission"
    $admittedAt = Get-UtcTimestamp $Admission "admittedAtUtc" "production campaign admission"
    if ($admittedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or
        [string](Get-Value $Admission "runId" "") -cne [string]$Config.RunId -or
        [string](Get-Value $Admission "configSha256" "") -cne [string]$Config.Sha256 -or
        [string](Get-Value $Admission "runIdentitySha256" "") -cne
            (Get-CanonicalSha256 (Get-CapacityRunIdentity $Config))) {
        throw "A different immutable production capacity campaign is already admitted."
    }
}

function Enter-CapacityCampaignAdmission {
    param($Config)
    $binding = Get-CapacityCampaignLockPath
    if (Test-Path -LiteralPath $binding.Path -PathType Leaf) {
        Assert-CurrentUserPrivateAcl $binding.Path "persistent production campaign admission"
        $admission = Read-JsonFile $binding.Path "persistent production campaign admission"
        Assert-CapacityCampaignAdmission $Config $admission
        if (-not (Test-Path -LiteralPath $Config.EvidenceRoot -PathType Container)) {
            # The only instructions between CreateNew of the persistent marker
            # and creation of this root are local ACL/file operations. Recover
            # that exact crash boundary locally, then force report-only reentry.
            New-Item -ItemType Directory -Path $Config.EvidenceRoot | Out-Null
            Set-CurrentUserPrivateAcl $Config.EvidenceRoot -Directory
            Write-AtomicJson (Join-Path $Config.EvidenceRoot "run-identity.json") `
                (Get-CapacityRunIdentity $Config)
        }
        Assert-CapacityRunIdentity $Config
        return [pscustomobject]@{
            Existing = $true
            Path = $binding.Path
            Admission = $admission
        }
    }
    if (Test-Path -LiteralPath $binding.Root) {
        Assert-CurrentUserPrivateAcl $binding.Root "production campaign lock root" -Directory
    }
    else {
        New-Item -ItemType Directory -Path $binding.Root -Force | Out-Null
        Set-CurrentUserPrivateAcl $binding.Root -Directory
    }
    if (Test-Path -LiteralPath $Config.EvidenceRoot) {
        throw "An evidence root exists without its persistent production campaign admission."
    }
    $admission = Get-CapacityCampaignAdmission $Config
    $json = $admission | ConvertTo-Json -Depth 10
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    try {
        $stream = [IO.FileStream]::new(
            $binding.Path,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
        Set-CurrentUserPrivateAcl $binding.Path
    }
    catch [IO.IOException] {
        if (-not (Test-Path -LiteralPath $binding.Path -PathType Leaf)) { throw }
        $observed = Read-JsonFile $binding.Path "concurrent production campaign admission"
        Assert-CapacityCampaignAdmission $Config $observed
        throw "The immutable production capacity campaign was concurrently admitted; rerun is prohibited."
    }
    Assert-CurrentUserPrivateAcl $binding.Path "production campaign admission"
    $sealed = Read-JsonFile $binding.Path "sealed production campaign admission"
    Assert-CapacityCampaignAdmission $Config $sealed
    # Complete the admission operation before any read-only provider preflight.
    # If the controller dies between these two durable writes, the exact-binding
    # branch above creates only this consumed root and cannot resume workload.
    New-Item -ItemType Directory -Path $Config.EvidenceRoot | Out-Null
    Set-CurrentUserPrivateAcl $Config.EvidenceRoot -Directory
    Write-AtomicJson (Join-Path $Config.EvidenceRoot "run-identity.json") `
        (Get-CapacityRunIdentity $Config)
    return [pscustomobject]@{
        Existing = $false
        Path = $binding.Path
        Admission = $sealed
    }
}

function Assert-CapacityRunIdentity {
    param($Config)
    $path = Join-Path $Config.EvidenceRoot "run-identity.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "The consumed evidence root lacks its immutable run identity."
    }
    $observed = Read-JsonFile $path "capacity run identity"
    if ((Get-CanonicalSha256 $observed) -cne
        (Get-CanonicalSha256 (Get-CapacityRunIdentity $Config))) {
        throw "The consumed evidence root belongs to a different immutable run identity."
    }
}

function Resolve-ExternalPath {
    param([string]$Path, [string]$Name, [switch]$AllowMissing)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path) -or
        $Path.StartsWith("\\?\") -or $Path.StartsWith("\\.\")) {
        throw "$Name must be an ordinary absolute path."
    }
    $absolute = [IO.Path]::GetFullPath($Path)
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $repo = $script:RepositoryRoot.TrimEnd('\', '/')
    if ([string]::Equals($absolute.TrimEnd('\', '/'), $repo, $comparison) -or
        $absolute.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw "$Name must be outside the repository."
    }
    $cursor = $absolute
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Name must not traverse a reparse point."
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

function Get-CapacityLoadGatesRoot {
    $localAppData = [string]$env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData) -or
        -not [IO.Path]::IsPathRooted($localAppData)) {
        throw "LOCALAPPDATA is unavailable for the private load-gates root."
    }
    return [IO.Path]::GetFullPath((Join-Path $localAppData "SchoolPilot\load-gates"))
}

function Assert-StrictChildPath {
    param([string]$Child, [string]$Parent, [string]$Name)
    $childFull = [IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $comparison = if ($IsWindows) {
        [StringComparison]::OrdinalIgnoreCase
    } else {
        [StringComparison]::Ordinal
    }
    if ([string]::Equals($childFull, $parentFull, $comparison) -or
        -not $childFull.StartsWith(
            $parentFull + [IO.Path]::DirectorySeparatorChar,
            $comparison
        )) {
        throw "$Name must remain a strict child of the private load-gates root."
    }
}

function Test-PathsOverlap {
    param([string]$Left, [string]$Right)
    $comparison = if ($IsWindows) {
        [StringComparison]::OrdinalIgnoreCase
    } else {
        [StringComparison]::Ordinal
    }
    $leftPath = [IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
    $rightPath = [IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
    $separator = [IO.Path]::DirectorySeparatorChar
    return [string]::Equals($leftPath, $rightPath, $comparison) -or
        $leftPath.StartsWith($rightPath + $separator, $comparison) -or
        $rightPath.StartsWith($leftPath + $separator, $comparison)
}

function Assert-CurrentUserPrivateAcl {
    param([string]$Path, [string]$Name, [switch]$Directory)
    if (-not $IsWindows) { throw "$Name requires Windows ACL enforcement." }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne [bool]$Directory -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Name has the wrong type or is a reparse point."
    }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $expectedInheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
    if ($owner.Value -cne $currentSid.Value -or -not $acl.AreAccessRulesProtected -or
        $rules.Count -ne 1 -or $rules[0].IsInherited -or
        $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rules[0].IdentityReference.Value -cne $currentSid.Value -or
        (($rules[0].FileSystemRights -band $fullControl) -ne $fullControl) -or
        $rules[0].InheritanceFlags -ne $expectedInheritance -or
        $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw "$Name must have one protected current-user FullControl rule."
    }
}

function Set-CurrentUserPrivateAcl {
    param([string]$Path, [switch]$Directory)
    if (-not $IsWindows) { throw "Capacity acceptance requires Windows ACL enforcement." }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = if ($Directory) {
        [Security.AccessControl.DirectorySecurity]::new()
    } else {
        [Security.AccessControl.FileSecurity]::new()
    }
    $security.SetOwner($currentSid)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $currentSid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    Set-Acl -LiteralPath $Path -AclObject $security
    Assert-CurrentUserPrivateAcl $Path "private capacity-acceptance artifact" -Directory:$Directory
}

function Assert-ExactDirectChildren {
    param([string]$Root, [string[]]$ExpectedNames, [string]$Name)
    $children = @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction Stop)
    if (@($children | Where-Object {
            ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $_.PSIsContainer
        }).Count -ne 0) {
        throw "$Name must contain only ordinary files."
    }
    $actual = @($children.Name | Sort-Object)
    $expected = @($ExpectedNames | Sort-Object)
    if (@(Compare-Object $actual $expected -CaseSensitive).Count -ne 0) {
        throw "$Name contains missing or unexpected files."
    }
}

function Get-UtcTimestamp {
    param($Object, [string]$Name, [string]$Owner)
    $raw = Get-RequiredString $Object $Name $Owner
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact(
            $raw,
            "o",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None,
            [ref]$parsed
        ) -or $parsed.Offset -ne [TimeSpan]::Zero) {
        throw "$Owner.$Name must be an ISO-8601 timestamp with an explicit zero offset."
    }
    return $parsed.ToUniversalTime()
}

function Test-IntervalContainsSchedulerTicks {
    param([DateTimeOffset]$StartUtc, [int]$DurationSeconds)
    try { $zone = [TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time") }
    catch { $zone = [TimeZoneInfo]::FindSystemTimeZoneById("America/New_York") }
    $endUtc = $StartUtc.AddSeconds($DurationSeconds)
    $localStart = [TimeZoneInfo]::ConvertTime($StartUtc, $zone)
    foreach ($offset in -1..1) {
        $date = $localStart.Date.AddDays($offset)
        $purgeLocal = [DateTime]::SpecifyKind($date.AddHours(1).AddMinutes(30), [DateTimeKind]::Unspecified)
        $rollupLocal = [DateTime]::SpecifyKind($date.AddHours(2), [DateTimeKind]::Unspecified)
        $purgeUtc = [DateTimeOffset]([TimeZoneInfo]::ConvertTimeToUtc($purgeLocal, $zone))
        $rollupUtc = [DateTimeOffset]([TimeZoneInfo]::ConvertTimeToUtc($rollupLocal, $zone))
        if ($StartUtc -le $purgeUtc -and $endUtc -ge $rollupUtc) { return $true }
    }
    return $false
}

function Write-AtomicJson {
    param([string]$Path, $Value)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Artifact parent directory does not exist."
    }
    $temporary = Join-Path $parent (".{0}.{1}.tmp" -f ([IO.Path]::GetFileName($Path)), [Guid]::NewGuid().ToString("N"))
    try {
        [IO.File]::WriteAllText(
            $temporary,
            ($Value | ConvertTo-Json -Depth 50),
            [Text.UTF8Encoding]::new($false)
        )
        Set-CurrentUserPrivateAcl $temporary
        Move-Item -LiteralPath $temporary -Destination $Path
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-AtomicJsonReplace {
    param([string]$Path, $Value)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Artifact parent directory does not exist."
    }
    $temporary = Join-Path $parent (".{0}.{1}.tmp" -f ([IO.Path]::GetFileName($Path)), [Guid]::NewGuid().ToString("N"))
    try {
        [IO.File]::WriteAllText(
            $temporary,
            ($Value | ConvertTo-Json -Depth 50),
            [Text.UTF8Encoding]::new($false)
        )
        Set-CurrentUserPrivateAcl $temporary
        [IO.File]::Move($temporary, $Path, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Read-JsonFile {
    param([string]$Path, [string]$Name)
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -DateKind String -Depth 50 }
    catch { throw "$Name must contain valid date-preserving JSON." }
}

function Read-CapacityConfiguration {
    $path = Resolve-ExternalPath $ConfigPath "ConfigPath"
    $sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $raw = Read-JsonFile $path "ConfigPath"
    Assert-ExactKeys $raw @(
        "schemaVersion", "engineeringAcceptance", "runId", "baseUrl", "evidenceRoot", "reportPath",
        "fixture", "deploymentIdentity", "expectedGeneratorPublicIp", "notificationTopicArn",
        "resources", "stages"
    ) @() "Capacity acceptance config"
    if ([int](Get-Value $raw "schemaVersion" 0) -ne 1 -or
        (Get-RequiredBoolean $raw "engineeringAcceptance" "Capacity acceptance config") -ne $true) {
        throw "Capacity acceptance config requires schemaVersion=1 and engineeringAcceptance=true."
    }
    $runId = Assert-SafeIdentifier (Get-RequiredString $raw "runId") "runId"
    $baseUrl = (Get-RequiredString $raw "baseUrl").TrimEnd('/')
    if ($baseUrl -cne "https://school-pilot.net") {
        throw "Capacity acceptance must target https://school-pilot.net through CloudFront."
    }
    $evidenceRoot = Resolve-ExternalPath (Get-RequiredString $raw "evidenceRoot") "evidenceRoot" -AllowMissing
    $reportPath = Resolve-ExternalPath (Get-RequiredString $raw "reportPath") "reportPath" -AllowMissing
    Assert-CurrentUserPrivateAcl $path "ConfigPath"
    $evidenceAclRoot = if (Test-Path -LiteralPath $evidenceRoot -PathType Container) {
        $evidenceRoot
    } else {
        Split-Path -Parent $evidenceRoot
    }
    Assert-CurrentUserPrivateAcl $evidenceAclRoot "evidenceRoot security root" -Directory
    $reportRoot = Split-Path -Parent $reportPath
    Assert-CurrentUserPrivateAcl $reportRoot "reportPath parent" -Directory
    if (Test-Path -LiteralPath $reportPath -PathType Leaf) {
        Assert-CurrentUserPrivateAcl $reportPath "reportPath"
    }

    $fixture = Get-Value $raw "fixture"
    Assert-ExactKeys $fixture @(
        "authorityFixtureId", "authoritySourceRoot", "authorityStateSha256",
        "authorityOwnershipSha256", "configPath", "configSha256", "continuityRoot",
        "stateSha256", "ownershipSha256", "support"
    ) @() "fixture"
    $authorityFixtureId = Get-RequiredString $fixture "authorityFixtureId" "fixture"
    if ($authorityFixtureId -cne "launch-safe-20260711") {
        throw "fixture.authorityFixtureId must bind the launch-safe-20260711 tool-owned authority."
    }
    $authoritySourceRoot = Resolve-ExternalPath (
        Get-RequiredString $fixture "authoritySourceRoot" "fixture"
    ) "fixture.authoritySourceRoot"
    $authorityStateSha256 = Assert-Sha256 (
        Get-RequiredString $fixture "authorityStateSha256" "fixture"
    ) "fixture.authorityStateSha256"
    $authorityOwnershipSha256 = Assert-Sha256 (
        Get-RequiredString $fixture "authorityOwnershipSha256" "fixture"
    ) "fixture.authorityOwnershipSha256"
    Assert-CurrentUserPrivateAcl $authoritySourceRoot "fixture.authoritySourceRoot" -Directory
    $authorityStatePath = Join-Path $authoritySourceRoot "fixture-state.private.json"
    $authorityOwnershipPath = Join-Path $authoritySourceRoot "fixture-ownership.private.json"
    foreach ($source in @(
        @($authorityStatePath, $authorityStateSha256, "authority state"),
        @($authorityOwnershipPath, $authorityOwnershipSha256, "authority ownership")
    )) {
        if (-not (Test-Path -LiteralPath $source[0] -PathType Leaf) -or
            (Get-FileHash -LiteralPath $source[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $source[1]) {
            throw "The durable launch-safe fixture $($source[2]) file does not match its source hash."
        }
        Assert-CurrentUserPrivateAcl $source[0] "fixture $($source[2]) file"
    }
    $fixtureConfigPath = Resolve-ExternalPath (Get-RequiredString $fixture "configPath" "fixture") "fixture.configPath"
    $fixtureConfigSha256 = Assert-Sha256 (Get-RequiredString $fixture "configSha256" "fixture") "fixture.configSha256"
    if ((Get-FileHash -LiteralPath $fixtureConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $fixtureConfigSha256) {
        throw "fixture.configPath does not match fixture.configSha256."
    }
    $continuityRoot = Resolve-ExternalPath (Get-RequiredString $fixture "continuityRoot" "fixture") "fixture.continuityRoot"
    Assert-StrictChildPath $continuityRoot (Get-CapacityLoadGatesRoot) "fixture.continuityRoot"
    Assert-CurrentUserPrivateAcl $continuityRoot "fixture.continuityRoot" -Directory
    $stateSha256 = Assert-Sha256 (Get-RequiredString $fixture "stateSha256" "fixture") "fixture.stateSha256"
    $ownershipSha256 = Assert-Sha256 (Get-RequiredString $fixture "ownershipSha256" "fixture") "fixture.ownershipSha256"
    foreach ($requiredFixtureFile in @("fixture-state.private.json", "fixture-ownership.private.json")) {
        $requiredFixturePath = Join-Path $continuityRoot $requiredFixtureFile
        if (-not (Test-Path -LiteralPath $requiredFixturePath -PathType Leaf)) {
            throw "fixture.continuityRoot is missing $requiredFixtureFile."
        }
        Assert-CurrentUserPrivateAcl $requiredFixturePath "fixture continuity $requiredFixtureFile"
    }
    $support = Get-Value $fixture "support"
    Assert-ExactKeys $support @(
        "root", "fixturePasswordsPath", "fixturePasswordsSha256",
        "superAdminPasswordPath", "superAdminPasswordSha256",
        "superAdminOperationPath", "superAdminOperationSha256"
    ) @() "fixture.support"
    $supportRoot = Resolve-ExternalPath (Get-RequiredString $support "root" "fixture.support") "fixture.support.root"
    Assert-CurrentUserPrivateAcl $supportRoot "fixture.support.root" -Directory
    $pathComparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if ([string]::Equals(
            [IO.Path]::GetFullPath($supportRoot).TrimEnd('\','/'),
            [IO.Path]::GetFullPath($continuityRoot).TrimEnd('\','/'),
            $pathComparison
        )) {
        throw "The fixture support root must be separate from the mutable continuity root."
    }
    $supportBindings = [ordered]@{}
    foreach ($binding in @(
        @("fixturePasswords", "fixturePasswordsPath", "fixturePasswordsSha256"),
        @("superAdminPassword", "superAdminPasswordPath", "superAdminPasswordSha256"),
        @("superAdminOperation", "superAdminOperationPath", "superAdminOperationSha256")
    )) {
        $boundPath = Resolve-ExternalPath (Get-RequiredString $support $binding[1] "fixture.support") `
            "fixture.support.$($binding[1])"
        $boundSha = Assert-Sha256 (Get-RequiredString $support $binding[2] "fixture.support") `
            "fixture.support.$($binding[2])"
        $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
        if (-not [string]::Equals([IO.Path]::GetFullPath((Split-Path -Parent $boundPath)),
                [IO.Path]::GetFullPath($supportRoot), $comparison) -or
            (Get-FileHash -LiteralPath $boundPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $boundSha) {
            throw "fixture.support.$($binding[0]) must be a hash-bound direct child of the support root."
        }
        $supportBindings[$binding[0]] = [pscustomobject]@{ Path=$boundPath; Sha256=$boundSha }
        Assert-CurrentUserPrivateAcl $boundPath "fixture.support.$($binding[0])"
    }
    if (-not [string]::Equals(
            [IO.Path]::GetFullPath((Split-Path -Parent $fixtureConfigPath)),
            [IO.Path]::GetFullPath($supportRoot),
            $pathComparison
        )) {
        throw "fixture.configPath must be a direct child of fixture.support.root."
    }
    Assert-CurrentUserPrivateAcl $fixtureConfigPath "fixture.configPath"
    Assert-ExactDirectChildren $supportRoot @(
        [IO.Path]::GetFileName($fixtureConfigPath),
        [IO.Path]::GetFileName($supportBindings.fixturePasswords.Path),
        [IO.Path]::GetFileName($supportBindings.superAdminPassword.Path),
        [IO.Path]::GetFileName($supportBindings.superAdminOperation.Path)
    ) "fixture.support.root"
    $identity = Get-Value $raw "deploymentIdentity"
    Assert-ExactKeys $identity @(
        "applicationGitSha", "deployedImageDigest", "apiTaskDefinitionArn", "workerTaskDefinitionArn",
        "rollbackApiTaskDefinitionArn", "rollbackWorkerTaskDefinitionArn"
    ) @() "deploymentIdentity"
    $applicationGitSha = (Get-RequiredString $identity "applicationGitSha" "deploymentIdentity").ToLowerInvariant()
    if ($applicationGitSha -notmatch '^[0-9a-f]{40}$') {
        throw "deploymentIdentity.applicationGitSha must be a 40-character commit SHA."
    }
    $imageDigest = Assert-Sha256 (Get-RequiredString $identity "deployedImageDigest" "deploymentIdentity") `
        "deploymentIdentity.deployedImageDigest" -ImageDigest
    $apiTaskDefinitionArn = Get-RequiredString $identity "apiTaskDefinitionArn" "deploymentIdentity"
    $workerTaskDefinitionArn = Get-RequiredString $identity "workerTaskDefinitionArn" "deploymentIdentity"
    $rollbackApiTaskDefinitionArn = Get-RequiredString $identity "rollbackApiTaskDefinitionArn" "deploymentIdentity"
    $rollbackWorkerTaskDefinitionArn = Get-RequiredString $identity "rollbackWorkerTaskDefinitionArn" "deploymentIdentity"
    $topLevelPaths = [ordered]@{
        config = $path
        evidence = $evidenceRoot
        report = $reportPath
        authority = $authoritySourceRoot
        continuity = $continuityRoot
        support = $supportRoot
    }
    $topLevelNames = @($topLevelPaths.Keys)
    for ($leftIndex = 0; $leftIndex -lt $topLevelNames.Count; $leftIndex++) {
        for ($rightIndex = $leftIndex + 1; $rightIndex -lt $topLevelNames.Count; $rightIndex++) {
            $leftName = $topLevelNames[$leftIndex]
            $rightName = $topLevelNames[$rightIndex]
            if (Test-PathsOverlap $topLevelPaths[$leftName] $topLevelPaths[$rightName]) {
                throw "Capacity acceptance paths '$leftName' and '$rightName' must be disjoint."
            }
        }
    }
    if ($apiTaskDefinitionArn -notmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api(?:-emergency)?:[1-9][0-9]*$' -or
        $workerTaskDefinitionArn -notmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:[1-9][0-9]*$' -or
        $rollbackApiTaskDefinitionArn -notmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api(?:-emergency)?:[1-9][0-9]*$' -or
        $rollbackWorkerTaskDefinitionArn -notmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:[1-9][0-9]*$' -or
        $rollbackApiTaskDefinitionArn -ceq $apiTaskDefinitionArn -or
        $rollbackWorkerTaskDefinitionArn -ceq $workerTaskDefinitionArn) {
        throw "deploymentIdentity must bind distinct exact revisioned active and rollback API/worker task definitions."
    }

    $expectedGeneratorPublicIp = Get-RequiredString $raw "expectedGeneratorPublicIp"
    $address = $null
    if (-not [Net.IPAddress]::TryParse($expectedGeneratorPublicIp, [ref]$address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw "expectedGeneratorPublicIp must be an IPv4 literal."
    }
    $notificationTopicArn = Get-RequiredString $raw "notificationTopicArn"
    if ($notificationTopicArn -notmatch '^arn:aws:sns:us-east-1:135775632425:[A-Za-z0-9_.-]+$') {
        throw "notificationTopicArn must be a production-account us-east-1 SNS topic ARN."
    }

    $resources = Get-Value $raw "resources"
    Assert-ExactKeys $resources @(
        "region", "accountId", "cluster", "apiService", "workerService", "rdsInstanceId",
        "redisCacheClusterId", "redisReplicationGroupId", "vpcId", "wafWebAclName",
        "wafDeviceClassifierMetricName", "wafDeviceRuleMetricName", "wafApiRuleMetricName",
        "cloudFrontDistributionId", "targetGroupArn", "route53HealthCheckId", "route53AlarmName",
        "expectedNatGatewayCount", "expectedRoute53MeasureLatency", "expectedEcsAssignPublicIp",
        "ecsTaskSubnetIds", "expectedRedisNodeType", "expectedRdsInstanceClass",
        "expectedActiveApiTaskDefinitionArn", "expectedActiveWorkerTaskDefinitionArn"
    ) @("expectedRdsPosture") "resources"
    foreach ($name in @(
        "region", "accountId", "cluster", "apiService", "workerService", "rdsInstanceId",
        "redisCacheClusterId", "redisReplicationGroupId", "vpcId", "wafWebAclName",
        "wafDeviceClassifierMetricName", "wafDeviceRuleMetricName", "wafApiRuleMetricName",
        "cloudFrontDistributionId", "targetGroupArn", "route53HealthCheckId", "route53AlarmName",
        "expectedRedisNodeType", "expectedRdsInstanceClass", "expectedActiveApiTaskDefinitionArn",
        "expectedActiveWorkerTaskDefinitionArn"
    )) { [void](Get-RequiredString $resources $name "resources") }
    $subnets = @((Get-Value $resources "ecsTaskSubnetIds" @()) | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    if ([string]$resources.region -cne $script:ExpectedRegion -or
        [string]$resources.accountId -cne $script:ExpectedAccountId -or
        [string]$resources.cluster -cne "schoolpilot-production-cluster" -or
        [string]$resources.apiService -cne "schoolpilot-production-api" -or
        [string]$resources.workerService -cne "schoolpilot-production-scheduler-worker" -or
        [string]$resources.expectedRdsInstanceClass -cne "db.t4g.medium" -or
        [string]$resources.expectedRedisNodeType -cne "cache.t4g.small" -or
        [int](Get-Value $resources "expectedNatGatewayCount" -1) -ne 2 -or
        (Get-RequiredBoolean $resources "expectedRoute53MeasureLatency" "resources") -ne $true -or
        (Get-RequiredBoolean $resources "expectedEcsAssignPublicIp" "resources") -ne $false -or
        [string]$resources.expectedActiveApiTaskDefinitionArn -cne $apiTaskDefinitionArn -or
        [string]$resources.expectedActiveWorkerTaskDefinitionArn -cne $workerTaskDefinitionArn -or
        $subnets.Count -lt 2 -or @($subnets | Where-Object { $_ -notmatch '^subnet-[0-9a-f]+$' }).Count -gt 0) {
        throw "resources must bind the exact production private medium/small Waf posture."
    }

    $rawStages = @(Get-Value $raw "stages" @())
    if ($rawStages.Count -ne 2) { throw "stages must contain exactly Waf/500 then Waf/800." }
    $stages = @()
    for ($index = 0; $index -lt 2; $index++) {
        $stage = $rawStages[$index]
        Assert-ExactKeys $stage @("stage", "runId", "trafficStartNotBeforeUtc", "trafficStartNotAfterUtc") @() "stages[$index]"
        $expectedStage = if ($index -eq 0) { "500" } else { "800" }
        if ((Get-RequiredString $stage "stage" "stages[$index]") -cne $expectedStage) {
            throw "stages must be ordered Waf/500 then Waf/800."
        }
        $stageRunId = Assert-SafeIdentifier (Get-RequiredString $stage "runId" "stages[$index]") "stages[$index].runId"
        $notBefore = Get-UtcTimestamp $stage "trafficStartNotBeforeUtc" "stages[$index]"
        $notAfter = Get-UtcTimestamp $stage "trafficStartNotAfterUtc" "stages[$index]"
        if ($notAfter -le $notBefore -or ($notAfter - $notBefore).TotalMinutes -gt 15) {
            throw "stages[$index] traffic start window must be positive and at most 15 minutes."
        }
        if ($expectedStage -eq "800" -and
            (-not (Test-IntervalContainsSchedulerTicks $notBefore 5400) -or
             -not (Test-IntervalContainsSchedulerTicks $notAfter 5400))) {
            throw "Waf/800 traffic window must guarantee coverage of the 01:30 purge and 02:00 rollup."
        }
        $stages += [pscustomobject]@{
            Stage = $expectedStage
            RunId = $stageRunId
            TrafficStartNotBeforeUtc = $notBefore
            TrafficStartNotAfterUtc = $notAfter
            Profile = $script:StageProfiles[$expectedStage]
        }
    }
    if ($stages[0].TrafficStartNotAfterUtc.AddSeconds(1800) -ge $stages[1].TrafficStartNotBeforeUtc) {
        throw "Waf/500 must have a restoration interval before Waf/800 preparation and traffic."
    }
    try { $eastern = [TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time") }
    catch { $eastern = [TimeZoneInfo]::FindSystemTimeZoneById("America/New_York") }
    $waf500LocalStart = [TimeZoneInfo]::ConvertTime($stages[0].TrafficStartNotBeforeUtc, $eastern)
    $waf500LocalEnd = [TimeZoneInfo]::ConvertTime($stages[0].TrafficStartNotAfterUtc, $eastern)
    $waf800LocalStart = [TimeZoneInfo]::ConvertTime($stages[1].TrafficStartNotBeforeUtc, $eastern)
    $waf800LocalEnd = [TimeZoneInfo]::ConvertTime($stages[1].TrafficStartNotAfterUtc, $eastern)
    $localStartDelta = (
        $waf800LocalStart.DateTime - $waf500LocalStart.DateTime
    ).TotalMinutes
    $localEndDelta = (
        $waf800LocalEnd.DateTime - $waf500LocalEnd.DateTime
    ).TotalMinutes
    $waf500Minute = $waf500LocalStart.Hour * 60 + $waf500LocalStart.Minute
    $waf800Minute = $waf800LocalStart.Hour * 60 + $waf800LocalStart.Minute
    if ($waf500Minute -lt (22 * 60 + 25) -or $waf500Minute -gt (22 * 60 + 35) -or
        $waf800Minute -lt (1 * 60 + 10) -or $waf800Minute -gt (1 * 60 + 20) -or
        $waf800LocalStart.Date -ne $waf500LocalStart.Date.AddDays(1) -or
        $localStartDelta -ne 165 -or $localEndDelta -ne 165 -or
        ($stages[0].TrafficStartNotAfterUtc - $stages[0].TrafficStartNotBeforeUtc) -ne
            ($stages[1].TrafficStartNotAfterUtc - $stages[1].TrafficStartNotBeforeUtc)) {
        throw "Waf/500 and Waf/800 windows must move together at approximately 22:30 and 01:15 ET on consecutive dates."
    }
    if (@($stages.RunId | Sort-Object -Unique).Count -ne 2 -or $stages.RunId -contains $runId) {
        throw "Campaign and stage run IDs must all be distinct."
    }

    return [pscustomobject]@{
        Raw = $raw
        Path = $path
        Sha256 = $sha256
        RunId = $runId
        BaseUrl = $baseUrl
        EvidenceRoot = $evidenceRoot
        ReportPath = $reportPath
        FixtureConfigPath = $fixtureConfigPath
        FixtureConfigSha256 = $fixtureConfigSha256
        ContinuityRoot = $continuityRoot
        AuthorityFixtureId = $authorityFixtureId
        AuthoritySourceRoot = $authoritySourceRoot
        AuthorityStatePath = $authorityStatePath
        AuthorityOwnershipPath = $authorityOwnershipPath
        AuthorityStateSha256 = $authorityStateSha256
        AuthorityOwnershipSha256 = $authorityOwnershipSha256
        FixtureStateSha256 = $stateSha256
        FixtureOwnershipSha256 = $ownershipSha256
        FixtureSupportRoot = $supportRoot
        FixtureSupport = $supportBindings
        ApplicationGitSha = $applicationGitSha
        ImageDigest = $imageDigest
        ApiTaskDefinitionArn = $apiTaskDefinitionArn
        WorkerTaskDefinitionArn = $workerTaskDefinitionArn
        RollbackApiTaskDefinitionArn = $rollbackApiTaskDefinitionArn
        RollbackWorkerTaskDefinitionArn = $rollbackWorkerTaskDefinitionArn
        ExpectedGeneratorPublicIp = $expectedGeneratorPublicIp
        NotificationTopicArn = $notificationTopicArn
        Resources = $resources
        Stages = $stages
    }
}

function Invoke-BoundedProcess {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [hashtable]$Environment = @{},
        [int]$TimeoutSeconds = 60,
        [string]$StdoutPath = "",
        [string]$StderrPath = ""
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($entry in $Environment.GetEnumerator()) {
        if ($null -eq $entry.Value) {
            [void]$startInfo.Environment.Remove([string]$entry.Key)
        }
        else {
            $startInfo.Environment[[string]$entry.Key] = [string]$entry.Value
        }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "Unable to start bounded child process." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill($true) } catch { }
            [void]$process.WaitForExit(15000)
            throw "Bounded child process exceeded its timeout."
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($StdoutPath) { [IO.File]::WriteAllText($StdoutPath, $stdout, [Text.UTF8Encoding]::new($false)) }
        if ($StderrPath) { [IO.File]::WriteAllText($StderrPath, $stderr, [Text.UTF8Encoding]::new($false)) }
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout
            Stderr = $stderr
            ProcessId = $process.Id
        }
    }
    finally { $process.Dispose() }
}

function Invoke-AwsJson {
    param([string[]]$Arguments, [int]$TimeoutSeconds = 60)
    $result = Invoke-BoundedProcess -FilePath $script:AwsPath `
        -Arguments (@($Arguments) + @("--output", "json")) -TimeoutSeconds $TimeoutSeconds
    if ($result.ExitCode -ne 0) {
        throw "AWS CLI request failed for $($Arguments[0]) $($Arguments[1])."
    }
    if ([string]::IsNullOrWhiteSpace($result.Stdout)) { return $null }
    try { return $result.Stdout | ConvertFrom-Json -DateKind String -Depth 50 }
    catch { throw "AWS CLI returned malformed JSON for $($Arguments[0]) $($Arguments[1])." }
}

function Invoke-AwsCommand {
    param([string[]]$Arguments, [int]$TimeoutSeconds = 900)
    $result = Invoke-BoundedProcess -FilePath $script:AwsPath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds
    if ($result.ExitCode -ne 0) {
        throw "AWS CLI mutation failed for $($Arguments[0]) $($Arguments[1])."
    }
}

function Get-ScalingSnapshot {
    param($Config)
    $resourceId = "service/$($Config.Resources.cluster)/$($Config.Resources.apiService)"
    $targets = Invoke-AwsJson @(
        "application-autoscaling", "describe-scalable-targets", "--region", $Config.Resources.region,
        "--service-namespace", "ecs", "--resource-ids", $resourceId,
        "--scalable-dimension", "ecs:service:DesiredCount"
    )
    $target = @($targets.ScalableTargets)
    if ($target.Count -ne 1) { throw "The API scalable target was not uniquely resolved." }
    $suspended = Get-Value $target[0] "SuspendedState"
    $actions = Invoke-AwsJson @(
        "application-autoscaling", "describe-scheduled-actions", "--region", $Config.Resources.region,
        "--service-namespace", "ecs", "--resource-id", $resourceId,
        "--scalable-dimension", "ecs:service:DesiredCount"
    )
    $scheduled = @($actions.ScheduledActions | Sort-Object ScheduledActionName | ForEach-Object {
        [ordered]@{
            name = [string]$_.ScheduledActionName
            schedule = [string]$_.Schedule
            timezone = [string]$_.Timezone
            minCapacity = Get-Value $_.ScalableTargetAction "MinCapacity"
            maxCapacity = Get-Value $_.ScalableTargetAction "MaxCapacity"
        }
    })
    $policiesResponse = Invoke-AwsJson @(
        "application-autoscaling", "describe-scaling-policies", "--region", $Config.Resources.region,
        "--service-namespace", "ecs", "--resource-id", $resourceId,
        "--scalable-dimension", "ecs:service:DesiredCount"
    )
    $policies = @($policiesResponse.ScalingPolicies | Sort-Object PolicyName | ForEach-Object {
        [ordered]@{
            name = [string]$_.PolicyName
            type = [string]$_.PolicyType
            targetTracking = $_.TargetTrackingScalingPolicyConfiguration
        }
    })
    return [ordered]@{
        resourceId = $resourceId
        minCapacity = [int]$target[0].MinCapacity
        maxCapacity = [int]$target[0].MaxCapacity
        suspendedState = [ordered]@{
            DynamicScalingInSuspended = [bool](Get-Value $suspended "DynamicScalingInSuspended" $false)
            DynamicScalingOutSuspended = [bool](Get-Value $suspended "DynamicScalingOutSuspended" $false)
            ScheduledScalingSuspended = [bool](Get-Value $suspended "ScheduledScalingSuspended" $false)
        }
        scheduledActionsSha256 = Get-CanonicalSha256 $scheduled
        scalingPoliciesSha256 = Get-CanonicalSha256 $policies
        scheduledActions = $scheduled
        scalingPolicies = $policies
    }
}

function Assert-ProductionScalingContract {
    param($Scaling)
    $actions = @($Scaling.scheduledActions)
    $policies = @($Scaling.scalingPolicies)
    $up = @($actions | Where-Object name -ceq "schoolpilot-production-api-arrival-scale-up")
    $down = @($actions | Where-Object name -ceq "schoolpilot-production-api-arrival-scale-down")
    $cpu = @($policies | Where-Object name -ceq "schoolpilot-production-api-cpu-scaling")
    $target = if ($cpu.Count -eq 1) { Get-Value $cpu[0] "targetTracking" } else { $null }
    $metric = Get-Value $target "PredefinedMetricSpecification"
    if ($actions.Count -ne 2 -or $up.Count -ne 1 -or $down.Count -ne 1 -or
        [string]$up[0].schedule -cne "cron(45 5 ? * MON-FRI *)" -or
        [string]$up[0].timezone -cne "America/New_York" -or
        [int]$up[0].minCapacity -ne 6 -or $null -ne $up[0].maxCapacity -or
        [string]$down[0].schedule -cne "cron(0 10 ? * MON-FRI *)" -or
        [string]$down[0].timezone -cne "America/New_York" -or
        [int]$down[0].minCapacity -ne 1 -or $null -ne $down[0].maxCapacity -or
        $policies.Count -ne 1 -or $cpu.Count -ne 1 -or
        [string]$cpu[0].type -cne "TargetTrackingScaling" -or
        [double](Get-Value $target "TargetValue" -1) -ne 70.0 -or
        [int](Get-Value $target "ScaleInCooldown" -1) -ne 300 -or
        [int](Get-Value $target "ScaleOutCooldown" -1) -ne 60 -or
        [string](Get-Value $metric "PredefinedMetricType" "") -cne
            "ECSServiceAverageCPUUtilization" -or
        [int]$Scaling.maxCapacity -ne 8 -or [int]$Scaling.minCapacity -notin @(1, 6) -or
        $Scaling.suspendedState.DynamicScalingInSuspended -ne $false -or
        $Scaling.suspendedState.DynamicScalingOutSuspended -ne $false -or
        $Scaling.suspendedState.ScheduledScalingSuspended -ne $false) {
        throw "Production API scaling does not match the committed 05:45/10:00 ET and 70% CPU contract."
    }
}

function Assert-HeldCapacityPosture {
    param($Services, $Targets, $Scaling)
    $baselineSemantics = [ordered]@{
        minCapacity = 1
        maxCapacity = 8
        suspendedState = [ordered]@{
            DynamicScalingInSuspended = $false
            DynamicScalingOutSuspended = $false
            ScheduledScalingSuspended = $false
        }
        scheduledActions = @($Scaling.scheduledActions)
        scalingPolicies = @($Scaling.scalingPolicies)
    }
    Assert-ProductionScalingContract $baselineSemantics
    if ([int]$Services.api.desired -ne 6 -or [int]$Services.api.running -ne 6 -or
        [int]$Services.api.pending -ne 0 -or
        [int]$Services.worker.desired -ne 1 -or [int]$Services.worker.running -ne 1 -or
        [int]$Services.worker.pending -ne 0 -or
        [int]$Targets.total -ne 6 -or [int]$Targets.healthy -ne 6 -or
        [int]$Targets.nonHealthy -ne 0 -or
        [int]$Scaling.minCapacity -ne 6 -or [int]$Scaling.maxCapacity -ne 8 -or
        $Scaling.suspendedState.DynamicScalingInSuspended -ne $false -or
        $Scaling.suspendedState.DynamicScalingOutSuspended -ne $true -or
        $Scaling.suspendedState.ScheduledScalingSuspended -ne $false) {
        throw "Production is not at the exact healthy six-API held-capacity posture."
    }
}

function Get-ServicePosture {
    param($Config)
    $response = Invoke-AwsJson @(
        "ecs", "describe-services", "--region", $Config.Resources.region, "--cluster", $Config.Resources.cluster,
        "--services", $Config.Resources.apiService, $Config.Resources.workerService
    )
    $services = @($response.services)
    if ($services.Count -ne 2 -or @($response.failures).Count -ne 0) {
        throw "Both production ECS services must resolve without failures."
    }
    $result = [ordered]@{}
    foreach ($binding in @(
        @("api", [string]$Config.Resources.apiService, $Config.ApiTaskDefinitionArn),
        @("worker", [string]$Config.Resources.workerService, $Config.WorkerTaskDefinitionArn)
    )) {
        $matches = @($services | Where-Object serviceName -eq $binding[1])
        if ($matches.Count -ne 1) { throw "The $($binding[0]) service was not uniquely resolved." }
        $service = $matches[0]
        if ([string]$service.taskDefinition -cne [string]$binding[2] -or
            [int]$service.desiredCount -lt 1 -or [int]$service.runningCount -ne [int]$service.desiredCount -or
            [int]$service.pendingCount -ne 0 -or @($service.deployments).Count -ne 1 -or
            [string]$service.deployments[0].status -cne "PRIMARY" -or
            [string]$service.deployments[0].rolloutState -cne "COMPLETED") {
            throw "The $($binding[0]) service is not stable on its exact bound task definition."
        }
        $network = $service.networkConfiguration.awsvpcConfiguration
        $subnets = @($network.subnets | ForEach-Object { [string]$_ } | Sort-Object -Unique)
        $expectedSubnets = @($Config.Resources.ecsTaskSubnetIds | ForEach-Object { [string]$_ } | Sort-Object -Unique)
        if ([string]$network.assignPublicIp -cne "DISABLED" -or
            @(Compare-Object $subnets $expectedSubnets).Count -ne 0) {
            throw "The $($binding[0]) service is not in the exact bound private ECS/NAT topology."
        }
        $result[$binding[0]] = [ordered]@{
            desired = [int]$service.desiredCount
            running = [int]$service.runningCount
            pending = [int]$service.pendingCount
            taskDefinitionArn = [string]$service.taskDefinition
            assignPublicIp = "DISABLED"
            subnetSetSha256 = Get-CanonicalSha256 $subnets
        }
    }
    return $result
}

function Get-TargetHealthSnapshot {
    param($Config)
    $response = Invoke-AwsJson @(
        "elbv2", "describe-target-health", "--region", $Config.Resources.region,
        "--target-group-arn", $Config.Resources.targetGroupArn
    )
    $states = @($response.TargetHealthDescriptions | ForEach-Object {
        [string](Get-Value $_.TargetHealth "State" "")
    })
    return [ordered]@{
        total = $states.Count
        healthy = @($states | Where-Object { $_ -ceq "healthy" }).Count
        nonHealthy = @($states | Where-Object { $_ -cne "healthy" }).Count
        states = @($states | Sort-Object)
    }
}

function Wait-TargetHealth {
    param($Config, [int]$ExpectedHealthy)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($script:TargetHealthTimeoutSeconds)
    do {
        $snapshot = Get-TargetHealthSnapshot $Config
        $prohibited = @($snapshot.states | Where-Object { $_ -notin @("healthy", "initial", "draining") })
        if ($prohibited.Count -gt 0) {
            throw "Target health observed a prohibited state."
        }
        if ([int]$snapshot.total -eq $ExpectedHealthy -and [int]$snapshot.healthy -eq $ExpectedHealthy -and
            [int]$snapshot.nonHealthy -eq 0) {
            return $snapshot
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            throw "Target health did not converge to exactly $ExpectedHealthy healthy API targets."
        }
        Start-Sleep -Seconds 5
    } while ($true)
}

function Get-TaskDefinitionPosture {
    param(
        $Config,
        [string]$Arn,
        [string]$ContainerName,
        [string]$ExpectedCpu,
        [string]$ExpectedMemory
    )
    $response = Invoke-AwsJson @(
        "ecs", "describe-task-definition", "--region", $Config.Resources.region, "--task-definition", $Arn
    )
    $definition = $response.taskDefinition
    $containers = @($definition.containerDefinitions | Where-Object name -ceq $ContainerName)
    if ($containers.Count -ne 1 -or [string]$definition.taskDefinitionArn -cne $Arn -or
        [string]$definition.cpu -cne $ExpectedCpu -or [string]$definition.memory -cne $ExpectedMemory) {
        throw "Task definition does not match its exact ARN, container, CPU, or memory identity."
    }
    $image = [string]$containers[0].image
    if ($image -notmatch '@(sha256:[0-9a-f]{64})$' -or $Matches[1].ToLowerInvariant() -cne $Config.ImageDigest) {
        throw "Task definition is not pinned to the bound image digest."
    }
    $logging = $null
    if ($ContainerName -in @("api", "scheduler-worker")) {
        $log = $containers[0].logConfiguration
        $options = Get-Value $log "options"
        $group = [string](Get-Value $options "awslogs-group" "")
        $region = [string](Get-Value $options "awslogs-region" "")
        $prefix = [string](Get-Value $options "awslogs-stream-prefix" "")
        if ([string](Get-Value $log "logDriver" "") -cne "awslogs" -or
            [string]::IsNullOrWhiteSpace($group) -or $region -cne $Config.Resources.region -or
            [string]::IsNullOrWhiteSpace($prefix)) {
            throw "The bound task definition requires an exact awslogs configuration."
        }
        $logging = [pscustomobject]@{
            Group = $group
            Region = $region
            StreamPrefix = "$prefix/$ContainerName/"
            Sanitized = [ordered]@{
                driver = "awslogs"
                groupSha256 = Get-StringSha256 $group
                streamPrefixSha256 = Get-StringSha256 "$prefix/$ContainerName/"
            }
        }
    }
    return [pscustomobject]@{
        Arn = $Arn
        ContainerName = $ContainerName
        Cpu = $ExpectedCpu
        Memory = $ExpectedMemory
        Logging = $logging
    }
}

function Get-WorkerExecutionPosture {
    param($Config, $WorkerTaskDefinition)
    $listed = Invoke-AwsJson @(
        "ecs", "list-tasks", "--region", $Config.Resources.region,
        "--cluster", $Config.Resources.cluster, "--service-name", $Config.Resources.workerService,
        "--desired-status", "RUNNING"
    )
    $taskArns = @($listed.taskArns)
    if ($taskArns.Count -ne 1) {
        throw "The scheduler worker must have exactly one running task."
    }
    $described = Invoke-AwsJson @(
        "ecs", "describe-tasks", "--region", $Config.Resources.region,
        "--cluster", $Config.Resources.cluster, "--tasks", [string]$taskArns[0]
    )
    $tasks = @($described.tasks)
    $containers = @(if ($tasks.Count -eq 1) {
        $tasks[0].containers | Where-Object name -ceq "scheduler-worker"
    })
    if ($tasks.Count -ne 1 -or @($described.failures).Count -ne 0 -or
        [string]$tasks[0].taskArn -cne [string]$taskArns[0] -or
        [string]$tasks[0].taskDefinitionArn -cne $Config.WorkerTaskDefinitionArn -or
        [string]$tasks[0].lastStatus -cne "RUNNING" -or $containers.Count -ne 1 -or
        [string]$containers[0].lastStatus -cne "RUNNING" -or
        $null -ne (Get-Value $containers[0] "exitCode")) {
        throw "The scheduler worker execution is not the exact healthy bound task."
    }
    $taskId = ([string]$tasks[0].taskArn -split '/')[-1]
    if ($taskId -notmatch '^[0-9a-f]{32}$') {
        throw "The scheduler worker task identity is malformed."
    }
    $startedAtRaw = [string](Get-Value $tasks[0] "startedAt" "")
    $startedAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse(
            $startedAtRaw,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None,
            [ref]$startedAt
        ) -or $startedAt.Offset -ne [TimeSpan]::Zero) {
        throw "The scheduler worker start timestamp is not explicit UTC."
    }
    return [pscustomobject]@{
        TaskArn = [string]$tasks[0].taskArn
        TaskArnSha256 = Get-StringSha256 ([string]$tasks[0].taskArn)
        TaskDefinitionArn = [string]$tasks[0].taskDefinitionArn
        StartedAtUtc = $startedAt.ToUniversalTime()
        LogGroup = $WorkerTaskDefinition.Logging.Group
        LogStream = "$($WorkerTaskDefinition.Logging.StreamPrefix)$taskId"
        LogStreamSha256 = Get-StringSha256 "$($WorkerTaskDefinition.Logging.StreamPrefix)$taskId"
    }
}

function Assert-RollbackCompatibility {
    param($Config)
    $contracts = @(
        [pscustomobject]@{
            Active = $Config.ApiTaskDefinitionArn
            Rollback = $Config.RollbackApiTaskDefinitionArn
            Container = "api"
            Cpu = "512"
            Memory = "2048"
        },
        [pscustomobject]@{
            Active = $Config.WorkerTaskDefinitionArn
            Rollback = $Config.RollbackWorkerTaskDefinitionArn
            Container = "scheduler-worker"
            Cpu = "256"
            Memory = "512"
        }
    )
    foreach ($contract in $contracts) {
        $activeResponse = Invoke-AwsJson @(
            "ecs", "describe-task-definition", "--region", $Config.Resources.region,
            "--task-definition", $contract.Active
        )
        $rollbackResponse = Invoke-AwsJson @(
            "ecs", "describe-task-definition", "--region", $Config.Resources.region,
            "--task-definition", $contract.Rollback
        )
        $active = $activeResponse.taskDefinition
        $rollback = $rollbackResponse.taskDefinition
        $activeContainers = @($active.containerDefinitions | ForEach-Object { [string]$_.name } | Sort-Object)
        $rollbackContainers = @($rollback.containerDefinitions | ForEach-Object { [string]$_.name } | Sort-Object)
        $activeTarget = @($active.containerDefinitions | Where-Object name -ceq $contract.Container)
        $rollbackTarget = @($rollback.containerDefinitions | Where-Object name -ceq $contract.Container)
        if ([string]$active.taskDefinitionArn -cne $contract.Active -or
            [string]$rollback.taskDefinitionArn -cne $contract.Rollback -or
            [string]$active.status -cne "ACTIVE" -or
            [string]$rollback.status -cne "ACTIVE" -or
            [string]$active.cpu -cne $contract.Cpu -or [string]$rollback.cpu -cne $contract.Cpu -or
            [string]$active.memory -cne $contract.Memory -or [string]$rollback.memory -cne $contract.Memory -or
            [string]$active.networkMode -cne [string]$rollback.networkMode -or
            [string]$active.taskRoleArn -cne [string]$rollback.taskRoleArn -or
            [string]$active.executionRoleArn -cne [string]$rollback.executionRoleArn -or
            @(Compare-Object $activeContainers $rollbackContainers).Count -ne 0 -or
            $activeTarget.Count -ne 1 -or $rollbackTarget.Count -ne 1) {
            throw "Active and rollback task definitions are not structurally compatible."
        }
        $activeEnvironmentNames = @($activeTarget[0].environment | ForEach-Object { [string]$_.name } | Sort-Object -Unique)
        $rollbackEnvironmentNames = @($rollbackTarget[0].environment | ForEach-Object { [string]$_.name } | Sort-Object -Unique)
        $activeSecretNames = @($activeTarget[0].secrets | ForEach-Object { [string]$_.name } | Sort-Object -Unique)
        $rollbackSecretNames = @($rollbackTarget[0].secrets | ForEach-Object { [string]$_.name } | Sort-Object -Unique)
        if (@(Compare-Object $activeEnvironmentNames $rollbackEnvironmentNames).Count -ne 0 -or
            @(Compare-Object $activeSecretNames $rollbackSecretNames).Count -ne 0) {
            throw "Active and rollback task definitions have incompatible environment or secret contracts."
        }
    }
}

function Get-EngineeringWafDeviceLabel {
    param($Statement)
    $label = Get-Value $Statement "LabelMatchStatement"
    if ($null -eq $label -or [string](Get-Value $label "Scope" "") -cne "LABEL" -or
        [string](Get-Value $label "Key" "") -cne "device-ingest") {
        return $null
    }
    return $label
}

function Assert-EngineeringWafContract {
    param($WebAcl, $Resources)
    $defaultAction = Get-Value $WebAcl "DefaultAction"
    $defaultNames = @(if ($null -ne $defaultAction) {
        $defaultAction.PSObject.Properties.Name
    })
    $allow = Get-Value $defaultAction "Allow"
    if ($defaultNames.Count -ne 1 -or [string]$defaultNames[0] -cne "Allow" -or
        $null -eq $allow -or @($allow.PSObject.Properties).Count -ne 0) {
        throw "The production WAF default action must remain exact ALLOW."
    }
    $rules = @((Get-Value $WebAcl "Rules" @()))
    $classifierMatches = @($rules | Where-Object Name -ceq "DeviceIngestClassifier")
    if ($classifierMatches.Count -ne 1) {
        throw "The production WAF requires exactly one DeviceIngestClassifier rule."
    }
    $classifier = $classifierMatches[0]
    $classifierAction = Get-Value $classifier "Action"
    $classifierActionNames = @(if ($null -ne $classifierAction) {
        $classifierAction.PSObject.Properties.Name
    })
    $classifierAnd = Get-Value (Get-Value $classifier "Statement") "AndStatement"
    $classifierStatements = @((Get-Value $classifierAnd "Statements" @()))
    $classifierLabels = @((Get-Value $classifier "RuleLabels" @()))
    $classifierVisibility = Get-Value $classifier "VisibilityConfig"
    if ($classifierActionNames.Count -ne 1 -or
        [string]$classifierActionNames[0] -cne "Count" -or
        [int](Get-Value $classifier "Priority" -1) -ne 25 -or
        $classifierStatements.Count -ne 2 -or $classifierLabels.Count -ne 1 -or
        [string](Get-Value $classifierLabels[0] "Name" "") -cne "device-ingest" -or
        [string](Get-Value $classifierVisibility "MetricName" "") -cne
            [string]$Resources.wafDeviceClassifierMetricName -or
        (Get-Value $classifierVisibility "CloudWatchMetricsEnabled" $false) -ne $true -or
        (Get-Value $classifierVisibility "SampledRequestsEnabled" $false) -ne $true) {
        throw "The production DeviceIngestClassifier contract changed."
    }
    $methodMatches = @($classifierStatements | ForEach-Object {
        Get-Value $_ "ByteMatchStatement"
    } | Where-Object { $null -ne $_ })
    $pathMatches = @($classifierStatements | ForEach-Object {
        Get-Value $_ "RegexMatchStatement"
    } | Where-Object { $null -ne $_ })
    if ($methodMatches.Count -ne 1 -or $pathMatches.Count -ne 1 -or
        [string](Get-Value $methodMatches[0] "SearchString" "") -notin @("POST", "UE9TVA==") -or
        [string](Get-Value $methodMatches[0] "PositionalConstraint" "") -cne "EXACTLY" -or
        $null -eq (Get-Value (Get-Value $methodMatches[0] "FieldToMatch") "Method") -or
        [string](Get-Value $pathMatches[0] "RegexString" "") -cne
            '^/api/(classpilot/)?device/(heartbeat|screenshot)$' -or
        $null -eq (Get-Value (Get-Value $pathMatches[0] "FieldToMatch") "UriPath")) {
        throw "The production DeviceIngestClassifier method or URI scope changed."
    }

    $contracts = @(
        [pscustomobject]@{
            Name = "DeviceIngestRateLimit"
            Priority = 30
            Limit = 100000
            Metric = [string]$Resources.wafDeviceRuleMetricName
        },
        [pscustomobject]@{
            Name = "ApiRateLimit"
            Priority = 40
            Limit = 50000
            Metric = [string]$Resources.wafApiRuleMetricName
        }
    )
    $validated = @{}
    foreach ($contract in $contracts) {
        $matches = @($rules | Where-Object Name -ceq $contract.Name)
        $rule = if ($matches.Count -eq 1) { $matches[0] } else { $null }
        $action = Get-Value $rule "Action"
        $actionNames = @(if ($null -ne $action) { $action.PSObject.Properties.Name })
        $rate = Get-Value (Get-Value $rule "Statement") "RateBasedStatement"
        $scope = Get-Value $rate "ScopeDownStatement"
        $visibility = Get-Value $rule "VisibilityConfig"
        if ($matches.Count -ne 1 -or $actionNames.Count -ne 1 -or
            [string]$actionNames[0] -cne "Block" -or
            [int](Get-Value $rule "Priority" -1) -ne $contract.Priority -or
            [int](Get-Value $rate "Limit" -1) -ne $contract.Limit -or
            [int](Get-Value $rate "EvaluationWindowSec" 300) -ne 300 -or
            [string](Get-Value $rate "AggregateKeyType" "") -cne "IP" -or
            $null -eq $scope -or
            [string](Get-Value $visibility "MetricName" "") -cne $contract.Metric -or
            (Get-Value $visibility "CloudWatchMetricsEnabled" $false) -ne $true -or
            (Get-Value $visibility "SampledRequestsEnabled" $false) -ne $true) {
            throw "$($contract.Name) no longer matches its exact BLOCK rate-rule contract."
        }
        $validated[$contract.Name] = $scope
    }
    $deviceLabel = Get-EngineeringWafDeviceLabel $validated.DeviceIngestRateLimit
    $apiAnd = Get-Value $validated.ApiRateLimit "AndStatement"
    $apiStatements = @((Get-Value $apiAnd "Statements" @()))
    $apiPathMatches = @($apiStatements | ForEach-Object {
        Get-Value $_ "ByteMatchStatement"
    } | Where-Object { $null -ne $_ })
    $notMatches = @($apiStatements | ForEach-Object {
        Get-Value $_ "NotStatement"
    } | Where-Object { $null -ne $_ })
    $excludedLabel = if ($notMatches.Count -eq 1) {
        Get-EngineeringWafDeviceLabel (Get-Value $notMatches[0] "Statement")
    } else { $null }
    if ($null -eq $deviceLabel -or $apiStatements.Count -ne 2 -or
        $apiPathMatches.Count -ne 1 -or $null -eq $excludedLabel -or
        [string](Get-Value $apiPathMatches[0] "SearchString" "") -notin @("/api/", "L2FwaS8=") -or
        [string](Get-Value $apiPathMatches[0] "PositionalConstraint" "") -cne "STARTS_WITH" -or
        $null -eq (Get-Value (Get-Value $apiPathMatches[0] "FieldToMatch") "UriPath")) {
        throw "The production WAF device/API split changed."
    }
}

function Get-ProductionPosture {
    param($Config, [switch]$HeldCapacity)
    $caller = Invoke-AwsJson @("sts", "get-caller-identity", "--region", $Config.Resources.region)
    if ([string]$caller.Account -cne $script:ExpectedAccountId) {
        throw "AWS CLI is not authenticated to the reviewed production account."
    }
    $services = Get-ServicePosture $Config
    $apiTask = Get-TaskDefinitionPosture $Config $Config.ApiTaskDefinitionArn "api" "512" "2048"
    $workerTask = Get-TaskDefinitionPosture $Config $Config.WorkerTaskDefinitionArn "scheduler-worker" "256" "512"
    $workerExecution = Get-WorkerExecutionPosture $Config $workerTask
    $targets = Get-TargetHealthSnapshot $Config
    if ([int]$targets.total -ne [int]$services.api.desired -or
        [int]$targets.healthy -ne [int]$services.api.desired -or [int]$targets.nonHealthy -ne 0) {
        throw "Every and only desired API target must be healthy."
    }

    $rdsResponse = Invoke-AwsJson @(
        "rds", "describe-db-instances", "--region", $Config.Resources.region,
        "--db-instance-identifier", $Config.Resources.rdsInstanceId
    )
    $rds = @($rdsResponse.DBInstances)
    $pending = if ($rds.Count -eq 1) { Get-Value $rds[0] "PendingModifiedValues" } else { $null }
    $pendingCount = if ($null -eq $pending) { 0 } else { @($pending.PSObject.Properties).Count }
    if ($rds.Count -ne 1 -or [string]$rds[0].DBInstanceClass -cne "db.t4g.medium" -or
        [string]$rds[0].DBInstanceStatus -cne "available" -or $rds[0].PubliclyAccessible -ne $false -or
        $rds[0].PerformanceInsightsEnabled -ne $true -or
        [string](Get-Value $rds[0] "DatabaseInsightsMode" "") -cne "standard" -or
        [int](Get-Value $rds[0] "PerformanceInsightsRetentionPeriod" 0) -ne 7 -or $pendingCount -ne 0) {
        throw "RDS must remain available, private, unchanged Standard/7 db.t4g.medium."
    }

    $redisResponse = Invoke-AwsJson @(
        "elasticache", "describe-replication-groups", "--region", $Config.Resources.region,
        "--replication-group-id", $Config.Resources.redisReplicationGroupId
    )
    $redis = @($redisResponse.ReplicationGroups)
    $members = if ($redis.Count -eq 1) {
        @($redis[0].MemberClusters | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    } else { @() }
    if ($redis.Count -ne 1 -or [string]$redis[0].Status -cne "available" -or
        [string]$redis[0].CacheNodeType -cne "cache.t4g.small" -or
        [string]$Config.Resources.redisCacheClusterId -notin $members) {
        throw "Redis must remain the exact available cache.t4g.small replication group."
    }

    $natResponse = Invoke-AwsJson @(
        "ec2", "describe-nat-gateways", "--region", $Config.Resources.region,
        "--filter", "Name=vpc-id,Values=$($Config.Resources.vpcId)"
    )
    $nat = @($natResponse.NatGateways)
    if ($nat.Count -ne 2 -or @($nat | Where-Object State -cne "available").Count -ne 0) {
        throw "The exact two-NAT production posture was not observed."
    }
    $scaling = Get-ScalingSnapshot $Config
    if ($HeldCapacity) {
        Assert-HeldCapacityPosture $services $targets $scaling
    } else {
        Assert-ProductionScalingContract $scaling
    }
    $webAcls = Invoke-AwsJson @(
        "wafv2", "list-web-acls", "--region", $Config.Resources.region, "--scope", "CLOUDFRONT"
    )
    $webAclMatches = @($webAcls.WebACLs | Where-Object Name -ceq $Config.Resources.wafWebAclName)
    if ($webAclMatches.Count -ne 1) { throw "The production WAF WebACL was not uniquely resolved." }
    $webAcl = Invoke-AwsJson @(
        "wafv2", "get-web-acl", "--region", $Config.Resources.region, "--scope", "CLOUDFRONT",
        "--name", [string]$webAclMatches[0].Name, "--id", [string]$webAclMatches[0].Id
    )
    Assert-EngineeringWafContract $webAcl.WebACL $Config.Resources
    $distribution = Invoke-AwsJson @(
        "cloudfront", "get-distribution-config", "--id", $Config.Resources.cloudFrontDistributionId
    )
    if ([string](Get-Value $distribution.DistributionConfig "WebACLId" "") -cne
        [string]$webAclMatches[0].ARN) {
        throw "The exact production WAF is not attached to the bound CloudFront distribution."
    }
    $healthCheck = Invoke-AwsJson @(
        "route53", "get-health-check", "--id", $Config.Resources.route53HealthCheckId
    )
    $healthConfig = Get-Value $healthCheck.HealthCheck "HealthCheckConfig"
    if ((Get-Value $healthConfig "MeasureLatency" $false) -ne $true -or
        [string](Get-Value $healthConfig "FullyQualifiedDomainName" "") -cne "school-pilot.net" -or
        [string](Get-Value $healthConfig "ResourcePath" "") -cne "/health") {
        throw "The Route53 health check does not match the healthy latency-measured production posture."
    }
    $alarmResponse = Invoke-AwsJson @(
        "cloudwatch", "describe-alarms", "--region", $Config.Resources.region,
        "--alarm-names", $Config.Resources.route53AlarmName
    )
    $alarms = @($alarmResponse.MetricAlarms)
    if ($alarms.Count -ne 1 -or [string]$alarms[0].StateValue -cne "OK") {
        throw "The Route53 production alarm is not uniquely healthy."
    }
    return [pscustomobject]@{
        ObservedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        Services = $services
        ApiTask = $apiTask
        WorkerTask = $workerTask
        WorkerExecution = $workerExecution
        Targets = $targets
        Rds = [ordered]@{
            instanceClass = "db.t4g.medium"
            status = "available"
            publiclyAccessible = $false
            databaseInsightsMode = "standard"
            performanceInsightsEnabled = $true
            performanceInsightsRetentionPeriod = 7
            dbiResourceId = [string]$rds[0].DbiResourceId
            dbiResourceIdSha256 = Get-StringSha256 ([string]$rds[0].DbiResourceId)
        }
        Redis = [ordered]@{
            status = "available"
            nodeType = "cache.t4g.small"
            replicationGroupSha256 = Get-StringSha256 ([string]$Config.Resources.redisReplicationGroupId)
        }
        Nat = [ordered]@{ availableCount = 2 }
        Scaling = $scaling
        Waf = [ordered]@{
            name = [string]$webAclMatches[0].Name
            defaultAction = "ALLOW"
            webAclSha256 = Get-StringSha256 ([string]$webAclMatches[0].ARN)
            cloudFrontAssociationVerified = $true
            deviceRuleAction = "BLOCK"
            apiRuleAction = "BLOCK"
        }
        Route53 = [ordered]@{
            measureLatency = $true
            alarmState = "OK"
            healthCheckSha256 = Get-StringSha256 ([string]$Config.Resources.route53HealthCheckId)
        }
    }
}

function Get-StableProductionPostureProjection {
    param($Posture)
    $services = Get-Value $Posture "Services"
    $apiService = Get-Value $services "api"
    $workerService = Get-Value $services "worker"
    $apiTask = Get-Value $Posture "ApiTask"
    $workerTask = Get-Value $Posture "WorkerTask"
    $apiLogging = Get-Value (Get-Value $apiTask "Logging") "Sanitized"
    $workerLogging = Get-Value (Get-Value $workerTask "Logging") "Sanitized"
    $workerExecution = Get-Value $Posture "WorkerExecution"
    $targets = Get-Value $Posture "Targets"
    $scaling = Get-Value $Posture "Scaling"
    $suspendedState = Get-Value $scaling "suspendedState"
    $rds = Get-Value $Posture "Rds"
    $redis = Get-Value $Posture "Redis"
    $nat = Get-Value $Posture "Nat"
    $waf = Get-Value $Posture "Waf"
    $route53 = Get-Value $Posture "Route53"

    return [ordered]@{
        services = [ordered]@{
            api = [ordered]@{
                desired = [int](Get-Value $apiService "desired" -1)
                running = [int](Get-Value $apiService "running" -1)
                pending = [int](Get-Value $apiService "pending" -1)
                taskDefinitionArn = [string](Get-Value $apiService "taskDefinitionArn" "")
                assignPublicIp = [string](Get-Value $apiService "assignPublicIp" "")
                subnetSetSha256 = [string](Get-Value $apiService "subnetSetSha256" "")
            }
            worker = [ordered]@{
                desired = [int](Get-Value $workerService "desired" -1)
                running = [int](Get-Value $workerService "running" -1)
                pending = [int](Get-Value $workerService "pending" -1)
                taskDefinitionArn = [string](Get-Value $workerService "taskDefinitionArn" "")
                assignPublicIp = [string](Get-Value $workerService "assignPublicIp" "")
                subnetSetSha256 = [string](Get-Value $workerService "subnetSetSha256" "")
            }
        }
        taskDefinitions = [ordered]@{
            api = [ordered]@{
                arn = [string](Get-Value $apiTask "Arn" "")
                containerName = [string](Get-Value $apiTask "ContainerName" "")
                cpu = [string](Get-Value $apiTask "Cpu" "")
                memory = [string](Get-Value $apiTask "Memory" "")
                logging = [ordered]@{
                    driver = [string](Get-Value $apiLogging "driver" "")
                    groupSha256 = [string](Get-Value $apiLogging "groupSha256" "")
                    streamPrefixSha256 = [string](Get-Value $apiLogging "streamPrefixSha256" "")
                }
            }
            worker = [ordered]@{
                arn = [string](Get-Value $workerTask "Arn" "")
                containerName = [string](Get-Value $workerTask "ContainerName" "")
                cpu = [string](Get-Value $workerTask "Cpu" "")
                memory = [string](Get-Value $workerTask "Memory" "")
                logging = [ordered]@{
                    driver = [string](Get-Value $workerLogging "driver" "")
                    groupSha256 = [string](Get-Value $workerLogging "groupSha256" "")
                    streamPrefixSha256 = [string](Get-Value $workerLogging "streamPrefixSha256" "")
                }
            }
        }
        workerExecution = [ordered]@{
            taskDefinitionArn = [string](Get-Value $workerExecution "TaskDefinitionArn" "")
        }
        targets = [ordered]@{
            total = [int](Get-Value $targets "total" -1)
            healthy = [int](Get-Value $targets "healthy" -1)
            nonHealthy = [int](Get-Value $targets "nonHealthy" -1)
        }
        scaling = [ordered]@{
            resourceId = [string](Get-Value $scaling "resourceId" "")
            minCapacity = [int](Get-Value $scaling "minCapacity" -1)
            maxCapacity = [int](Get-Value $scaling "maxCapacity" -1)
            suspendedState = [ordered]@{
                DynamicScalingInSuspended = [bool](Get-Value $suspendedState "DynamicScalingInSuspended" $false)
                DynamicScalingOutSuspended = [bool](Get-Value $suspendedState "DynamicScalingOutSuspended" $false)
                ScheduledScalingSuspended = [bool](Get-Value $suspendedState "ScheduledScalingSuspended" $false)
            }
            scheduledActionsSha256 = [string](Get-Value $scaling "scheduledActionsSha256" "")
            scalingPoliciesSha256 = [string](Get-Value $scaling "scalingPoliciesSha256" "")
        }
        rds = [ordered]@{
            instanceClass = [string](Get-Value $rds "instanceClass" "")
            status = [string](Get-Value $rds "status" "")
            publiclyAccessible = [bool](Get-Value $rds "publiclyAccessible" $true)
            databaseInsightsMode = [string](Get-Value $rds "databaseInsightsMode" "")
            performanceInsightsEnabled = [bool](Get-Value $rds "performanceInsightsEnabled" $false)
            performanceInsightsRetentionPeriod = [int](Get-Value $rds "performanceInsightsRetentionPeriod" -1)
            dbiResourceId = [string](Get-Value $rds "dbiResourceId" "")
            dbiResourceIdSha256 = [string](Get-Value $rds "dbiResourceIdSha256" "")
        }
        redis = [ordered]@{
            status = [string](Get-Value $redis "status" "")
            nodeType = [string](Get-Value $redis "nodeType" "")
            replicationGroupSha256 = [string](Get-Value $redis "replicationGroupSha256" "")
        }
        nat = [ordered]@{
            availableCount = [int](Get-Value $nat "availableCount" -1)
        }
        waf = [ordered]@{
            name = [string](Get-Value $waf "name" "")
            defaultAction = [string](Get-Value $waf "defaultAction" "")
            webAclSha256 = [string](Get-Value $waf "webAclSha256" "")
            cloudFrontAssociationVerified = [bool](Get-Value $waf "cloudFrontAssociationVerified" $false)
            deviceRuleAction = [string](Get-Value $waf "deviceRuleAction" "")
            apiRuleAction = [string](Get-Value $waf "apiRuleAction" "")
        }
        route53 = [ordered]@{
            measureLatency = [bool](Get-Value $route53 "measureLatency" $false)
            alarmState = [string](Get-Value $route53 "alarmState" "")
            healthCheckSha256 = [string](Get-Value $route53 "healthCheckSha256" "")
        }
    }
}

function Get-StableProductionPostureSha256 {
    param($Posture)
    return Get-CanonicalSha256 (Get-StableProductionPostureProjection $Posture)
}

function Set-ScalingTarget {
    param($Config, [int]$Minimum, [int]$Maximum, $SuspendedState)
    Invoke-AwsCommand @(
        "application-autoscaling", "register-scalable-target", "--region", $Config.Resources.region,
        "--service-namespace", "ecs", "--resource-id",
        "service/$($Config.Resources.cluster)/$($Config.Resources.apiService)",
        "--scalable-dimension", "ecs:service:DesiredCount", "--min-capacity", [string]$Minimum,
        "--max-capacity", [string]$Maximum, "--suspended-state",
        ($SuspendedState | ConvertTo-Json -Compress)
    )
}

function Set-SixApiCapacity {
    param($Config)
    $held = [ordered]@{
        DynamicScalingInSuspended = $false
        DynamicScalingOutSuspended = $true
        ScheduledScalingSuspended = $false
    }
    Set-ScalingTarget $Config 6 8 $held
    Invoke-AwsCommand @(
        "ecs", "update-service", "--region", $Config.Resources.region, "--cluster", $Config.Resources.cluster,
        "--service", $Config.Resources.apiService, "--desired-count", "6"
    )
    Invoke-AwsCommand @(
        "ecs", "wait", "services-stable", "--region", $Config.Resources.region,
        "--cluster", $Config.Resources.cluster, "--services",
        $Config.Resources.apiService, $Config.Resources.workerService
    )
    $services = Get-ServicePosture $Config
    $targets = Wait-TargetHealth $Config 6
    $scaling = Get-ScalingSnapshot $Config
    Assert-HeldCapacityPosture $services $targets $scaling
    return [ordered]@{ services = $services; targets = $targets; scaling = $scaling }
}

function Get-RollbackProductionPosture {
    param($Config)
    $bindings = @(
        [pscustomobject]@{
            Arn = $Config.RollbackApiTaskDefinitionArn
            Container = "api"
        },
        [pscustomobject]@{
            Arn = $Config.RollbackWorkerTaskDefinitionArn
            Container = "scheduler-worker"
        }
    )
    $digests = [Collections.Generic.List[string]]::new()
    foreach ($binding in $bindings) {
        $response = Invoke-AwsJson @(
            "ecs", "describe-task-definition", "--region", $Config.Resources.region,
            "--task-definition", $binding.Arn
        )
        $definition = $response.taskDefinition
        $containers = @($definition.containerDefinitions | Where-Object name -ceq $binding.Container)
        $image = if ($containers.Count -eq 1) { [string]$containers[0].image } else { "" }
        if ([string]$definition.taskDefinitionArn -cne $binding.Arn -or
            [string]$definition.status -cne "ACTIVE" -or
            $image -notmatch '@(sha256:[0-9a-f]{64})$') {
            throw "A configured rollback task definition is not an exact active digest-pinned revision."
        }
        $digests.Add($Matches[1].ToLowerInvariant())
    }
    if (@($digests | Sort-Object -Unique).Count -ne 1) {
        throw "Configured rollback API and worker task definitions do not share one image digest."
    }
    $rollbackConfig = $Config.PSObject.Copy()
    $rollbackConfig.ApiTaskDefinitionArn = $Config.RollbackApiTaskDefinitionArn
    $rollbackConfig.WorkerTaskDefinitionArn = $Config.RollbackWorkerTaskDefinitionArn
    $rollbackConfig.ImageDigest = $digests[0]
    return Get-ProductionPosture $rollbackConfig
}

function Restore-Scaling {
    param($Config, $InitialPosture, [switch]$AfterApplicationRollback)
    $original = $InitialPosture
    $held = [ordered]@{
        DynamicScalingInSuspended = $true
        DynamicScalingOutSuspended = $true
        ScheduledScalingSuspended = $true
    }
    Set-ScalingTarget $Config ([int]$original.Scaling.minCapacity) ([int]$original.Scaling.maxCapacity) $held
    Invoke-AwsCommand @(
        "ecs", "update-service", "--region", $Config.Resources.region, "--cluster", $Config.Resources.cluster,
        "--service", $Config.Resources.apiService, "--desired-count", [string]$original.Services.api.desired
    )
    if ($AfterApplicationRollback) {
        # Either rollback owner may have updated only one service before a
        # transient provider failure. Reissue both exact prior revisions
        # idempotently before final scaling and target-health convergence.
        [void](Invoke-ApplicationRollback $Config ([int]$original.Services.api.desired))
    }
    Invoke-AwsCommand @(
        "ecs", "wait", "services-stable", "--region", $Config.Resources.region,
        "--cluster", $Config.Resources.cluster, "--services",
        $Config.Resources.apiService, $Config.Resources.workerService
    )
    [void](Wait-TargetHealth $Config ([int]$original.Services.api.desired))
    Set-ScalingTarget $Config ([int]$original.Scaling.minCapacity) ([int]$original.Scaling.maxCapacity) `
        $original.Scaling.suspendedState
    $observed = if ($AfterApplicationRollback) {
        Get-RollbackProductionPosture $Config
    } else {
        Get-ProductionPosture $Config
    }
    $workerIdentityMatches = if ($AfterApplicationRollback) {
        [string]$observed.WorkerExecution.TaskDefinitionArn -ceq
            [string]$Config.RollbackWorkerTaskDefinitionArn
    } else {
        [string]$observed.WorkerExecution.TaskArn -ceq [string]$original.WorkerExecution.TaskArn -and
        [string]$observed.WorkerExecution.TaskDefinitionArn -ceq
            [string]$original.WorkerExecution.TaskDefinitionArn
    }
    $matches = (
        [int]$observed.Services.api.desired -eq [int]$original.Services.api.desired -and
        [int]$observed.Services.api.running -eq [int]$original.Services.api.running -and
        [int]$observed.Services.worker.desired -eq [int]$original.Services.worker.desired -and
        [int]$observed.Services.worker.running -eq [int]$original.Services.worker.running -and
        $workerIdentityMatches -and
        [int]$observed.Scaling.minCapacity -eq [int]$original.Scaling.minCapacity -and
        [int]$observed.Scaling.maxCapacity -eq [int]$original.Scaling.maxCapacity -and
        (Get-CanonicalSha256 $observed.Scaling.suspendedState) -ceq
            (Get-CanonicalSha256 $original.Scaling.suspendedState) -and
        [string]$observed.Scaling.scheduledActionsSha256 -ceq
            [string]$original.Scaling.scheduledActionsSha256 -and
        [string]$observed.Scaling.scalingPoliciesSha256 -ceq
            [string]$original.Scaling.scalingPoliciesSha256
    )
    if (-not $matches) { throw "Exact scaling, service, schedule, policy, or posture restoration was not observed." }
    return [ordered]@{
        restored = $true
        afterApplicationRollback = [bool]$AfterApplicationRollback
        restoredAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        posture = $observed
        initialAttempt = $null
    }
}

function ConvertTo-WindowsProcessArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * ($backslashes * 2 + 1)))
            [void]$builder.Append('"')
        }
        else {
            if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)) }
            [void]$builder.Append($character)
        }
        $backslashes = 0
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Start-SupervisedProcess {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [hashtable]$Environment = @{},
        [string]$StdoutPath,
        [string]$StderrPath
    )
    foreach ($outputPath in @($StdoutPath, $StderrPath)) {
        if (Test-Path -LiteralPath $outputPath) {
            throw "A supervised process output path already exists."
        }
    }
    $process = $null
    try {
        $argumentLine = @($Arguments | ForEach-Object {
            ConvertTo-WindowsProcessArgument ([string]$_)
        }) -join ' '
        $process = Start-Process -FilePath $FilePath -ArgumentList $argumentLine `
            -Environment $Environment -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath
        $startedAtUtc = [DateTimeOffset]$process.StartTime.ToUniversalTime()
        return [pscustomobject]@{
            Process = $process
            ProcessId = $process.Id
            ProcessPath = [IO.Path]::GetFullPath($FilePath)
            StartedAtUtc = $startedAtUtc
            StdoutPath = $StdoutPath
            StderrPath = $StderrPath
            OutputCommitted = $true
        }
    }
    catch {
        if ($null -ne $process) { $process.Dispose() }
        throw
    }
}

function Complete-SupervisedProcess {
    param($Child, [int]$TimeoutSeconds = 30, [switch]$Terminate)
    if ($Terminate -and -not $Child.Process.HasExited) {
        try { $Child.Process.Kill($true) } catch { }
    }
    if (-not $Child.Process.HasExited -and -not $Child.Process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $Child.Process.Kill($true) } catch { }
        [void]$Child.Process.WaitForExit(15000)
    }
    if (-not $Child.Process.HasExited) { throw "Supervised child did not terminate." }
    $Child.Process.WaitForExit()
    if (-not (Test-Path -LiteralPath $Child.StdoutPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $Child.StderrPath -PathType Leaf)) {
        throw "Supervised child direct output files are missing."
    }
    return [int]$Child.Process.ExitCode
}

function Dispose-SupervisedProcess {
    param($Child)
    if ($null -eq $Child) { return }
    try {
        if (-not $Child.Process.HasExited) {
            [void](Complete-SupervisedProcess $Child -TimeoutSeconds $script:ChildExitGraceSeconds -Terminate)
        }
        elseif (-not $Child.OutputCommitted) {
            [void](Complete-SupervisedProcess $Child -TimeoutSeconds $script:ChildExitGraceSeconds)
        }
    }
    finally { $Child.Process.Dispose() }
}

function Wait-ForPath {
    param(
        [string]$Path,
        [DateTimeOffset]$DeadlineUtc,
        $Child,
        [string]$Failure
    )
    while ([DateTimeOffset]::UtcNow -lt $DeadlineUtc) {
        if (Test-Path -LiteralPath $Path -PathType Leaf) { return }
        if ($null -ne $Child -and $Child.Process.HasExited) {
            [void](Complete-SupervisedProcess $Child -TimeoutSeconds $script:ChildExitGraceSeconds)
            throw $Failure
        }
        Start-Sleep -Milliseconds 250
    }
    throw $Failure
}

function Get-CurrentGeneratorIpv4 {
    $result = Invoke-BoundedProcess -FilePath "curl.exe" -Arguments @(
        "-4", "--fail", "--silent", "--show-error", "--max-time", "20",
        "https://checkip.amazonaws.com"
    ) -TimeoutSeconds 25
    $candidate = $result.Stdout.Trim()
    $address = $null
    if ($result.ExitCode -ne 0 -or
        -not [Net.IPAddress]::TryParse($candidate, [ref]$address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw "The generator public IPv4 address could not be verified."
    }
    return $candidate
}

function Assert-PlannedWindowsSchedulable {
    param($Config, [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow)
    $waf500 = $Config.Stages[0]
    $waf800 = $Config.Stages[1]
    if ($waf500.TrafficStartNotAfterUtc -lt $NowUtc -or
        $waf800.TrafficStartNotAfterUtc -lt $NowUtc -or
        $waf500.TrafficStartNotBeforeUtc -gt $NowUtc.AddHours(30) -or
        $waf800.TrafficStartNotBeforeUtc -gt $NowUtc.AddHours(33)) {
        throw "Both planned traffic windows must remain current and schedulable in this operational cycle."
    }
}

function Assert-FixtureVerification {
    param($Verification)
    if ([int](Get-Value $Verification "schemaVersion" 0) -ne 1 -or
        (Get-Value $Verification "passed" $false) -ne $true) {
        throw "Fixture verification did not pass its versioned contract."
    }
    $counts = Get-Value $Verification "counts"
    $expectedCounts = [ordered]@{
        schools = 2
        teachers = 20
        officeStaff = 1
        students = 1010
        classes = 20
        classRosterStudents = 800
        devices = 1010
        activeDeviceSessions = 1010
        activeSessions = 20
        commandBodies = 20
    }
    foreach ($entry in $expectedCounts.GetEnumerator()) {
        if ([int](Get-Value $counts ([string]$entry.Key) -1) -ne [int]$entry.Value) {
            throw "Fixture verification count '$($entry.Key)' is not exact."
        }
    }
    $planCohorts = Get-Value $counts "authorizationPlanCohorts"
    $liveAuth = Get-Value $counts "liveAuth"
    if ([int](Get-Value $planCohorts "coTeacherStudents" -1) -ne 40 -or
        [int](Get-Value $planCohorts "officeSupervisionStudents" -1) -ne 40 -or
        [int](Get-Value $liveAuth "commandAdministrators" -1) -ne 1 -or
        [int](Get-Value $liveAuth "teachers" -1) -ne 20) {
        throw "Fixture authorization cohorts are not exact."
    }
    $gates = Get-Value $Verification "gates"
    foreach ($gate in @(
        "autoEnrollDisabled", "trackingDisabled", "schedulesDisabled", "exactSchoolTimezones",
        "classRostersExactAndDisjoint", "authorizationPlanCohortsExact",
        "authorizationPlanOfficeStudentsOutsideTeacherRosters", "allDeviceTokensLive",
        "allStaffAuthArtifactsLive"
    )) {
        if ((Get-Value $gates $gate $false) -ne $true) {
            throw "Fixture verification gate '$gate' did not pass."
        }
    }
}

function Unprotect-EntropyDpapiPassword {
    param([string]$Path)
    $document = Read-JsonFile $Path "super-admin DPAPI document"
    if ([int](Get-Value $document "version" 0) -ne 1 -or
        [string](Get-Value $document "protection" "") -cne "Windows CurrentUser DPAPI") {
        throw "The super-admin DPAPI document has an unexpected contract."
    }
    $entropy = [Convert]::FromBase64String([string](Get-Value $document "entropyB64" ""))
    $protected = [Convert]::FromBase64String([string](Get-Value $document "protectedPasswordB64" ""))
    $plain = $null
    try {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect(
            $protected, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [Text.Encoding]::UTF8.GetString($plain)
    }
    finally {
        if ($null -ne $plain) { [Security.Cryptography.CryptographicOperations]::ZeroMemory($plain) }
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($protected)
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($entropy)
    }
}

function Unprotect-SecureStringPassword {
    param([string]$Ciphertext)
    $secure = ConvertTo-SecureString -String $Ciphertext
    try { return [Net.NetworkCredential]::new("", $secure).Password }
    finally { $secure.Dispose() }
}

function Read-FixtureSupportCredentials {
    param($Config)
    foreach ($binding in @($Config.FixtureSupport.Values)) {
        if ((Get-FileHash -LiteralPath $binding.Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne
            $binding.Sha256) {
            throw "A fixture support document changed."
        }
    }
    $fixtureConfig = Read-JsonFile $Config.FixtureConfigPath "fixture configuration"
    $passwords = Read-JsonFile $Config.FixtureSupport.fixturePasswords.Path "fixture password document"
    $operation = Read-JsonFile $Config.FixtureSupport.superAdminOperation.Path "super-admin operation"
    if ([string](Get-Value $fixtureConfig "fixtureId" "") -cne $Config.AuthorityFixtureId -or
        [string](Get-Value $passwords "fixtureId" "") -cne $Config.AuthorityFixtureId -or
        [int](Get-Value $operation "version" 0) -ne 1 -or
        [string](Get-Value $operation "status" "") -cne "reset_verified_ephemeral_aws_secret_removed" -or
        [string](Get-Value $operation "awsAccount" "") -cne $script:ExpectedAccountId -or
        [string]::IsNullOrWhiteSpace([string](Get-Value $operation "targetEmail" "")) -or
        [int](Get-Value $operation "temporaryPasswordLength" 0) -lt 16 -or
        (Get-Value $operation "resetTaskDefinitionDeregistered" $false) -ne $true) {
        throw "Fixture support documents do not match the launch-safe production authority."
    }
    [void](Get-UtcTimestamp $operation "resetVerifiedAtUtc" "super-admin operation")
    [void](Get-UtcTimestamp $operation "temporaryHashParameterDeletedAtUtc" "super-admin operation")
    $super = Unprotect-EntropyDpapiPassword $Config.FixtureSupport.superAdminPassword.Path
    $admin = Unprotect-SecureStringPassword ([string](Get-Value $passwords "adminDpapi" ""))
    $teacher = Unprotect-SecureStringPassword ([string](Get-Value $passwords "teacherDpapi" ""))
    if ($super.Length -ne [int]$operation.temporaryPasswordLength -or
        $admin.Length -lt 16 -or $teacher.Length -lt 16) {
        $super = $null; $admin = $null; $teacher = $null
        throw "A fixture support credential decrypted to an unexpected length."
    }
    return [ordered]@{
        SuperAdminEmail = [string]$operation.targetEmail
        SuperAdminPassword = $super
        FixtureAdminPassword = $admin
        FixtureTeacherPassword = $teacher
    }
}

function Assert-FixtureSupportDocuments {
    param($Config)
    $credentials = $null
    try {
        $credentials = Read-FixtureSupportCredentials $Config
        if ([string]::IsNullOrWhiteSpace([string]$credentials.SuperAdminEmail)) {
            throw "Fixture support credentials are incomplete."
        }
    }
    finally {
        if ($null -ne $credentials) {
            $credentials.SuperAdminPassword = $null
            $credentials.FixtureAdminPassword = $null
            $credentials.FixtureTeacherPassword = $null
        }
    }
}

function Assert-FixtureAuthority {
    param($Config)
    $statePath = Join-Path $Config.ContinuityRoot "fixture-state.private.json"
    $ownershipPath = Join-Path $Config.ContinuityRoot "fixture-ownership.private.json"
    Assert-ExactDirectChildren $Config.ContinuityRoot @(
        "fixture-state.private.json", "fixture-ownership.private.json"
    ) "fixture.continuityRoot"
    if ($Config.FixtureStateSha256 -cne $Config.AuthorityStateSha256 -or
        $Config.FixtureOwnershipSha256 -cne $Config.AuthorityOwnershipSha256 -or
        (Get-FileHash -LiteralPath $Config.AuthorityStatePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
            $Config.AuthorityStateSha256 -or
        (Get-FileHash -LiteralPath $Config.AuthorityOwnershipPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
            $Config.AuthorityOwnershipSha256) {
        throw "The durable launch-safe fixture authority source changed."
    }
    if ((Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
            $Config.AuthorityStateSha256 -or
        (Get-FileHash -LiteralPath $ownershipPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
            $Config.AuthorityOwnershipSha256) {
        throw "The continuity bootstrap is not byte-identical to the durable launch-safe authority."
    }
    $fixtureConfig = Read-JsonFile $Config.FixtureConfigPath "fixture configuration"
    $state = Read-JsonFile $statePath "fixture state"
    $ownership = Read-JsonFile $ownershipPath "fixture ownership"
    $fixtureId = [string](Get-Value $fixtureConfig "fixtureId" "")
    $baseUrl = [string](Get-Value $fixtureConfig "baseUrl" "")
    if ($fixtureId -cne $Config.AuthorityFixtureId -or
        [string](Get-Value $state "fixtureId" "") -cne $fixtureId -or
        [string](Get-Value $ownership "fixtureId" "") -cne $fixtureId -or
        [string](Get-Value $state "baseUrl" "") -cne $baseUrl -or
        [string](Get-Value $ownership "baseUrl" "") -cne $baseUrl -or
        [int](Get-Value $state "schemaVersion" 0) -ne 1 -or
        [int](Get-Value $ownership "schemaVersion" 0) -ne 2) {
        throw "The fixture state and ownership ledger do not bind the launch-safe authority."
    }
    $schools = Get-Value $state "schools"
    $schoolProperties = @($schools.PSObject.Properties.Name)
    $teachers = @(Get-Value $state "teachers" @())
    $officeStaff = Get-Value $state "officeStaff"
    if (@($schoolProperties | Sort-Object) -join "," -cne "canary,primary" -or
        $teachers.Count -ne 20 -or
        [string]::IsNullOrWhiteSpace([string](Get-Value $officeStaff "userId" "")) -or
        [string]::IsNullOrWhiteSpace([string](Get-Value $officeStaff "membershipId" "")) -or
        $null -ne (Get-Value $state "hold") -or
        $null -ne (Get-Value $state "cleanup")) {
        throw "The fixture authority must contain exactly two schools, 20 teachers, one office user, and no hold or cleanup state."
    }
    $ownedSchools = Get-Value $ownership "schools"
    $ownedTeachers = Get-Value $ownership "teachers"
    $ownedStaff = Get-Value $ownership "staff"
    $pending = Get-Value $ownership "pendingCreateIntents"
    if (@($ownedSchools.PSObject.Properties).Count -ne 2 -or
        @($ownedTeachers.PSObject.Properties).Count -ne 20 -or
        @($ownedStaff.PSObject.Properties).Count -ne 1 -or
        @((Get-Value $pending "schools").PSObject.Properties).Count -ne 0 -or
        @((Get-Value $pending "teachers").PSObject.Properties).Count -ne 0 -or
        @((Get-Value $pending "staff").PSObject.Properties).Count -ne 0) {
        throw "The fixture authority ownership ledger must be complete and have zero pending intents."
    }
    foreach ($ownedSchool in @($ownedSchools.PSObject.Properties.Value)) {
        if ((Get-Value $ownedSchool "createdByTool" $false) -ne $true) {
            throw "Both fixture schools must be durably tool-owned."
        }
    }
    Assert-FixtureSupportDocuments $Config
}

function Invoke-StageFixturePreparation {
    param($Config, $Stage, [string]$StageRoot)
    if ((Get-FileHash -LiteralPath $Config.FixtureConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
        $Config.FixtureConfigSha256) {
        throw "Fixture configuration changed before preparation."
    }
    $preparationRoot = Join-Path $StageRoot "fixture-preparation"
    New-Item -ItemType Directory -Path $preparationRoot | Out-Null
    $credentials = $null
    $credentialEnvironment = $null
    $refreshStartedAt = [DateTimeOffset]::UtcNow
    try {
        $credentials = Read-FixtureSupportCredentials $Config
        $credentialEnvironment = @{
            CLP_SUPER_ADMIN_BEARER = $null
            CLP_SUPER_ADMIN_EMAIL = [string]$credentials.SuperAdminEmail
            CLP_SUPER_ADMIN_PASSWORD = [string]$credentials.SuperAdminPassword
            CLP_FIXTURE_ADMIN_PASSWORD = [string]$credentials.FixtureAdminPassword
            CLP_FIXTURE_TEACHER_PASSWORD = [string]$credentials.FixtureTeacherPassword
            CLP_OPERATOR_ALIAS_CONFIRMED = $Config.AuthorityFixtureId
            CLP_CANARY_ALIAS_CONFIRMED = $Config.AuthorityFixtureId
        }
        $refresh = Invoke-BoundedProcess -FilePath $script:NodePath -Arguments @(
            $script:FixtureToolPath, "refresh", "--config", $Config.FixtureConfigPath,
            "--output", $Config.ContinuityRoot
        ) -Environment $credentialEnvironment -TimeoutSeconds 1500
        Write-AtomicJson (Join-Path $preparationRoot "refresh-process.json") ([ordered]@{
            exitCode = $refresh.ExitCode
            stdoutSha256 = Get-StringSha256 $refresh.Stdout
            stderrSha256 = Get-StringSha256 $refresh.Stderr
            rawOutputPersisted = $false
        })
        if ($refresh.ExitCode -ne 0) { throw "Fixture refresh failed." }
        $verify = Invoke-BoundedProcess -FilePath $script:NodePath -Arguments @(
            $script:FixtureToolPath, "verify", "--config", $Config.FixtureConfigPath,
            "--output", $Config.ContinuityRoot
        ) -Environment $credentialEnvironment -TimeoutSeconds 1500
        Write-AtomicJson (Join-Path $preparationRoot "verify-process.json") ([ordered]@{
            exitCode = $verify.ExitCode
            stdoutSha256 = Get-StringSha256 $verify.Stdout
            stderrSha256 = Get-StringSha256 $verify.Stderr
            rawOutputPersisted = $false
        })
        if ($verify.ExitCode -ne 0) { throw "Fixture verification failed." }
    }
    finally {
        if ($null -ne $credentialEnvironment) {
            foreach ($name in @(
                "CLP_SUPER_ADMIN_EMAIL", "CLP_SUPER_ADMIN_PASSWORD",
                "CLP_FIXTURE_ADMIN_PASSWORD", "CLP_FIXTURE_TEACHER_PASSWORD"
            )) {
                $credentialEnvironment[$name] = $null
            }
        }
        if ($null -ne $credentials) {
            $credentials.SuperAdminPassword = $null
            $credentials.FixtureAdminPassword = $null
            $credentials.FixtureTeacherPassword = $null
        }
    }
    $verificationPath = Join-Path $Config.ContinuityRoot "verification.private.json"
    if (-not (Test-Path -LiteralPath $verificationPath -PathType Leaf)) {
        throw "Fixture verification artifact was not produced."
    }
    $verification = Read-JsonFile $verificationPath "fixture verification"
    Assert-FixtureVerification $verification
    $verifiedAt = Get-UtcTimestamp $verification "verifiedAt" "fixture verification"
    if ($verifiedAt -lt $refreshStartedAt.AddSeconds(-2) -or
        $verifiedAt -lt ([DateTimeOffset]::UtcNow.AddMinutes(-5))) {
        throw "Fixture verification was not freshly produced by this stage."
    }
    $sealedPath = Join-Path $preparationRoot "verification.private.json"
    Copy-Item -LiteralPath $verificationPath -Destination $sealedPath
    $artifactBindings = [ordered]@{}
    foreach ($artifactName in @(
        "load-devices.private.json", "load-auth.private.json", "load-command-bodies.private.json"
    )) {
        $artifactPath = Join-Path $Config.ContinuityRoot $artifactName
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf) -or
            [DateTimeOffset](Get-Item -LiteralPath $artifactPath).LastWriteTimeUtc -lt
                $refreshStartedAt.AddSeconds(-2)) {
            throw "Stage preparation did not freshly produce $artifactName."
        }
        $artifactBindings[$artifactName] = [ordered]@{
            sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
            lastWriteTimeUtc = ([DateTimeOffset](Get-Item -LiteralPath $artifactPath).LastWriteTimeUtc).ToString("o")
        }
    }
    return [ordered]@{
        preparedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        verifiedAtUtc = $verifiedAt.ToString("o")
        verificationPath = $sealedPath
        verificationSha256 = (Get-FileHash -LiteralPath $sealedPath -Algorithm SHA256).Hash.ToLowerInvariant()
        harnessArtifacts = $artifactBindings
    }
}

function Get-HarnessEnvironment {
    param($Config, $Stage, [string]$AttemptRoot)
    $profile = $Stage.Profile
    $environment = @{
        LOAD_BASE_URL = $Config.BaseUrl
        LOAD_RUN_ID = $Stage.RunId
        LOAD_STAGE = $Stage.Stage
        LOAD_DIAGNOSTIC_ONLY = "false"
        LOAD_ENGINEERING_ACCEPTANCE = "true"
        LOAD_DEVICE_MANIFEST = (Join-Path $Config.ContinuityRoot "load-devices.private.json")
        LOAD_TEACHER_AUTH_FILE = (Join-Path $Config.ContinuityRoot "load-auth.private.json")
        LOAD_COMMAND_BODIES_FILE = (Join-Path $Config.ContinuityRoot "load-command-bodies.private.json")
        LOAD_DEVICE_COUNT = [string]$profile.devices
        LOAD_DURATION_SECONDS = [string]$profile.durationSeconds
        LOAD_SCREENSHOT_PROFILE = "standard"
        LOAD_SCREENSHOT_BYTES = "40960"
        LOAD_HEARTBEAT_INTERVAL_MS = "10000"
        LOAD_SCREENSHOT_INTERVAL_MS = "30000"
        LOAD_TEACHER_INTERVAL_MS = "5000"
        LOAD_TEACHER_TEMPLATE_INTERVAL_MS = "30000"
        LOAD_TEACHER_TEMPLATE_DEVICE_COUNT = "0"
        LOAD_TEACHER_HISTORY_WARMUP_MS = "25000"
        LOAD_SCREENSHOT_GET_INTERVAL_MS = "30000"
        LOAD_SCREENSHOT_GET_WARMUP_MS = "45000"
        LOAD_TILE_HISTORY_PATH = "/api/classpilot/tiles/history"
        LOAD_TILE_SCREENSHOTS_PATH = "/api/classpilot/tiles/screenshots"
        LOAD_WORKLOAD_SCHEMA_VERSION = $script:WorkloadSchemaVersion
        LOAD_TEACHER_PATHS = "/api/students-aggregated"
        LOAD_DASHBOARD_PATHS = ""
        LOAD_SCREENSHOT_GET_PATH_TEMPLATE = ""
        LOAD_COMMAND_ENDPOINT = "/api/classpilot/commands"
        LOAD_EXPECTED_CLASS_BODIES = "20"
        LOAD_EXPECTED_TARGETS_PER_CLASS = [string]$profile.targetsPerClass
        LOAD_COMMAND_WARMUP_MS = "30000"
        LOAD_COMMAND_INTERVAL_MS = "30000"
        LOAD_COMMAND_SETTLE_MS = "5000"
        LOAD_FORCE_RECONNECT_AT_SECONDS = "120"
        LOAD_FORCE_RECONNECT_STAGGER_MS = "30000"
        LOAD_EXPECTED_CANARY_DEVICES = "10"
        LOAD_WAF_DEVICE_LIMIT = "100000"
        LOAD_WAF_GENERAL_LIMIT = "50000"
        LOAD_SHARED_IP_LABEL = "single-generator-egress"
        LOAD_GATE_PROFILE = "launch"
        LOAD_ENFORCE_THRESHOLDS = "true"
        LOAD_EXTERNAL_PROGRESS_PATH = (Join-Path $AttemptRoot "load-progress.jsonl")
        LOAD_EXTERNAL_SUMMARY_PATH = (Join-Path $AttemptRoot "load-summary.json")
        LOAD_SUPERVISOR_READY_PATH = (Join-Path $AttemptRoot "harness-ready.json")
        LOAD_SUPERVISOR_START_GATE_PATH = (Join-Path $AttemptRoot "harness-start-gate.json")
        LOAD_SUPERVISOR_START_GATE_TIMEOUT_MS = "1800000"
    }
    foreach ($entry in (Get-NonCredentialChildEnvironment).GetEnumerator()) {
        $environment[[string]$entry.Key] = $entry.Value
    }
    return $environment
}

function Get-NonCredentialChildEnvironment {
    return @{
        CLP_SUPER_ADMIN_BEARER = $null
        CLP_SUPER_ADMIN_EMAIL = $null
        CLP_SUPER_ADMIN_PASSWORD = $null
        CLP_FIXTURE_ADMIN_PASSWORD = $null
        CLP_FIXTURE_TEACHER_PASSWORD = $null
        CLP_OPERATOR_ALIAS_CONFIRMED = $null
        CLP_CANARY_ALIAS_CONFIRMED = $null
    }
}

function Assert-HarnessInputs {
    param($Environment)
    foreach ($name in @(
        "LOAD_DEVICE_MANIFEST", "LOAD_TEACHER_AUTH_FILE", "LOAD_COMMAND_BODIES_FILE"
    )) {
        if (-not (Test-Path -LiteralPath $Environment[$name] -PathType Leaf)) {
            throw "Harness fixture input '$name' is missing."
        }
    }
}

function Assert-PreparedHarnessArtifacts {
    param($Config, $Preparation)
    foreach ($artifactName in @(
        "load-devices.private.json", "load-auth.private.json", "load-command-bodies.private.json"
    )) {
        $binding = Get-Value $Preparation.harnessArtifacts $artifactName
        $path = Join-Path $Config.ContinuityRoot $artifactName
        if ($null -eq $binding -or
            -not (Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne
                [string](Get-Value $binding "sha256" "")) {
            throw "A stage-bound harness artifact changed after fixture verification."
        }
    }
}

function Invoke-HarnessPreflight {
    param($Environment, [string]$AttemptRoot)
    Assert-HarnessInputs $Environment
    $result = Invoke-BoundedProcess -FilePath $script:NodePath `
        -Arguments @($script:HarnessPath, "--validate-config") -Environment $Environment `
        -TimeoutSeconds 120 -StdoutPath (Join-Path $AttemptRoot "harness-preflight.stdout.log") `
        -StderrPath (Join-Path $AttemptRoot "harness-preflight.stderr.log")
    if ($result.ExitCode -ne 0) { throw "Harness configuration preflight failed." }
    try { $preflight = $result.Stdout | ConvertFrom-Json -DateKind String -Depth 30 }
    catch { throw "Harness configuration preflight did not emit valid JSON." }
    if ((Get-Value $preflight "ok" $false) -ne $true -or
        (Get-Value $preflight "trafficStarted" $true) -ne $false -or
        (Get-Value $preflight "engineeringAcceptance" $false) -ne $true -or
        (Get-Value $preflight "certificationEligible" $true) -ne $false) {
        throw "Harness configuration preflight did not bind engineering acceptance."
    }
    return $preflight
}

function New-MonitorConfiguration {
    param(
        $Config,
        $Stage,
        [string]$AttemptRoot,
        $HarnessChild,
        [DateTimeOffset]$ArtifactsNotBeforeUtc,
        $InitialPosture
    )
    $monitorEvidence = Join-Path $AttemptRoot "monitor"
    New-Item -ItemType Directory -Path $monitorEvidence -Force | Out-Null
    $controller = Get-Process -Id $PID -ErrorAction Stop
    $controllerStartedAtUtc = ([DateTimeOffset]$controller.StartTime).ToUniversalTime()
    $controllerPath = [IO.Path]::GetFullPath([string]$controller.Path)
    return [ordered]@{
        schemaVersion = 1
        runId = $Stage.RunId
        phase = "Waf"
        diagnosticOnly = $false
        engineeringAcceptance = $true
        evidenceDirectory = $monitorEvidence
        loadProgressPath = Join-Path $AttemptRoot "load-progress.jsonl"
        loadSummaryPath = Join-Path $AttemptRoot "load-summary.json"
        expectedGeneratorPublicIp = $Config.ExpectedGeneratorPublicIp
        generatorIpEvidencePath = Join-Path $AttemptRoot "generator-ip.json"
        minimumWallClockSeconds = [int]$Stage.Profile.durationSeconds
        deadlineUtc = $Stage.TrafficStartNotAfterUtc.AddSeconds(
            [int]$Stage.Profile.durationSeconds + 1800
        ).ToString("o")
        artifactsNotBeforeUtc = $ArtifactsNotBeforeUtc.ToString("o")
        workload = [ordered]@{
            stage = $Stage.Stage
            devices = [int]$Stage.Profile.devices
            durationSeconds = [int]$Stage.Profile.durationSeconds
            screenshotBytes = 40960
            canaryDevices = 10
            workloadSchemaVersion = $script:WorkloadSchemaVersion
            endpointShapeSha256 = $script:EndpointShapeSha256
        }
        automaticRollback = $false
        requireLoadAcceptance = $true
        pollSeconds = 60
        notificationTopicArn = $Config.NotificationTopicArn
        harnessProcessId = [int]$HarnessChild.ProcessId
        harnessProcessStartedAtUtc = $HarnessChild.StartedAtUtc.ToString("o")
        harnessProcessPath = $HarnessChild.ProcessPath
        controllerProcessId = [int]$PID
        controllerProcessStartedAtUtc = $controllerStartedAtUtc.ToString("o")
        controllerProcessPath = $controllerPath
        engineeringScalingRestoration = [ordered]@{
            apiDesiredCount = [int]$InitialPosture.Services.api.desired
            minCapacity = [int]$InitialPosture.Scaling.minCapacity
            maxCapacity = [int]$InitialPosture.Scaling.maxCapacity
            rollbackApiTaskDefinitionArn = [string]$Config.RollbackApiTaskDefinitionArn
            rollbackWorkerTaskDefinitionArn = [string]$Config.RollbackWorkerTaskDefinitionArn
            scheduledActionsSha256 = [string]$InitialPosture.Scaling.scheduledActionsSha256
            scalingPoliciesSha256 = [string]$InitialPosture.Scaling.scalingPoliciesSha256
            suspendedState = $InitialPosture.Scaling.suspendedState
        }
        supervisedHeartbeatPaths = @()
        resources = $Config.Resources
    }
}

function Assert-MonitorRestorationArmed {
    param([string]$Path, $Stage, [string]$ExpectedConfigSha256, $MonitorChild)
    $heartbeat = Read-JsonFile $Path "monitor restoration-armed heartbeat"
    $timestamp = Get-UtcTimestamp $heartbeat "timestamp" "monitor restoration-armed heartbeat"
    if ([string](Get-Value $heartbeat "runId" "") -cne $Stage.RunId -or
        [string](Get-Value $heartbeat "phase" "") -cne "Waf" -or
        (Get-Value $heartbeat "engineeringAcceptance" $false) -ne $true -or
        (Get-Value $heartbeat "certificationEligible" $true) -ne $false -or
        (Get-Value $heartbeat "triggered" $true) -ne $false -or
        (Get-Value $heartbeat "scalingRestorationArmed" $false) -ne $true -or
        [int](Get-Value $heartbeat "iteration" -1) -ne 0 -or
        [string](Get-Value $heartbeat "configSha256" "") -cne $ExpectedConfigSha256 -or
        [int](Get-Value $heartbeat "monitorProcessId" 0) -ne $MonitorChild.ProcessId -or
        ([DateTimeOffset]::UtcNow - $timestamp).TotalSeconds -gt
            $script:MonitorHeartbeatMaximumAgeSeconds) {
        throw "AWS monitor did not arm the exact scaling-restoration fail-safe."
    }
    return $heartbeat
}

function Wait-ForHealthyMonitorHeartbeat {
    param([string]$Path, $Stage, $MonitorChild, [DateTimeOffset]$DeadlineUtc)
    while ([DateTimeOffset]::UtcNow -lt $DeadlineUtc) {
        if ($MonitorChild.Process.HasExited) {
            [void](Complete-SupervisedProcess $MonitorChild -TimeoutSeconds $script:ChildExitGraceSeconds)
            throw "The AWS monitor exited before observing held capacity."
        }
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try { return Assert-MonitorHeartbeat $Path $Stage } catch { }
        }
        Start-Sleep -Milliseconds 250
    }
    throw "The AWS monitor did not observe held capacity and commit a healthy heartbeat."
}

function Invoke-MonitorValidation {
    param([string]$MonitorConfigPath, [string]$MonitorConfigSha256, [string]$StdoutPath, [string]$StderrPath)
    $result = Invoke-BoundedProcess -FilePath $script:PwshPath -Arguments @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-File", $script:MonitorPath,
        "-Mode", "Validate", "-ConfigPath", $MonitorConfigPath,
        "-ExpectedConfigSha256", $MonitorConfigSha256
    ) -Environment (Get-NonCredentialChildEnvironment) -TimeoutSeconds 180 `
        -StdoutPath $StdoutPath -StderrPath $StderrPath
    if ($result.ExitCode -ne 0) { throw "AWS monitor configuration validation failed." }
}

function Assert-MonitorHeartbeat {
    param([string]$Path, $Stage)
    $heartbeat = Read-JsonFile $Path "monitor heartbeat"
    $timestamp = Get-UtcTimestamp $heartbeat "timestamp" "monitor heartbeat"
    if ([string](Get-Value $heartbeat "runId" "") -cne $Stage.RunId -or
        [string](Get-Value $heartbeat "phase" "") -cne "Waf" -or
        (Get-Value $heartbeat "engineeringAcceptance" $false) -ne $true -or
        (Get-Value $heartbeat "certificationEligible" $true) -ne $false -or
        (Get-Value $heartbeat "triggered" $true) -ne $false -or
        [int](Get-Value $heartbeat "iteration" 0) -lt 1 -or
        ([DateTimeOffset]::UtcNow - $timestamp).TotalSeconds -gt $script:MonitorHeartbeatMaximumAgeSeconds) {
        throw "AWS monitor heartbeat was not healthy, current, and identity-bound."
    }
    return $heartbeat
}

function Assert-RepositoryIdentity {
    param($Config)
    $head = Invoke-BoundedProcess -FilePath "git.exe" -Arguments @(
        "-C", $script:RepositoryRoot, "rev-parse", "HEAD"
    ) -TimeoutSeconds 30
    $status = Invoke-BoundedProcess -FilePath "git.exe" -Arguments @(
        "-C", $script:RepositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"
    ) -TimeoutSeconds 30
    if ($head.ExitCode -ne 0 -or $head.Stdout.Trim().ToLowerInvariant() -cne $Config.ApplicationGitSha) {
        throw "The local repository HEAD does not match the bound deployed application SHA."
    }
    if ($status.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($status.Stdout)) {
        throw "The local repository must be clean before capacity acceptance."
    }
}

function Write-GeneratorIpEvidence {
    param($Config, $Stage, [string]$Path)
    $actual = Get-CurrentGeneratorIpv4
    if ($actual -cne $Config.ExpectedGeneratorPublicIp) {
        throw "The current generator IPv4 address does not match the bound config."
    }
    Write-AtomicJsonReplace $Path ([ordered]@{
        runId = $Stage.RunId
        expectedPublicIp = $Config.ExpectedGeneratorPublicIp
        actualPublicIp = $actual
        observedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    })
}

function Wait-ForTrafficWindow {
    param($Config, $Stage, $HarnessChild, $MonitorChild, [string]$GeneratorIpEvidencePath)
    $nextGeneratorCheckUtc = [DateTimeOffset]::MinValue
    while ([DateTimeOffset]::UtcNow -lt $Stage.TrafficStartNotBeforeUtc) {
        if ([DateTimeOffset]::UtcNow -ge $nextGeneratorCheckUtc) {
            Write-GeneratorIpEvidence $Config $Stage $GeneratorIpEvidencePath
            $nextGeneratorCheckUtc = [DateTimeOffset]::UtcNow.AddSeconds(60)
        }
        foreach ($child in @($HarnessChild, $MonitorChild)) {
            if ($child.Process.HasExited) {
                [void](Complete-SupervisedProcess $child -TimeoutSeconds $script:ChildExitGraceSeconds)
                throw "A supervised child exited before the traffic window."
            }
        }
        $remaining = ($Stage.TrafficStartNotBeforeUtc - [DateTimeOffset]::UtcNow).TotalSeconds
        Start-Sleep -Seconds ([math]::Max(1, [math]::Min(30, [int][math]::Ceiling($remaining))))
    }
    if ([DateTimeOffset]::UtcNow -gt $Stage.TrafficStartNotAfterUtc) {
        throw "The immutable traffic start window was missed."
    }
    if ($Stage.Stage -ceq "800" -and
        -not (Test-IntervalContainsSchedulerTicks ([DateTimeOffset]::UtcNow) 5400)) {
        throw "The actual Waf/800 start no longer spans the 01:30 purge and 02:00 rollup."
    }
}

function Assert-HarnessReady {
    param([string]$Path, $Stage, $HarnessChild)
    $ready = Read-JsonFile $Path "harness ready gate"
    $readyAt = Get-UtcTimestamp $ready "readyAt" "harness ready gate"
    if ([int](Get-Value $ready "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $ready "type" "") -cne "load_supervisor_ready" -or
        [string](Get-Value $ready "runId" "") -cne $Stage.RunId -or
        [string](Get-Value $ready "stage" "") -cne $Stage.Stage -or
        [int](Get-Value $ready "harnessProcessId" 0) -ne $HarnessChild.ProcessId -or
        (Get-Value $ready "trafficStarted" $true) -ne $false -or
        $readyAt -lt $HarnessChild.StartedAtUtc.AddSeconds(-2)) {
        throw "Harness ready evidence was not identity-bound."
    }
    return $ready
}

function Assert-NoTrafficProgress {
    param([string]$ProgressPath, [string]$StartGatePath)
    if (Test-Path -LiteralPath $StartGatePath) { return $false }
    if (-not (Test-Path -LiteralPath $ProgressPath)) { return $true }
    return [string]::IsNullOrWhiteSpace((Get-Content -LiteralPath $ProgressPath -Raw))
}

function Assert-StageSummary {
    param($Summary, $Stage)
    $profile = $Stage.Profile
    if ([string](Get-Value $Summary "runId" "") -cne $Stage.RunId -or
        [string](Get-Value $Summary "stage" "") -cne $Stage.Stage -or
        (Get-Value $Summary "diagnosticOnly" $true) -ne $false -or
        (Get-Value $Summary "engineeringAcceptance" $false) -ne $true -or
        (Get-Value $Summary "certificationEligible" $true) -ne $false -or
        [string](Get-Value $Summary "workloadSchemaVersion" "") -cne $script:WorkloadSchemaVersion -or
        [string](Get-Value $Summary "workloadEndpointShapeSha256" "") -cne $script:EndpointShapeSha256 -or
        [int](Get-Value $Summary "devices" 0) -ne [int]$profile.devices -or
        [int](Get-Value $Summary "expectedTargetsPerClass" 0) -ne
            [int]$profile.targetsPerClass -or
        [int](Get-Value $Summary "declaredSecondSchoolCanaryDevices" -1) -ne 10) {
        throw "Harness summary identity or workload profile is invalid."
    }
    $configuredPrimaryDevices = Get-Value $Summary "configuredPrimaryDevices"
    if ($null -ne $configuredPrimaryDevices -and
        [int]$configuredPrimaryDevices -ne ([int]$profile.devices - 10)) {
        throw "Harness summary primary-device accounting is invalid."
    }
    $run = Get-Value $Summary "run"
    $thresholds = Get-Value $Summary "thresholds"
    if ([string](Get-Value $run "durationClock" "") -cne "monotonic-hrtime-v1" -or
        [double](Get-Value $run "runtimeTargetTrafficSeconds" 0) -ne [double]$profile.durationSeconds -or
        [double](Get-Value $run "actualTrafficMilliseconds" 0) -lt
            ([double]$profile.durationSeconds * 1000.0) -or
        (Get-Value $run "completedConfiguredDuration" $false) -ne $true -or
        (Get-Value $thresholds "enforced" $false) -ne $true -or
        (Get-Value $thresholds "passed" $false) -ne $true -or
        $null -ne (Get-Value $Summary "fatalGate")) {
        throw "Harness duration or unchanged launch thresholds did not pass."
    }
}

function Get-TrafficInterval {
    param([string]$ProgressPath, $Stage)
    $records = @()
    foreach ($line in @(Get-Content -LiteralPath $ProgressPath)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $records += $line | ConvertFrom-Json -DateKind String -Depth 30 }
        catch { throw "Harness progress contains malformed JSON." }
    }
    $starts = @($records | Where-Object event -ceq "start")
    $finals = @($records | Where-Object event -ceq "final")
    if ($starts.Count -ne 1 -or $finals.Count -ne 1) {
        throw "Harness progress must contain one start and one final record."
    }
    foreach ($record in @($starts[0], $finals[0])) {
        if ([string](Get-Value $record "runId" "") -cne $Stage.RunId -or
            [string](Get-Value $record "stage" "") -cne $Stage.Stage -or
            (Get-Value $record "engineeringAcceptance" $false) -ne $true -or
            (Get-Value $record "certificationEligible" $true) -ne $false) {
            throw "Harness progress identity is invalid."
        }
    }
    $startUtc = Get-UtcTimestamp $starts[0] "timestamp" "harness progress start"
    $endUtc = Get-UtcTimestamp $finals[0] "timestamp" "harness progress final"
    if ($endUtc -le $startUtc) { throw "Harness traffic interval is invalid." }
    return [pscustomobject]@{ StartUtc = $startUtc; EndUtc = $endUtc }
}

function Assert-MonitorResult {
    param($Result, $Stage)
    $workload = Get-Value $Result "workload"
    $acceptance = Get-Value $Result "acceptance"
    if ([string](Get-Value $Result "runId" "") -cne $Stage.RunId -or
        [string](Get-Value $Result "phase" "") -cne "Waf" -or
        [string](Get-Value $Result "status" "") -cne "completed" -or
        (Get-Value $Result "diagnosticOnly" $true) -ne $false -or
        (Get-Value $Result "engineeringAcceptance" $false) -ne $true -or
        (Get-Value $Result "certificationEligible" $true) -ne $false -or
        (Get-Value $Result "loadAccepted" $false) -ne $true -or
        (Get-Value $Result "postureAccepted" $false) -ne $true -or
        (Get-Value $acceptance "passed" $false) -ne $true -or
        [string](Get-Value $workload "stage" "") -cne $Stage.Stage -or
        [int](Get-Value $workload "devices" 0) -ne [int]$Stage.Profile.devices -or
        [int](Get-Value $workload "durationSeconds" 0) -ne [int]$Stage.Profile.durationSeconds -or
        [string](Get-Value $workload "workloadSchemaVersion" "") -cne $script:WorkloadSchemaVersion -or
        [string](Get-Value $workload "endpointShapeSha256" "") -cne $script:EndpointShapeSha256) {
        throw "AWS monitor did not complete the exact engineering-acceptance profile."
    }
}

function Assert-MonitorScalingRestoration {
    param($Evidence, $Stage, $InitialPosture, $Config)
    $target = Get-Value $Evidence "target"
    $observed = Get-Value $Evidence "observed"
    $applicationRollback = Get-Value $Evidence "applicationRollback"
    $afterApplicationRollback = (
        Get-Value $Evidence "afterApplicationRollback" $false
    ) -eq $true
    $rollbackCompleted = $null -ne $applicationRollback -and
        (Get-Value $applicationRollback "attempted" $false) -eq $true -and
        (Get-Value $applicationRollback "completed" $false) -eq $true
    $expectedApiTask = if ($rollbackCompleted) {
        [string]$Config.RollbackApiTaskDefinitionArn
    } else {
        [string]$InitialPosture.Services.api.taskDefinitionArn
    }
    $expectedWorkerTask = if ($rollbackCompleted) {
        [string]$Config.RollbackWorkerTaskDefinitionArn
    } else {
        [string]$InitialPosture.Services.worker.taskDefinitionArn
    }
    if ([int](Get-Value $Evidence "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $Evidence "runId" "") -cne $Stage.RunId -or
        (Get-Value $Evidence "engineeringAcceptance" $false) -ne $true -or
        (Get-Value $Evidence "restored" $false) -ne $true -or
        $afterApplicationRollback -ne $rollbackCompleted -or
        (Get-Value $Evidence "rawErrorPersisted" $true) -ne $false -or
        $null -eq $target -or $null -eq $observed -or
        [int](Get-Value $target "apiDesiredCount" -1) -ne
            [int]$InitialPosture.Services.api.desired -or
        [int](Get-Value $target "minCapacity" -1) -ne
            [int]$InitialPosture.Scaling.minCapacity -or
        [int](Get-Value $target "maxCapacity" -1) -ne
            [int]$InitialPosture.Scaling.maxCapacity -or
        [string](Get-Value $target "scheduledActionsSha256" "") -cne
            [string]$InitialPosture.Scaling.scheduledActionsSha256 -or
        [string](Get-Value $target "scalingPoliciesSha256" "") -cne
            [string]$InitialPosture.Scaling.scalingPoliciesSha256 -or
        (Get-CanonicalSha256 (Get-Value $target "suspendedState")) -cne
            (Get-CanonicalSha256 $InitialPosture.Scaling.suspendedState) -or
        [int](Get-Value $observed "minCapacity" -1) -ne
            [int]$InitialPosture.Scaling.minCapacity -or
        [int](Get-Value $observed "maxCapacity" -1) -ne
            [int]$InitialPosture.Scaling.maxCapacity -or
        [string](Get-Value $observed "scheduledActionsSha256" "") -cne
            [string]$InitialPosture.Scaling.scheduledActionsSha256 -or
        [string](Get-Value $observed "scalingPoliciesSha256" "") -cne
            [string]$InitialPosture.Scaling.scalingPoliciesSha256 -or
        (Get-CanonicalSha256 (Get-Value $observed "suspendedState")) -cne
            (Get-CanonicalSha256 $InitialPosture.Scaling.suspendedState) -or
        [int](Get-Value (Get-Value $observed "api") "desired" -1) -ne
            [int]$InitialPosture.Services.api.desired -or
        [int](Get-Value (Get-Value $observed "api") "running" -1) -ne
            [int]$InitialPosture.Services.api.desired -or
        [int](Get-Value (Get-Value $observed "api") "pending" -1) -ne 0 -or
        [string](Get-Value (Get-Value $observed "api") "taskDefinition" "") -cne
            $expectedApiTask -or
        [int](Get-Value (Get-Value $observed "api") "deploymentCount" -1) -ne 1 -or
        [string](Get-Value (Get-Value $observed "api") "assignPublicIp" "") -cne
            "DISABLED" -or
        (Get-CanonicalSha256 @(
            Get-Value (Get-Value $observed "api") "subnets" @()
        )) -cne [string]$InitialPosture.Services.api.subnetSetSha256 -or
        [int](Get-Value (Get-Value $observed "worker") "desired" -1) -ne 1 -or
        [int](Get-Value (Get-Value $observed "worker") "running" -1) -ne 1 -or
        [int](Get-Value (Get-Value $observed "worker") "pending" -1) -ne 0 -or
        [string](Get-Value (Get-Value $observed "worker") "taskDefinition" "") -cne
            $expectedWorkerTask -or
        [int](Get-Value (Get-Value $observed "worker") "deploymentCount" -1) -ne 1 -or
        [string](Get-Value (Get-Value $observed "worker") "assignPublicIp" "") -cne
            "DISABLED" -or
        (Get-CanonicalSha256 @(
            Get-Value (Get-Value $observed "worker") "subnets" @()
        )) -cne [string]$InitialPosture.Services.worker.subnetSetSha256 -or
        [int](Get-Value (Get-Value $observed "targets") "total" -1) -ne
            [int]$InitialPosture.Services.api.desired -or
        [int](Get-Value (Get-Value $observed "targets") "healthy" -1) -ne
            [int]$InitialPosture.Services.api.desired -or
        [int](Get-Value (Get-Value $observed "targets") "unhealthy" -1) -ne 0) {
        throw "AWS monitor did not independently restore the exact bound scaling and application posture."
    }
    if ($rollbackCompleted -and (
        [string](Get-Value $applicationRollback "apiTaskDefinitionSha256" "") -cne
            (Get-StringSha256 $Config.RollbackApiTaskDefinitionArn) -or
        [string](Get-Value $applicationRollback "workerTaskDefinitionSha256" "") -cne
            (Get-StringSha256 $Config.RollbackWorkerTaskDefinitionArn) -or
        [int](Get-Value $applicationRollback "exitCode" -1) -ne 0 -or
        (Get-Value $applicationRollback "rawErrorPersisted" $true) -ne $false
    )) {
        throw "AWS monitor application-rollback evidence is incomplete or drifted."
    }
}

function Get-MonitorOwnedApplicationRollback {
    param($Config, $MonitorResult)
    $rollback = Get-Value $MonitorResult "rollback"
    if ($null -eq $rollback -or
        (Get-Value $rollback "attempted" $false) -ne $true) {
        return $null
    }
    $completed = (Get-Value $rollback "completed" $false) -eq $true
    $mutationStarted = (Get-Value $rollback "mutationStarted" $false) -eq $true
    if ((Get-Value $rollback "approved" $false) -ne $true -or
        [string](Get-Value $rollback "action" "") -cne "Application" -or
        [string](Get-Value $rollback "apiTaskDefinitionSha256" "") -cne
            (Get-StringSha256 $Config.RollbackApiTaskDefinitionArn) -or
        [string](Get-Value $rollback "workerTaskDefinitionSha256" "") -cne
            (Get-StringSha256 $Config.RollbackWorkerTaskDefinitionArn) -or
        (Get-Value $rollback "rawErrorPersisted" $true) -ne $false -or
        ($completed -and [int](Get-Value $rollback "exitCode" -1) -ne 0) -or
        (-not $completed -and -not $mutationStarted)) {
        throw "Monitor-owned application rollback evidence is incomplete or drifted."
    }
    return [ordered]@{
        approved = $true
        attempted = $true
        completed = $completed
        mutationStarted = $mutationStarted
        action = "Application"
        exitCode = Get-Value $rollback "exitCode"
        apiTaskDefinitionSha256 = [string]$rollback.apiTaskDefinitionSha256
        workerTaskDefinitionSha256 = [string]$rollback.workerTaskDefinitionSha256
        completedAtUtc = [string](Get-Value $rollback "completedAtUtc" "")
        rawErrorPersisted = $false
        source = "aws_monitor"
    }
}

function Assert-ControllerScalingRestoration {
    param($Evidence, $InitialPosture, $ApplicationRollback, $Config)
    $posture = Get-Value $Evidence "posture"
    $afterRollback = (Get-Value $Evidence "afterApplicationRollback" $false) -eq $true
    $rollbackCompleted = $null -ne $ApplicationRollback -and
        (Get-Value $ApplicationRollback "attempted" $false) -eq $true -and
        (Get-Value $ApplicationRollback "completed" $false) -eq $true
    if ((Get-Value $Evidence "restored" $false) -ne $true -or
        $afterRollback -ne $rollbackCompleted -or $null -eq $posture) {
        throw "Controller scaling-restoration evidence is incomplete or drifted."
    }

    $expectedApiTask = if ($afterRollback) {
        [string]$Config.RollbackApiTaskDefinitionArn
    } else {
        [string]$InitialPosture.Services.api.taskDefinitionArn
    }
    $expectedWorkerTask = if ($afterRollback) {
        [string]$Config.RollbackWorkerTaskDefinitionArn
    } else {
        [string]$InitialPosture.Services.worker.taskDefinitionArn
    }
    $api = Get-Value (Get-Value $posture "Services") "api"
    $worker = Get-Value (Get-Value $posture "Services") "worker"
    $scaling = Get-Value $posture "Scaling"
    $targets = Get-Value $posture "Targets"
    $workerExecution = Get-Value $posture "WorkerExecution"
    if ([int](Get-Value $api "desired" -1) -ne [int]$InitialPosture.Services.api.desired -or
        [int](Get-Value $api "running" -1) -ne [int]$InitialPosture.Services.api.desired -or
        [int](Get-Value $api "pending" -1) -ne 0 -or
        [string](Get-Value $api "taskDefinitionArn" "") -cne $expectedApiTask -or
        [string](Get-Value $api "assignPublicIp" "") -cne "DISABLED" -or
        [string](Get-Value $api "subnetSetSha256" "") -cne
            [string]$InitialPosture.Services.api.subnetSetSha256 -or
        [int](Get-Value $worker "desired" -1) -ne 1 -or
        [int](Get-Value $worker "running" -1) -ne 1 -or
        [int](Get-Value $worker "pending" -1) -ne 0 -or
        [string](Get-Value $worker "taskDefinitionArn" "") -cne $expectedWorkerTask -or
        [string](Get-Value $worker "assignPublicIp" "") -cne "DISABLED" -or
        [string](Get-Value $worker "subnetSetSha256" "") -cne
            [string]$InitialPosture.Services.worker.subnetSetSha256 -or
        [string](Get-Value $workerExecution "TaskDefinitionArn" "") -cne $expectedWorkerTask -or
        [int](Get-Value $scaling "minCapacity" -1) -ne
            [int]$InitialPosture.Scaling.minCapacity -or
        [int](Get-Value $scaling "maxCapacity" -1) -ne
            [int]$InitialPosture.Scaling.maxCapacity -or
        (Get-CanonicalSha256 (Get-Value $scaling "suspendedState")) -cne
            (Get-CanonicalSha256 $InitialPosture.Scaling.suspendedState) -or
        [string](Get-Value $scaling "scheduledActionsSha256" "") -cne
            [string]$InitialPosture.Scaling.scheduledActionsSha256 -or
        [string](Get-Value $scaling "scalingPoliciesSha256" "") -cne
            [string]$InitialPosture.Scaling.scalingPoliciesSha256 -or
        [int](Get-Value $targets "total" -1) -ne [int]$InitialPosture.Services.api.desired -or
        [int](Get-Value $targets "healthy" -1) -ne [int]$InitialPosture.Services.api.desired -or
        [int](Get-Value $targets "nonHealthy" -1) -ne 0 -or
        (Get-CanonicalSha256 (Get-Value $posture "Rds")) -cne
            (Get-CanonicalSha256 $InitialPosture.Rds) -or
        (Get-CanonicalSha256 (Get-Value $posture "Redis")) -cne
            (Get-CanonicalSha256 $InitialPosture.Redis) -or
        (Get-CanonicalSha256 (Get-Value $posture "Nat")) -cne
            (Get-CanonicalSha256 $InitialPosture.Nat) -or
        (Get-CanonicalSha256 (Get-Value $posture "Waf")) -cne
            (Get-CanonicalSha256 $InitialPosture.Waf) -or
        (Get-CanonicalSha256 (Get-Value $posture "Route53")) -cne
            (Get-CanonicalSha256 $InitialPosture.Route53)) {
        throw "Controller scaling-restoration evidence does not prove the exact bound production posture."
    }
}

function Get-57014Snapshot {
    param($Config, $InitialPosture, $Interval)
    $logging = $InitialPosture.ApiTask.Logging
    if ($null -eq $logging) { throw "The bound API log configuration is unavailable." }
    $nextToken = $null
    $seenTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $pageCount = 0
    $eventCount = 0
    do {
        $arguments = @(
            "logs", "filter-log-events", "--region", $logging.Region,
            "--log-group-name", $logging.Group,
            "--log-stream-name-prefix", $logging.StreamPrefix,
            "--start-time", [string][long]($Interval.StartUtc.ToUnixTimeMilliseconds()),
            "--end-time", [string][long]($Interval.EndUtc.ToUnixTimeMilliseconds() + 1),
            "--filter-pattern", '"57014"'
        )
        if ($nextToken) { $arguments += @("--next-token", $nextToken) }
        $response = Invoke-AwsJson $arguments
        $pageCount++
        if ($pageCount -gt 100) { throw "PostgreSQL 57014 log evidence exceeded the page limit." }
        $events = @($response.events)
        $eventCount += $events.Count
        if ($eventCount -gt 10000) { throw "PostgreSQL 57014 log evidence exceeded the event limit." }
        foreach ($event in $events) {
            $timestamp = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$event.timestamp)
            if ($timestamp -lt $Interval.StartUtc -or $timestamp -gt $Interval.EndUtc -or
                [string]$event.logStreamName -notlike "$($logging.StreamPrefix)*" -or
                [string]$event.message -notmatch '57014') {
                throw "PostgreSQL 57014 log evidence contained an out-of-scope event."
            }
        }
        $nextToken = [string](Get-Value $response "nextToken" "")
        if ($nextToken -and -not $seenTokens.Add($nextToken)) {
            throw "PostgreSQL 57014 log evidence pagination cycled."
        }
    } while ($nextToken)
    return [ordered]@{
        eventCount = $eventCount
        pageCount = $pageCount
        canonicalSha256 = Get-CanonicalSha256 ([ordered]@{
            eventCount = $eventCount
            pageCount = $pageCount
            trafficStartUtc = $Interval.StartUtc.ToString("o")
            trafficEndUtc = $Interval.EndUtc.ToString("o")
        })
    }
}

function Get-Zero57014Evidence {
    param($Config, $InitialPosture, $Interval)
    $notBefore = $Interval.EndUtc.AddMinutes(5)
    $deadline = $Interval.EndUtc.AddMinutes(15)
    if ($deadline -lt [DateTimeOffset]::UtcNow.AddMinutes(2)) {
        $deadline = [DateTimeOffset]::UtcNow.AddMinutes(2)
    }
    while ([DateTimeOffset]::UtcNow -lt $notBefore) {
        $remaining = ($notBefore - [DateTimeOffset]::UtcNow).TotalSeconds
        Start-Sleep -Seconds ([math]::Max(1, [math]::Min(30, [int][math]::Ceiling($remaining))))
    }
    $previousHash = $null
    $attemptCount = 0
    do {
        $snapshot = Get-57014Snapshot $Config $InitialPosture $Interval
        $attemptCount++
        if ($snapshot.canonicalSha256 -ceq $previousHash) {
            if ([int]$snapshot.eventCount -ne 0) {
                throw "PostgreSQL 57014 statement-timeout evidence was observed."
            }
            return [ordered]@{
                collected = $true
                passed = $true
                eventCount = 0
                pageCount = [int]$snapshot.pageCount
                attemptCount = $attemptCount
                stableSnapshotSha256 = [string]$snapshot.canonicalSha256
                trafficStartUtc = $Interval.StartUtc.ToString("o")
                trafficEndUtc = $Interval.EndUtc.ToString("o")
                logConfiguration = $InitialPosture.ApiTask.Logging.Sanitized
                collectedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            }
        }
        $previousHash = [string]$snapshot.canonicalSha256
        if ([DateTimeOffset]::UtcNow -ge $deadline) { break }
        $remaining = ($deadline - [DateTimeOffset]::UtcNow).TotalSeconds
        Start-Sleep -Seconds ([math]::Max(1, [math]::Min(30, [int][math]::Ceiling($remaining))))
    } while ($true)
    throw "PostgreSQL 57014 log evidence did not stabilize before its publication deadline."
}

function Get-WorkerWindowLogSnapshot {
    param($Config, $WorkerExecution, $Interval)
    $nextToken = $null
    $seenTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $events = [Collections.Generic.List[object]]::new()
    $pageCount = 0
    do {
        $arguments = @(
            "logs", "get-log-events", "--region", $Config.Resources.region,
            "--log-group-name", $WorkerExecution.LogGroup,
            "--log-stream-name", $WorkerExecution.LogStream,
            "--start-time", [string]$Interval.StartUtc.AddMinutes(-2).ToUnixTimeMilliseconds(),
            "--end-time", [string]$Interval.EndUtc.AddMinutes(2).ToUnixTimeMilliseconds(),
            "--start-from-head"
        )
        if ($nextToken) { $arguments += @("--next-token", $nextToken) }
        $response = Invoke-AwsJson $arguments 30
        $pageCount++
        if ($pageCount -gt 100) { throw "Scheduler-window log evidence exceeded the page limit." }
        foreach ($event in @($response.events)) {
            $timestamp = [int64](Get-Value $event "timestamp" -1)
            $ingestionTime = [int64](Get-Value $event "ingestionTime" -1)
            $message = [string](Get-Value $event "message" "")
            if ($timestamp -lt 0 -or $ingestionTime -lt 0 -or [string]::IsNullOrWhiteSpace($message)) {
                throw "Scheduler-window log evidence contained a malformed event."
            }
            $events.Add([pscustomobject]@{
                timestamp = $timestamp
                ingestionTime = $ingestionTime
                message = $message
                messageSha256 = Get-StringSha256 $message
            })
            if ($events.Count -gt 10000) { throw "Scheduler-window log evidence exceeded the event limit." }
        }
        $newToken = [string](Get-Value $response "nextForwardToken" "")
        if (-not $newToken -or $newToken -ceq $nextToken) { break }
        if (-not $seenTokens.Add($newToken)) {
            throw "Scheduler-window log evidence pagination cycled."
        }
        $nextToken = $newToken
    } while ($true)
    $ordered = @($events | Sort-Object timestamp, ingestionTime, messageSha256)
    $heartbeatTimes = @($ordered | Where-Object {
        $_.message -match '"Service"\s*:\s*"scheduler-worker"' -and
        $_.message -match '"WorkerHeartbeat"\s*:\s*1(?:\D|$)'
    } | ForEach-Object { [int64]$_.timestamp } | Sort-Object)
    $failureEvents = @($ordered | Where-Object {
        $_.message -match '(?i)(scheduler_failure|Heartbeat purge error|Daily usage rollup error|' +
            '\[Scheduler\]\s+runHeavyJobsSerially failed outside handler|' +
            '\[SchedulerWorker\]\s+(?:uncaughtException|unhandledRejection))'
    })
    $skipTimes = @($ordered | Where-Object {
        $_.message -match '\[Scheduler\]\s+Heavy job already running, skipping this tick'
    } | ForEach-Object { [int64]$_.timestamp } | Sort-Object)
    $skipOverrun = $false
    if ($skipTimes.Count -ge 2) {
        for ($index = 0; $index -lt $skipTimes.Count; $index++) {
            if ($skipTimes[-1] - $skipTimes[$index] -ge 600000) {
                $skipOverrun = $true
                break
            }
        }
    }
    $maximumHeartbeatGapMilliseconds = 0
    for ($index = 1; $index -lt $heartbeatTimes.Count; $index++) {
        $maximumHeartbeatGapMilliseconds = [math]::Max(
            $maximumHeartbeatGapMilliseconds,
            $heartbeatTimes[$index] - $heartbeatTimes[$index - 1]
        )
    }
    $startMilliseconds = $Interval.StartUtc.ToUnixTimeMilliseconds()
    $endMilliseconds = $Interval.EndUtc.ToUnixTimeMilliseconds()
    $heartbeatCoverage = (
        $heartbeatTimes.Count -ge [math]::Floor(($endMilliseconds - $startMilliseconds) / 120000) -and
        $heartbeatTimes[0] -le $startMilliseconds + 120000 -and
        $heartbeatTimes[-1] -ge $endMilliseconds - 120000 -and
        $maximumHeartbeatGapMilliseconds -le 180000
    )
    $canonical = @($ordered | ForEach-Object {
        [ordered]@{
            timestamp = $_.timestamp
            ingestionTime = $_.ingestionTime
            messageSha256 = $_.messageSha256
        }
    })
    return [ordered]@{
        canonicalSha256 = Get-CanonicalSha256 $canonical
        pageCount = $pageCount
        eventCount = $ordered.Count
        heartbeatCount = $heartbeatTimes.Count
        heartbeatCoverage = $heartbeatCoverage
        maximumHeartbeatGapMilliseconds = [int64]$maximumHeartbeatGapMilliseconds
        schedulerFailureCount = $failureEvents.Count
        heavyJobSkipCount = $skipTimes.Count
        heavyJobOverrunObserved = $skipOverrun
    }
}

function Get-Waf800MaintenanceWindowEvidence {
    param($Config, $InitialPosture, $Interval)
    $notBefore = $Interval.EndUtc.AddMinutes(5)
    $deadline = $Interval.EndUtc.AddMinutes(15)
    if ($deadline -lt [DateTimeOffset]::UtcNow.AddMinutes(2)) {
        $deadline = [DateTimeOffset]::UtcNow.AddMinutes(2)
    }
    while ([DateTimeOffset]::UtcNow -lt $notBefore) {
        $remaining = ($notBefore - [DateTimeOffset]::UtcNow).TotalSeconds
        Start-Sleep -Seconds ([math]::Max(1, [math]::Min(30, [int][math]::Ceiling($remaining))))
    }
    $previousHash = $null
    $attemptCount = 0
    do {
        $currentWorker = Get-WorkerExecutionPosture $Config $InitialPosture.WorkerTask
        if ($currentWorker.TaskArn -cne $InitialPosture.WorkerExecution.TaskArn -or
            $currentWorker.TaskDefinitionArn -cne $Config.WorkerTaskDefinitionArn -or
            $currentWorker.LogStream -cne $InitialPosture.WorkerExecution.LogStream -or
            $currentWorker.StartedAtUtc -gt $Interval.StartUtc) {
            throw "The scheduler worker was replaced or drifted across the Waf/800 maintenance window."
        }
        $snapshot = Get-WorkerWindowLogSnapshot $Config $currentWorker $Interval
        $attemptCount++
        if ($snapshot.canonicalSha256 -ceq $previousHash) {
            if (-not $snapshot.heartbeatCoverage -or $snapshot.schedulerFailureCount -ne 0 -or
                $snapshot.heavyJobOverrunObserved) {
                throw "The Waf/800 purge/rollup worker evidence failed its strict maintenance-window gate."
            }
            return [ordered]@{
                required = $true
                passed = $true
                workerTaskDefinitionSha256 = Get-StringSha256 $Config.WorkerTaskDefinitionArn
                workerTaskArnSha256 = $currentWorker.TaskArnSha256
                logGroupSha256 = Get-StringSha256 $currentWorker.LogGroup
                logStreamSha256 = $currentWorker.LogStreamSha256
                trafficStartUtc = $Interval.StartUtc.ToString("o")
                trafficEndUtc = $Interval.EndUtc.ToString("o")
                pageCount = [int]$snapshot.pageCount
                eventCount = [int]$snapshot.eventCount
                heartbeatCount = [int]$snapshot.heartbeatCount
                maximumHeartbeatGapMilliseconds = [int64]$snapshot.maximumHeartbeatGapMilliseconds
                schedulerFailureCount = 0
                heavyJobSkipCount = [int]$snapshot.heavyJobSkipCount
                heavyJobOverrunObserved = $false
                attemptCount = $attemptCount
                stableSnapshotSha256 = [string]$snapshot.canonicalSha256
                completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
                rawErrorPersisted = $false
            }
        }
        $previousHash = [string]$snapshot.canonicalSha256
        if ([DateTimeOffset]::UtcNow -ge $deadline) { break }
        $remaining = ($deadline - [DateTimeOffset]::UtcNow).TotalSeconds
        Start-Sleep -Seconds ([math]::Max(1, [math]::Min(30, [int][math]::Ceiling($remaining))))
    } while ($true)
    throw "Waf/800 maintenance-window log evidence did not stabilize before its publication deadline."
}

function Get-StandardPiContextBestEffort {
    param($Config, $InitialPosture, $Interval)
    $startedAtUtc = [DateTimeOffset]::UtcNow
    try {
        $nextToken = $null
        $seenTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $values = [Collections.Generic.List[double]]::new()
        $pages = 0
        do {
            $arguments = @(
                "pi", "get-resource-metrics", "--region", $Config.Resources.region,
                "--service-type", "RDS", "--identifier", $InitialPosture.Rds.dbiResourceId,
                "--metric-queries", "Metric=db.load.avg",
                "--start-time", $Interval.StartUtc.ToString("o"),
                "--end-time", $Interval.EndUtc.ToString("o"),
                "--period-in-seconds", "60"
            )
            if ($nextToken) { $arguments += @("--next-token", $nextToken) }
            $response = Invoke-AwsJson $arguments 60
            $pages++
            if ($pages -gt 100) { throw "PI page limit exceeded." }
            foreach ($metric in @($response.MetricList)) {
                foreach ($point in @($metric.DataPoints)) {
                    $value = [double](Get-Value $point "Value" [double]::NaN)
                    if ([double]::IsNaN($value) -or [double]::IsInfinity($value) -or $value -lt 0) {
                        throw "PI returned an invalid datapoint."
                    }
                    $values.Add($value)
                    if ($values.Count -gt 10000) { throw "PI datapoint limit exceeded." }
                }
            }
            $nextToken = [string](Get-Value $response "NextToken" "")
            if ($nextToken -and -not $seenTokens.Add($nextToken)) { throw "PI pagination cycled." }
        } while ($nextToken)
        $average = if ($values.Count -eq 0) { $null } else {
            [math]::Round(($values | Measure-Object -Average).Average, 6)
        }
        $maximum = if ($values.Count -eq 0) { $null } else {
            [math]::Round(($values | Measure-Object -Maximum).Maximum, 6)
        }
        return [ordered]@{
            informationalOnly = $true
            databaseInsightsMode = "standard"
            collected = $true
            passed = $null
            datapointCount = $values.Count
            pageCount = $pages
            averageDbLoad = $average
            maximumDbLoad = $maximum
            startedAtUtc = $startedAtUtc.ToString("o")
            completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            rawErrorPersisted = $false
        }
    }
    catch {
        return [ordered]@{
            informationalOnly = $true
            databaseInsightsMode = "standard"
            collected = $false
            passed = $null
            failureCode = "standard_pi_context_unavailable"
            discardedMessageSha256 = Get-StringSha256 $_.Exception.Message
            startedAtUtc = $startedAtUtc.ToString("o")
            completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            rawErrorPersisted = $false
        }
    }
}

function New-ApplicationRollbackIntent {
    param($Config)
    return [ordered]@{
        attempted = $true
        completed = $false
        mutationStarted = $true
        action = "Application"
        exitCode = $null
        completedAtUtc = $null
        apiTaskDefinitionSha256 =
            Get-StringSha256 $Config.RollbackApiTaskDefinitionArn
        workerTaskDefinitionSha256 =
            Get-StringSha256 $Config.RollbackWorkerTaskDefinitionArn
        rawErrorPersisted = $false
    }
}

function Invoke-ApplicationRollback {
    param($Config, [int]$ExpectedApiCount)
    $retryDelays = @(0, 1, 2, 4)
    for ($attempt = 1; $attempt -le $retryDelays.Count; $attempt++) {
        $delay = [int]$retryDelays[$attempt - 1]
        if ($delay -gt 0) { Start-Sleep -Seconds $delay }
        $apiUpdateAccepted = $false
        $workerUpdateAccepted = $false
        try {
            Invoke-AwsCommand @(
                "ecs", "update-service", "--region", $Config.Resources.region,
                "--cluster", $Config.Resources.cluster, "--service", $Config.Resources.apiService,
                "--task-definition", $Config.RollbackApiTaskDefinitionArn
            )
            $apiUpdateAccepted = $true
        }
        catch { }
        try {
            Invoke-AwsCommand @(
                "ecs", "update-service", "--region", $Config.Resources.region,
                "--cluster", $Config.Resources.cluster, "--service", $Config.Resources.workerService,
                "--task-definition", $Config.RollbackWorkerTaskDefinitionArn
            )
            $workerUpdateAccepted = $true
        }
        catch { }
        if (-not $apiUpdateAccepted -or -not $workerUpdateAccepted) { continue }
        try {
            Invoke-AwsCommand @(
                "ecs", "wait", "services-stable", "--region", $Config.Resources.region,
                "--cluster", $Config.Resources.cluster, "--services",
                $Config.Resources.apiService, $Config.Resources.workerService
            )
            [void](Wait-TargetHealth $Config $ExpectedApiCount)
            $servicesResponse = Invoke-AwsJson @(
                "ecs", "describe-services", "--region", $Config.Resources.region,
                "--cluster", $Config.Resources.cluster, "--services",
                $Config.Resources.apiService, $Config.Resources.workerService
            )
            $services = @($servicesResponse.services)
            $api = @($services | Where-Object serviceName -ceq $Config.Resources.apiService)
            $worker = @($services | Where-Object serviceName -ceq $Config.Resources.workerService)
            if ($api.Count -eq 1 -and $worker.Count -eq 1 -and
                [string]$api[0].taskDefinition -ceq $Config.RollbackApiTaskDefinitionArn -and
                [string]$worker[0].taskDefinition -ceq
                    $Config.RollbackWorkerTaskDefinitionArn -and
                [int]$api[0].desiredCount -eq $ExpectedApiCount -and
                [int]$api[0].runningCount -eq $ExpectedApiCount -and
                [int]$worker[0].desiredCount -eq 1 -and
                [int]$worker[0].runningCount -eq 1 -and
                [int]$api[0].pendingCount -eq 0 -and
                [int]$worker[0].pendingCount -eq 0) {
                return [ordered]@{
                    attempted = $true
                    completed = $true
                    mutationStarted = $true
                    action = "Application"
                    exitCode = 0
                    attemptCount = $attempt
                    completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
                    apiTaskDefinitionSha256 =
                        Get-StringSha256 $Config.RollbackApiTaskDefinitionArn
                    workerTaskDefinitionSha256 =
                        Get-StringSha256 $Config.RollbackWorkerTaskDefinitionArn
                    rawErrorPersisted = $false
                }
            }
        }
        catch { }
    }
    throw "Application rollback did not converge to the exact API and worker revisions."
}

function Test-ApplicationFailure {
    param($MonitorResult, $Summary, [string]$SanitizedFailureCode = "")
    if ($SanitizedFailureCode -in @(
            "pretraffic_application_health", "maintenance_window_application_failure"
        )) {
        return $true
    }
    $failures = @((Get-Value $MonitorResult "failures" @())) + @(
        Get-Value (Get-Value $Summary "thresholds") "failures" @()
    )
    $fatalGate = Get-Value $Summary "fatalGate"
    $fatalReasons = @((Get-Value $fatalGate "reasonCodes" @()))
    $functionalFatalPattern = '^(cross-school-http-response|cross-school-delivery|' +
        'tenant-isolation-probe-unavailable|invalid-teacher-response|command-target-scope|' +
        'unfinished-http-requests|valid-http-(?:429|3\d\d|4(?:0[0-24-9]|[1-9]\d)))$'
    if (@($fatalReasons | Where-Object {
                [string]$_ -match $functionalFatalPattern
            }).Count -gt 0) {
        return $true
    }
    $monitorApplicationPattern = '^(alb_unhealthy(?:$|:)|ecs_active_(?:api|worker)_task_definition_mismatch|' +
        'ecs_active_running_task_revision_mismatch|ecs_active_emergency_api_oom(?:$|:)|' +
        'ecs_api_oom(?:$|:)|ecs_task_stopped(?:$|:)|ecs_unstable(?:$|:)|' +
        'load:(?:cross-school-delivery|cross-school-http-response|tenant-isolation-probe-failed|' +
        'command-target-scope|invalid-teacher-response|unfinished-http-requests))'
    $summaryApplicationPattern = '(?i)(HTTP 5xx rate|network error rate|admission-timeout 503|' +
        'valid traffic received .*HTTP (?:4xx|3xx)|HTTP requests remained unfinished|' +
        'inspected HTTP responses could not be parsed completely|' +
        'heartbeat (?:traffic|p95)|screenshot (?:POST|GET|success)|teacher/dashboard|history batch|' +
        'teacher command|WebSocket (?:auth|close|keepalive|reconnect)|crossed the declared school|' +
        'command target|teacher response|tenant-canary|foreign school|known non-owned|' +
        'tenant isolation probes passed|' +
        'final pre-shutdown WebSocket state|class command (?:targeted|reached|was delivered)|' +
        'only \d+/\d+ (?:device|teacher) sockets were authenticated at final pre-shutdown|' +
        'forced reconnects (?:were requested|requested|completed)|' +
        'command validation produced no sent targets|' +
        'configured class bodies produced sent (?:command )?targets|class bodies reached \d+ sent targets|' +
        'teacher WebSockets authenticated|teacher WebSockets closed unexpectedly|' +
        '(?:GET /api/students-aggregated|POST /api/classpilot/tiles/(?:history|screenshots)|' +
        'POST /api/classpilot/commands) (?:emitted no completed samples|p95 exceeds \d+ms)|' +
        'command responses or update owners|server command target statuses regressed|' +
        'command targets (?:received|sent completed ACKs)|server did not report (?:received|completed)|' +
        'unfinished-http-requests)'
    $hardApplicationFailure = @($failures | Where-Object {
        [string]$_ -match $monitorApplicationPattern
    }).Count -gt 0
    if ($hardApplicationFailure) { return $true }
    if ($SanitizedFailureCode -ceq "postgresql_57014") { return $true }

    # Capacity/provider causes take precedence over derivative latency/HTTP
    # symptoms. Rolling application revisions back cannot repair exhausted RDS
    # or Redis capacity, incomplete provider evidence, or WAF enforcement.
    $capacityOrWafPattern = '(?i)(?:^|:)(?:rds|redis|telemetry|evidence|performance_insights|' +
        'waf_.+blocked|ecs_(?:cpu|memory))(?::|_|$)'
    $capacityOrWafCause = @($failures | Where-Object {
        [string]$_ -match $capacityOrWafPattern
    }).Count -gt 0
    if ($capacityOrWafCause) { return $false }

    return @($failures | Where-Object {
        [string]$_ -match $summaryApplicationPattern
    }).Count -gt 0
}

function Initialize-ToolPaths {
    foreach ($binding in @(
        @("AwsPath", "aws"),
        @("NodePath", "node"),
        @("PwshPath", "pwsh"),
        @("GitPath", "git")
    )) {
        $command = Get-Command $binding[1] -ErrorAction Stop
        Set-Variable -Scope Script -Name $binding[0] -Value ([IO.Path]::GetFullPath($command.Source))
    }
}

function New-ScratchMonitorConfiguration {
    param($Config, $Stage, $InitialPosture)
    $scratchRoot = Join-Path ([IO.Path]::GetTempPath()) (
        "schoolpilot-capacity-validate-{0}-{1}" -f $Stage.RunId, [Guid]::NewGuid().ToString("N")
    )
    $current = Get-Process -Id $PID
    $child = [pscustomobject]@{
        ProcessId = $PID
        StartedAtUtc = [DateTimeOffset]$current.StartTime.ToUniversalTime()
        ProcessPath = $script:PwshPath
    }
    return [pscustomobject]@{
        Root = $scratchRoot
        Config = New-MonitorConfiguration $Config $Stage $scratchRoot $child `
            ([DateTimeOffset]::UtcNow) $InitialPosture
    }
}

function Invoke-RunnerValidation {
    param($Config, [ref]$ObservedPosture)
    Assert-PlannedWindowsSchedulable $Config
    $generatorIpv4 = Get-CurrentGeneratorIpv4
    if ($generatorIpv4 -cne $Config.ExpectedGeneratorPublicIp) {
        throw "The current generator IPv4 does not match the immutable acceptance binding."
    }
    Assert-RepositoryIdentity $Config
    Assert-FixtureAuthority $Config
    Assert-RollbackCompatibility $Config
    $posture = Get-ProductionPosture $Config
    if ($null -ne $ObservedPosture) {
        $ObservedPosture.Value = $posture
    }
    foreach ($stage in $Config.Stages) {
        $scratch = New-ScratchMonitorConfiguration $Config $stage $posture
        try {
            New-Item -ItemType Directory -Path $scratch.Root -Force | Out-Null
            Set-CurrentUserPrivateAcl $scratch.Root -Directory
            $monitorConfigPath = Join-Path $scratch.Root "monitor-config.json"
            Write-AtomicJson $monitorConfigPath $scratch.Config
            $monitorConfigSha = (Get-FileHash -LiteralPath $monitorConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
            Invoke-MonitorValidation $monitorConfigPath $monitorConfigSha `
                (Join-Path $scratch.Root "monitor-validate.stdout.log") `
                (Join-Path $scratch.Root "monitor-validate.stderr.log")
        }
        finally {
            if (Test-Path -LiteralPath $scratch.Root) {
                Remove-Item -LiteralPath $scratch.Root -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    return [ordered]@{
        valid = $true
        engineeringAcceptance = $true
        certificationEligible = $false
        runId = $Config.RunId
        applicationGitSha = $Config.ApplicationGitSha
        imageDigest = $Config.ImageDigest
        generatorIpv4Sha256 = Get-StringSha256 $generatorIpv4
        postureSha256 = Get-CanonicalSha256 $posture
    }
}

function Wait-ForStageProcesses {
    param(
        $Config, $Stage, $HarnessChild, $MonitorChild,
        [DateTimeOffset]$DeadlineUtc, [string]$GeneratorIpEvidencePath
    )
    $nextGeneratorCheckUtc = [DateTimeOffset]::MinValue
    while (-not $MonitorChild.Process.HasExited) {
        if ([DateTimeOffset]::UtcNow -ge $nextGeneratorCheckUtc) {
            Write-GeneratorIpEvidence $Config $Stage $GeneratorIpEvidencePath
            $nextGeneratorCheckUtc = [DateTimeOffset]::UtcNow.AddSeconds(60)
        }
        if ([DateTimeOffset]::UtcNow -ge $DeadlineUtc) {
            throw "The AWS monitor did not commit a terminal result before its deadline."
        }
        Start-Sleep -Seconds 5
    }
    $monitorExit = Complete-SupervisedProcess $MonitorChild -TimeoutSeconds $script:ChildExitGraceSeconds
    if (-not $HarnessChild.Process.HasExited) {
        # A successful monitor can finish immediately after the harness commits
        # its final summary while the harness is still flushing normal cleanup.
        # Give that exact bound process one bounded, no-traffic exit grace before
        # treating it as an orphan and recursively terminating its tree.
        if (-not $HarnessChild.Process.WaitForExit($script:ChildExitGraceSeconds * 1000)) {
            [void](Complete-SupervisedProcess $HarnessChild `
                -TimeoutSeconds $script:ChildExitGraceSeconds -Terminate)
            throw "The monitor exited while the load harness remained live after its bounded exit grace."
        }
    }
    $harnessExit = Complete-SupervisedProcess $HarnessChild -TimeoutSeconds $script:ChildExitGraceSeconds
    return [pscustomobject]@{ MonitorExit = $monitorExit; HarnessExit = $harnessExit }
}

function Invoke-StageAttempt {
    param($Config, $Stage, [string]$StageRoot, [int]$AttemptNumber, $Preparation)
    $attemptRoot = Join-Path $StageRoot ("attempt-{0}" -f $AttemptNumber)
    New-Item -ItemType Directory -Path $attemptRoot | Out-Null
    $harnessChild = $null
    $monitorChild = $null
    $initialPosture = $null
    $restoration = $null
    $interval = $null
    $summary = $null
    $monitorResult = $null
    $zero57014 = $null
    $maintenanceWindow = if ($Stage.Stage -ceq "800") {
        $null
    } else {
        [ordered]@{ required = $false; passed = $true }
    }
    $piContext = $null
    $applicationRollback = [ordered]@{ attempted = $false; completed = $false }
    $failure = $null
    $terminationFailure = $null
    $sanitizedFailureCode = ""
    $startedTraffic = $false
    $exits = $null
    try {
        if ([DateTimeOffset]::UtcNow -gt $Stage.TrafficStartNotAfterUtc) {
            throw "The immutable traffic start window has expired."
        }
        $initialPosture = Get-ProductionPosture $Config
        Write-AtomicJson (Join-Path $attemptRoot "initial-posture.json") $initialPosture
        Assert-PreparedHarnessArtifacts $Config $Preparation
        $environment = Get-HarnessEnvironment $Config $Stage $attemptRoot
        $preflight = Invoke-HarnessPreflight $environment $attemptRoot
        Write-AtomicJson (Join-Path $attemptRoot "harness-preflight.json") $preflight
        $artifactsNotBefore = [DateTimeOffset]::UtcNow
        $harnessChild = Start-SupervisedProcess -FilePath $script:NodePath `
            -Arguments @($script:HarnessPath) -Environment $environment `
            -StdoutPath (Join-Path $attemptRoot "harness.stdout.log") `
            -StderrPath (Join-Path $attemptRoot "harness.stderr.log")
        $controllerProcess = Get-Process -Id $PID -ErrorAction Stop
        $processBindingPath = Join-Path $attemptRoot "process-binding.json"
        $processBinding = [ordered]@{
            stage = $Stage.Stage
            runId = $Stage.RunId
            attempt = $AttemptNumber
            controller = [ordered]@{
                processId = [int]$PID
                startedAtUtc = (
                    [DateTimeOffset]$controllerProcess.StartTime
                ).ToUniversalTime().ToString("o")
                path = [IO.Path]::GetFullPath([string]$controllerProcess.Path)
            }
            harness = [ordered]@{
                processId = [int]$harnessChild.ProcessId
                startedAtUtc = $harnessChild.StartedAtUtc.ToString("o")
                path = $harnessChild.ProcessPath
                exitCode = $null
            }
            monitor = $null
            completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        }
        Write-AtomicJson $processBindingPath $processBinding
        $readyPath = [string]$environment.LOAD_SUPERVISOR_READY_PATH
        Wait-ForPath $readyPath ([DateTimeOffset]::UtcNow.AddMinutes(5)) $harnessChild `
            "The harness did not commit ready evidence."
        $ready = Assert-HarnessReady $readyPath $Stage $harnessChild

        $monitorConfig = New-MonitorConfiguration $Config $Stage $attemptRoot $harnessChild `
            $artifactsNotBefore $initialPosture
        $monitorConfigPath = Join-Path $attemptRoot "monitor-config.json"
        Write-AtomicJson $monitorConfigPath $monitorConfig
        $monitorConfigSha = (Get-FileHash -LiteralPath $monitorConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-GeneratorIpEvidence $Config $Stage $monitorConfig.generatorIpEvidencePath
        Invoke-MonitorValidation $monitorConfigPath $monitorConfigSha `
            (Join-Path $attemptRoot "monitor-validate.stdout.log") `
            (Join-Path $attemptRoot "monitor-validate.stderr.log")
        $monitorChild = Start-SupervisedProcess -FilePath $script:PwshPath -Arguments @(
            "-NoLogo", "-NoProfile", "-NonInteractive", "-File", $script:MonitorPath,
            "-Mode", "Monitor", "-ConfigPath", $monitorConfigPath,
            "-ExpectedConfigSha256", $monitorConfigSha
        ) -Environment (Get-NonCredentialChildEnvironment) `
            -StdoutPath (Join-Path $attemptRoot "monitor.stdout.log") `
            -StderrPath (Join-Path $attemptRoot "monitor.stderr.log")
        $processBinding.monitor = [ordered]@{
            processId = [int]$monitorChild.ProcessId
            startedAtUtc = $monitorChild.StartedAtUtc.ToString("o")
            path = $monitorChild.ProcessPath
            exitCode = $null
        }
        $processBinding.completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        Write-AtomicJsonReplace $processBindingPath $processBinding
        $heartbeatPath = Join-Path $monitorConfig.evidenceDirectory "$($Stage.RunId)-monitor-heartbeat.json"
        Wait-ForPath $heartbeatPath ([DateTimeOffset]::UtcNow.AddMinutes(5)) $monitorChild `
            "The AWS monitor did not commit restoration-armed evidence."
        [void](Assert-MonitorRestorationArmed $heartbeatPath $Stage $monitorConfigSha $monitorChild)
        [void](Set-SixApiCapacity $Config)
        [void](Wait-ForHealthyMonitorHeartbeat $heartbeatPath $Stage $monitorChild `
            ([DateTimeOffset]::UtcNow.AddMinutes(5)))
        [void](Assert-HarnessReady $readyPath $Stage $harnessChild)
        if ((Get-FileHash -LiteralPath $Config.Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne
            $Config.Sha256 -or
            (Get-FileHash -LiteralPath $monitorConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
            $monitorConfigSha) {
            throw "A bound acceptance configuration changed before traffic release."
        }
        Write-GeneratorIpEvidence $Config $Stage $monitorConfig.generatorIpEvidencePath
        Wait-ForTrafficWindow $Config $Stage $harnessChild $monitorChild `
            $monitorConfig.generatorIpEvidencePath
        [void](Assert-MonitorHeartbeat $heartbeatPath $Stage)
        Assert-PreparedHarnessArtifacts $Config $Preparation
        [void](Get-ProductionPosture $Config -HeldCapacity)
        if ([DateTimeOffset]::UtcNow -gt $Stage.TrafficStartNotAfterUtc) {
            throw "The immutable traffic start window expired before start-gate release."
        }
        $startGatePath = [string]$environment.LOAD_SUPERVISOR_START_GATE_PATH
        Write-AtomicJson $startGatePath ([ordered]@{
            schemaVersion = 1
            type = "load_supervisor_start"
            runId = $Stage.RunId
            harnessProcessId = [int]$harnessChild.ProcessId
            monitorProcessId = [int]$monitorChild.ProcessId
            releasedAt = [DateTimeOffset]::UtcNow.ToString("o")
        })
        $startedTraffic = $true
        $deadline = $Stage.TrafficStartNotAfterUtc.AddSeconds(
            [int]$Stage.Profile.durationSeconds + 1800
        )
        $exits = Wait-ForStageProcesses $Config $Stage $harnessChild $monitorChild $deadline `
            $monitorConfig.generatorIpEvidencePath
        $processBinding.harness.exitCode = [int]$exits.HarnessExit
        $processBinding.monitor.exitCode = [int]$exits.MonitorExit
        $processBinding.completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        Write-AtomicJsonReplace $processBindingPath $processBinding
        $summaryPath = [string]$monitorConfig.loadSummaryPath
        $resultPath = Join-Path $monitorConfig.evidenceDirectory "$($Stage.RunId)-monitor-result.json"
        $monitorRestorationPath = Join-Path $monitorConfig.evidenceDirectory `
            "$($Stage.RunId)-engineering-scaling-restoration.json"
        if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $resultPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $monitorRestorationPath -PathType Leaf)) {
            throw "Terminal harness, monitor, or monitor-owned scaling-restoration evidence is missing."
        }
        $summary = Read-JsonFile $summaryPath "harness summary"
        $monitorResult = Read-JsonFile $resultPath "monitor result"
        $monitorScalingRestoration = Read-JsonFile $monitorRestorationPath `
            "monitor-owned scaling restoration"
        Assert-StageSummary $summary $Stage
        Assert-MonitorResult $monitorResult $Stage
        Assert-MonitorScalingRestoration $monitorScalingRestoration $Stage $initialPosture $Config
        if ($exits.HarnessExit -ne 0 -or $exits.MonitorExit -ne 0) {
            throw "Harness or monitor process returned a nonzero terminal exit."
        }
        $interval = Get-TrafficInterval $monitorConfig.loadProgressPath $Stage
        try {
            $zero57014 = Get-Zero57014Evidence $Config $initialPosture $interval
        }
        catch {
            if ($_.Exception.Message -match '^PostgreSQL 57014 ') {
                $sanitizedFailureCode = "postgresql_57014"
            }
            throw
        }
        Write-AtomicJson (Join-Path $attemptRoot "postgres-57014-evidence.json") $zero57014
        if ($Stage.Stage -ceq "800") {
            try {
                $maintenanceWindow = Get-Waf800MaintenanceWindowEvidence $Config $initialPosture $interval
            }
            catch {
                $sanitizedFailureCode = if ($_.Exception.Message -in @(
                    "The scheduler worker was replaced or drifted across the Waf/800 maintenance window.",
                    "The Waf/800 purge/rollup worker evidence failed its strict maintenance-window gate."
                )) {
                    "maintenance_window_application_failure"
                } else {
                    "maintenance_window_evidence_unavailable"
                }
                throw
            }
            Write-AtomicJson (Join-Path $attemptRoot "waf800-maintenance-window-evidence.json") `
                $maintenanceWindow
        }
    }
    catch {
        $failure = $_
        if (-not $sanitizedFailureCode -and $failure.Exception.Message -match (
                '^(Both production ECS services must resolve without failures\.|' +
                'The (?:api|worker) service was not uniquely resolved\.|' +
                'The (?:api|worker) service is not stable on its exact bound task definition\.|' +
                'The scheduler worker must have exactly one running task\.|' +
                'The scheduler worker execution is not the exact healthy bound task\.|' +
                'Every and only desired API target must be healthy\.|' +
                'Target health observed a prohibited state\.|' +
                'Target health did not converge to exactly \d+ healthy API targets\.)$'
            )) {
            $sanitizedFailureCode = "pretraffic_application_health"
        }
        if ($null -eq $summary) {
            $summaryPath = Join-Path $attemptRoot "load-summary.json"
            if (Test-Path -LiteralPath $summaryPath -PathType Leaf) {
                try { $summary = Read-JsonFile $summaryPath "harness summary" } catch { }
            }
        }
        if ($null -eq $monitorResult) {
            $candidateResult = Join-Path (Join-Path $attemptRoot "monitor") "$($Stage.RunId)-monitor-result.json"
            if (Test-Path -LiteralPath $candidateResult -PathType Leaf) {
                try { $monitorResult = Read-JsonFile $candidateResult "monitor result" } catch { }
            }
        }
        if ($null -ne $monitorResult) {
            try {
                $monitorRollback = Get-MonitorOwnedApplicationRollback $Config $monitorResult
                if ($null -ne $monitorRollback) {
                    $applicationRollback = $monitorRollback
                    Write-AtomicJson (Join-Path $attemptRoot "application-rollback.json") `
                        $applicationRollback
                }
            }
            catch {
                $failure = $_
                $sanitizedFailureCode = "application_rollback_failed"
            }
        }
    }
    finally {
        foreach ($child in @($harnessChild, $monitorChild)) {
            if ($null -ne $child) {
                try { Dispose-SupervisedProcess $child }
                catch {
                    if ($null -eq $terminationFailure) { $terminationFailure = $_ }
                }
            }
        }
        if ($null -ne $terminationFailure) {
            if ($null -eq $failure) { $failure = $terminationFailure }
            $sanitizedFailureCode = "stage_attempt_failed"
        }
        if ($null -ne $initialPosture) {
            try {
                $monitorRollbackMutationStarted = (
                    Get-Value $applicationRollback "source" ""
                ) -ceq "aws_monitor" -and (
                    Get-Value $applicationRollback "mutationStarted" $false
                ) -eq $true
                $restoration = Restore-Scaling $Config $initialPosture `
                    -AfterApplicationRollback:$monitorRollbackMutationStarted
                if ($monitorRollbackMutationStarted -and
                    (Get-Value $applicationRollback "completed" $false) -ne $true) {
                    $applicationRollback.completed = $true
                    $applicationRollback.exitCode = 0
                    $applicationRollback.completedAtUtc =
                        [DateTimeOffset]::UtcNow.ToString("o")
                    Write-AtomicJsonReplace (
                        Join-Path $attemptRoot "application-rollback.json"
                    ) $applicationRollback
                }
                Assert-ControllerScalingRestoration $restoration $initialPosture `
                    $applicationRollback $Config
                Write-AtomicJson (Join-Path $attemptRoot "scaling-restoration.json") $restoration
            }
            catch {
                $restorationApplicationFailure = Test-PreflightApplicationHealthFailure $_
                $restoration = [ordered]@{
                    restored = $false
                    failureCode = "scaling_restoration_failed"
                    discardedMessageSha256 = Get-StringSha256 $_.Exception.Message
                    rawErrorPersisted = $false
                }
                try { Write-AtomicJson (Join-Path $attemptRoot "scaling-restoration.json") $restoration } catch { }
                if ($null -eq $failure) {
                    $failure = $_
                }
                if ($restorationApplicationFailure) {
                    $sanitizedFailureCode = "pretraffic_application_health"
                } elseif (-not $sanitizedFailureCode) {
                    $sanitizedFailureCode = "scaling_restoration_failed"
                }
            }
        }
        if ($null -ne $interval -and $null -ne $initialPosture) {
            $piContext = Get-StandardPiContextBestEffort $Config $initialPosture $interval
            try { Write-AtomicJson (Join-Path $attemptRoot "standard-pi-context.json") $piContext } catch { }
        }
    }
    if ($null -ne $failure) {
        $pretrafficRetryEligible = (
            $AttemptNumber -eq 1 -and -not $startedTraffic -and
            $null -eq $terminationFailure -and
            $null -ne $restoration -and $restoration.restored -eq $true -and
            (Assert-NoTrafficProgress (Join-Path $attemptRoot "load-progress.jsonl") `
                (Join-Path $attemptRoot "harness-start-gate.json"))
        )
        $applicationFailure = Test-ApplicationFailure $monitorResult $summary $sanitizedFailureCode
        if (($startedTraffic -or -not $pretrafficRetryEligible) -and
            $null -ne $initialPosture -and $applicationFailure -and
            (Get-Value $applicationRollback "completed" $false) -ne $true) {
            $initialRestorationEvidence = [ordered]@{
                restored = [bool](Get-Value $restoration "restored" $false)
                failureCode = Get-Value $restoration "failureCode"
                sha256 = if ($null -eq $restoration) {
                    $null
                } else {
                    Get-CanonicalSha256 $restoration
                }
            }
            try {
                $applicationRollback = New-ApplicationRollbackIntent $Config
                Write-AtomicJson (
                    Join-Path $attemptRoot "application-rollback.json"
                ) $applicationRollback
                $applicationRollback = Invoke-ApplicationRollback $Config ([int]$initialPosture.Services.api.desired)
                $applicationRollback.mutationStarted = $true
                $applicationRollback.action = "Application"
                $applicationRollback.exitCode = 0
                $applicationRollback.rawErrorPersisted = $false
                Write-AtomicJsonReplace (
                    Join-Path $attemptRoot "application-rollback.json"
                ) $applicationRollback
            }
            catch {
                $applicationRollback = [ordered]@{
                    attempted = $true
                    completed = $false
                    mutationStarted = $true
                    action = "Application"
                    exitCode = 1
                    completedAtUtc = $null
                    failureCode = "application_rollback_failed"
                    apiTaskDefinitionSha256 =
                        Get-StringSha256 $Config.RollbackApiTaskDefinitionArn
                    workerTaskDefinitionSha256 =
                        Get-StringSha256 $Config.RollbackWorkerTaskDefinitionArn
                    discardedMessageSha256 = Get-StringSha256 $_.Exception.Message
                    rawErrorPersisted = $false
                }
                try {
                    Write-AtomicJsonReplace (
                        Join-Path $attemptRoot "application-rollback.json"
                    ) $applicationRollback
                } catch { }
            }
            try {
                $postRollbackRestoration = Restore-Scaling $Config $initialPosture -AfterApplicationRollback
                $postRollbackRestoration.initialAttempt = $initialRestorationEvidence
                if ((Get-Value $applicationRollback "mutationStarted" $false) -eq $true -and
                    (Get-Value $applicationRollback "completed" $false) -ne $true) {
                    $applicationRollback.completed = $true
                    $applicationRollback.exitCode = 0
                    $applicationRollback.completedAtUtc =
                        [DateTimeOffset]::UtcNow.ToString("o")
                    Write-AtomicJsonReplace (
                        Join-Path $attemptRoot "application-rollback.json"
                    ) $applicationRollback
                }
                Assert-ControllerScalingRestoration $postRollbackRestoration $initialPosture `
                    $applicationRollback $Config
                $restoration = $postRollbackRestoration
            }
            catch {
                $restoration = [ordered]@{
                    restored = $false
                    afterApplicationRollback = $true
                    initialAttempt = $initialRestorationEvidence
                    failureCode = "scaling_restoration_failed"
                    discardedMessageSha256 = Get-StringSha256 $_.Exception.Message
                    rawErrorPersisted = $false
                }
            }
            try {
                Write-AtomicJsonReplace (Join-Path $attemptRoot "scaling-restoration.json") $restoration
            } catch { }
        }
        return [pscustomobject]@{
            Accepted = $false
            PretrafficRetryEligible = $pretrafficRetryEligible
            Attempt = $AttemptNumber
            AttemptRoot = $attemptRoot
            FailureCode = if ($sanitizedFailureCode) { $sanitizedFailureCode } else { "stage_attempt_failed" }
            FailureSha256 = Get-StringSha256 $failure.Exception.Message
            StartedTraffic = $startedTraffic
            Restoration = $restoration
            PiContext = $piContext
            ApplicationRollback = $applicationRollback
            Zero57014 = $zero57014
            MaintenanceWindow = $maintenanceWindow
            HarnessExitCode = if ($null -eq $exits) { $null } else { $exits.HarnessExit }
            MonitorExitCode = if ($null -eq $exits) { $null } else { $exits.MonitorExit }
            SummaryPath = if (Test-Path -LiteralPath (Join-Path $attemptRoot "load-summary.json")) {
                Join-Path $attemptRoot "load-summary.json"
            } else { $null }
            MonitorResultPath = if (Test-Path -LiteralPath (
                Join-Path (Join-Path $attemptRoot "monitor") "$($Stage.RunId)-monitor-result.json"
            )) {
                Join-Path (Join-Path $attemptRoot "monitor") "$($Stage.RunId)-monitor-result.json"
            } else { $null }
        }
    }
    return [pscustomobject]@{
        Accepted = $true
        PretrafficRetryEligible = $false
        Attempt = $AttemptNumber
        AttemptRoot = $attemptRoot
        StartedTraffic = $true
        Restoration = $restoration
        PiContext = $piContext
        Zero57014 = $zero57014
        MaintenanceWindow = $maintenanceWindow
        ApplicationRollback = $applicationRollback
        SummaryPath = Join-Path $attemptRoot "load-summary.json"
        MonitorResultPath = Join-Path (Join-Path $attemptRoot "monitor") "$($Stage.RunId)-monitor-result.json"
        HarnessExitCode = $exits.HarnessExit
        MonitorExitCode = $exits.MonitorExit
    }
}

function Invoke-CapacityStage {
    param($Config, $Stage)
    $preparationNotBefore = $Stage.TrafficStartNotBeforeUtc.AddMinutes(-35)
    while ([DateTimeOffset]::UtcNow -lt $preparationNotBefore) {
        $remaining = ($preparationNotBefore - [DateTimeOffset]::UtcNow).TotalSeconds
        Start-Sleep -Seconds ([math]::Max(1, [math]::Min(30, [int][math]::Ceiling($remaining))))
    }
    if ([DateTimeOffset]::UtcNow -gt $Stage.TrafficStartNotAfterUtc) {
        throw "The stage preparation window has expired."
    }
    $stageRoot = Join-Path $Config.EvidenceRoot ("waf-{0}-{1}" -f $Stage.Stage, $Stage.RunId)
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    $preparation = Invoke-StageFixturePreparation $Config $Stage $stageRoot
    Write-AtomicJson (Join-Path $stageRoot "fixture-preparation.json") $preparation
    $attemptNotBefore = $Stage.TrafficStartNotBeforeUtc.AddMinutes(-25)
    while ([DateTimeOffset]::UtcNow -lt $attemptNotBefore) {
        $remaining = ($attemptNotBefore - [DateTimeOffset]::UtcNow).TotalSeconds
        Start-Sleep -Seconds ([math]::Max(1, [math]::Min(30, [int][math]::Ceiling($remaining))))
    }
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $result = Invoke-StageAttempt $Config $Stage $stageRoot $attempt $preparation
        if ($result.Accepted -or -not $result.PretrafficRetryEligible) {
            return $result
        }
    }
    throw "The bounded pretraffic retry loop reached an impossible state."
}

function Add-PlainStageEvidenceLines {
    param([Collections.Generic.List[string]]$Lines, $Result)
    $summaryPath = [string](Get-Value $Result "SummaryPath" "")
    if ($summaryPath -and (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
        try {
            $summary = Read-JsonFile $summaryPath "plain-report harness summary"
            $run = Get-Value $summary "run"
            $rates = Get-Value $summary "rates"
            $kinds = Get-Value $summary "kinds"
            $screenshot = Get-Value $summary "screenshotRetrieval"
            $commands = Get-Value $summary "commands"
            $websocket = Get-Value $summary "websocket"
            $tile = Get-Value $summary "tileBatch"
            $counters = Get-Value $summary "counters"
            $thresholds = Get-Value $summary "thresholds"
            $Lines.Add("Harness thresholds passed: $(Get-Value $thresholds 'passed' 'unavailable')")
            $thresholdFailures = @(
                Get-Value $thresholds "failures" @() |
                    ForEach-Object { [string]$_ } |
                    Where-Object {
                        $_.Length -ge 1 -and $_.Length -le 240 -and
                        $_ -match '^[A-Za-z0-9 {}()[\].,;:_/%+-]+$' -and
                        $_ -notmatch '(?i)(?:arn:|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|' +
                            '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
                    }
            )
            if ($thresholdFailures.Count -gt 0) {
                $Lines.Add("Harness threshold failures: $($thresholdFailures -join '; ')")
            }
            $Lines.Add("Traffic milliseconds actual/target: $(Get-Value $run 'actualTrafficMilliseconds' 'unavailable') / $(Get-Value $run 'plannedTrafficMilliseconds' 'unavailable')")
            $Lines.Add("HTTP 5xx / network error percent: $(Get-Value $rates 'http5xxPercent' 'unavailable') / $(Get-Value $rates 'networkErrorPercent' 'unavailable')")
            $Lines.Add("Screenshot success percent: $(Get-Value $screenshot 'successPercent' 'unavailable')")
            $Lines.Add("Screenshot / history p95 milliseconds: $(Get-Value (Get-Value $kinds 'screenshotGet') 'p95' 'unavailable') / $(Get-Value (Get-Value $kinds 'historyBatch') 'p95' 'unavailable')")
            $Lines.Add("WebSocket authenticated devices / reconnect p95 ms: $(Get-Value $websocket 'uniqueDevicesAuthenticated' 'unavailable') / $(Get-Value (Get-Value $websocket 'reconnectLatency') 'p95' 'unavailable')")
            $Lines.Add("Command delivery / ACK percent: $(Get-Value $commands 'deliveryPercent' 'unavailable') / $(Get-Value $commands 'completedAckPercent' 'unavailable')")
            $Lines.Add("Tile requests / logical operations: $(Get-Value $tile 'networkRequests' 'unavailable') / $(Get-Value $tile 'logicalOperations' 'unavailable')")
            $Lines.Add("Tenant isolation probes passed/attempted/failed: $(Get-Value $counters 'tenantIsolationProbePassed' 'unavailable') / $(Get-Value $counters 'tenantIsolationProbeAttempts' 'unavailable') / $(Get-Value $counters 'tenantIsolationProbeFailed' 'unavailable')")
            $sharedIp = Get-Value $summary "sharedIpModel"
            $deviceWaf = Get-Value $sharedIp "deviceIngestWafBucket"
            $apiWaf = Get-Value $sharedIp "generalApiWafBucket"
            $Lines.Add("WAF device/API rolling peak versus limit: $(Get-Value $deviceWaf 'rollingPeakRequests5m' 'unavailable')/$(Get-Value $deviceWaf 'limit' 'unavailable'); $(Get-Value $apiWaf 'rollingPeakRequests5m' 'unavailable')/$(Get-Value $apiWaf 'limit' 'unavailable')")
        }
        catch {
            $Lines.Add("Harness metrics: unavailable (authoritative artifact retained)")
        }
    } else {
        $Lines.Add("Harness metrics: unavailable")
    }
    $monitorPath = [string](Get-Value $Result "MonitorResultPath" "")
    if ($monitorPath -and (Test-Path -LiteralPath $monitorPath -PathType Leaf)) {
        try {
            $monitor = Read-JsonFile $monitorPath "plain-report monitor result"
            $acceptance = Get-Value $monitor "acceptance"
            $metrics = Get-Value $acceptance "metrics"
            $coverage = Get-Value $acceptance "engineeringRdsCpuCoverage"
            $rdsConnections = Get-Value $metrics "rds_connections"
            $rdsCredits = Get-Value $metrics "rds_cpu_credit"
            $rdsSurplus = Get-Value $metrics "rds_surplus_charged"
            $Lines.Add("AWS acceptance passed: $(Get-Value $acceptance 'passed' 'unavailable')")
            $monitorFailures = @(
                Get-Value $monitor "failures" @() |
                    ForEach-Object { [string]$_ } |
                    Where-Object { $_ -match '^[a-z0-9][a-z0-9_.:-]{0,119}$' }
            )
            if ($monitorFailures.Count -gt 0) {
                $Lines.Add("AWS failure tokens: $($monitorFailures -join ', ')")
            }
            $Lines.Add("RDS CPU minutes observed/required and maximum percent: $(Get-Value $coverage 'observedPointCount' 'unavailable') / $(Get-Value $coverage 'requiredPointCount' 'unavailable'); $(Get-Value $coverage 'maximumPercent' 'unavailable')")
            $Lines.Add("RDS connections maximum: $(Get-Value $rdsConnections 'maximum' 'unavailable')")
            $Lines.Add("RDS CPU credit minimum / surplus charged maximum: $(Get-Value $rdsCredits 'minimum' 'unavailable') / $(Get-Value $rdsSurplus 'maximum' 'unavailable')")
            foreach ($service in @("api", "worker")) {
                $cpu = Get-Value $metrics "ecs_${service}_cpu"
                $memory = Get-Value $metrics "ecs_${service}_memory"
                $Lines.Add("ECS $service CPU average/p95 and memory maximum percent: $(Get-Value $cpu 'average' 'unavailable') / $(Get-Value $cpu 'p95' 'unavailable') / $(Get-Value $memory 'maximum' 'unavailable')")
            }
            $redisCpu = Get-Value $metrics "redis_cpu"
            $redisMemory = Get-Value $metrics "redis_memory"
            $redisEvictions = Get-Value $metrics "redis_evictions"
            $redisRejected = Get-Value $metrics "redis_rejected"
            $Lines.Add("Redis CPU/memory maximum percent: $(Get-Value $redisCpu 'maximum' 'unavailable') / $(Get-Value $redisMemory 'maximum' 'unavailable')")
            $Lines.Add("Redis evictions/rejected connections: $(Get-Value $redisEvictions 'sum' 'unavailable') / $(Get-Value $redisRejected 'sum' 'unavailable')")
        }
        catch {
            $Lines.Add("AWS metrics: unavailable (authoritative artifact retained)")
        }
    } else {
        $Lines.Add("AWS metrics: unavailable")
    }
    $maintenance = Get-Value $Result "MaintenanceWindow"
    if ($null -ne $maintenance -and (Get-Value $maintenance "required" $false)) {
        $Lines.Add("Purge/rollup worker gate passed: $(Get-Value $maintenance 'passed' $false)")
        $Lines.Add("Worker heartbeats / maximum gap ms / scheduler failures / heavy-job skips: $(Get-Value $maintenance 'heartbeatCount' 'unavailable') / $(Get-Value $maintenance 'maximumHeartbeatGapMilliseconds' 'unavailable') / $(Get-Value $maintenance 'schedulerFailureCount' 'unavailable') / $(Get-Value $maintenance 'heavyJobSkipCount' 'unavailable')")
    }
}

function Write-PlainReportBestEffort {
    param($Config, [string]$Outcome, [object[]]$StageResults, [string]$FailureCode = "")
    $temporary = $null
    try {
        $parent = Split-Path -Parent $Config.ReportPath
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            Set-CurrentUserPrivateAcl $parent -Directory
        }
        Assert-CurrentUserPrivateAcl $parent "reportPath parent" -Directory
        $lines = [Collections.Generic.List[string]]::new()
        $lines.Add("SchoolPilot 800-device engineering capacity acceptance on db.t4g.medium")
        $lines.Add("")
        $lines.Add("Outcome: $Outcome")
        $lines.Add("Application SHA: $($Config.ApplicationGitSha)")
        $lines.Add("Image digest: $($Config.ImageDigest)")
        $lines.Add("RDS posture: db.t4g.medium / Database Insights Standard/7")
        $lines.Add("Certification eligible: no")
        if ($FailureCode) { $lines.Add("Failure code: $FailureCode") }
        foreach ($result in $StageResults) {
            $lines.Add("")
            $lines.Add("Waf/$($result.Stage): $(if ($result.Accepted) { 'accepted' } else { 'rejected' })")
            $lines.Add("Attempt: $($result.Attempt)")
            $lines.Add("Evidence: $($result.AttemptRoot)")
            $stageFailureCode = [string](Get-Value $result "FailureCode" "")
            if ($stageFailureCode -match '^[a-z0-9][a-z0-9_]{0,119}$') {
                $lines.Add("Stage failure code: $stageFailureCode")
            }
            $stageFailureSha = [string](Get-Value $result "FailureSha256" "")
            if ($stageFailureSha -match '^[0-9a-f]{64}$') {
                $lines.Add("Discarded stage failure SHA-256: $stageFailureSha")
            }
            if ($result.Restoration) {
                $lines.Add("Scaling restored: $($result.Restoration.restored)")
                $restorationFailure = Get-Value $result.Restoration "failureCode"
                if ($restorationFailure) {
                    $lines.Add("Scaling restoration failure: $restorationFailure")
                }
            }
            $applicationRollback = Get-Value $result "ApplicationRollback"
            if ($null -ne $applicationRollback) {
                $lines.Add("Application rollback attempted/completed: $(
                    [bool](Get-Value $applicationRollback 'attempted' $false)
                ) / $([bool](Get-Value $applicationRollback 'completed' $false))")
                $rollbackFailure = Get-Value $applicationRollback "failureCode"
                if ($rollbackFailure) {
                    $lines.Add("Application rollback failure: $rollbackFailure")
                }
                $apiRollbackHash = Get-Value $applicationRollback "apiTaskDefinitionSha256"
                $workerRollbackHash = Get-Value $applicationRollback "workerTaskDefinitionSha256"
                if ($apiRollbackHash -and $workerRollbackHash) {
                    $lines.Add("Rollback API/worker revision hashes: $apiRollbackHash / $workerRollbackHash")
                }
            }
            if ($result.Zero57014) { $lines.Add("PostgreSQL 57014 count: $($result.Zero57014.eventCount)") }
            if ($result.PiContext) {
                $lines.Add("Standard PI context collected (informational only): $($result.PiContext.collected)")
            }
            Add-PlainStageEvidenceLines $lines $result
        }
        $temporary = Join-Path $parent (
            ".{0}.{1}.tmp" -f ([IO.Path]::GetFileName($Config.ReportPath)),
            [Guid]::NewGuid().ToString("N")
        )
        [IO.File]::WriteAllLines($temporary, $lines, [Text.UTF8Encoding]::new($false))
        Set-CurrentUserPrivateAcl $temporary
        [IO.File]::Move($temporary, $Config.ReportPath, $true)
        $temporary = $null
    }
    catch {
        Write-Warning "Plain report formatting failed after authoritative evidence was retained."
    }
    finally {
        if ($temporary -and (Test-Path -LiteralPath $temporary)) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-ReadOnlyProviderFailure {
    param($Failure)
    $message = if ($Failure -is [Management.Automation.ErrorRecord]) {
        [string]$Failure.Exception.Message
    } elseif ($Failure -is [Exception]) {
        [string]$Failure.Message
    } else {
        [string]$Failure
    }
    return $message -match (
        '^(AWS CLI request failed for |AWS CLI returned malformed JSON for |' +
        'Bounded child process exceeded its timeout\.|' +
        'Unable to start bounded child process\.|' +
        'The generator public IPv4 address could not be verified\.)'
    )
}

function Test-PreflightApplicationHealthFailure {
    param($Failure)
    $message = if ($Failure -is [Management.Automation.ErrorRecord]) {
        [string]$Failure.Exception.Message
    } elseif ($Failure -is [Exception]) {
        [string]$Failure.Message
    } else {
        [string]$Failure
    }
    return $message -match (
        '^(Both production ECS services must resolve without failures\.|' +
        'The (?:api|worker) service was not uniquely resolved\.|' +
        'The (?:api|worker) service is not stable on its exact bound task definition\.|' +
        'The scheduler worker must have exactly one running task\.|' +
        'The scheduler worker execution is not the exact healthy bound task\.|' +
        'Every and only desired API target must be healthy\.|' +
        'Target health observed a prohibited state\.|' +
        'Target health did not converge to exactly \d+ healthy API targets\.)$'
    )
}

function Get-RunRecoveryBaseline {
    param($Config)
    $response = Invoke-AwsJson @(
        "ecs", "describe-services", "--region", $Config.Resources.region,
        "--cluster", $Config.Resources.cluster, "--services",
        $Config.Resources.apiService, $Config.Resources.workerService
    )
    $services = @($response.services)
    $api = @($services | Where-Object serviceName -ceq $Config.Resources.apiService)
    $worker = @($services | Where-Object serviceName -ceq $Config.Resources.workerService)
    if (@($response.failures).Count -ne 0 -or $api.Count -ne 1 -or $worker.Count -ne 1 -or
        [int]$api[0].desiredCount -lt 1 -or [int]$api[0].desiredCount -gt 8 -or
        [int]$worker[0].desiredCount -ne 1) {
        throw "The run recovery service baseline could not be uniquely bound."
    }
    $scaling = Get-ScalingSnapshot $Config
    Assert-ProductionScalingContract $scaling
    return [ordered]@{
        Services = [ordered]@{
            api = [ordered]@{
                desired = [int]$api[0].desiredCount
                running = [int]$api[0].desiredCount
            }
            worker = [ordered]@{ desired = 1; running = 1 }
        }
        WorkerExecution = [ordered]@{
            TaskArn = $null
            TaskDefinitionArn = $Config.WorkerTaskDefinitionArn
        }
        Scaling = $scaling
    }
}

function Invoke-TopLevelReadOnlyPreflight {
    param($Config, [ref]$RecoveryBaseline)
    $RecoveryBaseline.Value = Get-RunRecoveryBaseline $Config
    $validatedPosture = $null
    $result = Invoke-RunnerValidation $Config ([ref]$validatedPosture)
    if ($null -eq $validatedPosture) {
        throw "The successful runner validation did not retain its exact production posture."
    }
    $RecoveryBaseline.Value = $validatedPosture
    return $result
}

function Write-TopLevelPreflightTerminalFailure {
    param($Config, $Failure, [bool]$ProviderFailure, $RecoveryBaseline)
    if (Test-Path -LiteralPath $Config.EvidenceRoot -PathType Container) {
        Assert-CapacityRunIdentity $Config
        $unexpected = @(
            Get-ChildItem -LiteralPath $Config.EvidenceRoot -Force |
                Where-Object Name -cne "run-identity.json"
        )
        if ($unexpected.Count -ne 0) {
            throw "The consumed evidence root changed before preflight failure could be sealed."
        }
    }
    else {
        New-Item -ItemType Directory -Path $Config.EvidenceRoot | Out-Null
        Set-CurrentUserPrivateAcl $Config.EvidenceRoot -Directory
        Write-AtomicJson (Join-Path $Config.EvidenceRoot "run-identity.json") `
            (Get-CapacityRunIdentity $Config)
    }
    $stage = $Config.Stages[0]
    $stageRoot = Join-Path $Config.EvidenceRoot ("waf-{0}-{1}" -f $stage.Stage, $stage.RunId)
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    Set-CurrentUserPrivateAcl $stageRoot -Directory
    if ($null -ne $RecoveryBaseline) {
        Write-AtomicJson (Join-Path $stageRoot "initial-posture.json") `
            $RecoveryBaseline
    }
    $applicationRollback = [ordered]@{ attempted = $false; completed = $false }
    $restoration = [ordered]@{ restored = $false }
    if ($null -ne $RecoveryBaseline -and (Test-PreflightApplicationHealthFailure $Failure)) {
        try {
            $applicationRollback = New-ApplicationRollbackIntent $Config
            Write-AtomicJson (
                Join-Path $stageRoot "application-rollback.json"
            ) $applicationRollback
            $applicationRollback = Invoke-ApplicationRollback $Config (
                [int]$RecoveryBaseline.Services.api.desired
            )
            $applicationRollback.mutationStarted = $true
            $applicationRollback.action = "Application"
            $applicationRollback.exitCode = 0
            $applicationRollback.rawErrorPersisted = $false
            Write-AtomicJsonReplace (
                Join-Path $stageRoot "application-rollback.json"
            ) $applicationRollback
        }
        catch {
            $applicationRollback = [ordered]@{
                attempted = $true
                completed = $false
                mutationStarted = $true
                action = "Application"
                exitCode = 1
                completedAtUtc = $null
                failureCode = "application_rollback_failed"
                apiTaskDefinitionSha256 =
                    Get-StringSha256 $Config.RollbackApiTaskDefinitionArn
                workerTaskDefinitionSha256 =
                    Get-StringSha256 $Config.RollbackWorkerTaskDefinitionArn
                discardedMessageSha256 = Get-StringSha256 $_.Exception.Message
                rawErrorPersisted = $false
            }
            try {
                Write-AtomicJsonReplace (
                    Join-Path $stageRoot "application-rollback.json"
                ) $applicationRollback
            } catch { }
        }
        try {
            $restoration = Restore-Scaling $Config $RecoveryBaseline -AfterApplicationRollback
            if ((Get-Value $applicationRollback "mutationStarted" $false) -eq $true -and
                (Get-Value $applicationRollback "completed" $false) -ne $true) {
                $applicationRollback.completed = $true
                $applicationRollback.exitCode = 0
                $applicationRollback.completedAtUtc =
                    [DateTimeOffset]::UtcNow.ToString("o")
                Write-AtomicJsonReplace (
                    Join-Path $stageRoot "application-rollback.json"
                ) $applicationRollback
            }
        }
        catch {
            $restoration = [ordered]@{
                restored = $false
                afterApplicationRollback = $true
                failureCode = "scaling_restoration_failed"
                discardedMessageSha256 = Get-StringSha256 $_.Exception.Message
                rawErrorPersisted = $false
            }
        }
        if (-not (Test-Path -LiteralPath (
                Join-Path $stageRoot "application-rollback.json"
            ) -PathType Leaf)) {
            Write-AtomicJson (
                Join-Path $stageRoot "application-rollback.json"
            ) $applicationRollback
        }
        Write-AtomicJson (Join-Path $stageRoot "scaling-restoration.json") $restoration
    }
    $failureCode = if ($ProviderFailure) {
        "preflight_provider_unavailable"
    } elseif (Test-PreflightApplicationHealthFailure $Failure) {
        "preflight_application_health"
    } else {
        "preflight_authoritative_failure"
    }
    $failureMessage = if ($Failure -is [Management.Automation.ErrorRecord]) {
        [string]$Failure.Exception.Message
    } elseif ($Failure -is [Exception]) {
        [string]$Failure.Message
    } else {
        [string]$Failure
    }
    $result = [pscustomobject]@{
        Stage = $stage.Stage
        Accepted = $false
        Attempt = 0
        AttemptRoot = $stageRoot
        StartedTraffic = $false
        Restoration = $restoration
        Zero57014 = $null
        PiContext = $null
        MaintenanceWindow = $null
        ApplicationRollback = $applicationRollback
        HarnessExitCode = $null
        MonitorExitCode = $null
        SummaryPath = $null
        MonitorResultPath = $null
        FailureCode = $failureCode
        FailureSha256 = Get-StringSha256 $failureMessage
    }
    Write-PlainReportBestEffort $Config "REJECTED" @($result) $failureCode
    return $result
}

function Assert-BoundChildProcessExited {
    param($Binding, [string]$Name)
    if ($null -eq $Binding) { return }
    $processId = [int](Get-Value $Binding "processId" 0)
    $startedAtUtc = Get-UtcTimestamp $Binding "startedAtUtc" "$Name process binding"
    $path = [IO.Path]::GetFullPath([string](Get-Value $Binding "path" ""))
    if ($processId -le 0 -or [string]::IsNullOrWhiteSpace($path)) {
        throw "$Name process binding is malformed."
    }
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return }
    try {
        $actualStartedAtUtc = ([DateTimeOffset]$process.StartTime).ToUniversalTime()
        $actualPath = [IO.Path]::GetFullPath([string]$process.Path)
    }
    catch {
        throw "$Name process identity could not be verified during interruption recovery."
    }
    $isExact = [math]::Abs(($actualStartedAtUtc - $startedAtUtc).TotalSeconds) -le 2 -and
        [string]::Equals($actualPath, $path, [StringComparison]::OrdinalIgnoreCase)
    if ($isExact) {
        throw "The exact bound $Name process remains live; interruption recovery is not terminal."
    }
}

function Get-AttemptTrafficStarted {
    param([string]$AttemptRoot, [string]$RunId)
    if (Test-Path -LiteralPath (Join-Path $AttemptRoot "harness-start-gate.json") -PathType Leaf) {
        return $true
    }
    $progressPath = Join-Path $AttemptRoot "load-progress.jsonl"
    if (-not (Test-Path -LiteralPath $progressPath -PathType Leaf)) { return $false }
    foreach ($line in @(Get-Content -LiteralPath $progressPath)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $event = $line | ConvertFrom-Json -DateKind String -Depth 30 }
        catch { throw "Interrupted stage progress contains malformed JSON." }
        if ([string](Get-Value $event "runId" "") -cne $RunId) {
            throw "Interrupted stage progress has a mismatched run identity."
        }
        if ([string](Get-Value $event "event" "") -ceq "start") { return $true }
    }
    return $false
}

function Read-RawStageOutcome {
    param($Config, $Stage)
    $stageRoot = Join-Path $Config.EvidenceRoot ("waf-{0}-{1}" -f $Stage.Stage, $Stage.RunId)
    if (-not (Test-Path -LiteralPath $stageRoot -PathType Container)) {
        return $null
    }

    $attemptDirectories = @(
        Get-ChildItem -LiteralPath $stageRoot -Directory |
            Where-Object Name -match '^attempt-[12]$' |
            Sort-Object { [int]($_.Name -replace '^attempt-', '') }
    )
    $unexpectedAttempts = @(
        Get-ChildItem -LiteralPath $stageRoot -Directory |
            Where-Object Name -like 'attempt-*' |
            Where-Object Name -notmatch '^attempt-[12]$'
    )
    if ($unexpectedAttempts.Count -gt 0 -or $attemptDirectories.Count -gt 2) {
        throw "Interrupted stage contains an invalid attempt layout."
    }

    $attempt = 0
    $attemptRoot = $stageRoot
    $startedTraffic = $false
    $harnessExitCode = $null
    $monitorExitCode = $null
    $summaryPath = $null
    $monitorPath = $null
    $zeroPath = $null
    $maintenancePath = $null
    $summary = $null
    $monitor = $null
    $zero = $null
    $maintenance = if ($Stage.Stage -ceq "800") { $null } else {
        [pscustomobject]@{ required = $false; passed = $true }
    }
    $accepted = $false
    $piCollected = $false
    $applicationRollback = [pscustomobject]@{ attempted = $false; completed = $false }
    $restorationEvidence = $null
    $initial = $null
    $controllerRestorationValidated = $false
    $monitorRestorationValidated = $false
    $boundChildrenAbsent = $false

    if ($attemptDirectories.Count -gt 0) {
        $attemptRoot = $attemptDirectories[-1].FullName
        $attempt = [int]($attemptDirectories[-1].Name -replace '^attempt-', '')
        $startedTraffic = Get-AttemptTrafficStarted $attemptRoot $Stage.RunId
        $initialPath = Join-Path $attemptRoot "initial-posture.json"
        if (Test-Path -LiteralPath $initialPath -PathType Leaf) {
            $initial = Read-JsonFile $initialPath "raw stage initial posture"
        }
        $rollbackPath = Join-Path $attemptRoot "application-rollback.json"
        if (Test-Path -LiteralPath $rollbackPath -PathType Leaf) {
            $applicationRollback = Read-JsonFile $rollbackPath "interrupted application rollback"
        }
        $bindingPath = Join-Path $attemptRoot "process-binding.json"
        if (-not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) {
            if ((Test-Path -LiteralPath (Join-Path $attemptRoot "harness.stdout.log")) -or
                (Test-Path -LiteralPath (Join-Path $attemptRoot "monitor-config.json"))) {
                throw "Interrupted stage launched a child without its durable process binding."
            }
        }
        else {
            $binding = Read-JsonFile $bindingPath "interrupted stage process binding"
            if ([string](Get-Value $binding "stage" "") -cne $Stage.Stage -or
                [string](Get-Value $binding "runId" "") -cne $Stage.RunId -or
                [int](Get-Value $binding "attempt" -1) -ne $attempt) {
                throw "Interrupted stage process binding has drifted."
            }
            $harnessBinding = Get-Value $binding "harness"
            $monitorBinding = Get-Value $binding "monitor"
            Assert-BoundChildProcessExited $harnessBinding "harness"
            Assert-BoundChildProcessExited $monitorBinding "monitor"
            $boundChildrenAbsent = $null -ne $harnessBinding -and $null -ne $monitorBinding
            $harnessExitCode = Get-Value $harnessBinding "exitCode"
            $monitorExitCode = Get-Value $monitorBinding "exitCode"
            if ($null -ne $monitorBinding) {
                $monitorRestorationPath = Join-Path (Join-Path $attemptRoot "monitor") `
                    "$($Stage.RunId)-engineering-scaling-restoration.json"
                $recoveredControllerRestorationPath =
                    Join-Path $attemptRoot "scaling-restoration.json"
                $rollbackRecoveryCompleted = (
                    Get-Value $applicationRollback "completed" $false
                ) -eq $true -and (
                    Get-Value $applicationRollback "mutationStarted" $false
                ) -eq $true -and (
                    Test-Path -LiteralPath $recoveredControllerRestorationPath -PathType Leaf
                )
                if ($null -eq $initial -or (
                    -not (Test-Path -LiteralPath $monitorRestorationPath -PathType Leaf) -and
                    -not $rollbackRecoveryCompleted
                )) {
                    throw "Interrupted stage lacks monitor-owned scaling-restoration evidence."
                }
                if (Test-Path -LiteralPath $monitorRestorationPath -PathType Leaf) {
                    $monitorRestoration = Read-JsonFile $monitorRestorationPath `
                        "interrupted stage monitor-owned scaling restoration"
                    Assert-MonitorScalingRestoration $monitorRestoration $Stage $initial $Config
                    $monitorRestorationValidated = $true
                    $restorationEvidence = $monitorRestoration
                }
            }
        }

        $controllerRestorationPath = Join-Path $attemptRoot "scaling-restoration.json"
        if (Test-Path -LiteralPath $controllerRestorationPath -PathType Leaf) {
            $controllerRestoration = Read-JsonFile $controllerRestorationPath `
                "raw controller scaling restoration"
            if ($null -eq $initial) { throw "Raw controller restoration lacks its bound initial posture." }
            Assert-ControllerScalingRestoration $controllerRestoration $initial `
                $applicationRollback $Config
            $controllerRestorationValidated = $true
            $restorationEvidence = $controllerRestoration
        }
        elseif ($null -eq $restorationEvidence) {
            throw "Raw stage evidence lacks controller or monitor-owned scaling restoration."
        }

        $summaryPath = Join-Path $attemptRoot "load-summary.json"
        $monitorPath = Join-Path (Join-Path $attemptRoot "monitor") `
            "$($Stage.RunId)-monitor-result.json"
        $zeroPath = Join-Path $attemptRoot "postgres-57014-evidence.json"
        $maintenancePath = Join-Path $attemptRoot "waf800-maintenance-window-evidence.json"
        if (Test-Path -LiteralPath $summaryPath -PathType Leaf) {
            $summary = Read-JsonFile $summaryPath "interrupted harness summary"
        } else { $summaryPath = $null }
        if (Test-Path -LiteralPath $monitorPath -PathType Leaf) {
            $monitor = Read-JsonFile $monitorPath "interrupted monitor result"
            $monitorRollback = Get-MonitorOwnedApplicationRollback $Config $monitor
            if ($null -ne $monitorRollback -and
                (Get-Value $applicationRollback "completed" $false) -ne $true) {
                $applicationRollback = $monitorRollback
            }
        } else { $monitorPath = $null }
        if (Test-Path -LiteralPath $zeroPath -PathType Leaf) {
            $zero = Read-JsonFile $zeroPath "interrupted PostgreSQL 57014 evidence"
        } else { $zeroPath = $null }
        if ($Stage.Stage -ceq "800" -and
            (Test-Path -LiteralPath $maintenancePath -PathType Leaf)) {
            $maintenance = Read-JsonFile $maintenancePath "interrupted maintenance evidence"
        } elseif ($Stage.Stage -ceq "800") {
            $maintenancePath = $null
        }
        $piPath = Join-Path $attemptRoot "standard-pi-context.json"
        if (Test-Path -LiteralPath $piPath -PathType Leaf) {
            $piCollected = [bool](Get-Value (
                Read-JsonFile $piPath "interrupted PI context"
            ) "collected" $false)
        }
        $normalProcessTerminal = (
            $null -ne $harnessExitCode -and [int]$harnessExitCode -eq 0 -and
            $null -ne $monitorExitCode -and [int]$monitorExitCode -eq 0
        )
        $postDecisionControllerLoss = (
            $null -eq $harnessExitCode -and $null -eq $monitorExitCode -and
            $boundChildrenAbsent -and $monitorRestorationValidated
        )
        $exactRestorationAccepted = (
            ($normalProcessTerminal -and $controllerRestorationValidated) -or
            ($postDecisionControllerLoss -and -not $controllerRestorationValidated)
        )
        if ($startedTraffic -and
            $null -ne $summary -and $null -ne $monitor -and $null -ne $zero -and
            ($normalProcessTerminal -or $postDecisionControllerLoss) -and
            $exactRestorationAccepted) {
            try {
                Assert-StageSummary $summary $Stage
                Assert-MonitorResult $monitor $Stage
                if ((Get-Value $zero "passed" $false) -ne $true -or
                    [int](Get-Value $zero "eventCount" -1) -ne 0 -or
                    $null -eq $maintenance -or
                    (Get-Value $maintenance "passed" $false) -ne $true) {
                    throw "Interrupted raw stage evidence did not pass every strict gate."
                }
                $accepted = $true
            }
            catch {
                $accepted = $false
            }
        }
    }
    else {
        $preAttemptRestorationPath = Join-Path $stageRoot "scaling-restoration.json"
        if (Test-Path -LiteralPath $preAttemptRestorationPath -PathType Leaf) {
            $restorationEvidence = Read-JsonFile $preAttemptRestorationPath `
                "raw pre-attempt scaling posture"
        }
    }

    return [pscustomobject]@{
        Stage = $Stage.Stage
        Accepted = $accepted
        Attempt = $attempt
        AttemptRoot = $attemptRoot
        StartedTraffic = $startedTraffic
        Restoration = if ($null -ne $restorationEvidence) {
            $restorationEvidence
        } else {
            [pscustomobject]@{
                restored = $false
                failureCode = "restoration_evidence_unavailable"
            }
        }
        Zero57014 = $zero
        PiContext = [pscustomobject]@{ collected = $piCollected }
        MaintenanceWindow = $maintenance
        ApplicationRollback = $applicationRollback
        HarnessExitCode = $harnessExitCode
        MonitorExitCode = $monitorExitCode
        SummaryPath = $summaryPath
        MonitorResultPath = $monitorPath
        FailureCode = if ($accepted) { $null } else { "controller_interrupted" }
        FailureSha256 = if ($accepted) { $null } else {
            Get-StringSha256 (
                "controller interrupted Waf/{0} attempt {1}; trafficStarted={2}" -f
                    $Stage.Stage, $attempt, $startedTraffic
            )
        }
    }
}

function Read-RawStageOutcomeSafely {
    param($Config, $Stage)
    try {
        return Read-RawStageOutcome $Config $Stage
    }
    catch {
        # Raw evidence is authoritative only when its strict parser succeeds.
        # A malformed or incomplete artifact must still yield a decisive,
        # sanitized rejected stage for the terminal plain-text report.
        $failureMessage = [string]$_.Exception.Message
        $stageRoot = Join-Path $Config.EvidenceRoot (
            "waf-{0}-{1}" -f $Stage.Stage, $Stage.RunId
        )
        $attemptDirectories = @(
            if (Test-Path -LiteralPath $stageRoot -PathType Container) {
                Get-ChildItem -LiteralPath $stageRoot -Directory -ErrorAction SilentlyContinue |
                    Where-Object Name -match '^attempt-[12]$' |
                    Sort-Object { [int]($_.Name -replace '^attempt-', '') }
            }
        )
        $attempt = if ($attemptDirectories.Count -gt 0) {
            [int]($attemptDirectories[-1].Name -replace '^attempt-', '')
        } else { 0 }
        $attemptRoot = if ($attemptDirectories.Count -gt 0) {
            $attemptDirectories[-1].FullName
        } else { $stageRoot }
        return [pscustomobject]@{
            Stage = $Stage.Stage
            Accepted = $false
            Attempt = $attempt
            AttemptRoot = $attemptRoot
            StartedTraffic = $false
            Restoration = [pscustomobject]@{
                restored = $false
                failureCode = "raw_evidence_invalid"
            }
            Zero57014 = $null
            PiContext = [pscustomobject]@{ collected = $false }
            MaintenanceWindow = $null
            ApplicationRollback = [pscustomobject]@{
                attempted = $false
                completed = $false
            }
            HarnessExitCode = $null
            MonitorExitCode = $null
            SummaryPath = $null
            MonitorResultPath = $null
            FailureCode = "raw_evidence_invalid"
            FailureSha256 = Get-StringSha256 $failureMessage
        }
    }
}

function Repair-InterruptedApplicationRollback {
    param($Config)
    foreach ($stage in $Config.Stages) {
        $stageRoot = Join-Path $Config.EvidenceRoot (
            "waf-{0}-{1}" -f $stage.Stage, $stage.RunId
        )
        if (-not (Test-Path -LiteralPath $stageRoot -PathType Container)) { continue }
        $candidateRoots = @($stageRoot) + @(
            Get-ChildItem -LiteralPath $stageRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object Name -match '^attempt-[12]$' |
                Sort-Object { [int]($_.Name -replace '^attempt-', '') }
        )
        foreach ($candidateRootEntry in $candidateRoots) {
            $candidateRoot = if ($candidateRootEntry -is [IO.DirectoryInfo]) {
                $candidateRootEntry.FullName
            } else {
                [string]$candidateRootEntry
            }
            $applicationPath = Join-Path $candidateRoot "application-rollback.json"
            $rollback = if (Test-Path -LiteralPath $applicationPath -PathType Leaf) {
                Read-JsonFile $applicationPath "interrupted application rollback"
            } else { $null }
            if ($null -eq $rollback) {
                $monitorPath = Join-Path (Join-Path $candidateRoot "monitor") `
                    "$($stage.RunId)-monitor-result.json"
                if (Test-Path -LiteralPath $monitorPath -PathType Leaf) {
                    $monitor = Read-JsonFile $monitorPath "interrupted monitor result"
                    $rollback = Get-MonitorOwnedApplicationRollback $Config $monitor
                }
            }
            if ($null -eq $rollback -or
                (Get-Value $rollback "completed" $false) -eq $true -or
                (Get-Value $rollback "mutationStarted" $false) -ne $true) {
                continue
            }
            if ((Get-Value $rollback "attempted" $false) -ne $true -or
                [string](Get-Value $rollback "action" "") -cne "Application" -or
                [string](Get-Value $rollback "apiTaskDefinitionSha256" "") -cne
                    (Get-StringSha256 $Config.RollbackApiTaskDefinitionArn) -or
                [string](Get-Value $rollback "workerTaskDefinitionSha256" "") -cne
                    (Get-StringSha256 $Config.RollbackWorkerTaskDefinitionArn) -or
                (Get-Value $rollback "rawErrorPersisted" $true) -ne $false) {
                throw "Interrupted application rollback intent is incomplete or drifted."
            }
            $bindingPath = Join-Path $candidateRoot "process-binding.json"
            if (Test-Path -LiteralPath $bindingPath -PathType Leaf) {
                $binding = Read-JsonFile $bindingPath "interrupted process binding"
                Assert-BoundChildProcessExited (Get-Value $binding "harness") "harness"
                Assert-BoundChildProcessExited (Get-Value $binding "monitor") "monitor"
            }
            elseif ((Test-Path -LiteralPath (
                        Join-Path $candidateRoot "monitor-config.json"
                    )) -or
                (Test-Path -LiteralPath (
                        Join-Path $candidateRoot "harness.stdout.log"
                    ))) {
                throw "Interrupted rollback recovery lacks its durable process binding."
            }
            $initialPath = Join-Path $candidateRoot "initial-posture.json"
            if (-not (Test-Path -LiteralPath $initialPath -PathType Leaf)) {
                throw "Interrupted rollback recovery lacks its bound initial posture."
            }
            $initial = Read-JsonFile $initialPath "interrupted initial posture"
            $restoration = Restore-Scaling $Config $initial -AfterApplicationRollback
            $rollback.completed = $true
            $rollback.exitCode = 0
            $rollback | Add-Member -NotePropertyName "completedAtUtc" `
                -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString("o")) -Force
            if (Test-Path -LiteralPath $applicationPath -PathType Leaf) {
                Write-AtomicJsonReplace $applicationPath $rollback
            }
            else {
                Write-AtomicJson $applicationPath $rollback
            }
            Assert-ControllerScalingRestoration $restoration $initial $rollback $Config
            $restorationPath = Join-Path $candidateRoot "scaling-restoration.json"
            if (Test-Path -LiteralPath $restorationPath -PathType Leaf) {
                Write-AtomicJsonReplace $restorationPath $restoration
            }
            else {
                Write-AtomicJson $restorationPath $restoration
            }
        }
    }
}

function Read-RawCapacityOutcome {
    param($Config)
    $results = [Collections.Generic.List[object]]::new()
    $failureCode = "controller_interrupted"
    foreach ($stage in $Config.Stages) {
        $result = Read-RawStageOutcomeSafely $Config $stage
        if ($null -eq $result) { break }
        $results.Add($result)
        if (-not $result.Accepted) {
            $failureCode = if ($result.FailureCode) {
                $result.FailureCode
            } else {
                "raw_stage_rejected"
            }
            break
        }
    }
    $accepted = $results.Count -eq $Config.Stages.Count -and
        @($results | Where-Object { -not $_.Accepted }).Count -eq 0
    return [pscustomobject]@{
        Accepted = $accepted
        StageResults = @($results)
        FailureCode = if ($accepted) { "" } else { $failureCode }
    }
}

function Invoke-CapacityRun {
    param($Config, $CampaignAdmission)
    $isNewCampaignAdmission = $null -ne $CampaignAdmission -and
        -not [bool](Get-Value $CampaignAdmission "Existing" $true)
    if ((Test-Path -LiteralPath $Config.EvidenceRoot) -and -not $isNewCampaignAdmission) {
        Assert-CapacityRunIdentity $Config
        Repair-InterruptedApplicationRollback $Config
        $raw = Read-RawCapacityOutcome $Config
        $rawOutcome = if ($raw.Accepted) { "ACCEPTED" } else { "REJECTED" }
        Write-PlainReportBestEffort $Config $rawOutcome @($raw.StageResults) $raw.FailureCode
        if (-not $raw.Accepted) {
            throw "The evidence root is consumed and its raw outcome is not accepted; workload rerun is prohibited."
        }
        return [ordered]@{
            accepted = $true
            engineeringAcceptance = $true
            certificationEligible = $false
            reportReformattedFromRawEvidence = $true
            stages = @($raw.StageResults | ForEach-Object {
                [ordered]@{ stage=$_.Stage; accepted=$true; attempt=$_.Attempt; evidencePath=$_.AttemptRoot }
            })
        }
    }
    $recoveryBaseline = $null
    for ($preflightAttempt = 1; $preflightAttempt -le 2; $preflightAttempt++) {
        try {
            [void](Invoke-TopLevelReadOnlyPreflight $Config ([ref]$recoveryBaseline))
            break
        }
        catch {
            $providerFailure = Test-ReadOnlyProviderFailure $_
            if ($preflightAttempt -eq 1 -and $providerFailure) {
                Start-Sleep -Seconds 1
                continue
            }
            [void](Write-TopLevelPreflightTerminalFailure $Config $_ $providerFailure $recoveryBaseline)
            throw "Capacity acceptance preflight was rejected; the one-shot evidence root is consumed."
        }
    }
    # Invoke-TopLevelReadOnlyPreflight retained the exact full posture that
    # passed the bounded validation. Do not perform an unbounded second live
    # read between successful preflight and consumption of the evidence root.
    if ($null -eq $recoveryBaseline) {
        throw "Capacity acceptance preflight did not retain its recovery posture."
    }
    if ($isNewCampaignAdmission) {
        Assert-CapacityRunIdentity $Config
    }
    else {
        New-Item -ItemType Directory -Path $Config.EvidenceRoot | Out-Null
        Set-CurrentUserPrivateAcl $Config.EvidenceRoot -Directory
        Write-AtomicJson (Join-Path $Config.EvidenceRoot "run-identity.json") `
            (Get-CapacityRunIdentity $Config)
    }
    $stageResults = [Collections.Generic.List[object]]::new()
    foreach ($stage in $Config.Stages) {
        try {
            $result = Invoke-CapacityStage $Config $stage
        }
        catch {
            $stageFailure = $_
            $stageRoot = Join-Path $Config.EvidenceRoot ("waf-{0}-{1}" -f $stage.Stage, $stage.RunId)
            New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
            $attempts = @(Get-ChildItem -LiteralPath $stageRoot -Directory -Filter "attempt-*")
            if ($attempts.Count -gt 0) {
                $result = Read-RawStageOutcomeSafely $Config $stage
                if ($null -eq $result) {
                    throw "A started stage could not be reconstructed from its raw evidence."
                }
            }
            else {
                $postFailurePosture = Get-ProductionPosture $Config
                if ((Get-StableProductionPostureSha256 $postFailurePosture) -cne
                    (Get-StableProductionPostureSha256 $recoveryBaseline)) {
                    throw "A pre-attempt stage failure did not preserve the exact healthy production posture."
                }
                $orchestrationRestoration = [ordered]@{
                    restored = $true
                    noScalingMutationObserved = $true
                    restoredAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
                    posture = $postFailurePosture
                }
                Write-AtomicJson (Join-Path $stageRoot "scaling-restoration.json") `
                    $orchestrationRestoration
                $result = [pscustomobject]@{
                    Accepted=$false;Attempt=0;AttemptRoot=$stageRoot;StartedTraffic=$false
                    Restoration=$orchestrationRestoration;Zero57014=$null;PiContext=$null
                    MaintenanceWindow=$null
                    ApplicationRollback=[pscustomobject]@{attempted=$false;completed=$false}
                    FailureCode="stage_orchestration_failed"
                    FailureSha256=Get-StringSha256 $stageFailure.Exception.Message
                }
            }
        }
        $result | Add-Member -NotePropertyName Stage -NotePropertyValue $stage.Stage
        $stageResults.Add($result)
        if (-not $result.Accepted) {
            Write-PlainReportBestEffort $Config "REJECTED" @($stageResults) $result.FailureCode
            throw "Waf/$($stage.Stage) was rejected; later stages are blocked."
        }
    }
    Write-PlainReportBestEffort $Config "ACCEPTED" @($stageResults)
    return [ordered]@{
        accepted = $true
        engineeringAcceptance = $true
        certificationEligible = $false
        applicationGitSha = $Config.ApplicationGitSha
        imageDigest = $Config.ImageDigest
        rdsInstanceClass = "db.t4g.medium"
        stages = @($stageResults | ForEach-Object {
            [ordered]@{
                stage = $_.Stage
                accepted = $_.Accepted
                attempt = $_.Attempt
                evidencePath = $_.AttemptRoot
            }
        })
    }
}

function Invoke-CapacityRunUnderMutex {
    param($Config)
    $runMutex = [Threading.Mutex]::new($false, (Get-CapacityRunMutexName $Config))
    $runMutexAcquired = $false
    try {
        try { $runMutexAcquired = $runMutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $runMutexAcquired = $true }
        if (-not $runMutexAcquired) {
            throw "Another production capacity-acceptance controller is already active."
        }
        # The OS mutex protects live controllers. This persistent, ACL-private
        # admission survives controller death and is intentionally never
        # cleared, so an abandoned mutex cannot admit another immutable run.
        $campaignAdmission = Enter-CapacityCampaignAdmission $Config
        try {
            return Invoke-CapacityRun $Config $campaignAdmission
        }
        catch {
            if (-not (Test-Path -LiteralPath $Config.ReportPath -PathType Leaf)) {
                try {
                    Write-PlainReportBestEffort $Config "REJECTED" @() `
                        "capacity_acceptance_failed"
                } catch { }
            }
            throw
        }
    }
    finally {
        if ($runMutexAcquired) { $runMutex.ReleaseMutex() }
        $runMutex.Dispose()
    }
}

Initialize-ToolPaths
$configuration = Read-CapacityConfiguration
if ($Mode -ceq "Validate") {
    Invoke-RunnerValidation $configuration | ConvertTo-Json -Depth 10
    exit 0
}
Invoke-CapacityRunUnderMutex $configuration | ConvertTo-Json -Depth 10
