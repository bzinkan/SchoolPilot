#requires -Version 7.5

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    throw 'Fixture-preparation binding validation is Windows-only because it verifies exact private ACLs and named mutexes.'
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$binderPath = Join-Path $repositoryRoot 'scripts/load/bind-fresh-diagnostic.ps1'
$diagnosticControllerPath = Join-Path $repositoryRoot 'scripts/load/start-waf800-batch-diagnostic.ps1'
$certificationSupervisorPath = Join-Path $repositoryRoot 'scripts/load/start-aws-rollout-supervisor.ps1'
$script:AssertionCount = 0
$script:FixtureRoots = [Collections.Generic.List[string]]::new()
$script:RequiredFixtureNames = @(
    'fixture-state.private.json',
    'load-auth.private.json',
    'load-command-bodies.private.json',
    'load-devices.private.json',
    'verification.private.json'
)

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    $script:AssertionCount++
    if (-not $Condition) { throw $Message }
}

function Assert-Throws {
    param([scriptblock]$Operation, [string]$Pattern, [string]$Message)
    $script:AssertionCount++
    $caught = $null
    try { & $Operation }
    catch { $caught = $_ }
    if ($null -eq $caught) { throw $Message }
    if (-not [string]::IsNullOrWhiteSpace($Pattern) -and
        $caught.Exception.Message -notmatch $Pattern) {
        throw "$Message Unexpected error: $($caught.Exception.Message)"
    }
}

function Import-ScriptFunction {
    param(
        [Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Name
    )
    $definition = $Ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq $Name
    }, $true)
    Assert-Condition ($null -ne $definition) "Missing function '$Name' for binding-validator testing."
    $body = $definition.Body.Extent.Text.Trim()
    $body = $body.Substring(1, $body.Length - 2)
    Set-Item -Path "Function:script:$Name" -Value ([scriptblock]::Create($body))
}

function Set-ExactPrivateAcl {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    $isDirectory = [bool]$item.PSIsContainer
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item,
        [Security.AccessControl.AccessControlSections]::Access
    )
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($security.GetAccessRules(
        $true,
        $true,
        [Security.Principal.SecurityIdentifier]
    ))) {
        [void]$security.RemoveAccessRuleSpecific($existing)
    }
    $inheritance = if ($isDirectory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
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
    param([string]$Path, [AllowEmptyString()][string]$Text)
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
    Set-ExactPrivateAcl $Path
}

function Write-PrivateJson {
    param([string]$Path, $Value)
    Write-PrivateText $Path ($Value | ConvertTo-Json -Depth 100)
}

function Get-TestTextSha256 {
    param([AllowEmptyString()][string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.UTF8Encoding]::new($false).GetBytes($Text)
    )).ToLowerInvariant()
}

function Get-TestFileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TestCanonicalSha256 {
    param($Value)
    return Get-TestTextSha256 (ConvertTo-Json -InputObject $Value -Depth 60 -Compress)
}

function Get-TestSnapshotArtifactSetSha256 {
    param($Artifacts)
    $json = @($Artifacts | Sort-Object { [string]$_.name }) |
        ConvertTo-Json -Depth 20 -Compress -AsArray
    return Get-TestTextSha256 $json
}

function Get-TestJournalRecordHash {
    param($Record)
    $canonical = [ordered]@{}
    foreach ($name in @(
        'schemaVersion', 'type', 'version', 'sequence', 'runId', 'manifestSha256',
        'timestampUtc', 'stage', 'status', 'process', 'exitCode', 'artifactHashes',
        'previousRecordHash', 'failureCode', 'failureStage'
    )) {
        $property = $Record.PSObject.Properties[$name]
        $canonical[$name] = if ($null -eq $property) { $null } else { $property.Value }
    }
    return Get-TestCanonicalSha256 $canonical
}

function Add-TestJournalRecord {
    param(
        [Collections.Generic.List[object]]$Records,
        [string]$RunId,
        [string]$ManifestSha256,
        [string]$Stage,
        [string]$Status,
        $ExitCode = $null,
        $ArtifactHashes = $null,
        $FailureCode = $null,
        $FailureStage = $null,
        $Process = $null
    )
    $previous = if ($Records.Count -eq 0) { $null } else { [string]$Records[-1].recordHash }
    $record = [ordered]@{
        schemaVersion = 1
        type = 'diagnostic_prep_journal_record'
        version = 'diagnostic-prep-journal-v1'
        sequence = $Records.Count + 1
        runId = $RunId
        manifestSha256 = $ManifestSha256
        timestampUtc = ([DateTimeOffset]::UtcNow.AddMilliseconds($Records.Count)).ToString('o')
        stage = $Stage
        status = $Status
        process = if ($null -eq $Process) {
            [ordered]@{
                kind = 'synthetic-local-test'
                pid = 2147483000
                startedAtUtc = '2000-01-01T00:00:00.0000000+00:00'
                path = (Get-Command pwsh -ErrorAction Stop).Source
            }
        } else {
            $Process
        }
        exitCode = $ExitCode
        artifactHashes = if ($null -eq $ArtifactHashes) { [ordered]@{} } else { $ArtifactHashes }
        previousRecordHash = $previous
        failureCode = $FailureCode
        failureStage = $FailureStage
    }
    $record.recordHash = Get-TestJournalRecordHash ([pscustomobject]$record)
    $Records.Add([pscustomobject]$record)
}

function New-TestVerification {
    return [ordered]@{
        schemaVersion = 1
        fixtureId = 'synthetic-binding-validator'
        verifiedAt = [DateTimeOffset]::UtcNow.ToString('o')
        passed = $true
        counts = [ordered]@{
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
            authorizationPlanCohorts = [ordered]@{
                coTeacherStudents = 40
                officeSupervisionStudents = 40
            }
            liveAuth = [ordered]@{
                commandAdministrators = 1
                teachers = 20
            }
        }
        gates = [ordered]@{
            autoEnrollDisabled = $true
            trackingDisabled = $true
            schedulesDisabled = $true
            exactSchoolTimezones = $true
            classRostersExactAndDisjoint = $true
            authorizationPlanCohortsExact = $true
            authorizationPlanOfficeStudentsOutsideTeacherRosters = $true
            allDeviceTokensLive = $true
            allStaffAuthArtifactsLive = $true
        }
    }
}

function Get-TestVerificationContractSha256 {
    param($Verification)
    $counts = [ordered]@{
        schools = [int]$Verification.counts.schools
        teachers = [int]$Verification.counts.teachers
        officeStaff = [int]$Verification.counts.officeStaff
        students = [int]$Verification.counts.students
        classes = [int]$Verification.counts.classes
        classRosterStudents = [int]$Verification.counts.classRosterStudents
        devices = [int]$Verification.counts.devices
        activeDeviceSessions = [int]$Verification.counts.activeDeviceSessions
        activeSessions = [int]$Verification.counts.activeSessions
        commandBodies = [int]$Verification.counts.commandBodies
        authorizationPlanCohorts = [ordered]@{
            coTeacherStudents = [int]$Verification.counts.authorizationPlanCohorts.coTeacherStudents
            officeSupervisionStudents = [int]$Verification.counts.authorizationPlanCohorts.officeSupervisionStudents
        }
        liveAuth = [ordered]@{
            commandAdministrators = [int]$Verification.counts.liveAuth.commandAdministrators
            teachers = [int]$Verification.counts.liveAuth.teachers
        }
    }
    $gates = [ordered]@{}
    foreach ($name in @(
        'autoEnrollDisabled', 'trackingDisabled', 'schedulesDisabled', 'exactSchoolTimezones',
        'classRostersExactAndDisjoint', 'authorizationPlanCohortsExact',
        'authorizationPlanOfficeStudentsOutsideTeacherRosters', 'allDeviceTokensLive',
        'allStaffAuthArtifactsLive'
    )) {
        $gates[$name] = [bool]$Verification.gates.$name
    }
    return Get-TestCanonicalSha256 ([ordered]@{ counts = $counts; gates = $gates })
}

function Get-ControllerArtifacts {
    param([switch]$MissingDiagnosticBinder)
    $entries = @(
        @{ kind = 'prep-supervisor'; path = 'scripts/load/start-waf800-diagnostic-preparation.ps1' },
        @{ kind = 'fixture-worker'; path = 'scripts/load/refresh-and-snapshot-fixtures.ps1' },
        @{ kind = 'diagnostic-binder'; path = 'scripts/load/bind-fresh-diagnostic.ps1' },
        @{ kind = 'coordinator'; path = 'scripts/load/start-waf800-batch-diagnostic.ps1' },
        @{ kind = 'monitor'; path = 'scripts/load/aws-rollout-monitor.ps1' },
        @{ kind = 'harness'; path = 'scripts/load/classpilot-load-test.mjs' },
        @{ kind = 'monotonic-deadline'; path = 'scripts/load/monotonic-deadline.mjs' },
        @{ kind = 'tile-poll-accounting'; path = 'scripts/load/tile-poll-accounting.mjs' },
        @{ kind = 'database-insights-lease'; path = 'scripts/load/database-insights-lease.ps1' }
    )
    if ($MissingDiagnosticBinder) {
        $entries = @($entries | Where-Object { $_.kind -cne 'diagnostic-binder' })
    }
    return @($entries | ForEach-Object {
        $path = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $_.path))
        [ordered]@{ kind = [string]$_.kind; path = $path; sha256 = Get-TestFileSha256 $path }
    })
}

function New-SyntheticFixturePreparation {
    param(
        [ValidateSet('initial', 'recovery')]
        [string]$ResultKind,
        [ValidateSet(
            'None',
            'TicketWorkerDrift',
            'TicketSupervisorDrift',
            'TicketLaunchAdmissionDrift',
            'LaunchAdmissionRunDrift',
            'CertificationTicketExtraField',
            'CertificationLaunchAdmissionExtraField',
            'CertificationLaunchAdmissionControlDrift',
            'CertificationLaunchNonceDrift',
            'CertificationLaunchTimeoutDrift',
            'CertificationLaunchTimestampDrift',
            'CertificationJournalExtraField',
            'CertificationJournalBindingHashDrift',
            'CertificationJournalResultHashDrift',
            'MissingDiagnosticBinder',
            'RawErrorPersisted',
            'RecoveryAdmissionHashDrift',
            'RecoveryOriginalStateDrift',
            'RecoveryOriginalResultDrift',
            'RecoverySupervisorDrift'
        )]
        [string]$Tamper = 'None'
    )
    if ($Tamper.StartsWith('Recovery') -and $ResultKind -cne 'recovery') {
        throw "Tamper '$Tamper' requires a recovery fixture."
    }

    $root = Join-Path ([IO.Path]::GetTempPath()) (
        'schoolpilot-prep-binding-{0}-{1}-{2}' -f $ResultKind, $Tamper.ToLowerInvariant(),
        [Guid]::NewGuid().ToString('N')
    )
    [void](New-PrivateDirectory $root)
    $script:FixtureRoots.Add($root)
    $runRoot = New-PrivateDirectory (Join-Path $root 'run')
    $snapshotRoot = New-PrivateDirectory (Join-Path $root 'snapshot')
    $sourceRoot = New-PrivateDirectory (Join-Path $root 'source')
    $bindingRoot = New-PrivateDirectory (Join-Path $root 'binding')
    $runId = "synthetic-$ResultKind-$([Guid]::NewGuid().ToString('N'))".ToLowerInvariant()
    $manifestPath = Join-Path $root 'prep-manifest.private.json'
    $journalPath = Join-Path $runRoot 'diagnostic-prep-journal.private.jsonl'
    $receiptPath = Join-Path $runRoot 'fixture-preparation-receipt.private.json'
    $ticketPath = Join-Path $runRoot 'supervisor-ticket.private.json'
    $launchAdmissionPath = Join-Path $runRoot 'supervisor-launch-admission.private.json'
    $initialResultPath = Join-Path $runRoot 'supervisor-result.private.json'
    $recoveryResultPath = Join-Path $runRoot 'publication-recovery-result.private.json'
    $recoveryAdmissionPath = Join-Path $runRoot 'publication-recovery-admission.private.json'
    $recoveryReceiptPath = Join-Path $runRoot 'publication-recovery-receipt.private.json'
    $originalStatePath = Join-Path $runRoot 'original-supervisor-state.private.json'
    $runLockPath = Join-Path $runRoot 'supervisor-run-lock.private.json'
    $workerOwnershipPath = Join-Path $runRoot 'worker-ownership.private.json'
    $recoveryWorkerOwnershipPath = Join-Path $runRoot 'publication-recovery-worker-ownership.private.json'

    $release = [ordered]@{
        applicationGitSha = '1' * 40
        controllerGitSha = '2' * 40
        deployedImageDigest = 'sha256:' + ('3' * 64)
        apiTaskDefinitionArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:999'
        workerTaskDefinitionArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:999'
    }
    $fixtureCliPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'scripts/load/classpilot-load-test.mjs'))
    $fixtureCliSha256 = Get-TestFileSha256 $fixtureCliPath
    $fixtureConfigPath = Join-Path $root 'fixture-config.private.json'
    Write-PrivateJson $fixtureConfigPath ([ordered]@{ schemaVersion=1; runId=$runId })
    $fixtureConfigSha256 = Get-TestFileSha256 $fixtureConfigPath
    $controllers = @(Get-ControllerArtifacts -MissingDiagnosticBinder:($Tamper -ceq 'MissingDiagnosticBinder'))
    $manifest = [ordered]@{
        schemaVersion = 1
        type = 'waf800_diagnostic_prep_manifest'
        version = 'waf800-diagnostic-prep-manifest-v1'
        runId = $runId
        diagnosticOnly = $true
        diagnosticEligible = $true
        certificationEligible = $false
        repositoryRoot = $repositoryRoot
        release = $release
        controllerArtifacts = @($controllers)
        fixture = [ordered]@{
            provider = 'production'
            fixtureId = "fixture-$runId"
            sourceRoot = $sourceRoot
            fixtureCli = [ordered]@{
                path = $fixtureCliPath
                sha256 = $fixtureCliSha256
            }
            config = [ordered]@{
                path = $fixtureConfigPath
                sha256 = $fixtureConfigSha256
            }
            requiredPrivateFiles = @($script:RequiredFixtureNames)
        }
        paths = [ordered]@{
            runDirectoryRoot = $runRoot
            snapshotRoot = $snapshotRoot
            journalPath = $journalPath
            fixturePreparationReceiptPath = $receiptPath
            publicationRecoveryReceiptPath = $recoveryReceiptPath
            supervisorStatePath = Join-Path $runRoot 'supervisor-state.private.json'
            bindingRoot = $bindingRoot
            leaseReceiptPath = Join-Path $root 'downstream\lease.private.json'
            startGatePath = Join-Path $root 'downstream\start-gate.private.json'
            trafficMarkerPath = Join-Path $root 'downstream\traffic-marker.private.json'
        }
        oneAttemptPolicy = [ordered]@{
            refreshAttempts = 1
            verificationAttempts = 1
            initialPublicationAttempts = 1
            publicationRecoveryAttempts = 1
        }
    }
    Write-PrivateJson $manifestPath $manifest
    $manifestSha256 = Get-TestFileSha256 $manifestPath

    $controllersByKind = @{}
    foreach ($controller in $controllers) { $controllersByKind[[string]$controller.kind] = $controller }
    $ticketWorker = [ordered]@{
        path = [string]$controllersByKind['fixture-worker'].path
        sha256 = [string]$controllersByKind['fixture-worker'].sha256
    }
    $ticketSupervisorScript = [ordered]@{
        path = [string]$controllersByKind['prep-supervisor'].path
        sha256 = [string]$controllersByKind['prep-supervisor'].sha256
    }
    if ($Tamper -ceq 'TicketWorkerDrift') {
        $ticketWorker = [ordered]@{
            path = [string]$controllersByKind['diagnostic-binder'].path
            sha256 = [string]$controllersByKind['diagnostic-binder'].sha256
        }
    }
    if ($Tamper -ceq 'TicketSupervisorDrift') {
        $ticketSupervisorScript = [ordered]@{
            path = [string]$controllersByKind['fixture-worker'].path
            sha256 = [string]$controllersByKind['fixture-worker'].sha256
        }
    }
    $processPath = (Get-Command pwsh -ErrorAction Stop).Source
    $ticketSupervisor = [ordered]@{
        pid = 2147483001
        startedAtUtc = '2000-01-01T00:00:01.0000000+00:00'
        path = $processPath
    }
    $recoverySupervisor = [ordered]@{
        pid = 2147483002
        startedAtUtc = '2000-01-01T00:00:02.0000000+00:00'
        path = $processPath
    }
    $initialTerminalWorker = [ordered]@{
        pid = 2147483003
        startedAtUtc = '2000-01-01T00:00:03.0000000+00:00'
        path = $processPath
        completedAtUtc = '2000-01-01T00:01:03.0000000+00:00'
        exitCode = 0
        timedOut = $false
        exitPersistedBeforeResultParsing = $true
    }
    $failedOriginalWorker = [ordered]@{
        pid = 2147483004
        startedAtUtc = '2000-01-01T00:00:04.0000000+00:00'
        path = $processPath
        completedAtUtc = '2000-01-01T00:01:04.0000000+00:00'
        exitCode = 1
        timedOut = $false
        exitPersistedBeforeResultParsing = $true
    }
    $recoveryTerminalWorker = [ordered]@{
        pid = 2147483005
        startedAtUtc = '2000-01-01T00:00:12.0000000+00:00'
        path = $processPath
        completedAtUtc = '2000-01-01T00:01:12.0000000+00:00'
        exitCode = 0
        timedOut = $false
        exitPersistedBeforeResultParsing = $true
    }
    $originalWorker = if ($ResultKind -ceq 'initial') {
        $initialTerminalWorker
    } else {
        $failedOriginalWorker
    }
    $terminalWorker = if ($ResultKind -ceq 'initial') {
        $initialTerminalWorker
    } else {
        $recoveryTerminalWorker
    }
    $refreshChild = [ordered]@{
        kind = 'fixture-refresh'
        pid = 2147483011
        startedAtUtc = '2000-01-01T00:00:05.0000000+00:00'
        path = $processPath
    }
    $verifyChild = [ordered]@{
        kind = 'fixture-verify'
        pid = 2147483012
        startedAtUtc = '2000-01-01T00:00:06.0000000+00:00'
        path = $processPath
    }
    $originalJournalWorker = [ordered]@{
        kind = 'fixture-worker'
        pid = [int]$originalWorker.pid
        startedAtUtc = [string]$originalWorker.startedAtUtc
        path = [string]$originalWorker.path
    }
    $recoveryJournalWorker = [ordered]@{
        kind = 'fixture-worker'
        pid = [int]$terminalWorker.pid
        startedAtUtc = [string]$terminalWorker.startedAtUtc
        path = [string]$terminalWorker.path
    }
    $syntheticRunMutexName =
        "Local\SchoolPilot.Waf800DiagnosticPreparation.$((Get-TestTextSha256 $runId).Substring(0, 32))"
    $syntheticSupervisorMutexName =
        "Local\SchoolPilot.Waf800DiagnosticPreparationSupervisor.$((Get-TestTextSha256 $runId).Substring(0, 32))"
    $launchAdmission = [ordered]@{
        schemaVersion = 1
        type = 'diagnostic_prep_supervisor_launch_admission'
        version = 'diagnostic-prep-supervisor-launch-admission-v1'
        runId = if ($Tamper -ceq 'LaunchAdmissionRunDrift') {
            "drift-$runId"
        } else {
            $runId
        }
        createdAtUtc = '2000-01-01T00:00:00.0000000+00:00'
        manifest = [ordered]@{ path = $manifestPath; sha256 = $manifestSha256 }
        worker = [ordered]@{
            path = [string]$controllersByKind['fixture-worker'].path
            sha256 = [string]$controllersByKind['fixture-worker'].sha256
        }
        supervisorScript = [ordered]@{
            path = [string]$controllersByKind['prep-supervisor'].path
            sha256 = [string]$controllersByKind['prep-supervisor'].sha256
        }
        launchNonceSha256 = '4' * 64
        timeoutSeconds = 2100
        control = [ordered]@{
            ticketPath = $ticketPath
            statePath = Join-Path $runRoot 'supervisor-state.private.json'
            resultPath = $initialResultPath
            journalPath = $journalPath
            workerStdoutPath = Join-Path $runRoot 'fixture-worker.stdout.log'
            workerStderrPath = Join-Path $runRoot 'fixture-worker.stderr.log'
            supervisorStdoutPath = Join-Path $runRoot 'supervisor.stdout.log'
            supervisorStderrPath = Join-Path $runRoot 'supervisor.stderr.log'
            runMutexName = $syntheticRunMutexName
            supervisorMutexName = $syntheticSupervisorMutexName
            supervisorLockPath = $runLockPath
        }
    }
    switch ($Tamper) {
        'CertificationLaunchAdmissionExtraField' { $launchAdmission['rawError'] = 'forbidden' }
        'CertificationLaunchAdmissionControlDrift' {
            $launchAdmission.control.statePath = Join-Path $runRoot 'wrong-state.private.json'
        }
        'CertificationLaunchNonceDrift' { $launchAdmission.launchNonceSha256 = '5' * 64 }
        'CertificationLaunchTimeoutDrift' { $launchAdmission.timeoutSeconds = 2099 }
        'CertificationLaunchTimestampDrift' {
            $launchAdmission.createdAtUtc = '1999-12-31T20:00:00.0000000-04:00'
        }
    }
    Write-PrivateJson $launchAdmissionPath $launchAdmission
    $launchAdmissionSha256 = Get-TestFileSha256 $launchAdmissionPath
    $ticket = [ordered]@{
        schemaVersion = 1
        type = 'diagnostic_prep_supervisor_ticket'
        version = 'diagnostic-prep-supervisor-ticket-v2'
        runId = $runId
        createdAtUtc = '2000-01-01T00:00:00.0000000+00:00'
        diagnosticOnly = $true
        diagnosticEligible = $true
        certificationEligible = $false
        manifest = [ordered]@{ path = $manifestPath; sha256 = $manifestSha256 }
        worker = $ticketWorker
        supervisorScript = $ticketSupervisorScript
        launchAdmission = [ordered]@{
            path = $launchAdmissionPath
            sha256 = if ($Tamper -ceq 'TicketLaunchAdmissionDrift') {
                '0' * 64
            } else {
                $launchAdmissionSha256
            }
        }
        supervisor = $ticketSupervisor
        launchNonceSha256 = '4' * 64
        timeoutSeconds = 2100
        control = [ordered]@{
            statePath = Join-Path $runRoot 'supervisor-state.private.json'
            resultPath = $initialResultPath
            journalPath = $journalPath
            workerStdoutPath = Join-Path $runRoot 'fixture-worker.stdout.log'
            workerStderrPath = Join-Path $runRoot 'fixture-worker.stderr.log'
            supervisorStdoutPath = Join-Path $runRoot 'supervisor.stdout.log'
            supervisorStderrPath = Join-Path $runRoot 'supervisor.stderr.log'
            runMutexName = [string]$launchAdmission.control.runMutexName
            supervisorMutexName = [string]$launchAdmission.control.supervisorMutexName
            supervisorLockPath = $runLockPath
        }
    }
    if ($Tamper -ceq 'CertificationTicketExtraField') { $ticket['rawError'] = 'forbidden' }
    Write-PrivateJson $ticketPath $ticket
    $ticketSha256 = Get-TestFileSha256 $ticketPath
    $workerOwnership = [ordered]@{
        schemaVersion = 1
        type = 'diagnostic_prep_worker_ownership'
        version = 'diagnostic-prep-worker-job-v1'
        runId = $runId
        createdAtUtc = '2000-01-01T00:00:03.5000000+00:00'
        manifestSha256 = $manifestSha256
        supervisorAdmissionSha256 = $ticketSha256
        supervisor = $ticketSupervisor
        worker = $originalWorker
        jobPolicy = 'kill-on-supervisor-close-v1'
        descendantPolicy = 'no-breakaway-v1'
    }
    Write-PrivateJson $workerOwnershipPath $workerOwnership
    $workerOwnershipSha256 = Get-TestFileSha256 $workerOwnershipPath
    $workerOwnershipReference = [ordered]@{
        path = $workerOwnershipPath
        sha256 = $workerOwnershipSha256
    }
    $receiptWorkerOwnershipReference = [ordered]@{
        path = $workerOwnershipPath
        sha256 = $workerOwnershipSha256
        version = 'diagnostic-prep-worker-job-v1'
        jobPolicy = 'kill-on-supervisor-close-v1'
        descendantPolicy = 'no-breakaway-v1'
    }
    Write-PrivateJson $runLockPath ([ordered]@{
        schemaVersion = 1
        type = 'diagnostic_prep_supervisor_run_lock'
        version = 'diagnostic-prep-supervisor-run-lock-v1'
        runId = $runId
        manifest = [ordered]@{ path = $manifestPath; sha256 = $manifestSha256 }
        ticket = [ordered]@{ path = $ticketPath; sha256 = $ticketSha256 }
        supervisorMutexName = [string]$ticket.control.supervisorMutexName
        workerMutexName = [string]$ticket.control.runMutexName
    })
    $runLockSha256 = Get-TestFileSha256 $runLockPath

    $verification = New-TestVerification
    foreach ($name in $script:RequiredFixtureNames) {
        $path = Join-Path $snapshotRoot $name
        $value = switch ($name) {
            'fixture-state.private.json' {
                [ordered]@{ schemaVersion = 1; fixtureId = "fixture-$runId"; refreshedAt = '2000-01-01T00:00:00+00:00' }
            }
            'verification.private.json' { $verification }
            'load-auth.private.json' {
                [ordered]@{ schemaVersion = 1; expiresAt = '2099-01-01T00:00:00+00:00'; teachers = @() }
            }
            'load-devices.private.json' { @([ordered]@{ ordinal = 1; token = 'synthetic-never-used' }) }
            'load-command-bodies.private.json' { @([ordered]@{ ordinal = 1; body = 'synthetic-never-used' }) }
        }
        Write-PrivateJson $path $value
    }
    $receiptArtifacts = @($script:RequiredFixtureNames | ForEach-Object {
        $path = [IO.Path]::GetFullPath((Join-Path $snapshotRoot $_))
        [ordered]@{
            name = $_
            sourcePath = Join-Path $root "sealed-source\$($_)"
            targetPath = $path
            sha256 = Get-TestFileSha256 $path
            size = (Get-Item -LiteralPath $path).Length
            lastWriteTimeUtc = (Get-Item -LiteralPath $path).LastWriteTimeUtc.ToString('o')
        }
    })
    $bindingArtifacts = @($receiptArtifacts | ForEach-Object {
        [ordered]@{
            name = $_.name
            path = $_.targetPath
            sha256 = $_.sha256
            size = $_.size
            lastWriteTimeUtc = $_.lastWriteTimeUtc
        }
    })
    $artifactSetInput = @($receiptArtifacts | ForEach-Object {
        [ordered]@{
            name = $_.name
            sha256 = $_.sha256
            size = $_.size
            lastWriteTimeUtc = $_.lastWriteTimeUtc
        }
    })
    $snapshotArtifactSetSha256 = Get-TestSnapshotArtifactSetSha256 $artifactSetInput
    $verificationArtifact = @($receiptArtifacts | Where-Object { $_.name -ceq 'verification.private.json' })[0]
    $verificationCountsAndGatesSha256 = Get-TestVerificationContractSha256 $verification
    $fixtureWorkerSha256 = [string]$controllersByKind['fixture-worker'].sha256
    $emptyOutputSha256 = Get-TestTextSha256 ''
    $childAdmissionHashes = [ordered]@{
        fixtureCliSha256 = $fixtureCliSha256
        fixtureCliGitObjectIdSha256 = '6' * 64
        fixtureWorkerSha256 = $fixtureWorkerSha256
        supervisorAdmissionSha256 = $ticketSha256
    }
    $childStartedHashes = [ordered]@{
        fixtureCliSha256 = $fixtureCliSha256
        fixtureWorkerSha256 = $fixtureWorkerSha256
        supervisorAdmissionSha256 = $ticketSha256
    }
    $childCompletedHashes = [ordered]@{
        stdoutSha256 = $emptyOutputSha256
        stderrSha256 = $emptyOutputSha256
    }
    $preflightHashes = [ordered]@{
        manifestSha256 = $manifestSha256
        fixtureWorkerSha256 = $fixtureWorkerSha256
        supervisorAdmissionSha256 = $ticketSha256
        supervisorAdmissionNonceSha256 = [string]$ticket.launchNonceSha256
    }
    $freshnessHashes = [ordered]@{
        fixtureIdSha256 = Get-TestTextSha256 "fixture-$runId"
    }

    $records = [Collections.Generic.List[object]]::new()
    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'preflight_accepted' -Status 'completed' -Process $originalJournalWorker `
        -ArtifactHashes $preflightHashes
    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'refresh_admitted' -Status 'running' -ArtifactHashes $childAdmissionHashes `
        -Process $originalJournalWorker
    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'refresh_child_started' -Status 'running' -ArtifactHashes $childStartedHashes `
        -Process $refreshChild
    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'refresh_completed' -Status 'completed' -ExitCode 0 `
        -ArtifactHashes $childCompletedHashes -Process $refreshChild
    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'verify_admitted' -Status 'running' -ArtifactHashes $childAdmissionHashes `
        -Process $originalJournalWorker
    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'verify_child_started' -Status 'running' -ArtifactHashes $childStartedHashes `
        -Process $verifyChild
    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'verify_completed' -Status 'completed' -ExitCode 0 `
        -ArtifactHashes $childCompletedHashes -Process $verifyChild
    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'freshness_accepted' -Status 'completed' -Process $originalJournalWorker `
        -ArtifactHashes $freshnessHashes
    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'source_hashes_sealed' -Status 'completed' -ExitCode 0 `
        -ArtifactHashes ([ordered]@{ snapshotArtifactSetSha256 = $snapshotArtifactSetSha256 }) `
        -Process $originalJournalWorker
    $sourceSealedRecordHash = [string]$records[-1].recordHash

    $receipt = [ordered]@{
        schemaVersion = 1
        type = 'fixture_preparation_receipt'
        version = 'fixture-preparation-receipt-v1'
        status = 'sources_sealed'
        runId = $runId
        diagnosticOnly = $true
        diagnosticEligible = $true
        certificationEligible = $false
        sealedAtUtc = '2000-01-01T00:00:07.0000000+00:00'
        manifest = [ordered]@{ path = $manifestPath; sha256 = $manifestSha256 }
        release = $release
        controllerArtifacts = @($controllers)
        supervisorAdmission = [ordered]@{
            type = 'diagnostic_prep_supervisor_ticket'
            version = 'diagnostic-prep-supervisor-ticket-v2'
            sha256 = $ticketSha256
            nonceSha256 = [string]$ticket.launchNonceSha256
            supervisor = $ticketSupervisor
            supervisorLockPathSha256 = Get-TestTextSha256 $runLockPath
            originalTicketSha256 = $null
            workerOwnership = $receiptWorkerOwnershipReference
        }
        fixture = [ordered]@{
            fixtureId = "fixture-$runId"
            provider = 'production'
            sourceRoot = $sourceRoot
            fixtureCli = $manifest.fixture.fixtureCli
            config = $manifest.fixture.config
        }
        execution = [ordered]@{
            runStartedAtUtc = '2000-01-01T00:00:00.0000000+00:00'
            runDirectory = $runRoot
            refreshCompletedAtUtc = '2000-01-01T00:00:03.0000000+00:00'
            verificationCompletedAtUtc = '2000-01-01T00:00:05.0000000+00:00'
            refreshExitCode = 0
            verificationExitCode = 0
            refreshStdoutSha256 = $emptyOutputSha256
            refreshStderrSha256 = $emptyOutputSha256
            verifyStdoutSha256 = $emptyOutputSha256
            verifyStderrSha256 = $emptyOutputSha256
            workerProcess = [ordered]@{
                pid = [int]$originalWorker.pid
                startedAtUtc = [string]$originalWorker.startedAtUtc
                path = [string]$originalWorker.path
                kind = 'fixture-worker'
            }
        }
        freshness = [ordered]@{
            refreshedAtUtc = '2000-01-01T00:00:00.0000000+00:00'
            verifiedAtUtc = '2000-01-01T00:00:05.0000000+00:00'
            checkedAtUtc = '2000-01-01T00:00:06.0000000+00:00'
            requiredVerificationMaximumAgeMinutes = 60
            requiredArtifactValiditySeconds = 2700
            expiresAtUtc = '2099-01-01T00:00:00.0000000+00:00'
            deviceManifestExpiresAtUtc = '2099-01-01T00:00:00.0000000+00:00'
        }
        verification = [ordered]@{
            artifactSha256 = $verificationArtifact.sha256
            counts = $verification.counts
            gates = $verification.gates
            countsAndGatesSha256 = $verificationCountsAndGatesSha256
        }
        credentials = [ordered]@{
            expiresAtUtc = '2099-01-01T00:00:00.0000000+00:00'
            deviceManifestExpiresAtUtc = '2099-01-01T00:00:00.0000000+00:00'
            requiredValiditySeconds = 2700
        }
        snapshot = [ordered]@{
            root = $snapshotRoot
            contract = 'unique-root-no-overwrite-atomic-five-file-v1'
            artifactSetSha256 = $snapshotArtifactSetSha256
            artifacts = @($receiptArtifacts)
        }
        recovery = [ordered]@{ allowedAttempts = 1; nonce = 'synthetic-private-nonce' }
        journal = [ordered]@{
            path = $journalPath
            sourceSealedRecordHash = $sourceSealedRecordHash
        }
        secretsPrinted = $false
        trafficStarted = $false
        leaseAcquired = $false
    }
    Write-PrivateJson $receiptPath $receipt
    $receiptSha256 = Get-TestFileSha256 $receiptPath

    $recoveryAdmissionSha256 = $null
    $recoveryReceiptSha256 = $null
    $recoveryAdmission = $null
    $originalResult = $null
    $originalState = $null
    if ($ResultKind -ceq 'recovery') {
        $originalResult = [ordered]@{
            schemaVersion = 1
            type = 'waf800_diagnostic_prep_supervisor_result'
            version = 'diagnostic-prep-supervisor-v1'
            runId = $runId
            status = 'failed'
            completedAtUtc = '2000-01-01T00:00:09.0000000+00:00'
            ticket = [ordered]@{ path = $ticketPath; sha256 = $ticketSha256 }
            supervisor = $ticketSupervisor
            worker = $originalWorker
            workerOwnership = $workerOwnershipReference
            terminalEvidenceCommitted = $true
            trafficStarted = $false
            leaseAcquired = $false
            rawErrorPersisted = $false
        }
        Write-PrivateJson $initialResultPath $originalResult
        $originalResultSha256 = Get-TestFileSha256 $initialResultPath
        $originalState = [ordered]@{
            schemaVersion = 1
            type = 'waf800_diagnostic_prep_supervisor_state'
            version = 'diagnostic-prep-supervisor-v1'
            runId = $runId
            status = 'failed'
            resultPath = $initialResultPath
            supervisor = $ticketSupervisor
            worker = $originalResult.worker
            workerOwnership = $workerOwnershipReference
        }
        Write-PrivateJson $originalStatePath $originalState
        $originalStateSha256 = Get-TestFileSha256 $originalStatePath
        $admissionSupervisor = if ($Tamper -ceq 'RecoverySupervisorDrift') {
            [ordered]@{
                pid = 2147483010
                startedAtUtc = [string]$recoverySupervisor.startedAtUtc
                path = [string]$recoverySupervisor.path
            }
        } else { $recoverySupervisor }
        $recoveryAdmission = [ordered]@{
            schemaVersion = 1
            type = 'diagnostic_prep_publication_recovery_admission'
            version = 'diagnostic-prep-publication-recovery-admission-v1'
            mode = 'ResumePublication'
            runId = $runId
            createdAtUtc = '2000-01-01T00:00:10.0000000+00:00'
            manifest = [ordered]@{ path = $manifestPath; sha256 = $manifestSha256 }
            worker = $controllersByKind['fixture-worker']
            supervisorScript = $controllersByKind['prep-supervisor']
            supervisor = $admissionSupervisor
            originalTicket = [ordered]@{ path = $ticketPath; sha256 = $ticketSha256 }
            originalExecution = [ordered]@{
                statePath = $originalStatePath
                stateSha256 = $originalStateSha256
                resultPath = $initialResultPath
                resultSha256 = $originalResultSha256
                fixturePreparationReceiptPath = $receiptPath
                fixturePreparationReceiptSha256 = $receiptSha256
            }
            recoveryNonceSha256 = '5' * 64
            control = [ordered]@{
                statePath = [string]$manifest.paths.supervisorStatePath
                recoveryResultPath = $recoveryResultPath
                recoveryStdoutPath = Join-Path $runRoot 'publication-recovery.stdout.log'
                recoveryStderrPath = Join-Path $runRoot 'publication-recovery.stderr.log'
                runMutexName = [string]$ticket.control.runMutexName
                supervisorMutexName = [string]$ticket.control.supervisorMutexName
                supervisorLockPath = $runLockPath
            }
        }
        Write-PrivateJson $recoveryAdmissionPath $recoveryAdmission
        $recoveryAdmissionSha256 = Get-TestFileSha256 $recoveryAdmissionPath
        $recoveryWorkerOwnership = [ordered]@{
            schemaVersion = 1
            type = 'diagnostic_prep_worker_ownership'
            version = 'diagnostic-prep-worker-job-v1'
            runId = $runId
            createdAtUtc = '2000-01-01T00:00:12.5000000+00:00'
            manifestSha256 = $manifestSha256
            supervisorAdmissionSha256 = $recoveryAdmissionSha256
            supervisor = $recoverySupervisor
            worker = $terminalWorker
            jobPolicy = 'kill-on-supervisor-close-v1'
            descendantPolicy = 'no-breakaway-v1'
        }
        Write-PrivateJson $recoveryWorkerOwnershipPath $recoveryWorkerOwnership
        $recoveryWorkerOwnershipSha256 = Get-TestFileSha256 $recoveryWorkerOwnershipPath
        $recoveryWorkerOwnershipReference = [ordered]@{
            path = $recoveryWorkerOwnershipPath
            sha256 = $recoveryWorkerOwnershipSha256
        }
        $recoveryReceipt = [ordered]@{
            schemaVersion = 1
            type = 'fixture_publication_recovery_receipt'
            version = 'fixture-publication-recovery-v1'
            status = 'admitted'
            runId = $runId
            admittedAtUtc = '2000-01-01T00:00:10.5000000+00:00'
            manifestSha256 = $manifestSha256
            fixturePreparationReceiptSha256 = $receiptSha256
            recoveryNonceSha256 = Get-TestTextSha256 'synthetic-private-nonce'
            supervisorAdmissionSha256 = $recoveryAdmissionSha256
            supervisorAdmissionNonceSha256 = [string]$recoveryAdmission.recoveryNonceSha256
            originalSupervisorTicketSha256 = $ticketSha256
        }
        Write-PrivateJson $recoveryReceiptPath $recoveryReceipt
        $recoveryReceiptSha256 = Get-TestFileSha256 $recoveryReceiptPath
    }

    Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
        -Stage 'fixture_receipt_sealed' -Status 'completed' -ExitCode 0 `
        -ArtifactHashes ([ordered]@{
            fixturePreparationReceiptSha256 = $receiptSha256
            snapshotArtifactSetSha256 = $snapshotArtifactSetSha256
            verificationCountsAndGatesSha256 = $verificationCountsAndGatesSha256
            supervisorAdmissionSha256 = $ticketSha256
        }) -Process $originalJournalWorker
    if ($ResultKind -ceq 'initial') {
        Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
            -Stage 'publication_started' -Status 'running' -Process $originalJournalWorker `
            -ArtifactHashes ([ordered]@{
                fixturePreparationReceiptSha256 = $receiptSha256
                snapshotArtifactSetSha256 = $snapshotArtifactSetSha256
            })
        Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
            -Stage 'publication_completed' -Status 'completed' -ExitCode 0 `
            -Process $originalJournalWorker -ArtifactHashes ([ordered]@{
                fixturePreparationReceiptSha256 = $receiptSha256
                snapshotArtifactSetSha256 = $snapshotArtifactSetSha256
                verificationCountsAndGatesSha256 = $verificationCountsAndGatesSha256
            })
        Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
            -Stage 'terminal_commit' -Status 'completed' -ExitCode 0 `
            -ArtifactHashes ([ordered]@{
                fixturePreparationReceiptSha256 = $receiptSha256
                snapshotArtifactSetSha256 = $snapshotArtifactSetSha256
                supervisorAdmissionSha256 = $ticketSha256
                verificationCountsAndGatesSha256 = $verificationCountsAndGatesSha256
            }) -Process $originalJournalWorker
    } else {
        Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
            -Stage 'publication_started' -Status 'running' -Process $originalJournalWorker `
            -ArtifactHashes ([ordered]@{
                fixturePreparationReceiptSha256 = $receiptSha256
                snapshotArtifactSetSha256 = $snapshotArtifactSetSha256
            })
        Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
            -Stage 'terminal_commit' -Status 'failed' -ExitCode 1 `
            -ArtifactHashes ([ordered]@{}) `
            -FailureCode 'fixture_snapshot_publication_failed' -FailureStage 'publication' `
            -Process $originalJournalWorker
        Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
            -Stage 'publication_recovery_started' -Status 'running' `
            -ArtifactHashes ([ordered]@{
                publicationRecoveryReceiptSha256 = $recoveryReceiptSha256
                snapshotArtifactSetSha256 = $snapshotArtifactSetSha256
            }) `
            -Process $recoveryJournalWorker
        Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
            -Stage 'publication_recovery_completed' -Status 'completed' -ExitCode 0 `
            -ArtifactHashes ([ordered]@{
                publicationRecoveryReceiptSha256 = $recoveryReceiptSha256
                snapshotArtifactSetSha256 = $snapshotArtifactSetSha256
            }) `
            -Process $recoveryJournalWorker
        Add-TestJournalRecord -Records $records -RunId $runId -ManifestSha256 $manifestSha256 `
            -Stage 'terminal_commit' -Status 'completed' -ExitCode 0 `
            -ArtifactHashes ([ordered]@{
                fixturePreparationReceiptSha256 = $receiptSha256
                snapshotArtifactSetSha256 = $snapshotArtifactSetSha256
                supervisorAdmissionSha256 = $recoveryAdmissionSha256
                publicationRecoveryReceiptSha256 = $recoveryReceiptSha256
                verificationCountsAndGatesSha256 = $verificationCountsAndGatesSha256
            }) -Process $recoveryJournalWorker
    }
    if ($Tamper -ceq 'CertificationJournalExtraField') {
        $records[0] | Add-Member -NotePropertyName rawError -NotePropertyValue 'forbidden'
    }
    $journalText = (@($records | ForEach-Object {
        ConvertTo-Json -InputObject $_ -Depth 60 -Compress
    }) -join "`n") + "`n"
    Write-PrivateText $journalPath $journalText
    $journalTerminalHash = [string]$records[-1].recordHash
    $journalSha256 = Get-TestFileSha256 $journalPath

    $resultPath = if ($ResultKind -ceq 'initial') { $initialResultPath } else { $recoveryResultPath }
    $resultSupervisor = if ($ResultKind -ceq 'initial') { $ticketSupervisor } else { $recoverySupervisor }
    $result = [ordered]@{
        schemaVersion = 1
        type = 'waf800_diagnostic_prep_supervisor_result'
        version = 'diagnostic-prep-supervisor-v1'
        runId = $runId
        status = 'completed'
        completedAtUtc = '2000-01-01T00:01:30.0000000+00:00'
        manifest = [ordered]@{ path = $manifestPath; sha256 = $manifestSha256 }
        ticket = [ordered]@{ path = $ticketPath; sha256 = $ticketSha256 }
        supervisorRunLock = [ordered]@{ path = $runLockPath; sha256 = $runLockSha256 }
        supervisorAdmissionSha256 = if ($ResultKind -ceq 'initial') {
            $ticketSha256
        } else {
            $recoveryAdmissionSha256
        }
        verificationCountsAndGatesSha256 = $verificationCountsAndGatesSha256
        supervisor = $resultSupervisor
        journal = [ordered]@{
            path = $journalPath
            sha256 = if ($Tamper -ceq 'CertificationJournalResultHashDrift') {
                '0' * 64
            } else {
                $journalSha256
            }
            recordCount = $records.Count
            terminalHash = $journalTerminalHash
            terminalCommitted = $true
        }
        fixturePreparationReceipt = [ordered]@{ path = $receiptPath; sha256 = $receiptSha256 }
        terminalEvidenceCommitted = $true
        trafficStarted = $false
        leaseAcquired = $false
        rawErrorPersisted = ($Tamper -ceq 'RawErrorPersisted')
    }
    if ($ResultKind -ceq 'initial') {
        $result.worker = $terminalWorker
        $result.workerOwnership = $workerOwnershipReference
    } else {
        $originalResultSha256 = Get-TestFileSha256 $initialResultPath
        $originalStateSha256 = Get-TestFileSha256 $originalStatePath
        $result.recoveryAdmission = [ordered]@{
            path = $recoveryAdmissionPath
            sha256 = if ($Tamper -ceq 'RecoveryAdmissionHashDrift') {
                '0' * 64
            } else {
                $recoveryAdmissionSha256
            }
        }
        $result.publicationRecoveryReceipt = [ordered]@{
            path = $recoveryReceiptPath
            sha256 = $recoveryReceiptSha256
        }
        $result.originalExecution = [ordered]@{
            status = 'failed'
            supervisor = $ticketSupervisor
            worker = $originalResult.worker
            workerOwnership = $workerOwnershipReference
            resultPath = $initialResultPath
            resultSha256 = if ($Tamper -ceq 'RecoveryOriginalResultDrift') {
                '0' * 64
            } else {
                $originalResultSha256
            }
            state = [ordered]@{
                path = $originalStatePath
                sha256 = if ($Tamper -ceq 'RecoveryOriginalStateDrift') {
                    '0' * 64
                } else {
                    $originalStateSha256
                }
            }
        }
        $result.recovery = [ordered]@{
            status = 'publication_recovered'
            worker = $terminalWorker
            workerOwnership = $recoveryWorkerOwnershipReference
        }
    }
    Write-PrivateJson $resultPath $result
    $resultSha256 = Get-TestFileSha256 $resultPath

    $binding = [ordered]@{
        version = 'fixture-preparation-receipt-v1'
        diagnosticEligible = $true
        receiptPath = $receiptPath
        receiptSha256 = $receiptSha256
        journalPath = $journalPath
        journalSha256 = if ($Tamper -ceq 'CertificationJournalBindingHashDrift') {
            '0' * 64
        } else {
            $journalSha256
        }
        journalTerminalHash = $journalTerminalHash
        manifestPath = $manifestPath
        manifestSha256 = $manifestSha256
        snapshotRoot = $snapshotRoot
        snapshotArtifactSetSha256 = $snapshotArtifactSetSha256
        supervisorTicketPath = $ticketPath
        supervisorTicketSha256 = $ticketSha256
        supervisorLaunchAdmissionPath = $launchAdmissionPath
        supervisorLaunchAdmissionSha256 = $launchAdmissionSha256
        supervisorResultPath = $resultPath
        supervisorResultSha256 = $resultSha256
        supervisorResultKind = $ResultKind
        supervisorRunLockPath = $runLockPath
        supervisorRunLockSha256 = $runLockSha256
        publicationRecoveryAdmissionPath = $null
        publicationRecoveryAdmissionSha256 = $null
        publicationRecoveryReceiptPath = $null
        publicationRecoveryReceiptSha256 = $null
        workerOwnershipPath = $workerOwnershipPath
        workerOwnershipSha256 = $workerOwnershipSha256
        publicationRecoveryWorkerOwnershipPath = $null
        publicationRecoveryWorkerOwnershipSha256 = $null
        verificationCountsAndGatesSha256 = $verificationCountsAndGatesSha256
        artifacts = @($bindingArtifacts)
    }
    if ($ResultKind -ceq 'recovery') {
        $binding.publicationRecoveryAdmissionPath = $recoveryAdmissionPath
        $binding.publicationRecoveryAdmissionSha256 = $recoveryAdmissionSha256
        $binding.publicationRecoveryReceiptPath = $recoveryReceiptPath
        $binding.publicationRecoveryReceiptSha256 = $recoveryReceiptSha256
        $binding.publicationRecoveryWorkerOwnershipPath = $recoveryWorkerOwnershipPath
        $binding.publicationRecoveryWorkerOwnershipSha256 = $recoveryWorkerOwnershipSha256
    }
    $stateArtifact = @($bindingArtifacts | Where-Object { $_.name -ceq 'fixture-state.private.json' })[0]
    $verificationArtifactBinding = @(
        $bindingArtifacts | Where-Object { $_.name -ceq 'verification.private.json' }
    )[0]
    $certificationArtifacts = @(
        [ordered]@{
            kind = 'device-manifest'
            path = (@($bindingArtifacts | Where-Object { $_.name -ceq 'load-devices.private.json' })[0]).path
            sha256 = (@($bindingArtifacts | Where-Object { $_.name -ceq 'load-devices.private.json' })[0]).sha256
        },
        [ordered]@{
            kind = 'teacher-auth'
            path = (@($bindingArtifacts | Where-Object { $_.name -ceq 'load-auth.private.json' })[0]).path
            sha256 = (@($bindingArtifacts | Where-Object { $_.name -ceq 'load-auth.private.json' })[0]).sha256
        },
        [ordered]@{
            kind = 'command-bodies'
            path = (@($bindingArtifacts | Where-Object { $_.name -ceq 'load-command-bodies.private.json' })[0]).path
            sha256 = (@($bindingArtifacts | Where-Object { $_.name -ceq 'load-command-bodies.private.json' })[0]).sha256
        }
    )
    return [pscustomobject]@{
        Root = $root
        ResultKind = $ResultKind
        Tamper = $Tamper
        RunId = $runId
        Release = [pscustomobject]$release
        Binding = [pscustomobject]$binding
        FixtureState = [pscustomobject]@{
            path = [string]$stateArtifact.path
            sha256 = [string]$stateArtifact.sha256
        }
        FixtureVerification = [pscustomobject]@{
            path = [string]$verificationArtifactBinding.path
            sha256 = [string]$verificationArtifactBinding.sha256
        }
        FixtureArtifacts = @($certificationArtifacts | ForEach-Object { [pscustomobject]$_ })
    }
}

function Get-ValidationArguments {
    param($Fixture)
    return @(
        $Fixture.RunId,
        [string]$Fixture.Release.applicationGitSha,
        [string]$Fixture.Release.controllerGitSha,
        [string]$Fixture.Release.deployedImageDigest,
        [string]$Fixture.Release.apiTaskDefinitionArn,
        [string]$Fixture.Release.workerTaskDefinitionArn
    )
}

$binderTokens = $null
$binderParseErrors = $null
$binderAst = [Management.Automation.Language.Parser]::ParseFile(
    $binderPath,
    [ref]$binderTokens,
    [ref]$binderParseErrors
)
Assert-Condition ($binderParseErrors.Count -eq 0) 'The fresh-diagnostic binder has parse errors.'
foreach ($name in @(
    'Get-BindingValue',
    'Get-BindingRequiredValue',
    'Assert-BindingSha256',
    'Get-BindingFileSha256',
    'Resolve-BindingExternalPath',
    'Assert-BindingPrivateFileAcl',
    'Assert-BindingPrivateDirectoryAcl',
    'Assert-BindingStrictChildPath',
    'Get-BindingStagingCandidates',
    'Assert-NoBindingStagingResidue',
    'Assert-BindingStagingTreeSafe',
    'Remove-BindingStagingSafely',
    'Assert-BindingPublicationPreconditions',
    'Assert-BindingRevalidationSet',
    'Assert-BindingJournalTimestampSequence',
    'Assert-BindingResultRecoveryProvenance',
    'Assert-BindingExactKeys',
    'Assert-BindingFixturePreparationReceiptShape'
)) {
    Import-ScriptFunction $binderAst $name
}
$script:RepositoryRoot = $repositoryRoot

$diagnosticTokens = $null
$diagnosticParseErrors = $null
$diagnosticAst = [Management.Automation.Language.Parser]::ParseFile(
    $diagnosticControllerPath,
    [ref]$diagnosticTokens,
    [ref]$diagnosticParseErrors
)
Assert-Condition ($diagnosticParseErrors.Count -eq 0) 'The diagnostic controller has parse errors.'
foreach ($name in @(
    'Get-Value',
    'Get-RequiredValue',
    'Get-StringSha256',
    'Assert-Sha256',
    'Assert-DiagnosticExactKeys',
    'Resolve-ExternalPath',
    'Assert-DiagnosticPrivateFileAcl',
    'Assert-DiagnosticPrivateDirectoryAcl',
     'Get-DiagnosticCanonicalSha256',
     'Get-DiagnosticPrepJournalRecordHash',
     'Assert-DiagnosticExactKeys',
    'Get-DiagnosticSnapshotArtifactSetSha256',
    'Test-DiagnosticBoundProcessPresent',
    'Test-DiagnosticProcessObservationEqual',
    'Test-DiagnosticProcessIdentityEqual',
    'Assert-DiagnosticFixtureWorkerProvenance',
    'Assert-DiagnosticWorkerOwnership',
    'Assert-DiagnosticPrepMutexFree',
     'Assert-DiagnosticPrepFileLockFree',
    'Assert-DiagnosticPrepJournalTimestampSequence',
    'Assert-DiagnosticPrepJournalNestedShape',
     'Assert-DiagnosticPrepJournalStateMachine',
     'Assert-DiagnosticFixtureChildEvidence',
    'Assert-DiagnosticFixturePreparationReceiptShape',
    'Assert-DiagnosticInitialPreparationHasNoRecoveryProvenance',
     'Assert-DiagnosticFixturePreparationBinding'
)) {
    Import-ScriptFunction $diagnosticAst $name
}
$script:RepositoryRoot = $repositoryRoot
$script:FixturePreparationReceiptVersion = 'fixture-preparation-receipt-v1'
$script:DiagnosticPrepManifestVersion = 'waf800-diagnostic-prep-manifest-v1'
$script:DiagnosticPrepJournalVersion = 'diagnostic-prep-journal-v1'
$script:DiagnosticPrepSupervisorTicketVersion = 'diagnostic-prep-supervisor-ticket-v2'
$script:DiagnosticPrepSupervisorResultVersion = 'diagnostic-prep-supervisor-v1'
$script:DiagnosticPrepRecoveryAdmissionVersion = 'diagnostic-prep-publication-recovery-admission-v1'
$script:DiagnosticPrepSupervisorRunLockVersion = 'diagnostic-prep-supervisor-run-lock-v1'
$script:DiagnosticPrepRecoveryReceiptVersion = 'fixture-publication-recovery-v1'

try {
    $boundaryRoot = Join-Path ([IO.Path]::GetTempPath()) (
        'schoolpilot-binder-boundary-' + [Guid]::NewGuid().ToString('N')
    )
    [void]$script:FixtureRoots.Add($boundaryRoot)
    [void](New-PrivateDirectory $boundaryRoot)

    $cleanParent = New-PrivateDirectory (Join-Path $boundaryRoot 'clean-parent')
    $cleanBindingRoot = Join-Path $cleanParent 'fresh-binding'
    Assert-NoBindingStagingResidue -Parent $cleanParent -BindingRoot $cleanBindingRoot
    Assert-Condition $true 'The binder must accept an exact-private parent without staging residue.'

    $broadParent = New-PrivateDirectory (Join-Path $boundaryRoot 'broad-parent')
    $broadParentItem = Get-Item -LiteralPath $broadParent -Force
    $broadAcl = [IO.FileSystemAclExtensions]::GetAccessControl(
        $broadParentItem,
        [Security.AccessControl.AccessControlSections]::Access
    )
    $usersSid = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::BuiltinUsersSid,
        $null
    )
    $broadAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $usersSid,
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.FileSystemAclExtensions]::SetAccessControl($broadParentItem, $broadAcl)
    Assert-Throws {
        Assert-NoBindingStagingResidue -Parent $broadParent `
            -BindingRoot (Join-Path $broadParent 'fresh-binding')
    } 'accessible only by the current operator' (
        'The binder must reject a parent with a broad ACL before creating staging.'
    )
    Set-ExactPrivateAcl $broadParent

    $residueParent = New-PrivateDirectory (Join-Path $boundaryRoot 'residue-parent')
    $residueBindingRoot = Join-Path $residueParent 'fresh-binding'
    $abandonedStaging = New-PrivateDirectory (
        Join-Path $residueParent '.fresh-binding.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.staging'
    )
    Assert-Throws {
        Assert-NoBindingStagingResidue -Parent $residueParent -BindingRoot $residueBindingRoot
    } 'abandoned or ambiguous' (
        'The binder must reject abandoned staging left by an abruptly terminated publisher.'
    )
    $secondAbandonedStaging = New-PrivateDirectory (
        Join-Path $residueParent '.fresh-binding.dddddddddddddddddddddddddddddddd.staging'
    )
    Assert-Throws {
        Assert-NoBindingStagingResidue -Parent $residueParent -BindingRoot $residueBindingRoot
    } 'abandoned or ambiguous' (
        'The binder must reject multiple ambiguous sibling staging directories.'
    )
    Remove-BindingStagingSafely -Path $abandonedStaging -ExpectedParent $residueParent
    Remove-BindingStagingSafely -Path $secondAbandonedStaging -ExpectedParent $residueParent
    Assert-Condition (-not (Test-Path -LiteralPath $abandonedStaging)) (
        'Guarded staging cleanup must remove only the exact validated staging directory.'
    )

    $junctionParent = New-PrivateDirectory (Join-Path $boundaryRoot 'junction-parent')
    $junctionTarget = New-PrivateDirectory (Join-Path $boundaryRoot 'junction-target')
    $junctionSentinel = Join-Path $junctionTarget 'sentinel.txt'
    Write-PrivateText $junctionSentinel 'must-survive'
    $junctionPath = Join-Path $junctionParent '.fresh-binding.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.staging'
    [void](New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget -ErrorAction Stop)
    try {
        Assert-Throws {
            Assert-BindingStagingTreeSafe -Path $junctionPath -ExpectedParent $junctionParent | Out-Null
        } 'reparse point|symbolic link|junction' (
            'The binder must reject a junction substituted for its staging directory.'
        )
        Assert-Throws {
            Remove-BindingStagingSafely -Path $junctionPath -ExpectedParent $junctionParent
        } 'reparse point|symbolic link|junction' (
            'Guarded cleanup must refuse a junction instead of traversing its target.'
        )
        Assert-Condition (Test-Path -LiteralPath $junctionSentinel -PathType Leaf) (
            'Junction rejection must leave the external target untouched.'
        )
    }
    finally {
        if (Test-Path -LiteralPath $junctionPath) {
            [IO.Directory]::Delete($junctionPath, $false)
        }
    }

    $competitionParent = New-PrivateDirectory (Join-Path $boundaryRoot 'competition-parent')
    $competitionBindingRoot = Join-Path $competitionParent 'fresh-binding'
    $competitionStaging = New-PrivateDirectory (
        Join-Path $competitionParent '.fresh-binding.cccccccccccccccccccccccccccccccc.staging'
    )
    foreach ($name in @('config.json','config.sha256.txt','receipt.json')) {
        Write-PrivateText (Join-Path $competitionStaging $name) $name
    }
    [void](New-PrivateDirectory $competitionBindingRoot)
    Assert-Throws {
        Assert-BindingPublicationPreconditions -Parent $competitionParent `
            -Staging $competitionStaging -BindingRoot $competitionBindingRoot
    } 'destination appeared' (
        'The binder must reject a competing destination immediately before rename.'
    )
    Remove-BindingStagingSafely -Path $competitionStaging -ExpectedParent $competitionParent

    $rehashRoot = New-PrivateDirectory (Join-Path $boundaryRoot 'rehash')
    $rehashPath = Join-Path $rehashRoot 'bound-input.private.json'
    Write-PrivateText $rehashPath '{"stable":true}'
    $rehashExpected = Get-TestFileSha256 $rehashPath
    Assert-BindingRevalidationSet -Files @([pscustomobject]@{
        name='Test bound input';path=$rehashPath;sha256=$rehashExpected;private=$true
    })
    Assert-Condition $true 'The binder must accept an unchanged private input during final rehash.'
    Assert-BindingRevalidationSet -Files @([pscustomobject]@{
        name='Binder source';path=$binderPath;sha256=(Get-TestFileSha256 $binderPath);private=$false
    })
    Assert-Condition $true 'The binder must rehash a non-reparse repository controller artifact.'
    Write-PrivateText $rehashPath '{"stable":false}'
    Assert-Throws {
        Assert-BindingRevalidationSet -Files @([pscustomobject]@{
            name='Test bound input';path=$rehashPath;sha256=$rehashExpected;private=$true
        })
    } 'changed before atomic binding publication' (
        'The binder must reject input drift detected after staging and before rename.'
    )

    $validJournalTimestamps = @(
        [pscustomobject]@{ timestampUtc='2026-07-23T01:00:00.0000000+00:00' },
        [pscustomobject]@{ timestampUtc='2026-07-23T01:00:00.0000000+00:00' },
        [pscustomobject]@{ timestampUtc='2026-07-23T01:00:00.0000001+00:00' }
    )
    Assert-BindingJournalTimestampSequence $validJournalTimestamps
    Assert-Condition $true 'The binder must accept exact UTC, non-regressing journal timestamps.'
    Assert-Throws {
        Assert-BindingJournalTimestampSequence @(
            [pscustomobject]@{ timestampUtc='2026-07-23T01:00:00.0000000-04:00' }
        )
    } 'exact \+00:00 UTC string' (
        'The binder must reject a journal timestamp with a nonzero offset.'
    )
    Assert-Throws {
        Assert-BindingJournalTimestampSequence @(
            [pscustomobject]@{ timestampUtc='2026-07-23T01:00:00.0000001+00:00' },
            [pscustomobject]@{ timestampUtc='2026-07-23T01:00:00.0000000+00:00' }
        )
    } 'non-regressing' 'The binder must reject regressing journal timestamps.'

    $exactReceiptShape = [pscustomobject]@{
        schemaVersion=1;type='fixture_preparation_receipt';version='fixture-preparation-receipt-v1'
        status='sources_sealed';runId='shape-test';diagnosticOnly=$true
        diagnosticEligible=$true;certificationEligible=$false
        sealedAtUtc='2026-07-23T01:00:00.0000000+00:00'
        manifest=[pscustomobject]@{path='manifest';sha256=('a' * 64)}
        release=[pscustomobject]@{
            applicationGitSha=('b' * 40);controllerGitSha=('b' * 40)
            deployedImageDigest=('sha256:' + ('c' * 64))
            apiTaskDefinitionArn='api';workerTaskDefinitionArn='worker'
        }
        controllerArtifacts=@([pscustomobject]@{kind='controller';path='path';sha256=('d' * 64)})
        supervisorAdmission=[pscustomobject]@{
            type='diagnostic_prep_supervisor_ticket';version='diagnostic-prep-supervisor-ticket-v2'
            sha256=('e' * 64);nonceSha256=('f' * 64)
            supervisor=[pscustomobject]@{pid=1;startedAtUtc='utc';path='pwsh'}
            supervisorLockPathSha256=('1' * 64);originalTicketSha256=$null
            workerOwnership=[pscustomobject]@{
                path='ownership';sha256=('2' * 64)
                version='diagnostic-prep-worker-job-v1'
                jobPolicy='kill-on-supervisor-close-v1'
                descendantPolicy='no-breakaway-v1'
            }
        }
        fixture=[pscustomobject]@{
            fixtureId='fixture';provider='production';sourceRoot='source'
            fixtureCli=[pscustomobject]@{path='cli';sha256=('3' * 64)}
            config=[pscustomobject]@{path='config';sha256=('4' * 64)}
        }
        execution=[pscustomobject]@{
            runStartedAtUtc='utc';runDirectory='run';refreshCompletedAtUtc='utc'
            verificationCompletedAtUtc='utc';refreshExitCode=0;verificationExitCode=0
            refreshStdoutSha256=('5' * 64);refreshStderrSha256=('6' * 64)
            verifyStdoutSha256=('7' * 64);verifyStderrSha256=('8' * 64)
            workerProcess=[pscustomobject]@{pid=2;startedAtUtc='utc';path='pwsh';kind='fixture-worker'}
        }
        freshness=[pscustomobject]@{
            refreshedAtUtc='utc';verifiedAtUtc='utc';checkedAtUtc='utc'
            requiredVerificationMaximumAgeMinutes=60;requiredArtifactValiditySeconds=2700
            expiresAtUtc='utc';deviceManifestExpiresAtUtc='utc'
        }
        verification=[pscustomobject]@{
            artifactSha256=('9' * 64)
            counts=[pscustomobject]@{
                schools=2;teachers=20;officeStaff=1;students=1010;classes=20
                classRosterStudents=800;devices=1010;activeDeviceSessions=1010
                activeSessions=20;commandBodies=20
                authorizationPlanCohorts=[pscustomobject]@{
                    coTeacherStudents=40;officeSupervisionStudents=40
                }
                liveAuth=[pscustomobject]@{commandAdministrators=1;teachers=20}
            }
            gates=[pscustomobject]@{
                autoEnrollDisabled=$true;trackingDisabled=$true;schedulesDisabled=$true
                exactSchoolTimezones=$true;classRostersExactAndDisjoint=$true
                authorizationPlanCohortsExact=$true
                authorizationPlanOfficeStudentsOutsideTeacherRosters=$true
                allDeviceTokensLive=$true;allStaffAuthArtifactsLive=$true
            }
            countsAndGatesSha256=('a' * 64)
        }
        credentials=[pscustomobject]@{
            expiresAtUtc='utc';deviceManifestExpiresAtUtc='utc';requiredValiditySeconds=2700
        }
        snapshot=[pscustomobject]@{
            root='snapshot';contract='contract';artifactSetSha256=('b' * 64)
            artifacts=@([pscustomobject]@{
                name='fixture-state.private.json';sourcePath='source';targetPath='target'
                sha256=('c' * 64);size=1;lastWriteTimeUtc='utc'
            })
        }
        recovery=[pscustomobject]@{allowedAttempts=1;nonce='nonce'}
        journal=[pscustomobject]@{path='journal';sourceSealedRecordHash=('d' * 64)}
        secretsPrinted=$false;trafficStarted=$false;leaseAcquired=$false
    }
    Assert-BindingFixturePreparationReceiptShape $exactReceiptShape
    Assert-Condition $true 'The binder must accept the exact preparation-receipt shape.'
    $receiptWithExtra = $exactReceiptShape | ConvertTo-Json -Depth 60 |
        ConvertFrom-Json -DateKind String -Depth 60
    Add-Member -InputObject $receiptWithExtra -NotePropertyName unexpected -NotePropertyValue $true
    Assert-Throws {
        Assert-BindingFixturePreparationReceiptShape $receiptWithExtra
    } 'missing, duplicate, or unexpected fields' (
        'The binder must reject an unexpected top-level preparation-receipt field.'
    )
    $nestedReceiptWithExtra = $exactReceiptShape | ConvertTo-Json -Depth 60 |
        ConvertFrom-Json -DateKind String -Depth 60
    Add-Member -InputObject $nestedReceiptWithExtra.snapshot.artifacts[0] `
        -NotePropertyName unexpected -NotePropertyValue $true
    Assert-Throws {
        Assert-BindingFixturePreparationReceiptShape $nestedReceiptWithExtra
    } 'missing, duplicate, or unexpected fields' (
        'The binder must reject an unexpected nested preparation-receipt field.'
    )

    $recoveryReceiptProbe = Join-Path $boundaryRoot 'publication-recovery-receipt.private.json'
    Assert-BindingResultRecoveryProvenance 'initial' ([pscustomobject]@{}) $recoveryReceiptProbe
    Assert-Condition $true 'An initial result without recovery provenance must remain eligible.'
    Assert-Throws {
        Assert-BindingResultRecoveryProvenance 'initial' ([pscustomobject]@{
            recovery=[pscustomobject]@{ worker='stale' }
        }) $recoveryReceiptProbe
    } 'must not contain recovery provenance' (
        'The binder must reject recovery-worker provenance attached to an initial result.'
    )
    Write-PrivateText $recoveryReceiptProbe '{"stale":true}'
    Assert-Throws {
        Assert-BindingResultRecoveryProvenance 'initial' ([pscustomobject]@{}) `
            $recoveryReceiptProbe
    } 'publication-recovery receipt exists' (
        'The binder must reject an initial result when the manifest-bound recovery receipt already exists.'
    )

    $validInitial = New-SyntheticFixturePreparation -ResultKind initial
    $validRecovery = New-SyntheticFixturePreparation -ResultKind recovery
    $rejectionFixtures = @(
        New-SyntheticFixturePreparation -ResultKind initial -Tamper TicketWorkerDrift
        New-SyntheticFixturePreparation -ResultKind initial -Tamper TicketSupervisorDrift
        New-SyntheticFixturePreparation -ResultKind initial -Tamper TicketLaunchAdmissionDrift
        New-SyntheticFixturePreparation -ResultKind initial -Tamper LaunchAdmissionRunDrift
        New-SyntheticFixturePreparation -ResultKind initial -Tamper MissingDiagnosticBinder
        New-SyntheticFixturePreparation -ResultKind initial -Tamper RawErrorPersisted
        New-SyntheticFixturePreparation -ResultKind recovery -Tamper RecoveryAdmissionHashDrift
        New-SyntheticFixturePreparation -ResultKind recovery -Tamper RecoveryOriginalStateDrift
        New-SyntheticFixturePreparation -ResultKind recovery -Tamper RecoveryOriginalResultDrift
        New-SyntheticFixturePreparation -ResultKind recovery -Tamper RecoverySupervisorDrift
    )

    $validatedCertificationInitial = $null
    foreach ($fixture in @($validInitial, $validRecovery)) {
        Write-Verbose "Validating diagnostic $($fixture.ResultKind) fixture at $($fixture.Root)."
        $prevalidatedTicket = Get-Content -LiteralPath ([string]$fixture.Binding.supervisorTicketPath) -Raw |
            ConvertFrom-Json -DateKind String -Depth 60
        Assert-Condition ($null -ne $prevalidatedTicket.control) 'Synthetic supervisor ticket lost its control envelope.'
        $validationArguments = @(Get-ValidationArguments $fixture)
        $validated = Assert-DiagnosticFixturePreparationBinding $fixture.Binding @validationArguments
        Assert-Condition (
            $validated.SupervisorResultKind -ceq $fixture.ResultKind -and
            $validated.ReceiptSha256 -ceq [string]$fixture.Binding.receiptSha256 -and
            $validated.JournalTerminalHash -ceq [string]$fixture.Binding.journalTerminalHash -and
            @($validated.Artifacts).Count -eq 5
        ) "The diagnostic validator must accept the complete $($fixture.ResultKind) preparation branch."
    }

    $expectedRejections = [ordered]@{
        TicketWorkerDrift = 'supervisor ticket or persistent lock binding changed'
        TicketSupervisorDrift = 'supervisor ticket or persistent lock binding changed'
        TicketLaunchAdmissionDrift = 'supervisor ticket or persistent lock binding changed'
        LaunchAdmissionRunDrift = 'launch admission identity is invalid'
        MissingDiagnosticBinder = "controller 'diagnostic-binder' is required"
        RawErrorPersisted = 'supervisor result is not a coherent completed no-traffic result'
        RecoveryAdmissionHashDrift = 'recovery admission changed after binding|recovery admission identity is invalid'
        RecoveryOriginalStateDrift = 'recovery admission identity is invalid'
        RecoveryOriginalResultDrift = 'recovery admission identity is invalid'
        RecoverySupervisorDrift = 'recovery admission identity is invalid'
    }
    foreach ($fixture in $rejectionFixtures) {
        $validationArguments = @(Get-ValidationArguments $fixture)
        Assert-Throws {
            Assert-DiagnosticFixturePreparationBinding $fixture.Binding @validationArguments | Out-Null
        } ([string]$expectedRejections[$fixture.Tamper]) (
            "The diagnostic validator must reject independently hash-bound $($fixture.Tamper) evidence."
        )
    }

    $certificationTokens = $null
    $certificationParseErrors = $null
    $certificationAst = [Management.Automation.Language.Parser]::ParseFile(
        $certificationSupervisorPath,
        [ref]$certificationTokens,
        [ref]$certificationParseErrors
    )
    Assert-Condition ($certificationParseErrors.Count -eq 0) 'The certification supervisor has parse errors.'
    foreach ($name in @(
        'Resolve-ExternalPath',
        'Get-RequiredProperty',
        'Get-CertificationValue',
        'Get-CertificationTextSha256',
        'Get-CertificationSha256',
        'Assert-CertificationSha256',
        'Assert-CertificationEvidenceReference',
        'Assert-CertificationPrivateFileAcl',
        'Assert-CertificationPrivateDirectoryAcl',
        'Assert-CertificationExactPropertySet',
        'Assert-CertificationPrepJournalRecordKeys',
        'Test-CertificationPathsOverlap',
        'Assert-CertificationFixturePreparationPathIsolation',
        'Get-CertificationCanonicalSha256',
        'Get-CertificationPrepJournalRecordHash',
        'Get-CertificationSnapshotArtifactSetSha256',
        'Test-CertificationBoundProcessPresent',
        'Test-CertificationProcessObservationEqual',
        'Test-CertificationProcessIdentityEqual',
        'Assert-CertificationFixtureWorkerProvenance',
        'Assert-CertificationWorkerOwnership',
        'Assert-CertificationPrepMutexFree',
         'Assert-CertificationPrepFileLockFree',
        'Assert-CertificationPrepJournalTimestampSequence',
        'Assert-CertificationPrepJournalNestedShape',
         'Assert-CertificationPrepJournalStateMachine',
         'Assert-CertificationFixtureChildEvidence',
        'Assert-CertificationFixturePreparationReceiptShape',
        'Assert-CertificationInitialPreparationHasNoRecoveryProvenance',
         'Get-CertificationFixturePreparationBinding'
    )) {
        Import-ScriptFunction $certificationAst $name
    }
    $script:RequiredFixturePreparationReceiptVersion = 'fixture-preparation-receipt-v1'
    $script:RequiredDiagnosticPrepManifestVersion = 'waf800-diagnostic-prep-manifest-v1'
    $script:RequiredDiagnosticPrepJournalVersion = 'diagnostic-prep-journal-v1'
    $script:RequiredDiagnosticPrepSupervisorTicketVersion = 'diagnostic-prep-supervisor-ticket-v2'
    $script:RequiredDiagnosticPrepSupervisorResultVersion = 'diagnostic-prep-supervisor-v1'
    $script:RequiredDiagnosticPrepRecoveryAdmissionVersion =
        'diagnostic-prep-publication-recovery-admission-v1'
    $script:RequiredDiagnosticPrepSupervisorRunLockVersion =
        'diagnostic-prep-supervisor-run-lock-v1'
    $script:RequiredDiagnosticPrepRecoveryReceiptVersion = 'fixture-publication-recovery-v1'

    foreach ($fixture in @($validInitial, $validRecovery)) {
        $config = [pscustomobject]@{ fixturePreparation = $fixture.Binding }
        $validationArguments = @(Get-ValidationArguments $fixture)
        $certificationArgumentList = [Collections.Generic.List[object]]::new()
        $certificationArgumentList.Add($config)
        foreach ($argument in $validationArguments) { $certificationArgumentList.Add($argument) }
        $certificationArgumentList.Add($fixture.FixtureState)
        $certificationArgumentList.Add($fixture.FixtureVerification)
        $certificationArgumentList.Add([object[]]@($fixture.FixtureArtifacts))
        $certificationArguments = $certificationArgumentList.ToArray()
        $validated = Get-CertificationFixturePreparationBinding @certificationArguments
        if ($fixture.ResultKind -ceq 'initial') { $validatedCertificationInitial = $validated }
        Assert-Condition (
            $validated.SupervisorResultKind -ceq $fixture.ResultKind -and
            $validated.Public.supervisorResultKind -ceq $fixture.ResultKind -and
            $validated.Public.diagnosticEligible -eq $true -and
            @($validated.Artifacts).Count -eq 5
        ) "The certification validator must accept the complete $($fixture.ResultKind) preparation branch."
    }
    Assert-CertificationFixturePreparationPathIsolation $validatedCertificationInitial @(
        [pscustomobject]@{
            Name = 'isolated test output'
            Path = Join-Path $validInitial.Root 'certification-output'
        }
    )
    Assert-Condition $true 'The certification validator must permit a write root disjoint from preparation provenance.'
    foreach ($protected in @(
            [pscustomobject]@{ Name='source'; Path=$validatedCertificationInitial.SourceRoot },
            [pscustomobject]@{ Name='snapshot'; Path=$validatedCertificationInitial.SnapshotRoot },
            [pscustomobject]@{ Name='run'; Path=$validatedCertificationInitial.RunRoot },
            [pscustomobject]@{ Name='binding'; Path=$validatedCertificationInitial.BindingRoot }
        )) {
        Assert-Throws {
            Assert-CertificationFixturePreparationPathIsolation $validatedCertificationInitial @(
                [pscustomobject]@{ Name='malicious write'; Path=$protected.Path }
            )
        } 'must not overlap' (
            "The certification validator must reject writes overlapping the protected $($protected.Name) root."
        )
    }

    $certificationOnlyRejections = @(
        New-SyntheticFixturePreparation -ResultKind initial -Tamper CertificationTicketExtraField
        New-SyntheticFixturePreparation -ResultKind initial -Tamper CertificationLaunchAdmissionExtraField
        New-SyntheticFixturePreparation -ResultKind initial -Tamper CertificationLaunchAdmissionControlDrift
        New-SyntheticFixturePreparation -ResultKind initial -Tamper CertificationLaunchNonceDrift
        New-SyntheticFixturePreparation -ResultKind initial -Tamper CertificationLaunchTimeoutDrift
        New-SyntheticFixturePreparation -ResultKind initial -Tamper CertificationLaunchTimestampDrift
        New-SyntheticFixturePreparation -ResultKind initial -Tamper CertificationJournalExtraField
        New-SyntheticFixturePreparation -ResultKind initial -Tamper CertificationJournalBindingHashDrift
        New-SyntheticFixturePreparation -ResultKind initial -Tamper CertificationJournalResultHashDrift
    )
    $certificationOnlyPatterns = [ordered]@{
        CertificationTicketExtraField = 'supervisor ticket fields are invalid'
        CertificationLaunchAdmissionExtraField = 'launch admission fields are invalid'
        CertificationLaunchAdmissionControlDrift = 'launch admission identity is invalid'
        CertificationLaunchNonceDrift = 'launch admission identity is invalid'
        CertificationLaunchTimeoutDrift = 'launch admission identity is invalid'
        CertificationLaunchTimestampDrift = 'launch admission identity is invalid'
        CertificationJournalExtraField = 'journal record fields are invalid'
        CertificationJournalBindingHashDrift = 'journal file hash drifted'
        CertificationJournalResultHashDrift = 'journal file hash drifted'
    }
    foreach ($fixture in $certificationOnlyRejections) {
        $config = [pscustomobject]@{ fixturePreparation = $fixture.Binding }
        $validationArguments = @(Get-ValidationArguments $fixture)
        $certificationArgumentList = [Collections.Generic.List[object]]::new()
        $certificationArgumentList.Add($config)
        foreach ($argument in $validationArguments) { $certificationArgumentList.Add($argument) }
        $certificationArgumentList.Add($fixture.FixtureState)
        $certificationArgumentList.Add($fixture.FixtureVerification)
        $certificationArgumentList.Add([object[]]@($fixture.FixtureArtifacts))
        $certificationArguments = $certificationArgumentList.ToArray()
        Assert-Throws {
            Get-CertificationFixturePreparationBinding @certificationArguments | Out-Null
        } ([string]$certificationOnlyPatterns[$fixture.Tamper]) (
            "The certification validator must reject $($fixture.Tamper)."
        )
    }

    foreach ($fixture in $rejectionFixtures) {
        $config = [pscustomobject]@{ fixturePreparation = $fixture.Binding }
        $validationArguments = @(Get-ValidationArguments $fixture)
        $certificationArgumentList = [Collections.Generic.List[object]]::new()
        $certificationArgumentList.Add($config)
        foreach ($argument in $validationArguments) { $certificationArgumentList.Add($argument) }
        $certificationArgumentList.Add($fixture.FixtureState)
        $certificationArgumentList.Add($fixture.FixtureVerification)
        $certificationArgumentList.Add([object[]]@($fixture.FixtureArtifacts))
        $certificationArguments = $certificationArgumentList.ToArray()
        Assert-Throws {
            Get-CertificationFixturePreparationBinding @certificationArguments | Out-Null
        } ([string]$expectedRejections[$fixture.Tamper]) (
            "The certification validator must reject independently hash-bound $($fixture.Tamper) evidence."
        )
    }
}
finally {
    if ($env:SCHOOLPILOT_KEEP_FIXTURE_BINDING_TEST_ARTIFACTS -ne '1') {
        foreach ($fixtureRoot in $script:FixtureRoots) {
            if (Test-Path -LiteralPath $fixtureRoot) {
                Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
            }
        }
    }
}

Write-Host "PASS: $script:AssertionCount fixture-preparation binding assertions."
