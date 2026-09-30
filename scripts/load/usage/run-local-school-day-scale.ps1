#requires -Version 7.5
[CmdletBinding()]
param(
  [ValidatePattern('^schoolpilot_redesign_usage_[a-z0-9_]+$')][string]$SchemaDatabase = 'schoolpilot_redesign_usage_20260930',
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
# Reuse the exact generated fixture, loopback, quota and cleanup guards. The
# separately named harness and immutable evidence describe this profile only.
& (Join-Path $PSScriptRoot 'run-local-usage-scale.ps1') -SchemaDatabase $SchemaDatabase -OutputDirectory $OutputDirectory -Profile 'school-day'
exit $LASTEXITCODE
