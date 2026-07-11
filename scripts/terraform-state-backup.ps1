#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateSet("Backup", "Restore")]
    [string]$Mode = "Backup",

    [string]$StatePath,

    [string]$OutputDirectory,

    [string]$BackupPath,

    [string]$RestorePath,

    [string]$Phase = "manual",

    [ValidateSet("Before", "After", "Manual")]
    [string]$Usage = "Manual",

    [string]$RecoveryPath,

    [System.Security.SecureString]$RecoveryPassphrase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$script:OuterMagic = [System.Text.Encoding]::ASCII.GetBytes("SPTFDPAPI01`n")
$script:InnerMagic = [System.Text.Encoding]::ASCII.GetBytes("SPTFSTATE01`n")
$script:Entropy = [System.Text.Encoding]::UTF8.GetBytes("SchoolPilot Terraform state backup format v1")
$script:RecoveryMagic = [System.Text.Encoding]::ASCII.GetBytes("SPTFAESGCM01`n")
$script:RecoverySaltLength = 16
$script:RecoveryNonceLength = 12
$script:RecoveryTagLength = 16
$script:RecoveryIterations = 600000

function Clear-ByteArray {
    param(
        [AllowNull()]
        [byte[]]$Bytes
    )

    if ($null -ne $Bytes -and $Bytes.Length -gt 0) {
        [System.Array]::Clear($Bytes, 0, $Bytes.Length)
    }
}

function Clear-CharArray {
    param(
        [AllowNull()]
        [char[]]$Chars
    )

    if ($null -ne $Chars -and $Chars.Length -gt 0) {
        [System.Array]::Clear($Chars, 0, $Chars.Length)
    }
}

function Get-GitShortSha {
    $sha = @(& git -C $script:RepositoryRoot rev-parse --verify --short=12 HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $sha.Count -ne 1) {
        throw "The repository Git SHA could not be resolved."
    }

    $value = ([string]$sha[0]).Trim().ToLowerInvariant()
    if ($value -notmatch "^[0-9a-f]{12}$") {
        throw "The repository Git SHA was not in the expected format."
    }
    return $value
}

function Get-BackupMetadata {
    if (
        [string]::IsNullOrWhiteSpace($Phase) -or
        $Phase.Length -gt 64 -or
        $Phase -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]*$" -or
        $Phase.EndsWith(".")
    ) {
        throw "Phase must be 1-64 filename-safe characters and start with a letter or number."
    }

    $timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
    $gitSha = Get-GitShortSha
    $phaseSlug = $Phase.ToLowerInvariant()
    $usageSlug = $Usage.ToLowerInvariant()

    return [pscustomobject]@{
        Timestamp = $timestamp
        GitSha    = $gitSha
        Phase     = $phaseSlug
        Usage     = $usageSlug
        # Every rollout artifact uses the same unambiguous
        # <UTC timestamp>-<Git SHA>-<phase> naming contract. Treat the usage
        # checkpoint as part of the phase so Before/After backups can never
        # collide or be mistaken for one another.
        FileStem  = "$timestamp-$gitSha-$phaseSlug-$usageSlug"
    }
}

function Convert-SecureStringToUtf8Bytes {
    param(
        [Parameter(Mandatory = $true)]
        [System.Security.SecureString]$Value
    )

    $pointer = [IntPtr]::Zero
    $chars = $null
    try {
        $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        $byteLength = [System.Runtime.InteropServices.Marshal]::ReadInt32($pointer, -4)
        $charLength = [int]($byteLength / 2)
        if ($charLength -lt 16) {
            throw "RecoveryPassphrase must contain at least 16 characters."
        }

        $chars = [char[]]::new($charLength)
        for ($index = 0; $index -lt $charLength; $index++) {
            $chars[$index] = [char][System.Runtime.InteropServices.Marshal]::ReadInt16(
                $pointer,
                $index * 2
            )
        }
        return ,[System.Text.Encoding]::UTF8.GetBytes($chars)
    }
    finally {
        Clear-CharArray -Chars $chars
        if ($pointer -ne [IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function New-RandomBytes {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 1024)]
        [int]$Length
    )

    $bytes = [byte[]]::new($Length)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return ,$bytes
    }
    finally {
        $rng.Dispose()
    }
}

function Get-AbsolutePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$ParameterName
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "$ParameterName must not be empty."
    }
    if ($Path.StartsWith("\\?\") -or $Path.StartsWith("\\.\")) {
        throw "$ParameterName must not use a Windows device-namespace path."
    }

    try {
        $absolutePath = [System.IO.Path]::GetFullPath($Path)
    }
    catch {
        throw "$ParameterName is not a valid filesystem path."
    }
    if ($absolutePath.StartsWith("\\?\") -or $absolutePath.StartsWith("\\.\")) {
        throw "$ParameterName must not use a Windows device-namespace path."
    }
    return $absolutePath
}

function Test-IsInsideRepository {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $repository = $script:RepositoryRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $candidate = $Path.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $comparison = [System.StringComparison]::OrdinalIgnoreCase

    if ([string]::Equals($candidate, $repository, $comparison)) {
        return $true
    }

    $repositoryBoundary = $repository + [System.IO.Path]::DirectorySeparatorChar
    return $candidate.StartsWith($repositoryBoundary, $comparison)
}

function Get-OneDriveRecoveryRoot {
    $oneDrive = [string](@($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($oneDrive)) {
        throw "OneDrive could not be resolved for the required rollout recovery copy."
    }
    return [System.IO.Path]::GetFullPath((Join-Path $oneDrive "SchoolPilot-Recovery"))
}

function Test-IsInsidePath {
    param([string]$Path, [string]$Parent)
    $candidate = $Path.TrimEnd('\', '/')
    $boundary = $Parent.TrimEnd('\', '/')
    if ([string]::Equals($candidate, $boundary, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $candidate.StartsWith($boundary + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoExistingReparsePoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$ParameterName
    )

    $current = $Path
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if ([System.IO.File]::Exists($current) -or [System.IO.Directory]::Exists($current)) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                $resolvedLinkTarget = $null
                try {
                    $resolvedLinkTarget = $item.ResolveLinkTarget($false)
                }
                catch {
                    throw "$ParameterName traverses an unreadable reparse point."
                }

                $linkType = [string]$item.LinkType
                $linkTarget = [string]$item.LinkTarget
                $configuredOneDriveRoots = @(
                    $env:OneDrive,
                    $env:OneDriveConsumer,
                    $env:OneDriveCommercial
                ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
                    [System.IO.Path]::GetFullPath([string]$_).TrimEnd('\', '/')
                } | Sort-Object -Unique
                $insideConfiguredOneDrive = $false
                foreach ($oneDriveRoot in $configuredOneDriveRoots) {
                    if (
                        [string]::Equals($current.TrimEnd('\', '/'), $oneDriveRoot, [StringComparison]::OrdinalIgnoreCase) -or
                        $current.StartsWith($oneDriveRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
                    ) {
                        $insideConfiguredOneDrive = $true
                        break
                    }
                }

                # OneDrive Files On-Demand marks its root and hydrated/cloud
                # placeholders as non-link reparse points. They have no link
                # target and are safe only inside the configured OneDrive root.
                # Real symlinks/junctions resolve a target and remain rejected,
                # including when somebody places one inside OneDrive.
                $isOneDriveCloudPlaceholder = $insideConfiguredOneDrive -and
                    $null -eq $resolvedLinkTarget -and
                    [string]::IsNullOrWhiteSpace($linkType) -and
                    [string]::IsNullOrWhiteSpace($linkTarget)
                if (-not $isOneDriveCloudPlaceholder) {
                    throw "$ParameterName must not traverse a symbolic link or junction."
                }
            }
        }

        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) {
            break
        }
        $current = $parent.FullName
    }
}

function Assert-OutsideRepository {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$ParameterName
    )

    $pathRoot = [System.IO.Path]::GetPathRoot($Path)
    $pathWithoutRoot = $Path.Substring($pathRoot.Length)
    if ($pathWithoutRoot.Contains(":")) {
        throw "$ParameterName must not use an NTFS alternate data stream."
    }
    if ($pathWithoutRoot -match "[ .][\\/]" -or $pathWithoutRoot -match "[ .]$") {
        throw "$ParameterName must not contain a component ending in a dot or space."
    }

    if (Test-IsInsideRepository -Path $Path) {
        throw "$ParameterName must be outside the SchoolPilot repository."
    }

    Assert-NoExistingReparsePoint -Path $Path -ParameterName $ParameterName
}

function Read-LockedBytes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        if ($stream.Length -le 0) {
            throw "$Description is empty."
        }
        if ($stream.Length -gt ([int]::MaxValue - 128)) {
            throw "$Description is too large for this backup format."
        }

        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -eq 0) {
                Clear-ByteArray -Bytes $bytes
                throw "$Description could not be read completely."
            }
            $offset += $read
        }

        return ,$bytes
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Get-Sha256 {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Bytes
    )

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash($Bytes)
        return ,$digest
    }
    finally {
        $sha.Dispose()
    }
}

function Test-ByteArraysEqual {
    param(
        [AllowNull()]
        [byte[]]$Left,

        [AllowNull()]
        [byte[]]$Right
    )

    if ($null -eq $Left -or $null -eq $Right -or $Left.Length -ne $Right.Length) {
        return $false
    }

    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ($Left[$index] -bxor $Right[$index])
    }
    return $difference -eq 0
}

function Test-ByteSegment {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Bytes,

        [Parameter(Mandatory = $true)]
        [int]$Offset,

        [Parameter(Mandatory = $true)]
        [byte[]]$Expected
    )

    if ($Offset -lt 0 -or $Offset + $Expected.Length -gt $Bytes.Length) {
        return $false
    }

    $difference = 0
    for ($index = 0; $index -lt $Expected.Length; $index++) {
        $difference = $difference -bor ($Bytes[$Offset + $index] -bxor $Expected[$index])
    }
    return $difference -eq 0
}

function New-StatePayload {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$StateBytes,

        [Parameter(Mandatory = $true)]
        [byte[]]$StateDigest
    )

    $payloadLength = $script:InnerMagic.Length + $StateDigest.Length + $StateBytes.Length
    $payload = [byte[]]::new($payloadLength)
    [System.Buffer]::BlockCopy($script:InnerMagic, 0, $payload, 0, $script:InnerMagic.Length)
    [System.Buffer]::BlockCopy(
        $StateDigest,
        0,
        $payload,
        $script:InnerMagic.Length,
        $StateDigest.Length
    )
    [System.Buffer]::BlockCopy(
        $StateBytes,
        0,
        $payload,
        $script:InnerMagic.Length + $StateDigest.Length,
        $StateBytes.Length
    )
    return ,$payload
}

function Get-RecoveryMetadataBytes {
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Metadata
    )

    $json = [ordered]@{
        version       = 1
        timestamp     = $Metadata.Timestamp
        gitSha        = $Metadata.GitSha
        phase         = $Metadata.Phase
        usage         = $Metadata.Usage
        cipher        = "AES-256-GCM"
        kdf           = "PBKDF2-SHA256"
        kdfIterations = $script:RecoveryIterations
    } | ConvertTo-Json -Compress
    return ,[System.Text.Encoding]::UTF8.GetBytes($json)
}

function New-AesGcmInstance {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Key
    )

    $type = "System.Security.Cryptography.AesGcm" -as [type]
    if ($null -eq $type) {
        throw "AES-GCM recovery copies require PowerShell 7 or newer."
    }

    try {
        return [System.Security.Cryptography.AesGcm]::new($Key, $script:RecoveryTagLength)
    }
    catch [System.Management.Automation.MethodException] {
        return [System.Security.Cryptography.AesGcm]::new($Key)
    }
}

function New-RecoveryEnvelope {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$StateBytes,

        [Parameter(Mandatory = $true)]
        [byte[]]$StateDigest,

        [Parameter(Mandatory = $true)]
        [byte[]]$MetadataBytes,

        [Parameter(Mandatory = $true)]
        [System.Security.SecureString]$Passphrase
    )

    $payload = $null
    $passwordBytes = $null
    $salt = $null
    $nonce = $null
    $key = $null
    $ciphertext = $null
    $tag = $null
    $kdf = $null
    $aes = $null
    try {
        $payload = New-StatePayload -StateBytes $StateBytes -StateDigest $StateDigest
        $passwordBytes = Convert-SecureStringToUtf8Bytes -Value $Passphrase
        $salt = New-RandomBytes -Length $script:RecoverySaltLength
        $nonce = New-RandomBytes -Length $script:RecoveryNonceLength
        $kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new(
            $passwordBytes,
            $salt,
            $script:RecoveryIterations,
            [System.Security.Cryptography.HashAlgorithmName]::SHA256
        )
        $key = $kdf.GetBytes(32)
        $ciphertext = [byte[]]::new($payload.Length)
        $tag = [byte[]]::new($script:RecoveryTagLength)
        $aes = New-AesGcmInstance -Key $key
        $aes.Encrypt($nonce, $payload, $ciphertext, $tag, $MetadataBytes)

        $metadataLengthBytes = [System.BitConverter]::GetBytes([int]$MetadataBytes.Length)
        $envelopeLength = (
            $script:RecoveryMagic.Length +
            $metadataLengthBytes.Length +
            $MetadataBytes.Length +
            $salt.Length +
            $nonce.Length +
            $tag.Length +
            $ciphertext.Length
        )
        $envelope = [byte[]]::new($envelopeLength)
        $offset = 0
        foreach ($segment in @(
            $script:RecoveryMagic,
            $metadataLengthBytes,
            $MetadataBytes,
            $salt,
            $nonce,
            $tag,
            $ciphertext
        )) {
            [System.Buffer]::BlockCopy($segment, 0, $envelope, $offset, $segment.Length)
            $offset += $segment.Length
        }
        return ,$envelope
    }
    finally {
        if ($null -ne $aes) {
            $aes.Dispose()
        }
        if ($null -ne $kdf) {
            $kdf.Dispose()
        }
        Clear-ByteArray -Bytes $payload
        Clear-ByteArray -Bytes $passwordBytes
        Clear-ByteArray -Bytes $salt
        Clear-ByteArray -Bytes $nonce
        Clear-ByteArray -Bytes $key
        Clear-ByteArray -Bytes $ciphertext
        Clear-ByteArray -Bytes $tag
    }
}

function New-EncryptedEnvelope {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$StateBytes,

        [Parameter(Mandatory = $true)]
        [byte[]]$StateDigest
    )

    $payload = $null
    $protectedBytes = $null
    try {
        $payload = New-StatePayload -StateBytes $StateBytes -StateDigest $StateDigest

        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $payload,
            $script:Entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )

        $envelope = [byte[]]::new($script:OuterMagic.Length + $protectedBytes.Length)
        [System.Buffer]::BlockCopy($script:OuterMagic, 0, $envelope, 0, $script:OuterMagic.Length)
        [System.Buffer]::BlockCopy(
            $protectedBytes,
            0,
            $envelope,
            $script:OuterMagic.Length,
            $protectedBytes.Length
        )
        return ,$envelope
    }
    finally {
        Clear-ByteArray -Bytes $payload
        Clear-ByteArray -Bytes $protectedBytes
    }
}

function Read-VerifiedStatePayload {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Payload,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    $storedDigest = $null
    $computedDigest = $null
    $stateBytes = $null
    try {
        $digestLength = 32
        $stateOffset = $script:InnerMagic.Length + $digestLength
        if (
            $Payload.Length -le $stateOffset -or
            -not (Test-ByteSegment -Bytes $Payload -Offset 0 -Expected $script:InnerMagic)
        ) {
            throw "$Description decrypted payload is invalid."
        }

        $storedDigest = [byte[]]::new($digestLength)
        [System.Buffer]::BlockCopy(
            $Payload,
            $script:InnerMagic.Length,
            $storedDigest,
            0,
            $digestLength
        )

        $stateBytes = [byte[]]::new($Payload.Length - $stateOffset)
        [System.Buffer]::BlockCopy($Payload, $stateOffset, $stateBytes, 0, $stateBytes.Length)
        $computedDigest = Get-Sha256 -Bytes $stateBytes
        if (-not (Test-ByteArraysEqual -Left $storedDigest -Right $computedDigest)) {
            throw "$Description failed its integrity check."
        }

        $result = [pscustomobject]@{
            Data     = $stateBytes
            Digest   = $storedDigest
            Metadata = $null
        }
        $stateBytes = $null
        $storedDigest = $null
        return $result
    }
    finally {
        Clear-ByteArray -Bytes $storedDigest
        Clear-ByteArray -Bytes $computedDigest
        Clear-ByteArray -Bytes $stateBytes
    }
}

function Read-VerifiedBackup {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $envelope = $null
    $protectedBytes = $null
    $payload = $null
    $verifiedPayload = $null

    try {
        $envelope = Read-LockedBytes -Path $Path -Description "Encrypted backup"
        if (
            $envelope.Length -le $script:OuterMagic.Length -or
            -not (Test-ByteSegment -Bytes $envelope -Offset 0 -Expected $script:OuterMagic)
        ) {
            throw "The encrypted backup format is not recognized."
        }

        $protectedLength = $envelope.Length - $script:OuterMagic.Length
        $protectedBytes = [byte[]]::new($protectedLength)
        [System.Buffer]::BlockCopy(
            $envelope,
            $script:OuterMagic.Length,
            $protectedBytes,
            0,
            $protectedLength
        )

        try {
            $payload = [System.Security.Cryptography.ProtectedData]::Unprotect(
                $protectedBytes,
                $script:Entropy,
                [System.Security.Cryptography.DataProtectionScope]::CurrentUser
            )
        }
        catch {
            throw "The backup is corrupt or was encrypted by a different Windows user."
        }

        $verifiedPayload = Read-VerifiedStatePayload -Payload $payload -Description "The DPAPI backup"
        $result = $verifiedPayload
        $verifiedPayload = $null
        return $result
    }
    finally {
        Clear-ByteArray -Bytes $envelope
        Clear-ByteArray -Bytes $protectedBytes
        Clear-ByteArray -Bytes $payload
        if ($null -ne $verifiedPayload) {
            Clear-ByteArray -Bytes $verifiedPayload.Data
            Clear-ByteArray -Bytes $verifiedPayload.Digest
        }
    }
}

function Test-IsRecoveryBackup {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $envelope = $null
    try {
        $envelope = Read-LockedBytes -Path $Path -Description "Encrypted backup"
        if (Test-ByteSegment -Bytes $envelope -Offset 0 -Expected $script:RecoveryMagic) {
            return $true
        }
        if (Test-ByteSegment -Bytes $envelope -Offset 0 -Expected $script:OuterMagic) {
            return $false
        }
        throw "The encrypted backup format is not recognized."
    }
    finally {
        Clear-ByteArray -Bytes $envelope
    }
}

function Read-VerifiedRecoveryBackup {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [System.Security.SecureString]$Passphrase,

        [pscustomobject]$ExpectedMetadata
    )

    $envelope = $null
    $metadataBytes = $null
    $salt = $null
    $nonce = $null
    $tag = $null
    $ciphertext = $null
    $passwordBytes = $null
    $key = $null
    $payload = $null
    $kdf = $null
    $aes = $null
    $verifiedPayload = $null
    try {
        $envelope = Read-LockedBytes -Path $Path -Description "AES-GCM recovery backup"
        $minimumLength = (
            $script:RecoveryMagic.Length +
            4 +
            1 +
            $script:RecoverySaltLength +
            $script:RecoveryNonceLength +
            $script:RecoveryTagLength +
            $script:InnerMagic.Length +
            32 +
            1
        )
        if (
            $envelope.Length -lt $minimumLength -or
            -not (Test-ByteSegment -Bytes $envelope -Offset 0 -Expected $script:RecoveryMagic)
        ) {
            throw "The AES-GCM recovery backup format is not recognized."
        }

        $offset = $script:RecoveryMagic.Length
        $metadataLength = [System.BitConverter]::ToInt32($envelope, $offset)
        $offset += 4
        if ($metadataLength -le 0 -or $metadataLength -gt 65536) {
            throw "The AES-GCM recovery metadata length is invalid."
        }

        $fixedTailLength = (
            $script:RecoverySaltLength +
            $script:RecoveryNonceLength +
            $script:RecoveryTagLength
        )
        if ($offset + $metadataLength + $fixedTailLength -ge $envelope.Length) {
            throw "The AES-GCM recovery backup is truncated."
        }

        $metadataBytes = [byte[]]::new($metadataLength)
        [System.Buffer]::BlockCopy($envelope, $offset, $metadataBytes, 0, $metadataLength)
        $offset += $metadataLength

        try {
            $metadata = [System.Text.Encoding]::UTF8.GetString($metadataBytes) | ConvertFrom-Json
        }
        catch {
            throw "The AES-GCM recovery metadata is invalid."
        }
        if (
            $metadata.version -ne 1 -or
            $metadata.cipher -ne "AES-256-GCM" -or
            $metadata.kdf -ne "PBKDF2-SHA256" -or
            $metadata.kdfIterations -ne $script:RecoveryIterations -or
            $metadata.gitSha -notmatch "^[0-9a-f]{12}$" -or
            $metadata.phase -notmatch "^[a-z0-9][a-z0-9._-]{0,63}$" -or
            $metadata.usage -notin @("before", "after", "manual")
        ) {
            throw "The AES-GCM recovery metadata failed validation."
        }
        if ($null -ne $ExpectedMetadata) {
            foreach ($property in @("Timestamp", "GitSha", "Phase", "Usage")) {
                $actualName = $property.Substring(0, 1).ToLowerInvariant() + $property.Substring(1)
                if ([string]$metadata.$actualName -cne [string]$ExpectedMetadata.$property) {
                    throw "The AES-GCM recovery usage metadata did not match the requested backup."
                }
            }
        }

        $salt = [byte[]]::new($script:RecoverySaltLength)
        [System.Buffer]::BlockCopy($envelope, $offset, $salt, 0, $salt.Length)
        $offset += $salt.Length
        $nonce = [byte[]]::new($script:RecoveryNonceLength)
        [System.Buffer]::BlockCopy($envelope, $offset, $nonce, 0, $nonce.Length)
        $offset += $nonce.Length
        $tag = [byte[]]::new($script:RecoveryTagLength)
        [System.Buffer]::BlockCopy($envelope, $offset, $tag, 0, $tag.Length)
        $offset += $tag.Length
        $ciphertext = [byte[]]::new($envelope.Length - $offset)
        [System.Buffer]::BlockCopy($envelope, $offset, $ciphertext, 0, $ciphertext.Length)

        $passwordBytes = Convert-SecureStringToUtf8Bytes -Value $Passphrase
        $kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new(
            $passwordBytes,
            $salt,
            $script:RecoveryIterations,
            [System.Security.Cryptography.HashAlgorithmName]::SHA256
        )
        $key = $kdf.GetBytes(32)
        $payload = [byte[]]::new($ciphertext.Length)
        $aes = New-AesGcmInstance -Key $key
        try {
            $aes.Decrypt($nonce, $ciphertext, $tag, $payload, $metadataBytes)
        }
        catch [System.Security.Cryptography.CryptographicException] {
            throw "The AES-GCM recovery backup is corrupt or the passphrase is incorrect."
        }

        $verifiedPayload = Read-VerifiedStatePayload -Payload $payload -Description "The AES-GCM recovery backup"
        $verifiedPayload.Metadata = $metadata
        $result = $verifiedPayload
        $verifiedPayload = $null
        return $result
    }
    finally {
        if ($null -ne $aes) {
            $aes.Dispose()
        }
        if ($null -ne $kdf) {
            $kdf.Dispose()
        }
        if ($null -ne $verifiedPayload) {
            Clear-ByteArray -Bytes $verifiedPayload.Data
            Clear-ByteArray -Bytes $verifiedPayload.Digest
        }
        Clear-ByteArray -Bytes $envelope
        Clear-ByteArray -Bytes $metadataBytes
        Clear-ByteArray -Bytes $salt
        Clear-ByteArray -Bytes $nonce
        Clear-ByteArray -Bytes $tag
        Clear-ByteArray -Bytes $ciphertext
        Clear-ByteArray -Bytes $passwordBytes
        Clear-ByteArray -Bytes $key
        Clear-ByteArray -Bytes $payload
    }
}

function Write-BytesCreateNew {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [byte[]]$Bytes
    )

    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Invoke-Backup {
    $sourcePath = if ([string]::IsNullOrWhiteSpace($StatePath)) {
        Join-Path $script:RepositoryRoot "infra\terraform.tfstate"
    }
    else {
        $StatePath
    }
    $sourcePath = Get-AbsolutePath -Path $sourcePath -ParameterName "StatePath"

    if (-not [System.IO.File]::Exists($sourcePath)) {
        throw "Terraform state was not found at the selected StatePath."
    }
    Assert-NoExistingReparsePoint -Path $sourcePath -ParameterName "StatePath"

    $destinationDirectory = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
        $localAppData = [System.Environment]::GetFolderPath(
            [System.Environment+SpecialFolder]::LocalApplicationData
        )
        if ([string]::IsNullOrWhiteSpace($localAppData)) {
            throw "LOCALAPPDATA could not be resolved; provide OutputDirectory explicitly."
        }
        Join-Path $localAppData "SchoolPilot\terraform-state-backups"
    }
    else {
        $OutputDirectory
    }
    $destinationDirectory = Get-AbsolutePath -Path $destinationDirectory -ParameterName "OutputDirectory"
    Assert-OutsideRepository -Path $destinationDirectory -ParameterName "OutputDirectory"

    if ([System.IO.File]::Exists($destinationDirectory)) {
        throw "OutputDirectory refers to a file, not a directory."
    }
    [void][System.IO.Directory]::CreateDirectory($destinationDirectory)
    Assert-OutsideRepository -Path $destinationDirectory -ParameterName "OutputDirectory"

    $metadata = Get-BackupMetadata
    $destinationPath = Join-Path $destinationDirectory "$($metadata.FileStem).dpapi"
    Assert-OutsideRepository -Path $destinationPath -ParameterName "Backup destination"
    if ([System.IO.Path]::GetFileName($destinationPath) -cne "$($metadata.FileStem).dpapi") {
        throw "The backup usage metadata could not be encoded in the destination filename."
    }

    $recoveryTargetPath = $null
    $effectiveRecoveryPassphrase = $RecoveryPassphrase
    $isRolloutBackup = $Usage -in @("Before", "After")
    if ($isRolloutBackup -and [string]::IsNullOrWhiteSpace($RecoveryPath)) {
        throw "Before/After rollout backups require an AES-GCM RecoveryPath under the configured OneDrive\SchoolPilot-Recovery directory."
    }
    if (-not [string]::IsNullOrWhiteSpace($RecoveryPath)) {
        $recoveryTargetPath = Get-AbsolutePath -Path $RecoveryPath -ParameterName "RecoveryPath"
        Assert-OutsideRepository -Path $recoveryTargetPath -ParameterName "RecoveryPath"
        if ($isRolloutBackup) {
            $requiredRecoveryRoot = Get-OneDriveRecoveryRoot
            if (-not (Test-IsInsidePath -Path $recoveryTargetPath -Parent $requiredRecoveryRoot)) {
                throw "Before/After RecoveryPath must be under $requiredRecoveryRoot."
            }
        }
        if ([System.IO.Path]::GetExtension($recoveryTargetPath) -cne ".aesgcm") {
            throw "RecoveryPath must use the .aesgcm extension."
        }
        if ([System.IO.File]::Exists($recoveryTargetPath) -or [System.IO.Directory]::Exists($recoveryTargetPath)) {
            throw "RecoveryPath already exists; recovery copies never overwrite files or directories."
        }
        if ([string]::Equals($recoveryTargetPath, $destinationPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "RecoveryPath must differ from the DPAPI backup destination."
        }

        $recoveryDirectory = [System.IO.Path]::GetDirectoryName($recoveryTargetPath)
        if ([string]::IsNullOrWhiteSpace($recoveryDirectory)) {
            throw "RecoveryPath must include a parent directory."
        }
        Assert-OutsideRepository -Path $recoveryDirectory -ParameterName "RecoveryPath parent"
        [void][System.IO.Directory]::CreateDirectory($recoveryDirectory)
        Assert-OutsideRepository -Path $recoveryDirectory -ParameterName "RecoveryPath parent"

        if ($null -eq $effectiveRecoveryPassphrase) {
            $effectiveRecoveryPassphrase = Read-Host -Prompt "Recovery passphrase (not displayed)" -AsSecureString
        }
    }
    elseif ($null -ne $effectiveRecoveryPassphrase) {
        throw "RecoveryPassphrase is valid only when RecoveryPath is provided."
    }

    $stateBytes = $null
    $stateDigest = $null
    $envelope = $null
    $verified = $null
    $created = $false
    $metadataBytes = $null
    $recoveryEnvelope = $null
    $verifiedRecovery = $null
    $recoveryCreated = $false

    try {
        $stateBytes = Read-LockedBytes -Path $sourcePath -Description "Terraform state"
        $stateDigest = Get-Sha256 -Bytes $stateBytes
        $envelope = New-EncryptedEnvelope -StateBytes $stateBytes -StateDigest $stateDigest
        Write-BytesCreateNew -Path $destinationPath -Bytes $envelope
        $created = $true

        Assert-OutsideRepository -Path $destinationPath -ParameterName "Backup destination"
        $verified = Read-VerifiedBackup -Path $destinationPath
        if (-not (Test-ByteArraysEqual -Left $stateDigest -Right $verified.Digest)) {
            throw "The encrypted backup did not match the source state."
        }

        if ($null -ne $recoveryTargetPath) {
            $metadataBytes = Get-RecoveryMetadataBytes -Metadata $metadata
            $recoveryEnvelope = New-RecoveryEnvelope `
                -StateBytes $stateBytes `
                -StateDigest $stateDigest `
                -MetadataBytes $metadataBytes `
                -Passphrase $effectiveRecoveryPassphrase
            Write-BytesCreateNew -Path $recoveryTargetPath -Bytes $recoveryEnvelope
            $recoveryCreated = $true
            Assert-OutsideRepository -Path $recoveryTargetPath -ParameterName "RecoveryPath"
            $verifiedRecovery = Read-VerifiedRecoveryBackup `
                -Path $recoveryTargetPath `
                -Passphrase $effectiveRecoveryPassphrase `
                -ExpectedMetadata $metadata
            if (-not (Test-ByteArraysEqual -Left $stateDigest -Right $verifiedRecovery.Digest)) {
                throw "The AES-GCM recovery backup did not match the source state."
            }
        }

        Write-Host "Verified $($metadata.Usage) Terraform state backup for phase '$($metadata.Phase)': $destinationPath"
        if ($null -ne $recoveryTargetPath) {
            Write-Host "Verified AES-256-GCM recovery copy created: $recoveryTargetPath"
        }
    }
    catch {
        $failure = $_
        if ($recoveryCreated) {
            try {
                [System.IO.File]::Delete($recoveryTargetPath)
            }
            catch {
                # Preserve the original failure; incomplete recovery output is never reported as successful.
            }
        }
        if ($created) {
            try {
                [System.IO.File]::Delete($destinationPath)
            }
            catch {
                # Preserve the original failure; the incomplete path is never reported as successful.
            }
        }
        throw $failure
    }
    finally {
        if ($null -ne $verified) {
            Clear-ByteArray -Bytes $verified.Data
            Clear-ByteArray -Bytes $verified.Digest
        }
        if ($null -ne $verifiedRecovery) {
            Clear-ByteArray -Bytes $verifiedRecovery.Data
            Clear-ByteArray -Bytes $verifiedRecovery.Digest
        }
        Clear-ByteArray -Bytes $stateBytes
        Clear-ByteArray -Bytes $stateDigest
        Clear-ByteArray -Bytes $envelope
        Clear-ByteArray -Bytes $metadataBytes
        Clear-ByteArray -Bytes $recoveryEnvelope
    }
}

function Invoke-Restore {
    if ([string]::IsNullOrWhiteSpace($BackupPath)) {
        throw "BackupPath is required in Restore mode."
    }
    if ([string]::IsNullOrWhiteSpace($RestorePath)) {
        throw "RestorePath is required in Restore mode."
    }

    $encryptedPath = Get-AbsolutePath -Path $BackupPath -ParameterName "BackupPath"
    $targetPath = Get-AbsolutePath -Path $RestorePath -ParameterName "RestorePath"
    Assert-OutsideRepository -Path $encryptedPath -ParameterName "BackupPath"
    Assert-OutsideRepository -Path $targetPath -ParameterName "RestorePath"

    if (-not [System.IO.File]::Exists($encryptedPath)) {
        throw "The selected encrypted backup does not exist."
    }
    Assert-NoExistingReparsePoint -Path $encryptedPath -ParameterName "BackupPath"
    if ([System.IO.File]::Exists($targetPath) -or [System.IO.Directory]::Exists($targetPath)) {
        throw "RestorePath already exists; restore never overwrites files or directories."
    }

    $targetDirectory = [System.IO.Path]::GetDirectoryName($targetPath)
    if ([string]::IsNullOrWhiteSpace($targetDirectory)) {
        throw "RestorePath must include a parent directory."
    }
    Assert-OutsideRepository -Path $targetDirectory -ParameterName "RestorePath parent"
    [void][System.IO.Directory]::CreateDirectory($targetDirectory)
    Assert-OutsideRepository -Path $targetDirectory -ParameterName "RestorePath parent"

    $verified = $null
    $restoredBytes = $null
    $restoredDigest = $null
    $created = $false
    $isRecoveryBackup = $false
    $effectiveRecoveryPassphrase = $RecoveryPassphrase

    try {
        $isRecoveryBackup = Test-IsRecoveryBackup -Path $encryptedPath
        if ($isRecoveryBackup) {
            if ($null -eq $effectiveRecoveryPassphrase) {
                $effectiveRecoveryPassphrase = Read-Host -Prompt "Recovery passphrase (not displayed)" -AsSecureString
            }
            $verified = Read-VerifiedRecoveryBackup `
                -Path $encryptedPath `
                -Passphrase $effectiveRecoveryPassphrase
        }
        else {
            $verified = Read-VerifiedBackup -Path $encryptedPath
        }
        Write-BytesCreateNew -Path $targetPath -Bytes $verified.Data
        $created = $true
        Assert-OutsideRepository -Path $targetPath -ParameterName "RestorePath"

        $restoredBytes = Read-LockedBytes -Path $targetPath -Description "Restored state"
        $restoredDigest = Get-Sha256 -Bytes $restoredBytes
        if (-not (Test-ByteArraysEqual -Left $verified.Digest -Right $restoredDigest)) {
            throw "The restored state failed its post-write integrity check."
        }

        $backupKind = if ($isRecoveryBackup) { "AES-256-GCM recovery" } else { "DPAPI" }
        Write-Host "Verified $backupKind Terraform state restore created: $targetPath"
    }
    catch {
        $failure = $_
        if ($created) {
            try {
                [System.IO.File]::Delete($targetPath)
            }
            catch {
                # Preserve the original failure; the incomplete path is never reported as successful.
            }
        }
        throw $failure
    }
    finally {
        if ($null -ne $verified) {
            Clear-ByteArray -Bytes $verified.Data
            Clear-ByteArray -Bytes $verified.Digest
        }
        Clear-ByteArray -Bytes $restoredBytes
        Clear-ByteArray -Bytes $restoredDigest
    }
}

try {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw "This tool requires Windows CurrentUser DPAPI."
    }

    if ($Mode -eq "Backup") {
        if (-not [string]::IsNullOrWhiteSpace($BackupPath) -or -not [string]::IsNullOrWhiteSpace($RestorePath)) {
            throw "BackupPath and RestorePath are valid only in Restore mode."
        }
        Invoke-Backup
    }
    else {
        if (-not [string]::IsNullOrWhiteSpace($StatePath) -or -not [string]::IsNullOrWhiteSpace($OutputDirectory)) {
            throw "StatePath and OutputDirectory are valid only in Backup mode."
        }
        if (-not [string]::IsNullOrWhiteSpace($RecoveryPath)) {
            throw "RecoveryPath is valid only in Backup mode; use BackupPath to restore a recovery copy."
        }
        if ($Phase -cne "manual" -or $Usage -cne "Manual") {
            throw "Phase and Usage are valid only in Backup mode."
        }
        Invoke-Restore
    }
}
catch {
    [Console]::Error.WriteLine("Terraform state operation failed: {0}", $_.Exception.Message)
    exit 1
}
