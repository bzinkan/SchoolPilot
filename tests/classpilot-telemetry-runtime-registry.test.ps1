#requires -Version 7.5
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/deploy-classpilot-runtime-config.ps1')
$newCapabilities = @('deviceTelemetryTransportV1', 'scopedScreenshotReferencesV1')
foreach ($capability in $newCapabilities) {
    if ($script:AllCapabilities -cnotcontains $capability -or $script:AdditiveCapabilities -cnotcontains $capability) {
        throw "Missing additive telemetry registry entry: $capability"
    }
    if ($script:ActivationOrder -ccontains $capability) { throw 'Historical activation prefix changed.' }
}
if (($script:AllCapabilities[-2..-1] -join ',') -cne ($newCapabilities -join ',')) { throw 'New capabilities must append after every historical entry.' }
$profile = [pscustomobject]@{ schemaVersion = 1; mode = 'test-school'; testSchoolId = '11111111-1111-4111-8111-111111111111'; enabledCapabilities = @($script:ActivationOrder) }
$runtime = ConvertTo-RuntimeConfiguration -Profile $profile
$rollouts = $runtime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON | ConvertFrom-Json -Depth 15
foreach ($capability in $newCapabilities) {
    if ($rollouts.$capability.mode -cne 'off' -or $runtime.Environment[$script:CapabilityFlags[$capability]] -cne 'false') {
        throw 'Existing profiles must never activate new telemetry or image-reference behavior.'
    }
}
Write-Output 'Telemetry runtime registry: appended, default off, historical prefix preserved.'
