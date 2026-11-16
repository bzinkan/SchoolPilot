#requires -Version 7.5
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/deploy-classpilot-runtime-config.ps1')
$newCapabilities = @('deviceTelemetryTransportV1', 'scopedScreenshotReferencesV1', 'scopedScreenshotDeltasV1')
foreach ($capability in $newCapabilities) {
    if ($script:AllCapabilities -cnotcontains $capability -or $script:AdditiveCapabilities -cnotcontains $capability) {
        throw "Missing additive telemetry registry entry: $capability"
    }
    if ($script:ActivationOrder -ccontains $capability) { throw 'Historical activation prefix changed.' }
}
# Pin historical positions rather than the absolute tail: future capabilities
# may append, but cannot move the telemetry trio or any earlier registry entry.
$historicalPrefix = @(
    'scopedAuthorityChecksV1', 'exactBindingAckV2', 'exactTabCloseV2', 'authBoundTelemetryV1',
    'studentChatIdempotencyV1', 'screenshotObservationLeaseV1', 'safetyEvidenceCaptureV1',
    'liveViewIceServersV1', 'kioskLaunchTicketV2', 'screenshotTrackingWindowLeaseV1',
    'screenshotActiveObservationCadenceV1', 'studentAuthGatePresenceV1', 'lateSignInRestrictionSsoV1',
    'restrictionAuthPassThroughV1', 'scheduledClassroomV1', 'afterHoursSafetyOnlyV1',
    'schoolWebsiteBlockEnforcementV1', 'screenshotReadOnlyObservationV1', 'preciseRestrictionResourcesV1',
    'kioskLaunchTicketV1', 'focusTabV1', 'privateChatLifecycleV1', 'pollReplaySafeV1'
) + $newCapabilities + @('classroomFocusScopeV1')
if ($script:AllCapabilities.Count -lt $historicalPrefix.Count -or
    ($script:AllCapabilities[0..($historicalPrefix.Count - 1)] -join ',') -cne ($historicalPrefix -join ',')) {
    throw 'Registry positions must remain fixed, with Classroom Focus appended after every historical entry.'
}
if (@($script:AllCapabilities | Group-Object -CaseSensitive | Where-Object Count -gt 1).Count -ne 0) {
    throw 'Append-only registry additions must not duplicate existing capability names.'
}
$profile = [pscustomobject]@{ schemaVersion = 1; mode = 'test-school'; testSchoolId = '11111111-1111-4111-8111-111111111111'; enabledCapabilities = @($script:ActivationOrder) }
$runtime = ConvertTo-RuntimeConfiguration -Profile $profile
$rollouts = $runtime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON | ConvertFrom-Json -Depth 15
foreach ($capability in $newCapabilities) {
    if ($rollouts.$capability.mode -cne 'off' -or $runtime.Environment[$script:CapabilityFlags[$capability]] -cne 'false') {
        throw 'Existing profiles must never activate new telemetry or image-reference behavior.'
    }
}
Write-Output 'Telemetry runtime registry: appended, default off, historical prefix preserved.'
