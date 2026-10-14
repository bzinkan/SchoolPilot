#requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PrivateRoot
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This preparer requires Windows ACL enforcement.' }

function Assert-NoReparseTraversal([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Staging source and destination paths must not traverse a reparse point.'
      }
    }
    $parent = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) { break }
    $cursor = $parent.FullName
  }
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not [IO.Path]::IsPathFullyQualified($PrivateRoot)) { throw 'PrivateRoot must be an absolute, private directory outside the repository.' }
if (-not (Test-Path -LiteralPath $PrivateRoot -PathType Container)) { throw 'Create and ACL-restrict PrivateRoot before preparing staging.' }
Assert-NoReparseTraversal $PrivateRoot
$privateDirectory = (Resolve-Path -LiteralPath $PrivateRoot).Path.TrimEnd('\', '/')
if ($privateDirectory.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $privateDirectory.StartsWith($repositoryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The staging workspace and state must be outside the repository.'
}
$acl = Get-Acl -LiteralPath $privateDirectory
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $acl.AreAccessRulesProtected -or
    $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentSid) {
  throw 'PrivateRoot must be current-user-owned with inherited access disabled.'
}
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $rule.IdentityReference.Value -notin @($currentSid, 'S-1-5-18')) {
    throw 'PrivateRoot may allow access only to the current user and SYSTEM.'
  }
}
$workspaceRoot = Join-Path $privateDirectory 'terraform-candidate'
$statePath = Join-Path $privateDirectory 'staging.tfstate'
$dataDirectory = Join-Path $privateDirectory 'terraform-data'
foreach ($target in @($workspaceRoot, $statePath, $dataDirectory, (Join-Path $privateDirectory 'staging-workspace.json'))) {
  if (Test-Path -LiteralPath $target) { throw "Refusing to reuse an existing workspace, state or Terraform data directory: $target" }
}

# Copy source inputs only. Never enumerate, parse, copy or initialize the
# repository's production .terraform or terraform.tfstate files.
$sourceFiles = @(& git -C $repositoryRoot ls-files --cached --others --exclude-standard -- infra)
if ($LASTEXITCODE -ne 0) { throw 'Could not inventory Terraform source files.' }
$allowedExtensions = @('.tf', '.tfvars', '.hcl', '.js', '.py', '.tftpl', '.sh')
$sourceFiles = @($sourceFiles | Where-Object {
  $allowedExtensions -contains [IO.Path]::GetExtension($_) -and $_ -notmatch '(^|/)\.terraform/'
}) + @('src/config/databaseCapacity.json', 'src/config/rlsRegistry.json')
$manifest = @()
foreach ($relativePath in $sourceFiles) {
  $sourcePath = Join-Path $repositoryRoot $relativePath
  Assert-NoReparseTraversal $sourcePath
  $destinationPath = Join-Path $workspaceRoot $relativePath
  New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
  $manifest += @{ path = $relativePath; sha256 = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$receipt = [ordered]@{
  version = 1
  environment = 'staging'
  terraformRoot = (Join-Path $workspaceRoot 'infra')
  dataDirectory = $dataDirectory
  statePath = $statePath
  bootstrapPlanPath = (Join-Path $privateDirectory 'staging-bootstrap.tfplan')
  sourceFiles = $manifest
}
$receiptPath = Join-Path $privateDirectory 'staging-workspace.json'
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding utf8
([pscustomobject]$receipt) | Select-Object version, environment, terraformRoot, dataDirectory, statePath, bootstrapPlanPath | ConvertTo-Json
