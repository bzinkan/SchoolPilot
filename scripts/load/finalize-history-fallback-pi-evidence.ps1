#requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$RequestPath,
    [Parameter(Mandatory=$true)][string]$ExpectedRequestSha256,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [ValidateSet("Validate", "Collect")][string]$Mode = "Validate"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$modulePath = Join-Path $PSScriptRoot "history-fallback-pi-finalizer.psm1"
Import-Module $modulePath -Force

try {
    $result = if ($Mode -ceq "Validate") {
        Test-HistoryFallbackPiFinalizationRequest -RequestPath $RequestPath `
            -ExpectedRequestSha256 $ExpectedRequestSha256
    } else {
        Invoke-HistoryFallbackPiFinalization -RequestPath $RequestPath `
            -ExpectedRequestSha256 $ExpectedRequestSha256 -OutputPath $OutputPath
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 20 -Compress))
    if ($Mode -ceq "Collect" -and $result.passed -ne $true) { exit 2 }
}
catch {
    [Console]::Error.WriteLine("history_fallback_pi_finalization_failed")
    exit 1
}
