# Included in the existing mocked deploy suite so registration and convergence
# regression tests below exercise the expanded managed environment allowlist too.
function New-TestReplayProfile {
    param([string]$Mode, [string]$School = $testSchoolId)
    $profile = [ordered]@{ schemaVersion = 11; mode = $Mode }
    if ($Mode -cne 'transient-replay-off') { $profile.pilotSchoolId = $School }
    if ($Mode -ceq 'transient-poll-replay-pilot') {
        $profile.pollReplayEvidence = [pscustomobject]@{
            validatedAt = [DateTimeOffset]::UtcNow.ToString('o')
            pilotSchoolId = $School; extensionVersion = '2.9.9'; releaseTag = 'v2.9.9'
            sourceCommit = ('c' * 40); zipSha256 = ('d' * 64); testEvidenceSha256 = ('e' * 64)
            extensionId = $script:ClassPilotExtensionId
            checks = [pscustomobject]@{
                packagedChromePassed = $true; managedChromebookPassed = $true; crossRepositoryContractPassed = $true
                restartAndCrashPassed = $true; mixedFleetPassed = $true; existingPagesUpgradePassed = $true; dashboardReloaded = $true
            }
        }
    }
    return [pscustomobject]$profile
}
function Resolve-TestReplayRuntime {
    param($Profile, $Source)
    return Resolve-SourcePreservingRuntimeConfiguration -RuntimeIntent (ConvertTo-RuntimeConfiguration -Profile $Profile) `
        -SourceTaskDefinition $Source -ContainerName api
}
$replayHistorical = New-TransitionSourceTask -RuntimeConfiguration (ConvertTo-RuntimeConfiguration -Profile $globalProfile)
$replayHistoricalContainer = $replayHistorical.containerDefinitions[0]
$replayHistoricalContainer.environment = @($replayHistoricalContainer.environment | Where-Object name -CNE 'CLASSPILOT_CAP_POLL_REPLAY_SAFE_V1')
$replayHistoricalRegistry = ($replayHistoricalContainer.environment | Where-Object name -CEQ 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON').value | ConvertFrom-Json -AsHashtable
$replayHistoricalRegistry.Remove('pollReplaySafeV1')
($replayHistoricalContainer.environment | Where-Object name -CEQ 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON').value = $replayHistoricalRegistry | ConvertTo-Json -Depth 10 -Compress
Assert-Condition ((Get-RuntimeActivationState -Environment $replayHistoricalContainer.environment -AllowBaseline).Mode -ceq 'global-on') 'Historical definitions without replay names/capability must remain readable.'
$replayTimer = Resolve-TestReplayRuntime (New-TestReplayProfile 'transient-timer-replay-pilot') $replayHistorical
$replayV7 = Resolve-TestReplayRuntime (New-TestReplayProfile 'transient-timer-replay-pilot' '11111111-1111-7111-8111-111111111111') $replayHistorical
Assert-Condition ($replayV7.Environment.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS -ceq '11111111-1111-7111-8111-111111111111') 'Runtime and backend must admit the same canonical modern UUID school scope.'
Assert-AllowedRuntimeTransition -SourceTaskDefinition $replayHistorical -ContainerName api -TargetRuntimeConfiguration $replayTimer
Assert-Condition ($replayTimer.Environment.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH -ceq 'true' -and
    $replayTimer.Environment.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS -ceq $testSchoolId -and
    $replayTimer.Environment.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS -ceq '' -and
    $replayTimer.Environment.CLASSPILOT_CAP_POLL_REPLAY_SAFE_V1 -ceq 'false') 'Timer pilot must enable one school and leave poll replay disabled without a manual TTL.'
$replayTimerSource = New-TransitionSourceTask -RuntimeConfiguration $replayTimer
$replayPollProfile = New-TestReplayProfile 'transient-poll-replay-pilot'
$replayPoll = Resolve-TestReplayRuntime $replayPollProfile $replayTimerSource
Assert-AllowedRuntimeTransition -SourceTaskDefinition $replayTimerSource -ContainerName api -TargetRuntimeConfiguration $replayPoll
Assert-Condition ((Get-TransientReplayRuntimeControl (ConvertTo-TestEnvironmentList $replayPoll)).Mode -ceq 'poll-pilot') 'Poll pilot must promote the exact timer school with negotiated capability controls.'
Assert-Throws { Resolve-TestReplayRuntime $replayPollProfile $replayHistorical } 'Poll replay must not skip the timer pilot.'
Assert-Throws { Resolve-TestReplayRuntime (New-TestReplayProfile 'transient-timer-replay-pilot') $replayTimerSource } 'Timer pilot must not silently reconfigure an active pilot.'
Assert-Throws { Resolve-TestReplayRuntime (New-TestReplayProfile 'transient-poll-replay-pilot' '22222222-2222-4222-8222-222222222222') $replayTimerSource } 'Poll pilot must not switch schools.'
foreach ($replayBadMode in @('transient-replay-global-on', 'transient-poll-replay-global-on')) {
    Assert-Throws { ConvertTo-RuntimeConfiguration ([pscustomobject]@{ schemaVersion = 11; mode = $replayBadMode }) } 'Global replay activation has no reviewed profile.'
}
Assert-Throws { ConvertTo-RuntimeConfiguration ([pscustomobject]@{ schemaVersion = 10; mode = 'transient-replay-off' }) } 'Replay profile schema must match.'
Assert-Throws { ConvertTo-RuntimeConfiguration ([pscustomobject]@{ schemaVersion = 11; mode = 'transient-timer-replay-pilot'; pilotSchoolId = '' }) } 'Replay pilot cannot omit scope.'
Assert-Throws { ConvertTo-RuntimeConfiguration ([pscustomobject]@{ schemaVersion = 11; mode = 'transient-replay-off'; pilotSchoolId = $testSchoolId }) } 'Replay off cannot carry a pilot school.'
Assert-Throws { ConvertTo-RuntimeConfiguration ([pscustomobject]@{ schemaVersion = 11; mode = 'transient-poll-replay-pilot'; pilotSchoolId = $testSchoolId }) } 'Poll replay cannot activate without package/device evidence.'
foreach ($replayBadField in @('managedChromebookPassed', 'packagedChromePassed', 'restartAndCrashPassed', 'existingPagesUpgradePassed')) {
    $replayBadEvidence = New-TestReplayProfile 'transient-poll-replay-pilot'
    $replayBadEvidence.pollReplayEvidence.checks.$replayBadField = $false
    Assert-Throws { ConvertTo-RuntimeConfiguration $replayBadEvidence } 'Unpassed managed/package/upgrade checks cannot be waived.'
}
$replayBadEvidence = New-TestReplayProfile 'transient-poll-replay-pilot'
$replayBadEvidence.pollReplayEvidence.extensionVersion = '2.9.8'
Assert-Throws { ConvertTo-RuntimeConfiguration $replayBadEvidence } 'Version 2.9.8 cannot establish the poll replay contract.'
$replayBadEvidence = New-TestReplayProfile 'transient-poll-replay-pilot'
$replayBadEvidence.pollReplayEvidence.validatedAt = [DateTimeOffset]::UtcNow.AddHours(-3).ToString('o')
Assert-Throws { ConvertTo-RuntimeConfiguration $replayBadEvidence } 'Expired release validation must be renewed before applying.'
Assert-Throws { Select-ServingRuntimeConfiguration -RuntimeConfiguration $replayTimer -KnownCapabilities @($script:AllCapabilities | Where-Object { $_ -cne 'pollReplaySafeV1' }) } 'Unsafe older images must not activate even timer replay.'

$replayPollSource = New-TransitionSourceTask -RuntimeConfiguration $replayPoll
$replayOff = Resolve-TestReplayRuntime (New-TestReplayProfile 'transient-replay-off') $replayPollSource
Assert-AllowedRuntimeTransition -SourceTaskDefinition $replayPollSource -ContainerName api -TargetRuntimeConfiguration $replayOff
Assert-Condition ($replayOff.Environment.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH -ceq 'false' -and
    $replayOff.Environment.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS -ceq '' -and
    $replayOff.Environment.CLASSPILOT_CAP_POLL_REPLAY_SAFE_V1 -ceq 'false') 'Replay off must clear both gates and school scope.'
foreach ($replayBadTtl in @('1', '14999', '60001', '15000.5', 'NaN')) {
    $replayBadEnv = @(ConvertTo-TestEnvironmentList $replayTimer | ForEach-Object {
        [pscustomobject]@{ name = $_.name; value = if ($_.name -ceq 'CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS') { $replayBadTtl } else { $_.value } }
    })
    Assert-Throws { Get-RuntimeActivationState -Environment $replayBadEnv } 'Unsafe TTL controls must be rejected.'
}
$replayMissingSchool = @(ConvertTo-TestEnvironmentList $replayTimer | Where-Object name -CNE 'CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS')
Assert-Throws { Get-RuntimeActivationState -Environment $replayMissingSchool } 'Missing scope must never turn a pilot global.'
$replayWrongScope = @(ConvertTo-TestEnvironmentList $replayPoll | ForEach-Object {
    [pscustomobject]@{ name = $_.name; value = if ($_.name -ceq 'CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS') { '22222222-2222-4222-8222-222222222222' } else { $_.value } }
})
Assert-Throws { Get-RuntimeActivationState -Environment $replayWrongScope } 'Poll capability and timer school scope must agree.'
$replayPreserved = Resolve-SourcePreservingRuntimeConfiguration `
    -RuntimeIntent (ConvertTo-RuntimeConfiguration ([pscustomobject]@{ schemaVersion = 3; mode = 'student-gate-pilot'; pilotSchoolId = $testSchoolId })) `
    -SourceTaskDefinition $replayTimerSource -ContainerName api
Assert-AllowedRuntimeTransition -SourceTaskDefinition $replayTimerSource -ContainerName api -TargetRuntimeConfiguration $replayPreserved
Assert-Condition ($replayPreserved.Environment.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS -ceq $testSchoolId) 'Unrelated source-preserving profiles retain replay controls.'
$replayTampered = Resolve-TestReplayRuntime (New-TestReplayProfile 'transient-replay-off') $replayPollSource
$replayTampered.Environment.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = 'false'
Assert-Throws { Assert-AllowedRuntimeTransition -SourceTaskDefinition $replayPollSource -ContainerName api -TargetRuntimeConfiguration $replayTampered } 'Replay profiles must not change another capability.'

# The task cloner and read-back verifier must agree on exact optional presence.
$replayDefinitionResponse = New-TestTaskResponse -Role api -Arn 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:10' `
    -Digest ('sha256:' + ('b' * 64)) -ManagedEnvironment @(ConvertTo-TestEnvironmentList $replayTimer)
Assert-RuntimeTaskConfiguration -TaskDefinition $replayDefinitionResponse.taskDefinition -RuntimeConfiguration $replayTimer -ContainerName api
$replayDefinitionResponse.taskDefinition.containerDefinitions[0].environment += [pscustomobject]@{ name = 'CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH'; value = 'false' }
Assert-Throws { Assert-RuntimeTaskConfiguration -TaskDefinition $replayDefinitionResponse.taskDefinition -RuntimeConfiguration $replayTimer -ContainerName api } 'Registered duplicate replay controls must fail closed.'
