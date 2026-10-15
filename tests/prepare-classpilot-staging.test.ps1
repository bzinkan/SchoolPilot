#requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows ACL tests require Windows.' }
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$preparer = Join-Path $repositoryRoot 'scripts/prepare-classpilot-staging.ps1'
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('schoolpilot-staging-preparer-test-' + [guid]::NewGuid().ToString('N'))
$junction = Join-Path $testRoot 'junction'
$passed = 0

function New-PrivateDirectory([string]$Name) {
  $path = Join-Path $testRoot $Name
  New-Item -ItemType Directory -Path $path | Out-Null
  $acl = Get-Acl -LiteralPath $path
  $acl.SetAccessRuleProtection($true, $false)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
  return $path
}

function Assert-Rejected([string]$Path, [string]$Pattern) {
  $failure = $null
  try { & $preparer -PrivateRoot $Path | Out-Null } catch { $failure = $_.Exception.Message }
  if (-not $failure -or $failure -notmatch $Pattern) { throw "Expected private staging path rejection: $Pattern" }
  if (Test-Path -LiteralPath (Join-Path $Path 'terraform-candidate')) { throw 'Rejected preparer created a workspace.' }
}

try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  Assert-Rejected $repositoryRoot 'outside the repository'; $passed++

  $inherited = Join-Path $testRoot 'inherited'
  New-Item -ItemType Directory -Path $inherited | Out-Null
  Assert-Rejected $inherited 'inherited access disabled'; $passed++

  $broad = New-PrivateDirectory 'broad'
  # Change only the DACL. Set-Acl's round trip can request SeSecurityPrivilege
  # for the audit section on otherwise unprivileged Windows hosts.
  & icacls.exe $broad /grant '*S-1-1-0:(RX)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not add the deliberately broad test access rule.' }
  Assert-Rejected $broad 'current user and SYSTEM'; $passed++

  $target = New-PrivateDirectory 'target'
  New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
  Assert-Rejected $junction 'reparse point'; $passed++
  Remove-Item -LiteralPath $junction -Force

  $existing = New-PrivateDirectory 'existing'
  Set-Content -LiteralPath (Join-Path $existing 'staging.tfstate') -Value 'synthetic state sentinel'
  Assert-Rejected $existing 'Refusing to reuse'; $passed++

  $valid = New-PrivateDirectory 'valid'
  $summary = (& $preparer -PrivateRoot $valid) | ConvertFrom-Json
  $receipt = Get-Content -LiteralPath (Join-Path $valid 'staging-workspace.json') -Raw | ConvertFrom-Json
  if ($summary.environment -ne 'staging' -or $summary.statePath -ne (Join-Path $valid 'staging.tfstate')) { throw 'Wrong explicit state binding.' }
  if ($summary.terraformRoot -ne $receipt.terraformRoot -or $receipt.sourceFiles.Count -lt 20) { throw 'Source copy receipt is incomplete.' }
  if ($receipt.sourceFiles.path -contains 'infra/terraform.tfstate' -or $receipt.sourceFiles.path -match '^infra/\.terraform/') { throw 'Production state/data entered source inventory.' }
  foreach ($required in @('src/config/databaseCapacity.json', 'src/config/rlsRegistry.json', 'infra/modules/cdn/spa-rewrite.js')) {
    if ($receipt.sourceFiles.path -notcontains $required) { throw 'A required isolated source input is absent.' }
  }
  if ((Test-Path -LiteralPath $summary.statePath) -or (Test-Path -LiteralPath (Join-Path $summary.terraformRoot 'terraform.tfstate'))) { throw 'Preparation must not create Terraform state.' }
  $copiedAcl = Get-Acl -LiteralPath (Join-Path $summary.terraformRoot 'main.tf')
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($rule in $copiedAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($currentSid, 'S-1-5-18')) { throw 'Copied input lost private ACL custody.' }
  }
  $passed++
  Write-Output "Staging preparer safety: $passed/6 passed"
} finally {
  if (Test-Path -LiteralPath $junction) { Remove-Item -LiteralPath $junction -Force }
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  if (-not $resolvedTestRoot.StartsWith($temporaryBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedTestRoot) -notlike 'schoolpilot-staging-preparer-test-*') { throw 'Refusing unsafe temporary cleanup.' }
  if (Test-Path -LiteralPath $resolvedTestRoot) { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force }
}
