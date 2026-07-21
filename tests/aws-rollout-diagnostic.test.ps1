#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$controllerPath = Join-Path $root "scripts/load/start-waf800-batch-diagnostic.ps1"
$monitorPath = Join-Path $root "scripts/load/aws-rollout-monitor.ps1"
$supervisorPath = Join-Path $root "scripts/load/start-aws-rollout-supervisor.ps1"
$harnessPath = Join-Path $root "scripts/load/classpilot-load-test.mjs"
$monotonicDeadlinePath = Join-Path $root "scripts/load/monotonic-deadline.mjs"
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

foreach ($path in @($controllerPath,$monitorPath,$supervisorPath)) {
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
    'embeddedCanonicalization="powershell-convertto-json-depth-50-compress-utf8"',
    'monotonicDeadline=(Get-FileHash -LiteralPath $script:MonotonicDeadlineScript'
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
$startGateIndex = $controller.IndexOf('Write-AtomicJson $startGatePath', $preReleaseHeartbeatIndex)
Assert-Condition ($preTrafficPostureIndex -ge 0 -and $preReleaseIpIndex -gt $preTrafficPostureIndex -and
    $preReleaseLivenessIndex -gt $preReleaseIpIndex -and $preReleaseHeartbeatIndex -gt $preReleaseLivenessIndex -and
    $startGateIndex -gt $preReleaseHeartbeatIndex) "Pre-release IP refresh, child liveness, and fresh monitor heartbeat validation must precede the start gate."
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
$attachMonitorIndex = $controller.IndexOf('Attach-TerminalMonitorEvidence $terminal', $stopChildrenIndex)
$collectEvidenceIndex = $controller.IndexOf('Collect-TerminalPostTrafficEvidence $terminal', $attachMonitorIndex)
$restoreScalingIndex = $controller.IndexOf('Restore-ScalingCapture $config $capture', $collectEvidenceIndex)
Assert-Condition ($finallyIndex -ge 0 -and $stopChildrenIndex -gt $finallyIndex -and $attachMonitorIndex -gt $stopChildrenIndex -and
    $collectEvidenceIndex -gt $attachMonitorIndex -and $restoreScalingIndex -gt $collectEvidenceIndex) 'The final path must stop children, attach the sealed monitor result, and collect post-traffic evidence before scaling restoration.'
Assert-Condition ((Test-Path -LiteralPath $monotonicDeadlinePath -PathType Leaf) -and
    $controller.Contains('$script:MonotonicDeadlineScript = Join-Path $PSScriptRoot "monotonic-deadline.mjs"')) 'The controller must bind the exact monotonic deadline helper imported by the harness.'
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
    'Get-Value','Assert-GitSha','Get-ControllerSha','Get-StableJsonSha256','Get-StringSha256','Get-DiagnosticRunMutexName','Enter-DiagnosticRunLock','Exit-DiagnosticRunLock',
    'Resolve-ExternalPath','Get-ValidationScratchPaths','Get-WafLabelMatch','Assert-WafDeviceIngestClassifierContract',
    'Assert-WafRateRuleContract','Assert-RedisReplicationIdentity','Assert-NoScheduledBoundaryOverlap','Get-TargetHealthSnapshot',
    'Wait-TargetHealthConvergence','Get-HealthyTargetCount','Restore-ScalingCapture',
    'Update-GeneratorPublicIpEvidence','Assert-HealthyMonitorHeartbeat','Resolve-ApiAwslogsBinding',
    'Get-BoundApiAwslogsBinding','Get-Postgres57014Evidence','Get-HistoryFallbackWaitEventEvidence',
    'Get-ObservedTrafficWindow','Get-TrafficWindow','Get-PerformanceInsightsTopTokens','Get-HotPathFallbackEvidenceWindows',
    'Get-PerformanceInsightsEvidence','Add-TerminalFailure','Remove-TerminalFailure','Attach-TerminalMonitorEvidence',
    'Collect-TerminalPostTrafficEvidence','Set-TerminalEvidenceIntegrity'
)) { Import-ScriptFunction $controllerAst $name }

$script:RepositoryRoot = $root
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
$script:WorkloadSchemaVersion = 'classpilot-tile-batch-v1'
$script:EndpointShapeSha256 = '8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2'
$script:DurationClock = 'monotonic-hrtime-v1'
$script:DiagnosticRuntimeTargetTrafficSeconds = 1800.0
$script:DiagnosticPlannedTrafficMilliseconds = 1800000L
$script:HotPathSummaryEvent = 'classpilot_heartbeat_hot_path_summary'
$script:HotPathSummaryIntervalSeconds = 60

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
    MetricList=@([pscustomobject]@{DataPoints=@([pscustomobject]@{Value=2.5},[pscustomobject]@{Value=2.5})})
}
$script:diagnosticTopKeys = @(
    [pscustomobject]@{Total=1.0;Dimensions=[pscustomobject]@{
        'db.sql_tokenized.id'='history-token-1'
        'db.sql_tokenized.statement'='WITH requested_tiles AS (VALUES (?)) SELECT * FROM requested_tiles CROSS JOIN LATERAL (SELECT * FROM heartbeats) h'
    }},
    [pscustomobject]@{Total=0.5;Dimensions=[pscustomobject]@{
        'db.sql_tokenized.id'='auth-token-1'
        'db.sql_tokenized.statement'='WITH requested_students AS (VALUES (?)), active_supervision AS (SELECT ?), authorized_students AS (SELECT ?) SELECT ?'
    }},
    [pscustomobject]@{Total=0.25;Dimensions=[pscustomobject]@{
        'db.sql_tokenized.id'='other-token-1';'db.sql_tokenized.statement'='SELECT ?'
    }}
)
$script:diagnosticWaitResponses = @{
    'history-token-1'=[pscustomobject]@{Keys=@(
        [pscustomobject]@{Total=0.2;Dimensions=[pscustomobject]@{'db.wait_event.name'='DataFileRead';'db.wait_event.type'='IO'}},
        [pscustomobject]@{Total=0.8;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
    )}
}
$script:diagnosticWaitCallCount = 0
$script:diagnosticTopTokenCalls = [System.Collections.Generic.List[object]]::new()
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
        'pi get-resource-metrics' { return $script:diagnosticMetricResponse }
        'pi describe-dimension-keys' {
            $groupBy = Get-TestArgumentValue $Arguments '--group-by'
            if ($groupBy -ceq 'Group=db.sql_tokenized,Limit=25') {
                $script:diagnosticTopTokenCalls.Add([pscustomobject]@{
                    StartUtc=Get-TestArgumentValue $Arguments '--start-time'
                    EndUtc=Get-TestArgumentValue $Arguments '--end-time'
                })
                return [pscustomobject]@{Keys=$script:diagnosticTopKeys}
            }
            Assert-Condition ($groupBy -ceq 'Group=db.wait_event,Limit=25') 'Present history tokens must be resolved through filtered wait-event evidence.'
            $script:diagnosticWaitCallCount++
            $filter = (Get-TestArgumentValue $Arguments '--filter') | ConvertFrom-Json
            $tokenId = [string]$filter.'db.sql_tokenized.id'
            if (-not $script:diagnosticWaitResponses.ContainsKey($tokenId)) { throw 'No test wait response for filtered token.' }
            return $script:diagnosticWaitResponses[$tokenId]
        }
        default { throw "Unexpected diagnostic evidence test command: $operation" }
    }
}

$diagnosticConfig = [pscustomobject]@{ApiTaskDefinitionArn=$apiTaskArn;Resources=[pscustomobject]@{region='us-east-1'}}
$trafficStart = '2026-07-20T12:00:00.0000000+00:00'
$trafficEnd = '2026-07-20T12:30:00.0000000+00:00'
$noTimeouts = Get-Postgres57014Evidence $diagnosticConfig $trafficStart $trafficEnd
Assert-Condition ($noTimeouts.passed -and $noTimeouts.matchCount -eq 0 -and -not $noTimeouts.rawMessagesPersisted -and -not $noTimeouts.rawIdentifiersPersisted) 'Zero exact-interval API SQLSTATE 57014 events must pass with sanitized evidence.'
$noTimeoutsJson = $noTimeouts | ConvertTo-Json -Depth 10 -Compress
Assert-Condition (-not $noTimeoutsJson.Contains('/ecs/schoolpilot-production-api') -and -not $noTimeoutsJson.Contains('api/api/')) 'Timeout evidence must hash rather than persist CloudWatch identifiers.'
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
Assert-Throws { Get-Postgres57014Evidence $diagnosticConfig $trafficStart $trafficEnd } 'complete PostgreSQL timeout evidence' 'An unconsumed CloudWatch pagination token must fail closed.'
$script:diagnosticLogResponse = [pscustomobject]@{events=@()}
$hotPathMessage = [ordered]@{
    event='classpilot_heartbeat_hot_path_summary';intervalSeconds=60
    counters=[ordered]@{tileBatchHistoryFallbackItems=40}
    timings=[ordered]@{tileBatchHistoryDatabaseMs=[ordered]@{count=1;totalMs=12.5;maxMs=12.5}}
} | ConvertTo-Json -Depth 10 -Compress
$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@([pscustomobject]@{
    timestamp=$startMs + 60000;logStreamName='api/api/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    eventId='hot-path-raw-event-id';message=$hotPathMessage
})}

$script:diagnosticWaitCallCount = 0
$script:diagnosticTopTokenCalls.Clear()
$piEvidence = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd 'db-resource-id'
Assert-Condition ($piEvidence.passed -and $piEvidence.tileAuthorization.passed) 'Existing aggregate tile-authorization non-dominance must remain enforced.'
Assert-Condition ($piEvidence.historyFallback.tokenCount -eq 1 -and $piEvidence.historyFallback.filteredWaitEventEvidenceComplete -and
    $piEvidence.historyFallback.perTokenAllBelowThreshold -and $piEvidence.historyFallback.dataFileReadSharePercent -eq 20.0 -and
    $piEvidence.historyFallback.source.fallbackPositiveSummaryCount -eq 1 -and
    $piEvidence.historyFallback.source.batchHistoryDatabaseReadCount -eq 1 -and
    $piEvidence.historyFallback.evidenceWindows.Count -eq 1 -and
    $script:diagnosticWaitCallCount -eq 1) 'A fallback-positive batch database-read window must have complete per-token and aggregate IO:DataFileRead evidence below 50 percent.'
Assert-Condition ($script:diagnosticTopTokenCalls.Count -eq 2 -and
    [DateTimeOffset]$script:diagnosticTopTokenCalls[1].StartUtc -eq [DateTimeOffset]'2026-07-20T12:00:00Z' -and
    [DateTimeOffset]$script:diagnosticTopTokenCalls[1].EndUtc -eq [DateTimeOffset]'2026-07-20T12:01:00Z') 'A fallback-positive 60-second hot-path summary must drive an exact-window PI top-25 query.'
$piEvidenceJson = $piEvidence | ConvertTo-Json -Depth 20 -Compress
Assert-Condition (-not $piEvidenceJson.Contains('history-token-1') -and -not $piEvidenceJson.Contains('requested_tiles') -and
    -not $piEvidenceJson.Contains('IO:DataFileRead') -and -not $piEvidenceJson.Contains('hot-path-raw-event-id') -and
    -not $piEvidenceJson.Contains('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') -and -not $piEvidenceJson.Contains('api/api/')) 'Performance Insights evidence must retain hashes/categories rather than raw SQL, token ids, log messages, stream ids, or wait-event names.'

$validHotPathLogResponse = $script:diagnosticHotPathLogResponse
$counterOnlyMessage = [ordered]@{
    event='classpilot_heartbeat_hot_path_summary';intervalSeconds=60
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
$noFallbackWindow = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd 'db-resource-id'
Assert-Condition (-not $noFallbackWindow.passed -and -not $noFallbackWindow.historyFallback.passed -and
    $noFallbackWindow.historyFallback.source.fallbackPositiveSummaryCount -eq 0 -and
    $script:diagnosticWaitCallCount -eq 0) 'A run with no observed batch fallback/database-read window must fail closed without fabricating per-token wait evidence.'

$script:diagnosticHotPathLogResponse = [pscustomobject]@{events=@();nextToken='unconsumed-hot-path-page'}
Assert-Throws { Get-HotPathFallbackEvidenceWindows $diagnosticConfig $trafficStart $trafficEnd } 'complete hot-path summary evidence' 'Incomplete hot-path CloudWatch pagination must fail closed.'
$script:diagnosticHotPathLogResponse = $validHotPathLogResponse

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
    $preservationConfig = [pscustomobject]@{RunId='diagnostic-window-test';ApiTaskDefinitionArn=$apiTaskArn;
        Resources=[pscustomobject]@{region='us-east-1'}}
    $attachedRejectedMonitor = Attach-TerminalMonitorEvidence $preservedTerminal $preservationConfig $monitorResultTestPath $null
    Assert-Condition ($null -ne $attachedRejectedMonitor -and $preservedTerminal.monitor.result.status -eq 'failed' -and
        [string]$preservedTerminal.monitor.sha256 -match '^[0-9a-f]{64}$') 'A rejected monitor result must still be attached and SHA-256 bound.'
    function Get-AwsPosture { param($Config) return [ordered]@{collected=$true;wafMode='BLOCK';rdsClass='db.t4g.medium'} }
    $script:diagnosticLogResponse = [pscustomobject]@{events=@()}
    $script:diagnosticHotPathLogResponse = $validHotPathLogResponse
    $script:diagnosticWaitResponses['history-token-1'] = [pscustomobject]@{Keys=@(
        [pscustomobject]@{Total=0.2;Dimensions=[pscustomobject]@{'db.wait_event.name'='DataFileRead';'db.wait_event.type'='IO'}},
        [pscustomobject]@{Total=0.8;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
    )}
    Collect-TerminalPostTrafficEvidence $preservedTerminal $preservationConfig $preservationProgressPath $preservationSummaryPath 'db-resource-id'
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
    Collect-TerminalPostTrafficEvidence $independentFailureTerminal $preservationConfig $preservationProgressPath $preservationSummaryPath 'db-resource-id'
    Assert-Condition ($independentFailureTerminal.postgresStatementTimeouts.collected -eq $false -and
        $independentFailureTerminal.postgresStatementTimeouts.rawErrorPersisted -eq $false -and
        $independentFailureTerminal.performanceInsights.passed -eq $true -and
        $null -ne $independentFailureTerminal.postTrafficAwsPosture -and
        @($independentFailureTerminal.failures) -contains 'postgres_statement_timeout_evidence_unavailable') 'One evidence-source failure must be sanitized and must not suppress independent PI or posture collection.'
    $failureJson = $independentFailureTerminal | ConvertTo-Json -Depth 30 -Compress
    Assert-Condition (-not $failureJson.Contains('unconsumed') -and -not $failureJson.Contains('incomplete-timeout-page')) 'Terminal evidence failures must not persist raw provider details.'
}
finally {
    $script:diagnosticLogResponse = [pscustomobject]@{events=@()}
    $script:diagnosticHotPathLogResponse = $validHotPathLogResponse
    Remove-Item -LiteralPath $preservationDirectory -Recurse -Force
}

$script:diagnosticWaitResponses['history-token-1'] = [pscustomobject]@{Keys=@(
    [pscustomobject]@{Total=0.5;Dimensions=[pscustomobject]@{'db.wait_event.name'='IO:DataFileRead';'db.wait_event.type'='IO'}},
    [pscustomobject]@{Total=0.5;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
)}
$ioDominated = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd 'db-resource-id'
Assert-Condition (-not $ioDominated.passed -and -not $ioDominated.historyFallback.passed -and
    $ioDominated.historyFallback.dataFileReadSharePercent -eq 50.0) 'A history token at the exclusive 50-percent IO boundary must fail.'
$script:diagnosticWaitResponses['history-token-1'] = [pscustomobject]@{Keys=@(
    [pscustomobject]@{Total=0.2;Dimensions=[pscustomobject]@{'db.wait_event.name'='DataFileRead';'db.wait_event.type'='IO'}},
    [pscustomobject]@{Total=0.6;Dimensions=[pscustomobject]@{'db.wait_event.name'='CPU';'db.wait_event.type'='CPU'}}
)}
Assert-Throws { Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd 'db-resource-id' } 'did not completely cover' 'A present history token with incomplete filtered wait-event load must fail closed.'

$script:diagnosticTopKeys = @($script:diagnosticTopKeys | Where-Object { $_.Dimensions.'db.sql_tokenized.id' -ne 'history-token-1' })
$script:diagnosticWaitCallCount = 0
$historyAbsent = Get-PerformanceInsightsEvidence $diagnosticConfig $trafficStart $trafficEnd 'db-resource-id'
Assert-Condition (-not $historyAbsent.passed -and -not $historyAbsent.historyFallback.passed -and
    $historyAbsent.historyFallback.absentFromTopTokens -and
    $historyAbsent.historyFallback.filteredWaitEventEvidenceRequired -and
    -not $historyAbsent.historyFallback.filteredWaitEventEvidenceComplete -and
    $script:diagnosticWaitCallCount -eq 0) 'The strict cold-cache diagnostic must fail closed when its history fallback token is absent from the bounded PI evidence.'

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
