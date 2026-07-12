#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Plan", "Validate", "Apply", "Rollback")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [ValidateSet(
        "google",
        "sendgrid",
        "stripe-api",
        "stripe-webhook",
        "openai",
        "session",
        "jwt",
        "student",
        "database",
        "pin-key"
    )]
    [string]$Phase,

    [string]$Environment = "production",
    [string]$Project = "schoolpilot",
    [string]$Region = "us-east-1",
    [string]$RepositoryRoot = (Join-Path $PSScriptRoot "..\.."),
    [string]$WorkDirectory,
    [string]$PlanPath,
    [string]$GateEvidencePath,
    [securestring]$NewSecret,
    [securestring]$NewSecretConfirmation,
    [switch]$Generate,
    [switch]$ConfirmProduction,
    [switch]$ProviderOverlapConfirmed,
    [switch]$ProviderOldCredentialStillEnabled,
    [switch]$AllowDisruptiveInternalRotation,
    [int]$PlanMaxAgeMinutes = 240
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$script:TestModeSentinel = "I_UNDERSTAND_CREDENTIAL_ROTATION_TEST_ONLY"
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:Utf8Bom = [System.Text.UTF8Encoding]::new($true)
$script:MutationStarted = $false

function Get-RotationPhaseCatalog {
    return [ordered]@{
        "google" = [ordered]@{
            terraformResourceName = "google_client_secret"
            parameterSuffix = "GOOGLE_CLIENT_SECRET"
            runtimeSecretName = "GOOGLE_CLIENT_SECRET"
            category = "provider"
            generated = $false
            applySupported = $true
            minimumLength = 12
            validationPattern = '^[A-Za-z0-9_-]+$'
            logErrors = @("invalid_client", "Google token exchange failed")
        }
        "sendgrid" = [ordered]@{
            terraformResourceName = "sendgrid_api_key"
            parameterSuffix = "SENDGRID_API_KEY"
            runtimeSecretName = "SENDGRID_API_KEY"
            category = "provider"
            generated = $false
            applySupported = $true
            minimumLength = 24
            validationPattern = '^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
            logErrors = @("SendGrid error", "email_failure")
        }
        "stripe-api" = [ordered]@{
            terraformResourceName = "stripe_secret_key"
            parameterSuffix = "STRIPE_SECRET_KEY"
            runtimeSecretName = "STRIPE_SECRET_KEY"
            category = "provider"
            generated = $false
            applySupported = $true
            minimumLength = 20
            validationPattern = '^sk_live_[A-Za-z0-9_]+$'
            logErrors = @("Stripe API", "Invalid API Key")
        }
        "stripe-webhook" = [ordered]@{
            terraformResourceName = "stripe_webhook_secret"
            parameterSuffix = "STRIPE_WEBHOOK_SECRET"
            runtimeSecretName = "STRIPE_WEBHOOK_SECRET"
            category = "provider"
            generated = $false
            applySupported = $true
            minimumLength = 20
            validationPattern = '^whsec_[A-Za-z0-9_]+$'
            logErrors = @("Webhook signature verification failed")
        }
        "openai" = [ordered]@{
            terraformResourceName = "openai_api_key"
            parameterSuffix = "OPENAI_API_KEY"
            runtimeSecretName = "OPENAI_API_KEY"
            category = "unused-provider"
            generated = $false
            applySupported = $false
            blockReason = "No OpenAI runtime consumer is present; revoke and remove this unused credential through a reviewed infrastructure change instead of rotating it."
            minimumLength = 20
            validationPattern = '^sk-[A-Za-z0-9_-]+$'
            logErrors = @("OpenAI API")
        }
        "session" = [ordered]@{
            terraformResourceName = "session_secret"
            parameterSuffix = "SESSION_SECRET"
            runtimeSecretName = "SESSION_SECRET"
            category = "disruptive-internal"
            generated = $true
            applySupported = $false
            blockReason = "SESSION_SECRET cannot be safely changed by a rolling ECS deployment; generic Apply remains blocked until a tested traffic-free scale-to-zero or dual-read cutover exists."
            minimumLength = 43
            generationBytes = 48
            validationPattern = '^[A-Za-z0-9_-]+$'
            logErrors = @("session signature", "invalid session")
        }
        "jwt" = [ordered]@{
            terraformResourceName = "jwt_secret"
            parameterSuffix = "JWT_SECRET"
            runtimeSecretName = "JWT_SECRET"
            category = "disruptive-internal"
            generated = $true
            applySupported = $false
            blockReason = "JWT_SECRET cannot be safely changed by a rolling ECS deployment; generic Apply remains blocked until a tested traffic-free scale-to-zero or dual-read cutover exists."
            minimumLength = 43
            generationBytes = 48
            validationPattern = '^[A-Za-z0-9_-]+$'
            logErrors = @("invalid token", "jwt malformed")
        }
        "student" = [ordered]@{
            terraformResourceName = "student_token_secret"
            parameterSuffix = "STUDENT_TOKEN_SECRET"
            runtimeSecretName = "STUDENT_TOKEN_SECRET"
            category = "student-hard-gate"
            generated = $true
            applySupported = $false
            blockReason = "Student-token rotation requires a specialized cutover that refreshes all synthetic and managed-Chromebook registrations after the new signer is active; generic Apply is blocked."
            minimumLength = 43
            generationBytes = 48
            validationPattern = '^[A-Za-z0-9_-]+$'
            logErrors = @("Invalid device token", "device authentication failed")
        }
        "database" = [ordered]@{
            terraformResourceName = "database_url"
            parameterSuffix = "DATABASE_URL"
            runtimeSecretName = "DATABASE_URL"
            category = "database-cutover"
            generated = $false
            applySupported = $false
            blockReason = "DATABASE_URL requires a coordinated RDS password/connection cutover and is intentionally plan/validate-only in this generic tool."
            minimumLength = 20
            validationPattern = '^postgres(?:ql)?://'
            logErrors = @("database_connectivity", "pool error")
        }
        "pin-key" = [ordered]@{
            terraformResourceName = "google_oauth_encryption_key"
            parameterSuffix = "GOOGLE_OAUTH_ENCRYPTION_KEY"
            runtimeSecretName = "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY"
            category = "pin-migration"
            generated = $true
            applySupported = $false
            blockReason = "PIN-key rotation requires the staged previous-key parameter, dual-read deployment, database migration, idempotency pass, and cleanup workflow; this generic tool is plan/validate-only for that phase."
            minimumLength = 43
            generationBytes = 32
            validationPattern = '^[A-Za-z0-9_-]{43}$'
            logErrors = @("Invalid encrypted secret", "Failed to decrypt")
        }
    }
}

function Get-RotationPhaseConfiguration {
    param([Parameter(Mandatory = $true)][string]$Name)
    $catalog = Get-RotationPhaseCatalog
    if (-not $catalog.Contains($Name)) {
        throw "Unsupported credential-rotation phase."
    }
    return $catalog[$Name]
}

function Test-IsPathWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    $parentBase = [System.IO.Path]::GetFullPath($Parent).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $candidateBase = $candidateFull.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if ([string]::Equals($candidateBase, $parentBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    $parentPrefix = $parentBase + [System.IO.Path]::DirectorySeparatorChar
    return $candidateFull.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePointInExistingPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $current = [System.IO.Path]::GetFullPath($Path)
    while ($current -and -not [System.IO.Directory]::Exists($current) -and -not [System.IO.File]::Exists($current)) {
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
    while ($current -and ([System.IO.Directory]::Exists($current) -or [System.IO.File]::Exists($current))) {
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Credential-rotation paths must not traverse a reparse point."
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Set-OwnerOnlyAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Directory
    )
    if (-not $IsWindows) {
        throw "The production credential-rotation tool requires Windows ACL support."
    }
    try {
        Assert-OwnerOnlyAcl -Path $Path
        return
    }
    catch {
        # A newly created or inherited path is tightened below. Avoid rewriting
        # an already-correct ACL because Windows can require SeSecurityPrivilege
        # when redundantly replacing protected descriptors.
    }

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $ownerSid = $identity.User
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new(
        [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
        $null
    )
    if ($Directory) {
        $security = [System.Security.AccessControl.DirectorySecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        $propagation = [System.Security.AccessControl.PropagationFlags]::None
    }
    else {
        $security = [System.Security.AccessControl.FileSecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
        $propagation = [System.Security.AccessControl.PropagationFlags]::None
    }
    $security.SetOwner($ownerSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($ownerSid, $systemSid)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            $propagation,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $security
}

function Assert-OwnerOnlyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $allowed = @(
        $identity.User.Value,
        [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
            $null
        ).Value
    )
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) {
        throw "Credential-rotation working paths must disable inherited access."
    }
    foreach ($rule in $acl.Access) {
        if (
            $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed
        ) {
            throw "Credential-rotation working paths must be limited to the operator and SYSTEM."
        }
    }
}

function Initialize-SecureWorkDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )
    $full = [System.IO.Path]::GetFullPath($Path)
    if (Test-IsPathWithin -Candidate $full -Parent $RepoRoot) {
        throw "Credential-rotation evidence and rollback material must stay outside the repository."
    }
    Assert-NoReparsePointInExistingPath -Path $full
    [void][System.IO.Directory]::CreateDirectory($full)
    Set-OwnerOnlyAcl -Path $full -Directory
    Assert-OwnerOnlyAcl -Path $full
    return $full
}

function Get-Sha256HexFromBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    return [System.Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData($Bytes)
    ).ToLowerInvariant()
}

function Invoke-WithSecureStringPlaintext {
    param(
        [Parameter(Mandatory = $true)][securestring]$Value,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )
    $pointer = [System.IntPtr]::Zero
    try {
        $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        $plaintext = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        return & $Action $plaintext
    }
    finally {
        $plaintext = $null
        if ($pointer -ne [System.IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Get-SecureStringHash {
    param([Parameter(Mandatory = $true)][securestring]$Value)
    return Invoke-WithSecureStringPlaintext -Value $Value -Action {
        param([string]$Plaintext)
        $bytes = $null
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($Plaintext)
            return Get-Sha256HexFromBytes -Bytes $bytes
        }
        finally {
            if ($null -ne $bytes) {
                [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($bytes)
            }
        }
    }
}

function Test-SecureStringsEqual {
    param(
        [Parameter(Mandatory = $true)][securestring]$Left,
        [Parameter(Mandatory = $true)][securestring]$Right
    )
    $leftHash = [System.Convert]::FromHexString((Get-SecureStringHash -Value $Left))
    $rightHash = [System.Convert]::FromHexString((Get-SecureStringHash -Value $Right))
    try {
        return [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($leftHash, $rightHash)
    }
    finally {
        [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($leftHash)
        [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($rightHash)
    }
}

function New-GeneratedCredentialSecret {
    param([int]$ByteCount = 48)
    $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes($ByteCount)
    try {
        $plaintext = [System.Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
        try {
            return ConvertTo-SecureString -String $plaintext -AsPlainText -Force
        }
        finally {
            $plaintext = $null
        }
    }
    finally {
        [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($bytes)
    }
}

function Remove-SensitiveFile {
    param([string]$Path)
    if (-not $Path -or -not [System.IO.File]::Exists($Path)) { return }
    try {
        $length = (Get-Item -LiteralPath $Path).Length
        $stream = [System.IO.FileStream]::new(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $zeroBuffer = [byte[]]::new(4096)
            $remaining = $length
            while ($remaining -gt 0) {
                $count = [int][Math]::Min($zeroBuffer.Length, $remaining)
                $stream.Write($zeroBuffer, 0, $count)
                $remaining -= $count
            }
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
    }
    catch {
        # Deletion is still attempted. The ACL-restricted directory is the primary boundary.
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Protect-RollbackSecret {
    param(
        [Parameter(Mandatory = $true)][securestring]$Value,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$EntropyText
    )
    if (-not $IsWindows) { throw "DPAPI rollback protection requires Windows." }
    [byte[]]$protected = @(Invoke-WithSecureStringPlaintext -Value $Value -Action {
        param([string]$Plaintext)
        $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($Plaintext)
        $entropy = [System.Text.Encoding]::UTF8.GetBytes($EntropyText)
        try {
            return [System.Security.Cryptography.ProtectedData]::Protect(
                $plainBytes,
                $entropy,
                [System.Security.Cryptography.DataProtectionScope]::CurrentUser
            )
        }
        finally {
            [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($plainBytes)
            [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($entropy)
        }
    })
    try {
        [System.IO.File]::WriteAllBytes($Path, $protected)
        Set-OwnerOnlyAcl -Path $Path
    }
    finally {
        [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($protected)
    }
}

function Unprotect-RollbackSecret {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$EntropyText
    )
    if (-not $IsWindows) { throw "DPAPI rollback protection requires Windows." }
    Assert-OwnerOnlyAcl -Path $Path
    $protected = [System.IO.File]::ReadAllBytes($Path)
    $entropy = [System.Text.Encoding]::UTF8.GetBytes($EntropyText)
    $plainBytes = $null
    try {
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $protected,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $plaintext = [System.Text.Encoding]::UTF8.GetString($plainBytes)
        try {
            return ConvertTo-SecureString -String $plaintext -AsPlainText -Force
        }
        finally {
            $plaintext = $null
        }
    }
    finally {
        [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($protected)
        [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($entropy)
        if ($null -ne $plainBytes) {
            [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($plainBytes)
        }
    }
}

function Invoke-ExternalCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string[]]$Arguments = @(),
        [int[]]$AllowedExitCodes = @(0),
        [ValidateRange(1, 3600)][int]$TimeoutSeconds = 300
    )
    $testHandler = Get-Variable -Name SchoolPilotCredentialRotationTestHandler -Scope Global -ErrorAction SilentlyContinue
    if (
        $env:SCHOOLPILOT_CREDENTIAL_ROTATION_TEST_MODE -eq $script:TestModeSentinel -and
        $null -ne $testHandler
    ) {
        $result = & $testHandler.Value $Command $Arguments
        if ($result.PSObject.Properties.Name -contains "TimedOut" -and $result.TimedOut -eq $true) {
            throw "A mocked external credential-rotation command timed out."
        }
        if ([int]$result.ExitCode -notin $AllowedExitCodes) {
            throw "A mocked external credential-rotation command failed."
        }
        return [string]$result.StdOut
    }

    $resolved = Get-Command $Command -ErrorAction Stop
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolved.Source
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add([string]$argument)
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "The external credential-rotation command could not start."
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill($true) } catch { }
            try { $process.WaitForExit(10000) | Out-Null } catch { }
            throw "An external credential-rotation command exceeded its bounded timeout."
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -notin $AllowedExitCodes) {
            throw "An external credential-rotation command failed with exit code $($process.ExitCode)."
        }
        return $stdout
    }
    finally {
        $process.Dispose()
    }
}

function Invoke-AwsJson {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [ValidateRange(1, 3600)][int]$TimeoutSeconds = 120
    )
    $stdout = Invoke-ExternalCommand -Command "aws" -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds
    try {
        return $stdout | ConvertFrom-Json -Depth 40
    }
    catch {
        throw "AWS returned an invalid sanitized JSON response."
    }
    finally {
        $stdout = $null
    }
}

function Get-SsmParameterSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$ParameterName,
        [Parameter(Mandatory = $true)][string]$AwsRegion,
        [switch]$IncludeSecureValue
    )
    $encryptedResponse = Invoke-AwsJson -Arguments @(
        "ssm", "get-parameter",
        "--name", $ParameterName,
        "--no-with-decryption",
        "--region", $AwsRegion,
        "--output", "json"
    )
    $decryptedResponse = Invoke-AwsJson -Arguments @(
        "ssm", "get-parameter",
        "--name", $ParameterName,
        "--with-decryption",
        "--region", $AwsRegion,
        "--output", "json"
    )
    $metadataResponse = Invoke-AwsJson -Arguments @(
        "ssm", "describe-parameters",
        "--parameter-filters", "Key=Name,Option=Equals,Values=$ParameterName",
        "--region", $AwsRegion,
        "--output", "json"
    )
    if (
        $null -eq $encryptedResponse.Parameter -or
        $null -eq $decryptedResponse.Parameter -or
        [string]$encryptedResponse.Parameter.Name -cne $ParameterName -or
        [string]$decryptedResponse.Parameter.Name -cne $ParameterName -or
        [string]$encryptedResponse.Parameter.Type -cne "SecureString" -or
        [string]$decryptedResponse.Parameter.Type -cne "SecureString" -or
        [int64]$encryptedResponse.Parameter.Version -lt 1 -or
        [int64]$decryptedResponse.Parameter.Version -ne [int64]$encryptedResponse.Parameter.Version
    ) {
        throw "The selected SSM parameter is missing or is not a versioned SecureString."
    }
    $metadata = @($metadataResponse.Parameters)
    if (
        $metadata.Count -ne 1 -or
        [string]$metadata[0].Name -cne $ParameterName -or
        [string]$metadata[0].Type -cne "SecureString" -or
        [int64]$metadata[0].Version -ne [int64]$encryptedResponse.Parameter.Version
    ) {
        throw "The selected SSM parameter metadata/version gate is inconsistent."
    }
    $cipherBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$encryptedResponse.Parameter.Value)
    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$decryptedResponse.Parameter.Value)
    $secureValue = $null
    try {
        if ($IncludeSecureValue) {
            $secureValue = ConvertTo-SecureString -String ([string]$decryptedResponse.Parameter.Value) -AsPlainText -Force
        }
        return [pscustomobject]@{
            Name = [string]$encryptedResponse.Parameter.Name
            Version = [int64]$encryptedResponse.Parameter.Version
            CiphertextHash = Get-Sha256HexFromBytes -Bytes $cipherBytes
            PlaintextHash = Get-Sha256HexFromBytes -Bytes $plainBytes
            KeyId = [string]$metadata[0].KeyId
            Tier = if ($metadata[0].Tier) { [string]$metadata[0].Tier } else { "Standard" }
            DataType = if ($metadata[0].DataType) { [string]$metadata[0].DataType } else { "text" }
            SecureValue = $secureValue
        }
    }
    finally {
        [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($cipherBytes)
        [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($plainBytes)
        if ($null -ne $decryptedResponse -and $null -ne $decryptedResponse.Parameter) {
            $decryptedResponse.Parameter.Value = $null
        }
        if ($null -ne $encryptedResponse -and $null -ne $encryptedResponse.Parameter) {
            $encryptedResponse.Parameter.Value = $null
        }
        $decryptedResponse = $null
        $encryptedResponse = $null
    }
}

function Assert-SsmSnapshotMatches {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual
    )
    if (
        [string]$Expected.Name -cne [string]$Actual.Name -or
        [int64]$Expected.Version -ne [int64]$Actual.Version -or
        [string]$Expected.CiphertextHash -cne [string]$Actual.CiphertextHash -or
        [string]$Expected.PlaintextHash -cne [string]$Actual.PlaintextHash -or
        [string]$Expected.KeyId -cne [string]$Actual.KeyId -or
        [string]$Expected.Tier -cne [string]$Actual.Tier -or
        [string]$Expected.DataType -cne [string]$Actual.DataType
    ) {
        throw "The SSM expected-version/ciphertext-hash gate changed; create a fresh rotation plan."
    }
}

function ConvertTo-SsmSnapshotRecord {
    param([Parameter(Mandatory = $true)]$Snapshot)
    return [pscustomobject][ordered]@{
        Name = [string]$Snapshot.Name
        Version = [int64]$Snapshot.Version
        CiphertextHash = [string]$Snapshot.CiphertextHash
        PlaintextHash = [string]$Snapshot.PlaintextHash
        KeyId = [string]$Snapshot.KeyId
        Tier = [string]$Snapshot.Tier
        DataType = [string]$Snapshot.DataType
    }
}

function Test-SsmSnapshotMatches {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual
    )
    try {
        Assert-SsmSnapshotMatches -Expected $Expected -Actual $Actual
        return $true
    }
    catch { return $false }
}

function Get-SsmMutationDisposition {
    param(
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$Current,
        [Parameter(Mandatory = $true)][string]$DesiredPlaintextHash
    )
    if (Test-SsmSnapshotMatches -Expected $Before -Actual $Current) {
        return "unchanged"
    }
    if (
        [string]$Current.Name -ceq [string]$Before.Name -and
        [int64]$Current.Version -eq ([int64]$Before.Version + 1) -and
        [string]$Current.CiphertextHash -cne [string]$Before.CiphertextHash -and
        [string]$Current.PlaintextHash -ceq $DesiredPlaintextHash -and
        [string]$Current.KeyId -ceq [string]$Before.KeyId -and
        [string]$Current.Tier -ceq [string]$Before.Tier -and
        [string]$Current.DataType -ceq [string]$Before.DataType
    ) {
        return "intended"
    }
    return "indeterminate"
}

function Get-StripeAccountId {
    param([Parameter(Mandatory = $true)][securestring]$ApiKey)
    $testHandler = Get-Variable -Name SchoolPilotStripeIdentityTestHandler -Scope Global -ErrorAction SilentlyContinue
    if (
        $env:SCHOOLPILOT_CREDENTIAL_ROTATION_TEST_MODE -eq $script:TestModeSentinel -and
        $null -ne $testHandler
    ) {
        $accountId = [string](& $testHandler.Value)
    }
    else {
        $accountId = Invoke-WithSecureStringPlaintext -Value $ApiKey -Action {
            param([string]$Plaintext)
            $client = [System.Net.Http.HttpClient]::new()
            $client.Timeout = [TimeSpan]::FromSeconds(30)
            $request = [System.Net.Http.HttpRequestMessage]::new(
                [System.Net.Http.HttpMethod]::Get,
                "https://api.stripe.com/v1/account"
            )
            try {
                $basicBytes = [System.Text.Encoding]::UTF8.GetBytes($Plaintext + ":")
                try {
                    $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new(
                        "Basic",
                        [System.Convert]::ToBase64String($basicBytes)
                    )
                }
                finally {
                    [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($basicBytes)
                }
                $response = $client.Send($request)
                try {
                    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                    if ([int]$response.StatusCode -ne 200) {
                        $body = $null
                        throw "Stripe rejected the read-only account identity check."
                    }
                    try {
                        $payload = $body | ConvertFrom-Json -Depth 10
                        return [string]$payload.id
                    }
                    finally {
                        $body = $null
                        $payload = $null
                    }
                }
                finally { $response.Dispose() }
            }
            finally {
                $request.Dispose()
                $client.Dispose()
            }
        }
    }
    if ($accountId -notmatch '^acct_[A-Za-z0-9]+$') {
        throw "Stripe returned an invalid account identity."
    }
    return $accountId
}

function Get-StripePlanAccountId {
    param(
        [Parameter(Mandatory = $true)][string]$PhaseName,
        [Parameter(Mandatory = $true)]$SelectedSsmSnapshot,
        [Parameter(Mandatory = $true)][string]$ProjectName,
        [Parameter(Mandatory = $true)][string]$EnvironmentName,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    if ($PhaseName -ceq "stripe-api") {
        if ($null -eq $SelectedSsmSnapshot.SecureValue) {
            throw "Stripe identity validation requires an in-memory selected SecureString."
        }
        return Get-StripeAccountId -ApiKey $SelectedSsmSnapshot.SecureValue
    }
    if ($PhaseName -ceq "stripe-webhook") {
        $apiSnapshot = Get-SsmParameterSnapshot `
            -ParameterName "/$ProjectName/$EnvironmentName/STRIPE_SECRET_KEY" `
            -AwsRegion $AwsRegion `
            -IncludeSecureValue
        try { return Get-StripeAccountId -ApiKey $apiSnapshot.SecureValue }
        finally { if ($null -ne $apiSnapshot.SecureValue) { $apiSnapshot.SecureValue.Dispose() } }
    }
    return ""
}

function Assert-StripeReplacementIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$PhaseName,
        [Parameter(Mandatory = $true)][string]$PriorAccountId,
        [securestring]$Replacement,
        [string]$EvidencePath,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Manifest
    )
    if ($PhaseName -ceq "stripe-webhook") {
        if (-not $EvidencePath) {
            throw "Stripe webhook rotation requires private exact target-account evidence."
        }
        $evidence = Read-GateEvidence -Path $EvidencePath -ExpectedPhase $PhaseName -RepoRoot $RepoRoot -Manifest $Manifest
        if (
            [string]$evidence.oldAccountId -cne $PriorAccountId -or
            [string]$evidence.targetAccountId -cne $PriorAccountId -or
            $evidence.checks.webhookRecreationReady -ne $true -or
            $evidence.checks.endpointOwnershipReviewed -ne $true
        ) {
            throw "Stripe webhook target-account evidence failed closed."
        }
        return $PriorAccountId
    }

    if ($PhaseName -cne "stripe-api") { return "" }
    if ($null -eq $Replacement) { throw "Stripe API replacement identity requires the hidden replacement key." }
    $newAccountId = Get-StripeAccountId -ApiKey $Replacement
    if ($newAccountId -ceq $PriorAccountId) { return $newAccountId }
    if (-not $EvidencePath) {
        throw "Cross-account Stripe replacement requires private migration evidence."
    }
    $evidence = Read-GateEvidence -Path $EvidencePath -ExpectedPhase $PhaseName -RepoRoot $RepoRoot -Manifest $Manifest
    if (
        [string]$evidence.oldAccountId -cne $PriorAccountId -or
        [string]$evidence.newAccountId -cne $newAccountId -or
        [int]$evidence.checks.activeSubscriptions -ne 0 -or
        [int]$evidence.checks.unresolvedProductionDbStripeReferences -ne 0 -or
        $evidence.checks.targetChargesReady -ne $true -or
        $evidence.checks.targetPayoutsReady -ne $true -or
        $evidence.checks.targetBusinessReady -ne $true -or
        $evidence.checks.old42DispositionConfirmed -ne $true -or
        $evidence.checks.webhookRecreationReady -ne $true -or
        $evidence.checks.webhookRecreationReviewed -ne $true -or
        $evidence.checks.reviewed -ne $true
    ) {
        throw "Cross-account Stripe migration evidence failed closed."
    }
    return $newAccountId
}

function Get-ServiceSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$Cluster,
        [Parameter(Mandatory = $true)][string]$ApiService,
        [Parameter(Mandatory = $true)][string]$WorkerService,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    $response = Invoke-AwsJson -Arguments @(
        "ecs", "describe-services",
        "--cluster", $Cluster,
        "--services", $ApiService, $WorkerService,
        "--region", $AwsRegion,
        "--output", "json"
    )
    if (@($response.failures).Count -gt 0 -or @($response.services).Count -ne 2) {
        throw "The production API/worker service snapshot is incomplete."
    }
    $api = @($response.services | Where-Object serviceName -CEQ $ApiService)
    $worker = @($response.services | Where-Object serviceName -CEQ $WorkerService)
    if ($api.Count -ne 1 -or $worker.Count -ne 1) {
        throw "The production API/worker service names did not match exactly."
    }
    foreach ($entry in @($api[0], $worker[0])) {
        $deployments = @($entry.deployments)
        if (
            [int]$entry.desiredCount -lt 1 -or
            [int]$entry.runningCount -ne [int]$entry.desiredCount -or
            [int]$entry.pendingCount -ne 0 -or
            $deployments.Count -ne 1 -or
            [string]$deployments[0].status -cne "PRIMARY" -or
            [string]$deployments[0].rolloutState -cne "COMPLETED" -or
            [string]$deployments[0].taskDefinition -cne [string]$entry.taskDefinition
        ) {
            throw "A production service is not in the exact stable rollout state."
        }
    }
    if ([int]$worker[0].desiredCount -ne 1) {
        throw "The production scheduler worker must remain an exact singleton."
    }
    if ([int]$api[0].desiredCount -notin @(1, 2)) {
        throw "Credential rotation requires the reviewed one/two-task API deployment window."
    }
    return [pscustomobject]@{
        ApiTaskDefinitionArn = [string]$api[0].taskDefinition
        WorkerTaskDefinitionArn = [string]$worker[0].taskDefinition
        ApiDesiredCount = [int]$api[0].desiredCount
        WorkerDesiredCount = [int]$worker[0].desiredCount
        TargetGroupArn = if (@($api[0].loadBalancers).Count -eq 1) {
            [string]$api[0].loadBalancers[0].targetGroupArn
        } else { "" }
    }
}

function Get-TaskDefinitionImage {
    param(
        [Parameter(Mandatory = $true)][string]$TaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$ContainerName,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    $response = Invoke-AwsJson -Arguments @(
        "ecs", "describe-task-definition",
        "--task-definition", $TaskDefinitionArn,
        "--region", $AwsRegion,
        "--query", "taskDefinition.{taskDefinitionArn:taskDefinitionArn,containerDefinitions:containerDefinitions[].{name:name,image:image}}",
        "--output", "json"
    )
    $containers = @($response.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if (
        [string]$response.taskDefinitionArn -cne $TaskDefinitionArn -or
        $containers.Count -ne 1 -or
        [string]$containers[0].image -notmatch '@(?<digest>sha256:[0-9a-f]{64})$'
    ) {
        throw "A production task definition is not pinned to an exact image digest."
    }
    return [pscustomobject]@{
        TaskDefinitionArn = $TaskDefinitionArn
        Image = [string]$containers[0].image
        Digest = [string]$Matches.digest
    }
}

function Assert-ServiceDigestGate {
    param(
        [Parameter(Mandatory = $true)]$ServiceSnapshot,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    $apiImage = Get-TaskDefinitionImage -TaskDefinitionArn $ServiceSnapshot.ApiTaskDefinitionArn -ContainerName "api" -AwsRegion $AwsRegion
    $workerImage = Get-TaskDefinitionImage -TaskDefinitionArn $ServiceSnapshot.WorkerTaskDefinitionArn -ContainerName "scheduler-worker" -AwsRegion $AwsRegion
    if ($apiImage.Digest -cne $workerImage.Digest) {
        throw "The API and worker are not running the same exact image digest."
    }
    return $apiImage.Digest
}

function Get-ExpectedRuntimeSsmParameterArn {
    param(
        [Parameter(Mandatory = $true)][string]$TaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$ParameterName,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    if ($TaskDefinitionArn -notmatch '^arn:(?<partition>aws(?:-[a-z0-9-]+)?):ecs:(?<region>[a-z0-9-]+):(?<account>[0-9]{12}):task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$') {
        throw "The runtime-secret contract could not derive an exact environment-scoped SSM ARN."
    }
    $partition = [string]$Matches.partition
    $taskRegion = [string]$Matches.region
    $account = [string]$Matches.account
    if ($taskRegion -cne $AwsRegion -or $ParameterName -notmatch '^/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$') {
        throw "The runtime-secret contract could not derive an exact environment-scoped SSM ARN."
    }
    return "arn:$($partition):ssm:$($AwsRegion):$($account):parameter$ParameterName"
}

function Assert-TaskDefinitionRuntimeSecretContract {
    param(
        [Parameter(Mandatory = $true)][string]$TaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$ContainerName,
        [Parameter(Mandatory = $true)][string]$RuntimeSecretName,
        [Parameter(Mandatory = $true)][string]$ParameterName,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    if ($RuntimeSecretName -notmatch '^[A-Z][A-Z0-9_]{1,127}$') {
        throw "The runtime-secret contract contains an invalid environment name."
    }
    $expectedArn = Get-ExpectedRuntimeSsmParameterArn `
        -TaskDefinitionArn $TaskDefinitionArn `
        -ParameterName $ParameterName `
        -AwsRegion $AwsRegion
    $response = Invoke-AwsJson -Arguments @(
        "ecs", "describe-task-definition",
        "--task-definition", $TaskDefinitionArn,
        "--region", $AwsRegion,
        "--query", "taskDefinition.{taskDefinitionArn:taskDefinitionArn,containerDefinitions:containerDefinitions[].{name:name,secrets:secrets[].{name:name,valueFrom:valueFrom},environmentNames:environment[].name}}",
        "--output", "json"
    )
    $containers = @($response.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ([string]$response.taskDefinitionArn -cne $TaskDefinitionArn -or $containers.Count -ne 1) {
        throw "The runtime-secret contract could not identify one exact application container."
    }
    $container = $containers[0]
    $secretReferences = @($container.secrets | Where-Object { [string]$_.name -ceq $RuntimeSecretName })
    $plaintextNames = @($container.environmentNames | Where-Object { [string]$_ -ceq $RuntimeSecretName })
    if (
        $secretReferences.Count -ne 1 -or
        [string]$secretReferences[0].valueFrom -cne $expectedArn -or
        $plaintextNames.Count -ne 0
    ) {
        throw "The task definition does not consume exactly one selected SecureString reference without a plaintext duplicate."
    }
}

function Assert-ServiceRuntimeSecretContract {
    param(
        [Parameter(Mandatory = $true)]$ServiceSnapshot,
        [Parameter(Mandatory = $true)][string]$RuntimeSecretName,
        [Parameter(Mandatory = $true)][string]$ParameterName,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    Assert-TaskDefinitionRuntimeSecretContract `
        -TaskDefinitionArn ([string]$ServiceSnapshot.ApiTaskDefinitionArn) `
        -ContainerName "api" `
        -RuntimeSecretName $RuntimeSecretName `
        -ParameterName $ParameterName `
        -AwsRegion $AwsRegion
    Assert-TaskDefinitionRuntimeSecretContract `
        -TaskDefinitionArn ([string]$ServiceSnapshot.WorkerTaskDefinitionArn) `
        -ContainerName "scheduler-worker" `
        -RuntimeSecretName $RuntimeSecretName `
        -ParameterName $ParameterName `
        -AwsRegion $AwsRegion
}

function Assert-PublicHealthGate {
    param([string]$Uri = "https://school-pilot.net/health")
    $healthHandler = Get-Variable -Name SchoolPilotCredentialRotationHealthHandler -Scope Global -ErrorAction SilentlyContinue
    if (
        $env:SCHOOLPILOT_CREDENTIAL_ROTATION_TEST_MODE -eq $script:TestModeSentinel -and
        $null -ne $healthHandler
    ) {
        $response = & $healthHandler.Value $Uri
    }
    else {
        $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec 20 -MaximumRedirection 0
    }
    if ([int]$response.StatusCode -ne 200) {
        throw "The public production health gate did not return HTTP 200."
    }
    try {
        $payload = [string]$response.Content | ConvertFrom-Json -Depth 10
    }
    catch {
        throw "The public production health gate returned invalid JSON."
    }
    if ([string]$payload.status -cne "ok") {
        throw "The public production health gate did not report status ok."
    }
}

function Assert-TargetHealthGate {
    param(
        [Parameter(Mandatory = $true)][string]$TargetGroupArn,
        [Parameter(Mandatory = $true)][int]$ExpectedHealthy,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    if (-not $TargetGroupArn) {
        throw "The API service has no exact ALB target-group attachment."
    }
    $response = Invoke-AwsJson -Arguments @(
        "elbv2", "describe-target-health",
        "--target-group-arn", $TargetGroupArn,
        "--region", $AwsRegion,
        "--output", "json"
    )
    $states = @($response.TargetHealthDescriptions | ForEach-Object { [string]$_.TargetHealth.State })
    $healthyCount = @($states | Where-Object { $_ -ceq "healthy" }).Count
    $prohibitedStates = @($states | Where-Object { $_ -notin @("healthy", "draining") })
    if ($healthyCount -lt $ExpectedHealthy -or $prohibitedStates.Count -gt 0) {
        throw "The ALB target-health gate is not fully healthy."
    }
}

function Get-CloudWatchFilterCount {
    param(
        [Parameter(Mandatory = $true)][string]$LogGroup,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$StreamPrefix,
        [Parameter(Mandatory = $true)][string]$FilterPattern,
        [Parameter(Mandatory = $true)][int64]$StartTimeMs,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    $arguments = @(
        "logs", "filter-log-events",
        "--log-group-name", $LogGroup,
        "--start-time", [string]$StartTimeMs,
        "--filter-pattern", ('"' + $FilterPattern.Replace('"', '') + '"'),
        "--region", $AwsRegion,
        # AWS CLI applies text-output queries once per paginator page. Returning
        # event IDs lets us aggregate every page locally; returning
        # `length(events)` emits one scalar per page and cannot be parsed safely.
        # Messages and log-stream content never enter this process.
        "--query", "events[].eventId",
        "--output", "text"
    )
    if ($StreamPrefix) {
        $arguments = @($arguments[0..3] + @("--log-stream-name-prefix", $StreamPrefix) + $arguments[4..($arguments.Count - 1)])
    }
    $stdout = Invoke-ExternalCommand -Command "aws" -Arguments $arguments
    $tokens = @($stdout -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($tokens.Count -eq 0) {
        return 0
    }
    $eventIds = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($token in $tokens) {
        $eventId = [string]$token
        # With text output the AWS CLI emits `None` for an empty projection on
        # each paginator page, including between pages that contain event IDs.
        # It is a page marker, not an event or malformed response.
        if ($eventId -ceq "None") {
            continue
        }
        if (
            $eventId.Length -gt 512 -or
            $eventId -notmatch '^[A-Za-z0-9._:/+=-]+$'
        ) {
            throw "CloudWatch returned an invalid sanitized event-ID projection."
        }
        [void]$eventIds.Add($eventId)
    }
    return $eventIds.Count
}

function Assert-PostDeployLogGate {
    param(
        [Parameter(Mandatory = $true)]$PhaseConfiguration,
        [Parameter(Mandatory = $true)][int64]$StartTimeMs,
        [Parameter(Mandatory = $true)][string]$ProjectName,
        [Parameter(Mandatory = $true)][string]$EnvironmentName,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    $logGroup = "/ecs/$ProjectName-$EnvironmentName-api"
    $commonErrors = @(
        "fatal_process_error",
        "uncaughtException",
        "unhandledRejection",
        "startup migrations failed",
        "OutOfMemoryError",
        "CannotPullContainerError",
        "ResourceInitializationError"
    )
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(3)
    $apiReady = $false
    $workerReady = $false
    do {
        foreach ($pattern in @($commonErrors + $PhaseConfiguration.logErrors)) {
            $count = Get-CloudWatchFilterCount -LogGroup $logGroup -StreamPrefix "" -FilterPattern $pattern -StartTimeMs $StartTimeMs -AwsRegion $AwsRegion
            if ($count -gt 0) {
                throw "The post-deploy sanitized log gate found a prohibited error category."
            }
        }
        $apiReady = (Get-CloudWatchFilterCount -LogGroup $logGroup -StreamPrefix "api" -FilterPattern "prewarmed" -StartTimeMs $StartTimeMs -AwsRegion $AwsRegion) -ge 1
        $workerReady = (Get-CloudWatchFilterCount -LogGroup $logGroup -StreamPrefix "scheduler-worker" -FilterPattern "WorkerHeartbeat" -StartTimeMs $StartTimeMs -AwsRegion $AwsRegion) -ge 1
        if ($apiReady -and $workerReady) { break }
        if ([DateTimeOffset]::UtcNow -lt $deadline) {
            if ($env:SCHOOLPILOT_CREDENTIAL_ROTATION_TEST_MODE -ne $script:TestModeSentinel) {
                Start-Sleep -Seconds 10
            }
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if (-not $apiReady -or -not $workerReady) {
        throw "The API/worker positive startup log gates were not observed within three minutes."
    }
}

function Write-SanitizedEvidenceEvent {
    param(
        [Parameter(Mandatory = $true)][string]$EvidencePath,
        [Parameter(Mandatory = $true)][string]$RunId,
        [Parameter(Mandatory = $true)][string]$PhaseName,
        [Parameter(Mandatory = $true)][string]$Event,
        [hashtable]$Details = @{}
    )
    $eventFields = @{
        plan_created = @(
            "priorSsmVersion", "priorCiphertextHashPrefix", "priorPlaintextHashPrefix",
            "apiTaskDefinitionArn", "workerTaskDefinitionArn", "imageDigest",
            "applySupported", "stripeIdentityCaptured"
        )
        plan_validated = @("ssmVersion", "taskState", "publicHealth")
        ssm_cutover_reconciled = @(
            "ssmVersion", "ciphertextHashPrefix", "plaintextHashPrefix",
            "commandAcknowledged", "commandFailed"
        )
        ssm_write_no_mutation = @("priorSsmVersion", "commandFailed")
        aws_cutover_complete = @(
            "ssmVersion", "apiTaskDefinitionArn", "workerTaskDefinitionArn", "imageDigest",
            "publicHealth", "albTargets", "logGate", "providerValidationStatus"
        )
        rotation_failed = @(
            "mutationAttempted", "automaticRollbackRequired", "errorCode", "mutationDisposition"
        )
        automatic_rollback_complete = @(
            "restoredSsmVersion", "apiTaskDefinitionArn", "workerTaskDefinitionArn", "imageDigest"
        )
        manual_rollback_complete = @(
            "restoredSsmVersion", "apiTaskDefinitionArn", "workerTaskDefinitionArn", "imageDigest"
        )
        manual_recovery_required = @(
            "errorCode", "rollbackApiTaskDefinitionArn", "rollbackWorkerTaskDefinitionArn",
            "rollbackSsmPriorVersion", "observedSsmVersion", "mutationDisposition"
        )
        unit = @("ssmVersion", "hashPrefix")
    }
    if (-not $eventFields.ContainsKey($Event)) {
        throw "Sanitized evidence rejected an unknown event type."
    }
    $allowed = @($eventFields[$Event])
    $forbidden = @("value", "secret", "credential", "password", "token", "authorization", "databaseUrl")
    foreach ($key in $Details.Keys) {
        if ([string]$key -in $forbidden -or [string]$key -notin $allowed) {
            throw "Sanitized evidence rejected a field that is not allowlisted for this event."
        }
    }
    $detailJson = $Details | ConvertTo-Json -Depth 20 -Compress
    if ($detailJson -match '(?i)(SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sk_live_[A-Za-z0-9_]+|whsec_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~-]+|postgres(?:ql)?://[^\s"@]+:[^\s"@]+@)') {
        throw "Sanitized evidence rejected a credential-shaped value."
    }
    $record = [ordered]@{
        schemaVersion = 1
        timestamp = [DateTimeOffset]::UtcNow.ToString("o")
        runId = $RunId
        phase = $PhaseName
        event = $Event
        details = $Details
    }
    $line = $record | ConvertTo-Json -Depth 20 -Compress
    [System.IO.File]::AppendAllText($EvidencePath, $line + [Environment]::NewLine, $script:Utf8NoBom)
    Set-OwnerOnlyAcl -Path $EvidencePath
}

function Get-ManifestHash {
    param([Parameter(Mandatory = $true)]$Manifest)
    $copy = [ordered]@{}
    foreach ($property in $Manifest.PSObject.Properties) {
        if ($property.Name -cne "manifestHash") {
            $copy[$property.Name] = $property.Value
        }
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($copy | ConvertTo-Json -Depth 40 -Compress))
    try { return Get-Sha256HexFromBytes -Bytes $bytes }
    finally { [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($bytes) }
}

function Write-RotationManifest {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$Path
    )
    if ($Manifest.PSObject.Properties.Name -contains "manifestHash") {
        $Manifest.manifestHash = Get-ManifestHash -Manifest $Manifest
    }
    else {
        Add-Member -InputObject $Manifest -NotePropertyName manifestHash -NotePropertyValue (Get-ManifestHash -Manifest $Manifest)
    }
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::WriteAllText($temporary, ($Manifest | ConvertTo-Json -Depth 40), $script:Utf8NoBom)
    Set-OwnerOnlyAcl -Path $temporary
    if ([System.IO.File]::Exists($Path)) {
        [System.IO.File]::Move($temporary, $Path, $true)
    }
    else {
        [System.IO.File]::Move($temporary, $Path)
    }
    Assert-OwnerOnlyAcl -Path $Path
}

function Read-RotationManifest {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-OwnerOnlyAcl -Path $Path
    try { $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 40 -DateKind String }
    catch { throw "The credential-rotation plan manifest is invalid JSON." }
    if (
        [int]$manifest.schemaVersion -ne 1 -or
        -not $manifest.manifestHash -or
        [string]$manifest.manifestHash -cne (Get-ManifestHash -Manifest $manifest)
    ) {
        throw "The credential-rotation plan manifest failed its integrity gate."
    }
    return $manifest
}

function Assert-ApplicationSecretDetachedFromTerraformState {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$ResourceName
    )
    $infraDirectory = Join-Path $RepoRoot "infra"
    $stateList = Invoke-ExternalCommand -Command "terraform" -Arguments @(
        "-chdir=$infraDirectory", "state", "list"
    )
    $forbidden = "module.ecs.aws_ssm_parameter.$ResourceName"
    if (@($stateList -split "`r?`n" | Where-Object { $_.Trim() -ceq $forbidden }).Count -gt 0) {
        throw "The selected application secret is still Terraform-state-owned; run the reviewed non-destructive detachment first."
    }
}

function Get-RepositoryGitSha {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $sha = (Invoke-ExternalCommand -Command "git" -Arguments @("-C", $RepoRoot, "rev-parse", "HEAD")).Trim()
    if ($sha -notmatch '^[0-9a-f]{40}$') { throw "The repository Git SHA is invalid." }
    return $sha
}

function Assert-ManifestGitShaCurrent {
    param([Parameter(Mandatory = $true)]$Manifest)
    $current = Get-RepositoryGitSha -RepoRoot ([string]$Manifest.repositoryRoot)
    if ([string]$Manifest.repositoryGitSha -cne $current) {
        throw "The repository HEAD differs from the exact Git SHA captured by the rotation plan."
    }
}

function Assert-RepositoryDeployReady {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    if ($env:SCHOOLPILOT_CREDENTIAL_ROTATION_TEST_MODE -eq $script:TestModeSentinel) { return }
    $branch = (Invoke-ExternalCommand -Command "git" -Arguments @("-C", $RepoRoot, "branch", "--show-current")).Trim()
    if ($branch -cne "main") {
        throw "Production credential rotation requires clean merged main."
    }
    $status = (Invoke-ExternalCommand -Command "git" -Arguments @("-C", $RepoRoot, "status", "--porcelain", "--untracked-files=all")).Trim()
    if ($status) {
        throw "Production credential rotation requires a clean tracked worktree."
    }
    $head = Get-RepositoryGitSha -RepoRoot $RepoRoot
    $origin = (Invoke-ExternalCommand -Command "git" -Arguments @("-C", $RepoRoot, "rev-parse", "origin/main")).Trim()
    if ($head -cne $origin) {
        throw "Production credential rotation requires main equal to origin/main."
    }
}

function Assert-PlanFreshAndScoped {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$ExpectedPhase,
        [Parameter(Mandatory = $true)][string]$ExpectedEnvironment,
        [Parameter(Mandatory = $true)][int]$MaxAgeMinutes
    )
    if (
        [string]$Manifest.phase -cne $ExpectedPhase -or
        [string]$Manifest.environment -cne $ExpectedEnvironment -or
        [string]$Manifest.status -notin @("planned", "applied", "aws_cutover_pending_provider_validation")
    ) {
        throw "The credential-rotation plan is not scoped to this exact phase/environment."
    }
    $created = [DateTimeOffset]::Parse([string]$Manifest.createdAt)
    if (
        [string]$Manifest.status -ceq "planned" -and
        [DateTimeOffset]::UtcNow -gt $created.AddMinutes($MaxAgeMinutes)
    ) {
        throw "The credential-rotation plan has expired; create a fresh plan."
    }
}

function Read-GateEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedPhase,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Manifest,
        [ValidateRange(1, 120)][int]$MaxTtlMinutes = 60
    )
    $full = [System.IO.Path]::GetFullPath($Path)
    if (Test-IsPathWithin -Candidate $full -Parent $RepoRoot) {
        throw "Internal-rotation gate evidence must stay outside the repository."
    }
    Assert-NoReparsePointInExistingPath -Path $full
    Assert-OwnerOnlyAcl -Path $full
    try { $evidence = Get-Content -LiteralPath $full -Raw | ConvertFrom-Json -Depth 20 -DateKind String }
    catch { throw "Internal-rotation gate evidence is invalid JSON." }
    try {
        $createdAt = [DateTimeOffset]::Parse([string]$evidence.createdAt)
        $expiresAt = [DateTimeOffset]::Parse([string]$evidence.expiresAt)
        $planCreatedAt = [DateTimeOffset]::Parse([string]$Manifest.createdAt)
    }
    catch { throw "Internal-rotation gate evidence contains invalid timestamps." }
    if (
        [int]$evidence.schemaVersion -ne 1 -or
        [string]$evidence.phase -cne $ExpectedPhase -or
        [string]$evidence.runId -cne [string]$Manifest.runId -or
        [string]$evidence.manifestHash -cne [string]$Manifest.manifestHash -or
        $evidence.approved -ne $true -or
        $createdAt -lt $planCreatedAt -or
        $createdAt -gt [DateTimeOffset]::UtcNow.AddMinutes(5) -or
        $expiresAt -le $createdAt -or
        $expiresAt -gt $createdAt.AddMinutes($MaxTtlMinutes) -or
        [DateTimeOffset]::UtcNow -gt $expiresAt
    ) {
        throw "Internal-rotation gate evidence is missing, expired, or not approved for this phase."
    }
    return $evidence
}

function Assert-PhaseApplyGate {
    param(
        [Parameter(Mandatory = $true)][string]$PhaseName,
        [Parameter(Mandatory = $true)]$Configuration,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Manifest,
        [string]$EvidencePath,
        [switch]$OverlapConfirmed,
        [switch]$DisruptiveConfirmed
    )
    if (-not $Configuration.applySupported) {
        throw [string]$Configuration.blockReason
    }
    switch ([string]$Configuration.category) {
        "provider" {
            if (-not $OverlapConfirmed) {
                throw "Provider overlap/grace must be confirmed before the AWS cutover."
            }
        }
        "unused-provider" {
            if (-not $OverlapConfirmed) {
                throw "OpenAI has no detected runtime consumer; confirm a deliberate overlap/removal decision before cutover."
            }
        }
        "disruptive-internal" {
            if (-not $DisruptiveConfirmed -or -not $EvidencePath) {
                throw "This internal rotation requires an explicit disruption acknowledgement and gate evidence."
            }
            $evidence = Read-GateEvidence -Path $EvidencePath -ExpectedPhase $PhaseName -RepoRoot $RepoRoot -Manifest $Manifest
            $required = if ($PhaseName -ceq "session") {
                @("plannedLogoutAccepted", "fixtureCookiesRefreshReady", "csrfRefreshReady")
            }
            else {
                @("bearerTokenRefreshReady", "nativeReauthenticationReady", "realtimeReconnectReady")
            }
            foreach ($name in $required) {
                if ($evidence.checks.$name -ne $true) {
                    throw "The internal-rotation evidence is missing a required readiness check."
                }
            }
        }
        "student-hard-gate" {
            if (-not $DisruptiveConfirmed -or -not $EvidencePath) {
                throw "Student-token rotation is hard-blocked without complete device re-registration evidence."
            }
            $evidence = Read-GateEvidence -Path $EvidencePath -ExpectedPhase $PhaseName -RepoRoot $RepoRoot -Manifest $Manifest
            if (
                $evidence.checks.syntheticManifestRefreshed -ne $true -or
                [int]$evidence.checks.syntheticDevicesReregistered -lt 1010 -or
                $evidence.checks.managedChromebookSmokePassed -ne $true -or
                $evidence.checks.realStudentOnboardingBlocked -ne $true
            ) {
                throw "Student-token rotation remains blocked by the Chromebook/device acceptance contract."
            }
        }
        "pin-migration" {
            if (-not $EvidencePath) {
                throw "PIN-key rotation is hard-blocked without dual-read migration evidence."
            }
            $evidence = Read-GateEvidence -Path $EvidencePath -ExpectedPhase $PhaseName -RepoRoot $RepoRoot -Manifest $Manifest
            $checks = $evidence.checks
            if (
                $checks.previousKeyParameterPresent -ne $true -or
                $checks.dualReadCurrentWriteDeployed -ne $true -or
                [int]$checks.failed -ne 0 -or
                [int]$checks.conflicted -ne 0 -or
                ([int]$checks.migrated + [int]$checks.alreadyCurrent) -ne [int]$checks.examined -or
                [int]$checks.idempotencyMigrated -ne 0 -or
                $checks.rollbackWindowOpen -ne $true
            ) {
                throw "PIN-key rotation remains blocked by the dual-read migration contract."
            }
        }
    }
}

function New-SsmPutRequestFile {
    param(
        [Parameter(Mandatory = $true)][string]$ParameterName,
        [Parameter(Mandatory = $true)][securestring]$Value,
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)]$ExpectedMetadata
    )
    $path = Join-Path $Directory ("ssm-put-" + [Guid]::NewGuid().ToString("N") + ".json")
    Invoke-WithSecureStringPlaintext -Value $Value -Action {
        param([string]$Plaintext)
        $request = [ordered]@{
            Name = $ParameterName
            Type = "SecureString"
            Value = $Plaintext
            Overwrite = $true
            Tier = [string]$ExpectedMetadata.Tier
            DataType = [string]$ExpectedMetadata.DataType
        }
        if ([string]$ExpectedMetadata.KeyId) {
            $request["KeyId"] = [string]$ExpectedMetadata.KeyId
        }
        [System.IO.File]::WriteAllText($path, ($request | ConvertTo-Json -Compress), $script:Utf8NoBom)
    } | Out-Null
    Set-OwnerOnlyAcl -Path $path
    return $path
}

function Invoke-SsmSecretWrite {
    param(
        [Parameter(Mandatory = $true)][string]$ParameterName,
        [Parameter(Mandatory = $true)][securestring]$Value,
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$AwsRegion,
        [Parameter(Mandatory = $true)]$BeforeSnapshot,
        [Parameter(Mandatory = $true)][string]$DesiredPlaintextHash
    )
    $requestPath = New-SsmPutRequestFile -ParameterName $ParameterName -Value $Value -Directory $Directory -ExpectedMetadata $BeforeSnapshot
    $response = $null
    $commandAcknowledged = $false
    $commandFailed = $false
    $current = $null
    try {
        $script:MutationStarted = $true
        try {
            $response = Invoke-AwsJson -Arguments @(
                "ssm", "put-parameter",
                "--cli-input-json", ("file://" + $requestPath),
                "--region", $AwsRegion,
                "--output", "json"
            )
            $commandAcknowledged = $true
        }
        catch { $commandFailed = $true }

        try {
            $current = Get-SsmParameterSnapshot -ParameterName $ParameterName -AwsRegion $AwsRegion
        }
        catch {
            return [pscustomobject]@{
                Disposition = "indeterminate"
                Snapshot = $null
                CommandAcknowledged = $commandAcknowledged
                CommandFailed = $commandFailed
            }
        }

        $disposition = Get-SsmMutationDisposition `
            -Before $BeforeSnapshot `
            -Current $current `
            -DesiredPlaintextHash $DesiredPlaintextHash
        if (
            $commandAcknowledged -and
            (
                $null -eq $response -or
                [int64]$response.Version -ne ([int64]$BeforeSnapshot.Version + 1)
            )
        ) {
            $disposition = "indeterminate"
        }
        return [pscustomobject]@{
            Disposition = $disposition
            Snapshot = $current
            CommandAcknowledged = $commandAcknowledged
            CommandFailed = $commandFailed
        }
    }
    finally {
        Remove-SensitiveFile -Path $requestPath
        $response = $null
    }
}

function Register-ClonedTaskDefinition {
    param(
        [Parameter(Mandatory = $true)][string]$TaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    $source = Invoke-AwsJson -Arguments @(
        "ecs", "describe-task-definition",
        "--task-definition", $TaskDefinitionArn,
        "--include", "TAGS",
        "--region", $AwsRegion,
        "--output", "json"
    )
    if ($null -eq $source.taskDefinition -or [string]$source.taskDefinition.taskDefinitionArn -cne $TaskDefinitionArn) {
        throw "The source ECS task definition could not be captured exactly."
    }
    $request = [ordered]@{}
    foreach ($name in @(
        "family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions",
        "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory",
        "runtimePlatform", "ephemeralStorage", "proxyConfiguration", "inferenceAccelerators",
        "pidMode", "ipcMode", "enableFaultInjection"
    )) {
        if ($source.taskDefinition.PSObject.Properties.Name -contains $name -and $null -ne $source.taskDefinition.$name) {
            $request[$name] = $source.taskDefinition.$name
        }
    }
    if (@($source.tags).Count -gt 0) { $request["tags"] = @($source.tags) }
    if (-not $request.Contains("family") -or -not $request.Contains("containerDefinitions")) {
        throw "The cloned ECS task definition request is incomplete."
    }
    $requestPath = Join-Path $Directory ("ecs-register-" + [Guid]::NewGuid().ToString("N") + ".json")
    [System.IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 40), $script:Utf8NoBom)
    Set-OwnerOnlyAcl -Path $requestPath
    try {
        $registered = Invoke-AwsJson -Arguments @(
            "ecs", "register-task-definition",
            "--cli-input-json", ("file://" + $requestPath),
            "--region", $AwsRegion,
            "--output", "json"
        )
        $newArn = [string]$registered.taskDefinition.taskDefinitionArn
        if (-not $newArn -or $newArn -ceq $TaskDefinitionArn) {
            throw "ECS did not register a distinct cloned task-definition revision."
        }
        return $newArn
    }
    finally { Remove-SensitiveFile -Path $requestPath }
}

function Invoke-SecretOnlyTaskCutover {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$ExpectedSsmSnapshot,
        [Parameter(Mandatory = $true)][string]$RunDirectory,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    $currentSsm = Get-SsmParameterSnapshot -ParameterName ([string]$Manifest.parameterName) -AwsRegion $AwsRegion
    Assert-SsmSnapshotMatches -Expected $ExpectedSsmSnapshot -Actual $currentSsm
    $phaseConfiguration = Get-RotationPhaseConfiguration -Name ([string]$Manifest.phase)
    $source = [pscustomobject]@{
        ApiTaskDefinitionArn = [string]$Manifest.prior.apiTaskDefinitionArn
        WorkerTaskDefinitionArn = [string]$Manifest.prior.workerTaskDefinitionArn
    }
    Assert-ServiceRuntimeSecretContract `
        -ServiceSnapshot $source `
        -RuntimeSecretName ([string]$phaseConfiguration.runtimeSecretName) `
        -ParameterName ([string]$Manifest.parameterName) `
        -AwsRegion $AwsRegion

    $apiRevision = Register-ClonedTaskDefinition `
        -TaskDefinitionArn ([string]$Manifest.prior.apiTaskDefinitionArn) `
        -Directory $RunDirectory `
        -AwsRegion $AwsRegion
    $workerRevision = Register-ClonedTaskDefinition `
        -TaskDefinitionArn ([string]$Manifest.prior.workerTaskDefinitionArn) `
        -Directory $RunDirectory `
        -AwsRegion $AwsRegion
    $candidate = [pscustomobject]@{
        ApiTaskDefinitionArn = $apiRevision
        WorkerTaskDefinitionArn = $workerRevision
    }
    Assert-ServiceRuntimeSecretContract `
        -ServiceSnapshot $candidate `
        -RuntimeSecretName ([string]$phaseConfiguration.runtimeSecretName) `
        -ParameterName ([string]$Manifest.parameterName) `
        -AwsRegion $AwsRegion
    $candidateDigest = Assert-ServiceDigestGate -ServiceSnapshot $candidate -AwsRegion $AwsRegion
    if ($candidateDigest -cne [string]$Manifest.prior.imageDigest) {
        throw "The secret-only task revisions changed the digest-pinned application image."
    }

    $preUpdateSsm = Get-SsmParameterSnapshot -ParameterName ([string]$Manifest.parameterName) -AwsRegion $AwsRegion
    Assert-SsmSnapshotMatches -Expected $ExpectedSsmSnapshot -Actual $preUpdateSsm
    foreach ($target in @(
        @{ service = [string]$Manifest.apiService; task = $apiRevision },
        @{ service = [string]$Manifest.workerService; task = $workerRevision }
    )) {
        [void](Invoke-AwsJson -Arguments @(
            "ecs", "update-service",
            "--cluster", ([string]$Manifest.cluster),
            "--service", $target.service,
            "--task-definition", $target.task,
            "--force-new-deployment",
            "--region", $AwsRegion,
            "--output", "json"
        ))
    }
    [void](Invoke-ExternalCommand -Command "aws" -Arguments @(
        "ecs", "wait", "services-stable",
        "--cluster", ([string]$Manifest.cluster),
        "--services", ([string]$Manifest.apiService), ([string]$Manifest.workerService),
        "--region", $AwsRegion
    ) -TimeoutSeconds 900)
    $services = Get-ServiceSnapshot `
        -Cluster ([string]$Manifest.cluster) `
        -ApiService ([string]$Manifest.apiService) `
        -WorkerService ([string]$Manifest.workerService) `
        -AwsRegion $AwsRegion
    $configuration = Get-RotationPhaseConfiguration -Name ([string]$Manifest.phase)
    Assert-ServiceRuntimeSecretContract `
        -ServiceSnapshot $services `
        -RuntimeSecretName ([string]$configuration.runtimeSecretName) `
        -ParameterName ([string]$Manifest.parameterName) `
        -AwsRegion $AwsRegion
    if (
        $services.ApiTaskDefinitionArn -cne $apiRevision -or
        $services.WorkerTaskDefinitionArn -cne $workerRevision
    ) {
        throw "The secret-only ECS cutover did not converge on both cloned task revisions."
    }
    $postUpdateSsm = Get-SsmParameterSnapshot -ParameterName ([string]$Manifest.parameterName) -AwsRegion $AwsRegion
    Assert-SsmSnapshotMatches -Expected $ExpectedSsmSnapshot -Actual $postUpdateSsm
    return $services
}

function Invoke-ServiceTaskRollback {
    param(
        [Parameter(Mandatory = $true)][string]$Cluster,
        [Parameter(Mandatory = $true)][string]$ApiService,
        [Parameter(Mandatory = $true)][string]$WorkerService,
        [Parameter(Mandatory = $true)][string]$ApiTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$WorkerTaskDefinitionArn,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    foreach ($target in @(
        @{ service = $ApiService; task = $ApiTaskDefinitionArn },
        @{ service = $WorkerService; task = $WorkerTaskDefinitionArn }
    )) {
        [void](Invoke-AwsJson -Arguments @(
            "ecs", "update-service",
            "--cluster", $Cluster,
            "--service", $target.service,
            "--task-definition", $target.task,
            "--force-new-deployment",
            "--region", $AwsRegion,
            "--output", "json"
        ))
    }
    [void](Invoke-ExternalCommand -Command "aws" -Arguments @(
        "ecs", "wait", "services-stable",
        "--cluster", $Cluster,
        "--services", $ApiService, $WorkerService,
        "--region", $AwsRegion
    ) -TimeoutSeconds 900)
    $snapshot = Get-ServiceSnapshot -Cluster $Cluster -ApiService $ApiService -WorkerService $WorkerService -AwsRegion $AwsRegion
    if (
        $snapshot.ApiTaskDefinitionArn -cne $ApiTaskDefinitionArn -or
        $snapshot.WorkerTaskDefinitionArn -cne $WorkerTaskDefinitionArn
    ) {
        throw "The service rollback did not converge on the captured task definitions."
    }
    return $snapshot
}

function Get-NewRotationSecret {
    param(
        [Parameter(Mandatory = $true)]$Configuration,
        [securestring]$Provided,
        [securestring]$Confirmation,
        [switch]$GenerateValue
    )
    if ($GenerateValue) {
        if (-not $Configuration.generated) {
            throw "This phase requires a provider-issued or operator-supplied secret."
        }
        return New-GeneratedCredentialSecret -ByteCount ([int]$Configuration.generationBytes)
    }
    if ($null -eq $Provided) {
        $Provided = Read-Host "Enter the new credential (input is hidden)" -AsSecureString
    }
    if ($null -eq $Confirmation) {
        $Confirmation = Read-Host "Re-enter the new credential (input is hidden)" -AsSecureString
    }
    if (-not (Test-SecureStringsEqual -Left $Provided -Right $Confirmation)) {
        throw "The two hidden credential entries did not match."
    }
    $length = Invoke-WithSecureStringPlaintext -Value $Provided -Action { param([string]$Plaintext) $Plaintext.Length }
    if ([int]$length -lt [int]$Configuration.minimumLength) {
        throw "The new credential does not meet the minimum phase length."
    }
    $formatOk = Invoke-WithSecureStringPlaintext -Value $Provided -Action {
        param([string]$Plaintext)
        return $Plaintext -cmatch [string]$Configuration.validationPattern
    }
    if (-not $formatOk) {
        throw "The new credential does not match the production phase format."
    }
    return $Provided.Copy()
}

function Assert-CurrentPlanState {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    Assert-ManifestGitShaCurrent -Manifest $Manifest
    Assert-ApplicationSecretDetachedFromTerraformState `
        -RepoRoot ([string]$Manifest.repositoryRoot) `
        -ResourceName ([string]$Manifest.terraformResourceName)
    $includeSecureValue = [string]$Manifest.phase -ceq "stripe-api"
    $actualSsm = Get-SsmParameterSnapshot `
        -ParameterName ([string]$Manifest.parameterName) `
        -AwsRegion $AwsRegion `
        -IncludeSecureValue:$includeSecureValue
    try {
        Assert-SsmSnapshotMatches -Expected $Manifest.prior.ssm -Actual $actualSsm
        if ([string]$Manifest.phase -in @("stripe-api", "stripe-webhook")) {
            $accountId = Get-StripePlanAccountId `
                -PhaseName ([string]$Manifest.phase) `
                -SelectedSsmSnapshot $actualSsm `
                -ProjectName ([string]$Manifest.project) `
                -EnvironmentName ([string]$Manifest.environment) `
                -AwsRegion $AwsRegion
            if ($accountId -cne [string]$Manifest.prior.stripeAccountId) {
                throw "The current Stripe account identity differs from the private rotation plan."
            }
        }
    }
    finally {
        if ($null -ne $actualSsm.SecureValue) { $actualSsm.SecureValue.Dispose() }
    }
    $services = Get-ServiceSnapshot `
        -Cluster ([string]$Manifest.cluster) `
        -ApiService ([string]$Manifest.apiService) `
        -WorkerService ([string]$Manifest.workerService) `
        -AwsRegion $AwsRegion
    $configuration = Get-RotationPhaseConfiguration -Name ([string]$Manifest.phase)
    Assert-ServiceRuntimeSecretContract `
        -ServiceSnapshot $services `
        -RuntimeSecretName ([string]$configuration.runtimeSecretName) `
        -ParameterName ([string]$Manifest.parameterName) `
        -AwsRegion $AwsRegion
    if (
        $services.ApiTaskDefinitionArn -cne [string]$Manifest.prior.apiTaskDefinitionArn -or
        $services.WorkerTaskDefinitionArn -cne [string]$Manifest.prior.workerTaskDefinitionArn
    ) {
        throw "The captured API/worker rollback task definitions changed; create a fresh plan."
    }
    $digest = Assert-ServiceDigestGate -ServiceSnapshot $services -AwsRegion $AwsRegion
    if ($digest -cne [string]$Manifest.prior.imageDigest) {
        throw "The captured task image digest changed; create a fresh plan."
    }
    Assert-PublicHealthGate
    Assert-TargetHealthGate -TargetGroupArn $services.TargetGroupArn -ExpectedHealthy $services.ApiDesiredCount -AwsRegion $AwsRegion
    return [pscustomobject]@{ Ssm = $actualSsm; Services = $services; Digest = $digest }
}

function New-CredentialRotationPlan {
    param(
        [Parameter(Mandatory = $true)][string]$PhaseName,
        [Parameter(Mandatory = $true)]$Configuration,
        [Parameter(Mandatory = $true)][string]$EnvironmentName,
        [Parameter(Mandatory = $true)][string]$ProjectName,
        [Parameter(Mandatory = $true)][string]$AwsRegion,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$ExternalRoot
    )
    Assert-ApplicationSecretDetachedFromTerraformState `
        -RepoRoot $RepoRoot `
        -ResourceName ([string]$Configuration.terraformResourceName)
    $runId = [DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssfffZ") + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
    $runDirectory = Initialize-SecureWorkDirectory -Path (Join-Path $ExternalRoot $runId) -RepoRoot $RepoRoot
    $evidencePath = Join-Path $runDirectory "evidence.jsonl"
    $manifestPath = Join-Path $runDirectory "plan.json"
    $rollbackPath = Join-Path $runDirectory "prior-secret.dpapi"
    $parameterName = "/$ProjectName/$EnvironmentName/$($Configuration.parameterSuffix)"
    $cluster = "$ProjectName-$EnvironmentName-cluster"
    $apiService = "$ProjectName-$EnvironmentName-api"
    $workerService = "$ProjectName-$EnvironmentName-scheduler-worker"

    $ssm = Get-SsmParameterSnapshot -ParameterName $parameterName -AwsRegion $AwsRegion -IncludeSecureValue
    try {
        Protect-RollbackSecret -Value $ssm.SecureValue -Path $rollbackPath -EntropyText "$runId|$PhaseName|$parameterName"
        $services = Get-ServiceSnapshot -Cluster $cluster -ApiService $apiService -WorkerService $workerService -AwsRegion $AwsRegion
        Assert-ServiceRuntimeSecretContract `
            -ServiceSnapshot $services `
            -RuntimeSecretName ([string]$Configuration.runtimeSecretName) `
            -ParameterName $parameterName `
            -AwsRegion $AwsRegion
        $digest = Assert-ServiceDigestGate -ServiceSnapshot $services -AwsRegion $AwsRegion
        Assert-PublicHealthGate
        Assert-TargetHealthGate -TargetGroupArn $services.TargetGroupArn -ExpectedHealthy $services.ApiDesiredCount -AwsRegion $AwsRegion
        $gitSha = Get-RepositoryGitSha -RepoRoot $RepoRoot
        $stripeAccountId = if ($PhaseName -in @("stripe-api", "stripe-webhook")) {
            Get-StripePlanAccountId `
                -PhaseName $PhaseName `
                -SelectedSsmSnapshot $ssm `
                -ProjectName $ProjectName `
                -EnvironmentName $EnvironmentName `
                -AwsRegion $AwsRegion
        }
        else { $null }
        $manifest = [pscustomobject][ordered]@{
            schemaVersion = 1
            runId = $runId
            phase = $PhaseName
            environment = $EnvironmentName
            project = $ProjectName
            region = $AwsRegion
            status = "planned"
            createdAt = [DateTimeOffset]::UtcNow.ToString("o")
            repositoryRoot = $RepoRoot
            repositoryGitSha = $gitSha
            terraformResourceName = [string]$Configuration.terraformResourceName
            parameterName = $parameterName
            cluster = $cluster
            apiService = $apiService
            workerService = $workerService
            rollbackBlobPath = $rollbackPath
            evidencePath = $evidencePath
            prior = [pscustomobject][ordered]@{
                ssm = ConvertTo-SsmSnapshotRecord -Snapshot $ssm
                stripeAccountId = $stripeAccountId
                apiTaskDefinitionArn = $services.ApiTaskDefinitionArn
                workerTaskDefinitionArn = $services.WorkerTaskDefinitionArn
                imageDigest = $digest
            }
            applied = $null
        }
        Write-RotationManifest -Manifest $manifest -Path $manifestPath
        Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId $runId -PhaseName $PhaseName -Event "plan_created" -Details @{
            priorSsmVersion = $ssm.Version
            priorCiphertextHashPrefix = $ssm.CiphertextHash.Substring(0, 12)
            priorPlaintextHashPrefix = $ssm.PlaintextHash.Substring(0, 12)
            apiTaskDefinitionArn = $services.ApiTaskDefinitionArn
            workerTaskDefinitionArn = $services.WorkerTaskDefinitionArn
            imageDigest = $digest
            applySupported = [bool]$Configuration.applySupported
            stripeIdentityCaptured = [bool]($PhaseName -in @("stripe-api", "stripe-webhook"))
        }
        return [pscustomobject]@{ PlanPath = $manifestPath; EvidencePath = $evidencePath; RunId = $runId }
    }
    finally {
        if ($null -ne $ssm.SecureValue) { $ssm.SecureValue.Dispose() }
    }
}

function Invoke-CredentialRollbackCore {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Configuration,
        [Parameter(Mandatory = $true)][string]$AwsRegion,
        [Parameter(Mandatory = $true)][string]$RunDirectory,
        [Parameter(Mandatory = $true)]$ExpectedCurrentSsmSnapshot,
        [Parameter(Mandatory = $true)][securestring]$PriorSecret,
        [Parameter(Mandatory = $true)][int64]$LogStartTimeMs
    )
    $currentSsm = Get-SsmParameterSnapshot -ParameterName ([string]$Manifest.parameterName) -AwsRegion $AwsRegion
    Assert-SsmSnapshotMatches -Expected $ExpectedCurrentSsmSnapshot -Actual $currentSsm
    $rollbackWrite = Invoke-SsmSecretWrite `
        -ParameterName ([string]$Manifest.parameterName) `
        -Value $PriorSecret `
        -Directory $RunDirectory `
        -AwsRegion $AwsRegion `
        -BeforeSnapshot $currentSsm `
        -DesiredPlaintextHash ([string]$Manifest.prior.ssm.PlaintextHash)
    if ([string]$rollbackWrite.Disposition -cne "intended" -or $null -eq $rollbackWrite.Snapshot) {
        throw "Rollback SSM reconciliation was not the exact intended next version; manual recovery is required."
    }
    $restoredSsm = ConvertTo-SsmSnapshotRecord -Snapshot $rollbackWrite.Snapshot
    if ([string]$restoredSsm.PlaintextHash -cne [string]$Manifest.prior.ssm.PlaintextHash) {
        throw "Rollback restored an unexpected plaintext hash."
    }
    $services = Invoke-ServiceTaskRollback `
        -Cluster ([string]$Manifest.cluster) `
        -ApiService ([string]$Manifest.apiService) `
        -WorkerService ([string]$Manifest.workerService) `
        -ApiTaskDefinitionArn ([string]$Manifest.prior.apiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$Manifest.prior.workerTaskDefinitionArn) `
        -AwsRegion $AwsRegion
    $digest = Assert-ServiceDigestGate -ServiceSnapshot $services -AwsRegion $AwsRegion
    if ($digest -cne [string]$Manifest.prior.imageDigest) {
        throw "Rollback restored unexpected task image digest."
    }
    Assert-PublicHealthGate
    Assert-TargetHealthGate -TargetGroupArn $services.TargetGroupArn -ExpectedHealthy $services.ApiDesiredCount -AwsRegion $AwsRegion
    Assert-PostDeployLogGate `
        -PhaseConfiguration $Configuration `
        -StartTimeMs $LogStartTimeMs `
        -ProjectName ([string]$Manifest.project) `
        -EnvironmentName ([string]$Manifest.environment) `
        -AwsRegion $AwsRegion
    $postRollbackSsm = Get-SsmParameterSnapshot -ParameterName ([string]$Manifest.parameterName) -AwsRegion $AwsRegion
    Assert-SsmSnapshotMatches -Expected $restoredSsm -Actual $postRollbackSsm
    return [pscustomobject]@{ SsmVersion = $restoredSsm.Version; Ssm = $restoredSsm; Services = $services; Digest = $digest }
}

function Invoke-CredentialRotationApply {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Configuration,
        [Parameter(Mandatory = $true)][securestring]$Replacement,
        [Parameter(Mandatory = $true)][string]$ManifestPathValue,
        [Parameter(Mandatory = $true)][string]$AwsRegion,
        [string]$StripeTargetAccountId = ""
    )
    $runDirectory = Split-Path -Parent $ManifestPathValue
    $evidencePath = [string]$Manifest.evidencePath
    $runId = [string]$Manifest.runId
    $phaseName = [string]$Manifest.phase
    $priorSecret = $null
    $ownedWriteSnapshot = $null
    $mutationDisposition = "not_attempted"
    $manualRecoveryRequired = $false
    $script:MutationStarted = $false
    $applyStart = [DateTimeOffset]::UtcNow
    $applyStartMs = $applyStart.AddMinutes(-1).ToUnixTimeMilliseconds()
    try {
        $priorSecret = Unprotect-RollbackSecret `
            -Path ([string]$Manifest.rollbackBlobPath) `
            -EntropyText "$runId|$phaseName|$($Manifest.parameterName)"
        if ((Get-SecureStringHash -Value $priorSecret) -cne [string]$Manifest.prior.ssm.PlaintextHash) {
            throw "The protected rollback material failed its expected hash gate."
        }
        $planState = Assert-CurrentPlanState -Manifest $Manifest -AwsRegion $AwsRegion
        $replacementHash = Get-SecureStringHash -Value $Replacement
        if ($replacementHash -ceq [string]$Manifest.prior.ssm.PlaintextHash) {
            throw "The replacement credential is identical to the planned prior credential."
        }
        $preWriteSsm = $planState.Ssm
        Assert-SsmSnapshotMatches -Expected $Manifest.prior.ssm -Actual $preWriteSsm
        $writeResult = Invoke-SsmSecretWrite `
            -ParameterName ([string]$Manifest.parameterName) `
            -Value $Replacement `
            -Directory $runDirectory `
            -AwsRegion $AwsRegion `
            -BeforeSnapshot $preWriteSsm `
            -DesiredPlaintextHash $replacementHash
        $mutationDisposition = [string]$writeResult.Disposition
        if ($mutationDisposition -ceq "unchanged") {
            Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId $runId -PhaseName $phaseName -Event "ssm_write_no_mutation" -Details @{
                priorSsmVersion = [int64]$preWriteSsm.Version
                commandFailed = [bool]$writeResult.CommandFailed
            }
            throw "The SSM command failed or returned without changing the exact planned snapshot."
        }
        if ($mutationDisposition -cne "intended" -or $null -eq $writeResult.Snapshot) {
            $manualRecoveryRequired = $true
            Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId $runId -PhaseName $phaseName -Event "manual_recovery_required" -Details @{
                errorCode = "SSM_WRITE_INDETERMINATE"
                rollbackApiTaskDefinitionArn = [string]$Manifest.prior.apiTaskDefinitionArn
                rollbackWorkerTaskDefinitionArn = [string]$Manifest.prior.workerTaskDefinitionArn
                rollbackSsmPriorVersion = [int64]$Manifest.prior.ssm.Version
                observedSsmVersion = if ($null -ne $writeResult.Snapshot) { [int64]$writeResult.Snapshot.Version } else { -1 }
                mutationDisposition = $mutationDisposition
            }
            throw "The SSM write outcome is indeterminate; no automatic overwrite is safe."
        }
        $ownedWriteSnapshot = ConvertTo-SsmSnapshotRecord -Snapshot $writeResult.Snapshot
        Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId $runId -PhaseName $phaseName -Event "ssm_cutover_reconciled" -Details @{
            ssmVersion = [int64]$ownedWriteSnapshot.Version
            ciphertextHashPrefix = $ownedWriteSnapshot.CiphertextHash.Substring(0, 12)
            plaintextHashPrefix = $ownedWriteSnapshot.PlaintextHash.Substring(0, 12)
            commandAcknowledged = [bool]$writeResult.CommandAcknowledged
            commandFailed = [bool]$writeResult.CommandFailed
        }
        $services = Invoke-SecretOnlyTaskCutover `
            -Manifest $Manifest `
            -ExpectedSsmSnapshot $ownedWriteSnapshot `
            -RunDirectory $runDirectory `
            -AwsRegion $AwsRegion
        $digest = Assert-ServiceDigestGate -ServiceSnapshot $services -AwsRegion $AwsRegion
        Assert-PublicHealthGate
        Assert-TargetHealthGate -TargetGroupArn $services.TargetGroupArn -ExpectedHealthy $services.ApiDesiredCount -AwsRegion $AwsRegion
        Assert-PostDeployLogGate `
            -PhaseConfiguration $Configuration `
            -StartTimeMs $applyStartMs `
            -ProjectName ([string]$Manifest.project) `
            -EnvironmentName ([string]$Manifest.environment) `
            -AwsRegion $AwsRegion
        $pendingProviderCanary = $phaseName -in @("google", "sendgrid", "stripe-webhook")
        $providerValidationStatus = if ($pendingProviderCanary) {
            "pending-machine-verifiable-provider-canary"
        }
        elseif ($phaseName -ceq "stripe-api") {
            "passed-read-only-stripe-account"
        }
        else { "not-applicable" }
        $Manifest.status = if ($pendingProviderCanary) { "aws_cutover_pending_provider_validation" } else { "applied" }
        $Manifest.applied = [pscustomobject][ordered]@{
            completedAt = [DateTimeOffset]::UtcNow.ToString("o")
            ssm = $ownedWriteSnapshot
            apiTaskDefinitionArn = $services.ApiTaskDefinitionArn
            workerTaskDefinitionArn = $services.WorkerTaskDefinitionArn
            imageDigest = $digest
            stripeAccountId = if ($StripeTargetAccountId) { $StripeTargetAccountId } else { $null }
            providerValidationStatus = $providerValidationStatus
            priorProviderCredentialDeleted = $false
        }
        Write-RotationManifest -Manifest $Manifest -Path $ManifestPathValue
        Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId $runId -PhaseName $phaseName -Event "aws_cutover_complete" -Details @{
            ssmVersion = $ownedWriteSnapshot.Version
            apiTaskDefinitionArn = $services.ApiTaskDefinitionArn
            workerTaskDefinitionArn = $services.WorkerTaskDefinitionArn
            imageDigest = $digest
            publicHealth = "ok"
            albTargets = "healthy"
            logGate = "pass"
            providerValidationStatus = $providerValidationStatus
        }
        return [pscustomobject]@{ Status = [string]$Manifest.status; EvidencePath = $evidencePath; ManifestPath = $ManifestPathValue }
    }
    catch {
        Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId $runId -PhaseName $phaseName -Event "rotation_failed" -Details @{
            mutationAttempted = $script:MutationStarted
            automaticRollbackRequired = ($null -ne $ownedWriteSnapshot -and -not $manualRecoveryRequired)
            errorCode = "ROTATION_GATE_FAILED"
            mutationDisposition = $mutationDisposition
        }
        if ($manualRecoveryRequired) {
            throw "Credential rotation stopped with an indeterminate external state; follow the private evidence and do not overwrite SSM automatically."
        }
        if ($null -ne $ownedWriteSnapshot -and $null -ne $priorSecret) {
            try {
                $current = Get-SsmParameterSnapshot -ParameterName ([string]$Manifest.parameterName) -AwsRegion $AwsRegion
                if (-not (Test-SsmSnapshotMatches -Expected $ownedWriteSnapshot -Actual $current)) {
                    $manualRecoveryRequired = $true
                    Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId $runId -PhaseName $phaseName -Event "manual_recovery_required" -Details @{
                        errorCode = "SSM_CONCURRENT_CHANGE"
                        rollbackApiTaskDefinitionArn = [string]$Manifest.prior.apiTaskDefinitionArn
                        rollbackWorkerTaskDefinitionArn = [string]$Manifest.prior.workerTaskDefinitionArn
                        rollbackSsmPriorVersion = [int64]$Manifest.prior.ssm.Version
                        observedSsmVersion = [int64]$current.Version
                        mutationDisposition = "indeterminate"
                    }
                    throw "Automatic rollback refused because SSM no longer matches the exact owned write snapshot."
                }
                $rollback = Invoke-CredentialRollbackCore `
                    -Manifest $Manifest `
                    -Configuration $Configuration `
                    -AwsRegion $AwsRegion `
                    -RunDirectory $runDirectory `
                    -ExpectedCurrentSsmSnapshot $ownedWriteSnapshot `
                    -PriorSecret $priorSecret `
                    -LogStartTimeMs ([DateTimeOffset]::UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds())
                $Manifest.status = "rolled_back"
                $Manifest.applied = $null
                Write-RotationManifest -Manifest $Manifest -Path $ManifestPathValue
                Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId $runId -PhaseName $phaseName -Event "automatic_rollback_complete" -Details @{
                    restoredSsmVersion = $rollback.SsmVersion
                    apiTaskDefinitionArn = $rollback.Services.ApiTaskDefinitionArn
                    workerTaskDefinitionArn = $rollback.Services.WorkerTaskDefinitionArn
                    imageDigest = $rollback.Digest
                }
            }
            catch {
                if (-not $manualRecoveryRequired) {
                    Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId $runId -PhaseName $phaseName -Event "manual_recovery_required" -Details @{
                        errorCode = "AUTOMATIC_ROLLBACK_FAILED"
                        rollbackApiTaskDefinitionArn = [string]$Manifest.prior.apiTaskDefinitionArn
                        rollbackWorkerTaskDefinitionArn = [string]$Manifest.prior.workerTaskDefinitionArn
                        rollbackSsmPriorVersion = [int64]$Manifest.prior.ssm.Version
                        observedSsmVersion = -1
                        mutationDisposition = "indeterminate"
                    }
                }
                throw "Credential rotation failed and automatic rollback did not complete; follow the external sanitized evidence."
            }
        }
        throw "Credential rotation failed a production gate; rollback evidence was recorded."
    }
    finally {
        if ($null -ne $priorSecret) { $priorSecret.Dispose() }
    }
}

function Invoke-CredentialRotationManualRollback {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Configuration,
        [Parameter(Mandatory = $true)][string]$ManifestPathValue,
        [Parameter(Mandatory = $true)][string]$AwsRegion
    )
    Assert-ManifestGitShaCurrent -Manifest $Manifest
    if ([string]$Manifest.status -notin @("applied", "aws_cutover_pending_provider_validation") -or $null -eq $Manifest.applied) {
        throw "Manual rollback requires an exact applied AWS-cutover manifest."
    }
    if (
        [string]$Configuration.category -in @("provider", "unused-provider") -and
        $Manifest.applied.PSObject.Properties.Name -contains "priorProviderCredentialDeleted" -and
        $Manifest.applied.priorProviderCredentialDeleted -eq $true
    ) {
        throw "Provider rollback is permanently blocked because the prior provider credential was deleted."
    }
    $current = Get-SsmParameterSnapshot -ParameterName ([string]$Manifest.parameterName) -AwsRegion $AwsRegion
    Assert-SsmSnapshotMatches -Expected $Manifest.applied.ssm -Actual $current
    $services = Get-ServiceSnapshot `
        -Cluster ([string]$Manifest.cluster) `
        -ApiService ([string]$Manifest.apiService) `
        -WorkerService ([string]$Manifest.workerService) `
        -AwsRegion $AwsRegion
    if (
        $services.ApiTaskDefinitionArn -cne [string]$Manifest.applied.apiTaskDefinitionArn -or
        $services.WorkerTaskDefinitionArn -cne [string]$Manifest.applied.workerTaskDefinitionArn
    ) {
        throw "Manual rollback refused because the applied task definitions changed."
    }
    $prior = Unprotect-RollbackSecret `
        -Path ([string]$Manifest.rollbackBlobPath) `
        -EntropyText "$($Manifest.runId)|$($Manifest.phase)|$($Manifest.parameterName)"
    try {
        if ((Get-SecureStringHash -Value $prior) -cne [string]$Manifest.prior.ssm.PlaintextHash) {
            throw "Manual rollback material failed its expected hash gate."
        }
        try {
            $rollback = Invoke-CredentialRollbackCore `
                -Manifest $Manifest `
                -Configuration $Configuration `
                -AwsRegion $AwsRegion `
                -RunDirectory (Split-Path -Parent $ManifestPathValue) `
                -ExpectedCurrentSsmSnapshot $Manifest.applied.ssm `
                -PriorSecret $prior `
                -LogStartTimeMs ([DateTimeOffset]::UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds())
        }
        catch {
            Write-SanitizedEvidenceEvent -EvidencePath ([string]$Manifest.evidencePath) -RunId ([string]$Manifest.runId) -PhaseName ([string]$Manifest.phase) -Event "manual_recovery_required" -Details @{
                errorCode = "MANUAL_ROLLBACK_INDETERMINATE"
                rollbackApiTaskDefinitionArn = [string]$Manifest.prior.apiTaskDefinitionArn
                rollbackWorkerTaskDefinitionArn = [string]$Manifest.prior.workerTaskDefinitionArn
                rollbackSsmPriorVersion = [int64]$Manifest.prior.ssm.Version
                observedSsmVersion = [int64]$current.Version
                mutationDisposition = "indeterminate"
            }
            throw "Manual rollback did not reconcile exactly; no further automatic overwrite is safe."
        }
        $Manifest.status = "rolled_back"
        Write-RotationManifest -Manifest $Manifest -Path $ManifestPathValue
        Write-SanitizedEvidenceEvent -EvidencePath ([string]$Manifest.evidencePath) -RunId ([string]$Manifest.runId) -PhaseName ([string]$Manifest.phase) -Event "manual_rollback_complete" -Details @{
            restoredSsmVersion = $rollback.SsmVersion
            apiTaskDefinitionArn = $rollback.Services.ApiTaskDefinitionArn
            workerTaskDefinitionArn = $rollback.Services.WorkerTaskDefinitionArn
            imageDigest = $rollback.Digest
        }
        return [pscustomobject]@{ Status = "rolled_back"; EvidencePath = [string]$Manifest.evidencePath }
    }
    finally { $prior.Dispose() }
}

function Invoke-CredentialRotationMain {
    $repoRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
    $externalRootCandidate = if ($WorkDirectory) {
        $WorkDirectory
    }
    elseif ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA "SchoolPilot\credential-rotation"
    }
    else {
        throw "LOCALAPPDATA is required unless an external work directory is supplied."
    }
    $externalRoot = Initialize-SecureWorkDirectory -Path $externalRootCandidate -RepoRoot $repoRoot
    $configuration = Get-RotationPhaseConfiguration -Name $Phase

    if ($Mode -ceq "Plan") {
        $result = New-CredentialRotationPlan `
            -PhaseName $Phase `
            -Configuration $configuration `
            -EnvironmentName $Environment `
            -ProjectName $Project `
            -AwsRegion $Region `
            -RepoRoot $repoRoot `
            -ExternalRoot $externalRoot
        Write-Output ([ordered]@{
            status = "planned"
            phase = $Phase
            runId = $result.RunId
            planPath = $result.PlanPath
            evidencePath = $result.EvidencePath
        } | ConvertTo-Json -Compress)
        return
    }

    if (-not $PlanPath) { throw "Validate, Apply, and Rollback require -PlanPath." }
    $planFull = [System.IO.Path]::GetFullPath($PlanPath)
    if (-not (Test-IsPathWithin -Candidate $planFull -Parent $externalRoot)) {
        throw "The plan manifest must be inside the ACL-restricted external work directory."
    }
    Assert-NoReparsePointInExistingPath -Path (Split-Path -Parent $planFull)
    $manifest = Read-RotationManifest -Path $planFull
    Assert-PlanFreshAndScoped -Manifest $manifest -ExpectedPhase $Phase -ExpectedEnvironment $Environment -MaxAgeMinutes $PlanMaxAgeMinutes
    Assert-ManifestGitShaCurrent -Manifest $manifest

    if ($Mode -ceq "Validate") {
        $null = Assert-CurrentPlanState -Manifest $manifest -AwsRegion $Region
        Write-SanitizedEvidenceEvent -EvidencePath ([string]$manifest.evidencePath) -RunId ([string]$manifest.runId) -PhaseName $Phase -Event "plan_validated" -Details @{
            ssmVersion = [int64]$manifest.prior.ssm.Version
            taskState = "unchanged"
            publicHealth = "ok"
        }
        Write-Output ([ordered]@{ status = "valid"; phase = $Phase; planPath = $planFull; evidencePath = [string]$manifest.evidencePath } | ConvertTo-Json -Compress)
        return
    }

    if (-not $ConfirmProduction) {
        throw "Apply and Rollback require the explicit -ConfirmProduction switch."
    }
    Assert-RepositoryDeployReady -RepoRoot $repoRoot

    if ($Mode -ceq "Apply") {
        if ([string]$manifest.status -cne "planned") {
            throw "Apply requires a fresh planned manifest."
        }
        Assert-PhaseApplyGate `
            -PhaseName $Phase `
            -Configuration $configuration `
            -RepoRoot $repoRoot `
            -Manifest $manifest `
            -EvidencePath $GateEvidencePath `
            -OverlapConfirmed:$ProviderOverlapConfirmed `
            -DisruptiveConfirmed:$AllowDisruptiveInternalRotation
        $replacement = Get-NewRotationSecret `
            -Configuration $configuration `
            -Provided $NewSecret `
            -Confirmation $NewSecretConfirmation `
            -GenerateValue:$Generate
        try {
            $stripeTargetAccountId = if ($Phase -in @("stripe-api", "stripe-webhook")) {
                Assert-StripeReplacementIdentity `
                    -PhaseName $Phase `
                    -PriorAccountId ([string]$manifest.prior.stripeAccountId) `
                    -Replacement $replacement `
                    -EvidencePath $GateEvidencePath `
                    -RepoRoot $repoRoot `
                    -Manifest $manifest
            }
            else { "" }
            $result = Invoke-CredentialRotationApply `
                -Manifest $manifest `
                -Configuration $configuration `
                -Replacement $replacement `
                -ManifestPathValue $planFull `
                -AwsRegion $Region `
                -StripeTargetAccountId $stripeTargetAccountId
            Write-Output ([ordered]@{ status = $result.Status; phase = $Phase; planPath = $result.ManifestPath; evidencePath = $result.EvidencePath } | ConvertTo-Json -Compress)
        }
        finally { $replacement.Dispose() }
        return
    }

    if ($configuration.category -in @("provider", "unused-provider") -and -not $ProviderOldCredentialStillEnabled) {
        throw "Provider rollback requires confirmation that the prior provider credential is still enabled."
    }
    $result = Invoke-CredentialRotationManualRollback `
        -Manifest $manifest `
        -Configuration $configuration `
        -ManifestPathValue $planFull `
        -AwsRegion $Region
    Write-Output ([ordered]@{ status = $result.Status; phase = $Phase; planPath = $planFull; evidencePath = $result.EvidencePath } | ConvertTo-Json -Compress)
}

if ($env:SCHOOLPILOT_CREDENTIAL_ROTATION_IMPORT_ONLY -ne $script:TestModeSentinel) {
    try {
        Invoke-CredentialRotationMain
    }
    catch {
        Write-Error "Credential rotation stopped safely. No credential value was emitted."
        exit 1
    }
}
