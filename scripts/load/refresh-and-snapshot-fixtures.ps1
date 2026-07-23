#requires -Version 7.5

[CmdletBinding()]
param(
    [ValidateSet('Validate', 'Run', 'ResumePublication')]
    [string]$Mode = 'Validate',

    [Parameter(Mandatory)]
    [string]$ManifestPath,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$ExpectedManifestSha256,

    [string]$SupervisorAdmissionPath,

    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$ExpectedSupervisorAdmissionSha256,

    [ValidatePattern('^[0-9a-f]{32}$')]
    [string]$SupervisorAdmissionNonce
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:Manifest = $null
$script:ManifestSha256 = $null
$script:SupervisorAdmission = $null
$script:WorkerOwnership = $null
$script:WorkerSha256 = $null
$script:JournalInitialized = $false
$script:JournalTerminalCommitted = $false
$script:CurrentStage = 'preflight'
$script:WindowFailureMessage = $null
$script:RequiredSnapshotFiles = @(
    'fixture-state.private.json',
    'verification.private.json',
    'load-devices.private.json',
    'load-auth.private.json',
    'load-command-bodies.private.json'
)
$script:AllowedSourceSupportFiles = @(
    'fixture-ownership.private.json',
    'prerequisites.private.json',
    'cleanup-result.private.json'
)

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-StringSha256 {
    param([AllowEmptyString()][string]$Value)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Assert-HexSha256 {
    param([object]$Value, [string]$Name)
    if ($Value -isnot [string] -or [string]$Value -cnotmatch '^[0-9a-f]{64}$') {
        throw "$Name must be one lowercase SHA-256 value."
    }
}

function Assert-File {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Name is missing."
    }
}

function Assert-ExactKeys {
    param(
        [Parameter(Mandatory)][Collections.IDictionary]$Value,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Required,
        [string[]]$Optional = @(),
        [Parameter(Mandatory)][string]$Name
    )
    $keys = @($Value.Keys | ForEach-Object { [string]$_ })
    foreach ($key in $Required) {
        if (-not $Value.Contains($key)) { throw "$Name is missing required field '$key'." }
    }
    $allowed = @($Required) + @($Optional)
    foreach ($key in $keys) {
        if ($allowed -cnotcontains $key) { throw "$Name contains unsupported field '$key'." }
    }
}

function Resolve-AbsolutePath {
    param(
        [object]$Value,
        [string]$Name,
        [switch]$AllowMissing,
        [switch]$AllowRepository
    )
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$Value) -or
        -not [IO.Path]::IsPathRooted([string]$Value) -or
        ([string]$Value).StartsWith('\\?\') -or ([string]$Value).StartsWith('\\.\')) {
        throw "$Name must be an ordinary absolute path."
    }
    $absolute = [IO.Path]::GetFullPath([string]$Value)
    if (-not $AllowRepository) {
        $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
        $repo = $script:RepositoryRoot.TrimEnd('\', '/')
        if ([string]::Equals($absolute, $repo, $comparison) -or
            $absolute.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, $comparison)) {
            throw "$Name must be outside the repository."
        }
    }
    $cursor = $absolute
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
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

function Assert-StrictChildPath {
    param([string]$Child, [string]$Parent, [string]$Name)
    $childFull = [IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if ([string]::Equals($childFull, $parentFull, $comparison) -or
        -not $childFull.StartsWith($parentFull + [IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw "$Name is outside its intended parent."
    }
}

function Test-PreparationPathsOverlap {
    param([string]$Left, [string]$Right)
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase }
        else { [StringComparison]::Ordinal }
    $leftPath = [IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
    $rightPath = [IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
    $separator = [IO.Path]::DirectorySeparatorChar
    return [string]::Equals($leftPath, $rightPath, $comparison) -or
        $leftPath.StartsWith($rightPath + $separator, $comparison) -or
        $rightPath.StartsWith($leftPath + $separator, $comparison)
}

function Set-ExactPrivateAcl {
    param([string]$Path, [bool]$Directory)
    if (-not $IsWindows) { throw 'Diagnostic preparation artifacts require Windows ACL support.' }
    $item = Get-Item -LiteralPath $Path -Force
    if ([bool]$item.PSIsContainer -ne $Directory) { throw 'Private ACL target type mismatch.' }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Private diagnostic preparation artifacts must not be reparse points.'
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = if ($Directory) {
        [Security.AccessControl.DirectorySecurity]::new()
    }
    else {
        [Security.AccessControl.FileSecurity]::new()
    }
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    Set-Acl -LiteralPath $Path -AclObject $security
    Assert-ExactPrivateAcl -Path $Path -Directory $Directory
}

function Assert-ExactPrivateAcl {
    param([string]$Path, [bool]$Directory)
    if (-not $IsWindows) { throw 'Diagnostic preparation artifacts require Windows ACL support.' }
    $item = Get-Item -LiteralPath $Path -Force
    if ([bool]$item.PSIsContainer -ne $Directory) { throw 'Private ACL target type mismatch.' }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Private diagnostic preparation artifacts must not be reparse points.'
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
    if ($owner.Value -cne $sid.Value -or -not $acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IsInherited -or
        $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rules[0].IdentityReference.Value -cne $sid.Value -or
        (($rules[0].FileSystemRights -band $fullControl) -ne $fullControl) -or
        $rules[0].InheritanceFlags -ne $inheritance -or
        $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw 'Diagnostic preparation artifacts must have one protected current-user FullControl rule.'
    }
}

function Assert-PrivateTreeSafeForRemoval {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$ExpectedParent)
    Assert-StrictChildPath -Child $Path -Parent $ExpectedParent -Name 'removal target'
    Assert-ExactPrivateAcl -Path $Path -Directory $true
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'A run-bound staging tree contains a reparse point and cannot be removed.'
        }
        Assert-ExactPrivateAcl -Path $item.FullName -Directory ([bool]$item.PSIsContainer)
    }
}

function Write-PrivateJsonAtomic {
    param([string]$Path, $Value, [switch]$Immutable)
    if ($Immutable -and (Test-Path -LiteralPath $Path)) {
        throw 'An immutable diagnostic preparation artifact already exists.'
    }
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $parent)
        Set-ExactPrivateAcl -Path $parent -Directory $true
    }
    else { Assert-ExactPrivateAcl -Path $parent -Directory $true }
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $json = $Value | ConvertTo-Json -Depth 100
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
        $stream = [IO.FileStream]::new(
            $temporary,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        Set-ExactPrivateAcl -Path $temporary -Directory $false
        if (Test-Path -LiteralPath $Path) { throw 'An immutable diagnostic preparation artifact appeared during publication.' }
        [IO.File]::Move($temporary, $Path)
        Assert-ExactPrivateAcl -Path $Path -Directory $false
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-ProcessIdentity {
    param([Diagnostics.Process]$Process, [string]$Kind)
    $lastFailure = $null
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try {
            $Process.Refresh()
            if ($Process.HasExited) {
                throw 'The bound child exited before its process identity could be observed.'
            }
            $startedAtUtc = ([DateTimeOffset]$Process.StartTime.ToUniversalTime()).ToString('o')
            $executablePath = [string]$Process.Path
            if ([string]::IsNullOrWhiteSpace($executablePath)) {
                $executablePath = [string]$Process.MainModule.FileName
            }
            if ([string]::IsNullOrWhiteSpace($executablePath)) {
                throw 'The bound child executable path was unavailable.'
            }
            return [ordered]@{
                pid = [int]$Process.Id
                startedAtUtc = $startedAtUtc
                path = [IO.Path]::GetFullPath($executablePath)
                kind = $Kind
            }
        }
        catch {
            $lastFailure = $_.Exception
            if ($Process.HasExited) { break }
            Start-Sleep -Milliseconds 50
        }
    }
    throw [InvalidOperationException]::new(
        'The bound child process identity could not be observed within the admission interval.',
        $lastFailure
    )
}

function Test-BoundProcessPresent {
    param([Collections.IDictionary]$Identity)
    if ($null -eq $Identity -or [int]$Identity.pid -le 0) { return $false }
    $candidate = Get-Process -Id ([int]$Identity.pid) -ErrorAction SilentlyContinue
    if ($null -eq $candidate) { return $false }
    try {
        $actual = ([DateTimeOffset]$candidate.StartTime.ToUniversalTime()).ToString('o')
        $expected = ([DateTimeOffset]::ParseExact(
            [string]$Identity.startedAtUtc,
            'o',
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )).ToUniversalTime().ToString('o')
        return $actual -ceq $expected
    }
    catch { return $true }
}

function New-JournalRecordCore {
    param(
        [int]$Sequence,
        [string]$Stage,
        [string]$Status,
        $Process,
        $ExitCode,
        $ArtifactHashes,
        $PreviousRecordHash,
        $FailureCode,
        $FailureStage
    )
    return [ordered]@{
        schemaVersion = 1
        type = 'diagnostic_prep_journal_record'
        version = 'diagnostic-prep-journal-v1'
        sequence = $Sequence
        runId = [string]$script:Manifest.runId
        manifestSha256 = $script:ManifestSha256
        timestampUtc = [DateTimeOffset]::UtcNow.ToString('o')
        stage = $Stage
        status = $Status
        process = $Process
        exitCode = $ExitCode
        artifactHashes = $ArtifactHashes
        previousRecordHash = $PreviousRecordHash
        failureCode = $FailureCode
        failureStage = $FailureStage
    }
}

function Get-JournalRecordHash {
    param([Collections.IDictionary]$RecordCore)
    return Get-StringSha256 -Value ($RecordCore | ConvertTo-Json -Compress -Depth 50)
}

function Read-And-ValidateJournal {
    $journalPath = [string]$script:Manifest.paths.journalPath
    if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) { return @() }
    Assert-ExactPrivateAcl -Path $journalPath -Directory $false
    $journalBytes = [IO.File]::ReadAllBytes($journalPath)
    # A newly created writer-owned journal is empty before sequence 1.  Once
    # any byte exists, the final record must already have its commit newline.
    if ($journalBytes.Length -gt 0 -and $journalBytes[-1] -ne 0x0a) {
        throw 'The diagnostic preparation journal ends with an uncommitted partial record.'
    }
    $records = [Collections.Generic.List[object]]::new()
    $previous = $null
    $sequence = 0
    foreach ($line in [IO.File]::ReadLines($journalPath, [Text.UTF8Encoding]::new($false))) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $record = $line | ConvertFrom-Json -DateKind String -AsHashtable -Depth 50 }
        catch { throw 'The diagnostic preparation journal contains malformed JSON.' }
        $sequence++
        Assert-ExactKeys -Value $record -Required @(
            'schemaVersion', 'type', 'version', 'sequence', 'runId', 'manifestSha256', 'timestampUtc',
            'stage', 'status', 'process', 'exitCode', 'artifactHashes', 'previousRecordHash',
            'failureCode', 'failureStage', 'recordHash'
        ) -Name 'journal record'
        if ([int]$record.schemaVersion -ne 1 -or [string]$record.type -cne 'diagnostic_prep_journal_record' -or
            [string]$record.version -cne 'diagnostic-prep-journal-v1' -or [int]$record.sequence -ne $sequence -or
            [string]$record.runId -cne [string]$script:Manifest.runId -or
            [string]$record.manifestSha256 -cne $script:ManifestSha256 -or
            [string]$record.previousRecordHash -cne [string]$previous) {
            throw 'The diagnostic preparation journal chain identity is invalid.'
        }
        $core = New-JournalRecordCore -Sequence ([int]$record.sequence) -Stage ([string]$record.stage) `
            -Status ([string]$record.status) -Process $record.process -ExitCode $record.exitCode `
            -ArtifactHashes $record.artifactHashes -PreviousRecordHash $record.previousRecordHash `
            -FailureCode $record.failureCode -FailureStage $record.failureStage
        $core.timestampUtc = [string]$record.timestampUtc
        $computed = Get-JournalRecordHash -RecordCore $core
        if ([string]$record.recordHash -cne $computed) { throw 'The diagnostic preparation journal hash is invalid.' }
        if ([string]$record.stage -cnotmatch '^[a-z][a-z0-9_]{2,63}$' -or
            [string]$record.status -cnotin @('running', 'completed', 'failed') -or
            $record.artifactHashes -isnot [Collections.IDictionary] -and $null -ne $record.artifactHashes) {
            throw 'The diagnostic preparation journal contains an unsafe record shape.'
        }
        try {
            $recordTime = [DateTimeOffset]::ParseExact(
                [string]$record.timestampUtc, 'o', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
        }
        catch { throw 'The diagnostic preparation journal timestamp is invalid.' }
        if ($recordTime.Offset -ne [TimeSpan]::Zero) { throw 'The diagnostic preparation journal timestamp is not UTC.' }
        if ($records.Count -gt 0) {
            $priorTime = [DateTimeOffset]::ParseExact(
                [string]$records[-1].timestampUtc, 'o', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
            if ($recordTime -lt $priorTime) { throw 'The diagnostic preparation journal time regressed.' }
        }
        $previous = $computed
        $records.Add($record)
    }
    return @($records)
}

function Assert-RecoveryJournalLifecycle {
    param([object[]]$Records, $Receipt)
    $required = @(
        @{ stage = 'preflight_accepted'; status = 'completed' },
        @{ stage = 'refresh_admitted'; status = 'running' },
        @{ stage = 'refresh_completed'; status = 'completed' },
        @{ stage = 'verify_admitted'; status = 'running' },
        @{ stage = 'verify_completed'; status = 'completed' },
        @{ stage = 'freshness_accepted'; status = 'completed' },
        @{ stage = 'source_hashes_sealed'; status = 'completed' },
        @{ stage = 'fixture_receipt_sealed'; status = 'completed' }
    )
    $lastSequence = 0
    foreach ($contract in $required) {
        $matches = @($Records | Where-Object {
            [string]$_.stage -ceq $contract.stage -and [string]$_.status -ceq $contract.status
        })
        if ($matches.Count -ne 1 -or [int]$matches[0].sequence -le $lastSequence) {
            throw 'The journal does not prove one ordered refresh, verification, seal, and publication attempt.'
        }
        if ($contract.stage -in @('refresh_completed', 'verify_completed') -and [int]$matches[0].exitCode -ne 0) {
            throw 'The journal contains a nonzero fixture command completion.'
        }
        $lastSequence = [int]$matches[0].sequence
    }
    $provider = [string]$script:Manifest.fixture.provider
    if ($provider -notin @('production','offline-fake')) {
        throw 'The journal fixture provider is unsupported.'
    }
    $emptySha256 = Get-StringSha256 -Value ''
    foreach ($command in @('refresh','verify')) {
        $childStarted = @($Records | Where-Object {
            [string]$_.stage -ceq "${command}_child_started" -and [string]$_.status -ceq 'running'
        })
        if ($provider -ceq 'offline-fake') {
            if ($childStarted.Count -ne 0) { throw 'Offline fixture evidence must not contain production child records.' }
            continue
        }
        $admitted = @($Records | Where-Object { [string]$_.stage -ceq "${command}_admitted" })
        $completed = @($Records | Where-Object { [string]$_.stage -ceq "${command}_completed" })
        if ($admitted.Count -ne 1 -or $childStarted.Count -ne 1 -or $completed.Count -ne 1 -or
            [int]$admitted[0].sequence -ge [int]$childStarted[0].sequence -or
            [int]$childStarted[0].sequence -ge [int]$completed[0].sequence -or
            [int]$completed[0].exitCode -ne 0) {
            throw 'Production fixture child lifecycle evidence is incomplete or out of order.'
        }
        $child = $childStarted[0].process
        $completion = $completed[0].process
        $admittedProcess = $admitted[0].process
        $expectedStdout = [string]$Receipt.execution["${command}StdoutSha256"]
        $expectedStderr = [string]$Receipt.execution["${command}StderrSha256"]
        $expectedAdmissionSha256 = [string]$Receipt.supervisorAdmission.sha256
        if ([int]$admittedProcess.pid -ne [int]$Receipt.execution.workerProcess.pid -or
            [string]$admittedProcess.startedAtUtc -cne [string]$Receipt.execution.workerProcess.startedAtUtc -or
            [string]$admittedProcess.path -cne [string]$Receipt.execution.workerProcess.path -or
            [string]$admittedProcess.kind -cne 'fixture-worker' -or
            [string]$admitted[0].artifactHashes.fixtureCliSha256 -cne
                [string]$script:Manifest.fixture.fixtureCli.sha256 -or
            [string]$admitted[0].artifactHashes.fixtureWorkerSha256 -cne $script:WorkerSha256 -or
            [string]$admitted[0].artifactHashes.supervisorAdmissionSha256 -cne $expectedAdmissionSha256 -or
            [int]$child.pid -le 0 -or [int]$child.pid -eq [int]$Receipt.execution.workerProcess.pid -or
            [string]$child.startedAtUtc -cne [string]$completion.startedAtUtc -or
            [string]$child.path -cne [string]$completion.path -or
            [string]$child.kind -cne "fixture-$command" -or
            [string]$completion.kind -cne "fixture-$command" -or
            [int]$child.pid -ne [int]$completion.pid -or
            -not [IO.Path]::IsPathRooted([string]$child.path) -or
            [string]$childStarted[0].artifactHashes.fixtureCliSha256 -cne
                [string]$script:Manifest.fixture.fixtureCli.sha256 -or
            [string]$childStarted[0].artifactHashes.fixtureWorkerSha256 -cne $script:WorkerSha256 -or
            [string]$childStarted[0].artifactHashes.supervisorAdmissionSha256 -cne $expectedAdmissionSha256 -or
            [string]$completed[0].artifactHashes.stdoutSha256 -cne $expectedStdout -or
            [string]$completed[0].artifactHashes.stderrSha256 -cne $expectedStderr -or
            $expectedStderr -cne $emptySha256) {
            throw 'Production fixture child process or output evidence is invalid.'
        }
    }
    foreach ($stage in @('publication_recovery_started', 'publication_recovery_completed')) {
        if (@($Records | Where-Object { [string]$_.stage -ceq $stage }).Count -ne 0) {
            throw 'The one permitted publication recovery was already represented in the journal.'
        }
    }
    $publicationStarted = @($Records | Where-Object { [string]$_.stage -ceq 'publication_started' })
    if ($publicationStarted.Count -gt 1 -or
        ($publicationStarted.Count -eq 1 -and ([string]$publicationStarted[0].status -cne 'running' -or
            [int]$publicationStarted[0].sequence -le $lastSequence))) {
        throw 'The journal contains an invalid initial publication lifecycle.'
    }
    $publicationCompleted = @($Records | Where-Object {
        [string]$_.stage -eq 'publication_completed' -and [string]$_.status -eq 'completed'
    })
    if ($publicationCompleted.Count -gt 1 -or
        ($publicationCompleted.Count -eq 1 -and ($publicationStarted.Count -ne 1 -or
            [int]$publicationCompleted[0].sequence -le [int]$publicationStarted[0].sequence))) {
        throw 'The journal contains an invalid completed publication boundary.'
    }
    $terminal = @($Records | Where-Object { [string]$_.stage -ceq 'terminal_commit' })
    if ($terminal.Count -gt 1 -or ($terminal.Count -eq 1 -and
        ([string]$terminal[0].status -cne 'failed' -or [int]$terminal[0].sequence -ne $Records.Count))) {
        throw 'Publication recovery requires no terminal commit or one intact failed original terminal commit.'
    }
}

function Add-JournalRecord {
    param(
        [string]$Stage,
        [string]$Status,
        $Process = $null,
        $ExitCode = $null,
        $ArtifactHashes = $null,
        $FailureCode = $null,
        $FailureStage = $null
    )
    if ($null -eq $Process) {
        $kind = if ($Mode -ceq 'ResumePublication') { 'fixture-worker-recovery' } else { 'fixture-worker' }
        $Process = Get-ProcessIdentity -Process (Get-Process -Id $PID) -Kind $kind
    }
    $journalPath = [string]$script:Manifest.paths.journalPath
    $parent = [IO.Path]::GetDirectoryName($journalPath)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $parent)
        Set-ExactPrivateAcl -Path $parent -Directory $true
    }
    else { Assert-ExactPrivateAcl -Path $parent -Directory $true }
    if (-not (Test-Path -LiteralPath $journalPath)) {
        $create = [IO.FileStream]::new($journalPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $create.Flush($true) } finally { $create.Dispose() }
        Set-ExactPrivateAcl -Path $journalPath -Directory $false
    }
    $records = @(Read-And-ValidateJournal)
    $previous = if ($records.Count -gt 0) { [string]$records[-1].recordHash } else { $null }
    $core = New-JournalRecordCore -Sequence ($records.Count + 1) -Stage $Stage -Status $Status `
        -Process $Process -ExitCode $ExitCode -ArtifactHashes $ArtifactHashes `
        -PreviousRecordHash $previous -FailureCode $FailureCode -FailureStage $FailureStage
    $hash = Get-JournalRecordHash -RecordCore $core
    $persisted = [ordered]@{}
    foreach ($entry in $core.GetEnumerator()) { $persisted[$entry.Key] = $entry.Value }
    $persisted.recordHash = $hash
    $line = ($persisted | ConvertTo-Json -Compress -Depth 50) + "`n"
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($line)
    $stream = [IO.FileStream]::new(
        $journalPath,
        [IO.FileMode]::Append,
        [IO.FileAccess]::Write,
        [IO.FileShare]::Read,
        4096,
        [IO.FileOptions]::WriteThrough
    )
    try {
        $journalSplitDelay = if ($script:Manifest.Contains('testControls') -and
            $script:Manifest.testControls.Contains('journalAppendSplitDelayMilliseconds')) {
            [int]$script:Manifest.testControls.journalAppendSplitDelayMilliseconds
        }
        else { 0 }
        if ($journalSplitDelay -gt 0) {
            $stream.Write($bytes, 0, $bytes.Length - 1)
            $stream.Flush($true)
            Start-Sleep -Milliseconds $journalSplitDelay
            $stream.Write($bytes, $bytes.Length - 1, 1)
            $stream.Flush($true)
        }
        else {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
    }
    finally { $stream.Dispose() }
    Assert-ExactPrivateAcl -Path $journalPath -Directory $false
    $script:JournalInitialized = $true
    if ($script:Manifest.Contains('testControls') -and
        $script:Manifest.testControls.Contains('pauseAfterJournalStage') -and
        [string]$script:Manifest.testControls.pauseAfterJournalStage -ceq $Stage) {
        Start-Sleep -Seconds ([int]$script:Manifest.testControls.pauseAfterJournalStageSeconds)
    }
    return $hash
}

function Get-SnapshotArtifactSetSha256 {
    param([object[]]$Artifacts)
    $canonical = @($Artifacts | Sort-Object { [string]$_.name } | ForEach-Object {
        [ordered]@{
            name = [string]$_.name
            sha256 = [string]$_.sha256
            size = [long]$_.size
            lastWriteTimeUtc = [string]$_.lastWriteTimeUtc
        }
    })
    return Get-StringSha256 -Value ($canonical | ConvertTo-Json -Compress -Depth 20 -AsArray)
}

function Convert-ToPinnedLocalIso {
    param([DateTimeOffset]$Instant)
    $python = (Get-Command python -ErrorAction Stop).Source
    $code = @'
import os
from datetime import datetime
from zoneinfo import ZoneInfo
with open(os.environ['SCHOOLPILOT_PINNED_TZIF'], 'rb') as stream:
    zone = ZoneInfo.from_file(stream, key=os.environ['SCHOOLPILOT_PINNED_TIMEZONE'])
instant = datetime.fromisoformat(os.environ['SCHOOLPILOT_UTC_INSTANT'])
print(instant.astimezone(zone).isoformat(timespec='seconds'))
'@
    $names = @('SCHOOLPILOT_PINNED_TZIF', 'SCHOOLPILOT_PINNED_TIMEZONE', 'SCHOOLPILOT_UTC_INSTANT')
    $prior = @{}
    foreach ($name in $names) { $prior[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        [Environment]::SetEnvironmentVariable('SCHOOLPILOT_PINNED_TZIF', [string]$script:Manifest.executionWindow.pinnedTzifPath, 'Process')
        [Environment]::SetEnvironmentVariable('SCHOOLPILOT_PINNED_TIMEZONE', [string]$script:Manifest.executionWindow.timezone, 'Process')
        [Environment]::SetEnvironmentVariable('SCHOOLPILOT_UTC_INSTANT', $Instant.ToUniversalTime().ToString('o'), 'Process')
        $output = @(& $python -c $code)
        if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$output[0])) {
            throw 'Pinned timezone conversion failed.'
        }
        return ([string]$output[0]).Trim()
    }
    finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $prior[$name], 'Process') }
    }
}

function Assert-CurrentWindow {
    $earliest = [DateTimeOffset]::ParseExact(
        [string]$script:Manifest.executionWindow.earliestUtc, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind
    )
    $latest = [DateTimeOffset]::ParseExact(
        [string]$script:Manifest.executionWindow.latestUtc, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind
    )
    if ($earliest.Offset -ne [TimeSpan]::Zero -or $latest.Offset -ne [TimeSpan]::Zero -or $latest -le $earliest) {
        throw 'The manifest execution window must be a positive exact UTC interval.'
    }
    $earliestLocal = Convert-ToPinnedLocalIso -Instant $earliest
    $latestLocal = Convert-ToPinnedLocalIso -Instant $latest
    $now = [DateTimeOffset]::UtcNow
    if ($now -lt $earliest -or $now -gt $latest) {
        $relation = if ($now -lt $earliest) { 'before' } else { 'after' }
        $script:WindowFailureMessage =
            "Fixture preparation is $relation the pinned execution window ($earliestLocal through $latestLocal $([string]$script:Manifest.executionWindow.timezone); UTC $($earliest.ToString('o')) through $($latest.ToString('o')))."
        throw $script:WindowFailureMessage
    }
    return [ordered]@{ earliestUtc = $earliest.ToString('o'); latestUtc = $latest.ToString('o'); earliestLocal = $earliestLocal; latestLocal = $latestLocal }
}

function Read-PrivateJson {
    param([string]$Path, [int]$Depth = 100)
    Assert-File -Path $Path -Name 'private JSON artifact'
    Assert-ExactPrivateAcl -Path $Path -Directory $false
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -DateKind String -AsHashtable -Depth $Depth }
    catch { throw 'A private diagnostic preparation JSON artifact is malformed.' }
}

function Assert-BoundFile {
    param([Collections.IDictionary]$Binding, [string]$Name, [switch]$Private, [switch]$Repository)
    Assert-ExactKeys -Value $Binding -Required @('path', 'sha256') -Name $Name
    Assert-HexSha256 -Value $Binding.sha256 -Name "$Name.sha256"
    $path = Resolve-AbsolutePath -Value $Binding.path -Name "$Name.path" -AllowRepository:$Repository
    Assert-File -Path $path -Name $Name
    if ((Get-Sha256 $path) -cne [string]$Binding.sha256) { throw "$Name hash mismatch." }
    if ($Private) { Assert-ExactPrivateAcl -Path $path -Directory $false }
    return $path
}

function Get-ControllerArtifactBinding {
    param([Parameter(Mandatory)][string]$Kind)
    $matches = @($script:Manifest.controllerArtifacts | Where-Object { [string]$_.kind -ceq $Kind })
    if ($matches.Count -ne 1) { throw "The preparation manifest must bind exactly one '$Kind' controller artifact." }
    $raw = $matches[0]
    $path = if ([IO.Path]::IsPathRooted([string]$raw.path)) {
        [IO.Path]::GetFullPath([string]$raw.path)
    }
    else { [IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot ([string]$raw.path))) }
    return [ordered]@{ kind = $Kind; path = $path; sha256 = [string]$raw.sha256 }
}

function Assert-RepositoryTrackedFixtureCli {
    $binding = $script:Manifest.fixture.fixtureCli
    $path = Resolve-AbsolutePath -Value $binding.path -Name 'fixture CLI path' -AllowRepository
    Assert-StrictChildPath -Child $path -Parent $script:RepositoryRoot -Name 'fixture CLI path'
    Assert-File -Path $path -Name 'fixture CLI'
    if ([IO.Path]::GetExtension($path) -cne '.mjs') { throw 'The fixture CLI must be the tracked repository JavaScript module.' }
    if ((Get-Sha256 $path) -cne [string]$binding.sha256) { throw 'The fixture CLI changed after manifest validation.' }
    $relative = [IO.Path]::GetRelativePath($script:RepositoryRoot, $path).Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains("`n") -or $relative.Contains("`r") -or $relative.Contains("`t")) {
        throw 'The fixture CLI repository path is unsafe.'
    }
    $stage = @(& git -C $script:RepositoryRoot ls-files --stage -- $relative)
    if ($LASTEXITCODE -ne 0 -or $stage.Count -ne 1 -or
        [string]$stage[0] -cnotmatch '^(?<mode>[0-9]{6}) (?<object>[0-9a-f]{40,64}) 0\t(?<path>.+)$' -or
        $Matches.mode -ceq '120000' -or $Matches.path -cne $relative) {
        throw 'The fixture CLI must be one ordinary stage-zero Git-tracked file.'
    }
    return [ordered]@{ path = $path; sha256 = [string]$binding.sha256; repositoryPath = $relative; gitObjectId = [string]$Matches.object }
}

function Assert-LiveBoundSupervisorProcess {
    param([Collections.IDictionary]$Identity)
    Assert-ExactKeys -Value $Identity -Required @('pid', 'startedAtUtc', 'path') -Name 'supervisor process identity'
    if ([int]$Identity.pid -le 0) { throw 'The supervisor process identity is invalid.' }
    $process = Get-Process -Id ([int]$Identity.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) { throw 'The bound preparation supervisor is not running.' }
    try {
        $actualStarted = ([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToString('o')
        $expectedStarted = ([DateTimeOffset]::ParseExact(
            [string]$Identity.startedAtUtc, 'o', [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )).ToUniversalTime().ToString('o')
        $actualPath = [IO.Path]::GetFullPath($process.Path)
        if ($actualStarted -cne $expectedStarted -or
            -not [string]::Equals([IO.Path]::GetFullPath([string]$Identity.path), $actualPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The live supervisor process does not match its admission identity.'
        }
        $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
        if ($null -eq $current -or [uint32]$current.ParentProcessId -ne [uint32]$Identity.pid) {
            throw 'The mutation worker was not launched by the bound live supervisor.'
        }
    }
    finally { $process.Dispose() }
}

function Assert-SupervisorLockHeld {
    param([string]$Path)
    $lockPath = Resolve-AbsolutePath -Value $Path -Name 'supervisor lock path'
    Assert-StrictChildPath -Child $lockPath -Parent ([string]$script:Manifest.paths.runDirectoryRoot) -Name 'supervisor lock path'
    Assert-File -Path $lockPath -Name 'supervisor lock'
    Assert-ExactPrivateAcl -Path $lockPath -Directory $false
    $opened = $null
    try {
        $opened = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    catch [IO.IOException] {
        $win32 = $_.Exception.HResult -band 0xffff
        if ($win32 -notin @(32, 33)) { throw 'The supervisor lock could not be safely inspected.' }
        return $lockPath
    }
    finally { if ($null -ne $opened) { $opened.Dispose() } }
    throw 'The admission supervisor does not hold its exclusive run lock.'
}

function Assert-AdmissionReference {
    param([Collections.IDictionary]$Reference, [string]$Name, [string]$ExpectedPath, [string]$ExpectedSha256)
    Assert-ExactKeys -Value $Reference -Required @('path', 'sha256') -Name $Name
    $path = Resolve-AbsolutePath -Value $Reference.path -Name "$Name.path" -AllowRepository
    Assert-HexSha256 -Value $Reference.sha256 -Name "$Name.sha256"
    if (-not [string]::Equals($path, [IO.Path]::GetFullPath($ExpectedPath), [StringComparison]::OrdinalIgnoreCase) -or
        [string]$Reference.sha256 -cne $ExpectedSha256) {
        throw "$Name does not match its immutable binding."
    }
}

function Assert-AdmissionControlCommon {
    param([Collections.IDictionary]$Control)
    if ([string]$Control.statePath -cne [string]$script:Manifest.paths.supervisorStatePath -or
        [string]$Control.journalPath -cne [string]$script:Manifest.paths.journalPath -or
        [string]$Control.runMutexName -cne (Get-PreparationMutexName) -or
        [string]$Control.supervisorMutexName -cne ('Local\SchoolPilot.Waf800DiagnosticPreparationSupervisor.' +
            (Get-StringSha256 -Value ([string]$script:Manifest.runId)).Substring(0, 32))) {
        throw 'The supervisor admission control binding is invalid.'
    }
    [void](Assert-SupervisorLockHeld -Path ([string]$Control.supervisorLockPath))
}

function Read-And-ValidateSupervisorAdmission {
    if ([string]::IsNullOrWhiteSpace($SupervisorAdmissionPath) -or
        [string]::IsNullOrWhiteSpace($ExpectedSupervisorAdmissionSha256) -or
        [string]::IsNullOrWhiteSpace($SupervisorAdmissionNonce)) {
        throw 'Mutation modes require a complete supervisor admission handshake.'
    }
    $path = Resolve-AbsolutePath -Value $SupervisorAdmissionPath -Name 'SupervisorAdmissionPath'
    Assert-StrictChildPath -Child $path -Parent ([string]$script:Manifest.paths.runDirectoryRoot) -Name 'SupervisorAdmissionPath'
    Assert-File -Path $path -Name 'supervisor admission'
    Assert-ExactPrivateAcl -Path $path -Directory $false
    $expectedSha = $ExpectedSupervisorAdmissionSha256.ToLowerInvariant()
    if ((Get-Sha256 $path) -cne $expectedSha) { throw 'The supervisor admission artifact hash is invalid.' }
    $admission = Read-PrivateJson -Path $path -Depth 50
    try {
        $admittedAt = [DateTimeOffset]::ParseExact(
            [string]$admission.createdAtUtc, 'o', [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch { throw 'The supervisor admission creation timestamp is invalid.' }
    if ($admittedAt.Offset -ne [TimeSpan]::Zero -or $admittedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or
        $admittedAt -lt [DateTimeOffset]::UtcNow.AddMinutes(-10)) {
        throw 'The supervisor admission is stale or outside exact UTC bounds.'
    }
    $worker = Get-ControllerArtifactBinding -Kind 'fixture-worker'
    $supervisorScript = Get-ControllerArtifactBinding -Kind 'prep-supervisor'
    $nonceSha = Get-StringSha256 -Value $SupervisorAdmissionNonce

    if ($Mode -ceq 'Run') {
        Assert-ExactKeys -Value $admission -Required @(
            'schemaVersion', 'type', 'version', 'runId', 'createdAtUtc', 'diagnosticOnly',
            'diagnosticEligible', 'certificationEligible', 'manifest', 'worker', 'supervisorScript',
            'launchAdmission', 'supervisor', 'launchNonceSha256', 'timeoutSeconds', 'control'
        ) -Name 'initial supervisor admission ticket'
        if ([int]$admission.schemaVersion -ne 1 -or
            [string]$admission.type -cne 'diagnostic_prep_supervisor_ticket' -or
            [string]$admission.version -cne 'diagnostic-prep-supervisor-ticket-v2' -or
            [string]$admission.runId -cne [string]$script:Manifest.runId -or
            $admission.diagnosticOnly -ne $true -or $admission.certificationEligible -ne $false -or
            [bool]$admission.diagnosticEligible -ne [bool]$script:Manifest.diagnosticEligible -or
            [string]$admission.launchNonceSha256 -cne $nonceSha) {
            throw 'The initial supervisor admission ticket identity is invalid.'
        }
        Assert-AdmissionReference -Reference $admission.manifest -Name 'admission manifest' -ExpectedPath $ManifestPath -ExpectedSha256 $script:ManifestSha256
        Assert-AdmissionReference -Reference $admission.worker -Name 'admission worker' -ExpectedPath ([string]$worker.path) -ExpectedSha256 ([string]$worker.sha256)
        Assert-AdmissionReference -Reference $admission.supervisorScript -Name 'admission supervisor script' -ExpectedPath ([string]$supervisorScript.path) -ExpectedSha256 ([string]$supervisorScript.sha256)
        $launchAdmissionPath = Resolve-AbsolutePath -Value ([string]$admission.launchAdmission.path) `
            -Name 'admission launch artifact'
        Assert-StrictChildPath -Child $launchAdmissionPath -Parent ([string]$script:Manifest.paths.runDirectoryRoot) `
            -Name 'admission launch artifact'
        Assert-File -Path $launchAdmissionPath -Name 'admission launch artifact'
        Assert-ExactPrivateAcl -Path $launchAdmissionPath -Directory $false
        Assert-HexSha256 -Value ([string]$admission.launchAdmission.sha256) `
            -Name 'admission launch artifact sha256'
        if ((Get-Sha256 $launchAdmissionPath) -cne [string]$admission.launchAdmission.sha256) {
            throw 'The supervisor launch admission changed before worker mutation.'
        }
        Assert-ExactKeys -Value $admission.control -Required @(
            'statePath', 'resultPath', 'journalPath', 'workerStdoutPath', 'workerStderrPath',
            'supervisorStdoutPath', 'supervisorStderrPath', 'runMutexName', 'supervisorMutexName',
            'supervisorLockPath'
        ) -Name 'initial admission control'
        Assert-AdmissionControlCommon -Control $admission.control
        foreach ($field in @('resultPath', 'workerStdoutPath', 'workerStderrPath', 'supervisorStdoutPath', 'supervisorStderrPath')) {
            Assert-StrictChildPath -Child ([string]$admission.control[$field]) -Parent ([string]$script:Manifest.paths.runDirectoryRoot) -Name "admission.control.$field"
        }
        Assert-LiveBoundSupervisorProcess -Identity $admission.supervisor
    }
    else {
        Assert-ExactKeys -Value $admission -Required @(
            'schemaVersion', 'type', 'version', 'mode', 'runId', 'createdAtUtc', 'manifest', 'worker',
            'supervisorScript', 'supervisor', 'originalTicket', 'originalExecution',
            'recoveryNonceSha256', 'control'
        ) -Name 'publication recovery admission'
        if ([int]$admission.schemaVersion -ne 1 -or
            [string]$admission.type -cne 'diagnostic_prep_publication_recovery_admission' -or
            [string]$admission.version -cne 'diagnostic-prep-publication-recovery-admission-v1' -or
            [string]$admission.mode -cne 'ResumePublication' -or
            [string]$admission.runId -cne [string]$script:Manifest.runId -or
            [string]$admission.recoveryNonceSha256 -cne $nonceSha) {
            throw 'The publication recovery admission identity is invalid.'
        }
        Assert-AdmissionReference -Reference $admission.manifest -Name 'recovery manifest' -ExpectedPath $ManifestPath -ExpectedSha256 $script:ManifestSha256
        Assert-AdmissionReference -Reference $admission.worker -Name 'recovery worker' -ExpectedPath ([string]$worker.path) -ExpectedSha256 ([string]$worker.sha256)
        Assert-AdmissionReference -Reference $admission.supervisorScript -Name 'recovery supervisor script' -ExpectedPath ([string]$supervisorScript.path) -ExpectedSha256 ([string]$supervisorScript.sha256)
        Assert-ExactKeys -Value $admission.originalTicket -Required @('path', 'sha256') -Name 'original ticket reference'
        $originalTicketPath = Resolve-AbsolutePath -Value $admission.originalTicket.path -Name 'original ticket path'
        Assert-File -Path $originalTicketPath -Name 'original supervisor ticket'
        Assert-ExactPrivateAcl -Path $originalTicketPath -Directory $false
        Assert-HexSha256 -Value $admission.originalTicket.sha256 -Name 'original ticket sha256'
        if ((Get-Sha256 $originalTicketPath) -cne [string]$admission.originalTicket.sha256) { throw 'The original supervisor ticket changed.' }
        Assert-ExactKeys -Value $admission.originalExecution -Required @(
            'statePath', 'stateSha256', 'resultPath', 'resultSha256',
            'fixturePreparationReceiptPath', 'fixturePreparationReceiptSha256'
        ) -Name 'recovery original execution'
        foreach ($reference in @(
            @{ Path = [string]$admission.originalExecution.statePath; Sha = [string]$admission.originalExecution.stateSha256; Name = 'original state' },
            @{ Path = [string]$admission.originalExecution.resultPath; Sha = [string]$admission.originalExecution.resultSha256; Name = 'original result' },
            @{ Path = [string]$admission.originalExecution.fixturePreparationReceiptPath; Sha = [string]$admission.originalExecution.fixturePreparationReceiptSha256; Name = 'fixture preparation receipt' }
        )) {
            $boundPath = Resolve-AbsolutePath -Value $reference.Path -Name "$($reference.Name) path"
            Assert-File -Path $boundPath -Name $reference.Name
            Assert-ExactPrivateAcl -Path $boundPath -Directory $false
            Assert-HexSha256 -Value $reference.Sha -Name "$($reference.Name) sha256"
            if ((Get-Sha256 $boundPath) -cne $reference.Sha) { throw "$($reference.Name) changed before publication recovery." }
        }
        if ([string]$admission.originalExecution.fixturePreparationReceiptPath -cne [string]$script:Manifest.paths.fixturePreparationReceiptPath) {
            throw 'The recovery admission references the wrong fixture preparation receipt.'
        }
        Assert-ExactKeys -Value $admission.control -Required @(
            'statePath', 'recoveryResultPath', 'recoveryStdoutPath', 'recoveryStderrPath',
            'runMutexName', 'supervisorMutexName', 'supervisorLockPath'
        ) -Name 'recovery admission control'
        # Recovery has no journalPath member; bind its common control fields directly.
        if ([string]$admission.control.statePath -cne [string]$script:Manifest.paths.supervisorStatePath -or
            [string]$admission.control.runMutexName -cne (Get-PreparationMutexName) -or
            [string]$admission.control.supervisorMutexName -cne ('Local\SchoolPilot.Waf800DiagnosticPreparationSupervisor.' +
                (Get-StringSha256 -Value ([string]$script:Manifest.runId)).Substring(0, 32))) {
            throw 'The recovery supervisor control binding is invalid.'
        }
        [void](Assert-SupervisorLockHeld -Path ([string]$admission.control.supervisorLockPath))
        foreach ($field in @('recoveryResultPath', 'recoveryStdoutPath', 'recoveryStderrPath')) {
            Assert-StrictChildPath -Child ([string]$admission.control[$field]) -Parent ([string]$script:Manifest.paths.runDirectoryRoot) -Name "recovery admission control.$field"
        }
        Assert-LiveBoundSupervisorProcess -Identity $admission.supervisor
    }
    return [ordered]@{
        type = [string]$admission.type
        version = [string]$admission.version
        sha256 = $expectedSha
        nonceSha256 = $nonceSha
        supervisor = $admission.supervisor
        supervisorLockPathSha256 = Get-StringSha256 -Value ([string]$admission.control.supervisorLockPath)
        originalTicketSha256 = $(if ($Mode -ceq 'ResumePublication') { [string]$admission.originalTicket.sha256 } else { $null })
    }
}

function Read-And-ValidateWorkerOwnership {
    param([Collections.IDictionary]$Admission)
    $fileName = if ($Mode -ceq 'Run') {
        'worker-ownership.private.json'
    }
    else { 'publication-recovery-worker-ownership.private.json' }
    $path = Join-Path ([string]$script:Manifest.paths.runDirectoryRoot) $fileName
    Assert-StrictChildPath -Child $path -Parent ([string]$script:Manifest.paths.runDirectoryRoot) `
        -Name 'worker ownership proof'
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Assert-LiveBoundSupervisorProcess -Identity $Admission.supervisor
        [void](Assert-SupervisorLockHeld -Path ([string](
            (Read-PrivateJson -Path $SupervisorAdmissionPath -Depth 50).control.supervisorLockPath
        )))
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            throw 'The supervisor did not commit kill-on-close worker ownership before mutation.'
        }
        Start-Sleep -Milliseconds 50
    }
    Assert-ExactPrivateAcl -Path $path -Directory $false
    $proof = Read-PrivateJson -Path $path -Depth 30
    Assert-ExactKeys -Value $proof -Required @(
        'schemaVersion', 'type', 'version', 'runId', 'createdAtUtc', 'manifestSha256',
        'supervisorAdmissionSha256', 'supervisor', 'worker', 'jobPolicy', 'descendantPolicy'
    ) -Name 'worker ownership proof'
    $self = Get-ProcessIdentity -Process (Get-Process -Id $PID) -Kind 'fixture-worker'
    $createdAt = [DateTimeOffset]::MinValue
    if ([int]$proof.schemaVersion -ne 1 -or
        [string]$proof.type -cne 'diagnostic_prep_worker_ownership' -or
        [string]$proof.version -cne 'diagnostic-prep-worker-job-v1' -or
        [string]$proof.runId -cne [string]$script:Manifest.runId -or
        [string]$proof.manifestSha256 -cne $script:ManifestSha256 -or
        [string]$proof.supervisorAdmissionSha256 -cne [string]$Admission.sha256 -or
        [string]$proof.jobPolicy -cne 'kill-on-supervisor-close-v1' -or
        [string]$proof.descendantPolicy -cne 'no-breakaway-v1' -or
        -not [DateTimeOffset]::TryParseExact(
            [string]$proof.createdAtUtc, 'o', [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None, [ref]$createdAt
        ) -or $createdAt.Offset -ne [TimeSpan]::Zero -or
        $createdAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or
        [int]$proof.supervisor.pid -ne [int]$Admission.supervisor.pid -or
        [string]$proof.supervisor.startedAtUtc -cne [string]$Admission.supervisor.startedAtUtc -or
        -not [string]::Equals(
            [string]$proof.supervisor.path, [string]$Admission.supervisor.path,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        [int]$proof.worker.pid -ne [int]$self.pid -or
        [string]$proof.worker.startedAtUtc -cne [string]$self.startedAtUtc -or
        -not [string]::Equals(
            [string]$proof.worker.path, [string]$self.path,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The worker ownership proof is malformed or not bound to this supervised process.'
    }
    Assert-LiveBoundSupervisorProcess -Identity $Admission.supervisor
    return [ordered]@{
        path = $path
        sha256 = Get-Sha256 $path
        version = [string]$proof.version
        jobPolicy = [string]$proof.jobPolicy
        descendantPolicy = [string]$proof.descendantPolicy
    }
}

function Assert-ManifestContract {
    Assert-ExactKeys -Value $script:Manifest -Required @(
        'schemaVersion', 'type', 'version', 'runId', 'diagnosticOnly', 'diagnosticEligible',
        'certificationEligible', 'repositoryRoot', 'release', 'controllerArtifacts',
        'executionWindow', 'fixture', 'paths', 'oneAttemptPolicy', 'workload'
    ) -Optional @(
        'createdAtUtc', 'resources', 'historyFallbackQueryIdentity', 'databaseInsightsLease',
        'testControls'
    ) -Name 'manifest'
    if ([int]$script:Manifest.schemaVersion -ne 1 -or
        [string]$script:Manifest.type -cne 'waf800_diagnostic_prep_manifest' -or
        [string]$script:Manifest.version -cne 'waf800-diagnostic-prep-manifest-v1' -or
        $script:Manifest.diagnosticOnly -ne $true -or $script:Manifest.certificationEligible -ne $false -or
        $script:Manifest.diagnosticEligible -isnot [bool] -or
        [string]$script:Manifest.runId -cnotmatch '^[a-z0-9][a-z0-9-]{15,159}$') {
        throw 'The diagnostic preparation manifest identity or eligibility boundary is invalid.'
    }
    Assert-ExactKeys -Value $script:Manifest.release -Required @(
        'applicationGitSha', 'controllerGitSha', 'deployedImageDigest',
        'apiTaskDefinitionArn', 'workerTaskDefinitionArn'
    ) -Name 'manifest.release'
    foreach ($field in @('applicationGitSha', 'controllerGitSha')) {
        if ([string]$script:Manifest.release[$field] -cnotmatch '^[0-9a-f]{40}$') { throw "manifest.release.$field is invalid." }
    }
    if ([string]$script:Manifest.release.applicationGitSha -cne [string]$script:Manifest.release.controllerGitSha) {
        throw 'The application and controller release identities must be identical.'
    }
    if ([string]$script:Manifest.release.deployedImageDigest -cnotmatch '^sha256:[0-9a-f]{64}$' -or
        [string]$script:Manifest.release.apiTaskDefinitionArn -cnotmatch '^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$' -or
        [string]$script:Manifest.release.workerTaskDefinitionArn -cnotmatch '^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$') {
        throw 'The manifest release digest or task identity is invalid.'
    }
    $repositoryRoot = Resolve-AbsolutePath -Value $script:Manifest.repositoryRoot -Name 'repositoryRoot' -AllowRepository
    if ([IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\') -cne $script:RepositoryRoot.TrimEnd('\')) {
        throw 'The manifest repository root is not this repository.'
    }
    if ($script:Manifest.controllerArtifacts -isnot [Collections.IEnumerable]) { throw 'controllerArtifacts must be an array.' }
    $controllerKinds = @{}
    $workerBound = $false
    foreach ($artifact in @($script:Manifest.controllerArtifacts)) {
        if ($artifact -isnot [Collections.IDictionary]) { throw 'A controller artifact is malformed.' }
        Assert-ExactKeys -Value $artifact -Required @('kind', 'path', 'sha256') -Name 'controller artifact'
        if ([string]$artifact.kind -cnotmatch '^[a-z0-9][a-z0-9-]{1,63}$' -or $controllerKinds.ContainsKey([string]$artifact.kind)) {
            throw 'Controller artifact kinds must be unique safe identifiers.'
        }
        $controllerKinds[[string]$artifact.kind] = $true
        $artifactPath = if ([IO.Path]::IsPathRooted([string]$artifact.path)) {
            Resolve-AbsolutePath -Value $artifact.path -Name 'controller artifact path' -AllowRepository
        }
        else {
            $joinedArtifactPath = [IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot ([string]$artifact.path)))
            Resolve-AbsolutePath -Value $joinedArtifactPath -Name 'controller artifact path' -AllowRepository
        }
        Assert-StrictChildPath -Child $artifactPath -Parent $script:RepositoryRoot -Name 'controller artifact path'
        Assert-HexSha256 -Value $artifact.sha256 -Name 'controller artifact sha256'
        Assert-File -Path $artifactPath -Name 'controller artifact'
        if ((Get-Sha256 $artifactPath) -cne [string]$artifact.sha256) { throw 'A controller artifact hash does not match.' }
        if ([string]$artifact.kind -ceq 'fixture-worker') {
            if ([IO.Path]::GetFullPath($artifactPath) -cne [IO.Path]::GetFullPath($PSCommandPath)) {
                throw 'The fixture-worker binding does not identify this script.'
            }
            $workerBound = $true
        }
    }
    if (-not $workerBound) { throw 'The manifest does not bind the fixture-worker artifact.' }
    foreach ($requiredKind in @(
        'fixture-worker', 'prep-supervisor', 'diagnostic-binder', 'coordinator', 'monitor', 'harness',
        'monotonic-deadline', 'tile-poll-accounting', 'database-insights-lease'
    )) {
        if (-not $controllerKinds.ContainsKey($requiredKind)) {
            throw "The preparation manifest must bind controller artifact '$requiredKind'."
        }
    }

    Assert-ExactKeys -Value $script:Manifest.workload -Required @(
        'stage', 'devices', 'durationSeconds', 'screenshotBytes', 'canaryDevices',
        'workloadSchemaVersion', 'endpointShapeSha256'
    ) -Name 'manifest.workload'
    if ([string]$script:Manifest.workload.stage -cne '800' -or
        [int]$script:Manifest.workload.devices -ne 810 -or
        [int]$script:Manifest.workload.durationSeconds -ne 1800 -or
        [int]$script:Manifest.workload.screenshotBytes -ne 40960 -or
        [int]$script:Manifest.workload.canaryDevices -ne 10 -or
        [string]$script:Manifest.workload.workloadSchemaVersion -cne 'classpilot-tile-batch-v1' -or
        [string]$script:Manifest.workload.endpointShapeSha256 -cne '8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2') {
        throw 'The preparation manifest workload differs from the exact Waf/800 batch contract.'
    }

    if ($script:Manifest.Contains('testControls')) {
        if ($script:Manifest.testControls -isnot [Collections.IDictionary]) {
            throw 'Manifest testControls must be an object.'
        }
        Assert-ExactKeys -Value $script:Manifest.testControls -Required @() `
            -Optional @(
                'harmlessDelaySeconds', 'faultStage', 'largeOutputBytes',
                'supervisorBeforeRunningStateDelayMilliseconds',
                'supervisorForceRunningStateRetryExhaustion',
                'journalAppendSplitDelayMilliseconds',
                'supervisorBeforeTicketDelayMilliseconds',
                'supervisorBeforeWorkerCreateDelayMilliseconds',
                'supervisorAfterWorkerAssignmentBeforeResumeDelayMilliseconds',
                'supervisorAfterRecoveryWorkerAssignmentBeforeResumeDelayMilliseconds',
                'supervisorAfterWorkerExitedStateDelayMilliseconds',
                'supervisorAfterResultCommitDelayMilliseconds',
                'supervisorAfterRecoveryAdmissionDelayMilliseconds',
                'afterFixtureReceiptSealDelaySeconds',
                'offlineFakeCredentialValidityMarginSeconds',
                'offlineRecoveryClockAdvanceSeconds',
                'pauseAfterJournalStage', 'pauseAfterJournalStageSeconds'
            ) -Name 'manifest.testControls'
        if ($script:Manifest.testControls.Count -eq 0) { throw 'Manifest testControls cannot be empty.' }
        $delay = if ($script:Manifest.testControls.Contains('harmlessDelaySeconds')) {
            [int]$script:Manifest.testControls.harmlessDelaySeconds
        }
        else { 0 }
        $largeOutputBytes = if ($script:Manifest.testControls.Contains('largeOutputBytes')) {
            [int]$script:Manifest.testControls.largeOutputBytes
        }
        else { 0 }
        $supervisorStateDelayMilliseconds = if (
            $script:Manifest.testControls.Contains('supervisorBeforeRunningStateDelayMilliseconds')
        ) {
            [int]$script:Manifest.testControls.supervisorBeforeRunningStateDelayMilliseconds
        }
        else { 0 }
        $forceStateRetryExhaustion = if (
            $script:Manifest.testControls.Contains('supervisorForceRunningStateRetryExhaustion')
        ) {
            $script:Manifest.testControls.supervisorForceRunningStateRetryExhaustion
        }
        else { $false }
        $journalAppendSplitDelayMilliseconds = if (
            $script:Manifest.testControls.Contains('journalAppendSplitDelayMilliseconds')
        ) {
            [int]$script:Manifest.testControls.journalAppendSplitDelayMilliseconds
        }
        else { 0 }
        $afterReceiptSealDelaySeconds = if (
            $script:Manifest.testControls.Contains('afterFixtureReceiptSealDelaySeconds')
        ) {
            [int]$script:Manifest.testControls.afterFixtureReceiptSealDelaySeconds
        }
        else { 0 }
        $offlineCredentialMarginSeconds = if (
            $script:Manifest.testControls.Contains('offlineFakeCredentialValidityMarginSeconds')
        ) {
            [int]$script:Manifest.testControls.offlineFakeCredentialValidityMarginSeconds
        }
        else { 3600 }
        $offlineRecoveryClockAdvanceSeconds = if (
            $script:Manifest.testControls.Contains('offlineRecoveryClockAdvanceSeconds')
        ) {
            [int]$script:Manifest.testControls.offlineRecoveryClockAdvanceSeconds
        }
        else { 0 }
        $pauseAfterJournalStageSeconds = if (
            $script:Manifest.testControls.Contains('pauseAfterJournalStageSeconds')
        ) {
            [int]$script:Manifest.testControls.pauseAfterJournalStageSeconds
        }
        else { 0 }
        $allowedPauseStages = @(
            'preflight_accepted','refresh_admitted','refresh_completed','verify_admitted',
            'verify_completed','freshness_accepted','source_hashes_sealed',
            'publication_started','publication_completed','terminal_commit'
        )
        $boundedSupervisorDelays = @(
            'supervisorBeforeTicketDelayMilliseconds',
            'supervisorBeforeWorkerCreateDelayMilliseconds',
            'supervisorAfterWorkerAssignmentBeforeResumeDelayMilliseconds',
            'supervisorAfterRecoveryWorkerAssignmentBeforeResumeDelayMilliseconds',
            'supervisorAfterWorkerExitedStateDelayMilliseconds',
            'supervisorAfterResultCommitDelayMilliseconds',
            'supervisorAfterRecoveryAdmissionDelayMilliseconds'
        )
        foreach ($delayName in $boundedSupervisorDelays) {
            if ($script:Manifest.testControls.Contains($delayName)) {
                $delayValue = $script:Manifest.testControls[$delayName]
                if ($delayValue -isnot [ValueType] -or [string]$delayValue -cnotmatch '^\d{1,5}$' -or
                    [int]$delayValue -gt 30000) {
                    throw 'A supervisor test delay is outside its bounded offline range.'
                }
            }
        }
        $allowedFaultStages = @(
            'refresh_nonzero', 'verify_nonzero', 'after_preflight', 'after_refresh_admitted',
            'after_refresh_completed', 'after_verify_admitted', 'after_verify_completed',
            'after_freshness_accepted', 'after_source_sealed', 'after_fixture_receipt_sealed',
            'publication_during_copy', 'publication_before_rename',
            'publication_after_rename_before_commit', 'after_publication_completed'
        )
        if ($script:Manifest.diagnosticEligible -ne $false -or
            [string]$script:Manifest.fixture.provider -cne 'offline-fake' -or
            $delay -lt 0 -or $delay -gt 1800 -or $largeOutputBytes -lt 0 -or $largeOutputBytes -gt 5242880 -or
            $afterReceiptSealDelaySeconds -lt 0 -or $afterReceiptSealDelaySeconds -gt 30 -or
            $offlineCredentialMarginSeconds -lt 1 -or $offlineCredentialMarginSeconds -gt 7200 -or
            $offlineRecoveryClockAdvanceSeconds -lt 0 -or
                $offlineRecoveryClockAdvanceSeconds -gt 7200 -or
            $supervisorStateDelayMilliseconds -lt 0 -or $supervisorStateDelayMilliseconds -gt 5000 -or
            $forceStateRetryExhaustion -isnot [bool] -or
            $journalAppendSplitDelayMilliseconds -lt 0 -or $journalAppendSplitDelayMilliseconds -gt 1000 -or
            ($script:Manifest.testControls.Contains('pauseAfterJournalStage') -xor
                $script:Manifest.testControls.Contains('pauseAfterJournalStageSeconds')) -or
            ($script:Manifest.testControls.Contains('pauseAfterJournalStage') -and
                ([string]$script:Manifest.testControls.pauseAfterJournalStage -cnotin $allowedPauseStages -or
                 $pauseAfterJournalStageSeconds -lt 1 -or $pauseAfterJournalStageSeconds -gt 30)) -or
            ($script:Manifest.testControls.Contains('faultStage') -and
                [string]$script:Manifest.testControls.faultStage -cnotin $allowedFaultStages)) {
            throw 'Test controls are restricted to bounded offline, diagnostic-ineligible rehearsal.'
        }
    }

    Assert-ExactKeys -Value $script:Manifest.executionWindow -Required @(
        'earliestUtc', 'latestUtc', 'timezone', 'pinnedTzifPath', 'pinnedTzifSha256'
    ) -Name 'manifest.executionWindow'
    if ([string]$script:Manifest.executionWindow.timezone -cnotmatch '^[A-Za-z_]+/[A-Za-z0-9_+.-]+$') {
        throw 'The pinned timezone identifier is invalid.'
    }
    $tzif = Resolve-AbsolutePath -Value $script:Manifest.executionWindow.pinnedTzifPath -Name 'pinned TZif path' -AllowRepository
    Assert-HexSha256 -Value $script:Manifest.executionWindow.pinnedTzifSha256 -Name 'pinned TZif sha256'
    Assert-File -Path $tzif -Name 'pinned TZif'
    if ((Get-Sha256 $tzif) -cne [string]$script:Manifest.executionWindow.pinnedTzifSha256) { throw 'Pinned TZif hash mismatch.' }
    [void](Assert-CurrentWindowContract)

    Assert-ExactKeys -Value $script:Manifest.fixture -Required @(
        'provider', 'fixtureId', 'sourceRoot', 'config', 'fixtureCli', 'baseUrl',
        'requiredVerificationMaximumAgeMinutes', 'requiredArtifactValiditySeconds', 'requiredPrivateFiles'
    ) -Optional @('fixturePasswords', 'superAdminPassword', 'superAdminOperation', 'fakeTemplateRoot') -Name 'manifest.fixture'
    $baseUri = $null
    $baseUriValid = [Uri]::TryCreate([string]$script:Manifest.fixture.baseUrl, [UriKind]::Absolute, [ref]$baseUri)
    if ([string]$script:Manifest.fixture.provider -cnotin @('production', 'offline-fake') -or
        [string]$script:Manifest.fixture.fixtureId -cnotmatch '^[a-z0-9][a-z0-9-]{3,127}$' -or
        -not $baseUriValid -or $baseUri.Scheme -cne 'https' -or -not [string]::IsNullOrEmpty($baseUri.UserInfo) -or
        -not [string]::IsNullOrEmpty($baseUri.Query) -or -not [string]::IsNullOrEmpty($baseUri.Fragment) -or
        [int]$script:Manifest.fixture.requiredVerificationMaximumAgeMinutes -ne 60 -or
        [int]$script:Manifest.fixture.requiredArtifactValiditySeconds -ne 2700) {
        throw 'The manifest fixture contract is invalid.'
    }
    $requiredNames = @($script:Manifest.fixture.requiredPrivateFiles | ForEach-Object { [string]$_ } | Sort-Object)
    $expectedNames = @($script:RequiredSnapshotFiles | Sort-Object)
    if ($requiredNames.Count -ne 5 -or @(Compare-Object $expectedNames $requiredNames).Count -ne 0) {
        throw 'The manifest fixture file contract must be the exact five-file set.'
    }
    $sourceRoot = Resolve-AbsolutePath -Value $script:Manifest.fixture.sourceRoot -Name 'fixture source root' -AllowMissing
    if ($script:Manifest.diagnosticEligible -eq $true -and $baseUri.AbsoluteUri.TrimEnd('/') -cne 'https://school-pilot.net') {
        throw 'A diagnostic-eligible fixture must use the production CloudFront origin.'
    }
    $script:Manifest.fixture.sourceRoot = $sourceRoot
    $script:Manifest.fixture.config.path = Assert-BoundFile -Binding $script:Manifest.fixture.config -Name 'fixture config' -Private
    $script:Manifest.fixture.fixtureCli.path = Assert-BoundFile -Binding $script:Manifest.fixture.fixtureCli -Name 'fixture CLI' -Repository
    [void](Assert-RepositoryTrackedFixtureCli)
    if ([string]$script:Manifest.fixture.provider -ceq 'production') {
        if ($script:Manifest.diagnosticEligible -ne $true) {
            throw 'The production fixture provider requires diagnosticEligible=true.'
        }
        foreach ($field in @('fixturePasswords', 'superAdminPassword', 'superAdminOperation')) {
            if (-not $script:Manifest.fixture.Contains($field)) { throw "Production fixture provider requires '$field'." }
            $script:Manifest.fixture[$field].path = Assert-BoundFile -Binding $script:Manifest.fixture[$field] -Name $field -Private
        }
        if ($script:Manifest.fixture.Contains('fakeTemplateRoot')) { throw 'Production fixture provider cannot bind a fake template root.' }
    }
    else {
        if ($script:Manifest.diagnosticEligible -ne $false -or -not $script:Manifest.fixture.Contains('fakeTemplateRoot')) {
            throw 'The offline-fake provider is restricted to diagnosticEligible=false rehearsals.'
        }
        $templateRoot = Resolve-AbsolutePath -Value $script:Manifest.fixture.fakeTemplateRoot -Name 'fake template root'
        Assert-ExactPrivateAcl -Path $templateRoot -Directory $true
        foreach ($name in $script:RequiredSnapshotFiles) {
            Assert-File -Path (Join-Path $templateRoot $name) -Name 'fake fixture template'
            Assert-ExactPrivateAcl -Path (Join-Path $templateRoot $name) -Directory $false
        }
        $script:Manifest.fixture.fakeTemplateRoot = $templateRoot
    }

    Assert-ExactKeys -Value $script:Manifest.paths -Required @(
        'runDirectoryRoot', 'snapshotRoot', 'journalPath', 'fixturePreparationReceiptPath',
        'publicationRecoveryReceiptPath', 'supervisorStatePath', 'leaseReceiptPath',
        'bindingRoot', 'evidenceDirectory', 'startGatePath', 'trafficMarkerPath'
    ) -Name 'manifest.paths'
    foreach ($field in @(
        'runDirectoryRoot', 'snapshotRoot', 'journalPath', 'fixturePreparationReceiptPath',
        'publicationRecoveryReceiptPath', 'supervisorStatePath', 'leaseReceiptPath',
        'bindingRoot', 'evidenceDirectory', 'startGatePath', 'trafficMarkerPath'
    )) {
        $script:Manifest.paths[$field] = Resolve-AbsolutePath -Value $script:Manifest.paths[$field] -Name "paths.$field" -AllowMissing
    }
    if ([IO.Path]::GetFileName([string]$script:Manifest.paths.snapshotRoot) -cne [string]$script:Manifest.runId) {
        throw 'The immutable snapshot root must end in the exact run ID.'
    }
    $rootEntries = @(
        [pscustomobject]@{ name = 'fixture.sourceRoot'; path = [string]$script:Manifest.fixture.sourceRoot },
        [pscustomobject]@{ name = 'paths.snapshotRoot'; path = [string]$script:Manifest.paths.snapshotRoot },
        [pscustomobject]@{ name = 'paths.runDirectoryRoot'; path = [string]$script:Manifest.paths.runDirectoryRoot },
        [pscustomobject]@{ name = 'paths.bindingRoot'; path = [string]$script:Manifest.paths.bindingRoot },
        [pscustomobject]@{ name = 'paths.evidenceDirectory'; path = [string]$script:Manifest.paths.evidenceDirectory }
    )
    for ($left = 0; $left -lt $rootEntries.Count; $left++) {
        for ($right = $left + 1; $right -lt $rootEntries.Count; $right++) {
            if (Test-PreparationPathsOverlap -Left $rootEntries[$left].path -Right $rootEntries[$right].path) {
                throw "$($rootEntries[$left].name) and $($rootEntries[$right].name) must be distinct and non-nested."
            }
        }
    }
    $runControlFields = @(
        'journalPath', 'fixturePreparationReceiptPath',
        'publicationRecoveryReceiptPath', 'supervisorStatePath'
    )
    foreach ($field in $runControlFields) {
        Assert-StrictChildPath -Child ([string]$script:Manifest.paths[$field]) `
            -Parent ([string]$script:Manifest.paths.runDirectoryRoot) -Name "paths.$field"
        foreach ($protected in $rootEntries | Where-Object { $_.name -ne 'paths.runDirectoryRoot' }) {
            if (Test-PreparationPathsOverlap -Left ([string]$script:Manifest.paths[$field]) `
                    -Right $protected.path) {
                throw "paths.$field must not overlap $($protected.name)."
            }
        }
    }
    foreach ($downstreamField in @('leaseReceiptPath', 'startGatePath', 'trafficMarkerPath')) {
        foreach ($root in $rootEntries) {
            if (Test-PreparationPathsOverlap -Left ([string]$script:Manifest.paths[$downstreamField]) `
                    -Right $root.path) {
                throw "paths.$downstreamField must not overlap $($root.name)."
            }
        }
    }
    $controlPaths = @(
        $runControlFields | ForEach-Object { [string]$script:Manifest.paths[$_] }
    ) + @(
        [string]$script:Manifest.paths.leaseReceiptPath,
        [string]$script:Manifest.paths.startGatePath,
        [string]$script:Manifest.paths.trafficMarkerPath
    )
    if (@($controlPaths | Sort-Object -Unique).Count -ne $controlPaths.Count) {
        throw 'Diagnostic preparation control artifact paths must be distinct.'
    }

    Assert-ExactKeys -Value $script:Manifest.oneAttemptPolicy -Required @(
        'refreshAttempts', 'verificationAttempts', 'initialPublicationAttempts', 'publicationRecoveryAttempts'
    ) -Name 'manifest.oneAttemptPolicy'
    foreach ($field in @('refreshAttempts', 'verificationAttempts', 'initialPublicationAttempts', 'publicationRecoveryAttempts')) {
        if ([int]$script:Manifest.oneAttemptPolicy[$field] -ne 1) { throw 'Every diagnostic preparation attempt limit must equal one.' }
    }
    if ([bool]$script:Manifest.diagnosticEligible) {
        if (-not $script:Manifest.Contains('historyFallbackQueryIdentity') -or
            -not $script:Manifest.Contains('databaseInsightsLease')) {
            throw 'A diagnostic-eligible preparation must bind the query receipt and planned Database Insights lease.'
        }
        Assert-ExactKeys -Value $script:Manifest.historyFallbackQueryIdentity -Required @('version', 'path', 'sha256') `
            -Name 'manifest.historyFallbackQueryIdentity'
        if ([string]$script:Manifest.historyFallbackQueryIdentity.version -cne 'history-fallback-queryid-v1') {
            throw 'The diagnostic query identity version is ineligible.'
        }
        $script:Manifest.historyFallbackQueryIdentity.path = Assert-BoundFile `
            -Binding ([ordered]@{
                path = [string]$script:Manifest.historyFallbackQueryIdentity.path
                sha256 = [string]$script:Manifest.historyFallbackQueryIdentity.sha256
            }) -Name 'history fallback query identity receipt' -Private
        Assert-ExactKeys -Value $script:Manifest.databaseInsightsLease -Required @('version', 'leasePurpose') `
            -Optional @('accountId', 'region', 'dbInstanceIdentifier', 'expectedRdsInstanceClass', 'initialPosture', 'requestedPosture') `
            -Name 'manifest.databaseInsightsLease'
        if ([string]$script:Manifest.databaseInsightsLease.version -cne 'database-insights-monitoring-lease-v3' -or
            [string]$script:Manifest.databaseInsightsLease.leasePurpose -cne 'diagnostic') {
            throw 'The planned Database Insights lease contract is ineligible.'
        }
    }
    elseif ($script:Manifest.Contains('historyFallbackQueryIdentity') -or $script:Manifest.Contains('databaseInsightsLease')) {
        throw 'A diagnostic-ineligible rehearsal must not bind query or Database Insights lease artifacts.'
    }
}

function Assert-CurrentWindowContract {
    foreach ($field in @('earliestUtc', 'latestUtc')) {
        try {
            $parsed = [DateTimeOffset]::ParseExact(
                [string]$script:Manifest.executionWindow[$field], 'o',
                [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind
            )
        }
        catch { throw "executionWindow.$field is not a round-trip timestamp." }
        if ($parsed.Offset -ne [TimeSpan]::Zero) { throw "executionWindow.$field must have zero offset." }
    }
    $earliest = [DateTimeOffset]::ParseExact([string]$script:Manifest.executionWindow.earliestUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    $latest = [DateTimeOffset]::ParseExact([string]$script:Manifest.executionWindow.latestUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    if ($latest -le $earliest) { throw 'The execution window must have positive duration.' }
    [void](Convert-ToPinnedLocalIso -Instant $earliest)
    [void](Convert-ToPinnedLocalIso -Instant $latest)
}

function Assert-RepositoryIdentity {
    $repo = [string]$script:Manifest.repositoryRoot
    $head = (& git -C $repo rev-parse HEAD).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $head -cne [string]$script:Manifest.release.applicationGitSha -or
        $head -cne [string]$script:Manifest.release.controllerGitSha) {
        throw 'Repository HEAD does not match the manifest release.'
    }
    if ($script:Manifest.diagnosticEligible -eq $true) {
        $origin = (& git -C $repo rev-parse origin/main).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0) { throw 'Repository origin/main cannot be resolved.' }
        $branch = (& git -C $repo branch --show-current).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Repository branch cannot be resolved.' }
        $dirty = @(& git -C $repo status --porcelain)
        if ($LASTEXITCODE -ne 0 -or $origin -cne $head -or $branch -cne 'main' -or $dirty.Count -ne 0) {
            throw 'A diagnostic-eligible preparation requires clean main equal to origin/main.'
        }
    }
}

function Unprotect-EntropyDpapiPassword {
    param([string]$Path)
    $document = Read-PrivateJson -Path $Path -Depth 10
    if ([int]$document.version -ne 1 -or [string]$document.protection -cne 'Windows CurrentUser DPAPI') {
        throw 'The super-admin DPAPI document has an unexpected contract.'
    }
    $entropy = [Convert]::FromBase64String([string]$document.entropyB64)
    $protected = [Convert]::FromBase64String([string]$document.protectedPasswordB64)
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
    try { return [Net.NetworkCredential]::new('', $secure).Password }
    finally { $secure.Dispose() }
}

function Read-ProductionCredentials {
    $fixturePasswords = Read-PrivateJson -Path ([string]$script:Manifest.fixture.fixturePasswords.path) -Depth 10
    $operation = Read-PrivateJson -Path ([string]$script:Manifest.fixture.superAdminOperation.path) -Depth 20
    $config = Read-PrivateJson -Path ([string]$script:Manifest.fixture.config.path) -Depth 20
    if ([string]$fixturePasswords.fixtureId -cne [string]$script:Manifest.fixture.fixtureId -or
        [string]$config.fixtureId -cne [string]$script:Manifest.fixture.fixtureId -or
        [string]$operation.status -cne 'reset_verified_ephemeral_aws_secret_removed' -or
        [string]::IsNullOrWhiteSpace([string]$operation.targetEmail)) {
        throw 'Credential or fixture identity validation failed.'
    }
    $super = Unprotect-EntropyDpapiPassword -Path ([string]$script:Manifest.fixture.superAdminPassword.path)
    $admin = Unprotect-SecureStringPassword -Ciphertext ([string]$fixturePasswords.adminDpapi)
    $teacher = Unprotect-SecureStringPassword -Ciphertext ([string]$fixturePasswords.teacherDpapi)
    if ($super.Length -ne [int]$operation.temporaryPasswordLength -or $admin.Length -lt 16 -or $teacher.Length -lt 16) {
        throw 'A fixture credential decrypted to an unexpected length.'
    }
    return [ordered]@{ superAdminPassword = $super; adminPassword = $admin; teacherPassword = $teacher; targetEmail = [string]$operation.targetEmail }
}

function Invoke-ProductionFixtureCommand {
    param([string]$Command, [string]$RunDirectory)
    $node = (Get-Command node -ErrorAction Stop).Source
    $stdout = Join-Path $RunDirectory "$Command.stdout.log"
    $stderr = Join-Path $RunDirectory "$Command.stderr.log"
    $arguments = @(
        [string]$script:Manifest.fixture.fixtureCli.path,
        $Command,
        '--config', [string]$script:Manifest.fixture.config.path,
        '--output', [string]$script:Manifest.fixture.sourceRoot
    )
    $cliIdentity = Assert-RepositoryTrackedFixtureCli
    $workerBinding = Get-ControllerArtifactBinding -Kind 'fixture-worker'
    $currentWorkerSha = Get-Sha256 $PSCommandPath
    if ($currentWorkerSha -cne [string]$workerBinding.sha256 -or
        -not [string]::Equals([IO.Path]::GetFullPath($PSCommandPath), [IO.Path]::GetFullPath([string]$workerBinding.path), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The active fixture worker changed before production fixture execution.'
    }
    $workerIdentity = Get-ProcessIdentity -Process (Get-Process -Id $PID) -Kind 'fixture-worker'
    # This admitted record is flushed with WriteThrough/Flush(true) before the
    # production child exists, so mutation admission is never inferred later.
    [void](Add-JournalRecord -Stage "${Command}_admitted" -Status 'running' -Process $workerIdentity `
        -ArtifactHashes ([ordered]@{
            fixtureCliSha256 = [string]$cliIdentity.sha256
            fixtureCliGitObjectIdSha256 = Get-StringSha256 -Value ([string]$cliIdentity.gitObjectId)
            fixtureWorkerSha256 = $currentWorkerSha
            supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
        }))
    # Hash and Git-index identity are checked again at the immediate launch
    # boundary, after the durable admission record.
    $cliIdentity = Assert-RepositoryTrackedFixtureCli
    $process = Start-Process -FilePath $node -ArgumentList $arguments -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $identity = Get-ProcessIdentity -Process $process -Kind "fixture-$Command"
    [void](Add-JournalRecord -Stage "${Command}_child_started" -Status 'running' -Process $identity `
        -ArtifactHashes ([ordered]@{
            fixtureCliSha256 = [string]$cliIdentity.sha256
            fixtureWorkerSha256 = $currentWorkerSha
            supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
        }))
    $process.WaitForExit()
    $exit = [int]$process.ExitCode
    $completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    [void](Add-JournalRecord -Stage "${Command}_completed" -Status $(if ($exit -eq 0) { 'completed' } else { 'failed' }) `
        -Process $identity -ExitCode $exit -ArtifactHashes ([ordered]@{
            stdoutSha256 = $(if (Test-Path -LiteralPath $stdout) { Get-Sha256 $stdout } else { $null })
            stderrSha256 = $(if (Test-Path -LiteralPath $stderr) { Get-Sha256 $stderr } else { $null })
        }))
    if ($exit -ne 0) { throw "Fixture $Command process failed." }
    Set-ExactPrivateAcl -Path $stdout -Directory $false
    Set-ExactPrivateAcl -Path $stderr -Directory $false
    try { $summary = Get-Content -LiteralPath $stdout -Raw | ConvertFrom-Json -DateKind String -AsHashtable -Depth 30 }
    catch { throw "Fixture $Command summary is malformed." }
    if ([string]$summary.command -cne $Command -or [string]$summary.fixtureId -cne [string]$script:Manifest.fixture.fixtureId -or
        ($Command -ceq 'verify' -and $summary.passed -ne $true)) {
        throw "Fixture $Command summary failed identity or acceptance validation."
    }
    return [ordered]@{
        summary = $summary; stdoutPath = $stdout; stderrPath = $stderr
        exitCode = $exit; process = $identity; completedAtUtc = $completedAtUtc
    }
}

function Invoke-OfflineTestFault {
    param([string]$Stage)
    if ($Mode -ceq 'Run' -and
        $script:Manifest.diagnosticEligible -eq $false -and
        [string]$script:Manifest.fixture.provider -ceq 'offline-fake' -and
        $script:Manifest.Contains('testControls') -and
        $script:Manifest.testControls.Contains('faultStage') -and
        [string]$script:Manifest.testControls.faultStage -ceq $Stage) {
        throw 'A manifest-bound offline rehearsal fault was triggered.'
    }
}

function Write-OfflineFakePrivateJson {
    param([string]$Path, $Value)
    if ($script:Manifest.diagnosticEligible -ne $false -or
        [string]$script:Manifest.fixture.provider -cne 'offline-fake') {
        throw 'Offline fake JSON rewriting is not available to diagnostic-eligible preparation.'
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 100))
    $stream = [IO.FileStream]::new(
        $Path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None,
        4096, [IO.FileOptions]::WriteThrough
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    # Rewriting an already-sealed rehearsal file preserves its protected ACL.
    # Reapplying the identical descriptor can make Windows request SACL
    # privileges that the unprivileged preparation host intentionally lacks.
    Assert-ExactPrivateAcl -Path $Path -Directory $false
}

function Invoke-OfflineFakeFixtureCommand {
    param([string]$Command, [string]$RunDirectory)
    $stdout = Join-Path $RunDirectory "$Command.stdout.log"
    $stderr = Join-Path $RunDirectory "$Command.stderr.log"
    $identity = Get-ProcessIdentity -Process (Get-Process -Id $PID) -Kind "offline-fake-$Command"
    [void](Add-JournalRecord -Stage "${Command}_admitted" -Status 'running' -Process $identity `
        -ArtifactHashes ([ordered]@{
            fixtureCliSha256 = [string]$script:Manifest.fixture.fixtureCli.sha256
            fixtureWorkerSha256 = $script:WorkerSha256
            supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
        }))
    Invoke-OfflineTestFault -Stage "after_${Command}_admitted"
    if ($script:Manifest.Contains('testControls') -and
        $script:Manifest.testControls.Contains('faultStage') -and
        [string]$script:Manifest.testControls.faultStage -ceq "${Command}_nonzero") {
        [void](Add-JournalRecord -Stage "${Command}_completed" -Status 'failed' -Process $identity -ExitCode 1)
        throw "The offline fixture $Command command returned nonzero."
    }
    if ($Command -ceq 'refresh') {
        $sourceRoot = [string]$script:Manifest.fixture.sourceRoot
        if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
            [void](New-Item -ItemType Directory -Path $sourceRoot)
            Set-ExactPrivateAcl -Path $sourceRoot -Directory $true
        }
        else { Assert-ExactPrivateAcl -Path $sourceRoot -Directory $true }
        foreach ($name in $script:RequiredSnapshotFiles) {
            $destination = Join-Path $sourceRoot $name
            [IO.File]::Copy((Join-Path ([string]$script:Manifest.fixture.fakeTemplateRoot) $name), $destination, $true)
            [IO.File]::SetLastWriteTimeUtc($destination, [DateTime]::UtcNow)
            Set-ExactPrivateAcl -Path $destination -Directory $false
        }
        foreach ($name in $script:AllowedSourceSupportFiles) {
            $templateSupport = Join-Path ([string]$script:Manifest.fixture.fakeTemplateRoot) $name
            if (-not (Test-Path -LiteralPath $templateSupport -PathType Leaf)) { continue }
            $destination = Join-Path $sourceRoot $name
            [IO.File]::Copy($templateSupport, $destination, $true)
            [IO.File]::SetLastWriteTimeUtc($destination, [DateTime]::UtcNow)
            Set-ExactPrivateAcl -Path $destination -Directory $false
        }
        $fakeNow = [DateTimeOffset]::UtcNow
        $state = Read-PrivateJson -Path (Join-Path $sourceRoot 'fixture-state.private.json')
        $state.refreshedAt = $fakeNow.ToString('o')
        $state.hold = $null
        $state.cleanup = $null
        Write-OfflineFakePrivateJson -Path (Join-Path $sourceRoot 'fixture-state.private.json') -Value $state
        $auth = Read-PrivateJson -Path (Join-Path $sourceRoot 'load-auth.private.json')
        $credentialMarginSeconds = if ($script:Manifest.Contains('testControls') -and
            $script:Manifest.testControls.Contains('offlineFakeCredentialValidityMarginSeconds')) {
            [int]$script:Manifest.testControls.offlineFakeCredentialValidityMarginSeconds
        }
        else { 3600 }
        $fakeExpiry = $fakeNow.AddSeconds(
            [int]$script:Manifest.fixture.requiredArtifactValiditySeconds + $credentialMarginSeconds
        ).ToString('o')
        $auth.expiresAt = $fakeExpiry
        $auth.deviceManifestExpiresAt = $fakeExpiry
        Write-OfflineFakePrivateJson -Path (Join-Path $sourceRoot 'load-auth.private.json') -Value $auth
        $summary = [ordered]@{
            command = 'refresh'; fixtureId = [string]$script:Manifest.fixture.fixtureId
            devicesRegistered = 1010; teachingSessionsStarted = 20
            authorizationPlanCohortsReady = $true; officeSupervisionStudents = 40; commandBodiesWritten = 20
        }
    }
    else {
        $verification = Read-PrivateJson -Path (Join-Path ([string]$script:Manifest.fixture.sourceRoot) 'verification.private.json')
        $verification.verifiedAt = [DateTimeOffset]::UtcNow.ToString('o')
        Write-OfflineFakePrivateJson `
            -Path (Join-Path ([string]$script:Manifest.fixture.sourceRoot) 'verification.private.json') `
            -Value $verification
        $summary = [ordered]@{
            command = 'verify'; fixtureId = [string]$script:Manifest.fixture.fixtureId; passed = $true
            schools = 2; teachers = 20; officeStaff = 1; students = 1010; classes = 20
            classRosterStudents = 800; devices = 1010; activeDeviceSessions = 1010
            activeSessions = 20; commandBodies = 20
        }
    }
    Write-PrivateJsonAtomic -Path $stdout -Value $summary -Immutable
    $empty = [Text.UTF8Encoding]::new($false).GetBytes('')
    [IO.File]::WriteAllBytes($stderr, $empty)
    Set-ExactPrivateAcl -Path $stderr -Directory $false
    [void](Add-JournalRecord -Stage "${Command}_completed" -Status 'completed' -Process $identity -ExitCode 0 `
        -ArtifactHashes ([ordered]@{ stdoutSha256 = Get-Sha256 $stdout; stderrSha256 = Get-Sha256 $stderr }))
    Invoke-OfflineTestFault -Stage "after_${Command}_completed"
    return [ordered]@{
        summary = $summary; stdoutPath = $stdout; stderrPath = $stderr
        exitCode = 0; process = $identity; completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    }
}

function Assert-FreshFixtureContract {
    param([DateTimeOffset]$RunStartUtc)
    $sourceRoot = [string]$script:Manifest.fixture.sourceRoot
    Assert-ExactPrivateAcl -Path $sourceRoot -Directory $true
    foreach ($name in $script:RequiredSnapshotFiles) {
        $path = Join-Path $sourceRoot $name
        Assert-File -Path $path -Name $name
        Assert-ExactPrivateAcl -Path $path -Directory $false
        if ((Get-Item -LiteralPath $path).LastWriteTimeUtc -lt $RunStartUtc.UtcDateTime.AddSeconds(-5)) {
            throw 'A fixture artifact was not freshly written by this bounded preparation.'
        }
    }
    $state = Read-PrivateJson -Path (Join-Path $sourceRoot 'fixture-state.private.json')
    $verification = Read-PrivateJson -Path (Join-Path $sourceRoot 'verification.private.json')
    $devices = @(Read-PrivateJson -Path (Join-Path $sourceRoot 'load-devices.private.json'))
    $auth = Read-PrivateJson -Path (Join-Path $sourceRoot 'load-auth.private.json')
    $commands = @(Read-PrivateJson -Path (Join-Path $sourceRoot 'load-command-bodies.private.json'))
    $refreshedAt = [DateTimeOffset]::Parse([string]$state.refreshedAt, [Globalization.CultureInfo]::InvariantCulture)
    $verifiedAt = [DateTimeOffset]::Parse([string]$verification.verifiedAt, [Globalization.CultureInfo]::InvariantCulture)
    $futureLimit = [DateTimeOffset]::UtcNow.AddMinutes(5)
    if ([string]$state.fixtureId -cne [string]$script:Manifest.fixture.fixtureId -or
        $refreshedAt -lt $RunStartUtc.AddSeconds(-5) -or $refreshedAt -gt $futureLimit -or
        ($state.Contains('hold') -and $null -ne $state.hold) -or ($state.Contains('cleanup') -and $null -ne $state.cleanup)) {
        throw 'Fresh fixture state is ineligible.'
    }
    if ($verification.passed -ne $true -or [string]$verification.fixtureId -cne [string]$script:Manifest.fixture.fixtureId -or
        $verifiedAt -lt $RunStartUtc.AddSeconds(-5) -or $verifiedAt -lt $refreshedAt -or $verifiedAt -gt $futureLimit -or
        [int]$verification.counts.schools -ne 2 -or [int]$verification.counts.teachers -ne 20 -or
        [int]$verification.counts.officeStaff -ne 1 -or [int]$verification.counts.students -ne 1010 -or
        [int]$verification.counts.classes -ne 20 -or [int]$verification.counts.classRosterStudents -ne 800 -or
        [int]$verification.counts.devices -ne 1010 -or [int]$verification.counts.activeDeviceSessions -ne 1010 -or
        [int]$verification.counts.activeSessions -ne 20 -or [int]$verification.counts.commandBodies -ne 20 -or
        [int]$verification.counts.authorizationPlanCohorts.coTeacherStudents -ne 40 -or
        [int]$verification.counts.authorizationPlanCohorts.officeSupervisionStudents -ne 40 -or
        [int]$verification.counts.liveAuth.commandAdministrators -ne 1 -or
        [int]$verification.counts.liveAuth.teachers -ne 20 -or
        $verification.gates.autoEnrollDisabled -ne $true -or $verification.gates.trackingDisabled -ne $true -or
        $verification.gates.schedulesDisabled -ne $true -or $verification.gates.exactSchoolTimezones -ne $true -or
        $verification.gates.classRostersExactAndDisjoint -ne $true -or
        $verification.gates.authorizationPlanCohortsExact -ne $true -or
        $verification.gates.authorizationPlanOfficeStudentsOutsideTeacherRosters -ne $true -or
        $verification.gates.allDeviceTokensLive -ne $true -or $verification.gates.allStaffAuthArtifactsLive -ne $true) {
        throw 'Fresh fixture verification does not satisfy the exact diagnostic contract.'
    }
    foreach ($school in @('primary', 'canary')) {
        if ([string]$verification.schoolTimezones[$school].schoolTimezone -cne [string]$script:Manifest.executionWindow.timezone -or
            [string]$verification.schoolTimezones[$school].schoolHoursTimezone -cne [string]$script:Manifest.executionWindow.timezone) {
            throw 'Fresh fixture timezone validation failed.'
        }
    }
    if ($devices.Count -ne 1010 -or $commands.Count -ne 20 -or @($auth.teacherAuth).Count -ne 20 -or
        [string]$auth.baseUrl -cne [string]$script:Manifest.fixture.baseUrl) {
        throw 'Fresh fixture artifact counts or origin are invalid.'
    }
    $expiresAt = [DateTimeOffset]::Parse([string]$auth.expiresAt, [Globalization.CultureInfo]::InvariantCulture)
    $deviceExpiresAt = [DateTimeOffset]::Parse([string]$auth.deviceManifestExpiresAt, [Globalization.CultureInfo]::InvariantCulture)
    $requiredUntil = [DateTimeOffset]::UtcNow.AddSeconds([int]$script:Manifest.fixture.requiredArtifactValiditySeconds)
    if ($expiresAt -le $requiredUntil -or $deviceExpiresAt -le $requiredUntil) {
        throw 'Fresh fixture credentials do not satisfy the required remaining validity.'
    }
    return [ordered]@{
        refreshedAtUtc = $refreshedAt.ToUniversalTime().ToString('o')
        verifiedAtUtc = $verifiedAt.ToUniversalTime().ToString('o')
        checkedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        requiredVerificationMaximumAgeMinutes = [int]$script:Manifest.fixture.requiredVerificationMaximumAgeMinutes
        requiredArtifactValiditySeconds = [int]$script:Manifest.fixture.requiredArtifactValiditySeconds
        expiresAtUtc = $expiresAt.ToUniversalTime().ToString('o')
        deviceManifestExpiresAtUtc = $deviceExpiresAt.ToUniversalTime().ToString('o')
    }
}

function Assert-ExactSourceRootArtifactSet {
    $sourceRoot = [string]$script:Manifest.fixture.sourceRoot
    Assert-ExactPrivateAcl -Path $sourceRoot -Directory $true
    $entries = @(Get-ChildItem -LiteralPath $sourceRoot -Force -ErrorAction Stop)
    $names = @($entries | ForEach-Object { $_.Name } | Sort-Object)
    $requiredMissing = @($script:RequiredSnapshotFiles | Where-Object { $_ -cnotin $names })
    $unexpected = @($names | Where-Object {
            $_ -cnotin $script:RequiredSnapshotFiles -and $_ -cnotin $script:AllowedSourceSupportFiles
        })
    if ($requiredMissing.Count -ne 0 -or $unexpected.Count -ne 0 -or
        @($entries | Where-Object { $_.PSIsContainer -or (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) }).Count -ne 0) {
        throw 'The fixture source root must contain all five snapshot artifacts and only allowlisted ordinary support artifacts.'
    }
    foreach ($entry in $entries) { Assert-ExactPrivateAcl -Path $entry.FullName -Directory $false }
}

function Get-SourceArtifacts {
    Assert-ExactSourceRootArtifactSet
    $artifacts = @()
    foreach ($name in $script:RequiredSnapshotFiles) {
        $path = Join-Path ([string]$script:Manifest.fixture.sourceRoot) $name
        $item = Get-Item -LiteralPath $path
        $artifacts += [ordered]@{
            name = $name
            sourcePath = $path
            targetPath = Join-Path ([string]$script:Manifest.paths.snapshotRoot) $name
            sha256 = Get-Sha256 $path
            size = [long]$item.Length
            lastWriteTimeUtc = ([DateTimeOffset]$item.LastWriteTimeUtc).ToString('o')
        }
    }
    return @($artifacts)
}

function Assert-ReceiptSourcesCurrent {
    param([Collections.IDictionary]$Receipt, [switch]$RequireFresh)
    Assert-ExactSourceRootArtifactSet
    $artifacts = @($Receipt.snapshot.artifacts)
    if ($artifacts.Count -ne 5) { throw 'The fixture preparation receipt does not bind five artifacts.' }
    $names = @($artifacts | ForEach-Object { [string]$_.name } | Sort-Object)
    if (@(Compare-Object ($script:RequiredSnapshotFiles | Sort-Object) $names).Count -ne 0) {
        throw 'The fixture preparation receipt file set is invalid.'
    }
    foreach ($artifact in $artifacts) {
        $source = [string]$artifact.sourcePath
        Assert-File -Path $source -Name 'receipt-bound source artifact'
        Assert-ExactPrivateAcl -Path $source -Directory $false
        $item = Get-Item -LiteralPath $source
        $expectedSource = Join-Path ([string]$script:Manifest.fixture.sourceRoot) ([string]$artifact.name)
        $expectedTarget = Join-Path ([string]$script:Manifest.paths.snapshotRoot) ([string]$artifact.name)
        if ([string]$artifact.sourcePath -cne $expectedSource -or [string]$artifact.targetPath -cne $expectedTarget -or
            (Get-Sha256 $source) -cne [string]$artifact.sha256 -or [long]$item.Length -ne [long]$artifact.size -or
            ([DateTimeOffset]$item.LastWriteTimeUtc).ToString('o') -cne [string]$artifact.lastWriteTimeUtc) {
            throw 'A receipt-bound fixture source changed after sealing.'
        }
    }
    if ($RequireFresh) {
        $recoveryClockAdvanceSeconds = if ($script:Manifest.Contains('testControls') -and
            $script:Manifest.testControls.Contains('offlineRecoveryClockAdvanceSeconds')) {
            [int]$script:Manifest.testControls.offlineRecoveryClockAdvanceSeconds
        }
        else { 0 }
        $now = [DateTimeOffset]::UtcNow.AddSeconds($recoveryClockAdvanceSeconds)
        $verified = [DateTimeOffset]::Parse([string]$Receipt.freshness.verifiedAtUtc, [Globalization.CultureInfo]::InvariantCulture)
        if (($now - $verified).TotalMinutes -gt [int]$Receipt.freshness.requiredVerificationMaximumAgeMinutes -or
            [DateTimeOffset]::Parse([string]$Receipt.credentials.expiresAtUtc, [Globalization.CultureInfo]::InvariantCulture) -le $now.AddSeconds([int]$Receipt.credentials.requiredValiditySeconds) -or
            [DateTimeOffset]::Parse([string]$Receipt.credentials.deviceManifestExpiresAtUtc, [Globalization.CultureInfo]::InvariantCulture) -le $now.AddSeconds([int]$Receipt.credentials.requiredValiditySeconds)) {
            throw 'The sealed fixture evidence is no longer fresh enough for publication recovery.'
        }
    }
    return $artifacts
}

function Assert-FinalSnapshot {
    param([object[]]$Artifacts)
    $root = [string]$script:Manifest.paths.snapshotRoot
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'The final snapshot root is absent.' }
    Assert-ExactPrivateAcl -Path $root -Directory $true
    $items = @(Get-ChildItem -LiteralPath $root -Force)
    if ($items.Count -ne 5 -or @($items | Where-Object { $_.PSIsContainer }).Count -ne 0 -or
        @(Compare-Object ($script:RequiredSnapshotFiles | Sort-Object) (@($items.Name) | Sort-Object)).Count -ne 0) {
        throw 'The final snapshot is not the exact five-file contract.'
    }
    foreach ($artifact in $Artifacts) {
        $path = Join-Path $root ([string]$artifact.name)
        Assert-ExactPrivateAcl -Path $path -Directory $false
        $item = Get-Item -LiteralPath $path
        if ((Get-Sha256 $path) -cne [string]$artifact.sha256 -or [long]$item.Length -ne [long]$artifact.size) {
            throw 'A final snapshot artifact differs from its sealed source.'
        }
    }
}

function Publish-Snapshot {
    param([object[]]$Artifacts, [switch]$Recovery)
    $snapshotRoot = [string]$script:Manifest.paths.snapshotRoot
    $snapshotParent = [IO.Path]::GetDirectoryName($snapshotRoot)
    $staging = Join-Path $snapshotParent ('.' + [string]$script:Manifest.runId + '.fixture-snapshot.staging')
    Assert-StrictChildPath -Child $staging -Parent $snapshotParent -Name 'snapshot staging root'
    Assert-StrictChildPath -Child $snapshotRoot -Parent $snapshotParent -Name 'snapshot root'
    if (-not (Test-Path -LiteralPath $snapshotParent -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $snapshotParent)
        Set-ExactPrivateAcl -Path $snapshotParent -Directory $true
    }
    else { Assert-ExactPrivateAcl -Path $snapshotParent -Directory $true }
    $stagingPrefix = '.' + [string]$script:Manifest.runId + '.'
    $unexpected = @(Get-ChildItem -LiteralPath $snapshotParent -Force -Directory -ErrorAction Stop |
        Where-Object {
            $_.Name.StartsWith($stagingPrefix, [StringComparison]::Ordinal) -and
            $_.Name.EndsWith('.staging', [StringComparison]::Ordinal) -and
            $_.FullName -cne $staging
        })
    if ($unexpected.Count -gt 0) { throw 'Ambiguous run-bound fixture snapshot staging directories exist.' }
    if (Test-Path -LiteralPath $snapshotRoot) {
        if (-not $Recovery) { throw 'The immutable fixture snapshot root already exists.' }
        Assert-FinalSnapshot -Artifacts $Artifacts
        return 'reconciled'
    }
    if (Test-Path -LiteralPath $staging) {
        if (-not $Recovery) { throw 'The run-bound fixture snapshot staging directory already exists.' }
        Assert-PrivateTreeSafeForRemoval -Path $staging -ExpectedParent $snapshotParent
        # Re-resolve the exact root and parent immediately before the recursive
        # operation. A junction/reparse swap must fail closed instead of
        # redirecting recovery cleanup outside the run-bound staging root.
        $stagingItem = Get-Item -LiteralPath $staging -Force -ErrorAction Stop
        if (-not $stagingItem.PSIsContainer -or
            ($stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [IO.Path]::GetFullPath($stagingItem.FullName) -cne [IO.Path]::GetFullPath($staging)) {
            throw 'The run-bound staging root changed before removal.'
        }
        $resolvedStagingParent = [IO.Path]::GetFullPath($stagingItem.Parent.FullName)
        if ($resolvedStagingParent -cne [IO.Path]::GetFullPath($snapshotParent)) {
            throw 'The run-bound staging parent changed before removal.'
        }
        Assert-StrictChildPath -Child $stagingItem.FullName -Parent $resolvedStagingParent `
            -Name 'revalidated removal target'
        [IO.Directory]::Delete($stagingItem.FullName, $true)
    }
    [void](Assert-CurrentWindow)
    [void](New-Item -ItemType Directory -Path $staging)
    Set-ExactPrivateAcl -Path $staging -Directory $true
    $copyIndex = 0
    foreach ($artifact in $Artifacts) {
        $source = [string]$artifact.sourcePath
        $destination = Join-Path $staging ([string]$artifact.name)
        $before = Get-Sha256 $source
        [IO.File]::Copy($source, $destination, $false)
        Set-ExactPrivateAcl -Path $destination -Directory $false
        if ((Get-Sha256 $source) -cne $before -or $before -cne [string]$artifact.sha256 -or
            (Get-Sha256 $destination) -cne $before) {
            throw 'Fixture source or destination drifted during publication.'
        }
        $copyIndex++
        if ($copyIndex -eq 1) { Invoke-OfflineTestFault -Stage 'publication_during_copy' }
    }
    if ((Get-ChildItem -LiteralPath $staging -Force).Count -ne 5 -or (Test-Path -LiteralPath $snapshotRoot)) {
        throw 'Atomic fixture publication precondition failed.'
    }
    Invoke-OfflineTestFault -Stage 'publication_before_rename'
    [void](Assert-CurrentWindow)
    [IO.Directory]::Move($staging, $snapshotRoot)
    Invoke-OfflineTestFault -Stage 'publication_after_rename_before_commit'
    Assert-ExactPrivateAcl -Path $snapshotRoot -Directory $true
    foreach ($artifact in $Artifacts) { Assert-ExactPrivateAcl -Path (Join-Path $snapshotRoot ([string]$artifact.name)) -Directory $false }
    Assert-FinalSnapshot -Artifacts $Artifacts
    return 'published'
}

function New-SanitizedVerificationBinding {
    $path = Join-Path ([string]$script:Manifest.fixture.sourceRoot) 'verification.private.json'
    $verification = Read-PrivateJson -Path $path
    $counts = [ordered]@{
        schools = [int]$verification.counts.schools
        teachers = [int]$verification.counts.teachers
        officeStaff = [int]$verification.counts.officeStaff
        students = [int]$verification.counts.students
        classes = [int]$verification.counts.classes
        classRosterStudents = [int]$verification.counts.classRosterStudents
        devices = [int]$verification.counts.devices
        activeDeviceSessions = [int]$verification.counts.activeDeviceSessions
        activeSessions = [int]$verification.counts.activeSessions
        commandBodies = [int]$verification.counts.commandBodies
        authorizationPlanCohorts = [ordered]@{
            coTeacherStudents = [int]$verification.counts.authorizationPlanCohorts.coTeacherStudents
            officeSupervisionStudents = [int]$verification.counts.authorizationPlanCohorts.officeSupervisionStudents
        }
        liveAuth = [ordered]@{
            commandAdministrators = [int]$verification.counts.liveAuth.commandAdministrators
            teachers = [int]$verification.counts.liveAuth.teachers
        }
    }
    $gates = [ordered]@{
        autoEnrollDisabled = [bool]$verification.gates.autoEnrollDisabled
        trackingDisabled = [bool]$verification.gates.trackingDisabled
        schedulesDisabled = [bool]$verification.gates.schedulesDisabled
        exactSchoolTimezones = [bool]$verification.gates.exactSchoolTimezones
        classRostersExactAndDisjoint = [bool]$verification.gates.classRostersExactAndDisjoint
        authorizationPlanCohortsExact = [bool]$verification.gates.authorizationPlanCohortsExact
        authorizationPlanOfficeStudentsOutsideTeacherRosters = [bool]$verification.gates.authorizationPlanOfficeStudentsOutsideTeacherRosters
        allDeviceTokensLive = [bool]$verification.gates.allDeviceTokensLive
        allStaffAuthArtifactsLive = [bool]$verification.gates.allStaffAuthArtifactsLive
    }
    $canonical = [ordered]@{ counts = $counts; gates = $gates }
    return [ordered]@{
        artifactSha256 = Get-Sha256 $path
        counts = $counts
        gates = $gates
        countsAndGatesSha256 = Get-StringSha256 -Value ($canonical | ConvertTo-Json -Compress -Depth 20)
    }
}

function New-PreparationReceipt {
    param(
        [DateTimeOffset]$RunStartUtc,
        [string]$RunDirectory,
        [Collections.IDictionary]$Refresh,
        [Collections.IDictionary]$Verify,
        [Collections.IDictionary]$Freshness,
        [object[]]$Artifacts,
        [string]$SourceSealedRecordHash
    )
    $nonceBytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($nonceBytes)
    try { $nonce = [Convert]::ToBase64String($nonceBytes) }
    finally { [Security.Cryptography.CryptographicOperations]::ZeroMemory($nonceBytes) }
    $verificationBinding = New-SanitizedVerificationBinding
    return [ordered]@{
        schemaVersion = 1
        type = 'fixture_preparation_receipt'
        version = 'fixture-preparation-receipt-v1'
        status = 'sources_sealed'
        runId = [string]$script:Manifest.runId
        diagnosticOnly = $true
        diagnosticEligible = [bool]$script:Manifest.diagnosticEligible
        certificationEligible = $false
        sealedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        manifest = [ordered]@{ path = $ManifestPath; sha256 = $script:ManifestSha256 }
        release = $script:Manifest.release
        controllerArtifacts = @($script:Manifest.controllerArtifacts)
        supervisorAdmission = $script:SupervisorAdmission
        fixture = [ordered]@{
            fixtureId = [string]$script:Manifest.fixture.fixtureId
            provider = [string]$script:Manifest.fixture.provider
            sourceRoot = [string]$script:Manifest.fixture.sourceRoot
            fixtureCli = $script:Manifest.fixture.fixtureCli
            config = $script:Manifest.fixture.config
        }
        execution = [ordered]@{
            runStartedAtUtc = $RunStartUtc.ToString('o')
            runDirectory = $RunDirectory
            refreshCompletedAtUtc = [string]$Refresh.completedAtUtc
            verificationCompletedAtUtc = [string]$Verify.completedAtUtc
            refreshExitCode = [int]$Refresh.exitCode
            verificationExitCode = [int]$Verify.exitCode
            refreshStdoutSha256 = Get-Sha256 ([string]$Refresh.stdoutPath)
            refreshStderrSha256 = Get-Sha256 ([string]$Refresh.stderrPath)
            verifyStdoutSha256 = Get-Sha256 ([string]$Verify.stdoutPath)
            verifyStderrSha256 = Get-Sha256 ([string]$Verify.stderrPath)
            workerProcess = Get-ProcessIdentity -Process (Get-Process -Id $PID) -Kind 'fixture-worker'
        }
        freshness = $Freshness
        verification = $verificationBinding
        credentials = [ordered]@{
            expiresAtUtc = [string]$Freshness.expiresAtUtc
            deviceManifestExpiresAtUtc = [string]$Freshness.deviceManifestExpiresAtUtc
            requiredValiditySeconds = [int]$Freshness.requiredArtifactValiditySeconds
        }
        snapshot = [ordered]@{
            root = [string]$script:Manifest.paths.snapshotRoot
            contract = 'unique-root-no-overwrite-atomic-five-file-v1'
            artifactSetSha256 = Get-SnapshotArtifactSetSha256 -Artifacts $Artifacts
            artifacts = @($Artifacts)
        }
        recovery = [ordered]@{ allowedAttempts = 1; nonce = $nonce }
        journal = [ordered]@{ path = [string]$script:Manifest.paths.journalPath; sourceSealedRecordHash = $SourceSealedRecordHash }
        secretsPrinted = $false
        trafficStarted = $false
        leaseAcquired = $false
    }
}

function Get-PreparationMutexName {
    return 'Local\SchoolPilot.Waf800DiagnosticPreparation.' + (Get-StringSha256 -Value ([string]$script:Manifest.runId)).Substring(0, 32)
}

function Invoke-WithPreparationMutex {
    param([scriptblock]$Operation)
    $mutex = [Threading.Mutex]::new($false, (Get-PreparationMutexName))
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Another process owns this diagnostic preparation run.' }
        return & $Operation
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Assert-NoDownstreamArtifacts {
    foreach ($field in @('leaseReceiptPath', 'bindingRoot', 'evidenceDirectory', 'startGatePath', 'trafficMarkerPath')) {
        if (Test-Path -LiteralPath ([string]$script:Manifest.paths[$field])) {
            throw 'A downstream lease, binding, evidence, start-gate, or traffic artifact blocks diagnostic preparation.'
        }
    }
}

function Assert-SupervisorTerminated {
    $statePath = [string]$script:Manifest.paths.supervisorStatePath
    $state = Read-PrivateJson -Path $statePath -Depth 30
    Assert-ExactKeys -Value $state -Required @(
        'schemaVersion', 'type', 'runId', 'manifestSha256', 'status', 'supervisor', 'worker'
    ) -Optional @(
        'version', 'updatedAtUtc', 'ticketPath', 'resultPath', 'resultSha256', 'resultStatus', 'failureCode',
        'originalExecution', 'workerOwnership', 'recoveryAdmission'
    ) -Name 'supervisor state'
    if ([int]$state.schemaVersion -ne 1 -or [string]$state.type -cne 'waf800_diagnostic_prep_supervisor_state' -or
        [string]$state.runId -cne [string]$script:Manifest.runId -or
        [string]$state.manifestSha256 -cne $script:ManifestSha256) {
        throw 'The supervisor state identity is invalid.'
    }
    $original = if ($state.Contains('originalExecution')) { $state.originalExecution } else {
        [ordered]@{ status = $state.status; supervisor = $state.supervisor; worker = $state.worker }
    }
    if ($original -isnot [Collections.IDictionary] -or [string]$original.status -cnotin @('completed', 'failed', 'timed_out', 'interrupted')) {
        throw 'The original supervisor execution is not terminal.'
    }
    foreach ($identity in @($original.supervisor, $original.worker)) {
        if ($identity -isnot [Collections.IDictionary] -or -not $identity.Contains('pid') -or -not $identity.Contains('startedAtUtc')) {
            throw 'The supervisor state lacks a process creation identity.'
        }
        if (Test-BoundProcessPresent -Identity $identity) { throw 'The original diagnostic preparation process is still present.' }
    }
    $ownershipReference = if ($state.Contains('originalExecution')) {
        if (-not $original.Contains('workerOwnership')) { $null } else { $original.workerOwnership }
    } else {
        if (-not $state.Contains('workerOwnership')) { $null } else { $state.workerOwnership }
    }
    if ($ownershipReference -isnot [Collections.IDictionary]) {
        throw 'The original supervisor state lacks kill-on-close worker ownership evidence.'
    }
    Assert-ExactKeys -Value $ownershipReference -Required @('path', 'sha256') `
        -Name 'supervisor state worker ownership'
    $ownershipPath = Resolve-AbsolutePath -Value $ownershipReference.path `
        -Name 'original worker ownership path'
    $expectedOwnershipPath = Join-Path ([string]$script:Manifest.paths.runDirectoryRoot) `
        'worker-ownership.private.json'
    if (-not [string]::Equals($ownershipPath, $expectedOwnershipPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The original worker ownership proof path drifted.'
    }
    Assert-File -Path $ownershipPath -Name 'original worker ownership proof'
    Assert-ExactPrivateAcl -Path $ownershipPath -Directory $false
    Assert-HexSha256 -Value $ownershipReference.sha256 -Name 'original worker ownership sha256'
    if ((Get-Sha256 $ownershipPath) -cne [string]$ownershipReference.sha256) {
        throw 'The original worker ownership proof changed after supervision.'
    }
    $ownership = Read-PrivateJson -Path $ownershipPath -Depth 30
    Assert-ExactKeys -Value $ownership -Required @(
        'schemaVersion', 'type', 'version', 'runId', 'createdAtUtc', 'manifestSha256',
        'supervisorAdmissionSha256', 'supervisor', 'worker', 'jobPolicy', 'descendantPolicy'
    ) -Name 'original worker ownership proof'
    $ownershipCreatedAt = [DateTimeOffset]::MinValue
    if ([int]$ownership.schemaVersion -ne 1 -or
        [string]$ownership.type -cne 'diagnostic_prep_worker_ownership' -or
        [string]$ownership.version -cne 'diagnostic-prep-worker-job-v1' -or
        [string]$ownership.runId -cne [string]$script:Manifest.runId -or
        [string]$ownership.manifestSha256 -cne $script:ManifestSha256 -or
        [string]$ownership.supervisorAdmissionSha256 -cne
            [string]$script:SupervisorAdmission.originalTicketSha256 -or
        [string]$ownership.jobPolicy -cne 'kill-on-supervisor-close-v1' -or
        [string]$ownership.descendantPolicy -cne 'no-breakaway-v1' -or
        -not [DateTimeOffset]::TryParseExact(
            [string]$ownership.createdAtUtc, 'o', [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None, [ref]$ownershipCreatedAt
        ) -or $ownershipCreatedAt.Offset -ne [TimeSpan]::Zero -or
        [int]$ownership.supervisor.pid -ne [int]$original.supervisor.pid -or
        [string]$ownership.supervisor.startedAtUtc -cne [string]$original.supervisor.startedAtUtc -or
        -not [string]::Equals(
            [string]$ownership.supervisor.path, [string]$original.supervisor.path,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        [int]$ownership.worker.pid -ne [int]$original.worker.pid -or
        [string]$ownership.worker.startedAtUtc -cne [string]$original.worker.startedAtUtc -or
        -not [string]::Equals(
            [string]$ownership.worker.path, [string]$original.worker.path,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The original worker ownership proof is not bound to the terminal execution.'
    }
    return $original
}

function Get-FailureCode {
    param([string]$Stage)
    $map = @{
        preflight = 'fixture_preparation_preflight_failed'
        rehearsal_delay = 'fixture_rehearsal_delay_failed'
        rehearsal_delay_launch = 'fixture_rehearsal_delay_launch_failed'
        rehearsal_delay_observation = 'fixture_rehearsal_delay_observation_failed'
        rehearsal_delay_wait = 'fixture_rehearsal_delay_wait_failed'
        rehearsal_output = 'fixture_rehearsal_output_failed'
        refresh = 'fixture_refresh_failed'
        verify = 'fixture_verification_failed'
        freshness = 'fixture_freshness_failed'
        source_seal = 'fixture_source_seal_failed'
        fixture_receipt = 'fixture_receipt_seal_boundary_failed'
        publication = 'fixture_snapshot_publication_failed'
        publication_complete = 'fixture_snapshot_publication_commit_boundary_failed'
        recovery = 'fixture_snapshot_recovery_failed'
        terminal = 'fixture_preparation_terminal_commit_failed'
    }
    if ($map.ContainsKey($Stage)) { return $map[$Stage] }
    return 'fixture_preparation_failed'
}

function Invoke-HarmlessDelay {
    param([int]$Seconds, [string]$RunDirectory)
    if ($Seconds -le 0) { return }
    $stdout = Join-Path $RunDirectory 'harmless-delay.stdout.log'
    $stderr = Join-Path $RunDirectory 'harmless-delay.stderr.log'
    $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
    $delayCommand = "Start-Sleep -Seconds $Seconds"
    $encodedDelayCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($delayCommand))
    $script:CurrentStage = 'rehearsal_delay_launch'
    $process = Start-Process -FilePath $pwsh -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedDelayCommand
    ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $script:CurrentStage = 'rehearsal_delay_observation'
    $identity = Get-ProcessIdentity -Process $process -Kind 'offline-harmless-delay'
    [void](Add-JournalRecord -Stage 'harmless_delay_started' -Status 'running' -Process $identity)
    $script:CurrentStage = 'rehearsal_delay_wait'
    $process.WaitForExit()
    [void](Add-JournalRecord -Stage 'harmless_delay_completed' `
        -Status $(if ($process.ExitCode -eq 0) { 'completed' } else { 'failed' }) `
        -Process $identity -ExitCode ([int]$process.ExitCode))
    if ($process.ExitCode -ne 0) { throw 'The offline harmless delay child failed.' }
    Set-ExactPrivateAcl -Path $stdout -Directory $false
    Set-ExactPrivateAcl -Path $stderr -Directory $false
}

function Write-HarmlessLargeOutput {
    param([int]$Bytes)
    if ($Bytes -le 0) { return }
    $stdoutRemaining = $Bytes
    $chunk = 65536
    while ($stdoutRemaining -gt 0) {
        $count = [Math]::Min($chunk, $stdoutRemaining)
        [Console]::Out.Write((' ' * $count))
        $stdoutRemaining -= $count
    }
    [Console]::Out.Flush()
}

function Invoke-RunPreparation {
    [void](Assert-CurrentWindow)
    $journalPath = [string]$script:Manifest.paths.journalPath
    if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) {
        throw 'The durable supervisor must pre-create the private empty preparation journal.'
    }
    Assert-ExactPrivateAcl -Path $journalPath -Directory $false
    if ((Get-Item -LiteralPath $journalPath).Length -ne 0 -or
        (Test-Path -LiteralPath ([string]$script:Manifest.paths.fixturePreparationReceiptPath)) -or
        (Test-Path -LiteralPath ([string]$script:Manifest.paths.publicationRecoveryReceiptPath)) -or
        (Test-Path -LiteralPath ([string]$script:Manifest.paths.snapshotRoot))) {
        throw 'This immutable diagnostic preparation run has already started.'
    }
    Assert-NoDownstreamArtifacts
    $script:CurrentStage = 'preflight'
    $self = Get-ProcessIdentity -Process (Get-Process -Id $PID) -Kind 'fixture-worker'
    [void](Add-JournalRecord -Stage 'preflight_accepted' -Status 'completed' -Process $self `
        -ArtifactHashes ([ordered]@{
            manifestSha256 = $script:ManifestSha256
            fixtureWorkerSha256 = $script:WorkerSha256
            supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
            supervisorAdmissionNonceSha256 = [string]$script:SupervisorAdmission.nonceSha256
        }))
    Invoke-OfflineTestFault -Stage 'after_preflight'
    $runStart = [DateTimeOffset]::UtcNow
    $runDirectory = Join-Path ([string]$script:Manifest.paths.runDirectoryRoot) $runStart.ToString('yyyyMMddTHHmmssfffffffZ')
    if (-not (Test-Path -LiteralPath ([string]$script:Manifest.paths.runDirectoryRoot) -PathType Container)) {
        [void](New-Item -ItemType Directory -Path ([string]$script:Manifest.paths.runDirectoryRoot))
        Set-ExactPrivateAcl -Path ([string]$script:Manifest.paths.runDirectoryRoot) -Directory $true
    }
    else { Assert-ExactPrivateAcl -Path ([string]$script:Manifest.paths.runDirectoryRoot) -Directory $true }
    [void](New-Item -ItemType Directory -Path $runDirectory)
    Set-ExactPrivateAcl -Path $runDirectory -Directory $true
    if ($script:Manifest.Contains('testControls')) {
        if ($script:Manifest.testControls.Contains('largeOutputBytes')) {
            $script:CurrentStage = 'rehearsal_output'
            [void](Add-JournalRecord -Stage 'harmless_output_started' -Status 'running')
            Write-HarmlessLargeOutput -Bytes ([int]$script:Manifest.testControls.largeOutputBytes)
            [void](Add-JournalRecord -Stage 'harmless_output_completed' -Status 'completed' `
                -ArtifactHashes ([ordered]@{ emittedBytes = [int]$script:Manifest.testControls.largeOutputBytes }))
        }
        if ($script:Manifest.testControls.Contains('harmlessDelaySeconds')) {
            $script:CurrentStage = 'rehearsal_delay'
            Invoke-HarmlessDelay -Seconds ([int]$script:Manifest.testControls.harmlessDelaySeconds) -RunDirectory $runDirectory
        }
    }

    $credentials = $null
    $managedNames = @(
        'CLP_SUPER_ADMIN_BEARER', 'CLP_SUPER_ADMIN_EMAIL', 'CLP_SUPER_ADMIN_PASSWORD',
        'CLP_FIXTURE_ADMIN_PASSWORD', 'CLP_FIXTURE_TEACHER_PASSWORD',
        'CLP_OPERATOR_ALIAS_CONFIRMED', 'CLP_CANARY_ALIAS_CONFIRMED'
    )
    $prior = @{}
    foreach ($name in $managedNames) { $prior[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        if ([string]$script:Manifest.fixture.provider -ceq 'production') {
            $credentials = Read-ProductionCredentials
            [Environment]::SetEnvironmentVariable('CLP_SUPER_ADMIN_BEARER', $null, 'Process')
            [Environment]::SetEnvironmentVariable('CLP_SUPER_ADMIN_EMAIL', [string]$credentials.targetEmail, 'Process')
            [Environment]::SetEnvironmentVariable('CLP_SUPER_ADMIN_PASSWORD', [string]$credentials.superAdminPassword, 'Process')
            [Environment]::SetEnvironmentVariable('CLP_FIXTURE_ADMIN_PASSWORD', [string]$credentials.adminPassword, 'Process')
            [Environment]::SetEnvironmentVariable('CLP_FIXTURE_TEACHER_PASSWORD', [string]$credentials.teacherPassword, 'Process')
            [Environment]::SetEnvironmentVariable('CLP_OPERATOR_ALIAS_CONFIRMED', [string]$script:Manifest.fixture.fixtureId, 'Process')
            [Environment]::SetEnvironmentVariable('CLP_CANARY_ALIAS_CONFIRMED', [string]$script:Manifest.fixture.fixtureId, 'Process')
        }
        $script:CurrentStage = 'refresh'
        [void](Assert-CurrentWindow)
        $refresh = if ([string]$script:Manifest.fixture.provider -ceq 'production') {
            Invoke-ProductionFixtureCommand -Command 'refresh' -RunDirectory $runDirectory
        }
        else { Invoke-OfflineFakeFixtureCommand -Command 'refresh' -RunDirectory $runDirectory }
        $script:CurrentStage = 'verify'
        [void](Assert-CurrentWindow)
        $verify = if ([string]$script:Manifest.fixture.provider -ceq 'production') {
            Invoke-ProductionFixtureCommand -Command 'verify' -RunDirectory $runDirectory
        }
        else { Invoke-OfflineFakeFixtureCommand -Command 'verify' -RunDirectory $runDirectory }
        $script:CurrentStage = 'freshness'
        $freshness = Assert-FreshFixtureContract -RunStartUtc $runStart
        [void](Add-JournalRecord -Stage 'freshness_accepted' -Status 'completed' `
            -ArtifactHashes ([ordered]@{ fixtureIdSha256 = Get-StringSha256 -Value ([string]$script:Manifest.fixture.fixtureId) }))
        Invoke-OfflineTestFault -Stage 'after_freshness_accepted'
        $script:CurrentStage = 'source_seal'
        $artifacts = @(Get-SourceArtifacts)
        $artifactSetHash = Get-SnapshotArtifactSetSha256 -Artifacts $artifacts
        $sourceRecordHash = Add-JournalRecord -Stage 'source_hashes_sealed' -Status 'completed' `
            -ArtifactHashes ([ordered]@{ snapshotArtifactSetSha256 = $artifactSetHash })
        Invoke-OfflineTestFault -Stage 'after_source_sealed'
        [void](Assert-CurrentWindow)
        $receipt = New-PreparationReceipt -RunStartUtc $runStart -RunDirectory $runDirectory `
            -Refresh $refresh -Verify $verify -Freshness $freshness -Artifacts $artifacts `
            -SourceSealedRecordHash $sourceRecordHash
        Write-PrivateJsonAtomic -Path ([string]$script:Manifest.paths.fixturePreparationReceiptPath) -Value $receipt -Immutable
        $receiptHash = Get-Sha256 ([string]$script:Manifest.paths.fixturePreparationReceiptPath)
        $verificationContractHash = [string]$receipt.verification.countsAndGatesSha256
        [void](Add-JournalRecord -Stage 'fixture_receipt_sealed' -Status 'completed' `
            -ArtifactHashes ([ordered]@{
                fixturePreparationReceiptSha256 = $receiptHash
                snapshotArtifactSetSha256 = $artifactSetHash
                verificationCountsAndGatesSha256 = $verificationContractHash
                supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
            }))
        $script:CurrentStage = 'fixture_receipt'
        Invoke-OfflineTestFault -Stage 'after_fixture_receipt_sealed'
        if ($script:Manifest.Contains('testControls') -and
            $script:Manifest.testControls.Contains('afterFixtureReceiptSealDelaySeconds')) {
            $script:CurrentStage = 'fixture_receipt_hold'
            Start-Sleep -Seconds ([int]$script:Manifest.testControls.afterFixtureReceiptSealDelaySeconds)
        }
        $script:CurrentStage = 'publication'
        [void](Assert-CurrentWindow)
        [void](Add-JournalRecord -Stage 'publication_started' -Status 'running' `
            -ArtifactHashes ([ordered]@{ fixturePreparationReceiptSha256 = $receiptHash; snapshotArtifactSetSha256 = $artifactSetHash }))
        $publication = Publish-Snapshot -Artifacts $artifacts
        [void](Add-JournalRecord -Stage 'publication_completed' -Status 'completed' `
            -ArtifactHashes ([ordered]@{
                fixturePreparationReceiptSha256 = $receiptHash
                snapshotArtifactSetSha256 = $artifactSetHash
                verificationCountsAndGatesSha256 = $verificationContractHash
            }))
        $script:CurrentStage = 'publication_complete'
        Invoke-OfflineTestFault -Stage 'after_publication_completed'
        $script:CurrentStage = 'terminal'
        $terminalHash = Add-JournalRecord -Stage 'terminal_commit' -Status 'completed' -Process $self `
            -ExitCode 0 -ArtifactHashes ([ordered]@{
                fixturePreparationReceiptSha256 = $receiptHash
                snapshotArtifactSetSha256 = $artifactSetHash
                verificationCountsAndGatesSha256 = $verificationContractHash
                supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
            })
        $script:JournalTerminalCommitted = $true
        return [ordered]@{
            valid = $true; mode = 'Run'; runId = [string]$script:Manifest.runId
            manifestSha256 = $script:ManifestSha256; status = 'completed'
            diagnosticEligible = [bool]$script:Manifest.diagnosticEligible
            trafficStarted = $false; leaseAcquired = $false
            journalTerminalHash = $terminalHash
            fixturePreparationReceiptSha256 = $receiptHash
            supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
            verificationCountsAndGatesSha256 = $verificationContractHash
            snapshotArtifactSetSha256 = $artifactSetHash; publication = $publication
            files = @($artifacts | ForEach-Object { [ordered]@{ name = $_.name; sha256 = $_.sha256 } })
        }
    }
    finally {
        foreach ($name in $managedNames) { [Environment]::SetEnvironmentVariable($name, $prior[$name], 'Process') }
        if ($null -ne $credentials) {
            $credentials.superAdminPassword = $null; $credentials.adminPassword = $null; $credentials.teacherPassword = $null
        }
    }
}

function Invoke-ResumePublication {
    [void](Assert-CurrentWindow)
    Assert-NoDownstreamArtifacts
    $originalExecution = Assert-SupervisorTerminated
    $script:CurrentStage = 'recovery'
    $receiptPath = [string]$script:Manifest.paths.fixturePreparationReceiptPath
    $receipt = Read-PrivateJson -Path $receiptPath
    Assert-ExactKeys -Value $receipt -Required @(
        'schemaVersion', 'type', 'version', 'status', 'runId', 'diagnosticOnly', 'diagnosticEligible',
        'certificationEligible', 'sealedAtUtc', 'manifest', 'release', 'controllerArtifacts',
        'supervisorAdmission', 'fixture', 'execution', 'freshness', 'verification', 'credentials',
        'snapshot', 'recovery', 'journal',
        'secretsPrinted', 'trafficStarted', 'leaseAcquired'
    ) -Name 'fixture preparation receipt'
    if ([int]$receipt.schemaVersion -ne 1 -or [string]$receipt.type -cne 'fixture_preparation_receipt' -or
        [string]$receipt.version -cne 'fixture-preparation-receipt-v1' -or [string]$receipt.status -cne 'sources_sealed' -or
        [string]$receipt.runId -cne [string]$script:Manifest.runId -or
        [string]$receipt.manifest.sha256 -cne $script:ManifestSha256 -or
        [bool]$receipt.diagnosticEligible -ne [bool]$script:Manifest.diagnosticEligible -or
        [int]$receipt.execution.refreshExitCode -ne 0 -or [int]$receipt.execution.verificationExitCode -ne 0 -or
        [int]$receipt.recovery.allowedAttempts -ne 1 -or [string]::IsNullOrWhiteSpace([string]$receipt.recovery.nonce)) {
        throw 'The fixture preparation receipt is not eligible for publication recovery.'
    }
    if ([string]$receipt.supervisorAdmission.type -cne 'diagnostic_prep_supervisor_ticket' -or
        [string]$receipt.supervisorAdmission.version -cne 'diagnostic-prep-supervisor-ticket-v2' -or
        [string]$receipt.supervisorAdmission.sha256 -cne [string]$script:SupervisorAdmission.originalTicketSha256) {
        throw 'The receipt is not bound to the original admitted supervisor ticket.'
    }
    if ([int]$receipt.execution.workerProcess.pid -ne [int]$originalExecution.worker.pid -or
        [string]$receipt.execution.workerProcess.startedAtUtc -cne [string]$originalExecution.worker.startedAtUtc) {
        throw 'The receipt worker identity does not match the original supervised worker.'
    }
    if (($receipt.release | ConvertTo-Json -Compress -Depth 20) -cne ($script:Manifest.release | ConvertTo-Json -Compress -Depth 20) -or
        ($receipt.controllerArtifacts | ConvertTo-Json -Compress -Depth 20 -AsArray) -cne (@($script:Manifest.controllerArtifacts) | ConvertTo-Json -Compress -Depth 20 -AsArray)) {
        throw 'Release or controller identity drift blocks publication recovery.'
    }
    $records = @(Read-And-ValidateJournal)
    Assert-RecoveryJournalLifecycle -Records $records -Receipt $receipt
    $sourceSealRecords = @($records | Where-Object {
        [string]$_.stage -ceq 'source_hashes_sealed' -and [string]$_.status -ceq 'completed'
    })
    $receiptHash = Get-Sha256 $receiptPath
    $receiptSealRecords = @($records | Where-Object {
        [string]$_.stage -ceq 'fixture_receipt_sealed' -and [string]$_.status -ceq 'completed'
    })
    if ($sourceSealRecords.Count -ne 1 -or
        [string]$receipt.journal.sourceSealedRecordHash -cne [string]$sourceSealRecords[0].recordHash) {
        throw 'The receipt does not bind the journal source-seal record.'
    }
    if ($receiptSealRecords.Count -ne 1 -or
        [string]$receiptSealRecords[0].artifactHashes.fixturePreparationReceiptSha256 -cne $receiptHash) {
        throw 'The journal does not bind the exact fixture preparation receipt.'
    }
    if (Test-Path -LiteralPath ([string]$script:Manifest.paths.publicationRecoveryReceiptPath)) {
        throw 'The one permitted publication recovery was already consumed.'
    }
    $artifacts = @(Assert-ReceiptSourcesCurrent -Receipt $receipt -RequireFresh)
    $verificationBinding = New-SanitizedVerificationBinding
    if (($receipt.verification | ConvertTo-Json -Compress -Depth 30) -cne
        ($verificationBinding | ConvertTo-Json -Compress -Depth 30)) {
        throw 'The sealed verification counts or gates changed before publication recovery.'
    }
    $verificationContractHash = [string]$verificationBinding.countsAndGatesSha256
    $artifactSetHash = Get-SnapshotArtifactSetSha256 -Artifacts $artifacts
    if ($artifactSetHash -cne [string]$receipt.snapshot.artifactSetSha256 -or
        [string]$receipt.snapshot.root -cne [string]$script:Manifest.paths.snapshotRoot) {
        throw 'The sealed snapshot artifact set is inconsistent.'
    }
    $recoveryMarker = [ordered]@{
        schemaVersion = 1; type = 'fixture_publication_recovery_receipt'; version = 'fixture-publication-recovery-v1'
        status = 'admitted'; runId = [string]$script:Manifest.runId; manifestSha256 = $script:ManifestSha256
        fixturePreparationReceiptSha256 = $receiptHash
        recoveryNonceSha256 = Get-StringSha256 -Value ([string]$receipt.recovery.nonce)
        supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
        supervisorAdmissionNonceSha256 = [string]$script:SupervisorAdmission.nonceSha256
        originalSupervisorTicketSha256 = [string]$script:SupervisorAdmission.originalTicketSha256
        admittedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    }
    Write-PrivateJsonAtomic -Path ([string]$script:Manifest.paths.publicationRecoveryReceiptPath) -Value $recoveryMarker -Immutable
    $recoveryMarkerHash = Get-Sha256 ([string]$script:Manifest.paths.publicationRecoveryReceiptPath)
    [void](Add-JournalRecord -Stage 'publication_recovery_started' -Status 'running' `
        -ArtifactHashes ([ordered]@{ publicationRecoveryReceiptSha256 = $recoveryMarkerHash; snapshotArtifactSetSha256 = $artifactSetHash }))
    $outcome = Publish-Snapshot -Artifacts $artifacts -Recovery
    [void](Add-JournalRecord -Stage 'publication_recovery_completed' -Status 'completed' `
        -ArtifactHashes ([ordered]@{ publicationRecoveryReceiptSha256 = $recoveryMarkerHash; snapshotArtifactSetSha256 = $artifactSetHash }))
    $terminalHash = Add-JournalRecord -Stage 'terminal_commit' -Status 'completed' `
        -Process (Get-ProcessIdentity -Process (Get-Process -Id $PID) -Kind 'fixture-worker-recovery') -ExitCode 0 `
        -ArtifactHashes ([ordered]@{
            fixturePreparationReceiptSha256 = $receiptHash
            publicationRecoveryReceiptSha256 = $recoveryMarkerHash
            snapshotArtifactSetSha256 = $artifactSetHash
            verificationCountsAndGatesSha256 = $verificationContractHash
            supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
        })
    $script:JournalTerminalCommitted = $true
    return [ordered]@{
        valid = $true; mode = 'ResumePublication'; runId = [string]$script:Manifest.runId
        manifestSha256 = $script:ManifestSha256; status = $(if ($outcome -ceq 'reconciled') { 'publication_reconciled' } else { 'publication_recovered' })
        diagnosticEligible = [bool]$script:Manifest.diagnosticEligible; trafficStarted = $false; leaseAcquired = $false
        journalTerminalHash = $terminalHash
        fixturePreparationReceiptSha256 = $receiptHash
        publicationRecoveryReceiptSha256 = $recoveryMarkerHash
        supervisorAdmissionSha256 = [string]$script:SupervisorAdmission.sha256
        verificationCountsAndGatesSha256 = $verificationContractHash
        snapshotArtifactSetSha256 = $artifactSetHash
    }
}

$manifestAbsolute = Resolve-AbsolutePath -Value $ManifestPath -Name 'ManifestPath'
$ManifestPath = $manifestAbsolute
Assert-File -Path $ManifestPath -Name 'diagnostic preparation manifest'
Assert-ExactPrivateAcl -Path $ManifestPath -Directory $false
$script:ManifestSha256 = Get-Sha256 $ManifestPath
$script:WorkerSha256 = Get-Sha256 $PSCommandPath
$ExpectedManifestSha256 = $ExpectedManifestSha256.ToLowerInvariant()
if ($script:ManifestSha256 -cne $ExpectedManifestSha256) { throw 'Diagnostic preparation manifest hash mismatch.' }
try { $script:Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json -DateKind String -AsHashtable -Depth 100 }
catch { throw 'Diagnostic preparation manifest JSON is malformed.' }
Assert-ManifestContract
Assert-RepositoryIdentity

if ($Mode -ceq 'Validate') {
    if (-not [string]::IsNullOrWhiteSpace($SupervisorAdmissionPath) -or
        -not [string]::IsNullOrWhiteSpace($ExpectedSupervisorAdmissionSha256) -or
        -not [string]::IsNullOrWhiteSpace($SupervisorAdmissionNonce)) {
        throw 'Validate mode is read-only and does not accept a mutation admission handshake.'
    }
    # Validation is the first fail-closed fence for a fresh run.  The Run path
    # repeats this immediately before its first durable journal mutation so a
    # downstream artifact cannot race validation and consume fixture work.
    Assert-NoDownstreamArtifacts
    $credentialsReadable = $false
    if ([string]$script:Manifest.fixture.provider -ceq 'production') {
        $credentials = Read-ProductionCredentials
        $credentialsReadable = $true
        $credentials.superAdminPassword = $null; $credentials.adminPassword = $null; $credentials.teacherPassword = $null
    }
    [ordered]@{
        valid = $true; mode = 'Validate'; runId = [string]$script:Manifest.runId
        manifestSha256 = $script:ManifestSha256; diagnosticEligible = [bool]$script:Manifest.diagnosticEligible
        provider = [string]$script:Manifest.fixture.provider; credentialsReadable = $credentialsReadable
        mutationStarted = $false; snapshotPublished = $false; trafficStarted = $false; leaseAcquired = $false
        earliestRunUtc = [string]$script:Manifest.executionWindow.earliestUtc
        latestRunUtc = [string]$script:Manifest.executionWindow.latestUtc
        earliestRunLocal = Convert-ToPinnedLocalIso -Instant ([DateTimeOffset]::Parse([string]$script:Manifest.executionWindow.earliestUtc))
        latestRunLocal = Convert-ToPinnedLocalIso -Instant ([DateTimeOffset]::Parse([string]$script:Manifest.executionWindow.latestUtc))
    } | ConvertTo-Json -Depth 20
    return
}

$script:SupervisorAdmission = Read-And-ValidateSupervisorAdmission
$script:WorkerOwnership = Read-And-ValidateWorkerOwnership -Admission $script:SupervisorAdmission
$script:SupervisorAdmission.workerOwnership = $script:WorkerOwnership

try {
    $result = Invoke-WithPreparationMutex -Operation {
        if ($Mode -ceq 'Run') { return Invoke-RunPreparation }
        return Invoke-ResumePublication
    }
    $result | ConvertTo-Json -Depth 50
}
catch {
    if ($script:JournalInitialized -and -not $script:JournalTerminalCommitted) {
        try {
            $failureCode = Get-FailureCode -Stage $script:CurrentStage
            [void](Add-JournalRecord -Stage 'terminal_commit' -Status 'failed' `
                -Process (Get-ProcessIdentity -Process (Get-Process -Id $PID) -Kind 'fixture-worker') `
                -ExitCode 1 -FailureCode $failureCode -FailureStage $script:CurrentStage)
            $script:JournalTerminalCommitted = $true
        }
        catch { }
    }
    $code = Get-FailureCode -Stage $script:CurrentStage
    $windowDetail = if ([string]::IsNullOrWhiteSpace($script:WindowFailureMessage)) {
        ''
    }
    else { " $($script:WindowFailureMessage)" }
    throw "Diagnostic fixture preparation failed closed at stage '$($script:CurrentStage)' ($code).$windowDetail"
}
