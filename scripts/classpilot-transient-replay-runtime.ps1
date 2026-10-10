# Narrow, source-preserving controls for the initial one-school replay rollout.
# Dot-sourced by deploy-classpilot-runtime-config.ps1; no AWS calls here.

function Get-TransientReplayRuntimeControl {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()]$Environment)
    $entries = @($Environment | Where-Object { [string]$_.name -iin $script:TransientReplayEnvironmentNames })
    if (@($entries | Where-Object { [string]$_.name -cnotin $script:TransientReplayEnvironmentNames }).Count -gt 0 -or
        @($entries | Group-Object name -CaseSensitive | Where-Object Count -ne 1).Count -gt 0) {
        throw 'Transient replay environment names must be canonical and unique.'
    }
    $values = @{}; foreach ($entry in $entries) { $values[[string]$entry.name] = [string]$entry.value }
    $gate = if ($values.ContainsKey('CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH')) { $values.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH } else { 'false' }
    $schoolId = if ($values.ContainsKey('CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS')) { $values.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS } else { '' }
    $ttl = if ($values.ContainsKey('CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS')) { $values.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS } else { '' }
    if ($gate -cnotin @('true', 'false')) { throw 'Transient replay gate must be true or false.' }
    if (($gate -ceq 'true' -or $schoolId -cne '') -and
        $schoolId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
        throw 'Transient replay requires exactly one canonical school; global activation is not admitted.'
    }
    if ($ttl -cne '' -and ($ttl -cnotmatch '^[0-9]{5}$' -or [int]$ttl -lt 15000 -or [int]$ttl -gt 60000)) {
        throw 'Transient replay TTL override must be an integer from 15000 through 60000 milliseconds.'
    }
    $controls = Get-RuntimeCapabilityControls -Environment $Environment
    $poll = $controls[$script:PollReplayCapability]
    if ($poll.flag -cnotin @('true', 'false') -or ($poll.flag -ceq 'true') -ne ($poll.mode -ceq 'on')) {
        throw 'Poll replay requires matching capability controls.'
    }
    if ($poll.flag -ceq 'true' -and ($gate -cne 'true' -or @($poll.schoolIds).Count -ne 1 -or
        [string]$poll.schoolIds[0] -cne $schoolId)) {
        throw 'Poll replay capability must remain inside the exact active timer replay pilot.'
    }
    if ($poll.flag -ceq 'false' -and @($poll.schoolIds).Count -ne 0) { throw 'Disabled poll replay must clear capability scope.' }
    return [pscustomobject]@{
        Mode = if ($gate -ceq 'false') { 'off' } elseif ($poll.flag -ceq 'true') { 'poll-pilot' } else { 'timer-pilot' }
        SchoolId = if ($gate -ceq 'true') { $schoolId } else { $null }
        Environment = @($entries | Sort-Object name | ForEach-Object { [ordered]@{ name = [string]$_.name; value = [string]$_.value } })
    }
}

function Copy-TransientReplayEnvironment {
    param($RuntimeIntent, $SourceTaskDefinition, [string]$ContainerName)
    $containers = @($SourceTaskDefinition.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($containers.Count -ne 1) { throw 'Transient replay source container is ambiguous.' }
    foreach ($entry in @($containers[0].environment | Where-Object { [string]$_.name -cin $script:TransientReplayEnvironmentNames })) {
        $RuntimeIntent.Environment[[string]$entry.name] = [string]$entry.value
    }
}

function Assert-PollReplayReleaseEvidence {
    param($Profile, [string]$SchoolId, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
    if ($Profile.PSObject.Properties.Name -cnotcontains 'pollReplayEvidence') {
        throw 'Poll replay activation requires packaged extension and managed Chromebook evidence.'
    }
    $evidence = $Profile.pollReplayEvidence
    Assert-ExactProperties -Value $evidence -Allowed @(
        'validatedAt', 'pilotSchoolId', 'extensionVersion', 'releaseTag', 'sourceCommit', 'zipSha256',
        'testEvidenceSha256', 'extensionId', 'checks'
    ) -Trail 'pollReplayEvidence'
    foreach ($required in @('validatedAt', 'pilotSchoolId', 'extensionVersion', 'releaseTag', 'sourceCommit', 'zipSha256', 'testEvidenceSha256', 'extensionId', 'checks')) {
        if ($evidence.PSObject.Properties.Name -cnotcontains $required) { throw 'Poll replay release evidence is incomplete.' }
    }
    $version = $null
    if (-not [Version]::TryParse([string]$evidence.extensionVersion, [ref]$version) -or $version -le [Version]'2.9.8' -or
        [string]$evidence.extensionVersion -cnotmatch '^\d+\.\d+\.\d+$' -or
        [string]$evidence.releaseTag -cne ('v' + [string]$evidence.extensionVersion) -or
        [string]$evidence.pilotSchoolId -cne $SchoolId -or
        [string]$evidence.extensionId -cne $script:ClassPilotExtensionId -or
        [string]$evidence.sourceCommit -cnotmatch '^[0-9a-f]{40}$' -or
        [string]$evidence.zipSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$evidence.testEvidenceSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Poll replay release evidence must bind the successor version, exact source, package, tests, extension, and pilot school.'
    }
    [void](Get-FreshEvidenceTimestamp -Value ([string]$evidence.validatedAt) -Label 'Poll replay validation timestamp' -Now $Now)
    $checks = @('packagedChromePassed', 'managedChromebookPassed', 'crossRepositoryContractPassed',
        'restartAndCrashPassed', 'mixedFleetPassed', 'existingPagesUpgradePassed', 'dashboardReloaded')
    Assert-ExactProperties -Value $evidence.checks -Allowed $checks -Trail 'pollReplayEvidence.checks'
    foreach ($check in $checks) {
        if ($evidence.checks.PSObject.Properties.Name -cnotcontains $check -or
            $evidence.checks.$check -isnot [bool] -or $evidence.checks.$check -ne $true) {
            throw 'Every poll replay release check must have passed; synthetic waivers are not admitted.'
        }
    }
}

function Set-TransientReplayRuntimeIntent {
    param($RuntimeIntent, $SourceEnvironment, $Values, $Rollouts)
    $source = Get-TransientReplayRuntimeControl -Environment $SourceEnvironment
    $mode = [string]$RuntimeIntent.Mode
    if ($mode -ceq 'transient-timer-replay-pilot' -and $source.Mode -cne 'off') {
        throw 'Timer replay pilot must begin from replay off.'
    }
    if ($mode -ceq 'transient-poll-replay-pilot' -and ($source.Mode -cne 'timer-pilot' -or
        [string]$source.SchoolId -cne [string]$RuntimeIntent.PilotSchoolId)) {
        throw 'Poll replay pilot must promote the exact active timer pilot.'
    }
    $on = $mode -cne 'transient-replay-off'
    $pollOn = $mode -ceq 'transient-poll-replay-pilot'
    $Values['CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH'] = if ($on) { 'true' } else { 'false' }
    $Values['CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS'] = if ($on) { [string]$RuntimeIntent.PilotSchoolId } else { '' }
    $Values['CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS'] = ''
    $Values[[string]$script:CapabilityFlags[$script:PollReplayCapability]] = if ($pollOn) { 'true' } else { 'false' }
    $Rollouts[$script:PollReplayCapability] = if ($pollOn) {
        [ordered]@{ mode = 'on'; schoolIds = @([string]$RuntimeIntent.PilotSchoolId) }
    } else { [ordered]@{ mode = 'off' } }
}

function Assert-TransientReplayRuntimeTransition {
    param($SourceEnvironment, $TargetEnvironment, $RuntimeConfiguration)
    $source = Get-TransientReplayRuntimeControl -Environment $SourceEnvironment
    $target = Get-TransientReplayRuntimeControl -Environment $TargetEnvironment
    $sourceControls = Get-RuntimeCapabilityControls -Environment $SourceEnvironment
    $targetControls = Get-RuntimeCapabilityControls -Environment $TargetEnvironment
    if ([string]$RuntimeConfiguration.Mode -cnotin $script:TransientReplayModes) {
        if ((Get-CanonicalJsonSha256 -Value ([ordered]@{ environment = @($source.Environment) })) -cne
            (Get-CanonicalJsonSha256 -Value ([ordered]@{ environment = @($target.Environment) })) -or
            (Get-CanonicalJsonSha256 -Value $sourceControls[$script:PollReplayCapability]) -cne
            (Get-CanonicalJsonSha256 -Value $targetControls[$script:PollReplayCapability])) {
            throw 'Other runtime profiles must preserve the exact replay controls; disable replay with its own off profile first.'
        }
        return
    }
    foreach ($capability in $script:AllCapabilities) {
        if ($capability -ceq $script:PollReplayCapability) { continue }
        if ((Get-CanonicalJsonSha256 -Value $sourceControls[$capability]) -cne
            (Get-CanonicalJsonSha256 -Value $targetControls[$capability])) {
            throw 'Replay profiles must preserve every unrelated capability and school scope.'
        }
    }
    $expected = switch ([string]$RuntimeConfiguration.Mode) {
        'transient-replay-off' { 'off' }
        'transient-timer-replay-pilot' { 'timer-pilot' }
        'transient-poll-replay-pilot' { 'poll-pilot' }
    }
    if ($target.Mode -cne $expected -or ($expected -cne 'off' -and
        [string]$target.SchoolId -cne [string]$RuntimeConfiguration.PilotSchoolId) -or
        ($expected -ceq 'timer-pilot' -and $source.Mode -cne 'off') -or
        ($expected -ceq 'poll-pilot' -and ($source.Mode -cne 'timer-pilot' -or $source.SchoolId -cne $target.SchoolId))) {
        throw 'Transient replay transition must follow off, exact-school timer pilot, then exact-school poll pilot.'
    }
    $values = @{}; foreach ($entry in $TargetEnvironment) { $values[[string]$entry.name] = [string]$entry.value }
    if (-not $values.ContainsKey('CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS') -or
        $values.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS -cne '') { throw 'Replay profiles must clear manual TTL overrides.' }
    if ($expected -ceq 'off' -and $values.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS -cne '') { throw 'Replay off must clear its school scope.' }
}
