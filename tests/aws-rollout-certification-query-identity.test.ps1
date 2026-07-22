#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$supervisorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\start-aws-rollout-supervisor.ps1"))
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($supervisorPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Unable to parse the rollout supervisor." }
foreach ($name in @(
    "Resolve-ExternalPath", "Get-RequiredProperty", "Get-CertificationValue", "Get-CertificationSha256",
    "Get-CertificationTextSha256", "Assert-CertificationSha256", "Assert-CertificationEvidenceReference",
    "Assert-CertificationPrivateFileAcl", "Set-CertificationPrivateFileAcl",
    "Write-CertificationPrivateImmutableJson",
    "Get-CertificationHistoryFallbackQueryIdentity"
)) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing supervisor function $name." }
    Invoke-Expression $definition.Extent.Text
}

$script:RequiredHistoryFallbackQueryIdentityVersion = "history-fallback-queryid-v1"
$script:RequiredHistoryFallbackPiEvidenceVersion = "queryid-sqlstats-v1"
$appSha = "1" * 40
$digest = "sha256:" + ("2" * 64)
$apiArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:27"
$workerArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:45"
$parameterSignatureSha = Get-CertificationTextSha256 `
    '["$1:text[]:student_ids","$2:text[]:device_ids","$3:text:school_id","$4:bigint:history_limit"]'

function Set-TestPrivateAcl {
    param([string]$Path)
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $item = Get-Item -LiteralPath $Path
    $security = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, [Security.AccessControl.AccessControlSections]::Access
    )
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($security.GetAccessRules(
            $true, $true, [Security.Principal.SecurityIdentifier]
        ))) {
        [void]$security.RemoveAccessRuleSpecific($existingRule)
    }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $current.User,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]::None,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
}

function Set-TestMalformedPrivateAcl {
    param(
        [string]$Path,
        [Security.AccessControl.AccessControlType]$AccessType,
        [Security.AccessControl.FileSystemRights]$Rights,
        [switch]$Empty
    )
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $item = Get-Item -LiteralPath $Path
    $security = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, [Security.AccessControl.AccessControlSections]::Access
    )
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($security.GetAccessRules(
            $true, $true, [Security.Principal.SecurityIdentifier]
        ))) {
        [void]$security.RemoveAccessRuleSpecific($existingRule)
    }
    if (-not $Empty) {
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $current.User,
            $Rights,
            [Security.AccessControl.InheritanceFlags]::None,
            [Security.AccessControl.PropagationFlags]::None,
            $AccessType
        ))
    }
    [IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
}

$aclRegressionPath = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-certification-acl-$([Guid]::NewGuid().ToString('N')).json"
try {
    [IO.File]::WriteAllText($aclRegressionPath, '{}', [Text.UTF8Encoding]::new($false))
    $aclItem = Get-Item -LiteralPath $aclRegressionPath
    $seedAcl = [IO.FileSystemAclExtensions]::GetAccessControl(
        $aclItem, [Security.AccessControl.AccessControlSections]::Access
    )
    $seedAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
        [Security.AccessControl.FileSystemRights]::ReadData,
        [Security.AccessControl.InheritanceFlags]::None,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.FileSystemAclExtensions]::SetAccessControl($aclItem, $seedAcl)
    Set-CertificationPrivateFileAcl $aclRegressionPath
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = Get-Acl -LiteralPath $aclRegressionPath
    $allowSids = @($acl.Access | Where-Object AccessControlType -eq Allow | ForEach-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    })
    Assert-Condition ($acl.AreAccessRulesProtected -and $allowSids.Count -eq 1 -and
        $allowSids[0] -ceq $currentSid) 'The certification ACL setter must remove every pre-existing explicit allow ACE.'
}
finally {
    if (Test-Path -LiteralPath $aclRegressionPath) { Remove-Item -LiteralPath $aclRegressionPath -Force }
}

function Write-TestReceipt {
    param([string]$Path, [string]$QueryIdentifier, [hashtable]$Overrides = @{})
    $receipt = [ordered]@{
        schemaVersion=1;type="history_fallback_query_identity_receipt";identityVersion="history-fallback-queryid-v1"
        queryIdentifier=$QueryIdentifier;queryIdentifierSha256=Get-CertificationTextSha256 $QueryIdentifier
        compiledSqlSha256="3"*64;parameterTypeSignatureSha256=$parameterSignatureSha
        engineVersion="16.4";schemaIdentitySha256="4"*64;trackIoTiming=$true;databaseResourceId="db-JX7VX4P2ZHF5JXA6N5EREVL54I"
        applicationGitSha=$appSha;deployedImageDigest=$digest
        activeApiTaskDefinitionArn=$apiArn;activeWorkerTaskDefinitionArn=$workerArn
    }
    foreach ($key in $Overrides.Keys) { $receipt[$key] = $Overrides[$key] }
    [IO.File]::WriteAllText($Path, ($receipt | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    Set-TestPrivateAcl $Path
}

function Get-TestBinding {
    param([string]$Path, [string]$PiVersion = "queryid-sqlstats-v1")
    $certification = [pscustomobject]@{
        historyFallbackPiEvidenceVersion=$PiVersion
        historyFallbackQueryIdentity=[pscustomobject]@{path=$Path;sha256=Get-CertificationSha256 $Path}
    }
    return (Get-CertificationHistoryFallbackQueryIdentity $certification $appSha $digest $apiArn $workerArn).Public
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-cert-queryid-$([Guid]::NewGuid().ToString('N'))"
[void][IO.Directory]::CreateDirectory($tempRoot)
$assertions = 0
try {
    $tempRootItem = Get-Item -LiteralPath $tempRoot
    $tempRootAcl = [IO.FileSystemAclExtensions]::GetAccessControl(
        $tempRootItem, [Security.AccessControl.AccessControlSections]::Access
    )
    $tempRootAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
            [Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.FileSystemAclExtensions]::SetAccessControl($tempRootItem, $tempRootAcl)
    $privateWriterPath = Join-Path $tempRoot 'private-writer.json'
    Write-CertificationPrivateImmutableJson $privateWriterPath ([ordered]@{schemaVersion=1;private=$true})
    $privateWriterAcl = [IO.FileSystemAclExtensions]::GetAccessControl(
        (Get-Item -LiteralPath $privateWriterPath), [Security.AccessControl.AccessControlSections]::Access
    )
    $privateWriterRules = @($privateWriterAcl.GetAccessRules(
        $true, $true, [Security.Principal.SecurityIdentifier]
    ))
    Assert-Condition ($privateWriterAcl.AreAccessRulesProtected -and $privateWriterRules.Count -eq 1 -and
        $privateWriterRules[0].IdentityReference.Value -ceq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -and
        $privateWriterRules[0].FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
        @(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter '*.private.*').Count -eq 0) `
        'The certification private writer must remove inherited access and clean its staging directory.'
    $assertions++

    $privateWriterDefinition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Write-CertificationPrivateImmutableJson'
    }, $true)
    $privateWriterSource = $privateWriterDefinition.Extent.Text
    $stagingAclIndex = $privateWriterSource.IndexOf('Set-CertificationPrivateFileAcl $stagingDirectory', [StringComparison]::Ordinal)
    $emptyFileIndex = $privateWriterSource.IndexOf('[IO.File]::Open(', [StringComparison]::Ordinal)
    $fileAclIndex = $privateWriterSource.IndexOf('Set-CertificationPrivateFileAcl $temporary', [StringComparison]::Ordinal)
    $sensitiveWriteIndex = $privateWriterSource.IndexOf('[IO.File]::WriteAllText(', [StringComparison]::Ordinal)
    Assert-Condition ($stagingAclIndex -ge 0 -and $emptyFileIndex -gt $stagingAclIndex -and
        $fileAclIndex -gt $emptyFileIndex -and $sensitiveWriteIndex -gt $fileAclIndex) `
        'The certification writer must protect an empty staging directory and file before writing evidence.'
    $assertions++

    foreach ($malformedAcl in @(
        [ordered]@{name='empty DACL';empty=$true;type=[Security.AccessControl.AccessControlType]::Allow;rights=[Security.AccessControl.FileSystemRights]::FullControl},
        [ordered]@{name='insufficient rights';empty=$false;type=[Security.AccessControl.AccessControlType]::Allow;rights=[Security.AccessControl.FileSystemRights]::ReadData},
        [ordered]@{name='deny-only DACL';empty=$false;type=[Security.AccessControl.AccessControlType]::Deny;rights=[Security.AccessControl.FileSystemRights]::FullControl}
    )) {
        $malformedAclPath = Join-Path $tempRoot `
            "malformed-private-acl-$([Guid]::NewGuid().ToString('N')).json"
        try {
            [IO.File]::WriteAllText($malformedAclPath, '{}', [Text.UTF8Encoding]::new($false))
            Set-TestMalformedPrivateAcl -Path $malformedAclPath -AccessType $malformedAcl.type `
                -Rights $malformedAcl.rights -Empty:([bool]$malformedAcl.empty)
            $malformedRejected = $false
            try { Assert-CertificationPrivateFileAcl $malformedAclPath 'malformed private receipt' }
            catch { $malformedRejected = $true }
            Assert-Condition $malformedRejected `
                "The private receipt validator must reject a $($malformedAcl.name)."
            $assertions++
        }
        finally {
            if (Test-Path -LiteralPath $malformedAclPath) {
                Set-TestPrivateAcl $malformedAclPath
                Remove-Item -LiteralPath $malformedAclPath -Force
            }
        }
    }

    foreach ($queryIdentifier in @("9223372036854775807", "-9223372036854775808")) {
        $path = Join-Path $tempRoot "query-$([Guid]::NewGuid().ToString('N')).json"
        Write-TestReceipt $path $queryIdentifier
        $binding = Get-TestBinding $path
        $serialized = $binding | ConvertTo-Json -Depth 20 -Compress
        Assert-Condition ($binding.version -eq "history-fallback-queryid-v1" -and
            $binding.queryIdentifierSha256 -eq (Get-CertificationTextSha256 $queryIdentifier) -and
            $binding.parameterTypeSignatureSha256 -eq $parameterSignatureSha -and
            $binding.trackIoTiming -eq $true -and
            $binding.piEvidenceVersion -eq "queryid-sqlstats-v1") `
            "The supervisor must preserve exact signed-64-bit query identity hashes, track_io_timing, and evidence versions."
        $assertions++
        Assert-Condition (-not $serialized.Contains($queryIdentifier) -and -not $serialized.Contains('"queryIdentifier"')) `
            "Supervisor-chain bindings must not expose the raw PostgreSQL query identifier."
        $assertions++
        Assert-Condition (-not $serialized.Contains("db-JX7VX4P2ZHF5JXA6N5EREVL54I") -and
            $binding.databaseResourceIdSha256 -eq (Get-CertificationTextSha256 "db-JX7VX4P2ZHF5JXA6N5EREVL54I")) `
            "Supervisor-chain bindings must expose only the native database-resource ID hash."
        $assertions++
        Assert-Condition (-not $serialized.Contains($path) -and
            $binding.receiptPathSha256 -eq (Get-CertificationTextSha256 $path)) `
            "Supervisor-chain bindings must expose only the private receipt path hash."
        $assertions++
    }

    foreach ($invalid in @("0", "+1", "01", "9223372036854775808", "-9223372036854775809")) {
        $path = Join-Path $tempRoot "invalid-$([Guid]::NewGuid().ToString('N')).json"
        Write-TestReceipt $path $invalid
        $rejected = $false
        try { Get-TestBinding $path | Out-Null }
        catch { $rejected = $_.Exception.Message -match "nonzero signed PostgreSQL 64-bit" }
        Assert-Condition $rejected "The supervisor must reject noncanonical, zero, or out-of-range query identifier '$invalid'."
        $assertions++
    }

    $wrongHashPath = Join-Path $tempRoot "wrong-hash.json"
    Write-TestReceipt $wrongHashPath "-123" @{queryIdentifierSha256="f"*64}
    $wrongHashRejected = $false
    try { Get-TestBinding $wrongHashPath | Out-Null } catch { $wrongHashRejected = $true }
    Assert-Condition $wrongHashRejected "A query identifier whose hash does not match must be rejected."
    $assertions++

    $wrongSignaturePath = Join-Path $tempRoot "wrong-signature.json"
    Write-TestReceipt $wrongSignaturePath "123" @{parameterTypeSignatureSha256="e"*64}
    $wrongSignatureRejected = $false
    try { Get-TestBinding $wrongSignaturePath | Out-Null } catch { $wrongSignatureRejected = $true }
    Assert-Condition $wrongSignatureRejected "A different fallback parameter signature must be rejected."
    $assertions++

    $wrongReleasePath = Join-Path $tempRoot "wrong-release.json"
    Write-TestReceipt $wrongReleasePath "123" @{applicationGitSha="9"*40}
    $wrongReleaseRejected = $false
    try { Get-TestBinding $wrongReleasePath | Out-Null } catch { $wrongReleaseRejected = $_.Exception.Message -match "exact database, release" }
    Assert-Condition $wrongReleaseRejected "A receipt from another release must not seed certification."
    $assertions++

    $missingTrackIoPath = Join-Path $tempRoot "track-io-disabled.json"
    Write-TestReceipt $missingTrackIoPath "123" @{trackIoTiming=$false}
    $missingTrackIoRejected = $false
    try { Get-TestBinding $missingTrackIoPath | Out-Null }
    catch { $missingTrackIoRejected = $_.Exception.Message -match "exact database, release" }
    Assert-Condition $missingTrackIoRejected "The private query-identity receipt must bind track_io_timing=true."
    $assertions++

    $wrongTaskPath = Join-Path $tempRoot "wrong-task.json"
    Write-TestReceipt $wrongTaskPath "123" @{activeApiTaskDefinitionArn="arn:aws:ecs:us-east-1:135775632425:task-definition/other:1"}
    $wrongTaskRejected = $false
    try { Get-TestBinding $wrongTaskPath | Out-Null } catch { $wrongTaskRejected = $_.Exception.Message -match "exact database, release" }
    Assert-Condition $wrongTaskRejected "A receipt from another active task revision must not seed certification."
    $assertions++

    $wrongVersionPath = Join-Path $tempRoot "wrong-version.json"
    Write-TestReceipt $wrongVersionPath "123" @{identityVersion="history-fallback-markers-v0"}
    $wrongVersionRejected = $false
    try { Get-TestBinding $wrongVersionPath | Out-Null } catch { $wrongVersionRejected = $true }
    Assert-Condition $wrongVersionRejected "Historical marker-only identity evidence must be rejected."
    $assertions++

    $piVersionPath = Join-Path $tempRoot "wrong-pi-version.json"
    Write-TestReceipt $piVersionPath "123"
    $piVersionRejected = $false
    try { Get-TestBinding $piVersionPath "top-load-markers-v0" | Out-Null }
    catch { $piVersionRejected = $_.Exception.Message -match "deterministic queryid SQL-statistics" }
    Assert-Condition $piVersionRejected "Historical top-load PI evidence must not enter a new certification chain."
    $assertions++

    $inheritedAclPath = Join-Path $tempRoot "inherited-acl.json"
    Write-TestReceipt $inheritedAclPath "123"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $discarded = & icacls.exe $inheritedAclPath /inheritance:e 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not create inherited ACL test case." }
    $inheritedAclRejected = $false
    try { Get-TestBinding $inheritedAclPath | Out-Null }
    catch { $inheritedAclRejected = $_.Exception.Message -match "disable inherited" }
    Assert-Condition $inheritedAclRejected "The raw query identifier receipt must remain ACL-restricted."
    $assertions++

    $tamperedPath = Join-Path $tempRoot "tampered.json"
    Write-TestReceipt $tamperedPath "123"
    $recordedHash = Get-CertificationSha256 $tamperedPath
    [IO.File]::AppendAllText($tamperedPath, " ")
    $certification = [pscustomobject]@{
        historyFallbackPiEvidenceVersion="queryid-sqlstats-v1"
        historyFallbackQueryIdentity=[pscustomobject]@{path=$tamperedPath;sha256=$recordedHash}
    }
    $tamperRejected = $false
    try { Get-CertificationHistoryFallbackQueryIdentity $certification $appSha $digest $apiArn $workerArn | Out-Null }
    catch { $tamperRejected = $_.Exception.Message -match "changed after its hash" }
    Assert-Condition $tamperRejected "Receipt tampering after hash capture must fail before certification."
    $assertions++
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

Write-Host "AWS rollout certification query-identity tests: PASS ($assertions assertions)"
