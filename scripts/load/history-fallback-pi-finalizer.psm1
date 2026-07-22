#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:HfRepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:HfRequestType = "history_fallback_pi_finalization_request"
$script:HfReceiptType = "history_fallback_pi_evidence_receipt"
$script:HfIdentityReceiptType = "history_fallback_query_identity_receipt"
$script:HfIdentityVersion = "history-fallback-queryid-v1"
$script:HfPiEvidenceVersion = "queryid-sqlstats-v1"
$script:HfCollectorVersion = "post-traffic-v2"
$script:HfParameterTypeSignatureJson = '["$1:text[]:student_ids","$2:text[]:device_ids","$3:text:school_id","$4:bigint:history_limit"]'
$script:HfHotPathSummaryEvent = "classpilot_heartbeat_hot_path_summary"
$script:HfHotPathSummaryIntervalSeconds = 60
$script:HfMarkers = @("requested_tiles", "heartbeats", "lateral")
$script:HfPeriodSeconds = 60
$script:HfMaximumPages = 100
$script:HfMaximumRecords = 10000
$script:HfAwsTimeoutSeconds = 60
$script:HfAwsMaximumAttempts = 4
$script:HfAwsRetryDelaysSeconds = @(0, 1, 2, 4)
$script:HfInitialDelayMinutes = 5
$script:HfDeadlineMinutes = 15
$script:HfPollSeconds = 60
$script:HfIoThresholdPercent = 50.0
$script:HfWaitCoverageTolerancePercent = 0.5
$script:HfSqlStatsMetrics = [ordered]@{
    calls = "db.sql_tokenized.stats.calls_per_sec.avg"
    totalTime = "db.sql_tokenized.stats.total_time_per_sec.avg"
    blockReadTime = "db.sql_tokenized.stats.blk_read_time_per_sec.avg"
    sharedBlocksRead = "db.sql_tokenized.stats.shared_blks_read_per_sec.avg"
    tempBlocksRead = "db.sql_tokenized.stats.temp_blks_read_per_sec.avg"
    tempBlocksWritten = "db.sql_tokenized.stats.temp_blks_written_per_sec.avg"
}

function Get-HfValue {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    if ($Object -is [Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Get-HfRequiredValue {
    param($Object, [string]$Name)
    $value = Get-HfValue $Object $Name $null
    if ($null -eq $value -or ($value -is [string] -and [string]::IsNullOrWhiteSpace($value))) {
        throw "History fallback PI finalization requires '$Name'."
    }
    return $value
}

function Get-HfTextSha256 {
    param([string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.UTF8Encoding]::new($false).GetBytes($Text)
    )).ToLowerInvariant()
}

function Get-HfFileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-HfCanonicalSha256 {
    param($Value)
    return Get-HfTextSha256 ($Value | ConvertTo-Json -Depth 60 -Compress)
}

function Get-HfCeilingMinute {
    param([DateTimeOffset]$Value)
    $utc = $Value.ToUniversalTime()
    $minuteMs = 60000L
    $milliseconds = $utc.ToUnixTimeMilliseconds()
    $aligned = if (($milliseconds % $minuteMs) -eq 0) { $milliseconds } else {
        ([long][math]::Floor($milliseconds / [double]$minuteMs) + 1L) * $minuteMs
    }
    return [DateTimeOffset]::FromUnixTimeMilliseconds($aligned)
}

function Get-HfFloorMinute {
    param([DateTimeOffset]$Value)
    $milliseconds = $Value.ToUniversalTime().ToUnixTimeMilliseconds()
    return [DateTimeOffset]::FromUnixTimeMilliseconds(
        [long][math]::Floor($milliseconds / 60000.0) * 60000L
    )
}

function Assert-HfSha256 {
    param([string]$Value, [string]$Name, [switch]$ImageDigest)
    $normalized = $Value.Trim().ToLowerInvariant()
    $pattern = if ($ImageDigest) { '^sha256:[0-9a-f]{64}$' } else { '^[0-9a-f]{64}$' }
    if ($normalized -notmatch $pattern) { throw "$Name must be an exact SHA-256 value." }
    return $normalized
}

function Assert-HfBoundedText {
    param([string]$Value, [string]$Name, [int]$MaximumLength = 512)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt $MaximumLength -or
        $Value -match '[\u0000-\u001f\u007f]') {
        throw "$Name must be bounded non-control text."
    }
    return $Value
}

function Assert-HfSafeIdentifier {
    param([string]$Value, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 128 -or
        $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $Value.EndsWith('.')) {
        throw "$Name must be a filename-safe identifier."
    }
    return $Value
}

function Resolve-HfExternalPath {
    param([string]$Path, [string]$Name, [switch]$AllowMissing)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path) -or
        $Path.StartsWith("\\?\") -or $Path.StartsWith("\\.\")) {
        throw "$Name must be an ordinary absolute path outside the repository."
    }
    $absolute = [IO.Path]::GetFullPath($Path)
    $root = $script:HfRepositoryRoot.TrimEnd('\', '/')
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if ([string]::Equals($absolute, $root, $comparison) -or
        $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw "$Name must remain outside the repository."
    }
    $cursor = if ($AllowMissing) { [IO.Path]::GetDirectoryName($absolute) } else { $absolute }
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Name must not traverse a reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $absolute -PathType Leaf)) {
        throw "$Name does not exist."
    }
    if ($AllowMissing) {
        $parentPath = [IO.Path]::GetDirectoryName($absolute)
        if ([string]::IsNullOrWhiteSpace($parentPath) -or -not (Test-Path -LiteralPath $parentPath -PathType Container)) {
            throw "$Name parent directory must already exist."
        }
    }
    return $absolute
}

function Assert-HfPrivateAcl {
    param([string]$Path, [string]$Name)
    if (-not $IsWindows) { throw "$Name requires Windows ACL enforcement." }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $item = Get-Item -LiteralPath $Path
    $acl = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, [Security.AccessControl.AccessControlSections]::Access
    )
    if (-not $acl.AreAccessRulesProtected) { throw "$Name must disable inherited file access." }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 1) { throw "$Name must be readable only by the current certification operator." }
    $rule = $rules[0]
    if ($rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.IdentityReference.Value -cne $currentSid -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw "$Name must have one exact current-operator FullControl rule."
    }
}

function Set-HfPrivateAcl {
    param([string]$Path)
    if (-not $IsWindows) { throw "History fallback PI receipts require Windows ACL enforcement." }
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
    Assert-HfPrivateAcl $Path "historyFallbackPiEvidenceReceipt"
}

function Write-HfPrivateImmutableJson {
    param([string]$Path, $Value)
    if (Test-Path -LiteralPath $Path) {
        throw "The immutable history fallback PI evidence receipt already exists; use a fresh path."
    }
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    $stagingDirectory = Join-Path $parent `
        ".$([IO.Path]::GetFileName($Path)).private.$([Guid]::NewGuid().ToString('N'))"
    $temporary = Join-Path $stagingDirectory "payload.json"
    try {
        # Protect an empty staging directory and file before materializing any
        # private evidence beneath a potentially permissive caller-owned parent.
        [void](New-Item -ItemType Directory -Path $stagingDirectory)
        Set-HfPrivateAcl $stagingDirectory
        $empty = [IO.File]::Open(
            $temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None
        )
        $empty.Dispose()
        Set-HfPrivateAcl $temporary
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 60), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, $Path)
        Assert-HfPrivateAcl $Path "historyFallbackPiEvidenceReceipt"
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $stagingDirectory -PathType Container) {
            Remove-Item -LiteralPath $stagingDirectory -Force
        }
    }
}

function Assert-HfPrivateReference {
    param($Reference, [string]$Name)
    $path = Resolve-HfExternalPath ([string](Get-HfRequiredValue $Reference "path")) "$Name.path"
    $expected = Assert-HfSha256 ([string](Get-HfRequiredValue $Reference "sha256")) "$Name.sha256"
    $actual = Get-HfFileSha256 $path
    if ($actual -cne $expected) { throw "$Name changed after its hash was recorded." }
    Assert-HfPrivateAcl $path $Name
    return [pscustomobject]@{ Path=$path;Sha256=$actual }
}

function Assert-HfTaskDefinitionArn {
    param([string]$Arn, [string]$Name, [string]$Region, [string]$AccountId, [string]$FamilyMarker)
    $escapedRegion = [Regex]::Escape($Region)
    $escapedAccount = [Regex]::Escape($AccountId)
    $match = [Regex]::Match($Arn, "^arn:aws:ecs:$escapedRegion`:$escapedAccount`:task-definition/([A-Za-z0-9_-]+):([1-9][0-9]*)$")
    if (-not $match.Success -or -not $match.Groups[1].Value.Contains($FamilyMarker, [StringComparison]::Ordinal)) {
        throw "$Name must bind one exact revisioned production task definition."
    }
    return $Arn
}

function Assert-HfCanonicalQueryIdentifier {
    param([string]$Value)
    $parsed = [Numerics.BigInteger]::Zero
    if ($Value -notmatch '^-?(?:[1-9][0-9]{0,18})$' -or
        -not [Numerics.BigInteger]::TryParse($Value, [Globalization.NumberStyles]::AllowLeadingSign,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -or
        $parsed -eq [Numerics.BigInteger]::Zero -or
        $parsed -lt [Numerics.BigInteger]::Parse("-9223372036854775808") -or
        $parsed -gt [Numerics.BigInteger]::Parse("9223372036854775807") -or
        $Value -cne $parsed.ToString([Globalization.CultureInfo]::InvariantCulture)) {
        throw "The query-identity receipt must preserve one canonical nonzero signed 64-bit query identifier."
    }
    return $Value
}

function Read-HfIdentityReceipt {
    param($Reference, $Request)
    $bound = Assert-HfPrivateReference $Reference "historyFallbackQueryIdentity"
    try { $receipt = Get-Content -LiteralPath $bound.Path -Raw | ConvertFrom-Json -Depth 40 -DateKind String }
    catch { throw "The query-identity receipt must contain valid JSON." }
    $queryIdentifier = Assert-HfCanonicalQueryIdentifier ([string](Get-HfRequiredValue $receipt "queryIdentifier"))
    $identityVersion = [string](Get-HfRequiredValue $receipt "identityVersion")
    $queryIdentifierSha256 = Assert-HfSha256 ([string](Get-HfRequiredValue $receipt "queryIdentifierSha256")) `
        "historyFallbackQueryIdentity.queryIdentifierSha256"
    $compiledSqlSha256 = Assert-HfSha256 ([string](Get-HfRequiredValue $receipt "compiledSqlSha256")) `
        "historyFallbackQueryIdentity.compiledSqlSha256"
    $parameterTypeSignatureSha256 = Assert-HfSha256 `
        ([string](Get-HfRequiredValue $receipt "parameterTypeSignatureSha256")) `
        "historyFallbackQueryIdentity.parameterTypeSignatureSha256"
    $schemaIdentitySha256 = Assert-HfSha256 ([string](Get-HfRequiredValue $receipt "schemaIdentitySha256")) `
        "historyFallbackQueryIdentity.schemaIdentitySha256"
    if ([int](Get-HfValue $receipt "schemaVersion" 0) -ne 1 -or
        [string](Get-HfValue $receipt "type" "") -cne $script:HfIdentityReceiptType -or
        $identityVersion -cne $script:HfIdentityVersion -or
        (Get-HfValue $receipt "trackIoTiming" $false) -ne $true -or
        $queryIdentifierSha256 -cne (Get-HfTextSha256 $queryIdentifier) -or
        $parameterTypeSignatureSha256 -cne (Get-HfTextSha256 $script:HfParameterTypeSignatureJson)) {
        throw "The query-identity receipt does not match the reviewed fallback identity schema."
    }
    $requestIdentity = Get-HfRequiredValue $Request "historyFallbackSqlIdentity"
    foreach ($binding in @(
        @("version", $identityVersion),
        @("queryIdentifierSha256", $queryIdentifierSha256),
        @("compiledSqlSha256", $compiledSqlSha256),
        @("parameterTypeSignatureSha256", $parameterTypeSignatureSha256),
        @("schemaIdentitySha256", $schemaIdentitySha256)
    )) {
        if ([string](Get-HfRequiredValue $requestIdentity $binding[0]) -cne [string]$binding[1]) {
            throw "The finalization request query identity does not match its protected receipt."
        }
    }
    if ((Get-HfValue $requestIdentity "trackIoTiming" $false) -ne $true) {
        throw "The finalization request query identity must bind track_io_timing=true."
    }
    $rds = Get-HfRequiredValue $Request "rds"
    $tasks = Get-HfRequiredValue $Request "taskDefinitions"
    if ([string](Get-HfRequiredValue $receipt "databaseResourceId") -cne [string](Get-HfRequiredValue $rds "databaseResourceId") -or
        [string](Get-HfRequiredValue $receipt "engineVersion") -cne [string](Get-HfRequiredValue $rds "engineVersion") -or
        [string](Get-HfRequiredValue $receipt "applicationGitSha") -cne [string](Get-HfRequiredValue $Request "applicationGitSha") -or
        [string](Get-HfRequiredValue $receipt "deployedImageDigest") -cne [string](Get-HfRequiredValue $Request "deployedImageDigest") -or
        [string](Get-HfRequiredValue $receipt "activeApiTaskDefinitionArn") -cne [string](Get-HfRequiredValue $tasks "api") -or
        [string](Get-HfRequiredValue $receipt "activeWorkerTaskDefinitionArn") -cne [string](Get-HfRequiredValue $tasks "worker")) {
        throw "The query-identity receipt does not bind the requested database, release, and task revisions."
    }
    return [pscustomobject]@{
        Receipt=$bound;QueryIdentifier=$queryIdentifier;IdentityVersion=$identityVersion
        QueryIdentifierSha256=$queryIdentifierSha256;CompiledSqlSha256=$compiledSqlSha256
        ParameterTypeSignatureSha256=$parameterTypeSignatureSha256
        SchemaIdentitySha256=$schemaIdentitySha256
        DatabaseResourceId=[string](Get-HfRequiredValue $receipt "databaseResourceId")
        EngineVersion=[string](Get-HfRequiredValue $receipt "engineVersion")
        TrackIoTiming=$true
    }
}

function Read-HistoryFallbackPiFinalizationRequest {
    param([string]$RequestPath, [string]$ExpectedRequestSha256)
    $path = Resolve-HfExternalPath $RequestPath "RequestPath"
    $expectedSha = Assert-HfSha256 $ExpectedRequestSha256 "ExpectedRequestSha256"
    $actualSha = Get-HfFileSha256 $path
    if ($actualSha -cne $expectedSha) { throw "The PI finalization request changed after its hash was recorded." }
    Assert-HfPrivateAcl $path "historyFallbackPiFinalizationRequest"
    $rawText = Get-Content -LiteralPath $path -Raw
    if ($rawText -match '"queryIdentifier"\s*:') {
        throw "The finalization request must reference the private identity receipt instead of embedding the raw query identifier."
    }
    try { $request = $rawText | ConvertFrom-Json -Depth 50 -DateKind String }
    catch { throw "The PI finalization request must contain valid JSON." }
    if ([int](Get-HfValue $request "schemaVersion" 0) -ne 1 -or
        [string](Get-HfValue $request "type" "") -cne $script:HfRequestType -or
        [string](Get-HfValue $request "historyFallbackPiEvidenceVersion" "") -cne $script:HfPiEvidenceVersion -or
        [string](Get-HfValue $request "evidenceCollectorVersion" "") -cne $script:HfCollectorVersion) {
        throw "The PI finalization request has an unsupported schema or evidence version."
    }
    $runId = Assert-HfSafeIdentifier ([string](Get-HfRequiredValue $request "runId")) "runId"
    $chainId = Assert-HfSafeIdentifier ([string](Get-HfRequiredValue $request "chainId")) "chainId"
    $phase = [string](Get-HfRequiredValue $request "phase")
    $stage = [string](Get-HfRequiredValue $request "stage")
    if ($phase -cne "Waf" -or $stage -notin @("500", "800")) {
        throw "The certification PI finalizer accepts only Waf/500 or Waf/800 requests."
    }
    $applicationGitSha = ([string](Get-HfRequiredValue $request "applicationGitSha")).ToLowerInvariant()
    if ($applicationGitSha -notmatch '^[0-9a-f]{40}$') { throw "applicationGitSha must be one full Git SHA." }
    $imageDigest = Assert-HfSha256 ([string](Get-HfRequiredValue $request "deployedImageDigest")) `
        "deployedImageDigest" -ImageDigest
    $rds = Get-HfRequiredValue $request "rds"
    $region = [string](Get-HfRequiredValue $rds "region")
    $accountId = [string](Get-HfRequiredValue $rds "accountId")
    if ($region -notmatch '^[a-z]{2}-[a-z]+-[1-9][0-9]*$' -or $accountId -notmatch '^\d{12}$') {
        throw "The RDS region/account binding is malformed."
    }
    $dbInstanceIdentifier = Assert-HfSafeIdentifier ([string](Get-HfRequiredValue $rds "dbInstanceIdentifier")) `
        "rds.dbInstanceIdentifier"
    $databaseResourceId = [string](Get-HfRequiredValue $rds "databaseResourceId")
    $engineVersion = [string](Get-HfRequiredValue $rds "engineVersion")
    if ($databaseResourceId -notmatch '^db-[A-Z0-9]{20,64}$' -or
        $engineVersion -notmatch '^[0-9]+(?:\.[0-9]+){0,2}$' -or
        [string](Get-HfRequiredValue $rds "expectedInstanceClass") -cne "db.t4g.medium") {
        throw "The RDS identity must bind the reviewed db.t4g.medium PostgreSQL resource."
    }
    $tasks = Get-HfRequiredValue $request "taskDefinitions"
    $apiArn = Assert-HfTaskDefinitionArn ([string](Get-HfRequiredValue $tasks "api")) `
        "taskDefinitions.api" $region $accountId "api"
    $workerArn = Assert-HfTaskDefinitionArn ([string](Get-HfRequiredValue $tasks "worker")) `
        "taskDefinitions.worker" $region $accountId "scheduler-worker"
    $runtimeBinding = Get-HfRequiredValue $request "ecsRuntimeBinding"
    $clusterName = Assert-HfSafeIdentifier ([string](Get-HfRequiredValue $runtimeBinding "clusterName")) `
        "ecsRuntimeBinding.clusterName"
    $apiServiceName = Assert-HfSafeIdentifier ([string](Get-HfRequiredValue $runtimeBinding "apiServiceName")) `
        "ecsRuntimeBinding.apiServiceName"
    $workerServiceName = Assert-HfSafeIdentifier ([string](Get-HfRequiredValue $runtimeBinding "workerServiceName")) `
        "ecsRuntimeBinding.workerServiceName"
    if ($apiServiceName -ceq $workerServiceName) {
        throw "The ECS runtime binding requires distinct API and worker services."
    }
    $window = Get-HfRequiredValue $request "trafficWindow"
    if ((Get-HfValue $window "coherent" $false) -ne $true) {
        throw "The PI finalization request requires a coherent observed traffic window."
    }
    try {
        $start = ([DateTimeOffset]([string](Get-HfRequiredValue $window "startUtc"))).ToUniversalTime()
        $end = ([DateTimeOffset]([string](Get-HfRequiredValue $window "endUtc"))).ToUniversalTime()
    }
    catch { throw "The coherent traffic window requires valid UTC timestamps." }
    if ($end -le $start -or ($end - $start).TotalMinutes -gt 120) {
        throw "The coherent traffic window must be positive and bounded to two hours."
    }
    $cloudWatch = Get-HfRequiredValue $request "apiCloudWatchBinding"
    $logDriver = [string](Get-HfRequiredValue $cloudWatch "logDriver")
    $logRegion = [string](Get-HfRequiredValue $cloudWatch "logRegion")
    $logGroup = Assert-HfBoundedText ([string](Get-HfRequiredValue $cloudWatch "logGroupName")) `
        "apiCloudWatchBinding.logGroupName" 512
    $streamPrefix = Assert-HfBoundedText ([string](Get-HfRequiredValue $cloudWatch "awslogsStreamPrefix")) `
        "apiCloudWatchBinding.awslogsStreamPrefix" 128
    $apiStreamPrefix = Assert-HfBoundedText ([string](Get-HfRequiredValue $cloudWatch "apiLogStreamNamePrefix")) `
        "apiCloudWatchBinding.apiLogStreamNamePrefix" 256
    if ($logDriver -cne "awslogs" -or $logRegion -cne $region -or
        $apiStreamPrefix -cne "$streamPrefix/api/") {
        throw "The API CloudWatch binding must match one exact awslogs task stream prefix."
    }
    $fallback = Get-HfRequiredValue $request "applicationFallbackDatabaseReadEvidence"
    $identity = Read-HfIdentityReceipt (Get-HfRequiredValue $request "historyFallbackQueryIdentity") $request
    if ([string](Get-HfRequiredValue $fallback "sourceEvent") -cne "classpilot_heartbeat_hot_path_summary" -or
        [string](Get-HfRequiredValue $fallback "historyFallbackSqlIdentityVersion") -cne $identity.IdentityVersion -or
        [string](Get-HfRequiredValue $fallback "historyFallbackSqlIdentitySha256") -cne $identity.CompiledSqlSha256) {
        throw "The application fallback database-read evidence does not bind the reviewed deployed SQL identity."
    }
    $evidenceStart = Get-HfCeilingMinute $start
    $evidenceEnd = Get-HfFloorMinute $end
    if ($evidenceEnd -le $evidenceStart) {
        throw "The coherent traffic interval does not contain a positive minute-aligned PI evidence subwindow."
    }
    return [pscustomobject]@{
        Request=[pscustomobject]@{Path=$path;Sha256=$actualSha};Raw=$request
        RunId=$runId;ChainId=$chainId;Phase=$phase;Stage=$stage
        ApplicationGitSha=$applicationGitSha;ImageDigest=$imageDigest
        Region=$region;AccountId=$accountId;DbInstanceIdentifier=$dbInstanceIdentifier
        DatabaseResourceId=$databaseResourceId;EngineVersion=$engineVersion
        ExpectedInstanceClass="db.t4g.medium";ApiTaskDefinitionArn=$apiArn
        WorkerTaskDefinitionArn=$workerArn;TrafficStart=$start;TrafficEnd=$end
        EcsClusterName=$clusterName;ApiServiceName=$apiServiceName;WorkerServiceName=$workerServiceName
        ApiTaskDefinitionSha256=(Get-HfTextSha256 $apiArn)
        EvidenceStart=$evidenceStart;EvidenceEnd=$evidenceEnd
        LogDriver=$logDriver;LogRegion=$logRegion;LogGroupName=$logGroup
        AwslogsStreamPrefix=$streamPrefix;ApiLogStreamNamePrefix=$apiStreamPrefix
        Identity=$identity
    }
}

function Test-HistoryFallbackPiFinalizationRequest {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$RequestPath,
        [Parameter(Mandatory=$true)][string]$ExpectedRequestSha256)
    $config = Read-HistoryFallbackPiFinalizationRequest $RequestPath $ExpectedRequestSha256
    return [ordered]@{
        schemaVersion=1;valid=$true;requestSha256=$config.Request.Sha256;runId=$config.RunId
        chainId=$config.ChainId;phase=$config.Phase;stage=$config.Stage
        historyFallbackPiEvidenceVersion=$script:HfPiEvidenceVersion
        queryIdentifierSha256=$config.Identity.QueryIdentifierSha256
        compiledSqlSha256=$config.Identity.CompiledSqlSha256
        databaseResourceIdSha256=(Get-HfTextSha256 $config.DatabaseResourceId)
        apiRuntimeTaskDefinitionSha256=$config.ApiTaskDefinitionSha256
        trackIoTiming=$config.Identity.TrackIoTiming
        evidenceStartUtc=$config.EvidenceStart.ToString("o");evidenceEndUtc=$config.EvidenceEnd.ToString("o")
        evidenceWindowSha256=(Get-HfCanonicalSha256 ([ordered]@{
            startUtc=$config.EvidenceStart.ToString("o");endUtc=$config.EvidenceEnd.ToString("o")
        }))
        releaseIdentitySha256=(Get-HfCanonicalSha256 ([ordered]@{
            applicationGitSha=$config.ApplicationGitSha;deployedImageDigest=$config.ImageDigest
            apiTaskDefinitionArn=$config.ApiTaskDefinitionArn;workerTaskDefinitionArn=$config.WorkerTaskDefinitionArn
        }))
    }
}

function Test-HfAwsRetryableFailure {
    param([string]$StandardError, [bool]$TimedOut = $false)
    if ($TimedOut) { return $true }
    return ([string]$StandardError).ToLowerInvariant() -match `
        'throttl|rate exceeded|requestlimitexceeded|service unavailable|temporar|timeout|timed out|connection|internalerror|internal failure'
}

function New-HfCollectorException {
    param([string]$Message, [string]$Stage, [string]$FailureCode = "performance_insights_evidence_unavailable",
        [int]$AttemptCount = 0, $PartialEvidence = $null, [Exception]$InnerException = $null)
    $exception = if ($null -eq $InnerException) {
        [InvalidOperationException]::new($Message)
    } else {
        [InvalidOperationException]::new($Message, $InnerException)
    }
    $exception.Data["failureStage"] = $Stage
    $exception.Data["failureCode"] = $FailureCode
    $exception.Data["attemptCount"] = $AttemptCount
    if ($null -ne $PartialEvidence) { $exception.Data["partialEvidence"] = $PartialEvidence }
    return $exception
}

function Get-HfCollectorFailureClassification {
    param([Parameter(Mandatory=$true)][Exception]$Exception)
    $stage = if ($Exception.Data.Contains("failureStage")) {
        [string]$Exception.Data["failureStage"]
    } else { "collector_runtime" }
    $failureCode = if ($Exception.Data.Contains("failureCode")) {
        [string]$Exception.Data["failureCode"]
    } elseif ($stage -ceq "collector_runtime") {
        "controller_runtime_failure"
    } else {
        "performance_insights_evidence_unavailable"
    }
    $attemptCount = if ($Exception.Data.Contains("attemptCount")) {
        [int]$Exception.Data["attemptCount"]
    } else { 1 }
    $partial = if ($Exception.Data.Contains("partialEvidence")) {
        $Exception.Data["partialEvidence"]
    } else { $null }
    return [ordered]@{
        failureStage=$stage;failureCode=$failureCode;attemptCount=$attemptCount;partialEvidence=$partial
    }
}

function Invoke-HfAwsJson {
    param([string[]]$Arguments)
    $operation = if ($Arguments.Count -ge 2) { "$($Arguments[0]) $($Arguments[1])" } else { "AWS request" }
    $aws = (Get-Command aws -ErrorAction Stop).Source
    $lastCategory = "unknown"
    for ($attempt = 1; $attempt -le $script:HfAwsMaximumAttempts; $attempt++) {
        $delay = $script:HfAwsRetryDelaysSeconds[$attempt - 1]
        if ($delay -gt 0) { Start-Sleep -Seconds $delay }
        $process = $null
        try {
            $startInfo = [Diagnostics.ProcessStartInfo]::new()
            $startInfo.FileName = $aws
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            foreach ($argument in @($Arguments) + @("--output", "json")) { [void]$startInfo.ArgumentList.Add($argument) }
            $startInfo.RedirectStandardOutput = $true
            $startInfo.RedirectStandardError = $true
            $process = [Diagnostics.Process]::new()
            $process.StartInfo = $startInfo
            if (-not $process.Start()) { throw "AWS CLI process could not start." }
            $stdoutTask = $process.StandardOutput.ReadToEndAsync()
            $stderrTask = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit($script:HfAwsTimeoutSeconds * 1000)) {
                try { $process.Kill($true) } catch { }
                $lastCategory = "timeout"
                if ($attempt -lt $script:HfAwsMaximumAttempts) { continue }
                throw (New-HfCollectorException "AWS evidence request timed out for $operation." "aws_request")
            }
            $stdout = $stdoutTask.GetAwaiter().GetResult()
            $stderr = $stderrTask.GetAwaiter().GetResult()
            if ($process.ExitCode -ne 0) {
                $retryable = Test-HfAwsRetryableFailure ([string]$stderr)
                $lastCategory = if ($retryable) { "transient" } else { "non_retryable" }
                if ($retryable -and $attempt -lt $script:HfAwsMaximumAttempts) { continue }
                throw (New-HfCollectorException "AWS evidence request failed for $operation ($lastCategory)." "aws_request")
            }
            $text = ([string]$stdout).Trim()
            if (-not $text) { return $null }
            try { return $text | ConvertFrom-Json -Depth 60 -DateKind String }
            catch { throw (New-HfCollectorException "AWS evidence request returned malformed JSON for $operation." "aws_response") }
        }
        finally {
            if ($null -ne $process) { $process.Dispose() }
        }
    }
    throw (New-HfCollectorException "AWS evidence request failed for $operation ($lastCategory)." "aws_request")
}

function Invoke-HfAwsJsonPages {
    param([string[]]$Arguments, [string]$ItemsProperty, [string]$TokenProperty,
        [string]$TokenArgument = "--next-token", [scriptblock]$Identity,
        [scriptblock]$PageValidator = $null)
    $items = [Collections.Generic.List[object]]::new()
    $seenTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $seenItems = @{}
    $pageToken = $null
    $pageCount = 0
    do {
        $pageCount++
        if ($pageCount -gt $script:HfMaximumPages) { throw "AWS evidence pagination exceeded 100 pages." }
        $pageArguments = @($Arguments) + @("--no-paginate")
        if (-not [string]::IsNullOrWhiteSpace([string]$pageToken)) {
            $pageArguments += @($TokenArgument, [string]$pageToken)
        }
        $page = Invoke-HfAwsJson $pageArguments
        if ($null -eq $page) { throw "AWS evidence pagination returned an empty page." }
        if ($null -ne $PageValidator) { & $PageValidator $page }
        foreach ($item in @((Get-HfValue $page $ItemsProperty @()))) {
            $key = if ($null -ne $Identity) { [string](& $Identity $item) } else { Get-HfCanonicalSha256 $item }
            if ([string]::IsNullOrWhiteSpace($key)) { throw "AWS evidence pagination returned an item without identity." }
            $itemHash = Get-HfCanonicalSha256 $item
            if ($seenItems.ContainsKey($key)) {
                if ([string]$seenItems[$key] -cne $itemHash) {
                    throw "AWS evidence pagination returned conflicting duplicate records."
                }
                continue
            }
            $seenItems[$key] = $itemHash
            $items.Add($item)
            if ($items.Count -gt $script:HfMaximumRecords) { throw "AWS evidence pagination exceeded 10000 records." }
        }
        $pageToken = [string](Get-HfValue $page $TokenProperty "")
        if ($pageToken -and -not $seenTokens.Add($pageToken)) {
            throw "AWS evidence pagination returned a token cycle."
        }
    } while ($pageToken)
    return [pscustomobject]@{Items=$items.ToArray();PageCount=$pageCount;RecordCount=$items.Count}
}

function Test-HfEmptyObject {
    param($Value)
    if ($null -eq $Value) { return $true }
    if ($Value -is [Collections.IDictionary]) { return $Value.Count -eq 0 }
    return @($Value.PSObject.Properties).Count -eq 0
}

function Get-HfTaskDefinitionContainer {
    param($Response, [string]$ExpectedArn, [string]$ContainerName, [string]$ImageDigest,
        [string]$AccountId, [string]$Region)
    $task = Get-HfRequiredValue $Response "taskDefinition"
    if ([string](Get-HfRequiredValue $task "taskDefinitionArn") -cne $ExpectedArn) {
        throw "AWS did not return the exact requested task-definition revision."
    }
    $containers = @((Get-HfRequiredValue $task "containerDefinitions") | Where-Object {
        [string](Get-HfValue $_ "name" "") -ceq $ContainerName
    })
    if ($containers.Count -ne 1) { throw "The exact task definition did not contain one expected container." }
    $image = [string](Get-HfRequiredValue $containers[0] "image")
    $expectedRegistryPrefix = "$AccountId.dkr.ecr.$Region.amazonaws.com/"
    if (-not $image.StartsWith($expectedRegistryPrefix, [StringComparison]::Ordinal) -or
        $image -notmatch '^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$' -or
        -not $image.EndsWith("@$ImageDigest", [StringComparison]::Ordinal)) {
        throw "The exact task definition does not bind the requested image digest."
    }
    return $containers[0]
}

function Get-HfTrackIoTimingParameterEvidence {
    param($Instance, $Config)
    $groups = @((Get-HfRequiredValue $Instance "DBParameterGroups"))
    if ($groups.Count -ne 1 -or
        [string](Get-HfRequiredValue $groups[0] "ParameterApplyStatus") -cne "in-sync") {
        throw "RDS preflight requires one in-sync database parameter group."
    }
    $groupName = Assert-HfBoundedText ([string](Get-HfRequiredValue $groups[0] "DBParameterGroupName")) `
        "DBParameterGroupName" 255
    if ($groupName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$') {
        throw "RDS preflight returned a malformed database parameter-group name."
    }
    $pages = Invoke-HfAwsJsonPages -Arguments @(
        "rds", "describe-db-parameters", "--region", $Config.Region,
        "--db-parameter-group-name", $groupName,
        "--filters", "Name=parameter-name,Values=track_io_timing"
    ) -ItemsProperty "Parameters" -TokenProperty "Marker" -TokenArgument "--marker" -Identity {
        param($parameter)
        return [string](Get-HfValue $parameter "ParameterName" "")
    }
    $parameters = @($pages.Items)
    if ($parameters.Count -ne 1 -or
        [string](Get-HfRequiredValue $parameters[0] "ParameterName") -cne "track_io_timing") {
        throw "RDS preflight did not resolve one exact track_io_timing parameter."
    }
    $parameterValue = ([string](Get-HfRequiredValue $parameters[0] "ParameterValue")).Trim().ToLowerInvariant()
    if ($parameterValue -notin @("1", "on", "true")) {
        throw "RDS preflight requires effective track_io_timing to be enabled."
    }
    return [ordered]@{
        enabled=$true;parameterGroupSha256=(Get-HfTextSha256 $groupName)
        pageCount=$pages.PageCount;rawIdentifiersPersisted=$false
    }
}

function Get-HfEcsRuntimeBindingEvidence {
    param($Config)
    $response = Invoke-HfAwsJson @(
        "ecs", "describe-services", "--region", $Config.Region,
        "--cluster", $Config.EcsClusterName,
        "--services", $Config.ApiServiceName, $Config.WorkerServiceName
    )
    if (@((Get-HfValue $response "failures" @())).Count -ne 0) {
        throw "ECS runtime preflight returned service lookup failures."
    }
    $services = @((Get-HfRequiredValue $response "services"))
    if ($services.Count -ne 2) {
        throw "ECS runtime preflight did not resolve both bound services."
    }
    $sanitized = [ordered]@{}
    foreach ($binding in @(
        @("api", $Config.ApiServiceName, $Config.ApiTaskDefinitionArn, "api"),
        @("worker", $Config.WorkerServiceName, $Config.WorkerTaskDefinitionArn, "scheduler-worker")
    )) {
        $role = [string]$binding[0]
        $serviceName = [string]$binding[1]
        $expectedTaskDefinitionArn = [string]$binding[2]
        $containerName = [string]$binding[3]
        $matches = @($services | Where-Object {
            [string](Get-HfValue $_ "serviceName" "") -ceq $serviceName
        })
        if ($matches.Count -ne 1) { throw "ECS runtime preflight service identity was ambiguous." }
        $service = $matches[0]
        $desiredCount = [int](Get-HfRequiredValue $service "desiredCount")
        $runningCount = [int](Get-HfRequiredValue $service "runningCount")
        $deployments = @((Get-HfRequiredValue $service "deployments"))
        if ([string](Get-HfRequiredValue $service "status") -cne "ACTIVE" -or
            [string](Get-HfRequiredValue $service "taskDefinition") -cne $expectedTaskDefinitionArn -or
            $desiredCount -lt 1 -or $runningCount -ne $desiredCount -or
            [int](Get-HfRequiredValue $service "pendingCount") -ne 0 -or
            $deployments.Count -ne 1 -or
            [string](Get-HfRequiredValue $deployments[0] "status") -cne "PRIMARY" -or
            [string](Get-HfRequiredValue $deployments[0] "taskDefinition") -cne $expectedTaskDefinitionArn -or
            [string](Get-HfRequiredValue $deployments[0] "rolloutState") -cne "COMPLETED") {
            throw "ECS runtime preflight found a service outside its exact stable revision."
        }
        $listed = Invoke-HfAwsJsonPages -Arguments @(
            "ecs", "list-tasks", "--region", $Config.Region,
            "--cluster", $Config.EcsClusterName, "--service-name", $serviceName,
            "--desired-status", "RUNNING"
        ) -ItemsProperty "taskArns" -TokenProperty "nextToken" -Identity {
            param($taskArn)
            return [string]$taskArn
        }
        $taskArns = @($listed.Items)
        if ($taskArns.Count -ne $runningCount) {
            throw "ECS runtime preflight task count did not match the stable service."
        }
        $describedCount = 0
        for ($offset = 0; $offset -lt $taskArns.Count; $offset += 100) {
            $upper = [math]::Min($offset + 99, $taskArns.Count - 1)
            $chunk = @($taskArns[$offset..$upper])
            $tasksResponse = Invoke-HfAwsJson (@(
                "ecs", "describe-tasks", "--region", $Config.Region,
                "--cluster", $Config.EcsClusterName, "--tasks"
            ) + $chunk)
            if (@((Get-HfValue $tasksResponse "failures" @())).Count -ne 0) {
                throw "ECS runtime preflight returned task lookup failures."
            }
            $tasks = @((Get-HfRequiredValue $tasksResponse "tasks"))
            if ($tasks.Count -ne $chunk.Count) {
                throw "ECS runtime preflight returned an incomplete running-task set."
            }
            foreach ($task in $tasks) {
                $containers = @((Get-HfRequiredValue $task "containers") | Where-Object {
                    [string](Get-HfValue $_ "name" "") -ceq $containerName
                })
                if ([string](Get-HfRequiredValue $task "taskDefinitionArn") -cne $expectedTaskDefinitionArn -or
                    [string](Get-HfRequiredValue $task "lastStatus") -cne "RUNNING" -or
                    [string](Get-HfRequiredValue $task "desiredStatus") -cne "RUNNING" -or
                    $containers.Count -ne 1 -or
                    [string](Get-HfRequiredValue $containers[0] "imageDigest") -cne $Config.ImageDigest -or
                    [string](Get-HfRequiredValue $containers[0] "lastStatus") -cne "RUNNING") {
                    throw "ECS runtime preflight found a running task outside its exact revision and digest."
                }
                $describedCount++
            }
        }
        $sanitized[$role] = [ordered]@{
            serviceNameSha256=(Get-HfTextSha256 $serviceName)
            taskDefinitionSha256=(Get-HfTextSha256 $expectedTaskDefinitionArn)
            desiredCount=$desiredCount;runningCount=$runningCount
            runningTaskCount=$describedCount;listPageCount=$listed.PageCount
            imageDigestMatched=$true;passed=$true
        }
    }
    return [ordered]@{
        clusterNameSha256=(Get-HfTextSha256 $Config.EcsClusterName)
        api=$sanitized.api;worker=$sanitized.worker;rawIdentifiersPersisted=$false;passed=$true
    }
}

function Assert-HfAwsPreflight {
    param($Config)
    $caller = Invoke-HfAwsJson @("sts", "get-caller-identity", "--region", $Config.Region)
    if ([string](Get-HfRequiredValue $caller "Account") -cne $Config.AccountId) {
        throw "AWS caller identity does not match the certification request."
    }
    $rdsResponse = Invoke-HfAwsJson @("rds", "describe-db-instances", "--region", $Config.Region,
        "--db-instance-identifier", $Config.DbInstanceIdentifier)
    $instances = @((Get-HfRequiredValue $rdsResponse "DBInstances"))
    if ($instances.Count -ne 1) { throw "RDS preflight did not resolve exactly one database instance." }
    $instance = $instances[0]
    $parameterStatuses = @(@(Get-HfValue $instance "DBParameterGroups" @()) | ForEach-Object {
        [string](Get-HfValue $_ "ParameterApplyStatus" "")
    })
    if ([string](Get-HfRequiredValue $instance "DbiResourceId") -cne $Config.DatabaseResourceId -or
        [string](Get-HfRequiredValue $instance "Engine") -cne "postgres" -or
        [string](Get-HfRequiredValue $instance "EngineVersion") -cne $Config.EngineVersion -or
        [string](Get-HfRequiredValue $instance "DBInstanceClass") -cne $Config.ExpectedInstanceClass -or
        [string](Get-HfRequiredValue $instance "DBInstanceStatus") -cne "available" -or
        [string](Get-HfRequiredValue $instance "DatabaseInsightsMode") -cne "advanced" -or
        (Get-HfValue $instance "PerformanceInsightsEnabled" $false) -ne $true -or
        [int](Get-HfRequiredValue $instance "PerformanceInsightsRetentionPeriod") -ne 465 -or
        -not (Test-HfEmptyObject (Get-HfValue $instance "PendingModifiedValues" $null)) -or
        @($parameterStatuses | Where-Object { $_ -cne "in-sync" }).Count -gt 0) {
        throw "RDS preflight does not match available Advanced/465 db.t4g.medium evidence posture."
    }
    $trackIoTiming = Get-HfTrackIoTimingParameterEvidence $instance $Config
    $apiResponse = Invoke-HfAwsJson @("ecs", "describe-task-definition", "--region", $Config.Region,
        "--task-definition", $Config.ApiTaskDefinitionArn)
    $apiContainer = Get-HfTaskDefinitionContainer $apiResponse $Config.ApiTaskDefinitionArn "api" `
        $Config.ImageDigest $Config.AccountId $Config.Region
    $logConfiguration = Get-HfRequiredValue $apiContainer "logConfiguration"
    $options = Get-HfRequiredValue $logConfiguration "options"
    if ([string](Get-HfRequiredValue $logConfiguration "logDriver") -cne $Config.LogDriver -or
        [string](Get-HfRequiredValue $options "awslogs-region") -cne $Config.LogRegion -or
        [string](Get-HfRequiredValue $options "awslogs-group") -cne $Config.LogGroupName -or
        [string](Get-HfRequiredValue $options "awslogs-stream-prefix") -cne $Config.AwslogsStreamPrefix) {
        throw "The active API task revision does not match the bound CloudWatch log identity."
    }
    $workerResponse = Invoke-HfAwsJson @("ecs", "describe-task-definition", "--region", $Config.Region,
        "--task-definition", $Config.WorkerTaskDefinitionArn)
    [void](Get-HfTaskDefinitionContainer $workerResponse $Config.WorkerTaskDefinitionArn "scheduler-worker" `
        $Config.ImageDigest $Config.AccountId $Config.Region)
    $ecsRuntime = Get-HfEcsRuntimeBindingEvidence $Config
    return [ordered]@{
        accountIdSha256=Get-HfTextSha256 $Config.AccountId
        databaseResourceIdSha256=Get-HfTextSha256 $Config.DatabaseResourceId
        dbInstanceIdentifierSha256=Get-HfTextSha256 $Config.DbInstanceIdentifier
        engineVersion=$Config.EngineVersion;instanceClass=$Config.ExpectedInstanceClass
        databaseInsightsMode="advanced";performanceInsightsEnabled=$true
        performanceInsightsRetentionPeriod=465;pendingModifiedValuesAbsent=$true
        trackIoTiming=$trackIoTiming
        apiTaskDefinitionSha256=Get-HfTextSha256 $Config.ApiTaskDefinitionArn
        workerTaskDefinitionSha256=Get-HfTextSha256 $Config.WorkerTaskDefinitionArn
        apiLogGroupSha256=Get-HfTextSha256 $Config.LogGroupName
        apiLogStreamPrefixSha256=Get-HfTextSha256 $Config.ApiLogStreamNamePrefix
        ecsRuntime=$ecsRuntime
        passed=$true
    }
}

function Test-HfFiniteNonnegativeNumber {
    param($Value)
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [char] -or $Value -isnot [ValueType]) {
        return $false
    }
    try { $number = [double]$Value } catch { return $false }
    return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number) -and $number -ge 0
}

function Resolve-HistoryFallbackHotPathLogEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Config,
        [object[]]$Events = @(),
        [int]$PageCount = 1
    )
    $startMs = $Config.EvidenceStart.ToUnixTimeMilliseconds()
    $endMs = $Config.EvidenceEnd.ToUnixTimeMilliseconds()
    $matchingSummaryCount = 0
    $fallbackPositiveSummaryCount = 0
    $boundaryExcludedFallbackPositiveSummaryCount = 0
    $fallbackItems = 0L
    $databaseReadCount = 0L
    $fallbackPositiveIntervals = [System.Collections.Generic.List[object]]::new()
    foreach ($event in @($Events)) {
        $rawTimestamp = Get-HfValue $event "timestamp" $null
        if ($null -eq $rawTimestamp -or $rawTimestamp -is [bool] -or $rawTimestamp -is [char]) {
            throw "CloudWatch Logs returned malformed hot-path summary evidence."
        }
        try { $timestamp = [long]$rawTimestamp }
        catch { throw "CloudWatch Logs returned malformed hot-path summary evidence." }
        $stream = [string](Get-HfValue $event "logStreamName" "")
        $message = [string](Get-HfValue $event "message" "")
        if ($timestamp -lt $startMs -or $timestamp -gt $endMs -or
            -not $stream.StartsWith($Config.ApiLogStreamNamePrefix, [StringComparison]::Ordinal) -or
            [string]::IsNullOrWhiteSpace($message)) {
            throw "CloudWatch Logs returned out-of-scope hot-path summary evidence."
        }
        try { $payload = $message | ConvertFrom-Json -Depth 30 -DateKind String }
        catch { throw "CloudWatch Logs returned malformed hot-path summary evidence." }
        if ([string](Get-HfValue $payload "event" "") -cne $script:HfHotPathSummaryEvent -or
            [int](Get-HfValue $payload "intervalSeconds" -1) -ne $script:HfHotPathSummaryIntervalSeconds) {
            throw "CloudWatch Logs returned an unreviewed hot-path summary schema."
        }
        $matchingSummaryCount++
        $counters = Get-HfValue $payload "counters" $null
        $rawFallbackItems = Get-HfValue $counters "tileBatchHistoryFallbackItems" $null
        if (-not (Test-HfFiniteNonnegativeNumber $rawFallbackItems)) {
            throw "CloudWatch Logs returned malformed fallback counters."
        }
        $eventFallbackItems = [double]$rawFallbackItems
        if ($eventFallbackItems -ne [math]::Floor($eventFallbackItems)) {
            throw "CloudWatch Logs returned malformed fallback counters."
        }
        if ($eventFallbackItems -eq 0) { continue }
        if ([string](Get-HfValue $payload "historyFallbackSqlIdentityVersion" "") -cne
                $Config.Identity.IdentityVersion -or
            [string](Get-HfValue $payload "historyFallbackSqlIdentitySha256" "").ToLowerInvariant() -cne
                $Config.Identity.CompiledSqlSha256 -or
            [string](Get-HfValue $payload "apiRuntimeTaskDefinitionSha256" "").ToLowerInvariant() -cne
                $Config.ApiTaskDefinitionSha256) {
            throw "CloudWatch Logs fallback evidence did not bind the reviewed SQL and API runtime identities."
        }
        try {
            $intervalStartText = [string](Get-HfRequiredValue $payload "intervalStartedAtUtc")
            $intervalEndText = [string](Get-HfRequiredValue $payload "intervalEndedAtUtc")
            $rawIntervalStart = [DateTimeOffset]$intervalStartText
            $rawIntervalEnd = [DateTimeOffset]$intervalEndText
            if ($rawIntervalStart.Offset -ne [TimeSpan]::Zero -or $rawIntervalEnd.Offset -ne [TimeSpan]::Zero) {
                throw "not_utc"
            }
            $intervalStart = $rawIntervalStart.ToUniversalTime()
            $intervalEnd = $rawIntervalEnd.ToUniversalTime()
        }
        catch { throw "CloudWatch Logs fallback evidence did not contain a valid explicit summary interval." }
        $intervalMilliseconds = ($intervalEnd - $intervalStart).TotalMilliseconds
        if ($intervalEnd -le $intervalStart -or $intervalMilliseconds -ne 60000.0 -or
            ($intervalStart.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or
            ($intervalEnd.Ticks % [TimeSpan]::TicksPerMinute) -ne 0) {
            throw "CloudWatch Logs fallback evidence must bind each claimed hot-path summary to one exact UTC-minute-aligned 60-second interval."
        }
        if ($intervalStart -lt $Config.EvidenceStart -or $intervalEnd -gt $Config.EvidenceEnd) {
            $boundaryExcludedFallbackPositiveSummaryCount++
            continue
        }
        $timings = Get-HfValue $payload "timings" $null
        $databaseTiming = Get-HfValue $timings "tileBatchHistoryDatabaseMs" $null
        $rawReadCount = Get-HfValue $databaseTiming "count" $null
        $rawTotalMs = Get-HfValue $databaseTiming "totalMs" $null
        $rawMaxMs = Get-HfValue $databaseTiming "maxMs" $null
        foreach ($value in @($rawReadCount, $rawTotalMs, $rawMaxMs)) {
            if (-not (Test-HfFiniteNonnegativeNumber $value)) {
                throw "CloudWatch Logs returned malformed fallback database timing evidence."
            }
        }
        $readCount = [double]$rawReadCount
        if ($readCount -le 0 -or $readCount -ne [math]::Floor($readCount)) {
            throw "CloudWatch Logs returned malformed fallback database timing evidence."
        }
        $fallbackPositiveSummaryCount++
        $fallbackItems += [long]$eventFallbackItems
        $databaseReadCount += [long]$readCount
        $fallbackPositiveIntervals.Add([ordered]@{
            startUtc=$intervalStart.ToString("o");endUtc=$intervalEnd.ToString("o")
            durationMilliseconds=60000;fallbackItems=[long]$eventFallbackItems
            databaseReadCount=[long]$readCount
        })
    }
    $hasPositive = $fallbackPositiveSummaryCount -gt 0 -and $databaseReadCount -gt 0
    $failureReasons = @()
    if (-not $hasPositive) { $failureReasons += "missing_fallback_positive_log_evidence" }
    $evidence = [ordered]@{
        source="cloudwatch_logs";sourceEvent=$script:HfHotPathSummaryEvent
        sourceIntervalSeconds=$script:HfHotPathSummaryIntervalSeconds;pageCount=$PageCount
        matchingSummaryCount=$matchingSummaryCount;fallbackPositiveSummaryCount=$fallbackPositiveSummaryCount
        boundaryExcludedFallbackPositiveSummaryCount=$boundaryExcludedFallbackPositiveSummaryCount
        fallbackItems=$fallbackItems;derivedDatabaseReadCount=$databaseReadCount
        fallbackPositiveIntervals=@($fallbackPositiveIntervals)
        evidenceStartUtc=$Config.EvidenceStart.ToString("o");evidenceEndUtc=$Config.EvidenceEnd.ToString("o")
        historyFallbackSqlIdentityVersion=$Config.Identity.IdentityVersion
        historyFallbackSqlIdentitySha256=$Config.Identity.CompiledSqlSha256
        apiRuntimeTaskDefinitionSha256=$Config.ApiTaskDefinitionSha256
        exactTaskDefinitionBound=$true;logDriver=$Config.LogDriver;logRegion=$Config.LogRegion
        logGroupSha256=(Get-HfTextSha256 $Config.LogGroupName)
        streamPrefixSha256=(Get-HfTextSha256 $Config.ApiLogStreamNamePrefix)
        rawMessagesPersisted=$false;rawIdentifiersPersisted=$false
        failureReasons=@($failureReasons);passed=($failureReasons.Count -eq 0)
    }
    return [pscustomobject]@{
        Evidence=$evidence;DatabaseReadCount=$databaseReadCount;HasPositive=$hasPositive
    }
}

function Get-HfHotPathLogEvidence {
    param($Config)
    $startMs = $Config.EvidenceStart.ToUnixTimeMilliseconds()
    $endMs = $Config.EvidenceEnd.ToUnixTimeMilliseconds()
    $pages = Invoke-HfAwsJsonPages -Arguments @("logs", "filter-log-events", "--region", $Config.LogRegion,
        "--log-group-name", $Config.LogGroupName, "--log-stream-name-prefix", $Config.ApiLogStreamNamePrefix,
        "--start-time", [string]$startMs, "--end-time", [string]$endMs,
        "--filter-pattern", ('"' + $script:HfHotPathSummaryEvent + '"')) `
        -ItemsProperty "events" -TokenProperty "nextToken" -Identity {
            param($event)
            $eventId = [string](Get-HfValue $event "eventId" "")
            if ($eventId) { return $eventId }
            return Get-HfCanonicalSha256 ([ordered]@{
                timestamp=Get-HfValue $event "timestamp";stream=Get-HfValue $event "logStreamName"
                message=Get-HfValue $event "message"
            })
        }
    return Resolve-HistoryFallbackHotPathLogEvidence $Config @($pages.Items) $pages.PageCount
}

function New-HfSqlStatsGateResult {
    param($Config, [string[]]$FailureReasons, [int]$IdentityCount = 0)
    return [pscustomobject]@{
        CanSample=$false;TokenId=$null;TokenSha256=$null;Statement=$null
        Evidence=[ordered]@{
            historyFallbackPiEvidenceVersion=$script:HfPiEvidenceVersion
            identityCount=$IdentityCount;exactQueryIdentifierMatched=$false
            positiveCallsObserved=$false;integratedCalls=0.0
            applicationDatabaseReadCount=$Config.ApplicationDatabaseReadCount
            callsCoverApplicationReads=$false;temporaryIoAbsent=$false
            blockReadTimeSharePercent=$null;dominanceThresholdPercent=$script:HfIoThresholdPercent
            failureReasons=@($FailureReasons);passed=$false
        }
    }
}

function Get-HfSqlStatsBucketCoverage {
    param(
        [Parameter(Mandatory=$true)]$Config,
        [Parameter(Mandatory=$true)]$CallMetricPoints,
        [Parameter(Mandatory=$true)][object[]]$ApplicationFallbackWindows,
        [Parameter(Mandatory=$true)][long]$ExpectedDatabaseReadCount
    )
    $start = [DateTimeOffset]$Config.EvidenceStart
    $end = [DateTimeOffset]$Config.EvidenceEnd
    $durationSeconds = ($end-$start).TotalSeconds
    if ($end -le $start -or $durationSeconds -ne [math]::Floor($durationSeconds) -or
        ([long]$durationSeconds % $script:HfPeriodSeconds) -ne 0 -or
        ($start.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or
        ($end.Ticks % [TimeSpan]::TicksPerMinute) -ne 0) {
        throw "SQL statistics require one exact minute-aligned evidence window."
    }
    $expectedBuckets = [Collections.Generic.List[string]]::new()
    for ($cursor = $start; $cursor -lt $end; $cursor = $cursor.AddSeconds($script:HfPeriodSeconds)) {
        $expectedBuckets.Add($cursor.ToString("o"))
    }
    if ($expectedBuckets.Count -lt 1) { throw "SQL statistics require at least one expected minute bucket." }
    $expectedSet = [Collections.Generic.HashSet[string]]::new($expectedBuckets, [StringComparer]::Ordinal)
    $observedBuckets = @($CallMetricPoints.Keys | Sort-Object)
    foreach ($timestamp in $observedBuckets) {
        if (-not $expectedSet.Contains([string]$timestamp)) {
            throw "SQL statistics returned a datapoint outside the expected minute-bucket lattice."
        }
    }
    $observedSet = [Collections.Generic.HashSet[string]]::new([string[]]$observedBuckets, [StringComparer]::Ordinal)
    $positiveObservedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($timestamp in $observedBuckets) {
        if ([double]$CallMetricPoints[$timestamp] -gt 0.0) {
            [void]$positiveObservedSet.Add([string]$timestamp)
        }
    }
    $missingMiddle = [Collections.Generic.List[string]]::new()
    if ($observedBuckets.Count -gt 1) {
        $firstIndex = $expectedBuckets.IndexOf([string]$observedBuckets[0])
        $lastIndex = $expectedBuckets.IndexOf([string]$observedBuckets[-1])
        for ($index = $firstIndex; $index -le $lastIndex; $index++) {
            if (-not $observedSet.Contains($expectedBuckets[$index])) {
                $missingMiddle.Add($expectedBuckets[$index])
            }
        }
    }
    $applicationActiveBuckets = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $coveredApplicationWindows = 0
    $positiveCallCoveredApplicationWindows = 0
    $applicationReadCount = 0L
    foreach ($window in @($ApplicationFallbackWindows)) {
        try {
            $rawWindowStart = [DateTimeOffset]([string](Get-HfRequiredValue $window "startUtc"))
            $rawWindowEnd = [DateTimeOffset]([string](Get-HfRequiredValue $window "endUtc"))
            $windowReads = [long](Get-HfRequiredValue $window "databaseReadCount")
            $windowStart = $rawWindowStart.ToUniversalTime()
            $windowEnd = $rawWindowEnd.ToUniversalTime()
        }
        catch { throw "Application fallback bucket evidence was malformed." }
        if ($rawWindowStart.Offset -ne [TimeSpan]::Zero -or $rawWindowEnd.Offset -ne [TimeSpan]::Zero -or
            $windowStart -lt $start -or $windowEnd -gt $end -or
            ($windowEnd-$windowStart).TotalMilliseconds -ne 60000.0 -or
            ($windowStart.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or
            ($windowEnd.Ticks % [TimeSpan]::TicksPerMinute) -ne 0 -or $windowReads -le 0) {
            throw "Application fallback bucket evidence was outside the exact SQL-statistics window."
        }
        $applicationReadCount += $windowReads
        $windowCovered = $false
        $windowPositiveCallCovered = $false
        foreach ($bucketText in $expectedBuckets) {
            $bucketStart = [DateTimeOffset]$bucketText
            $bucketEnd = $bucketStart.AddSeconds($script:HfPeriodSeconds)
            if ($bucketStart -lt $windowEnd -and $bucketEnd -gt $windowStart) {
                [void]$applicationActiveBuckets.Add($bucketText)
                if ($observedSet.Contains($bucketText)) { $windowCovered = $true }
                if ($positiveObservedSet.Contains($bucketText)) { $windowPositiveCallCovered = $true }
            }
        }
        if ($windowCovered) { $coveredApplicationWindows++ }
        if ($windowPositiveCallCovered) { $positiveCallCoveredApplicationWindows++ }
    }
    if ($applicationReadCount -ne $ExpectedDatabaseReadCount -or $ApplicationFallbackWindows.Count -lt 1) {
        throw "Application fallback bucket evidence did not reconcile to the bound database-read count."
    }
    $applicationActiveBucketTexts = @($applicationActiveBuckets | Sort-Object)
    $unobservedActiveBuckets = @($applicationActiveBucketTexts | Where-Object { -not $observedSet.Contains($_) })
    $zeroCallApplicationActiveBuckets = @($applicationActiveBucketTexts | Where-Object {
        $observedSet.Contains($_) -and -not $positiveObservedSet.Contains($_)
    })
    if ($missingMiddle.Count -gt 0 -or $unobservedActiveBuckets.Count -gt 0 -or
        $coveredApplicationWindows -ne $ApplicationFallbackWindows.Count) {
        throw "SQL statistics contained missing-middle or application-active sparse minute buckets."
    }
    $omittedBuckets = @($expectedBuckets | Where-Object { -not $observedSet.Contains($_) })
    $positiveBucketTexts = @($positiveObservedSet | Sort-Object)
    $observedOrdinals = @($observedBuckets | ForEach-Object { $expectedBuckets.IndexOf([string]$_) })
    $positiveOrdinals = @($positiveBucketTexts | ForEach-Object { $expectedBuckets.IndexOf([string]$_) })
    $applicationActiveOrdinals = @($applicationActiveBucketTexts | ForEach-Object { $expectedBuckets.IndexOf([string]$_) })
    return [ordered]@{
        coverageContractVersion="queryid-minute-sparse-v1";periodSeconds=$script:HfPeriodSeconds
        expectedBucketCount=$expectedBuckets.Count;observedBucketCount=$observedBuckets.Count
        positiveCallBucketCount=$positiveObservedSet.Count;omittedSparseBucketCount=$omittedBuckets.Count
        missingMiddleBucketCount=$missingMiddle.Count
        applicationFallbackWindowCount=$ApplicationFallbackWindows.Count
        coveredApplicationFallbackWindowCount=$coveredApplicationWindows
        positiveCallCoveredApplicationFallbackWindowCount=$positiveCallCoveredApplicationWindows
        applicationActiveBucketCount=$applicationActiveBuckets.Count
        unobservedApplicationActiveBucketCount=$unobservedActiveBuckets.Count
        zeroCallApplicationActiveBucketCount=$zeroCallApplicationActiveBuckets.Count
        positiveCallCoveragePassed=($positiveCallCoveredApplicationWindows -eq $ApplicationFallbackWindows.Count -and
            $zeroCallApplicationActiveBuckets.Count -eq 0)
        expectedBucketSetSha256=(Get-HfCanonicalSha256 ([ordered]@{buckets=@($expectedBuckets)}))
        observedBucketSetSha256=(Get-HfCanonicalSha256 ([ordered]@{buckets=@($observedBuckets)}))
        positiveCallBucketSetSha256=(Get-HfCanonicalSha256 ([ordered]@{buckets=@($positiveBucketTexts)}))
        applicationActiveBucketSetSha256=(Get-HfCanonicalSha256 ([ordered]@{buckets=@($applicationActiveBucketTexts)}))
        observedBucketOrdinals=$observedOrdinals;positiveCallBucketOrdinals=$positiveOrdinals
        applicationActiveBucketOrdinals=$applicationActiveOrdinals
        sparseBucketsPermittedOnlyWithoutApplicationActivity=$true;complete=$true
    }
}

function Resolve-HistoryFallbackPiSqlStatistics {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Config,
        [Parameter(Mandatory=$true)][object[]]$MetricList,
        [int]$PageCount = 1
    )
    $identity = $Config.Identity
    $identityRecords = @{}
    foreach ($metricResult in @($MetricList)) {
        $key = Get-HfValue $metricResult "Key" $null
        $dimensions = Get-HfValue $key "Dimensions" $null
        $dbId = [string](Get-HfValue $dimensions "db.sql_tokenized.db_id" "")
        $tokenId = [string](Get-HfValue $dimensions "db.sql_tokenized.id" "")
        $statement = [string](Get-HfValue $dimensions "db.sql_tokenized.statement" "")
        if ($dbId -or $tokenId -or $statement) {
            $recordKey = "$dbId|$tokenId|$(Get-HfTextSha256 $statement)"
            $identityRecords[$recordKey] = [pscustomobject]@{DbId=$dbId;TokenId=$tokenId;Statement=$statement}
        }
    }
    if ($identityRecords.Count -eq 0) { return New-HfSqlStatsGateResult $Config @("missing_query_identity") 0 }
    if ($identityRecords.Count -ne 1) { return New-HfSqlStatsGateResult $Config @("ambiguous_query_identity") $identityRecords.Count }
    $record = @($identityRecords.Values)[0]
    $lowerStatement = $record.Statement.ToLowerInvariant()
    if ($record.DbId -cne $identity.QueryIdentifier) {
        return New-HfSqlStatsGateResult $Config @("native_query_identifier_mismatch") 1
    }
    if ([string]::IsNullOrWhiteSpace($record.TokenId) -or [string]::IsNullOrWhiteSpace($record.Statement) -or
        @($script:HfMarkers | Where-Object { $lowerStatement.Contains($_) }).Count -ne $script:HfMarkers.Count) {
        return New-HfSqlStatsGateResult $Config @("statement_marker_mismatch") 1
    }
    $expectedMetrics = @($script:HfSqlStatsMetrics.Values)
    $metricPoints = @{}
    $ungroupedTotalSeriesHashes = @{}
    $repeatedUngroupedTotalSeriesCount = 0
    foreach ($metric in $expectedMetrics) { $metricPoints[$metric] = @{} }
    foreach ($metricResult in @($MetricList)) {
        $key = Get-HfValue $metricResult "Key" $null
        $metric = [string](Get-HfValue $key "Metric" "")
        $dimensions = Get-HfValue $key "Dimensions" $null
        if ($metric -notin $expectedMetrics) { throw "SQL statistics returned an unreviewed metric." }
        # GetResourceMetrics returns one dimensionless total series in addition
        # to the requested grouped series.  It is scoped by the filter, but it
        # cannot prove the native/tokenized identity, so never integrate it.
        # Identical totals can repeat across service pages; deduplicate them,
        # reject conflicts, and use only the exact dimensioned series below as
        # gate evidence.
        if (Test-HfEmptyObject $dimensions) {
            $totalHash = Get-HfCanonicalSha256 $metricResult
            if ($ungroupedTotalSeriesHashes.ContainsKey($metric)) {
                if ([string]$ungroupedTotalSeriesHashes[$metric] -cne $totalHash) {
                    throw "SQL statistics returned conflicting duplicate ungrouped total series."
                }
                $repeatedUngroupedTotalSeriesCount++
            } else {
                $ungroupedTotalSeriesHashes[$metric] = $totalHash
            }
            continue
        }
        if ([string](Get-HfValue $dimensions "db.sql_tokenized.db_id" "") -cne $record.DbId -or
            [string](Get-HfValue $dimensions "db.sql_tokenized.id" "") -cne $record.TokenId -or
            [string](Get-HfValue $dimensions "db.sql_tokenized.statement" "") -cne $record.Statement) {
            throw "SQL statistics metric identity changed within a snapshot."
        }
        foreach ($point in @((Get-HfValue $metricResult "DataPoints" @()))) {
            $timestampText = [string](Get-HfValue $point "Timestamp" "")
            $rawValue = Get-HfValue $point "Value" $null
            if (-not (Test-HfFiniteNonnegativeNumber $rawValue)) { throw "SQL statistics returned a malformed metric value." }
            try { $timestamp = ([DateTimeOffset]$timestampText).ToUniversalTime() }
            catch { throw "SQL statistics returned a malformed metric timestamp." }
            # PI StartTime is inclusive and EndTime is exclusive.  Accepting a
            # point stamped exactly at EvidenceEnd would let an adjacent bucket
            # leak into the integrated call and I/O totals.
            if ($timestamp -lt $Config.EvidenceStart -or $timestamp -ge $Config.EvidenceEnd) {
                throw "SQL statistics returned an out-of-window metric timestamp."
            }
            $canonical = $timestamp.ToString("o")
            $value = [double]$rawValue
            if ($metricPoints[$metric].ContainsKey($canonical)) {
                if ([double]$metricPoints[$metric][$canonical] -ne $value) {
                    throw "SQL statistics returned conflicting duplicate metric points."
                }
                continue
            }
            $metricPoints[$metric][$canonical] = $value
        }
    }
    foreach ($metric in $expectedMetrics) {
        if ($metricPoints[$metric].Count -lt 1) { throw "SQL statistics did not return complete call and I/O metrics." }
    }
    $reference = [string]$script:HfSqlStatsMetrics.calls
    $referenceTimestamps = @($metricPoints[$reference].Keys | Sort-Object)
    foreach ($metric in $expectedMetrics) {
        if (@(Compare-Object $referenceTimestamps @($metricPoints[$metric].Keys | Sort-Object) -SyncWindow 0).Count -ne 0) {
            throw "SQL statistics did not return identical timestamp coverage for all metrics."
        }
    }
    $applicationFallbackWindows = @(Get-HfRequiredValue $Config "ApplicationFallbackWindows")
    $bucketCoverage = Get-HfSqlStatsBucketCoverage $Config $metricPoints[$reference] `
        $applicationFallbackWindows ([long]$Config.ApplicationDatabaseReadCount)
    $totals = @{}
    $pointCounts = [ordered]@{}
    foreach ($entry in $script:HfSqlStatsMetrics.GetEnumerator()) {
        $sum = [double](($metricPoints[[string]$entry.Value].Values | Measure-Object -Sum).Sum)
        if ([double]::IsNaN($sum) -or [double]::IsInfinity($sum) -or $sum -lt 0) {
            throw "SQL statistics aggregate was malformed."
        }
        $totals[[string]$entry.Key] = $sum
        $pointCounts[[string]$entry.Key] = $metricPoints[[string]$entry.Value].Count
    }
    $integratedCalls = $totals.calls * $script:HfPeriodSeconds
    $positiveCalls = $totals.calls -gt 0
    $positiveTotalTime = $totals.totalTime -gt 0
    $rawBlockReadShare = if ($positiveTotalTime) { ($totals.blockReadTime / $totals.totalTime) * 100.0 } else { $null }
    $callsCover = $positiveCalls -and ($integratedCalls -ge [double]$Config.ApplicationDatabaseReadCount)
    $temporaryIoAbsent = $totals.tempBlocksRead -eq 0.0 -and $totals.tempBlocksWritten -eq 0.0
    $failureReasons = @()
    if (-not $positiveCalls) { $failureReasons += "missing_positive_calls" }
    if (-not $positiveTotalTime) { $failureReasons += "missing_positive_total_time" }
    if (-not $callsCover) { $failureReasons += "pi_call_undercount" }
    if ((Get-HfValue $bucketCoverage "positiveCallCoveragePassed" $false) -ne $true) {
        $failureReasons += "application_active_bucket_without_positive_calls"
    }
    if (-not $temporaryIoAbsent) { $failureReasons += "temporary_io_observed" }
    if ($positiveTotalTime -and $rawBlockReadShare -ge $script:HfIoThresholdPercent) {
        $failureReasons += "block_read_time_dominant"
    }
    $tokenSha256 = Get-HfCanonicalSha256 ([ordered]@{
        queryIdentifierSha256=$identity.QueryIdentifierSha256;supportId=$record.TokenId;statement=$record.Statement
    })
    return [pscustomobject]@{
        CanSample=$true;TokenId=$record.TokenId;TokenSha256=$tokenSha256;Statement=$record.Statement
        Evidence=[ordered]@{
            historyFallbackPiEvidenceVersion=$script:HfPiEvidenceVersion
            identityCount=1;queryIdentifierSha256=$identity.QueryIdentifierSha256
            compiledSqlSha256=$identity.CompiledSqlSha256
            parameterTypeSignatureSha256=$identity.ParameterTypeSignatureSha256
            schemaIdentitySha256=$identity.SchemaIdentitySha256
            releaseIdentitySha256=$Config.ReleaseIdentitySha256
            databaseResourceIdSha256=(Get-HfTextSha256 $Config.DatabaseResourceId)
            tokenSha256=$tokenSha256;statementSha256=(Get-HfTextSha256 $record.Statement)
            exactQueryIdentifierMatched=$true;statementMarkersMatched=$true
            periodSeconds=$script:HfPeriodSeconds;pageCount=$PageCount;metricPointCounts=$pointCounts
            bucketCoverage=$bucketCoverage
            ignoredUngroupedTotalSeriesCount=$ungroupedTotalSeriesHashes.Count
            repeatedUngroupedTotalSeriesCount=$repeatedUngroupedTotalSeriesCount
            positiveCallsObserved=$positiveCalls;integratedCalls=[math]::Round($integratedCalls,6)
            applicationDatabaseReadCount=$Config.ApplicationDatabaseReadCount
            callsCoverApplicationReads=$callsCover
            totalTimePerSecondSum=[math]::Round($totals.totalTime,9)
            blockReadTimePerSecondSum=[math]::Round($totals.blockReadTime,9)
            blockReadTimeSharePercent=if($positiveTotalTime){[math]::Round($rawBlockReadShare,6)}else{$null}
            sharedBlocksReadPerSecondSum=[math]::Round($totals.sharedBlocksRead,9)
            tempBlocksReadPerSecondSum=[math]::Round($totals.tempBlocksRead,9)
            tempBlocksWrittenPerSecondSum=[math]::Round($totals.tempBlocksWritten,9)
            temporaryIoAbsent=$temporaryIoAbsent;dominanceThresholdPercent=$script:HfIoThresholdPercent
            failureReasons=@($failureReasons);passed=($failureReasons.Count -eq 0)
        }
    }
}

function Resolve-HistoryFallbackPiSampledLoad {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Config,
        [Parameter(Mandatory=$true)]$SqlStatistics,
        [object[]]$SampledKeys = @(),
        [object[]]$WaitKeys = @(),
        [int]$SampledPageCount = 1,
        [int]$WaitPageCount = 0
    )
    if ((Get-HfValue $SqlStatistics "CanSample" $false) -ne $true) {
        return [ordered]@{status="not_evaluated_identity_gate_failed";sampledDbLoad=$null;tokenCount=0
            filteredWaitEventEvidenceRequired=$false;filteredWaitEventEvidenceComplete=$false
            failureReasons=@("sql_identity_gate_failed");passed=$false}
    }
    $keys = @($SampledKeys)
    if ($keys.Count -eq 0) {
        return [ordered]@{status="not_applicable_zero_sampled_load";sampledDbLoad=0.0;tokenCount=0
            pageCount=$SampledPageCount;filteredWaitEventEvidenceRequired=$false
            filteredWaitEventEvidenceComplete=$true;dataFileReadSharePercent=$null
            dominanceThresholdPercent=$script:HfIoThresholdPercent;failureReasons=@();passed=$true}
    }
    if ($keys.Count -ne 1) {
        return [ordered]@{status="ambiguous_sampled_identity";sampledDbLoad=$null;tokenCount=$keys.Count
            pageCount=$SampledPageCount;filteredWaitEventEvidenceRequired=$false
            filteredWaitEventEvidenceComplete=$false;failureReasons=@("ambiguous_sampled_identity");passed=$false}
    }
    $dimensions = Get-HfValue $keys[0] "Dimensions" $null
    $dbId = [string](Get-HfValue $dimensions "db.sql_tokenized.db_id" "")
    $tokenId = [string](Get-HfValue $dimensions "db.sql_tokenized.id" "")
    $statement = [string](Get-HfValue $dimensions "db.sql_tokenized.statement" "")
    $rawLoad = Get-HfValue $keys[0] "Total" $null
    if (-not (Test-HfFiniteNonnegativeNumber $rawLoad)) { throw "Sampled SQL load was malformed." }
    $load = [double]$rawLoad
    $lowerStatement = $statement.ToLowerInvariant()
    $tokenSha = Get-HfCanonicalSha256 ([ordered]@{
        queryIdentifierSha256=$Config.Identity.QueryIdentifierSha256;supportId=$tokenId;statement=$statement
    })
    if ($dbId -cne $Config.Identity.QueryIdentifier -or $tokenId -cne $SqlStatistics.TokenId -or
        $statement -cne $SqlStatistics.Statement -or $tokenSha -cne $SqlStatistics.TokenSha256 -or
        @($script:HfMarkers | Where-Object { $lowerStatement.Contains($_) }).Count -ne $script:HfMarkers.Count) {
        return [ordered]@{status="sampled_identity_mismatch";sampledDbLoad=[math]::Round($load,6);tokenCount=1
            pageCount=$SampledPageCount;filteredWaitEventEvidenceRequired=($load -gt 0)
            filteredWaitEventEvidenceComplete=$false;failureReasons=@("sampled_identity_mismatch");passed=$false}
    }
    if ($load -eq 0) {
        return [ordered]@{status="not_applicable_zero_sampled_load";sampledDbLoad=0.0;tokenCount=1
            pageCount=$SampledPageCount;tokenSha256=$tokenSha;filteredWaitEventEvidenceRequired=$false
            filteredWaitEventEvidenceComplete=$true;dataFileReadSharePercent=$null
            dominanceThresholdPercent=$script:HfIoThresholdPercent;failureReasons=@();passed=$true}
    }
    $waits = @($WaitKeys)
    if ($waits.Count -eq 0) {
        return [ordered]@{status="sampled_load_wait_evidence_incomplete";sampledDbLoad=[math]::Round($load,6)
            tokenCount=1;pageCount=$SampledPageCount;tokenSha256=$tokenSha
            filteredWaitEventEvidenceRequired=$true;filteredWaitEventEvidenceComplete=$false
            dataFileReadSharePercent=$null;dominanceThresholdPercent=$script:HfIoThresholdPercent
            failureReasons=@("missing_wait_event_evidence");passed=$false}
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $waitLoad = 0.0
    $dataFileReadLoad = 0.0
    foreach ($key in $waits) {
        $waitDimensions = Get-HfValue $key "Dimensions" $null
        $name = [string](Get-HfValue $waitDimensions "db.wait_event.name" "")
        $type = [string](Get-HfValue $waitDimensions "db.wait_event.type" "")
        $rawWaitLoad = Get-HfValue $key "Total" $null
        if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($type) -or
            -not (Test-HfFiniteNonnegativeNumber $rawWaitLoad) -or -not $seen.Add("$type`:$name")) {
            throw "Filtered wait-event evidence was malformed."
        }
        $value = [double]$rawWaitLoad
        $waitLoad += $value
        if (($type -ieq "IO" -and $name -ieq "DataFileRead") -or $name -ieq "IO:DataFileRead") {
            $dataFileReadLoad += $value
        }
    }
    $allowedDifference = [math]::Max(0.000001, $load * ($script:HfWaitCoverageTolerancePercent / 100.0))
    $complete = [math]::Abs($waitLoad - $load) -le $allowedDifference
    $rawShare = if ($waitLoad -gt 0) { ($dataFileReadLoad / $waitLoad) * 100.0 } else { $null }
    $failureReasons = @()
    if (-not $complete -or $waitLoad -le 0) { $failureReasons += "incomplete_wait_event_coverage" }
    if ($waitLoad -gt 0 -and $rawShare -ge $script:HfIoThresholdPercent) {
        $failureReasons += "sampled_data_file_read_dominant"
    }
    return [ordered]@{
        status="sampled_load_wait_events_required";sampledDbLoad=[math]::Round($load,6);tokenCount=1
        pageCount=$SampledPageCount;tokenSha256=$tokenSha;filteredWaitEventEvidenceRequired=$true
        filteredWaitEventEvidenceComplete=$complete;waitEventCount=$waits.Count;waitPageCount=$WaitPageCount
        filteredWaitEventDbLoad=[math]::Round($waitLoad,6)
        coveragePercent=if($load -gt 0){[math]::Round(($waitLoad/$load)*100.0,6)}else{$null}
        coverageTolerancePercent=$script:HfWaitCoverageTolerancePercent
        dataFileReadDbLoad=[math]::Round($dataFileReadLoad,6)
        dataFileReadSharePercent=if($waitLoad -gt 0){[math]::Round($rawShare,6)}else{$null}
        dominanceThresholdPercent=$script:HfIoThresholdPercent
        failureReasons=@($failureReasons);passed=($failureReasons.Count -eq 0)
    }
}

function Get-HfSqlStatsMetricList {
    param($Config)
    $dimensions = @("db.sql_tokenized.db_id", "db.sql_tokenized.id", "db.sql_tokenized.statement")
    $queries = @($script:HfSqlStatsMetrics.GetEnumerator() | ForEach-Object {
        [ordered]@{Metric=[string]$_.Value;GroupBy=[ordered]@{Group="db.sql_tokenized";Dimensions=$dimensions;Limit=25}
            Filter=[ordered]@{"db.sql_tokenized.db_id"=[string]$Config.Identity.QueryIdentifier}}
    })
    $base = @("pi", "get-resource-metrics", "--region", $Config.Region, "--service-type", "RDS",
        "--identifier", $Config.DatabaseResourceId, "--start-time", $Config.EvidenceStart.ToString("o"),
        "--end-time", $Config.EvidenceEnd.ToString("o"), "--period-in-seconds", [string]$script:HfPeriodSeconds,
        "--period-alignment", "START_TIME",
        "--metric-queries", ($queries | ConvertTo-Json -Depth 10 -Compress))
    $results = [Collections.Generic.List[object]]::new()
    $seenTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $token = $null
    $pageCount = 0
    $recordCount = 0
    do {
        $pageCount++
        if ($pageCount -gt $script:HfMaximumPages) { throw "SQL-statistics pagination exceeded 100 pages." }
        $arguments = @($base) + @("--no-paginate")
        if ($token) { $arguments += @("--next-token", $token) }
        $page = Invoke-HfAwsJson $arguments
        if ($null -eq $page) { throw "SQL-statistics pagination returned an empty page." }
        $alignedStart = [string](Get-HfValue $page "AlignedStartTime" "")
        $alignedEnd = [string](Get-HfValue $page "AlignedEndTime" "")
        try {
            $parsedAlignedStart = ([DateTimeOffset]$alignedStart).ToUniversalTime()
            $parsedAlignedEnd = ([DateTimeOffset]$alignedEnd).ToUniversalTime()
        }
        catch { throw "SQL-statistics pagination did not return valid aligned bounds." }
        if ([string](Get-HfValue $page "Identifier" "") -cne $Config.DatabaseResourceId -or
            $parsedAlignedStart -ne $Config.EvidenceStart -or $parsedAlignedEnd -ne $Config.EvidenceEnd) {
            throw "SQL-statistics pagination did not preserve the exact minute-aligned evidence window."
        }
        foreach ($metric in @((Get-HfValue $page "MetricList" @()))) {
            $results.Add($metric)
            $recordCount++
            $recordCount += @((Get-HfValue $metric "DataPoints" @())).Count
            if ($recordCount -gt $script:HfMaximumRecords) { throw "SQL-statistics pagination exceeded 10000 records." }
        }
        $token = [string](Get-HfValue $page "NextToken" "")
        if ($token -and -not $seenTokens.Add($token)) { throw "SQL-statistics pagination returned a token cycle." }
    } while ($token)
    return [pscustomobject]@{MetricList=$results.ToArray();PageCount=$pageCount;RecordCount=$recordCount
        AlignedStart=$Config.EvidenceStart;AlignedEnd=$Config.EvidenceEnd}
}

function Assert-HfPiDimensionPage {
    param($Page, $Config)
    try {
        $alignedStart = ([DateTimeOffset]([string](Get-HfRequiredValue $Page "AlignedStartTime"))).ToUniversalTime()
        $alignedEnd = ([DateTimeOffset]([string](Get-HfRequiredValue $Page "AlignedEndTime"))).ToUniversalTime()
    }
    catch { throw "PI dimension evidence did not return valid aligned bounds." }
    if ($alignedStart -ne $Config.EvidenceStart -or $alignedEnd -ne $Config.EvidenceEnd) {
        throw "PI dimension evidence did not preserve the exact minute-aligned evidence window."
    }
}

function Get-HfSampledKeys {
    param($Config)
    $filter = ([ordered]@{"db.sql_tokenized.db_id"=[string]$Config.Identity.QueryIdentifier} | ConvertTo-Json -Compress)
    return Invoke-HfAwsJsonPages -Arguments @("pi", "describe-dimension-keys", "--region", $Config.Region,
        "--service-type", "RDS", "--identifier", $Config.DatabaseResourceId,
        "--start-time", $Config.EvidenceStart.ToString("o"), "--end-time", $Config.EvidenceEnd.ToString("o"),
        "--period-in-seconds", [string]$script:HfPeriodSeconds, "--metric", "db.load.avg",
        "--group-by", "Group=db.sql_tokenized,Dimensions=[db.sql_tokenized.db_id,db.sql_tokenized.id,db.sql_tokenized.statement],Limit=25",
        "--filter", $filter) -ItemsProperty "Keys" -TokenProperty "NextToken" -Identity {
            param($key)
            $dimensions = Get-HfValue $key "Dimensions" $null
            return "$([string](Get-HfValue $dimensions 'db.sql_tokenized.db_id' ''))|$([string](Get-HfValue $dimensions 'db.sql_tokenized.id' ''))"
        } -PageValidator { param($page) Assert-HfPiDimensionPage $page $Config }
}

function Get-HfWaitKeys {
    param($Config, [string]$SupportTokenId)
    $filter = ([ordered]@{
        "db.sql_tokenized.db_id"=[string]$Config.Identity.QueryIdentifier
        "db.sql_tokenized.id"=$SupportTokenId
    } | ConvertTo-Json -Compress)
    return Invoke-HfAwsJsonPages -Arguments @("pi", "describe-dimension-keys", "--region", $Config.Region,
        "--service-type", "RDS", "--identifier", $Config.DatabaseResourceId,
        "--start-time", $Config.EvidenceStart.ToString("o"), "--end-time", $Config.EvidenceEnd.ToString("o"),
        "--period-in-seconds", [string]$script:HfPeriodSeconds, "--metric", "db.load.avg",
        "--group-by", "Group=db.wait_event,Limit=25", "--filter", $filter) `
        -ItemsProperty "Keys" -TokenProperty "NextToken" -Identity {
            param($key)
            $dimensions = Get-HfValue $key "Dimensions" $null
            return "$([string](Get-HfValue $dimensions 'db.wait_event.type' ''))|$([string](Get-HfValue $dimensions 'db.wait_event.name' ''))"
        } -PageValidator { param($page) Assert-HfPiDimensionPage $page $Config }
}

function Get-HfSnapshot {
    param($Config)
    try { $hotPath = Get-HfHotPathLogEvidence $Config }
    catch {
        throw (New-HfCollectorException "Hot-path log evidence was unavailable." "hot_path_log_windows" `
            "performance_insights_evidence_unavailable" 0 $null $_.Exception)
    }
    if (-not $hotPath.HasPositive) {
        return [ordered]@{
            historyFallbackPiEvidenceVersion=$script:HfPiEvidenceVersion
            evidenceCollectorVersion=$script:HfCollectorVersion;sanitized=$true;rawSqlPersisted=$false
            rawIdentifiersPersisted=$false;queryIdentifierSha256=$Config.Identity.QueryIdentifierSha256
            compiledSqlSha256=$Config.Identity.CompiledSqlSha256
            parameterTypeSignatureSha256=$Config.Identity.ParameterTypeSignatureSha256
            schemaIdentitySha256=$Config.Identity.SchemaIdentitySha256
            apiRuntimeTaskDefinitionSha256=$Config.ApiTaskDefinitionSha256
            trackIoTiming=$Config.Identity.TrackIoTiming
            releaseIdentitySha256=$Config.ReleaseIdentitySha256
            trafficWindowSha256=(Get-HfCanonicalSha256 ([ordered]@{
                startUtc=$Config.TrafficStart.ToString("o");endUtc=$Config.TrafficEnd.ToString("o");coherent=$true
            }))
            evidenceWindow=[ordered]@{
                alignment="utc-minute-interior-v1";periodAlignment="START_TIME"
                startUtc=$Config.EvidenceStart.ToString("o");endUtc=$Config.EvidenceEnd.ToString("o")
                coherentCoveragePercent=[math]::Round((($Config.EvidenceEnd-$Config.EvidenceStart).TotalMilliseconds /
                    ($Config.TrafficEnd-$Config.TrafficStart).TotalMilliseconds)*100.0,6)
            }
            hotPathLogEvidenceSha256=(Get-HfCanonicalSha256 $hotPath.Evidence)
            hotPathLogEvidence=$hotPath.Evidence
            sqlStatistics=$null;sampledLoad=$null;passed=$false
        }
    }
    $snapshotConfig = $Config.PSObject.Copy()
    $snapshotConfig | Add-Member -NotePropertyName ApplicationDatabaseReadCount `
        -NotePropertyValue ([long]$hotPath.DatabaseReadCount) -Force
    $snapshotConfig | Add-Member -NotePropertyName ApplicationFallbackWindows `
        -NotePropertyValue @($hotPath.Evidence.fallbackPositiveIntervals) -Force
    try {
        $rawStats = Get-HfSqlStatsMetricList $snapshotConfig
        $sqlStatistics = Resolve-HistoryFallbackPiSqlStatistics $snapshotConfig @($rawStats.MetricList) $rawStats.PageCount
    }
    catch {
        throw (New-HfCollectorException "Fallback SQL-statistics evidence was unavailable." "fallback_sql_stats" `
            "performance_insights_evidence_unavailable" 0 $hotPath.Evidence $_.Exception)
    }
    try {
        $sampled = if ($sqlStatistics.CanSample -eq $true) {
            $sampledKeys = Get-HfSampledKeys $snapshotConfig
            $positive = @($sampledKeys.Items).Count -eq 1 -and
                (Test-HfFiniteNonnegativeNumber (Get-HfValue $sampledKeys.Items[0] "Total" $null)) -and
                [double](Get-HfValue $sampledKeys.Items[0] "Total" 0) -gt 0
            $waitKeys = if ($positive) { Get-HfWaitKeys $snapshotConfig $sqlStatistics.TokenId } else {
                [pscustomobject]@{Items=@();PageCount=0;RecordCount=0}
            }
            Resolve-HistoryFallbackPiSampledLoad $snapshotConfig $sqlStatistics @($sampledKeys.Items) @($waitKeys.Items) `
                $sampledKeys.PageCount $waitKeys.PageCount
        } else {
            Resolve-HistoryFallbackPiSampledLoad $snapshotConfig $sqlStatistics
        }
    }
    catch {
        throw (New-HfCollectorException "Fallback sampled-load evidence was unavailable." "fallback_sampled_load" `
            "performance_insights_evidence_unavailable" 0 ([ordered]@{
                hotPathLogEvidence=$hotPath.Evidence;sqlStatistics=$sqlStatistics.Evidence
            }) $_.Exception)
    }
    $passed = (Get-HfValue $sqlStatistics.Evidence "passed" $false) -eq $true -and
        (Get-HfValue $sampled "passed" $false) -eq $true -and
        (Get-HfValue $hotPath.Evidence "passed" $false) -eq $true
    return [ordered]@{
        historyFallbackPiEvidenceVersion=$script:HfPiEvidenceVersion
        evidenceCollectorVersion=$script:HfCollectorVersion;sanitized=$true;rawSqlPersisted=$false
        rawIdentifiersPersisted=$false;queryIdentifierSha256=$Config.Identity.QueryIdentifierSha256
        compiledSqlSha256=$Config.Identity.CompiledSqlSha256
        parameterTypeSignatureSha256=$Config.Identity.ParameterTypeSignatureSha256
        schemaIdentitySha256=$Config.Identity.SchemaIdentitySha256
        apiRuntimeTaskDefinitionSha256=$Config.ApiTaskDefinitionSha256
        trackIoTiming=$Config.Identity.TrackIoTiming
        releaseIdentitySha256=$Config.ReleaseIdentitySha256
        trafficWindowSha256=(Get-HfCanonicalSha256 ([ordered]@{
            startUtc=$Config.TrafficStart.ToString("o");endUtc=$Config.TrafficEnd.ToString("o");coherent=$true
        }))
        evidenceWindow=[ordered]@{
            alignment="utc-minute-interior-v1";periodAlignment="START_TIME"
            startUtc=$Config.EvidenceStart.ToString("o");endUtc=$Config.EvidenceEnd.ToString("o")
            coherentCoveragePercent=[math]::Round((($Config.EvidenceEnd-$Config.EvidenceStart).TotalMilliseconds /
                ($Config.TrafficEnd-$Config.TrafficStart).TotalMilliseconds)*100.0,6)
        }
        hotPathLogEvidenceSha256=(Get-HfCanonicalSha256 $hotPath.Evidence)
        hotPathLogEvidence=$hotPath.Evidence
        sqlStatistics=$sqlStatistics.Evidence;sampledLoad=$sampled;passed=$passed
    }
}

function Get-HfNow { return [DateTimeOffset]::UtcNow }
function Wait-HfDelay { param([int]$Seconds) if ($Seconds -gt 0) { Start-Sleep -Seconds $Seconds } }

function Get-HfStabilizedSnapshot {
    param($Config)
    $notBefore = $Config.TrafficEnd.AddMinutes($script:HfInitialDelayMinutes)
    $deadline = $Config.TrafficEnd.AddMinutes($script:HfDeadlineMinutes)
    $now = Get-HfNow
    if ($now -ge $deadline) {
        throw (New-HfCollectorException "PI stabilization began after its evidence deadline." "snapshot_stabilization")
    }
    if ($now -lt $notBefore) { Wait-HfDelay ([int][math]::Ceiling(($notBefore-$now).TotalSeconds)) }
    $priorHash = $null
    $priorCompletedAt = $null
    $lastComplete = $null
    $lastCompleteHash = $null
    $lastFailure = $null
    $attemptCount = 0
    while ((Get-HfNow) -lt $deadline) {
        $attemptCount++
        try {
            $snapshot = Get-HfSnapshot $Config
            $completedAt = Get-HfNow
            if ($completedAt -gt $deadline) {
                throw (New-HfCollectorException "PI snapshot completed after its evidence deadline." "snapshot_stabilization")
            }
            $hash = Get-HfCanonicalSha256 $snapshot
            $lastComplete = $snapshot
            $lastCompleteHash = $hash
            if ($priorHash -and $hash -ceq $priorHash -and
                ($completedAt - $priorCompletedAt).TotalSeconds -ge $script:HfPollSeconds) {
                return [pscustomobject]@{Evidence=$snapshot;AttemptCount=$attemptCount;CanonicalSha256=$hash}
            }
            $priorHash = $hash
            $priorCompletedAt = $completedAt
            $lastFailure = $null
        }
        catch {
            $lastFailure = $_
            $priorHash = $null
            $priorCompletedAt = $null
        }
        $now = Get-HfNow
        if ($now -ge $deadline) { break }
        $wakeAt = $now.AddSeconds($script:HfPollSeconds)
        if ($wakeAt -gt $deadline) { $wakeAt = $deadline }
        Wait-HfDelay ([int][math]::Ceiling(($wakeAt-$now).TotalSeconds))
    }
    if ($null -ne $lastFailure) {
        $stage = [string](Get-HfValue $lastFailure.Exception.Data "failureStage" "snapshot_collection")
        throw (New-HfCollectorException "PI did not produce a complete stable snapshot." $stage `
            "performance_insights_evidence_unavailable" $attemptCount $null $lastFailure.Exception)
    }
    $partial = if ($null -eq $lastComplete) { $null } else { [ordered]@{
        lastCompleteSnapshot=$lastComplete;lastCompleteCanonicalSha256=$lastCompleteHash
        stableConsecutiveSnapshotCount=1
    }}
    throw (New-HfCollectorException "PI did not produce two consecutive identical snapshots." `
        "snapshot_stabilization" "performance_insights_evidence_unavailable" $attemptCount $partial)
}

function Test-HfForbiddenRawIdentifierKey {
    param($Value)
    if ($null -eq $Value) { return $false }
    if ($Value -is [Collections.IDictionary]) {
        foreach ($key in $Value.Keys) {
            if ([string]$key -ceq "queryIdentifier") { return $true }
            if (Test-HfForbiddenRawIdentifierKey $Value[$key]) { return $true }
        }
        return $false
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
        foreach ($item in $Value) { if (Test-HfForbiddenRawIdentifierKey $item) { return $true } }
        return $false
    }
    foreach ($property in @($Value.PSObject.Properties)) {
        if ($property.Name -ceq "queryIdentifier") { return $true }
        if (Test-HfForbiddenRawIdentifierKey $property.Value) { return $true }
    }
    return $false
}

function New-HfReceiptBase {
    param($Config)
    return [ordered]@{
        schemaVersion=1;type=$script:HfReceiptType
        historyFallbackPiEvidenceVersion=$script:HfPiEvidenceVersion
        evidenceCollectorVersion=$script:HfCollectorVersion
        runId=$Config.RunId;chainId=$Config.ChainId;phase=$Config.Phase;stage=$Config.Stage
        requestSha256=$Config.Request.Sha256
        queryIdentityReceiptSha256=$Config.Identity.Receipt.Sha256
        queryIdentifierSha256=$Config.Identity.QueryIdentifierSha256
        compiledSqlSha256=$Config.Identity.CompiledSqlSha256
        parameterTypeSignatureSha256=$Config.Identity.ParameterTypeSignatureSha256
        schemaIdentitySha256=$Config.Identity.SchemaIdentitySha256
        apiRuntimeTaskDefinitionSha256=$Config.ApiTaskDefinitionSha256
        trackIoTiming=$Config.Identity.TrackIoTiming
        releaseIdentitySha256=$Config.ReleaseIdentitySha256
        databaseResourceIdSha256=Get-HfTextSha256 $Config.DatabaseResourceId
        rawSqlPersisted=$false;rawIdentifiersPersisted=$false;rawErrorPersisted=$false
    }
}

function Invoke-HistoryFallbackPiFinalization {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$RequestPath,
        [Parameter(Mandatory=$true)][string]$ExpectedRequestSha256,
        [Parameter(Mandatory=$true)][string]$OutputPath
    )
    $config = Read-HistoryFallbackPiFinalizationRequest $RequestPath $ExpectedRequestSha256
    $output = Resolve-HfExternalPath $OutputPath "OutputPath" -AllowMissing
    if (Test-Path -LiteralPath $output) {
        throw "The immutable history fallback PI evidence receipt already exists; use a fresh path."
    }
    $config | Add-Member -NotePropertyName ReleaseIdentitySha256 -NotePropertyValue `
        (Get-HfCanonicalSha256 ([ordered]@{
            applicationGitSha=$config.ApplicationGitSha;deployedImageDigest=$config.ImageDigest
            apiTaskDefinitionArn=$config.ApiTaskDefinitionArn;workerTaskDefinitionArn=$config.WorkerTaskDefinitionArn
        })) -Force
    $base = New-HfReceiptBase $config
    $receipt = $null
    try {
        try { $preflight = Assert-HfAwsPreflight $config }
        catch {
            throw (New-HfCollectorException "AWS release and database preflight failed." "aws_preflight" `
                "performance_insights_evidence_unavailable" 0 $null $_.Exception)
        }
        $stabilized = Get-HfStabilizedSnapshot $config
        $passed = (Get-HfValue $stabilized.Evidence "passed" $false) -eq $true
        $receipt = [ordered]@{} + $base
        $receipt["state"] = "completed"
        $receipt["collected"] = $true
        $receipt["passed"] = $passed
        $receipt["attemptCount"] = $stabilized.AttemptCount
        $receipt["completedAtUtc"] = [DateTimeOffset]::UtcNow.ToString("o")
        $receipt["failureCode"] = if($passed){$null}else{"history_fallback_pi_gate_failed"}
        $receipt["failureStage"] = if($passed){$null}else{"history_fallback_gate"}
        $receipt["discardedMessageSha256"] = $null
        $receipt["preflight"] = $preflight
        $receipt["stableSnapshotSha256"] = $stabilized.CanonicalSha256
        $receipt["evidence"] = $stabilized.Evidence
        $receipt["partial"] = $null
    }
    catch {
        $classification = Get-HfCollectorFailureClassification $_.Exception
        $receipt = [ordered]@{} + $base
        $receipt["state"] = "failed"
        $receipt["collected"] = $false
        $receipt["passed"] = $false
        $receipt["attemptCount"] = $classification.attemptCount
        $receipt["completedAtUtc"] = [DateTimeOffset]::UtcNow.ToString("o")
        $receipt["failureCode"] = $classification.failureCode
        $receipt["failureStage"] = $classification.failureStage
        $receipt["discardedMessageSha256"] = Get-HfTextSha256 $_.Exception.Message
        $receipt["preflight"] = $null
        $receipt["stableSnapshotSha256"] = $null
        $receipt["evidence"] = $null
        $receipt["partial"] = $classification.partialEvidence
    }
    if (Test-HfForbiddenRawIdentifierKey $receipt) {
        throw "The PI evidence receipt attempted to persist a forbidden raw query identifier."
    }
    Write-HfPrivateImmutableJson $output $receipt
    return [ordered]@{
        schemaVersion=1;type="history_fallback_pi_evidence_reference";path=$output
        sha256=Get-HfFileSha256 $output;historyFallbackPiEvidenceVersion=$script:HfPiEvidenceVersion
        collected=$receipt.collected;passed=$receipt.passed;failureCode=$receipt.failureCode
        queryIdentifierSha256=$config.Identity.QueryIdentifierSha256
        releaseIdentitySha256=$config.ReleaseIdentitySha256
    }
}

Export-ModuleMember -Function @(
    "Invoke-HistoryFallbackPiFinalization",
    "Test-HistoryFallbackPiFinalizationRequest",
    "Resolve-HistoryFallbackPiSqlStatistics",
    "Resolve-HistoryFallbackPiSampledLoad",
    "Resolve-HistoryFallbackHotPathLogEvidence"
)
