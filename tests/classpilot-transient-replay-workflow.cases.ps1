# Real Plan/Read/Apply/Rollback orchestration, with the suite's AWS/Git mocks.
Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
Set-MockSourceRuntimeConfiguration -RuntimeConfiguration (ConvertTo-RuntimeConfiguration -Profile $globalProfile)
$replayFlowApiArn = $apiSourceArn; $replayFlowWorkerArn = $workerSourceArn
foreach ($replayFlowMode in @('transient-timer-replay-pilot', 'transient-poll-replay-pilot', 'transient-replay-off')) {
    $replayFlowProfilePath = Join-Path $testRoot ($replayFlowMode + '.json')
    $replayFlowProfile = New-TestReplayProfile $replayFlowMode
    if ($replayFlowMode -ceq 'transient-poll-replay-pilot') { $replayFlowProfile.pollReplayEvidence.validatedAt = $now.ToString('o') }
    Write-TestJson -Path $replayFlowProfilePath -Value $replayFlowProfile
    $replayFlowPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $replayFlowProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $replayFlowApiArn -WorkerTaskDefinitionArn $replayFlowWorkerArn -Now $now -SkipRepositoryCheck
    $replayFlowPlan = Read-RuntimePlan -Path $replayFlowPlanResult.PlanPath -ExpectedSha256 $replayFlowPlanResult.PlanSha256
    Assert-Condition ($replayFlowPlan.profileMode -ceq $replayFlowMode) 'Replay mode must survive the immutable plan round trip.'
    Assert-Condition (-not ([IO.File]::ReadAllText($replayFlowPlanResult.PlanPath)).Contains($testSchoolId)) 'Public plan metadata must not expose the private school scope.'
    # Production Apply checks the entire reviewed checkout, including imports.
    # A dependency-only edit must fail even with the same entrypoint and HEAD.
    $replayEntrypointHash = Get-FileSha256 -Path $helperPath
    $replayPriorDirty = $global:RuntimeConfigGitState.Dirty
    $replayPriorAwsHandler = $global:SchoolPilotRuntimeConfigAwsHandler
    $global:ReplayDependencyAwsCalls = 0
    try {
        $global:SchoolPilotRuntimeConfigAwsHandler = {
            param([string[]]$Arguments)
            $global:ReplayDependencyAwsCalls++
            throw 'Changed runtime imports must reject before any AWS call.'
        }
        foreach ($replayChangedImport in @('scripts/private-permissions.ps1', 'scripts/classpilot-transient-replay-runtime.ps1')) {
            $global:RuntimeConfigGitState.Dirty = " M $replayChangedImport"
            $replayDependencyError = $null
            try {
                Invoke-RuntimeConfigApply -Plan $replayFlowPlan -PlanSha256 $replayFlowPlanResult.PlanSha256 `
                    -Now $now -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
            } catch { $replayDependencyError = $_ }
            Assert-Condition ($null -ne $replayDependencyError -and
                $replayDependencyError.Exception.Message -like 'Runtime configuration deployment requires clean main*') `
                'Production Apply must reject a changed import for every transient replay profile.'
            Assert-Condition ($global:ReplayDependencyAwsCalls -eq 0) 'Changed imports must reject before AWS reads or mutations.'
            Assert-Condition ((Get-FileSha256 -Path $helperPath) -ceq $replayEntrypointHash) 'The dependency custody regression must leave the entrypoint unchanged.'
        }
    } finally {
        $global:RuntimeConfigGitState.Dirty = $replayPriorDirty
        $global:SchoolPilotRuntimeConfigAwsHandler = $replayPriorAwsHandler
        Remove-Variable -Name ReplayDependencyAwsCalls -Scope Global
    }
    if ($replayFlowMode -ceq 'transient-poll-replay-pilot') {
        Assert-Throws {
            Invoke-RuntimeConfigApply -Plan $replayFlowPlan -PlanSha256 $replayFlowPlanResult.PlanSha256 `
                -Now $now.AddHours(2).AddSeconds(1) -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
        } 'Poll release evidence expiring between Plan and Apply must fail before mutation.'
        Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -ceq $replayFlowApiArn -and
            $global:RuntimeConfigTestState.WorkerCurrentArn -ceq $replayFlowWorkerArn) 'Expired evidence must leave both serving task definitions unchanged.'
    }
    # The source input can change; Apply uses only its hashed private copy.
    Write-TestJson -Path $replayFlowProfilePath -Value ([pscustomobject]@{ schemaVersion = 11; mode = 'transient-replay-off' })
    $replayFlowResult = Invoke-RuntimeConfigApply -Plan $replayFlowPlan -PlanSha256 $replayFlowPlanResult.PlanSha256 `
        -Now $now -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    Assert-Condition ($replayFlowResult.status -ceq 'applied' -and $replayFlowResult.scalingRestored) 'Replay Apply must converge both services and restore scaling.'
    $replayFlowApiArn = [string]$replayFlowResult.candidateApiTaskDefinitionArn
    $replayFlowWorkerArn = [string]$replayFlowResult.candidateWorkerTaskDefinitionArn
    $replayFlowApi = $global:RuntimeConfigTestState.TaskResponses[$replayFlowApiArn].taskDefinition
    $replayFlowWorker = $global:RuntimeConfigTestState.TaskResponses[$replayFlowWorkerArn].taskDefinition
    Assert-Condition ((Get-ManagedRuntimeFingerprint -TaskDefinition $replayFlowApi -ContainerName api) -ceq
        (Get-ManagedRuntimeFingerprint -TaskDefinition $replayFlowWorker -ContainerName 'scheduler-worker')) 'Replay API and worker runtime must remain identical.'
    $replayExpectedMode = switch ($replayFlowMode) {
        'transient-timer-replay-pilot' { 'timer-pilot' }
        'transient-poll-replay-pilot' { 'poll-pilot' }
        'transient-replay-off' { 'off' }
    }
    $replayActualMode = (Get-TransientReplayRuntimeControl -Environment $replayFlowApi.containerDefinitions[0].environment).Mode
    Assert-Condition ($replayActualMode -ceq $replayExpectedMode) 'Registered runtime must implement the reviewed replay stage.'
}
[void](Invoke-RuntimeConfigRollback -Plan $replayFlowPlan -PlanSha256 $replayFlowPlanResult.PlanSha256 -Now $now `
    -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0)
Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -cne $replayFlowApiArn) 'Explicit rollback must restore the exact captured source task definitions.'

Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
Set-MockSourceRuntimeConfiguration -RuntimeConfiguration (ConvertTo-RuntimeConfiguration -Profile $globalProfile)
$replayFailureProfilePath = Join-Path $testRoot 'replay-failure.json'
Write-TestJson -Path $replayFailureProfilePath -Value (New-TestReplayProfile 'transient-timer-replay-pilot')
$replayOldTarget = '9' * 40
$global:RuntimeConfigGitState.ProtocolSourceBySha[$replayOldTarget] = $currentProtocolSource -replace '\r?\n\s*"pollReplaySafeV1",', ''
try {
    Assert-Throws {
        New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $replayFailureProfilePath `
            -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest -RegistryTargetAppSha $replayOldTarget `
            -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    } 'A registry projection removing the repaired replay capability must reject timer activation.'
} finally { $global:RuntimeConfigGitState.ProtocolSourceBySha.Remove($replayOldTarget) }
$replayFailurePlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $replayFailureProfilePath `
    -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
    -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
$replayFailurePlan = Read-RuntimePlan -Path $replayFailurePlanResult.PlanPath -ExpectedSha256 $replayFailurePlanResult.PlanSha256
$global:RuntimeConfigTestState.FailWorkerCandidateOnce = $true
Assert-Throws {
    Invoke-RuntimeConfigApply -Plan $replayFailurePlan -PlanSha256 $replayFailurePlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
} 'A failed replay worker rollout must fail the Apply and restore the captured pair.'
Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -ceq $apiSourceArn -and
    $global:RuntimeConfigTestState.WorkerCurrentArn -ceq $workerSourceArn -and
    -not $global:RuntimeConfigTestState.DynamicIn -and -not $global:RuntimeConfigTestState.DynamicOut) 'Replay convergence failure must restore both source tasks and scaling.'
