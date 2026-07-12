#requires -Version 7.0

[CmdletBinding()]
param(
    [switch]$Execute,

    [string]$TerraformDirectory,

    [string]$VerifiedDpapiBackupPath,

    [string]$VerifiedRecoveryBackupPath,

    [string]$RecoveryCredentialDpapiPath,

    [switch]$RetirePlaintextSecretSource,

    [string]$PlaintextSecretSourcePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$terraformRoot = if ([string]::IsNullOrWhiteSpace($TerraformDirectory)) {
    Join-Path $repositoryRoot "infra"
}
else {
    [System.IO.Path]::GetFullPath($TerraformDirectory)
}

$secretAddresses = @(
    "module.ecs.aws_ssm_parameter.database_url",
    "module.ecs.aws_ssm_parameter.session_secret",
    "module.ecs.aws_ssm_parameter.jwt_secret",
    "module.ecs.aws_ssm_parameter.student_token_secret",
    "module.ecs.aws_ssm_parameter.google_client_secret",
    "module.ecs.aws_ssm_parameter.google_oauth_encryption_key",
    "module.ecs.aws_ssm_parameter.sendgrid_api_key",
    "module.ecs.aws_ssm_parameter.stripe_secret_key",
    "module.ecs.aws_ssm_parameter.stripe_webhook_secret",
    "module.ecs.aws_ssm_parameter.openai_api_key"
)
$redisAddress = "module.ecs.aws_ssm_parameter.redis_url"

function Test-IsInsideRepository {
    param([Parameter(Mandatory = $true)][string]$Path)

    $relative = [System.IO.Path]::GetRelativePath(
        $repositoryRoot,
        [System.IO.Path]::GetFullPath($Path)
    )
    return $relative -eq "." -or (
        -not $relative.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)") -and
        -not [System.IO.Path]::IsPathRooted($relative)
    )
}

function Assert-VerifiedEncryptedBackup {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$ExpectedExtension
    )

    if (-not [System.IO.Path]::IsPathFullyQualified($Path)) {
        throw "$Name must be an absolute path outside the repository."
    }
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (Test-IsInsideRepository -Path $resolved) {
        throw "$Name must be outside the repository."
    }
    if (-not [System.IO.File]::Exists($resolved)) {
        throw "$Name does not exist."
    }
    if ([System.IO.Path]::GetExtension($resolved) -cne $ExpectedExtension) {
        throw "$Name must use the $ExpectedExtension encrypted-backup extension."
    }
    if ([DateTime]::UtcNow -gt [System.IO.File]::GetLastWriteTimeUtc($resolved).AddMinutes(30)) {
        throw "$Name must be a fresh backup created within the last 30 minutes."
    }
}

function Assert-OwnerSystemOnlyFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if (-not [System.IO.Path]::IsPathFullyQualified($Path)) {
        throw "$Name must be an absolute path outside the repository."
    }
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (Test-IsInsideRepository -Path $resolved) {
        throw "$Name must be outside the repository."
    }
    if (-not [System.IO.File]::Exists($resolved)) {
        throw "$Name does not exist."
    }
    if ((Get-Item -LiteralPath $resolved -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "$Name must not be a reparse point."
    }
    $acl = Get-Acl -LiteralPath $resolved
    if (-not $acl.AreAccessRulesProtected) {
        throw "$Name must disable inherited access."
    }
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new(
        [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
        $null
    ).Value
    foreach ($rule in $acl.Access) {
        $sid = $rule.IdentityReference.Translate(
            [System.Security.Principal.SecurityIdentifier]
        ).Value
        if (
            $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            $sid -notin @($currentSid, $systemSid)
        ) {
            throw "$Name must allow only the current user and SYSTEM."
        }
    }
    return $resolved
}

function Assert-OwnerSystemOnlyAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) {
        throw "$Name must disable inherited access."
    }
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new(
        [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
        $null
    ).Value
    foreach ($rule in $acl.Access) {
        $sid = $rule.IdentityReference.Translate(
            [System.Security.Principal.SecurityIdentifier]
        ).Value
        if (
            $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            $sid -notin @($currentSid, $systemSid)
        ) {
            throw "$Name must allow only the current user and SYSTEM."
        }
    }
}

function Assert-NoExistingReparsePoint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $cursor = [System.IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ([System.IO.File]::Exists($cursor) -or [System.IO.Directory]::Exists($cursor)) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "$Name must not traverse a reparse point."
            }
        }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Resolve-ReviewedPlaintextSecretSource {
    param([string]$RequestedPath)

    $expected = [System.IO.Path]::GetFullPath((Join-Path $terraformRoot "secrets.auto.tfvars"))
    $candidate = if ([string]::IsNullOrWhiteSpace($RequestedPath)) {
        $expected
    }
    else {
        [System.IO.Path]::GetFullPath($RequestedPath)
    }
    if (-not [string]::Equals($candidate, $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "PlaintextSecretSourcePath must be the exact secrets.auto.tfvars file in TerraformDirectory."
    }
    if (-not [System.IO.File]::Exists($candidate)) {
        return ""
    }
    Assert-NoExistingReparsePoint -Path $candidate -Name "PlaintextSecretSourcePath"
    Assert-OwnerSystemOnlyAcl -Path $candidate -Name "PlaintextSecretSourcePath"

    if (Test-IsInsideRepository -Path $candidate) {
        & git -C $repositoryRoot check-ignore --quiet -- "infra/secrets.auto.tfvars"
        if ($LASTEXITCODE -ne 0) {
            throw "The plaintext secret source must remain git-ignored before retirement."
        }
    }
    elseif ([string]::IsNullOrWhiteSpace($TerraformDirectory)) {
        throw "An outside-repository plaintext source is allowed only with an explicit TerraformDirectory."
    }

    return $candidate
}

function Remove-ReviewedPlaintextSecretSource {
    param([string]$ResolvedPath)

    if ([string]::IsNullOrWhiteSpace($ResolvedPath)) {
        return 0
    }
    [System.IO.File]::Delete($ResolvedPath)
    if ([System.IO.File]::Exists($ResolvedPath)) {
        throw "The plaintext secret source could not be retired."
    }
    return 1
}

function Assert-BackupsMatchCurrentState {
    param(
        [Parameter(Mandatory = $true)][string]$DpapiPath,
        [Parameter(Mandatory = $true)][string]$RecoveryPath,
        [Parameter(Mandatory = $true)][string]$RecoveryCredentialPath
    )

    $backupTool = Join-Path $repositoryRoot "scripts\terraform-state-backup.ps1"
    $statePath = Join-Path $terraformRoot "terraform.tfstate"
    if (-not [System.IO.File]::Exists($backupTool) -or -not [System.IO.File]::Exists($statePath)) {
        throw "The reviewed backup verifier or current Terraform state is missing."
    }

    $protectedPassphrase = [System.IO.File]::ReadAllText($RecoveryCredentialPath).Trim()
    $recoveryPassphrase = $null
    try {
        $recoveryPassphrase = ConvertTo-SecureString -String $protectedPassphrase
        $protectedPassphrase = $null
        & $backupTool -Mode Verify -StatePath $statePath -BackupPath $DpapiPath
        & $backupTool `
            -Mode Verify `
            -StatePath $statePath `
            -BackupPath $RecoveryPath `
            -RecoveryPassphrase $recoveryPassphrase
    }
    finally {
        $protectedPassphrase = $null
        if ($null -ne $recoveryPassphrase) {
            $recoveryPassphrase.Dispose()
        }
    }
}

function Invoke-TerraformCaptured {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $output = @(& terraform "-chdir=$terraformRoot" @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Terraform state detachment command failed without changing the live SSM parameters."
    }
    return @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
}

if (-not [System.IO.Directory]::Exists($terraformRoot)) {
    throw "TerraformDirectory does not exist."
}
if ($RetirePlaintextSecretSource -and -not $Execute) {
    throw "RetirePlaintextSecretSource is valid only with Execute after verified backups."
}

if ($Execute) {
    if (
        [string]::IsNullOrWhiteSpace($VerifiedDpapiBackupPath) -or
        [string]::IsNullOrWhiteSpace($VerifiedRecoveryBackupPath) -or
        [string]::IsNullOrWhiteSpace($RecoveryCredentialDpapiPath)
    ) {
        throw "Execute mode requires both verified encrypted state backup paths and the ACL-restricted DPAPI recovery credential."
    }
    Assert-VerifiedEncryptedBackup -Path $VerifiedDpapiBackupPath -Name "VerifiedDpapiBackupPath" -ExpectedExtension ".dpapi"
    Assert-VerifiedEncryptedBackup -Path $VerifiedRecoveryBackupPath -Name "VerifiedRecoveryBackupPath" -ExpectedExtension ".aesgcm"
    $recoveryCredential = Assert-OwnerSystemOnlyFile -Path $RecoveryCredentialDpapiPath -Name "RecoveryCredentialDpapiPath"
    Assert-BackupsMatchCurrentState `
        -DpapiPath ([System.IO.Path]::GetFullPath($VerifiedDpapiBackupPath)) `
        -RecoveryPath ([System.IO.Path]::GetFullPath($VerifiedRecoveryBackupPath)) `
        -RecoveryCredentialPath $recoveryCredential
}

$reviewedPlaintextSecretSource = ""
if ($RetirePlaintextSecretSource) {
    $reviewedPlaintextSecretSource = Resolve-ReviewedPlaintextSecretSource `
        -RequestedPath $PlaintextSecretSourcePath
}

$before = Invoke-TerraformCaptured -Arguments @("state", "list")
$trackedSecrets = @($secretAddresses | Where-Object { $before -contains $_ })
$redisWasTracked = $before -contains $redisAddress

if ($trackedSecrets.Count -gt 0) {
    $dryRunArguments = @(
        "state",
        "rm",
        "-dry-run",
        "-lock-timeout=5m"
    ) + $trackedSecrets
    $dryRun = Invoke-TerraformCaptured -Arguments $dryRunArguments

    foreach ($address in $trackedSecrets) {
        if (-not ($dryRun | Where-Object { $_ -match [regex]::Escape($address) })) {
            throw "Terraform dry-run did not confirm every expected state address."
        }
    }
}

if (-not $Execute) {
    [pscustomobject]@{
        status          = "dry_run"
        candidates      = $secretAddresses.Count
        tracked         = $trackedSecrets.Count
        wouldDetach     = $trackedSecrets.Count
        redisStillOwned = $redisWasTracked
    } | ConvertTo-Json -Compress
    exit 0
}

if ($trackedSecrets.Count -gt 0) {
    # Existing verified encrypted backups are mandatory above. Sending Terraform's
    # automatic plaintext backup to the OS null device prevents a new cleartext
    # state copy from being left on disk during this address-only rewrite.
    $backupSink = if ($IsWindows) { "NUL" } else { "/dev/null" }
    $detachArguments = @(
        "state",
        "rm",
        "-lock-timeout=5m",
        "-backup=$backupSink"
    ) + $trackedSecrets
    $null = Invoke-TerraformCaptured -Arguments $detachArguments
}

$after = Invoke-TerraformCaptured -Arguments @("state", "list")
$remaining = @($secretAddresses | Where-Object { $after -contains $_ })
if ($remaining.Count -ne 0) {
    throw "One or more application-secret state bindings remain after detachment."
}
if ($redisWasTracked -and -not ($after -contains $redisAddress)) {
    throw "REDIS_URL unexpectedly left Terraform state during secret detachment."
}

$plaintextBackupsRemoved = 0
$legacyBackupPath = [System.IO.Path]::GetFullPath((Join-Path $terraformRoot "terraform.tfstate.backup"))
if ([System.IO.File]::Exists($legacyBackupPath)) {
    $expectedParent = [System.IO.Path]::GetFullPath($terraformRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $actualParent = [System.IO.Path]::GetDirectoryName($legacyBackupPath).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if (
        -not [string]::Equals($actualParent, $expectedParent, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($legacyBackupPath) -cne "terraform.tfstate.backup"
    ) {
        throw "Refusing to remove a plaintext backup outside the intended Terraform workspace."
    }
    Remove-Item -LiteralPath $legacyBackupPath -Force
    if ([System.IO.File]::Exists($legacyBackupPath)) {
        throw "The legacy plaintext Terraform backup could not be removed."
    }
    $plaintextBackupsRemoved = 1
}

$plaintextSecretSourceRemoved = 0
if ($RetirePlaintextSecretSource) {
    $plaintextSecretSourceRemoved = Remove-ReviewedPlaintextSecretSource `
        -ResolvedPath $reviewedPlaintextSecretSource
}

[pscustomobject]@{
    status          = "detached"
    candidates      = $secretAddresses.Count
    previouslyOwned = $trackedSecrets.Count
    detached        = $trackedSecrets.Count
    remaining       = $remaining.Count
    redisStillOwned = $after -contains $redisAddress
    plaintextBackupsRemoved = $plaintextBackupsRemoved
    plaintextSecretSourceRemoved = $plaintextSecretSourceRemoved
} | ConvertTo-Json -Compress
