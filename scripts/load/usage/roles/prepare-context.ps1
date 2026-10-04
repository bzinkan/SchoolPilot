#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Repository,[Parameter(Mandatory)][string]$SourceSha,[Parameter(Mandatory)][string]$CandidateImageId,[Parameter(Mandatory)][string]$CandidateScanReceipt,[Parameter(Mandatory)][string]$HostFixtureDirectory,[Parameter(Mandatory)][string]$ContextDirectory)
$ErrorActionPreference='Stop'
node (Join-Path $PSScriptRoot 'create-context.mjs') $Repository $SourceSha $CandidateImageId $CandidateScanReceipt $HostFixtureDirectory $ContextDirectory
if ($LASTEXITCODE -ne 0) { throw 'Role context preparation failed; retained all partial files.' }
