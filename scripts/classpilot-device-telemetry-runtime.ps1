# Schema 12 controls. Dot-sourced by the governed Plan/Apply tool; no providers.
$script:TelemetryProfileCapabilities = @{
    'device-telemetry-pilot' = 'deviceTelemetryTransportV1'
    'device-telemetry-global-on' = 'deviceTelemetryTransportV1'
    'device-telemetry-off' = 'deviceTelemetryTransportV1'
    'screenshot-references-pilot' = 'scopedScreenshotReferencesV1'
    'screenshot-references-global-on' = 'scopedScreenshotReferencesV1'
    'screenshot-references-off' = 'scopedScreenshotReferencesV1'
}
$script:TelemetryPilotModes = @('device-telemetry-pilot', 'screenshot-references-pilot')
$script:TelemetryGlobalModes = @('device-telemetry-global-on', 'screenshot-references-global-on')
$script:TelemetryCapabilities = @('deviceTelemetryTransportV1', 'scopedScreenshotReferencesV1')

function Assert-TelemetryLocalValidation {
    param($Profile)
    $on = [string]$Profile.mode -cin @($script:TelemetryPilotModes + $script:TelemetryGlobalModes)
    $hasValidation = $Profile.PSObject.Properties.Name -ccontains 'localValidation'
    if (-not $on) {
        if ($hasValidation) { throw 'Only Schema 12 activation profiles may carry local validation; off is evidence-free.' }
        return
    }
    if (-not $hasValidation) { throw 'Telemetry activation requires factual local Windows compatibility validation.' }
    $record = $Profile.localValidation
    $fields = @('schemaVersion', 'validationLevel', 'capacityAccepted', 'appSha', 'extensionSha', 'checks')
    Assert-ExactProperties -Value $record -Allowed $fields -Trail 'localValidation'
    foreach ($field in $fields) {
        if ($record.PSObject.Properties.Name -cnotcontains $field) { throw 'Local telemetry validation is incomplete.' }
    }
    if ($record.schemaVersion -isnot [long] -and $record.schemaVersion -isnot [int]) { throw 'Local validation schemaVersion must be an integer.' }
    if ($record.schemaVersion -ne 1 -or [string]$record.validationLevel -cne 'local_windows_correctness' -or
        $record.capacityAccepted -isnot [bool] -or $record.capacityAccepted -ne $false -or
        [string]$record.appSha -cnotmatch '^[0-9a-f]{40}$' -or [string]$record.extensionSha -cnotmatch '^[0-9a-f]{40}$') {
        throw 'Local validation must bind exact backend and extension sources and explicitly decline capacity acceptance.'
    }
    $checks = @('httpWsParity', 'lostReplyIdempotency', 'staleBindingDenied', 'controlLaneIndependent', 'realChromeMv3Passed', 'captureCadenceAndPixelsPreserved')
    Assert-ExactProperties -Value $record.checks -Allowed $checks -Trail 'localValidation.checks'
    foreach ($check in $checks) {
        if ($record.checks.PSObject.Properties.Name -cnotcontains $check -or
            $record.checks.$check -isnot [bool] -or $record.checks.$check -ne $true) {
            throw 'Every local Windows compatibility check must factually pass for the exact source commits.'
        }
    }
}

function Assert-TelemetryLocalValidationSource {
    param($Profile, [string]$AppSha)
    Assert-TelemetryLocalValidation -Profile $Profile
    if ([string]$Profile.mode -cin @($script:TelemetryPilotModes + $script:TelemetryGlobalModes) -and
        [string]$Profile.localValidation.appSha -cne $AppSha) {
        throw 'Local telemetry validation must match the exact planned backend source SHA.'
    }
}

function Get-TelemetryEntrySchools {
    param($Entry)
    $hasScope = if ($Entry -is [System.Collections.IDictionary]) {
        $Entry.Contains('schoolIds')
    } else { $Entry.PSObject.Properties.Name -ccontains 'schoolIds' }
    if ($hasScope) {
        if ($Entry.schoolIds -isnot [Array] -or @($Entry.schoolIds).Count -ne 1) {
            throw 'A present telemetry school scope must be a one-element array.'
        }
        return @($Entry.schoolIds)
    }
    return @()
}

function Assert-TelemetryRuntimeControls {
    param($Values, $Rollouts)
    foreach ($capability in $script:TelemetryCapabilities) {
        $flag = [string]$Values[$script:CapabilityFlags[$capability]]
        $entry = $Rollouts.$capability
        $schools = @(Get-TelemetryEntrySchools $entry)
        if ($flag -cnotin @('true', 'false') -or ($flag -ceq 'true') -ne ([string]$entry.mode -ceq 'on')) {
            throw 'Telemetry capabilities require matching flag and rollout entry controls.'
        }
        if ($flag -ceq 'false') {
            if ($schools.Count -ne 0) { throw 'Disabled telemetry controls must clear their school scope.' }
            continue
        }
        if ($schools.Count -gt 1 -or ($schools.Count -eq 1 -and [string]$schools[0] -cnotmatch
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) {
            throw 'Telemetry rollout must be global or exactly one canonical pilot school.'
        }
        if ([string]$Values.CLASSPILOT_PROTOCOL_V3_ENABLED -cne 'true') { throw 'Telemetry requires the protocol gate.' }
        $parents = @('scopedAuthorityChecksV1')
        if ($capability -ceq 'scopedScreenshotReferencesV1') { $parents += @('deviceTelemetryTransportV1', $script:TrackingWindowCapability) }
        foreach ($parent in $parents) {
            $parentEntry = $Rollouts.$parent
            if ([string]$Values[$script:CapabilityFlags[$parent]] -cne 'true' -or [string]$parentEntry.mode -cne 'on') {
                throw 'Telemetry rollout requires every parent capability to be active.'
            }
            $parentSchools = @(Get-TelemetryEntrySchools $parentEntry)
            if ($parentSchools.Count -gt 0 -and ($schools.Count -eq 0 -or
                @($schools | Where-Object { $_ -cnotin $parentSchools }).Count -gt 0)) {
                throw 'Telemetry school scope must remain inside every active parent scope.'
            }
        }
    }
}

function Set-TelemetryRuntimeIntent {
    param($RuntimeIntent, $Values, $Rollouts)
    $mode = [string]$RuntimeIntent.Mode
    $selected = [string]$script:TelemetryProfileCapabilities[$mode]
    $previous = $Rollouts.$selected
    $previousSchools = @(Get-TelemetryEntrySchools $previous)
    if ($mode -cin $script:TelemetryPilotModes -and
        ([string]$previous.mode -cne 'off' -or [string]$Values[$script:CapabilityFlags[$selected]] -cne 'false')) {
        throw 'Telemetry pilot must begin from off.'
    }
    if ($mode -cin $script:TelemetryGlobalModes -and
        ([string]$previous.mode -cne 'on' -or [string]$Values[$script:CapabilityFlags[$selected]] -cne 'true' -or $previousSchools.Count -ne 1)) {
        throw 'Global telemetry activation must promote its active one-school pilot.'
    }
    $on = $mode -cin @($script:TelemetryPilotModes + $script:TelemetryGlobalModes)
    $Values[$script:CapabilityFlags[$selected]] = if ($on) { 'true' } else { 'false' }
    $Rollouts[$selected] = [ordered]@{ mode = if ($on) { 'on' } else { 'off' } }
    if ($mode -cin $script:TelemetryPilotModes) { $Rollouts[$selected].schoolIds = @([string]$RuntimeIntent.PilotSchoolId) }
    Assert-TelemetryRuntimeControls -Values $Values -Rollouts $Rollouts
}

function Assert-TelemetryRuntimeTransition {
    param($SourceControls, $TargetControls, $SourceState, $TargetState, $RuntimeConfiguration)
    $mode = [string]$RuntimeConfiguration.Mode
    if (-not $script:TelemetryProfileCapabilities.ContainsKey($mode)) {
        if ($mode -ceq 'off') { return }
        foreach ($capability in $script:TelemetryCapabilities) {
            if ((Get-CanonicalJsonSha256 $SourceControls[$capability]) -cne (Get-CanonicalJsonSha256 $TargetControls[$capability])) {
                throw 'Other profiles must preserve telemetry controls; disable each with its own off profile first.'
            }
        }
        return
    }
    if ([string]$SourceState.Mode -cnotin @('global-on', 'tracking-window-pilot', 'tracking-window-global-on') -or
        [string]$SourceState.Mode -cne [string]$TargetState.Mode -or [string]$SourceState.SchoolId -cne [string]$TargetState.SchoolId -or
        [int]$SourceState.PrefixCount -ne [int]$TargetState.PrefixCount -or
        ($RuntimeConfiguration.PSObject.Properties.Name -ccontains 'SourceMode' -and [string]$RuntimeConfiguration.SourceMode -cne [string]$SourceState.Mode)) {
        throw 'Telemetry profiles must preserve their exact completed repaired-capability source.'
    }
    $selected = [string]$script:TelemetryProfileCapabilities[$mode]
    foreach ($capability in $script:AllCapabilities) {
        if ($capability -ceq $selected) { continue }
        if ((Get-CanonicalJsonSha256 $SourceControls[$capability]) -cne (Get-CanonicalJsonSha256 $TargetControls[$capability])) {
            throw 'Telemetry profiles must preserve every other capability and school scope.'
        }
    }
    $source = $SourceControls[$selected]; $target = $TargetControls[$selected]
    if ($mode -cin $script:TelemetryPilotModes) {
        if ($source.flag -cne 'false' -or $source.mode -cne 'off' -or $target.flag -cne 'true' -or $target.mode -cne 'on' -or
            @($target.schoolIds).Count -ne 1 -or [string]$target.schoolIds[0] -cne [string]$RuntimeConfiguration.PilotSchoolId) {
            throw 'Telemetry activation must begin with its exact school pilot from off.'
        }
    } elseif ($mode -cin $script:TelemetryGlobalModes) {
        if ($source.flag -cne 'true' -or $source.mode -cne 'on' -or @($source.schoolIds).Count -ne 1 -or
            $target.flag -cne 'true' -or $target.mode -cne 'on' -or @($target.schoolIds).Count -ne 0) {
            throw 'Telemetry global promotion must release only its active one-school pilot.'
        }
    } elseif ($target.flag -cne 'false' -or $target.mode -cne 'off' -or @($target.schoolIds).Count -ne 0) {
        throw 'Telemetry off must disable only its selected capability.'
    }
}
