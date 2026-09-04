#requires -Version 7.5

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Capacity acceptance regression failed: $Message" }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $threw = $false
    try { & $Action }
    catch {
        $threw = $true
        if ($Pattern -and $_.Exception.Message -notmatch $Pattern) {
            throw "Capacity acceptance regression failed: $Message (unexpected error: $($_.Exception.Message))"
        }
    }
    if (-not $threw) { throw "Capacity acceptance regression failed: $Message" }
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$runnerPath = Join-Path $repositoryRoot "scripts\load\start-classpilot-capacity-acceptance.ps1"
$authorizationPath = Join-Path $repositoryRoot "scripts\load\capacity-acceptance-authorization.json"
Assert-Condition (Test-Path -LiteralPath $runnerPath -PathType Leaf) "The capacity acceptance runner must exist."
Assert-Condition (Test-Path -LiteralPath $authorizationPath -PathType Leaf) `
    "The committed capacity acceptance authorization must exist."
Assert-Throws {
    & $runnerPath -Mode Run -ConfigPath (Join-Path $repositoryRoot "missing-capacity-config.json") `
        2>$null | Out-Null
} "Capacity acceptance is paused" `
    "Runner Run must reject the committed pause before reading even an invalid config path."
$source = Get-Content -LiteralPath $runnerPath -Raw
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $runnerPath,
    [ref]$tokens,
    [ref]$parseErrors
)
Assert-Condition ($parseErrors.Count -eq 0) "The runner must parse under PowerShell 7.5."

$functions = @{}
$functionDefinitions = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst]
}, $true))
$duplicateFunctions = @(
    $functionDefinitions |
        Group-Object Name |
        Where-Object Count -gt 1 |
        ForEach-Object Name
)
Assert-Condition ($duplicateFunctions.Count -eq 0) `
    "The runner must not contain duplicate function definitions: $($duplicateFunctions -join ', ')."
foreach ($definition in $functionDefinitions) {
    $functions[$definition.Name] = $definition
}
foreach ($requiredFunction in @(
    "Read-CapacityAcceptanceAuthorization", "Assert-CapacityAcceptanceRunAuthorized",
    "Read-CapacityConfiguration", "Assert-FixtureAuthority", "Assert-RollbackCompatibility",
    "Get-ProductionPosture", "Assert-EngineeringWafContract", "Assert-HeldCapacityPosture",
    "Set-SixApiCapacity", "Restore-Scaling", "Get-RollbackProductionPosture",
    "Assert-PlannedWindowsSchedulable",
    "Invoke-StageFixturePreparation", "Invoke-StageAttempt", "Invoke-CapacityStage",
    "Get-Zero57014Evidence", "Get-WorkerWindowLogSnapshot",
    "Get-Waf800MaintenanceWindowEvidence", "Get-StandardPiContextBestEffort",
    "New-ApplicationRollbackIntent", "Invoke-ApplicationRollback", "Test-ApplicationFailure",
    "Assert-StageSummary", "Assert-MonitorResult", "Get-WorkerExecutionPosture",
    "Write-PlainReportBestEffort", "Assert-MonitorScalingRestoration",
    "Get-MonitorOwnedApplicationRollback",
    "Assert-ControllerScalingRestoration", "Get-CapacityRunMutexName",
    "Get-CapacityCampaignLockPath", "Get-CapacityCampaignAdmission",
    "Assert-CapacityCampaignAdmission", "Enter-CapacityCampaignAdmission",
    "Get-CapacityRunIdentity", "Assert-CapacityRunIdentity",
    "Get-CapacityLoadGatesRoot", "Assert-StrictChildPath",
    "Get-StableProductionPostureProjection", "Get-StableProductionPostureSha256",
    "Read-RawStageOutcome", "Read-RawStageOutcomeSafely", "Read-RawCapacityOutcome",
    "Repair-InterruptedApplicationRollback",
    "Assert-BoundChildProcessExited", "Get-AttemptTrafficStarted",
    "New-MonitorConfiguration", "New-ScratchMonitorConfiguration",
    "Assert-MonitorRestorationArmed", "Wait-ForHealthyMonitorHeartbeat",
    "Get-NonCredentialChildEnvironment", "Get-RunRecoveryBaseline",
    "ConvertTo-WindowsProcessArgument", "Start-SupervisedProcess",
    "Complete-SupervisedProcess", "Dispose-SupervisedProcess",
    "Test-ReadOnlyProviderFailure", "Test-PreflightApplicationHealthFailure",
    "Invoke-TopLevelReadOnlyPreflight", "Write-TopLevelPreflightTerminalFailure",
    "Invoke-RunnerValidation", "Invoke-CapacityRun"
)) {
    Assert-Condition $functions.ContainsKey($requiredFunction) "Missing required function $requiredFunction."
}

$runAuthorizationIndex = $source.LastIndexOf('if ($Mode -ceq "Run")')
$runAuthorizationCallIndex = $source.IndexOf(
    "Assert-CapacityAcceptanceRunAuthorized",
    $runAuthorizationIndex
)
$toolInitializationIndex = $source.LastIndexOf("Initialize-ToolPaths")
$configurationReadIndex = $source.LastIndexOf('$configuration = Read-CapacityConfiguration')
$validateBranchIndex = $source.LastIndexOf('if ($Mode -ceq "Validate")')
$capacityRunIndex = $source.LastIndexOf('Invoke-CapacityRunUnderMutex $configuration')
Assert-Condition ($runAuthorizationIndex -ge 0 -and
    $runAuthorizationCallIndex -gt $runAuthorizationIndex -and
    $toolInitializationIndex -gt $runAuthorizationCallIndex -and
    $configurationReadIndex -gt $toolInitializationIndex -and
    $validateBranchIndex -gt $configurationReadIndex -and
    $capacityRunIndex -gt $validateBranchIndex) `
    "Run must fail on committed authorization before tool, config, provider, evidence, or traffic work while Validate bypasses the mutating guard."

Assert-Condition ($source -match '"500"\s*=\s*\[ordered\]@\{\s*devices\s*=\s*510;\s*durationSeconds\s*=\s*1800;\s*targetsPerClass\s*=\s*25') `
    "Waf/500 must remain exactly 510 devices, 1,800 seconds, and 25 targets per class."
Assert-Condition ($source -match '"800"\s*=\s*\[ordered\]@\{\s*devices\s*=\s*810;\s*durationSeconds\s*=\s*5400;\s*targetsPerClass\s*=\s*40') `
    "Waf/800 must remain exactly 810 devices, 5,400 seconds, and 40 targets per class."
foreach ($literal in @(
    'LOAD_ENGINEERING_ACCEPTANCE = "true"',
    'LOAD_DIAGNOSTIC_ONLY = "false"',
    'LOAD_ENFORCE_THRESHOLDS = "true"',
    'LOAD_GATE_PROFILE = "launch"',
    'LOAD_SCREENSHOT_BYTES = "40960"',
    'LOAD_TEACHER_HISTORY_WARMUP_MS = "25000"',
    'LOAD_SCREENSHOT_GET_WARMUP_MS = "45000"',
    'LOAD_WORKLOAD_SCHEMA_VERSION = $script:WorkloadSchemaVersion',
    '$script:WorkloadSchemaVersion = "classpilot-tile-batch-v1"',
    '$script:EndpointShapeSha256 = "8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"'
)) {
    Assert-Condition ($source.Contains($literal)) "The immutable harness contract is missing '$literal'."
}

$readConfigSource = $functions["Read-CapacityConfiguration"].Extent.Text
foreach ($contract in @(
    "launch-safe-20260711", "authoritySourceRoot", "authorityStateSha256",
    "authorityOwnershipSha256", "stateSha256", "ownershipSha256",
    "fixturePasswordsPath", "superAdminPasswordPath", "superAdminOperationPath",
    "rollbackApiTaskDefinitionArn", "rollbackWorkerTaskDefinitionArn",
    "db.t4g.medium", "cache.t4g.small"
)) {
    Assert-Condition ($readConfigSource.Contains($contract)) "Configuration must bind $contract."
}
Assert-Condition ($readConfigSource.Contains("Test-IntervalContainsSchedulerTicks")) `
    "Waf/800 must be scheduled across the purge and rollup."
Assert-Condition ($readConfigSource.Contains('$notAfter -le $notBefore')) `
    "A zero-width traffic admission window must be rejected."
Assert-Condition ($readConfigSource.Contains("Waf/500 must have a restoration interval")) `
    "The two stages must have an explicit restoration interval."
Assert-Condition ($readConfigSource.Contains("22 * 60 + 25") -and
    $readConfigSource.Contains("1 * 60 + 10") -and
    $readConfigSource.Contains('$localStartDelta -ne 165') -and
    $readConfigSource.Contains("Test-PathsOverlap")) `
    "Stage windows and all sensitive roots must remain relationship-bound and disjoint."
$continuityResolveIndex = $readConfigSource.IndexOf('$continuityRoot = Resolve-ExternalPath')
$continuityChildIndex = $readConfigSource.IndexOf(
    'Assert-StrictChildPath $continuityRoot (Get-CapacityLoadGatesRoot) "fixture.continuityRoot"'
)
$continuityAclIndex = $readConfigSource.IndexOf(
    'Assert-CurrentUserPrivateAcl $continuityRoot "fixture.continuityRoot" -Directory'
)
Assert-Condition ($continuityResolveIndex -ge 0 -and
    $continuityChildIndex -gt $continuityResolveIndex -and
    $continuityAclIndex -gt $continuityChildIndex) `
    "Configuration must directionally constrain continuity under load-gates immediately after path resolution."
$loadGatesSource = $functions["Get-CapacityLoadGatesRoot"].Extent.Text
$strictChildSource = $functions["Assert-StrictChildPath"].Extent.Text
Assert-Condition ($loadGatesSource.Contains('"SchoolPilot\load-gates"') -and
    $strictChildSource.Contains('$childFull.StartsWith(') -and
    $strictChildSource.Contains('$parentFull + [IO.Path]::DirectorySeparatorChar') -and
    -not $strictChildSource.Contains("Test-PathsOverlap")) `
    "Continuity containment must be directional and separator-bound, not a symmetric overlap check."
foreach ($privateContract in @(
    "Assert-CurrentUserPrivateAcl", "Assert-ExactDirectChildren", "fixture.support.root"
)) {
    Assert-Condition ($readConfigSource.Contains($privateContract)) `
        "Configuration must enforce private provenance contract '$privateContract'."
}

$authoritySource = $functions["Assert-FixtureAuthority"].Extent.Text
foreach ($contract in @(
    "fixture-state.private.json", "fixture-ownership.private.json",
    "teachers.Count -ne 20", "schoolProperties", "officeStaff",
    "hold", "cleanup", "pendingCreateIntents", "createdByTool"
)) {
    Assert-Condition ($authoritySource.Contains($contract)) "Fixture authority validation must cover $contract."
}
Assert-Condition ($authoritySource.Contains("Assert-FixtureSupportDocuments")) `
    "Fixture authority validation must decrypt and validate support documents without ambient credentials."
Assert-Condition ($authoritySource.Contains("AuthorityStatePath") -and
    $authoritySource.Contains("AuthorityOwnershipPath") -and
    $authoritySource.Contains("byte-identical")) `
    "Fixture continuity must be proven byte-identical to the durable launch-safe authority."

$fixturePreparationSource = $functions["Invoke-StageFixturePreparation"].Extent.Text
foreach ($contract in @(
    'CLP_SUPER_ADMIN_BEARER = $null', "CLP_SUPER_ADMIN_EMAIL",
    "CLP_SUPER_ADMIN_PASSWORD", "CLP_FIXTURE_ADMIN_PASSWORD",
    "CLP_FIXTURE_TEACHER_PASSWORD", "CLP_OPERATOR_ALIAS_CONFIRMED",
    "CLP_CANARY_ALIAS_CONFIRMED", '$refreshStartedAt = [DateTimeOffset]::UtcNow',
    "rawOutputPersisted = `$false", "harnessArtifacts"
)) {
    Assert-Condition ($fixturePreparationSource.Contains($contract)) `
        "Fixture preparation must enforce child-only credential/freshness contract '$contract'."
}
Assert-Condition ($fixturePreparationSource.IndexOf('$refreshStartedAt = [DateTimeOffset]::UtcNow') -lt
    $fixturePreparationSource.IndexOf('"refresh"')) `
    "Fixture freshness must be latched immediately before refresh."
Assert-Condition (-not $fixturePreparationSource.Contains("refresh.stdout.log") -and
    -not $fixturePreparationSource.Contains("verify.stderr.log")) `
    "Fixture command output must be hashed and discarded rather than persist secret-adjacent text."

$postureSource = $functions["Get-ProductionPosture"].Extent.Text
$scalingContractSource = $functions["Assert-ProductionScalingContract"].Extent.Text
$wafContractSource = $functions["Assert-EngineeringWafContract"].Extent.Text
foreach ($contract in @(
    "db.t4g.medium", "cache.t4g.small", "DatabaseInsightsMode",
    "PerformanceInsightsRetentionPeriod", "wafv2", "cloudfront",
    "route53", "MeasureLatency", "alarmState"
)) {
    Assert-Condition ($postureSource.Contains($contract)) "Production posture must verify $contract."
}
foreach ($contract in @(
    "schoolpilot-production-api-arrival-scale-up", "cron(45 5 ? * MON-FRI *)",
    "schoolpilot-production-api-arrival-scale-down", "cron(0 16 ? * MON-FRI *)",
    "schoolpilot-production-api-cpu-scaling", "ECSServiceAverageCPUUtilization"
)) {
    Assert-Condition ($scalingContractSource.Contains($contract)) `
        "Production scaling must directly validate '$contract'."
}
foreach ($contract in @(
    "default action must remain exact ALLOW", "DeviceIngestRateLimit", "ApiRateLimit",
    "100000", "50000", "Block", "device-ingest"
)) {
    Assert-Condition ($wafContractSource.Contains($contract)) `
        "Production WAF must directly validate '$contract'."
}
Assert-Condition (-not $postureSource.Contains("default action is not BLOCK")) `
    "Production WAF must never require the construction-impossible default BLOCK posture."
Assert-Condition ($functions["Assert-StageSummary"].Extent.Text.Contains(
    '"expectedTargetsPerClass"'
) -and $functions["Assert-StageSummary"].Extent.Text.Contains(
    '"configuredPrimaryDevices"'
)) "Terminal harness evidence must independently bind exact per-class and primary-device counts."
Assert-Condition ($functions["Get-WorkerExecutionPosture"].Extent.Text.Contains(
    '$containers = @(if ('
)) "Worker container cardinality must remain an explicit array for one-container responses."
$stableProjectionSource = $functions["Get-StableProductionPostureProjection"].Extent.Text
foreach ($contract in @(
    '"Services"', '"ApiTask"', '"WorkerTask"', '"Targets"', '"Scaling"', '"Rds"', '"Redis"',
    '"Nat"', '"Waf"', '"Route53"', '"taskDefinitionArn"', '"subnetSetSha256"',
    '"databaseInsightsMode"', '"nodeType"', '"deviceRuleAction"', '"apiRuleAction"'
)) {
    Assert-Condition ($stableProjectionSource.Contains($contract)) `
        "Stable posture comparison must bind $contract."
}
foreach ($volatileContract in @(
    '"ObservedAtUtc"', '"TaskArn"', '"TaskArnSha256"', '"StartedAtUtc"',
    '"LogGroup"', '"LogStream"', '"LogStreamSha256"'
)) {
    Assert-Condition (-not $stableProjectionSource.Contains($volatileContract)) `
        "Stable posture comparison must exclude replaceable field $volatileContract."
}
$capacityRunSource = $functions["Invoke-CapacityRun"].Extent.Text
$postFailureReadIndex = $capacityRunSource.IndexOf(
    '$postFailurePosture = Get-ProductionPosture $Config'
)
$stablePostFailureIndex = $capacityRunSource.IndexOf(
    '(Get-StableProductionPostureSha256 $postFailurePosture)'
)
$stableBaselineIndex = $capacityRunSource.IndexOf(
    '(Get-StableProductionPostureSha256 $recoveryBaseline)'
)
$fixtureFailureHashIndex = $capacityRunSource.IndexOf(
    'FailureSha256=Get-StringSha256 $stageFailure.Exception.Message'
)
Assert-Condition ($postFailureReadIndex -ge 0 -and
    $stablePostFailureIndex -gt $postFailureReadIndex -and
    $stableBaselineIndex -gt $stablePostFailureIndex -and
    $fixtureFailureHashIndex -gt $stableBaselineIndex) `
    "The real pre-attempt catch must compare stable posture while preserving the fixture failure."

$secretScrubSource = $functions["Get-NonCredentialChildEnvironment"].Extent.Text
foreach ($name in @(
    "CLP_SUPER_ADMIN_BEARER", "CLP_SUPER_ADMIN_EMAIL", "CLP_SUPER_ADMIN_PASSWORD",
    "CLP_FIXTURE_ADMIN_PASSWORD", "CLP_FIXTURE_TEACHER_PASSWORD",
    "CLP_OPERATOR_ALIAS_CONFIRMED", "CLP_CANARY_ALIAS_CONFIRMED"
)) {
    Assert-Condition ($secretScrubSource.Contains("$name = `$null")) `
        "Non-fixture children must explicitly scrub $name."
}
Assert-Condition ($functions["Get-HarnessEnvironment"].Extent.Text.Contains(
    "Get-NonCredentialChildEnvironment"
)) "Harness children must inherit the explicit secret scrub."
Assert-Condition ($functions["Invoke-MonitorValidation"].Extent.Text.Contains(
    "Get-NonCredentialChildEnvironment"
) -and $functions["Invoke-StageAttempt"].Extent.Text.Contains(
    "Get-NonCredentialChildEnvironment"
)) `
    "Monitor validation and monitoring children must inherit the explicit secret scrub."

$validationSource = $functions["Invoke-RunnerValidation"].Extent.Text
foreach ($readOnlyRequirement in @(
    "Assert-RepositoryIdentity", "Assert-FixtureAuthority",
    "Assert-RollbackCompatibility", "Get-ProductionPosture",
    "Invoke-MonitorValidation", "Get-CurrentGeneratorIpv4",
    "Assert-PlannedWindowsSchedulable"
)) {
    Assert-Condition ($validationSource.Contains($readOnlyRequirement)) `
        "Validate must perform read-only $readOnlyRequirement."
}
foreach ($mutation in @("Set-SixApiCapacity", "Restore-Scaling", "Invoke-ApplicationRollback", "Invoke-StageFixturePreparation")) {
    Assert-Condition (-not $validationSource.Contains($mutation)) "Validate must not call mutation $mutation."
}

$stageAttemptSource = $functions["Invoke-StageAttempt"].Extent.Text
$monitorStartIndex = $stageAttemptSource.IndexOf('$monitorChild = Start-SupervisedProcess')
$heartbeatIndex = $stageAttemptSource.IndexOf('Assert-MonitorHeartbeat')
$startGateIndex = $stageAttemptSource.IndexOf('Write-AtomicJson $startGatePath')
Assert-Condition ($monitorStartIndex -ge 0 -and $heartbeatIndex -gt $monitorStartIndex -and
    $startGateIndex -gt $heartbeatIndex) `
    "The monitor must start and commit a healthy heartbeat before the harness start gate."
Assert-Condition ($stageAttemptSource.Contains("Get-ProductionPosture `$Config") -and
    $stageAttemptSource.LastIndexOf("Get-ProductionPosture `$Config") -lt $startGateIndex) `
    "Production posture must be rechecked before traffic release."
$finallyIndex = $stageAttemptSource.IndexOf("finally")
$restoreIndex = $stageAttemptSource.IndexOf("Restore-Scaling", $finallyIndex)
$piIndex = $stageAttemptSource.IndexOf("Get-StandardPiContextBestEffort", $restoreIndex)
Assert-Condition ($finallyIndex -ge 0 -and $restoreIndex -gt $finallyIndex -and $piIndex -gt $restoreIndex) `
    "Scaling restoration must run in finally before informational Standard PI collection."
Assert-Condition ($stageAttemptSource.Contains('$AttemptNumber -eq 1 -and -not $startedTraffic') -and
    $stageAttemptSource.Contains('$restoration.restored -eq $true') -and
    $stageAttemptSource.Contains("Assert-NoTrafficProgress")) `
    "Only one exact no-gate/no-progress/restored pretraffic retry may be admitted."
Assert-Condition ($stageAttemptSource.Contains("Get-Zero57014Evidence")) `
    "Every coherent stage must collect the zero-57014 gate."
Assert-Condition ($stageAttemptSource.Contains("Get-ProductionPosture `$Config -HeldCapacity")) `
    "The pretraffic gate must validate the intentional six-task scaling hold, not the restored baseline."
Assert-Condition ($stageAttemptSource.Contains("Get-Waf800MaintenanceWindowEvidence") -and
    $stageAttemptSource.Contains('"maintenance_window_application_failure"') -and
    $stageAttemptSource.Contains('"maintenance_window_evidence_unavailable"')) `
    "Waf/800 must seal a strict worker purge/rollup maintenance-window gate."
Assert-Condition ($stageAttemptSource.Contains(
    "Restore-Scaling `$Config `$initialPosture -AfterApplicationRollback"
) -and -not $stageAttemptSource.Contains(
    '$restoration.restored -eq $true -and' + [Environment]::NewLine + '            $applicationFailure'
)) "Application rollback and its rollback-aware final scaling proof must not depend on initial restoration success."
$controllerIntentIndex = $stageAttemptSource.LastIndexOf(
    '$applicationRollback = New-ApplicationRollbackIntent $Config'
)
$controllerMutationIndex = $stageAttemptSource.LastIndexOf(
    '$applicationRollback = Invoke-ApplicationRollback $Config'
)
Assert-Condition ($controllerIntentIndex -ge 0 -and
    $controllerMutationIndex -gt $controllerIntentIndex -and
    $stageAttemptSource.IndexOf(
        'Write-AtomicJson (', $controllerIntentIndex
    ) -lt $controllerMutationIndex) `
    "Controller rollback intent must be durable before the first ECS task-definition mutation."
$trafficWaitSource = $functions["Wait-ForTrafficWindow"].Extent.Text
$processWaitSource = $functions["Wait-ForStageProcesses"].Extent.Text
Assert-Condition ($trafficWaitSource.Contains("Write-GeneratorIpEvidence") -and
    $trafficWaitSource.Contains("AddSeconds(60)") -and
    $processWaitSource.Contains("Write-GeneratorIpEvidence") -and
    $processWaitSource.Contains("AddSeconds(60)")) `
    "Generator-IP evidence must be replaced every minute before and throughout traffic."

$maintenanceSource = $functions["Get-Waf800MaintenanceWindowEvidence"].Extent.Text
foreach ($contract in @(
    "Get-WorkerExecutionPosture", "Get-WorkerWindowLogSnapshot",
    "heartbeatCoverage", "schedulerFailureCount", "heavyJobOverrunObserved",
    "stableSnapshotSha256"
)) {
    Assert-Condition ($maintenanceSource.Contains($contract)) `
        "Maintenance-window evidence must bind '$contract'."
}
$workerSnapshotSource = $functions["Get-WorkerWindowLogSnapshot"].Extent.Text
foreach ($contract in @(
    "scheduler_failure", "Heartbeat purge error", "Daily usage rollup error",
    "Heavy job already running, skipping this tick", "WorkerHeartbeat",
    "pageCount -gt 100", "events.Count -gt 10000", "pagination cycled"
)) {
    Assert-Condition ($workerSnapshotSource.Contains($contract)) `
        "Worker log collection must enforce '$contract'."
}

$stageSource = $functions["Invoke-CapacityStage"].Extent.Text
$deferIndex = $stageSource.IndexOf("TrafficStartNotBeforeUtc.AddMinutes(-35)")
$fixtureIndex = $stageSource.IndexOf("Invoke-StageFixturePreparation")
Assert-Condition ($deferIndex -ge 0 -and $fixtureIndex -gt $deferIndex) `
    "Stage fixture preparation and child launch must be deferred until near its traffic window."

$runSource = $functions["Invoke-CapacityRun"].Extent.Text
Assert-Condition ($runSource.Contains("if (-not `$result.Accepted)") -and
    $runSource.IndexOf("if (-not `$result.Accepted)") -lt
        $runSource.LastIndexOf('Write-PlainReportBestEffort $Config "ACCEPTED"')) `
    "Waf/500 rejection must block Waf/800 and final acceptance."
Assert-Condition ($runSource.Contains("Read-RawCapacityOutcome") -and
    $runSource.Contains("reportReformattedFromRawEvidence") -and
    $runSource.Contains("workload rerun is prohibited")) `
    "A consumed evidence root must permit read-only raw reporting but never another workload."
Assert-Condition ($runSource.IndexOf("Repair-InterruptedApplicationRollback") -ge 0 -and
    $runSource.IndexOf("Repair-InterruptedApplicationRollback") -lt
        $runSource.IndexOf("Read-RawCapacityOutcome")) `
    "Report-only restart must repair an exact pending rollback before raw outcome parsing."
Assert-Condition ($runSource.IndexOf("Invoke-TopLevelReadOnlyPreflight") -ge 0 -and
    $runSource.IndexOf("Invoke-TopLevelReadOnlyPreflight") -lt
        $runSource.IndexOf("New-Item -ItemType Directory -Path `$Config.EvidenceRoot") -and
    $runSource.Contains("Test-ReadOnlyProviderFailure") -and
    $runSource.Contains("Write-TopLevelPreflightTerminalFailure")) `
    "Run preflight must precede evidence-root creation, retry one read-only provider fault, and consume failure."

$rollbackSource = $functions["Invoke-ApplicationRollback"].Extent.Text
foreach ($contract in @(
    "RollbackApiTaskDefinitionArn", "RollbackWorkerTaskDefinitionArn",
    "Wait-TargetHealth `$Config `$ExpectedApiCount",
    "retryDelays", "apiUpdateAccepted", "workerUpdateAccepted",
    "desiredCount -eq `$ExpectedApiCount", "worker[0].desiredCount -eq 1"
)) {
    Assert-Condition ($rollbackSource.Contains($contract)) "Application rollback must verify $contract."
}
$restoreScalingSource = $functions["Restore-Scaling"].Extent.Text
Assert-Condition (
    $restoreScalingSource.Contains('if ($AfterApplicationRollback)') -and
    $restoreScalingSource.Contains(
        'Invoke-ApplicationRollback $Config ([int]$original.Services.api.desired)'
    )
) "Final controller restoration must idempotently reassert both prior application revisions."
$classificationSource = $functions["Test-ApplicationFailure"].Extent.Text
Assert-Condition ($classificationSource.Contains("monitorApplicationPattern") -and
    $classificationSource.Contains("functionalFatalPattern")) `
    "Rollback causes must use explicit monitor, summary, and fatal application allowlists."
foreach ($forbiddenCause in @("rds_", "redis_", "evidence_", "telemetry_", "run_acceptance_failed")) {
    Assert-Condition (-not $classificationSource.Contains($forbiddenCause)) `
        "Cause-specific application rollback must exclude $forbiddenCause."
}

$zeroSource = $functions["Get-Zero57014Evidence"].Extent.Text
Assert-Condition ($zeroSource.Contains("AddMinutes(5)") -and $zeroSource.Contains("AddMinutes(15)") -and
    $zeroSource.Contains('$snapshot.canonicalSha256 -ceq $previousHash')) `
    "The zero-57014 gate must tolerate publication delay and require two stable snapshots."
$piSource = $functions["Get-StandardPiContextBestEffort"].Extent.Text
Assert-Condition ($piSource.Contains('informationalOnly = $true') -and
    $piSource.Contains('databaseInsightsMode = "standard"') -and
    $piSource.Contains('passed = $null') -and
    $piSource.Contains("standard_pi_context_unavailable")) `
    "Standard PI context must be informational and fail open."
Assert-Condition ($source -notmatch 'DatabaseInsightsMode\s*=\s*"advanced"|queryIdentity|query.?id-bound') `
    "The runner must not introduce Advanced PI or query-identity acceptance."

# Load a small, side-effect-free subset of the runner functions for behavioral checks.
foreach ($name in @(
    "Get-Value", "Assert-ExactKeys", "Get-RequiredString", "Get-UtcTimestamp", "Read-JsonFile",
    "Read-CapacityAcceptanceAuthorization", "Assert-CapacityAcceptanceRunAuthorized",
    "Assert-FixtureVerification",
    "Get-StringSha256", "Get-CanonicalSha256", "Assert-Sha256",
    "Resolve-ExternalPath", "Get-CapacityLoadGatesRoot", "Assert-StrictChildPath",
    "Test-PathsOverlap", "Get-StableProductionPostureProjection",
    "Get-StableProductionPostureSha256",
    "Write-AtomicJson", "Write-AtomicJsonReplace",
    "Invoke-BoundedProcess",
    "Assert-PlannedWindowsSchedulable", "Assert-NoTrafficProgress", "Test-ApplicationFailure",
    "Get-NonCredentialChildEnvironment", "Get-HarnessEnvironment",
    "ConvertTo-WindowsProcessArgument", "Start-SupervisedProcess",
    "Complete-SupervisedProcess", "Dispose-SupervisedProcess",
    "Assert-ProductionScalingContract", "Assert-HeldCapacityPosture",
    "Get-EngineeringWafDeviceLabel",
    "Assert-EngineeringWafContract", "Get-RunRecoveryBaseline",
    "Test-ReadOnlyProviderFailure", "Test-PreflightApplicationHealthFailure",
    "Invoke-TopLevelReadOnlyPreflight", "Write-TopLevelPreflightTerminalFailure",
    "Get-Zero57014Evidence", "Assert-CurrentUserPrivateAcl", "Set-CurrentUserPrivateAcl",
    "Assert-StageSummary", "Assert-MonitorResult", "Assert-MonitorScalingRestoration",
    "Get-MonitorOwnedApplicationRollback",
    "Assert-ControllerScalingRestoration", "Get-CapacityRunMutexName",
    "Get-CapacityCampaignLockPath", "Get-CapacityCampaignAdmission",
    "Assert-CapacityCampaignAdmission", "Enter-CapacityCampaignAdmission",
    "Get-CapacityRunIdentity", "Assert-CapacityRunIdentity",
    "Get-WorkerExecutionPosture",
    "Get-WorkerWindowLogSnapshot", "Get-Waf800MaintenanceWindowEvidence",
    "Write-GeneratorIpEvidence", "Wait-ForTrafficWindow", "Wait-ForStageProcesses",
    "Add-PlainStageEvidenceLines", "Write-PlainReportBestEffort",
    "Assert-BoundChildProcessExited", "Get-AttemptTrafficStarted",
    "Read-RawStageOutcome", "Read-RawStageOutcomeSafely", "Read-RawCapacityOutcome",
    "Repair-InterruptedApplicationRollback",
    "Invoke-RunnerValidation", "Invoke-StageAttempt", "Invoke-CapacityStage",
    "Invoke-CapacityRun", "Invoke-CapacityRunUnderMutex",
    "New-ApplicationRollbackIntent", "Invoke-ApplicationRollback", "Restore-Scaling"
)) {
    Invoke-Expression $functions[$name].Extent.Text
}
$script:CapacityAcceptanceAuthorizationPath = $authorizationPath
Assert-Throws {
    Assert-CapacityAcceptanceRunAuthorized
} "Capacity acceptance is paused" `
    "The committed paused authorization must reject runner Run."

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "schoolpilot-capacity-test-{0}" -f [Guid]::NewGuid().ToString("N")
)
New-Item -ItemType Directory -Path $tempRoot | Out-Null
Set-CurrentUserPrivateAcl $tempRoot -Directory
$originalLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = Join-Path $tempRoot "local-app-data"
try {
    $nodeTimestamp = & (Get-Command node).Source -e (
        'process.stdout.write(new Date("2026-07-29T02:10:05.517Z").toISOString())'
    )
    Assert-Condition ($LASTEXITCODE -eq 0 -and $nodeTimestamp -ceq "2026-07-29T02:10:05.517Z") `
        "The cross-runtime regression must exercise Node's exact ISO timestamp output."

    $acceptedTimestampCases = @(
        [pscustomobject]@{
            Value = "2026-07-29T02:10:05.5Z"
            Expected = "2026-07-29T02:10:05.5000000+00:00"
        },
        [pscustomobject]@{
            Value = $nodeTimestamp
            Expected = "2026-07-29T02:10:05.5170000+00:00"
        },
        [pscustomobject]@{
            Value = "2026-07-29T02:10:05.5170000Z"
            Expected = "2026-07-29T02:10:05.5170000+00:00"
        },
        [pscustomobject]@{
            Value = "2026-07-29T02:10:05.5170000+00:00"
            Expected = "2026-07-29T02:10:05.5170000+00:00"
        }
    )
    foreach ($case in $acceptedTimestampCases) {
        $actual = Get-UtcTimestamp ([pscustomobject]@{ timestamp = $case.Value }) `
            "timestamp" "cross-runtime timestamp"
        Assert-Condition ($actual.ToString("o") -ceq $case.Expected) `
            "The exact UTC timestamp '$($case.Value)' must normalize without losing precision."
    }
    Assert-Condition (
        (Get-UtcTimestamp ([pscustomobject]@{ timestamp = $nodeTimestamp }) `
            "timestamp" "Node timestamp") -eq
        (Get-UtcTimestamp ([pscustomobject]@{
            timestamp = "2026-07-29T02:10:05.5170000+00:00"
        }) "timestamp" ".NET timestamp")
    ) "Equivalent Node and .NET UTC timestamps must represent the same instant."

    foreach ($rejectedTimestamp in @(
        "2026-07-29T02:10:05",
        "2026-07-29T02:10:05Z",
        "2026-07-29T02:10:05.517-04:00",
        "2026-07-29T02:10:05.517+01:00",
        "2026-07-29T02:10:05.517z",
        " 2026-07-29T02:10:05.517Z",
        "2026-07-29T02:10:05.517Z ",
        "2026-07-29T02:10:05.12345678Z",
        "2026-02-30T02:10:05.517Z",
        "2026-07-29 02:10:05.517Z"
    )) {
        Assert-Throws {
            Get-UtcTimestamp ([pscustomobject]@{ timestamp = $rejectedTimestamp }) `
                "timestamp" "cross-runtime timestamp" | Out-Null
        } "ISO-8601 timestamp with an explicit zero offset" `
            "The malformed or non-UTC timestamp '$rejectedTimestamp' must fail closed."
    }

    $verificationIngressPath = Join-Path $tempRoot "fixture-verification.json"
    [IO.File]::WriteAllText(
        $verificationIngressPath,
        (@{
            schemaVersion = 1
            passed = $true
            verifiedAt = $nodeTimestamp
            counts = @{
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
                authorizationPlanCohorts = @{
                    coTeacherStudents = 40
                    officeSupervisionStudents = 40
                }
                liveAuth = @{ commandAdministrators = 1; teachers = 20 }
            }
            gates = @{
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
        } | ConvertTo-Json -Depth 10),
        [Text.UTF8Encoding]::new($false)
    )
    $verificationIngress = Read-JsonFile $verificationIngressPath `
        "cross-runtime fixture verification"
    Assert-FixtureVerification $verificationIngress
    Assert-Condition (
        (Get-UtcTimestamp $verificationIngress "verifiedAt" "fixture verification").ToString("o") `
            -ceq "2026-07-29T02:10:05.5170000+00:00"
    ) "A verifier-shaped JSON artifact must preserve and accept Node timestamp precision."

    $harnessReadyIngress = (
        '{"readyAt":"2026-07-29T02:10:05.517Z"}' |
            ConvertFrom-Json -DateKind String
    )
    $harnessProgressIngress = (
        '{"timestamp":"2026-07-29T02:10:05.518Z"}' |
            ConvertFrom-Json -DateKind String
    )
    Assert-Condition (
        (Get-UtcTimestamp $harnessReadyIngress "readyAt" "harness ready gate").Offset -eq
            [TimeSpan]::Zero -and
        (Get-UtcTimestamp $harnessProgressIngress "timestamp" "harness progress").Offset -eq
            [TimeSpan]::Zero
    ) "Harness-ready and progress JSON must accept Node ISO timestamps."

    $secretEnvironmentNames = @(
        "CLP_SUPER_ADMIN_BEARER", "CLP_SUPER_ADMIN_EMAIL", "CLP_SUPER_ADMIN_PASSWORD",
        "CLP_FIXTURE_ADMIN_PASSWORD", "CLP_FIXTURE_TEACHER_PASSWORD",
        "CLP_OPERATOR_ALIAS_CONFIRMED", "CLP_CANARY_ALIAS_CONFIRMED"
    )
    foreach ($name in $secretEnvironmentNames) {
        [Environment]::SetEnvironmentVariable($name, "stale-parent-value", "Process")
    }
    try {
        $scrub = Get-NonCredentialChildEnvironment
        Assert-Condition (@($secretEnvironmentNames | Where-Object {
            $scrub.ContainsKey($_) -and $null -eq $scrub[$_]
        }).Count -eq $secretEnvironmentNames.Count) `
            "Every secret-adjacent fixture variable must be explicitly removed from non-fixture children."
        $child = Invoke-BoundedProcess -FilePath (Get-Command pwsh).Source -Arguments @(
            "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            '$names=@("CLP_SUPER_ADMIN_BEARER","CLP_SUPER_ADMIN_EMAIL","CLP_SUPER_ADMIN_PASSWORD",' +
            '"CLP_FIXTURE_ADMIN_PASSWORD","CLP_FIXTURE_TEACHER_PASSWORD",' +
            '"CLP_OPERATOR_ALIAS_CONFIRMED","CLP_CANARY_ALIAS_CONFIRMED");' +
            'if(@($names|?{[Environment]::GetEnvironmentVariable($_)}).Count){exit 9};"scrubbed"'
        ) -Environment $scrub -TimeoutSeconds 30
        Assert-Condition ($child.ExitCode -eq 0 -and $child.Stdout.Trim() -ceq "scrubbed") `
            "A real child process must not inherit stale refresh/verify credentials or alias confirmations."
    }
    finally {
        foreach ($name in $secretEnvironmentNames) {
            [Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
    }

    Assert-Condition (Test-PathsOverlap (Join-Path $tempRoot "a") (Join-Path $tempRoot "a\b")) `
        "Nested sensitive paths must be detected as overlapping."
    Assert-Condition (-not (Test-PathsOverlap (Join-Path $tempRoot "a") (Join-Path $tempRoot "b"))) `
        "Sibling sensitive paths must remain independently usable."

    $loadGatesRoot = Get-CapacityLoadGatesRoot
    $validContinuityRoot = Join-Path $loadGatesRoot "capacity-acceptance\run-a\deep\continuity"
    [void][IO.Directory]::CreateDirectory($validContinuityRoot)
    Assert-StrictChildPath $validContinuityRoot $loadGatesRoot "fixture.continuityRoot"
    Assert-Throws {
        Assert-StrictChildPath (
            Join-Path (Split-Path -Parent $loadGatesRoot) "load-gates-sibling\continuity"
        ) $loadGatesRoot "fixture.continuityRoot"
    } "strict child" "A sibling continuity root must be rejected."
    Assert-Throws {
        Assert-StrictChildPath (
            "{0}-archive{1}continuity" -f $loadGatesRoot,[IO.Path]::DirectorySeparatorChar
        ) $loadGatesRoot "fixture.continuityRoot"
    } "strict child" "A load-gates prefix collision must be rejected."
    Assert-Throws {
        Assert-StrictChildPath (Split-Path -Parent $loadGatesRoot) `
            $loadGatesRoot "fixture.continuityRoot"
    } "strict child" "A parent of load-gates must be rejected."
    $inheritedAclContinuityRoot = Join-Path $loadGatesRoot (
        "capacity-acceptance\inherited-acl\continuity"
    )
    [void][IO.Directory]::CreateDirectory($inheritedAclContinuityRoot)
    Assert-StrictChildPath $inheritedAclContinuityRoot $loadGatesRoot "fixture.continuityRoot"
    Assert-Throws {
        Assert-CurrentUserPrivateAcl $inheritedAclContinuityRoot `
            "fixture.continuityRoot" -Directory
    } "protected current-user" `
        "A path-valid continuity root with inherited or broad ACLs must be rejected."

    $junctionTarget = Join-Path $tempRoot "continuity-junction-target"
    [void][IO.Directory]::CreateDirectory($junctionTarget)
    $junctionPath = Join-Path $loadGatesRoot "capacity-acceptance\junction-continuity"
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $junctionPath))
    [void](New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget -ErrorAction Stop)
    try {
        Assert-Throws {
            Resolve-ExternalPath $junctionPath "fixture.continuityRoot" | Out-Null
        } "reparse point" "Continuity resolution must reject a junction under load-gates."
    }
    finally {
        if (Test-Path -LiteralPath $junctionPath) {
            [IO.Directory]::Delete($junctionPath, $false)
        }
    }

    $stablePosture = [pscustomobject]@{
        ObservedAtUtc = "2026-07-27T20:00:00.0000000+00:00"
        Services = [pscustomobject]@{
            api = [pscustomobject]@{
                desired=1;running=1;pending=0
                taskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/api:31"
                assignPublicIp="DISABLED";subnetSetSha256=("1" * 64)
            }
            worker = [pscustomobject]@{
                desired=1;running=1;pending=0
                taskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:48"
                assignPublicIp="DISABLED";subnetSetSha256=("2" * 64)
            }
        }
        ApiTask = [pscustomobject]@{
            Arn="arn:aws:ecs:us-east-1:135775632425:task-definition/api:31"
            ContainerName="api";Cpu="512";Memory="2048"
            Logging=[pscustomobject]@{Sanitized=[pscustomobject]@{
                driver="awslogs";groupSha256=("3" * 64);streamPrefixSha256=("4" * 64)
            }}
        }
        WorkerTask = [pscustomobject]@{
            Arn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:48"
            ContainerName="scheduler-worker";Cpu="256";Memory="512"
            Logging=[pscustomobject]@{Sanitized=[pscustomobject]@{
                driver="awslogs";groupSha256=("5" * 64);streamPrefixSha256=("6" * 64)
            }}
        }
        WorkerExecution = [pscustomobject]@{
            TaskArn="arn:aws:ecs:us-east-1:135775632425:task/old"
            TaskArnSha256=("7" * 64)
            TaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:48"
            StartedAtUtc="2026-07-27T19:00:00.0000000+00:00"
            LogGroup="/ecs/worker";LogStream="worker/scheduler-worker/old"
            LogStreamSha256=("8" * 64)
        }
        Targets=[pscustomobject]@{total=1;healthy=1;nonHealthy=0}
        Scaling=[pscustomobject]@{
            resourceId="service/cluster/api";minCapacity=1;maxCapacity=6
            suspendedState=[pscustomobject]@{
                DynamicScalingInSuspended=$false
                DynamicScalingOutSuspended=$false
                ScheduledScalingSuspended=$false
            }
            scheduledActionsSha256=("9" * 64);scalingPoliciesSha256=("a" * 64)
        }
        Rds=[pscustomobject]@{
            instanceClass="db.t4g.medium";status="available";publiclyAccessible=$false
            databaseInsightsMode="standard";performanceInsightsEnabled=$true
            performanceInsightsRetentionPeriod=7;dbiResourceId="db-resource"
            dbiResourceIdSha256=("b" * 64)
        }
        Redis=[pscustomobject]@{
            status="available";nodeType="cache.t4g.small";replicationGroupSha256=("c" * 64)
        }
        Nat=[pscustomobject]@{availableCount=2}
        Waf=[pscustomobject]@{
            name="production-waf";defaultAction="ALLOW";webAclSha256=("d" * 64)
            cloudFrontAssociationVerified=$true;deviceRuleAction="BLOCK";apiRuleAction="BLOCK"
        }
        Route53=[pscustomobject]@{
            measureLatency=$true;alarmState="OK";healthCheckSha256=("e" * 64)
        }
    }
    $stablePostureHash = Get-StableProductionPostureSha256 $stablePosture
    $volatileOnlyPosture = $stablePosture | ConvertTo-Json -Depth 20 |
        ConvertFrom-Json -DateKind String -Depth 20
    $volatileOnlyPosture.ObservedAtUtc = "2026-07-28T01:00:00.0000000+00:00"
    $volatileOnlyPosture.WorkerExecution.TaskArn =
        "arn:aws:ecs:us-east-1:135775632425:task/replacement"
    $volatileOnlyPosture.WorkerExecution.TaskArnSha256 = "f" * 64
    $volatileOnlyPosture.WorkerExecution.StartedAtUtc = "2026-07-28T00:59:00.0000000+00:00"
    $volatileOnlyPosture.WorkerExecution.LogGroup = "/ecs/replacement-worker"
    $volatileOnlyPosture.WorkerExecution.LogStream = "worker/scheduler-worker/replacement"
    $volatileOnlyPosture.WorkerExecution.LogStreamSha256 = "0" * 64
    Assert-Condition (
        (Get-StableProductionPostureSha256 $volatileOnlyPosture) -ceq $stablePostureHash
    ) "Observation time and replaceable worker execution identity must not create posture drift."

    $stablePostureMutations = @(
        [pscustomobject]@{Name="RDS instance class";Apply={
            param($p);$p.Rds.instanceClass="db.t4g.large"
        }},
        [pscustomobject]@{Name="Database Insights mode";Apply={
            param($p);$p.Rds.databaseInsightsMode="advanced"
        }},
        [pscustomobject]@{Name="Redis node type";Apply={
            param($p);$p.Redis.nodeType="cache.t4g.micro"
        }},
        [pscustomobject]@{Name="WAF device action";Apply={
            param($p);$p.Waf.deviceRuleAction="COUNT"
        }},
        [pscustomobject]@{Name="WAF API action";Apply={
            param($p);$p.Waf.apiRuleAction="COUNT"
        }},
        [pscustomobject]@{Name="scaling maximum";Apply={
            param($p);$p.Scaling.maxCapacity=9
        }},
        [pscustomobject]@{Name="API service task definition";Apply={
            param($p);$p.Services.api.taskDefinitionArn=
                "arn:aws:ecs:us-east-1:135775632425:task-definition/api:32"
        }},
        [pscustomobject]@{Name="worker service subnet";Apply={
            param($p);$p.Services.worker.subnetSetSha256="0" * 64
        }},
        [pscustomobject]@{Name="worker execution task definition";Apply={
            param($p);$p.WorkerExecution.TaskDefinitionArn=
                "arn:aws:ecs:us-east-1:135775632425:task-definition/worker:49"
        }},
        [pscustomobject]@{Name="NAT topology";Apply={
            param($p);$p.Nat.availableCount=1
        }},
        [pscustomobject]@{Name="Route53 topology";Apply={
            param($p);$p.Route53.measureLatency=$false
        }}
    )
    foreach ($mutation in $stablePostureMutations) {
        $driftedPosture = $stablePosture | ConvertTo-Json -Depth 20 |
            ConvertFrom-Json -DateKind String -Depth 20
        & $mutation.Apply $driftedPosture
        Assert-Condition (
            (Get-StableProductionPostureSha256 $driftedPosture) -cne $stablePostureHash
        ) "Stable posture comparison must reject $($mutation.Name) drift."
    }

    $scheduleNow = [DateTimeOffset]::Parse("2026-07-27T20:00:00+00:00")
    $scheduleConfig = [pscustomobject]@{Stages=@(
        [pscustomobject]@{
            TrafficStartNotBeforeUtc=$scheduleNow.AddHours(6)
            TrafficStartNotAfterUtc=$scheduleNow.AddHours(6).AddMinutes(6)
        },
        [pscustomobject]@{
            TrafficStartNotBeforeUtc=$scheduleNow.AddHours(8).AddMinutes(45)
            TrafficStartNotAfterUtc=$scheduleNow.AddHours(8).AddMinutes(51)
        }
    )}
    Assert-PlannedWindowsSchedulable $scheduleConfig $scheduleNow
    $scheduleConfig.Stages[0].TrafficStartNotAfterUtc = $scheduleNow.AddSeconds(-1)
    Assert-Throws {
        Assert-PlannedWindowsSchedulable $scheduleConfig $scheduleNow
    } "current and schedulable" "Validation must reject an expired Waf/500 window."
    $scheduleConfig.Stages[0].TrafficStartNotAfterUtc = $scheduleNow.AddHours(6).AddMinutes(6)
    $scheduleConfig.Stages[0].TrafficStartNotBeforeUtc = $scheduleNow.AddHours(31)
    Assert-Throws {
        Assert-PlannedWindowsSchedulable $scheduleConfig $scheduleNow
    } "current and schedulable" "Validation must reject a window outside the current operational cycle."

    $generatorRoot = Join-Path $tempRoot "generator-heartbeat"
    New-Item -ItemType Directory -Path $generatorRoot | Out-Null
    Set-CurrentUserPrivateAcl $generatorRoot -Directory
    $generatorPath = Join-Path $generatorRoot "generator-ip.json"
    $script:currentGeneratorIp = "203.0.113.7"
    function Get-CurrentGeneratorIpv4 { return $script:currentGeneratorIp }
    $generatorConfig = [pscustomobject]@{ ExpectedGeneratorPublicIp = "203.0.113.7" }
    $generatorStage = [pscustomobject]@{ RunId = "generator-heartbeat-stage" }
    foreach ($simulatedMinute in 0..3) {
        if (Test-Path -LiteralPath $generatorPath) {
            (Get-Item -LiteralPath $generatorPath).LastWriteTimeUtc = [DateTime]::UtcNow.AddSeconds(-61)
        }
        Write-GeneratorIpEvidence $generatorConfig $generatorStage $generatorPath
        $generatorEvidence = Read-JsonFile $generatorPath "generator IP regression evidence"
        Assert-Condition ($generatorEvidence.actualPublicIp -ceq "203.0.113.7") `
            "Repeated generator-IP replacement must remain exact."
    }
    Assert-Condition (
        ([DateTime]::UtcNow - (Get-Item -LiteralPath $generatorPath).LastWriteTimeUtc).TotalSeconds -lt 10
    ) "Four simulated minute heartbeats (>150 seconds) must keep one replaceable evidence path fresh."
    $script:currentGeneratorIp = "203.0.113.8"
    Assert-Throws {
        Write-GeneratorIpEvidence $generatorConfig $generatorStage $generatorPath
    } "does not match the bound config" "Generator-IP drift must terminate the stage."

    function Assert-PlannedWindowsSchedulable { param($Config) }
    $script:currentGeneratorIp = "203.0.113.7"
    function Assert-RepositoryIdentity { param($Config) }
    function Assert-FixtureAuthority { param($Config) }
    function Assert-RollbackCompatibility { param($Config) }
    function Get-ProductionPosture { param($Config); return [ordered]@{healthy=$true} }
    $validationConfig = [pscustomobject]@{
        ExpectedGeneratorPublicIp="203.0.113.7";Stages=@();RunId="validation"
        ApplicationGitSha=("a" * 40);ImageDigest=("sha256:" + ("b" * 64))
    }
    $validation = Invoke-RunnerValidation $validationConfig
    Assert-Condition ($validation.valid -eq $true -and
        $validation.generatorIpv4Sha256 -eq (Get-StringSha256 "203.0.113.7")) `
        "Validate must admit and hash-bind the exact current generator IPv4."
    $validationConfig.ExpectedGeneratorPublicIp = "203.0.113.8"
    Assert-Throws {
        Invoke-RunnerValidation $validationConfig | Out-Null
    } "current generator IPv4" "Validate must reject generator-IP drift."

    $scalingContract = [pscustomobject]@{
        minCapacity=1;maxCapacity=6
        suspendedState=[pscustomobject]@{
            DynamicScalingInSuspended=$false
            DynamicScalingOutSuspended=$false
            ScheduledScalingSuspended=$false
        }
        scheduledActions=@(
            [pscustomobject]@{
                name="schoolpilot-production-api-arrival-scale-up"
                schedule="cron(45 5 ? * MON-FRI *)";timezone="America/New_York"
                minCapacity=3;maxCapacity=$null
            },
            [pscustomobject]@{
                name="schoolpilot-production-api-arrival-scale-down"
                schedule="cron(0 16 ? * MON-FRI *)";timezone="America/New_York"
                minCapacity=1;maxCapacity=$null
            }
        )
        scalingPolicies=@(
            [pscustomobject]@{
                name="schoolpilot-production-api-cpu-scaling"
                type="TargetTrackingScaling"
                targetTracking=[pscustomobject]@{
                    TargetValue=70.0;ScaleInCooldown=300;ScaleOutCooldown=60
                    PredefinedMetricSpecification=[pscustomobject]@{
                        PredefinedMetricType="ECSServiceAverageCPUUtilization"
                    }
                }
            }
        )
    }
    Assert-ProductionScalingContract $scalingContract
    $staleArrivalContract = $scalingContract | ConvertTo-Json -Depth 10 | ConvertFrom-Json -Depth 10
    @($staleArrivalContract.scheduledActions | Where-Object name -ceq "schoolpilot-production-api-arrival-scale-up")[0].minCapacity = 6
    Assert-Throws { Assert-ProductionScalingContract $staleArrivalContract } "05:45/16:00" `
        "The superseded six-task arrival minimum must be rejected as drift from the three-task school-day floor."
    $heldScaling = [pscustomobject]@{
        minCapacity=6;maxCapacity=6
        suspendedState=[pscustomobject]@{
            DynamicScalingInSuspended=$false
            DynamicScalingOutSuspended=$true
            ScheduledScalingSuspended=$false
        }
        scheduledActions=$scalingContract.scheduledActions
        scalingPolicies=$scalingContract.scalingPolicies
    }
    $heldServices = [pscustomobject]@{
        api=[pscustomobject]@{desired=6;running=6;pending=0}
        worker=[pscustomobject]@{desired=1;running=1;pending=0}
    }
    $heldTargets = [pscustomobject]@{total=6;healthy=6;nonHealthy=0}
    Assert-HeldCapacityPosture $heldServices $heldTargets $heldScaling
    $heldScaling.suspendedState.ScheduledScalingSuspended = $true
    Assert-Throws {
        Assert-HeldCapacityPosture $heldServices $heldTargets $heldScaling
    } "six-API held-capacity" `
        "The pretraffic held-posture validator must preserve scheduled scaling as a tertiary fail-safe."
    $heldScaling.suspendedState.ScheduledScalingSuspended = $false
    function Invoke-AwsJson {
        param([string[]]$Arguments, [int]$TimeoutSeconds)
        return [pscustomobject]@{
            failures=@()
            services=@(
                [pscustomobject]@{serviceName="api";desiredCount=4},
                [pscustomobject]@{serviceName="worker";desiredCount=1}
            )
        }
    }
    function Get-ScalingSnapshot { param($Config); return $scalingContract }
    $recoveryConfig = [pscustomobject]@{
        WorkerTaskDefinitionArn="arn:worker"
        Resources=[pscustomobject]@{
            region="us-east-1";cluster="cluster";apiService="api";workerService="worker"
        }
    }
    $recoveryBaseline = Get-RunRecoveryBaseline $recoveryConfig
    Assert-Condition ($recoveryBaseline.Services.api.desired -eq 4) `
        "Run recovery must retain an in-flight scalable API desired count, not only schedule minima."

    $wafResources = [pscustomobject]@{
        wafDeviceClassifierMetricName="classifier-metric"
        wafDeviceRuleMetricName="device-metric"
        wafApiRuleMetricName="api-metric"
    }
    $wafContract = [pscustomobject]@{
        DefaultAction=[pscustomobject]@{Allow=[pscustomobject]@{}}
        Rules=@(
            [pscustomobject]@{
                Name="DeviceIngestClassifier";Priority=25
                Action=[pscustomobject]@{Count=[pscustomobject]@{}}
                RuleLabels=@([pscustomobject]@{Name="device-ingest"})
                VisibilityConfig=[pscustomobject]@{
                    MetricName="classifier-metric"
                    CloudWatchMetricsEnabled=$true;SampledRequestsEnabled=$true
                }
                Statement=[pscustomobject]@{AndStatement=[pscustomobject]@{Statements=@(
                    [pscustomobject]@{ByteMatchStatement=[pscustomobject]@{
                        SearchString="POST";PositionalConstraint="EXACTLY"
                        FieldToMatch=[pscustomobject]@{Method=[pscustomobject]@{}}
                    }},
                    [pscustomobject]@{RegexMatchStatement=[pscustomobject]@{
                        RegexString='^/api/(classpilot/)?device/(heartbeat|screenshot)$'
                        FieldToMatch=[pscustomobject]@{UriPath=[pscustomobject]@{}}
                    }}
                )}}
            },
            [pscustomobject]@{
                Name="DeviceIngestRateLimit";Priority=30
                Action=[pscustomobject]@{Block=[pscustomobject]@{}}
                VisibilityConfig=[pscustomobject]@{
                    MetricName="device-metric";CloudWatchMetricsEnabled=$true;SampledRequestsEnabled=$true
                }
                Statement=[pscustomobject]@{RateBasedStatement=[pscustomobject]@{
                    Limit=100000;EvaluationWindowSec=300;AggregateKeyType="IP"
                    ScopeDownStatement=[pscustomobject]@{
                        LabelMatchStatement=[pscustomobject]@{Scope="LABEL";Key="device-ingest"}
                    }
                }}
            },
            [pscustomobject]@{
                Name="ApiRateLimit";Priority=40
                Action=[pscustomobject]@{Block=[pscustomobject]@{}}
                VisibilityConfig=[pscustomobject]@{
                    MetricName="api-metric";CloudWatchMetricsEnabled=$true;SampledRequestsEnabled=$true
                }
                Statement=[pscustomobject]@{RateBasedStatement=[pscustomobject]@{
                    Limit=50000;EvaluationWindowSec=300;AggregateKeyType="IP"
                    ScopeDownStatement=[pscustomobject]@{AndStatement=[pscustomobject]@{Statements=@(
                        [pscustomobject]@{ByteMatchStatement=[pscustomobject]@{
                            SearchString="/api/";PositionalConstraint="STARTS_WITH"
                            FieldToMatch=[pscustomobject]@{UriPath=[pscustomobject]@{}}
                        }},
                        [pscustomobject]@{NotStatement=[pscustomobject]@{
                            Statement=[pscustomobject]@{LabelMatchStatement=[pscustomobject]@{
                                Scope="LABEL";Key="device-ingest"
                            }}
                        }}
                    )}}
                }}
            }
        )
    }
    Assert-EngineeringWafContract $wafContract $wafResources
    $wafContract.DefaultAction = [pscustomobject]@{Block=[pscustomobject]@{}}
    Assert-Throws {
        Assert-EngineeringWafContract $wafContract $wafResources
    } "exact ALLOW" "The production-faithful WAF contract must reject default BLOCK."

    $script:WorkloadSchemaVersion = "classpilot-tile-batch-v1"
    $script:EndpointShapeSha256 = "8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"
    $summaryStage = [pscustomobject]@{
        Stage="500";RunId="summary-profile"
        Profile=[pscustomobject]@{devices=510;durationSeconds=1800;targetsPerClass=25}
    }
    $summaryEvidence = [pscustomobject]@{
        runId="summary-profile";stage="500";diagnosticOnly=$false
        engineeringAcceptance=$true;certificationEligible=$false
        workloadSchemaVersion="classpilot-tile-batch-v1"
        workloadEndpointShapeSha256="8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"
        devices=510;expectedTargetsPerClass=25;configuredPrimaryDevices=500
        declaredSecondSchoolCanaryDevices=10
        run=[pscustomobject]@{
            durationClock="monotonic-hrtime-v1";runtimeTargetTrafficSeconds=1800
            actualTrafficMilliseconds=1800000;completedConfiguredDuration=$true
        }
        thresholds=[pscustomobject]@{enforced=$true;passed=$true}
        fatalGate=$null
    }
    Assert-StageSummary $summaryEvidence $summaryStage
    $summaryEvidence.expectedTargetsPerClass = 24
    Assert-Throws {
        Assert-StageSummary $summaryEvidence $summaryStage
    } "workload profile" "Terminal evidence must reject a mismatched expected target count."
    $summaryEvidence.expectedTargetsPerClass = 25
    $summaryEvidence.configuredPrimaryDevices = 499
    Assert-Throws {
        Assert-StageSummary $summaryEvidence $summaryStage
    } "primary-device accounting" "Terminal evidence must reject mismatched primary-device accounting."

    $workerTaskId = "0123456789abcdef0123456789abcdef"
    $workerTaskArn = "arn:aws:ecs:us-east-1:135775632425:task/cluster/$workerTaskId"
    function Invoke-AwsJson {
        param([string[]]$Arguments, [int]$TimeoutSeconds)
        if ($Arguments[1] -ceq "list-tasks") {
            return [pscustomobject]@{taskArns=@($workerTaskArn)}
        }
        return [pscustomobject]@{
            failures=@()
            tasks=@([pscustomobject]@{
                taskArn=$workerTaskArn
                taskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:1"
                lastStatus="RUNNING";startedAt="2026-07-27T12:00:00+00:00"
                containers=@([pscustomobject]@{
                    name="scheduler-worker";lastStatus="RUNNING";exitCode=$null
                })
            })
        }
    }
    $workerPostureConfig = [pscustomobject]@{
        WorkerTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:1"
        Resources=[pscustomobject]@{
            region="us-east-1";cluster="cluster";workerService="worker"
        }
    }
    $workerTaskDefinition = [pscustomobject]@{
        Logging=[pscustomobject]@{
            Group="/ecs/worker";StreamPrefix="worker/scheduler-worker/"
        }
    }
    $healthyWorker = Get-WorkerExecutionPosture $workerPostureConfig $workerTaskDefinition
    Assert-Condition ($healthyWorker.TaskArn -ceq $workerTaskArn -and
        $healthyWorker.LogStream -ceq "worker/scheduler-worker/$workerTaskId") `
        "One healthy scheduler-worker container must remain deterministically array-typed."

    function New-TestRunConfig {
        param([string]$EvidenceRoot, [string]$Suffix)
        $now = [DateTimeOffset]::UtcNow
        return [pscustomobject]@{
            RunId="capacity-$Suffix"
            EvidenceRoot=$EvidenceRoot
            ReportPath=(Join-Path $tempRoot "capacity-$Suffix.txt")
            Sha256=("1" * 64)
            ApplicationGitSha=("2" * 40)
            ImageDigest=("sha256:" + ("3" * 64))
            ApiTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/api:1"
            WorkerTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:1"
            RollbackApiTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/api:0"
            RollbackWorkerTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:0"
            Stages=@(
                [pscustomobject]@{
                    Stage="500";RunId="waf500-$Suffix"
                    Profile=[pscustomobject]@{devices=510;durationSeconds=1800;targetsPerClass=25}
                    TrafficStartNotBeforeUtc=$now.AddMinutes(-1)
                    TrafficStartNotAfterUtc=$now.AddMinutes(5)
                },
                [pscustomobject]@{
                    Stage="800";RunId="waf800-$Suffix"
                    Profile=[pscustomobject]@{devices=810;durationSeconds=5400;targetsPerClass=40}
                    TrafficStartNotBeforeUtc=$now.AddHours(2)
                    TrafficStartNotAfterUtc=$now.AddHours(2).AddMinutes(6)
                }
            )
        }
    }
    function Write-TestAcceptedStage {
        param($Config, $Stage)
        if (-not (Test-Path -LiteralPath $Config.EvidenceRoot -PathType Container)) {
            New-Item -ItemType Directory -Path $Config.EvidenceRoot | Out-Null
            Set-CurrentUserPrivateAcl $Config.EvidenceRoot -Directory
        }
        $identityPath = Join-Path $Config.EvidenceRoot "run-identity.json"
        if (-not (Test-Path -LiteralPath $identityPath -PathType Leaf)) {
            Write-AtomicJson $identityPath (Get-CapacityRunIdentity $Config)
        }
        $stageRoot = Join-Path $Config.EvidenceRoot ("waf-{0}-{1}" -f $Stage.Stage, $Stage.RunId)
        New-Item -ItemType Directory -Path $stageRoot | Out-Null
        Set-CurrentUserPrivateAcl $stageRoot -Directory
        $attemptRoot = Join-Path $stageRoot "attempt-1"
        New-Item -ItemType Directory -Path $attemptRoot | Out-Null
        Set-CurrentUserPrivateAcl $attemptRoot -Directory
        $summary = [ordered]@{
            runId=$Stage.RunId;stage=$Stage.Stage;diagnosticOnly=$false
            engineeringAcceptance=$true;certificationEligible=$false
            workloadSchemaVersion=$script:WorkloadSchemaVersion
            workloadEndpointShapeSha256=$script:EndpointShapeSha256
            devices=[int]$Stage.Profile.devices
            expectedTargetsPerClass=[int]$Stage.Profile.targetsPerClass
            configuredPrimaryDevices=([int]$Stage.Profile.devices - 10)
            declaredSecondSchoolCanaryDevices=10
            run=[ordered]@{
                durationClock="monotonic-hrtime-v1"
                runtimeTargetTrafficSeconds=[int]$Stage.Profile.durationSeconds
                actualTrafficMilliseconds=([int]$Stage.Profile.durationSeconds * 1000)
                completedConfiguredDuration=$true
            }
            thresholds=[ordered]@{enforced=$true;passed=$true}
            fatalGate=$null
        }
        $summaryPath = Join-Path $attemptRoot "load-summary.json"
        Write-AtomicJson $summaryPath $summary
        $monitorRoot = Join-Path $attemptRoot "monitor"
        New-Item -ItemType Directory -Path $monitorRoot | Out-Null
        Set-CurrentUserPrivateAcl $monitorRoot -Directory
        $monitor = [ordered]@{
            runId=$Stage.RunId;phase="Waf";status="completed";diagnosticOnly=$false
            engineeringAcceptance=$true;certificationEligible=$false
            loadAccepted=$true;postureAccepted=$true
            acceptance=[ordered]@{passed=$true}
            workload=[ordered]@{
                stage=$Stage.Stage;devices=[int]$Stage.Profile.devices
                durationSeconds=[int]$Stage.Profile.durationSeconds
                workloadSchemaVersion=$script:WorkloadSchemaVersion
                endpointShapeSha256=$script:EndpointShapeSha256
            }
        }
        $monitorPath = Join-Path $monitorRoot "$($Stage.RunId)-monitor-result.json"
        Write-AtomicJson $monitorPath $monitor
        $initialPosture = [ordered]@{
            Services=[ordered]@{
                api=[ordered]@{
                    desired=1;running=1;pending=0
                    taskDefinitionArn=$Config.ApiTaskDefinitionArn
                    assignPublicIp="DISABLED"
                    subnetSetSha256=Get-CanonicalSha256 @("subnet-a","subnet-b")
                }
                worker=[ordered]@{
                    desired=1;running=1;pending=0
                    taskDefinitionArn=$Config.WorkerTaskDefinitionArn
                    assignPublicIp="DISABLED"
                    subnetSetSha256=Get-CanonicalSha256 @("subnet-a","subnet-b")
                }
            }
            WorkerExecution=[ordered]@{
                TaskArn="arn:aws:ecs:us-east-1:135775632425:task/cluster/worker"
                TaskDefinitionArn=$Config.WorkerTaskDefinitionArn
            }
            Targets=[ordered]@{total=1;healthy=1;nonHealthy=0;states=@("healthy")}
            Rds=[ordered]@{instanceClass="db.t4g.medium";status="available"}
            Redis=[ordered]@{status="available";nodeType="cache.t4g.small"}
            Nat=[ordered]@{availableCount=2}
            Waf=[ordered]@{defaultAction="ALLOW";deviceRuleAction="BLOCK";apiRuleAction="BLOCK"}
            Route53=[ordered]@{measureLatency=$true;alarmState="OK"}
            Scaling=[ordered]@{
                minCapacity=1;maxCapacity=6
                scheduledActionsSha256=("a" * 64)
                scalingPoliciesSha256=("b" * 64)
                suspendedState=[ordered]@{
                    DynamicScalingInSuspended=$false
                    DynamicScalingOutSuspended=$false
                    ScheduledScalingSuspended=$false
                }
            }
        }
        Write-AtomicJson (Join-Path $attemptRoot "initial-posture.json") $initialPosture
        Write-AtomicJson (
            Join-Path $monitorRoot "$($Stage.RunId)-engineering-scaling-restoration.json"
        ) ([ordered]@{
            schemaVersion=1;runId=$Stage.RunId;engineeringAcceptance=$true
            restored=$true;completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
            target=[ordered]@{
                apiDesiredCount=1;minCapacity=1;maxCapacity=6
                scheduledActionsSha256=$initialPosture.Scaling.scheduledActionsSha256
                scalingPoliciesSha256=$initialPosture.Scaling.scalingPoliciesSha256
                suspendedState=$initialPosture.Scaling.suspendedState
            }
            observed=[ordered]@{
                minCapacity=1;maxCapacity=6
                scheduledActionsSha256=$initialPosture.Scaling.scheduledActionsSha256
                scalingPoliciesSha256=$initialPosture.Scaling.scalingPoliciesSha256
                suspendedState=$initialPosture.Scaling.suspendedState
                api=[ordered]@{
                    desired=1;running=1;pending=0
                    taskDefinition=$Config.ApiTaskDefinitionArn;deploymentCount=1
                    subnets=@("subnet-a","subnet-b");assignPublicIp="DISABLED"
                }
                worker=[ordered]@{
                    desired=1;running=1;pending=0
                    taskDefinition=$Config.WorkerTaskDefinitionArn;deploymentCount=1
                    subnets=@("subnet-a","subnet-b");assignPublicIp="DISABLED"
                }
                targets=[ordered]@{total=1;healthy=1;unhealthy=0}
            }
            rawErrorPersisted=$false
        })
        Write-AtomicJson (Join-Path $attemptRoot "scaling-restoration.json") ([ordered]@{
            restored=$true
            afterApplicationRollback=$false
            restoredAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
            posture=$initialPosture
        })
        $zeroPath = Join-Path $attemptRoot "postgres-57014-evidence.json"
        Write-AtomicJson $zeroPath ([ordered]@{passed=$true;eventCount=0})
        $maintenancePath = Join-Path $attemptRoot "waf800-maintenance-window-evidence.json"
        if ($Stage.Stage -ceq "800") {
            Write-AtomicJson $maintenancePath ([ordered]@{required=$true;passed=$true})
        }
        Write-AtomicJson (Join-Path $attemptRoot "harness-start-gate.json") ([ordered]@{
            runId=$Stage.RunId;releasedAt=[DateTimeOffset]::UtcNow.ToString("o")
        })
        $current = Get-Process -Id $PID
        $processBinding = [ordered]@{
            stage=$Stage.Stage;runId=$Stage.RunId;attempt=1
            controller=$null
            harness=[ordered]@{
                processId=2147483001;startedAtUtc="2026-07-27T12:00:00.0000000+00:00"
                path=(Get-Command node).Source;exitCode=0
            }
            monitor=[ordered]@{
                processId=2147483002;startedAtUtc="2026-07-27T12:00:00.0000000+00:00"
                path=(Get-Command pwsh).Source;exitCode=0
            }
            completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
        }
        Write-AtomicJson (Join-Path $attemptRoot "process-binding.json") $processBinding
    }
    $bootstrapEvidenceRoot = Join-Path $tempRoot "fresh-evidence-root"
    $bootstrapConfig = New-TestRunConfig $bootstrapEvidenceRoot "provider-retry"
    $script:preflightCalls = 0
    function Invoke-TopLevelReadOnlyPreflight {
        param($Config, [ref]$RecoveryBaseline)
        $script:preflightCalls++
        if ($script:preflightCalls -eq 1) {
            throw "AWS CLI request failed for ecs describe-services."
        }
        $RecoveryBaseline.Value = [ordered]@{ healthy=$true }
        return [ordered]@{valid=$true}
    }
    $script:stageCalls = 0
    function Invoke-CapacityStage {
        param($Config, $Stage)
        $script:stageCalls++
        $stageRoot = Join-Path $Config.EvidenceRoot "mock-stage"
        New-Item -ItemType Directory -Path $stageRoot | Out-Null
        $decisionPath = Join-Path $stageRoot "terminal.json"
        Write-AtomicJson $decisionPath ([ordered]@{accepted=$false})
        return [pscustomobject]@{
            Accepted=$false;PretrafficRetryEligible=$false;Attempt=1;AttemptRoot=$stageRoot
            StartedTraffic=$false;Restoration=[pscustomobject]@{restored=$true}
            Zero57014=$null;PiContext=$null;MaintenanceWindow=$null
            ApplicationRollback=[pscustomobject]@{attempted=$false;completed=$false}
            HarnessExitCode=$null;MonitorExitCode=$null;SummaryPath=$null;MonitorResultPath=$null
            FailureCode="mock_stage_failure";FailureSha256=("4" * 64)
            TerminalDecisionPath=$decisionPath
            TerminalDecisionSha256=(Get-FileHash -LiteralPath $decisionPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    Assert-Condition (-not (Test-Path -LiteralPath $bootstrapEvidenceRoot)) `
        "The exact evidence root must begin absent."
    Assert-Throws {
        Invoke-CapacityRun $bootstrapConfig | Out-Null
    } "Waf/500 was rejected" `
        "Run must retry one read-only provider fault before an authoritative stage decision."
    Assert-Condition ($script:preflightCalls -eq 2 -and $script:stageCalls -eq 1) `
        "Provider preflight must retry once, while Waf/500 rejection must block Waf/800."
    Assert-Condition ((Test-Path -LiteralPath $bootstrapEvidenceRoot -PathType Container) -and
        (Test-Path -LiteralPath $bootstrapConfig.ReportPath -PathType Leaf)) `
        "A post-preflight rejection must consume the one-shot root and write its best-effort report."
    Assert-CurrentUserPrivateAcl $bootstrapEvidenceRoot "fresh evidence root" -Directory

    $preflightFailureRoot = Join-Path $tempRoot "preflight-terminal-root"
    $preflightFailureConfig = New-TestRunConfig $preflightFailureRoot "preflight-failure"
    function Invoke-TopLevelReadOnlyPreflight {
        param($Config, [ref]$RecoveryBaseline)
        throw "The local repository must be clean before capacity acceptance."
    }
    $script:stageCalls = 0
    Assert-Throws {
        Invoke-CapacityRun $preflightFailureConfig | Out-Null
    } "preflight was rejected" `
        "An authoritative preflight failure must consume the run and produce a report."
    Assert-Condition ($script:stageCalls -eq 0 -and
        (Test-Path -LiteralPath $preflightFailureRoot -PathType Container) -and
        (Test-Path -LiteralPath $preflightFailureConfig.ReportPath -PathType Leaf)) `
        "Preflight rejection must be sanitized, reported, traffic-free, and one-shot."

    $orphanRoot = Join-Path $tempRoot "orphan-evidence-root"
    New-Item -ItemType Directory -Path $orphanRoot | Out-Null
    Set-CurrentUserPrivateAcl $orphanRoot -Directory
    $orphanConfig = New-TestRunConfig $orphanRoot "orphan"
    Assert-Throws {
        Invoke-CapacityRun $orphanConfig | Out-Null
    } "lacks its immutable run identity" `
        "Any existing evidence root must block another workload even without stage evidence."

    $interruptedRoot = Join-Path $tempRoot "interrupted-between-stages"
    New-Item -ItemType Directory -Path $interruptedRoot | Out-Null
    Set-CurrentUserPrivateAcl $interruptedRoot -Directory
    $interruptedConfig = New-TestRunConfig $interruptedRoot "interrupted"
    Write-TestAcceptedStage $interruptedConfig $interruptedConfig.Stages[0]
    $script:stageCalls = 0
    Assert-Throws {
        Invoke-CapacityRun $interruptedConfig | Out-Null
    } "raw outcome is not accepted" `
        "Accepted Waf/500 raw evidence without Waf/800 must remain terminal and never rerun."
    Assert-Condition ($script:stageCalls -eq 0) `
        "Read-only reconstruction must not launch another stage."

    $completedRoot = Join-Path $tempRoot "completed-before-campaign-write"
    New-Item -ItemType Directory -Path $completedRoot | Out-Null
    Set-CurrentUserPrivateAcl $completedRoot -Directory
    $completedConfig = New-TestRunConfig $completedRoot "completed"
    Write-TestAcceptedStage $completedConfig $completedConfig.Stages[0]
    Write-TestAcceptedStage $completedConfig $completedConfig.Stages[1]
    $script:stageCalls = 0
    $completedRun = Invoke-CapacityRun $completedConfig
    Assert-Condition ($completedRun.accepted -eq $true -and $script:stageCalls -eq 0 -and
        $completedRun.reportReformattedFromRawEvidence -eq $true) `
        "Two independently valid raw accepted stages must reconstruct the report without rerunning work."

    $rejectedRoot = Join-Path $tempRoot "rejected-before-campaign-write"
    New-Item -ItemType Directory -Path $rejectedRoot | Out-Null
    Set-CurrentUserPrivateAcl $rejectedRoot -Directory
    $rejectedConfig = New-TestRunConfig $rejectedRoot "rejected"
    Write-TestAcceptedStage $rejectedConfig $rejectedConfig.Stages[0]
    $rejectedStage = $rejectedConfig.Stages[1]
    $rejectedStageRoot = Join-Path $rejectedRoot (
        "waf-800-{0}" -f $rejectedStage.RunId
    )
    New-Item -ItemType Directory -Path $rejectedStageRoot | Out-Null
    Set-CurrentUserPrivateAcl $rejectedStageRoot -Directory
    Write-AtomicJson (Join-Path $rejectedStageRoot "scaling-restoration.json") `
        ([ordered]@{restored=$true;noScalingMutationObserved=$true})
    Assert-Throws {
        Invoke-CapacityRun $rejectedConfig | Out-Null
    } "raw outcome is not accepted" `
        "Accepted Waf/500 plus incomplete Waf/800 raw evidence must remain rejected without rerun."

    $inheritedAclFile = Join-Path $tempRoot "inherited.private.json"
    [IO.File]::WriteAllText($inheritedAclFile, "{}", [Text.UTF8Encoding]::new($false))
    Assert-Throws {
        Assert-CurrentUserPrivateAcl $inheritedAclFile "inherited fixture input"
    } "protected current-user" "Inherited or broad sensitive-file ACLs must be rejected."
    Set-CurrentUserPrivateAcl $inheritedAclFile
    Assert-CurrentUserPrivateAcl $inheritedAclFile "protected fixture input"

    $progressPath = Join-Path $tempRoot "progress.jsonl"
    $gatePath = Join-Path $tempRoot "start.json"
    Assert-Condition (Assert-NoTrafficProgress $progressPath $gatePath) `
        "Missing gate and progress must prove no traffic."
    [IO.File]::WriteAllText($progressPath, "", [Text.UTF8Encoding]::new($false))
    Assert-Condition (Assert-NoTrafficProgress $progressPath $gatePath) `
        "An empty progress file remains pretraffic."
    [IO.File]::WriteAllText($progressPath, '{"event":"start"}', [Text.UTF8Encoding]::new($false))
    Assert-Condition (-not (Assert-NoTrafficProgress $progressPath $gatePath)) `
        "Any progress record must prohibit a pretraffic retry."
    Remove-Item -LiteralPath $progressPath
    [IO.File]::WriteAllText($gatePath, "{}", [Text.UTF8Encoding]::new($false))
    Assert-Condition (-not (Assert-NoTrafficProgress $progressPath $gatePath)) `
        "A released start gate must prohibit a retry even without progress."

    Assert-Condition (Test-ApplicationFailure $null (
        [pscustomobject]@{thresholds=[pscustomobject]@{failures=@("HTTP 5xx rate 1% is not below 0.1%")}}
    )) `
        "An allowlisted application failure must authorize the existing application rollback."
    Assert-Condition (Test-ApplicationFailure $null (
        [pscustomobject]@{
            thresholds=[pscustomobject]@{failures=@()}
            fatalGate=[pscustomobject]@{reasonCodes=@("cross-school-delivery")}
        }
    )) "An allowlisted functional/security fatal gate must authorize application rollback."
    foreach ($monitorFailure in @(
        "alb_unhealthy",
        "ecs_active_emergency_api_oom:task",
        "ecs_api_oom:task",
        "ecs_task_stopped:task",
        "ecs_unstable:api"
    )) {
        Assert-Condition (Test-ApplicationFailure (
            [pscustomobject]@{failures=@($monitorFailure)}
        ) $null) "Application-health monitor token '$monitorFailure' must authorize rollback."
    }
    Assert-Condition (Test-ApplicationFailure $null (
        [pscustomobject]@{
            thresholds=[pscustomobject]@{failures=@()}
            fatalGate=[pscustomobject]@{reasonCodes=@("unfinished-http-requests")}
        }
    )) "A terminal unfinished HTTP request gate must authorize application rollback."
    foreach ($harnessFailure in @(
        "3 inspected HTTP responses could not be parsed completely",
        "final pre-shutdown WebSocket state was not captured",
        "a class command was delivered more than once to the same device",
        "one or more command responses or update owners could not be validated",
        "one or more server command target statuses regressed",
        "fewer than 99% of command targets received the WebSocket command within 2 seconds",
        "fewer than 99% of command targets sent completed ACKs within 5 seconds",
        "server did not report received status within 2 seconds for 99% of command targets",
        "server did not report completed status within 5 seconds for 99% of command targets",
        "only 809/810 device sockets were authenticated at final pre-shutdown",
        "only 19/20 teacher sockets were authenticated at final pre-shutdown",
        "only 809/810 forced reconnects were requested",
        "only 809/810 forced reconnects completed",
        "command validation produced no sent targets",
        "only 19/20 configured class bodies produced sent command targets",
        "only 19/20 class bodies reached 40 sent targets",
        "only 19/20 teacher WebSockets authenticated",
        "one or more teacher WebSockets closed unexpectedly",
        "GET /api/students-aggregated emitted no completed samples",
        "GET /api/students-aggregated p95 exceeds 1000ms",
        "POST /api/classpilot/tiles/history emitted no completed samples",
        "POST /api/classpilot/tiles/screenshots p95 exceeds 750ms",
        "POST /api/classpilot/commands p95 exceeds 1000ms",
        "tenant isolation probes passed 9/10"
    )) {
        Assert-Condition (Test-ApplicationFailure $null (
            [pscustomobject]@{thresholds=[pscustomobject]@{failures=@($harnessFailure)}}
        )) "Harness functional failure '$harnessFailure' must authorize application rollback."
    }
    Assert-Condition (Test-ApplicationFailure $null $null "postgresql_57014") `
        "Authoritative PostgreSQL 57014 evidence must authorize application rollback."
    Assert-Condition (Test-ApplicationFailure $null $null "maintenance_window_application_failure") `
        "Observed scheduler/worker maintenance failure must authorize application rollback."
    Assert-Condition (-not (Test-ApplicationFailure $null $null "maintenance_window_evidence_unavailable")) `
        "Maintenance evidence transport failure must not authorize application rollback."
    foreach ($pretrafficMessage in @(
        "The api service was not uniquely resolved.",
        "The worker service was not uniquely resolved.",
        "The scheduler worker must have exactly one running task.",
        "The scheduler worker execution is not the exact healthy bound task."
    )) {
        Assert-Condition (Test-PreflightApplicationHealthFailure ([Exception]::new($pretrafficMessage))) `
            "Pretraffic app-health failure '$pretrafficMessage' must authorize recovery."
    }
    Assert-Condition (-not (Test-PreflightApplicationHealthFailure (
        [Exception]::new("The Route53 production alarm is not uniquely healthy.")
    ))) "Topology/provider posture failures must not be misclassified as application health."
    foreach ($evidenceFailure in @(
        "progress-output-error", "summary-output-error", "telemetry_incomplete",
        "rds_cpu_threshold", "redis_cpu_threshold", "evidence_unavailable"
    )) {
        Assert-Condition (-not (Test-ApplicationFailure (
            [pscustomobject]@{failures=@($evidenceFailure)}
        ) $null)) "Capacity or evidence token '$evidenceFailure' must not trigger application rollback."
    }
    Assert-Condition (-not (Test-ApplicationFailure (
        [pscustomobject]@{failures=@("rds_cpu_threshold", "telemetry_incomplete", "run_acceptance_failed")}
    ) $null)) "RDS, telemetry, and generic acceptance failures must not trigger application rollback."
    Assert-Condition (-not (Test-ApplicationFailure (
        [pscustomobject]@{failures=@("rds_cpu_peak")}
    ) ([pscustomobject]@{thresholds=[pscustomobject]@{
        failures=@("POST /api/classpilot/tiles/history p95 exceeds 1000ms")
    }}))) "RDS capacity plus derivative history latency must not roll application revisions back."
    Assert-Condition (-not (Test-ApplicationFailure (
        [pscustomobject]@{failures=@("waf_device_blocked","load:valid-http-403")}
    ) ([pscustomobject]@{thresholds=[pscustomobject]@{
        failures=@("valid traffic received HTTP 4xx")
    }}))) "WAF enforcement plus derivative HTTP 403 must not roll application revisions back."
    Assert-Condition (Test-ApplicationFailure (
        [pscustomobject]@{failures=@("rds_cpu_peak","load:cross-school-delivery")}
    ) $null) "A genuine security failure must retain rollback precedence over capacity evidence."

    $runnerRollbackApi =
        "arn:aws:ecs:us-east-1:135775632425:task-definition/api:19"
    $runnerRollbackWorker =
        "arn:aws:ecs:us-east-1:135775632425:task-definition/worker:19"
    $runnerRollbackConfig = [pscustomobject]@{
        RollbackApiTaskDefinitionArn=$runnerRollbackApi
        RollbackWorkerTaskDefinitionArn=$runnerRollbackWorker
        Resources=[pscustomobject]@{
            region="us-east-1";cluster="cluster";apiService="api";workerService="worker"
        }
    }
    function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }
    foreach ($partialCase in @(
        [pscustomobject]@{
            Name="API-first partial controller rollback";FailingService="worker"
        },
        [pscustomobject]@{
            Name="worker-first partial controller rollback";FailingService="api"
        }
    )) {
        $script:runnerRollbackCalls = [Collections.Generic.List[string]]::new()
        $script:runnerPartialFailureConsumed = $false
        $script:runnerCurrentApi =
            "arn:aws:ecs:us-east-1:135775632425:task-definition/api:20"
        $script:runnerCurrentWorker =
            "arn:aws:ecs:us-east-1:135775632425:task-definition/worker:20"
        function Invoke-AwsCommand {
            param([string[]]$Arguments)
            $joined = $Arguments -join " "
            $script:runnerRollbackCalls.Add($joined)
            if ($Arguments[0] -ceq "ecs" -and $Arguments[1] -ceq "update-service" -and
                $Arguments -contains "--task-definition") {
                $serviceIndex = [Array]::IndexOf($Arguments, "--service")
                $taskIndex = [Array]::IndexOf($Arguments, "--task-definition")
                $service = [string]$Arguments[$serviceIndex + 1]
                $task = [string]$Arguments[$taskIndex + 1]
                if ($service -ceq $partialCase.FailingService -and
                    -not $script:runnerPartialFailureConsumed) {
                    $script:runnerPartialFailureConsumed = $true
                    throw "simulated controller partial mutation"
                }
                if ($service -ceq "api") { $script:runnerCurrentApi = $task }
                if ($service -ceq "worker") { $script:runnerCurrentWorker = $task }
            }
        }
        function Wait-TargetHealth { param($Config,[int]$ExpectedCount) }
        function Invoke-AwsJson {
            param([string[]]$Arguments, [int]$TimeoutSeconds)
            return [pscustomobject]@{services=@(
                [pscustomobject]@{
                    serviceName="api";taskDefinition=$script:runnerCurrentApi
                    desiredCount=1;runningCount=1;pendingCount=0
                },
                [pscustomobject]@{
                    serviceName="worker";taskDefinition=$script:runnerCurrentWorker
                    desiredCount=1;runningCount=1;pendingCount=0
                }
            )}
        }
        $runnerRollback = Invoke-ApplicationRollback $runnerRollbackConfig 1
        Assert-Condition (
            $runnerRollback.completed -and $runnerRollback.attemptCount -eq 2 -and
            $script:runnerCurrentApi -ceq $runnerRollbackApi -and
            $script:runnerCurrentWorker -ceq $runnerRollbackWorker -and
            @($script:runnerRollbackCalls | Where-Object {
                $_ -match 'update-service.+api.+api:19'
            }).Count -eq 2 -and
            @($script:runnerRollbackCalls | Where-Object {
                $_ -match 'update-service.+worker.+worker:19'
            }).Count -eq 2
        ) "$($partialCase.Name) must idempotently converge both exact prior revisions."
    }

    $script:restorationRollbackCalls = 0
    function Invoke-ApplicationRollback {
        param($Config,[int]$ExpectedApiCount)
        $script:restorationRollbackCalls++
        return [ordered]@{attempted=$true;completed=$true}
    }
    function Set-ScalingTarget {
        param($Config,[int]$Minimum,[int]$Maximum,$SuspendedState)
    }
    function Invoke-AwsCommand { param([string[]]$Arguments) }
    function Wait-TargetHealth { param($Config,[int]$ExpectedCount) }
    $restorationInitial = [pscustomobject]@{
        Services=[pscustomobject]@{
            api=[pscustomobject]@{desired=1;running=1}
            worker=[pscustomobject]@{desired=1;running=1}
        }
        WorkerExecution=[pscustomobject]@{
            TaskArn="arn:task/old";TaskDefinitionArn=$runnerRollbackWorker
        }
        Scaling=[pscustomobject]@{
            minCapacity=1;maxCapacity=6
            suspendedState=[ordered]@{
                DynamicScalingInSuspended=$false
                DynamicScalingOutSuspended=$false
                ScheduledScalingSuspended=$false
            }
            scheduledActionsSha256=("a" * 64)
            scalingPoliciesSha256=("b" * 64)
        }
    }
    $restorationObserved = [pscustomobject]@{
        Services=[pscustomobject]@{
            api=[pscustomobject]@{desired=1;running=1}
            worker=[pscustomobject]@{desired=1;running=1}
        }
        WorkerExecution=[pscustomobject]@{
            TaskArn="arn:task/prior";TaskDefinitionArn=$runnerRollbackWorker
        }
        Scaling=$restorationInitial.Scaling
    }
    function Get-RollbackProductionPosture {
        param($Config)
        return $restorationObserved
    }
    $restorationResult = Restore-Scaling $runnerRollbackConfig `
        $restorationInitial -AfterApplicationRollback
    Assert-Condition ($restorationResult.restored -eq $true -and
        $restorationResult.afterApplicationRollback -eq $true -and
        $script:restorationRollbackCalls -eq 1) `
        "Controller final restoration must reassert both prior revisions after any partial mutation."
    Invoke-Expression $functions["Invoke-ApplicationRollback"].Extent.Text
    Remove-Item Function:\Set-ScalingTarget -ErrorAction SilentlyContinue
    Remove-Item Function:\Invoke-AwsCommand -ErrorAction SilentlyContinue
    Remove-Item Function:\Wait-TargetHealth -ErrorAction SilentlyContinue
    Remove-Item Function:\Invoke-AwsJson -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-RollbackProductionPosture -ErrorAction SilentlyContinue
    Remove-Item Function:\Start-Sleep -ErrorAction SilentlyContinue

    $recoveryRoot = Join-Path $tempRoot "hard-kill-rollback-recovery"
    New-Item -ItemType Directory -Path $recoveryRoot | Out-Null
    Set-CurrentUserPrivateAcl $recoveryRoot -Directory
    $recoveryConfig = [pscustomobject]@{
        EvidenceRoot=$recoveryRoot
        RollbackApiTaskDefinitionArn=$runnerRollbackApi
        RollbackWorkerTaskDefinitionArn=$runnerRollbackWorker
        Resources=$runnerRollbackConfig.Resources
        Stages=@(
            [pscustomobject]@{Stage="500";RunId="controller-kill"},
            [pscustomobject]@{Stage="800";RunId="monitor-kill"}
        )
    }
    $pendingIntent = New-ApplicationRollbackIntent $recoveryConfig
    $intentPayloadPath = Join-Path $tempRoot "pending-intent.payload.json"
    Write-AtomicJson $intentPayloadPath $pendingIntent
    $pendingMonitorIntent = [ordered]@{}
    foreach ($entry in $pendingIntent.GetEnumerator()) {
        $pendingMonitorIntent[$entry.Key] = $entry.Value
    }
    $pendingMonitorIntent.approved = $true
    $pendingMonitorResult = [ordered]@{
        runId="monitor-kill";phase="Waf";diagnosticOnly=$false
        engineeringAcceptance=$true;certificationEligible=$false
        status="failed";timestamp=[DateTimeOffset]::UtcNow.ToString("o")
        failures=@("load:cross-school-delivery")
        rollback=$pendingMonitorIntent
    }
    $monitorPayloadPath = Join-Path $tempRoot "pending-monitor.payload.json"
    Write-AtomicJson $monitorPayloadPath $pendingMonitorResult
    $intentWriterScript = Join-Path $tempRoot "write-pending-then-sleep.ps1"
    [IO.File]::WriteAllText($intentWriterScript, @'
#requires -Version 7.5
param([string]$Payload,[string]$Destination,[string]$PartialMarker,[string]$Ready)
[IO.File]::Copy($Payload,$Destination,$false)
[IO.File]::WriteAllText($PartialMarker,"first-service-updated")
[IO.File]::WriteAllText($Ready,"ready")
[Threading.Thread]::Sleep(30000)
'@, [Text.UTF8Encoding]::new($false))
    $script:ChildExitGraceSeconds = 1
    $killedBindings = @{}
    foreach ($killCase in @(
        [pscustomobject]@{
            Stage=$recoveryConfig.Stages[0];Mode="controller";Payload=$intentPayloadPath
        },
        [pscustomobject]@{
            Stage=$recoveryConfig.Stages[1];Mode="monitor";Payload=$monitorPayloadPath
        }
    )) {
        $stageRoot = Join-Path $recoveryRoot (
            "waf-{0}-{1}" -f $killCase.Stage.Stage,$killCase.Stage.RunId
        )
        $candidateRoot = if ($killCase.Mode -ceq "monitor") {
            Join-Path $stageRoot "attempt-1"
        } else { $stageRoot }
        New-Item -ItemType Directory -Path $candidateRoot -Force | Out-Null
        Set-CurrentUserPrivateAcl $stageRoot -Directory
        if ($candidateRoot -cne $stageRoot) {
            Set-CurrentUserPrivateAcl $candidateRoot -Directory
        }
        Write-AtomicJson (Join-Path $candidateRoot "initial-posture.json") `
            $restorationInitial
        $destination = if ($killCase.Mode -ceq "monitor") {
            $monitorDirectory = Join-Path $candidateRoot "monitor"
            New-Item -ItemType Directory -Path $monitorDirectory | Out-Null
            Set-CurrentUserPrivateAcl $monitorDirectory -Directory
            Join-Path $monitorDirectory "$($killCase.Stage.RunId)-monitor-result.json"
        } else {
            Join-Path $candidateRoot "application-rollback.json"
        }
        $partialMarker = Join-Path $candidateRoot "partial-api-update.marker"
        $ready = Join-Path $candidateRoot "intent-ready.marker"
        $child = Start-SupervisedProcess -FilePath (Get-Command pwsh).Source `
            -Arguments @(
                "-NoLogo","-NoProfile","-File",$intentWriterScript,
                "-Payload",$killCase.Payload,"-Destination",$destination,
                "-PartialMarker",$partialMarker,"-Ready",$ready
            ) -StdoutPath (Join-Path $tempRoot "$($killCase.Mode).stdout.log") `
            -StderrPath (Join-Path $tempRoot "$($killCase.Mode).stderr.log")
        try {
            $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
            while (-not (Test-Path -LiteralPath $ready) -and
                [DateTimeOffset]::UtcNow -lt $deadline -and
                -not $child.Process.HasExited) {
                [Threading.Thread]::Sleep(25)
            }
            Assert-Condition ((Test-Path -LiteralPath $ready) -and
                (Test-Path -LiteralPath $partialMarker)) `
                "$($killCase.Mode) must persist rollback intent before its simulated first mutation."
            $killedBindings[$killCase.Mode] = [ordered]@{
                processId=$child.ProcessId
                startedAtUtc=$child.StartedAtUtc.ToString("o")
                path=$child.ProcessPath
                exitCode=$null
            }
        }
        finally {
            Dispose-SupervisedProcess $child
        }
        if ($killCase.Mode -ceq "monitor") {
            Write-AtomicJson (Join-Path $candidateRoot "process-binding.json") `
                ([ordered]@{
                    stage=$killCase.Stage.Stage;runId=$killCase.Stage.RunId;attempt=1
                    harness=$null;monitor=$killedBindings[$killCase.Mode]
                })
        }
    }
    $script:recoveryRestorationCalls = 0
    function Restore-Scaling {
        param($Config,$InitialPosture,[switch]$AfterApplicationRollback)
        $script:recoveryRestorationCalls++
        Assert-Condition $AfterApplicationRollback `
            "Hard-kill recovery must reassert prior application revisions."
        return [ordered]@{
            restored=$true;afterApplicationRollback=$true
            restoredAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
            posture=$restorationObserved
        }
    }
    function Assert-ControllerScalingRestoration {
        param($Evidence,$InitialPosture,$ApplicationRollback,$Config)
        Assert-Condition ($Evidence.restored -and $ApplicationRollback.completed) `
            "Recovered rollback must be complete before final posture acceptance."
    }
    Repair-InterruptedApplicationRollback $recoveryConfig
    foreach ($killCase in @(
        [pscustomobject]@{Stage=$recoveryConfig.Stages[0];Attempt=$false},
        [pscustomobject]@{Stage=$recoveryConfig.Stages[1];Attempt=$true}
    )) {
        $candidateRoot = Join-Path $recoveryRoot (
            "waf-{0}-{1}" -f $killCase.Stage.Stage,$killCase.Stage.RunId
        )
        if ($killCase.Attempt) { $candidateRoot = Join-Path $candidateRoot "attempt-1" }
        $recoveredRollback = Read-JsonFile (
            Join-Path $candidateRoot "application-rollback.json"
        ) "recovered rollback"
        Assert-Condition ($recoveredRollback.completed -eq $true -and
            $recoveredRollback.mutationStarted -eq $true -and
            (Test-Path -LiteralPath (
                Join-Path $candidateRoot "scaling-restoration.json"
            ))) "Hard-kill recovery must durably seal exact rollback and restoration."
    }
    Assert-Condition ($script:recoveryRestorationCalls -eq 2) `
        "Both controller- and monitor-kill pending intents must be repaired exactly once."
    Invoke-Expression $functions["Restore-Scaling"].Extent.Text
    Invoke-Expression $functions["Assert-ControllerScalingRestoration"].Extent.Text

    $script:snapshotCalls = 0
    function Get-57014Snapshot {
        $script:snapshotCalls++
        return [ordered]@{eventCount=0;pageCount=1;canonicalSha256=("a" * 64)}
    }
    function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }
    $interval = [pscustomobject]@{
        StartUtc = [DateTimeOffset]::UtcNow.AddMinutes(-8)
        EndUtc = [DateTimeOffset]::UtcNow.AddMinutes(-6)
    }
    $initialPosture = [pscustomobject]@{
        ApiTask = [pscustomobject]@{
            Logging = [pscustomobject]@{ Sanitized = [ordered]@{driver="awslogs"} }
        }
    }
    $zero = Get-Zero57014Evidence ([pscustomobject]@{}) $initialPosture $interval
    Assert-Condition ($zero.passed -eq $true -and $zero.attemptCount -eq 2 -and
        $script:snapshotCalls -eq 2) `
        "Zero-57014 evidence must require two identical snapshots."

    $script:snapshotCalls = 0
    function Get-57014Snapshot {
        $script:snapshotCalls++
        return [ordered]@{eventCount=1;pageCount=1;canonicalSha256=("b" * 64)}
    }
    Assert-Throws {
        Get-Zero57014Evidence ([pscustomobject]@{}) $initialPosture $interval | Out-Null
    } "57014 statement-timeout evidence" "A stable nonzero snapshot must fail."

    $workerInterval = [pscustomobject]@{
        StartUtc = [DateTimeOffset]::UtcNow.AddMinutes(-100)
        EndUtc = [DateTimeOffset]::UtcNow.AddMinutes(-10)
    }
    $script:workerLogEvents = @(
        0..90 | ForEach-Object {
            [pscustomobject]@{
                timestamp = $workerInterval.StartUtc.AddMinutes($_).ToUnixTimeMilliseconds()
                ingestionTime = $workerInterval.StartUtc.AddMinutes($_).AddSeconds(2).ToUnixTimeMilliseconds()
                message = '{"Service":"scheduler-worker","WorkerHeartbeat":1}'
            }
        }
    )
    $script:workerLogPage = 0
    function Invoke-AwsJson {
        param([string[]]$Arguments, [int]$TimeoutSeconds)
        $script:workerLogPage++
        if ($script:workerLogPage -eq 1) {
            return [pscustomobject]@{events=$script:workerLogEvents;nextForwardToken="stable-token"}
        }
        return [pscustomobject]@{events=@();nextForwardToken="stable-token"}
    }
    $workerExecution = [pscustomobject]@{
        LogGroup="/ecs/worker";LogStream="worker/scheduler-worker/task"
    }
    $workerSnapshot = Get-WorkerWindowLogSnapshot (
        [pscustomobject]@{Resources=[pscustomobject]@{region="us-east-1"}}
    ) $workerExecution $workerInterval
    Assert-Condition ($workerSnapshot.heartbeatCoverage -eq $true -and
        $workerSnapshot.schedulerFailureCount -eq 0 -and $workerSnapshot.pageCount -eq 2) `
        "Worker evidence must paginate and prove continuous heartbeat coverage."

    $script:workerLogEvents = @($script:workerLogEvents) + @(
        [pscustomobject]@{
            timestamp=$workerInterval.StartUtc.AddMinutes(45).ToUnixTimeMilliseconds()
            ingestionTime=$workerInterval.StartUtc.AddMinutes(45).AddSeconds(3).ToUnixTimeMilliseconds()
            message='{"event":"scheduler_failure","job":"rollupDailyUsage"}'
        }
    )
    $script:workerLogPage = 0
    $workerFailureSnapshot = Get-WorkerWindowLogSnapshot (
        [pscustomobject]@{Resources=[pscustomobject]@{region="us-east-1"}}
    ) $workerExecution $workerInterval
    Assert-Condition ($workerFailureSnapshot.schedulerFailureCount -eq 1) `
        "Scheduler failure logs must be authoritative maintenance failures."

    $script:maintenanceSnapshotCalls = 0
    function Get-WorkerExecutionPosture {
        param($Config, $WorkerTaskDefinition)
        return [pscustomobject]@{
            TaskArn="arn:aws:ecs:us-east-1:135775632425:task/task"
            TaskArnSha256=("a" * 64)
            TaskDefinitionArn=$Config.WorkerTaskDefinitionArn
            StartedAtUtc=$workerInterval.StartUtc.AddMinutes(-5)
            LogGroup="/ecs/worker"
            LogStream="worker/scheduler-worker/task"
            LogStreamSha256=("b" * 64)
        }
    }
    function Get-WorkerWindowLogSnapshot {
        param($Config, $WorkerExecution, $Interval)
        $script:maintenanceSnapshotCalls++
        $hash = if ($script:maintenanceSnapshotCalls -eq 1) { "c" * 64 } else { "d" * 64 }
        return [ordered]@{
            canonicalSha256=$hash;pageCount=1;eventCount=91;heartbeatCount=91
            heartbeatCoverage=$true;maximumHeartbeatGapMilliseconds=60000
            schedulerFailureCount=0;heavyJobSkipCount=0;heavyJobOverrunObserved=$false
        }
    }
    $maintenanceConfig = [pscustomobject]@{
        WorkerTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:1"
    }
    $maintenanceInitial = [pscustomobject]@{
        WorkerTask=[pscustomobject]@{}
        WorkerExecution=(Get-WorkerExecutionPosture $maintenanceConfig $null)
    }
    $maintenance = Get-Waf800MaintenanceWindowEvidence (
        $maintenanceConfig
    ) $maintenanceInitial $workerInterval
    Assert-Condition ($maintenance.passed -eq $true -and
        $maintenance.attemptCount -eq 3 -and $script:maintenanceSnapshotCalls -eq 3) `
        "Delayed maintenance evidence must require two identical complete snapshots."

    $script:maintenanceSnapshotCalls = 0
    function Get-WorkerWindowLogSnapshot {
        param($Config, $WorkerExecution, $Interval)
        $script:maintenanceSnapshotCalls++
        return [ordered]@{
            canonicalSha256=("e" * 64);pageCount=1;eventCount=92;heartbeatCount=91
            heartbeatCoverage=$true;maximumHeartbeatGapMilliseconds=60000
            schedulerFailureCount=1;heavyJobSkipCount=0;heavyJobOverrunObserved=$false
        }
    }
    Assert-Throws {
        Get-Waf800MaintenanceWindowEvidence $maintenanceConfig $maintenanceInitial $workerInterval | Out-Null
    } "strict maintenance-window gate" "Stable scheduler failure evidence must reject Waf/800."

    # Direct-to-file supervised children must preserve Windows argument
    # boundaries and flush their output independently of controller-owned pipes.
    $argumentProbePath = Join-Path $tempRoot "argument probe.ps1"
    [IO.File]::WriteAllText($argumentProbePath, @'
param(
    [AllowEmptyString()][string]$One,
    [AllowEmptyString()][string]$Two,
    [AllowEmptyString()][string]$Three,
    [AllowEmptyString()][string]$Four
)
[ordered]@{one=$One;two=$Two;three=$Three;four=$Four} | ConvertTo-Json -Compress
'@, [Text.UTF8Encoding]::new($false))
    $argumentStdout = Join-Path $tempRoot "argument.stdout.log"
    $argumentStderr = Join-Path $tempRoot "argument.stderr.log"
    $argumentChild = Start-SupervisedProcess -FilePath (Get-Command pwsh).Source -Arguments @(
        "-NoLogo","-NoProfile","-File",$argumentProbePath,
        "-One","space value","-Two",'embedded"quote',"-Three","","-Four",'C:\tail\'
    ) -StdoutPath $argumentStdout -StderrPath $argumentStderr
    $argumentExit = Complete-SupervisedProcess $argumentChild 30
    $argumentChild.Process.Dispose()
    $argumentResult = (Get-Content -LiteralPath $argumentStdout -Raw) |
        ConvertFrom-Json -DateKind String
    Assert-Condition ($argumentExit -eq 0 -and $argumentResult.one -ceq "space value" -and
        $argumentResult.two -ceq 'embedded"quote' -and $argumentResult.three -ceq "" -and
        $argumentResult.four -ceq 'C:\tail\') `
        "Direct supervised launch must preserve spaces, quotes, empty arguments, and trailing slashes."

    # The monitor may seal first while a successful harness is flushing normal
    # cleanup. Exercise the real process boundary: a delayed clean exit passes,
    # while a harness still live after the bounded grace is tree-terminated.
    $delayedHarnessPath = Join-Path $tempRoot "delayed-harness.ps1"
    [IO.File]::WriteAllText($delayedHarnessPath, @'
param([int]$DelayMilliseconds)
[Threading.Thread]::Sleep($DelayMilliseconds)
"harness-clean"
'@, [Text.UTF8Encoding]::new($false))
    $quickMonitorPath = Join-Path $tempRoot "quick-monitor.ps1"
    [IO.File]::WriteAllText($quickMonitorPath, '"monitor-sealed"', [Text.UTF8Encoding]::new($false))
    function Start-ExitGracePair {
        param([int]$HarnessDelay, [string]$Suffix)
        $harness = Start-SupervisedProcess -FilePath (Get-Command pwsh).Source -Arguments @(
            "-NoLogo","-NoProfile","-File",$delayedHarnessPath,
            "-DelayMilliseconds",[string]$HarnessDelay
        ) -StdoutPath (Join-Path $tempRoot "grace-harness-$Suffix.stdout.log") `
          -StderrPath (Join-Path $tempRoot "grace-harness-$Suffix.stderr.log")
        $monitor = Start-SupervisedProcess -FilePath (Get-Command pwsh).Source -Arguments @(
            "-NoLogo","-NoProfile","-File",$quickMonitorPath
        ) -StdoutPath (Join-Path $tempRoot "grace-monitor-$Suffix.stdout.log") `
          -StderrPath (Join-Path $tempRoot "grace-monitor-$Suffix.stderr.log")
        [void]$monitor.Process.WaitForExit(10000)
        return [pscustomobject]@{ Harness=$harness;Monitor=$monitor }
    }
    $script:ChildExitGraceSeconds = 3
    $cleanPair = Start-ExitGracePair 800 "clean"
    $cleanExits = Wait-ForStageProcesses ([pscustomobject]@{}) ([pscustomobject]@{}) `
        $cleanPair.Harness $cleanPair.Monitor ([DateTimeOffset]::UtcNow.AddSeconds(10)) `
        (Join-Path $tempRoot "unused-generator-clean.json")
    Assert-Condition ($cleanExits.MonitorExit -eq 0 -and $cleanExits.HarnessExit -eq 0 -and
        (Get-Content -LiteralPath $cleanPair.Harness.StdoutPath -Raw) -match "harness-clean") `
        "A monitor-first result must accept the bound harness's delayed clean exit within grace."
    $cleanPair.Harness.Process.Dispose()
    $cleanPair.Monitor.Process.Dispose()

    $script:ChildExitGraceSeconds = 1
    $stuckPair = Start-ExitGracePair 30000 "stuck"
    Assert-Throws {
        Wait-ForStageProcesses ([pscustomobject]@{}) ([pscustomobject]@{}) `
            $stuckPair.Harness $stuckPair.Monitor ([DateTimeOffset]::UtcNow.AddSeconds(10)) `
            (Join-Path $tempRoot "unused-generator-stuck.json") | Out-Null
    } "remained live after its bounded exit grace" `
        "A harness still live after grace must be recursively terminated and rejected."
    Assert-Condition ($stuckPair.Harness.Process.HasExited -and
        (Test-Path -LiteralPath $stuckPair.Harness.StdoutPath -PathType Leaf) -and
        (Test-Path -LiteralPath $stuckPair.Harness.StderrPath -PathType Leaf)) `
        "Stuck-harness rejection must retain readable direct output and no live bound process."
    $stuckPair.Harness.Process.Dispose()
    $stuckPair.Monitor.Process.Dispose()

    $treePidPath = Join-Path $tempRoot "grandchild.pid"
    $treeScriptPath = Join-Path $tempRoot "tree-parent.ps1"
    [IO.File]::WriteAllText($treeScriptPath, @'
param([string]$PidPath)
$grandchild = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @(
    "-NoLogo","-NoProfile","-Command","[Threading.Thread]::Sleep(60000)"
) -PassThru -WindowStyle Hidden
[IO.File]::WriteAllText($PidPath,[string]$grandchild.Id)
while($true){[Threading.Thread]::Sleep(100)}
'@, [Text.UTF8Encoding]::new($false))
    $treeChild = Start-SupervisedProcess -FilePath (Get-Command pwsh).Source -Arguments @(
        "-NoLogo","-NoProfile","-File",$treeScriptPath,"-PidPath",$treePidPath
    ) -StdoutPath (Join-Path $tempRoot "tree.stdout.log") `
      -StderrPath (Join-Path $tempRoot "tree.stderr.log")
    $treeDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $treePidPath) -and
        [DateTimeOffset]::UtcNow -lt $treeDeadline) {
        [Threading.Thread]::Sleep(50)
    }
    $grandchildPid = [int](Get-Content -LiteralPath $treePidPath -Raw)
    $script:ChildExitGraceSeconds = 1
    Dispose-SupervisedProcess $treeChild
    [Threading.Thread]::Sleep(200)
    Assert-Condition ($null -eq (Get-Process -Id $grandchildPid -ErrorAction SilentlyContinue)) `
        "Supervised termination must recursively remove the child process tree."

    # Distinct immutable runs must share one production-wide mutex, and lock
    # contention must occur before the run body, AWS preflight, or report path.
    $script:ExpectedAccountId = "135775632425"
    $script:ExpectedRegion = "us-east-1"
    $mutexConfigA = New-TestRunConfig (Join-Path $tempRoot "mutex-a") "mutex-a"
    $mutexConfigB = New-TestRunConfig (Join-Path $tempRoot "mutex-b") "mutex-b"
    $mutexConfigB.Sha256 = "9" * 64
    Assert-Condition ((Get-CapacityRunMutexName $mutexConfigA) -ceq
        (Get-CapacityRunMutexName $mutexConfigB)) `
        "All production capacity runs must map to one account/region mutex."
    $campaignAdmission = Enter-CapacityCampaignAdmission $mutexConfigA
    $campaignPath = (Get-CapacityCampaignLockPath).Path
    Assert-Condition (-not $campaignAdmission.Existing -and
        (Test-Path -LiteralPath $campaignPath -PathType Leaf) -and
        (Test-Path -LiteralPath (
            Join-Path $mutexConfigA.EvidenceRoot "run-identity.json"
        ) -PathType Leaf)) `
        "Campaign admission must durably establish the fixed marker and consumed run identity."
    Assert-CurrentUserPrivateAcl $campaignPath "test production campaign admission"
    # Simulate a hard controller death at the only cross-root admission gap.
    # Exact reentry may locally reconstruct only the consumed identity root.
    Remove-Item -LiteralPath $mutexConfigA.EvidenceRoot -Recurse -Force
    $recoveredAdmission = Enter-CapacityCampaignAdmission $mutexConfigA
    Assert-Condition ($recoveredAdmission.Existing -and
        (Test-Path -LiteralPath (
            Join-Path $mutexConfigA.EvidenceRoot "run-identity.json"
        ) -PathType Leaf)) `
        "Exact admission-gap recovery must be report-only and reconstruct only run identity."
    Assert-Throws {
        Enter-CapacityCampaignAdmission $mutexConfigB | Out-Null
    } "different immutable production capacity campaign" `
        "A persistent campaign marker must reject a different immutable config."
    $mutexReady = Join-Path $tempRoot "mutex.ready"
    $mutexHolderScript = Join-Path $tempRoot "mutex-holder.ps1"
    [IO.File]::WriteAllText($mutexHolderScript, @'
param([string]$Name,[string]$Ready)
$mutex=[Threading.Mutex]::new($false,$Name)
try {
  [void]$mutex.WaitOne()
  [IO.File]::WriteAllText($Ready,"held")
  [Threading.Thread]::Sleep(30000)
} finally {
  try{$mutex.ReleaseMutex()}catch{}
  $mutex.Dispose()
}
'@, [Text.UTF8Encoding]::new($false))
    $mutexHolder = Start-SupervisedProcess -FilePath (Get-Command pwsh).Source -Arguments @(
        "-NoLogo","-NoProfile","-File",$mutexHolderScript,
        "-Name",(Get-CapacityRunMutexName $mutexConfigA),"-Ready",$mutexReady
    ) -StdoutPath (Join-Path $tempRoot "mutex.stdout.log") `
      -StderrPath (Join-Path $tempRoot "mutex.stderr.log")
    $mutexDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $mutexReady) -and
        [DateTimeOffset]::UtcNow -lt $mutexDeadline) {
        [Threading.Thread]::Sleep(50)
    }
    $script:mutexRunCalls = 0
    $script:mutexReportCalls = 0
    function Invoke-CapacityRun { $script:mutexRunCalls++ }
    function Write-PlainReportBestEffort { $script:mutexReportCalls++ }
    Assert-Throws {
        Invoke-CapacityRunUnderMutex $mutexConfigB | Out-Null
    } "already active" "A held production mutex must reject an overlapping run."
    Assert-Condition ($script:mutexRunCalls -eq 0 -and $script:mutexReportCalls -eq 0 -and
        -not (Test-Path -LiteralPath $mutexConfigB.EvidenceRoot)) `
        "Mutex contention must precede preflight, evidence, report, and traffic work."
    Dispose-SupervisedProcess $mutexHolder
    # The OS mutex is now abandoned/released by hard termination. The durable
    # marker must still stop a different run before the run body or AWS work.
    Assert-Throws {
        Invoke-CapacityRunUnderMutex $mutexConfigB | Out-Null
    } "different immutable production capacity campaign" `
        "A controller hard loss must not allow a different campaign after mutex abandonment."
    Assert-Condition ($script:mutexRunCalls -eq 0 -and $script:mutexReportCalls -eq 0 -and
        -not (Test-Path -LiteralPath $mutexConfigB.EvidenceRoot)) `
        "Persistent admission rejection must precede every run, report, fixture, AWS, and traffic action."
    Invoke-Expression $functions["Invoke-CapacityRun"].Extent.Text
    Invoke-Expression $functions["Write-PlainReportBestEffort"].Extent.Text

    # Execute the real stage-attempt state machine with tooling-only mocks and
    # inject faults on both sides of every scarce lifecycle boundary.
    & {
        $script:NodePath = (Get-Command node).Source
        $script:PwshPath = (Get-Command pwsh).Source
        $script:HarnessPath = Join-Path $tempRoot "mock-harness.mjs"
        $script:MonitorPath = Join-Path $tempRoot "mock-monitor.ps1"
        function Invoke-MockedStageBoundary {
            param([string]$FaultPoint)
            $stageRoot = Join-Path $tempRoot "fault-$FaultPoint"
            New-Item -ItemType Directory -Path $stageRoot | Out-Null
            $configPath = Join-Path $stageRoot "config.json"
            [IO.File]::WriteAllText($configPath,"{}")
            $config = [pscustomobject]@{
                Path=$configPath
                Sha256=(Get-FileHash $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
                ApiTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/api:1"
                WorkerTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:1"
                RollbackApiTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/api:0"
                RollbackWorkerTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/worker:0"
                ExpectedGeneratorPublicIp="203.0.113.1";Resources=[pscustomobject]@{}
            }
            $stage = [pscustomobject]@{
                Stage="500";RunId="fault-$FaultPoint"
                Profile=[pscustomobject]@{devices=510;durationSeconds=1800;targetsPerClass=25}
                TrafficStartNotBeforeUtc=[DateTimeOffset]::UtcNow.AddMinutes(-1)
                TrafficStartNotAfterUtc=[DateTimeOffset]::UtcNow.AddHours(1)
            }
            $script:faultEvents = [Collections.Generic.List[string]]::new()
            $script:childStarts = 0
            $initial = [pscustomobject]@{
                Services=[pscustomobject]@{
                    api=[pscustomobject]@{desired=1}
                    worker=[pscustomobject]@{desired=1}
                }
                Scaling=[pscustomobject]@{minCapacity=1;maxCapacity=6;
                    suspendedState=[pscustomobject]@{}}
            }
            function Get-ProductionPosture {
                param($Config,[switch]$HeldCapacity)
                if ($HeldCapacity) {
                    $script:faultEvents.Add("held-posture")
                    if ($FaultPoint -ceq "before-start-gate") { throw "fault:before-start-gate" }
                    if ($FaultPoint -ceq "expired-before-start-gate") {
                        $stage.TrafficStartNotAfterUtc=[DateTimeOffset]::UtcNow.AddSeconds(-1)
                    }
                }
                return $initial
            }
            function Assert-PreparedHarnessArtifacts {
                if ($FaultPoint -ceq "before-harness" -and $script:childStarts -eq 0) {
                    throw "fault:before-harness"
                }
            }
            function Get-HarnessEnvironment {
                return @{
                    LOAD_SUPERVISOR_READY_PATH=(Join-Path $stageRoot "attempt-1\ready.json")
                    LOAD_SUPERVISOR_START_GATE_PATH=(Join-Path $stageRoot "attempt-1\start.json")
                }
            }
            function Invoke-HarnessPreflight { return [pscustomobject]@{passed=$true} }
            function Start-SupervisedProcess {
                $script:childStarts++
                $kind=if($script:childStarts -eq 1){"harness"}else{"monitor"}
                $script:faultEvents.Add("$kind-launched")
                return [pscustomobject]@{
                    ProcessId=(4000+$script:childStarts)
                    StartedAtUtc=[DateTimeOffset]::UtcNow
                    ProcessPath=(Get-Command pwsh).Source
                    Process=[pscustomobject]@{HasExited=$false}
                }
            }
            function Wait-ForPath {
                if ($FaultPoint -ceq "after-harness" -and $script:childStarts -eq 1) {
                    throw "fault:after-harness"
                }
            }
            function Assert-HarnessReady { return [pscustomobject]@{ready=$true} }
            function New-MonitorConfiguration {
                $monitorRoot=Join-Path $stageRoot "attempt-1\monitor"
                New-Item -ItemType Directory -Path $monitorRoot -Force | Out-Null
                return [pscustomobject]@{
                    evidenceDirectory=$monitorRoot
                    generatorIpEvidencePath=(Join-Path $stageRoot "generator.json")
                    loadSummaryPath=(Join-Path $stageRoot "attempt-1\load-summary.json")
                    loadProgressPath=(Join-Path $stageRoot "attempt-1\load-progress.jsonl")
                }
            }
            function Write-GeneratorIpEvidence {}
            function Invoke-MonitorValidation {
                if ($FaultPoint -ceq "before-monitor") { throw "fault:before-monitor" }
            }
            function Get-NonCredentialChildEnvironment { return @{} }
            function Assert-MonitorRestorationArmed {
                if ($FaultPoint -ceq "after-monitor") { throw "fault:after-monitor" }
            }
            function Set-SixApiCapacity {
                if ($FaultPoint -ceq "before-pin") { throw "fault:before-pin" }
                $script:faultEvents.Add("capacity-pinned")
            }
            function Wait-ForHealthyMonitorHeartbeat {
                if ($FaultPoint -ceq "after-pin") { throw "fault:after-pin" }
            }
            function Wait-ForTrafficWindow {}
            function Assert-MonitorHeartbeat {}
            function Wait-ForStageProcesses {
                if ($FaultPoint -eq "after-start-gate") { throw "fault:after-start-gate" }
                $attemptRoot=Join-Path $stageRoot "attempt-1"
                Write-AtomicJson (Join-Path $attemptRoot "load-summary.json") @{}
                $monitorRoot=Join-Path $attemptRoot "monitor"
                Write-AtomicJson (Join-Path $monitorRoot "$($stage.RunId)-monitor-result.json") @{}
                Write-AtomicJson (Join-Path $monitorRoot "$($stage.RunId)-engineering-scaling-restoration.json") @{}
                return [pscustomobject]@{HarnessExit=0;MonitorExit=1}
            }
            function Assert-StageSummary {}
            function Assert-MonitorResult {}
            function Assert-MonitorScalingRestoration {}
            function Dispose-SupervisedProcess {}
            function Restore-Scaling {
                $script:faultEvents.Add("restoration")
                if ($FaultPoint -ceq "restoration") { throw "fault:restoration" }
                return [ordered]@{restored=$true;posture=[ordered]@{}}
            }
            function Assert-ControllerScalingRestoration {}
            function Get-StandardPiContextBestEffort { return [ordered]@{collected=$false} }
            function Assert-NoTrafficProgress { return $true }
            function Test-ApplicationFailure { return $false }
            $result=Invoke-StageAttempt $config $stage $stageRoot 1 ([pscustomobject]@{})
            return [pscustomobject]@{
                Result=$result;Events=@($script:faultEvents)
                StartGateExists=@(
                    Get-ChildItem -LiteralPath $stageRoot -Recurse -File -Filter "start.json"
                ).Count -eq 1
            }
        }
        foreach($faultPoint in @(
            "before-harness","after-harness","before-monitor","after-monitor",
            "before-pin","after-pin","before-start-gate","expired-before-start-gate",
            "after-start-gate","monitor-exit","restoration"
        )){
            $observed=Invoke-MockedStageBoundary $faultPoint
            Assert-Condition (-not $observed.Result.Accepted -and
                $observed.Events -contains "restoration") `
                "Fault '$faultPoint' must reject and execute restoration."
            if($faultPoint -in @("after-start-gate","monitor-exit","restoration")){
                Assert-Condition $observed.StartGateExists `
                    "Post-gate fault '$faultPoint' must prove the start gate boundary was crossed (events: $($observed.Events -join ','))."
            } else {
                Assert-Condition (-not $observed.StartGateExists) `
                    "Pretraffic fault '$faultPoint' must not release the start gate."
            }
        }
    }

    $reportPath = Join-Path $tempRoot "capacity.txt"
    $reportConfig = [pscustomobject]@{
        ReportPath=$reportPath
        ApplicationGitSha=("c" * 40)
        ImageDigest=("sha256:" + ("d" * 64))
    }
    $reportResult = [pscustomobject]@{
        Stage="500";Accepted=$true;Attempt=1;AttemptRoot=$tempRoot
        Restoration=[pscustomobject]@{restored=$true}
        Zero57014=[pscustomobject]@{eventCount=0}
        PiContext=[pscustomobject]@{collected=$false}
    }
    $setAclDefinition = $functions["Set-CurrentUserPrivateAcl"].Extent.Text
    function Set-CurrentUserPrivateAcl {
        param([string]$Path, [switch]$Directory)
        if (-not $Directory) { throw "simulated ACL interruption after report write" }
    }
    Write-PlainReportBestEffort $reportConfig "ACCEPTED" @($reportResult)
    Assert-Condition (-not (Test-Path -LiteralPath $reportPath) -and
        @((Get-ChildItem -LiteralPath $tempRoot -Filter ".capacity.txt.*.tmp")).Count -eq 0) `
        "A write-to-ACL interruption must leave no inherited destination or stale temporary report."
    Invoke-Expression $setAclDefinition
    Write-PlainReportBestEffort $reportConfig "ACCEPTED" @($reportResult)
    Assert-Condition ((Get-Content -LiteralPath $reportPath -Raw) -match "Outcome: ACCEPTED") `
        "Plain report formatting must preserve accepted authoritative evidence."
    Assert-CurrentUserPrivateAcl $reportPath "atomically published plain report"

    $badParent = Join-Path $tempRoot "not-a-directory"
    [IO.File]::WriteAllText($badParent, "occupied", [Text.UTF8Encoding]::new($false))
    $reportConfig.ReportPath = Join-Path $badParent "capacity.txt"
    $reportThrew = $false
    try { Write-PlainReportBestEffort $reportConfig "ACCEPTED" @($reportResult) }
    catch { $reportThrew = $true }
    Assert-Condition (-not $reportThrew) "Report-write failure must not change authoritative acceptance."
}
finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    Remove-Item Function:\Get-57014Snapshot -ErrorAction SilentlyContinue
    Remove-Item Function:\Invoke-AwsJson -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-WorkerExecutionPosture -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-WorkerWindowLogSnapshot -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-CurrentGeneratorIpv4 -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-RepositoryIdentity -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-FixtureAuthority -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-RollbackCompatibility -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-ProductionPosture -ErrorAction SilentlyContinue
    Remove-Item Function:\Start-Sleep -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "AWS rollout capacity acceptance tests passed."
