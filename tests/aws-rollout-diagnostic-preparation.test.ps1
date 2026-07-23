#requires -Version 7.5

[CmdletBinding()]
param(
    [ValidateSet('Suite','OfflineRehearsal','HostSmoke')]
    [string]$Mode = 'Suite',
    [string]$EvidenceOutputPath,
    [ValidateRange(1560, 2100)]
    [int]$HostSmokeSeconds = 1560
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workerPath = Join-Path $root 'scripts/load/refresh-and-snapshot-fixtures.ps1'
$supervisorPath = Join-Path $root 'scripts/load/start-waf800-diagnostic-preparation.ps1'
$binderPath = Join-Path $root 'scripts/load/bind-fresh-diagnostic.ps1'
$diagnosticPath = Join-Path $root 'scripts/load/start-waf800-batch-diagnostic.ps1'
$certificationPath = Join-Path $root 'scripts/load/start-aws-rollout-supervisor.ps1'
$fixtureCliPath = Join-Path $root 'scripts/load/prepare-classpilot-load-test.mjs'
$manifestTemplatePath = Join-Path $root 'scripts/load/waf800-diagnostic-prep-manifest.template.json'
$script:AssertionCount = 0
$script:RequiredFixtureFiles = @(
    'fixture-state.private.json',
    'verification.private.json',
    'load-devices.private.json',
    'load-auth.private.json',
    'load-command-bodies.private.json'
)

function Assert-Condition {
    param($Condition, [string]$Message)
    $script:AssertionCount++
    if ($Condition -isnot [bool]) {
        $typeName = if ($null -eq $Condition) { '<null>' } else { $Condition.GetType().FullName }
        throw "Assertion condition at line $($MyInvocation.ScriptLineNumber) was $typeName instead of Boolean. $Message"
    }
    if (-not $Condition) {
        throw "Assertion failed at line $($MyInvocation.ScriptLineNumber). $Message"
    }
}

function Assert-Throws {
    param([scriptblock]$Operation, [string]$Pattern, [string]$Message)
    $script:AssertionCount++
    $threw = $false
    try { & $Operation }
    catch {
        $threw = $true
        if ($Pattern -and $_.Exception.Message -notmatch $Pattern) {
            throw "$Message Unexpected error: $($_.Exception.Message)"
        }
    }
    if (-not $threw) { throw $Message }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-ExactProcessPresent {
    param($Identity)
    if ($null -eq $Identity -or [int]$Identity.pid -le 0) { return $false }
    $process = Get-Process -Id ([int]$Identity.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $false }
    try {
        return ([DateTimeOffset]$process.StartTime).ToUniversalTime().ToString('o') -ceq
                ([DateTimeOffset]::Parse([string]$Identity.startedAtUtc)).ToUniversalTime().ToString('o') -and
            [string]::Equals(
                [string]$process.Path, [string]$Identity.path,
                [StringComparison]::OrdinalIgnoreCase
            )
    }
    catch { return $false }
    finally { $process.Dispose() }
}

function Test-ExactSuspendedProcessPresent {
    param($Identity)
    if ($null -eq $Identity -or [int]$Identity.pid -le 0) { return $false }
    $process = Get-Process -Id ([int]$Identity.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $false }
    try {
        # Windows can deny MainModule/Path while the primary thread is still
        # suspended. Creation time is queried from the exact process object;
        # the immutable ownership proof already binds lpApplicationName.
        return ([DateTimeOffset]$process.StartTime).ToUniversalTime().ToString('o') -ceq
            ([DateTimeOffset]::Parse([string]$Identity.startedAtUtc)).ToUniversalTime().ToString('o') -and
            [string]::Equals(
                [IO.Path]::GetFullPath([string]$Identity.path),
                [IO.Path]::GetFullPath((Get-Command pwsh -ErrorAction Stop).Source),
                [StringComparison]::OrdinalIgnoreCase
            )
    }
    catch { return $false }
    finally { $process.Dispose() }
}

function Set-ExactPrivateAcl {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    $isDirectory = [bool]$item.PSIsContainer
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, [Security.AccessControl.AccessControlSections]::Access
    )
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($security.GetAccessRules(
        $true, $true, [Security.Principal.SecurityIdentifier]
    ))) {
        [void]$security.RemoveAccessRuleSpecific($existing)
    }
    $inheritance = if ($isDirectory) {
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
    [IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
}

function New-PrivateDirectory {
    param([string]$Path)
    [void][IO.Directory]::CreateDirectory($Path)
    Set-ExactPrivateAcl $Path
    return [IO.Path]::GetFullPath($Path)
}

function Write-PrivateText {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
    Set-ExactPrivateAcl $Path
}

function Write-PrivateJson {
    param([string]$Path, $Value)
    Write-PrivateText $Path ($Value | ConvertTo-Json -Depth 100)
}

function Write-ImmutablePrivateEvidence {
    param([string]$Path, $Value)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'A rehearsal evidence output path is required.'
    }
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\?\', [StringComparison]::Ordinal) -or
        $fullPath.StartsWith('\\.\', [StringComparison]::Ordinal)) {
        throw 'Rehearsal evidence must not use a Windows device-path prefix.'
    }
    $repositoryPrefix = $root.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if ($fullPath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Rehearsal evidence must be stored in an external private root.'
    }
    if (Test-Path -LiteralPath $fullPath) {
        throw 'Rehearsal evidence is immutable and already exists.'
    }
    $parent = [IO.Path]::GetDirectoryName($fullPath)
    $cursor = $parent
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $ancestor = Get-Item -LiteralPath $cursor -Force
            if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Rehearsal evidence must not traverse a reparse point.'
            }
        }
        $ancestorParent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $ancestorParent) { break }
        $cursor = $ancestorParent.FullName
    }
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        [void](New-PrivateDirectory $parent)
    }
    else { Assert-ExactPrivateAclState -Path $parent -Directory }
    $item = Get-Item -LiteralPath $parent -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Rehearsal evidence parent must not be a reparse point.'
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(
        ($Value | ConvertTo-Json -Depth 100)
    )
    $stream = [IO.FileStream]::new(
        $fullPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
        [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    Set-ExactPrivateAcl $fullPath
    Assert-ExactPrivateAclState -Path $fullPath
    return [pscustomobject]@{ path = $fullPath; sha256 = Get-Sha256 $fullPath }
}

function Get-MergedMainRepositoryState {
    $head = (& git -C $root rev-parse HEAD).Trim().ToLowerInvariant()
    $headExit = $LASTEXITCODE
    $branch = (& git -C $root branch --show-current).Trim()
    $branchExit = $LASTEXITCODE
    $originMain = (& git -C $root rev-parse refs/remotes/origin/main).Trim().ToLowerInvariant()
    $originExit = $LASTEXITCODE
    $status = @(& git -C $root status --porcelain=v1 --untracked-files=all)
    $statusExit = $LASTEXITCODE
    Assert-Condition (
        $headExit -eq 0 -and $branchExit -eq 0 -and $originExit -eq 0 -and
        $statusExit -eq 0 -and $head -match '^[0-9a-f]{40}$' -and
        $originMain -match '^[0-9a-f]{40}$' -and $branch -ceq 'main' -and
        $head -ceq $originMain -and $status.Count -eq 0
    ) 'A rehearsal must run from clean main == origin/main at one exact merged SHA.'
    return [pscustomobject]@{
        gitSha = $head
        branch = $branch
        originMainSha = $originMain
        clean = $true
        componentHashes = [ordered]@{
            workerSha256 = Get-Sha256 $workerPath
            supervisorSha256 = Get-Sha256 $supervisorPath
            binderSha256 = Get-Sha256 $binderPath
        }
    }
}

function Assert-MergedMainRepositoryStateUnchanged {
    param($Before)
    $after = Get-MergedMainRepositoryState
    Assert-Condition (
        $after.gitSha -ceq $Before.gitSha -and
        $after.branch -ceq $Before.branch -and
        $after.originMainSha -ceq $Before.originMainSha -and
        $after.componentHashes.workerSha256 -ceq $Before.componentHashes.workerSha256 -and
        $after.componentHashes.supervisorSha256 -ceq $Before.componentHashes.supervisorSha256 -and
        $after.componentHashes.binderSha256 -ceq $Before.componentHashes.binderSha256
    ) 'The merged repository or a bound preparation component changed during rehearsal.'
    return $after
}

function Invoke-JsonProcess {
    param([string]$Script, [string[]]$Arguments, [switch]$AllowFailure)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command pwsh -ErrorAction Stop).Source
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-File', $Script) + $Arguments) {
        [void]$start.ArgumentList.Add([string]$argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        Assert-Condition $process.Start() "Could not start $([IO.Path]::GetFileName($Script))."
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        Assert-Condition ($process.WaitForExit(120000)) "The test subprocess exceeded two minutes."
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $parsed = $null
        $trimmed = $stdout.Trim()
        if (-not [string]::IsNullOrWhiteSpace($trimmed)) {
            try { $parsed = $trimmed | ConvertFrom-Json -DateKind String -Depth 100 }
            catch {
                if (-not $AllowFailure) { throw 'Subprocess stdout was not one JSON value.' }
            }
        }
        if (-not $AllowFailure -and $process.ExitCode -ne 0) {
            $failureCode = if ($null -eq $parsed) { 'unparsed' } else { [string]$parsed.failureCode }
            $failureStage = if ($null -eq $parsed) { 'unparsed' } else { [string]$parsed.failureStage }
            $messageSha256 = if ($null -eq $parsed) { 'unparsed' } else {
                [string]$parsed.messageSha256
            }
            throw "$([IO.Path]::GetFileName($Script)) failed ($($process.ExitCode)); failure=$failureCode/$failureStage; message hash=$messageSha256; stdout hash=$((Get-TextSha256 $stdout)); stderr hash=$((Get-TextSha256 $stderr))."
        }
        return [pscustomobject]@{ ExitCode=$process.ExitCode; Stdout=$stdout; Stderr=$stderr; Json=$parsed }
    }
    finally { $process.Dispose() }
}

function Start-JsonProcessAsync {
    param([string]$Script, [string[]]$Arguments)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command pwsh -ErrorAction Stop).Source
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-File', $Script) + $Arguments) {
        [void]$start.ArgumentList.Add([string]$argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    Assert-Condition $process.Start() "Could not start concurrent $([IO.Path]::GetFileName($Script))."
    return [pscustomobject]@{
        Process=$process
        StdoutTask=$process.StandardOutput.ReadToEndAsync()
        StderrTask=$process.StandardError.ReadToEndAsync()
    }
}

function Complete-JsonProcessAsync {
    param($Invocation)
    try {
        Assert-Condition ($Invocation.Process.WaitForExit(120000)) `
            'A concurrent test subprocess exceeded two minutes.'
        $Invocation.Process.WaitForExit()
        $stdout = $Invocation.StdoutTask.GetAwaiter().GetResult()
        $stderr = $Invocation.StderrTask.GetAwaiter().GetResult()
        $json = $null
        if (-not [string]::IsNullOrWhiteSpace($stdout)) {
            try { $json = $stdout.Trim() | ConvertFrom-Json -DateKind String -Depth 100 }
            catch { }
        }
        return [pscustomobject]@{
            ExitCode=$Invocation.Process.ExitCode;Stdout=$stdout;Stderr=$stderr;Json=$json
        }
    }
    finally { $Invocation.Process.Dispose() }
}

function Wait-TestPath {
    param(
        [string]$Path,
        [int]$TimeoutSeconds = 20
    )
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        if (Test-Path -LiteralPath $Path -PathType Leaf) { return }
        Start-Sleep -Milliseconds 50
    } while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw "The expected test artifact was not published in time: $Path"
}

function Stop-TicketBoundSupervisor {
    param($Context)
    $ticketPath = Join-Path $Context.RunRoot 'supervisor-ticket.private.json'
    Wait-TestPath -Path $ticketPath
    $ticket = Get-Content -LiteralPath $ticketPath -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    $identity = $ticket.supervisor
    $process = Get-Process -Id ([int]$identity.pid) -ErrorAction Stop
    try {
        Assert-Condition (
            ([DateTimeOffset]$process.StartTime).ToUniversalTime().ToString('o') -ceq
                ([DateTimeOffset]::Parse([string]$identity.startedAtUtc)).ToUniversalTime().ToString('o') -and
            [string]::Equals(
                [string]$process.Path, [string]$identity.path,
                [StringComparison]::OrdinalIgnoreCase
            )
        ) 'A lifecycle crash regression may terminate only its exact ticket-bound supervisor identity.'
        Stop-Process -Id ([int]$identity.pid) -Force -ErrorAction Stop
    }
    finally { $process.Dispose() }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 50
        $present = Test-ExactProcessPresent $identity
    } while ($present -and $watch.Elapsed.TotalSeconds -lt 10)
    Assert-Condition (-not $present) 'The exact ticket-bound supervisor did not terminate in time.'
    return $ticket
}

function Stop-ExactAsyncInvocation {
    param($Invocation)
    $identity = [pscustomobject]@{
        pid = [int]$Invocation.Process.Id
        startedAtUtc = ([DateTimeOffset]$Invocation.Process.StartTime).ToUniversalTime().ToString('o')
        path = [string]$Invocation.Process.Path
    }
    Assert-Condition (Test-ExactProcessPresent $identity) `
        'The recovery crash regression lost the exact process identity before termination.'
    Stop-Process -Id $identity.pid -Force -ErrorAction Stop
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 50
        $present = Test-ExactProcessPresent $identity
    } while ($present -and $watch.Elapsed.TotalSeconds -lt 10)
    Assert-Condition (-not $present) 'The exact recovery supervisor did not terminate in time.'
    return $identity
}

function Remove-TestContextBestEffort {
    param($Context)
    if ($null -eq $Context -or -not (Test-Path -LiteralPath $Context.Root)) { return }
    $identities = [Collections.Generic.List[object]]::new()
    foreach ($path in @(
        (Join-Path $Context.RunRoot 'supervisor-ticket.private.json'),
        ([string]$Context.Manifest.paths.supervisorStatePath),
        (Join-Path $Context.RunRoot 'worker-ownership.private.json'),
        (Join-Path $Context.RunRoot 'publication-recovery-worker-ownership.private.json')
    )) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        try {
            $value = Get-Content -LiteralPath $path -Raw |
                ConvertFrom-Json -DateKind String -Depth 100
            $candidates = [Collections.Generic.List[object]]::new()
            foreach ($name in @('supervisor','worker')) {
                $property = $value.PSObject.Properties[$name]
                if ($null -ne $property -and $null -ne $property.Value) {
                    $candidates.Add($property.Value)
                }
            }
            $originalProperty = $value.PSObject.Properties['originalExecution']
            if ($null -ne $originalProperty -and $null -ne $originalProperty.Value) {
                foreach ($name in @('supervisor','worker')) {
                    $property = $originalProperty.Value.PSObject.Properties[$name]
                    if ($null -ne $property -and $null -ne $property.Value) {
                        $candidates.Add($property.Value)
                    }
                }
            }
            foreach ($candidate in $candidates) {
                if ($null -ne $candidate -and [int]$candidate.pid -gt 0 -and
                    [int]$candidate.pid -ne $PID) {
                    $identities.Add($candidate)
                }
            }
        }
        catch { }
    }
    foreach ($identity in $identities) {
        try {
            if (Test-ExactProcessPresent $identity) {
                Stop-Process -Id ([int]$identity.pid) -Force -ErrorAction Stop
            }
        }
        catch { }
    }
    $processWatch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $present = @($identities | Where-Object { Test-ExactProcessPresent $_ }).Count -gt 0
        if (-not $present) { break }
        Start-Sleep -Milliseconds 50
    } while ($processWatch.Elapsed.TotalSeconds -lt 5)
    $cleanupWatch = [Diagnostics.Stopwatch]::StartNew()
    do {
        try {
            Remove-Item -LiteralPath $Context.Root -Recurse -Force -ErrorAction Stop
            return
        }
        catch {
            Start-Sleep -Milliseconds 100
        }
    } while ($cleanupWatch.Elapsed.TotalSeconds -lt 5)
    # Cleanup is intentionally best effort: a transient test-host file handle
    # must not replace the lifecycle assertion that caused the run to unwind.
}

function Get-TextSha256 {
    param([AllowEmptyString()][string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.UTF8Encoding]::new($false).GetBytes($Text)
    )).ToLowerInvariant()
}

function New-FakeFixtureTemplate {
    param([string]$Path, [string]$FixtureId)
    [void](New-PrivateDirectory $Path)
    $now = [DateTimeOffset]::UtcNow
    $expires = $now.AddHours(3).ToString('o')
    $state = [ordered]@{
        schemaVersion=1;fixtureId=$FixtureId;refreshedAt=$now.ToString('o');hold=$null;cleanup=$null
    }
    $verification = [ordered]@{
        schemaVersion=1;fixtureId=$FixtureId;verifiedAt=$now.ToString('o');passed=$true
        counts=[ordered]@{
            schools=2;teachers=20;officeStaff=1;students=1010;classes=20
            classRosterStudents=800;devices=1010;activeDeviceSessions=1010;activeSessions=20
            commandBodies=20
            authorizationPlanCohorts=[ordered]@{coTeacherStudents=40;officeSupervisionStudents=40}
            liveAuth=[ordered]@{commandAdministrators=1;teachers=20}
        }
        gates=[ordered]@{
            autoEnrollDisabled=$true;trackingDisabled=$true;schedulesDisabled=$true
            exactSchoolTimezones=$true;classRostersExactAndDisjoint=$true
            authorizationPlanCohortsExact=$true
            authorizationPlanOfficeStudentsOutsideTeacherRosters=$true
            allDeviceTokensLive=$true;allStaffAuthArtifactsLive=$true
        }
        schoolTimezones=[ordered]@{
            primary=[ordered]@{schoolTimezone='America/New_York';schoolHoursTimezone='America/New_York'}
            canary=[ordered]@{schoolTimezone='America/New_York';schoolHoursTimezone='America/New_York'}
        }
    }
    $devices = @(0..1009 | ForEach-Object { [ordered]@{ordinal=$_;token='offline-redacted'} })
    $teachers = @(0..19 | ForEach-Object { [ordered]@{ordinal=$_;token='offline-redacted'} })
    $commands = @(0..19 | ForEach-Object { [ordered]@{ordinal=$_;body='offline'} })
    $auth = [ordered]@{
        fixtureId=$FixtureId;baseUrl='https://schoolpilot.invalid';expiresAt=$expires
        deviceManifestExpiresAt=$expires;teacherAuth=$teachers
    }
    Write-PrivateJson (Join-Path $Path 'fixture-state.private.json') $state
    Write-PrivateJson (Join-Path $Path 'verification.private.json') $verification
    Write-PrivateJson (Join-Path $Path 'load-devices.private.json') $devices
    Write-PrivateJson (Join-Path $Path 'load-auth.private.json') $auth
    Write-PrivateJson (Join-Path $Path 'load-command-bodies.private.json') $commands
    Write-PrivateJson (Join-Path $Path 'fixture-ownership.private.json') ([ordered]@{
        schemaVersion=3;fixtureId=$FixtureId;offlineTestOnly=$true
    })
}

function New-TestContext {
    param(
        [string]$Name,
        [hashtable]$TestControls = @{}
    )
    $externalRoot = Join-Path ([IO.Path]::GetTempPath()) `
        ("schoolpilot-prep-test-{0}-{1}" -f $Name, [Guid]::NewGuid().ToString('N'))
    [void](New-PrivateDirectory $externalRoot)
    $templateRoot = New-PrivateDirectory (Join-Path $externalRoot 'template')
    $fixtureId = "offline-$Name-$([Guid]::NewGuid().ToString('N').Substring(0,8))".ToLowerInvariant()
    New-FakeFixtureTemplate -Path $templateRoot -FixtureId $fixtureId
    $configPath = Join-Path $externalRoot 'fixture-config.private.json'
    Write-PrivateJson $configPath ([ordered]@{fixtureId=$fixtureId;provider='offline-fake'})
    $tzifPath = Join-Path $externalRoot 'America-New_York.tzif'
    $tzifBase64 = 'VFppZjIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAEAAAAAAAAAVFppZjIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACvAAAABQAAABT/////XgPwkP////+eph5w/////5+662D/////oIYAcP////+hms1g/////6Jl4nD/////o4Pp4P////+kaq5w/////6U1p2D/////plPK8P////+nFYlg/////6gzrPD/////qP6l4P////+qE47w/////6reh+D/////q/Nw8P////+svmng/////63TUvD/////rp5L4P////+vszTw/////7B+LeD/////sZxRcP////+yZ0pg/////7N8M3D/////tEcsYP////+1XBVw/////7YnDmD/////tzv3cP////+4BvBg/////7kb2XD/////uebSYP////+7BPXw/////7vGtGD/////vOTX8P////+9r9Dg/////77EufD/////v4+y4P/////ApJvw/////8FvlOD/////woR98P/////DT3bg/////8RkX/D/////xS9Y4P/////GTXxw/////8cPOuD/////yC1ecP/////I+Fdg/////8oNQHD/////ytg5YP/////LiPBw/////9Ij9HD/////0mD74P/////TdeTw/////9RA3eD/////1VXG8P/////WIL/g/////9c1qPD/////2ACh4P/////ZFYrw/////9ngg+D/////2v6ncP/////bwGXg/////9zeiXD/////3amCYP/////evmtw/////9+JZGD/////4J5NcP/////haUZg/////+J+L3D/////40koYP/////kXhFw/////+VXLuD/////5kct8P/////nNxDg/////+gnD/D/////6Rby4P/////qBvHw/////+r21OD/////6+bT8P/////s1rbg/////+3GtfD/////7r/TYP/////vr9Jw//////CftWD/////8Y+0cP/////yf5dg//////NvlnD/////9F95YP/////1T3hw//////Y/W2D/////9y9acP/////4KHfg//////kPPHD/////+ghZ4P/////6+Fjw//////voO+D//////Ng68P/////9yB3g//////64HPD//////6f/4AAAAAAAl/7wAAAAAAGH4eAAAAAAAnfg8AAAAAADcP5gAAAAAARg/XAAAAAABVDgYAAAAAAGQN9wAAAAAAcwwmAAAAAAB40ZcAAAAAAJEKRgAAAAAAmtlPAAAAAACvCGYAAAAAAL4IVwAAAAAAzZouAAAAAADcBncAAAAAAOuYTgAAAAAA+pg/AAAAAAEJlm4AAAAAARiWXwAAAAABJ5SOAAAAAAE2lH8AAAAAAUWSrgAAAAABVJKfAAAAAAFjkM4AAAAAAXKQvwAAAAABgiKWAAAAAAGQjt8AAAAAAaAgtgAAAAABryCnAAAAAAG+HtYAAAAAAc0exwAAAAAB3Bz2AAAAAAHrHOcAAAAAAfobFgAAAAACB2APAAAAAAIYGTYAAAAAAiVeLwAAAAACNqr+AAAAAAJDXE8AAAAAAlSpHgAAAAACYVpvAAAAAAJypz4AAAAAAn/sNwAAAAACkKVeAAAAAAKd6lcAAAAAAq6jfgAAAAACu+h3AAAAAALNNUYAAAAAAtnmlwAAAAAC6zNmAAAAAAL35LcAAAAAAwkxhgAAAAADFnZ/AAAAAAMnL6YAAAAAAzR0nwAAAAADRS3GAAAAAANScr8AAAAAA2Mr5gAAAAADcHDfAAAAAAOBva4AAAAAA45u/wAAAAADn7vOAAAAAAOsbR8AAAAAA7257gAAAAADyv7nAAAAAAPbuA4AAAAAA+j9BwAAAAAD+bYuAAAAAAQG+ycAAAAABBhH9gAAAAAEJPlHAAAAAAQ2RhYAAAAABEL3ZwAAAAAEVEQ2AAAAAARfOo8AIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIDBAIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgECAQIBAgH//7qeAAD//8fAAQT//7mwAAj//8fAAQz//8fAARBMTVQARURUAEVTVABFV1QARVBUAApFU1Q1RURULE0zLjIuMCxNMTEuMS4wCg=='
    $gitRoot = Split-Path -Parent (Split-Path -Parent (Get-Command git -ErrorAction Stop).Source)
    $tzifSourceCandidates = @(
        (Join-Path $gitRoot 'mingw64/share/zoneinfo/America/New_York'),
        (Join-Path $gitRoot 'usr/share/zoneinfo/America/New_York')
    )
    $tzifSource = @($tzifSourceCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) |
        Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace([string]$tzifSource)) {
        throw 'The Windows Git runtime does not expose the pinned offline rehearsal TZif source.'
    }
    [IO.File]::Copy([string]$tzifSource, $tzifPath, $false)
    Set-ExactPrivateAcl $tzifPath

    $runId = "offline-prep-$Name-$([Guid]::NewGuid().ToString('N'))".ToLowerInvariant()
    $runRoot = Join-Path $externalRoot 'run-control'
    $snapshotRoot = Join-Path (Join-Path $externalRoot 'snapshots') $runId
    $head = (& git -C $root rev-parse HEAD).Trim().ToLowerInvariant()
    $artifacts = @(
        @{kind='fixture-worker';path=$workerPath},
        @{kind='prep-supervisor';path=$supervisorPath},
        @{kind='diagnostic-binder';path=$binderPath},
        @{kind='coordinator';path=$diagnosticPath},
        @{kind='monitor';path=(Join-Path $root 'scripts/load/aws-rollout-monitor.ps1')},
        @{kind='harness';path=(Join-Path $root 'scripts/load/classpilot-load-test.mjs')},
        @{kind='monotonic-deadline';path=(Join-Path $root 'scripts/load/monotonic-deadline.mjs')},
        @{kind='tile-poll-accounting';path=(Join-Path $root 'scripts/load/tile-poll-accounting.mjs')},
        @{kind='database-insights-lease';path=(Join-Path $root 'scripts/load/database-insights-lease.ps1')}
    ) | ForEach-Object { [ordered]@{kind=$_.kind;path=[IO.Path]::GetFullPath($_.path);sha256=Get-Sha256 $_.path} }
    $now = [DateTimeOffset]::UtcNow
    $manifest = [ordered]@{
        schemaVersion=1;type='waf800_diagnostic_prep_manifest';version='waf800-diagnostic-prep-manifest-v1'
        runId=$runId;diagnosticOnly=$true;diagnosticEligible=$false;certificationEligible=$false
        repositoryRoot=$root
        release=[ordered]@{
            applicationGitSha=$head;controllerGitSha=$head
            deployedImageDigest=('sha256:' + ('1' * 64))
            apiTaskDefinitionArn='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:999'
            workerTaskDefinitionArn='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:999'
        }
        controllerArtifacts=@($artifacts)
        executionWindow=[ordered]@{
            earliestUtc=$now.AddMinutes(-2).ToString('o');latestUtc=$now.AddMinutes(90).ToString('o')
            timezone='America/New_York';pinnedTzifPath=$tzifPath;pinnedTzifSha256=Get-Sha256 $tzifPath
        }
        fixture=[ordered]@{
            provider='offline-fake';fixtureId=$fixtureId;sourceRoot=(Join-Path $externalRoot 'source')
            config=[ordered]@{path=$configPath;sha256=Get-Sha256 $configPath}
            fixtureCli=[ordered]@{path=$fixtureCliPath;sha256=Get-Sha256 $fixtureCliPath}
            baseUrl='https://schoolpilot.invalid';requiredVerificationMaximumAgeMinutes=60
            requiredArtifactValiditySeconds=2700;requiredPrivateFiles=@($script:RequiredFixtureFiles)
            fakeTemplateRoot=$templateRoot
        }
        paths=[ordered]@{
            runDirectoryRoot=$runRoot;snapshotRoot=$snapshotRoot
            journalPath=(Join-Path $runRoot 'diagnostic-prep-journal.private.jsonl')
            fixturePreparationReceiptPath=(Join-Path $runRoot 'fixture-preparation-receipt.private.json')
            publicationRecoveryReceiptPath=(Join-Path $runRoot 'publication-recovery-receipt.private.json')
            supervisorStatePath=(Join-Path $runRoot 'supervisor-state.private.json')
            leaseReceiptPath=(Join-Path $externalRoot 'lease.private.json')
            bindingRoot=(Join-Path $externalRoot 'binding')
            evidenceDirectory=(Join-Path $externalRoot 'evidence')
            startGatePath=(Join-Path $externalRoot 'start-gate.private.json')
            trafficMarkerPath=(Join-Path $externalRoot 'traffic.private.json')
        }
        oneAttemptPolicy=[ordered]@{
            refreshAttempts=1;verificationAttempts=1;initialPublicationAttempts=1;publicationRecoveryAttempts=1
        }
        workload=[ordered]@{
            stage='800';devices=810;durationSeconds=1800;screenshotBytes=40960;canaryDevices=10
            workloadSchemaVersion='classpilot-tile-batch-v1'
            endpointShapeSha256='8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2'
        }
        resources=[ordered]@{offlineRehearsal=$true}
    }
    if ($TestControls.Count -gt 0) { $manifest.testControls = [ordered]@{} + $TestControls }
    $manifestPath = Join-Path $externalRoot 'prep-manifest.private.json'
    Write-PrivateJson $manifestPath $manifest
    return [pscustomobject]@{
        Root=$externalRoot;RunId=$runId;RunRoot=$runRoot;SnapshotRoot=$snapshotRoot
        Manifest=$manifest;ManifestPath=$manifestPath;ManifestSha256=Get-Sha256 $manifestPath
        BindingRoot=[string]$manifest.paths.bindingRoot
    }
}

function Invoke-Supervisor {
    param($Context, [string]$Mode, [int]$TimeoutSeconds = 2100, [switch]$AllowFailure)
    $arguments = @(
        '-Mode', $Mode,
        '-ManifestPath', $Context.ManifestPath,
        '-ExpectedManifestSha256', $Context.ManifestSha256
    )
    if ($TimeoutSeconds -ne 2100) { $arguments += @('-SupervisorTimeoutSeconds', [string]$TimeoutSeconds) }
    try {
        return Invoke-JsonProcess -Script $supervisorPath -Arguments $arguments -AllowFailure:$AllowFailure
    }
    catch {
        throw "Supervisor context '$($Context.RunId)' mode '$Mode' failed: $($_.Exception.Message)"
    }
}

function Wait-SupervisorTerminal {
    param($Context, [int]$TimeoutSeconds = 60, [switch]$Fast)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 100
        $statePath = [string]$Context.Manifest.paths.supervisorStatePath
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            try {
                $state = Get-Content -LiteralPath $statePath -Raw |
                    ConvertFrom-Json -DateKind String -Depth 60
                if ([string]$state.status -in @('completed','failed','timed_out','interrupted')) {
                    if ($Fast) {
                        $lastKnownStage = $null
                        try {
                            $records = @(Read-TestJournal $Context)
                            if ($records.Count -gt 0) { $lastKnownStage = [string]$records[-1].stage }
                        }
                        catch { }
                        return [pscustomobject]@{
                            status = [string]$state.status
                            healthy = $true
                            lastKnownStage = $lastKnownStage
                            result = $(if ([string]::IsNullOrWhiteSpace([string]$state.resultPath)) {
                                $null
                            } else { [pscustomobject]@{ path = [string]$state.resultPath } })
                        }
                    }
                    $status = Invoke-Supervisor -Context $Context -Mode Status -AllowFailure
                    if ($status.ExitCode -eq 0 -and $null -ne $status.Json) { return $status.Json }
                    throw 'The terminal preparation state failed independent status validation.'
                }
            }
            catch {
                if ($_.Exception.Message -ceq 'The terminal preparation state failed independent status validation.') {
                    throw
                }
            }
        }
    } while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw "The detached preparation supervisor for $([string]$Context.Manifest.runId) did not reach a terminal state in the test window."
}

function Wait-SupervisorWorkerIdentity {
    param($Context, [int]$TimeoutSeconds = 20)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 100
        $statePath = [string]$Context.Manifest.paths.supervisorStatePath
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            try {
                $state = Get-Content -LiteralPath $statePath -Raw |
                    ConvertFrom-Json -DateKind String -Depth 60
                if ($state.status -ceq 'running' -and $null -ne $state.worker -and
                    [int]$state.worker.pid -gt 0 -and
                    -not [string]::IsNullOrWhiteSpace([string]$state.worker.startedAtUtc)) {
                    return $state.worker
                }
            }
            catch { }
        }
        $ticketPath = Join-Path $Context.RunRoot 'supervisor-ticket.private.json'
        if (Test-Path -LiteralPath $ticketPath -PathType Leaf) {
            try {
                $ticket = Get-Content -LiteralPath $ticketPath -Raw |
                    ConvertFrom-Json -DateKind String -Depth 30
                $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $([int]$ticket.supervisor.pid)" |
                    Where-Object {
                        [string]$_.CommandLine -like ('*' + [IO.Path]::GetFileName($workerPath) + '*')
                    })
                if ($children.Count -eq 1) {
                    $child = Get-Process -Id ([int]$children[0].ProcessId) -ErrorAction Stop
                    return [pscustomobject]@{
                        pid = [int]$child.Id
                        startedAtUtc = ([DateTimeOffset]$child.StartTime.ToUniversalTime()).ToString('o')
                        path = [string]$child.Path
                    }
                }
            }
            catch { }
        }
    } while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw 'The detached preparation supervisor did not publish its owned worker identity.'
}

function Wait-SupervisorStateStatus {
    param($Context, [string]$ExpectedStatus, [int]$TimeoutSeconds = 20)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $statePath = [string]$Context.Manifest.paths.supervisorStatePath
    do {
        Start-Sleep -Milliseconds 50
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            try {
                $state = Get-Content -LiteralPath $statePath -Raw |
                    ConvertFrom-Json -DateKind String -Depth 60
                if ([string]$state.status -ceq $ExpectedStatus) { return $state }
            }
            catch { }
        }
    } while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw "The detached preparation supervisor did not publish state '$ExpectedStatus'."
}

function Wait-PreparationJournalStage {
    param($Context, [string]$ExpectedStage, [int]$TimeoutSeconds = 20)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $journalPath = [string]$Context.Manifest.paths.journalPath
    do {
        Start-Sleep -Milliseconds 100
        if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
            try {
                $lastLine = Get-Content -LiteralPath $journalPath -Tail 1
                if (-not [string]::IsNullOrWhiteSpace([string]$lastLine)) {
                    $record = $lastLine | ConvertFrom-Json -DateKind String -Depth 60
                    if ([string]$record.stage -ceq $ExpectedStage) { return $record }
                }
            }
            catch { }
        }
    } while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw "The preparation worker did not commit the expected $ExpectedStage journal boundary."
}

function Read-TestJournal {
    param($Context)
    $journalPath = [string]$Context.Manifest.paths.journalPath
    Assert-Condition (Test-Path -LiteralPath $journalPath -PathType Leaf) `
        "The expected preparation journal is absent for $([string]$Context.Manifest.runId)."
    $records = [Collections.Generic.List[object]]::new()
    $expectedPrevious = $null
    $expectedSequence = 1
    foreach ($line in [IO.File]::ReadLines($journalPath, [Text.UTF8Encoding]::new($false))) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $record = $line | ConvertFrom-Json -DateKind String -AsHashtable -Depth 60
        Assert-Condition ([int]$record.sequence -eq $expectedSequence) `
            'Preparation journal sequence must be contiguous.'
        Assert-Condition ([string]$record.previousRecordHash -ceq [string]$expectedPrevious) `
            'Preparation journal previous-record hash must match independently.'
        $core = [ordered]@{}
        foreach ($key in @(
            'schemaVersion','type','version','sequence','runId','manifestSha256','timestampUtc',
            'stage','status','process','exitCode','artifactHashes','previousRecordHash',
            'failureCode','failureStage'
        )) { $core[$key] = $record[$key] }
        $computed = Get-TextSha256 ($core | ConvertTo-Json -Compress -Depth 50)
        Assert-Condition ([string]$record.recordHash -ceq $computed) `
            'Preparation journal record hash must match independently.'
        $expectedPrevious = $computed
        $expectedSequence++
        $records.Add($record)
    }
    return @($records)
}

function Get-TestObjectKeys {
    param($Value)
    if ($Value -is [Collections.IDictionary]) { return @($Value.Keys | ForEach-Object { [string]$_ }) }
    return @($Value.PSObject.Properties.Name)
}

function New-TerminalPreparationEvidenceBinding {
    param($Context, $Status, [object[]]$JournalRecordsOverride = $null)
    $expectedStatusKeys = @(
        'schemaVersion','type','version','runId','status','healthy','ticket',
        'supervisorProcessPresent','workerProcessPresent','lastKnownStage','journal',
        'result','recoveryAdmission','finding','trafficStarted','leaseAcquired'
    )
    $expectedJournalKeys = @(
        'exists','path','sha256','recordCount','lastStage','lastStatus',
        'lastRecordHash','terminalCommitted','hasPartialRecord'
    )
    $expectedTerminalRecordKeys = @(
        'schemaVersion','type','version','sequence','runId','manifestSha256','timestampUtc',
        'stage','status','process','exitCode','artifactHashes','previousRecordHash',
        'failureCode','failureStage','recordHash'
    )
    $expectedReferenceKeys = @('path','sha256')
    $expectedResultReferenceKeys = @('path','sha256','status')
    $expectedProcessKeys = @('pid','startedAtUtc','path','kind')
    $expectedTerminalArtifactHashKeys = @(
        'fixturePreparationReceiptSha256','snapshotArtifactSetSha256',
        'verificationCountsAndGatesSha256','supervisorAdmissionSha256'
    )
    Assert-Condition (
        @(Compare-Object ($expectedStatusKeys | Sort-Object) `
            ((Get-TestObjectKeys $Status) | Sort-Object)).Count -eq 0 -and
        $Status.schemaVersion -is [long] -and $Status.schemaVersion -eq 1 -and
        $Status.type -is [string] -and $Status.version -is [string] -and
        $Status.runId -is [string] -and $Status.status -is [string] -and
        $Status.lastKnownStage -is [string] -and
        [string]$Status.type -ceq 'diagnostic_prep_supervisor_status' -and
        [string]$Status.version -ceq 'diagnostic-prep-supervisor-v1' -and
        [string]$Status.runId -ceq $Context.RunId -and
        [string]$Status.status -ceq 'completed' -and
        $Status.healthy -is [bool] -and $Status.healthy -eq $true -and
        $Status.supervisorProcessPresent -is [bool] -and
        $Status.supervisorProcessPresent -eq $false -and
        $Status.workerProcessPresent -is [bool] -and
        $Status.workerProcessPresent -eq $false -and
        [string]$Status.lastKnownStage -ceq 'terminal_commit' -and
        $null -eq $Status.recoveryAdmission -and
        $null -eq $Status.finding -and
        $Status.trafficStarted -is [bool] -and $Status.trafficStarted -eq $false -and
        $Status.leaseAcquired -is [bool] -and $Status.leaseAcquired -eq $false -and
        @(Compare-Object ($expectedReferenceKeys | Sort-Object) `
            ((Get-TestObjectKeys $Status.ticket) | Sort-Object)).Count -eq 0 -and
        $Status.ticket.path -is [string] -and $Status.ticket.sha256 -is [string] -and
        @(Compare-Object ($expectedResultReferenceKeys | Sort-Object) `
            ((Get-TestObjectKeys $Status.result) | Sort-Object)).Count -eq 0 -and
        $Status.result.path -is [string] -and $Status.result.sha256 -is [string] -and
        $Status.result.status -is [string]
    ) 'Terminal preparation Status must have the exact successful no-traffic shape.'
    Assert-Condition (
        @(Compare-Object ($expectedJournalKeys | Sort-Object) `
            ((Get-TestObjectKeys $Status.journal) | Sort-Object)).Count -eq 0 -and
        $Status.journal.exists -is [bool] -and $Status.journal.exists -eq $true -and
        $Status.journal.path -is [string] -and $Status.journal.sha256 -is [string] -and
        $Status.journal.recordCount -is [long] -and
        $Status.journal.lastStage -is [string] -and
        $Status.journal.lastStatus -is [string] -and
        $Status.journal.lastRecordHash -is [string] -and
        [string]$Status.journal.path -ceq [string]$Context.Manifest.paths.journalPath -and
        [string]$Status.journal.sha256 -ceq (Get-Sha256 ([string]$Status.journal.path)) -and
        [string]$Status.journal.lastStage -ceq 'terminal_commit' -and
        [string]$Status.journal.lastStatus -ceq 'completed' -and
        [string]$Status.journal.lastRecordHash -match '^[0-9a-f]{64}$' -and
        $Status.journal.terminalCommitted -is [bool] -and
        $Status.journal.terminalCommitted -eq $true -and
        $Status.journal.hasPartialRecord -is [bool] -and
        $Status.journal.hasPartialRecord -eq $false
    ) 'Terminal preparation Status must bind the exact complete journal file and terminal record.'

    $records = if ($null -eq $JournalRecordsOverride) {
        @(Read-TestJournal $Context)
    } else { @($JournalRecordsOverride) }
    Assert-Condition ($records.Count -gt 0) 'Terminal evidence requires at least one committed journal record.'
    $terminalRecord = $records[-1]
    Assert-Condition (
        @(Compare-Object ($expectedTerminalRecordKeys | Sort-Object) `
            ((Get-TestObjectKeys $terminalRecord) | Sort-Object)).Count -eq 0 -and
        $terminalRecord.schemaVersion -is [long] -and $terminalRecord.schemaVersion -eq 1 -and
        $terminalRecord.sequence -is [long] -and
        $terminalRecord.exitCode -is [long] -and
        $terminalRecord.type -is [string] -and $terminalRecord.version -is [string] -and
        $terminalRecord.runId -is [string] -and $terminalRecord.manifestSha256 -is [string] -and
        $terminalRecord.timestampUtc -is [string] -and $terminalRecord.stage -is [string] -and
        $terminalRecord.status -is [string] -and $terminalRecord.previousRecordHash -is [string] -and
        $terminalRecord.recordHash -is [string] -and
        $null -eq $terminalRecord.failureCode -and $null -eq $terminalRecord.failureStage -and
        @(Compare-Object ($expectedProcessKeys | Sort-Object) `
            ((Get-TestObjectKeys $terminalRecord.process) | Sort-Object)).Count -eq 0 -and
        $terminalRecord.process.pid -is [long] -and $terminalRecord.process.pid -gt 0 -and
        $terminalRecord.process.startedAtUtc -is [string] -and
        $terminalRecord.process.path -is [string] -and $terminalRecord.process.kind -is [string] -and
        @(Compare-Object ($expectedTerminalArtifactHashKeys | Sort-Object) `
            ((Get-TestObjectKeys $terminalRecord.artifactHashes) | Sort-Object)).Count -eq 0 -and
        @($expectedTerminalArtifactHashKeys | Where-Object {
            $terminalRecord.artifactHashes[$_] -isnot [string] -or
            [string]$terminalRecord.artifactHashes[$_] -notmatch '^[0-9a-f]{64}$'
        }).Count -eq 0 -and
        [int]$Status.journal.recordCount -eq $records.Count -and
        [string]$terminalRecord.stage -ceq 'terminal_commit' -and
        [string]$terminalRecord.status -ceq 'completed' -and
        [int]$terminalRecord.exitCode -eq 0 -and
        [string]$terminalRecord.recordHash -ceq [string]$Status.journal.lastRecordHash
    ) 'The independently validated final journal record must equal the terminal Status binding.'

    $resultPath = [IO.Path]::GetFullPath([string]$Status.result.path)
    $resultSha256 = Get-Sha256 $resultPath
    $result = Get-Content -LiteralPath $resultPath -Raw |
        ConvertFrom-Json -DateKind String -Depth 100
    $statePath = [IO.Path]::GetFullPath([string]$Context.Manifest.paths.supervisorStatePath)
    $stateSha256 = Get-Sha256 $statePath
    $state = Get-Content -LiteralPath $statePath -Raw |
        ConvertFrom-Json -DateKind String -Depth 100
    $receiptPath = [IO.Path]::GetFullPath(
        [string]$Context.Manifest.paths.fixturePreparationReceiptPath
    )
    $receiptSha256 = Get-Sha256 $receiptPath
    $receipt = Get-Content -LiteralPath $receiptPath -Raw |
        ConvertFrom-Json -DateKind String -Depth 100
    $ticketPath = Join-Path $Context.RunRoot 'supervisor-ticket.private.json'
    $ticketSha256 = Get-Sha256 $ticketPath
    $ticket = Get-Content -LiteralPath $ticketPath -Raw |
        ConvertFrom-Json -DateKind String -Depth 100
    Assert-Condition (
        [string]$Status.ticket.path -ceq [IO.Path]::GetFullPath($ticketPath) -and
        [string]$Status.ticket.sha256 -ceq $ticketSha256 -and
        [string]$Status.result.path -ceq $resultPath -and
        [string]$Status.result.sha256 -ceq $resultSha256 -and
        [string]$Status.result.status -ceq 'completed' -and
        $result.schemaVersion -is [long] -and $result.schemaVersion -eq 1 -and
        [string]$result.type -ceq 'waf800_diagnostic_prep_supervisor_result' -and
        [string]$result.version -ceq 'diagnostic-prep-supervisor-v1' -and
        [string]$result.runId -ceq $Context.RunId -and
        [string]$result.manifest.sha256 -ceq $Context.ManifestSha256 -and
        [string]$result.ticket.sha256 -ceq $ticketSha256 -and
        [string]$result.status -ceq 'completed' -and
        $result.terminalEvidenceCommitted -is [bool] -and
        $result.terminalEvidenceCommitted -eq $true -and
        $result.trafficStarted -is [bool] -and $result.trafficStarted -eq $false -and
        $result.leaseAcquired -is [bool] -and $result.leaseAcquired -eq $false -and
        $result.rawErrorPersisted -is [bool] -and $result.rawErrorPersisted -eq $false -and
        [string]$result.journal.path -ceq [string]$Status.journal.path -and
        [string]$result.journal.sha256 -ceq [string]$Status.journal.sha256 -and
        $result.journal.recordCount -is [long] -and
        [int]$result.journal.recordCount -eq $records.Count -and
        [string]$result.journal.terminalHash -ceq [string]$terminalRecord.recordHash -and
        $result.journal.terminalCommitted -is [bool] -and
        $result.journal.terminalCommitted -eq $true -and
        [string]$result.fixturePreparationReceipt.path -ceq $receiptPath -and
        [string]$result.fixturePreparationReceipt.sha256 -ceq $receiptSha256
    ) 'Terminal Status, immutable result, ticket, journal, and preparation receipt must cross-bind exactly.'
    Assert-Condition (
        [string]$state.status -ceq 'completed' -and
        [string]$state.resultPath -ceq $resultPath -and
        [string]$state.resultSha256 -ceq $resultSha256 -and
        [string]$state.resultStatus -ceq 'completed' -and
        $state.worker.exitPersistedBeforeResultParsing -is [bool] -and
        $state.worker.exitPersistedBeforeResultParsing -eq $true -and
        $state.worker.exitCode -is [long] -and $state.worker.exitCode -eq 0 -and
        [string]$receipt.type -ceq 'fixture_preparation_receipt' -and
        [string]$receipt.version -ceq 'fixture-preparation-receipt-v1' -and
        [string]$receipt.status -ceq 'sources_sealed' -and
        [string]$receipt.runId -ceq $Context.RunId -and
        [string]$receipt.manifest.sha256 -ceq $Context.ManifestSha256 -and
        [string]$ticket.runId -ceq $Context.RunId -and
        [string]$ticket.manifest.sha256 -ceq $Context.ManifestSha256
    ) 'Terminal state, receipt, and ticket must retain the same immutable run identity.'
    $terminalArtifactHashes = $terminalRecord.artifactHashes
    Assert-Condition (
        [string]$terminalArtifactHashes.fixturePreparationReceiptSha256 -ceq $receiptSha256 -and
        [string]$terminalArtifactHashes.snapshotArtifactSetSha256 -ceq
            [string]$receipt.snapshot.artifactSetSha256 -and
        [string]$terminalArtifactHashes.verificationCountsAndGatesSha256 -ceq
            [string]$receipt.verification.countsAndGatesSha256 -and
        [string]$terminalArtifactHashes.supervisorAdmissionSha256 -ceq $ticketSha256 -and
        [string]$result.verificationCountsAndGatesSha256 -ceq
            [string]$receipt.verification.countsAndGatesSha256 -and
        [string]$result.supervisorAdmissionSha256 -ceq $ticketSha256
    ) 'The terminal journal record must bind the exact receipt, snapshot, verification, and admission hashes.'

    $statusCanonical = ([ordered]@{
        schemaVersion=$Status.schemaVersion;type=$Status.type
        version=$Status.version;runId=$Status.runId
        status=$Status.status;healthy=$Status.healthy
        ticket=$Status.ticket;supervisorProcessPresent=$Status.supervisorProcessPresent
        workerProcessPresent=$Status.workerProcessPresent
        lastKnownStage=$Status.lastKnownStage;journal=$Status.journal;result=$Status.result
        recoveryAdmission=$Status.recoveryAdmission;finding=$Status.finding
        trafficStarted=$Status.trafficStarted;leaseAcquired=$Status.leaseAcquired
    } | ConvertTo-Json -Compress -Depth 100)
    $recordCanonical = ([ordered]@{
        schemaVersion=$terminalRecord.schemaVersion;type=$terminalRecord.type
        version=$terminalRecord.version;sequence=$terminalRecord.sequence
        runId=$terminalRecord.runId;manifestSha256=$terminalRecord.manifestSha256
        timestampUtc=$terminalRecord.timestampUtc;stage=$terminalRecord.stage
        status=$terminalRecord.status;process=$terminalRecord.process
        exitCode=$terminalRecord.exitCode;artifactHashes=$terminalRecord.artifactHashes
        previousRecordHash=$terminalRecord.previousRecordHash
        failureCode=$terminalRecord.failureCode;failureStage=$terminalRecord.failureStage
        recordHash=$terminalRecord.recordHash
    } | ConvertTo-Json -Compress -Depth 100)
    return [ordered]@{
        terminalStatus=[ordered]@{
            canonicalJson=$statusCanonical
            canonicalSha256=Get-TextSha256 $statusCanonical
        }
        terminalJournalRecord=[ordered]@{
            canonicalJson=$recordCanonical
            canonicalSha256=Get-TextSha256 $recordCanonical
            recordHash=[string]$terminalRecord.recordHash
            sequence=[int]$terminalRecord.sequence
        }
        supervisorStateSha256=$stateSha256
        supervisorResultSha256=$resultSha256
        journalSha256=[string]$Status.journal.sha256
        preparationReceiptSha256=$receiptSha256
    }
}

function Assert-OfflineRehearsalNoExternalContact {
    param($Context)
    Assert-Condition (
        [string]$Context.Manifest.fixture.provider -ceq 'offline-fake' -and
        $Context.Manifest.diagnosticEligible -eq $false -and
        ([Uri][string]$Context.Manifest.fixture.baseUrl).Host.EndsWith(
            '.invalid', [StringComparison]::OrdinalIgnoreCase
        )
    ) 'Offline rehearsal must be bound to a reserved, non-routable provider endpoint.'
    $records = @(Read-TestJournal $Context)
    $externalBoundaryRecords = @($records | Where-Object {
        [string]$_.stage -in @('refresh_child_started','verify_child_started')
    })
    Assert-Condition ($externalBoundaryRecords.Count -eq 0) `
        'Offline rehearsal must fail closed if a production fixture child boundary is invoked.'
    foreach ($logName in @(
            'fixture-worker.stdout.log','fixture-worker.stderr.log',
            'supervisor.stdout.log','supervisor.stderr.log'
        )) {
        $logPath = Join-Path $Context.RunRoot $logName
        if (Test-Path -LiteralPath $logPath -PathType Leaf) {
            $logText = Get-Content -LiteralPath $logPath -Raw
            Assert-Condition ($logText -cnotmatch '(?i)school-pilot\.net|amazonaws\.com|\baws(?:\.exe)?\b') `
                'Offline rehearsal logs prove that no production or AWS boundary was invoked.'
        }
    }
    return [ordered]@{
        reservedEndpointHost = ([Uri][string]$Context.Manifest.fixture.baseUrl).Host
        productionChildBoundaryInvocationCount = 0
        awsBoundaryInvocationCount = 0
    }
}

function Assert-TerminalFailureStage {
    param($Context, [string]$ExpectedStage, [string]$ExpectedPriorStage)
    $records = @(Read-TestJournal $Context)
    Assert-Condition ($records.Count -ge 2) 'A failed preparation must retain boundary evidence.'
    $terminal = $records[-1]
    Assert-Condition (
        [string]$terminal.stage -ceq 'terminal_commit' -and
        [string]$terminal.status -ceq 'failed' -and
        [string]$terminal.failureStage -ceq $ExpectedStage -and
        [int]$terminal.exitCode -eq 1
    ) "The terminal journal must preserve the exact failure stage '$ExpectedStage'."
    if (-not [string]::IsNullOrWhiteSpace($ExpectedPriorStage)) {
        Assert-Condition ([string]$records[-2].stage -ceq $ExpectedPriorStage) `
            "The last committed boundary before terminal failure must be '$ExpectedPriorStage'."
    }
}

function Assert-ExactPrivateAclState {
    param([string]$Path, [switch]$Directory)
    $item = Get-Item -LiteralPath $Path -Force
    Assert-Condition ([bool]$item.PSIsContainer -eq [bool]$Directory) `
        "ACL assertion path type mismatch: $Path"
    $security = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, [Security.AccessControl.AccessControlSections]::Access
    )
    $rules = @($security.GetAccessRules(
        $true, $true, [Security.Principal.SecurityIdentifier]
    ))
    $expectedSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-Condition ($security.AreAccessRulesProtected -and $rules.Count -eq 1) `
        "Private artifact must have one protected access rule: $Path"
    $rule = $rules[0]
    Assert-Condition (
        $rule.IdentityReference.Value -ceq $expectedSid -and
        $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        -not $rule.IsInherited -and
        (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq
            [Security.AccessControl.FileSystemRights]::FullControl)
    ) "Private artifact ACL is not current-user FullControl only: $Path"
}

function Get-TestSnapshotStagingPath {
    param($Context)
    return Join-Path ([IO.Path]::GetDirectoryName($Context.SnapshotRoot)) `
        ('.' + $Context.RunId + '.fixture-snapshot.staging')
}

function Rewrite-TestManifest {
    param($Context, [scriptblock]$Mutation)
    & $Mutation $Context.Manifest
    Write-PrivateJson $Context.ManifestPath $Context.Manifest
    $Context.ManifestSha256 = Get-Sha256 $Context.ManifestPath
}

function Assert-RecoveryRejected {
    param($Context, [string]$Message)
    $result = Invoke-Supervisor -Context $Context -Mode ResumePublication -AllowFailure
    Assert-Condition ($result.ExitCode -ne 0) $Message
    return $result
}

function Get-SupervisorBindingArguments {
    param($Context, $Terminal)
    $ticketPath = Join-Path $Context.RunRoot 'supervisor-ticket.private.json'
    Assert-Condition (Test-Path -LiteralPath $ticketPath -PathType Leaf) `
        'Diagnostic binding requires the immutable durable-supervisor ticket.'
    $terminalResultProperty = if ($null -eq $Terminal) { $null } else {
        $Terminal.PSObject.Properties['result']
    }
    $resultPath = if ($null -ne $terminalResultProperty -and
        $null -ne $terminalResultProperty.Value -and
        -not [string]::IsNullOrWhiteSpace([string]$terminalResultProperty.Value.path)) {
        [string]$terminalResultProperty.Value.path
    }
    else {
        $state = Get-Content -LiteralPath ([string]$Context.Manifest.paths.supervisorStatePath) -Raw |
            ConvertFrom-Json -DateKind String -Depth 80
        [string]$state.resultPath
    }
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($resultPath) -and
        (Test-Path -LiteralPath $resultPath -PathType Leaf)) `
        'Diagnostic binding requires the exact terminal durable-supervisor result.'
    return @(
        '-SupervisorTicketPath',$ticketPath,
        '-ExpectedSupervisorTicketSha256',(Get-Sha256 $ticketPath),
        '-SupervisorResultPath',$resultPath,
        '-ExpectedSupervisorResultSha256',(Get-Sha256 $resultPath)
    )
}

foreach ($path in @($workerPath,$supervisorPath,$binderPath,$diagnosticPath,$certificationPath)) {
    Assert-Condition (Test-Path -LiteralPath $path -PathType Leaf) "Missing preparation component: $path"
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    Assert-Condition ($errors.Count -eq 0) "$path has PowerShell parse errors."
    Assert-Condition ($ast.ScriptRequirements.RequiredPSVersion -ge [Version]'7.5') `
        "$path must require PowerShell 7.5 or newer."
}
Assert-Condition (Test-Path -LiteralPath $manifestTemplatePath -PathType Leaf) `
    'The repository-owned production preparation manifest template is missing.'
$manifestTemplate = Get-Content -LiteralPath $manifestTemplatePath -Raw |
    ConvertFrom-Json -DateKind String -Depth 100
$expectedManifestResourceKeys = @(
    'region','accountId','cluster','apiService','workerService','rdsInstanceId',
    'redisCacheClusterId','redisReplicationGroupId','vpcId','wafWebAclName',
    'cloudFrontDistributionId','wafDeviceClassifierMetricName','wafDeviceRuleMetricName',
    'wafApiRuleMetricName','targetGroupArn','route53HealthCheckId','route53AlarmName',
    'notificationTopicArn','expectedRdsInstanceClass','expectedRedisNodeType',
    'expectedNatGatewayCount','expectedEcsAssignPublicIp','expectedRoute53MeasureLatency',
    'ecsTaskSubnetIds','expectedActiveApiTaskDefinitionArn','expectedActiveWorkerTaskDefinitionArn'
)
$actualManifestResourceKeys = @($manifestTemplate.resources.PSObject.Properties.Name | Sort-Object)
Assert-Condition (
    [int]$manifestTemplate.schemaVersion -eq 1 -and
    [string]$manifestTemplate.type -ceq 'waf800_diagnostic_prep_manifest' -and
    [string]$manifestTemplate.version -ceq 'waf800-diagnostic-prep-manifest-v1' -and
    $manifestTemplate.diagnosticOnly -eq $true -and
    $manifestTemplate.diagnosticEligible -eq $true -and
    $manifestTemplate.certificationEligible -eq $false -and
    $null -eq $manifestTemplate.PSObject.Properties['testControls'] -and
    @($manifestTemplate.fixture.requiredPrivateFiles).Count -eq 5 -and
    [string]$manifestTemplate.historyFallbackQueryIdentity.version -ceq
        'history-fallback-queryid-v1' -and
    [string]$manifestTemplate.databaseInsightsLease.version -ceq
        'database-insights-monitoring-lease-v3' -and
    @(Compare-Object ($expectedManifestResourceKeys | Sort-Object) $actualManifestResourceKeys).Count -eq 0 -and
    [string]$manifestTemplate.resources.region -ceq 'us-east-1' -and
    [string]$manifestTemplate.resources.accountId -ceq '135775632425' -and
    [string]$manifestTemplate.resources.cluster -ceq 'schoolpilot-production-cluster' -and
    [string]$manifestTemplate.resources.apiService -ceq 'schoolpilot-production-api' -and
    [string]$manifestTemplate.resources.workerService -ceq
        'schoolpilot-production-scheduler-worker' -and
    [string]$manifestTemplate.resources.wafWebAclName -ceq
        'schoolpilot-production-cloudfront-waf' -and
    [string]$manifestTemplate.resources.wafDeviceClassifierMetricName -ceq
        'schoolpilot-production-device-ingest-classifier' -and
    [string]$manifestTemplate.resources.wafDeviceRuleMetricName -ceq
        'schoolpilot-production-device-ingest-rate-limit' -and
    [string]$manifestTemplate.resources.wafApiRuleMetricName -ceq
        'schoolpilot-production-api-rate-limit' -and
    [string]$manifestTemplate.resources.expectedRdsInstanceClass -ceq 'db.t4g.medium' -and
    [string]$manifestTemplate.resources.expectedRedisNodeType -ceq 'cache.t4g.small' -and
    [int]$manifestTemplate.resources.expectedNatGatewayCount -eq 2 -and
    $manifestTemplate.resources.expectedEcsAssignPublicIp -eq $false -and
    $manifestTemplate.resources.expectedRoute53MeasureLatency -eq $true -and
    @($manifestTemplate.resources.ecsTaskSubnetIds).Count -eq 2 -and
    [string]$manifestTemplate.resources.expectedActiveApiTaskDefinitionArn -ceq
        [string]$manifestTemplate.release.apiTaskDefinitionArn -and
    [string]$manifestTemplate.resources.expectedActiveWorkerTaskDefinitionArn -ceq
        [string]$manifestTemplate.release.workerTaskDefinitionArn
) 'The repository-owned preparation manifest template must retain the production diagnostic contract.'

$workerText = Get-Content -LiteralPath $workerPath -Raw
$supervisorText = Get-Content -LiteralPath $supervisorPath -Raw
$binderText = Get-Content -LiteralPath $binderPath -Raw
$diagnosticText = Get-Content -LiteralPath $diagnosticPath -Raw
$certificationText = Get-Content -LiteralPath $certificationPath -Raw
foreach ($required in @(
    'waf800-diagnostic-prep-manifest-v1','fixture-preparation-receipt-v1','diagnostic-prep-journal-v1',
    'ResumePublication','source_hashes_sealed','publication_started','publication_completed','terminal_commit',
    'fixture_snapshot_recovery_failed','one permitted publication recovery','offline-fake'
)) { Assert-Condition $workerText.Contains($required) "Fixture worker is missing invariant: $required" }
foreach ($required in @(
    'diagnostic-prep-supervisor-v1','SupervisorTimeoutSeconds = 2100','exitPersistedBeforeResultParsing',
    'supervisor-ticket.private.json','publication-recovery-result.private.json','returnedBeforeCompletion',
    'CREATE_SUSPENDED','PROC_THREAD_ATTRIBUTE_HANDLE_LIST','PROC_THREAD_ATTRIBUTE_JOB_LIST',
    'CreateSuspendedProcessInJob','ResumeThread'
)) { Assert-Condition $supervisorText.Contains($required) "Preparation supervisor is missing invariant: $required" }
Assert-Condition (-not $supervisorText.Contains('Start-Process -FilePath $pwsh')) `
    'Preparation workers must never execute before atomic Job admission.'
Assert-Condition (-not $workerText.Contains('05:48')) 'Preparation errors must not retain the historical hard-coded window.'
Assert-Condition (-not $supervisorText.Contains('05:48')) 'Supervisor errors must derive the manifest-bound window.'
Assert-Condition ($binderText.Contains('[IO.Directory]::Move($staging, $bindingRoot)')) `
    'Diagnostic binding must publish its group with one directory rename.'
Assert-Condition ($diagnosticText.Contains("Diagnostic config requires 'fixturePreparation'.")) `
    'The diagnostic controller must require fixture preparation provenance.'
Assert-Condition ($certificationText.Contains('fixturePreparation must bind an eligible repository-owned preparation receipt.')) `
    'The certification supervisor must independently require fixture preparation provenance.'

$specialContext = $null
$specialSucceeded = $false
if ($Mode -ne 'Suite') {
    if ([string]::IsNullOrWhiteSpace($EvidenceOutputPath)) {
        throw "$Mode requires -EvidenceOutputPath."
    }
    $repositoryBefore = Get-MergedMainRepositoryState
    $gitSha = $repositoryBefore.gitSha
    $modeStartedAtUtc = [DateTimeOffset]::UtcNow
    $modeWatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($Mode -ceq 'OfflineRehearsal') {
            $specialContext = New-TestContext -Name 'merged-sha-offline-rehearsal' `
                -TestControls @{harmlessDelaySeconds=1}
            $validated = Invoke-Supervisor -Context $specialContext -Mode Validate
            Assert-Condition ($validated.Json.valid -eq $true -and
                $validated.Json.diagnosticEligible -eq $false) `
                'The offline rehearsal manifest must validate as permanently traffic-ineligible.'
            $started = Invoke-Supervisor -Context $specialContext -Mode Start
            Assert-Condition ($started.Json.accepted -eq $true -and
                $started.Json.returnedBeforeCompletion -eq $true) `
                'The offline rehearsal must begin through the durable Start contract.'
            $terminal = Wait-SupervisorTerminal -Context $specialContext -TimeoutSeconds 180
            Assert-Condition ($terminal.status -ceq 'completed' -and $terminal.healthy -eq $true) `
                'The offline refresh-to-publication rehearsal must complete.'
            $bindArguments = @(
                '-ManifestPath',$specialContext.ManifestPath,
                '-ExpectedManifestSha256',$specialContext.ManifestSha256,
                '-FixturePreparationReceiptPath',
                    [string]$specialContext.Manifest.paths.fixturePreparationReceiptPath,
                '-ExpectedFixturePreparationReceiptSha256',
                    (Get-Sha256 ([string]$specialContext.Manifest.paths.fixturePreparationReceiptPath))
            ) + @(Get-SupervisorBindingArguments -Context $specialContext -Terminal $terminal)
            $bound = Invoke-JsonProcess -Script $binderPath -Arguments $bindArguments
            $boundConfig = Get-Content -LiteralPath $bound.Json.configPath -Raw |
                ConvertFrom-Json -DateKind String -Depth 100
            Assert-Condition ($bound.Json.ok -eq $true -and
                $bound.Json.diagnosticEligible -eq $false -and
                $boundConfig.diagnosticEligible -eq $false -and
                $null -eq $boundConfig.databaseInsightsLease -and
                $null -eq $boundConfig.historyFallbackQueryIdentity) `
                'The end-to-end offline binder result must remain unusable for workload traffic.'
            $noContactEvidence = Assert-OfflineRehearsalNoExternalContact $specialContext
            $repositoryAfter = Assert-MergedMainRepositoryStateUnchanged $repositoryBefore
            $modeWatch.Stop()
            $terminalEvidence = New-TerminalPreparationEvidenceBinding `
                -Context $specialContext -Status $terminal
            $evidence = [ordered]@{
                schemaVersion=1;type='waf800_diagnostic_prep_rehearsal_evidence'
                version='diagnostic-prep-offline-rehearsal-v1';mode=$Mode;status='passed'
                startedAtUtc=$modeStartedAtUtc.ToString('o')
                completedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')
                elapsedMilliseconds=[long]$modeWatch.ElapsedMilliseconds
                repository=[ordered]@{
                    gitSha=$repositoryAfter.gitSha;branch=$repositoryAfter.branch
                    originMainSha=$repositoryAfter.originMainSha;clean=$true
                    verifiedBeforeAndAfter=$true
                }
                components=$repositoryAfter.componentHashes
                run=[ordered]@{
                    runId=$specialContext.RunId;manifestSha256=$specialContext.ManifestSha256
                    diagnosticEligible=$false;provider='offline-fake';externalContactPermitted=$false
                    noExternalContactEvidence=$noContactEvidence
                    retainedArtifactRoot=$specialContext.Root
                    retainedControlRoot=$specialContext.RunRoot
                    retainedSnapshotRoot=$specialContext.SnapshotRoot
                    terminalStatus=$terminalEvidence.terminalStatus
                    terminalJournalRecord=$terminalEvidence.terminalJournalRecord
                    supervisorTicketSha256=Get-Sha256 (Join-Path $specialContext.RunRoot `
                        'supervisor-ticket.private.json')
                    supervisorStateSha256=$terminalEvidence.supervisorStateSha256
                    supervisorResultSha256=$terminalEvidence.supervisorResultSha256
                    journalSha256=$terminalEvidence.journalSha256
                    preparationReceiptSha256=$terminalEvidence.preparationReceiptSha256
                    snapshotArtifactSetSha256=[string](
                        (Get-Content -LiteralPath `
                            ([string]$specialContext.Manifest.paths.fixturePreparationReceiptPath) -Raw |
                            ConvertFrom-Json -DateKind String -Depth 100).snapshot.artifactSetSha256
                    )
                    bindingConfigSha256=Get-Sha256 $bound.Json.configPath
                    bindingReceiptSha256=Get-Sha256 $bound.Json.bindingReceiptPath
                }
                assertions=$script:AssertionCount;artifactsRetained=$true
                trafficStarted=$false;leaseAcquired=$false
                productionFixturesAccessed=$false;rawErrorPersisted=$false
            }
        }
        else {
            $specialContext = New-TestContext -Name 'merged-sha-26-minute-host-smoke' `
                -TestControls @{harmlessDelaySeconds=$HostSmokeSeconds}
            $validated = Invoke-Supervisor -Context $specialContext -Mode Validate
            Assert-Condition ($validated.Json.valid -eq $true -and
                $validated.Json.diagnosticEligible -eq $false) `
                'The host smoke manifest must validate as permanently traffic-ineligible.'
            $initiator = Start-JsonProcessAsync -Script $supervisorPath -Arguments @(
                '-Mode','Start','-ManifestPath',$specialContext.ManifestPath,
                '-ExpectedManifestSha256',$specialContext.ManifestSha256
            )
            $initiatorProcess = $initiator.Process
            $initiatorIdentity = [ordered]@{
                pid=[int]$initiatorProcess.Id
                startedAtUtc=([DateTimeOffset]$initiatorProcess.StartTime).ToUniversalTime().ToString('o')
                path=[string]$initiatorProcess.Path
            }
            $startResult = Complete-JsonProcessAsync $initiator
            Assert-Condition ($startResult.ExitCode -eq 0 -and
                $startResult.Json.accepted -eq $true -and
                $startResult.Json.returnedBeforeCompletion -eq $true -and
                -not (Test-ExactProcessPresent $initiatorIdentity)) `
                'The disposable initiating host must exit while its detached supervisor remains durable.'
            $pollCount = 0
            $activePollCount = 0
            $observedBeyondPriorBoundary = $false
            $terminal = $null
            $pollWatch = [Diagnostics.Stopwatch]::StartNew()
            do {
                $polled = Invoke-Supervisor -Context $specialContext -Mode Status -AllowFailure
                Assert-Condition ($polled.ExitCode -eq 0 -and $polled.Json.healthy -eq $true) `
                    'Independent host-smoke Status polling must remain healthy.'
                $pollCount++
                if ([string]$polled.Json.status -in @(
                        'launching','running','worker_exited','committing',
                        'recovery_admitted','recovery_running','recovery_committing'
                    )) {
                    $activePollCount++
                }
                if ($pollWatch.Elapsed.TotalMinutes -ge 15 -and
                    [string]$polled.Json.status -notin @('completed','failed','timed_out','interrupted') -and
                    $polled.Json.supervisorProcessPresent -eq $true) {
                    $observedBeyondPriorBoundary = $true
                }
                if ([string]$polled.Json.status -in @('completed','failed','timed_out','interrupted')) {
                    $terminal = $polled.Json
                    break
                }
                Start-Sleep -Seconds 30
            } while ($pollWatch.Elapsed.TotalSeconds -lt ($HostSmokeSeconds + 300))
            $pollWatch.Stop()
            $modeWatch.Stop()
            Assert-Condition ($null -ne $terminal -and $terminal.status -ceq 'completed' -and
                $terminal.healthy -eq $true -and $observedBeyondPriorBoundary -and
                $pollWatch.Elapsed.TotalSeconds -ge $HostSmokeSeconds -and
                $activePollCount -ge 30) `
                'The host smoke must remain supervised beyond 15 minutes and complete the full harmless interval.'
            $state = Get-Content -LiteralPath `
                ([string]$specialContext.Manifest.paths.supervisorStatePath) -Raw |
                ConvertFrom-Json -DateKind String -Depth 100
            Assert-Condition ($state.worker.exitPersistedBeforeResultParsing -eq $true -and
                [int]$state.worker.exitCode -eq 0) `
                'The 26-minute host smoke must persist the exact worker exit before parsing.'
            $noContactEvidence = Assert-OfflineRehearsalNoExternalContact $specialContext
            $repositoryAfter = Assert-MergedMainRepositoryStateUnchanged $repositoryBefore
            $terminalEvidence = New-TerminalPreparationEvidenceBinding `
                -Context $specialContext -Status $terminal
            $evidence = [ordered]@{
                schemaVersion=1;type='waf800_diagnostic_prep_rehearsal_evidence'
                version='diagnostic-prep-host-supervision-smoke-v2';mode=$Mode;status='passed'
                startedAtUtc=$modeStartedAtUtc.ToString('o')
                completedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')
                elapsedMilliseconds=[long]$modeWatch.ElapsedMilliseconds
                requestedHarmlessChildSeconds=$HostSmokeSeconds
                observedBeyondPriorFifteenMinuteBoundary=$observedBeyondPriorBoundary
                statusPollCount=$pollCount;activeStatusPollCount=$activePollCount
                initiatingProcessExited=$true
                repository=[ordered]@{
                    gitSha=$repositoryAfter.gitSha;branch=$repositoryAfter.branch
                    originMainSha=$repositoryAfter.originMainSha;clean=$true
                    verifiedBeforeAndAfter=$true
                }
                components=$repositoryAfter.componentHashes
                run=[ordered]@{
                    runId=$specialContext.RunId;manifestSha256=$specialContext.ManifestSha256
                    diagnosticEligible=$false;provider='offline-fake';externalContactPermitted=$false
                    noExternalContactEvidence=$noContactEvidence
                    retainedArtifactRoot=$specialContext.Root
                    retainedControlRoot=$specialContext.RunRoot
                    retainedSnapshotRoot=$specialContext.SnapshotRoot
                    terminalStatus=$terminalEvidence.terminalStatus
                    terminalJournalRecord=$terminalEvidence.terminalJournalRecord
                    supervisorTicketSha256=Get-Sha256 (Join-Path $specialContext.RunRoot `
                        'supervisor-ticket.private.json')
                    supervisorStateSha256=$terminalEvidence.supervisorStateSha256
                    supervisorResultSha256=$terminalEvidence.supervisorResultSha256
                    journalSha256=$terminalEvidence.journalSha256
                    preparationReceiptSha256=$terminalEvidence.preparationReceiptSha256
                }
                assertions=$script:AssertionCount;artifactsRetained=$true
                trafficStarted=$false;leaseAcquired=$false
                productionFixturesAccessed=$false;rawErrorPersisted=$false
            }
        }
        $publishedEvidence = Write-ImmutablePrivateEvidence -Path $EvidenceOutputPath -Value $evidence
        $specialSucceeded = $true
        [Console]::Out.WriteLine((([ordered]@{
            ok=$true;mode=$Mode;status='passed';evidencePath=$publishedEvidence.path
            evidenceSha256=$publishedEvidence.sha256;trafficStarted=$false;leaseAcquired=$false
        }) | ConvertTo-Json -Compress))
    }
    finally {
        if (-not $specialSucceeded -and $null -ne $specialContext -and
            (Test-Path -LiteralPath $specialContext.Root)) {
            Remove-TestContextBestEffort $specialContext
        }
    }
    return
}

$contexts = [Collections.Generic.List[object]]::new()
try {
    $ineligibleProduction = New-TestContext -Name 'ineligible-production-provider'
    $contexts.Add($ineligibleProduction)
    foreach ($credentialName in @('fixturePasswords','superAdminPassword','superAdminOperation')) {
        $credentialPath = Join-Path $ineligibleProduction.Root "$credentialName.private.json"
        Write-PrivateJson $credentialPath ([ordered]@{offlineTestOnly=$true})
        $ineligibleProduction.Manifest.fixture[$credentialName] = [ordered]@{
            path=$credentialPath;sha256=Get-Sha256 $credentialPath
        }
    }
    $ineligibleProduction.Manifest.fixture.provider = 'production'
    $ineligibleProduction.Manifest.fixture.Remove('fakeTemplateRoot')
    Rewrite-TestManifest -Context $ineligibleProduction -Mutation { param($manifest) }
    $ineligibleProductionValidation = Invoke-JsonProcess -Script $workerPath -Arguments @(
        '-Mode','Validate','-ManifestPath',$ineligibleProduction.ManifestPath,
        '-ExpectedManifestSha256',$ineligibleProduction.ManifestSha256
    ) -AllowFailure
    Assert-Condition ($ineligibleProductionValidation.ExitCode -ne 0 -and
        -not (Test-Path -LiteralPath ([string]$ineligibleProduction.Manifest.fixture.sourceRoot))) `
        'A diagnostic-ineligible manifest must never admit the production fixture provider.'

    $staleRecoveryEvidence = New-TestContext -Name 'fresh-run-stale-recovery-evidence'
    $contexts.Add($staleRecoveryEvidence)
    [void](New-PrivateDirectory $staleRecoveryEvidence.RunRoot)
    Write-PrivateJson ([string]$staleRecoveryEvidence.Manifest.paths.publicationRecoveryReceiptPath) `
        ([ordered]@{status='stale';offlineTestOnly=$true})
    $staleRecoveryStart = Invoke-Supervisor -Context $staleRecoveryEvidence -Mode Start -AllowFailure
    Assert-Condition ($staleRecoveryStart.ExitCode -ne 0 -and
        -not (Test-Path -LiteralPath (Join-Path $staleRecoveryEvidence.RunRoot `
            'supervisor-launch-admission.private.json')) -and
        -not (Test-Path -LiteralPath ([string]$staleRecoveryEvidence.Manifest.paths.journalPath)) -and
        -not (Test-Path -LiteralPath ([string]$staleRecoveryEvidence.Manifest.fixture.sourceRoot))) `
        'A fresh preparation must reject stale publication-recovery evidence before admission or mutation.'

    foreach ($downstreamField in @(
        'leaseReceiptPath','bindingRoot','evidenceDirectory','startGatePath','trafficMarkerPath'
    )) {
        $staleDownstream = New-TestContext -Name ("fresh-run-downstream-" + $downstreamField)
        $contexts.Add($staleDownstream)
        $staleDownstreamPath = [string]$staleDownstream.Manifest.paths[$downstreamField]
        if ($downstreamField -in @('bindingRoot','evidenceDirectory')) {
            [void](New-PrivateDirectory $staleDownstreamPath)
        }
        else { Write-PrivateText $staleDownstreamPath '{"stale":true}' }
        $staleDownstreamValidate = Invoke-Supervisor -Context $staleDownstream `
            -Mode Validate -AllowFailure
        $staleDownstreamStart = Invoke-Supervisor -Context $staleDownstream `
            -Mode Start -AllowFailure
        Assert-Condition (
            $staleDownstreamValidate.ExitCode -ne 0 -and
            $staleDownstreamStart.ExitCode -ne 0 -and
            -not (Test-Path -LiteralPath (Join-Path $staleDownstream.RunRoot `
                'supervisor-launch-admission.private.json')) -and
            -not (Test-Path -LiteralPath (Join-Path $staleDownstream.RunRoot `
                'supervisor-ticket.private.json')) -and
            -not (Test-Path -LiteralPath ([string]$staleDownstream.Manifest.paths.journalPath)) -and
            -not (Test-Path -LiteralPath ([string]$staleDownstream.Manifest.paths.fixturePreparationReceiptPath)) -and
            -not (Test-Path -LiteralPath ([string]$staleDownstream.Manifest.fixture.sourceRoot)) -and
            -not (Test-Path -LiteralPath $staleDownstream.SnapshotRoot)
        ) "A stale $downstreamField artifact must reject validation and Start before launch admission, journal, source mutation, or snapshot publication."
    }

    $success = New-TestContext -Name 'success' -TestControls @{harmlessDelaySeconds=1}
    $contexts.Add($success)
    $validate = Invoke-Supervisor -Context $success -Mode Validate
    Assert-Condition ($validate.ExitCode -eq 0 -and $validate.Json.valid -eq $true -and
        $validate.Json.mutationStarted -eq $false) 'Supervisor Validate must be bound and non-mutating.'
    $startWatch = [Diagnostics.Stopwatch]::StartNew()
    $start = Invoke-Supervisor -Context $success -Mode Start
    Assert-Condition ($startWatch.Elapsed.TotalSeconds -lt 15 -and $start.Json.accepted -eq $true -and
        $start.Json.returnedBeforeCompletion -eq $true) 'Start must promptly return a durable detached ticket.'
    $terminal = Wait-SupervisorTerminal $success
    Assert-Condition ($terminal.status -ceq 'completed' -and $terminal.healthy -eq $true -and
        $terminal.journal.terminalCommitted -eq $true) `
        "Detached fake preparation must complete with a terminal journal (status=$(ConvertTo-Json -InputObject $terminal -Depth 20 -Compress))."
    $successTerminalEvidence = New-TerminalPreparationEvidenceBinding `
        -Context $success -Status $terminal
    Assert-Condition (
        [string]$successTerminalEvidence.terminalStatus.canonicalSha256 -ceq
            (Get-TextSha256 ([string]$successTerminalEvidence.terminalStatus.canonicalJson)) -and
        [string]$successTerminalEvidence.terminalJournalRecord.canonicalSha256 -ceq
            (Get-TextSha256 ([string]$successTerminalEvidence.terminalJournalRecord.canonicalJson)) -and
        [string]$successTerminalEvidence.terminalJournalRecord.recordHash -ceq
            [string]$terminal.journal.lastRecordHash -and
        [string]$successTerminalEvidence.supervisorStateSha256 -ceq
            (Get-Sha256 ([string]$success.Manifest.paths.supervisorStatePath))
    ) 'Fast preparation tests must verify the exact readiness terminal-evidence binding.'
    $tamperedTerminalStatus = $terminal | ConvertTo-Json -Depth 100 |
        ConvertFrom-Json -DateKind String -Depth 100
    $tamperedTerminalStatus.result.sha256 = '0' * 64
    Assert-Throws {
        [void](New-TerminalPreparationEvidenceBinding -Context $success `
            -Status $tamperedTerminalStatus)
    } 'immutable result' 'Terminal readiness evidence must reject a tampered result hash.'
    $tamperedTerminalBoolean = $terminal | ConvertTo-Json -Depth 100 |
        ConvertFrom-Json -DateKind String -Depth 100
    $tamperedTerminalBoolean.healthy = 'true'
    Assert-Throws {
        [void](New-TerminalPreparationEvidenceBinding -Context $success `
            -Status $tamperedTerminalBoolean)
    } 'exact successful' 'Terminal readiness evidence must reject a string-coerced Boolean.'
    $tamperedTerminalJournal = $terminal | ConvertTo-Json -Depth 100 |
        ConvertFrom-Json -DateKind String -Depth 100
    $tamperedTerminalJournal.journal.recordCount = [string]$terminal.journal.recordCount
    Assert-Throws {
        [void](New-TerminalPreparationEvidenceBinding -Context $success `
            -Status $tamperedTerminalJournal)
    } 'complete journal' 'Terminal readiness evidence must reject a string-coerced journal count.'
    $tamperedTerminalNested = $terminal | ConvertTo-Json -Depth 100 |
        ConvertFrom-Json -DateKind String -Depth 100
    $tamperedTerminalNested.ticket | Add-Member -NotePropertyName rawError `
        -NotePropertyValue 'forbidden'
    Assert-Throws {
        [void](New-TerminalPreparationEvidenceBinding -Context $success `
            -Status $tamperedTerminalNested)
    } 'exact successful' 'Terminal readiness evidence must reject extra nested Status fields.'
    $tamperedFailureRecords = @((Read-TestJournal $success) | ForEach-Object {
        $_ | ConvertTo-Json -Depth 100 | ConvertFrom-Json -DateKind String -AsHashtable -Depth 100
    })
    $tamperedFailureRecords[-1]['failureCode'] = 'forbidden_success_failure'
    Assert-Throws {
        [void](New-TerminalPreparationEvidenceBinding -Context $success -Status $terminal `
            -JournalRecordsOverride $tamperedFailureRecords)
    } 'final journal record' 'Successful terminal records must reject non-null failure metadata.'
    $tamperedNestedRecords = @((Read-TestJournal $success) | ForEach-Object {
        $_ | ConvertTo-Json -Depth 100 | ConvertFrom-Json -DateKind String -AsHashtable -Depth 100
    })
    $tamperedNestedRecords[-1]['process']['rawError'] = 'forbidden'
    Assert-Throws {
        [void](New-TerminalPreparationEvidenceBinding -Context $success -Status $terminal `
            -JournalRecordsOverride $tamperedNestedRecords)
    } 'final journal record' 'Terminal readiness evidence must reject extra nested journal fields.'
    $terminalEvidenceCanonical = [string]$successTerminalEvidence.terminalStatus.canonicalJson +
        [string]$successTerminalEvidence.terminalJournalRecord.canonicalJson
    Assert-Condition ($terminalEvidenceCanonical -cnotmatch
        'rawError|password|bearer|studentId|deviceId|teacherId|school-pilot\.net|amazonaws\.com') `
        'Canonical terminal readiness evidence must remain sanitized and endpoint-free.'
    Assert-Condition ((Get-ChildItem -LiteralPath $success.SnapshotRoot -Force -File).Count -eq 5) `
        'Preparation must atomically publish exactly five snapshot files.'
    Assert-Condition ((Get-ChildItem -LiteralPath ([string]$success.Manifest.fixture.sourceRoot) -Force -File).Count -eq 6 -and
        (Test-Path -LiteralPath (Join-Path ([string]$success.Manifest.fixture.sourceRoot) 'fixture-ownership.private.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $success.SnapshotRoot 'fixture-ownership.private.json'))) `
        'Production-shaped source support files must remain private source-only inputs, never snapshot artifacts.'
    $successJournal = @(Read-TestJournal $success)
    Assert-Condition (
        [string]$successJournal[0].stage -ceq 'preflight_accepted' -and
        [string]$successJournal[-1].stage -ceq 'terminal_commit' -and
        [string]$successJournal[-1].status -ceq 'completed'
    ) 'Successful preparation must retain the ordered journal boundary contract.'
    $state = Get-Content -LiteralPath ([string]$success.Manifest.paths.supervisorStatePath) -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    Assert-Condition ($state.worker.exitPersistedBeforeResultParsing -eq $true -and $state.worker.exitCode -eq 0) `
        'Supervisor must persist the child exit before interpreting its result.'
    foreach ($privateDirectory in @($success.RunRoot, $success.SnapshotRoot)) {
        Assert-ExactPrivateAclState -Path $privateDirectory -Directory
    }
    foreach ($privateFile in @(
        [string]$success.Manifest.paths.journalPath,
        [string]$success.Manifest.paths.fixturePreparationReceiptPath,
        [string]$success.Manifest.paths.supervisorStatePath
    ) + @($script:RequiredFixtureFiles | ForEach-Object { Join-Path $success.SnapshotRoot $_ })) {
        Assert-ExactPrivateAclState -Path $privateFile
    }
    $journalRaw = Get-Content -LiteralPath ([string]$success.Manifest.paths.journalPath) -Raw
    Assert-Condition ($journalRaw -cnotmatch 'offline-redacted|school-pilot\.net|studentId|deviceId|teacherId|password|bearer|rawError') `
        'The preparation journal must contain no fixture secrets, raw errors, or tenant/student/device identifiers.'
    $successReceipt = Get-Content -LiteralPath ([string]$success.Manifest.paths.fixturePreparationReceiptPath) -Raw |
        ConvertFrom-Json -DateKind String -Depth 100
    Assert-Condition ($successReceipt.secretsPrinted -eq $false -and $successReceipt.trafficStarted -eq $false -and
        $successReceipt.leaseAcquired -eq $false) `
        'The sealed preparation receipt must explicitly prove redaction, no traffic, and no lease.'

    $ticketAdmission = New-TestContext -Name 'child-authored-ticket-admission' -TestControls @{
        harmlessDelaySeconds=1;supervisorBeforeTicketDelayMilliseconds=5000
    }
    $contexts.Add($ticketAdmission)
    $ticketStartInvocation = Start-JsonProcessAsync -Script $supervisorPath -Arguments @(
        '-Mode','Start',
        '-ManifestPath',$ticketAdmission.ManifestPath,
        '-ExpectedManifestSha256',$ticketAdmission.ManifestSha256
    )
    $ticketLauncherPid = [int]$ticketStartInvocation.Process.Id
    $ticketStartCompleted = $false
    try {
        $launchAdmissionPath = Join-Path $ticketAdmission.RunRoot `
            'supervisor-launch-admission.private.json'
        $launchPresencePath = Join-Path $ticketAdmission.RunRoot `
            'supervisor-launch-presence.private.json'
        $ticketPath = Join-Path $ticketAdmission.RunRoot 'supervisor-ticket.private.json'
        Wait-TestPath -Path $launchAdmissionPath
        Wait-TestPath -Path $launchPresencePath
        Assert-Condition (
            -not (Test-Path -LiteralPath $ticketPath) -and
            -not (Test-Path -LiteralPath ([string]$ticketAdmission.Manifest.paths.supervisorStatePath)) -and
            -not (Test-Path -LiteralPath ([string]$ticketAdmission.Manifest.paths.journalPath)) -and
            -not (Test-Path -LiteralPath (Join-Path $ticketAdmission.RunRoot 'worker-ownership.private.json'))
        ) 'Before the child-authored ticket, launch admission must be durable while child state, journal, and ownership remain absent.'
        $admittedStatus = Invoke-Supervisor -Context $ticketAdmission -Mode Status -AllowFailure
        Assert-Condition (
            $admittedStatus.ExitCode -eq 0 -and
            [string]$admittedStatus.Json.status -ceq 'launching' -and
            $admittedStatus.Json.healthy -eq $true -and
            $admittedStatus.Json.supervisorProcessPresent -eq $true -and
            $null -eq $admittedStatus.Json.finding -and
            $null -eq $admittedStatus.Json.ticket -and
            [string]$admittedStatus.Json.launchAdmission.sha256 -ceq (Get-Sha256 $launchAdmissionPath) -and
            [string]$admittedStatus.Json.launchPresence.sha256 -ceq (Get-Sha256 $launchPresencePath)
        ) 'Status must bind the live detached supervisor before it authors the normal ticket.'
        $ticketStart = Complete-JsonProcessAsync $ticketStartInvocation
        $ticketStartCompleted = $true
        Assert-Condition ($ticketStart.ExitCode -eq 0 -and $ticketStart.Json.accepted -eq $true) `
            'The delayed child-authored ticket must complete its parent Start handshake.'
        $ticket = Get-Content -LiteralPath $ticketPath -Raw |
            ConvertFrom-Json -DateKind String -Depth 60
        $admission = Get-Content -LiteralPath $launchAdmissionPath -Raw |
            ConvertFrom-Json -DateKind String -Depth 60
        Assert-Condition (
            [string]$ticket.version -ceq 'diagnostic-prep-supervisor-ticket-v2' -and
            [string]$ticket.launchAdmission.path -ceq $launchAdmissionPath -and
            [string]$ticket.launchAdmission.sha256 -ceq (Get-Sha256 $launchAdmissionPath) -and
            [int]$ticket.supervisor.pid -eq [int]$ticketStart.Json.supervisor.pid -and
            [int]$ticket.supervisor.pid -ne $ticketLauncherPid -and
            [DateTimeOffset]::Parse([string]$ticket.createdAtUtc) -ge
                [DateTimeOffset]::Parse([string]$admission.createdAtUtc)
        ) 'Ticket v2 must be authored by the admitted detached child and bind the earlier immutable admission exactly.'
        $ticketAdmissionTerminal = Wait-SupervisorTerminal $ticketAdmission
        Assert-Condition ($ticketAdmissionTerminal.status -ceq 'completed') `
            'The child-authored ticket lifecycle must continue to an ordinary offline completion.'
    }
    finally {
        if (-not $ticketStartCompleted) {
            try {
                if (-not $ticketStartInvocation.Process.HasExited) {
                    Stop-Process -Id $ticketStartInvocation.Process.Id -Force -ErrorAction Stop
                }
            }
            catch { }
            try {
                Wait-TestPath -Path (Join-Path $ticketAdmission.RunRoot `
                    'supervisor-ticket.private.json') -TimeoutSeconds 10
                [void](Stop-TicketBoundSupervisor $ticketAdmission)
            }
            catch { }
            try { [void](Complete-JsonProcessAsync $ticketStartInvocation) } catch { }
        }
    }

    $initiatorLoss = New-TestContext -Name 'initiating-shell-disappears' -TestControls @{
        harmlessDelaySeconds=1;supervisorBeforeTicketDelayMilliseconds=5000
    }
    $contexts.Add($initiatorLoss)
    $initiatorInvocation = Start-JsonProcessAsync -Script $supervisorPath -Arguments @(
        '-Mode','Start',
        '-ManifestPath',$initiatorLoss.ManifestPath,
        '-ExpectedManifestSha256',$initiatorLoss.ManifestSha256
    )
    $initiatorCompleted = $false
    try {
        $initiatorPresencePath = Join-Path $initiatorLoss.RunRoot `
            'supervisor-launch-presence.private.json'
        $initiatorTicketPath = Join-Path $initiatorLoss.RunRoot 'supervisor-ticket.private.json'
        Wait-TestPath -Path $initiatorPresencePath
        Assert-Condition (-not (Test-Path -LiteralPath $initiatorTicketPath)) `
            'The disposable initiating shell regression must end before ticket publication.'
        $initiatorPresence = Get-Content -LiteralPath $initiatorPresencePath -Raw |
            ConvertFrom-Json -DateKind String -Depth 60
        $detachedIdentity = $initiatorPresence.supervisor
        Assert-Condition (Test-ExactProcessPresent $detachedIdentity) `
            'The child-authored launch presence must identify the exact live detached supervisor.'
        Stop-ExactAsyncInvocation $initiatorInvocation
        $initiatorExit = Complete-JsonProcessAsync $initiatorInvocation
        $initiatorCompleted = $true
        Assert-Condition ($initiatorExit.ExitCode -ne 0 -and
            (Test-ExactProcessPresent $detachedIdentity)) `
            'Terminating the disposable initiating shell must not terminate its admitted detached supervisor.'
        Wait-TestPath -Path $initiatorTicketPath -TimeoutSeconds 15
        $initiatorActive = Invoke-Supervisor -Context $initiatorLoss -Mode Status
        Assert-Condition ($initiatorActive.Json.healthy -eq $true -and
            [string]$initiatorActive.Json.status -in @('launching','running','worker_exited','completed')) `
            'A separate Status process must observe a coherent lifecycle after the initiating shell disappears.'
        $initiatorTerminal = Wait-SupervisorTerminal $initiatorLoss
        Assert-Condition ($initiatorTerminal.status -ceq 'completed' -and
            $initiatorTerminal.healthy -eq $true) `
            'The detached preparation must complete after its initiating shell disappears.'
    }
    finally {
        if (-not $initiatorCompleted) {
            try { Stop-ExactAsyncInvocation $initiatorInvocation } catch { }
            try { [void](Complete-JsonProcessAsync $initiatorInvocation) } catch { }
            try { [void](Stop-TicketBoundSupervisor $initiatorLoss) } catch { }
        }
    }

    $beforeWorkerCreate = New-TestContext -Name 'supervisor-loss-before-atomic-worker-create' `
        -TestControls @{
            harmlessDelaySeconds=1
            supervisorBeforeWorkerCreateDelayMilliseconds=30000
        }
    $contexts.Add($beforeWorkerCreate)
    [void](Invoke-Supervisor -Context $beforeWorkerCreate -Mode Start)
    [void](Wait-SupervisorStateStatus $beforeWorkerCreate 'launching')
    $beforeCreateOwnership = Join-Path $beforeWorkerCreate.RunRoot 'worker-ownership.private.json'
    $beforeCreateJournal = [string]$beforeWorkerCreate.Manifest.paths.journalPath
    Wait-TestPath -Path $beforeCreateJournal
    Assert-Condition (
        -not (Test-Path -LiteralPath $beforeCreateOwnership) -and
        (Test-Path -LiteralPath $beforeCreateJournal -PathType Leaf) -and
        (Get-Item -LiteralPath $beforeCreateJournal).Length -eq 0
    ) 'Before atomic CreateProcess/Job admission, no worker identity or journal mutation may exist.'
    [void](Stop-TicketBoundSupervisor $beforeWorkerCreate)
    $beforeCreateStatus = Invoke-Supervisor -Context $beforeWorkerCreate -Mode Status -AllowFailure
    Assert-Condition (
        $beforeCreateStatus.ExitCode -eq 0 -and
        $beforeCreateStatus.Json.healthy -eq $false -and
        [string]$beforeCreateStatus.Json.finding -ceq 'supervisor_process_lost_without_terminal_state' -and
        $beforeCreateStatus.Json.workerProcessPresent -eq $false -and
        -not (Test-Path -LiteralPath ([string]$beforeWorkerCreate.Manifest.paths.fixturePreparationReceiptPath)) -and
        -not (Test-Path -LiteralPath $beforeWorkerCreate.SnapshotRoot)
    ) "Supervisor loss before atomic worker creation must leave no worker or fixture mutation (status=$(ConvertTo-Json -InputObject $beforeCreateStatus.Json -Depth 20 -Compress); receipt=$(Test-Path -LiteralPath ([string]$beforeWorkerCreate.Manifest.paths.fixturePreparationReceiptPath)); snapshot=$(Test-Path -LiteralPath $beforeWorkerCreate.SnapshotRoot))."

    $afterWorkerAssignment = New-TestContext `
        -Name 'supervisor-loss-after-atomic-assignment-before-resume' `
        -TestControls @{
            harmlessDelaySeconds=1
            supervisorAfterWorkerAssignmentBeforeResumeDelayMilliseconds=30000
        }
    $contexts.Add($afterWorkerAssignment)
    [void](Invoke-Supervisor -Context $afterWorkerAssignment -Mode Start)
    $afterAssignmentOwnershipPath = Join-Path $afterWorkerAssignment.RunRoot `
        'worker-ownership.private.json'
    Wait-TestPath -Path $afterAssignmentOwnershipPath
    $afterAssignmentOwnership = Get-Content -LiteralPath $afterAssignmentOwnershipPath -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    $suspendedWorkerIdentity = $afterAssignmentOwnership.worker
    Assert-Condition (
        (Test-ExactSuspendedProcessPresent $suspendedWorkerIdentity) -and
        (Get-Item -LiteralPath ([string]$afterWorkerAssignment.Manifest.paths.journalPath)).Length -eq 0 -and
        (Get-Item -LiteralPath (Join-Path $afterWorkerAssignment.RunRoot `
            'fixture-worker.stdout.log')).Length -eq 0 -and
        (Get-Item -LiteralPath (Join-Path $afterWorkerAssignment.RunRoot `
            'fixture-worker.stderr.log')).Length -eq 0
    ) "The atomically Job-bound worker must remain suspended and mutation-free until ResumeThread (present=$(Test-ExactSuspendedProcessPresent $suspendedWorkerIdentity); journal=$((Get-Item -LiteralPath ([string]$afterWorkerAssignment.Manifest.paths.journalPath)).Length); stdout=$((Get-Item -LiteralPath (Join-Path $afterWorkerAssignment.RunRoot 'fixture-worker.stdout.log')).Length); stderr=$((Get-Item -LiteralPath (Join-Path $afterWorkerAssignment.RunRoot 'fixture-worker.stderr.log')).Length))."
    [void](Stop-TicketBoundSupervisor $afterWorkerAssignment)
    $assignmentExitWatch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 50
        $suspendedWorkerPresent = Test-ExactSuspendedProcessPresent $suspendedWorkerIdentity
    } while ($suspendedWorkerPresent -and $assignmentExitWatch.Elapsed.TotalSeconds -lt 10)
    $afterAssignmentStatus = Invoke-Supervisor -Context $afterWorkerAssignment -Mode Status -AllowFailure
    Assert-Condition (
        -not $suspendedWorkerPresent -and
        $afterAssignmentStatus.ExitCode -eq 0 -and
        $afterAssignmentStatus.Json.healthy -eq $false -and
        [string]$afterAssignmentStatus.Json.finding -ceq
            'supervisor_process_lost_without_terminal_state' -and
        $afterAssignmentStatus.Json.workerProcessPresent -eq $false -and
        (Get-Item -LiteralPath ([string]$afterWorkerAssignment.Manifest.paths.journalPath)).Length -eq 0 -and
        -not (Test-Path -LiteralPath ([string]$afterWorkerAssignment.Manifest.paths.fixturePreparationReceiptPath)) -and
        -not (Test-Path -LiteralPath $afterWorkerAssignment.SnapshotRoot)
    ) 'Closing the supervisor Job handle before ResumeThread must remove the exact suspended worker without mutation.'

    $statusPolling = New-TestContext -Name 'concurrent-status-polling' -TestControls @{
        harmlessDelaySeconds=5;journalAppendSplitDelayMilliseconds=150
    }
    $contexts.Add($statusPolling)
    [void](Invoke-Supervisor -Context $statusPolling -Mode Start)
    $sawActiveStatus = $false
    $statusPollWatch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $polled = Invoke-Supervisor -Context $statusPolling -Mode Status -AllowFailure
        Assert-Condition ($polled.ExitCode -eq 0 -and $polled.Json.healthy -eq $true) `
            "High-frequency Status polling must tolerate only the live writer's uncommitted trailing record (exit=$($polled.ExitCode); json=$(ConvertTo-Json -InputObject $polled.Json -Depth 20 -Compress))."
        if ([string]$polled.Json.status -in @('launching','running','worker_exited')) { $sawActiveStatus = $true }
        if ([string]$polled.Json.status -in @('completed','failed','timed_out','interrupted')) { break }
        Start-Sleep -Milliseconds 25
    } while ($statusPollWatch.Elapsed.TotalSeconds -lt 20)
    Assert-Condition $sawActiveStatus 'Concurrent Status polling must observe an active detached supervisor.'
    $statusPollingTerminal = Wait-SupervisorTerminal $statusPolling
    Assert-Condition ($statusPollingTerminal.status -ceq 'completed') `
        'Concurrent Status polling must not perturb the preparation outcome.'

    $orphanedWorker = New-TestContext -Name 'supervisor-loss-terminates-owned-tree' `
        -TestControls @{harmlessDelaySeconds=30}
    $contexts.Add($orphanedWorker)
    [void](Invoke-Supervisor -Context $orphanedWorker -Mode Start)
    $orphanWorkerIdentity = Wait-SupervisorWorkerIdentity $orphanedWorker
    [void](Wait-PreparationJournalStage $orphanedWorker 'harmless_delay_started')
    $delayStarted = @((Read-TestJournal $orphanedWorker) | Where-Object {
        [string]$_.stage -ceq 'harmless_delay_started'
    })
    Assert-Condition ($delayStarted.Count -eq 1) `
        'Supervisor-loss regression requires the exact owned harmless-delay child identity.'
    $delayIdentity = $delayStarted[0].process
    $orphanTicketPath = Join-Path $orphanedWorker.RunRoot 'supervisor-ticket.private.json'
    $orphanTicket = Get-Content -LiteralPath $orphanTicketPath -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    $orphanSupervisorProcess = Get-Process -Id ([int]$orphanTicket.supervisor.pid) -ErrorAction Stop
    $orphanSupervisorStartedAt = ([DateTimeOffset]$orphanSupervisorProcess.StartTime.ToUniversalTime()).ToString('o')
    Assert-Condition ($orphanSupervisorStartedAt -ceq
        ([DateTimeOffset]::Parse([string]$orphanTicket.supervisor.startedAtUtc).ToUniversalTime().ToString('o')) -and
        [string]::Equals(
            [string]$orphanSupervisorProcess.Path, [string]$orphanTicket.supervisor.path,
            [StringComparison]::OrdinalIgnoreCase
        )) 'The orphan regression must target only the ticket-bound supervisor creation identity.'
    try {
        Stop-Process -Id ([int]$orphanTicket.supervisor.pid) -Force -ErrorAction Stop
        $supervisorExitWatch = [Diagnostics.Stopwatch]::StartNew()
        do {
            Start-Sleep -Milliseconds 50
            $stillPresent = $false
            try {
                $candidate = Get-Process -Id ([int]$orphanTicket.supervisor.pid) -ErrorAction Stop
                $stillPresent = ([DateTimeOffset]$candidate.StartTime.ToUniversalTime()).ToString('o') -ceq
                    ([DateTimeOffset]::Parse([string]$orphanTicket.supervisor.startedAtUtc).ToUniversalTime().ToString('o'))
            }
            catch { }
        } while ($stillPresent -and $supervisorExitWatch.Elapsed.TotalSeconds -lt 10)
        $treeExitWatch = [Diagnostics.Stopwatch]::StartNew()
        do {
            Start-Sleep -Milliseconds 50
            $workerPresent = Test-ExactProcessPresent $orphanWorkerIdentity
            $delayPresent = Test-ExactProcessPresent $delayIdentity
        } while (($workerPresent -or $delayPresent) -and $treeExitWatch.Elapsed.TotalSeconds -lt 10)
        $orphanStatus = Invoke-Supervisor -Context $orphanedWorker -Mode Status -AllowFailure
        Assert-Condition ($orphanStatus.ExitCode -eq 0 -and $orphanStatus.Json.healthy -eq $false -and
            [string]$orphanStatus.Json.finding -ceq 'supervisor_process_lost_without_terminal_state' -and
            $orphanStatus.Json.supervisorProcessPresent -eq $false -and
            $orphanStatus.Json.workerProcessPresent -eq $false -and
            -not $workerPresent -and -not $delayPresent) `
            'Supervisor loss must close the Job Object, terminate the exact worker/child tree, and preserve a process-loss finding.'
    }
    finally {
        try {
            $workerProcess = Get-Process -Id ([int]$orphanWorkerIdentity.pid) -ErrorAction Stop
            $workerStartedAt = ([DateTimeOffset]$workerProcess.StartTime.ToUniversalTime()).ToString('o')
            if ($workerStartedAt -ceq
                ([DateTimeOffset]::Parse([string]$orphanWorkerIdentity.startedAtUtc).ToUniversalTime().ToString('o'))) {
                Stop-Process -Id ([int]$orphanWorkerIdentity.pid) -Force -ErrorAction Stop
            }
        }
        catch { }
    }

    $receiptLoss = New-TestContext -Name 'supervisor-loss-after-receipt-seal' `
        -TestControls @{afterFixtureReceiptSealDelaySeconds=15}
    $contexts.Add($receiptLoss)
    [void](Invoke-Supervisor -Context $receiptLoss -Mode Start)
    $receiptLossWorker = Wait-SupervisorWorkerIdentity $receiptLoss
    [void](Wait-PreparationJournalStage $receiptLoss 'fixture_receipt_sealed')
    $receiptLossTicket = Get-Content -LiteralPath `
        (Join-Path $receiptLoss.RunRoot 'supervisor-ticket.private.json') -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    $receiptLossSupervisor = Get-Process -Id ([int]$receiptLossTicket.supervisor.pid) -ErrorAction Stop
    $receiptLossSupervisorStartedAt = ([DateTimeOffset]$receiptLossSupervisor.StartTime.ToUniversalTime()).ToString('o')
    Assert-Condition ($receiptLossSupervisorStartedAt -ceq
        ([DateTimeOffset]::Parse([string]$receiptLossTicket.supervisor.startedAtUtc).ToUniversalTime().ToString('o'))) `
        'Receipt-seal loss regression must target the exact ticket-bound supervisor creation identity.'
    Stop-Process -Id ([int]$receiptLossTicket.supervisor.pid) -Force -ErrorAction Stop
    $receiptLossExitWatch = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 50
        $receiptLossSupervisorPresent = Test-ExactProcessPresent $receiptLossTicket.supervisor
        $receiptLossWorkerPresent = Test-ExactProcessPresent $receiptLossWorker
    } while (($receiptLossSupervisorPresent -or $receiptLossWorkerPresent) -and
        $receiptLossExitWatch.Elapsed.TotalSeconds -lt 10)
    $receiptLossStatus = Invoke-Supervisor -Context $receiptLoss -Mode Status -AllowFailure
    Assert-Condition ($receiptLossStatus.ExitCode -eq 0 -and
        [string]$receiptLossStatus.Json.finding -ceq 'supervisor_process_lost_without_terminal_state' -and
        $receiptLossStatus.Json.supervisorProcessPresent -eq $false -and
        -not $receiptLossSupervisorPresent -and -not $receiptLossWorkerPresent) `
        'A supervisor lost after receipt sealing must remain fail-closed with its owned worker tree absent.'
    $receiptLossResume = Invoke-Supervisor -Context $receiptLoss -Mode ResumePublication
    Assert-Condition ([string]$receiptLossResume.Json.status -ceq 'completed') `
        'The one filesystem-only recovery must reconcile a sealed-receipt supervisor loss.'
    $receiptLossTerminal = Invoke-Supervisor -Context $receiptLoss -Mode Status
    $receiptLossOriginalResult = Get-Content -LiteralPath `
        (Join-Path $receiptLoss.RunRoot 'supervisor-result.private.json') -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    Assert-Condition ($receiptLossTerminal.Json.status -ceq 'completed' -and
        $receiptLossTerminal.Json.healthy -eq $true -and
        [string]$receiptLossOriginalResult.status -ceq 'interrupted' -and
        [string]$receiptLossOriginalResult.failure.code -ceq
            'fixture_preparation_supervisor_process_lost' -and
        $receiptLossOriginalResult.worker.processLost -eq $true -and
        $null -eq $receiptLossOriginalResult.worker.exitCode -and
        $receiptLossOriginalResult.worker.exitPersistedBeforeResultParsing -eq $false -and
        (Get-ChildItem -LiteralPath $receiptLoss.SnapshotRoot -Force -File).Count -eq 5) `
        'Loss reconciliation must preserve unknown exit evidence, then publish the exact sealed snapshot once.'

    # Windows readers that omit FileShare.Delete used to make atomic mutable
    # state replacement fail nondeterministically.  Prove that a short reader
    # conflict is retried and that a conflict beyond the bounded retry window
    # fails closed while still persisting the owned worker's exit evidence.
    $stateRetry = New-TestContext -Name 'state-reader-retry' -TestControls @{
        harmlessDelaySeconds=2;supervisorBeforeRunningStateDelayMilliseconds=1000
    }
    $contexts.Add($stateRetry)
    [void](Invoke-Supervisor -Context $stateRetry -Mode Start)
    [void](Wait-SupervisorStateStatus $stateRetry 'launching')
    $stateRetryStream = [IO.FileStream]::new(
        [string]$stateRetry.Manifest.paths.supervisorStatePath,
        [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite
    )
    try { Start-Sleep -Milliseconds 1600 }
    finally { $stateRetryStream.Dispose() }
    $stateRetryTerminal = Wait-SupervisorTerminal $stateRetry
    Assert-Condition ($stateRetryTerminal.status -ceq 'completed' -and
        $stateRetryTerminal.healthy -eq $true) `
        'A transient state reader without delete sharing must be retried to a coherent completion.'

    $stateRetryExhausted = New-TestContext -Name 'state-reader-retry-exhausted' -TestControls @{
        harmlessDelaySeconds=8;supervisorForceRunningStateRetryExhaustion=$true
    }
    $contexts.Add($stateRetryExhausted)
    [void](Invoke-Supervisor -Context $stateRetryExhausted -Mode Start)
    $stateRetryExhaustedTerminal = Wait-SupervisorTerminal $stateRetryExhausted
    Assert-Condition ($stateRetryExhaustedTerminal.status -ceq 'failed' -and
        $stateRetryExhaustedTerminal.healthy -eq $true) `
        'A state reader beyond the bounded retry window must stop the worker and fail closed.'
    $stateRetryExhaustedState = Get-Content -LiteralPath `
        ([string]$stateRetryExhausted.Manifest.paths.supervisorStatePath) -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    Assert-Condition ($stateRetryExhaustedState.worker.exitPersistedBeforeResultParsing -eq $true -and
        [int]$stateRetryExhaustedState.worker.pid -gt 0) `
        'Bounded state-publication failure must retain exact owned-worker exit evidence.'

    $workerExitReconciliation = New-TestContext -Name 'worker-exit-terminal-reconciliation' `
        -TestControls @{
            harmlessDelaySeconds=1
            supervisorAfterWorkerExitedStateDelayMilliseconds=30000
        }
    $contexts.Add($workerExitReconciliation)
    [void](Invoke-Supervisor -Context $workerExitReconciliation -Mode Start)
    $workerExitedState = Wait-SupervisorStateStatus $workerExitReconciliation 'worker_exited'
    Assert-Condition (
        $workerExitedState.worker.exitPersistedBeforeResultParsing -eq $true -and
        [int]$workerExitedState.worker.exitCode -eq 0 -and
        -not (Test-Path -LiteralPath (Join-Path $workerExitReconciliation.RunRoot `
            'supervisor-result.private.json'))
    ) 'The worker-exit crash boundary must persist the exact successful exit before any result parsing.'
    [void](Stop-TicketBoundSupervisor $workerExitReconciliation)
    $workerExitStatus = Invoke-Supervisor -Context $workerExitReconciliation -Mode Status -AllowFailure
    Assert-Condition (
        $workerExitStatus.ExitCode -eq 0 -and
        [string]$workerExitStatus.Json.status -ceq 'worker_exited' -and
        [string]$workerExitStatus.Json.finding -ceq 'terminal_reconciliation_required' -and
        $workerExitStatus.Json.supervisorProcessPresent -eq $false -and
        $workerExitStatus.Json.workerProcessPresent -eq $false
    ) 'A supervisor crash after the persisted worker exit must require deterministic terminal reconciliation.'
    $workerExitReconciled = Invoke-Supervisor -Context $workerExitReconciliation -Mode ResumePublication
    Assert-Condition (
        $workerExitReconciled.ExitCode -eq 0 -and
        [string]$workerExitReconciled.Json.status -ceq 'completed' -and
        $workerExitReconciled.Json.terminalEvidenceCommitted -eq $true
    ) 'ResumePublication must reconstruct the exact completed result from the persisted worker exit and sealed evidence.'
    $workerExitResultPath = Join-Path $workerExitReconciliation.RunRoot `
        'supervisor-result.private.json'
    $workerExitStatePath = [string]$workerExitReconciliation.Manifest.paths.supervisorStatePath
    $workerExitResultSha = Get-Sha256 $workerExitResultPath
    $workerExitTerminalState = Get-Content -LiteralPath $workerExitStatePath -Raw |
        ConvertFrom-Json -DateKind String -Depth 80
    Assert-Condition (
        [string]$workerExitTerminalState.status -ceq 'completed' -and
        [string]$workerExitTerminalState.resultPath -ceq $workerExitResultPath -and
        [string]$workerExitTerminalState.resultSha256 -ceq $workerExitResultSha -and
        [string]$workerExitTerminalState.resultStatus -ceq 'completed'
    ) 'Terminal reconciliation must bind resultPath, resultSha256, and resultStatus in the adopted state.'
    $workerExitStateSha = Get-Sha256 $workerExitStatePath
    $workerExitStableStatusA = Invoke-Supervisor -Context $workerExitReconciliation -Mode Status
    $workerExitStableStatusB = Invoke-Supervisor -Context $workerExitReconciliation -Mode Status
    $workerExitSecondResume = Invoke-Supervisor -Context $workerExitReconciliation `
        -Mode ResumePublication -AllowFailure
    Assert-Condition (
        $workerExitStableStatusA.Json.healthy -eq $true -and
        $workerExitStableStatusB.Json.healthy -eq $true -and
        [string]$workerExitStableStatusA.Json.result.sha256 -ceq $workerExitResultSha -and
        [string]$workerExitStableStatusB.Json.result.sha256 -ceq $workerExitResultSha -and
        $workerExitSecondResume.ExitCode -ne 0 -and
        (Get-Sha256 $workerExitResultPath) -ceq $workerExitResultSha -and
        (Get-Sha256 $workerExitStatePath) -ceq $workerExitStateSha
    ) 'Reconciliation must be idempotent: repeat observation is stable and a second resume cannot mutate terminal evidence.'

    $resultCommitReconciliation = New-TestContext -Name 'result-commit-state-reconciliation' `
        -TestControls @{
            harmlessDelaySeconds=1
            supervisorAfterResultCommitDelayMilliseconds=30000
        }
    $contexts.Add($resultCommitReconciliation)
    [void](Invoke-Supervisor -Context $resultCommitReconciliation -Mode Start)
    [void](Wait-SupervisorStateStatus $resultCommitReconciliation 'worker_exited')
    $resultCommitPath = Join-Path $resultCommitReconciliation.RunRoot `
        'supervisor-result.private.json'
    Wait-TestPath -Path $resultCommitPath
    $committedResultSha = Get-Sha256 $resultCommitPath
    [void](Stop-TicketBoundSupervisor $resultCommitReconciliation)
    $resultCommitStatus = Invoke-Supervisor -Context $resultCommitReconciliation -Mode Status -AllowFailure
    Assert-Condition (
        $resultCommitStatus.ExitCode -eq 0 -and
        [string]$resultCommitStatus.Json.status -ceq 'worker_exited' -and
        [string]$resultCommitStatus.Json.finding -ceq
            'terminal_result_committed_state_reconciliation_required' -and
        [string]$resultCommitStatus.Json.result.sha256 -ceq $committedResultSha
    ) 'A supervisor crash after immutable result commit must report result-adoption reconciliation, not process loss.'
    $resultCommitReconciled = Invoke-Supervisor -Context $resultCommitReconciliation `
        -Mode ResumePublication
    $resultCommitStatePath = [string]$resultCommitReconciliation.Manifest.paths.supervisorStatePath
    $resultCommitState = Get-Content -LiteralPath $resultCommitStatePath -Raw |
        ConvertFrom-Json -DateKind String -Depth 80
    Assert-Condition (
        $resultCommitReconciled.ExitCode -eq 0 -and
        [string]$resultCommitReconciled.Json.status -ceq 'completed' -and
        (Get-Sha256 $resultCommitPath) -ceq $committedResultSha -and
        [string]$resultCommitState.resultSha256 -ceq $committedResultSha -and
        [string]$resultCommitState.resultStatus -ceq 'completed'
    ) 'ResumePublication must adopt the already committed result byte-for-byte and bind it in terminal state.'

    $failedResultCommitReconciliation = New-TestContext `
        -Name 'failed-result-commit-state-reconciliation' -TestControls @{
            faultStage='after_preflight'
            supervisorAfterResultCommitDelayMilliseconds=30000
        }
    $contexts.Add($failedResultCommitReconciliation)
    [void](Invoke-Supervisor -Context $failedResultCommitReconciliation -Mode Start)
    [void](Wait-SupervisorStateStatus $failedResultCommitReconciliation 'worker_exited')
    $failedResultPath = Join-Path $failedResultCommitReconciliation.RunRoot `
        'supervisor-result.private.json'
    Wait-TestPath -Path $failedResultPath
    $failedResultSha = Get-Sha256 $failedResultPath
    [void](Stop-TicketBoundSupervisor $failedResultCommitReconciliation)
    $failedResultStatus = Invoke-Supervisor -Context $failedResultCommitReconciliation `
        -Mode Status -AllowFailure
    Assert-Condition (
        $failedResultStatus.ExitCode -eq 0 -and
        [string]$failedResultStatus.Json.status -ceq 'worker_exited' -and
        [string]$failedResultStatus.Json.finding -ceq
            'terminal_result_committed_state_reconciliation_required' -and
        [string]$failedResultStatus.Json.result.sha256 -ceq $failedResultSha
    ) 'A committed failed result must be recognized before generic process-loss handling.'
    $failedResultResume = Invoke-Supervisor -Context $failedResultCommitReconciliation `
        -Mode ResumePublication -AllowFailure
    $failedResultState = Get-Content -LiteralPath `
        ([string]$failedResultCommitReconciliation.Manifest.paths.supervisorStatePath) -Raw |
        ConvertFrom-Json -DateKind String -Depth 80
    Assert-Condition (
        $failedResultResume.ExitCode -ne 0 -and
        [string]$failedResultState.status -ceq 'failed' -and
        [string]$failedResultState.resultPath -ceq $failedResultPath -and
        [string]$failedResultState.resultSha256 -ceq $failedResultSha -and
        [string]$failedResultState.resultStatus -ceq 'failed' -and
        -not (Test-Path -LiteralPath (Join-Path $failedResultCommitReconciliation.RunRoot `
            'publication-recovery-admission.private.json'))
    ) 'Terminal reconciliation must adopt an exact failed result before later recovery eligibility fails.'

    $successSupervisorBinding = @(Get-SupervisorBindingArguments -Context $success -Terminal $terminal)

    foreach ($fault in @('after_config_write','after_hash_write','after_receipt_write','before_rename')) {
        $bindArguments = @(
            '-ManifestPath',$success.ManifestPath,'-ExpectedManifestSha256',$success.ManifestSha256,
            '-FixturePreparationReceiptPath',[string]$success.Manifest.paths.fixturePreparationReceiptPath,
            '-ExpectedFixturePreparationReceiptSha256',(Get-Sha256 ([string]$success.Manifest.paths.fixturePreparationReceiptPath))
        ) + $successSupervisorBinding + @('-TestFaultStage',$fault)
        $bind = Invoke-JsonProcess -Script $binderPath -Arguments $bindArguments -AllowFailure
        Assert-Condition ($bind.ExitCode -ne 0 -and -not (Test-Path -LiteralPath $success.BindingRoot)) `
            "Binder fault $fault must not publish a partial output group."
        $bindingParent = [IO.Path]::GetDirectoryName($success.BindingRoot)
        $bindingStaging = @(Get-ChildItem -LiteralPath $bindingParent -Force -Directory |
            Where-Object { $_.Name -like '.binding.*.staging' })
        Assert-Condition ($bindingStaging.Count -eq 0) `
            "Binder fault $fault must clean its unpublished staging group."
    }
    $boundArguments = @(
        '-ManifestPath',$success.ManifestPath,'-ExpectedManifestSha256',$success.ManifestSha256,
        '-FixturePreparationReceiptPath',[string]$success.Manifest.paths.fixturePreparationReceiptPath,
        '-ExpectedFixturePreparationReceiptSha256',(Get-Sha256 ([string]$success.Manifest.paths.fixturePreparationReceiptPath))
    ) + $successSupervisorBinding
    $bound = Invoke-JsonProcess -Script $binderPath -Arguments $boundArguments
    Assert-Condition ($bound.Json.ok -eq $true -and $bound.Json.diagnosticEligible -eq $false -and
        (Get-ChildItem -LiteralPath $success.BindingRoot -Force -File).Count -eq 3) `
        'Offline fake preparation must bind as one three-file, permanently ineligible group.'
    $boundConfig = Get-Content -LiteralPath $bound.Json.configPath -Raw | ConvertFrom-Json -DateKind String -Depth 100
    Assert-Condition ($boundConfig.diagnosticEligible -eq $false -and $null -eq $boundConfig.databaseInsightsLease -and
        $null -eq $boundConfig.historyFallbackQueryIdentity) `
        'Offline binding must contain no lease or query-identity bypass usable for traffic.'
    $sanitizedEvidencePaths = @(
        Get-ChildItem -LiteralPath $success.RunRoot -Force -File |
            Where-Object { $_.Extension -in @('.json','.jsonl','.log','.lock') } |
            ForEach-Object { $_.FullName }
    ) + @(
        Get-ChildItem -LiteralPath $success.BindingRoot -Force -File |
            ForEach-Object { $_.FullName }
    )
    $forbiddenEvidencePattern = '(?i)(school-pilot\.net|offline-redacted|authorization\s*:\s*bearer|"(?:tenantId|schoolId|studentId|deviceId|teacherId|password)"\s*:|\b(?:tenantId|schoolId|studentId|deviceId|teacherId|password)\s*=)'
    foreach ($evidencePath in $sanitizedEvidencePaths) {
        $evidenceText = [string](Get-Content -LiteralPath $evidencePath -Raw)
        Assert-Condition ($evidenceText -notmatch $forbiddenEvidencePattern) `
            "Preparation control/binding evidence contains a forbidden secret or tenant identifier: $([IO.Path]::GetFileName($evidencePath))"
    }

    foreach ($topologyCase in @(
        'binding-under-run','evidence-under-run','binding-evidence-overlap',
        'run-under-source','snapshot-under-run','journal-under-source',
        'recovery-receipt-under-snapshot','state-under-source','lease-under-source',
        'start-gate-under-evidence'
    )) {
        $topology = New-TestContext -Name ("binder-topology-" + $topologyCase)
        $contexts.Add($topology)
        Rewrite-TestManifest -Context $topology -Mutation {
            param($manifest)
            if ($topologyCase -ceq 'binding-under-run') {
                $manifest.paths.bindingRoot = Join-Path `
                    ([string]$manifest.paths.runDirectoryRoot) 'nested-binding'
            }
            elseif ($topologyCase -ceq 'evidence-under-run') {
                $manifest.paths.evidenceDirectory = Join-Path `
                    ([string]$manifest.paths.runDirectoryRoot) 'nested-evidence'
            }
            elseif ($topologyCase -ceq 'binding-evidence-overlap') {
                $manifest.paths.evidenceDirectory = Join-Path `
                    ([string]$manifest.paths.bindingRoot) 'nested-evidence'
            }
            elseif ($topologyCase -ceq 'run-under-source') {
                $manifest.paths.runDirectoryRoot = Join-Path `
                    ([string]$manifest.fixture.sourceRoot) 'nested-run'
            }
            elseif ($topologyCase -ceq 'snapshot-under-run') {
                $manifest.paths.snapshotRoot = Join-Path `
                    ([string]$manifest.paths.runDirectoryRoot) ([string]$manifest.runId)
            }
            elseif ($topologyCase -ceq 'journal-under-source') {
                $manifest.paths.journalPath = Join-Path `
                    ([string]$manifest.fixture.sourceRoot) 'journal.private.jsonl'
            }
            elseif ($topologyCase -ceq 'recovery-receipt-under-snapshot') {
                $manifest.paths.publicationRecoveryReceiptPath = Join-Path `
                    ([string]$manifest.paths.snapshotRoot) 'recovery.private.json'
            }
            elseif ($topologyCase -ceq 'state-under-source') {
                $manifest.paths.supervisorStatePath = Join-Path `
                    ([string]$manifest.fixture.sourceRoot) 'state.private.json'
            }
            elseif ($topologyCase -ceq 'lease-under-source') {
                $manifest.paths.leaseReceiptPath = Join-Path `
                    ([string]$manifest.fixture.sourceRoot) 'lease.private.json'
            }
            else {
                $manifest.paths.startGatePath = Join-Path `
                    ([string]$manifest.paths.evidenceDirectory) 'start.private.json'
            }
        }
        $topologyStart = Invoke-Supervisor -Context $topology -Mode Start -AllowFailure
        Assert-Condition (
            $topologyStart.ExitCode -ne 0 -and
            -not (Test-Path -LiteralPath ([string]$topology.Manifest.paths.runDirectoryRoot)) -and
            -not (Test-Path -LiteralPath ([string]$topology.Manifest.fixture.sourceRoot)) -and
            -not (Test-Path -LiteralPath $topology.SnapshotRoot) -and
            -not (Test-Path -LiteralPath ([string]$topology.Manifest.paths.bindingRoot)) -and
            -not (Test-Path -LiteralPath ([string]$topology.Manifest.paths.evidenceDirectory))
        ) "Shallow supervisor preflight must reject malicious topology '$topologyCase' before any local mutation."
    }

    $binderRace = New-TestContext -Name 'concurrent-binder-publication'
    $contexts.Add($binderRace)
    [void](Invoke-Supervisor -Context $binderRace -Mode Start)
    $binderRaceTerminal = Wait-SupervisorTerminal $binderRace
    Assert-Condition ($binderRaceTerminal.status -ceq 'completed') `
        'Concurrent binder publication requires one successful prepared input.'
    $binderRaceArguments = @(
        '-ManifestPath',$binderRace.ManifestPath,'-ExpectedManifestSha256',$binderRace.ManifestSha256,
        '-FixturePreparationReceiptPath',[string]$binderRace.Manifest.paths.fixturePreparationReceiptPath,
        '-ExpectedFixturePreparationReceiptSha256',
            (Get-Sha256 ([string]$binderRace.Manifest.paths.fixturePreparationReceiptPath))
    ) + @(Get-SupervisorBindingArguments -Context $binderRace -Terminal $binderRaceTerminal)
    $binderInvocationA = Start-JsonProcessAsync -Script $binderPath -Arguments $binderRaceArguments
    $binderInvocationB = Start-JsonProcessAsync -Script $binderPath -Arguments $binderRaceArguments
    $binderRaceA = Complete-JsonProcessAsync $binderInvocationA
    $binderRaceB = Complete-JsonProcessAsync $binderInvocationB
    $binderRaceResults = @($binderRaceA,$binderRaceB)
    Assert-Condition (@($binderRaceResults | Where-Object ExitCode -eq 0).Count -eq 1 -and
        @($binderRaceResults | Where-Object ExitCode -ne 0).Count -eq 1) `
        'Two concurrent binders must produce exactly one atomic publication winner.'
    $binderRacePublished = @(Get-ChildItem -LiteralPath $binderRace.BindingRoot -Force)
    $binderRaceStaging = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($binderRace.BindingRoot)) `
        -Force -Directory | Where-Object { $_.Name -like '.binding.*.staging' })
    Assert-Condition ($binderRacePublished.Count -eq 3 -and
        @($binderRacePublished | Where-Object { -not $_.PSIsContainer }).Count -eq 3 -and
        $binderRaceStaging.Count -eq 0) `
        'Concurrent binders must leave one coherent three-file group and no staging residue.'

    foreach ($downstreamMarkerField in @('startGatePath','trafficMarkerPath')) {
        $blockedBinder = New-TestContext -Name ("binder-downstream-" + $downstreamMarkerField)
        $contexts.Add($blockedBinder)
        [void](Invoke-Supervisor -Context $blockedBinder -Mode Start)
        $blockedBinderTerminal = Wait-SupervisorTerminal $blockedBinder
        Assert-Condition ($blockedBinderTerminal.status -ceq 'completed') `
            "Binder downstream-marker test $downstreamMarkerField requires a complete preparation."
        Write-PrivateText ([string]$blockedBinder.Manifest.paths[$downstreamMarkerField]) `
            '{"trafficStarted":false}'
        $blockedBinderArguments = @(
            '-ManifestPath',$blockedBinder.ManifestPath,
            '-ExpectedManifestSha256',$blockedBinder.ManifestSha256,
            '-FixturePreparationReceiptPath',
                [string]$blockedBinder.Manifest.paths.fixturePreparationReceiptPath,
            '-ExpectedFixturePreparationReceiptSha256',
                (Get-Sha256 ([string]$blockedBinder.Manifest.paths.fixturePreparationReceiptPath))
        ) + @(Get-SupervisorBindingArguments -Context $blockedBinder `
            -Terminal $blockedBinderTerminal)
        $blockedBinderResult = Invoke-JsonProcess -Script $binderPath `
            -Arguments $blockedBinderArguments -AllowFailure
        $blockedBinderParent = [IO.Path]::GetDirectoryName($blockedBinder.BindingRoot)
        $blockedBinderStaging = @(Get-ChildItem -LiteralPath $blockedBinderParent `
            -Force -Directory | Where-Object { $_.Name -like '.binding.*.staging' })
        Assert-Condition (
            $blockedBinderResult.ExitCode -ne 0 -and
            -not (Test-Path -LiteralPath $blockedBinder.BindingRoot) -and
            $blockedBinderStaging.Count -eq 0
        ) "A pre-existing $downstreamMarkerField must block binder staging and final publication."
    }

    $boundaryFaults = @(
        @{ fault='refresh_nonzero'; expectedStage='refresh'; expectedPrior='refresh_completed' },
        @{ fault='verify_nonzero'; expectedStage='verify'; expectedPrior='verify_completed' },
        @{ fault='after_preflight'; expectedStage='preflight'; expectedPrior='preflight_accepted' },
        @{ fault='after_refresh_admitted'; expectedStage='refresh'; expectedPrior='refresh_admitted' },
        @{ fault='after_refresh_completed'; expectedStage='refresh'; expectedPrior='refresh_completed' },
        @{ fault='after_verify_admitted'; expectedStage='verify'; expectedPrior='verify_admitted' },
        @{ fault='after_verify_completed'; expectedStage='verify'; expectedPrior='verify_completed' },
        @{ fault='after_freshness_accepted'; expectedStage='freshness'; expectedPrior='freshness_accepted' },
        @{ fault='after_source_sealed'; expectedStage='source_seal'; expectedPrior='source_hashes_sealed' },
        @{ fault='after_fixture_receipt_sealed'; expectedStage='fixture_receipt'; expectedPrior='fixture_receipt_sealed' },
        @{ fault='after_publication_completed'; expectedStage='publication_complete'; expectedPrior='publication_completed' }
    )
    foreach ($case in $boundaryFaults) {
        $faultName = [string]$case.fault
        $faultContext = New-TestContext -Name ("boundary-" + $faultName.Replace('_','-')) `
            -TestControls @{faultStage=$faultName}
        $contexts.Add($faultContext)
        [void](Invoke-Supervisor -Context $faultContext -Mode Start)
        $faultTerminal = Wait-SupervisorTerminal $faultContext -Fast
        Assert-Condition ($faultTerminal.status -ceq 'failed' -and $faultTerminal.healthy -eq $true) `
            "Offline boundary fault $faultName must seal a coherent failed supervisor result."
        Assert-TerminalFailureStage -Context $faultContext `
            -ExpectedStage ([string]$case.expectedStage) -ExpectedPriorStage ([string]$case.expectedPrior)
        $faultState = Get-Content -LiteralPath ([string]$faultContext.Manifest.paths.supervisorStatePath) -Raw |
            ConvertFrom-Json -DateKind String -Depth 60
        Assert-Condition ($faultState.worker.exitPersistedBeforeResultParsing -eq $true -and
            [int]$faultState.worker.exitCode -ne 0) `
            "Offline boundary fault $faultName must persist its nonzero worker exit before parsing."
        $faultResultRaw = Get-Content -LiteralPath ([string]$faultTerminal.result.path) -Raw
        $faultResult = $faultResultRaw | ConvertFrom-Json -DateKind String -Depth 60
        Assert-Condition ($faultResult.terminalEvidenceCommitted -eq $true -and
            [string]$faultTerminal.lastKnownStage -ceq 'terminal_commit' -and
            [string]$faultResult.failure.stage -ceq 'fixture_preparation' -and
            $faultResult.failure.rawErrorPersisted -eq $false -and
            $faultResultRaw -cnotmatch 'offline-redacted|school-pilot\.net|studentId|deviceId|teacherId|password|bearer|triggered') `
            "Offline boundary fault $faultName must seal its exact failure/last-known stage and only sanitized evidence."
    }

    $interrupted = New-TestContext -Name 'owned-worker-interruption' -TestControls @{harmlessDelaySeconds=30}
    $contexts.Add($interrupted)
    [void](Invoke-Supervisor -Context $interrupted -Mode Start)
    $ownedWorker = Wait-SupervisorWorkerIdentity $interrupted
    $delayStartedRecord = Wait-PreparationJournalStage $interrupted 'harmless_delay_started'
    $delayChildIdentity = $delayStartedRecord.process
    $ownedProcess = Get-Process -Id ([int]$ownedWorker.pid) -ErrorAction Stop
    $ownedStartedAt = ([DateTimeOffset]$ownedProcess.StartTime.ToUniversalTime()).ToString('o')
    Assert-Condition ($ownedStartedAt -ceq ([DateTimeOffset]::Parse([string]$ownedWorker.startedAtUtc).ToUniversalTime().ToString('o'))) `
        'The interruption regression must kill only the exact PID and creation identity owned by the supervisor.'
    Stop-Process -Id ([int]$ownedWorker.pid) -Force -ErrorAction Stop
    $interruptedTerminal = Wait-SupervisorTerminal $interrupted
    Assert-Condition ($interruptedTerminal.status -ceq 'interrupted' -and
        [string]$interruptedTerminal.lastKnownStage -ceq 'harmless_delay_started') `
        'An externally terminated owned worker must preserve interruption and its exact last-known stage.'
    $interruptedState = Get-Content -LiteralPath ([string]$interrupted.Manifest.paths.supervisorStatePath) -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    Assert-Condition ($interruptedState.worker.exitPersistedBeforeResultParsing -eq $true -and
            [int]$interruptedState.worker.pid -eq [int]$ownedWorker.pid) `
        'Interrupted workers must retain their bound exit observation before result parsing.'
    Assert-Condition (-not (Test-ExactProcessPresent $delayChildIdentity)) `
        'The supervisor-owned kill-on-close job must not leave the journal-bound harmless child alive.'

    foreach ($boundaryStage in @(
        'preflight_accepted','refresh_admitted','refresh_completed','verify_admitted',
        'verify_completed','freshness_accepted','source_hashes_sealed',
        'publication_started','publication_completed','terminal_commit'
    )) {
        $boundaryContext = New-TestContext -Name ("external-stop-" +
            $boundaryStage.Replace('_','-')) -TestControls @{
                pauseAfterJournalStage=$boundaryStage
                pauseAfterJournalStageSeconds=30
            }
        $contexts.Add($boundaryContext)
        [void](Invoke-Supervisor -Context $boundaryContext -Mode Start)
        $boundaryWorker = Wait-SupervisorWorkerIdentity $boundaryContext
        $boundaryRecord = Wait-PreparationJournalStage $boundaryContext $boundaryStage
        Assert-Condition ([int]$boundaryRecord.process.pid -eq [int]$boundaryWorker.pid) `
            "Boundary $boundaryStage must be committed by the exact supervisor-owned worker."
        $boundaryProcess = Get-Process -Id ([int]$boundaryWorker.pid) -ErrorAction Stop
        try {
            Assert-Condition (
                ([DateTimeOffset]$boundaryProcess.StartTime).ToUniversalTime().ToString('o') -ceq
                    ([DateTimeOffset]::Parse([string]$boundaryWorker.startedAtUtc)).ToUniversalTime().ToString('o') -and
                [string]::Equals([string]$boundaryProcess.Path, [string]$boundaryWorker.path,
                    [StringComparison]::OrdinalIgnoreCase)
            ) "Boundary $boundaryStage termination must target the exact worker creation identity."
            Stop-Process -Id ([int]$boundaryWorker.pid) -Force -ErrorAction Stop
        }
        finally { $boundaryProcess.Dispose() }
        $boundaryTerminal = Wait-SupervisorTerminal $boundaryContext
        Assert-Condition (
            [string]$boundaryTerminal.status -in @('failed','interrupted') -and
            [string]$boundaryTerminal.lastKnownStage -ceq $boundaryStage -and
            -not (Test-ExactProcessPresent $boundaryWorker)
        ) "External termination after $boundaryStage must preserve that exact last-known stage."
    }

    $timeout = New-TestContext -Name 'timeout' -TestControls @{harmlessDelaySeconds=4}
    $contexts.Add($timeout)
    $timeoutStart = Invoke-Supervisor -Context $timeout -Mode Start -TimeoutSeconds 1
    Assert-Condition ($timeoutStart.Json.accepted -eq $true) 'The timeout rehearsal must start under a detached supervisor.'
    $timeoutTerminal = Wait-SupervisorTerminal $timeout
    Assert-Condition ($timeoutTerminal.status -ceq 'timed_out') 'Supervisor must seal a bounded worker timeout.'
    $timeoutState = Get-Content -LiteralPath ([string]$timeout.Manifest.paths.supervisorStatePath) -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    Assert-Condition ($timeoutState.worker.exitPersistedBeforeResultParsing -eq $true) `
        'Timed-out worker termination must still persist exit observation before parsing.'

    $terminalResultTamper = New-TestContext -Name 'terminal-result-sha-tamper' `
        -TestControls @{faultStage='publication_during_copy'}
    $contexts.Add($terminalResultTamper)
    [void](Invoke-Supervisor -Context $terminalResultTamper -Mode Start)
    $terminalResultTamperState = Wait-SupervisorTerminal $terminalResultTamper -Fast
    $terminalResultTamperPath = [string]$terminalResultTamperState.result.path
    [IO.File]::AppendAllText(
        $terminalResultTamperPath, ' ', [Text.UTF8Encoding]::new($false)
    )
    $terminalResultTamperResume = Invoke-Supervisor -Context $terminalResultTamper `
        -Mode ResumePublication -AllowFailure
    Assert-Condition (
        $terminalResultTamperResume.ExitCode -ne 0 -and
        -not (Test-Path -LiteralPath (Join-Path $terminalResultTamper.RunRoot `
            'publication-recovery-admission.private.json'))
    ) 'ResumePublication must reject terminal-result SHA drift before admitting recovery.'

    $publicationRecoveries = @(
        @{ fault='publication_during_copy'; expected='publication_recovered'; finalInitiallyPresent=$false },
        @{ fault='publication_before_rename'; expected='publication_recovered'; finalInitiallyPresent=$false },
        @{ fault='publication_after_rename_before_commit'; expected='publication_reconciled'; finalInitiallyPresent=$true }
    )
    $reconciledRecovery = $null
    foreach ($case in $publicationRecoveries) {
        $fault = [string]$case.fault
        $recovery = New-TestContext -Name ("recovery-" + $fault.Replace('_','-')) `
            -TestControls @{faultStage=$fault}
        $contexts.Add($recovery)
        [void](Invoke-Supervisor -Context $recovery -Mode Start)
        $failed = Wait-SupervisorTerminal $recovery -Fast
        Assert-Condition ($failed.status -ceq 'failed' -and
            (Test-Path -LiteralPath $recovery.SnapshotRoot) -eq [bool]$case.finalInitiallyPresent) `
            "Publication fault $fault must preserve its exact atomic filesystem boundary."
        Assert-TerminalFailureStage -Context $recovery -ExpectedStage 'publication' `
            -ExpectedPriorStage 'publication_started'
        $preRecoveryFinalRootWriteUtc = $null
        $preRecoveryFinalFiles = @()
        if ($case.finalInitiallyPresent) {
            $preRecoveryFinalRootWriteUtc = (Get-Item -LiteralPath $recovery.SnapshotRoot).LastWriteTimeUtc.Ticks
            $preRecoveryFinalFiles = @(Get-ChildItem -LiteralPath $recovery.SnapshotRoot -File |
                Sort-Object Name | ForEach-Object {
                    [pscustomobject]@{
                        name=$_.Name;length=[long]$_.Length;lastWriteTimeUtcTicks=$_.LastWriteTimeUtc.Ticks
                        sha256=Get-Sha256 $_.FullName
                    }
                })
        }
        $resumed = Invoke-Supervisor -Context $recovery -Mode ResumePublication
        Assert-Condition ($resumed.ExitCode -eq 0 -and $resumed.Json.status -ceq 'completed' -and
            $resumed.Json.recovery.status -ceq [string]$case.expected) `
            "Publication fault $fault must recover only through the expected hash-identical outcome."
        Assert-Condition ((Get-ChildItem -LiteralPath $recovery.SnapshotRoot -Force -File).Count -eq 5 -and
            -not (Test-Path -LiteralPath (Get-TestSnapshotStagingPath $recovery))) `
            "Publication recovery for $fault must leave one exact final root and no staging root."
        if ($case.finalInitiallyPresent) {
            $postRecoveryFinalFiles = @(Get-ChildItem -LiteralPath $recovery.SnapshotRoot -File |
                Sort-Object Name | ForEach-Object {
                    [pscustomobject]@{
                        name=$_.Name;length=[long]$_.Length;lastWriteTimeUtcTicks=$_.LastWriteTimeUtc.Ticks
                        sha256=Get-Sha256 $_.FullName
                    }
                })
            Assert-Condition (
                (Get-Item -LiteralPath $recovery.SnapshotRoot).LastWriteTimeUtc.Ticks -eq
                    $preRecoveryFinalRootWriteUtc -and
                ($preRecoveryFinalFiles | ConvertTo-Json -Compress -Depth 10) -ceq
                    ($postRecoveryFinalFiles | ConvertTo-Json -Compress -Depth 10)
            ) 'Hash-identical final-root reconciliation must not rewrite the directory or any snapshot file.'
        }
        $recoveryReceiptPath = [string]$recovery.Manifest.paths.publicationRecoveryReceiptPath
        $recoveryAdmissionPath = Join-Path $recovery.RunRoot 'publication-recovery-admission.private.json'
        $preparationReceiptPath = [string]$recovery.Manifest.paths.fixturePreparationReceiptPath
        $recoveryReceipt = Get-Content -LiteralPath $recoveryReceiptPath -Raw |
            ConvertFrom-Json -DateKind String -Depth 60
        $recoveryAdmission = Get-Content -LiteralPath $recoveryAdmissionPath -Raw |
            ConvertFrom-Json -DateKind String -Depth 60
        $preparationReceipt = Get-Content -LiteralPath $preparationReceiptPath -Raw |
            ConvertFrom-Json -DateKind String -Depth 100
        $sealedNonceSha256 = Get-TextSha256 ([string]$preparationReceipt.recovery.nonce)
        Assert-Condition (
            [string]$recoveryReceipt.recoveryNonceSha256 -ceq $sealedNonceSha256 -and
            [string]$recoveryReceipt.supervisorAdmissionNonceSha256 -ceq
                [string]$recoveryAdmission.recoveryNonceSha256 -and
            [string]$recoveryReceipt.recoveryNonceSha256 -cne
                [string]$recoveryReceipt.supervisorAdmissionNonceSha256 -and
            [string]$resumed.Json.publicationRecoveryReceipt.sha256 -ceq
                (Get-Sha256 $recoveryReceiptPath)
        ) 'Publication recovery must independently bind its sealed one-use nonce and supervisor launch nonce.'
        $recoveryJournal = @(Read-TestJournal $recovery)
        foreach ($stage in @('publication_recovery_started','publication_recovery_completed','terminal_commit')) {
            $stageRecords = @($recoveryJournal | Where-Object {
                [string]$_.stage -ceq $stage -and
                ($stage -cne 'terminal_commit' -or [string]$_.status -ceq 'completed')
            })
            Assert-Condition ($stageRecords.Count -eq 1 -and
                [string]$stageRecords[0].artifactHashes.publicationRecoveryReceiptSha256 -ceq
                    (Get-Sha256 $recoveryReceiptPath)) `
                "Publication recovery stage $stage must bind the immutable one-use receipt."
        }
        if ($case.finalInitiallyPresent) {
            $reconciledRecovery = $recovery
            $recoveryBindArguments = @(
                '-ManifestPath',$recovery.ManifestPath,'-ExpectedManifestSha256',$recovery.ManifestSha256,
                '-FixturePreparationReceiptPath',[string]$recovery.Manifest.paths.fixturePreparationReceiptPath,
                '-ExpectedFixturePreparationReceiptSha256',
                    (Get-Sha256 ([string]$recovery.Manifest.paths.fixturePreparationReceiptPath))
            ) + @(Get-SupervisorBindingArguments -Context $recovery -Terminal $resumed.Json)
            $recoveryBound = Invoke-JsonProcess -Script $binderPath -Arguments $recoveryBindArguments
            $recoveryBoundConfig = Get-Content -LiteralPath $recoveryBound.Json.configPath -Raw |
                ConvertFrom-Json -DateKind String -Depth 100
            Assert-Condition ($recoveryBound.Json.ok -eq $true -and
                $recoveryBoundConfig.fixturePreparation.supervisorResultKind -ceq 'recovery' -and
                -not [string]::IsNullOrWhiteSpace(
                    [string]$recoveryBoundConfig.fixturePreparation.publicationRecoveryAdmissionSha256
                ) -and -not [string]::IsNullOrWhiteSpace(
                    [string]$recoveryBoundConfig.fixturePreparation.publicationRecoveryReceiptSha256
                )) 'A reconciled publication must bind its recovery admission, one-use receipt, and original evidence.'
        }
    }
    [void](Assert-RecoveryRejected -Context $reconciledRecovery `
        -Message 'A second publication recovery must be rejected.')

    $recoveryResultCommit = New-TestContext -Name 'recovery-result-state-reconciliation' `
        -TestControls @{
            faultStage='publication_during_copy'
            supervisorAfterResultCommitDelayMilliseconds=30000
        }
    $contexts.Add($recoveryResultCommit)
    [void](Invoke-Supervisor -Context $recoveryResultCommit -Mode Start)
    $recoveryResultInitial = Wait-SupervisorTerminal $recoveryResultCommit -Fast
    Assert-Condition ($recoveryResultInitial.status -ceq 'failed') `
        'The recovery-result crash regression requires one eligible failed initial publication.'
    $recoveryResultInvocation = Start-JsonProcessAsync -Script $supervisorPath -Arguments @(
        '-Mode','ResumePublication',
        '-ManifestPath',$recoveryResultCommit.ManifestPath,
        '-ExpectedManifestSha256',$recoveryResultCommit.ManifestSha256
    )
    $recoveryResultInvocationCompleted = $false
    try {
        $committedRecoveryResultPath = Join-Path $recoveryResultCommit.RunRoot `
            'publication-recovery-result.private.json'
        Wait-TestPath -Path $committedRecoveryResultPath
        $committedRecoveryResultSha = Get-Sha256 $committedRecoveryResultPath
        $liveRecoveryCommitStatus = Invoke-Supervisor -Context $recoveryResultCommit `
            -Mode Status -AllowFailure
        Assert-Condition (
            $liveRecoveryCommitStatus.ExitCode -eq 0 -and
            [string]$liveRecoveryCommitStatus.Json.status -ceq 'recovery_committing' -and
            $liveRecoveryCommitStatus.Json.healthy -eq $true -and
            $liveRecoveryCommitStatus.Json.supervisorProcessPresent -eq $true -and
            $null -eq $liveRecoveryCommitStatus.Json.finding -and
            [string]$liveRecoveryCommitStatus.Json.result.path -ceq
                $committedRecoveryResultPath -and
            [string]$liveRecoveryCommitStatus.Json.result.sha256 -ceq
                $committedRecoveryResultSha
        ) 'Status must follow the live recovery supervisor through its result-to-state commit gap.'
        [void](Stop-ExactAsyncInvocation $recoveryResultInvocation)
        [void](Complete-JsonProcessAsync $recoveryResultInvocation)
        $recoveryResultInvocationCompleted = $true
        $recoveryResultStatus = Invoke-Supervisor -Context $recoveryResultCommit `
            -Mode Status -AllowFailure
        Assert-Condition (
            $recoveryResultStatus.ExitCode -eq 0 -and
            [string]$recoveryResultStatus.Json.finding -ceq
                'recovery_terminal_result_committed_state_reconciliation_required' -and
            [string]$recoveryResultStatus.Json.result.path -ceq $committedRecoveryResultPath -and
            [string]$recoveryResultStatus.Json.result.sha256 -ceq $committedRecoveryResultSha
        ) 'Status must recognize a committed recovery result awaiting final state adoption.'
        $recoveryResultAdopted = Invoke-Supervisor -Context $recoveryResultCommit `
            -Mode ResumePublication
        $recoveryResultFinalState = Get-Content -LiteralPath `
            ([string]$recoveryResultCommit.Manifest.paths.supervisorStatePath) -Raw |
            ConvertFrom-Json -DateKind String -Depth 100
        Assert-Condition (
            $recoveryResultAdopted.ExitCode -eq 0 -and
            [string]$recoveryResultAdopted.Json.status -ceq 'completed' -and
            (Get-Sha256 $committedRecoveryResultPath) -ceq $committedRecoveryResultSha -and
            [string]$recoveryResultFinalState.status -ceq 'completed' -and
            [string]$recoveryResultFinalState.resultPath -ceq $committedRecoveryResultPath -and
            [string]$recoveryResultFinalState.resultSha256 -ceq $committedRecoveryResultSha -and
            [string]$recoveryResultFinalState.resultStatus -ceq 'completed'
        ) 'ResumePublication must adopt a valid committed recovery result without a second worker execution.'
    }
    finally {
        if (-not $recoveryResultInvocationCompleted) {
            try { [void](Stop-ExactAsyncInvocation $recoveryResultInvocation) } catch { }
            try { [void](Complete-JsonProcessAsync $recoveryResultInvocation) } catch { }
        }
    }

    $recoveryAdmissionCrash = New-TestContext -Name 'recovery-admission-crash' `
        -TestControls @{
            faultStage='publication_during_copy'
            supervisorAfterRecoveryAdmissionDelayMilliseconds=30000
        }
    $contexts.Add($recoveryAdmissionCrash)
    [void](Invoke-Supervisor -Context $recoveryAdmissionCrash -Mode Start)
    $recoveryAdmissionOriginal = Wait-SupervisorTerminal $recoveryAdmissionCrash -Fast
    Assert-Condition ($recoveryAdmissionOriginal.status -ceq 'failed') `
        'The recovery-admission crash regression requires one eligible failed initial publication.'
    $recoveryAdmissionInvocation = Start-JsonProcessAsync -Script $supervisorPath -Arguments @(
        '-Mode','ResumePublication',
        '-ManifestPath',$recoveryAdmissionCrash.ManifestPath,
        '-ExpectedManifestSha256',$recoveryAdmissionCrash.ManifestSha256
    )
    $recoveryAdmissionInvocationCompleted = $false
    try {
        $recoveryAdmissionPath = Join-Path $recoveryAdmissionCrash.RunRoot `
            'publication-recovery-admission.private.json'
        $frozenStatePath = Join-Path $recoveryAdmissionCrash.RunRoot `
            'original-supervisor-state.private.json'
        $recoveryStdoutPath = Join-Path $recoveryAdmissionCrash.RunRoot `
            'publication-recovery.stdout.log'
        $recoveryResultPath = Join-Path $recoveryAdmissionCrash.RunRoot `
            'publication-recovery-result.private.json'
        Wait-TestPath -Path $recoveryAdmissionPath
        $recoveryAdmissionSha = Get-Sha256 $recoveryAdmissionPath
        Assert-Condition (
            -not (Test-Path -LiteralPath $frozenStatePath) -and
            -not (Test-Path -LiteralPath $recoveryStdoutPath) -and
            -not (Test-Path -LiteralPath $recoveryResultPath)
        ) 'The immutable recovery admission must be the first recovery artifact before frozen state, worker streams, or result.'
        $liveRecoveryStatus = Invoke-Supervisor -Context $recoveryAdmissionCrash `
            -Mode Status -AllowFailure
        Assert-Condition (
            $liveRecoveryStatus.ExitCode -eq 0 -and
            [string]$liveRecoveryStatus.Json.status -ceq 'recovery_admitted' -and
            $liveRecoveryStatus.Json.healthy -eq $true -and
            $liveRecoveryStatus.Json.supervisorProcessPresent -eq $true -and
            [string]$liveRecoveryStatus.Json.recoveryAdmission.path -ceq $recoveryAdmissionPath -and
            [string]$liveRecoveryStatus.Json.recoveryAdmission.sha256 -ceq $recoveryAdmissionSha -and
            $null -eq $liveRecoveryStatus.Json.finding
        ) 'Status must follow the exact admitted recovery supervisor during the admission-to-state gap.'
        [void](Stop-ExactAsyncInvocation $recoveryAdmissionInvocation)
        [void](Complete-JsonProcessAsync $recoveryAdmissionInvocation)
        $recoveryAdmissionInvocationCompleted = $true
        $recoveryCrashStatus = Invoke-Supervisor -Context $recoveryAdmissionCrash `
            -Mode Status -AllowFailure
        Assert-Condition (
            $recoveryCrashStatus.ExitCode -eq 0 -and
            [string]$recoveryCrashStatus.Json.finding -ceq 'recovery_admitted_incomplete' -and
            (Get-Sha256 $recoveryAdmissionPath) -ceq $recoveryAdmissionSha -and
            -not (Test-Path -LiteralPath $frozenStatePath) -and
            -not (Test-Path -LiteralPath $recoveryResultPath)
        ) 'A crash after immutable recovery admission must expose the consumed, incomplete recovery attempt without later artifacts.'
        $recoveryCrashSecondAttempt = Invoke-Supervisor -Context $recoveryAdmissionCrash `
            -Mode ResumePublication -AllowFailure
        Assert-Condition (
            $recoveryCrashSecondAttempt.ExitCode -ne 0 -and
            (Get-Sha256 $recoveryAdmissionPath) -ceq $recoveryAdmissionSha -and
            -not (Test-Path -LiteralPath $frozenStatePath) -and
            -not (Test-Path -LiteralPath $recoveryResultPath)
        ) 'Any recovery admission consumes the sole recovery attempt; a second recovery must fail without mutation.'
    }
    finally {
        if (-not $recoveryAdmissionInvocationCompleted) {
            try {
                if (-not $recoveryAdmissionInvocation.Process.HasExited) {
                    Stop-Process -Id $recoveryAdmissionInvocation.Process.Id -Force -ErrorAction Stop
                }
            }
            catch { }
            try { [void](Complete-JsonProcessAsync $recoveryAdmissionInvocation) } catch { }
        }
    }

    $recoverySuspended = New-TestContext `
        -Name 'recovery-loss-after-atomic-assignment-before-resume' `
        -TestControls @{
            faultStage='publication_during_copy'
            supervisorAfterRecoveryWorkerAssignmentBeforeResumeDelayMilliseconds=30000
        }
    $contexts.Add($recoverySuspended)
    [void](Invoke-Supervisor -Context $recoverySuspended -Mode Start)
    $recoverySuspendedInitial = Wait-SupervisorTerminal $recoverySuspended -Fast
    Assert-Condition ($recoverySuspendedInitial.status -ceq 'failed') `
        'The suspended recovery-worker regression requires one eligible failed initial publication.'
    $recoverySuspendedInvocation = Start-JsonProcessAsync -Script $supervisorPath -Arguments @(
        '-Mode','ResumePublication',
        '-ManifestPath',$recoverySuspended.ManifestPath,
        '-ExpectedManifestSha256',$recoverySuspended.ManifestSha256
    )
    $recoverySuspendedInvocationCompleted = $false
    try {
        $recoveryOwnershipPath = Join-Path $recoverySuspended.RunRoot `
            'publication-recovery-worker-ownership.private.json'
        Wait-TestPath -Path $recoveryOwnershipPath
        $recoveryOwnership = Get-Content -LiteralPath $recoveryOwnershipPath -Raw |
            ConvertFrom-Json -DateKind String -Depth 60
        $recoverySuspendedIdentity = $recoveryOwnership.worker
        $recoveryStagesBeforeResume = @((Read-TestJournal $recoverySuspended) | Where-Object {
            [string]$_.stage -in @('publication_recovery_started','publication_recovery_completed')
        })
        Assert-Condition (
            (Test-ExactSuspendedProcessPresent $recoverySuspendedIdentity) -and
            $recoveryStagesBeforeResume.Count -eq 0 -and
            (Get-Item -LiteralPath (Join-Path $recoverySuspended.RunRoot `
                'publication-recovery.stdout.log')).Length -eq 0 -and
            (Get-Item -LiteralPath (Join-Path $recoverySuspended.RunRoot `
                'publication-recovery.stderr.log')).Length -eq 0
        ) 'The recovery worker must remain suspended and filesystem-inert after atomic Job assignment.'
        [void](Stop-ExactAsyncInvocation $recoverySuspendedInvocation)
        [void](Complete-JsonProcessAsync $recoverySuspendedInvocation)
        $recoverySuspendedInvocationCompleted = $true
        $recoveryWorkerExitWatch = [Diagnostics.Stopwatch]::StartNew()
        do {
            Start-Sleep -Milliseconds 50
            $recoverySuspendedPresent = Test-ExactSuspendedProcessPresent $recoverySuspendedIdentity
        } while ($recoverySuspendedPresent -and $recoveryWorkerExitWatch.Elapsed.TotalSeconds -lt 10)
        $recoverySuspendedStatus = Invoke-Supervisor -Context $recoverySuspended `
            -Mode Status -AllowFailure
        Assert-Condition (
            -not $recoverySuspendedPresent -and
            $recoverySuspendedStatus.ExitCode -eq 0 -and
            [string]$recoverySuspendedStatus.Json.finding -ceq 'recovery_admitted_incomplete' -and
            $recoverySuspendedStatus.Json.workerProcessPresent -eq $false -and
            -not (Test-Path -LiteralPath (Join-Path $recoverySuspended.RunRoot `
                'publication-recovery-result.private.json'))
        ) 'Recovery-supervisor loss before ResumeThread must kill the exact suspended worker and consume the one attempt.'
        [void](Assert-RecoveryRejected -Context $recoverySuspended `
            -Message 'A pre-resume recovery-supervisor loss must permanently consume the one recovery attempt.')
    }
    finally {
        if (-not $recoverySuspendedInvocationCompleted) {
            try { [void](Stop-ExactAsyncInvocation $recoverySuspendedInvocation) } catch { }
            try { [void](Complete-JsonProcessAsync $recoverySuspendedInvocation) } catch { }
        }
    }

    foreach ($tamperKind in @(
        'original-result','original-state','recovery-supervisor','recovery-admission','recovery-receipt'
    )) {
        $tamperedRecovery = New-TestContext -Name ("recovery-tamper-" + $tamperKind) `
            -TestControls @{faultStage='publication_after_rename_before_commit'}
        $contexts.Add($tamperedRecovery)
        [void](Invoke-Supervisor -Context $tamperedRecovery -Mode Start)
        [void](Wait-SupervisorTerminal $tamperedRecovery -Fast)
        $tamperedResult = Invoke-Supervisor -Context $tamperedRecovery -Mode ResumePublication
        $recoveryResultPath = Join-Path $tamperedRecovery.RunRoot 'publication-recovery-result.private.json'
        $recoveryAdmissionPath = Join-Path $tamperedRecovery.RunRoot 'publication-recovery-admission.private.json'
        if ($tamperKind -ceq 'original-result') {
            [IO.File]::AppendAllText(
                (Join-Path $tamperedRecovery.RunRoot 'supervisor-result.private.json'),
                ' ', [Text.UTF8Encoding]::new($false)
            )
        }
        elseif ($tamperKind -ceq 'original-state') {
            [IO.File]::AppendAllText(
                (Join-Path $tamperedRecovery.RunRoot 'original-supervisor-state.private.json'),
                ' ', [Text.UTF8Encoding]::new($false)
            )
        }
        elseif ($tamperKind -ceq 'recovery-supervisor') {
            $recoveryResult = Get-Content -LiteralPath $recoveryResultPath -Raw |
                ConvertFrom-Json -DateKind String -AsHashtable -Depth 100
            $recoveryResult.supervisor.pid = [int]$recoveryResult.supervisor.pid + 1
            Write-PrivateJson $recoveryResultPath $recoveryResult
        }
        elseif ($tamperKind -ceq 'recovery-receipt') {
            [IO.File]::AppendAllText(
                ([string]$tamperedRecovery.Manifest.paths.publicationRecoveryReceiptPath),
                ' ', [Text.UTF8Encoding]::new($false)
            )
        }
        else {
            $recoveryAdmission = Get-Content -LiteralPath $recoveryAdmissionPath -Raw |
                ConvertFrom-Json -DateKind String -AsHashtable -Depth 100
            $recoveryAdmission.originalExecution.resultSha256 = '0' * 64
            Write-PrivateJson $recoveryAdmissionPath $recoveryAdmission
            $recoveryResult = Get-Content -LiteralPath $recoveryResultPath -Raw |
                ConvertFrom-Json -DateKind String -AsHashtable -Depth 100
            $recoveryResult.recoveryAdmission.sha256 = Get-Sha256 $recoveryAdmissionPath
            Write-PrivateJson $recoveryResultPath $recoveryResult
        }
        $tamperedBindArguments = @(
            '-ManifestPath',$tamperedRecovery.ManifestPath,
            '-ExpectedManifestSha256',$tamperedRecovery.ManifestSha256,
            '-FixturePreparationReceiptPath',[string]$tamperedRecovery.Manifest.paths.fixturePreparationReceiptPath,
            '-ExpectedFixturePreparationReceiptSha256',
                (Get-Sha256 ([string]$tamperedRecovery.Manifest.paths.fixturePreparationReceiptPath))
        ) + @(Get-SupervisorBindingArguments -Context $tamperedRecovery -Terminal $tamperedResult.Json)
        $tamperedBind = Invoke-JsonProcess -Script $binderPath -Arguments $tamperedBindArguments -AllowFailure
        Assert-Condition ($tamperedBind.ExitCode -ne 0 -and
            -not (Test-Path -LiteralPath $tamperedRecovery.BindingRoot)) `
            "Binder must reject $tamperKind drift in recovered publication evidence."
    }

    $missingRecoveryNewline = New-TestContext -Name 'recovery-missing-journal-newline' `
        -TestControls @{faultStage='publication_during_copy'}
    $contexts.Add($missingRecoveryNewline)
    [void](Invoke-Supervisor -Context $missingRecoveryNewline -Mode Start)
    [void](Wait-SupervisorTerminal $missingRecoveryNewline -Fast)
    $missingRecoveryJournalPath = [string]$missingRecoveryNewline.Manifest.paths.journalPath
    $missingRecoveryJournalRaw = Get-Content -LiteralPath $missingRecoveryJournalPath -Raw
    [IO.File]::WriteAllText(
        $missingRecoveryJournalPath,
        $missingRecoveryJournalRaw.TrimEnd("`r","`n"),
        [Text.UTF8Encoding]::new($false)
    )
    $missingRecoveryNewlineResult = Invoke-Supervisor -Context $missingRecoveryNewline `
        -Mode ResumePublication -AllowFailure
    Assert-Condition ($missingRecoveryNewlineResult.ExitCode -ne 0) `
        'Publication recovery must reject an otherwise complete journal whose terminal newline is absent.'

    $sourceDrift = New-TestContext -Name 'recovery-source-drift' `
        -TestControls @{faultStage='publication_during_copy'}
    $contexts.Add($sourceDrift)
    [void](Invoke-Supervisor -Context $sourceDrift -Mode Start)
    [void](Wait-SupervisorTerminal $sourceDrift -Fast)
    $driftPath = Join-Path ([string]$sourceDrift.Manifest.fixture.sourceRoot) 'load-command-bodies.private.json'
    [IO.File]::AppendAllText($driftPath, ' ', [Text.UTF8Encoding]::new($false))
    [void](Assert-RecoveryRejected -Context $sourceDrift `
        -Message 'Publication recovery must reject byte-level source drift after sealing.')
    Assert-Condition (-not (Test-Path -LiteralPath $sourceDrift.SnapshotRoot)) `
        'Source-drift rejection must not publish a final snapshot.'

    $staleVerification = New-TestContext -Name 'recovery-stale-verification' -TestControls @{
        faultStage='publication_before_rename'
        offlineFakeCredentialValidityMarginSeconds=7200
        offlineRecoveryClockAdvanceSeconds=3601
    }
    $contexts.Add($staleVerification)
    [void](Invoke-Supervisor -Context $staleVerification -Mode Start)
    [void](Wait-SupervisorTerminal $staleVerification -Fast)
    [void](Assert-RecoveryRejected -Context $staleVerification `
        -Message 'Publication recovery must reject a verification older than the exact 60-minute limit.')
    Assert-Condition (-not (Test-Path -LiteralPath $staleVerification.SnapshotRoot)) `
        'Stale-verification rejection must not publish a final snapshot.'

    $staleCredentials = New-TestContext -Name 'recovery-stale-credentials' -TestControls @{
        faultStage='publication_before_rename'
        offlineFakeCredentialValidityMarginSeconds=30
        offlineRecoveryClockAdvanceSeconds=60
    }
    $contexts.Add($staleCredentials)
    [void](Invoke-Supervisor -Context $staleCredentials -Mode Start)
    [void](Wait-SupervisorTerminal $staleCredentials -Fast)
    [void](Assert-RecoveryRejected -Context $staleCredentials `
        -Message 'Publication recovery must reject credentials lacking the required remaining lifetime.')
    Assert-Condition (-not (Test-Path -LiteralPath $staleCredentials.SnapshotRoot)) `
        'Stale-credential rejection must not publish a final snapshot.'

    $wrongReceiptDonor = New-TestContext -Name 'recovery-wrong-receipt-donor' `
        -TestControls @{faultStage='publication_before_rename'}
    $wrongReceiptTarget = New-TestContext -Name 'recovery-wrong-receipt-target' `
        -TestControls @{faultStage='publication_before_rename'}
    $contexts.Add($wrongReceiptDonor)
    $contexts.Add($wrongReceiptTarget)
    [void](Invoke-Supervisor -Context $wrongReceiptDonor -Mode Start)
    [void](Wait-SupervisorTerminal $wrongReceiptDonor -Fast)
    [void](Invoke-Supervisor -Context $wrongReceiptTarget -Mode Start)
    [void](Wait-SupervisorTerminal $wrongReceiptTarget -Fast)
    [IO.File]::Copy(
        [string]$wrongReceiptDonor.Manifest.paths.fixturePreparationReceiptPath,
        [string]$wrongReceiptTarget.Manifest.paths.fixturePreparationReceiptPath,
        $true
    )
    Set-ExactPrivateAcl ([string]$wrongReceiptTarget.Manifest.paths.fixturePreparationReceiptPath)
    [void](Assert-RecoveryRejected -Context $wrongReceiptTarget `
        -Message 'Publication recovery must reject a receipt bound to another immutable run and manifest.')
    Assert-Condition (-not (Test-Path -LiteralPath $wrongReceiptTarget.SnapshotRoot)) `
        'Wrong-run receipt rejection must not publish a final snapshot.'

    $missingSource = New-TestContext -Name 'recovery-missing-source' `
        -TestControls @{faultStage='publication_before_rename'}
    $contexts.Add($missingSource)
    [void](Invoke-Supervisor -Context $missingSource -Mode Start)
    [void](Wait-SupervisorTerminal $missingSource -Fast)
    $missingSourcePath = Join-Path ([string]$missingSource.Manifest.fixture.sourceRoot) $script:RequiredFixtureFiles[1]
    Remove-Item -LiteralPath $missingSourcePath -Force
    [void](Assert-RecoveryRejected -Context $missingSource `
        -Message 'Publication recovery must reject a missing receipt-bound source file.')
    Assert-Condition (-not (Test-Path -LiteralPath $missingSource.SnapshotRoot)) `
        'Missing-source rejection must not publish a final snapshot.'

    $extraSource = New-TestContext -Name 'recovery-extra-source' `
        -TestControls @{faultStage='publication_before_rename'}
    $contexts.Add($extraSource)
    [void](Invoke-Supervisor -Context $extraSource -Mode Start)
    [void](Wait-SupervisorTerminal $extraSource -Fast)
    Write-PrivateText (Join-Path ([string]$extraSource.Manifest.fixture.sourceRoot) 'unexpected.private.json') '{}'
    [void](Assert-RecoveryRejected -Context $extraSource `
        -Message 'Publication recovery must reject extra files beside the five sealed sources.')
    Assert-Condition (-not (Test-Path -LiteralPath $extraSource.SnapshotRoot)) `
        'Extra-source rejection must not publish a final snapshot.'

    $partialFinal = New-TestContext -Name 'recovery-partial-final' `
        -TestControls @{faultStage='publication_before_rename'}
    $contexts.Add($partialFinal)
    [void](Invoke-Supervisor -Context $partialFinal -Mode Start)
    [void](Wait-SupervisorTerminal $partialFinal -Fast)
    $partialStaging = Get-TestSnapshotStagingPath $partialFinal
    Remove-Item -LiteralPath $partialStaging -Recurse -Force
    [void](New-PrivateDirectory $partialFinal.SnapshotRoot)
    $partialName = $script:RequiredFixtureFiles[0]
    $partialSource = Join-Path ([string]$partialFinal.Manifest.fixture.sourceRoot) $partialName
    $partialDestination = Join-Path $partialFinal.SnapshotRoot $partialName
    [IO.File]::Copy($partialSource, $partialDestination, $false)
    Set-ExactPrivateAcl $partialDestination
    $partialHash = Get-Sha256 $partialDestination
    [void](Assert-RecoveryRejected -Context $partialFinal `
        -Message 'Publication recovery must reject and preserve a partial immutable final root.')
    Assert-Condition (@(Get-ChildItem -LiteralPath $partialFinal.SnapshotRoot -Force).Count -eq 1 -and
        (Get-Sha256 $partialDestination) -ceq $partialHash) `
        'A partial final root must never be repaired, overwritten, or deleted.'

    $ambiguous = New-TestContext -Name 'recovery-ambiguous-staging' `
        -TestControls @{faultStage='publication_during_copy'}
    $contexts.Add($ambiguous)
    [void](Invoke-Supervisor -Context $ambiguous -Mode Start)
    [void](Wait-SupervisorTerminal $ambiguous -Fast)
    $snapshotParent = [IO.Path]::GetDirectoryName($ambiguous.SnapshotRoot)
    $ambiguousStaging = Join-Path $snapshotParent ('.' + $ambiguous.RunId + '.ambiguous.staging')
    [void](New-PrivateDirectory $ambiguousStaging)
    [void](Assert-RecoveryRejected -Context $ambiguous `
        -Message 'Publication recovery must reject ambiguous run-bound staging roots.')
    Assert-Condition ((Test-Path -LiteralPath $ambiguousStaging) -and
        (Test-Path -LiteralPath (Get-TestSnapshotStagingPath $ambiguous)) -and
        -not (Test-Path -LiteralPath $ambiguous.SnapshotRoot)) `
        'Ambiguous-staging rejection must not select, discard, or publish either root.'

    $reparseStaging = New-TestContext -Name 'recovery-reparse-staging' `
        -TestControls @{faultStage='publication_during_copy'}
    $contexts.Add($reparseStaging)
    [void](Invoke-Supervisor -Context $reparseStaging -Mode Start)
    [void](Wait-SupervisorTerminal $reparseStaging -Fast)
    $reparseStagingPath = Get-TestSnapshotStagingPath $reparseStaging
    Remove-Item -LiteralPath $reparseStagingPath -Recurse -Force
    $reparseTarget = New-PrivateDirectory (Join-Path $reparseStaging.Root 'do-not-remove-target')
    $reparseSentinel = Join-Path $reparseTarget 'sentinel.txt'
    Write-PrivateText $reparseSentinel 'must-survive'
    [void](New-Item -ItemType Junction -Path $reparseStagingPath -Target $reparseTarget)
    try {
        [void](Assert-RecoveryRejected -Context $reparseStaging `
            -Message 'Publication recovery must reject a junction substituted for its exact staging root.')
        Assert-Condition ((Test-Path -LiteralPath $reparseSentinel -PathType Leaf) -and
            [IO.File]::ReadAllText($reparseSentinel) -ceq 'must-survive' -and
            -not (Test-Path -LiteralPath $reparseStaging.SnapshotRoot)) `
            'Reparse-point rejection must not traverse, delete, or publish outside the staging root.'
    }
    finally {
        if (Test-Path -LiteralPath $reparseStagingPath) {
            [IO.Directory]::Delete($reparseStagingPath)
        }
    }

    foreach ($downstreamField in @(
        'leaseReceiptPath','bindingRoot','evidenceDirectory','startGatePath','trafficMarkerPath'
    )) {
        $downstream = New-TestContext -Name ("recovery-downstream-" + $downstreamField) `
            -TestControls @{faultStage='publication_before_rename'}
        $contexts.Add($downstream)
        [void](Invoke-Supervisor -Context $downstream -Mode Start)
        [void](Wait-SupervisorTerminal $downstream -Fast)
        $downstreamPath = [string]$downstream.Manifest.paths[$downstreamField]
        if ($downstreamField -in @('bindingRoot','evidenceDirectory')) {
            [void](New-PrivateDirectory $downstreamPath)
        }
        else { Write-PrivateText $downstreamPath '{"trafficStarted":false}' }
        [void](Assert-RecoveryRejected -Context $downstream `
            -Message "Downstream artifact $downstreamField must block recovery.")
        Assert-Condition (
            -not (Test-Path -LiteralPath ([string]$downstream.Manifest.paths.publicationRecoveryReceiptPath)) -and
            -not (Test-Path -LiteralPath (Join-Path $downstream.RunRoot `
                'publication-recovery-admission.private.json'))
        ) "Downstream artifact $downstreamField must reject before consuming the recovery admission or nonce."
    }

    $large = New-TestContext -Name 'large-output' -TestControls @{largeOutputBytes=1048576}
    $contexts.Add($large)
    [void](Invoke-Supervisor -Context $large -Mode Start)
    $largeTerminal = Wait-SupervisorTerminal $large
    Assert-Condition ($largeTerminal.status -ceq 'completed') `
        'One MiB of harmless redirected worker output must not deadlock the durable supervisor.'
    $largeState = Get-Content -LiteralPath ([string]$large.Manifest.paths.supervisorStatePath) -Raw |
        ConvertFrom-Json -DateKind String -Depth 60
    Assert-Condition ($largeState.worker.exitCode -eq 0 -and $largeState.worker.exitPersistedBeforeResultParsing -eq $true) `
        'Large-output completion must retain the owned worker exit evidence.'

    foreach ($journalCase in @('truncated','tampered','missing-final-newline')) {
        $journalContext = New-TestContext -Name ("journal-" + $journalCase)
        $contexts.Add($journalContext)
        [void](Invoke-Supervisor -Context $journalContext -Mode Start)
        [void](Wait-SupervisorTerminal $journalContext -Fast)
        $journalPath = [string]$journalContext.Manifest.paths.journalPath
        if ($journalCase -ceq 'truncated') {
            [IO.File]::AppendAllText($journalPath, '{"schemaVersion":1', [Text.UTF8Encoding]::new($false))
        }
        elseif ($journalCase -ceq 'missing-final-newline') {
            $raw = Get-Content -LiteralPath $journalPath -Raw
            [IO.File]::WriteAllText(
                $journalPath,
                $raw.TrimEnd("`r","`n"),
                [Text.UTF8Encoding]::new($false)
            )
        }
        else {
            $raw = Get-Content -LiteralPath $journalPath -Raw
            [IO.File]::WriteAllText(
                $journalPath,
                $raw.Replace('preflight_accepted','preflight_tampered'),
                [Text.UTF8Encoding]::new($false)
            )
        }
        $invalidStatus = Invoke-Supervisor -Context $journalContext -Mode Status -AllowFailure
        Assert-Condition ($invalidStatus.ExitCode -ne 0) `
            "A $journalCase preparation journal must fail closed during independent status validation."
    }

    $windowCases = @(
        @{
            name='cross-midnight'; earliest='2026-01-15T04:30:00.0000000+00:00'; latest='2026-01-15T05:30:00.0000000+00:00'
            earliestLocal='2026-01-14T23:30:00-05:00'; latestLocal='2026-01-15T00:30:00-05:00'
        },
        @{
            name='dst-fall-back'; earliest='2026-11-01T05:30:00.0000000+00:00'; latest='2026-11-01T06:30:00.0000000+00:00'
            earliestLocal='2026-11-01T01:30:00-04:00'; latestLocal='2026-11-01T01:30:00-05:00'
        },
        @{
            name='dst-spring-forward'; earliest='2026-03-08T06:30:00.0000000+00:00'; latest='2026-03-08T07:30:00.0000000+00:00'
            earliestLocal='2026-03-08T01:30:00-05:00'; latestLocal='2026-03-08T03:30:00-04:00'
        }
    )
    foreach ($case in $windowCases) {
        $windowContext = New-TestContext -Name ("window-" + [string]$case.name)
        $contexts.Add($windowContext)
        Rewrite-TestManifest -Context $windowContext -Mutation {
            param($manifest)
            $manifest.executionWindow.earliestUtc = [string]$case.earliest
            $manifest.executionWindow.latestUtc = [string]$case.latest
        }
        $windowValidation = Invoke-JsonProcess -Script $workerPath -Arguments @(
            '-Mode','Validate','-ManifestPath',$windowContext.ManifestPath,
            '-ExpectedManifestSha256',$windowContext.ManifestSha256
        )
        Assert-Condition ($windowValidation.Json.earliestRunLocal -ceq [string]$case.earliestLocal -and
            $windowValidation.Json.latestRunLocal -ceq [string]$case.latestLocal) `
            "Pinned TZif conversion must derive the exact $([string]$case.name) execution window."
    }

    foreach ($relativeWindow in @('before','after')) {
        $windowContext = New-TestContext -Name ("window-" + $relativeWindow)
        $contexts.Add($windowContext)
        $windowNow = [DateTimeOffset]::UtcNow
        Rewrite-TestManifest -Context $windowContext -Mutation {
            param($manifest)
            if ($relativeWindow -ceq 'before') {
                $manifest.executionWindow.earliestUtc = $windowNow.AddHours(1).ToString('o')
                $manifest.executionWindow.latestUtc = $windowNow.AddHours(2).ToString('o')
            }
            else {
                $manifest.executionWindow.earliestUtc = $windowNow.AddHours(-2).ToString('o')
                $manifest.executionWindow.latestUtc = $windowNow.AddHours(-1).ToString('o')
            }
        }
        $relativeWindowValidation = Invoke-JsonProcess -Script $workerPath -Arguments @(
            '-Mode','Validate','-ManifestPath',$windowContext.ManifestPath,
            '-ExpectedManifestSha256',$windowContext.ManifestSha256
        )
        [void](Invoke-Supervisor -Context $windowContext -Mode Start)
        $windowTerminal = Wait-SupervisorTerminal $windowContext -Fast
        $windowWorkerStderr = Get-Content -LiteralPath `
            (Join-Path $windowContext.RunRoot 'fixture-worker.stderr.log') -Raw
        Assert-Condition ($windowTerminal.status -ceq 'interrupted' -and
            -not (Test-Path -LiteralPath ([string]$windowContext.Manifest.fixture.sourceRoot)) -and
            -not (Test-Path -LiteralPath $windowContext.SnapshotRoot) -and
            $windowWorkerStderr.Contains("is $relativeWindow the pinned execution window") -and
            $windowWorkerStderr.Contains([string]$relativeWindowValidation.Json.earliestRunUtc) -and
            $windowWorkerStderr.Contains([string]$relativeWindowValidation.Json.latestRunUtc) -and
            $windowWorkerStderr.Contains([string]$relativeWindowValidation.Json.earliestRunLocal) -and
            $windowWorkerStderr.Contains([string]$relativeWindowValidation.Json.latestRunLocal)) `
            "A $relativeWindow-window run must preserve its exact pinned UTC/local diagnostic and fail before fixture mutation."
    }
}
finally {
    foreach ($context in $contexts) {
        if ($env:SCHOOLPILOT_KEEP_PREP_TEST_ARTIFACTS -ne '1' -and
            $null -ne $context -and (Test-Path -LiteralPath $context.Root)) {
            Remove-TestContextBestEffort $context
        }
    }
}

Write-Output "PASS: $script:AssertionCount Waf/800 diagnostic preparation lifecycle assertions."
