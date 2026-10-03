#requires -Version 7.5
[CmdletBinding()]
param(
  [ValidatePattern('^schoolpilot_redesign_usage_[a-z0-9_]+$')][string]$SchemaDatabase = 'schoolpilot_redesign_usage_20260930',
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
& (Join-Path $PSScriptRoot 'run-local-usage-scale.ps1') -SchemaDatabase $SchemaDatabase -OutputDirectory $OutputDirectory `
  -RlsInventory 'classpilotPrivateChatLifecyclePostExpand' -Profile 'cold-open-loop-ai'
exit $LASTEXITCODE
