#requires -Version 7.5

# Loaded by deploy-classpilot-runtime-config.ps1. This exception belongs only to
# precise resources and Focus. It does not restore the retired TURN waiver.
function Get-RoadmapReleaseCapability {
    param([Parameter(Mandatory = $true)][string]$Mode)
    switch -CaseSensitive ($Mode) {
        { $_ -cin @('precise-restriction-resources-pilot', 'precise-restriction-resources-global-on') } {
            return 'preciseRestrictionResourcesV1'
        }
        { $_ -cin @('focus-tab-pilot', 'focus-tab-global-on') } { return 'focusTabV1' }
        default { return $null }
    }
}

function Assert-RequiredEvidenceProperties {
    param($Value, [string[]]$Names, [string]$Label)
    Assert-ExactProperties -Value $Value -Allowed $Names -Trail $Label
    if (@($Names | Where-Object { $Value.PSObject.Properties.Name -cnotcontains $_ }).Count -ne 0) {
        throw "$Label is incomplete."
    }
}

function Assert-EvidenceChecksPassed {
    param($Value, [string[]]$Names, [string]$Label)
    Assert-RequiredEvidenceProperties -Value $Value -Names $Names -Label $Label
    foreach ($name in $Names) {
        if ($Value.$name -isnot [bool] -or -not $Value.$name) { throw "$Label requires $name."
        }
    }
}

function Assert-RoadmapReleaseEvidence {
    param(
        [Parameter(Mandatory = $true)]$EvidenceSnapshot,
        [Parameter(Mandatory = $true)][string]$Mode,
        [Parameter(Mandatory = $true)][string]$PilotSchoolId,
        [Parameter(Mandatory = $true)][string]$ToolSha,
        [Parameter(Mandatory = $true)][string]$AppSha,
        [Parameter(Mandatory = $true)][string]$ImageDigest,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    $capability = Get-RoadmapReleaseCapability -Mode $Mode
    if ($null -eq $capability) { throw 'The managed-validation exception does not cover this profile.' }
    if ($capability -ceq 'preciseRestrictionResourcesV1') {
        Assert-PreciseRestrictionPilotReleaseEvidenceBound
        $mergeSha = $script:PreciseRestrictionRequiredMergeSha
        $zipSha256 = $script:PreciseRestrictionRequiredZipSha256
    }
    else {
        Assert-FocusTabPilotReleaseEvidenceBound
        $mergeSha = $script:FocusTabRequiredMergeSha
        $zipSha256 = $script:FocusTabRequiredZipSha256
    }
    $evidence = $EvidenceSnapshot.Value
    Assert-RequiredEvidenceProperties -Value $evidence -Names @(
        'schemaVersion', 'approvedAt', 'approvedBy', 'reason', 'validationLevel', 'managedValidation',
        'capability', 'pilotSchoolId', 'toolSha', 'appSha', 'imageDigest', 'classPilotTag',
        'classPilotMergeSha', 'classPilotZipSha256', 'classPilotExtensionId',
        'contractFixtureSha256', 'testEvidenceSha256', 'checks'
    ) -Label 'roadmap release evidence'
    foreach ($name in @('approvedAt', 'approvedBy', 'reason', 'validationLevel', 'managedValidation', 'capability',
        'pilotSchoolId', 'toolSha', 'appSha', 'imageDigest', 'classPilotTag', 'classPilotMergeSha',
        'classPilotZipSha256', 'classPilotExtensionId', 'contractFixtureSha256', 'testEvidenceSha256')) {
        if ($evidence.$name -isnot [string]) { throw 'Roadmap release identity fields must be strings.' }
    }
    if (-not (Test-IsJsonInteger $evidence.schemaVersion) -or $evidence.schemaVersion -ne 1 -or
        $evidence.approvedBy -cne 'bzinkan@school-pilot.net' -or
        $evidence.reason -isnot [string] -or $evidence.reason.Length -lt 20 -or $evidence.reason.Length -gt 1000 -or
        $evidence.validationLevel -cne 'synthetic_only' -or $evidence.managedValidation -cne 'waived_not_passed') {
        throw 'Roadmap release evidence must record the explicit scoped approval and unpassed managed validation.'
    }
    [void](Get-FreshEvidenceTimestamp -Value ([string]$evidence.approvedAt) -Label 'roadmap release approval' -Now $Now)
    $fixtureSha = Get-FileSha256 -Path (Join-Path $RepositoryRoot 'tests/fixtures/restriction-resource-matcher-cases.json')
    if ($PilotSchoolId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
        $evidence.capability -cne $capability -or $evidence.pilotSchoolId -cne $PilotSchoolId -or
        $evidence.toolSha -cne $ToolSha -or $evidence.appSha -cne $AppSha -or $evidence.imageDigest -cne $ImageDigest -or
        $evidence.classPilotTag -cne 'v2.9.7' -or $evidence.classPilotMergeSha -cne $mergeSha -or
        $evidence.classPilotZipSha256 -cne $zipSha256 -or $evidence.classPilotExtensionId -cne $script:ClassPilotExtensionId -or
        $evidence.contractFixtureSha256 -cne $fixtureSha -or $evidence.testEvidenceSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Roadmap release evidence does not bind the exact source, package, capability and pilot.'
    }
    Assert-EvidenceChecksPassed -Value $evidence.checks -Names @(
        'combinedCiPassed', 'exactPackageVerified', 'nativeChromePackagePassed', 'crossRepositoryContractPassed',
        'unsupportedClientsFailClosed', 'identityAndStaleBindingPassed', 'offlineCleanupPassed',
        'attentionLessonAndChatRegressionsPassed', 'announcementsRemainAvailable'
    ) -Label 'roadmap release evidence.checks'
    return [pscustomobject]@{ EvidenceSha256 = [string]$EvidenceSnapshot.Sha256; Capability = $capability }
}

function Assert-RoadmapPilotEvidence {
    param(
        [Parameter(Mandatory = $true)]$EvidenceSnapshot,
        [Parameter(Mandatory = $true)][string]$Mode,
        [Parameter(Mandatory = $true)][string]$PilotSchoolId,
        [Parameter(Mandatory = $true)][string]$ToolSha,
        [Parameter(Mandatory = $true)][string]$AppSha,
        [Parameter(Mandatory = $true)][string]$ImageDigest,
        [Parameter(Mandatory = $true)][string]$ApiTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$WorkerTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$RuntimeConfigurationSha256,
        [AllowNull()][string]$ReleaseEvidenceSha256,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    if ($Mode -cnotin $script:RoadmapGlobalModes) {
        throw 'Live pilot evidence is valid only for the scoped roadmap global promotion.'
    }
    $evidence = $EvidenceSnapshot.Value
    Assert-RequiredEvidenceProperties -Value $evidence -Names @(
        'schemaVersion', 'reviewedAt', 'observedFrom', 'observedThrough', 'capability', 'pilotSchoolId',
        'toolSha', 'appSha', 'imageDigest', 'apiTaskDefinitionArn', 'workerTaskDefinitionArn',
        'runtimeConfigurationSha256', 'releaseEvidenceSha256', 'observedActions', 'logSha256', 'checks'
        'classPilotTag', 'classPilotMergeSha', 'classPilotZipSha256', 'classPilotExtensionId'
    ) -Label 'roadmap live pilot evidence'
    foreach ($name in @('reviewedAt', 'observedFrom', 'observedThrough', 'capability', 'pilotSchoolId', 'toolSha',
        'appSha', 'imageDigest', 'apiTaskDefinitionArn', 'workerTaskDefinitionArn', 'runtimeConfigurationSha256',
        'logSha256', 'classPilotTag', 'classPilotMergeSha', 'classPilotZipSha256', 'classPilotExtensionId')) {
        if ($evidence.$name -isnot [string]) { throw 'Live pilot identity fields must be strings.' }
    }
    if (-not (Test-IsJsonInteger $evidence.schemaVersion) -or $evidence.schemaVersion -ne 1 -or
        $evidence.capability -cne $script:RoadmapProfileCapabilities[$Mode] -or
        $evidence.pilotSchoolId -cne $PilotSchoolId -or $evidence.toolSha -cne $ToolSha -or
        $evidence.appSha -cne $AppSha -or $evidence.imageDigest -cne $ImageDigest -or
        $evidence.apiTaskDefinitionArn -cne $ApiTaskDefinitionArn -or $evidence.workerTaskDefinitionArn -cne $WorkerTaskDefinitionArn -or
        $evidence.runtimeConfigurationSha256 -cne $RuntimeConfigurationSha256 -or
        [string]$evidence.releaseEvidenceSha256 -cne [string]$ReleaseEvidenceSha256 -or
        -not (Test-IsJsonInteger $evidence.observedActions) -or $evidence.observedActions -lt 1 -or
        $evidence.logSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Live pilot evidence does not bind the currently serving pilot and release approval.'
    }
    if ($Mode -ceq 'focus-tab-global-on') {
        Assert-FocusTabPilotReleaseEvidenceBound
        $mergeSha = $script:FocusTabRequiredMergeSha; $zipSha = $script:FocusTabRequiredZipSha256
    }
    else {
        # The reviewed common successor also binds the existing after-hours and
        # website pilot promotion. No managed waiver is granted for those modes.
        Assert-PreciseRestrictionPilotReleaseEvidenceBound
        $mergeSha = $script:PreciseRestrictionRequiredMergeSha; $zipSha = $script:PreciseRestrictionRequiredZipSha256
    }
    if ($evidence.classPilotTag -cne 'v2.9.7' -or $evidence.classPilotMergeSha -cne $mergeSha -or
        $evidence.classPilotZipSha256 -cne $zipSha -or $evidence.classPilotExtensionId -cne $script:ClassPilotExtensionId) {
        throw 'Live pilot evidence does not bind the exact reviewed 2.9.7 package.'
    }
    if (-not $ReleaseEvidenceSha256 -and $null -ne $evidence.releaseEvidenceSha256) {
        throw 'Live-only promotion must not claim a managed-waiver receipt.'
    }
    if ($ReleaseEvidenceSha256 -and $evidence.releaseEvidenceSha256 -isnot [string]) {
        throw 'A waived live pilot must bind one string release-evidence hash.'
    }
    $reviewedAt = [DateTimeOffset]::Parse((Get-FreshEvidenceTimestamp -Value ([string]$evidence.reviewedAt) -Label 'roadmap live pilot review' -Now $Now))
    try {
        $from = [DateTimeOffset]::ParseExact([string]$evidence.observedFrom, 'o', [Globalization.CultureInfo]::InvariantCulture)
        $through = [DateTimeOffset]::ParseExact([string]$evidence.observedThrough, 'o', [Globalization.CultureInfo]::InvariantCulture)
    }
    catch { throw 'Live pilot observations require exact ISO-8601 timestamps.' }
    if (($through - $from).TotalMinutes -lt 15 -or ($through - $from).TotalHours -gt 24 -or
        ($reviewedAt - $through).TotalMinutes -lt 0 -or ($reviewedAt - $through).TotalMinutes -gt 30) {
        throw 'Live pilot evidence requires a completed, recent observation window of at least 15 minutes.'
    }
    Assert-EvidenceChecksPassed -Value $evidence.checks -Names @(
        'teachingPeriodObserved', 'supportedClientNegotiated', 'exactRecipientsVerified', 'resourceOrFocusEnforced',
        'completedOutcomeVerified', 'staleAndOfflineCleanupVerified', 'unsupportedClientsFailClosed',
        'noAuthorizationOrPrivacyDefects', 'apiWorkerAndRosterHealthy', 'announcementsRemainAvailable'
    ) -Label 'roadmap live pilot evidence.checks'
    return [pscustomobject]@{ EvidenceSha256 = [string]$EvidenceSnapshot.Sha256 }
}

function Assert-RoadmapActivationEvidence {
    param($Runtime, $SourceTaskDefinition, $ReleaseSnapshot, $PilotSnapshot,
        [string]$ToolSha, [string]$AppSha, [string]$ImageDigest, [string]$RepositoryRoot,
        [string]$ApiTaskDefinitionArn, [string]$WorkerTaskDefinitionArn,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
    $capability = Get-RoadmapReleaseCapability -Mode ([string]$Runtime.Mode)
    $liveOnly = [string]$Runtime.Mode -cin @('after-hours-safety-only-global-on', 'school-website-block-global-on')
    if ($null -eq $capability -and -not $liveOnly) {
        if ($null -ne $ReleaseSnapshot -or $null -ne $PilotSnapshot) { throw 'Roadmap evidence cannot authorize another profile.' }
        return
    }
    if ($liveOnly) {
        if ($null -ne $ReleaseSnapshot) { throw 'This promotion does not use the precise/Focus managed waiver.' }
        $capability = $script:RoadmapProfileCapabilities[[string]$Runtime.Mode]
    }
    elseif ($null -eq $ReleaseSnapshot) { throw 'Precise/Focus activation requires the scoped release approval.' }
    $pilotSchool = [string]$Runtime.PilotSchoolId
    if ([string]$Runtime.Mode -cin $script:RoadmapGlobalModes) {
        $container = @($SourceTaskDefinition.containerDefinitions | Where-Object name -CEQ 'api')
        if ($container.Count -ne 1) { throw 'Live pilot source container is ambiguous.' }
        $controls = Get-RuntimeCapabilityControls -Environment @($container[0].environment)
        $selected = $controls[$capability]
        if ($selected.flag -cne 'true' -or $selected.mode -cne 'on' -or @($selected.schoolIds).Count -ne 1) {
            throw 'Global promotion requires the exact currently active one-school pilot.'
        }
        $pilotSchool = [string]$selected.schoolIds[0]
        if ($null -eq $PilotSnapshot) { throw 'Global promotion requires fresh live current-school pilot evidence.' }
    }
    elseif ($null -ne $PilotSnapshot) { throw 'Live pilot evidence is valid only for global promotion.' }
    if (-not $liveOnly) {
        [void](Assert-RoadmapReleaseEvidence -EvidenceSnapshot $ReleaseSnapshot -Mode ([string]$Runtime.Mode) `
            -PilotSchoolId $pilotSchool -ToolSha $ToolSha -AppSha $AppSha -ImageDigest $ImageDigest `
            -RepositoryRoot $RepositoryRoot -Now $Now)
    }
    if ($null -ne $PilotSnapshot) {
        [void](Assert-RoadmapPilotEvidence -EvidenceSnapshot $PilotSnapshot -Mode ([string]$Runtime.Mode) `
            -PilotSchoolId $pilotSchool -ToolSha $ToolSha -AppSha $AppSha -ImageDigest $ImageDigest `
            -ApiTaskDefinitionArn $ApiTaskDefinitionArn -WorkerTaskDefinitionArn $WorkerTaskDefinitionArn `
            -RuntimeConfigurationSha256 (Get-ManagedRuntimeFingerprint -TaskDefinition $SourceTaskDefinition -ContainerName 'api') `
            -ReleaseEvidenceSha256 $(if ($liveOnly) { $null } else { [string]$ReleaseSnapshot.Sha256 }) -Now $Now)
    }
}

function Assert-PrivateChatRuntimeCompatibility {
    param($Runtime, $Snapshot, [string]$RepositoryRoot, [string]$AppSha)
    $api = $Snapshot.ApiTask.taskDefinition
    $worker = $Snapshot.WorkerTask.taskDefinition
    $sourceContainer = @($api.containerDefinitions | Where-Object name -CEQ 'api')
    if ($sourceContainer.Count -ne 1) { throw 'Private chat source container is ambiguous.' }
    $sourceControls = Get-RuntimeCapabilityControls -Environment @($sourceContainer[0].environment)
    $needsFence = [string]$Runtime.Mode -cin @('private-chat-lifecycle-global-on','private-chat-lifecycle-global-off') -or
        $sourceControls['privateChatLifecycleV1'].mode -ceq 'on' -or
        @($Runtime.EnabledCapabilities) -ccontains 'privateChatLifecycleV1'
    if (-not $needsFence) { return }
    if ([string]$Runtime.Mode -ceq 'private-chat-lifecycle-global-on') { Assert-PreciseRestrictionPilotReleaseEvidenceBound }
    $message = 'Private chat lifecycle requires the complete preserved129-table GUC admission on both services and a lifecycle-aware sticky writer/migration at the exact serving SHA. Capability off never permits legacy fallback.'
    try {
        $source = Invoke-GitText -Arguments @('show', "${AppSha}:src/services/classpilotPrivateChatLifecycle.ts") -RepositoryRoot $RepositoryRoot
        $migration = Invoke-GitText -Arguments @('show', "${AppSha}:src/db/classpilotPrivateChatLifecycleMigration.ts") -RepositoryRoot $RepositoryRoot
        $registry = (Invoke-GitText -Arguments @('show', "${AppSha}:src/config/rlsRegistry.json") -RepositoryRoot $RepositoryRoot) | ConvertFrom-Json -Depth 30 -DateKind String
        $inventory = $registry.inventories.classpilotPrivateChatLifecyclePostExpand
        $previous = @($registry.inventories.passpilotAppointmentsPostExpand.tables)
        if ($source -cnotmatch 'export const PRIVATE_CHAT_LIFECYCLE_WRITER_VERSION = 1;' -or
            $migration -cnotmatch 'id: "classpilot-private-chat-lifecycle-20261002"' -or
            $migration -cnotmatch 'OLD\.private_chat_lifecycle_required\s+AND\s+NOT\s+NEW\.private_chat_lifecycle_required' -or
            $inventory.count -ne 129 -or @($inventory.tables).Count -ne 129 -or
            @($inventory.tables | Sort-Object -Unique).Count -ne 129 -or $previous.Count -ne 128 -or
            (Get-CanonicalJsonSha256 -Value @($inventory.tables)[0..127]) -cne (Get-CanonicalJsonSha256 -Value $previous) -or
            [string]$inventory.tables[128] -cne 'classpilot_private_chat_threads' -or
            (Get-CanonicalJsonSha256 -Value @($registry.reviewedEnablementRequests.classpilotPrivateChatLifecycle)) -cne
                (Get-CanonicalJsonSha256 -Value @('classpilot_private_chat_threads'))) { throw $message }
        foreach ($contract in @(@{ Task=$api; Container='api' }, @{ Task=$worker; Container='scheduler-worker' })) {
            $container = @($contract.Task.containerDefinitions | Where-Object name -CEQ $contract.Container)
            if ($container.Count -ne 1) { throw $message }
            $environment = @{}; foreach ($entry in @($container[0].environment)) { $environment[[string]$entry.name]=[string]$entry.value }
            if ($environment['RLS_GUC_ENABLED'] -cne 'true' -or -not $environment.ContainsKey('RLS_ENABLED_TABLES') -or
                @($inventory.tables | Where-Object { $_ -cnotin $environment['RLS_ENABLED_TABLES'].Split(',') }).Count) { throw $message }
        }
    }
    catch { throw $message }
}
