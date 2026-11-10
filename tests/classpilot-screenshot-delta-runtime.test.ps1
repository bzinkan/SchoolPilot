#requires -Version 7.5
# Reuse and run the existing pure Schema 12 contract fixtures first.
. (Join-Path $PSScriptRoot 'classpilot-telemetry-runtime-profiles.test.ps1')
$deltaStart = $script:assertions
function New-DeltaProfile([string]$Mode, [string]$SchoolId = $school) {
    $value = [pscustomobject]@{ schemaVersion = 13; mode = $Mode }
    if ($Mode.EndsWith('-pilot')) { $value | Add-Member pilotSchoolId $SchoolId }
    if (-not $Mode.EndsWith('-off')) {
        $record = New-Validation
        foreach ($name in @('losslessDeltaBytesPreserved', 'staleBaseRecovery', 'teacherDeltaRecovery')) {
            $record.checks | Add-Member $name $true
        }
        $value | Add-Member localValidation $record
    }
    return $value
}
function Resolve-Delta($Source, [string]$Mode, [string]$SchoolId = $school) {
    $intent = ConvertTo-RuntimeConfiguration -Profile (New-DeltaProfile $Mode $SchoolId)
    $result = Resolve-SourcePreservingRuntimeConfiguration -RuntimeIntent $intent -SourceTaskDefinition (New-Task $Source) -ContainerName 'api'
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-Task $Source) -ContainerName 'api' -TargetRuntimeConfiguration $result
    return $result
}
$deltaPilot = Resolve-Delta $referenceGlobal 'screenshot-deltas-pilot'
$deltaControls = Get-RuntimeCapabilityControls -Environment (New-Task $deltaPilot).containerDefinitions[0].environment
Assert-Test ($deltaControls.scopedScreenshotDeltasV1.flag -ceq 'true' -and $deltaControls.scopedScreenshotDeltasV1.schoolIds[0] -ceq $school) 'Delta pilot must activate only its exact school.'
foreach ($capability in @($script:AllCapabilities | Where-Object { $_ -cne 'scopedScreenshotDeltasV1' })) {
    $before = (Get-RuntimeCapabilityControls -Environment (New-Task $referenceGlobal).containerDefinitions[0].environment)[$capability]
    Assert-Test ((Get-CanonicalJsonSha256 $before) -ceq (Get-CanonicalJsonSha256 $deltaControls[$capability])) 'Delta pilot must preserve every other control.'
}
$deltaGlobal = Resolve-Delta $deltaPilot 'screenshot-deltas-global-on'
Assert-Test ((Get-RuntimeCapabilityControls -Environment (New-Task $deltaGlobal).containerDefinitions[0].environment).scopedScreenshotDeltasV1.schoolIds.Count -eq 0) 'Global promotion clears only the child pilot scope.'
Assert-Rejected { Resolve-Test $deltaGlobal 'screenshot-references-off' } 'References cannot disable while deltas are active.'
Assert-Rejected { Resolve-Test $deltaGlobal 'device-telemetry-off' } 'Transport cannot disable while delta parents remain active.'
$deltaOff = Resolve-Delta $deltaGlobal 'screenshot-deltas-off'
$referencesAfter = Resolve-Test $deltaOff 'screenshot-references-off'
$null = Resolve-Test $referencesAfter 'device-telemetry-off'
Assert-Rejected { Resolve-Delta $referenceGlobal 'screenshot-deltas-global-on' } 'Delta activation must pass through a pilot.'
Assert-Rejected { Resolve-Delta $global 'screenshot-deltas-pilot' } 'Deltas require active image references.'
Assert-Rejected { Resolve-Delta $scopedTransport 'screenshot-deltas-pilot' $other } 'Delta scope cannot escape the reference/transport pilot.'
$scopedDelta = Resolve-Delta $scopedTransport 'screenshot-deltas-pilot'
Assert-Rejected { Resolve-Delta $scopedDelta 'screenshot-deltas-global-on' } 'Global deltas require global parents.'
foreach ($check in @('losslessDeltaBytesPreserved', 'staleBaseRecovery', 'teacherDeltaRecovery')) {
    $profile = New-DeltaProfile 'screenshot-deltas-pilot'
    $profile.localValidation.checks.$check = $false
    Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Every lossless delta compatibility check must pass.'
    $profile.localValidation.checks.PSObject.Properties.Remove($check)
    Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Delta validation cannot omit a check.'
}
$profile = New-DeltaProfile 'screenshot-deltas-pilot'; $profile.localValidation.capacityAccepted = $true
Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Local delta validation cannot establish AWS capacity.'
Assert-Rejected { Assert-TelemetryLocalValidationSource -Profile (New-DeltaProfile 'screenshot-deltas-pilot') -AppSha ('c' * 40) } 'Delta evidence must bind the exact backend image source.'
$profile = New-DeltaProfile 'screenshot-deltas-pilot'; $profile.schemaVersion = 12
Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Schema 12 must not accept the new delta modes.'
$profile = New-Profile 'device-telemetry-pilot'; $profile.schemaVersion = 13
Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Schema 13 is limited to delta modes.'
$known = @($script:AllCapabilities | Where-Object { $_ -cne 'scopedScreenshotDeltasV1' })
Assert-Rejected { Select-ServingRuntimeConfiguration -RuntimeConfiguration $deltaPilot -KnownCapabilities $known } 'Older serving sources cannot enable unknown deltas.'
$projected = Select-ServingRuntimeConfiguration -RuntimeConfiguration $deltaOff -KnownCapabilities $known
Assert-Test ($projected.ProjectedAbsentCapabilities -ccontains 'scopedScreenshotDeltasV1') 'Older source projection may omit only disabled deltas.'
Write-Output "Screenshot delta runtime: $($script:assertions - $deltaStart) assertions passed; no AWS provider invoked."
