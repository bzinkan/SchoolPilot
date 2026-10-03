#requires -Version 7.5
[CmdletBinding()]
param(
  [ValidatePattern('^schoolpilot_redesign_usage_[a-z0-9_]+$')][string]$SchemaDatabase = 'schoolpilot_redesign_usage_20260930',
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [ValidateSet('classpilotUsageRollupDaysPostExpand','passpilotAppointmentsPostExpand')][string]$RlsInventory = 'classpilotUsageRollupDaysPostExpand'
)
# Same generated fixture, quotas, guards and production deadlines; AI presence
# is a separate named scenario rather than a change to the original profile.
& (Join-Path $PSScriptRoot 'run-local-usage-scale.ps1') -SchemaDatabase $SchemaDatabase -OutputDirectory $OutputDirectory -RlsInventory $RlsInventory -Profile 'school-day-ai'
exit $LASTEXITCODE
