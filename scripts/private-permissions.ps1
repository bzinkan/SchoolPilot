# Private path checks extracted without behavior changes from the runtime tool.
# This standalone helper imports no deployment or rollout code.

function Test-IsPathWithin {
    param([Parameter(Mandatory = $true)][string]$Candidate, [Parameter(Mandatory = $true)][string]$Parent)
    $candidatePath = [IO.Path]::GetFullPath($Candidate)
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    return $candidatePath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePointInExistingPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Private runtime paths must not traverse a reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Set-PrivatePathPermissions {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Directory)
    if ($IsWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $ownerSid = $identity.User
        $systemSid = [Security.Principal.SecurityIdentifier]::new(
            [Security.Principal.WellKnownSidType]::LocalSystemSid, $null
        )
        $security = Get-Acl -LiteralPath $Path
        if ($Directory) {
            $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        else {
            $inheritance = [Security.AccessControl.InheritanceFlags]::None
        }
        $security.SetAccessRuleProtection($true, $false)
        foreach ($identityReference in @($security.Access | ForEach-Object { $_.IdentityReference } | Sort-Object Value -Unique)) {
            $security.PurgeAccessRules($identityReference)
        }
        foreach ($sid in @($ownerSid, $systemSid)) {
            [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
                [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow
            ))
        }
        if ($Directory) {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), [Security.AccessControl.DirectorySecurity]$security)
        }
        else {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path), [Security.AccessControl.FileSecurity]$security)
        }
        $observed = Get-Acl -LiteralPath $Path
        $allowedSids = @($ownerSid.Value, $systemSid.Value)
        if (-not $observed.AreAccessRulesProtected -or @($observed.Access | Where-Object {
            $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids
        }).Count -gt 0) {
            throw "Private runtime material permissions did not converge to operator-and-SYSTEM only."
        }
        return
    }
    $mode = if ($Directory) {
        [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute
    } else {
        [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite
    }
    [IO.File]::SetUnixFileMode($Path, $mode)
}

function Assert-PrivatePathPermissions {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Directory)
    if ($IsWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $ownerSid = $identity.User.Value
        $systemSid = [Security.Principal.SecurityIdentifier]::new(
            [Security.Principal.WellKnownSidType]::LocalSystemSid, $null
        ).Value
        $security = Get-Acl -LiteralPath $Path
        $allowedSids = @($ownerSid, $systemSid)
        $allowedRules = @($security.Access | Where-Object {
            $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
        })
        if (-not $security.AreAccessRulesProtected -or $allowedRules.Count -eq 0 -or
            @($allowedRules | Where-Object {
                $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids
            }).Count -gt 0 -or
            @($allowedRules | Where-Object {
                $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $ownerSid
            }).Count -eq 0) {
            throw "Private runtime material must be accessible only to the operator and SYSTEM."
        }
        return
    }
    $mode = [IO.File]::GetUnixFileMode($Path)
    $sharedBits = [IO.UnixFileMode]::GroupRead -bor [IO.UnixFileMode]::GroupWrite -bor [IO.UnixFileMode]::GroupExecute -bor
        [IO.UnixFileMode]::OtherRead -bor [IO.UnixFileMode]::OtherWrite -bor [IO.UnixFileMode]::OtherExecute
    if (($mode -band $sharedBits) -ne 0) {
        throw "Private runtime material must use owner-only permissions."
    }
}

function Assert-PrivateInputPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot
    )
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "Runtime configuration inputs require absolute paths." }
    Assert-NoReparsePointInExistingPath -Path $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Runtime configuration inputs must be regular private files."
    }
    if (Test-IsPathWithin -Candidate $item.FullName -Parent $RepositoryRoot) {
        throw "Runtime configuration inputs must stay outside the repository."
    }
    Assert-PrivatePathPermissions -Path $item.FullName
    return $item.FullName
}
