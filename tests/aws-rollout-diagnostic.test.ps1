#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$controllerPath = Join-Path $root "scripts/load/start-waf800-batch-diagnostic.ps1"
$monitorPath = Join-Path $root "scripts/load/aws-rollout-monitor.ps1"
$supervisorPath = Join-Path $root "scripts/load/start-aws-rollout-supervisor.ps1"
$harnessPath = Join-Path $root "scripts/load/classpilot-load-test.mjs"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Throws {
    param([scriptblock]$Operation, [string]$Pattern, [string]$Message)
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
    'LOAD_TILE_HISTORY_PATH="/api/classpilot/tiles/history"',
    'LOAD_TILE_SCREENSHOTS_PATH="/api/classpilot/tiles/screenshots"',
    'LOAD_SCREENSHOT_GET_PATH_TEMPLATE=""'
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
Assert-Condition ($controller.Contains('$terminal.terminalAwsPosture = Get-AwsPosture $config')) "Exact AWS posture must be revalidated at terminal success."
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
    'Wait-TargetHealthConvergence','Get-HealthyTargetCount','Restore-ScalingCapture'
)) { Import-ScriptFunction $controllerAst $name }

$script:RepositoryRoot = $root
$expectedControllerShaOutput = @(& git -C $root rev-parse HEAD 2>$null)
Assert-Condition ($LASTEXITCODE -eq 0 -and $expectedControllerShaOutput.Count -eq 1) 'The test fixture must resolve one current Git SHA.'
$expectedControllerSha = [string]$expectedControllerShaOutput[0]
Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
$resolvedControllerSha = Get-ControllerSha
Assert-Condition ($resolvedControllerSha -ceq $expectedControllerSha.ToLowerInvariant()) 'Controller SHA resolution must succeed when LASTEXITCODE starts unset.'
Assert-Throws { Assert-GitSha 'abc123' 'test SHA' } 'full 40-character' 'Controller SHA validation must reject abbreviated Git identities.'

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
$redisGroup = [pscustomobject]@{ReplicationGroupId='schoolpilot-production';Status='available';CacheNodeType='cache.t4g.small';MemberClusters=@('schoolpilot-production-001')}
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
    'Assert-DiagnosticWafRateRuleContract','Get-SeriesSummary','Get-DiagnosticRdsCpuCoverageResult'
)) { Import-ScriptFunction $monitorAst $name }
$monitorWafResources = [pscustomobject]@{
    wafDeviceClassifierMetricName='classifier-metric';wafDeviceRuleMetricName='device-metric';wafApiRuleMetricName='api-metric'
}
Assert-DiagnosticWafDeviceIngestClassifierContract -Rules $validRules -Resources $monitorWafResources
Assert-DiagnosticWafRateRuleContract -Rules $validRules -Resources $monitorWafResources
Assert-Throws { Assert-DiagnosticWafDeviceIngestClassifierContract -Rules $wrongClassifierRegex -Resources $monitorWafResources } 'exact reviewed device-ingest URI regex' 'Monitor classifier validation must reject path drift.'
Assert-Throws { Assert-DiagnosticWafRateRuleContract -Rules $wrongRateLabel -Resources $monitorWafResources } 'reviewed device/API split' 'Monitor rate validation must reject both consumers drifting to another label key.'
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

Write-Output "AWS Waf/800 diagnostic-only contract tests passed."
