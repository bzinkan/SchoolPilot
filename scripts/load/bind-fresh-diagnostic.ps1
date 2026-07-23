#requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ExpectedManifestSha256,

    [Parameter(Mandatory = $true)]
    [string]$FixturePreparationReceiptPath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ExpectedFixturePreparationReceiptSha256,

    [Parameter(Mandatory = $true)]
    [string]$SupervisorTicketPath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ExpectedSupervisorTicketSha256,

    [Parameter(Mandatory = $true)]
    [string]$SupervisorResultPath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ExpectedSupervisorResultSha256,

    [string]$DatabaseInsightsLeaseReceiptPath,

    [string]$ExpectedDatabaseInsightsLeaseReceiptSha256,

    [string]$ExpectedGeneratorPublicIp,

    [ValidateSet('', 'after_config_write', 'after_hash_write', 'after_receipt_write', 'before_rename')]
    [string]$TestFaultStage = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:ManifestVersion = 'waf800-diagnostic-prep-manifest-v1'
$script:ReceiptVersion = 'fixture-preparation-receipt-v1'
$script:JournalVersion = 'diagnostic-prep-journal-v1'
$script:SupervisorTicketVersion = 'diagnostic-prep-supervisor-ticket-v2'
$script:SupervisorResultVersion = 'diagnostic-prep-supervisor-v1'
$script:SupervisorRunLockVersion = 'diagnostic-prep-supervisor-run-lock-v1'
$script:RecoveryAdmissionVersion = 'diagnostic-prep-publication-recovery-admission-v1'
$script:RecoveryReceiptVersion = 'fixture-publication-recovery-v1'
$script:RequiredSnapshotNames = @(
    'fixture-state.private.json',
    'load-auth.private.json',
    'load-command-bodies.private.json',
    'load-devices.private.json',
    'verification.private.json'
)

function Get-BindingValue {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    if ($Object -is [Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Get-BindingRequiredValue {
    param($Object, [string]$Name)
    $value = Get-BindingValue $Object $Name
    if ($null -eq $value -or ($value -is [string] -and [string]::IsNullOrWhiteSpace([string]$value))) {
        throw "Diagnostic binding requires '$Name'."
    }
    return $value
}

function Assert-BindingSha256 {
    param([string]$Value, [string]$Name, [switch]$ImageDigest)
    $normalized = $Value.Trim().ToLowerInvariant()
    $pattern = if ($ImageDigest) { '^sha256:[0-9a-f]{64}$' } else { '^[0-9a-f]{64}$' }
    if ($normalized -notmatch $pattern) { throw "$Name must be an exact lowercase SHA-256 value." }
    return $normalized
}

function Get-BindingTextSha256 {
    param([string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.UTF8Encoding]::new($false).GetBytes($Text)
    )).ToLowerInvariant()
}

function Get-BindingFileSha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required file is missing." }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-BindingCanonicalSha256 {
    param($Value)
    return Get-BindingTextSha256 (ConvertTo-Json -InputObject $Value -Depth 60 -Compress)
}

function Resolve-BindingExternalPath {
    param([string]$Path, [string]$Name, [switch]$AllowMissing, [switch]$Directory)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path) -or
        $Path.StartsWith('\\?\') -or $Path.StartsWith('\\.\')) {
        throw "$Name must be an ordinary absolute external path."
    }
    $absolute = [IO.Path]::GetFullPath($Path)
    $repo = $script:RepositoryRoot.TrimEnd('\', '/')
    if ($absolute -eq $repo -or $absolute.StartsWith($repo + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name must remain outside the repository."
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
    if (-not $AllowMissing) {
        $pathType = if ($Directory) { 'Container' } else { 'Leaf' }
        if (-not (Test-Path -LiteralPath $absolute -PathType $pathType)) { throw "$Name does not exist." }
    }
    return $absolute
}

function Test-BindingPathsOverlap {
    param([string]$Left, [string]$Right)
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else {
        [StringComparison]::Ordinal
    }
    $leftPath = [IO.Path]::GetFullPath($Left).TrimEnd('\','/')
    $rightPath = [IO.Path]::GetFullPath($Right).TrimEnd('\','/')
    $separator = [IO.Path]::DirectorySeparatorChar
    return [string]::Equals($leftPath, $rightPath, $comparison) -or
        $leftPath.StartsWith($rightPath + $separator, $comparison) -or
        $rightPath.StartsWith($leftPath + $separator, $comparison)
}

function Assert-BindingPrivateFileAcl {
    param([string]$Path, [string]$Name)
    if (-not $IsWindows) { throw "$Name requires Windows ACL enforcement." }
    $absolute = Resolve-BindingExternalPath $Path $Name
    $acl = Get-Acl -LiteralPath $absolute
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    try { $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value }
    catch { throw "$Name owner cannot be resolved to the current operator." }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($null -eq $acl.Owner -or $ownerSid -cne $currentSid -or
        -not $acl.AreAccessRulesProtected -or $rules.Count -ne 1) {
        throw "$Name must be readable only by the current operator."
    }
    $rule = $rules[0]
    if ($rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.IdentityReference.Value -cne $currentSid -or
        (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
            [Security.AccessControl.FileSystemRights]::FullControl) -or
        $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw "$Name must have one exact current-operator FullControl rule."
    }
}

function Assert-BindingPrivateDirectoryAcl {
    param([string]$Path, [string]$Name)
    if (-not $IsWindows) { throw "$Name requires Windows ACL enforcement." }
    $absolute = Resolve-BindingExternalPath $Path $Name -Directory
    $acl = Get-Acl -LiteralPath $absolute
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    try { $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value }
    catch { throw "$Name owner cannot be resolved to the current operator." }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    if ($null -eq $acl.Owner -or $ownerSid -cne $currentSid -or
        -not $acl.AreAccessRulesProtected -or $rules.Count -ne 1) {
        throw "$Name must be accessible only by the current operator."
    }
    $rule = $rules[0]
    if ($rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.IdentityReference.Value -cne $currentSid -or
        (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
            [Security.AccessControl.FileSystemRights]::FullControl) -or
        $rule.InheritanceFlags -ne $expectedInheritance -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw "$Name must have one exact inheritable current-operator FullControl rule."
    }
}

function Set-BindingPrivateAcl {
    param([string]$Path, [switch]$Directory)
    if (-not $IsWindows) { throw 'Binding publication requires Windows ACL enforcement.' }
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = if ($Directory) {
        [Security.AccessControl.DirectorySecurity]::new()
    } else {
        [Security.AccessControl.FileSecurity]::new()
    }
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($current)
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else { [Security.AccessControl.InheritanceFlags]::None }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $current, [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance, [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $security
}

function Assert-BindingStrictChildPath {
    param([string]$Child, [string]$Parent, [string]$Name)
    $childFull = [IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $comparison = if ($IsWindows) {
        [StringComparison]::OrdinalIgnoreCase
    } else { [StringComparison]::Ordinal }
    if ([string]::Equals($childFull, $parentFull, $comparison) -or
        -not $childFull.StartsWith(
            $parentFull + [IO.Path]::DirectorySeparatorChar,
            $comparison
        )) {
        throw "$Name must remain a strict child of its bound parent."
    }
}

function Get-BindingStagingCandidates {
    param([string]$Parent, [string]$BindingRoot)
    $bindingName = [IO.Path]::GetFileName([IO.Path]::GetFullPath($BindingRoot))
    $prefix = ".$bindingName."
    return @(Get-ChildItem -LiteralPath $Parent -Force -ErrorAction Stop | Where-Object {
        $_.Name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        $_.Name.EndsWith('.staging', [StringComparison]::OrdinalIgnoreCase)
    })
}

function Assert-NoBindingStagingResidue {
    param([string]$Parent, [string]$BindingRoot)
    Assert-BindingPrivateDirectoryAcl $Parent 'Diagnostic binding parent'
    if (@(Get-BindingStagingCandidates -Parent $Parent -BindingRoot $BindingRoot).Count -ne 0) {
        throw 'An abandoned or ambiguous diagnostic binding staging artifact exists.'
    }
}

function Assert-BindingStagingTreeSafe {
    param([string]$Path, [string]$ExpectedParent)
    Assert-BindingStrictChildPath -Child $Path -Parent $ExpectedParent -Name 'Diagnostic binding staging root'
    Assert-BindingPrivateDirectoryAcl $ExpectedParent 'Diagnostic binding parent'
    Assert-BindingPrivateDirectoryAcl $Path 'Diagnostic binding staging root'
    $stagingItem = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $stagingItem.PSIsContainer -or
        ($stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath($stagingItem.FullName),
            [IO.Path]::GetFullPath($Path),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath($stagingItem.Parent.FullName),
            [IO.Path]::GetFullPath($ExpectedParent),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Diagnostic binding staging identity changed.'
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Diagnostic binding staging must not contain a reparse point.'
        }
        if ($item.PSIsContainer) {
            Assert-BindingPrivateDirectoryAcl $item.FullName 'Diagnostic binding staging child'
        } else {
            Assert-BindingPrivateFileAcl $item.FullName 'Diagnostic binding staging child'
        }
    }
    return $stagingItem
}

function Remove-BindingStagingSafely {
    param([string]$Path, [string]$ExpectedParent)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $stagingItem = Assert-BindingStagingTreeSafe -Path $Path -ExpectedParent $ExpectedParent
    [IO.Directory]::Delete($stagingItem.FullName, $true)
}

function Assert-BindingPublicationPreconditions {
    param([string]$Parent, [string]$Staging, [string]$BindingRoot)
    $parentResolved = Resolve-BindingExternalPath $Parent 'Diagnostic binding parent' -Directory
    Assert-BindingPrivateDirectoryAcl $parentResolved 'Diagnostic binding parent'
    if (-not [string]::Equals(
            $parentResolved,
            [IO.Path]::GetFullPath($Parent),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Diagnostic binding parent identity changed.'
    }
    [void](Assert-BindingStagingTreeSafe -Path $Staging -ExpectedParent $parentResolved)
    $candidates = @(Get-BindingStagingCandidates -Parent $parentResolved -BindingRoot $BindingRoot)
    if ($candidates.Count -ne 1 -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath($candidates[0].FullName),
            [IO.Path]::GetFullPath($Staging),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Diagnostic binding staging is ambiguous immediately before publication.'
    }
    $resolvedDestination = Resolve-BindingExternalPath $BindingRoot `
        'Fresh diagnostic binding root' -AllowMissing -Directory
    if (-not [string]::Equals(
            $resolvedDestination,
            [IO.Path]::GetFullPath($BindingRoot),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        (Test-Path -LiteralPath $resolvedDestination)) {
        throw 'Fresh diagnostic binding destination appeared before publication.'
    }
}

function Assert-BindingRevalidationSet {
    param([object[]]$Files)
    foreach ($file in $Files) {
        $path = [IO.Path]::GetFullPath([string]$file.path)
        $name = [string]$file.name
        $expectedSha256 = Assert-BindingSha256 ([string]$file.sha256) "$name sha256"
        $isPrivate = [bool]$file.private
        $resolved = if ($isPrivate) {
            Resolve-BindingExternalPath $path $name
        } else {
            $repositoryPrefix = $script:RepositoryRoot.TrimEnd('\', '/') +
                [IO.Path]::DirectorySeparatorChar
            if (-not $path.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase) -or
                -not (Test-Path -LiteralPath $path -PathType Leaf)) {
                throw "$name must remain an existing repository file."
            }
            $cursor = $path
            while ($cursor) {
                $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "$name must not traverse a symbolic link, junction, or reparse point."
                }
                if ([string]::Equals(
                        [IO.Path]::GetFullPath($cursor),
                        $script:RepositoryRoot,
                        [StringComparison]::OrdinalIgnoreCase
                    )) {
                    break
                }
                $parent = [IO.Directory]::GetParent($cursor)
                if ($null -eq $parent) { throw "$name escaped the repository during revalidation." }
                $cursor = $parent.FullName
            }
            $path
        }
        if (-not [string]::Equals(
                $resolved,
                $path,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            throw "$name path identity changed before publication."
        }
        if ($isPrivate) {
            Assert-BindingPrivateFileAcl $resolved $name
        }
        if ((Get-BindingFileSha256 $resolved) -cne $expectedSha256) {
            throw "$name changed before atomic binding publication."
        }
    }
}

function Write-BindingDurableUtf8 {
    param([string]$Path, [string]$Text)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    $stream = [IO.FileStream]::new(
        $Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None,
        4096, [IO.FileOptions]::WriteThrough
    )
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    Set-BindingPrivateAcl -Path $Path
}

function Read-BindingJson {
    param([string]$Path, [string]$Name, [int]$Depth = 60)
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -DateKind String -Depth $Depth }
    catch { throw "$Name must contain valid JSON." }
}

function Get-BindingJournalRecordHash {
    param($Record)
    $canonical = [ordered]@{}
    foreach ($name in @(
        'schemaVersion', 'type', 'version', 'sequence', 'runId', 'manifestSha256',
        'timestampUtc', 'stage', 'status', 'process', 'exitCode', 'artifactHashes',
        'previousRecordHash', 'failureCode', 'failureStage'
    )) { $canonical[$name] = Get-BindingValue $Record $name $null }
    return Get-BindingCanonicalSha256 $canonical
}

function Get-BindingSnapshotArtifactSetSha256 {
    param($Artifacts)
    $json = @($Artifacts | Sort-Object { [string]$_.name }) |
        ConvertTo-Json -Depth 20 -Compress -AsArray
    return Get-BindingTextSha256 $json
}

function Assert-BindingExactKeys {
    param($Value, [string[]]$Required, [string[]]$Optional = @(), [string]$Name)
    $actual = if ($Value -is [Collections.IDictionary]) {
        @($Value.Keys | ForEach-Object { [string]$_ })
    } else { @($Value.PSObject.Properties.Name) }
    $allowed = @($Required + $Optional)
    if (@(Compare-Object ($Required | Sort-Object -Unique) `
            (@($actual | Where-Object { $_ -in $Required }) | Sort-Object -Unique)).Count -ne 0 -or
        @($actual | Where-Object { $_ -notin $allowed }).Count -ne 0 -or
        @($actual | Group-Object | Where-Object Count -ne 1).Count -ne 0) {
        throw "$Name has missing, duplicate, or unexpected fields."
    }
}

function Assert-BindingJournalTimestampSequence {
    param([object[]]$Records)
    $previousTimestamp = $null
    foreach ($record in $Records) {
        $timestampText = [string](Get-BindingRequiredValue $record 'timestampUtc')
        $parsedTimestamp = [DateTimeOffset]::MinValue
        if ($timestampText -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}\+00:00$' -or
            -not [DateTimeOffset]::TryParseExact(
                $timestampText,
                'o',
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None,
                [ref]$parsedTimestamp
            ) -or
            $parsedTimestamp.Offset -ne [TimeSpan]::Zero) {
            throw 'Fixture preparation journal timestamp must be an exact +00:00 UTC string.'
        }
        if ($null -ne $previousTimestamp -and $parsedTimestamp -lt $previousTimestamp) {
            throw 'Fixture preparation journal timestamps must be non-regressing.'
        }
        $previousTimestamp = $parsedTimestamp
    }
}

function Assert-BindingResultRecoveryProvenance {
    param(
        [string]$ResultKind,
        $SupervisorResult,
        [string]$ManifestRecoveryReceiptPath
    )
    if ($ResultKind -cne 'initial') { return }
    foreach ($recoveryField in @(
            'recoveryAdmission','publicationRecoveryReceipt','recovery','originalExecution'
        )) {
        if ($null -ne (Get-BindingValue $SupervisorResult $recoveryField $null)) {
            throw 'Initial fixture preparation result must not contain recovery provenance.'
        }
    }
    if (Test-Path -LiteralPath $ManifestRecoveryReceiptPath) {
        throw 'Initial fixture preparation result is ineligible while a publication-recovery receipt exists.'
    }
}

function Assert-BindingFixturePreparationReceiptShape {
    param($Receipt)
    Assert-BindingExactKeys $Receipt @(
        'schemaVersion','type','version','status','runId','diagnosticOnly',
        'diagnosticEligible','certificationEligible','sealedAtUtc','manifest','release',
        'controllerArtifacts','supervisorAdmission','fixture','execution','freshness',
        'verification','credentials','snapshot','recovery','journal','secretsPrinted',
        'trafficStarted','leaseAcquired'
    ) @() 'Fixture preparation receipt'
    Assert-BindingExactKeys (Get-BindingRequiredValue $Receipt 'manifest') @(
        'path','sha256'
    ) @() 'Fixture preparation receipt manifest'
    Assert-BindingExactKeys (Get-BindingRequiredValue $Receipt 'release') @(
        'applicationGitSha','controllerGitSha','deployedImageDigest',
        'apiTaskDefinitionArn','workerTaskDefinitionArn'
    ) @() 'Fixture preparation receipt release'
    foreach ($artifact in @((Get-BindingRequiredValue $Receipt 'controllerArtifacts'))) {
        Assert-BindingExactKeys $artifact @('kind','path','sha256') @() `
            'Fixture preparation receipt controller artifact'
    }
    $supervisorAdmission = Get-BindingRequiredValue $Receipt 'supervisorAdmission'
    Assert-BindingExactKeys $supervisorAdmission @(
        'type','version','sha256','nonceSha256','supervisor',
        'supervisorLockPathSha256','originalTicketSha256','workerOwnership'
    ) @() 'Fixture preparation receipt supervisor admission'
    Assert-BindingExactKeys (Get-BindingRequiredValue $supervisorAdmission 'supervisor') @(
        'pid','startedAtUtc','path'
    ) @() 'Fixture preparation receipt supervisor identity'
    $receiptWorkerOwnership = Get-BindingRequiredValue $supervisorAdmission 'workerOwnership'
    Assert-BindingExactKeys $receiptWorkerOwnership @(
        'path','sha256','version','jobPolicy','descendantPolicy'
    ) @() 'Fixture preparation receipt worker ownership'
    if ([string](Get-BindingValue $receiptWorkerOwnership 'version' '') -cne
            'diagnostic-prep-worker-job-v1' -or
        [string](Get-BindingValue $receiptWorkerOwnership 'jobPolicy' '') -cne
            'kill-on-supervisor-close-v1' -or
        [string](Get-BindingValue $receiptWorkerOwnership 'descendantPolicy' '') -cne
            'no-breakaway-v1') {
        throw 'Fixture preparation receipt worker ownership policy is invalid.'
    }
    $fixture = Get-BindingRequiredValue $Receipt 'fixture'
    Assert-BindingExactKeys $fixture @(
        'fixtureId','provider','sourceRoot','fixtureCli','config'
    ) @() 'Fixture preparation receipt fixture'
    foreach ($referenceName in @('fixtureCli','config')) {
        Assert-BindingExactKeys (Get-BindingRequiredValue $fixture $referenceName) @(
            'path','sha256'
        ) @() "Fixture preparation receipt $referenceName"
    }
    $execution = Get-BindingRequiredValue $Receipt 'execution'
    Assert-BindingExactKeys $execution @(
        'runStartedAtUtc','runDirectory','refreshCompletedAtUtc','verificationCompletedAtUtc',
        'refreshExitCode','verificationExitCode','refreshStdoutSha256','refreshStderrSha256',
        'verifyStdoutSha256','verifyStderrSha256','workerProcess'
    ) @() 'Fixture preparation receipt execution'
    Assert-BindingExactKeys (Get-BindingRequiredValue $execution 'workerProcess') @(
        'pid','startedAtUtc','path','kind'
    ) @() 'Fixture preparation receipt worker process'
    Assert-BindingExactKeys (Get-BindingRequiredValue $Receipt 'freshness') @(
        'refreshedAtUtc','verifiedAtUtc','checkedAtUtc',
        'requiredVerificationMaximumAgeMinutes','requiredArtifactValiditySeconds',
        'expiresAtUtc','deviceManifestExpiresAtUtc'
    ) @() 'Fixture preparation receipt freshness'
    $verification = Get-BindingRequiredValue $Receipt 'verification'
    Assert-BindingExactKeys $verification @(
        'artifactSha256','counts','gates','countsAndGatesSha256'
    ) @() 'Fixture preparation receipt verification'
    $counts = Get-BindingRequiredValue $verification 'counts'
    Assert-BindingExactKeys $counts @(
        'schools','teachers','officeStaff','students','classes','classRosterStudents',
        'devices','activeDeviceSessions','activeSessions','commandBodies',
        'authorizationPlanCohorts','liveAuth'
    ) @() 'Fixture preparation receipt verification counts'
    Assert-BindingExactKeys (Get-BindingRequiredValue $counts 'authorizationPlanCohorts') @(
        'coTeacherStudents','officeSupervisionStudents'
    ) @() 'Fixture preparation receipt authorization-plan counts'
    Assert-BindingExactKeys (Get-BindingRequiredValue $counts 'liveAuth') @(
        'commandAdministrators','teachers'
    ) @() 'Fixture preparation receipt live-authorization counts'
    Assert-BindingExactKeys (Get-BindingRequiredValue $verification 'gates') @(
        'autoEnrollDisabled','trackingDisabled','schedulesDisabled','exactSchoolTimezones',
        'classRostersExactAndDisjoint','authorizationPlanCohortsExact',
        'authorizationPlanOfficeStudentsOutsideTeacherRosters','allDeviceTokensLive',
        'allStaffAuthArtifactsLive'
    ) @() 'Fixture preparation receipt verification gates'
    Assert-BindingExactKeys (Get-BindingRequiredValue $Receipt 'credentials') @(
        'expiresAtUtc','deviceManifestExpiresAtUtc','requiredValiditySeconds'
    ) @() 'Fixture preparation receipt credentials'
    $snapshot = Get-BindingRequiredValue $Receipt 'snapshot'
    Assert-BindingExactKeys $snapshot @(
        'root','contract','artifactSetSha256','artifacts'
    ) @() 'Fixture preparation receipt snapshot'
    foreach ($artifact in @((Get-BindingRequiredValue $snapshot 'artifacts'))) {
        Assert-BindingExactKeys $artifact @(
            'name','sourcePath','targetPath','sha256','size','lastWriteTimeUtc'
        ) @() 'Fixture preparation receipt snapshot artifact'
    }
    Assert-BindingExactKeys (Get-BindingRequiredValue $Receipt 'recovery') @(
        'allowedAttempts','nonce'
    ) @() 'Fixture preparation receipt recovery'
    Assert-BindingExactKeys (Get-BindingRequiredValue $Receipt 'journal') @(
        'path','sourceSealedRecordHash'
    ) @() 'Fixture preparation receipt journal'
}

function Test-BindingBoundProcessPresent {
    param($Identity, [string]$Name)
    if ($null -eq $Identity) { throw "$Name process identity is missing." }
    $pidValue = [int](Get-BindingRequiredValue $Identity 'pid')
    if ($pidValue -le 0) { throw "$Name process PID is malformed." }
    try { $process = [Diagnostics.Process]::GetProcessById($pidValue) }
    catch [ArgumentException] { return $false }
    catch { throw "$Name process could not be inspected safely." }
    try {
        $started = ([DateTimeOffset]$process.StartTime).ToUniversalTime().ToString('o')
        $path = [IO.Path]::GetFullPath($process.Path)
        $expectedStarted = [string](Get-BindingRequiredValue $Identity 'startedAtUtc')
        $expectedPath = [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $Identity 'path'))
        return $started -ceq $expectedStarted -and
            [string]::Equals($path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { throw "$Name process identity could not be inspected safely." }
    finally { $process.Dispose() }
}

function Test-BindingProcessObservationEqual {
    param($Left, $Right)
    if ($null -eq $Left -or $null -eq $Right) { return $false }
    return [int](Get-BindingValue $Left 'pid' 0) -eq [int](Get-BindingValue $Right 'pid' 0) -and
        [string](Get-BindingValue $Left 'startedAtUtc' '') -ceq
            [string](Get-BindingValue $Right 'startedAtUtc' '') -and
        [string]::Equals(
            [string](Get-BindingValue $Left 'path' ''),
            [string](Get-BindingValue $Right 'path' ''),
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        [string](Get-BindingValue $Left 'completedAtUtc' '') -ceq
            [string](Get-BindingValue $Right 'completedAtUtc' '') -and
        (Get-BindingValue $Left 'exitCode' $null) -eq (Get-BindingValue $Right 'exitCode' $null) -and
        [bool](Get-BindingValue $Left 'timedOut' $false) -eq
            [bool](Get-BindingValue $Right 'timedOut' $false) -and
        [bool](Get-BindingValue $Left 'exitPersistedBeforeResultParsing' $false) -eq
            [bool](Get-BindingValue $Right 'exitPersistedBeforeResultParsing' $false)
}

function Test-BindingProcessIdentityEqual {
    param($Left, $Right)
    if ($null -eq $Left -or $null -eq $Right) { return $false }
    return [int](Get-BindingValue $Left 'pid' 0) -eq [int](Get-BindingValue $Right 'pid' 0) -and
        [string](Get-BindingValue $Left 'startedAtUtc' '') -ceq
            [string](Get-BindingValue $Right 'startedAtUtc' '') -and
        [string]::Equals(
            [string](Get-BindingValue $Left 'path' ''),
            [string](Get-BindingValue $Right 'path' ''),
            [StringComparison]::OrdinalIgnoreCase
        )
}

function Assert-BindingWorkerProvenance {
    param(
        [object[]]$Records, $ReceiptWorker, $OriginalWorker, $RecoveryWorker,
        [string]$ResultKind, [string]$Provider
    )
    if (-not (Test-BindingProcessIdentityEqual $ReceiptWorker $OriginalWorker)) {
        throw 'The supervisor observation is not bound to the receipt worker process.'
    }
    $refreshChild = $null; $verifyChild = $null; $harmlessChild = $null
    foreach ($record in $Records) {
        $stage = [string](Get-BindingRequiredValue $record 'stage')
        $process = Get-BindingRequiredValue $record 'process'
        $expected = $null
        switch -Regex ($stage) {
            '^(preflight_accepted|freshness_accepted|source_hashes_sealed|fixture_receipt_sealed|publication_started|publication_completed|harmless_output_started|harmless_output_completed)$' {
                $expected = $OriginalWorker; break
            }
            '^(refresh_admitted|verify_admitted)$' { $expected = $OriginalWorker; break }
            '^(refresh_child_started|refresh_completed)$' {
                if ($Provider -cne 'production') { $expected = $OriginalWorker; break }
                if ($null -eq $refreshChild) { $refreshChild = $process }
                $expected = $refreshChild; break
            }
            '^(verify_child_started|verify_completed)$' {
                if ($Provider -cne 'production') { $expected = $OriginalWorker; break }
                if ($null -eq $verifyChild) { $verifyChild = $process }
                $expected = $verifyChild; break
            }
            '^(harmless_delay_started|harmless_delay_completed)$' {
                if ($Provider -cne 'offline-fake') { throw 'Harmless child evidence is forbidden for production preparation.' }
                if ($null -eq $harmlessChild) { $harmlessChild = $process }
                $expected = $harmlessChild; break
            }
            '^(publication_recovery_started|publication_recovery_completed)$' {
                if ($ResultKind -cne 'recovery') { throw 'Unexpected publication recovery process evidence.' }
                $expected = $RecoveryWorker; break
            }
            '^terminal_commit$' {
                $expected = if ($ResultKind -ceq 'recovery' -and
                    [string](Get-BindingValue $record 'status' '') -ceq 'completed') {
                    $RecoveryWorker
                } else { $OriginalWorker }
                break
            }
            default { throw 'Fixture preparation journal contains an unclassified process-bearing stage.' }
        }
        if (-not (Test-BindingProcessIdentityEqual $process $expected)) {
            throw 'Fixture preparation journal process provenance drifted from its classified owner.'
        }
    }
}

function Assert-BindingWorkerOwnership {
    param(
        $Reference, $ExpectedSupervisor, $ExpectedWorker,
        [string]$ExpectedAdmissionSha256, [string]$ExpectedPath,
        [string]$RunId, [string]$ManifestSha256
    )
    $path = Resolve-BindingExternalPath `
        ([string](Get-BindingRequiredValue $Reference 'path')) 'worker ownership proof'
    $sha256 = Assert-BindingSha256 `
        ([string](Get-BindingRequiredValue $Reference 'sha256')) 'worker ownership proof sha256'
    if (-not [string]::Equals($path, [IO.Path]::GetFullPath($ExpectedPath),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Worker ownership proof path drifted from its run-bound location.'
    }
    Assert-BindingPrivateFileAcl $path 'Worker ownership proof'
    if ((Get-BindingFileSha256 $path) -cne $sha256) {
        throw 'Worker ownership proof changed after supervision.'
    }
    $proof = Read-BindingJson $path 'Worker ownership proof'
    $expectedKeys = @(
        'schemaVersion','type','version','runId','createdAtUtc','manifestSha256',
        'supervisorAdmissionSha256','supervisor','worker','jobPolicy','descendantPolicy'
    )
    if (@(Compare-Object ($expectedKeys | Sort-Object) `
            (@($proof.PSObject.Properties.Name) | Sort-Object)).Count -ne 0) {
        throw 'Worker ownership proof fields are invalid.'
    }
    $createdAt = [DateTimeOffset]::MinValue
    if ([int](Get-BindingValue $proof 'schemaVersion' 0) -ne 1 -or
        [string](Get-BindingValue $proof 'type' '') -cne 'diagnostic_prep_worker_ownership' -or
        [string](Get-BindingValue $proof 'version' '') -cne 'diagnostic-prep-worker-job-v1' -or
        [string](Get-BindingValue $proof 'runId' '') -cne $RunId -or
        [string](Get-BindingValue $proof 'manifestSha256' '') -cne $ManifestSha256 -or
        [string](Get-BindingValue $proof 'supervisorAdmissionSha256' '') -cne $ExpectedAdmissionSha256 -or
        [string](Get-BindingValue $proof 'jobPolicy' '') -cne 'kill-on-supervisor-close-v1' -or
        [string](Get-BindingValue $proof 'descendantPolicy' '') -cne 'no-breakaway-v1' -or
        -not [DateTimeOffset]::TryParseExact(
            [string](Get-BindingValue $proof 'createdAtUtc' ''), 'o',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None,
            [ref]$createdAt
        ) -or $createdAt.Offset -ne [TimeSpan]::Zero -or
        -not (Test-BindingProcessIdentityEqual (Get-BindingRequiredValue $proof 'supervisor') $ExpectedSupervisor) -or
        -not (Test-BindingProcessIdentityEqual (Get-BindingRequiredValue $proof 'worker') $ExpectedWorker)) {
        throw 'Worker ownership proof is not bound to the exact supervised process tree.'
    }
    return [ordered]@{path=$path;sha256=$sha256}
}

function Assert-BindingNamedMutexFree {
    param([string]$Name, [string]$Description)
    if ([string]::IsNullOrWhiteSpace($Name)) { throw "$Description mutex name is missing." }
    $mutex = [Threading.Mutex]::new($false, $Name)
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw "$Description mutex is still owned." }
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Assert-BindingFileLockFree {
    param([string]$Path, [string]$ExpectedSha256)
    $resolved = Resolve-BindingExternalPath $Path 'fixture preparation supervisor lock'
    Assert-BindingPrivateFileAcl $resolved 'Fixture preparation supervisor lock'
    if ((Get-BindingFileSha256 $resolved) -cne $ExpectedSha256) {
        throw 'Fixture preparation supervisor lock identity changed.'
    }
    $stream = $null
    try {
        $stream = [IO.FileStream]::new(
            $resolved, [IO.FileMode]::Open, [IO.FileAccess]::Read,
            [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough
        )
    }
    catch { throw 'Fixture preparation supervisor lock is still owned by another session.' }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    return $resolved
}

function Assert-BindingJournalStateMachine {
    param([object[]]$Records, $Manifest, [string]$ExpectedResultKind)
    $core = [Collections.Generic.List[string]]::new()
    $core.Add('preflight_accepted|completed')
    $testControls = Get-BindingValue $Manifest 'testControls' $null
    if ($null -ne $testControls -and $ExpectedResultKind -in @('initial','recovery')) {
        if ($null -ne (Get-BindingValue $testControls 'largeOutputBytes' $null) -and
            [int](Get-BindingValue $testControls 'largeOutputBytes' 0) -gt 0) {
            $core.Add('harmless_output_started|running')
            $core.Add('harmless_output_completed|completed')
        }
        if ($null -ne (Get-BindingValue $testControls 'harmlessDelaySeconds' $null) -and
            [int](Get-BindingValue $testControls 'harmlessDelaySeconds' 0) -gt 0) {
            $core.Add('harmless_delay_started|running')
            $core.Add('harmless_delay_completed|completed')
        }
    }
    $provider = [string](Get-BindingValue (Get-BindingRequiredValue $Manifest 'fixture') 'provider' '')
    if ($provider -notin @('production','offline-fake')) {
        throw 'Fixture preparation journal provider is unsupported.'
    }
    $core.Add('refresh_admitted|running')
    if ($provider -ceq 'production') { $core.Add('refresh_child_started|running') }
    $core.Add('refresh_completed|completed')
    $core.Add('verify_admitted|running')
    if ($provider -ceq 'production') { $core.Add('verify_child_started|running') }
    foreach ($signature in @(
        'verify_completed|completed','freshness_accepted|completed','source_hashes_sealed|completed',
        'fixture_receipt_sealed|completed'
    )) { $core.Add($signature) }
    $pairs = @($Records | ForEach-Object {
        ([string](Get-BindingValue $_ 'stage' '')) + '|' + ([string](Get-BindingValue $_ 'status' ''))
    })
    if ($pairs.Count -lt $core.Count -or
        ($pairs[0..($core.Count - 1)] -join ';') -cne (@($core) -join ';')) {
        throw 'Fixture preparation journal violates the exact ordered preparation state machine.'
    }
    $suffix = if ($pairs.Count -eq $core.Count) { @() } else { @($pairs[$core.Count..($pairs.Count - 1)]) }
    $allowedSignatures = if ($ExpectedResultKind -ceq 'initial') {
        @('publication_started|running;publication_completed|completed;terminal_commit|completed')
    } else {
        @(
            'publication_recovery_started|running;publication_recovery_completed|completed;terminal_commit|completed',
            'publication_started|running;publication_recovery_started|running;publication_recovery_completed|completed;terminal_commit|completed',
            'publication_started|running;terminal_commit|failed;publication_recovery_started|running;publication_recovery_completed|completed;terminal_commit|completed',
            'publication_started|running;publication_completed|completed;publication_recovery_started|running;publication_recovery_completed|completed;terminal_commit|completed',
            'publication_started|running;publication_completed|completed;terminal_commit|failed;publication_recovery_started|running;publication_recovery_completed|completed;terminal_commit|completed'
        )
    }
    if (($suffix -join ';') -cnotin $allowedSignatures -or
        [int](Get-BindingValue $Records[-1] 'exitCode' -1) -ne 0) {
        throw 'Fixture preparation journal contains out-of-order, repeated, or trailing states.'
    }
}

function Assert-BindingFixtureChildEvidence {
    param([object[]]$Records, $Manifest, $Receipt, [string]$WorkerSha256, [string]$TicketSha256)
    $fixture = Get-BindingRequiredValue $Manifest 'fixture'
    $provider = [string](Get-BindingRequiredValue $fixture 'provider')
    $allChildren = @($Records | Where-Object {
        [string](Get-BindingValue $_ 'stage' '') -in @('refresh_child_started','verify_child_started')
    })
    if ($provider -ceq 'offline-fake') {
        if ($allChildren.Count -ne 0) { throw 'Offline fixture preparation cannot bind production child evidence.' }
        return
    }
    if ($provider -cne 'production') { throw 'Fixture preparation child provider is unsupported.' }
    $fixtureCliSha256 = Assert-BindingSha256 `
        ([string](Get-BindingRequiredValue (Get-BindingRequiredValue $fixture 'fixtureCli') 'sha256')) `
        'fixture CLI sha256'
    $execution = Get-BindingRequiredValue $Receipt 'execution'
    $workerProcess = Get-BindingRequiredValue $execution 'workerProcess'
    $emptySha256 = Get-BindingTextSha256 ''
    foreach ($command in @('refresh','verify')) {
        $admitted = @($Records | Where-Object {
            [string](Get-BindingValue $_ 'stage' '') -ceq "${command}_admitted" -and
            [string](Get-BindingValue $_ 'status' '') -ceq 'running'
        })
        $started = @($Records | Where-Object {
            [string](Get-BindingValue $_ 'stage' '') -ceq "${command}_child_started" -and
            [string](Get-BindingValue $_ 'status' '') -ceq 'running'
        })
        $completed = @($Records | Where-Object {
            [string](Get-BindingValue $_ 'stage' '') -ceq "${command}_completed" -and
            [string](Get-BindingValue $_ 'status' '') -ceq 'completed'
        })
        if ($admitted.Count -ne 1 -or $started.Count -ne 1 -or $completed.Count -ne 1 -or
            [int](Get-BindingValue $admitted[0] 'sequence' 0) -ge [int](Get-BindingValue $started[0] 'sequence' 0) -or
            [int](Get-BindingValue $started[0] 'sequence' 0) -ge [int](Get-BindingValue $completed[0] 'sequence' 0) -or
            [int](Get-BindingValue $completed[0] 'exitCode' -1) -ne 0) {
            throw 'Production fixture child lifecycle is incomplete or out of order.'
        }
        $admittedProcess = Get-BindingRequiredValue $admitted[0] 'process'
        $childProcess = Get-BindingRequiredValue $started[0] 'process'
        $completedProcess = Get-BindingRequiredValue $completed[0] 'process'
        $admittedHashes = Get-BindingRequiredValue $admitted[0] 'artifactHashes'
        $childHashes = Get-BindingRequiredValue $started[0] 'artifactHashes'
        $completedHashes = Get-BindingRequiredValue $completed[0] 'artifactHashes'
        $stdoutField = if ($command -ceq 'refresh') { 'refreshStdoutSha256' } else { 'verifyStdoutSha256' }
        $stderrField = if ($command -ceq 'refresh') { 'refreshStderrSha256' } else { 'verifyStderrSha256' }
        $expectedStdout = Assert-BindingSha256 `
            ([string](Get-BindingRequiredValue $execution $stdoutField)) "receipt.execution.$stdoutField"
        $expectedStderr = Assert-BindingSha256 `
            ([string](Get-BindingRequiredValue $execution $stderrField)) "receipt.execution.$stderrField"
        $childStartedAt = [DateTimeOffset]::MinValue
        if ([int](Get-BindingValue $admittedProcess 'pid' 0) -ne [int](Get-BindingValue $workerProcess 'pid' 0) -or
            [string](Get-BindingValue $admittedProcess 'startedAtUtc' '') -cne
                [string](Get-BindingValue $workerProcess 'startedAtUtc' '') -or
            -not [string]::Equals(
                [string](Get-BindingValue $admittedProcess 'path' ''),
                [string](Get-BindingValue $workerProcess 'path' ''), [StringComparison]::OrdinalIgnoreCase) -or
            [string](Get-BindingValue $admittedProcess 'kind' '') -cne 'fixture-worker' -or
            [string](Get-BindingValue $admittedHashes 'fixtureCliSha256' '') -cne $fixtureCliSha256 -or
            [string](Get-BindingValue $admittedHashes 'fixtureWorkerSha256' '') -cne $WorkerSha256 -or
            [string](Get-BindingValue $admittedHashes 'supervisorAdmissionSha256' '') -cne $TicketSha256 -or
            [int](Get-BindingValue $childProcess 'pid' 0) -le 0 -or
            [int](Get-BindingValue $childProcess 'pid' 0) -eq [int](Get-BindingValue $workerProcess 'pid' 0) -or
            [string](Get-BindingValue $childProcess 'startedAtUtc' '') -cne
                [string](Get-BindingValue $completedProcess 'startedAtUtc' '') -or
            -not [string]::Equals(
                [string](Get-BindingValue $childProcess 'path' ''),
                [string](Get-BindingValue $completedProcess 'path' ''), [StringComparison]::OrdinalIgnoreCase) -or
            [string](Get-BindingValue $childProcess 'kind' '') -cne "fixture-$command" -or
            [string](Get-BindingValue $completedProcess 'kind' '') -cne "fixture-$command" -or
            [int](Get-BindingValue $childProcess 'pid' 0) -ne [int](Get-BindingValue $completedProcess 'pid' 0) -or
            -not [IO.Path]::IsPathRooted([string](Get-BindingValue $childProcess 'path' '')) -or
            -not [DateTimeOffset]::TryParseExact(
                [string](Get-BindingValue $childProcess 'startedAtUtc' ''), 'o',
                [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None,
                [ref]$childStartedAt
            ) -or $childStartedAt.Offset -ne [TimeSpan]::Zero -or
            [string](Get-BindingValue $childHashes 'fixtureCliSha256' '') -cne $fixtureCliSha256 -or
            [string](Get-BindingValue $childHashes 'fixtureWorkerSha256' '') -cne $WorkerSha256 -or
            [string](Get-BindingValue $childHashes 'supervisorAdmissionSha256' '') -cne $TicketSha256 -or
            [string](Get-BindingValue $completedHashes 'stdoutSha256' '') -cne $expectedStdout -or
            [string](Get-BindingValue $completedHashes 'stderrSha256' '') -cne $expectedStderr -or
            $expectedStderr -cne $emptySha256) {
            throw 'Production fixture child process or output evidence is invalid.'
        }
    }
}

$ManifestPath = Resolve-BindingExternalPath $ManifestPath 'ManifestPath'
$manifestSha256 = Assert-BindingSha256 $ExpectedManifestSha256 'ExpectedManifestSha256'
$FixturePreparationReceiptPath = Resolve-BindingExternalPath $FixturePreparationReceiptPath `
    'FixturePreparationReceiptPath'
$fixtureReceiptSha256 = Assert-BindingSha256 $ExpectedFixturePreparationReceiptSha256 `
    'ExpectedFixturePreparationReceiptSha256'
$SupervisorTicketPath = Resolve-BindingExternalPath $SupervisorTicketPath 'SupervisorTicketPath'
$supervisorTicketSha256 = Assert-BindingSha256 $ExpectedSupervisorTicketSha256 `
    'ExpectedSupervisorTicketSha256'
$SupervisorResultPath = Resolve-BindingExternalPath $SupervisorResultPath 'SupervisorResultPath'
$supervisorResultSha256 = Assert-BindingSha256 $ExpectedSupervisorResultSha256 `
    'ExpectedSupervisorResultSha256'
foreach ($private in @(
        $ManifestPath, $FixturePreparationReceiptPath, $SupervisorTicketPath, $SupervisorResultPath
    )) {
    Assert-BindingPrivateFileAcl $private 'Diagnostic private binding input'
}
if ((Get-BindingFileSha256 $ManifestPath) -cne $manifestSha256 -or
    (Get-BindingFileSha256 $FixturePreparationReceiptPath) -cne $fixtureReceiptSha256 -or
    (Get-BindingFileSha256 $SupervisorTicketPath) -cne $supervisorTicketSha256 -or
    (Get-BindingFileSha256 $SupervisorResultPath) -cne $supervisorResultSha256) {
    throw 'A diagnostic binding input changed after its hash was recorded.'
}

$manifest = Read-BindingJson $ManifestPath 'Diagnostic preparation manifest'
$receipt = Read-BindingJson $FixturePreparationReceiptPath 'Fixture preparation receipt'
$runId = [string](Get-BindingRequiredValue $manifest 'runId')
$diagnosticEligibleValue = Get-BindingValue $manifest 'diagnosticEligible' $null
if ($diagnosticEligibleValue -isnot [bool] -or
    [int](Get-BindingValue $manifest 'schemaVersion' 0) -ne 1 -or
    [string](Get-BindingValue $manifest 'type' '') -cne 'waf800_diagnostic_prep_manifest' -or
    [string](Get-BindingValue $manifest 'version' '') -cne $script:ManifestVersion -or
    $runId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
    (Get-BindingValue $manifest 'diagnosticOnly' $false) -ne $true -or
    (Get-BindingValue $manifest 'certificationEligible' $true) -ne $false) {
    throw 'The preparation manifest is historical, a rehearsal, or otherwise ineligible.'
}
$diagnosticEligible = [bool]$diagnosticEligibleValue
if ($diagnosticEligible -and -not [string]::IsNullOrWhiteSpace($TestFaultStage)) {
    throw 'TestFaultStage is forbidden for diagnostic-eligible binding.'
}
$oneAttemptPolicy = Get-BindingRequiredValue $manifest 'oneAttemptPolicy'
foreach ($field in @(
    'refreshAttempts','verificationAttempts','initialPublicationAttempts','publicationRecoveryAttempts'
)) {
    if ([int](Get-BindingValue $oneAttemptPolicy $field 0) -ne 1) {
        throw 'The preparation manifest must preserve the exact one-attempt policy.'
    }
}
$manifestRepositoryRoot = [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $manifest 'repositoryRoot'))
if (-not [string]::Equals($manifestRepositoryRoot, $script:RepositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The preparation manifest does not bind this repository.'
}
$paths = Get-BindingRequiredValue $manifest 'paths'
if ([IO.Path]::GetFullPath([string](Get-BindingRequiredValue $paths 'fixturePreparationReceiptPath')) -cne
        $FixturePreparationReceiptPath) {
    throw 'Preparation receipt invocation drifted from the manifest path.'
}
$runRoot = Resolve-BindingExternalPath ([string](Get-BindingRequiredValue $paths 'runDirectoryRoot')) `
    'paths.runDirectoryRoot' -Directory
Assert-BindingPrivateDirectoryAcl $runRoot 'Preparation run root'
$runRootPrefix = $runRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (-not $SupervisorTicketPath.StartsWith($runRootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    -not $SupervisorResultPath.StartsWith($runRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Supervisor evidence must remain inside the bound preparation run root.'
}
$ticket = Read-BindingJson $SupervisorTicketPath 'Preparation supervisor ticket'
$ticketManifest = Get-BindingRequiredValue $ticket 'manifest'
$ticketWorker = Get-BindingRequiredValue $ticket 'worker'
$ticketSupervisorScript = Get-BindingRequiredValue $ticket 'supervisorScript'
$ticketLaunchAdmission = Get-BindingRequiredValue $ticket 'launchAdmission'
$ticketSupervisor = Get-BindingRequiredValue $ticket 'supervisor'
$ticketControl = Get-BindingRequiredValue $ticket 'control'
$ticketKeys = @(
    'schemaVersion','type','version','runId','createdAtUtc','diagnosticOnly',
    'diagnosticEligible','certificationEligible','manifest','worker','supervisorScript',
    'launchAdmission','supervisor','launchNonceSha256','timeoutSeconds','control'
)
Assert-BindingExactKeys $ticket $ticketKeys @() 'Preparation supervisor ticket'
foreach ($reference in @(
        [pscustomobject]@{ value=$ticketManifest; name='ticket manifest' },
        [pscustomobject]@{ value=$ticketWorker; name='ticket worker' },
        [pscustomobject]@{ value=$ticketSupervisorScript; name='ticket supervisor script' },
        [pscustomobject]@{ value=$ticketLaunchAdmission; name='ticket launch admission' }
    )) {
    Assert-BindingExactKeys $reference.value @('path','sha256') @() $reference.name
}
$ticketCreatedAt = [DateTimeOffset]::MinValue
$ticketTimeout = [int](Get-BindingValue $ticket 'timeoutSeconds' 0)
$expectedRunMutexName = "Local\SchoolPilot.Waf800DiagnosticPreparation.$((Get-BindingTextSha256 $runId).Substring(0, 32))"
$expectedSupervisorMutexName = "Local\SchoolPilot.Waf800DiagnosticPreparationSupervisor.$((Get-BindingTextSha256 $runId).Substring(0, 32))"
$expectedTicketControl = [ordered]@{
    statePath = [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $paths 'supervisorStatePath'))
    resultPath = [IO.Path]::GetFullPath((Join-Path $runRoot 'supervisor-result.private.json'))
    journalPath = [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $paths 'journalPath'))
    workerStdoutPath = [IO.Path]::GetFullPath((Join-Path $runRoot 'fixture-worker.stdout.log'))
    workerStderrPath = [IO.Path]::GetFullPath((Join-Path $runRoot 'fixture-worker.stderr.log'))
    supervisorStdoutPath = [IO.Path]::GetFullPath((Join-Path $runRoot 'supervisor.stdout.log'))
    supervisorStderrPath = [IO.Path]::GetFullPath((Join-Path $runRoot 'supervisor.stderr.log'))
    runMutexName = $expectedRunMutexName
    supervisorMutexName = $expectedSupervisorMutexName
    supervisorLockPath = [IO.Path]::GetFullPath((Join-Path $runRoot 'supervisor-run.private.lock'))
}
if ([int](Get-BindingValue $ticket 'schemaVersion' 0) -ne 1 -or
    [string](Get-BindingValue $ticket 'type' '') -cne 'diagnostic_prep_supervisor_ticket' -or
    [string](Get-BindingValue $ticket 'version' '') -cne $script:SupervisorTicketVersion -or
    [string](Get-BindingValue $ticket 'runId' '') -cne $runId -or
    (Get-BindingValue $ticket 'diagnosticOnly' $false) -ne $true -or
    (Get-BindingValue $ticket 'diagnosticEligible' $null) -isnot [bool] -or
    [bool](Get-BindingValue $ticket 'diagnosticEligible' $null) -ne $diagnosticEligible -or
    (Get-BindingValue $ticket 'certificationEligible' $true) -ne $false -or
    [string](Get-BindingValue $ticketManifest 'path' '') -cne $ManifestPath -or
    [string](Get-BindingValue $ticketManifest 'sha256' '') -cne $manifestSha256 -or
    $ticketTimeout -lt 1 -or $ticketTimeout -gt 2100 -or
    ($diagnosticEligible -and $ticketTimeout -ne 2100) -or
    [string](Get-BindingValue $ticket 'launchNonceSha256' '') -cnotmatch '^[0-9a-f]{64}$' -or
    -not [DateTimeOffset]::TryParseExact(
        [string](Get-BindingValue $ticket 'createdAtUtc' ''), 'o',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None, [ref]$ticketCreatedAt
    ) -or $ticketCreatedAt.Offset -ne [TimeSpan]::Zero) {
    throw 'Preparation supervisor ticket identity or manifest binding is invalid.'
}
Assert-BindingExactKeys $ticketControl @($expectedTicketControl.Keys) @() `
    'Preparation supervisor ticket control'
foreach ($field in $expectedTicketControl.Keys) {
    if ([string](Get-BindingValue $ticketControl $field '') -cne [string]$expectedTicketControl[$field]) {
        throw 'Preparation supervisor ticket control binding changed.'
    }
}
$launchAdmissionPath = Resolve-BindingExternalPath `
    ([string](Get-BindingRequiredValue $ticketLaunchAdmission 'path')) `
    'preparation supervisor launch admission'
$launchAdmissionSha256 = Assert-BindingSha256 `
    ([string](Get-BindingRequiredValue $ticketLaunchAdmission 'sha256')) `
    'preparation supervisor launch admission sha256'
$expectedLaunchAdmissionPath = Join-Path $runRoot 'supervisor-launch-admission.private.json'
Assert-BindingPrivateFileAcl $launchAdmissionPath 'Preparation supervisor launch admission'
if (-not [string]::Equals($launchAdmissionPath, $expectedLaunchAdmissionPath,
        [StringComparison]::OrdinalIgnoreCase) -or
    (Get-BindingFileSha256 $launchAdmissionPath) -cne $launchAdmissionSha256) {
    throw 'Preparation supervisor launch admission changed after the child-authored ticket.'
}
$launchAdmission = Read-BindingJson $launchAdmissionPath 'Preparation supervisor launch admission'
$launchAdmissionKeys = @(
    'schemaVersion','type','version','runId','createdAtUtc','manifest','worker',
    'supervisorScript','launchNonceSha256','timeoutSeconds','control'
)
Assert-BindingExactKeys $launchAdmission $launchAdmissionKeys @() `
    'Preparation supervisor launch admission'
$launchManifest = Get-BindingRequiredValue $launchAdmission 'manifest'
$launchWorker = Get-BindingRequiredValue $launchAdmission 'worker'
$launchSupervisorScript = Get-BindingRequiredValue $launchAdmission 'supervisorScript'
$launchControl = Get-BindingRequiredValue $launchAdmission 'control'
foreach ($reference in @(
        [pscustomobject]@{ value=$launchManifest; name='launch admission manifest' },
        [pscustomobject]@{ value=$launchWorker; name='launch admission worker' },
        [pscustomobject]@{ value=$launchSupervisorScript; name='launch admission supervisor script' }
    )) {
    Assert-BindingExactKeys $reference.value @('path','sha256') @() $reference.name
}
$ticketControlKeys = @(
    'statePath','resultPath','journalPath','workerStdoutPath','workerStderrPath',
    'supervisorStdoutPath','supervisorStderrPath','runMutexName','supervisorMutexName',
    'supervisorLockPath'
)
Assert-BindingExactKeys $ticketControl $ticketControlKeys @() 'Preparation supervisor ticket control'
Assert-BindingExactKeys $launchControl (@('ticketPath') + $ticketControlKeys) @() `
    'Preparation supervisor launch admission control'
$launchCreatedAt = [DateTimeOffset]::MinValue
$launchTimeout = [int](Get-BindingValue $launchAdmission 'timeoutSeconds' 0)
if ([int](Get-BindingValue $launchAdmission 'schemaVersion' 0) -ne 1 -or
    [string](Get-BindingValue $launchAdmission 'type' '') -cne
        'diagnostic_prep_supervisor_launch_admission' -or
    [string](Get-BindingValue $launchAdmission 'version' '') -cne
        'diagnostic-prep-supervisor-launch-admission-v1' -or
    [string](Get-BindingValue $launchAdmission 'runId' '') -cne $runId -or
    [string](Get-BindingValue $launchManifest 'path' '') -cne $ManifestPath -or
    [string](Get-BindingValue $launchManifest 'sha256' '') -cne $manifestSha256 -or
    [IO.Path]::GetFullPath([string](Get-BindingValue $launchWorker 'path' '')) -cne
        [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $ticketWorker 'path')) -or
    [string](Get-BindingValue $launchWorker 'sha256' '') -cne
        [string](Get-BindingRequiredValue $ticketWorker 'sha256') -or
    [IO.Path]::GetFullPath([string](Get-BindingValue $launchSupervisorScript 'path' '')) -cne
        [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $ticketSupervisorScript 'path')) -or
    [string](Get-BindingValue $launchSupervisorScript 'sha256' '') -cne
        [string](Get-BindingRequiredValue $ticketSupervisorScript 'sha256') -or
    [string](Get-BindingValue $launchAdmission 'launchNonceSha256' '') -cne
        [string](Get-BindingRequiredValue $ticket 'launchNonceSha256') -or
    $launchTimeout -lt 1 -or $launchTimeout -gt 2100 -or
    $launchTimeout -ne [int](Get-BindingRequiredValue $ticket 'timeoutSeconds') -or
    -not [DateTimeOffset]::TryParseExact(
        [string](Get-BindingValue $launchAdmission 'createdAtUtc' ''), 'o',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None, [ref]$launchCreatedAt
    ) -or $launchCreatedAt.Offset -ne [TimeSpan]::Zero -or
    [IO.Path]::GetFullPath([string](Get-BindingValue $launchControl 'ticketPath' '')) -cne
        $SupervisorTicketPath) {
    throw 'Preparation supervisor launch admission identity is invalid.'
}
foreach ($field in $ticketControlKeys) {
    if ([string](Get-BindingValue $launchControl $field '') -cne
        [string](Get-BindingRequiredValue $ticketControl $field)) {
        throw 'Preparation supervisor launch admission control binding changed.'
    }
}
$supervisorScriptPath = [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $ticketSupervisorScript 'path'))
$supervisorScriptSha256 = Assert-BindingSha256 `
    ([string](Get-BindingRequiredValue $ticketSupervisorScript 'sha256')) 'supervisor script sha256'
$workerScriptPath = [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $ticketWorker 'path'))
$workerScriptSha256 = Assert-BindingSha256 `
    ([string](Get-BindingRequiredValue $ticketWorker 'sha256')) 'fixture worker sha256'
foreach ($scriptReference in @(
        [pscustomobject]@{path=$supervisorScriptPath;sha256=$supervisorScriptSha256},
        [pscustomobject]@{path=$workerScriptPath;sha256=$workerScriptSha256}
    )) {
    $repositoryPrefix = $script:RepositoryRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $scriptReference.path.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        (Get-BindingFileSha256 $scriptReference.path) -cne $scriptReference.sha256) {
        throw 'Preparation supervisor ticket controller identity drifted.'
    }
}
if (Test-BindingBoundProcessPresent $ticketSupervisor 'preparation supervisor') {
    throw 'Preparation supervisor is still present; binding is blocked.'
}

$supervisorResult = Read-BindingJson $SupervisorResultPath 'Preparation supervisor result'
$resultManifest = Get-BindingRequiredValue $supervisorResult 'manifest'
$resultTicket = Get-BindingRequiredValue $supervisorResult 'ticket'
$resultJournal = Get-BindingRequiredValue $supervisorResult 'journal'
$resultReceipt = Get-BindingRequiredValue $supervisorResult 'fixturePreparationReceipt'
$initialResultPath = [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $ticketControl 'resultPath'))
$recoveryResultPath = [IO.Path]::GetFullPath((Join-Path $runRoot 'publication-recovery-result.private.json'))
$resultKind = if ($SupervisorResultPath -ceq $initialResultPath) { 'initial' }
elseif ($SupervisorResultPath -ceq $recoveryResultPath) { 'recovery' }
else { throw 'Supervisor result path is not the exact initial or one permitted recovery result.' }
$manifestRecoveryReceiptPath = Resolve-BindingExternalPath `
    ([string](Get-BindingRequiredValue $paths 'publicationRecoveryReceiptPath')) `
    'paths.publicationRecoveryReceiptPath' -AllowMissing
[void](Assert-BindingResultRecoveryProvenance $resultKind $supervisorResult `
    $manifestRecoveryReceiptPath)
if ([int](Get-BindingValue $supervisorResult 'schemaVersion' 0) -ne 1 -or
    [string](Get-BindingValue $supervisorResult 'type' '') -cne 'waf800_diagnostic_prep_supervisor_result' -or
    [string](Get-BindingValue $supervisorResult 'version' '') -cne $script:SupervisorResultVersion -or
    [string](Get-BindingValue $supervisorResult 'runId' '') -cne $runId -or
    [string](Get-BindingValue $supervisorResult 'status' '') -cne 'completed' -or
    (Get-BindingValue $supervisorResult 'terminalEvidenceCommitted' $false) -ne $true -or
    (Get-BindingValue $supervisorResult 'trafficStarted' $true) -ne $false -or
    (Get-BindingValue $supervisorResult 'leaseAcquired' $true) -ne $false -or
    (Get-BindingValue $supervisorResult 'rawErrorPersisted' $true) -ne $false -or
    [string](Get-BindingValue $resultManifest 'path' '') -cne $ManifestPath -or
    [string](Get-BindingValue $resultManifest 'sha256' '') -cne $manifestSha256 -or
    [string](Get-BindingValue $resultTicket 'path' '') -cne $SupervisorTicketPath -or
    [string](Get-BindingValue $resultTicket 'sha256' '') -cne $supervisorTicketSha256 -or
    [string](Get-BindingValue $resultJournal 'path' '') -cne
        [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $paths 'journalPath')) -or
    (Get-BindingValue $resultJournal 'terminalCommitted' $false) -ne $true -or
    [string](Get-BindingValue $resultReceipt 'path' '') -cne $FixturePreparationReceiptPath -or
    [string](Get-BindingValue $resultReceipt 'sha256' '') -cne $fixtureReceiptSha256) {
    throw 'Preparation supervisor result is not an exact coherent no-traffic completion.'
}
$resultRunLock = Get-BindingRequiredValue $supervisorResult 'supervisorRunLock'
$runLockPath = [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $resultRunLock 'path'))
$runLockSha256 = Assert-BindingSha256 ([string](Get-BindingRequiredValue $resultRunLock 'sha256')) `
    'fixture preparation supervisor lock sha256'
if ($runLockPath -cne [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $ticketControl 'supervisorLockPath'))) {
    throw 'Preparation supervisor lock path drifted from its ticket.'
}
$runLockRecord = Read-BindingJson $runLockPath 'Preparation supervisor run lock'
$expectedRunLockRecord = [ordered]@{
    schemaVersion = 1
    type = 'diagnostic_prep_supervisor_run_lock'
    version = $script:SupervisorRunLockVersion
    runId = $runId
    manifest = [ordered]@{ path = $ManifestPath; sha256 = $manifestSha256 }
    ticket = [ordered]@{ path = $SupervisorTicketPath; sha256 = $supervisorTicketSha256 }
    supervisorMutexName = [string](Get-BindingRequiredValue $ticketControl 'supervisorMutexName')
    workerMutexName = [string](Get-BindingRequiredValue $ticketControl 'runMutexName')
}
if (($runLockRecord | ConvertTo-Json -Compress -Depth 20) -cne
    ($expectedRunLockRecord | ConvertTo-Json -Compress -Depth 20)) {
    throw 'Preparation supervisor run lock provenance is invalid.'
}
[void](Assert-BindingFileLockFree $runLockPath $runLockSha256)
Assert-BindingNamedMutexFree ([string](Get-BindingRequiredValue $ticketControl 'supervisorMutexName')) `
    'fixture preparation supervisor'
Assert-BindingNamedMutexFree ([string](Get-BindingRequiredValue $ticketControl 'runMutexName')) `
    'fixture preparation worker'

$terminalWorker = if ($resultKind -ceq 'initial') {
    Get-BindingRequiredValue $supervisorResult 'worker'
} else {
    Get-BindingRequiredValue (Get-BindingRequiredValue $supervisorResult 'recovery') 'worker'
}
$receiptWorkerProcess = Get-BindingRequiredValue `
    (Get-BindingRequiredValue $receipt 'execution') 'workerProcess'
$originalTerminalWorker = if ($resultKind -ceq 'initial') {
    $terminalWorker
} else {
    Get-BindingRequiredValue (Get-BindingRequiredValue $supervisorResult 'originalExecution') 'worker'
}
if (-not (Test-BindingProcessIdentityEqual $receiptWorkerProcess $originalTerminalWorker)) {
    throw 'Preparation receipt worker is not the exact supervisor-owned original worker.'
}
$originalOwnershipReference = if ($resultKind -ceq 'initial') {
    Get-BindingRequiredValue $supervisorResult 'workerOwnership'
} else {
    Get-BindingRequiredValue (Get-BindingRequiredValue $supervisorResult 'originalExecution') 'workerOwnership'
}
$receiptOwnershipReference = Get-BindingRequiredValue `
    (Get-BindingRequiredValue $receipt 'supervisorAdmission') 'workerOwnership'
$expectedOriginalOwnershipPath = Join-Path $runRoot 'worker-ownership.private.json'
$originalWorkerOwnership = Assert-BindingWorkerOwnership $originalOwnershipReference `
    $ticketSupervisor $originalTerminalWorker $supervisorTicketSha256 `
    $expectedOriginalOwnershipPath $runId $manifestSha256
if ([string](Get-BindingRequiredValue $receiptOwnershipReference 'path') -cne $originalWorkerOwnership.path -or
    [string](Get-BindingRequiredValue $receiptOwnershipReference 'sha256') -cne $originalWorkerOwnership.sha256) {
    throw 'Receipt, state, and supervisor result do not bind the same original worker ownership proof.'
}
$terminalSupervisor = Get-BindingRequiredValue $supervisorResult 'supervisor'
if ($resultKind -ceq 'initial' -and
    (([int](Get-BindingValue $terminalSupervisor 'pid' 0) -ne [int](Get-BindingValue $ticketSupervisor 'pid' 0)) -or
     [string](Get-BindingValue $terminalSupervisor 'startedAtUtc' '') -cne
        [string](Get-BindingValue $ticketSupervisor 'startedAtUtc' '') -or
     -not [string]::Equals(
        [string](Get-BindingValue $terminalSupervisor 'path' ''),
        [string](Get-BindingValue $ticketSupervisor 'path' ''),
        [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Initial supervisor result process identity drifted from its ticket.'
}
if (Test-BindingBoundProcessPresent $terminalSupervisor 'terminal preparation supervisor') {
    throw 'Terminal preparation supervisor is still present; binding is blocked.'
}
if ([int](Get-BindingValue $terminalWorker 'exitCode' -1) -ne 0 -or
    (Get-BindingValue $terminalWorker 'timedOut' $true) -ne $false -or
    (Get-BindingValue $terminalWorker 'exitPersistedBeforeResultParsing' $false) -ne $true -or
    (Test-BindingBoundProcessPresent $terminalWorker 'fixture preparation terminal worker')) {
    throw 'Preparation supervisor result does not prove a captured zero exit before result parsing.'
}
$recoveryAdmissionPath = $null
$recoveryAdmissionSha256 = $null
$recoveryReceiptPath = $null
$recoveryReceiptSha256 = $null
$recoveryWorkerOwnership = $null
$originalResultEvidencePath = $null
$originalResultEvidenceSha256 = $null
$originalStateEvidencePath = $null
$originalStateEvidenceSha256 = $null
if ($resultKind -ceq 'recovery') {
    $recoveryAdmissionRef = Get-BindingRequiredValue $supervisorResult 'recoveryAdmission'
    $recoveryAdmissionPath = Resolve-BindingExternalPath `
        ([string](Get-BindingRequiredValue $recoveryAdmissionRef 'path')) 'publication recovery admission'
    $recoveryAdmissionSha256 = Assert-BindingSha256 `
        ([string](Get-BindingRequiredValue $recoveryAdmissionRef 'sha256')) 'publication recovery admission sha256'
    Assert-BindingPrivateFileAcl $recoveryAdmissionPath 'Publication recovery admission'
    if ((Get-BindingFileSha256 $recoveryAdmissionPath) -cne $recoveryAdmissionSha256) {
        throw 'Publication recovery admission changed after supervision.'
    }
    $recoveryAdmission = Read-BindingJson $recoveryAdmissionPath 'Publication recovery admission'
    $recoveryWorkerOwnership = Assert-BindingWorkerOwnership `
        (Get-BindingRequiredValue (Get-BindingRequiredValue $supervisorResult 'recovery') 'workerOwnership') `
        $terminalSupervisor $terminalWorker $recoveryAdmissionSha256 `
        (Join-Path $runRoot 'publication-recovery-worker-ownership.private.json') `
        $runId $manifestSha256
    $admissionOriginal = Get-BindingRequiredValue $recoveryAdmission 'originalExecution'
    $resultOriginal = Get-BindingRequiredValue $supervisorResult 'originalExecution'
    $originalResultEvidencePath = Resolve-BindingExternalPath `
        ([string](Get-BindingRequiredValue $admissionOriginal 'resultPath')) 'original supervisor result'
    $originalResultEvidenceSha256 = Assert-BindingSha256 `
        ([string](Get-BindingRequiredValue $admissionOriginal 'resultSha256')) 'original supervisor result sha256'
    $originalStateEvidencePath = Resolve-BindingExternalPath `
        ([string](Get-BindingRequiredValue $admissionOriginal 'statePath')) 'original supervisor state'
    $originalStateEvidenceSha256 = Assert-BindingSha256 `
        ([string](Get-BindingRequiredValue $admissionOriginal 'stateSha256')) 'original supervisor state sha256'
    foreach ($originalEvidencePath in @($originalResultEvidencePath,$originalStateEvidencePath)) {
        Assert-BindingPrivateFileAcl $originalEvidencePath 'Original supervisor recovery evidence'
    }
    if ((Get-BindingFileSha256 $originalResultEvidencePath) -cne $originalResultEvidenceSha256 -or
        (Get-BindingFileSha256 $originalStateEvidencePath) -cne $originalStateEvidenceSha256) {
        throw 'Original supervisor recovery evidence changed after admission.'
    }
    $originalResultEvidence = Read-BindingJson $originalResultEvidencePath 'Original supervisor result'
    $originalStateEvidence = Read-BindingJson $originalStateEvidencePath 'Original supervisor state'
    $originalResultSupervisor = Get-BindingRequiredValue $originalResultEvidence 'supervisor'
    $originalStateSupervisor = Get-BindingRequiredValue $originalStateEvidence 'supervisor'
    $resultOriginalWorker = Get-BindingRequiredValue $resultOriginal 'worker'
    $originalResultWorker = Get-BindingRequiredValue $originalResultEvidence 'worker'
    $originalStateWorker = Get-BindingRequiredValue $originalStateEvidence 'worker'
    $resultOriginalOwnership = Get-BindingRequiredValue $resultOriginal 'workerOwnership'
    $originalResultOwnership = Get-BindingRequiredValue $originalResultEvidence 'workerOwnership'
    $originalStateOwnership = Get-BindingRequiredValue $originalStateEvidence 'workerOwnership'
    $resultOriginalState = Get-BindingRequiredValue $resultOriginal 'state'
    $admissionSupervisor = Get-BindingRequiredValue $recoveryAdmission 'supervisor'
    $admissionManifest = Get-BindingRequiredValue $recoveryAdmission 'manifest'
    $admissionWorker = Get-BindingRequiredValue $recoveryAdmission 'worker'
    $admissionSupervisorScript = Get-BindingRequiredValue $recoveryAdmission 'supervisorScript'
    $admissionControl = Get-BindingRequiredValue $recoveryAdmission 'control'
    if ([int](Get-BindingValue $recoveryAdmission 'schemaVersion' 0) -ne 1 -or
        [string](Get-BindingValue $recoveryAdmission 'type' '') -cne 'diagnostic_prep_publication_recovery_admission' -or
        [string](Get-BindingValue $recoveryAdmission 'version' '') -cne $script:RecoveryAdmissionVersion -or
        [string](Get-BindingValue $recoveryAdmission 'mode' '') -cne 'ResumePublication' -or
        [string](Get-BindingValue $recoveryAdmission 'runId' '') -cne $runId -or
        [string](Get-BindingValue $admissionManifest 'path' '') -cne $ManifestPath -or
        [string](Get-BindingValue $admissionManifest 'sha256' '') -cne $manifestSha256 -or
        [IO.Path]::GetFullPath([string](Get-BindingValue $admissionWorker 'path' '')) -cne $workerScriptPath -or
        [string](Get-BindingValue $admissionWorker 'sha256' '') -cne $workerScriptSha256 -or
        [IO.Path]::GetFullPath([string](Get-BindingValue $admissionSupervisorScript 'path' '')) -cne
            $supervisorScriptPath -or
        [string](Get-BindingValue $admissionSupervisorScript 'sha256' '') -cne $supervisorScriptSha256 -or
        [string](Get-BindingValue $recoveryAdmission 'recoveryNonceSha256' '') -cnotmatch '^[0-9a-f]{64}$' -or
        [IO.Path]::GetFullPath([string](Get-BindingValue $admissionControl 'statePath' '')) -cne
            [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $paths 'supervisorStatePath')) -or
        [IO.Path]::GetFullPath([string](Get-BindingValue $admissionControl 'recoveryResultPath' '')) -cne
            $recoveryResultPath -or
        [IO.Path]::GetFullPath([string](Get-BindingValue $admissionControl 'recoveryStdoutPath' '')) -cne
            [IO.Path]::GetFullPath((Join-Path $runRoot 'publication-recovery.stdout.log')) -or
        [IO.Path]::GetFullPath([string](Get-BindingValue $admissionControl 'recoveryStderrPath' '')) -cne
            [IO.Path]::GetFullPath((Join-Path $runRoot 'publication-recovery.stderr.log')) -or
        [string](Get-BindingValue $admissionControl 'runMutexName' '') -cne
            [string](Get-BindingRequiredValue $ticketControl 'runMutexName') -or
        [string](Get-BindingValue $admissionControl 'supervisorMutexName' '') -cne
            [string](Get-BindingRequiredValue $ticketControl 'supervisorMutexName') -or
        [IO.Path]::GetFullPath([string](Get-BindingValue $admissionControl 'supervisorLockPath' '')) -cne
            $runLockPath -or
        [string](Get-BindingValue (Get-BindingRequiredValue $recoveryAdmission 'originalTicket') 'path' '') -cne
            $SupervisorTicketPath -or
        [string](Get-BindingValue (Get-BindingRequiredValue $recoveryAdmission 'originalTicket') 'sha256' '') -cne
            $supervisorTicketSha256 -or
        [int](Get-BindingValue $admissionSupervisor 'pid' 0) -ne
            [int](Get-BindingValue $terminalSupervisor 'pid' 0) -or
        [string](Get-BindingValue $admissionSupervisor 'startedAtUtc' '') -cne
            [string](Get-BindingValue $terminalSupervisor 'startedAtUtc' '') -or
        -not [string]::Equals(
            [string](Get-BindingValue $admissionSupervisor 'path' ''),
            [string](Get-BindingValue $terminalSupervisor 'path' ''),
            [StringComparison]::OrdinalIgnoreCase) -or
        $originalResultEvidencePath -cne $initialResultPath -or
        $originalStateEvidencePath -cne
            [IO.Path]::GetFullPath((Join-Path $runRoot 'original-supervisor-state.private.json')) -or
        [string](Get-BindingValue $resultOriginal 'resultPath' '') -cne $originalResultEvidencePath -or
        [string](Get-BindingValue $admissionOriginal 'resultSha256' '') -cne
            [string](Get-BindingValue $resultOriginal 'resultSha256' '') -or
        [string](Get-BindingValue $resultOriginalState 'path' '') -cne $originalStateEvidencePath -or
        [string](Get-BindingValue $resultOriginalState 'sha256' '') -cne $originalStateEvidenceSha256 -or
        [string](Get-BindingValue $admissionOriginal 'fixturePreparationReceiptPath' '') -cne
            $FixturePreparationReceiptPath -or
        [string](Get-BindingValue $admissionOriginal 'fixturePreparationReceiptSha256' '') -cne
            $fixtureReceiptSha256 -or
        [int](Get-BindingValue $originalResultEvidence 'schemaVersion' 0) -ne 1 -or
        [string](Get-BindingValue $originalResultEvidence 'type' '') -cne
            'waf800_diagnostic_prep_supervisor_result' -or
        [string](Get-BindingValue $originalResultEvidence 'version' '') -cne $script:SupervisorResultVersion -or
        [string](Get-BindingValue $originalResultEvidence 'runId' '') -cne $runId -or
        [string](Get-BindingValue $originalResultEvidence 'status' '') -notin @('failed','timed_out','interrupted') -or
        (Get-BindingValue $originalResultEvidence 'terminalEvidenceCommitted' $false) -ne $true -or
        (Get-BindingValue $originalResultEvidence 'trafficStarted' $true) -ne $false -or
        (Get-BindingValue $originalResultEvidence 'leaseAcquired' $true) -ne $false -or
        (Get-BindingValue $originalResultEvidence 'rawErrorPersisted' $true) -ne $false -or
        [string](Get-BindingValue (Get-BindingRequiredValue $originalResultEvidence 'ticket') 'sha256' '') -cne
            $supervisorTicketSha256 -or
        [int](Get-BindingValue $originalResultSupervisor 'pid' 0) -ne
            [int](Get-BindingValue $ticketSupervisor 'pid' 0) -or
        [string](Get-BindingValue $originalResultSupervisor 'startedAtUtc' '') -cne
            [string](Get-BindingValue $ticketSupervisor 'startedAtUtc' '') -or
        -not [string]::Equals(
            [string](Get-BindingValue $originalResultSupervisor 'path' ''),
            [string](Get-BindingValue $ticketSupervisor 'path' ''),
            [StringComparison]::OrdinalIgnoreCase) -or
        [int](Get-BindingValue $originalStateEvidence 'schemaVersion' 0) -ne 1 -or
        [string](Get-BindingValue $originalStateEvidence 'type' '') -cne
            'waf800_diagnostic_prep_supervisor_state' -or
        [string](Get-BindingValue $originalStateEvidence 'runId' '') -cne $runId -or
        [string](Get-BindingValue $originalStateEvidence 'status' '') -cne
            [string](Get-BindingValue $originalResultEvidence 'status' '') -or
        [string](Get-BindingValue $originalStateEvidence 'resultPath' '') -cne $initialResultPath -or
        [int](Get-BindingValue $originalStateSupervisor 'pid' 0) -ne
            [int](Get-BindingValue $ticketSupervisor 'pid' 0) -or
        [string](Get-BindingValue $originalStateSupervisor 'startedAtUtc' '') -cne
            [string](Get-BindingValue $ticketSupervisor 'startedAtUtc' '') -or
        -not [string]::Equals(
            [string](Get-BindingValue $originalStateSupervisor 'path' ''),
            [string](Get-BindingValue $ticketSupervisor 'path' ''),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-BindingProcessObservationEqual $resultOriginalWorker $originalResultWorker) -or
        -not (Test-BindingProcessObservationEqual $resultOriginalWorker $originalStateWorker) -or
        [string](Get-BindingValue $resultOriginalOwnership 'path' '') -cne $originalWorkerOwnership.path -or
        [string](Get-BindingValue $resultOriginalOwnership 'sha256' '') -cne $originalWorkerOwnership.sha256 -or
        [string](Get-BindingValue $originalResultOwnership 'path' '') -cne $originalWorkerOwnership.path -or
        [string](Get-BindingValue $originalResultOwnership 'sha256' '') -cne $originalWorkerOwnership.sha256 -or
        [string](Get-BindingValue $originalStateOwnership 'path' '') -cne $originalWorkerOwnership.path -or
        [string](Get-BindingValue $originalStateOwnership 'sha256' '') -cne $originalWorkerOwnership.sha256) {
        throw 'Publication recovery admission is not bound to the original immutable supervision evidence.'
    }
    $resultRecoveryReceipt = Get-BindingRequiredValue $supervisorResult 'publicationRecoveryReceipt'
    $recoveryReceiptPath = Resolve-BindingExternalPath `
        ([string](Get-BindingRequiredValue $resultRecoveryReceipt 'path')) `
        'publication recovery receipt'
    $recoveryReceiptSha256 = Assert-BindingSha256 `
        ([string](Get-BindingRequiredValue $resultRecoveryReceipt 'sha256')) `
        'publication recovery receipt sha256'
    $expectedRecoveryReceiptPath = $manifestRecoveryReceiptPath
    Assert-BindingPrivateFileAcl $recoveryReceiptPath 'Publication recovery receipt'
    if ($recoveryReceiptPath -cne $expectedRecoveryReceiptPath -or
        (Get-BindingFileSha256 $recoveryReceiptPath) -cne $recoveryReceiptSha256) {
        throw 'Publication recovery receipt changed or drifted from the manifest.'
    }
    $recoveryReceipt = Read-BindingJson $recoveryReceiptPath 'Publication recovery receipt'
    Assert-BindingExactKeys $recoveryReceipt @(
        'schemaVersion','type','version','status','runId','manifestSha256',
        'fixturePreparationReceiptSha256','recoveryNonceSha256',
        'supervisorAdmissionSha256','supervisorAdmissionNonceSha256',
        'originalSupervisorTicketSha256','admittedAtUtc'
    ) @() 'Publication recovery receipt'
    $recoveryAdmittedAtUtc = [string](Get-BindingRequiredValue $recoveryReceipt 'admittedAtUtc')
    $parsedRecoveryAdmittedAtUtc = [DateTimeOffset]::MinValue
    $sealedRecoveryNonceSha256 = Get-BindingTextSha256 `
        ([string](Get-BindingRequiredValue (Get-BindingRequiredValue $receipt 'recovery') 'nonce'))
    if ([int](Get-BindingValue $recoveryReceipt 'schemaVersion' 0) -ne 1 -or
        [string](Get-BindingValue $recoveryReceipt 'type' '') -cne
            'fixture_publication_recovery_receipt' -or
        [string](Get-BindingValue $recoveryReceipt 'version' '') -cne $script:RecoveryReceiptVersion -or
        [string](Get-BindingValue $recoveryReceipt 'status' '') -cne 'admitted' -or
        [string](Get-BindingValue $recoveryReceipt 'runId' '') -cne $runId -or
        [string](Get-BindingValue $recoveryReceipt 'manifestSha256' '') -cne $manifestSha256 -or
        [string](Get-BindingValue $recoveryReceipt 'fixturePreparationReceiptSha256' '') -cne
            $fixtureReceiptSha256 -or
        [string](Get-BindingValue $recoveryReceipt 'recoveryNonceSha256' '') -cne
            $sealedRecoveryNonceSha256 -or
        [string](Get-BindingValue $recoveryReceipt 'supervisorAdmissionSha256' '') -cne
            $recoveryAdmissionSha256 -or
        [string](Get-BindingValue $recoveryReceipt 'supervisorAdmissionNonceSha256' '') -cne
            [string](Get-BindingRequiredValue $recoveryAdmission 'recoveryNonceSha256') -or
        [string](Get-BindingValue $recoveryReceipt 'originalSupervisorTicketSha256' '') -cne
            $supervisorTicketSha256 -or
        -not [DateTimeOffset]::TryParseExact(
            $recoveryAdmittedAtUtc, 'o', [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None, [ref]$parsedRecoveryAdmittedAtUtc
        ) -or $parsedRecoveryAdmittedAtUtc.Offset -ne [TimeSpan]::Zero) {
        throw 'Publication recovery receipt identity is invalid.'
    }
}
$leaseReceiptSha256 = $null
if ($diagnosticEligible) {
    if ([string]::IsNullOrWhiteSpace($DatabaseInsightsLeaseReceiptPath) -or
        [string]::IsNullOrWhiteSpace($ExpectedDatabaseInsightsLeaseReceiptSha256)) {
        throw 'Eligible binding requires the exact Database Insights lease receipt and SHA-256.'
    }
    $DatabaseInsightsLeaseReceiptPath = Resolve-BindingExternalPath $DatabaseInsightsLeaseReceiptPath `
        'DatabaseInsightsLeaseReceiptPath'
    $leaseReceiptSha256 = Assert-BindingSha256 $ExpectedDatabaseInsightsLeaseReceiptSha256 `
        'ExpectedDatabaseInsightsLeaseReceiptSha256'
    Assert-BindingPrivateFileAcl $DatabaseInsightsLeaseReceiptPath 'Database Insights lease receipt'
    if ((Get-BindingFileSha256 $DatabaseInsightsLeaseReceiptPath) -cne $leaseReceiptSha256 -or
        [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $paths 'leaseReceiptPath')) -cne
            $DatabaseInsightsLeaseReceiptPath) {
        throw 'Database Insights lease receipt changed or drifted from the manifest path.'
    }
} elseif (-not [string]::IsNullOrWhiteSpace($DatabaseInsightsLeaseReceiptPath) -or
    -not [string]::IsNullOrWhiteSpace($ExpectedDatabaseInsightsLeaseReceiptSha256) -or
    -not [string]::IsNullOrWhiteSpace($ExpectedGeneratorPublicIp)) {
    throw 'Offline rehearsal binding forbids Database Insights lease and generator-IP inputs.'
}

$release = Get-BindingRequiredValue $manifest 'release'
$applicationGitSha = ([string](Get-BindingRequiredValue $release 'applicationGitSha')).ToLowerInvariant()
$controllerGitSha = ([string](Get-BindingRequiredValue $release 'controllerGitSha')).ToLowerInvariant()
$imageDigest = Assert-BindingSha256 ([string](Get-BindingRequiredValue $release 'deployedImageDigest')) `
    'release.deployedImageDigest' -ImageDigest
$apiArn = [string](Get-BindingRequiredValue $release 'apiTaskDefinitionArn')
$workerArn = [string](Get-BindingRequiredValue $release 'workerTaskDefinitionArn')
if ($applicationGitSha -notmatch '^[0-9a-f]{40}$' -or $controllerGitSha -cne $applicationGitSha -or
    $apiArn -notmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api(?:-emergency)?:[1-9][0-9]*$' -or
    $workerArn -notmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:[1-9][0-9]*$') {
    throw 'The preparation manifest release identity is invalid.'
}
$head = @(& git -C $script:RepositoryRoot rev-parse HEAD 2>$null)
$headExit = $LASTEXITCODE
if ($headExit -ne 0 -or $head.Count -ne 1 -or
    ([string]$head[0]).Trim().ToLowerInvariant() -cne $applicationGitSha) {
    throw 'Binding requires repository HEAD at the manifest release.'
}
if ($diagnosticEligible) {
    $origin = @(& git -C $script:RepositoryRoot rev-parse origin/main 2>$null)
    $originExit = $LASTEXITCODE
    $branch = @(& git -C $script:RepositoryRoot branch --show-current 2>$null)
    $branchExit = $LASTEXITCODE
    $dirty = @(& git -C $script:RepositoryRoot status --porcelain 2>$null)
    $dirtyExit = $LASTEXITCODE
    if ($originExit -ne 0 -or $branchExit -ne 0 -or $dirtyExit -ne 0 -or
        $origin.Count -ne 1 -or $branch.Count -ne 1 -or $dirty.Count -ne 0 -or
        ([string]$origin[0]).Trim().ToLowerInvariant() -cne $applicationGitSha -or
        ([string]$branch[0]).Trim() -cne 'main') {
        throw 'Diagnostic-eligible binding requires clean main equal to origin/main at the deployed release.'
    }
}

$controllerArtifacts = @((Get-BindingRequiredValue $manifest 'controllerArtifacts'))
$controllerHashes = [ordered]@{}
$controllerRevalidationFiles = [Collections.Generic.List[object]]::new()
$seenKinds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($artifact in $controllerArtifacts) {
    $kind = [string](Get-BindingRequiredValue $artifact 'kind')
    $relativePath = [string](Get-BindingRequiredValue $artifact 'path')
    $expectedHash = Assert-BindingSha256 ([string](Get-BindingRequiredValue $artifact 'sha256')) `
        "controllerArtifacts.$kind.sha256"
    if (-not $seenKinds.Add($kind)) {
        throw 'Controller artifact identities must be unique.'
    }
    $path = if ([IO.Path]::IsPathRooted($relativePath)) {
        [IO.Path]::GetFullPath($relativePath)
    } else { [IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot $relativePath)) }
    $prefix = $script:RepositoryRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        (Get-BindingFileSha256 $path) -cne $expectedHash) {
        throw "Controller artifact '$kind' drifted after manifest review."
    }
    $controllerHashes[$kind] = $expectedHash
    $controllerRevalidationFiles.Add([pscustomobject]@{
        name = "Controller artifact '$kind'"
        path = $path
        sha256 = $expectedHash
        private = $false
    })
}
foreach ($requiredKind in @(
    'prep-supervisor','fixture-worker','diagnostic-binder','coordinator','monitor','harness',
    'monotonic-deadline','tile-poll-accounting','database-insights-lease'
)) {
    if (-not $seenKinds.Contains($requiredKind)) { throw "Controller artifact '$requiredKind' is required." }
}

$receiptManifest = Get-BindingRequiredValue $receipt 'manifest'
$receiptRelease = Get-BindingRequiredValue $receipt 'release'
$receiptSnapshot = Get-BindingRequiredValue $receipt 'snapshot'
$receiptJournal = Get-BindingRequiredValue $receipt 'journal'
[void](Assert-BindingFixturePreparationReceiptShape $receipt)
if ([int](Get-BindingValue $receipt 'schemaVersion' 0) -ne 1 -or
    [string](Get-BindingValue $receipt 'type' '') -cne 'fixture_preparation_receipt' -or
    [string](Get-BindingValue $receipt 'version' '') -cne $script:ReceiptVersion -or
    [string](Get-BindingValue $receipt 'status' '') -cne 'sources_sealed' -or
    [string](Get-BindingValue $receipt 'runId' '') -cne $runId -or
    (Get-BindingValue $receipt 'diagnosticOnly' $false) -ne $true -or
    (Get-BindingValue $receipt 'diagnosticEligible' $null) -isnot [bool] -or
    [bool](Get-BindingValue $receipt 'diagnosticEligible' $null) -ne $diagnosticEligible -or
    (Get-BindingValue $receipt 'certificationEligible' $true) -ne $false -or
    [string](Get-BindingValue $receiptManifest 'path' '') -cne $ManifestPath -or
    [string](Get-BindingValue $receiptManifest 'sha256' '') -cne $manifestSha256 -or
    (ConvertTo-Json -InputObject (Get-BindingRequiredValue $receipt 'controllerArtifacts') -Depth 30 -Compress) -cne
        (ConvertTo-Json -InputObject $controllerArtifacts -Depth 30 -Compress) -or
    (ConvertTo-Json -InputObject $receiptRelease -Depth 20 -Compress) -cne
        (ConvertTo-Json -InputObject $release -Depth 20 -Compress)) {
    throw 'Fixture preparation receipt is ineligible, reconstructed, or identity-drifted.'
}
$execution = Get-BindingRequiredValue $receipt 'execution'
if ([int](Get-BindingValue $execution 'refreshExitCode' -1) -ne 0 -or
    [int](Get-BindingValue $execution 'verificationExitCode' -1) -ne 0) {
    throw 'Fixture preparation did not complete refresh and verification successfully.'
}

$journalPath = Resolve-BindingExternalPath ([string](Get-BindingRequiredValue $receiptJournal 'path')) `
    'fixture preparation journal'
if ($journalPath -cne [IO.Path]::GetFullPath([string](Get-BindingRequiredValue $paths 'journalPath'))) {
    throw 'Fixture preparation journal path drifted from the manifest.'
}
Assert-BindingPrivateFileAcl $journalPath 'Fixture preparation journal'
$journalBytes = [IO.File]::ReadAllBytes($journalPath)
$journalSha256 = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($journalBytes)
).ToLowerInvariant()
if ($journalBytes.Length -eq 0 -or $journalBytes[-1] -ne 0x0a) {
    throw 'Fixture preparation journal ends with an uncommitted partial record.'
}
$journalRecords = @()
try {
    $journalRecords = @(Get-Content -LiteralPath $journalPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json -DateKind String -Depth 60 })
}
catch { throw 'Fixture preparation journal must be complete JSONL.' }
if ($journalRecords.Count -lt 2) { throw 'Fixture preparation journal is incomplete.' }
[void](Assert-BindingJournalTimestampSequence $journalRecords)
$previousHash = $null
for ($index = 0; $index -lt $journalRecords.Count; $index++) {
    $record = $journalRecords[$index]
    Assert-BindingExactKeys $record @(
        'schemaVersion','type','version','sequence','runId','manifestSha256',
        'timestampUtc','stage','status','process','exitCode','artifactHashes',
        'previousRecordHash','failureCode','failureStage','recordHash'
    ) @() 'fixture preparation journal record'
    $recordPreviousHash = Get-BindingValue $record 'previousRecordHash' $null
    $previousHashMatches = if ($null -eq $previousHash) {
        $null -eq $recordPreviousHash
    } else { [string]$recordPreviousHash -ceq $previousHash }
    if ([int](Get-BindingValue $record 'schemaVersion' 0) -ne 1 -or
        [string](Get-BindingValue $record 'type' '') -cne 'diagnostic_prep_journal_record' -or
        [string](Get-BindingValue $record 'version' '') -cne $script:JournalVersion -or
        [int](Get-BindingValue $record 'sequence' 0) -ne ($index + 1) -or
        [string](Get-BindingValue $record 'runId' '') -cne $runId -or
        [string](Get-BindingValue $record 'manifestSha256' '') -cne $manifestSha256 -or
        -not $previousHashMatches) {
        throw 'Fixture preparation journal chain is invalid.'
    }
    $recordHash = Assert-BindingSha256 ([string](Get-BindingRequiredValue $record 'recordHash')) `
        'fixture preparation journal recordHash'
    if ((Get-BindingJournalRecordHash $record) -cne $recordHash) {
        throw 'Fixture preparation journal record hash validation failed.'
    }
    $previousHash = $recordHash
}
[void](Assert-BindingJournalStateMachine $journalRecords $manifest $resultKind)
[void](Assert-BindingFixtureChildEvidence $journalRecords $manifest $receipt `
    $workerScriptSha256 $supervisorTicketSha256)
[void](Assert-BindingWorkerProvenance $journalRecords $receiptWorkerProcess $originalTerminalWorker `
    $terminalWorker $resultKind `
    ([string](Get-BindingRequiredValue (Get-BindingRequiredValue $manifest 'fixture') 'provider')))
$terminal = $journalRecords[-1]
$terminalHashes = Get-BindingRequiredValue $terminal 'artifactHashes'
$snapshotArtifactSetSha256 = Assert-BindingSha256 `
    ([string](Get-BindingRequiredValue $terminalHashes 'snapshotArtifactSetSha256')) `
    'snapshotArtifactSetSha256'
if ([string](Get-BindingValue $terminal 'stage' '') -cne 'terminal_commit' -or
    [string](Get-BindingValue $terminal 'status' '') -cne 'completed' -or
    [string](Get-BindingValue $resultJournal 'sha256' '') -cne $journalSha256 -or
    [string](Get-BindingValue $resultJournal 'terminalHash' '') -cne $previousHash -or
    [string](Get-BindingValue $terminalHashes 'fixturePreparationReceiptSha256' '') -cne $fixtureReceiptSha256) {
    throw 'Fixture preparation journal does not prove completed atomic publication.'
}
$sourceSealRecords = @($journalRecords | Where-Object {
    [string](Get-BindingValue $_ 'stage' '') -ceq 'source_hashes_sealed' -and
    [string](Get-BindingValue $_ 'status' '') -ceq 'completed'
})
$receiptSealRecords = @($journalRecords | Where-Object {
    [string](Get-BindingValue $_ 'stage' '') -ceq 'fixture_receipt_sealed' -and
    [string](Get-BindingValue $_ 'status' '') -ceq 'completed'
})
$requiredAttemptStages = @(
    @('preflight_accepted','completed'), @('refresh_admitted','running'),
    @('refresh_completed','completed'), @('verify_admitted','running'),
    @('verify_completed','completed'), @('freshness_accepted','completed')
)
foreach ($stageContract in $requiredAttemptStages) {
    $stageRecords = @($journalRecords | Where-Object {
        [string](Get-BindingValue $_ 'stage' '') -ceq $stageContract[0] -and
        [string](Get-BindingValue $_ 'status' '') -ceq $stageContract[1]
    })
    if ($stageRecords.Count -ne 1 -or
        ($stageContract[0] -in @('refresh_completed','verify_completed') -and
            [int](Get-BindingValue $stageRecords[0] 'exitCode' -1) -ne 0)) {
        throw 'Fixture preparation journal violates the exact one-attempt stage contract.'
    }
}
if ($sourceSealRecords.Count -ne 1 -or $receiptSealRecords.Count -ne 1 -or
    [string](Get-BindingValue $receiptJournal 'sourceSealedRecordHash' '') -cne
        [string](Get-BindingRequiredValue $sourceSealRecords[0] 'recordHash')) {
    throw 'Fixture preparation receipt does not bind the unique sealed source record.'
}
$receiptSealHashes = Get-BindingRequiredValue $receiptSealRecords[0] 'artifactHashes'
if ([string](Get-BindingValue $receiptSealHashes 'fixturePreparationReceiptSha256' '') -cne
        $fixtureReceiptSha256 -or
    [string](Get-BindingValue $receiptSealHashes 'snapshotArtifactSetSha256' '') -cne
        $snapshotArtifactSetSha256) {
    throw 'Fixture preparation journal does not bind the immutable receipt before publication.'
}
if ($resultKind -ceq 'recovery') {
    $recoveryStartedRecords = @($journalRecords | Where-Object {
        [string](Get-BindingValue $_ 'stage' '') -ceq 'publication_recovery_started' -and
        [string](Get-BindingValue $_ 'status' '') -ceq 'running'
    })
    $recoveryCompletedRecords = @($journalRecords | Where-Object {
        [string](Get-BindingValue $_ 'stage' '') -ceq 'publication_recovery_completed' -and
        [string](Get-BindingValue $_ 'status' '') -ceq 'completed'
    })
    if ($recoveryStartedRecords.Count -ne 1 -or $recoveryCompletedRecords.Count -ne 1 -or
        [string](Get-BindingValue (Get-BindingRequiredValue $recoveryStartedRecords[0] 'artifactHashes') `
            'publicationRecoveryReceiptSha256' '') -cne $recoveryReceiptSha256 -or
        [string](Get-BindingValue (Get-BindingRequiredValue $recoveryCompletedRecords[0] 'artifactHashes') `
            'publicationRecoveryReceiptSha256' '') -cne $recoveryReceiptSha256 -or
        [string](Get-BindingValue $terminalHashes 'publicationRecoveryReceiptSha256' '') -cne
            $recoveryReceiptSha256) {
        throw 'Fixture preparation journal does not bind the exact one-use recovery receipt.'
    }
} elseif ($null -ne (Get-BindingValue $terminalHashes 'publicationRecoveryReceiptSha256' $null)) {
    throw 'An initial fixture preparation must not bind publication-recovery evidence.'
}

$snapshotRoot = Resolve-BindingExternalPath ([string](Get-BindingRequiredValue $paths 'snapshotRoot')) `
    'paths.snapshotRoot' -Directory
if ([string](Get-BindingValue $receiptSnapshot 'root' '') -cne $snapshotRoot) {
    throw 'Fixture preparation receipt snapshot root drifted from the manifest.'
}
Assert-BindingPrivateDirectoryAcl $snapshotRoot 'Fixture preparation snapshot root'
$snapshotEntries = @(Get-ChildItem -LiteralPath $snapshotRoot -Force)
if ($snapshotEntries.Count -ne 5 -or
    @($snapshotEntries | Where-Object { $_.PSIsContainer }).Count -ne 0 -or
    @(Compare-Object $script:RequiredSnapshotNames @($snapshotEntries.Name | Sort-Object)).Count -ne 0) {
    throw 'Fixture preparation snapshot root must contain exactly the five sealed artifacts.'
}
$receiptArtifacts = @((Get-BindingRequiredValue $receiptSnapshot 'artifacts'))
if ($receiptArtifacts.Count -ne 5 -or
    @(Compare-Object $script:RequiredSnapshotNames @($receiptArtifacts.name | ForEach-Object { [string]$_ } | Sort-Object)).Count -ne 0) {
    throw 'Fixture preparation must bind exactly the five private snapshot artifacts.'
}
$snapshotArtifacts = @()
$artifactSetInput = @()
foreach ($name in $script:RequiredSnapshotNames) {
    $artifact = @($receiptArtifacts | Where-Object { [string]$_.name -ceq $name })
    if ($artifact.Count -ne 1) { throw "Fixture artifact '$name' is ambiguous." }
    $path = Resolve-BindingExternalPath ([string](Get-BindingRequiredValue $artifact[0] 'targetPath')) `
        "fixture artifact $name"
    $sha256 = Assert-BindingSha256 ([string](Get-BindingRequiredValue $artifact[0] 'sha256')) `
        "fixture artifact $name sha256"
    $size = [long](Get-BindingRequiredValue $artifact[0] 'size')
    $lastWriteTimeUtc = [string](Get-BindingRequiredValue $artifact[0] 'lastWriteTimeUtc')
    if ($path -cne [IO.Path]::GetFullPath((Join-Path $snapshotRoot $name)) -or
        (Get-Item -LiteralPath $path).Length -ne $size -or (Get-BindingFileSha256 $path) -cne $sha256) {
        throw "Fixture artifact '$name' drifted from its sealed receipt."
    }
    Assert-BindingPrivateFileAcl $path "Fixture artifact $name"
    $snapshotArtifacts += [ordered]@{name=$name;path=$path;sha256=$sha256;size=$size;lastWriteTimeUtc=$lastWriteTimeUtc}
    $artifactSetInput += [ordered]@{name=$name;sha256=$sha256;size=$size;lastWriteTimeUtc=$lastWriteTimeUtc}
}
if ((Get-BindingSnapshotArtifactSetSha256 $artifactSetInput) -cne
        $snapshotArtifactSetSha256 -or
    [string](Get-BindingValue $receiptSnapshot 'artifactSetSha256' '') -cne
        $snapshotArtifactSetSha256) {
    throw 'Fixture snapshot artifact-set hash validation failed.'
}

$verificationArtifact = @($snapshotArtifacts | Where-Object { $_.name -ceq 'verification.private.json' })[0]
$stateArtifact = @($snapshotArtifacts | Where-Object { $_.name -ceq 'fixture-state.private.json' })[0]
$verification = Read-BindingJson $verificationArtifact.path 'Fixture verification' 40
$state = Read-BindingJson $stateArtifact.path 'Fixture state' 50
$fixture = Get-BindingRequiredValue $manifest 'fixture'
$fixtureId = [string](Get-BindingRequiredValue $fixture 'fixtureId')
$fixtureProvider = [string](Get-BindingRequiredValue $fixture 'provider')
$maximumAgeMinutes = [int](Get-BindingRequiredValue $fixture 'requiredVerificationMaximumAgeMinutes')
$requiredValiditySeconds = [int](Get-BindingRequiredValue $fixture 'requiredArtifactValiditySeconds')
$verifiedAt = [DateTimeOffset]::Parse([string](Get-BindingRequiredValue $verification 'verifiedAt'), [Globalization.CultureInfo]::InvariantCulture)
$refreshedAt = [DateTimeOffset]::Parse([string](Get-BindingRequiredValue $state 'refreshedAt'), [Globalization.CultureInfo]::InvariantCulture)
$verificationAgeMinutes = ([DateTimeOffset]::UtcNow - $verifiedAt).TotalMinutes
$expectedFixtureProvider = if ($diagnosticEligible) { 'production' } else { 'offline-fake' }
$fixtureBaseUrl = [string](Get-BindingRequiredValue $fixture 'baseUrl')
$fixtureBaseUri = $null
if (-not [Uri]::TryCreate($fixtureBaseUrl, [UriKind]::Absolute, [ref]$fixtureBaseUri) -or
    $fixtureBaseUri.Scheme -cne 'https') {
    throw 'Fixture preparation receipt base URL is invalid.'
}
if ($fixtureProvider -cne $expectedFixtureProvider -or
    ($diagnosticEligible -and $fixtureBaseUrl -cne 'https://school-pilot.net') -or
    (-not $diagnosticEligible -and
        -not $fixtureBaseUri.Host.EndsWith('.invalid', [StringComparison]::OrdinalIgnoreCase)) -or
    $maximumAgeMinutes -ne 60 -or $requiredValiditySeconds -ne 2700 -or
    $verificationAgeMinutes -lt 0 -or $verificationAgeMinutes -gt $maximumAgeMinutes -or $verifiedAt -lt $refreshedAt -or
    [int](Get-BindingValue $verification 'schemaVersion' 0) -ne 1 -or
    [string](Get-BindingValue $verification 'fixtureId' '') -cne $fixtureId -or
    (Get-BindingValue $verification 'passed' $false) -ne $true) {
    throw 'Fixture verification identity, freshness, or chronology is invalid.'
}
$counts = Get-BindingRequiredValue $verification 'counts'
$gates = Get-BindingRequiredValue $verification 'gates'
if ([int]$counts.schools -ne 2 -or [int]$counts.teachers -ne 20 -or [int]$counts.officeStaff -ne 1 -or
    [int]$counts.students -ne 1010 -or [int]$counts.classes -ne 20 -or [int]$counts.classRosterStudents -ne 800 -or
    [int]$counts.devices -ne 1010 -or [int]$counts.activeDeviceSessions -ne 1010 -or
    [int]$counts.activeSessions -ne 20 -or [int]$counts.commandBodies -ne 20 -or
    [int]$counts.authorizationPlanCohorts.coTeacherStudents -ne 40 -or
    [int]$counts.authorizationPlanCohorts.officeSupervisionStudents -ne 40 -or
    [int]$counts.liveAuth.commandAdministrators -ne 1 -or [int]$counts.liveAuth.teachers -ne 20) {
    throw 'Fixture verification does not prove the exact diagnostic inventory.'
}
foreach ($gateName in @(
    'autoEnrollDisabled','trackingDisabled','schedulesDisabled','exactSchoolTimezones',
    'classRostersExactAndDisjoint','authorizationPlanCohortsExact',
    'authorizationPlanOfficeStudentsOutsideTeacherRosters','allDeviceTokensLive','allStaffAuthArtifactsLive'
)) {
    if ((Get-BindingValue $gates $gateName $false) -ne $true) { throw "Fixture gate failed: $gateName" }
}
$sanitizedCounts = [ordered]@{
    schools=[int]$counts.schools;teachers=[int]$counts.teachers;officeStaff=[int]$counts.officeStaff
    students=[int]$counts.students;classes=[int]$counts.classes
    classRosterStudents=[int]$counts.classRosterStudents;devices=[int]$counts.devices
    activeDeviceSessions=[int]$counts.activeDeviceSessions;activeSessions=[int]$counts.activeSessions
    commandBodies=[int]$counts.commandBodies
    authorizationPlanCohorts=[ordered]@{
        coTeacherStudents=[int]$counts.authorizationPlanCohorts.coTeacherStudents
        officeSupervisionStudents=[int]$counts.authorizationPlanCohorts.officeSupervisionStudents
    }
    liveAuth=[ordered]@{
        commandAdministrators=[int]$counts.liveAuth.commandAdministrators
        teachers=[int]$counts.liveAuth.teachers
    }
}
$sanitizedGates = [ordered]@{}
foreach ($gateName in @(
    'autoEnrollDisabled','trackingDisabled','schedulesDisabled','exactSchoolTimezones',
    'classRostersExactAndDisjoint','authorizationPlanCohortsExact',
    'authorizationPlanOfficeStudentsOutsideTeacherRosters','allDeviceTokensLive','allStaffAuthArtifactsLive'
)) { $sanitizedGates[$gateName] = [bool](Get-BindingValue $gates $gateName $false) }
$verificationCountsAndGatesSha256 = Get-BindingCanonicalSha256 ([ordered]@{
    counts=$sanitizedCounts;gates=$sanitizedGates
})
$receiptVerification = Get-BindingRequiredValue $receipt 'verification'
$receiptAdmission = Get-BindingRequiredValue $receipt 'supervisorAdmission'
if ([string](Get-BindingValue $receiptVerification 'artifactSha256' '') -cne $verificationArtifact.sha256 -or
    [string](Get-BindingValue $receiptVerification 'countsAndGatesSha256' '') -cne
        $verificationCountsAndGatesSha256 -or
    (ConvertTo-Json -InputObject (Get-BindingRequiredValue $receiptVerification 'counts') -Depth 20 -Compress) -cne
        (ConvertTo-Json -InputObject $sanitizedCounts -Depth 20 -Compress) -or
    (ConvertTo-Json -InputObject (Get-BindingRequiredValue $receiptVerification 'gates') -Depth 20 -Compress) -cne
        (ConvertTo-Json -InputObject $sanitizedGates -Depth 20 -Compress) -or
    [string](Get-BindingValue $receiptAdmission 'type' '') -cne 'diagnostic_prep_supervisor_ticket' -or
    [string](Get-BindingValue $receiptAdmission 'version' '') -cne $script:SupervisorTicketVersion -or
    [string](Get-BindingValue $receiptAdmission 'sha256' '') -cne $supervisorTicketSha256 -or
    $null -ne (Get-BindingValue $receiptAdmission 'originalTicketSha256' $null)) {
    throw 'Fixture preparation receipt verification or supervisor-admission binding is invalid.'
}
$expectedTerminalAdmissionSha256 = if ($resultKind -ceq 'initial') {
    $supervisorTicketSha256
} else { $recoveryAdmissionSha256 }
if ([string](Get-BindingValue $terminalHashes 'verificationCountsAndGatesSha256' '') -cne
        $verificationCountsAndGatesSha256 -or
    [string](Get-BindingValue $terminalHashes 'supervisorAdmissionSha256' '') -cne
        $expectedTerminalAdmissionSha256) {
    throw 'Fixture preparation terminal journal does not bind verification and supervised admission evidence.'
}

$deviceArtifact = @($snapshotArtifacts | Where-Object { $_.name -ceq 'load-devices.private.json' })[0]
$authArtifact = @($snapshotArtifacts | Where-Object { $_.name -ceq 'load-auth.private.json' })[0]
$commandsArtifact = @($snapshotArtifacts | Where-Object { $_.name -ceq 'load-command-bodies.private.json' })[0]
$devices = @(Get-Content -LiteralPath $deviceArtifact.path -Raw | ConvertFrom-Json -DateKind String -Depth 30)
$auth = Get-Content -LiteralPath $authArtifact.path -Raw | ConvertFrom-Json -DateKind String -Depth 40
$commands = @(Get-Content -LiteralPath $commandsArtifact.path -Raw | ConvertFrom-Json -DateKind String -Depth 30)
$requiredValidity = [DateTimeOffset]::UtcNow.AddSeconds($requiredValiditySeconds)
if ($devices.Count -ne 1010 -or $commands.Count -ne 20 -or @($auth.teacherAuth).Count -ne 20 -or
    [DateTimeOffset]$auth.expiresAt -le $requiredValidity -or
    [DateTimeOffset]$auth.deviceManifestExpiresAt -le $requiredValidity) {
    throw 'Fixture harness artifacts are inexact or expire before the diagnostic safety margin.'
}

if ($diagnosticEligible) {
$queryReference = Get-BindingRequiredValue $manifest 'historyFallbackQueryIdentity'
if ([string](Get-BindingRequiredValue $queryReference 'version') -cne 'history-fallback-queryid-v1') {
    throw 'History-fallback query identity version is ineligible.'
}
$queryPath = Resolve-BindingExternalPath ([string](Get-BindingRequiredValue $queryReference 'path')) `
    'historyFallbackQueryIdentity.path'
$querySha = Assert-BindingSha256 ([string](Get-BindingRequiredValue $queryReference 'sha256')) `
    'historyFallbackQueryIdentity.sha256'
Assert-BindingPrivateFileAcl $queryPath 'History-fallback query identity receipt'
if ((Get-BindingFileSha256 $queryPath) -cne $querySha) { throw 'History-fallback query identity receipt drifted.' }
$queryReceipt = Read-BindingJson $queryPath 'History-fallback query identity receipt' 40
$queryIdentifier = [string](Get-BindingRequiredValue $queryReceipt 'queryIdentifier')
$parsedQueryIdentifier = 0L
if ([int](Get-BindingValue $queryReceipt 'schemaVersion' 0) -ne 1 -or
    [string](Get-BindingValue $queryReceipt 'type' '') -cne 'history_fallback_query_identity_receipt' -or
    [string](Get-BindingValue $queryReceipt 'identityVersion' '') -cne 'history-fallback-queryid-v1' -or
    -not [long]::TryParse($queryIdentifier, [Globalization.NumberStyles]::AllowLeadingSign,
        [Globalization.CultureInfo]::InvariantCulture, [ref]$parsedQueryIdentifier) -or
    $parsedQueryIdentifier -eq 0 -or (Get-BindingTextSha256 $queryIdentifier) -cne
        [string](Get-BindingRequiredValue $queryReceipt 'queryIdentifierSha256') -or
    [string](Get-BindingValue $queryReceipt 'applicationGitSha' '') -cne $applicationGitSha -or
    [string](Get-BindingValue $queryReceipt 'deployedImageDigest' '') -cne $imageDigest -or
    [string](Get-BindingValue $queryReceipt 'activeApiTaskDefinitionArn' '') -cne $apiArn -or
    [string](Get-BindingValue $queryReceipt 'activeWorkerTaskDefinitionArn' '') -cne $workerArn -or
    (Get-BindingValue $queryReceipt 'trackIoTiming' $false) -ne $true) {
    throw 'History-fallback query identity does not bind the exact active release.'
}

$leaseManifest = Get-BindingRequiredValue $manifest 'databaseInsightsLease'
if ([string](Get-BindingRequiredValue $leaseManifest 'version') -cne 'database-insights-monitoring-lease-v3' -or
    [string](Get-BindingRequiredValue $leaseManifest 'leasePurpose') -cne 'diagnostic') {
    throw 'Database Insights lease invocation drifted from the preparation manifest.'
}
$leaseReceipt = Read-BindingJson $DatabaseInsightsLeaseReceiptPath 'Database Insights lease receipt' 60
$durableGuard = Get-BindingValue $leaseReceipt 'durableRestoreGuard' $null
if ([int](Get-BindingValue $leaseReceipt 'schemaVersion' 0) -ne 3 -or
    [string](Get-BindingValue $leaseReceipt 'type' '') -cne 'database_insights_monitoring_lease' -or
    [string](Get-BindingValue $leaseReceipt 'leaseVersion' '') -cne 'database-insights-monitoring-lease-v3' -or
    [string](Get-BindingValue $leaseReceipt 'leasePurpose' '') -cne 'diagnostic' -or
    [string](Get-BindingValue $leaseReceipt 'accountId' '') -cne '135775632425' -or
    [string](Get-BindingValue $leaseReceipt 'region' '') -cne 'us-east-1' -or
    [string](Get-BindingValue $leaseReceipt 'dbInstanceIdentifier' '') -cne 'schoolpilot-production-db' -or
    [string](Get-BindingValue $leaseReceipt 'expectedRdsInstanceClass' '') -cne 'db.t4g.medium' -or
    [string](Get-BindingValue $leaseReceipt.initialPosture 'databaseInsightsMode' '') -cne 'standard' -or
    [int](Get-BindingValue $leaseReceipt.initialPosture 'performanceInsightsRetentionPeriod' 0) -ne 7 -or
    [string](Get-BindingValue $leaseReceipt.requestedPosture 'databaseInsightsMode' '') -cne 'advanced' -or
    [int](Get-BindingValue $leaseReceipt.requestedPosture 'performanceInsightsRetentionPeriod' 0) -ne 465 -or
    [string](Get-BindingValue $durableGuard 'version' '') -cne 'aws-scheduler-ssm-recurring-restore-v2' -or
    [string](Get-BindingValue $durableGuard 'automationVersion' '') -cne 'ssm-rds-monitoring-restore-v2' -or
    [string](Get-BindingValue $durableGuard 'automationDocumentName' '') -cne 'schoolpilot-production-db-insights-restore-v2' -or
    [string](Get-BindingValue $durableGuard 'automationDocumentVersion' '') -cne '1') {
    throw 'Database Insights lease is not the exact live diagnostic v3 lease.'
}
foreach ($suffix in @('.status.json','.watchdog.json')) {
    if (-not (Test-Path -LiteralPath ($DatabaseInsightsLeaseReceiptPath + $suffix) -PathType Leaf)) {
        throw "Database Insights lease artifact is missing: $suffix"
    }
}

$address = $null
if (-not [Net.IPAddress]::TryParse($ExpectedGeneratorPublicIp, [ref]$address) -or
    $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'ExpectedGeneratorPublicIp must be an IPv4 literal.'
}
$observedIp = ([string](Invoke-RestMethod -Uri 'https://checkip.amazonaws.com' -TimeoutSec 10)).Trim()
if ($observedIp -cne $ExpectedGeneratorPublicIp) {
    throw 'ExpectedGeneratorPublicIp no longer equals the generator public IPv4 address.'
}
} else {
    $queryPath = $null
    $querySha = $null
    $queryReceipt = $null
    $leaseReceipt = $null
    $ExpectedGeneratorPublicIp = $null
}

$workload = Get-BindingRequiredValue $manifest 'workload'
if ([string](Get-BindingValue $workload 'stage' '') -cne '800' -or
    [int](Get-BindingValue $workload 'devices' 0) -ne 810 -or
    [int](Get-BindingValue $workload 'durationSeconds' 0) -ne 1800 -or
    [int](Get-BindingValue $workload 'screenshotBytes' 0) -ne 40960 -or
    [int](Get-BindingValue $workload 'canaryDevices' 0) -ne 10 -or
    [string](Get-BindingValue $workload 'workloadSchemaVersion' '') -cne 'classpilot-tile-batch-v1' -or
    [string](Get-BindingValue $workload 'endpointShapeSha256' '') -cne
        '8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2') {
    throw 'Manifest workload is not the exact strict Waf/800 diagnostic profile.'
}
$resources = Get-BindingRequiredValue $manifest 'resources'
$evidenceDirectory = Resolve-BindingExternalPath ([string](Get-BindingRequiredValue $paths 'evidenceDirectory')) `
    'paths.evidenceDirectory' -AllowMissing -Directory
if (Test-Path -LiteralPath $evidenceDirectory) { throw 'Fresh diagnostic evidence directory already exists.' }
$bindingRoot = Resolve-BindingExternalPath ([string](Get-BindingRequiredValue $paths 'bindingRoot')) `
    'paths.bindingRoot' -AllowMissing -Directory
if (Test-Path -LiteralPath $bindingRoot) { throw 'Fresh diagnostic binding root already exists.' }
$sourceRoot = Resolve-BindingExternalPath ([string](Get-BindingRequiredValue $fixture 'sourceRoot')) `
    'fixture.sourceRoot' -Directory
$startGatePath = Resolve-BindingExternalPath `
    ([string](Get-BindingRequiredValue $paths 'startGatePath')) `
    'paths.startGatePath' -AllowMissing
$trafficMarkerPath = Resolve-BindingExternalPath `
    ([string](Get-BindingRequiredValue $paths 'trafficMarkerPath')) `
    'paths.trafficMarkerPath' -AllowMissing
$downstreamPaths = @(
    $bindingRoot,
    $evidenceDirectory,
    (Resolve-BindingExternalPath ([string](Get-BindingRequiredValue $paths 'leaseReceiptPath')) `
        'paths.leaseReceiptPath' -AllowMissing),
    $startGatePath,
    $trafficMarkerPath
)
foreach ($downstreamPath in $downstreamPaths) {
    foreach ($protectedRoot in @($sourceRoot,$snapshotRoot,$runRoot)) {
        if (Test-BindingPathsOverlap $downstreamPath $protectedRoot) {
            throw 'Diagnostic binding and downstream paths must be disjoint from sealed source, snapshot, and preparation roots.'
        }
    }
}
if (Test-BindingPathsOverlap $bindingRoot $evidenceDirectory) {
    throw 'Diagnostic binding and evidence roots must be topologically disjoint.'
}

$harnessArtifacts = @(
    [ordered]@{kind='device-manifest';path=$deviceArtifact.path;sha256=$deviceArtifact.sha256},
    [ordered]@{kind='teacher-auth';path=$authArtifact.path;sha256=$authArtifact.sha256},
    [ordered]@{kind='command-bodies';path=$commandsArtifact.path;sha256=$commandsArtifact.sha256}
)
$fixturePreparation = [ordered]@{
    version=$script:ReceiptVersion
    diagnosticEligible=$diagnosticEligible
    receiptPath=$FixturePreparationReceiptPath
    receiptSha256=$fixtureReceiptSha256
    journalPath=$journalPath
    journalSha256=$journalSha256
    journalTerminalHash=$previousHash
    manifestPath=$ManifestPath
    manifestSha256=$manifestSha256
    snapshotRoot=$snapshotRoot
    snapshotArtifactSetSha256=$snapshotArtifactSetSha256
    supervisorTicketPath=$SupervisorTicketPath
    supervisorTicketSha256=$supervisorTicketSha256
    supervisorLaunchAdmissionPath=$launchAdmissionPath
    supervisorLaunchAdmissionSha256=$launchAdmissionSha256
    supervisorResultPath=$SupervisorResultPath
    supervisorResultSha256=$supervisorResultSha256
    supervisorResultKind=$resultKind
    supervisorRunLockPath=$runLockPath
    supervisorRunLockSha256=$runLockSha256
    publicationRecoveryAdmissionPath=$recoveryAdmissionPath
    publicationRecoveryAdmissionSha256=$recoveryAdmissionSha256
    publicationRecoveryReceiptPath=$recoveryReceiptPath
    publicationRecoveryReceiptSha256=$recoveryReceiptSha256
    workerOwnershipPath=$originalWorkerOwnership.path
    workerOwnershipSha256=$originalWorkerOwnership.sha256
    publicationRecoveryWorkerOwnershipPath=$(if($null -eq $recoveryWorkerOwnership){$null}else{$recoveryWorkerOwnership.path})
    publicationRecoveryWorkerOwnershipSha256=$(if($null -eq $recoveryWorkerOwnership){$null}else{$recoveryWorkerOwnership.sha256})
    verificationCountsAndGatesSha256=$verificationCountsAndGatesSha256
    artifacts=@($snapshotArtifacts)
}
$config = [ordered]@{
    schemaVersion=1
    diagnosticOnly=$true
    diagnosticEligible=$diagnosticEligible
    runId=$runId
    evidenceDirectory=$evidenceDirectory
    baseUrl=$fixtureBaseUrl
    workload=$workload
    deploymentIdentity=[ordered]@{
        applicationGitSha=$applicationGitSha;controllerGitSha=$controllerGitSha
        deployedImageDigest=$imageDigest;apiTaskDefinitionArn=$apiArn;workerTaskDefinitionArn=$workerArn
    }
    resources=$resources
    historyFallbackPiEvidenceVersion=if($diagnosticEligible){'queryid-sqlstats-v1'}else{$null}
    historyFallbackQueryIdentity=if($diagnosticEligible){[ordered]@{path=$queryPath;sha256=$querySha}}else{$null}
    databaseInsightsLease=if($diagnosticEligible){[ordered]@{
        version='database-insights-monitoring-lease-v3'
        receiptPath=$DatabaseInsightsLeaseReceiptPath
        receiptSha256=$leaseReceiptSha256
    }}else{$null}
    fixturePreparation=$fixturePreparation
    harnessArtifacts=$harnessArtifacts
    expectedGeneratorPublicIp=$ExpectedGeneratorPublicIp
}

$bindingParent = Resolve-BindingExternalPath (Split-Path -Parent $bindingRoot) `
    'Diagnostic binding parent' -Directory
Assert-BindingPrivateDirectoryAcl $bindingParent 'Diagnostic binding parent'
$bindingPublicationMutexName = 'Local\SchoolPilot.Waf800DiagnosticBinding.' +
    (Get-BindingTextSha256 ([IO.Path]::GetFullPath($bindingRoot).ToLowerInvariant())).Substring(0, 32)
$bindingPublicationMutex = [Threading.Mutex]::new($false, $bindingPublicationMutexName)
$bindingPublicationMutexOwned = $false
$staging = $null
try {
    try { $bindingPublicationMutexOwned = $bindingPublicationMutex.WaitOne(120000) }
    catch [Threading.AbandonedMutexException] { $bindingPublicationMutexOwned = $true }
    if (-not $bindingPublicationMutexOwned) {
        throw 'Timed out waiting for exclusive diagnostic binding publication ownership.'
    }
    if (Test-Path -LiteralPath $bindingRoot) {
        throw 'Fresh diagnostic binding root was already published.'
    }
    foreach ($forbiddenPublicationPath in @(
            $evidenceDirectory, $startGatePath, $trafficMarkerPath
        )) {
        if (Test-Path -LiteralPath $forbiddenPublicationPath) {
            throw 'A downstream evidence, start-gate, or traffic artifact blocks diagnostic binding publication.'
        }
    }
    Assert-NoBindingStagingResidue -Parent $bindingParent -BindingRoot $bindingRoot
    $staging = Join-Path $bindingParent ('.' + [IO.Path]::GetFileName($bindingRoot) + '.' + [Guid]::NewGuid().ToString('N') + '.staging')
    [void][IO.Directory]::CreateDirectory($staging)
    Set-BindingPrivateAcl -Path $staging -Directory
    if (-not [string]::Equals(
            [IO.Path]::GetFullPath($staging),
            [IO.Path]::GetFullPath((Get-Item -LiteralPath $staging -Force).FullName),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Diagnostic binding staging directory identity changed during creation.'
    }
$configName = "$runId.config.json"
$hashName = "$runId.config.sha256.txt"
$receiptName = "$runId.binding-receipt.json"
$finalConfigPath = Join-Path $bindingRoot $configName
$finalHashPath = Join-Path $bindingRoot $hashName
$finalReceiptPath = Join-Path $bindingRoot $receiptName
try {
    $stagedConfigPath = Join-Path $staging $configName
    Write-BindingDurableUtf8 $stagedConfigPath (ConvertTo-Json -InputObject $config -Depth 60)
    if ($TestFaultStage -ceq 'after_config_write') { throw 'Injected offline binder fault after config write.' }
    $configSha256 = Get-BindingFileSha256 $stagedConfigPath
    Write-BindingDurableUtf8 (Join-Path $staging $hashName) ($configSha256 + [Environment]::NewLine)
    if ($TestFaultStage -ceq 'after_hash_write') { throw 'Injected offline binder fault after hash write.' }
    $bindingReceipt = [ordered]@{
        schemaVersion=3;type='waf800_batch_diagnostic_binding_receipt';bindingVersion='fixture-preparation-binding-v1'
        diagnosticOnly=$true;diagnosticEligible=$diagnosticEligible;certificationEligible=$false;trafficStarted=$false
        boundAtUtc=[DateTimeOffset]::UtcNow.ToString('o');runId=$runId
        configPath=$finalConfigPath;configSha256=$configSha256;evidenceDirectory=$evidenceDirectory
        manifest=[ordered]@{path=$ManifestPath;sha256=$manifestSha256}
        release=$release;controllerHashes=$controllerHashes;fixturePreparation=$fixturePreparation
        historyFallbackQueryIdentity=if($diagnosticEligible){[ordered]@{
            version='history-fallback-queryid-v1';receiptSha256=$querySha
            queryIdentifierSha256=[string](Get-BindingRequiredValue $queryReceipt 'queryIdentifierSha256')
            rawIdentifierPersisted=$false
        }}else{$null}
        databaseInsightsLease=if($diagnosticEligible){[ordered]@{
            version='database-insights-monitoring-lease-v3';receiptSha256=$leaseReceiptSha256
            leasePurpose='diagnostic';rawLeaseIdPersisted=$false
        }}else{$null}
        expectedGeneratorPublicIpSha256=if($diagnosticEligible){Get-BindingTextSha256 $ExpectedGeneratorPublicIp}else{$null}
        rawSqlPersisted=$false;rawIdentifiersPersisted=$false
        remainingAction=if($diagnosticEligible){
            'Run controller Mode=Validate, then exactly one Mode=Run only if validation succeeds.'
        }else{'Offline rehearsal complete; this binding is permanently ineligible for validation or traffic.'}
    }
    Write-BindingDurableUtf8 (Join-Path $staging $receiptName) `
        (ConvertTo-Json -InputObject $bindingReceipt -Depth 60)
    $bindingReceiptSha256 = Get-BindingFileSha256 (Join-Path $staging $receiptName)
    if ($TestFaultStage -ceq 'after_receipt_write') { throw 'Injected offline binder fault after receipt write.' }
    if ($TestFaultStage -ceq 'before_rename') { throw 'Injected offline binder fault before group publication.' }

    $revalidationFiles = [Collections.Generic.List[object]]::new()
    foreach ($boundInput in @(
            [pscustomobject]@{name='Diagnostic preparation manifest';path=$ManifestPath;sha256=$manifestSha256;private=$true},
            [pscustomobject]@{name='Fixture preparation receipt';path=$FixturePreparationReceiptPath;sha256=$fixtureReceiptSha256;private=$true},
            [pscustomobject]@{name='Preparation supervisor ticket';path=$SupervisorTicketPath;sha256=$supervisorTicketSha256;private=$true},
            [pscustomobject]@{name='Preparation supervisor result';path=$SupervisorResultPath;sha256=$supervisorResultSha256;private=$true},
            [pscustomobject]@{name='Preparation supervisor launch admission';path=$launchAdmissionPath;sha256=$launchAdmissionSha256;private=$true},
            [pscustomobject]@{name='Preparation supervisor run lock';path=$runLockPath;sha256=$runLockSha256;private=$true},
            [pscustomobject]@{name='Fixture preparation journal';path=$journalPath;sha256=$journalSha256;private=$true},
            [pscustomobject]@{name='Original worker ownership proof';path=$originalWorkerOwnership.path;sha256=$originalWorkerOwnership.sha256;private=$true},
            [pscustomobject]@{name='Preparation supervisor script';path=$supervisorScriptPath;sha256=$supervisorScriptSha256;private=$false},
            [pscustomobject]@{name='Fixture preparation worker script';path=$workerScriptPath;sha256=$workerScriptSha256;private=$false}
        )) {
        $revalidationFiles.Add($boundInput)
    }
    foreach ($controllerInput in $controllerRevalidationFiles) {
        $revalidationFiles.Add($controllerInput)
    }
    foreach ($snapshotArtifact in $snapshotArtifacts) {
        $revalidationFiles.Add([pscustomobject]@{
            name = "Fixture snapshot artifact '$($snapshotArtifact.name)'"
            path = $snapshotArtifact.path
            sha256 = $snapshotArtifact.sha256
            private = $true
        })
    }
    if ($resultKind -ceq 'recovery') {
        foreach ($recoveryInput in @(
                [pscustomobject]@{name='Publication recovery admission';path=$recoveryAdmissionPath;sha256=$recoveryAdmissionSha256;private=$true},
                [pscustomobject]@{name='Publication recovery receipt';path=$recoveryReceiptPath;sha256=$recoveryReceiptSha256;private=$true},
                [pscustomobject]@{name='Publication recovery worker ownership proof';path=$recoveryWorkerOwnership.path;sha256=$recoveryWorkerOwnership.sha256;private=$true},
                [pscustomobject]@{name='Original supervisor result evidence';path=$originalResultEvidencePath;sha256=$originalResultEvidenceSha256;private=$true},
                [pscustomobject]@{name='Original supervisor state evidence';path=$originalStateEvidencePath;sha256=$originalStateEvidenceSha256;private=$true}
            )) {
            $revalidationFiles.Add($recoveryInput)
        }
    }
    if ($diagnosticEligible) {
        $revalidationFiles.Add([pscustomobject]@{
            name='History-fallback query identity receipt';path=$queryPath;sha256=$querySha;private=$true
        })
        $revalidationFiles.Add([pscustomobject]@{
            name='Database Insights lease receipt';path=$DatabaseInsightsLeaseReceiptPath
            sha256=$leaseReceiptSha256;private=$true
        })
    }
    Assert-BindingRevalidationSet -Files $revalidationFiles.ToArray()

    $stagedItems = @(Get-ChildItem -LiteralPath $staging -Force -ErrorAction Stop)
    $stagedNames = @($stagedItems | ForEach-Object Name | Sort-Object)
    $requiredStagedNames = @(@($configName, $hashName, $receiptName) | Sort-Object)
    if ($stagedItems.Count -ne 3 -or
        @($stagedItems | Where-Object PSIsContainer).Count -ne 0 -or
        @(Compare-Object $requiredStagedNames $stagedNames).Count -ne 0 -or
        (Get-BindingFileSha256 (Join-Path $staging $configName)) -cne $configSha256 -or
        (Get-BindingFileSha256 (Join-Path $staging $receiptName)) -cne $bindingReceiptSha256 -or
        [IO.File]::ReadAllText(
            (Join-Path $staging $hashName),
            [Text.UTF8Encoding]::new($false)
        ) -cne ($configSha256 + [Environment]::NewLine)) {
        throw 'Diagnostic binding staging content drifted before atomic publication.'
    }
    Assert-BindingPublicationPreconditions -Parent $bindingParent -Staging $staging `
        -BindingRoot $bindingRoot
    [IO.Directory]::Move($staging, $bindingRoot)
}
finally {
    Remove-BindingStagingSafely -Path $staging -ExpectedParent $bindingParent
}
}
finally {
    if ($bindingPublicationMutexOwned) {
        try { $bindingPublicationMutex.ReleaseMutex() } catch { }
    }
    $bindingPublicationMutex.Dispose()
}

$publishedItems = @(Get-ChildItem -LiteralPath $bindingRoot -Force)
$publishedNames = @($publishedItems | ForEach-Object { $_.Name } | Sort-Object)
$requiredPublishedNames = @(@($configName, $hashName, $receiptName) | Sort-Object)
if ($publishedItems.Count -ne 3 -or
    @($publishedItems | Where-Object { -not $_.PSIsContainer }).Count -ne 3 -or
    @(Compare-Object $requiredPublishedNames $publishedNames).Count -ne 0) {
    throw 'Atomic binding publication did not produce exactly the three required files.'
}
Assert-BindingPrivateDirectoryAcl $bindingRoot 'Published diagnostic binding root'
foreach ($path in @($finalConfigPath, $finalHashPath, $finalReceiptPath)) {
    Assert-BindingPrivateFileAcl $path 'Published diagnostic binding artifact'
}
if ((Get-BindingFileSha256 $finalConfigPath) -cne $configSha256 -or
    (Get-BindingFileSha256 $finalReceiptPath) -cne $bindingReceiptSha256 -or
    [IO.File]::ReadAllText($finalHashPath, [Text.UTF8Encoding]::new($false)) -cne
        ($configSha256 + [Environment]::NewLine)) {
    throw 'Published diagnostic binding hashes drifted during atomic rename.'
}
$publishedConfig = Read-BindingJson $finalConfigPath 'Published diagnostic config'
$publishedReceipt = Read-BindingJson $finalReceiptPath 'Published diagnostic binding receipt'
if ((ConvertTo-Json -InputObject $publishedConfig -Depth 60 -Compress) -cne
        (ConvertTo-Json -InputObject $config -Depth 60 -Compress) -or
    (ConvertTo-Json -InputObject $publishedReceipt -Depth 60 -Compress) -cne
        (ConvertTo-Json -InputObject $bindingReceipt -Depth 60 -Compress)) {
    throw 'Published diagnostic binding content changed during atomic rename.'
}

[ordered]@{
    ok=$true;runId=$runId;diagnosticEligible=$diagnosticEligible;configPath=$finalConfigPath;configSha256=$configSha256
    hashPath=$finalHashPath;bindingReceiptPath=$finalReceiptPath;bindingReceiptSha256=$bindingReceiptSha256
    fixturePreparationReceiptSha256=$fixtureReceiptSha256
    fixturePreparationJournalTerminalHash=$previousHash
    fixturePreparationSupervisorTicketSha256=$supervisorTicketSha256
    fixturePreparationSupervisorResultSha256=$supervisorResultSha256
    fixturePreparationVerificationCountsAndGatesSha256=$verificationCountsAndGatesSha256
    snapshotArtifactSetSha256=$snapshotArtifactSetSha256
} | ConvertTo-Json -Depth 20
