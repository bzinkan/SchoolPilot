#requires -Version 7.5
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/deploy-classpilot-runtime-config.ps1')
$script:assertions = 0
function Assert-Test($Condition, [string]$Reason) {
    $script:assertions++
    if (-not $Condition) { throw $Reason }
}
function Assert-Rejected([scriptblock]$Action, [string]$Reason) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    Assert-Test $rejected $Reason
}
$school = '11111111-1111-7111-8111-111111111111'
$other = '22222222-2222-7222-8222-222222222222'
$app = 'a' * 40
$extension = 'b' * 40
function New-Validation {
    [pscustomobject]@{
        schemaVersion = 1; validationLevel = 'local_windows_correctness'; capacityAccepted = $false
        appSha = $app; extensionSha = $extension
        checks = [pscustomobject]@{
            httpWsParity = $true; lostReplyIdempotency = $true; staleBindingDenied = $true
            controlLaneIndependent = $true; realChromeMv3Passed = $true; captureCadenceAndPixelsPreserved = $true
        }
    }
}
function New-Profile([string]$Mode, [string]$SchoolId = $school) {
    $profile = [pscustomobject]@{ schemaVersion = 12; mode = $Mode }
    if ($Mode.EndsWith('-pilot')) { $profile | Add-Member pilotSchoolId $SchoolId }
    if (-not $Mode.EndsWith('-off')) { $profile | Add-Member localValidation (New-Validation) }
    return $profile
}
function New-Task($Runtime) {
    [pscustomobject]@{ containerDefinitions = @([pscustomobject]@{ name = 'api'; environment = @(
        $Runtime.Environment.GetEnumerator() | ForEach-Object { [pscustomobject]@{ name = $_.Key; value = $_.Value } }
    ) }) }
}
function Resolve-Test($Source, [string]$Mode, [string]$SchoolId = $school) {
    $intent = ConvertTo-RuntimeConfiguration -Profile (New-Profile $Mode $SchoolId)
    $resolved = Resolve-SourcePreservingRuntimeConfiguration -RuntimeIntent $intent -SourceTaskDefinition (New-Task $Source) -ContainerName 'api'
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-Task $Source) -ContainerName 'api' -TargetRuntimeConfiguration $resolved
    return $resolved
}
function Set-Control($Runtime, [string]$Capability, [string]$Flag, [string]$Mode, [string[]]$SchoolIds = @()) {
    $Runtime.Environment[$script:CapabilityFlags[$Capability]] = $Flag
    $entries = $Runtime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON | ConvertFrom-Json -AsHashtable
    $entries[$Capability] = @{ mode = $Mode }
    if ($SchoolIds.Count -gt 0) { $entries[$Capability].schoolIds = $SchoolIds }
    $Runtime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = $entries | ConvertTo-Json -Depth 10 -Compress
}
function Copy-Runtime($Runtime) { $Runtime | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable }

# The record below is synthetic test input, never a production validation receipt.
$base = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{ schemaVersion = 2; mode = 'tracking-window-global-on' })
$pilot = Resolve-Test $base 'device-telemetry-pilot'
Assert-Test ($pilot.PilotSchoolId -ceq $school) 'Telemetry pilot must retain its exact school.'
$controls = Get-RuntimeCapabilityControls -Environment (New-Task $pilot).containerDefinitions[0].environment
Assert-Test ($controls.deviceTelemetryTransportV1.flag -ceq 'true' -and $controls.deviceTelemetryTransportV1.schoolIds[0] -ceq $school) 'Pilot activates exactly one school.'
Assert-Test ($controls.scopedScreenshotReferencesV1.mode -ceq 'off') 'Transport pilot must preserve references off.'
Assert-TelemetryLocalValidationSource -Profile (New-Profile 'device-telemetry-pilot') -AppSha $app
Assert-Rejected { Assert-TelemetryLocalValidationSource -Profile (New-Profile 'device-telemetry-pilot') -AppSha ('c' * 40) } 'Validation must bind the planned backend source.'
$global = Resolve-Test $pilot 'device-telemetry-global-on'
$referencePilot = Resolve-Test $global 'screenshot-references-pilot'
$referenceGlobal = Resolve-Test $referencePilot 'screenshot-references-global-on'
$referenceOff = Resolve-Test $referenceGlobal 'screenshot-references-off'
$transportOff = Resolve-Test $referenceOff 'device-telemetry-off'
Assert-Test ((Get-RuntimeCapabilityControls -Environment (New-Task $transportOff).containerDefinitions[0].environment).deviceTelemetryTransportV1.mode -ceq 'off') 'Leaf-first disable must work without validation evidence.'
Assert-Rejected { Resolve-Test $referenceGlobal 'device-telemetry-off' } 'Transport cannot disable an active image-reference parent.'
Assert-Rejected { Resolve-Test $base 'device-telemetry-global-on' } 'Global activation must follow an active pilot.'
Assert-Rejected { Resolve-Test $pilot 'device-telemetry-pilot' } 'A pilot cannot silently replace an active scope.'
Assert-Rejected { Resolve-Test $base 'screenshot-references-pilot' } 'References require active transport.'
$scopedTransport = Resolve-Test $pilot 'screenshot-references-pilot'
Assert-Rejected { Resolve-Test $pilot 'screenshot-references-pilot' $other } 'References must stay inside transport scope.'
Assert-Rejected { Resolve-Test $scopedTransport 'screenshot-references-global-on' } 'A global child requires global parents.'
$scopedTracking = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{ schemaVersion = 2; mode = 'tracking-window-pilot'; pilotSchoolId = '11111111-1111-4111-8111-111111111111' })
Assert-Rejected { Resolve-Test $scopedTracking 'screenshot-references-pilot' } 'A child cannot escape tracking scope.'
foreach ($capability in @('deviceTelemetryTransportV1', 'scopedScreenshotReferencesV1')) {
    $broken = Copy-Runtime $referenceGlobal
    Set-Control $broken $capability 'false' 'on'
    Assert-Rejected { Get-RuntimeActivationState -Environment (New-Task $broken).containerDefinitions[0].environment } 'Flag and entry must match.'
    $broken = Copy-Runtime $referenceGlobal
    Set-Control $broken $capability 'true' 'on' @($school, $other)
    Assert-Rejected { Get-RuntimeActivationState -Environment (New-Task $broken).containerDefinitions[0].environment } 'Only one canonical pilot school is admitted.'
    foreach ($badScope in @('scalar', 'empty', 'null')) {
        $broken = Copy-Runtime $referenceGlobal
        $entries = $broken.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON | ConvertFrom-Json -AsHashtable
        $entries[$capability].schoolIds = switch ($badScope) { 'scalar' { $school }; 'empty' { ,@() }; 'null' { $null } }
        $broken.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = $entries | ConvertTo-Json -Depth 10 -Compress
        Assert-Rejected { Get-RuntimeActivationState -Environment (New-Task $broken).containerDefinitions[0].environment } 'A present school scope must be a one-element array.'
    }
}
$tamperedOff = Resolve-SourcePreservingRuntimeConfiguration -RuntimeIntent (ConvertTo-RuntimeConfiguration -Profile (New-Profile 'screenshot-references-off')) -SourceTaskDefinition (New-Task $referenceGlobal) -ContainerName 'api'
Set-Control $tamperedOff 'deviceTelemetryTransportV1' 'true' 'on' @($school)
Assert-Rejected { Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-Task $referenceGlobal) -ContainerName 'api' -TargetRuntimeConfiguration $tamperedOff } 'Off profiles must preserve every other capability.'
foreach ($field in @('appSha', 'extensionSha', 'checks')) {
    $profile = New-Profile 'device-telemetry-pilot'
    $profile.localValidation.PSObject.Properties.Remove($field)
    Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Validation must be complete.'
}
$profile = New-Profile 'device-telemetry-pilot'; $profile.localValidation.capacityAccepted = $true
Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Local evidence cannot assert capacity acceptance.'
$profile = New-Profile 'device-telemetry-pilot'; $profile.localValidation.checks.realChromeMv3Passed = $false
Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Every factual local compatibility check must pass.'
$profile = New-Profile 'device-telemetry-off'; $profile | Add-Member localValidation (New-Validation)
Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Off must not require or carry validation evidence.'
$profile = [pscustomobject]@{ schemaVersion = 1; mode = 'off'; localValidation = New-Validation }
Assert-Rejected { ConvertTo-RuntimeConfiguration -Profile $profile } 'Historical profiles cannot carry telemetry evidence.'
$oldCapabilities = @($script:AllCapabilities | Where-Object { $_ -cnotin @('deviceTelemetryTransportV1', 'scopedScreenshotReferencesV1') })
Assert-Rejected { Select-ServingRuntimeConfiguration -RuntimeConfiguration $pilot -KnownCapabilities $oldCapabilities } 'Older serving images must reject ON controls.'
$projectedOff = Select-ServingRuntimeConfiguration -RuntimeConfiguration $transportOff -KnownCapabilities $oldCapabilities
Assert-Test ($projectedOff.ProjectedAbsentCapabilities -ccontains 'deviceTelemetryTransportV1') 'Older image projection may remove only OFF controls.'
Write-Output "Telemetry runtime profiles: $script:assertions assertions passed; no AWS provider invoked."
