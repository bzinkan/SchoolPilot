#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$controllerPath = Join-Path $root "scripts/load/start-waf800-batch-diagnostic.ps1"
$monitorPath = Join-Path $root "scripts/load/aws-rollout-monitor.ps1"
$supervisorPath = Join-Path $root "scripts/load/start-aws-rollout-supervisor.ps1"
$harnessPath = Join-Path $root "scripts/load/classpilot-load-test.mjs"
$monotonicDeadlinePath = Join-Path $root "scripts/load/monotonic-deadline.mjs"
$tilePollAccountingPath = Join-Path $root "scripts/load/tile-poll-accounting.mjs"
$databaseInsightsLeasePath = Join-Path $root "scripts/load/database-insights-lease.ps1"
$script:AssertionCount = 0

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    $script:AssertionCount++
    if (-not $Condition) { throw $Message }
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

function Import-ScriptFunction {
    param($Ast, [string]$Name)
    $definition = $Ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name }, $true)
    Assert-Condition ($null -ne $definition) "Missing function $Name for behavioral testing."
    $body = $definition.Body.Extent.Text.Trim()
    $body = $body.Substring(1, $body.Length - 2)
    Set-Item -Path "Function:script:$Name" -Value ([scriptblock]::Create($body))
}

foreach ($path in @($controllerPath,$monitorPath,$supervisorPath,$databaseInsightsLeasePath)) {
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)
    Assert-Condition ($errors.Count -eq 0) "$path has PowerShell parse errors: $($errors -join '; ')"
}

$controller = Get-Content -LiteralPath $controllerPath -Raw
$monitor = Get-Content -LiteralPath $monitorPath -Raw
$supervisor = Get-Content -LiteralPath $supervisorPath -Raw
$harness = Get-Content -LiteralPath $harnessPath -Raw

foreach ($required in @(
    'diagnosticOnly=$true','certificationEligible=$false','supervisorSealed=$false','predecessor=$null',
    'stage="800";devices=810;durationSeconds=1800','screenshotBytes=40960;canaryDevices=10',
    'classpilot-tile-batch-v1','8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2',
    'db.t4g.medium','cache.t4g.small','Assert-WafDeviceIngestClassifierContract','Assert-WafRateRuleContract','expectedNatGatewayCount',
    'wafDeviceClassifierMetricName','DeviceIngestClassifier','^/api/(classpilot/)?device/(heartbeat|screenshot)$',
    'cloudFrontDistributionId','list-distributions-by-web-acl-id','EvaluationWindowSec','100000','50000',
    'Assert-RedisReplicationIdentity','describe-cache-clusters','clusterReplicationGroupId',
    'ScheduleBoundaryGuardSeconds = 7200','Enter-DiagnosticRunLock','Exit-DiagnosticRunLock',
    'AlbDeregistrationDelaySeconds = 300','TargetHealthConvergenceTimeoutSeconds = $script:AlbDeregistrationDelaySeconds + 120',
    'Wait-TargetHealthConvergence','AllowedTransitionalStates @("initial")','AllowedTransitionalStates @("draining")',
    'DynamicScalingInSuspended=$true','DynamicScalingOutSuspended=$true','ScheduledScalingSuspended=$true',
    'Restore-ScalingCapture','scaling_restoration_failed','scheduledActionsSha256','scalingPoliciesSha256',
    'Group=db.sql_tokenized,Limit=25','rawSqlPersisted=$false','dominanceThresholdPercent=50.0',
    'HistoryFallbackSqlMarkers = @("requested_tiles", "heartbeats", "lateral")',
    'history-fallback-queryid-v1','queryid-sqlstats-v1','historyFallbackQueryIdentity','historyFallbackPiEvidenceVersion','db.sql_tokenized.db_id',
    'database-insights-monitoring-lease-v2','Invoke-DatabaseInsightsLeaseController','database_insights_lease_restoration_failed',
    'db.sql_tokenized.stats.calls_per_sec.avg','db.sql_tokenized.stats.total_time_per_sec.avg',
    'db.sql_tokenized.stats.blk_read_time_per_sec.avg','db.sql_tokenized.stats.temp_blks_read_per_sec.avg',
    'Group=db.wait_event,Limit=25','db.sql_tokenized.id','IO:DataFileRead','historyFallback',
    'filteredWaitEventEvidenceComplete','Get-Postgres57014Evidence','logs","filter-log-events',
    'sqlState="57014"','rawMessagesPersisted=$false;rawIdentifiersPersisted=$false',
    'GeneratorIpCheckSeconds = 60','MonitorHeartbeatStaleSeconds = 150','Update-GeneratorPublicIpEvidence',
    'Assert-HealthyMonitorHeartbeat','GeneratorIpCheckSeconds -ge $script:MonitorHeartbeatStaleSeconds',
    'LOAD_TILE_HISTORY_PATH="/api/classpilot/tiles/history"',
    'LOAD_TILE_SCREENSHOTS_PATH="/api/classpilot/tiles/screenshots"',
    'LOAD_SCREENSHOT_GET_PATH_TEMPLATE=""',
    'DurationClock = "monotonic-hrtime-v1"','DiagnosticPlannedTrafficMilliseconds = 1800000L',
    'classpilot_heartbeat_hot_path_summary','tileBatchHistoryDatabaseMs','Get-HotPathFallbackEvidenceWindows',
    'observedTrafficWindow=$null','Collect-TerminalPostTrafficEvidence','strict_traffic_duration_not_completed',
    'EvidenceCollectorVersion = "post-traffic-v2"','EvidenceAwsTimeoutSeconds = 60','EvidenceAwsMaximumAttempts = 4',
    'PerformanceInsightsInitialDelayMinutes = 5','PerformanceInsightsStabilizationDeadlineMinutes = 15',
    'DatabaseInsightsLeaseMaximumAcquisitionAgeSeconds = 900','DatabaseInsightsLeaseRequiredRemainingSeconds',
    'diagnostic-pi-lease-headroom-v1','queryid-minute-sparse-v1',
    'HarnessTerminalCommitTimeoutSeconds = 45','Wait-HarnessTerminalEvidenceCommit','Resolve-DiagnosticTerminalExitCode',
    'Get-ControllerCleanupDisposition','Stop-ControllerChildrenImmediately','immediate_harness_first','controller_operational_failure','controller_runtime_failure',
    'db_load_series','full_interval_top_tokens','hot_path_log_windows','fallback_window_top_tokens','fallback_token_wait_events',
    'embeddedCanonicalization="powershell-convertto-json-depth-50-compress-utf8"',
    'monotonicDeadline=(Get-FileHash -LiteralPath $script:MonotonicDeadlineScript',
    'tilePollAccounting=(Get-FileHash -LiteralPath $script:TilePollAccountingScript',
    'databaseInsightsLease=(Get-FileHash -LiteralPath $script:DatabaseInsightsLeaseScript'
)) {
    Assert-Condition ($controller.Contains($required)) "Diagnostic controller is missing invariant: $required"
}

Assert-Condition ($controller.Contains('Assert-NoScheduledBoundaryOverlap')) "Diagnostic capacity pin must not cross the existing scheduled-scale boundaries."
Assert-Condition ($controller.Contains('finally {')) "Diagnostic controller must restore scaling through a finally block."
Assert-Condition ($controller.Contains('Get-ValidationScratchPaths $config')) "Validate must use a pre-existing scratch parent independent of the evidence directory."
Assert-Condition ($controller.Contains('-ProgressPath $validationScratch.ProgressPath')) "Validate must run harness validation against the non-evidence scratch path."
Assert-Condition ($controller.Contains('nonMutating=$true')) "Validate output must attest that it was non-mutating."
Assert-Condition ($controller.IndexOf('if ($Mode -eq "Validate")') -lt $controller.IndexOf('New-Item -ItemType Directory')) "Validate must exit before the first evidence-directory write."
Assert-Condition ($controller.Contains('$terminal.preTrafficAwsPosture = Get-AwsPosture $config')) "Exact AWS posture must be revalidated immediately before traffic."
Assert-Condition ($controller.Contains('($now - $lastGeneratorIpCheck).TotalSeconds -ge $script:GeneratorIpCheckSeconds')) "Generator IP evidence must be refreshed on the immutable 60-second cadence."
Assert-Condition ($monitor.Contains('supervisedHeartbeatStaleSeconds = 150')) "The monitor's 150-second fail-closed freshness threshold must remain unchanged."
$preTrafficPostureIndex = $controller.IndexOf('$terminal.preTrafficAwsPosture = Get-AwsPosture $config')
$preReleaseIpIndex = $controller.IndexOf('$lastGeneratorIpCheck = Update-GeneratorPublicIpEvidence', $preTrafficPostureIndex)
$preReleaseLivenessIndex = $controller.IndexOf('$monitor.Refresh(); $harness.Refresh()', $preReleaseIpIndex)
$preReleaseHeartbeatIndex = $controller.IndexOf('Assert-HealthyMonitorHeartbeat -Heartbeat $monitorHeartbeat', $preReleaseLivenessIndex)
$preReleaseLeaseIndex = $controller.IndexOf('$databaseInsightsLeaseValidation = Invoke-DatabaseInsightsLeaseController -Config $config -LeaseMode Validate', $preReleaseHeartbeatIndex)
$postLeaseHeartbeatIndex = $controller.IndexOf('Assert-HealthyMonitorHeartbeat -Heartbeat $monitorHeartbeat', $preReleaseLeaseIndex)
$startGateIndex = $controller.IndexOf('Write-AtomicJson $startGatePath', $postLeaseHeartbeatIndex)
Assert-Condition ($preTrafficPostureIndex -ge 0 -and $preReleaseIpIndex -gt $preTrafficPostureIndex -and
    $preReleaseLivenessIndex -gt $preReleaseIpIndex -and $preReleaseHeartbeatIndex -gt $preReleaseLivenessIndex -and
    $preReleaseLeaseIndex -gt $preReleaseHeartbeatIndex -and $postLeaseHeartbeatIndex -gt $preReleaseLeaseIndex -and
    $startGateIndex -gt $postLeaseHeartbeatIndex) "Pre-release IP refresh, child liveness, lease headroom, and fresh monitor heartbeat validation must precede the start gate."
$runtimeLoopIndex = $controller.IndexOf('while ([DateTimeOffset]::UtcNow -lt $deadline)', $startGateIndex)
$runtimePreLookupExitIndex = $controller.IndexOf('if ($monitor.HasExited) { break }', $runtimeLoopIndex)
$runtimeIpIndex = $controller.IndexOf('if (($now - $lastGeneratorIpCheck).TotalSeconds -ge $script:GeneratorIpCheckSeconds)', $runtimePreLookupExitIndex)
$runtimePostLookupRefreshIndex = $controller.IndexOf('$monitor.Refresh(); $harness.Refresh()', $runtimeIpIndex)
$runtimePostLookupExitIndex = $controller.IndexOf('if ($monitor.HasExited) { break }', $runtimePostLookupRefreshIndex)
Assert-Condition ($runtimeLoopIndex -ge 0 -and $runtimePreLookupExitIndex -gt $runtimeLoopIndex -and
    $runtimeIpIndex -gt $runtimePreLookupExitIndex -and $runtimePostLookupRefreshIndex -gt $runtimeIpIndex -and
    $runtimePostLookupExitIndex -gt $runtimePostLookupRefreshIndex) "Runtime child liveness checks must surround each potentially blocking generator IP refresh."
Assert-Condition ($controller.Contains('$terminal.terminalAwsPosture = Get-AwsPosture $config')) "Exact AWS posture must be revalidated at terminal success."
Assert-Condition (-not $controller.Contains('error=$_.Exception.Message')) 'Diagnostic terminal/restoration evidence must never persist raw exception messages.'
Assert-Condition (-not $controller.Contains('Diagnostic harness failed before monitor acceptance.')) 'A nonzero harness exit must not prevent the monitor from sealing terminal evidence.'
Assert-Condition (-not $controller.Contains('Diagnostic harness failed during the generator IP check.')) 'A nonzero harness exit during an IP refresh must not bypass monitor sealing.'
$stopChildrenIndex = $controller.LastIndexOf('Stop-ProcessBounded $monitor')
$finallyIndex = $controller.LastIndexOf('finally {', $stopChildrenIndex)
$terminalCommitIndex = $controller.IndexOf('Wait-HarnessTerminalEvidenceCommit', $stopChildrenIndex)
$attachMonitorIndex = $controller.IndexOf('Attach-TerminalMonitorEvidence $terminal', $stopChildrenIndex)
$collectImmediateIndex = $controller.IndexOf('-Phase Immediate', $attachMonitorIndex)
$restoreScalingIndex = $controller.IndexOf('Restore-ScalingCapture $config $capture', $collectImmediateIndex)
$collectDelayedIndex = $controller.IndexOf('-Phase Delayed', $restoreScalingIndex)
Assert-Condition ($finallyIndex -ge 0 -and $stopChildrenIndex -gt $finallyIndex -and
    $terminalCommitIndex -gt $stopChildrenIndex -and $attachMonitorIndex -gt $terminalCommitIndex -and
    $collectImmediateIndex -gt $attachMonitorIndex -and $restoreScalingIndex -gt $collectImmediateIndex -and
    $collectDelayedIndex -gt $restoreScalingIndex) 'The final path must stop children, attach the sealed monitor result, capture immediate posture, restore scaling, and only then wait for delayed PI evidence.'
$immediateCleanupIndex = $controller.IndexOf('$cleanupDisposition.mode -ceq "immediate_harness_first"')
$immediateStopCallIndex = $controller.IndexOf('Stop-ControllerChildrenImmediately $terminal $harness $monitor', $immediateCleanupIndex)
$graceWaitIndex = $controller.IndexOf('Wait-HarnessTerminalEvidenceCommit', $immediateStopCallIndex)
Assert-Condition ($immediateCleanupIndex -ge 0 -and $immediateStopCallIndex -gt $immediateCleanupIndex -and
    $graceWaitIndex -gt $immediateStopCallIndex) 'A controller exception with both children live must use the harness-first immediate-stop path without entering commit grace first.'
Assert-Condition ((Test-Path -LiteralPath $monotonicDeadlinePath -PathType Leaf) -and
    $controller.Contains('$script:MonotonicDeadlineScript = Join-Path $PSScriptRoot "monotonic-deadline.mjs"')) 'The controller must bind the exact monotonic deadline helper imported by the harness.'
Assert-Condition ((Test-Path -LiteralPath $tilePollAccountingPath -PathType Leaf) -and
    $controller.Contains('$script:TilePollAccountingScript = Join-Path $PSScriptRoot "tile-poll-accounting.mjs"')) 'The controller must bind the exact tile poll accounting helper imported by the harness.'
Assert-Condition ($supervisor.Contains('tilePollAccounting = Join-Path $PSScriptRoot "tile-poll-accounting.mjs"')) 'Certification controller hashes must bind the tile poll accounting helper.'
Assert-Condition ($supervisor.Contains('databaseInsightsLease = Join-Path $PSScriptRoot "database-insights-lease.ps1"')) 'Certification controller hashes must bind the Database Insights lease helper.'
Assert-Condition ((Test-Path -LiteralPath $databaseInsightsLeasePath -PathType Leaf) -and
    $controller.Contains('$script:DatabaseInsightsLeaseScript = Join-Path $PSScriptRoot "database-insights-lease.ps1"')) 'The diagnostic controller must bind the reviewed Database Insights lease helper.'
Assert-Condition ($controller.Contains('(Get-RequiredValue $raw "historyFallbackQueryIdentity")') -and
    $controller.Contains('Raw historyFallbackSqlIdentity content is forbidden')) 'Diagnostic configuration must reference the private query-identity receipt and reject an inline raw identifier.'
Assert-Condition (-not $controller.Contains('queryIdentifier=$config.HistoryFallbackSqlIdentity.QueryIdentifier;')) 'Terminal diagnostic evidence must never serialize the raw PostgreSQL query identifier.'
Assert-Condition ($controller.Contains('config=[ordered]@{pathSha256=(Get-StringSha256 $config.Path)') -and
    -not $controller.Contains('config=[ordered]@{path=$config.Path')) 'Terminal diagnostic evidence must hash the private config path instead of persisting it.'
Assert-Condition ($controller.Contains('historyFallbackQueryIdentity=[ordered]@{receiptSha256=$config.HistoryFallbackSqlIdentity.Receipt.Sha256') -and
    -not $controller.Contains('historyFallbackQueryIdentity=[ordered]@{receipt=[ordered]@{path=')) 'Terminal identity evidence must retain only the protected receipt hash, never its private filesystem path.'
Assert-Condition ($controller.Contains('dbiResourceIdSha256=(Get-StringSha256') -and
    -not $controller.Contains('pendingReboot=$false;dbiResourceId=[string]')) 'Diagnostic posture artifacts must hash the DBI resource identity rather than sealing a raw PI identifier.'
Assert-Condition ($controller.Contains('Diagnostic validation failed and exact Database Insights restoration also failed') -and
    $controller.Contains('Diagnostic initialization failed and exact Database Insights restoration also failed')) 'Validate and early Run initialization failures must fail closed if the pre-acquired Database Insights lease cannot be exactly restored.'
$lastDelayedCollectionIndex = $controller.LastIndexOf('-Phase Delayed')
$leaseRestoreAfterDelayedIndex = $controller.IndexOf('Restore-TerminalDatabaseInsightsLease $terminal $config $databaseInsightsRestoration', $lastDelayedCollectionIndex)
$standardTerminalPostureIndex = $controller.IndexOf('Get-AwsPosture $config -ExpectedDatabaseInsightsMode "standard"', $leaseRestoreAfterDelayedIndex)
Assert-Condition ($lastDelayedCollectionIndex -ge 0 -and $leaseRestoreAfterDelayedIndex -gt $lastDelayedCollectionIndex -and
    $standardTerminalPostureIndex -gt $leaseRestoreAfterDelayedIndex) 'Delayed PI evidence must seal before the bounded lease restores Standard/7 and terminal posture validates it.'
Assert-Condition ($controller.Contains('$healthyTargets = Get-HealthyTargetCount $Config')) "Read-only AWS posture validation must retain strict target-health enforcement."
Assert-Condition ($controller.Contains('$output.Count -ne 1')) "Controller Git identity must require exactly one native-command output line."
Assert-Condition (-not $controller.Contains('start-aws-rollout-supervisor.ps1')) "Diagnostic controller must never call the certification supervisor."
Assert-Condition ($monitor.Contains('Diagnostic-only evidence must not declare or consume predecessor evidence.')) "Monitor must reject diagnostic predecessor consumption."
Assert-Condition ($monitor.Contains('DiagnosticOnly = $diagnosticOnly')) "Monitor must retain the diagnostic marker in bound runtime state."
Assert-Condition ($monitor.Contains('certificationEligible = -not $config.DiagnosticOnly')) "Monitor terminal results must mark diagnostic evidence non-eligible."
Assert-Condition ($monitor.Contains('diagnostic_rds_cpu_30_of_30_coverage')) "Monitor must require all 30 diagnostic RDS CPU points."
Assert-Condition ($monitor.Contains('diagnostic_rds_cpu_every_minute_below_65')) "Monitor must require every diagnostic RDS CPU point below 65 percent."
Assert-Condition ($monitor.Contains('redis_group_member_identity_mismatch')) "Monitor must fail runtime Redis group/member identity drift."
Assert-Condition ($supervisor.Contains('Diagnostic-only runs can never enter or seed the certification supervisor.')) "Certification supervisor must reject diagnostic configs."
Assert-Condition ($supervisor.Contains('LOAD_DIAGNOSTIC_ONLY                 = "false"')) "Certification harness launch must override ambient diagnostic mode."
Assert-Condition ($harness.Contains('LOAD_DIAGNOSTIC_ONLY=true')) "Harness help must expose the explicit diagnostic-only switch."
Assert-Condition ($harness.Contains('certificationEligible: isLaunchGate && !diagnosticOnly')) "Harness evidence must make diagnostic eligibility explicit."
Assert-Condition ($harness.Contains('diagnosticOnly ? 30 * 60')) "Only explicit diagnostic mode may select the 30-minute Waf/800 duration."

$tokens = $null; $parseErrors = $null
$controllerAst = [Management.Automation.Language.Parser]::ParseFile($controllerPath, [ref]$tokens, [ref]$parseErrors)
foreach ($name in @(
    'Get-Value','Get-RequiredValue','Assert-Sha256','Assert-HistoryFallbackSqlIdentity','Assert-GitSha','Get-ControllerSha','Get-StableJsonSha256','Get-StringSha256','Test-DiagnosticEmptyObject','Get-DiagnosticRunMutexName','Enter-DiagnosticRunLock','Exit-DiagnosticRunLock',
    'Resolve-ExternalPath','Assert-DiagnosticPrivateFileAcl','Read-HistoryFallbackQueryIdentityReceipt',
    'Assert-DatabaseInsightsLeaseBinding','Get-DatabaseInsightsLeaseTimingEvidence',
    'Invoke-DatabaseInsightsLeaseController','Restore-TerminalDatabaseInsightsLease',
    'Get-ValidationScratchPaths','Get-WafLabelMatch','Assert-WafDeviceIngestClassifierContract',
    'Assert-WafRateRuleContract','Assert-RedisReplicationIdentity','Get-DiagnosticTrackIoTimingPosture','Assert-NoScheduledBoundaryOverlap','Get-TargetHealthSnapshot',
    'Wait-TargetHealthConvergence','Get-HealthyTargetCount','Restore-ScalingCapture',
    'Update-GeneratorPublicIpEvidence','Assert-HealthyMonitorHeartbeat','Resolve-ApiAwslogsBinding',
    'Get-BoundApiAwslogsBinding','Get-Postgres57014Evidence','Get-HistoryFallbackWaitEventEvidence',
    'Test-EvidenceAwsRetryableFailure','ConvertTo-ExactUtcDateTimeOffset','Get-PerformanceInsightsEvidenceWindow','Assert-PerformanceInsightsResponseScope',
    'Invoke-EvidenceAwsJsonPages','New-StagedEvidenceException','New-EvidenceEnvelope','Test-EvidenceSourceNotStarted',
    'Get-EvidenceUtcNow','Wait-EvidenceDelay','Wait-HarnessTerminalEvidenceCommit','Resolve-DiagnosticTerminalExitCode',
    'Get-ControllerFailureClassification','Test-HarnessTerminalEvidencePresent','Get-ControllerCleanupDisposition','Stop-ControllerChildrenImmediately',
    'Get-ObservedTrafficWindow','Get-TrafficWindow','Get-PerformanceInsightsTopTokens',
    'New-DiagnosticHistoryFallbackSqlStatsGateResult','Get-DiagnosticHistoryFallbackSqlStatsBucketCoverage',
    'Get-HistoryFallbackSqlStatsEvidence',
    'Get-HistoryFallbackSampledLoadEvidence','Get-HotPathFallbackEvidenceWindows',
    'Get-PerformanceInsightsMetricPoints','Get-StabilizedPerformanceInsightsEvidence',
    'Get-PerformanceInsightsEvidence','Add-TerminalFailure','Remove-TerminalFailure','Attach-TerminalMonitorEvidence',
    'Collect-TerminalPostTrafficEvidence','Set-TerminalEvidenceIntegrity'
)) { Import-ScriptFunction $controllerAst $name }

$script:RepositoryRoot = $root
$orderedValueFixture = [ordered]@{falseValue=$false;zeroValue=0;emptyValue=@();nullValue=$null}
Assert-Condition ((Get-Value $orderedValueFixture 'falseValue' $true) -eq $false) 'Get-Value must preserve false values from ordered dictionaries.'
Assert-Condition ((Get-Value $orderedValueFixture 'zeroValue' 9) -eq 0) 'Get-Value must preserve zero values from ordered dictionaries.'
Assert-Condition (@((Get-Value $orderedValueFixture 'emptyValue' @('fallback'))).Count -eq 0) 'Get-Value must preserve empty arrays from ordered dictionaries.'
Assert-Condition ($null -eq (Get-Value $orderedValueFixture 'nullValue' 'fallback')) 'Get-Value must preserve explicit null values from ordered dictionaries.'
$liveFailureCleanup = Get-ControllerCleanupDisposition $true $true $true $false $false
Assert-Condition ($liveFailureCleanup.mode -ceq 'immediate_harness_first' -and
    (@($liveFailureCleanup.stopOrder) -join ',') -ceq 'harness,monitor,restore') 'A controller exception with both children live and no terminal artifacts must stop harness, monitor, then restore without commit grace.'
$deadMonitorLiveHarnessCleanup = Get-ControllerCleanupDisposition $true $true $false $false $true
Assert-Condition ($deadMonitorLiveHarnessCleanup.mode -ceq 'immediate_harness_first' -and
    (@($deadMonitorLiveHarnessCleanup.stopOrder) -join ',') -ceq 'harness,monitor,restore') 'A live harness with a dead monitor and no coherent terminal evidence must be stopped immediately without commit grace.'
$deadHarnessCleanup = Get-ControllerCleanupDisposition $true $false $true $false $true
Assert-Condition ($deadHarnessCleanup.mode -ceq 'commit_grace' -and
    (@($deadHarnessCleanup.stopOrder) -join ',') -ceq 'monitor,harness,restore') 'A naturally terminal harness may use the bounded terminal-evidence commit grace.'
$artifactCleanup = Get-ControllerCleanupDisposition $true $true $true $true $false
Assert-Condition ($artifactCleanup.mode -ceq 'commit_grace') 'Already-present coherent terminal artifacts may use the bounded commit grace.'
$script:controllerCleanupStopOrder = [Collections.Generic.List[string]]::new()
function Stop-ProcessBounded { param($Process) $script:controllerCleanupStopOrder.Add([string]$Process) }
try {
    Stop-ControllerChildrenImmediately ([ordered]@{failures=@()}) 'harness-process' 'monitor-process'
    Assert-Condition (($script:controllerCleanupStopOrder -join ',') -ceq 'harness-process,monitor-process') 'The immediate child cleanup implementation must stop the live harness before the live monitor.'
}
finally { Remove-Item -Path Function:Stop-ProcessBounded -Force }
try { throw 'generator address changed: raw-operational-detail-must-not-persist' }
catch { $operationalControllerFailure = Get-ControllerFailureClassification 'traffic_monitoring' $_ }
$operationalFailureJson = $operationalControllerFailure | ConvertTo-Json -Compress
Assert-Condition ($operationalControllerFailure.failureCode -ceq 'controller_operational_failure' -and
    $operationalControllerFailure.failureStage -ceq 'traffic_monitoring' -and
    [string]$operationalControllerFailure.messageSha256 -match '^[0-9a-f]{64}$' -and
    $operationalControllerFailure.rawErrorPersisted -eq $false -and
    -not $operationalFailureJson.Contains('raw-operational-detail')) 'Allowlisted external/orchestration failures must be sanitized operational failures, not controller runtime failures.'
$programmingException = [Management.Automation.CommandNotFoundException]::new('missing framework command')
$programmingRecord = [Management.Automation.ErrorRecord]::new($programmingException, 'CommandNotFoundException',
    [Management.Automation.ErrorCategory]::ObjectNotFound, $null)
$programmingControllerFailure = Get-ControllerFailureClassification 'traffic_monitoring' $programmingRecord
Assert-Condition ($programmingControllerFailure.failureCode -ceq 'controller_runtime_failure' -and
    $programmingControllerFailure.failureStage -ceq 'traffic_monitoring' -and
    $programmingControllerFailure.rawErrorPersisted -eq $false) 'Genuine framework/programming faults must retain controller_runtime_failure classification.'
Assert-Condition (Test-EvidenceAwsRetryableFailure 'ThrottlingException: rate exceeded') 'AWS evidence reads must retry allowlisted throttling failures.'
Assert-Condition (Test-EvidenceAwsRetryableFailure 'connection reset by peer') 'AWS evidence reads must retry allowlisted transient connection failures.'
Assert-Condition (Test-EvidenceAwsRetryableFailure '' $true) 'AWS evidence reads must retry a bounded process timeout.'
Assert-Condition (-not (Test-EvidenceAwsRetryableFailure 'AccessDeniedException')) 'AWS evidence reads must not retry permission failures.'
Assert-Condition (-not (Test-EvidenceAwsRetryableFailure 'ValidationException')) 'AWS evidence reads must not retry validation failures.'
$exitPrecedenceTerminal = [ordered]@{failures=@('scaling_restoration_failed')}
$restoredDatabaseInsightsLease = [ordered]@{attempted=$true;restored=$true}
Assert-Condition ((Resolve-DiagnosticTerminalExitCode $exitPrecedenceTerminal ([ordered]@{attempted=$true;restored=$false}) $restoredDatabaseInsightsLease $true 2) -eq 4) 'A failed attempted scaling restoration must retain exit code 4 after acceptance adjudication.'
Assert-Condition ((Resolve-DiagnosticTerminalExitCode ([ordered]@{failures=@('database_insights_lease_restoration_failed')}) ([ordered]@{attempted=$true;restored=$true}) ([ordered]@{attempted=$true;restored=$false}) $true 2) -eq 4) 'A failed attempted Database Insights restoration must retain exit code 4 after acceptance adjudication.'
Assert-Condition ((Resolve-DiagnosticTerminalExitCode ([ordered]@{failures=@()}) ([ordered]@{attempted=$true;restored=$true}) $restoredDatabaseInsightsLease $true 2) -eq 0) 'A fully accepted run with both verified restorations may resolve to exit code 0.'
$leaseRestorationTerminal = [ordered]@{failures=@();databaseInsightsLease=[ordered]@{restoration=$null}}
function Invoke-DatabaseInsightsLeaseController {
    param($Config, [string]$LeaseMode)
    return [ordered]@{state='restored';receiptSha256=('aa' * 32);rawPathsPersisted=$false}
}
$successfulLeaseRestoration = Restore-TerminalDatabaseInsightsLease $leaseRestorationTerminal ([pscustomobject]@{}) ([ordered]@{attempted=$false;restored=$false})
Assert-Condition ($successfulLeaseRestoration.attempted -and $successfulLeaseRestoration.restored -and
    $leaseRestorationTerminal.databaseInsightsLease.restoration.lease.state -ceq 'restored') 'The terminal finalizer must seal a successful exact Database Insights restoration.'
function Invoke-DatabaseInsightsLeaseController { throw 'raw lease restoration provider failure' }
$failedLeaseTerminal = [ordered]@{failures=@();databaseInsightsLease=[ordered]@{restoration=$null}}
$failedLeaseRestoration = Restore-TerminalDatabaseInsightsLease $failedLeaseTerminal ([pscustomobject]@{}) ([ordered]@{attempted=$false;restored=$false})
$failedLeaseJson = $failedLeaseRestoration | ConvertTo-Json -Compress
Assert-Condition ($failedLeaseRestoration.attempted -and -not $failedLeaseRestoration.restored -and
    $failedLeaseRestoration.failureCode -ceq 'database_insights_lease_restoration_failed' -and
    @($failedLeaseTerminal.failures) -contains 'database_insights_lease_restoration_failed' -and
    -not $failedLeaseJson.Contains('raw lease restoration provider failure')) 'Database Insights restoration failure must fail closed with only a discarded-message hash.'
Import-ScriptFunction $controllerAst 'Invoke-DatabaseInsightsLeaseController'
$expectedControllerShaOutput = @(& git -C $root rev-parse HEAD 2>$null)
Assert-Condition ($LASTEXITCODE -eq 0 -and $expectedControllerShaOutput.Count -eq 1) 'The test fixture must resolve one current Git SHA.'
$expectedControllerSha = [string]$expectedControllerShaOutput[0]
Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
$resolvedControllerSha = Get-ControllerSha
Assert-Condition ($resolvedControllerSha -ceq $expectedControllerSha.ToLowerInvariant()) 'Controller SHA resolution must succeed when LASTEXITCODE starts unset.'
Assert-Throws { Assert-GitSha 'abc123' 'test SHA' } 'full 40-character' 'Controller SHA validation must reject abbreviated Git identities.'

$script:GeneratorIpCheckSeconds = 60
$script:MonitorHeartbeatStaleSeconds = 150
$script:testGeneratorIp = '203.0.113.10'
$script:testGeneratorIpFailure = $false
$script:generatorIpWrites = [System.Collections.Generic.List[object]]::new()
function Resolve-GeneratorPublicIp {
    if ($script:testGeneratorIpFailure) { throw 'test generator IP lookup failed' }
    return $script:testGeneratorIp
}
function Write-AtomicJson {
    param([string]$Path, $Value)
    $script:generatorIpWrites.Add([pscustomobject]@{Path=$Path;Value=$Value})
}
$generatorIpConfig = [pscustomobject]@{RunId='diagnostic-ip-test';ExpectedGeneratorPublicIp='203.0.113.10'}
$generatorIpObservedAt = Update-GeneratorPublicIpEvidence -Config $generatorIpConfig -Path 'generator-ip.json' -FailureMessage 'changed'
Assert-Condition ($script:generatorIpWrites.Count -eq 1 -and $script:generatorIpWrites[0].Path -eq 'generator-ip.json') 'A matching generator IP must write one fresh evidence record.'
Assert-Condition ($script:generatorIpWrites[0].Value.runId -eq $generatorIpConfig.RunId -and
    $script:generatorIpWrites[0].Value.expectedPublicIp -eq $generatorIpConfig.ExpectedGeneratorPublicIp -and
    $script:generatorIpWrites[0].Value.actualPublicIp -eq $generatorIpConfig.ExpectedGeneratorPublicIp -and
    [DateTimeOffset]$script:generatorIpWrites[0].Value.timestamp -eq $generatorIpObservedAt) 'Generator IP evidence must bind the exact run, expected IP, actual IP, and observation time.'
$script:testGeneratorIp = '203.0.113.11'
Assert-Throws { Update-GeneratorPublicIpEvidence -Config $generatorIpConfig -Path 'generator-ip.json' -FailureMessage 'changed during test' } 'changed during test' 'A changed generator IP must fail closed.'
Assert-Condition ($script:generatorIpWrites.Count -eq 2 -and $script:generatorIpWrites[1].Value.actualPublicIp -eq '203.0.113.11') 'A changed generator IP must be recorded before the controller fails.'
$writesBeforeResolverFailure = $script:generatorIpWrites.Count
$script:testGeneratorIpFailure = $true
Assert-Throws { Update-GeneratorPublicIpEvidence -Config $generatorIpConfig -Path 'generator-ip.json' -FailureMessage 'changed' } 'lookup failed' 'A generator IP resolver failure must fail closed.'
Assert-Condition ($script:generatorIpWrites.Count -eq $writesBeforeResolverFailure) 'A resolver failure must not refresh stale generator IP evidence.'

$monitorStartedAt = [DateTimeOffset]'2026-07-20T12:00:00Z'
$heartbeatNow = $monitorStartedAt.AddSeconds(60)
$healthyHeartbeat = [pscustomobject]@{runId='diagnostic-ip-test';phase='Waf';timestamp=$heartbeatNow.ToString('o');iteration=1;triggered=$false}
Assert-HealthyMonitorHeartbeat -Heartbeat $healthyHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt -Now $heartbeatNow
$wrongRunHeartbeat = $healthyHeartbeat | ConvertTo-Json | ConvertFrom-Json
$wrongRunHeartbeat.runId = 'wrong-run'
Assert-Throws { Assert-HealthyMonitorHeartbeat -Heartbeat $wrongRunHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt -Now $heartbeatNow } 'fresh, healthy' 'A wrong-run monitor heartbeat must fail closed.'
$wrongPhaseHeartbeat = $healthyHeartbeat | ConvertTo-Json | ConvertFrom-Json
$wrongPhaseHeartbeat.phase = 'Application'
Assert-Throws { Assert-HealthyMonitorHeartbeat -Heartbeat $wrongPhaseHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt -Now $heartbeatNow } 'fresh, healthy' 'A wrong-phase monitor heartbeat must fail closed.'
$triggeredHeartbeat = $healthyHeartbeat | ConvertTo-Json | ConvertFrom-Json
$triggeredHeartbeat.triggered = $true
Assert-Throws { Assert-HealthyMonitorHeartbeat -Heartbeat $triggeredHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt -Now $heartbeatNow } 'fresh, healthy' 'A triggered monitor heartbeat must fail closed.'
$nonBooleanHeartbeat = $healthyHeartbeat | ConvertTo-Json | ConvertFrom-Json
$nonBooleanHeartbeat.triggered = 'false'
Assert-Throws { Assert-HealthyMonitorHeartbeat -Heartbeat $nonBooleanHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt -Now $heartbeatNow } 'fresh, healthy' 'A non-Boolean trigger field must fail closed.'
$staleHeartbeat = $healthyHeartbeat | ConvertTo-Json | ConvertFrom-Json
$staleHeartbeat.timestamp = $heartbeatNow.AddSeconds(-151).ToString('o')
Assert-Throws { Assert-HealthyMonitorHeartbeat -Heartbeat $staleHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt.AddMinutes(-10) -Now $heartbeatNow } 'fresh, healthy' 'A heartbeat beyond the unchanged 150-second threshold must fail closed.'
$zeroIterationHeartbeat = $healthyHeartbeat | ConvertTo-Json | ConvertFrom-Json
$zeroIterationHeartbeat.iteration = 0
Assert-Throws { Assert-HealthyMonitorHeartbeat -Heartbeat $zeroIterationHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt -Now $heartbeatNow } 'fresh, healthy' 'A zero-iteration monitor heartbeat must fail closed.'
$preLaunchHeartbeat = $healthyHeartbeat | ConvertTo-Json | ConvertFrom-Json
$preLaunchHeartbeat.timestamp = $monitorStartedAt.AddSeconds(-1).ToString('o')
Assert-Throws { Assert-HealthyMonitorHeartbeat -Heartbeat $preLaunchHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt -Now $heartbeatNow } 'fresh, healthy' 'A pre-launch monitor heartbeat must fail closed.'
$futureHeartbeat = $healthyHeartbeat | ConvertTo-Json | ConvertFrom-Json
$futureHeartbeat.timestamp = $heartbeatNow.AddSeconds(6).ToString('o')
Assert-Throws { Assert-HealthyMonitorHeartbeat -Heartbeat $futureHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt -Now $heartbeatNow } 'fresh, healthy' 'A monitor heartbeat beyond the five-second clock-skew allowance must fail closed.'
$invalidTimestampHeartbeat = $healthyHeartbeat | ConvertTo-Json | ConvertFrom-Json
$invalidTimestampHeartbeat.timestamp = 'invalid'
Assert-Throws { Assert-HealthyMonitorHeartbeat -Heartbeat $invalidTimestampHeartbeat -ExpectedRunId 'diagnostic-ip-test' -ExpectedPhase 'Waf' -MonitorStartedAt $monitorStartedAt -Now $heartbeatNow } 'timestamp is invalid' 'An invalid monitor heartbeat timestamp must fail closed.'
Assert-Condition ($script:GeneratorIpCheckSeconds -lt $script:MonitorHeartbeatStaleSeconds) 'The 60-second generator IP refresh must remain inside the unchanged 150-second monitor threshold.'

$script:fakeGitExitCode = 0
$script:fakeGitOutput = @()
function git {
    $global:LASTEXITCODE = $script:fakeGitExitCode
    foreach ($line in $script:fakeGitOutput) { Write-Output $line }
}
try {
    $script:fakeGitExitCode = 128
    $script:fakeGitOutput = @()
    Assert-Throws { Get-ControllerSha } 'Unable to resolve' 'Controller SHA resolution must reject a nonzero native Git exit.'
    $script:fakeGitExitCode = 0
    $script:fakeGitOutput = @('1111111111111111111111111111111111111111','2222222222222222222222222222222222222222')
    Assert-Throws { Get-ControllerSha } 'exactly one output line' 'Controller SHA resolution must reject ambiguous multiline native output.'
    $script:fakeGitOutput = @('not-a-full-sha')
    Assert-Throws { Get-ControllerSha } 'full 40-character' 'Controller SHA resolution must reject malformed native output.'
}
finally { Remove-Item -Path Function:git -Force }

$script:ExpectedRegion = 'us-east-1'
$script:AuthSqlMarkers = @(
    'requested_students','active_supervision','active_staff_groups',
    'active_roster_students','authorized_students','resolved_students'
)
$script:HistoryFallbackSqlMarkers = @('requested_tiles','heartbeats','lateral')
$script:HistoryIoDominanceThresholdPercent = 50.0
$script:PerformanceInsightsCoverageTolerancePercent = 0.5
$script:HistoryFallbackSqlIdentityVersion = 'history-fallback-queryid-v1'
$script:HistoryFallbackPiEvidenceVersion = 'queryid-sqlstats-v1'
$script:HistoryFallbackParameterTypeSignatureJson = '["$1:text[]:student_ids","$2:text[]:device_ids","$3:text:school_id","$4:bigint:history_limit"]'
$script:DatabaseInsightsLeaseVersion = 'database-insights-monitoring-lease-v2'
$script:DatabaseInsightsDurableRestoreGuardVersion = 'aws-scheduler-ssm-recurring-restore-v1'
$script:DatabaseInsightsLeaseScript = $databaseInsightsLeasePath
$script:HistoryFallbackSqlStatsPeriodSeconds = 60
$script:HistoryFallbackSqlStatsMetrics = [ordered]@{
    calls='db.sql_tokenized.stats.calls_per_sec.avg'
    totalTime='db.sql_tokenized.stats.total_time_per_sec.avg'
    blockReadTime='db.sql_tokenized.stats.blk_read_time_per_sec.avg'
    sharedBlocksRead='db.sql_tokenized.stats.shared_blks_read_per_sec.avg'
    tempBlocksRead='db.sql_tokenized.stats.temp_blks_read_per_sec.avg'
    tempBlocksWritten='db.sql_tokenized.stats.temp_blks_written_per_sec.avg'
}
$script:EvidenceCollectorVersion = 'post-traffic-v2'
$script:EvidenceMaximumPages = 100
$script:EvidenceMaximumRecords = 10000
$script:PerformanceInsightsInitialDelayMinutes = 5
$script:PerformanceInsightsStabilizationDeadlineMinutes = 15
$script:PerformanceInsightsPollSeconds = 0
$script:DatabaseInsightsLeaseMaximumAcquisitionAgeSeconds = 900
$script:DatabaseInsightsLeaseRestoreTimeoutSeconds = 900
$script:DatabaseInsightsLeaseSafetyMarginSeconds = 300
$script:DatabaseInsightsLeaseRequiredRemainingSeconds = 3900
$script:HarnessTerminalCommitTimeoutSeconds = 45
$script:HarnessTerminalCommitPollMilliseconds = 250
$script:WorkloadSchemaVersion = 'classpilot-tile-batch-v1'
$script:EndpointShapeSha256 = '8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2'
$script:DurationClock = 'monotonic-hrtime-v1'
$script:DiagnosticRuntimeTargetTrafficSeconds = 1800.0
$script:DiagnosticPlannedTrafficMilliseconds = 1800000L
$script:HotPathSummaryEvent = 'classpilot_heartbeat_hot_path_summary'
$script:HotPathSummaryIntervalSeconds = 60

$fractionalPiWindow = Get-PerformanceInsightsEvidenceWindow '2026-07-20T12:00:00.001Z' '2026-07-20T12:30:59.999Z'
Assert-Condition ($fractionalPiWindow.AlignedStart.ToString('o') -ceq '2026-07-20T12:01:00.0000000+00:00' -and
    $fractionalPiWindow.AlignedEnd.ToString('o') -ceq '2026-07-20T12:30:00.0000000+00:00' -and
    $fractionalPiWindow.Evidence.completeMinuteCount -eq 29 -and
    [string]$fractionalPiWindow.Evidence.coherentWindowSha256 -match '^[0-9a-f]{64}$' -and
    [string]$fractionalPiWindow.Evidence.alignedEvidenceWindowSha256 -match '^[0-9a-f]{64}$') 'PI evidence must use the positive complete-minute interior of the coherent traffic window and hash both scopes.'
Assert-Throws { Get-PerformanceInsightsEvidenceWindow '2026-07-20T12:00:30Z' '2026-07-20T12:01:00Z' } 'positive complete-minute' 'A coherent window without a positive aligned interior must fail closed.'
$validPiScopeResponse = [pscustomobject]@{AlignedStartTime='2026-07-20T12:01:00Z';AlignedEndTime='2026-07-20T12:30:00Z';Identifier='db-AAAAAAAAAAAAAAAAAAAA'}
Assert-PerformanceInsightsResponseScope $validPiScopeResponse '2026-07-20T12:01:00Z' '2026-07-20T12:30:00Z' 'db-AAAAAAAAAAAAAAAAAAAA'
Assert-Condition $true 'Exact aligned PI response bounds and database identity must validate.'
Assert-Throws { Assert-PerformanceInsightsResponseScope $validPiScopeResponse '2026-07-20T12:01:00Z' '2026-07-20T12:29:00Z' 'db-AAAAAAAAAAAAAAAAAAAA' } 'outside the exact aligned' 'A PI response with different aligned bounds must fail closed.'
Assert-Throws { Assert-PerformanceInsightsResponseScope $validPiScopeResponse '2026-07-20T12:01:00Z' '2026-07-20T12:30:00Z' 'db-BBBBBBBBBBBBBBBBBBBB' } 'different database' 'A GetResourceMetrics response for another DBI resource must fail closed.'

$historyQueryIdentifier = '-9223372036854775808'
$historyCompiledSqlSha256 = ('ab' * 32)
$historyFallbackSqlIdentity = Assert-HistoryFallbackSqlIdentity ([ordered]@{
    identityVersion='history-fallback-queryid-v1';queryIdentifier=$historyQueryIdentifier
    queryIdentifierSha256=(Get-StringSha256 $historyQueryIdentifier)
    compiledSqlSha256=$historyCompiledSqlSha256;parameterTypeSignatureSha256=('cd' * 32)
    databaseResourceId='db-AAAAAAAAAAAAAAAAAAAA';engineVersion='16.4';schemaIdentitySha256=('ef' * 32);trackIoTiming=$true
})
$historyDbiResourceId = $historyFallbackSqlIdentity.DatabaseResourceId
Assert-Condition ($historyFallbackSqlIdentity.QueryIdentifier -ceq $historyQueryIdentifier -and
    $historyFallbackSqlIdentity.QueryIdentifierSha256 -ceq (Get-StringSha256 $historyQueryIdentifier)) 'A signed 64-bit query identifier must retain exact decimal precision and hash binding.'
Assert-Throws { Assert-HistoryFallbackSqlIdentity ([ordered]@{
    identityVersion='history-fallback-queryid-v1';queryIdentifier='01';queryIdentifierSha256=('00' * 32)
    compiledSqlSha256=('ab' * 32);parameterTypeSignatureSha256=('cd' * 32)
    databaseResourceId='db-AAAAAAAAAAAAAAAAAAAA';engineVersion='16.4';schemaIdentitySha256=('ef' * 32);trackIoTiming=$true
}) } 'canonical nonzero signed' 'A noncanonical query identifier must fail closed.'
Assert-Throws { Assert-HistoryFallbackSqlIdentity ([ordered]@{
    identityVersion='history-fallback-queryid-v1';queryIdentifier=$historyQueryIdentifier
    queryIdentifierSha256=(Get-StringSha256 $historyQueryIdentifier)
    compiledSqlSha256=('ab' * 32);parameterTypeSignatureSha256=('cd' * 32)
    databaseResourceId='db-AAAAAAAAAAAAAAAAAAAA';engineVersion='16.4';schemaIdentitySha256=('ef' * 32);trackIoTiming=$false
}) } 'track_io_timing=true' 'A fallback identity without effective PostgreSQL I/O timing must fail closed.'

function Set-TestDiagnosticPrivateAcl {
    param([string]$Path)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $discarded = & icacls.exe $Path /inheritance:r /grant:r "$identity`:(F)" 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply private test ACL.' }
}
$queryIdentityReceiptDirectory = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-diagnostic-query-identity-$([guid]::NewGuid().ToString('N'))"
[void](New-Item -ItemType Directory -Path $queryIdentityReceiptDirectory)
$queryIdentityReceiptPath = Join-Path $queryIdentityReceiptDirectory 'identity.json'
$queryIdentityAppSha = '1' * 40
$queryIdentityDigest = 'sha256:' + ('2' * 64)
$queryIdentityApiArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:27'
$queryIdentityWorkerArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:45'
try {
    $queryIdentityReceipt = [ordered]@{
        schemaVersion=1;type='history_fallback_query_identity_receipt';identityVersion='history-fallback-queryid-v1'
        queryIdentifier=$historyQueryIdentifier;queryIdentifierSha256=(Get-StringSha256 $historyQueryIdentifier)
        compiledSqlSha256=$historyCompiledSqlSha256
        parameterTypeSignatureSha256=(Get-StringSha256 '["$1:text[]:student_ids","$2:text[]:device_ids","$3:text:school_id","$4:bigint:history_limit"]')
        databaseResourceId='db-AAAAAAAAAAAAAAAAAAAA';engineVersion='16.4';schemaIdentitySha256=('ef' * 32);trackIoTiming=$true
        applicationGitSha=$queryIdentityAppSha;deployedImageDigest=$queryIdentityDigest
        activeApiTaskDefinitionArn=$queryIdentityApiArn;activeWorkerTaskDefinitionArn=$queryIdentityWorkerArn
    }
    [IO.File]::WriteAllText($queryIdentityReceiptPath, ($queryIdentityReceipt | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    Set-TestDiagnosticPrivateAcl $queryIdentityReceiptPath
    $queryIdentityReceiptSha = (Get-FileHash -LiteralPath $queryIdentityReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $privateIdentity = Read-HistoryFallbackQueryIdentityReceipt ([ordered]@{path=$queryIdentityReceiptPath;sha256=$queryIdentityReceiptSha}) `
        $queryIdentityAppSha $queryIdentityDigest $queryIdentityApiArn $queryIdentityWorkerArn 'queryid-sqlstats-v1'
    Assert-Condition ($privateIdentity.QueryIdentifier -ceq $historyQueryIdentifier -and
        $privateIdentity.Receipt.Path -ceq [IO.Path]::GetFullPath($queryIdentityReceiptPath) -and
        $privateIdentity.Receipt.Sha256 -ceq $queryIdentityReceiptSha -and
        $privateIdentity.PiEvidenceVersion -ceq 'queryid-sqlstats-v1') 'The diagnostic must read the exact signed query ID privately from an ACL/hash-bound receipt.'
    Assert-Throws { Read-HistoryFallbackQueryIdentityReceipt ([ordered]@{path=$queryIdentityReceiptPath;sha256=$queryIdentityReceiptSha}) `
        ('9' * 40) $queryIdentityDigest $queryIdentityApiArn $queryIdentityWorkerArn 'queryid-sqlstats-v1' } `
        'exact release and active task revisions' 'A private identity receipt for another release must fail diagnostic binding.'
}
finally { Remove-Item -LiteralPath $queryIdentityReceiptDirectory -Recurse -Force }

$leaseBindingDirectory = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-diagnostic-lease-binding-$([guid]::NewGuid().ToString('N'))"
[void](New-Item -ItemType Directory -Path $leaseBindingDirectory)
$leaseBindingReceiptPath = Join-Path $leaseBindingDirectory 'lease.json'
$leaseBindingStatusPath = "$leaseBindingReceiptPath.status.json"
$leaseBindingWatchdogPath = "$leaseBindingReceiptPath.watchdog.json"
try {
    $leaseScheduleArn = 'arn:aws:scheduler:us-east-1:135775632425:schedule/schoolpilot-production-db-insights-leases/db-insights-restore-0123456789abcdef01234567'
    $leaseRoleArn = 'arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore'
    $leaseDlqArn = 'arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq'
    $leaseAutomationDefinitionArn = 'arn:aws:ssm:us-east-1:135775632425:automation-definition/schoolpilot-production-db-insights-restore-v1:1'
    $leaseAutomationRoleArn = 'arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore-automation'
    $leaseAutomationFailureRuleArn = 'arn:aws:events:us-east-1:135775632425:rule/schoolpilot-production-db-insights-restore-failed'
    $leaseAutomationDocumentContentSha256 = '8' * 64
    [IO.File]::WriteAllText($leaseBindingReceiptPath, ([ordered]@{immutable=$true;durableRestoreGuard=[ordered]@{
        version='aws-scheduler-ssm-recurring-restore-v1';bindingSha256=('9' * 64)
        scheduleArn=$leaseScheduleArn;targetRoleArn=$leaseRoleArn;deadLetterQueueArn=$leaseDlqArn
        automationDefinitionArn=$leaseAutomationDefinitionArn;automationRoleArn=$leaseAutomationRoleArn
        automationFailureRuleArn=$leaseAutomationFailureRuleArn;automationDocumentVersion='1'
        automationDocumentContentSha256=$leaseAutomationDocumentContentSha256
    }} | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($leaseBindingStatusPath, '{"state":"active"}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($leaseBindingWatchdogPath, '{"state":"monitoring"}', [Text.UTF8Encoding]::new($false))
    $leaseBindingReceiptSha = (Get-FileHash -LiteralPath $leaseBindingReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $leaseBinding = Assert-DatabaseInsightsLeaseBinding ([ordered]@{version=$script:DatabaseInsightsLeaseVersion;
        receiptPath=$leaseBindingReceiptPath;receiptSha256=$leaseBindingReceiptSha})
    Assert-Condition ($leaseBinding.ReceiptPath -ceq [IO.Path]::GetFullPath($leaseBindingReceiptPath) -and
        $leaseBinding.ReceiptSha256 -ceq $leaseBindingReceiptSha -and
        $leaseBinding.StatusPath -ceq [IO.Path]::GetFullPath($leaseBindingStatusPath) -and
        $leaseBinding.WatchdogPath -ceq [IO.Path]::GetFullPath($leaseBindingWatchdogPath) -and
        $leaseBinding.DurableRestoreScheduleArnSha256 -ceq (Get-StringSha256 $leaseScheduleArn) -and
        $leaseBinding.DurableRestoreTargetRoleArnSha256 -ceq (Get-StringSha256 $leaseRoleArn) -and
        $leaseBinding.DurableRestoreDeadLetterQueueArnSha256 -ceq (Get-StringSha256 $leaseDlqArn) -and
        $leaseBinding.DurableRestoreAutomationDefinitionArnSha256 -ceq (Get-StringSha256 $leaseAutomationDefinitionArn) -and
        $leaseBinding.DurableRestoreAutomationRoleArnSha256 -ceq (Get-StringSha256 $leaseAutomationRoleArn) -and
        $leaseBinding.DurableRestoreAutomationFailureRuleArnSha256 -ceq (Get-StringSha256 $leaseAutomationFailureRuleArn) -and
        $leaseBinding.DurableRestoreAutomationDocumentVersion -ceq '1' -and
        $leaseBinding.DurableRestoreAutomationDocumentContentSha256 -ceq $leaseAutomationDocumentContentSha256) 'The diagnostic lease binding must preserve the exact external immutable receipt and hash its private recurring schedule, Automation, roles, failure rule, and DLQ identities.'
    [IO.File]::AppendAllText($leaseBindingReceiptPath, 'tamper', [Text.UTF8Encoding]::new($false))
    Assert-Throws { Assert-DatabaseInsightsLeaseBinding ([ordered]@{version=$script:DatabaseInsightsLeaseVersion;
        receiptPath=$leaseBindingReceiptPath;receiptSha256=$leaseBindingReceiptSha}) } 'hash does not match' 'A changed Database Insights receipt must fail config validation.'
}
finally { Remove-Item -LiteralPath $leaseBindingDirectory -Recurse -Force }

$leaseTimingDirectory = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-diagnostic-lease-timing-$([guid]::NewGuid().ToString('N'))"
[void](New-Item -ItemType Directory -Path $leaseTimingDirectory)
$leaseTimingReceiptPath = Join-Path $leaseTimingDirectory 'lease.json'
$leaseTimingNow = [DateTimeOffset]'2026-07-20T12:00:00Z'
try {
    function Write-TestLeaseTimingReceipt {
        param([DateTimeOffset]$CapturedAt, [DateTimeOffset]$ExpiresAt)
        [IO.File]::WriteAllText($leaseTimingReceiptPath, ([ordered]@{
            capturedAtUtc=$CapturedAt.ToString('o');expiresAtUtc=$ExpiresAt.ToString('o')
        } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        Set-TestDiagnosticPrivateAcl $leaseTimingReceiptPath
        return (Get-FileHash -LiteralPath $leaseTimingReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $leaseTimingSha = Write-TestLeaseTimingReceipt ($leaseTimingNow.AddMinutes(-5)) ($leaseTimingNow.AddSeconds(3901))
    $leaseTimingConfig = [pscustomobject]@{DatabaseInsightsLease=[pscustomobject]@{
        ReceiptPath=$leaseTimingReceiptPath;ReceiptSha256=$leaseTimingSha
    }}
    $leaseTiming = Get-DatabaseInsightsLeaseTimingEvidence $leaseTimingConfig `
        ($leaseTimingNow.AddSeconds(3901).ToString('o')) $leaseTimingNow
    Assert-Condition ($leaseTiming.timingContractVersion -ceq 'diagnostic-pi-lease-headroom-v1' -and
        $leaseTiming.requiredRemainingSeconds -eq 3900 -and $leaseTiming.remainingSeconds -eq 3901 -and
        $leaseTiming.acquisitionAgeSeconds -eq 300 -and -not $leaseTiming.rawPathsPersisted) `
        'Lease timing must prove traffic, +15-minute publication, full restore timeout, and fixed safety headroom without exposing paths.'

    $leaseTimingSha = Write-TestLeaseTimingReceipt ($leaseTimingNow.AddSeconds(-901)) ($leaseTimingNow.AddMinutes(90))
    $leaseTimingConfig.DatabaseInsightsLease.ReceiptSha256 = $leaseTimingSha
    Assert-Throws { Get-DatabaseInsightsLeaseTimingEvidence $leaseTimingConfig `
        ($leaseTimingNow.AddMinutes(90).ToString('o')) $leaseTimingNow } 'too old' `
        'A lease captured more than fifteen minutes before validation must not authorize fresh traffic.'

    $leaseTimingSha = Write-TestLeaseTimingReceipt ($leaseTimingNow.AddMinutes(-1)) ($leaseTimingNow.AddSeconds(3900))
    $leaseTimingConfig.DatabaseInsightsLease.ReceiptSha256 = $leaseTimingSha
    Assert-Throws { Get-DatabaseInsightsLeaseTimingEvidence $leaseTimingConfig `
        ($leaseTimingNow.AddSeconds(3900).ToString('o')) $leaseTimingNow } 'does not extend beyond' `
        'A lease expiring exactly at the required traffic/publication/restore boundary must fail; headroom is exclusive.'
}
finally {
    Remove-Item -Path Function:Write-TestLeaseTimingReceipt -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $leaseTimingDirectory -Recurse -Force
}

function Read-AtomicJson {
    param([string]$Path)
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 50
}
function Write-TestTrafficEvidence {
    param(
        [string]$ProgressPath,
        [string]$SummaryPath,
        [long]$ActualMilliseconds,
        [bool]$CompletedConfiguredDuration,
        [string]$DurationClock = 'monotonic-hrtime-v1',
        [string]$FinalTimestamp = '2026-07-20T12:30:05Z'
    )
    $progress = @(
        [ordered]@{schemaVersion=1;type='progress';event='start';runId='diagnostic-window-test';stage='800';
            diagnosticOnly=$true;certificationEligible=$false;timestamp='2026-07-20T12:00:00Z';devices=810},
        [ordered]@{schemaVersion=1;type='progress';event='final';runId='diagnostic-window-test';stage='800';
            diagnosticOnly=$true;certificationEligible=$false;timestamp=$FinalTimestamp;devices=810}
    ) | ForEach-Object { $_ | ConvertTo-Json -Depth 10 -Compress }
    [IO.File]::WriteAllLines($ProgressPath, $progress, [Text.UTF8Encoding]::new($false))
    $summary = [ordered]@{
        runId='diagnostic-window-test';stage='800';diagnosticOnly=$true;certificationEligible=$false;devices=810
        workloadSchemaVersion=$script:WorkloadSchemaVersion;workloadEndpointShapeSha256=$script:EndpointShapeSha256
        run=[ordered]@{
            shutdownReason='duration';durationClock=$DurationClock;runtimeTargetTrafficSeconds=1800
            plannedTrafficMilliseconds=1800000;actualTrafficMilliseconds=$ActualMilliseconds
            plannedTrafficSeconds=1800;actualTrafficSeconds=($ActualMilliseconds / 1000.0)
            completedConfiguredDuration=$CompletedConfiguredDuration
        }
    }
    [IO.File]::WriteAllText($SummaryPath, ($summary | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
}

$trafficEvidenceDirectory = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-diagnostic-window-$([guid]::NewGuid().ToString('N'))"
[void](New-Item -ItemType Directory -Path $trafficEvidenceDirectory)
$trafficProgressPath = Join-Path $trafficEvidenceDirectory 'progress.jsonl'
$trafficSummaryPath = Join-Path $trafficEvidenceDirectory 'summary.json'
$trafficWindowConfig = [pscustomobject]@{RunId='diagnostic-window-test'}
try {
    Write-TestTrafficEvidence $trafficProgressPath $trafficSummaryPath 1799900 $false
    $observedRejected = Get-ObservedTrafficWindow $trafficWindowConfig $trafficProgressPath $trafficSummaryPath
    Assert-Condition ($observedRejected.Evidence.coherent -and -not $observedRejected.Evidence.strictlyComplete -and
        $observedRejected.Evidence.actualTrafficMilliseconds -eq 1799900 -and
        $observedRejected.Evidence.durationClock -ceq 'monotonic-hrtime-v1') 'A coherent 1799.9-second run must remain observable but strictly rejected.'
    Assert-Throws { Get-TrafficWindow $trafficWindowConfig $trafficProgressPath $trafficSummaryPath } 'exact completed diagnostic-only' 'Strict traffic acceptance must reject a monotonic interval below 1,800,000 ms.'

    Write-TestTrafficEvidence $trafficProgressPath $trafficSummaryPath 1800000 $true 'monotonic-hrtime-v1' '2026-07-20T11:55:00Z'
    $strictWindow = Get-TrafficWindow $trafficWindowConfig $trafficProgressPath $trafficSummaryPath
    Assert-Condition ([DateTimeOffset]$strictWindow.startUtc -eq [DateTimeOffset]'2026-07-20T12:00:00Z' -and
        [DateTimeOffset]$strictWindow.endUtc -eq [DateTimeOffset]'2026-07-20T12:30:00Z') 'Strict duration must derive solely from monotonic milliseconds even if wall-clock labels roll backward.'

    Write-TestTrafficEvidence $trafficProgressPath $trafficSummaryPath 2200000 $true 'monotonic-hrtime-v1' '2026-07-20T11:55:00Z'
    $lateStrictWindow = Get-TrafficWindow $trafficWindowConfig $trafficProgressPath $trafficSummaryPath
    Assert-Condition ([DateTimeOffset]$lateStrictWindow.endUtc -eq [DateTimeOffset]'2026-07-20T12:36:40Z') 'A late monotonic deadline callback must preserve its full coherent observed window and remain strict once the minimum duration is met.'

    Write-TestTrafficEvidence $trafficProgressPath $trafficSummaryPath 1800000 $true 'wall-clock-v1'
    Assert-Throws { Get-ObservedTrafficWindow $trafficWindowConfig $trafficProgressPath $trafficSummaryPath } 'reviewed monotonic clock' 'A missing or mismatched monotonic duration-clock identity must fail closed.'

    Write-TestTrafficEvidence $trafficProgressPath $trafficSummaryPath 1800000 $true
    $stringTimingSummary = Read-AtomicJson $trafficSummaryPath
    $stringTimingSummary.run.actualTrafficMilliseconds = '1800000'
    [IO.File]::WriteAllText($trafficSummaryPath, ($stringTimingSummary | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    Assert-Throws { Get-ObservedTrafficWindow $trafficWindowConfig $trafficProgressPath $trafficSummaryPath } 'must be JSON numbers' 'Stringified monotonic timing fields must not satisfy strict duration evidence.'
}
finally { Remove-Item -LiteralPath $trafficEvidenceDirectory -Recurse -Force }

$apiTaskArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:99'
$apiRuntimeTaskDefinitionSha256 = Get-StringSha256 $apiTaskArn
$script:diagnosticTaskDefinition = [pscustomobject]@{
    taskDefinitionArn=$apiTaskArn
    containerDefinitions=@([pscustomobject]@{
        name='api'
        logConfiguration=[pscustomobject]@{
            logDriver='awslogs'
            options=[pscustomobject]@{
                'awslogs-group'='/ecs/schoolpilot-production-api'
                'awslogs-region'='us-east-1'
                'awslogs-stream-prefix'='api'
            }
        }
    })
}
$logBinding = Resolve-ApiAwslogsBinding $script:diagnosticTaskDefinition $apiTaskArn 'us-east-1'
Assert-Condition ($logBinding.ApiStreamPrefix -ceq 'api/api/') 'API log evidence must derive the deterministic container stream prefix from the exact task definition.'
$wrongLogGroupTask = $script:diagnosticTaskDefinition | ConvertTo-Json -Depth 10 | ConvertFrom-Json -Depth 10
$wrongLogGroupTask.containerDefinitions[0].logConfiguration.options.'awslogs-group' = '/ecs/other'
Assert-Throws { Resolve-ApiAwslogsBinding $wrongLogGroupTask $apiTaskArn 'us-east-1' } 'reviewed production awslogs binding' 'A different log group must fail the exact API log binding.'
$wrongLogDriverTask = $script:diagnosticTaskDefinition | ConvertTo-Json -Depth 10 | ConvertFrom-Json -Depth 10
$wrongLogDriverTask.containerDefinitions[0].logConfiguration.logDriver = 'splunk'
Assert-Throws { Resolve-ApiAwslogsBinding $wrongLogDriverTask $apiTaskArn 'us-east-1' } 'reviewed production awslogs binding' 'A non-awslogs driver must fail the exact API log binding.'
Assert-Throws { Resolve-ApiAwslogsBinding $script:diagnosticTaskDefinition ($apiTaskArn -replace ':99$',':98') 'us-east-1' } 'exact bound task definition' 'Log evidence must reject a task-definition identity mismatch.'

$script:diagnosticAwsCalls = [System.Collections.Generic.List[object]]::new()
$script:diagnosticLogResponse = [pscustomobject]@{events=@();searchedLogStreams=@()}
$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@();searchedLogStreams=@()}
$script:diagnosticMetricResponse = [pscustomobject]@{
    AlignedStartTime='2026-07-20T12:00:00Z';AlignedEndTime='2026-07-20T12:30:00Z'
    Identifier=$historyDbiResourceId
    MetricList=@([pscustomobject]@{Key='db.load.avg';DataPoints=@(
        [pscustomobject]@{Timestamp='2026-07-20T12:00:00Z';Value=2.5},
        [pscustomobject]@{Timestamp='2026-07-20T12:01:00Z';Value=2.5}
    )})
}
$script:diagnosticHistoryStatement = 'WITH requested_tiles AS (VALUES (?)) SELECT * FROM requested_tiles CROSS JOIN LATERAL (SELECT * FROM heartbeats) h'
$script:diagnosticHistoryTokenId = 'history-token-1'
$script:diagnosticSqlStatsCallsRate = (1.0 / 60.0)
$script:diagnosticSqlStatsTotalTimeRate = 1.0
$script:diagnosticSqlStatsBlockReadTimeRate = 0.2
$script:diagnosticSqlStatsSharedBlocksReadRate = 2.0
$script:diagnosticSqlStatsTempBlocksReadRate = 0.0
$script:diagnosticSqlStatsTempBlocksWrittenRate = 0.0
$script:diagnosticSqlStatsTimestampOverrides = @{}
$script:diagnosticSqlStatsUngroupedTotalsMode = 'none'
$script:diagnosticSqlStatsIdentityMode = 'valid'
$script:diagnosticSqlStatsTimestamps = @('2026-07-20T12:00:00Z')
$script:diagnosticSampledLoad = 1.0
$script:diagnosticSampledIdentityMode = 'valid'
$script:diagnosticTrackIoTimingValue = 'on'
function New-DiagnosticSqlStatsResponse {
    $values = @{
        'db.sql_tokenized.stats.calls_per_sec.avg'=$script:diagnosticSqlStatsCallsRate
        'db.sql_tokenized.stats.total_time_per_sec.avg'=$script:diagnosticSqlStatsTotalTimeRate
        'db.sql_tokenized.stats.blk_read_time_per_sec.avg'=$script:diagnosticSqlStatsBlockReadTimeRate
        'db.sql_tokenized.stats.shared_blks_read_per_sec.avg'=$script:diagnosticSqlStatsSharedBlocksReadRate
        'db.sql_tokenized.stats.temp_blks_read_per_sec.avg'=$script:diagnosticSqlStatsTempBlocksReadRate
        'db.sql_tokenized.stats.temp_blks_written_per_sec.avg'=$script:diagnosticSqlStatsTempBlocksWrittenRate
    }
    $returnedDbId = if($script:diagnosticSqlStatsIdentityMode -ceq 'native_mismatch'){'9223372036854775807'}else{$historyQueryIdentifier}
    $returnedStatement = if($script:diagnosticSqlStatsIdentityMode -ceq 'marker_mismatch'){'SELECT 1'}else{$script:diagnosticHistoryStatement}
    $grouped = @($values.GetEnumerator() | ForEach-Object {
        $metricEntry = $_
        [pscustomobject]@{
            Key=[pscustomobject]@{Metric=[string]$metricEntry.Key;Dimensions=[pscustomobject]@{
                'db.sql_tokenized.db_id'=$returnedDbId
                'db.sql_tokenized.id'=$script:diagnosticHistoryTokenId
                'db.sql_tokenized.statement'=$returnedStatement
            }}
            DataPoints=@($script:diagnosticSqlStatsTimestamps | ForEach-Object {
                [pscustomobject]@{Timestamp=if($script:diagnosticSqlStatsTimestampOverrides.ContainsKey([string]$metricEntry.Key)){
                        [string]$script:diagnosticSqlStatsTimestampOverrides[[string]$metricEntry.Key]
                    }else{[string]$_};Value=[double]$metricEntry.Value}
            })
        }
    })
    if ($script:diagnosticSqlStatsIdentityMode -ceq 'missing') { $grouped = @() }
    if ($script:diagnosticSqlStatsIdentityMode -ceq 'ambiguous' -and $grouped.Count -gt 0) {
        $ambiguous = $grouped[0] | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $ambiguous.Key.Dimensions.'db.sql_tokenized.id' = 'history-token-2'
        $grouped += $ambiguous
    }
    $totals = @()
    if ($script:diagnosticSqlStatsUngroupedTotalsMode -cne 'none') {
        $totals = @($grouped | ForEach-Object {
            [pscustomobject]@{Key=[pscustomobject]@{Metric=$_.Key.Metric};DataPoints=$_.DataPoints}
        })
        if ($script:diagnosticSqlStatsUngroupedTotalsMode -in @('repeated','conflicting')) {
            $value = if ($script:diagnosticSqlStatsUngroupedTotalsMode -ceq 'conflicting') { 999.0 } else {
                [double]$totals[0].DataPoints[0].Value
            }
            $totals += [pscustomobject]@{Key=[pscustomobject]@{Metric=$totals[0].Key.Metric};DataPoints=@(
                [pscustomobject]@{Timestamp=$totals[0].DataPoints[0].Timestamp;Value=$value}
            )}
        }
    }
    return [pscustomobject]@{
        AlignedStartTime='2026-07-20T12:00:00Z';AlignedEndTime='2026-07-20T12:30:00Z'
        Identifier=$historyDbiResourceId
        MetricList=@($totals) + @($grouped)
    }
}
$script:diagnosticTopKeys = @(
    [pscustomobject]@{Total=1.0;Dimensions=[pscustomobject]@{
        'db.sql_tokenized.id'='history-token-1'
        'db.sql_tokenized.statement'=$script:diagnosticHistoryStatement
    }},
    [pscustomobject]@{Total=0.5;Dimensions=[pscustomobject]@{
        'db.sql_tokenized.id'='auth-token-1'
        'db.sql_tokenized.statement'='WITH requested_students AS (VALUES (?)), active_supervision AS (SELECT ?), authorized_students AS (SELECT ?) SELECT ?'
    }},
    [pscustomobject]@{Total=0.25;Dimensions=[pscustomobject]@{
        'db.sql_tokenized.id'='other-token-1';'db.sql_tokenized.statement'='SELECT ?'
    }}
)
$historyWaitKey = "$historyQueryIdentifier|history-token-1"
$script:diagnosticWaitResponses = @{
    $historyWaitKey=[pscustomobject]@{Keys=@(
        [pscustomobject]@{Total=0.2;Dimensions=[pscustomobject]@{'db.wait_event.name'='DataFileRead';'db.wait_event.type'='IO'}},
        [pscustomobject]@{Total=0.8;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
    )}
    '9223372036854775807|history-token-1'=[pscustomobject]@{Keys=@(
        [pscustomobject]@{Total=1.0;Dimensions=[pscustomobject]@{'db.wait_event.name'='DataFileRead';'db.wait_event.type'='IO'}}
    )}
}
$script:diagnosticWaitCallCount = 0
$script:diagnosticTopTokenCalls = [System.Collections.Generic.List[object]]::new()
$script:diagnosticSqlStatsCallCount = 0
$script:diagnosticSampledLoadCallCount = 0
$script:diagnosticPageQueue = $null
function Get-TestArgumentValue {
    param([string[]]$Arguments,[string]$Name)
    $index = [Array]::IndexOf($Arguments,$Name)
    if ($index -lt 0 -or $index + 1 -ge $Arguments.Count) { return $null }
    return $Arguments[$index + 1]
}
function Invoke-AwsJson {
    param([string[]]$Arguments)
    $script:diagnosticAwsCalls.Add(@($Arguments))
    $operation = "$($Arguments[0]) $($Arguments[1])"
    if ($operation -ceq 'logs filter-log-events' -and $null -ne $script:diagnosticPageQueue) {
        if ($script:diagnosticPageQueue.Count -eq 0) { throw 'The diagnostic page queue was exhausted.' }
        return $script:diagnosticPageQueue.Dequeue()
    }
    switch ($operation) {
        'ecs describe-task-definition' {
            Assert-Condition ((Get-TestArgumentValue $Arguments '--task-definition') -ceq $apiTaskArn) 'The log query must re-read the exact bound API task definition.'
            return [pscustomobject]@{taskDefinition=$script:diagnosticTaskDefinition}
        }
        'logs filter-log-events' {
            Assert-Condition ((Get-TestArgumentValue $Arguments '--log-group-name') -ceq '/ecs/schoolpilot-production-api') 'Log evidence must use the task-definition-derived log group.'
            Assert-Condition ((Get-TestArgumentValue $Arguments '--log-stream-name-prefix') -ceq 'api/api/') 'Log evidence must use only exact API container streams.'
            $filterPattern = Get-TestArgumentValue $Arguments '--filter-pattern'
            if ($filterPattern -ceq '"57014"') { return $script:diagnosticLogResponse }
            Assert-Condition ($filterPattern -ceq '"classpilot_heartbeat_hot_path_summary"') 'Fallback evidence must select only sanitized hot-path summary events.'
            return $script:diagnosticHotPathLogResponse
        }
        'pi get-resource-metrics' {
            Assert-Condition ((Get-TestArgumentValue $Arguments '--period-alignment') -ceq 'START_TIME') 'Every PI metric query must use START_TIME period alignment.'
            $metricQueries = Get-TestArgumentValue $Arguments '--metric-queries'
            if ($metricQueries -ceq 'Metric=db.load.avg') {
                $script:diagnosticMetricResponse.AlignedStartTime = Get-TestArgumentValue $Arguments '--start-time'
                $script:diagnosticMetricResponse.AlignedEndTime = Get-TestArgumentValue $Arguments '--end-time'
                $script:diagnosticMetricResponse.Identifier = Get-TestArgumentValue $Arguments '--identifier'
                return $script:diagnosticMetricResponse
            }
            $script:diagnosticSqlStatsCallCount++
            $parsedQueries = @($metricQueries | ConvertFrom-Json -Depth 20)
            Assert-Condition ($parsedQueries.Count -eq 6) 'The fallback SQL-statistics query must request every reviewed call and I/O metric together.'
            foreach ($query in $parsedQueries) {
                Assert-Condition ([string]$query.Filter.'db.sql_tokenized.db_id' -ceq $historyQueryIdentifier) 'Every SQL-statistics metric must filter by the exact native PostgreSQL query identifier.'
            }
            $statsResponse = New-DiagnosticSqlStatsResponse
            $statsResponse.AlignedStartTime = Get-TestArgumentValue $Arguments '--start-time'
            $statsResponse.AlignedEndTime = Get-TestArgumentValue $Arguments '--end-time'
            $statsResponse.Identifier = Get-TestArgumentValue $Arguments '--identifier'
            return $statsResponse
        }
        'rds describe-db-parameters' {
            Assert-Condition ('--no-paginate' -in $Arguments) 'The track_io_timing parameter read must disable implicit AWS CLI pagination.'
            Assert-Condition ((Get-TestArgumentValue $Arguments '--filters') -ceq 'Name=parameter-name,Values=track_io_timing') 'The RDS parameter read must filter to track_io_timing.'
            return [pscustomobject]@{Parameters=@([pscustomobject]@{
                ParameterName='track_io_timing';ParameterValue=$script:diagnosticTrackIoTimingValue
            })}
        }
        'pi describe-dimension-keys' {
            $groupBy = Get-TestArgumentValue $Arguments '--group-by'
            if ($groupBy -ceq 'Group=db.sql_tokenized,Limit=25') {
                $script:diagnosticTopTokenCalls.Add([pscustomobject]@{
                    StartUtc=Get-TestArgumentValue $Arguments '--start-time'
                    EndUtc=Get-TestArgumentValue $Arguments '--end-time'
                })
                return [pscustomobject]@{AlignedStartTime=(Get-TestArgumentValue $Arguments '--start-time');
                    AlignedEndTime=(Get-TestArgumentValue $Arguments '--end-time');Keys=$script:diagnosticTopKeys}
            }
            if ($groupBy -ceq 'Group=db.sql_tokenized,Dimensions=[db.sql_tokenized.db_id,db.sql_tokenized.id,db.sql_tokenized.statement],Limit=25') {
                $script:diagnosticSampledLoadCallCount++
                $filter = (Get-TestArgumentValue $Arguments '--filter') | ConvertFrom-Json
                Assert-Condition ([string]$filter.'db.sql_tokenized.db_id' -ceq $historyQueryIdentifier) 'Sampled fallback load must be filtered by the exact native query identifier.'
                $sampledDbId = if($script:diagnosticSampledIdentityMode -ceq 'native_mismatch'){'9223372036854775807'}else{$historyQueryIdentifier}
                $sampledStatement = if($script:diagnosticSampledIdentityMode -ceq 'marker_mismatch'){'SELECT 1'}else{$script:diagnosticHistoryStatement}
                $keys = if ($null -eq $script:diagnosticSampledLoad) { @() } else { @([pscustomobject]@{
                    Total=[double]$script:diagnosticSampledLoad;Dimensions=[pscustomobject]@{
                        'db.sql_tokenized.db_id'=$sampledDbId
                        'db.sql_tokenized.id'=$script:diagnosticHistoryTokenId
                        'db.sql_tokenized.statement'=$sampledStatement
                    }
                }) }
                if ($script:diagnosticSampledIdentityMode -ceq 'ambiguous' -and $keys.Count -eq 1) {
                    $extra = $keys[0] | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
                    $extra.Dimensions.'db.sql_tokenized.id' = 'history-token-2'
                    $keys += $extra
                }
                return [pscustomobject]@{AlignedStartTime=(Get-TestArgumentValue $Arguments '--start-time');
                    AlignedEndTime=(Get-TestArgumentValue $Arguments '--end-time');Keys=$keys}
            }
            Assert-Condition ($groupBy -ceq 'Group=db.wait_event,Limit=25') 'Present history tokens must be resolved through filtered wait-event evidence.'
            $script:diagnosticWaitCallCount++
            $filter = (Get-TestArgumentValue $Arguments '--filter') | ConvertFrom-Json
            $dbId = [string]$filter.'db.sql_tokenized.db_id'
            $tokenId = [string]$filter.'db.sql_tokenized.id'
            $waitIdentity = "$dbId|$tokenId"
            if (-not $script:diagnosticWaitResponses.ContainsKey($waitIdentity)) { throw 'No test wait response for the exact native/tokenized SQL identity.' }
            $waitResponse = $script:diagnosticWaitResponses[$waitIdentity]
            return [pscustomobject]@{AlignedStartTime=(Get-TestArgumentValue $Arguments '--start-time');
                AlignedEndTime=(Get-TestArgumentValue $Arguments '--end-time');Keys=@($waitResponse.Keys)}
        }
        default { throw "Unexpected diagnostic evidence test command: $operation" }
    }
}

$diagnosticConfig = [pscustomobject]@{ApplicationGitSha=('1' * 40);ImageDigest=('sha256:' + ('2' * 64));
    ApiTaskDefinitionArn=$apiTaskArn;WorkerTaskDefinitionArn='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:99';
    Resources=[pscustomobject]@{region='us-east-1'};HistoryFallbackSqlIdentity=$historyFallbackSqlIdentity}
$trackIoInstance = [pscustomobject]@{DBParameterGroups=@([pscustomobject]@{
    DBParameterGroupName='schoolpilot-production-postgres16';ParameterApplyStatus='in-sync'
})}
$trackIoPosture = Get-DiagnosticTrackIoTimingPosture $trackIoInstance $diagnosticConfig
Assert-Condition ($trackIoPosture.enabled -eq $true -and $trackIoPosture.pageCount -eq 1 -and
    [string]$trackIoPosture.parameterGroupSha256 -match '^[0-9a-f]{64}$') `
    'Diagnostic preflight must independently verify effective track_io_timing from the active in-sync RDS parameter group.'
$script:diagnosticTrackIoTimingValue = 'off'
Assert-Throws { Get-DiagnosticTrackIoTimingPosture $trackIoInstance $diagnosticConfig } `
    'must be enabled' 'A disabled effective RDS track_io_timing value must fail diagnostic preflight closed.'
$script:diagnosticTrackIoTimingValue = 'on'
$trafficStart = '2026-07-20T12:00:00.0000000+00:00'
$trafficEnd = '2026-07-20T12:30:00.0000000+00:00'
$noTimeouts = Get-Postgres57014Evidence $diagnosticConfig $trafficStart $trafficEnd
Assert-Condition ($noTimeouts.passed -and $noTimeouts.matchCount -eq 0 -and -not $noTimeouts.rawMessagesPersisted -and -not $noTimeouts.rawIdentifiersPersisted) 'Zero exact-interval API SQLSTATE 57014 events must pass with sanitized evidence.'
$noTimeoutsJson = $noTimeouts | ConvertTo-Json -Depth 10 -Compress
Assert-Condition (-not $noTimeoutsJson.Contains('/ecs/schoolpilot-production-api') -and -not $noTimeoutsJson.Contains('api/api/')) 'Timeout evidence must hash rather than persist CloudWatch identifiers.'
$script:diagnosticPageQueue = [Collections.Generic.Queue[object]]::new()
$script:diagnosticPageQueue.Enqueue([pscustomobject]@{events=@([pscustomobject]@{eventId='page-event-1';value=1});nextToken='page-2'})
$script:diagnosticPageQueue.Enqueue([pscustomobject]@{events=@([pscustomobject]@{eventId='page-event-2';value=2})})
$pagedEvidence = Invoke-EvidenceAwsJsonPages -Arguments @('logs','filter-log-events') -ItemsProperty 'events' -TokenProperty 'nextToken' -Identity {
    param($event) return [string](Get-Value $event 'eventId' '')
}
Assert-Condition ($pagedEvidence.PageCount -eq 2 -and $pagedEvidence.RecordCount -eq 2) 'Evidence pagination must consume every explicit page exactly once.'
$script:diagnosticPageQueue = [Collections.Generic.Queue[object]]::new()
$script:diagnosticPageQueue.Enqueue([pscustomobject]@{events=@([pscustomobject]@{eventId='duplicate-event';value=1});nextToken='duplicate-page-2'})
$script:diagnosticPageQueue.Enqueue([pscustomobject]@{events=@([pscustomobject]@{eventId='duplicate-event';value=2})})
Assert-Throws {
    Invoke-EvidenceAwsJsonPages -Arguments @('logs','filter-log-events') -ItemsProperty 'events' -TokenProperty 'nextToken' -Identity {
        param($event) return [string](Get-Value $event 'eventId' '')
    }
} 'conflicting duplicate' 'Evidence pagination must reject conflicting duplicate records across pages.'
$script:diagnosticPageQueue = $null
$startMs = ([DateTimeOffset]$trafficStart).ToUnixTimeMilliseconds()
$script:diagnosticLogResponse = [pscustomobject]@{events=@([pscustomobject]@{
    timestamp=$startMs + 1;logStreamName='api/api/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    eventId='raw-event-identifier';message='database@example.test cancel SQLSTATE 57014 raw-message'
})}
$timeouts = Get-Postgres57014Evidence $diagnosticConfig $trafficStart $trafficEnd
Assert-Condition (-not $timeouts.passed -and $timeouts.matchCount -eq 1) 'Any API SQLSTATE 57014 event in the exact traffic interval must fail closed.'
$timeoutsJson = $timeouts | ConvertTo-Json -Depth 10 -Compress
Assert-Condition (-not $timeoutsJson.Contains('database@example.test') -and -not $timeoutsJson.Contains('raw-event-identifier') -and
    -not $timeoutsJson.Contains('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) 'Timeout evidence must never persist raw messages, event ids, or stream ids.'
$script:diagnosticLogResponse.events[0].timestamp = $startMs - 1
Assert-Throws { Get-Postgres57014Evidence $diagnosticConfig $trafficStart $trafficEnd } 'out-of-scope' 'CloudWatch events outside the exact traffic interval must be rejected.'
$script:diagnosticLogResponse = [pscustomobject]@{events=@();nextToken='unconsumed-page'}
Assert-Throws { Get-Postgres57014Evidence $diagnosticConfig $trafficStart $trafficEnd } 'token cycle' 'A cyclic CloudWatch pagination token must fail closed.'
$script:diagnosticLogResponse = [pscustomobject]@{events=@()}
$hotPathMessage = [ordered]@{
    event='classpilot_heartbeat_hot_path_summary';intervalSeconds=60
    intervalStartedAtUtc='2026-07-20T12:00:00Z';intervalEndedAtUtc='2026-07-20T12:01:00Z'
    historyFallbackSqlIdentityVersion='history-fallback-queryid-v1'
    historyFallbackSqlIdentitySha256=$historyCompiledSqlSha256
    apiRuntimeTaskDefinitionSha256=$apiRuntimeTaskDefinitionSha256
    counters=[ordered]@{tileBatchHistoryFallbackItems=40}
    timings=[ordered]@{tileBatchHistoryDatabaseMs=[ordered]@{count=1;totalMs=12.5;maxMs=12.5}}
} | ConvertTo-Json -Depth 10 -Compress
$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@([pscustomobject]@{
    timestamp=$startMs + 60000;logStreamName='api/api/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    eventId='hot-path-raw-event-id';message=$hotPathMessage
})}
$testFallbackWindows = @([pscustomobject]@{
    StartUtc='2026-07-20T12:00:00Z';EndUtc='2026-07-20T12:01:00Z';DatabaseReadCount=1
})

$script:diagnosticWaitCallCount = 0
$script:diagnosticTopTokenCalls.Clear()
$script:diagnosticSqlStatsCallCount = 0
$script:diagnosticSampledLoadCallCount = 0
$piEvidence = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition ($piEvidence.passed -and $piEvidence.tileAuthorization.passed) 'Existing aggregate tile-authorization non-dominance must remain enforced.'
Assert-Condition ($piEvidence.historyFallback.historyFallbackPiEvidenceVersion -ceq 'queryid-sqlstats-v1' -and
    $piEvidence.historyFallback.sqlStatistics.integratedCalls -ge 1 -and
    $piEvidence.historyFallback.sqlStatistics.callsCoverApplicationReads -and
    $piEvidence.historyFallback.sqlStatistics.blockReadTimeSharePercent -eq 20.0 -and
    [string]$piEvidence.historyFallback.sqlStatistics.releaseIdentitySha256 -match '^[0-9a-f]{64}$' -and
    $piEvidence.historyFallback.sampledLoad.filteredWaitEventEvidenceComplete -and
    $piEvidence.historyFallback.sampledLoad.dataFileReadSharePercent -eq 20.0 -and
    $piEvidence.historyFallback.source.fallbackPositiveSummaryCount -eq 1 -and
    $piEvidence.historyFallback.source.batchHistoryDatabaseReadCount -eq 1 -and
    $script:diagnosticWaitCallCount -eq 1 -and $script:diagnosticSqlStatsCallCount -eq 1 -and
    $script:diagnosticSampledLoadCallCount -eq 1) 'A fallback-positive batch database-read window must have deterministic query-ID-bound call statistics and sampled-wait evidence below 50 percent.'
Assert-Condition ($piEvidence.historyFallback.sqlStatistics.bucketCoverage.coverageContractVersion -ceq 'queryid-minute-sparse-v1' -and
    $piEvidence.historyFallback.sqlStatistics.bucketCoverage.expectedBucketCount -eq 30 -and
    $piEvidence.historyFallback.sqlStatistics.bucketCoverage.observedBucketCount -eq 1 -and
    $piEvidence.historyFallback.sqlStatistics.bucketCoverage.omittedSparseBucketCount -eq 29 -and
    $piEvidence.historyFallback.sqlStatistics.bucketCoverage.applicationActiveBucketCount -eq 1 -and
    $piEvidence.historyFallback.sqlStatistics.bucketCoverage.unobservedApplicationActiveBucketCount -eq 0 -and
    $piEvidence.historyFallback.sqlStatistics.bucketCoverage.missingMiddleBucketCount -eq 0 -and
    [string]$piEvidence.historyFallback.sqlStatistics.bucketCoverage.expectedBucketSetSha256 -match '^[0-9a-f]{64}$' -and
    [string]$piEvidence.historyFallback.sqlStatistics.bucketCoverage.observedBucketSetSha256 -match '^[0-9a-f]{64}$') `
    'SQL-statistics evidence must explicitly seal the expected/observed minute lattice and allow only inactive leading/trailing sparse buckets.'
Assert-Condition ([string]$piEvidence.evidenceWindow.coherentWindowSha256 -match '^[0-9a-f]{64}$' -and
    [string]$piEvidence.evidenceWindow.alignedEvidenceWindowSha256 -match '^[0-9a-f]{64}$' -and
    $piEvidence.evidenceWindow.alignedCoveragePercent -eq 100.0 -and
    $piEvidence.historyFallback.source.coherentWindowSha256 -ceq $piEvidence.evidenceWindow.coherentWindowSha256 -and
    $piEvidence.historyFallback.source.alignedEvidenceWindowSha256 -ceq $piEvidence.evidenceWindow.alignedEvidenceWindowSha256) 'Sealed PI and hot-path evidence must bind the same coherent and aligned subwindow hashes and coverage.'
$script:diagnosticSqlStatsCallsRate = (0.9995 / 60.0)
$strictCallUndercount = Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId 1 $testFallbackWindows
Assert-Condition (-not $strictCallUndercount.Evidence.callsCoverApplicationReads -and -not $strictCallUndercount.Evidence.passed) 'Integrated PI calls below the exact aligned application read count must fail without tolerance.'
$script:diagnosticSqlStatsCallsRate = (1.0 / 60.0)
$script:diagnosticSqlStatsUngroupedTotalsMode = 'single'
$withDimensionlessTotals = Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId 1 $testFallbackWindows
Assert-Condition ($withDimensionlessTotals.Evidence.passed -and
    $withDimensionlessTotals.Evidence.ignoredUngroupedTotalSeriesCount -eq 6) `
    'AWS dimensionless GetResourceMetrics totals must be ignored by the diagnostic SQL-statistics gate.'
$script:diagnosticSqlStatsUngroupedTotalsMode = 'repeated'
$withRepeatedDimensionlessTotal = Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId 1 $testFallbackWindows
Assert-Condition ($withRepeatedDimensionlessTotal.Evidence.passed -and
    $withRepeatedDimensionlessTotal.Evidence.repeatedUngroupedTotalSeriesCount -eq 1) `
    'Identical repeated dimensionless totals must be deduplicated in the diagnostic collector.'
$script:diagnosticSqlStatsUngroupedTotalsMode = 'conflicting'
Assert-Throws {
    Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId 1 $testFallbackWindows
} 'conflicting duplicate ungrouped total' 'Conflicting repeated dimensionless totals must fail the diagnostic collector closed.'
$script:diagnosticSqlStatsUngroupedTotalsMode = 'none'
Assert-Condition ($script:diagnosticTopTokenCalls.Count -eq 1) 'Top-25 token discovery must remain only for aggregate authorization evidence, never fallback identity discovery.'

$script:diagnosticSqlStatsIdentityMode = 'missing'
$missingIdentitySnapshot = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
$missingIdentityEnvelope = New-EvidenceEnvelope -Collected $true -Passed $missingIdentitySnapshot.passed -AttemptCount 2 `
    -FailureCode $null -FailureStage $null -MessageSha256 $null -Evidence $missingIdentitySnapshot
Assert-Condition ($missingIdentityEnvelope.collected -and -not $missingIdentityEnvelope.passed -and
    $missingIdentityEnvelope.state -ceq 'completed' -and $null -eq $missingIdentityEnvelope.failureCode -and
    @($missingIdentityEnvelope.historyFallback.sqlStatistics.failureReasons) -contains 'missing_query_identity' -and
    $missingIdentityEnvelope.historyFallback.sampledLoad.status -ceq 'not_evaluated_identity_gate_failed') `
    'A stable missing query token must seal as a collected deterministic gate failure, not PI evidence unavailability.'

$script:diagnosticSqlStatsIdentityMode = 'ambiguous'
$ambiguousIdentity = Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd `
    $historyDbiResourceId 1 $testFallbackWindows
Assert-Condition (-not $ambiguousIdentity.Evidence.passed -and
    @($ambiguousIdentity.Evidence.failureReasons) -contains 'ambiguous_query_identity') `
    'Multiple query-ID-filtered token identities must produce a deterministic ambiguous-identity gate failure.'

$script:diagnosticSqlStatsIdentityMode = 'native_mismatch'
$driftedIdentity = Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd `
    $historyDbiResourceId 1 $testFallbackWindows
Assert-Condition (-not $driftedIdentity.Evidence.passed -and
    @($driftedIdentity.Evidence.failureReasons) -contains 'native_query_identifier_mismatch') `
    'A stable native PostgreSQL query-ID drift must produce a collected gate failure.'

$script:diagnosticSqlStatsIdentityMode = 'marker_mismatch'
$markerDrift = Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd `
    $historyDbiResourceId 1 $testFallbackWindows
Assert-Condition (-not $markerDrift.Evidence.passed -and
    @($markerDrift.Evidence.failureReasons) -contains 'statement_marker_mismatch') `
    'A stable tokenized statement-shape drift must produce a collected gate failure.'

$script:diagnosticSqlStatsIdentityMode = 'valid'
$script:diagnosticSqlStatsCallsRate = 0.0
$script:diagnosticSampledLoad = $null
$missingCalls = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $missingCalls.passed -and
    @($missingCalls.historyFallback.sqlStatistics.failureReasons) -contains 'missing_positive_calls' -and
    @($missingCalls.historyFallback.sqlStatistics.failureReasons) -contains 'pi_call_undercount' -and
    @($missingCalls.historyFallback.sqlStatistics.failureReasons) -contains 'application_active_bucket_without_positive_calls' -and
    -not $missingCalls.historyFallback.sqlStatistics.bucketCoverage.positiveCallCoveragePassed -and
    $missingCalls.historyFallback.sqlStatistics.bucketCoverage.zeroCallApplicationActiveBucketCount -eq 1) `
    'Stable zero SQL-call statistics must be a deterministic collected per-application-bucket gate failure.'
$script:diagnosticSqlStatsCallsRate = (1.0 / 60.0)
$script:diagnosticSampledLoad = 1.0

$script:diagnosticSampledIdentityMode = 'native_mismatch'
$sampledIdentityDrift = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $sampledIdentityDrift.passed -and
    $sampledIdentityDrift.historyFallback.sampledLoad.status -ceq 'sampled_identity_mismatch' -and
    @($sampledIdentityDrift.historyFallback.sampledLoad.failureReasons) -contains 'sampled_identity_mismatch') `
    'Stable sampled-load identity drift must seal as a deterministic gate failure.'
$script:diagnosticSampledIdentityMode = 'valid'

$script:diagnosticSqlStatsTimestamps = @('2026-07-20T12:00:00Z','2026-07-20T12:02:00Z')
$twoFallbackWindows = @(
    [pscustomobject]@{StartUtc='2026-07-20T12:00:00Z';EndUtc='2026-07-20T12:01:00Z';DatabaseReadCount=1},
    [pscustomobject]@{StartUtc='2026-07-20T12:02:00Z';EndUtc='2026-07-20T12:03:00Z';DatabaseReadCount=1}
)
Assert-Throws { Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd `
    $historyDbiResourceId 2 $twoFallbackWindows } 'missing-middle' `
    'A missing interior SQL-statistics minute must fail closed even when aggregate calls could cover application reads.'
$script:diagnosticSqlStatsTimestamps = @('2026-07-20T12:00:00Z')
$uncoveredFallbackWindow = @([pscustomobject]@{
    StartUtc='2026-07-20T12:01:00Z';EndUtc='2026-07-20T12:02:00Z';DatabaseReadCount=1
})
Assert-Throws { Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd `
    $historyDbiResourceId 1 $uncoveredFallbackWindow } 'application-active sparse' `
    'A sparse PI bucket overlapping a fallback-positive application interval must fail closed.'
$script:diagnosticSqlStatsTimestamps = @('2026-07-20T12:00:00Z')

Assert-Condition (@($piEvidence.tokens | Where-Object category -eq 'history_fallback').Count -eq 0 -and
    @($piEvidence.tokens | Where-Object category -eq 'tile_authorization').Count -eq 1) 'Full-interval top tokens must classify only authorization SQL; fallback identity and markers belong exclusively to query-ID-filtered evidence.'
$piEvidenceJson = $piEvidence | ConvertTo-Json -Depth 20 -Compress
Assert-Condition (-not $piEvidenceJson.Contains('history-token-1') -and -not $piEvidenceJson.Contains('requested_tiles') -and
    -not $piEvidenceJson.Contains($historyQueryIdentifier) -and
    -not $piEvidenceJson.Contains($historyDbiResourceId) -and
    -not $piEvidenceJson.Contains('IO:DataFileRead') -and -not $piEvidenceJson.Contains('hot-path-raw-event-id') -and
    -not $piEvidenceJson.Contains('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') -and -not $piEvidenceJson.Contains('api/api/')) 'Performance Insights evidence must retain hashes/categories rather than raw SQL, token ids, log messages, stream ids, or wait-event names.'
$script:diagnosticTopKeys[1].Total = 1.25
$authorizationBoundary = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $authorizationBoundary.passed -and -not $authorizationBoundary.tileAuthorization.passed -and
    $authorizationBoundary.tileAuthorization.sharePercent -eq 50.0) 'Authorization PI share at exactly 50 percent must fail the exclusive threshold.'
$script:diagnosticTopKeys[1].Total = 1.249975
$authorizationBelowBoundary = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition ($authorizationBelowBoundary.passed -and $authorizationBelowBoundary.tileAuthorization.passed -and
    $authorizationBelowBoundary.tileAuthorization.sharePercent -eq 49.999) 'Authorization PI share at 49.999 percent must satisfy the exclusive threshold without rounded-boundary drift.'
$script:diagnosticTopKeys[1].Total = 0.5

$validHotPathLogResponse = $script:diagnosticHotPathLogResponse
$wrongRuntimePayload = $hotPathMessage | ConvertFrom-Json -Depth 20
$wrongRuntimePayload.apiRuntimeTaskDefinitionSha256 = ('0' * 64)
$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@([pscustomobject]@{
    timestamp=$startMs + 60000;logStreamName='api/api/runtime-mismatch'
    eventId='runtime-mismatch';message=($wrongRuntimePayload | ConvertTo-Json -Depth 20 -Compress)
})}
Assert-Throws { Get-HotPathFallbackEvidenceWindows $diagnosticConfig $trafficStart $trafficEnd } `
    'API runtime identities' 'Every diagnostic fallback-positive interval must bind the exact emitting API revision hash.'
$script:diagnosticHotPathLogResponse = $validHotPathLogResponse
$edgeHotPathMessage = [ordered]@{
    event='classpilot_heartbeat_hot_path_summary';intervalSeconds=60
    intervalStartedAtUtc='2026-07-20T12:00:00Z';intervalEndedAtUtc='2026-07-20T12:01:00Z'
    historyFallbackSqlIdentityVersion='history-fallback-queryid-v1';historyFallbackSqlIdentitySha256=$historyCompiledSqlSha256
    apiRuntimeTaskDefinitionSha256=$apiRuntimeTaskDefinitionSha256
    counters=[ordered]@{tileBatchHistoryFallbackItems=400}
    timings=[ordered]@{tileBatchHistoryDatabaseMs=[ordered]@{count=10;totalMs=30;maxMs=5}}
} | ConvertTo-Json -Depth 10 -Compress
$interiorHotPathMessage = [ordered]@{
    event='classpilot_heartbeat_hot_path_summary';intervalSeconds=60
    intervalStartedAtUtc='2026-07-20T12:01:00Z';intervalEndedAtUtc='2026-07-20T12:02:00Z'
    historyFallbackSqlIdentityVersion='history-fallback-queryid-v1';historyFallbackSqlIdentitySha256=$historyCompiledSqlSha256
    apiRuntimeTaskDefinitionSha256=$apiRuntimeTaskDefinitionSha256
    counters=[ordered]@{tileBatchHistoryFallbackItems=40}
    timings=[ordered]@{tileBatchHistoryDatabaseMs=[ordered]@{count=1;totalMs=3;maxMs=3}}
} | ConvertTo-Json -Depth 10 -Compress
$fractionalTrafficStart = '2026-07-20T12:00:30Z'
$fractionalTrafficEnd = '2026-07-20T12:30:45Z'
$fractionalStartMs = ([DateTimeOffset]$fractionalTrafficStart).ToUnixTimeMilliseconds()
$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@(
    [pscustomobject]@{timestamp=$fractionalStartMs + 31000;logStreamName='api/api/edge';message=$edgeHotPathMessage},
    [pscustomobject]@{timestamp=$fractionalStartMs + 91000;logStreamName='api/api/interior';message=$interiorHotPathMessage}
)}
$alignedHotPath = Get-HotPathFallbackEvidenceWindows $diagnosticConfig $fractionalTrafficStart $fractionalTrafficEnd
Assert-Condition ($alignedHotPath.Evidence.excludedEdgeSummaryCount -eq 1 -and
    $alignedHotPath.Evidence.fallbackPositiveSummaryCount -eq 1 -and
    $alignedHotPath.Evidence.batchHistoryDatabaseReadCount -eq 1 -and
    $alignedHotPath.Windows[0].ObservedSeconds -eq 60.0 -and
    $alignedHotPath.Windows[0].StartUtc -ceq '2026-07-20T12:01:00.0000000+00:00') 'Fallback counts must exclude natural edge summaries and use only complete payload-declared intervals wholly inside the aligned PI subwindow.'
$script:diagnosticHotPathLogResponse = $validHotPathLogResponse
$missingIntervalMessage = [ordered]@{
    event='classpilot_heartbeat_hot_path_summary';intervalSeconds=60
    historyFallbackSqlIdentityVersion='history-fallback-queryid-v1';historyFallbackSqlIdentitySha256=$historyCompiledSqlSha256
    apiRuntimeTaskDefinitionSha256=$apiRuntimeTaskDefinitionSha256
    counters=[ordered]@{tileBatchHistoryFallbackItems=40}
    timings=[ordered]@{tileBatchHistoryDatabaseMs=[ordered]@{count=1;totalMs=3;maxMs=3}}
} | ConvertTo-Json -Depth 10 -Compress
$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@([pscustomobject]@{
    timestamp=$startMs + 60000;logStreamName='api/api/missing-interval';message=$missingIntervalMessage
})}
Assert-Throws { Get-HotPathFallbackEvidenceWindows $diagnosticConfig $trafficStart $trafficEnd } 'valid UTC interval bounds' 'Every fallback-positive hot-path summary must declare its exact UTC interval.'
$script:diagnosticHotPathLogResponse = $validHotPathLogResponse
$unalignedIntervalMessage = [ordered]@{
    event='classpilot_heartbeat_hot_path_summary';intervalSeconds=60
    intervalStartedAtUtc='2026-07-20T12:00:00.001Z';intervalEndedAtUtc='2026-07-20T12:01:00.001Z'
    historyFallbackSqlIdentityVersion='history-fallback-queryid-v1';historyFallbackSqlIdentitySha256=$historyCompiledSqlSha256
    apiRuntimeTaskDefinitionSha256=$apiRuntimeTaskDefinitionSha256
    counters=[ordered]@{tileBatchHistoryFallbackItems=40}
    timings=[ordered]@{tileBatchHistoryDatabaseMs=[ordered]@{count=1;totalMs=3;maxMs=3}}
} | ConvertTo-Json -Depth 10 -Compress
$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@([pscustomobject]@{
    timestamp=$startMs + 60000;logStreamName='api/api/unaligned-interval';message=$unalignedIntervalMessage
})}
Assert-Throws { Get-HotPathFallbackEvidenceWindows $diagnosticConfig $trafficStart $trafficEnd } 'complete UTC summary interval' 'Fallback-positive intervals must align exactly to the UTC-minute PI lattice.'
$script:diagnosticHotPathLogResponse = $validHotPathLogResponse
$counterOnlyMessage = [ordered]@{
    event='classpilot_heartbeat_hot_path_summary';intervalSeconds=60
    intervalStartedAtUtc='2026-07-20T12:00:00Z';intervalEndedAtUtc='2026-07-20T12:01:00Z'
    historyFallbackSqlIdentityVersion='history-fallback-queryid-v1'
    historyFallbackSqlIdentitySha256=$historyCompiledSqlSha256
    apiRuntimeTaskDefinitionSha256=$apiRuntimeTaskDefinitionSha256
    counters=[ordered]@{tileBatchHistoryFallbackItems=40};timings=[ordered]@{}
} | ConvertTo-Json -Depth 10 -Compress
$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@([pscustomobject]@{
    timestamp=$startMs + 60000;logStreamName='api/api/cccccccccccccccccccccccccccccccc';message=$counterOnlyMessage
})}
Assert-Throws { Get-HotPathFallbackEvidenceWindows $diagnosticConfig $trafficStart $trafficEnd } 'batch history database timing' 'A fallback counter without a same-summary batch database-read timing must fail closed.'

$zeroFallbackMessage = [ordered]@{
    event='classpilot_heartbeat_hot_path_summary';intervalSeconds=60
    counters=[ordered]@{tileBatchHistoryFallbackItems=0};timings=[ordered]@{}
} | ConvertTo-Json -Depth 10 -Compress
$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@([pscustomobject]@{
    timestamp=$startMs + 60000;logStreamName='api/api/dddddddddddddddddddddddddddddddd';message=$zeroFallbackMessage
})}
$script:diagnosticWaitCallCount = 0
$noFallbackWindow = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $noFallbackWindow.passed -and -not $noFallbackWindow.historyFallback.passed -and
    $noFallbackWindow.historyFallback.source.fallbackPositiveSummaryCount -eq 0 -and
    $script:diagnosticWaitCallCount -eq 0) 'A run with no observed batch fallback/database-read window must fail closed without fabricating per-token wait evidence.'

$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@();nextToken='unconsumed-hot-path-page'}
Assert-Throws { Get-HotPathFallbackEvidenceWindows $diagnosticConfig $trafficStart $trafficEnd } 'token cycle' 'Cyclic hot-path CloudWatch pagination must fail closed.'
$script:diagnosticHotPathLogResponse = $validHotPathLogResponse

$script:fakeEvidenceNow = ([DateTimeOffset]$trafficEnd).AddMinutes(4)
$script:fakeEvidenceDelays = [Collections.Generic.List[int]]::new()
$script:fakePiSnapshotCalls = 0
$script:fakePiChanging = $false
$script:fakePiAdvanceSeconds = 0
$script:fakePiPassed = $true
$script:PerformanceInsightsPollSeconds = 60
function Get-EvidenceUtcNow { return $script:fakeEvidenceNow }
function Wait-EvidenceDelay {
    param([int]$Seconds)
    $script:fakeEvidenceDelays.Add($Seconds)
    $script:fakeEvidenceNow = $script:fakeEvidenceNow.AddSeconds($Seconds)
}
function Get-PerformanceInsightsEvidence {
    param($Config,[string]$StartUtc,[string]$EndUtc,[string]$DbiResourceId)
    $script:fakePiSnapshotCalls++
    if ($script:fakePiAdvanceSeconds -gt 0) { $script:fakeEvidenceNow = $script:fakeEvidenceNow.AddSeconds($script:fakePiAdvanceSeconds) }
    return [ordered]@{diagnosticOnly=$true;sanitized=$true;passed=$script:fakePiPassed;
        generation=if($script:fakePiChanging){$script:fakePiSnapshotCalls}else{1};
        tileAuthorization=[ordered]@{passed=$true};historyFallback=[ordered]@{passed=$script:fakePiPassed}}
}
$fakeStabilizedPi = Get-StabilizedPerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition ($fakeStabilizedPi.AttemptCount -eq 2 -and $script:fakePiSnapshotCalls -eq 2 -and
    ($script:fakeEvidenceDelays -join ',') -ceq '60,60') "PI stabilization must use an injectable clock/sleeper, wait until traffic-end plus five minutes, and require two consecutive snapshots (attempts=$($fakeStabilizedPi.AttemptCount), calls=$script:fakePiSnapshotCalls, delays=$($script:fakeEvidenceDelays -join ','))."
$script:fakeEvidenceNow = ([DateTimeOffset]$trafficEnd).AddMinutes(4)
$script:fakeEvidenceDelays.Clear()
$script:fakePiSnapshotCalls = 0
$script:fakePiPassed = $false
$stableGateFailure = Get-StabilizedPerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition ($stableGateFailure.AttemptCount -eq 2 -and -not $stableGateFailure.Evidence.passed -and
    -not $stableGateFailure.Evidence.historyFallback.passed) `
    'Two identical complete PI snapshots may stabilize an evidence-based gate failure without becoming evidence-unavailable.'
$script:fakePiPassed = $true
$script:fakeEvidenceNow = ([DateTimeOffset]$trafficEnd).AddMinutes(15)
$script:fakePiSnapshotCalls = 0
$script:fakePiChanging = $true
$deadlineStartError = $null
try { [void](Get-StabilizedPerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId) }
catch { $deadlineStartError = $_ }
Assert-Condition ($null -ne $deadlineStartError -and
    [int]$deadlineStartError.Exception.Data['attemptCount'] -eq 0 -and $script:fakePiSnapshotCalls -eq 0) 'PI stabilization must never start a snapshot at or after traffic-end plus fifteen minutes.'
$script:fakeEvidenceNow = ([DateTimeOffset]$trafficEnd).AddMinutes(14).AddSeconds(30)
$script:fakePiSnapshotCalls = 0
$script:fakeEvidenceDelays.Clear()
$unstableSnapshotError = $null
try { [void](Get-StabilizedPerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId) }
catch { $unstableSnapshotError = $_ }
Assert-Condition ($null -ne $unstableSnapshotError -and
    [string]$unstableSnapshotError.Exception.Data['failureStage'] -ceq 'snapshot_stabilization' -and
    $null -ne $unstableSnapshotError.Exception.Data['partialEvidence'].lastCompleteSnapshot -and
    [string]$unstableSnapshotError.Exception.Data['partialEvidence'].lastCompleteCanonicalSha256 -match '^[0-9a-f]{64}$' -and
    @($unstableSnapshotError.Exception.Data['completedStages']) -contains 'fallback_window_top_tokens' -and
    @($unstableSnapshotError.Exception.Data['completedStages']) -notcontains 'fallback_sql_stats' -and
    @($unstableSnapshotError.Exception.Data['completedStages']) -notcontains 'fallback_sampled_load' -and
    ($script:fakeEvidenceDelays -join ',') -ceq '30') 'A stabilization attempt crossing the deadline must stop before another snapshot while retaining the last sanitized complete snapshot and provenance.'
$script:fakeEvidenceNow = ([DateTimeOffset]$trafficEnd).AddMinutes(14).AddSeconds(45)
$script:fakePiSnapshotCalls = 0
$script:fakePiChanging = $false
$script:fakePiAdvanceSeconds = 30
$lateSnapshotError = $null
try { [void](Get-StabilizedPerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId) }
catch { $lateSnapshotError = $_ }
Assert-Condition ($null -ne $lateSnapshotError -and $script:fakePiSnapshotCalls -eq 1 -and
    [string]$lateSnapshotError.Exception.Data['failureStage'] -ceq 'snapshot_stabilization' -and
    [int]$lateSnapshotError.Exception.Data['attemptCount'] -eq 1) 'A PI snapshot completing after the hard deadline must be rejected rather than accepted as stabilization evidence.'
$script:fakePiAdvanceSeconds = 0
foreach ($name in @('Get-EvidenceUtcNow','Wait-EvidenceDelay','Get-PerformanceInsightsEvidence')) { Import-ScriptFunction $controllerAst $name }
$script:PerformanceInsightsPollSeconds = 0

$script:preservationEvidenceNow = [DateTimeOffset]'2026-07-20T12:35:00Z'
function Get-EvidenceUtcNow { return $script:preservationEvidenceNow }
function Wait-EvidenceDelay {
    param([int]$Seconds)
    $script:preservationEvidenceNow = $script:preservationEvidenceNow.AddSeconds($Seconds)
}
$preservationDirectory = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-diagnostic-preservation-$([guid]::NewGuid().ToString('N'))"
[void](New-Item -ItemType Directory -Path $preservationDirectory)
$preservationProgressPath = Join-Path $preservationDirectory 'progress.jsonl'
$preservationSummaryPath = Join-Path $preservationDirectory 'summary.json'
$monitorResultTestPath = Join-Path $preservationDirectory 'monitor-result.json'
$restorationIntegrityTestPath = Join-Path $preservationDirectory 'scaling-restoration.json'
try {
    Write-TestTrafficEvidence $preservationProgressPath $preservationSummaryPath 1799900 $false
    $rejectedMonitorResult = [ordered]@{runId='diagnostic-window-test';status='failed';diagnosticOnly=$true;
        certificationEligible=$false;acceptance=[ordered]@{passed=$false}}
    [IO.File]::WriteAllText($monitorResultTestPath, ($rejectedMonitorResult | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $preservedTerminal = [ordered]@{failures=@();monitor=$null;observedTrafficWindow=$null;postgresStatementTimeouts=$null;
        performanceInsights=$null;postTrafficAwsPosture=$null;evidenceIntegrity=$null}
    $preservationConfig = [pscustomobject]@{RunId='diagnostic-window-test';ApplicationGitSha=$diagnosticConfig.ApplicationGitSha;
        ImageDigest=$diagnosticConfig.ImageDigest;ApiTaskDefinitionArn=$apiTaskArn;
        WorkerTaskDefinitionArn=$diagnosticConfig.WorkerTaskDefinitionArn;
        Resources=[pscustomobject]@{region='us-east-1'};HistoryFallbackSqlIdentity=$historyFallbackSqlIdentity}
    $attachedRejectedMonitor = Attach-TerminalMonitorEvidence $preservedTerminal $preservationConfig $monitorResultTestPath $null
    Assert-Condition ($null -ne $attachedRejectedMonitor -and $preservedTerminal.monitor.result.status -eq 'failed' -and
        [string]$preservedTerminal.monitor.sha256 -match '^[0-9a-f]{64}$') 'A rejected monitor result must still be attached and SHA-256 bound.'
    function Get-AwsPosture { param($Config) return [ordered]@{collected=$true;wafMode='BLOCK';rdsClass='db.t4g.medium'} }
    $script:diagnosticLogResponse = [pscustomobject]@{events=@()}
    $script:diagnosticHotPathLogResponse = $validHotPathLogResponse
    $script:diagnosticWaitResponses[$historyWaitKey] = [pscustomobject]@{Keys=@(
        [pscustomobject]@{Total=0.2;Dimensions=[pscustomobject]@{'db.wait_event.name'='DataFileRead';'db.wait_event.type'='IO'}},
        [pscustomobject]@{Total=0.8;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
    )}
    $raceProgressPath = Join-Path $preservationDirectory 'race-progress.jsonl'
    $raceSummaryPath = Join-Path $preservationDirectory 'race-summary.json'
    $raceStart = [ordered]@{schemaVersion=1;type='progress';event='start';runId='diagnostic-window-test';stage='800';
        diagnosticOnly=$true;certificationEligible=$false;timestamp='2026-07-20T12:00:00Z';devices=810} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($raceProgressPath, $raceStart + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    $raceTerminal = [ordered]@{failures=@();monitor=$null;observedTrafficWindow=$null;postgresStatementTimeouts=$null;
        performanceInsights=$null;postTrafficAwsPosture=$null;evidenceIntegrity=$null}
    Collect-TerminalPostTrafficEvidence $raceTerminal $preservationConfig $raceProgressPath $raceSummaryPath $historyDbiResourceId
    Assert-Condition ($null -eq $raceTerminal.observedTrafficWindow -and
        $null -eq $raceTerminal.postgresStatementTimeouts -and $null -eq $raceTerminal.performanceInsights -and
        $raceTerminal.postTrafficAwsPosture.state -ceq 'completed') 'An interim missing harness final/summary must leave observed, 57014, and PI sources not_started while collecting independent posture.'
    Write-TestTrafficEvidence $raceProgressPath $raceSummaryPath 1799900 $false
    Assert-Condition (Wait-HarnessTerminalEvidenceCommit $raceTerminal $preservationConfig $raceProgressPath $raceSummaryPath $null 0 0) 'The bounded commit phase must accept a later coherent rejected harness final exactly once.'
    $script:preservationEvidenceNow = [DateTimeOffset]'2026-07-20T12:35:00Z'
    Collect-TerminalPostTrafficEvidence $raceTerminal $preservationConfig $raceProgressPath $raceSummaryPath $historyDbiResourceId
    Assert-Condition ($raceTerminal.observedTrafficWindow.coherent -and
        $raceTerminal.postgresStatementTimeouts.state -ceq 'completed' -and
        $raceTerminal.performanceInsights.state -ceq 'completed' -and
        @($raceTerminal.failures) -contains 'strict_traffic_duration_not_completed') 'A coherent rejected final arriving during commit grace must collect dependent evidence once without becoming accepted.'
    $raceCallsAfterCommit = $script:diagnosticAwsCalls.Count
    Collect-TerminalPostTrafficEvidence $raceTerminal $preservationConfig $raceProgressPath $raceSummaryPath $historyDbiResourceId
    Assert-Condition ($script:diagnosticAwsCalls.Count -eq $raceCallsAfterCommit) 'A committed rejected final must not collect settled dependent sources twice.'
    $script:preservationEvidenceNow = [DateTimeOffset]'2026-07-20T12:35:00Z'
    Collect-TerminalPostTrafficEvidence $preservedTerminal $preservationConfig $preservationProgressPath $preservationSummaryPath $historyDbiResourceId
    Assert-Condition ($preservedTerminal.observedTrafficWindow.coherent -and
        -not $preservedTerminal.observedTrafficWindow.strictlyComplete -and
        $null -ne $preservedTerminal.postgresStatementTimeouts -and $null -ne $preservedTerminal.performanceInsights -and
        $null -ne $preservedTerminal.postTrafficAwsPosture -and
        @($preservedTerminal.failures) -contains 'strict_traffic_duration_not_completed' -and
        @($preservedTerminal.failures) -notcontains 'performance_insights_evidence_unavailable') 'A coherent but strictly rejected run must still preserve timeout, PI, and post-traffic posture evidence.'
    [IO.File]::WriteAllText($restorationIntegrityTestPath, '{"restored":true}', [Text.UTF8Encoding]::new($false))
    Set-TerminalEvidenceIntegrity $preservedTerminal $restorationIntegrityTestPath
    Assert-Condition ($preservedTerminal.evidenceIntegrity.algorithm -ceq 'sha256' -and
        $preservedTerminal.evidenceIntegrity.monitor.path -ceq $monitorResultTestPath -and
        $preservedTerminal.evidenceIntegrity.monitor.sha256 -ceq $preservedTerminal.monitor.sha256 -and
        $preservedTerminal.evidenceIntegrity.embeddedObjects.performanceInsights.sha256 -ceq
            (Get-StableJsonSha256 $preservedTerminal.performanceInsights) -and
        $preservedTerminal.evidenceIntegrity.embeddedObjects.postTrafficAwsPosture.sha256 -ceq
            (Get-StableJsonSha256 $preservedTerminal.postTrafficAwsPosture) -and
        $preservedTerminal.evidenceIntegrity.scalingRestoration.path -ceq $restorationIntegrityTestPath -and
        $preservedTerminal.evidenceIntegrity.scalingRestoration.sha256 -ceq
            (Get-FileHash -LiteralPath $restorationIntegrityTestPath -Algorithm SHA256).Hash.ToLowerInvariant()) 'Terminal evidence integrity must bind the monitor/restoration files and stable hashes of each embedded evidence object.'

    $independentFailureTerminal = [ordered]@{failures=@();monitor=$null;observedTrafficWindow=$null;postgresStatementTimeouts=$null;
        performanceInsights=$null;postTrafficAwsPosture=$null;evidenceIntegrity=$null}
    $script:diagnosticLogResponse = [pscustomobject]@{events=@();nextToken='incomplete-timeout-page'}
    $script:preservationEvidenceNow = [DateTimeOffset]'2026-07-20T12:35:00Z'
    Collect-TerminalPostTrafficEvidence $independentFailureTerminal $preservationConfig $preservationProgressPath $preservationSummaryPath $historyDbiResourceId
    Assert-Condition ($independentFailureTerminal.postgresStatementTimeouts.collected -eq $false -and
        $independentFailureTerminal.postgresStatementTimeouts.rawErrorPersisted -eq $false -and
        $independentFailureTerminal.performanceInsights.passed -eq $true -and
        $null -ne $independentFailureTerminal.postTrafficAwsPosture -and
        @($independentFailureTerminal.failures) -contains 'postgres_statement_timeout_evidence_unavailable') 'One evidence-source failure must be sanitized and must not suppress independent PI or posture collection.'
    $failureJson = $independentFailureTerminal | ConvertTo-Json -Depth 30 -Compress
    Assert-Condition (-not $failureJson.Contains('unconsumed') -and -not $failureJson.Contains('incomplete-timeout-page')) 'Terminal evidence failures must not persist raw provider details.'

    $validMetricResponse = $script:diagnosticMetricResponse
    $script:diagnosticLogResponse = [pscustomobject]@{events=@()}
    $script:diagnosticMetricResponse = [pscustomobject]@{MetricList=@([pscustomobject]@{
        Key='db.load.avg';DataPoints=@([pscustomobject]@{Value=2.5})
    })}
    $piFailureTerminal = [ordered]@{failures=@();monitor=$null;observedTrafficWindow=$null;postgresStatementTimeouts=$null;
        performanceInsights=$null;postTrafficAwsPosture=$null;evidenceIntegrity=$null}
    $script:preservationEvidenceNow = [DateTimeOffset]'2026-07-20T12:44:00Z'
    Collect-TerminalPostTrafficEvidence $piFailureTerminal $preservationConfig $preservationProgressPath $preservationSummaryPath $historyDbiResourceId
    Assert-Condition ($piFailureTerminal.performanceInsights.state -ceq 'failed' -and
        $piFailureTerminal.performanceInsights.collected -eq $false -and
        $piFailureTerminal.performanceInsights.failureStage -ceq 'db_load_series' -and
        $piFailureTerminal.performanceInsights.attemptCount -eq 1 -and
        $piFailureTerminal.performanceInsights.rawErrorPersisted -eq $false -and
        $piFailureTerminal.postgresStatementTimeouts.state -ceq 'completed' -and
        $piFailureTerminal.postTrafficAwsPosture.state -ceq 'completed') 'A PI provider/shape failure must seal one sanitized staged envelope without suppressing SQL or posture evidence.'
    $piFailureHash = Get-StableJsonSha256 $piFailureTerminal.performanceInsights
    $awsCallsBeforeIdempotentFinalizer = $script:diagnosticAwsCalls.Count
    Collect-TerminalPostTrafficEvidence $piFailureTerminal $preservationConfig $preservationProgressPath $preservationSummaryPath $historyDbiResourceId
    Assert-Condition ((Get-StableJsonSha256 $piFailureTerminal.performanceInsights) -ceq $piFailureHash -and
        $script:diagnosticAwsCalls.Count -eq $awsCallsBeforeIdempotentFinalizer) 'A second finalizer pass must not retry or rewrite a settled failed evidence source.'

    $script:diagnosticMetricResponse = $validMetricResponse
    $script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@([pscustomobject]@{
        timestamp=$startMs + 60000;logStreamName='api/api/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';message='not-json'
    })}
    $partialFailureTerminal = [ordered]@{failures=@();monitor=$null;observedTrafficWindow=$null;postgresStatementTimeouts=$null;
        performanceInsights=$null;postTrafficAwsPosture=$null;evidenceIntegrity=$null}
    $script:preservationEvidenceNow = [DateTimeOffset]'2026-07-20T12:44:00Z'
    Collect-TerminalPostTrafficEvidence $partialFailureTerminal $preservationConfig $preservationProgressPath $preservationSummaryPath $historyDbiResourceId
    Assert-Condition ($partialFailureTerminal.performanceInsights.failureStage -ceq 'hot_path_log_windows' -and
        @($partialFailureTerminal.performanceInsights.completedStages) -contains 'db_load_series' -and
        @($partialFailureTerminal.performanceInsights.completedStages) -contains 'full_interval_top_tokens' -and
        $null -ne $partialFailureTerminal.performanceInsights.partial.dbLoadSeries -and
        $null -ne $partialFailureTerminal.performanceInsights.partial.fullIntervalTopTokens) 'A later PI-stage failure must retain only sanitized completed-stage provenance and partial evidence.'
    $partialFailureJson = $partialFailureTerminal.performanceInsights | ConvertTo-Json -Depth 30 -Compress
    Assert-Condition (-not $partialFailureJson.Contains('auth-token-1') -and -not $partialFailureJson.Contains('requested_students') -and
        -not $partialFailureJson.Contains('not-json')) 'Partial PI failure evidence must not persist raw SQL, provider payloads, or token identifiers.'
    $script:diagnosticHotPathLogResponse = $validHotPathLogResponse
}
finally {
    $script:diagnosticLogResponse = [pscustomobject]@{events=@()}
    $script:diagnosticHotPathLogResponse = $validHotPathLogResponse
    Remove-Item -LiteralPath $preservationDirectory -Recurse -Force
}
foreach ($name in @('Get-EvidenceUtcNow','Wait-EvidenceDelay')) { Import-ScriptFunction $controllerAst $name }

$script:diagnosticWaitResponses[$historyWaitKey] = [pscustomobject]@{Keys=@(
    [pscustomobject]@{Total=0.5;Dimensions=[pscustomobject]@{'db.wait_event.name'='IO:DataFileRead';'db.wait_event.type'='IO'}},
    [pscustomobject]@{Total=0.5;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
)}
$ioDominated = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $ioDominated.passed -and -not $ioDominated.historyFallback.passed -and
    $ioDominated.historyFallback.sampledLoad.dataFileReadSharePercent -eq 50.0) 'Sampled wait evidence at the exclusive 50-percent IO boundary must fail.'
$script:diagnosticWaitResponses[$historyWaitKey] = [pscustomobject]@{Keys=@(
    [pscustomobject]@{Total=0.49999;Dimensions=[pscustomobject]@{'db.wait_event.name'='IO:DataFileRead';'db.wait_event.type'='IO'}},
    [pscustomobject]@{Total=0.50001;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
)}
$ioBelowBoundary = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition ($ioBelowBoundary.passed -and $ioBelowBoundary.historyFallback.passed -and
    $ioBelowBoundary.historyFallback.sampledLoad.dataFileReadSharePercent -eq 49.999) 'Complete sampled wait evidence at 49.999 percent IO must satisfy the exclusive threshold.'
$script:diagnosticWaitResponses[$historyWaitKey] = [pscustomobject]@{Keys=@(
    [pscustomobject]@{Total=0.2;Dimensions=[pscustomobject]@{'db.wait_event.name'='DataFileRead';'db.wait_event.type'='IO'}},
    [pscustomobject]@{Total=0.6;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
)}
$incompleteWaitCoverage = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $incompleteWaitCoverage.passed -and
    -not $incompleteWaitCoverage.historyFallback.sampledLoad.filteredWaitEventEvidenceComplete -and
    @($incompleteWaitCoverage.historyFallback.sampledLoad.failureReasons) -contains 'incomplete_wait_event_coverage') `
    'Stable incomplete filtered wait-event coverage must seal as a collected gate failure rather than PI unavailability.'

$script:diagnosticWaitResponses[$historyWaitKey] = [pscustomobject]@{Keys=@()}
$missingWaitCoverage = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $missingWaitCoverage.passed -and
    @($missingWaitCoverage.historyFallback.sampledLoad.failureReasons) -contains 'missing_wait_event_coverage') `
    'Stable missing filtered wait-event coverage for positive sampled load must seal as a collected gate failure.'

$script:diagnosticWaitResponses[$historyWaitKey] = [pscustomobject]@{Keys=@(
    [pscustomobject]@{Total=0.2;Dimensions=[pscustomobject]@{'db.wait_event.name'='DataFileRead';'db.wait_event.type'='IO'}},
    [pscustomobject]@{Total=0.8;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
)}
$script:diagnosticWaitCallCount = 0
$script:diagnosticSampledLoad = $null
$zeroSampledLoad = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition ($zeroSampledLoad.passed -and $zeroSampledLoad.historyFallback.passed -and
    $zeroSampledLoad.historyFallback.sampledLoad.status -ceq 'not_applicable_zero_sampled_load' -and
    -not $zeroSampledLoad.historyFallback.sampledLoad.filteredWaitEventEvidenceRequired -and
    $zeroSampledLoad.historyFallback.sampledLoad.filteredWaitEventEvidenceComplete -and
    $script:diagnosticWaitCallCount -eq 0) 'A query-ID-bound fast fallback with positive call statistics and zero sampled AAS must pass without fabricating wait-event evidence.'
$script:diagnosticSampledLoad = 1.0

$script:diagnosticSqlStatsBlockReadTimeRate = 0.5
$callTimeBoundary = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $callTimeBoundary.passed -and
    $callTimeBoundary.historyFallback.sqlStatistics.blockReadTimeSharePercent -eq 50.0) 'Call-time block-read evidence at exactly 50 percent must fail.'
$script:diagnosticSqlStatsBlockReadTimeRate = 0.49999
$callTimeBelowBoundary = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition ($callTimeBelowBoundary.passed -and
    $callTimeBelowBoundary.historyFallback.sqlStatistics.blockReadTimeSharePercent -eq 49.999) 'Call-time block-read evidence at 49.999 percent must pass.'
$script:diagnosticSqlStatsTempBlocksReadRate = 0.01
$temporaryIo = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $temporaryIo.passed -and -not $temporaryIo.historyFallback.sqlStatistics.temporaryIoAbsent) 'Any temporary-block I/O must fail the fallback SQL-statistics gate.'
$script:diagnosticSqlStatsTempBlocksReadRate = 0.0
$script:diagnosticSqlStatsTimestampOverrides['db.sql_tokenized.stats.temp_blks_written_per_sec.avg'] = '2026-07-20T12:01:00Z'
Assert-Throws { Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId } `
    'identical timestamp coverage' 'Missing or shifted SQL-statistics metric coverage must fail closed.'
$script:diagnosticSqlStatsTimestampOverrides.Clear()
$metricNamesForExclusiveEnd = @(
    'db.sql_tokenized.stats.calls_per_sec.avg',
    'db.sql_tokenized.stats.total_time_per_sec.avg',
    'db.sql_tokenized.stats.blk_read_time_per_sec.avg',
    'db.sql_tokenized.stats.shared_blks_read_per_sec.avg',
    'db.sql_tokenized.stats.temp_blks_read_per_sec.avg',
    'db.sql_tokenized.stats.temp_blks_written_per_sec.avg'
)
foreach ($metricName in $metricNamesForExclusiveEnd) {
    $script:diagnosticSqlStatsTimestampOverrides[$metricName] = $trafficEnd
}
Assert-Throws {
    Get-HistoryFallbackSqlStatsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId 1 $testFallbackWindows
} 'out-of-scope' 'PI EndTime is exclusive; a diagnostic SQL-statistics point exactly at EndTime must fail closed.'
$script:diagnosticSqlStatsTimestampOverrides.Clear()
$script:diagnosticSqlStatsBlockReadTimeRate = 0.2
$script:diagnosticSqlStatsCallsRate = (0.5 / 60.0)
$undercountedCalls = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd $historyDbiResourceId
Assert-Condition (-not $undercountedCalls.passed -and -not $undercountedCalls.historyFallback.sqlStatistics.callsCoverApplicationReads) 'PI call statistics below the application fallback database-read count must fail closed.'
$script:diagnosticSqlStatsCallsRate = (1.0 / 60.0)

$script:TargetHealthConvergenceTimeoutSeconds = 420
$script:TargetHealthPollSeconds = 5
$script:targetHealthResponses = [Collections.Generic.Queue[object]]::new()
$script:traceRestoreTargetHealth = $false
$script:restoreEvents = [System.Collections.Generic.List[string]]::new()
function New-TargetHealthResponse {
    param([string[]]$States)
    return [pscustomobject]@{TargetHealthDescriptions=@($States | ForEach-Object {
        [pscustomobject]@{TargetHealth=[pscustomobject]@{State=$_}}
    })}
}
function Set-TargetHealthResponses {
    param([object[]]$Responses)
    $script:targetHealthResponses.Clear()
    foreach ($response in $Responses) { $script:targetHealthResponses.Enqueue($response) }
}
function Invoke-AwsJson {
    param([string[]]$Arguments)
    Assert-Condition ($Arguments[0] -eq 'elbv2' -and $Arguments[1] -eq 'describe-target-health') 'Target-health tests must invoke only the expected read-only ELB query.'
    if ($script:targetHealthResponses.Count -eq 0) { throw 'Target-health test response queue was exhausted.' }
    if ($script:traceRestoreTargetHealth) { $script:restoreEvents.Add('target-health') }
    return $script:targetHealthResponses.Dequeue()
}
function Start-Sleep { param([int]$Seconds,[int]$Milliseconds) }
$targetConfig = [pscustomobject]@{Resources=[pscustomobject]@{region='us-east-1';targetGroupArn='target-group'}}

Set-TargetHealthResponses @(
    (New-TargetHealthResponse @('healthy','healthy','healthy','healthy','healthy','initial')),
    (New-TargetHealthResponse @('healthy','healthy','healthy','healthy','healthy','healthy'))
)
$scaleUpTargets = Wait-TargetHealthConvergence $targetConfig 6 -AllowedTransitionalStates @('initial') -TimeoutSeconds 1 -PollSeconds 0
Assert-Condition ($scaleUpTargets.healthy -eq 6 -and $scaleUpTargets.nonHealthy -eq 0) 'Scale-up must tolerate initial targets and finish with exactly six healthy targets.'

Set-TargetHealthResponses @(
    (New-TargetHealthResponse @('healthy','draining','draining','draining','draining','draining')),
    (New-TargetHealthResponse @('healthy'))
)
$scaleDownTargets = Wait-TargetHealthConvergence $targetConfig 1 -AllowedTransitionalStates @('draining') -TimeoutSeconds 1 -PollSeconds 0
Assert-Condition ($scaleDownTargets.healthy -eq 1 -and $scaleDownTargets.nonHealthy -eq 0) 'Scale-down must tolerate draining targets and finish with exactly one healthy target.'

Set-TargetHealthResponses @((New-TargetHealthResponse @('healthy','initial')))
Assert-Throws { Wait-TargetHealthConvergence $targetConfig 2 -AllowedTransitionalStates @('initial') -TimeoutSeconds 0 -PollSeconds 0 } `
    'bounded timeout' 'Persistent scale-up initial state must time out closed.'
Set-TargetHealthResponses @((New-TargetHealthResponse @('healthy','draining')))
Assert-Throws { Wait-TargetHealthConvergence $targetConfig 1 -AllowedTransitionalStates @('draining') -TimeoutSeconds 0 -PollSeconds 0 } `
    'bounded timeout' 'Persistent scale-down draining state must time out closed.'
Set-TargetHealthResponses @((New-TargetHealthResponse @('healthy','draining')))
Assert-Throws { Wait-TargetHealthConvergence $targetConfig 2 -AllowedTransitionalStates @('initial') -TimeoutSeconds 1 -PollSeconds 0 } `
    'prohibited non-transitional' 'Scale-up must reject a draining target instead of treating it as an allowed transition.'
Set-TargetHealthResponses @((New-TargetHealthResponse @('healthy','initial')))
Assert-Throws { Wait-TargetHealthConvergence $targetConfig 1 -AllowedTransitionalStates @('draining') -TimeoutSeconds 1 -PollSeconds 0 } `
    'prohibited non-transitional' 'Scale-down must reject an initial target instead of treating it as an allowed transition.'
Set-TargetHealthResponses @((New-TargetHealthResponse @('healthy','unhealthy')))
Assert-Throws { Wait-TargetHealthConvergence $targetConfig 2 -AllowedTransitionalStates @('initial') -TimeoutSeconds 1 -PollSeconds 0 } `
    'prohibited non-transitional' 'Target convergence must immediately reject unhealthy targets.'
Set-TargetHealthResponses @((New-TargetHealthResponse @('healthy','healthy','healthy','healthy','healthy','healthy','healthy')))
Assert-Throws { Wait-TargetHealthConvergence $targetConfig 6 -AllowedTransitionalStates @('initial') -TimeoutSeconds 0 -PollSeconds 0 } `
    'bounded timeout' 'An extra healthy target must not satisfy exact target-health convergence.'
Set-TargetHealthResponses @((New-TargetHealthResponse @('healthy','initial')))
Assert-Throws { Get-HealthyTargetCount $targetConfig } 'non-healthy target' 'Strict AWS posture target validation must reject even an expected transition.'

$missingEvidenceDirectory = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-missing-evidence-$([Guid]::NewGuid().ToString('N'))"
$scratchConfig = [pscustomobject]@{EvidenceDirectory=$missingEvidenceDirectory;RunId="fresh-validate-$([Guid]::NewGuid().ToString('N'))"}
Assert-Condition (-not (Test-Path -LiteralPath $scratchConfig.EvidenceDirectory)) 'The fresh Validate behavioral fixture must start without an evidence directory.'
$validationScratch = Get-ValidationScratchPaths $scratchConfig
Assert-Condition (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($validationScratch.ProgressPath)) -PathType Container) 'Validate scratch must use a pre-existing parent.'
Assert-Condition (-not $validationScratch.ProgressPath.StartsWith($scratchConfig.EvidenceDirectory, [StringComparison]::OrdinalIgnoreCase)) 'Validate scratch must not depend on the missing evidence directory.'
Assert-Condition (-not (Test-Path -LiteralPath $validationScratch.ProgressPath) -and -not (Test-Path -LiteralPath $validationScratch.SummaryPath)) 'Validate scratch selection must not create output files.'
Assert-Condition (-not (Test-Path -LiteralPath $scratchConfig.EvidenceDirectory)) 'Validate scratch selection must not create the missing evidence directory.'

$deviceScope = [pscustomobject]@{LabelMatchStatement=[pscustomobject]@{Scope='LABEL';Key='device-ingest'}}
$apiScope = [pscustomobject]@{AndStatement=[pscustomobject]@{Statements=@(
    [pscustomobject]@{ByteMatchStatement=[pscustomobject]@{SearchString='L2FwaS8=';FieldToMatch=[pscustomobject]@{UriPath=[pscustomobject]@{}};
        PositionalConstraint='STARTS_WITH';TextTransformations=@([pscustomobject]@{Priority=0;Type='NONE'})}},
    [pscustomobject]@{NotStatement=[pscustomobject]@{Statement=$deviceScope}}
)}}
function New-WafRule([string]$Name,[int]$Priority,[int]$Limit,[string]$Metric,$Scope) {
    return [pscustomobject]@{Name=$Name;Priority=$Priority;Action=[pscustomobject]@{Block=[pscustomobject]@{}};
        Statement=[pscustomobject]@{RateBasedStatement=[pscustomobject]@{Limit=$Limit;EvaluationWindowSec=300;AggregateKeyType='IP';ScopeDownStatement=$Scope}};
        VisibilityConfig=[pscustomobject]@{MetricName=$Metric;CloudWatchMetricsEnabled=$true;SampledRequestsEnabled=$true}}
}
function New-WafClassifierRule {
    return [pscustomobject]@{
        Name='DeviceIngestClassifier';Priority=25;Action=[pscustomobject]@{Count=[pscustomobject]@{}}
        Statement=[pscustomobject]@{AndStatement=[pscustomobject]@{Statements=@(
            [pscustomobject]@{ByteMatchStatement=[pscustomobject]@{SearchString='UE9TVA==';FieldToMatch=[pscustomobject]@{Method=[pscustomobject]@{}};
                PositionalConstraint='EXACTLY';TextTransformations=@([pscustomobject]@{Priority=0;Type='NONE'})}},
            [pscustomobject]@{RegexMatchStatement=[pscustomobject]@{RegexString='^/api/(classpilot/)?device/(heartbeat|screenshot)$';
                FieldToMatch=[pscustomobject]@{UriPath=[pscustomobject]@{}};TextTransformations=@([pscustomobject]@{Priority=0;Type='NONE'})}}
        )}}
        RuleLabels=@([pscustomobject]@{Name='device-ingest'})
        VisibilityConfig=[pscustomobject]@{MetricName='classifier-metric';CloudWatchMetricsEnabled=$true;SampledRequestsEnabled=$true}
    }
}
$validRules = @(
    (New-WafClassifierRule),
    (New-WafRule 'DeviceIngestRateLimit' 30 100000 'device-metric' $deviceScope),
    (New-WafRule 'ApiRateLimit' 40 50000 'api-metric' $apiScope)
)
$validatedClassifier = Assert-WafDeviceIngestClassifierContract $validRules 'classifier-metric'
Assert-Condition ($validatedClassifier.label -eq 'device-ingest') 'Valid exact WAF classifier should pass behavioral validation.'
$validatedRules = @(Assert-WafRateRuleContract $validRules 'device-metric' 'api-metric')
Assert-Condition ($validatedRules.Count -eq 2) 'Valid exact WAF rules should pass behavioral validation.'
$wrongLimit = @($validRules | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30)
$wrongLimit[1].Statement.RateBasedStatement.Limit = 99999
Assert-Throws { Assert-WafRateRuleContract $wrongLimit 'device-metric' 'api-metric' } 'exact BLOCK' 'A changed WAF limit must be rejected.'
$wrongScope = @($validRules | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30)
$wrongScope[2].Statement.RateBasedStatement.ScopeDownStatement.AndStatement.Statements[0].ByteMatchStatement.SearchString = 'L2JhZC8='
Assert-Throws { Assert-WafRateRuleContract $wrongScope 'device-metric' 'api-metric' } 'scoped to /api/' 'A changed WAF scope must be rejected.'
$wrongClassifierMethod = @($validRules | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30)
$wrongClassifierMethod[0].Statement.AndStatement.Statements[0].ByteMatchStatement.SearchString = 'R0VU'
Assert-Throws { Assert-WafDeviceIngestClassifierContract $wrongClassifierMethod 'classifier-metric' } 'exact POST' 'Classifier method drift must be rejected.'
$wrongClassifierRegex = @($validRules | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30)
$wrongClassifierRegex[0].Statement.AndStatement.Statements[1].RegexMatchStatement.RegexString = '^/api/device/heartbeat$'
Assert-Throws { Assert-WafDeviceIngestClassifierContract $wrongClassifierRegex 'classifier-metric' } 'exact reviewed device-ingest URI regex' 'Classifier path drift must be rejected.'
$wrongClassifierLabel = @($validRules | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30)
$wrongClassifierLabel[0].RuleLabels[0].Name = 'device-ingest-drifted'
Assert-Throws { Assert-WafDeviceIngestClassifierContract $wrongClassifierLabel 'classifier-metric' } 'device-ingest label' 'Classifier output-label drift must be rejected.'
$wrongRateLabel = @($validRules | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30)
$wrongRateLabel[1].Statement.RateBasedStatement.ScopeDownStatement.LabelMatchStatement.Key = 'other:device-ingest'
$wrongRateLabel[2].Statement.RateBasedStatement.ScopeDownStatement.AndStatement.Statements[1].NotStatement.Statement.LabelMatchStatement.Key = 'other:device-ingest'
Assert-Throws { Assert-WafRateRuleContract $wrongRateLabel 'device-metric' 'api-metric' } 'device-ingest classifier label' 'Rate rules must consume the exact unqualified classifier label.'

$redisResources = [pscustomobject]@{redisReplicationGroupId='schoolpilot-production';redisCacheClusterId='schoolpilot-production-001'}
$redisGroup = [pscustomobject]@{ReplicationGroupId='schoolpilot-production';Status='available';CacheNodeType='cache.t4g.small';MemberClusters=@('schoolpilot-production-001');PendingModifiedValues=[pscustomobject]@{}}
$redisCluster = [pscustomobject]@{CacheClusterId='schoolpilot-production-001';ReplicationGroupId='schoolpilot-production';CacheClusterStatus='available';CacheNodeType='cache.t4g.small'}
$redisEvidence = Assert-RedisReplicationIdentity $redisGroup $redisCluster $redisResources
Assert-Condition ($redisEvidence.clusterNodeType -eq 'cache.t4g.small') 'Valid Redis group/member identity should pass.'
$wrongRedisCluster = $redisCluster | ConvertTo-Json -Depth 10 | ConvertFrom-Json -Depth 10
$wrongRedisCluster.ReplicationGroupId = 'other-group'
Assert-Throws { Assert-RedisReplicationIdentity $redisGroup $wrongRedisCluster $redisResources } 'exact validated replication group' 'A Redis member/group mismatch must be rejected.'

Assert-Throws { Assert-NoScheduledBoundaryOverlap -NowUtc ([DateTimeOffset]'2026-07-20T08:00:00Z') -WorstCaseLifecycleSeconds 7200 } 'would cross' 'The full lifecycle guard must reject a weekday scaling-boundary overlap.'
Assert-NoScheduledBoundaryOverlap -NowUtc ([DateTimeOffset]'2026-07-20T06:00:00Z') -WorstCaseLifecycleSeconds 7200
Assert-Throws { Assert-NoScheduledBoundaryOverlap -NowUtc ([DateTimeOffset]'2026-07-20T06:00:00Z') -WorstCaseLifecycleSeconds 5399 } 'at least 90 minutes' 'A shortened lifecycle guard must be rejected.'

$lockConfig = [pscustomobject]@{EvidenceDirectory=[IO.Path]::GetTempPath();RunId="diagnostic-lock-$([Guid]::NewGuid().ToString('N'))"}
$firstLock = Enter-DiagnosticRunLock $lockConfig
try { Assert-Throws { Enter-DiagnosticRunLock $lockConfig } 'already owns' 'A second same-run controller must be rejected.' }
finally { Exit-DiagnosticRunLock $firstLock }
$replacementLock = Enter-DiagnosticRunLock $lockConfig
Exit-DiagnosticRunLock $replacementLock

$script:restoreCalls = [System.Collections.Generic.List[object]]::new()
$script:restoredScaling = [ordered]@{minCapacity=1;maxCapacity=8;suspendedState=[ordered]@{DynamicScalingInSuspended=$false;DynamicScalingOutSuspended=$false;ScheduledScalingSuspended=$false};scheduledActionsSha256='schedule';scalingPoliciesSha256='policy'}
$script:restoredServices = [ordered]@{api=[ordered]@{desired=2;running=2};worker=[ordered]@{desired=1;running=1}}
function Set-ScalingTarget {
    param($Config,[int]$Minimum,[int]$Maximum,$SuspendedState)
    $script:restoreCalls.Add([ordered]@{minimum=$Minimum;maximum=$Maximum;suspended=$SuspendedState})
    $script:restoreEvents.Add("scaling:$Minimum`:$Maximum`:$([bool]$SuspendedState.ScheduledScalingSuspended)")
}
function Invoke-AwsCommand {
    param([string[]]$Arguments)
    $script:restoreEvents.Add("aws:$($Arguments[0])`:$($Arguments[1])")
}
function Get-ScalingSnapshot {
    param($Config)
    $script:restoreEvents.Add('scaling-snapshot')
    return $script:restoredScaling
}
function Get-ServicePosture {
    param($Config)
    $script:restoreEvents.Add('service-posture')
    return $script:restoredServices
}
$restoreConfig = [pscustomobject]@{Resources=[pscustomobject]@{region='us-east-1';cluster='cluster';apiService='api';workerService='worker';targetGroupArn='target-group'}}
$restoreCapture = [pscustomobject]@{original=[pscustomobject]@{scaling=$script:restoredScaling;services=$script:restoredServices}}
Set-TargetHealthResponses @(
    (New-TargetHealthResponse @('healthy','draining')),
    (New-TargetHealthResponse @('healthy','healthy')),
    (New-TargetHealthResponse @('healthy','healthy'))
)
$script:restoreEvents.Clear()
$script:traceRestoreTargetHealth = $true
$restoreResult = Restore-ScalingCapture $restoreConfig $restoreCapture
$script:traceRestoreTargetHealth = $false
Assert-Condition ($restoreResult.restored -eq $true) 'Exact scaling restoration should produce successful terminal evidence.'
Assert-Condition ($script:restoreCalls.Count -eq 2) 'Restoration must hold scaling while desired capacity converges, then restore the original suspended state.'
$expectedRestoreEvents = @(
    'scaling:1:8:True','aws:ecs:update-service','aws:ecs:wait','target-health','target-health',
    'scaling:1:8:False','scaling-snapshot','service-posture','target-health'
)
Assert-Condition (($script:restoreEvents -join '|') -ceq ($expectedRestoreEvents -join '|')) `
    'Restoration must hold scaling through ECS stabilization and ALB draining, then restore and reverify the exact posture.'

$monitorTokens = $null; $monitorParseErrors = $null
$monitorAst = [Management.Automation.Language.Parser]::ParseFile($monitorPath, [ref]$monitorTokens, [ref]$monitorParseErrors)
foreach ($name in @(
    'Get-OptionalValue','Get-WafDeviceLabelMatch','Assert-DiagnosticWafDeviceIngestClassifierContract',
    'Assert-DiagnosticWafRateRuleContract','Get-RedisState','Get-SeriesSummary','Get-DiagnosticRdsCpuCoverageResult'
)) { Import-ScriptFunction $monitorAst $name }
$monitorExplicitNull = [ordered]@{diagnosticOnly=$null}
Assert-Condition ($null -eq (Get-OptionalValue $monitorExplicitNull 'diagnosticOnly' $false)) `
    'Monitor value lookup must preserve an explicit null so the diagnosticOnly boolean gate rejects it.'
$monitorWafResources = [pscustomobject]@{
    wafDeviceClassifierMetricName='classifier-metric';wafDeviceRuleMetricName='device-metric';wafApiRuleMetricName='api-metric'
}
Assert-DiagnosticWafDeviceIngestClassifierContract -Rules $validRules -Resources $monitorWafResources
Assert-DiagnosticWafRateRuleContract -Rules $validRules -Resources $monitorWafResources
Assert-Throws { Assert-DiagnosticWafDeviceIngestClassifierContract -Rules $wrongClassifierRegex -Resources $monitorWafResources } 'exact reviewed device-ingest URI regex' 'Monitor classifier validation must reject path drift.'
Assert-Throws { Assert-DiagnosticWafRateRuleContract -Rules $wrongRateLabel -Resources $monitorWafResources } 'reviewed device/API split' 'Monitor rate validation must reject both consumers drifting to another label key.'

$script:monitorRedisGroupResponse = [pscustomobject]@{ReplicationGroups=@($redisGroup)}
$script:monitorRedisClusterResponse = [pscustomobject]@{CacheClusters=@($redisCluster)}
function Invoke-AwsJson {
    param([string[]]$Arguments)
    if ($Arguments[0] -eq 'elasticache' -and $Arguments[1] -eq 'describe-replication-groups') {
        return $script:monitorRedisGroupResponse
    }
    if ($Arguments[0] -eq 'elasticache' -and $Arguments[1] -eq 'describe-cache-clusters') {
        return $script:monitorRedisClusterResponse
    }
    throw "Unexpected monitor Redis test command: $($Arguments -join ' ')"
}
$monitorRedisConfig = [pscustomobject]@{
    DiagnosticOnly=$true
    ExpectedRedisNodeType='cache.t4g.small'
    Resources=[pscustomobject]@{
        region='us-east-1'
        redisReplicationGroupId='schoolpilot-production'
        redisCacheClusterId='schoolpilot-production-001'
    }
}
$monitorRedisState = Get-RedisState -Config $monitorRedisConfig
Assert-Condition ((Get-OptionalValue $monitorRedisState 'clusterIdentityValid' $false) -eq $true) `
    'A valid diagnostic Redis group/member identity must remain true when the runtime gate reads the state through Get-OptionalValue.'
$wrongMonitorRedisCluster = $redisCluster | ConvertTo-Json -Depth 10 | ConvertFrom-Json -Depth 10
$wrongMonitorRedisCluster.ReplicationGroupId = 'other-group'
$script:monitorRedisClusterResponse = [pscustomobject]@{CacheClusters=@($wrongMonitorRedisCluster)}
$wrongMonitorRedisState = Get-RedisState -Config $monitorRedisConfig
Assert-Condition ((Get-OptionalValue $wrongMonitorRedisState 'clusterIdentityValid' $true) -eq $false) `
    'A diagnostic Redis member bound to another replication group must remain a fail-closed false identity through the runtime gate.'
$script:monitorRedisClusterResponse = [pscustomobject]@{CacheClusters=@()}
$missingMonitorRedisState = Get-RedisState -Config $monitorRedisConfig
Assert-Condition ((Get-OptionalValue $missingMonitorRedisState 'clusterIdentityValid' $true) -eq $false) `
    'A missing diagnostic Redis member must remain a fail-closed false identity through the runtime gate.'

function Set-TestRdsCpuSeries([int]$Count,[double]$LastValue = 40.0) {
    $timestamps = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $values = [System.Collections.Generic.List[double]]::new()
    $points = @{}
    $start = [DateTimeOffset]'2026-07-20T12:00:00Z'
    for ($index=0; $index -lt $Count; $index++) {
        $timestamp = $start.AddMinutes($index).ToString('o')
        [void]$timestamps.Add($timestamp)
        $value = if ($index -eq ($Count - 1)) { $LastValue } else { 40.0 }
        $values.Add($value); $points[$timestamp]=$value
    }
    $script:AcceptanceSeries = @{rds_cpu=[ordered]@{timestamps=$timestamps;values=$values;points=$points}}
}
$cpuConfig = [pscustomobject]@{DiagnosticOnly=$true;Thresholds=[ordered]@{rdsCpuMaximumPercent=65.0}}
Set-TestRdsCpuSeries 29
$missingCpu = Get-DiagnosticRdsCpuCoverageResult $cpuConfig
Assert-Condition (-not $missingCpu.fullCoverage) 'Twenty-nine RDS CPU points must not satisfy the 30/30 diagnostic contract.'
Set-TestRdsCpuSeries 30
$completeCpu = Get-DiagnosticRdsCpuCoverageResult $cpuConfig
Assert-Condition ($completeCpu.passed -and $completeCpu.coveragePercent -eq 100.0) 'Thirty contiguous sub-65 RDS CPU points must satisfy the diagnostic contract.'
Set-TestRdsCpuSeries 30 65.0
$breachedCpu = Get-DiagnosticRdsCpuCoverageResult $cpuConfig
Assert-Condition (-not $breachedCpu.allPointsBelowMaximum) 'An RDS CPU minute at 65 percent must fail the exclusive threshold.'

Write-Output "AWS Waf/800 diagnostic-only contract tests passed ($script:AssertionCount assertions)."
