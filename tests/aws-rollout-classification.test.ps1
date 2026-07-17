#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$monitorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\aws-rollout-monitor.ps1"))
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($monitorPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Unable to parse rollout monitor." }
foreach ($name in @("Get-ApprovedActionForFailure","Resolve-ApprovedRollback")) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing monitor function $name." }
    Invoke-Expression $definition.Extent.Text
}

$sample = [pscustomobject]@{
    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
    waf = [pscustomobject]@{ blockedObserved=$false;latestBlockedTimestamp=$null }
    immediateFailures = @()
    consecutiveFailures = @()
}

$cases = @(
    @("Waf","cache.t4g.small","redis_cpu",$null),
    @("PublicEcs","cache.t4g.small","redis_unavailable",$null),
    @("NatRemoved","cache.t4g.small","redis_pending_modifications",$null),
    @("PublicEcs","cache.t4g.small","ecs_task_stopped:abc",$null),
    @("Redis","cache.t4g.micro","ecs_unstable:api",$null),
    @("NatRemoved","cache.t4g.small","alb_unhealthy",$null),
    @("Final","cache.t4g.micro","ecs_active_worker_task_definition_mismatch","Application"),
    @("Waf","cache.t4g.small","ecs_network_contract_mismatch",$null),
    @("PublicEcs","cache.t4g.small","ecs_network_contract_mismatch","PublicEcs"),
    @("NatRemoved","cache.t4g.small","ecs_network_contract_mismatch","NatRemoved"),
    @("Redis","cache.t4g.micro","ecs_network_contract_mismatch",$null),
    @("PublicEcs","cache.t4g.small","nat_failed",$null),
    @("NatRemoved","cache.t4g.small","nat_count_mismatch","NatRemoved"),
    @("Route53","cache.t4g.small","route53_checker_failure",$null),
    @("Redis","cache.t4g.micro","redis_evictions","Redis"),
    @("Final","cache.t4g.micro","redis_cpu_credit","Redis"),
    @("Waf","cache.t4g.small","missing_metric:redis_cpu",$null),
    @("Redis","cache.t4g.micro","stale_metric:redis_cpu",$null),
    @("NatRemoved","cache.t4g.small","rds_cpu",$null),
    @("Redis","cache.t4g.micro","rds_read_latency_peak",$null),
    @("Application","cache.t4g.small","ecs_active_emergency_api_oom:abc",$null),
    @("NatRemoved","cache.t4g.small","ecs_api_oom:abc","Oom")
)

$assertions = 0
foreach ($case in $cases) {
    $config = [pscustomobject]@{Phase=$case[0];ExpectedRedisNodeType=$case[1]}
    $actual = Get-ApprovedActionForFailure -Config $config -Sample $sample -Failure $case[2]
    $actualAction = if ($null -eq $actual) { $null } else { [string]$actual.action }
    Assert-Condition ($actualAction -eq $case[3]) "Cause '$($case[2])' in phase '$($case[0])' resolved to '$actualAction', expected '$($case[3])'."
    $assertions++
}

$correlatedSample = [pscustomobject]@{
    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
    waf = [pscustomobject]@{blockedObserved=$true;latestBlockedTimestamp=[DateTimeOffset]::UtcNow.ToString("o")}
}
$correlated = Get-ApprovedActionForFailure -Config ([pscustomobject]@{Phase="PublicEcs";ExpectedRedisNodeType="cache.t4g.small"}) `
    -Sample $correlatedSample -Failure "load:valid-http-403"
Assert-Condition ([string]$correlated.action -eq "Waf") "A reviewed, time-correlated WAF rejection must select only Waf recovery."
$assertions++

$uncorrelated = Get-ApprovedActionForFailure -Config ([pscustomobject]@{Phase="Waf";ExpectedRedisNodeType="cache.t4g.small"}) `
    -Sample $sample -Failure "load:valid-http-403"
Assert-Condition ([string]$uncorrelated.action -eq "Application") "An uncorrelated 403 must not be relabeled as a WAF mutation."
$assertions++

$mixedSample = [pscustomobject]@{
    immediateFailures = @("rds_cpu","ecs_network_contract_mismatch","ecs_task_stopped:abc")
    consecutiveFailures = @()
    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
    waf = [pscustomobject]@{blockedObserved=$false;latestBlockedTimestamp=$null}
}
$mixed = Resolve-ApprovedRollback -Config ([pscustomobject]@{Phase="NatRemoved";ExpectedRedisNodeType="cache.t4g.small"}) -Sample $mixedSample
Assert-Condition ($mixed.approved -and -not $mixed.ambiguous -and $mixed.action -eq "NatRemoved" -and
    @($mixed.candidates | Where-Object action -eq "NatRemoved").Count -eq 1 -and
    @($mixed.candidates | Where-Object reason -eq "ecs_task_stopped:abc").Count -eq 0 -and
    @($mixed.candidates | Where-Object reason -eq "rds_cpu").Count -eq 0) `
    "A generic stopped-task symptom must not compete with independently proven networking recovery or translate the RDS failure."
$assertions++

$redisMixed = [pscustomobject]@{
    immediateFailures=@("redis_unavailable","ecs_unstable:api");consecutiveFailures=@()
    timestamp=[DateTimeOffset]::UtcNow.ToString("o");waf=[pscustomobject]@{blockedObserved=$false;latestBlockedTimestamp=$null}
}
$redisResolution = Resolve-ApprovedRollback -Config ([pscustomobject]@{Phase="Redis";ExpectedRedisNodeType="cache.t4g.micro"}) -Sample $redisMixed
Assert-Condition ($redisResolution.approved -and -not $redisResolution.ambiguous -and $redisResolution.action -eq "Redis" -and
    @($redisResolution.candidates | Where-Object reason -eq "ecs_unstable:api").Count -eq 0) `
    "A generic unstable-service symptom must not be relabeled as Application when Redis has independent cause evidence."
$assertions++

$genericOnlySample = [pscustomobject]@{
    immediateFailures=@("ecs_task_stopped:abc","alb_unhealthy");consecutiveFailures=@("ecs_unstable:api")
    timestamp=[DateTimeOffset]::UtcNow.ToString("o");waf=[pscustomobject]@{blockedObserved=$false;latestBlockedTimestamp=$null}
}
$genericOnly = Resolve-ApprovedRollback -Config ([pscustomobject]@{Phase="PublicEcs";ExpectedRedisNodeType="cache.t4g.small"}) -Sample $genericOnlySample
Assert-Condition (-not $genericOnly.approved -and -not $genericOnly.ambiguous -and $null -eq $genericOnly.action -and
    @($genericOnly.candidates).Count -eq 0) `
    "Generic stopped-task, unstable-service, and unhealthy-target symptoms must hard-stop without guessing Application or networking recovery."
$assertions++

$provenMixedSample = [pscustomobject]@{
    immediateFailures=@("ecs_active_api_task_definition_mismatch","ecs_network_contract_mismatch");consecutiveFailures=@()
    timestamp=[DateTimeOffset]::UtcNow.ToString("o");waf=[pscustomobject]@{blockedObserved=$false;latestBlockedTimestamp=$null}
}
$provenMixed = Resolve-ApprovedRollback -Config ([pscustomobject]@{Phase="PublicEcs";ExpectedRedisNodeType="cache.t4g.small"}) -Sample $provenMixedSample
Assert-Condition (-not $provenMixed.approved -and $provenMixed.ambiguous -and $null -eq $provenMixed.action) `
    "Independent proven application and networking causes at equal priority must remain an ambiguous hard stop."
$assertions++

"AWS rollout cause-classification tests: PASS ($assertions assertions)"
