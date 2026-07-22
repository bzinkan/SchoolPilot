#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Acquire", "Validate", "Restore", "Watchdog")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$DbInstanceIdentifier,

    [Parameter(Mandatory = $true)]
    [string]$ReceiptPath,

    [string]$ExpectedReceiptSha256,
    [string]$Region = "us-east-1",
    [string]$ExpectedAccountId = "135775632425",
    [string]$ExpectedRdsInstanceClass = "db.t4g.medium",

    [ValidateSet("diagnostic", "certification")]
    [string]$LeasePurpose = "diagnostic",

    [ValidateRange(15, 720)]
    [int]$MaximumLeaseMinutes = 90,

    [ValidateRange(1, 60)]
    [int]$PollSeconds = 15,

    [ValidateRange(60, 1800)]
    [int]$TimeoutSeconds = 900
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:DatabaseInsightsLeaseVersion = "database-insights-monitoring-lease-v2"
$script:DatabaseInsightsAdvancedRetentionDays = 465
$script:DatabaseInsightsStandardRetentionDays = 7
$script:DatabaseInsightsRepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:DatabaseInsightsAwsProcessTimeoutMilliseconds = 60000
$script:DatabaseInsightsWatchdogPollSeconds = 30
$script:DatabaseInsightsWatchdogHeartbeatStaleSeconds = 90
$script:DatabaseInsightsDurableRestoreGuardVersion = "aws-scheduler-ssm-recurring-restore-v1"
$script:DatabaseInsightsDurableRestoreAutomationVersion = "ssm-rds-monitoring-restore-v1"
$script:DatabaseInsightsDurableRestoreTargetArn = "arn:aws:scheduler:::aws-sdk:ssm:startAutomationExecution"
$script:DatabaseInsightsDurableRestoreMaximumEventAgeSeconds = 60
$script:DatabaseInsightsDurableRestoreMaximumRetryAttempts = 0
$script:DatabaseInsightsDurableRestoreCadenceMinutes = 15
$script:DatabaseInsightsDurableRestoreDocumentVersion = "1"
$script:DatabaseInsightsDurableRestoreFailureRetentionSeconds = 1209600

function Get-DatabaseInsightsValue {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    if ($Object -is [Collections.IDictionary]) {
        if (-not $Object.Contains($Name) -or $null -eq $Object[$Name]) { return $Default }
        return $Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Get-DatabaseInsightsTextSha256 {
    param([string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.UTF8Encoding]::new($false).GetBytes($Text)
    )).ToLowerInvariant()
}

function Get-DatabaseInsightsFileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-DatabaseInsightsSha256 {
    param([string]$Value, [string]$Name)
    $normalized = $Value.ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{64}$') { throw "$Name must be an exact SHA-256 digest." }
    return $normalized
}

function Resolve-DatabaseInsightsReceiptPath {
    param([string]$Path)
    $repositoryRoot = $script:DatabaseInsightsRepositoryRoot
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw "ReceiptPath must be an absolute path outside the repository."
    }
    $resolved = [IO.Path]::GetFullPath($Path)
    $root = $repositoryRoot.TrimEnd('\', '/')
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if ([string]::Equals($resolved, $root, $comparison) -or
        $resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw "ReceiptPath must be outside the repository."
    }
    $parent = [IO.Path]::GetDirectoryName($resolved)
    if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "ReceiptPath parent directory must already exist."
    }
    return $resolved
}

function Set-DatabaseInsightsPrivateAcl {
    param([string]$Path)
    if (-not $IsWindows) { throw "Database Insights lease receipts require Windows ACL support." }
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isDirectory = Test-Path -LiteralPath $Path -PathType Container
    $item = Get-Item -LiteralPath $Path
    $security = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, [Security.AccessControl.AccessControlSections]::Access
    )
    $inheritance = if ($isDirectory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($security.GetAccessRules(
            $true, $true, [Security.Principal.SecurityIdentifier]
        ))) {
        [void]$security.RemoveAccessRuleSpecific($existingRule)
    }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $current.User,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
    Assert-DatabaseInsightsPrivateAcl -Path $Path
}

function Assert-DatabaseInsightsPrivateAcl {
    param([string]$Path)
    if (-not $IsWindows) { throw "Database Insights lease receipts require Windows ACL support." }
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isDirectory = Test-Path -LiteralPath $Path -PathType Container
    $item = Get-Item -LiteralPath $Path
    $verified = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, [Security.AccessControl.AccessControlSections]::Access
    )
    if (-not $verified.AreAccessRulesProtected) {
        throw "Could not enforce a protected private ACL on the Database Insights lease artifact."
    }
    $expectedInheritance = if ($isDirectory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    $rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 1) {
        throw "Database Insights lease artifacts must be readable only by the current operator."
    }
    $rule = $rules[0]
    if ($rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.IdentityReference.Value -cne $current.User.Value -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne $expectedInheritance -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw "Database Insights lease artifacts must have one exact current-operator FullControl rule."
    }
}

function Write-DatabaseInsightsPrivateJson {
    param([string]$Path, $Value, [switch]$Immutable)
    if ($Immutable -and (Test-Path -LiteralPath $Path)) {
        throw "The immutable Database Insights lease receipt already exists; use a fresh path."
    }
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    $stagingDirectory = Join-Path $parent `
        ".$([IO.Path]::GetFileName($Path)).private.$([Guid]::NewGuid().ToString('N'))"
    $temporary = Join-Path $stagingDirectory "payload.json"
    try {
        # No sensitive bytes are written beneath a permissive caller-owned
        # directory.  The empty staging directory and empty file are protected
        # first; only then is the JSON materialized and atomically moved.
        [void](New-Item -ItemType Directory -Path $stagingDirectory)
        Set-DatabaseInsightsPrivateAcl -Path $stagingDirectory
        $empty = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $empty.Dispose()
        Set-DatabaseInsightsPrivateAcl -Path $temporary
        [IO.File]::WriteAllText(
            $temporary,
            ($Value | ConvertTo-Json -Depth 40),
            [Text.UTF8Encoding]::new($false)
        )
        [IO.File]::Move($temporary, $Path, -not $Immutable)
        Set-DatabaseInsightsPrivateAcl -Path $Path
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $stagingDirectory -PathType Container) {
            Remove-Item -LiteralPath $stagingDirectory -Force
        }
    }
}

function Invoke-DatabaseInsightsAwsJson {
    param([string[]]$Arguments)
    $operation = if ($Arguments.Count -ge 2) { "$($Arguments[0]) $($Arguments[1])" } else { "AWS request" }
    try { $awsPath = (Get-Command aws -CommandType Application -ErrorAction Stop).Source }
    catch { throw "The AWS CLI required for the Database Insights lease is unavailable." }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $awsPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @($Arguments) + @("--output", "json", "--no-cli-pager")) {
        [void]$startInfo.ArgumentList.Add([string]$argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "$operation could not start; provider output was discarded." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($script:DatabaseInsightsAwsProcessTimeoutMilliseconds)) {
            try { $process.Kill($true) } catch { }
            try { $process.WaitForExit(5000) | Out-Null } catch { }
            throw "$operation timed out; provider output was discarded."
        }
        $output = $stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "$operation failed; provider output was discarded." }
        try { return ($output | ConvertFrom-Json -Depth 60) }
        catch { throw "AWS returned malformed JSON for the Database Insights lease request." }
    }
    finally { $process.Dispose() }
}

function Test-DatabaseInsightsEmptyObject {
    param($Value)
    if ($null -eq $Value) { return $true }
    if ($Value -is [Collections.IDictionary]) { return $Value.Count -eq 0 }
    return @($Value.PSObject.Properties).Count -eq 0
}

function Get-DatabaseInsightsCallerAccount {
    $identity = Invoke-DatabaseInsightsAwsJson @("sts", "get-caller-identity")
    $account = [string](Get-DatabaseInsightsValue $identity "Account" "")
    if ($account -notmatch '^\d{12}$') { throw "AWS caller identity did not contain one account ID." }
    return $account
}

function Get-DatabaseInsightsPosture {
    param([string]$Region, [string]$DbInstanceIdentifier)
    $response = Invoke-DatabaseInsightsAwsJson @(
        "rds", "describe-db-instances", "--region", $Region,
        "--db-instance-identifier", $DbInstanceIdentifier
    )
    $instances = @(Get-DatabaseInsightsValue $response "DBInstances" @())
    if ($instances.Count -ne 1) { throw "The Database Insights lease must resolve exactly one RDS instance." }
    $instance = $instances[0]
    $parameterStatuses = @(
        @(Get-DatabaseInsightsValue $instance "DBParameterGroups" @()) |
            ForEach-Object { [string](Get-DatabaseInsightsValue $_ "ParameterApplyStatus" "") } |
            Sort-Object
    )
    $logExports = @(
        @(Get-DatabaseInsightsValue $instance "EnabledCloudwatchLogsExports" @()) |
            ForEach-Object { [string]$_ } |
            Sort-Object -Unique
    )
    return [ordered]@{
        dbInstanceIdentifier = [string](Get-DatabaseInsightsValue $instance "DBInstanceIdentifier" "")
        dbInstanceArn = [string](Get-DatabaseInsightsValue $instance "DBInstanceArn" "")
        databaseResourceId = [string](Get-DatabaseInsightsValue $instance "DbiResourceId" "")
        status = [string](Get-DatabaseInsightsValue $instance "DBInstanceStatus" "")
        instanceClass = [string](Get-DatabaseInsightsValue $instance "DBInstanceClass" "")
        engine = [string](Get-DatabaseInsightsValue $instance "Engine" "")
        engineVersion = [string](Get-DatabaseInsightsValue $instance "EngineVersion" "")
        databaseInsightsMode = [string](Get-DatabaseInsightsValue $instance "DatabaseInsightsMode" "")
        performanceInsightsEnabled = [bool](Get-DatabaseInsightsValue $instance "PerformanceInsightsEnabled" $false)
        performanceInsightsRetentionPeriod = [int](Get-DatabaseInsightsValue $instance "PerformanceInsightsRetentionPeriod" 0)
        performanceInsightsKmsKeyId = [string](Get-DatabaseInsightsValue $instance "PerformanceInsightsKMSKeyId" "")
        monitoringInterval = [int](Get-DatabaseInsightsValue $instance "MonitoringInterval" 0)
        monitoringRoleArn = [string](Get-DatabaseInsightsValue $instance "MonitoringRoleArn" "")
        enabledCloudwatchLogsExports = $logExports
        pendingModifiedValuesAbsent = Test-DatabaseInsightsEmptyObject (Get-DatabaseInsightsValue $instance "PendingModifiedValues")
        parameterApplyStatuses = $parameterStatuses
    }
}

function Get-DatabaseInsightsPreservedMonitoringPosture {
    param($Posture)
    return [ordered]@{
        performanceInsightsKmsKeyId = [string](Get-DatabaseInsightsValue $Posture "performanceInsightsKmsKeyId" "")
        monitoringInterval = [int](Get-DatabaseInsightsValue $Posture "monitoringInterval" -1)
        monitoringRoleArn = [string](Get-DatabaseInsightsValue $Posture "monitoringRoleArn" "")
        enabledCloudwatchLogsExports = @(
            @(Get-DatabaseInsightsValue $Posture "enabledCloudwatchLogsExports" @()) |
                ForEach-Object { [string]$_ } |
                Sort-Object -Unique
        )
    }
}

function Get-DatabaseInsightsPreservedMonitoringPostureSha256 {
    param($Posture)
    $preserved = Get-DatabaseInsightsPreservedMonitoringPosture $Posture
    return Get-DatabaseInsightsTextSha256 ($preserved | ConvertTo-Json -Depth 10 -Compress)
}

function Assert-DatabaseInsightsPreservedMonitoringPosture {
    param($Posture, $IdentityPosture)
    $observed = Get-DatabaseInsightsPreservedMonitoringPosture $Posture
    $expected = Get-DatabaseInsightsPreservedMonitoringPosture $IdentityPosture
    if ([string]::IsNullOrWhiteSpace([string]$expected.performanceInsightsKmsKeyId) -or
        [int]$expected.monitoringInterval -lt 0 -or [int]$expected.monitoringInterval -gt 60 -or
        ([int]$expected.monitoringInterval -gt 0 -and [string]::IsNullOrWhiteSpace([string]$expected.monitoringRoleArn)) -or
        @($expected.enabledCloudwatchLogsExports | Where-Object { [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
        throw "The captured RDS monitoring posture is incomplete."
    }
    if ((Get-DatabaseInsightsPreservedMonitoringPostureSha256 $observed) -cne
        (Get-DatabaseInsightsPreservedMonitoringPostureSha256 $expected)) {
        throw "RDS Performance Insights encryption, Enhanced Monitoring, or log-export posture changed during the lease."
    }
}

function Assert-DatabaseInsightsPosture {
    param(
        $Posture,
        [string]$ExpectedIdentifier,
        [string]$ExpectedClass,
        [string]$ExpectedMode,
        [int]$ExpectedRetention,
        $IdentityPosture = $null
    )
    if ([string]$Posture.dbInstanceIdentifier -cne $ExpectedIdentifier -or
        [string]$Posture.status -cne "available" -or
        [string]$Posture.instanceClass -cne $ExpectedClass -or
        [string]$Posture.engine -cne "postgres" -or
        [string]::IsNullOrWhiteSpace([string]$Posture.engineVersion) -or
        [string]::IsNullOrWhiteSpace([string]$Posture.dbInstanceArn) -or
        [string]::IsNullOrWhiteSpace([string]$Posture.databaseResourceId) -or
        [string]$Posture.databaseInsightsMode -cne $ExpectedMode -or
        $Posture.performanceInsightsEnabled -ne $true -or
        [int]$Posture.performanceInsightsRetentionPeriod -ne $ExpectedRetention -or
        $Posture.pendingModifiedValuesAbsent -ne $true -or
        @($Posture.parameterApplyStatuses).Count -lt 1 -or
        @($Posture.parameterApplyStatuses | Where-Object { $_ -cne "in-sync" }).Count -gt 0) {
        throw "RDS does not match the exact healthy Database Insights $ExpectedMode/$ExpectedRetention posture."
    }
    if ($null -eq $IdentityPosture) {
        [void](Assert-DatabaseInsightsPreservedMonitoringPosture $Posture $Posture)
    }
    if ($null -ne $IdentityPosture -and (
        [string]$Posture.dbInstanceArn -cne [string]$IdentityPosture.dbInstanceArn -or
        [string]$Posture.databaseResourceId -cne [string]$IdentityPosture.databaseResourceId -or
        [string]$Posture.engine -cne [string]$IdentityPosture.engine -or
        [string]$Posture.engineVersion -cne [string]$IdentityPosture.engineVersion -or
        [string]$Posture.instanceClass -cne [string]$IdentityPosture.instanceClass
    )) {
        throw "RDS identity changed during the Database Insights monitoring lease."
    }
    if ($null -ne $IdentityPosture) {
        [void](Assert-DatabaseInsightsPreservedMonitoringPosture $Posture $IdentityPosture)
    }
    return $Posture
}

function Assert-DatabaseInsightsLeaseIdentity {
    param($Posture, $IdentityPosture, [string]$ExpectedIdentifier, [string]$ExpectedClass)
    if ([string](Get-DatabaseInsightsValue $Posture "dbInstanceIdentifier" "") -cne $ExpectedIdentifier -or
        [string](Get-DatabaseInsightsValue $Posture "instanceClass" "") -cne $ExpectedClass -or
        [string](Get-DatabaseInsightsValue $Posture "engine" "") -cne "postgres" -or
        [string](Get-DatabaseInsightsValue $Posture "engineVersion" "") -cne [string]$IdentityPosture.engineVersion -or
        [string](Get-DatabaseInsightsValue $Posture "dbInstanceArn" "") -cne [string]$IdentityPosture.dbInstanceArn -or
        [string](Get-DatabaseInsightsValue $Posture "databaseResourceId" "") -cne [string]$IdentityPosture.databaseResourceId -or
        (Get-DatabaseInsightsValue $Posture "performanceInsightsEnabled" $false) -ne $true) {
        throw "The immutable RDS identity changed during the Database Insights monitoring lease."
    }
    [void](Assert-DatabaseInsightsPreservedMonitoringPosture $Posture $IdentityPosture)
    return $Posture
}

function Set-DatabaseInsightsPosture {
    param(
        [string]$Region,
        [string]$DbInstanceIdentifier,
        [ValidateSet("standard", "advanced")]
        [string]$DatabaseInsightsMode,
        [int]$RetentionDays
    )
    [void](Invoke-DatabaseInsightsAwsJson @(
        "rds", "modify-db-instance", "--region", $Region,
        "--db-instance-identifier", $DbInstanceIdentifier,
        "--database-insights-mode", $DatabaseInsightsMode,
        "--enable-performance-insights",
        "--performance-insights-retention-period", ([string]$RetentionDays),
        "--apply-immediately"
    ))
}

function Wait-DatabaseInsightsPosture {
    param(
        [string]$Region,
        [string]$DbInstanceIdentifier,
        [string]$ExpectedClass,
        [string]$ExpectedMode,
        [int]$ExpectedRetention,
        $IdentityPosture,
        [int]$PollSeconds,
        [int]$TimeoutSeconds
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastFailure = "RDS monitoring posture has not converged."
    do {
        try {
            $posture = Get-DatabaseInsightsPosture -Region $Region -DbInstanceIdentifier $DbInstanceIdentifier
            return Assert-DatabaseInsightsPosture $posture $DbInstanceIdentifier $ExpectedClass $ExpectedMode $ExpectedRetention $IdentityPosture
        }
        catch { $lastFailure = $_.Exception.Message }
        if ([DateTimeOffset]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds $PollSeconds
    } while ($true)
    throw "Timed out waiting for Database Insights posture: $lastFailure"
}

function Get-DatabaseInsightsDurableRestoreGuardBinding {
    param(
        $InitialPosture,
        [string]$AccountId,
        [string]$Region,
        [string]$DbInstanceIdentifier,
        [string]$LeaseId,
        [DateTimeOffset]$ExpiresAtUtc,
        [string]$AutomationDocumentContentSha256 = ""
    )
    $databaseNameMatch = [Text.RegularExpressions.Regex]::Match(
        $DbInstanceIdentifier, '^(?<prefix>[a-z][a-z0-9-]{0,54})-db$'
    )
    if ($AccountId -notmatch '^\d{12}$' -or $Region -notmatch '^[a-z]{2}(?:-[a-z]+)+-\d$' -or
        -not $databaseNameMatch.Success -or $LeaseId -notmatch '^[0-9a-f]{32}$') {
        throw "The durable Database Insights restore guard has an invalid account, region, database, or lease identity."
    }
    $namePrefix = [string]$databaseNameMatch.Groups["prefix"].Value
    $expectedDbArn = "arn:aws:rds:$Region`:$AccountId`:db:$DbInstanceIdentifier"
    if ([string](Get-DatabaseInsightsValue $InitialPosture "dbInstanceArn" "") -cne $expectedDbArn) {
        throw "The durable Database Insights restore guard database ARN does not match the exact lease identity."
    }
    $expiration = $ExpiresAtUtc.ToUniversalTime()
    if ($expiration.Millisecond -ne 0) {
        throw "The durable Database Insights restore guard expiration must have whole-second precision."
    }
    $scheduleGroupName = "$namePrefix-db-insights-leases"
    $roleArn = "arn:aws:iam::$AccountId`:role/$namePrefix-db-insights-restore"
    $automationDocumentName = "$namePrefix-db-insights-restore-v1"
    $automationDocumentVersion = $script:DatabaseInsightsDurableRestoreDocumentVersion
    $automationDefinitionArn = "arn:aws:ssm:$Region`:$AccountId`:automation-definition/$automationDocumentName`:$automationDocumentVersion"
    $automationRoleArn = "arn:aws:iam::$AccountId`:role/$namePrefix-db-insights-restore-automation"
    $automationFailureRuleArn = "arn:aws:events:$Region`:$AccountId`:rule/$namePrefix-db-insights-restore-failed"
    $dlqArn = "arn:aws:sqs:$Region`:$AccountId`:$namePrefix-db-insights-restore-dlq"
    $databaseIdentitySha256 = Get-DatabaseInsightsTextSha256 "$AccountId|$Region|$DbInstanceIdentifier"
    $scheduleName = "db-insights-restore-$($databaseIdentitySha256.Substring(0, 24))"
    $scheduleArn = "arn:aws:scheduler:$Region`:$AccountId`:schedule/$scheduleGroupName/$scheduleName"
    $scheduleExpression = "rate($($script:DatabaseInsightsDurableRestoreCadenceMinutes) minutes)"
    $scheduleStartAtUtc = $expiration.ToString("o")
    $leaseIdSha256 = Get-DatabaseInsightsTextSha256 $LeaseId
    if ([string]::IsNullOrWhiteSpace($AutomationDocumentContentSha256)) {
        $documentResponse = Invoke-DatabaseInsightsAwsJson @(
            "ssm", "get-document", "--region", $Region, "--name", $automationDocumentName,
            "--document-version", $automationDocumentVersion, "--document-format", "JSON"
        )
        $automationDocumentContent = [string](Get-DatabaseInsightsValue $documentResponse "Content" "")
        try { [void]($automationDocumentContent | ConvertFrom-Json -Depth 60) }
        catch { throw "The durable Database Insights restoration Automation document content is malformed." }
        if ([string](Get-DatabaseInsightsValue $documentResponse "Name" "") -cne $automationDocumentName -or
            [string](Get-DatabaseInsightsValue $documentResponse "DocumentVersion" "") -cne $automationDocumentVersion -or
            [string](Get-DatabaseInsightsValue $documentResponse "DocumentType" "") -cne "Automation" -or
            [string](Get-DatabaseInsightsValue $documentResponse "DocumentFormat" "") -cne "JSON" -or
            [string](Get-DatabaseInsightsValue $documentResponse "Status" "") -cne "Active") {
            throw "The durable Database Insights restoration Automation document identity is missing or drifted."
        }
        $AutomationDocumentContentSha256 = Get-DatabaseInsightsTextSha256 $automationDocumentContent
    }
    else {
        $AutomationDocumentContentSha256 = Assert-DatabaseInsightsSha256 `
            $AutomationDocumentContentSha256 `
            "The durable Database Insights restoration Automation document content hash"
    }
    $expectedLogExportsJson = @(
        @(Get-DatabaseInsightsValue $InitialPosture "enabledCloudwatchLogsExports" @()) |
            ForEach-Object { [string]$_ } | Sort-Object -Unique
    ) | ConvertTo-Json -Compress -AsArray
    $targetInput = [ordered]@{
        DocumentName = $automationDocumentName
        DocumentVersion = $automationDocumentVersion
        Parameters = [ordered]@{
            AutomationAssumeRole = @($automationRoleArn)
            DBInstanceIdentifier = @($DbInstanceIdentifier)
            ExpectedDBInstanceArn = @($expectedDbArn)
            ExpectedDatabaseResourceId = @([string](Get-DatabaseInsightsValue $InitialPosture "databaseResourceId" ""))
            ExpectedDBInstanceClass = @([string](Get-DatabaseInsightsValue $InitialPosture "instanceClass" ""))
            ExpectedEngineVersion = @([string](Get-DatabaseInsightsValue $InitialPosture "engineVersion" ""))
            ExpectedPerformanceInsightsKmsKeyId = @([string](Get-DatabaseInsightsValue $InitialPosture "performanceInsightsKmsKeyId" ""))
            ExpectedMonitoringInterval = @([string](Get-DatabaseInsightsValue $InitialPosture "monitoringInterval" ""))
            ExpectedMonitoringRoleArn = @([string](Get-DatabaseInsightsValue $InitialPosture "monitoringRoleArn" ""))
            ExpectedLogExportsJson = @($expectedLogExportsJson)
            FailureQueueUrl = @("https://sqs.$Region.amazonaws.com/$AccountId/$namePrefix-db-insights-restore-dlq")
            RestoreScheduleName = @($scheduleName)
            RestoreScheduleGroupName = @($scheduleGroupName)
            AutomationDocumentContentSha256 = @($AutomationDocumentContentSha256)
            LeaseIdSha256 = @($leaseIdSha256)
            ExpiresAtUtc = @($expiration.ToString("o"))
            RestoreMode = @("scheduled")
        }
    } | ConvertTo-Json -Depth 20 -Compress
    $descriptionBindingSha256 = Get-DatabaseInsightsTextSha256 `
        "$AccountId|$Region|$DbInstanceIdentifier|$($expiration.ToString('o'))|$leaseIdSha256"
    $description = "SchoolPilot db-insights restore v2 lease=$leaseIdSha256 binding=$descriptionBindingSha256"
    $binding = [ordered]@{
        version = $script:DatabaseInsightsDurableRestoreGuardVersion
        accountId = $AccountId
        region = $Region
        dbInstanceIdentifier = $DbInstanceIdentifier
        dbInstanceArn = $expectedDbArn
        expiresAtUtc = $expiration.ToString("o")
        scheduleName = $scheduleName
        scheduleGroupName = $scheduleGroupName
        scheduleArn = $scheduleArn
        scheduleExpression = $scheduleExpression
        scheduleStartAtUtc = $scheduleStartAtUtc
        scheduleExpressionTimezone = "UTC"
        actionAfterCompletion = "NONE"
        state = "ENABLED"
        description = $description
        targetArn = $script:DatabaseInsightsDurableRestoreTargetArn
        automationVersion = $script:DatabaseInsightsDurableRestoreAutomationVersion
        automationDocumentName = $automationDocumentName
        automationDocumentVersion = $automationDocumentVersion
        automationDocumentContentSha256 = $AutomationDocumentContentSha256
        automationDefinitionArn = $automationDefinitionArn
        automationRoleArn = $automationRoleArn
        automationFailureRuleArn = $automationFailureRuleArn
        targetRoleArn = $roleArn
        deadLetterQueueArn = $dlqArn
        targetInput = $targetInput
        maximumEventAgeInSeconds = $script:DatabaseInsightsDurableRestoreMaximumEventAgeSeconds
        maximumRetryAttempts = $script:DatabaseInsightsDurableRestoreMaximumRetryAttempts
    }
    $binding["bindingSha256"] = Get-DatabaseInsightsDurableRestoreGuardBindingSha256 $binding
    return $binding
}

function Get-DatabaseInsightsDurableRestoreGuardBindingSha256 {
    param($Binding)
    $expiresAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string](Get-DatabaseInsightsValue $Binding "expiresAtUtc" ""), [ref]$expiresAt)) {
        throw "The durable Database Insights restore guard has an invalid expiration."
    }
    $canonical = [ordered]@{
        version = [string](Get-DatabaseInsightsValue $Binding "version" "")
        accountId = [string](Get-DatabaseInsightsValue $Binding "accountId" "")
        region = [string](Get-DatabaseInsightsValue $Binding "region" "")
        dbInstanceIdentifier = [string](Get-DatabaseInsightsValue $Binding "dbInstanceIdentifier" "")
        dbInstanceArn = [string](Get-DatabaseInsightsValue $Binding "dbInstanceArn" "")
        expiresAtUtc = $expiresAt.ToUniversalTime().ToString("o")
        scheduleName = [string](Get-DatabaseInsightsValue $Binding "scheduleName" "")
        scheduleGroupName = [string](Get-DatabaseInsightsValue $Binding "scheduleGroupName" "")
        scheduleArn = [string](Get-DatabaseInsightsValue $Binding "scheduleArn" "")
        scheduleExpression = [string](Get-DatabaseInsightsValue $Binding "scheduleExpression" "")
        scheduleStartAtUtc = Get-DatabaseInsightsTimestampText `
            (Get-DatabaseInsightsValue $Binding "scheduleStartAtUtc" "") `
            "The durable Database Insights restore guard start time"
        scheduleExpressionTimezone = [string](Get-DatabaseInsightsValue $Binding "scheduleExpressionTimezone" "")
        actionAfterCompletion = [string](Get-DatabaseInsightsValue $Binding "actionAfterCompletion" "")
        state = [string](Get-DatabaseInsightsValue $Binding "state" "")
        description = [string](Get-DatabaseInsightsValue $Binding "description" "")
        targetArn = [string](Get-DatabaseInsightsValue $Binding "targetArn" "")
        automationVersion = [string](Get-DatabaseInsightsValue $Binding "automationVersion" "")
        automationDocumentName = [string](Get-DatabaseInsightsValue $Binding "automationDocumentName" "")
        automationDocumentVersion = [string](Get-DatabaseInsightsValue $Binding "automationDocumentVersion" "")
        automationDocumentContentSha256 = [string](Get-DatabaseInsightsValue $Binding "automationDocumentContentSha256" "")
        automationDefinitionArn = [string](Get-DatabaseInsightsValue $Binding "automationDefinitionArn" "")
        automationRoleArn = [string](Get-DatabaseInsightsValue $Binding "automationRoleArn" "")
        automationFailureRuleArn = [string](Get-DatabaseInsightsValue $Binding "automationFailureRuleArn" "")
        targetRoleArn = [string](Get-DatabaseInsightsValue $Binding "targetRoleArn" "")
        deadLetterQueueArn = [string](Get-DatabaseInsightsValue $Binding "deadLetterQueueArn" "")
        targetInput = [string](Get-DatabaseInsightsValue $Binding "targetInput" "")
        maximumEventAgeInSeconds = [int](Get-DatabaseInsightsValue $Binding "maximumEventAgeInSeconds" 0)
        maximumRetryAttempts = [int](Get-DatabaseInsightsValue $Binding "maximumRetryAttempts" -1)
    }
    return Get-DatabaseInsightsTextSha256 ($canonical | ConvertTo-Json -Depth 20 -Compress)
}

function Get-DatabaseInsightsObjectPropertyNames {
    param($Object)
    if ($null -eq $Object) { return @() }
    if ($Object -is [Collections.IDictionary]) {
        return @($Object.Keys | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    }
    return @($Object.PSObject.Properties.Name | ForEach-Object { [string]$_ } | Sort-Object -Unique)
}

function Test-DatabaseInsightsExactStrings {
    param($Observed, [string[]]$Expected)
    $observedValues = @(@($Observed) | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $expectedValues = @(@($Expected) | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    if ($observedValues.Count -ne $expectedValues.Count) { return $false }
    for ($index = 0; $index -lt $expectedValues.Count; $index++) {
        if ($observedValues[$index] -cne $expectedValues[$index]) { return $false }
    }
    return $true
}

function Get-DatabaseInsightsNormalizedScriptSha256 {
    param([string]$Text)
    $normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
    return Get-DatabaseInsightsTextSha256 $normalized
}

function Assert-DatabaseInsightsDurableRestoreInfrastructure {
    param($Binding)
    $accountId = [string]$Binding.accountId
    $region = [string]$Binding.region
    $groupName = [string]$Binding.scheduleGroupName
    $roleArn = [string]$Binding.targetRoleArn
    $automationRoleArn = [string]$Binding.automationRoleArn
    $automationDefinitionArn = [string]$Binding.automationDefinitionArn
    $automationDocumentName = [string]$Binding.automationDocumentName
    $automationFailureRuleArn = [string]$Binding.automationFailureRuleArn
    $queueArn = [string]$Binding.deadLetterQueueArn
    $roleName = ($roleArn -split ':role/', 2)[-1]
    $automationRoleName = ($automationRoleArn -split ':role/', 2)[-1]
    $queueName = ($queueArn -split ':', 6)[-1]
    $namePrefix = $groupName -replace '-db-insights-leases$', ''
    $expectedGroupArn = "arn:aws:scheduler:$region`:$accountId`:schedule-group/$groupName"
    $expectedSourceArn = $expectedGroupArn
    $expectedAlertTopicArn = "arn:aws:sns:$region`:$accountId`:$namePrefix-alerts"
    $expectedAlarmName = "$namePrefix-scale-db-insights-restore-dlq"
    $expectedAutomationExecutionSourceArn = "arn:aws:ssm:$region`:$accountId`:automation-execution/*"
    $expectedAutomationFailureRuleName = "$namePrefix-db-insights-restore-failed"

    if ($roleName -notmatch '^[A-Za-z0-9+=,.@_-]{1,64}$' -or
        $automationRoleName -notmatch '^[A-Za-z0-9+=,.@_-]{1,64}$' -or
        $queueName -notmatch '^[A-Za-z0-9_-]{1,80}$' -or
        $namePrefix -notmatch '^[a-z][a-z0-9-]{0,54}$' -or
        [string]$Binding.automationVersion -cne $script:DatabaseInsightsDurableRestoreAutomationVersion -or
        $automationDocumentName -cne "$namePrefix-db-insights-restore-v1" -or
        [string]$Binding.automationDocumentVersion -cne $script:DatabaseInsightsDurableRestoreDocumentVersion -or
        [string]$Binding.automationDocumentContentSha256 -notmatch '^[0-9a-f]{64}$' -or
        $automationDefinitionArn -cne "arn:aws:ssm:$region`:$accountId`:automation-definition/$automationDocumentName`:$($script:DatabaseInsightsDurableRestoreDocumentVersion)" -or
        $automationFailureRuleArn -cne "arn:aws:events:$region`:$accountId`:rule/$expectedAutomationFailureRuleName") {
        throw "The durable Database Insights restore infrastructure identity is malformed."
    }

    $group = Invoke-DatabaseInsightsAwsJson @(
        "scheduler", "get-schedule-group", "--region", $region, "--name", $groupName
    )
    if ([string](Get-DatabaseInsightsValue $group "Arn" "") -cne $expectedGroupArn -or
        [string](Get-DatabaseInsightsValue $group "Name" "") -cne $groupName -or
        [string](Get-DatabaseInsightsValue $group "State" "") -cne "ACTIVE") {
        throw "The durable Database Insights restore Scheduler group is missing or drifted."
    }

    $roleResponse = Invoke-DatabaseInsightsAwsJson @("iam", "get-role", "--role-name", $roleName)
    $role = Get-DatabaseInsightsValue $roleResponse "Role"
    $trust = Get-DatabaseInsightsValue $role "AssumeRolePolicyDocument"
    $trustStatements = @(Get-DatabaseInsightsValue $trust "Statement" @())
    $trustStatement = if ($trustStatements.Count -eq 1) { $trustStatements[0] } else { $null }
    $trustPrincipal = Get-DatabaseInsightsValue $trustStatement "Principal"
    $trustCondition = Get-DatabaseInsightsValue $trustStatement "Condition"
    $sourceAccountCondition = Get-DatabaseInsightsValue $trustCondition "StringEquals"
    $sourceArnCondition = Get-DatabaseInsightsValue $trustCondition "ArnLike"
    if ([string](Get-DatabaseInsightsValue $role "Arn" "") -cne $roleArn -or
        $null -ne (Get-DatabaseInsightsValue $role "PermissionsBoundary" $null) -or
        [string](Get-DatabaseInsightsValue $trust "Version" "") -cne "2012-10-17" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $trust) `
            @("Statement", "Version")) -or
        $null -eq $trustStatement -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $trustStatement) `
            @("Action", "Condition", "Effect", "Principal", "Sid")) -or
        [string](Get-DatabaseInsightsValue $trustStatement "Sid" "") -cne "SchedulerOnly" -or
        [string](Get-DatabaseInsightsValue $trustStatement "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $trustStatement "Action" @()) @("sts:AssumeRole")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $trustPrincipal) @("Service")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $trustPrincipal "Service" @()) @("scheduler.amazonaws.com")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $trustCondition) @("ArnLike", "StringEquals")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $sourceAccountCondition) @("aws:SourceAccount")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $sourceAccountCondition "aws:SourceAccount" @()) @($accountId)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $sourceArnCondition) @("aws:SourceArn")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $sourceArnCondition "aws:SourceArn" @()) @($expectedSourceArn))) {
        throw "The durable Database Insights restore execution-role trust is missing or drifted."
    }

    $attached = Invoke-DatabaseInsightsAwsJson @(
        "iam", "list-attached-role-policies", "--role-name", $roleName, "--max-items", "100", "--no-paginate"
    )
    $inline = Invoke-DatabaseInsightsAwsJson @(
        "iam", "list-role-policies", "--role-name", $roleName, "--max-items", "100", "--no-paginate"
    )
    if ((Get-DatabaseInsightsValue $attached "IsTruncated" $false) -eq $true -or
        -not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $attached "Marker" "")) -or
        -not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $attached "NextToken" "")) -or
        @(Get-DatabaseInsightsValue $attached "AttachedPolicies" @()).Count -ne 0 -or
        (Get-DatabaseInsightsValue $inline "IsTruncated" $false) -eq $true -or
        -not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $inline "Marker" "")) -or
        -not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $inline "NextToken" "")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $inline "PolicyNames" @()) @("database-insights-restore"))) {
        throw "The durable Database Insights restore role has unexpected permissions."
    }
    $policyResponse = Invoke-DatabaseInsightsAwsJson @(
        "iam", "get-role-policy", "--role-name", $roleName, "--policy-name", "database-insights-restore"
    )
    $policy = Get-DatabaseInsightsValue $policyResponse "PolicyDocument"
    $statements = @(Get-DatabaseInsightsValue $policy "Statement" @())
    $startStatements = @($statements | Where-Object { [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "StartExactRestoreAutomation" })
    $passRoleStatements = @($statements | Where-Object { [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "PassExactRestoreAutomationRole" })
    $dlqStatements = @($statements | Where-Object { [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "PublishFailedInvocationToEncryptedDlq" })
    $passRoleCondition = if ($passRoleStatements.Count -eq 1) {
        Get-DatabaseInsightsValue $passRoleStatements[0] "Condition"
    } else { $null }
    $passedToService = Get-DatabaseInsightsValue $passRoleCondition "StringEquals"
    if ([string](Get-DatabaseInsightsValue $policy "Version" "") -cne "2012-10-17" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $policy) `
            @("Statement", "Version")) -or
        $statements.Count -ne 3 -or $startStatements.Count -ne 1 -or $passRoleStatements.Count -ne 1 -or $dlqStatements.Count -ne 1 -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $startStatements[0]) `
            @("Action", "Effect", "Resource", "Sid")) -or
        [string](Get-DatabaseInsightsValue $startStatements[0] "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $startStatements[0] "Action" @()) @("ssm:StartAutomationExecution")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $startStatements[0] "Resource" @()) @($automationDefinitionArn)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $passRoleStatements[0]) `
            @("Action", "Condition", "Effect", "Resource", "Sid")) -or
        [string](Get-DatabaseInsightsValue $passRoleStatements[0] "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $passRoleStatements[0] "Action" @()) @("iam:PassRole")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $passRoleStatements[0] "Resource" @()) @($automationRoleArn)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $passRoleCondition) @("StringEquals")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $passedToService) @("iam:PassedToService")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $passedToService "iam:PassedToService" @()) @("ssm.amazonaws.com")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $dlqStatements[0]) `
            @("Action", "Effect", "Resource", "Sid")) -or
        [string](Get-DatabaseInsightsValue $dlqStatements[0] "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $dlqStatements[0] "Action" @()) @("sqs:SendMessage")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $dlqStatements[0] "Resource" @()) @($queueArn))) {
        throw "The durable Database Insights restore launcher role is not least-privilege for the exact Automation, verifier role, and DLQ."
    }

    $automationRoleResponse = Invoke-DatabaseInsightsAwsJson @("iam", "get-role", "--role-name", $automationRoleName)
    $automationRole = Get-DatabaseInsightsValue $automationRoleResponse "Role"
    $automationTrust = Get-DatabaseInsightsValue $automationRole "AssumeRolePolicyDocument"
    $automationTrustStatements = @(Get-DatabaseInsightsValue $automationTrust "Statement" @())
    $automationTrustStatement = if ($automationTrustStatements.Count -eq 1) { $automationTrustStatements[0] } else { $null }
    $automationPrincipal = Get-DatabaseInsightsValue $automationTrustStatement "Principal"
    $automationCondition = Get-DatabaseInsightsValue $automationTrustStatement "Condition"
    $automationSourceAccount = Get-DatabaseInsightsValue $automationCondition "StringEquals"
    $automationSourceArn = Get-DatabaseInsightsValue $automationCondition "ArnLike"
    if ([string](Get-DatabaseInsightsValue $automationRole "Arn" "") -cne $automationRoleArn -or
        $null -ne (Get-DatabaseInsightsValue $automationRole "PermissionsBoundary" $null) -or
        [string](Get-DatabaseInsightsValue $automationTrust "Version" "") -cne "2012-10-17" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $automationTrust) `
            @("Statement", "Version")) -or
        $null -eq $automationTrustStatement -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $automationTrustStatement) `
            @("Action", "Condition", "Effect", "Principal", "Sid")) -or
        [string](Get-DatabaseInsightsValue $automationTrustStatement "Sid" "") -cne "SsmAutomationOnly" -or
        [string](Get-DatabaseInsightsValue $automationTrustStatement "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $automationTrustStatement "Action" @()) @("sts:AssumeRole")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $automationPrincipal) @("Service")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $automationPrincipal "Service" @()) @("ssm.amazonaws.com")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $automationCondition) @("ArnLike", "StringEquals")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $automationSourceAccount) @("aws:SourceAccount")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $automationSourceAccount "aws:SourceAccount" @()) @($accountId)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $automationSourceArn) @("aws:SourceArn")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $automationSourceArn "aws:SourceArn" @()) @($expectedAutomationExecutionSourceArn))) {
        throw "The durable Database Insights restoration Automation-role trust is missing or drifted."
    }
    $automationAttached = Invoke-DatabaseInsightsAwsJson @(
        "iam", "list-attached-role-policies", "--role-name", $automationRoleName, "--max-items", "100", "--no-paginate"
    )
    $automationInline = Invoke-DatabaseInsightsAwsJson @(
        "iam", "list-role-policies", "--role-name", $automationRoleName, "--max-items", "100", "--no-paginate"
    )
    if ((Get-DatabaseInsightsValue $automationAttached "IsTruncated" $false) -eq $true -or
        -not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $automationAttached "Marker" "")) -or
        -not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $automationAttached "NextToken" "")) -or
        @(Get-DatabaseInsightsValue $automationAttached "AttachedPolicies" @()).Count -ne 0 -or
        (Get-DatabaseInsightsValue $automationInline "IsTruncated" $false) -eq $true -or
        -not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $automationInline "Marker" "")) -or
        -not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $automationInline "NextToken" "")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $automationInline "PolicyNames" @()) @("database-insights-restore-automation"))) {
        throw "The durable Database Insights restoration Automation role has unexpected permissions."
    }
    $automationPolicyResponse = Invoke-DatabaseInsightsAwsJson @(
        "iam", "get-role-policy", "--role-name", $automationRoleName,
        "--policy-name", "database-insights-restore-automation"
    )
    $automationPolicy = Get-DatabaseInsightsValue $automationPolicyResponse "PolicyDocument"
    $automationStatements = @(Get-DatabaseInsightsValue $automationPolicy "Statement" @())
    $modifyStatements = @($automationStatements | Where-Object {
        [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "ModifyExactDatabaseInsightsPosture"
    })
    $describeStatements = @($automationStatements | Where-Object {
        [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "DescribeDatabaseForExactVerification"
    })
    $manageScheduleStatements = @($automationStatements | Where-Object {
        [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "ManageExactRestoreSchedule"
    })
    $passSchedulerRoleStatements = @($automationStatements | Where-Object {
        [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "PassExactSchedulerRoleForDisarm"
    })
    $publishFailureStatements = @($automationStatements | Where-Object {
        [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "PublishRestoreFailureDirectly"
    })
    $describeCondition = if ($describeStatements.Count -eq 1) {
        Get-DatabaseInsightsValue $describeStatements[0] "Condition"
    } else { $null }
    $requestedRegion = Get-DatabaseInsightsValue $describeCondition "StringEquals"
    $passSchedulerCondition = if ($passSchedulerRoleStatements.Count -eq 1) {
        Get-DatabaseInsightsValue $passSchedulerRoleStatements[0] "Condition"
    } else { $null }
    $passedToScheduler = Get-DatabaseInsightsValue $passSchedulerCondition "StringEquals"
    if ([string](Get-DatabaseInsightsValue $automationPolicy "Version" "") -cne "2012-10-17" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $automationPolicy) `
            @("Statement", "Version")) -or
        $automationStatements.Count -ne 5 -or $modifyStatements.Count -ne 1 -or $describeStatements.Count -ne 1 -or
        $manageScheduleStatements.Count -ne 1 -or $passSchedulerRoleStatements.Count -ne 1 -or
        $publishFailureStatements.Count -ne 1 -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $modifyStatements[0]) `
            @("Action", "Effect", "Resource", "Sid")) -or
        [string](Get-DatabaseInsightsValue $modifyStatements[0] "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $modifyStatements[0] "Action" @()) @("rds:ModifyDBInstance")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $modifyStatements[0] "Resource" @()) @([string]$Binding.dbInstanceArn)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $describeStatements[0]) `
            @("Action", "Condition", "Effect", "Resource", "Sid")) -or
        [string](Get-DatabaseInsightsValue $describeStatements[0] "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $describeStatements[0] "Action" @()) @("rds:DescribeDBInstances")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $describeStatements[0] "Resource" @()) @("*")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $describeCondition) @("StringEquals")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $requestedRegion) @("aws:RequestedRegion")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $requestedRegion "aws:RequestedRegion" @()) @($region)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $manageScheduleStatements[0]) `
            @("Action", "Effect", "Resource", "Sid")) -or
        [string](Get-DatabaseInsightsValue $manageScheduleStatements[0] "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $manageScheduleStatements[0] "Action" @()) `
            @("scheduler:DeleteSchedule", "scheduler:GetSchedule", "scheduler:UpdateSchedule")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $manageScheduleStatements[0] "Resource" @()) @([string]$Binding.scheduleArn)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $passSchedulerRoleStatements[0]) `
            @("Action", "Condition", "Effect", "Resource", "Sid")) -or
        [string](Get-DatabaseInsightsValue $passSchedulerRoleStatements[0] "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $passSchedulerRoleStatements[0] "Action" @()) @("iam:PassRole")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $passSchedulerRoleStatements[0] "Resource" @()) @($roleArn)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $passSchedulerCondition) @("StringEquals")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $passedToScheduler) @("iam:PassedToService")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $passedToScheduler "iam:PassedToService" @()) @("scheduler.amazonaws.com")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $publishFailureStatements[0]) `
            @("Action", "Effect", "Resource", "Sid")) -or
        [string](Get-DatabaseInsightsValue $publishFailureStatements[0] "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $publishFailureStatements[0] "Action" @()) @("sqs:SendMessage")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $publishFailureStatements[0] "Resource" @()) @($queueArn))) {
        throw "The durable Database Insights restoration Automation role is not least-privilege for exact modify, generation verification, and failure publication."
    }

    $documentResponse = Invoke-DatabaseInsightsAwsJson @(
        "ssm", "get-document", "--region", $region, "--name", $automationDocumentName,
        "--document-version", [string]$Binding.automationDocumentVersion, "--document-format", "JSON"
    )
    try { $document = [string](Get-DatabaseInsightsValue $documentResponse "Content" "") | ConvertFrom-Json -Depth 60 }
    catch { throw "The durable Database Insights restoration Automation document content is malformed." }
    $expectedRestoreScriptPath = Join-Path $script:DatabaseInsightsRepositoryRoot `
        "infra/modules/database-insights-lease-watchdog/restore_exact_monitoring_posture.py"
    if (-not (Test-Path -LiteralPath $expectedRestoreScriptPath -PathType Leaf)) {
        throw "The reviewed durable Database Insights restoration script is missing."
    }
    $expectedRestoreScriptSha256 = Get-DatabaseInsightsNormalizedScriptSha256 `
        ([IO.File]::ReadAllText($expectedRestoreScriptPath))
    $parameters = Get-DatabaseInsightsValue $document "parameters"
    $steps = @(Get-DatabaseInsightsValue $document "mainSteps" @())
    $restoreStep = if ($steps.Count -eq 4) { $steps[0] } else { $null }
    $finishSuccessStep = if ($steps.Count -eq 4) { $steps[1] } else { $null }
    $publishFailureStep = if ($steps.Count -eq 4) { $steps[2] } else { $null }
    $failAutomationStep = if ($steps.Count -eq 4) { $steps[3] } else { $null }
    $restoreInputs = Get-DatabaseInsightsValue $restoreStep "inputs"
    $restorePayload = Get-DatabaseInsightsValue $restoreInputs "InputPayload"
    $finishSuccessInputs = Get-DatabaseInsightsValue $finishSuccessStep "inputs"
    $publishFailureInputs = Get-DatabaseInsightsValue $publishFailureStep "inputs"
    $failAutomationInputs = Get-DatabaseInsightsValue $failAutomationStep "inputs"
    $parameterSchemaIsExact = Test-DatabaseInsightsExactStrings `
        (Get-DatabaseInsightsObjectPropertyNames $parameters) @(
            "AutomationAssumeRole", "DBInstanceIdentifier", "ExpectedDBInstanceArn",
            "ExpectedDatabaseResourceId", "ExpectedDBInstanceClass", "ExpectedEngineVersion",
            "ExpectedPerformanceInsightsKmsKeyId", "ExpectedMonitoringInterval",
            "ExpectedMonitoringRoleArn", "ExpectedLogExportsJson", "RestoreScheduleName",
            "RestoreScheduleGroupName", "FailureQueueUrl", "AutomationDocumentContentSha256",
            "LeaseIdSha256", "ExpiresAtUtc", "RestoreMode"
        )
    foreach ($parameterName in @(
        "AutomationAssumeRole", "ExpectedDatabaseResourceId", "ExpectedEngineVersion",
        "ExpectedPerformanceInsightsKmsKeyId", "ExpectedMonitoringInterval",
        "ExpectedMonitoringRoleArn", "ExpectedLogExportsJson", "ExpiresAtUtc"
    )) {
        $parameter = Get-DatabaseInsightsValue $parameters $parameterName
        if (-not (Test-DatabaseInsightsExactStrings `
                (Get-DatabaseInsightsObjectPropertyNames $parameter) @("type")) -or
            [string](Get-DatabaseInsightsValue $parameter "type" "") -cne "String") {
            $parameterSchemaIsExact = $false
        }
    }
    foreach ($allowedParameter in @(
        [ordered]@{Name="DBInstanceIdentifier";Value=[string]$Binding.dbInstanceIdentifier},
        [ordered]@{Name="ExpectedDBInstanceArn";Value=[string]$Binding.dbInstanceArn},
        [ordered]@{Name="ExpectedDBInstanceClass";Value="db.t4g.medium"},
        [ordered]@{Name="RestoreScheduleName";Value=[string]$Binding.scheduleName},
        [ordered]@{Name="RestoreScheduleGroupName";Value=[string]$Binding.scheduleGroupName},
        [ordered]@{Name="FailureQueueUrl";Value="https://sqs.$region.amazonaws.com/$accountId/$queueName"}
    )) {
        $parameter = Get-DatabaseInsightsValue $parameters $allowedParameter.Name
        if (-not (Test-DatabaseInsightsExactStrings `
                (Get-DatabaseInsightsObjectPropertyNames $parameter) @("allowedValues", "type")) -or
            [string](Get-DatabaseInsightsValue $parameter "type" "") -cne "String" -or
            -not (Test-DatabaseInsightsExactStrings `
                (Get-DatabaseInsightsValue $parameter "allowedValues" @()) @([string]$allowedParameter.Value))) {
            $parameterSchemaIsExact = $false
        }
    }
    foreach ($hashParameterName in @("AutomationDocumentContentSha256", "LeaseIdSha256")) {
        $parameter = Get-DatabaseInsightsValue $parameters $hashParameterName
        if (-not (Test-DatabaseInsightsExactStrings `
                (Get-DatabaseInsightsObjectPropertyNames $parameter) @("allowedPattern", "type")) -or
            [string](Get-DatabaseInsightsValue $parameter "type" "") -cne "String" -or
            [string](Get-DatabaseInsightsValue $parameter "allowedPattern" "") -cne '^[0-9a-f]{64}$') {
            $parameterSchemaIsExact = $false
        }
    }
    $restoreModeParameter = Get-DatabaseInsightsValue $parameters "RestoreMode"
    if (-not (Test-DatabaseInsightsExactStrings `
            (Get-DatabaseInsightsObjectPropertyNames $restoreModeParameter) @("allowedValues", "type")) -or
        [string](Get-DatabaseInsightsValue $restoreModeParameter "type" "") -cne "String" -or
        -not (Test-DatabaseInsightsExactStrings `
            (Get-DatabaseInsightsValue $restoreModeParameter "allowedValues" @()) @("manual", "scheduled"))) {
        $parameterSchemaIsExact = $false
    }
    $expectedSuccessScript = "def handler(events, context):`n    return {'verified': True}`n"
    $expectedFailureScript = "def handler(events, context):`n    raise RuntimeError('database insights restoration failed')`n"
    if ([string](Get-DatabaseInsightsValue $documentResponse "Name" "") -cne $automationDocumentName -or
        [string](Get-DatabaseInsightsValue $documentResponse "DocumentVersion" "") -cne `
            [string]$Binding.automationDocumentVersion -or
        [string](Get-DatabaseInsightsValue $documentResponse "DocumentType" "") -cne "Automation" -or
        [string](Get-DatabaseInsightsValue $documentResponse "DocumentFormat" "") -cne "JSON" -or
        [string](Get-DatabaseInsightsValue $documentResponse "Status" "") -cne "Active" -or
        (Get-DatabaseInsightsTextSha256 ([string](Get-DatabaseInsightsValue $documentResponse "Content" ""))) -cne `
            [string]$Binding.automationDocumentContentSha256 -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $document) `
            @("assumeRole", "description", "mainSteps", "parameters", "schemaVersion")) -or
        [string](Get-DatabaseInsightsValue $document "schemaVersion" "") -cne "0.3" -or
        [string](Get-DatabaseInsightsValue $document "description" "") -cne `
            "Durably restore and verify the exact SchoolPilot production Database Insights Standard/7 posture." -or
        [string](Get-DatabaseInsightsValue $document "assumeRole" "") -cne "{{ AutomationAssumeRole }}" -or
        -not $parameterSchemaIsExact -or $steps.Count -ne 4 -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $restoreStep) `
            @("action", "inputs", "name", "nextStep", "onFailure", "timeoutSeconds")) -or
        [string](Get-DatabaseInsightsValue $restoreStep "name" "") -cne "RestoreExactPosture" -or
        [string](Get-DatabaseInsightsValue $restoreStep "action" "") -cne "aws:executeScript" -or
        [int](Get-DatabaseInsightsValue $restoreStep "timeoutSeconds" 0) -ne 600 -or
        [string](Get-DatabaseInsightsValue $restoreStep "onFailure" "") -cne "step:PublishRestoreFailure" -or
        [string](Get-DatabaseInsightsValue $restoreStep "nextStep" "") -cne "FinishRestoreSuccess" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $restoreInputs) `
            @("Handler", "InputPayload", "Runtime", "Script")) -or
        [string](Get-DatabaseInsightsValue $restoreInputs "Runtime" "") -cne "python3.11" -or
        [string](Get-DatabaseInsightsValue $restoreInputs "Handler" "") -cne "handler" -or
        (Get-DatabaseInsightsNormalizedScriptSha256 `
            ([string](Get-DatabaseInsightsValue $restoreInputs "Script" ""))) -cne $expectedRestoreScriptSha256 -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $restorePayload) @(
            "dbInstanceIdentifier", "expectedDbInstanceArn", "expectedDatabaseResourceId",
            "expectedDbInstanceClass", "expectedEngineVersion", "expectedPerformanceInsightsKmsKeyId",
            "expectedMonitoringInterval", "expectedMonitoringRoleArn", "expectedLogExportsJson",
            "restoreScheduleName", "restoreScheduleGroupName", "automationDocumentName",
            "automationDocumentVersion", "automationDocumentContentSha256", "leaseIdSha256", "expiresAtUtc",
            "restoreMode", "maximumEventAgeInSeconds")) -or
        [string](Get-DatabaseInsightsValue $restorePayload "dbInstanceIdentifier" "") -cne "{{ DBInstanceIdentifier }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "expectedDbInstanceArn" "") -cne "{{ ExpectedDBInstanceArn }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "expectedDatabaseResourceId" "") -cne "{{ ExpectedDatabaseResourceId }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "expectedDbInstanceClass" "") -cne "{{ ExpectedDBInstanceClass }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "expectedEngineVersion" "") -cne "{{ ExpectedEngineVersion }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "expectedPerformanceInsightsKmsKeyId" "") -cne "{{ ExpectedPerformanceInsightsKmsKeyId }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "expectedMonitoringInterval" "") -cne "{{ ExpectedMonitoringInterval }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "expectedMonitoringRoleArn" "") -cne "{{ ExpectedMonitoringRoleArn }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "expectedLogExportsJson" "") -cne "{{ ExpectedLogExportsJson }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "restoreScheduleName" "") -cne "{{ RestoreScheduleName }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "restoreScheduleGroupName" "") -cne "{{ RestoreScheduleGroupName }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "automationDocumentName" "") -cne $automationDocumentName -or
        [string](Get-DatabaseInsightsValue $restorePayload "automationDocumentVersion" "") -cne `
            [string]$Binding.automationDocumentVersion -or
        [string](Get-DatabaseInsightsValue $restorePayload "automationDocumentContentSha256" "") -cne `
            "{{ AutomationDocumentContentSha256 }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "leaseIdSha256" "") -cne "{{ LeaseIdSha256 }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "expiresAtUtc" "") -cne "{{ ExpiresAtUtc }}" -or
        [string](Get-DatabaseInsightsValue $restorePayload "restoreMode" "") -cne "{{ RestoreMode }}" -or
        [int](Get-DatabaseInsightsValue $restorePayload "maximumEventAgeInSeconds" 0) -ne 60 -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $finishSuccessStep) `
            @("action", "inputs", "isEnd", "name", "onFailure", "timeoutSeconds")) -or
        [string](Get-DatabaseInsightsValue $finishSuccessStep "name" "") -cne "FinishRestoreSuccess" -or
        [string](Get-DatabaseInsightsValue $finishSuccessStep "action" "") -cne "aws:executeScript" -or
        [int](Get-DatabaseInsightsValue $finishSuccessStep "timeoutSeconds" 0) -ne 30 -or
        [string](Get-DatabaseInsightsValue $finishSuccessStep "onFailure" "") -cne "Abort" -or
        (Get-DatabaseInsightsValue $finishSuccessStep "isEnd" $false) -ne $true -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $finishSuccessInputs) `
            @("Handler", "Runtime", "Script")) -or
        [string](Get-DatabaseInsightsValue $finishSuccessInputs "Runtime" "") -cne "python3.11" -or
        [string](Get-DatabaseInsightsValue $finishSuccessInputs "Handler" "") -cne "handler" -or
        (Get-DatabaseInsightsNormalizedScriptSha256 `
            ([string](Get-DatabaseInsightsValue $finishSuccessInputs "Script" ""))) -cne `
            (Get-DatabaseInsightsNormalizedScriptSha256 $expectedSuccessScript) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $publishFailureStep) `
            @("action", "inputs", "name", "nextStep", "onFailure", "timeoutSeconds")) -or
        [string](Get-DatabaseInsightsValue $publishFailureStep "name" "") -cne "PublishRestoreFailure" -or
        [string](Get-DatabaseInsightsValue $publishFailureStep "action" "") -cne "aws:executeAwsApi" -or
        [int](Get-DatabaseInsightsValue $publishFailureStep "timeoutSeconds" 0) -ne 60 -or
        [string](Get-DatabaseInsightsValue $publishFailureStep "onFailure" "") -cne "Abort" -or
        [string](Get-DatabaseInsightsValue $publishFailureStep "nextStep" "") -cne "FailRestoreAutomation" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $publishFailureInputs) `
            @("Api", "MessageBody", "QueueUrl", "Service")) -or
        [string](Get-DatabaseInsightsValue $publishFailureInputs "Service" "") -cne "sqs" -or
        [string](Get-DatabaseInsightsValue $publishFailureInputs "Api" "") -cne "SendMessage" -or
        [string](Get-DatabaseInsightsValue $publishFailureInputs "QueueUrl" "") -cne "{{ FailureQueueUrl }}" -or
        [string](Get-DatabaseInsightsValue $publishFailureInputs "MessageBody" "") -cne `
            "database_insights_restore_automation_failed" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $failAutomationStep) `
            @("action", "inputs", "isEnd", "name", "onFailure", "timeoutSeconds")) -or
        [string](Get-DatabaseInsightsValue $failAutomationStep "name" "") -cne "FailRestoreAutomation" -or
        [string](Get-DatabaseInsightsValue $failAutomationStep "action" "") -cne "aws:executeScript" -or
        [int](Get-DatabaseInsightsValue $failAutomationStep "timeoutSeconds" 0) -ne 30 -or
        [string](Get-DatabaseInsightsValue $failAutomationStep "onFailure" "") -cne "Abort" -or
        (Get-DatabaseInsightsValue $failAutomationStep "isEnd" $false) -ne $true -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $failAutomationInputs) `
            @("Handler", "Runtime", "Script")) -or
        [string](Get-DatabaseInsightsValue $failAutomationInputs "Runtime" "") -cne "python3.11" -or
        [string](Get-DatabaseInsightsValue $failAutomationInputs "Handler" "") -cne "handler" -or
        (Get-DatabaseInsightsNormalizedScriptSha256 `
            ([string](Get-DatabaseInsightsValue $failAutomationInputs "Script" ""))) -cne `
            (Get-DatabaseInsightsNormalizedScriptSha256 $expectedFailureScript)) {
        throw "The durable Database Insights restoration Automation document is not the exact reviewed parameter, step, or script contract."
    }

    $ruleResponse = Invoke-DatabaseInsightsAwsJson @(
        "events", "describe-rule", "--region", $region, "--name", $expectedAutomationFailureRuleName
    )
    try { $rulePattern = [string](Get-DatabaseInsightsValue $ruleResponse "EventPattern" "") | ConvertFrom-Json -Depth 20 }
    catch { throw "The durable Database Insights restoration failure rule pattern is malformed." }
    $ruleDetail = Get-DatabaseInsightsValue $rulePattern "detail"
    if ([string](Get-DatabaseInsightsValue $ruleResponse "Arn" "") -cne $automationFailureRuleArn -or
        [string](Get-DatabaseInsightsValue $ruleResponse "Name" "") -cne $expectedAutomationFailureRuleName -or
        [string](Get-DatabaseInsightsValue $ruleResponse "State" "") -cne "ENABLED" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $rulePattern) `
            @("detail", "detail-type", "source")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $ruleDetail) `
            @("Definition", "Status")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $rulePattern "source" @()) @("aws.ssm")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $rulePattern "detail-type" @()) @("EC2 Automation Execution Status-change Notification")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $ruleDetail "Definition" @()) @($automationDocumentName)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $ruleDetail "Status" @()) @("Canceled", "Failed", "TimedOut"))) {
        throw "The durable Database Insights restoration failure rule is missing or drifted."
    }
    $targetsResponse = Invoke-DatabaseInsightsAwsJson @(
        "events", "list-targets-by-rule", "--region", $region, "--rule", $expectedAutomationFailureRuleName,
        "--limit", "100", "--no-paginate"
    )
    if (-not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $targetsResponse "NextToken" ""))) {
        throw "The durable Database Insights restoration failure target lookup was unexpectedly paginated."
    }
    $targets = @(Get-DatabaseInsightsValue $targetsResponse "Targets" @())
    if ($targets.Count -ne 1 -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $targets[0]) `
            @("Arn", "Id")) -or
        [string](Get-DatabaseInsightsValue $targets[0] "Id" "") -cne "database-insights-automation-failure" -or
        [string](Get-DatabaseInsightsValue $targets[0] "Arn" "") -cne $queueArn) {
        throw "The durable Database Insights restoration failure rule is not bound to the exact alarmed DLQ."
    }

    $queueUrlResponse = Invoke-DatabaseInsightsAwsJson @(
        "sqs", "get-queue-url", "--region", $region, "--queue-name", $queueName,
        "--queue-owner-aws-account-id", $accountId
    )
    $queueUrl = [string](Get-DatabaseInsightsValue $queueUrlResponse "QueueUrl" "")
    if ([string]::IsNullOrWhiteSpace($queueUrl)) {
        throw "The durable Database Insights restore DLQ is missing."
    }
    $queueResponse = Invoke-DatabaseInsightsAwsJson @(
        "sqs", "get-queue-attributes", "--region", $region, "--queue-url", $queueUrl,
        "--attribute-names", "QueueArn", "SqsManagedSseEnabled", "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed",
        "MessageRetentionPeriod", "Policy"
    )
    $queueAttributes = Get-DatabaseInsightsValue $queueResponse "Attributes"
    if ([string](Get-DatabaseInsightsValue $queueAttributes "QueueArn" "") -cne $queueArn -or
        [string](Get-DatabaseInsightsValue $queueAttributes "SqsManagedSseEnabled" "") -cne "true" -or
        [int](Get-DatabaseInsightsValue $queueAttributes "MessageRetentionPeriod" -1) -ne `
            $script:DatabaseInsightsDurableRestoreFailureRetentionSeconds -or
        [int](Get-DatabaseInsightsValue $queueAttributes "ApproximateNumberOfMessages" -1) -ne 0 -or
        [int](Get-DatabaseInsightsValue $queueAttributes "ApproximateNumberOfMessagesNotVisible" -1) -ne 0 -or
        [int](Get-DatabaseInsightsValue $queueAttributes "ApproximateNumberOfMessagesDelayed" -1) -ne 0) {
        throw "The durable Database Insights restore DLQ is unencrypted, nonempty, short-retained, or identity-drifted."
    }
    try { $queuePolicy = [string](Get-DatabaseInsightsValue $queueAttributes "Policy" "") | ConvertFrom-Json -Depth 30 }
    catch { throw "The durable Database Insights restore DLQ policy is malformed." }
    $queueStatements = @(Get-DatabaseInsightsValue $queuePolicy "Statement" @())
    $tlsStatements = @($queueStatements | Where-Object {
        [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "DenyInsecureTransport"
    })
    $eventStatements = @($queueStatements | Where-Object {
        [string](Get-DatabaseInsightsValue $_ "Sid" "") -ceq "AcceptFailedAutomationEvents"
    })
    $tlsCondition = if ($tlsStatements.Count -eq 1) { Get-DatabaseInsightsValue $tlsStatements[0] "Condition" } else { $null }
    $tlsBool = Get-DatabaseInsightsValue $tlsCondition "Bool"
    $eventPrincipal = if ($eventStatements.Count -eq 1) { Get-DatabaseInsightsValue $eventStatements[0] "Principal" } else { $null }
    $eventCondition = if ($eventStatements.Count -eq 1) { Get-DatabaseInsightsValue $eventStatements[0] "Condition" } else { $null }
    $eventSourceArn = Get-DatabaseInsightsValue $eventCondition "ArnEquals"
    if ([string](Get-DatabaseInsightsValue $queuePolicy "Version" "") -cne "2012-10-17" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $queuePolicy) `
            @("Statement", "Version")) -or
        $queueStatements.Count -ne 2 -or $tlsStatements.Count -ne 1 -or $eventStatements.Count -ne 1 -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $tlsStatements[0]) `
            @("Action", "Condition", "Effect", "Principal", "Resource", "Sid")) -or
        -not (Test-DatabaseInsightsExactStrings `
            (Get-DatabaseInsightsObjectPropertyNames (Get-DatabaseInsightsValue $tlsStatements[0] "Principal")) `
            @("AWS")) -or
        -not (Test-DatabaseInsightsExactStrings `
            (Get-DatabaseInsightsValue (Get-DatabaseInsightsValue $tlsStatements[0] "Principal") "AWS" @()) `
            @("*")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $tlsCondition) @("Bool")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $tlsBool) `
            @("aws:SecureTransport")) -or
        [string](Get-DatabaseInsightsValue $tlsStatements[0] "Effect" "") -cne "Deny" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $tlsStatements[0] "Action" @()) @("sqs:*")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $tlsStatements[0] "Resource" @()) @($queueArn)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $tlsBool "aws:SecureTransport" @()) @("false")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $eventStatements[0]) `
            @("Action", "Condition", "Effect", "Principal", "Resource", "Sid")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $eventPrincipal) `
            @("Service")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $eventCondition) `
            @("ArnEquals")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $eventSourceArn) `
            @("aws:SourceArn")) -or
        [string](Get-DatabaseInsightsValue $eventStatements[0] "Effect" "") -cne "Allow" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $eventPrincipal "Service" @()) @("events.amazonaws.com")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $eventStatements[0] "Action" @()) @("sqs:SendMessage")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $eventStatements[0] "Resource" @()) @($queueArn)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $eventSourceArn "aws:SourceArn" @()) @($automationFailureRuleArn))) {
        throw "The durable Database Insights restore DLQ policy does not exactly bind encrypted transport and failed Automation events."
    }

    $alarmsResponse = Invoke-DatabaseInsightsAwsJson @(
        "cloudwatch", "describe-alarms", "--region", $region, "--alarm-names", $expectedAlarmName,
        "--alarm-types", "MetricAlarm", "--max-records", "100", "--no-paginate"
    )
    if (-not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $alarmsResponse "NextToken" ""))) {
        throw "The durable Database Insights restore alarm lookup was unexpectedly paginated."
    }
    $alarms = @(Get-DatabaseInsightsValue $alarmsResponse "MetricAlarms" @())
    $alarm = if ($alarms.Count -eq 1) { $alarms[0] } else { $null }
    $dimensions = @(Get-DatabaseInsightsValue $alarm "Dimensions" @())
    $dimension = if ($dimensions.Count -eq 1) { $dimensions[0] } else { $null }
    if ($null -eq $alarm -or
        [string](Get-DatabaseInsightsValue $alarm "AlarmName" "") -cne $expectedAlarmName -or
        (Get-DatabaseInsightsValue $alarm "ActionsEnabled" $false) -ne $true -or
        [string](Get-DatabaseInsightsValue $alarm "Namespace" "") -cne "AWS/SQS" -or
        [string](Get-DatabaseInsightsValue $alarm "MetricName" "") -cne "ApproximateNumberOfMessagesVisible" -or
        [string](Get-DatabaseInsightsValue $alarm "ComparisonOperator" "") -cne "GreaterThanThreshold" -or
        [double](Get-DatabaseInsightsValue $alarm "Threshold" -1) -ne 0 -or
        [int](Get-DatabaseInsightsValue $alarm "EvaluationPeriods" 0) -ne 1 -or
        [int](Get-DatabaseInsightsValue $alarm "DatapointsToAlarm" 0) -ne 1 -or
        [int](Get-DatabaseInsightsValue $alarm "Period" 0) -ne 60 -or
        [string](Get-DatabaseInsightsValue $alarm "Statistic" "") -cne "Maximum" -or
        $null -ne (Get-DatabaseInsightsValue $alarm "Unit" $null) -or
        [string](Get-DatabaseInsightsValue $alarm "TreatMissingData" "") -cne "notBreaching" -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $alarm "AlarmActions" @()) @($expectedAlertTopicArn)) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsValue $alarm "OKActions" @()) @($expectedAlertTopicArn)) -or
        $null -eq $dimension -or
        [string](Get-DatabaseInsightsValue $dimension "Name" "") -cne "QueueName" -or
        [string](Get-DatabaseInsightsValue $dimension "Value" "") -cne $queueName) {
        throw "The durable Database Insights restore failure alarm is missing or drifted."
    }
    return [ordered]@{
        scheduleGroupArnSha256 = Get-DatabaseInsightsTextSha256 $expectedGroupArn
        targetRoleArnSha256 = Get-DatabaseInsightsTextSha256 $roleArn
        deadLetterQueueArnSha256 = Get-DatabaseInsightsTextSha256 $queueArn
        automationDefinitionArnSha256 = Get-DatabaseInsightsTextSha256 $automationDefinitionArn
        automationRoleArnSha256 = Get-DatabaseInsightsTextSha256 $automationRoleArn
        automationFailureRuleArnSha256 = Get-DatabaseInsightsTextSha256 $automationFailureRuleArn
        failureAlarmNameSha256 = Get-DatabaseInsightsTextSha256 $expectedAlarmName
        alertTopicArnSha256 = Get-DatabaseInsightsTextSha256 $expectedAlertTopicArn
        state = "verified"
    }
}

function Get-DatabaseInsightsDurableRestoreSchedule {
    param($Binding)
    $list = Invoke-DatabaseInsightsAwsJson @(
        "scheduler", "list-schedules", "--region", [string]$Binding.region,
        "--group-name", [string]$Binding.scheduleGroupName,
        "--name-prefix", [string]$Binding.scheduleName,
        "--max-results", "100", "--no-paginate"
    )
    if (-not [string]::IsNullOrWhiteSpace([string](Get-DatabaseInsightsValue $list "NextToken" ""))) {
        throw "The durable Database Insights restore schedule lookup was unexpectedly paginated."
    }
    $matches = @(
        @(Get-DatabaseInsightsValue $list "Schedules" @()) |
            Where-Object { [string](Get-DatabaseInsightsValue $_ "Name" "") -ceq [string]$Binding.scheduleName }
    )
    if ($matches.Count -gt 1) {
        throw "The durable Database Insights restore schedule identity is ambiguous."
    }
    if ($matches.Count -eq 0) { return $null }
    return Invoke-DatabaseInsightsAwsJson @(
        "scheduler", "get-schedule", "--region", [string]$Binding.region,
        "--group-name", [string]$Binding.scheduleGroupName,
        "--name", [string]$Binding.scheduleName
    )
}

function Get-DatabaseInsightsActiveRestoreAutomations {
    param($Binding)
    $filters = @(
        [ordered]@{Key="DocumentNamePrefix";Values=@([string]$Binding.automationDocumentName)}
    ) | ConvertTo-Json -Depth 5 -Compress
    $activeStatuses = @(
        "Pending", "InProgress", "Waiting", "PendingApproval", "Approved", "Scheduled",
        "RunbookInProgress", "PendingChangeCalendarOverride", "ChangeCalendarOverrideApproved",
        "Cancelling"
    )
    $terminalStatuses = @(
        "Success", "TimedOut", "Cancelled", "Canceled", "Failed", "Rejected",
        "ChangeCalendarOverrideRejected", "CompletedWithSuccess", "CompletedWithFailure", "Exited"
    )
    $maximumPages = 100
    $maximumRecords = 10000
    $nextToken = ""
    $seenTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $seenExecutionIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $active = [Collections.Generic.List[object]]::new()
    $recordCount = 0
    for ($page = 0; $page -lt $maximumPages; $page++) {
        $arguments = [Collections.Generic.List[string]]::new()
        @(
            "ssm", "describe-automation-executions", "--region", [string]$Binding.region,
            "--filters", $filters, "--max-results", "50", "--no-paginate"
        ) | ForEach-Object { $arguments.Add([string]$_) }
        if (-not [string]::IsNullOrWhiteSpace($nextToken)) {
            $arguments.Add("--next-token")
            $arguments.Add($nextToken)
        }
        $response = Invoke-DatabaseInsightsAwsJson $arguments.ToArray()
        foreach ($execution in @(Get-DatabaseInsightsValue $response "AutomationExecutionMetadataList" @())) {
            $recordCount++
            if ($recordCount -gt $maximumRecords) {
                throw "The durable Database Insights Automation execution lookup exceeded its bounded record limit."
            }
            $executionId = [string](Get-DatabaseInsightsValue $execution "AutomationExecutionId" "")
            if ($executionId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' -or
                -not $seenExecutionIds.Add($executionId)) {
                throw "The durable Database Insights Automation execution lookup returned a missing or duplicate identity."
            }
            if ([string](Get-DatabaseInsightsValue $execution "DocumentName" "") -cne `
                    [string]$Binding.automationDocumentName) {
                continue
            }
            $documentVersion = [string](Get-DatabaseInsightsValue $execution "DocumentVersion" "")
            if ($documentVersion -notmatch '^[1-9][0-9]*$') {
                throw "The durable Database Insights Automation execution lookup returned an invalid document generation."
            }
            $status = [string](Get-DatabaseInsightsValue $execution "AutomationExecutionStatus" "")
            if ($activeStatuses -ccontains $status) {
                # Any active generation of this fixed-name restoration document
                # can still mutate the same database; conservatively block new
                # acquisition/disarm until it is terminal.
                $active.Add($execution)
            }
            elseif ($terminalStatuses -cnotcontains $status) {
                throw "The durable Database Insights Automation execution lookup returned an unsupported status."
            }
        }
        $nextToken = [string](Get-DatabaseInsightsValue $response "NextToken" "")
        if ([string]::IsNullOrWhiteSpace($nextToken)) { return $active.ToArray() }
        if (-not $seenTokens.Add($nextToken)) {
            throw "The durable Database Insights Automation execution lookup returned a pagination cycle."
        }
    }
    throw "The durable Database Insights Automation execution lookup exceeded its bounded page limit."
}

function Wait-DatabaseInsightsRestoreAutomationsQuiescent {
    param(
        $Binding,
        [int]$PollSeconds,
        [int]$TimeoutSeconds,
        [switch]$IncludeDeliveryGrace
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    if ($IncludeDeliveryGrace) {
        $graceSeconds = [int]$Binding.maximumEventAgeInSeconds + 5
        if ([DateTimeOffset]::UtcNow.AddSeconds($graceSeconds) -gt $deadline) {
            throw "The durable restore quiescence timeout does not cover the Scheduler delivery grace."
        }
        Start-Sleep -Seconds $graceSeconds
    }
    do {
        if (@(Get-DatabaseInsightsActiveRestoreAutomations $Binding).Count -eq 0) {
            return [ordered]@{state="quiescent";checkedAtUtc=[DateTimeOffset]::UtcNow.ToString("o")}
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds $PollSeconds
    } while ($true)
    throw "Timed out waiting for all durable Database Insights restoration Automations to become terminal."
}

function Start-DatabaseInsightsBoundRestoreAutomation {
    param($Binding)
    try { $targetInput = [string]$Binding.targetInput | ConvertFrom-Json -Depth 30 -AsHashtable }
    catch { throw "The bound durable restore Automation target input is malformed." }
    if (-not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $targetInput) `
            @("DocumentName", "DocumentVersion", "Parameters")) -or
        [string](Get-DatabaseInsightsValue $targetInput "DocumentName" "") -cne `
            [string]$Binding.automationDocumentName -or
        [string](Get-DatabaseInsightsValue $targetInput "DocumentVersion" "") -cne `
            [string]$Binding.automationDocumentVersion) {
        throw "The bound durable restore Automation target identity is malformed."
    }
    $parameters = Get-DatabaseInsightsValue $targetInput "Parameters"
    $restoreMode = @(Get-DatabaseInsightsValue $parameters "RestoreMode" @())
    if ($null -eq $parameters -or $restoreMode.Count -ne 1 -or [string]$restoreMode[0] -cne "scheduled") {
        throw "The bound durable restore Automation target omitted its scheduled generation mode."
    }
    $manualParameters = [ordered]@{}
    foreach ($parameterName in @(Get-DatabaseInsightsObjectPropertyNames $parameters)) {
        $values = @(Get-DatabaseInsightsValue $parameters $parameterName @())
        if ($values.Count -ne 1) {
            throw "The bound durable restore Automation target has an ambiguous parameter."
        }
        $manualParameters[$parameterName] = @([string]$values[0])
    }
    $manualParameters["RestoreMode"] = @("manual")
    $response = Invoke-DatabaseInsightsAwsJson @(
        "ssm", "start-automation-execution", "--region", [string]$Binding.region,
        "--document-name", [string]$Binding.automationDocumentName,
        "--document-version", [string]$Binding.automationDocumentVersion,
        "--parameters", ($manualParameters | ConvertTo-Json -Depth 20 -Compress)
    )
    $executionId = [string](Get-DatabaseInsightsValue $response "AutomationExecutionId" "")
    if ($executionId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
        throw "The manual durable restore Automation did not return one execution identity."
    }
    return [ordered]@{
        executionId = $executionId
        executionIdSha256 = Get-DatabaseInsightsTextSha256 $executionId
        documentVersion = [string]$Binding.automationDocumentVersion
        restoreMode = "manual"
    }
}

function Wait-DatabaseInsightsBoundRestoreAutomation {
    param($Binding, [string]$ExecutionId, [int]$PollSeconds, [int]$TimeoutSeconds)
    if ($ExecutionId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
        throw "The manual durable restore Automation execution identity is malformed."
    }
    $activeStatuses = @(
        "Pending", "InProgress", "Waiting", "PendingApproval", "Approved", "Scheduled",
        "RunbookInProgress", "PendingChangeCalendarOverride", "ChangeCalendarOverrideApproved",
        "Cancelling"
    )
    $successStatuses = @("Success", "CompletedWithSuccess")
    $failureStatuses = @(
        "TimedOut", "Cancelled", "Canceled", "Failed", "Rejected",
        "ChangeCalendarOverrideRejected", "CompletedWithFailure", "Exited"
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $response = Invoke-DatabaseInsightsAwsJson @(
            "ssm", "get-automation-execution", "--region", [string]$Binding.region,
            "--automation-execution-id", $ExecutionId
        )
        $execution = Get-DatabaseInsightsValue $response "AutomationExecution"
        if ($null -eq $execution -or
            [string](Get-DatabaseInsightsValue $execution "AutomationExecutionId" "") -cne $ExecutionId -or
            [string](Get-DatabaseInsightsValue $execution "DocumentName" "") -cne `
                [string]$Binding.automationDocumentName -or
            [string](Get-DatabaseInsightsValue $execution "DocumentVersion" "") -cne `
                [string]$Binding.automationDocumentVersion) {
            throw "The manual durable restore Automation execution binding drifted."
        }
        $status = [string](Get-DatabaseInsightsValue $execution "AutomationExecutionStatus" "")
        if ($successStatuses -ccontains $status) {
            return [ordered]@{
                executionIdSha256 = Get-DatabaseInsightsTextSha256 $ExecutionId
                state = "succeeded"
            }
        }
        if ($failureStatuses -ccontains $status) {
            throw "The manual durable restore Automation reached a terminal failure."
        }
        if ($activeStatuses -cnotcontains $status) {
            throw "The manual durable restore Automation returned an unsupported status."
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds $PollSeconds
    } while ($true)
    throw "Timed out waiting for the manual durable restore Automation to become terminal."
}

function Assert-DatabaseInsightsDurableRestoreSchedule {
    param($Schedule, $Binding, [ValidateSet("ENABLED", "DISABLED")][string]$ExpectedState = "ENABLED")
    if ($null -eq $Schedule) { throw "The durable Database Insights restore schedule is missing." }
    $flexible = Get-DatabaseInsightsValue $Schedule "FlexibleTimeWindow"
    $target = Get-DatabaseInsightsValue $Schedule "Target"
    $deadLetter = Get-DatabaseInsightsValue $target "DeadLetterConfig"
    $retry = Get-DatabaseInsightsValue $target "RetryPolicy"
    $targetInput = [string](Get-DatabaseInsightsValue $target "Input" "")
    $observedStartAt = [DateTimeOffset]::MinValue
    $expectedStartAt = [DateTimeOffset]::MinValue
    $startAtValid = [DateTimeOffset]::TryParse(
        [string](Get-DatabaseInsightsValue $Schedule "StartDate" ""), [ref]$observedStartAt
    ) -and [DateTimeOffset]::TryParse([string]$Binding.scheduleStartAtUtc, [ref]$expectedStartAt)
    if (-not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $Schedule) @(
            "ActionAfterCompletion", "Arn", "CreationDate", "Description", "FlexibleTimeWindow",
            "GroupName", "LastModificationDate", "Name", "ScheduleExpression",
            "ScheduleExpressionTimezone", "StartDate", "State", "Target")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $flexible) @("Mode")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $target) `
            @("Arn", "DeadLetterConfig", "Input", "RetryPolicy", "RoleArn")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $deadLetter) @("Arn")) -or
        -not (Test-DatabaseInsightsExactStrings (Get-DatabaseInsightsObjectPropertyNames $retry) `
            @("MaximumEventAgeInSeconds", "MaximumRetryAttempts")) -or
        [string](Get-DatabaseInsightsValue $Schedule "Arn" "") -cne [string]$Binding.scheduleArn -or
        [string](Get-DatabaseInsightsValue $Schedule "Name" "") -cne [string]$Binding.scheduleName -or
        [string](Get-DatabaseInsightsValue $Schedule "GroupName" "") -cne [string]$Binding.scheduleGroupName -or
        [string](Get-DatabaseInsightsValue $Schedule "Description" "") -cne [string]$Binding.description -or
        [string](Get-DatabaseInsightsValue $Schedule "ScheduleExpression" "") -cne [string]$Binding.scheduleExpression -or
        -not $startAtValid -or
        $observedStartAt.ToUniversalTime() -ne $expectedStartAt.ToUniversalTime() -or
        [string](Get-DatabaseInsightsValue $Schedule "ScheduleExpressionTimezone" "") -cne "UTC" -or
        [string](Get-DatabaseInsightsValue $Schedule "State" "") -cne $ExpectedState -or
        [string](Get-DatabaseInsightsValue $Schedule "ActionAfterCompletion" "") -cne "NONE" -or
        [string](Get-DatabaseInsightsValue $flexible "Mode" "") -cne "OFF" -or
        [string](Get-DatabaseInsightsValue $target "Arn" "") -cne [string]$Binding.targetArn -or
        [string](Get-DatabaseInsightsValue $target "RoleArn" "") -cne [string]$Binding.targetRoleArn -or
        [string](Get-DatabaseInsightsValue $deadLetter "Arn" "") -cne [string]$Binding.deadLetterQueueArn -or
        [int](Get-DatabaseInsightsValue $retry "MaximumEventAgeInSeconds" 0) -ne [int]$Binding.maximumEventAgeInSeconds -or
        [int](Get-DatabaseInsightsValue $retry "MaximumRetryAttempts" -1) -ne [int]$Binding.maximumRetryAttempts -or
        $targetInput -cne [string]$Binding.targetInput) {
        throw "The durable Database Insights restore schedule does not match its immutable lease binding."
    }
    return [ordered]@{
        bindingSha256 = [string]$Binding.bindingSha256
        scheduleArnSha256 = Get-DatabaseInsightsTextSha256 ([string]$Schedule.Arn)
        targetRoleArnSha256 = Get-DatabaseInsightsTextSha256 ([string]$target.RoleArn)
        deadLetterQueueArnSha256 = Get-DatabaseInsightsTextSha256 ([string]$deadLetter.Arn)
        automationDefinitionArnSha256 = Get-DatabaseInsightsTextSha256 ([string]$Binding.automationDefinitionArn)
        automationRoleArnSha256 = Get-DatabaseInsightsTextSha256 ([string]$Binding.automationRoleArn)
        automationFailureRuleArnSha256 = Get-DatabaseInsightsTextSha256 ([string]$Binding.automationFailureRuleArn)
        state = "armed"
    }
}

function New-DatabaseInsightsDurableRestoreSchedule {
    param($Binding)
    [void](Assert-DatabaseInsightsDurableRestoreInfrastructure $Binding)
    if ($null -ne (Get-DatabaseInsightsDurableRestoreSchedule $Binding)) {
        throw "A durable Database Insights restore generation already exists for this database."
    }
    [void](Wait-DatabaseInsightsRestoreAutomationsQuiescent $Binding 5 90 -IncludeDeliveryGrace)
    $flexible = [ordered]@{Mode="OFF"} | ConvertTo-Json -Compress
    $target = [ordered]@{
        Arn = [string]$Binding.targetArn
        RoleArn = [string]$Binding.targetRoleArn
        Input = [string]$Binding.targetInput
        DeadLetterConfig = [ordered]@{Arn=[string]$Binding.deadLetterQueueArn}
        RetryPolicy = [ordered]@{
            MaximumEventAgeInSeconds = [int]$Binding.maximumEventAgeInSeconds
            MaximumRetryAttempts = [int]$Binding.maximumRetryAttempts
        }
    } | ConvertTo-Json -Depth 10 -Compress
    [void](Invoke-DatabaseInsightsAwsJson @(
        "scheduler", "create-schedule", "--region", [string]$Binding.region,
        "--name", [string]$Binding.scheduleName,
        "--group-name", [string]$Binding.scheduleGroupName,
        "--description", [string]$Binding.description,
        "--schedule-expression", [string]$Binding.scheduleExpression,
        "--start-date", [string]$Binding.scheduleStartAtUtc,
        "--schedule-expression-timezone", "UTC",
        "--flexible-time-window", $flexible,
        "--target", $target,
        "--action-after-completion", "NONE",
        "--state", "ENABLED"
    ))
    $schedule = Get-DatabaseInsightsDurableRestoreSchedule $Binding
    return Assert-DatabaseInsightsDurableRestoreSchedule $schedule $Binding
}

function Disable-DatabaseInsightsDurableRestoreSchedule {
    param($Binding)
    $schedule = Get-DatabaseInsightsDurableRestoreSchedule $Binding
    [void](Assert-DatabaseInsightsDurableRestoreSchedule $schedule $Binding "ENABLED")
    $flexible = [ordered]@{Mode="OFF"} | ConvertTo-Json -Compress
    $target = [ordered]@{
        Arn = [string]$Binding.targetArn
        RoleArn = [string]$Binding.targetRoleArn
        Input = [string]$Binding.targetInput
        DeadLetterConfig = [ordered]@{Arn=[string]$Binding.deadLetterQueueArn}
        RetryPolicy = [ordered]@{
            MaximumEventAgeInSeconds = [int]$Binding.maximumEventAgeInSeconds
            MaximumRetryAttempts = [int]$Binding.maximumRetryAttempts
        }
    } | ConvertTo-Json -Depth 10 -Compress
    [void](Invoke-DatabaseInsightsAwsJson @(
        "scheduler", "update-schedule", "--region", [string]$Binding.region,
        "--name", [string]$Binding.scheduleName,
        "--group-name", [string]$Binding.scheduleGroupName,
        "--description", [string]$Binding.description,
        "--schedule-expression", [string]$Binding.scheduleExpression,
        "--start-date", [string]$Binding.scheduleStartAtUtc,
        "--schedule-expression-timezone", "UTC",
        "--flexible-time-window", $flexible,
        "--target", $target,
        "--action-after-completion", "NONE",
        "--state", "DISABLED"
    ))
    $disabled = Get-DatabaseInsightsDurableRestoreSchedule $Binding
    [void](Assert-DatabaseInsightsDurableRestoreSchedule $disabled $Binding "DISABLED")
    return [ordered]@{bindingSha256=[string]$Binding.bindingSha256;state="disabled"}
}

function Remove-DatabaseInsightsDurableRestoreSchedule {
    param($Binding, [switch]$AllowAlreadyExecuted, [switch]$AllowAlreadyRemoved)
    $schedule = Get-DatabaseInsightsDurableRestoreSchedule $Binding
    if ($null -eq $schedule) {
        if ($AllowAlreadyRemoved) {
            return [ordered]@{bindingSha256=[string]$Binding.bindingSha256;state="already_removed"}
        }
        $expiresAt = [DateTimeOffset]::MinValue
        if ($AllowAlreadyExecuted -and
            [DateTimeOffset]::TryParse([string]$Binding.expiresAtUtc, [ref]$expiresAt) -and
            [DateTimeOffset]::UtcNow -ge $expiresAt.ToUniversalTime()) {
            return [ordered]@{bindingSha256=[string]$Binding.bindingSha256;state="executed_and_removed"}
        }
        throw "The durable Database Insights restore schedule disappeared before verified restoration."
    }
    $observedState = [string](Get-DatabaseInsightsValue $schedule "State" "")
    if ($observedState -notmatch '^(ENABLED|DISABLED)$') {
        throw "The durable Database Insights restore schedule has an unsupported state."
    }
    [void](Assert-DatabaseInsightsDurableRestoreSchedule $schedule $Binding $observedState)
    [void](Invoke-DatabaseInsightsAwsJson @(
        "scheduler", "delete-schedule", "--region", [string]$Binding.region,
        "--group-name", [string]$Binding.scheduleGroupName,
        "--name", [string]$Binding.scheduleName
    ))
    if ($null -ne (Get-DatabaseInsightsDurableRestoreSchedule $Binding)) {
        throw "The durable Database Insights restore schedule was not deleted after verified restoration."
    }
    return [ordered]@{bindingSha256=[string]$Binding.bindingSha256;state="removed"}
}

function Read-DatabaseInsightsLeaseReceipt {
    param([string]$Path, [string]$ExpectedSha256)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "The immutable Database Insights lease receipt is missing." }
    $expected = Assert-DatabaseInsightsSha256 $ExpectedSha256 "ExpectedReceiptSha256"
    if ((Get-DatabaseInsightsFileSha256 $Path) -cne $expected) { throw "The Database Insights lease receipt was changed after capture." }
    Assert-DatabaseInsightsPrivateAcl -Path $Path
    try { $receipt = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "The Database Insights lease receipt is malformed." }
    if ([int](Get-DatabaseInsightsValue $receipt "schemaVersion" 0) -ne 2 -or
        [string](Get-DatabaseInsightsValue $receipt "type" "") -cne "database_insights_monitoring_lease" -or
        [string](Get-DatabaseInsightsValue $receipt "leaseVersion" "") -cne $script:DatabaseInsightsLeaseVersion -or
        [string](Get-DatabaseInsightsValue $receipt "leaseId" "") -notmatch '^[0-9a-f]{32}$') {
        throw "The Database Insights lease receipt has an unsupported identity."
    }
    return $receipt
}

function Write-DatabaseInsightsLeaseStatus {
    param([string]$StatusPath, [string]$ReceiptSha256, [string]$State, $ObservedPosture, [string]$FailureStage = "", [string]$FailureMessage = "")
    $failureHash = if ([string]::IsNullOrEmpty($FailureMessage)) { $null } else { Get-DatabaseInsightsTextSha256 $FailureMessage }
    Write-DatabaseInsightsPrivateJson -Path $StatusPath -Value ([ordered]@{
        schemaVersion = 1
        type = "database_insights_monitoring_lease_status"
        leaseVersion = $script:DatabaseInsightsLeaseVersion
        receiptSha256 = $ReceiptSha256
        state = $State
        completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        failureStage = if ($FailureStage) { $FailureStage } else { $null }
        discardedMessageSha256 = $failureHash
        rawErrorPersisted = $false
        observedPosture = $ObservedPosture
    })
}

function Read-DatabaseInsightsLeaseStatus {
    param([string]$StatusPath, [string]$ReceiptSha256)
    if (-not (Test-Path -LiteralPath $StatusPath -PathType Leaf)) {
        throw "The Database Insights lease status journal is missing."
    }
    Assert-DatabaseInsightsPrivateAcl -Path $StatusPath
    try { $status = Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json -Depth 40 }
    catch { throw "The Database Insights lease status journal is malformed." }
    if ([int](Get-DatabaseInsightsValue $status "schemaVersion" 0) -ne 1 -or
        [string](Get-DatabaseInsightsValue $status "type" "") -cne "database_insights_monitoring_lease_status" -or
        [string](Get-DatabaseInsightsValue $status "leaseVersion" "") -cne $script:DatabaseInsightsLeaseVersion -or
        [string](Get-DatabaseInsightsValue $status "receiptSha256" "") -cne $ReceiptSha256 -or
        [string](Get-DatabaseInsightsValue $status "state" "") -notmatch '^(captured|active|restore_automation_starting|restore_automation_started|restore_posture_verified|restore_guard_disabled|restore_guard_delete_authorized|restore_guard_removed|restored|restore_failed|acquire_failed_restored|acquire_failed_unmutated)$') {
        throw "The Database Insights lease status journal has an unsupported identity or state."
    }
    return $status
}

function Get-DatabaseInsightsWatchdogPath {
    param([string]$ReceiptPath)
    return "$ReceiptPath.watchdog.json"
}

function Get-DatabaseInsightsReceiptExpirationText {
    param($Receipt)
    $expiresAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Receipt.expiresAtUtc, [ref]$expiresAt)) {
        throw "The Database Insights lease receipt has an invalid expiration."
    }
    return $expiresAt.ToUniversalTime().ToString("o")
}

function Get-DatabaseInsightsTimestampText {
    param($Value, [string]$Name)
    if ($Value -is [DateTimeOffset]) {
        return ([DateTimeOffset]$Value).ToUniversalTime().ToString("o")
    }
    if ($Value -is [DateTime]) {
        $dateTime = [DateTime]$Value
        if ($dateTime.Kind -eq [DateTimeKind]::Unspecified) {
            throw "$Name must include an explicit UTC offset."
        }
        return ([DateTimeOffset]::new($dateTime.ToUniversalTime())).ToString("o")
    }
    $text = [string]$Value
    if ($text -notmatch '(Z|[+-][0-9]{2}:[0-9]{2})$') {
        throw "$Name must include an explicit UTC offset."
    }
    $timestamp = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($text, [ref]$timestamp)) {
        throw "$Name is not a valid timestamp."
    }
    return $timestamp.ToUniversalTime().ToString("o")
}

function Write-DatabaseInsightsWatchdogHeartbeat {
    param(
        [string]$WatchdogPath,
        $Receipt,
        [string]$ReceiptSha256,
        [ValidateSet("armed", "monitoring", "restoring", "restored", "failed")]
        [string]$State,
        [string]$FailureMessage = ""
    )
    $failureHash = if ([string]::IsNullOrEmpty($FailureMessage)) { $null } else { Get-DatabaseInsightsTextSha256 $FailureMessage }
    Write-DatabaseInsightsPrivateJson -Path $WatchdogPath -Value ([ordered]@{
        schemaVersion = 1
        type = "database_insights_monitoring_lease_watchdog"
        leaseVersion = $script:DatabaseInsightsLeaseVersion
        receiptSha256 = $ReceiptSha256
        leaseIdSha256 = Get-DatabaseInsightsTextSha256 ([string]$Receipt.leaseId)
        expiresAtUtc = Get-DatabaseInsightsReceiptExpirationText $Receipt
        state = $State
        observedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        discardedMessageSha256 = $failureHash
        rawErrorPersisted = $false
    })
}

function Read-DatabaseInsightsWatchdogHeartbeat {
    param([string]$WatchdogPath, $Receipt, [string]$ReceiptSha256, [switch]$RequireFresh)
    if (-not (Test-Path -LiteralPath $WatchdogPath -PathType Leaf)) {
        throw "The bounded Database Insights lease watchdog heartbeat is missing."
    }
    Assert-DatabaseInsightsPrivateAcl -Path $WatchdogPath
    try { $heartbeat = Get-Content -LiteralPath $WatchdogPath -Raw | ConvertFrom-Json -Depth 20 }
    catch { throw "The bounded Database Insights lease watchdog heartbeat is malformed." }
    $observedAt = [DateTimeOffset]::MinValue
    $heartbeatExpiresAt = [DateTimeOffset]::MinValue
    $receiptExpiresAt = [DateTimeOffset]::MinValue
    if ([int](Get-DatabaseInsightsValue $heartbeat "schemaVersion" 0) -ne 1 -or
        [string](Get-DatabaseInsightsValue $heartbeat "type" "") -cne "database_insights_monitoring_lease_watchdog" -or
        [string](Get-DatabaseInsightsValue $heartbeat "leaseVersion" "") -cne $script:DatabaseInsightsLeaseVersion -or
        [string](Get-DatabaseInsightsValue $heartbeat "receiptSha256" "") -cne $ReceiptSha256 -or
        [string](Get-DatabaseInsightsValue $heartbeat "leaseIdSha256" "") -cne (Get-DatabaseInsightsTextSha256 ([string]$Receipt.leaseId)) -or
        -not [DateTimeOffset]::TryParse([string](Get-DatabaseInsightsValue $heartbeat "expiresAtUtc" ""), [ref]$heartbeatExpiresAt) -or
        -not [DateTimeOffset]::TryParse([string]$Receipt.expiresAtUtc, [ref]$receiptExpiresAt) -or
        [Math]::Abs(($heartbeatExpiresAt.ToUniversalTime() - $receiptExpiresAt.ToUniversalTime()).TotalMilliseconds) -ge 1000 -or
        [string](Get-DatabaseInsightsValue $heartbeat "state" "") -notmatch '^(armed|monitoring|restoring|restored|failed)$' -or
        -not [DateTimeOffset]::TryParse([string](Get-DatabaseInsightsValue $heartbeat "observedAtUtc" ""), [ref]$observedAt)) {
        throw "The bounded Database Insights lease watchdog heartbeat has an unsupported identity."
    }
    if ($RequireFresh) {
        $age = [DateTimeOffset]::UtcNow - $observedAt.ToUniversalTime()
        if ($age.TotalSeconds -lt -5 -or $age.TotalSeconds -gt $script:DatabaseInsightsWatchdogHeartbeatStaleSeconds -or
            [string]$heartbeat.state -notmatch '^(armed|monitoring)$') {
            throw "The bounded Database Insights lease watchdog is not fresh and active."
        }
    }
    return $heartbeat
}

function Get-DatabaseInsightsLeaseMutexName {
    param([string]$AccountId, [string]$Region, [string]$DbInstanceIdentifier)
    $suffix = Get-DatabaseInsightsTextSha256 "$AccountId|$Region|$DbInstanceIdentifier"
    if ($IsWindows) { return "Local\SchoolPilot.DatabaseInsightsLease.$suffix" }
    return "SchoolPilot.DatabaseInsightsLease.$suffix"
}

function Invoke-WithDatabaseInsightsLeaseMutex {
    param(
        [string]$AccountId,
        [string]$Region,
        [string]$DbInstanceIdentifier,
        [int]$TimeoutSeconds,
        [scriptblock]$Action
    )
    $mutex = [Threading.Mutex]::new(
        $false,
        (Get-DatabaseInsightsLeaseMutexName $AccountId $Region $DbInstanceIdentifier)
    )
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds([Math]::Max(60, $TimeoutSeconds + 60))) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw "Timed out serializing the Database Insights lease restoration." }
        return & $Action
    }
    finally {
        if ($acquired) { try { $mutex.ReleaseMutex() } catch { } }
        $mutex.Dispose()
    }
}

function Start-DatabaseInsightsLeaseWatchdog {
    param(
        [string]$ReceiptPath,
        [string]$ReceiptSha256,
        $Receipt,
        [string]$Region,
        [string]$ExpectedAccountId,
        [string]$ExpectedClass,
        [string]$LeasePurpose,
        [int]$PollSeconds,
        [int]$TimeoutSeconds
    )
    if ([string]::IsNullOrWhiteSpace($PSCommandPath) -or -not (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) {
        throw "The reviewed Database Insights lease helper cannot arm its watchdog."
    }
    $watchdogPath = Get-DatabaseInsightsWatchdogPath $ReceiptPath
    if (Test-Path -LiteralPath $watchdogPath) {
        throw "The Database Insights watchdog artifact already exists; use a fresh receipt path."
    }
    $pwshPath = (Get-Process -Id $PID).Path
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $pwshPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @(
        "-NoProfile", "-NonInteractive", "-File", $PSCommandPath,
        "-Mode", "Watchdog", "-DbInstanceIdentifier", [string]$Receipt.dbInstanceIdentifier,
        "-ReceiptPath", $ReceiptPath, "-ExpectedReceiptSha256", $ReceiptSha256,
        "-Region", $Region, "-ExpectedAccountId", $ExpectedAccountId,
        "-ExpectedRdsInstanceClass", $ExpectedClass, "-LeasePurpose", $LeasePurpose,
        "-PollSeconds", [string]$PollSeconds, "-TimeoutSeconds", [string]$TimeoutSeconds
    )) { [void]$startInfo.ArgumentList.Add([string]$argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "The Database Insights watchdog process did not start." }
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
        do {
            if ($process.HasExited) { throw "The Database Insights watchdog exited before committing its heartbeat." }
            if (Test-Path -LiteralPath $watchdogPath -PathType Leaf) {
                $heartbeat = Read-DatabaseInsightsWatchdogHeartbeat $watchdogPath $Receipt $ReceiptSha256 -RequireFresh
                return [ordered]@{
                    processId = $process.Id
                    heartbeatSha256 = Get-DatabaseInsightsFileSha256 $watchdogPath
                    state = [string]$heartbeat.state
                }
            }
            Start-Sleep -Milliseconds 250
        } while ([DateTimeOffset]::UtcNow -lt $deadline)
        throw "The Database Insights watchdog did not commit a timely heartbeat."
    }
    catch {
        if (-not $process.HasExited) { try { $process.Kill($true) } catch { } }
        throw
    }
    finally { $process.Dispose() }
}

function Assert-DatabaseInsightsReceiptBinding {
    param($Receipt, [string]$Region, [string]$ExpectedAccountId, [string]$ExpectedIdentifier, [string]$ExpectedClass, [string]$ExpectedLeasePurpose)
    $capturedAt = [DateTimeOffset]::MinValue
    $expiresAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Receipt.capturedAtUtc, [ref]$capturedAt) -or
        -not [DateTimeOffset]::TryParse([string]$Receipt.expiresAtUtc, [ref]$expiresAt) -or
        $expiresAt -le $capturedAt -or $expiresAt -gt $capturedAt.AddHours(12)) {
        throw "The Database Insights lease receipt has an invalid bounded lifetime."
    }
    [void](Assert-DatabaseInsightsPreservedMonitoringPosture $Receipt.initialPosture $Receipt.initialPosture)
    $preservedPostureSha256 = Get-DatabaseInsightsPreservedMonitoringPostureSha256 $Receipt.initialPosture
    $observedDurableGuard = Get-DatabaseInsightsValue $Receipt "durableRestoreGuard"
    if ($null -eq $observedDurableGuard) {
        throw "The Database Insights lease receipt is missing its exact AWS-native durable restore guard binding."
    }
    $boundAutomationDocumentContentSha256 = Assert-DatabaseInsightsSha256 `
        ([string](Get-DatabaseInsightsValue $observedDurableGuard "automationDocumentContentSha256" "")) `
        "The Database Insights lease receipt Automation document content hash"
    # Restore and watchdog paths must remain independent of SSM availability. The
    # immutable receipt already binds the numeric document version/content hash;
    # Validate separately proves that exact live Automation infrastructure.
    $expectedDurableGuard = Get-DatabaseInsightsDurableRestoreGuardBinding `
        $Receipt.initialPosture $ExpectedAccountId $Region $ExpectedIdentifier ([string]$Receipt.leaseId) `
        $expiresAt.ToUniversalTime() $boundAutomationDocumentContentSha256
    if ([string]$Receipt.region -cne $Region -or [string]$Receipt.accountId -cne $ExpectedAccountId -or
        [string]$Receipt.dbInstanceIdentifier -cne $ExpectedIdentifier -or [string]$Receipt.expectedRdsInstanceClass -cne $ExpectedClass -or
        [string]$Receipt.leasePurpose -cne $ExpectedLeasePurpose -or
        [string]$Receipt.initialPosture.databaseInsightsMode -cne "standard" -or
        [int]$Receipt.initialPosture.performanceInsightsRetentionPeriod -ne $script:DatabaseInsightsStandardRetentionDays -or
        $Receipt.initialPosture.performanceInsightsEnabled -ne $true -or
        [string]$Receipt.requestedPosture.databaseInsightsMode -cne "advanced" -or
        [int]$Receipt.requestedPosture.performanceInsightsRetentionPeriod -ne $script:DatabaseInsightsAdvancedRetentionDays -or
        $Receipt.requestedPosture.performanceInsightsEnabled -ne $true -or
        [string](Get-DatabaseInsightsValue $Receipt.requestedPosture "preservedMonitoringPostureSha256" "") -cne $preservedPostureSha256) {
        throw "The Database Insights lease receipt is bound to a different account, region, instance, class, or posture."
    }
    if ([string](Get-DatabaseInsightsValue $observedDurableGuard "bindingSha256" "") -cne [string]$expectedDurableGuard.bindingSha256 -or
        (Get-DatabaseInsightsDurableRestoreGuardBindingSha256 $observedDurableGuard) -cne [string]$expectedDurableGuard.bindingSha256) {
        throw "The Database Insights lease receipt is missing its exact AWS-native durable restore guard binding."
    }
    return [ordered]@{capturedAtUtc=$capturedAt.ToUniversalTime();expiresAtUtc=$expiresAt.ToUniversalTime()}
}

function Restore-DatabaseInsightsLease {
    param(
        $Receipt,
        [string]$ReceiptSha256,
        [string]$ReceiptPath,
        [string]$StatusPath,
        [string]$Region,
        [string]$DbInstanceIdentifier,
        [string]$ExpectedClass,
        [int]$PollSeconds,
        [int]$TimeoutSeconds
    )
    return Invoke-WithDatabaseInsightsLeaseMutex -AccountId ([string]$Receipt.accountId) -Region $Region `
        -DbInstanceIdentifier $DbInstanceIdentifier -TimeoutSeconds $TimeoutSeconds -Action {
        $lastCommittedRestoreState = ""
        $restored = $null
        try {
            $priorStatusState = ""
            try {
                $priorStatus = Read-DatabaseInsightsLeaseStatus $StatusPath $ReceiptSha256
                $priorStatusState = [string]$priorStatus.state
            }
            catch { $priorStatusState = "" }
            $lastCommittedRestoreState = $priorStatusState
            $current = Get-DatabaseInsightsPosture -Region $Region -DbInstanceIdentifier $DbInstanceIdentifier
            [void](Assert-DatabaseInsightsLeaseIdentity $current $Receipt.initialPosture $DbInstanceIdentifier $ExpectedClass)
            $restored = $current
            $priorTerminalRestoration = $priorStatusState -match '^(restored|acquire_failed_restored)$'
            $guardSchedule = Get-DatabaseInsightsDurableRestoreSchedule $Receipt.durableRestoreGuard
            $alreadyRestored = $false
            try {
                [void](Assert-DatabaseInsightsPosture $current $DbInstanceIdentifier $ExpectedClass "standard" `
                    $script:DatabaseInsightsStandardRetentionDays $Receipt.initialPosture)
                $alreadyRestored = $true
            }
            catch { $alreadyRestored = $false }

            # This process deliberately owns no RDS/Scheduler mutation during
            # restoration.  The exact, receipt-bound manual SSM Automation is
            # the distributed generation fence and performs disarm, restore,
            # delivery-grace drain, re-verification, and deletion atomically
            # with respect to Acquire's all-version Automation barrier.
            if ($null -eq $guardSchedule) {
                $missingGuardAuthorizedStates = @(
                    "restore_automation_starting", "restore_automation_started",
                    "restore_guard_delete_authorized", "restore_guard_removed",
                    "restored", "acquire_failed_restored"
                )
                if ($missingGuardAuthorizedStates -cnotcontains $priorStatusState -or -not $alreadyRestored) {
                    throw "The recurring durable restore guard disappeared before explicit disarm and exact Standard/7 convergence."
                }
                [void](Wait-DatabaseInsightsRestoreAutomationsQuiescent `
                    $Receipt.durableRestoreGuard $PollSeconds $TimeoutSeconds)
                $reverified = Get-DatabaseInsightsPosture -Region $Region `
                    -DbInstanceIdentifier $DbInstanceIdentifier
                $restored = Assert-DatabaseInsightsPosture $reverified $DbInstanceIdentifier $ExpectedClass `
                    "standard" $script:DatabaseInsightsStandardRetentionDays $Receipt.initialPosture
                if ($null -ne (Get-DatabaseInsightsDurableRestoreSchedule $Receipt.durableRestoreGuard)) {
                    throw "A durable restore generation appeared while completing a removed-guard restoration."
                }
                if (-not $priorTerminalRestoration) {
                    Write-DatabaseInsightsLeaseStatus $StatusPath $ReceiptSha256 "restore_guard_removed" $restored
                    $lastCommittedRestoreState = "restore_guard_removed"
                }
            }
            else {
                $guardState = [string](Get-DatabaseInsightsValue $guardSchedule "State" "")
                if ($guardState -notmatch '^(ENABLED|DISABLED)$') {
                    throw "The recurring durable restore guard has an unsupported disarm state."
                }
                [void](Assert-DatabaseInsightsDurableRestoreSchedule `
                    $guardSchedule $Receipt.durableRestoreGuard $guardState)
                Write-DatabaseInsightsLeaseStatus $StatusPath $ReceiptSha256 `
                    "restore_automation_starting" $current
                $lastCommittedRestoreState = "restore_automation_starting"
                $manualRestore = Start-DatabaseInsightsBoundRestoreAutomation `
                    $Receipt.durableRestoreGuard
                Write-DatabaseInsightsLeaseStatus $StatusPath $ReceiptSha256 `
                    "restore_automation_started" $current
                $lastCommittedRestoreState = "restore_automation_started"
                [void](Wait-DatabaseInsightsBoundRestoreAutomation `
                    $Receipt.durableRestoreGuard ([string]$manualRestore.executionId) `
                    $PollSeconds $TimeoutSeconds)
                [void](Wait-DatabaseInsightsRestoreAutomationsQuiescent `
                    $Receipt.durableRestoreGuard $PollSeconds $TimeoutSeconds)
                $reverified = Get-DatabaseInsightsPosture -Region $Region `
                    -DbInstanceIdentifier $DbInstanceIdentifier
                $restored = Assert-DatabaseInsightsPosture $reverified $DbInstanceIdentifier $ExpectedClass `
                    "standard" $script:DatabaseInsightsStandardRetentionDays $Receipt.initialPosture
                $remainingGuard = Get-DatabaseInsightsDurableRestoreSchedule $Receipt.durableRestoreGuard
                if ($null -ne $remainingGuard) {
                    $remainingState = [string](Get-DatabaseInsightsValue $remainingGuard "State" "")
                    if ($remainingState -match '^(ENABLED|DISABLED)$') {
                        [void](Assert-DatabaseInsightsDurableRestoreSchedule `
                            $remainingGuard $Receipt.durableRestoreGuard $remainingState)
                    }
                    throw "The manual durable restore Automation did not remove the exact recurring guard."
                }
                if (-not $priorTerminalRestoration) {
                    Write-DatabaseInsightsLeaseStatus $StatusPath $ReceiptSha256 "restore_guard_removed" $restored
                    $lastCommittedRestoreState = "restore_guard_removed"
                }
            }
            Write-DatabaseInsightsLeaseStatus $StatusPath $ReceiptSha256 "restored" $restored
            $lastCommittedRestoreState = "restored"
            return $restored
        }
        catch {
            if ($lastCommittedRestoreState -match '^(restored|acquire_failed_restored)$') {
                # Never replace already committed terminal restoration evidence.
            }
            elseif ($lastCommittedRestoreState -match `
                '^restore_(automation_starting|automation_started|posture_verified|guard_disabled|guard_delete_authorized|guard_removed)$') {
                Write-DatabaseInsightsLeaseStatus $StatusPath $ReceiptSha256 $lastCommittedRestoreState `
                    $restored "restore" $_.Exception.Message
            }
            else {
                Write-DatabaseInsightsLeaseStatus $StatusPath $ReceiptSha256 "restore_failed" $null `
                    "restore" $_.Exception.Message
            }
            throw "Exact Database Insights posture restoration failed; certification and diagnostic progression are blocked."
        }
    }
}

function Invoke-DatabaseInsightsLeaseWatchdog {
    param(
        $Receipt,
        [string]$ReceiptSha256,
        [string]$ReceiptPath,
        [string]$StatusPath,
        [string]$WatchdogPath,
        [string]$Region,
        [string]$ExpectedAccountId,
        [string]$DbInstanceIdentifier,
        [string]$ExpectedClass,
        [DateTimeOffset]$ExpiresAtUtc,
        [int]$PollSeconds,
        [int]$TimeoutSeconds
    )
    Write-DatabaseInsightsWatchdogHeartbeat $WatchdogPath $Receipt $ReceiptSha256 "armed"
    while ($true) {
        $restoreNow = [DateTimeOffset]::UtcNow -ge $ExpiresAtUtc
        try {
            $status = Read-DatabaseInsightsLeaseStatus $StatusPath $ReceiptSha256
            if ([string]$status.state -match '^(restored|acquire_failed_restored)$') {
                Write-DatabaseInsightsWatchdogHeartbeat $WatchdogPath $Receipt $ReceiptSha256 "restored"
                return [ordered]@{state="restored_observed";receiptSha256=$ReceiptSha256}
            }
            if ([string]$status.state -cne "active") { $restoreNow = $true }
        }
        catch { $restoreNow = $true }

        if ($restoreNow) {
            Write-DatabaseInsightsWatchdogHeartbeat $WatchdogPath $Receipt $ReceiptSha256 "restoring"
            try {
                $callerAccount = Get-DatabaseInsightsCallerAccount
                if ($callerAccount -cne $ExpectedAccountId) {
                    throw "AWS caller identity is not the expected Database Insights lease account."
                }
                [void](Restore-DatabaseInsightsLease $Receipt $ReceiptSha256 $ReceiptPath $StatusPath $Region `
                    $DbInstanceIdentifier $ExpectedClass $PollSeconds $TimeoutSeconds)
                Write-DatabaseInsightsWatchdogHeartbeat $WatchdogPath $Receipt $ReceiptSha256 "restored"
                return [ordered]@{state="restored";receiptSha256=$ReceiptSha256}
            }
            catch {
                Write-DatabaseInsightsWatchdogHeartbeat $WatchdogPath $Receipt $ReceiptSha256 "failed" $_.Exception.Message
                throw "The bounded Database Insights lease watchdog could not restore the captured posture."
            }
        }

        Write-DatabaseInsightsWatchdogHeartbeat $WatchdogPath $Receipt $ReceiptSha256 "monitoring"
        $remainingSeconds = [Math]::Max(1, [Math]::Ceiling(($ExpiresAtUtc - [DateTimeOffset]::UtcNow).TotalSeconds))
        Start-Sleep -Seconds ([int][Math]::Min($script:DatabaseInsightsWatchdogPollSeconds, $remainingSeconds))
    }
}

function Invoke-DatabaseInsightsLease {
    param(
        [string]$Mode,
        [string]$DbInstanceIdentifier,
        [string]$ReceiptPath,
        [string]$ExpectedReceiptSha256,
        [string]$Region,
        [string]$ExpectedAccountId,
        [string]$ExpectedRdsInstanceClass,
        [string]$LeasePurpose,
        [int]$MaximumLeaseMinutes,
        [int]$PollSeconds,
        [int]$TimeoutSeconds
    )
    $resolvedReceipt = Resolve-DatabaseInsightsReceiptPath $ReceiptPath
    $statusPath = "$resolvedReceipt.status.json"
    $watchdogPath = Get-DatabaseInsightsWatchdogPath $resolvedReceipt

    if ($Mode -eq "Watchdog") {
        if ([string]::IsNullOrWhiteSpace($ExpectedReceiptSha256)) {
            throw "ExpectedReceiptSha256 is required for the lease watchdog."
        }
        $receipt = Read-DatabaseInsightsLeaseReceipt $resolvedReceipt $ExpectedReceiptSha256
        $lifetime = Assert-DatabaseInsightsReceiptBinding $receipt $Region $ExpectedAccountId $DbInstanceIdentifier $ExpectedRdsInstanceClass $LeasePurpose
        return Invoke-DatabaseInsightsLeaseWatchdog $receipt $ExpectedReceiptSha256 $resolvedReceipt $statusPath `
            $watchdogPath $Region $ExpectedAccountId $DbInstanceIdentifier $ExpectedRdsInstanceClass `
            $lifetime.expiresAtUtc $PollSeconds $TimeoutSeconds
    }

    $callerAccount = Get-DatabaseInsightsCallerAccount
    if ($callerAccount -cne $ExpectedAccountId) { throw "AWS caller identity is not the expected Database Insights lease account." }

    if ($Mode -eq "Acquire") {
        if ((Test-Path -LiteralPath $resolvedReceipt) -or (Test-Path -LiteralPath $statusPath) -or
            (Test-Path -LiteralPath $watchdogPath)) {
            throw "Database Insights lease artifacts already exist; use a fresh receipt path."
        }
        $initial = Get-DatabaseInsightsPosture -Region $Region -DbInstanceIdentifier $DbInstanceIdentifier
        [void](Assert-DatabaseInsightsPosture $initial $DbInstanceIdentifier $ExpectedRdsInstanceClass "standard" $script:DatabaseInsightsStandardRetentionDays)
        $captured = [DateTimeOffset]::UtcNow
        $unroundedExpiration = $captured.AddMinutes($MaximumLeaseMinutes).ToUniversalTime()
        $expirationTicks = $unroundedExpiration.UtcDateTime.Ticks
        $tickRemainder = $expirationTicks % [TimeSpan]::TicksPerSecond
        if ($tickRemainder -ne 0) { $expirationTicks += [TimeSpan]::TicksPerSecond - $tickRemainder }
        $expiresAt = [DateTimeOffset]::new([DateTime]::new($expirationTicks, [DateTimeKind]::Utc))
        $leaseId = [Guid]::NewGuid().ToString("N")
        $durableRestoreGuard = Get-DatabaseInsightsDurableRestoreGuardBinding `
            $initial $ExpectedAccountId $Region $DbInstanceIdentifier $leaseId $expiresAt
        $receipt = [ordered]@{
            schemaVersion = 2
            type = "database_insights_monitoring_lease"
            leaseVersion = $script:DatabaseInsightsLeaseVersion
            leaseId = $leaseId
            leasePurpose = $LeasePurpose
            capturedAtUtc = $captured.ToString("o")
            expiresAtUtc = $expiresAt.ToString("o")
            accountId = $ExpectedAccountId
            region = $Region
            dbInstanceIdentifier = $DbInstanceIdentifier
            expectedRdsInstanceClass = $ExpectedRdsInstanceClass
            initialPosture = $initial
            requestedPosture = [ordered]@{
                databaseInsightsMode = "advanced"
                performanceInsightsEnabled = $true
                performanceInsightsRetentionPeriod = $script:DatabaseInsightsAdvancedRetentionDays
                preservedMonitoringPostureSha256 = Get-DatabaseInsightsPreservedMonitoringPostureSha256 $initial
            }
            durableRestoreGuard = $durableRestoreGuard
        }
        Write-DatabaseInsightsPrivateJson -Path $resolvedReceipt -Value $receipt -Immutable
        $receiptSha = Get-DatabaseInsightsFileSha256 $resolvedReceipt
        Write-DatabaseInsightsLeaseStatus $statusPath $receiptSha "captured" $initial
        $advancedMutationAttempted = $false
        try {
            $durableGuard = New-DatabaseInsightsDurableRestoreSchedule $durableRestoreGuard
            $advancedMutationAttempted = $true
            Set-DatabaseInsightsPosture -Region $Region -DbInstanceIdentifier $DbInstanceIdentifier `
                -DatabaseInsightsMode "advanced" -RetentionDays $script:DatabaseInsightsAdvancedRetentionDays
            $advanced = Wait-DatabaseInsightsPosture -Region $Region -DbInstanceIdentifier $DbInstanceIdentifier `
                -ExpectedClass $ExpectedRdsInstanceClass -ExpectedMode "advanced" `
                -ExpectedRetention $script:DatabaseInsightsAdvancedRetentionDays `
                -IdentityPosture $initial -PollSeconds $PollSeconds -TimeoutSeconds $TimeoutSeconds
            [void](Assert-DatabaseInsightsDurableRestoreInfrastructure $durableRestoreGuard)
            $revalidatedSchedule = Get-DatabaseInsightsDurableRestoreSchedule $durableRestoreGuard
            [void](Assert-DatabaseInsightsDurableRestoreSchedule $revalidatedSchedule $durableRestoreGuard "ENABLED")
            Write-DatabaseInsightsLeaseStatus $statusPath $receiptSha "active" $advanced
            $watchdog = Start-DatabaseInsightsLeaseWatchdog $resolvedReceipt $receiptSha $receipt $Region `
                $ExpectedAccountId $ExpectedRdsInstanceClass $LeasePurpose $PollSeconds $TimeoutSeconds
            return [ordered]@{
                receiptPathSha256=Get-DatabaseInsightsTextSha256 $resolvedReceipt
                receiptSha256=$receiptSha
                statusPathSha256=Get-DatabaseInsightsTextSha256 $statusPath
                watchdogPathSha256=Get-DatabaseInsightsTextSha256 $watchdogPath
                watchdogHeartbeatSha256=$watchdog.heartbeatSha256
                watchdogState=$watchdog.state
                durableRestoreGuardVersion=$script:DatabaseInsightsDurableRestoreGuardVersion
                durableRestoreGuardBindingSha256=[string]$durableRestoreGuard.bindingSha256
                durableRestoreScheduleArnSha256=[string]$durableGuard.scheduleArnSha256
                durableRestoreTargetRoleArnSha256=[string]$durableGuard.targetRoleArnSha256
                durableRestoreDeadLetterQueueArnSha256=[string]$durableGuard.deadLetterQueueArnSha256
                durableRestoreAutomationDefinitionArnSha256=[string]$durableGuard.automationDefinitionArnSha256
                durableRestoreAutomationRoleArnSha256=[string]$durableGuard.automationRoleArnSha256
                durableRestoreAutomationFailureRuleArnSha256=[string]$durableGuard.automationFailureRuleArnSha256
                durableRestoreAutomationDocumentVersion=[string]$durableRestoreGuard.automationDocumentVersion
                durableRestoreAutomationDocumentContentSha256=[string]$durableRestoreGuard.automationDocumentContentSha256
                durableRestoreGuardState=[string]$durableGuard.state
                state="active"
                expiresAtUtc=$receipt.expiresAtUtc
                rawPathsPersisted=$false
            }
        }
        catch {
            $acquireFailure = $_.Exception.Message
            if (-not $advancedMutationAttempted) {
                try {
                    $candidate = Get-DatabaseInsightsDurableRestoreSchedule $durableRestoreGuard
                    if ($null -ne $candidate) {
                        [void](Assert-DatabaseInsightsDurableRestoreSchedule $candidate $durableRestoreGuard)
                        [void](Remove-DatabaseInsightsDurableRestoreSchedule $durableRestoreGuard)
                    }
                }
                catch {
                    Write-DatabaseInsightsLeaseStatus $statusPath $receiptSha "acquire_failed_unmutated" $initial `
                        "durable_guard_cleanup" $_.Exception.Message
                    throw "Database Insights lease acquisition failed before RDS mutation and the durable guard could not be safely removed; progression is blocked."
                }
                Write-DatabaseInsightsLeaseStatus $statusPath $receiptSha "acquire_failed_unmutated" $initial `
                    "durable_guard" $acquireFailure
                throw "Database Insights lease acquisition failed before RDS mutation; the captured Standard/7 posture was not changed."
            }
            try {
                [void](Restore-DatabaseInsightsLease $receipt $receiptSha $resolvedReceipt $statusPath $Region $DbInstanceIdentifier $ExpectedRdsInstanceClass $PollSeconds $TimeoutSeconds)
            }
            catch { throw "Database Insights lease acquisition failed and exact restoration also failed; progression is blocked." }
            Write-DatabaseInsightsLeaseStatus $statusPath $receiptSha "acquire_failed_restored" $initial "acquire" $acquireFailure
            throw "Database Insights lease acquisition failed; the captured Standard/7 posture was restored."
        }
    }

    if ([string]::IsNullOrWhiteSpace($ExpectedReceiptSha256)) {
        throw "ExpectedReceiptSha256 is required for Validate and Restore."
    }
    $receipt = Read-DatabaseInsightsLeaseReceipt $resolvedReceipt $ExpectedReceiptSha256
    $lifetime = Assert-DatabaseInsightsReceiptBinding $receipt $Region $ExpectedAccountId $DbInstanceIdentifier $ExpectedRdsInstanceClass $LeasePurpose
    if ($Mode -eq "Restore") {
        $restored = Restore-DatabaseInsightsLease $receipt $ExpectedReceiptSha256 $resolvedReceipt $statusPath $Region $DbInstanceIdentifier $ExpectedRdsInstanceClass $PollSeconds $TimeoutSeconds
        return [ordered]@{
            receiptPathSha256=Get-DatabaseInsightsTextSha256 $resolvedReceipt
            receiptSha256=$ExpectedReceiptSha256
            statusPathSha256=Get-DatabaseInsightsTextSha256 $statusPath
            watchdogPathSha256=Get-DatabaseInsightsTextSha256 $watchdogPath
            durableRestoreGuardVersion=$script:DatabaseInsightsDurableRestoreGuardVersion
            durableRestoreGuardBindingSha256=[string]$receipt.durableRestoreGuard.bindingSha256
            durableRestoreGuardState="removed"
            state="restored"
            posture=$restored
            rawPathsPersisted=$false
        }
    }
    if ([DateTimeOffset]::UtcNow -gt $lifetime.expiresAtUtc) {
        throw "The bounded Database Insights monitoring lease expired; restore it before continuing."
    }
    $watchdogHeartbeat = Read-DatabaseInsightsWatchdogHeartbeat $watchdogPath $receipt $ExpectedReceiptSha256 -RequireFresh
    [void](Assert-DatabaseInsightsDurableRestoreInfrastructure $receipt.durableRestoreGuard)
    $durableSchedule = Get-DatabaseInsightsDurableRestoreSchedule $receipt.durableRestoreGuard
    $durableGuard = Assert-DatabaseInsightsDurableRestoreSchedule $durableSchedule $receipt.durableRestoreGuard
    $active = Get-DatabaseInsightsPosture -Region $Region -DbInstanceIdentifier $DbInstanceIdentifier
    [void](Assert-DatabaseInsightsPosture $active $DbInstanceIdentifier $ExpectedRdsInstanceClass "advanced" $script:DatabaseInsightsAdvancedRetentionDays $receipt.initialPosture)
    return [ordered]@{
        receiptPathSha256=Get-DatabaseInsightsTextSha256 $resolvedReceipt
        receiptSha256=$ExpectedReceiptSha256
        statusPathSha256=Get-DatabaseInsightsTextSha256 $statusPath
        watchdogPathSha256=Get-DatabaseInsightsTextSha256 $watchdogPath
        watchdogHeartbeatSha256=Get-DatabaseInsightsFileSha256 $watchdogPath
        watchdogState=[string]$watchdogHeartbeat.state
        durableRestoreGuardVersion=$script:DatabaseInsightsDurableRestoreGuardVersion
        durableRestoreGuardBindingSha256=[string]$receipt.durableRestoreGuard.bindingSha256
        durableRestoreScheduleArnSha256=[string]$durableGuard.scheduleArnSha256
        durableRestoreTargetRoleArnSha256=[string]$durableGuard.targetRoleArnSha256
        durableRestoreDeadLetterQueueArnSha256=[string]$durableGuard.deadLetterQueueArnSha256
        durableRestoreAutomationDefinitionArnSha256=[string]$durableGuard.automationDefinitionArnSha256
        durableRestoreAutomationRoleArnSha256=[string]$durableGuard.automationRoleArnSha256
        durableRestoreAutomationFailureRuleArnSha256=[string]$durableGuard.automationFailureRuleArnSha256
        durableRestoreAutomationDocumentVersion=[string]$receipt.durableRestoreGuard.automationDocumentVersion
        durableRestoreAutomationDocumentContentSha256=[string]$receipt.durableRestoreGuard.automationDocumentContentSha256
        durableRestoreGuardState=[string]$durableGuard.state
        state="active_validated"
        expiresAtUtc=$receipt.expiresAtUtc
        rawPathsPersisted=$false
    }
}

$result = Invoke-DatabaseInsightsLease `
    -Mode $Mode `
    -DbInstanceIdentifier $DbInstanceIdentifier `
    -ReceiptPath $ReceiptPath `
    -ExpectedReceiptSha256 $ExpectedReceiptSha256 `
    -Region $Region `
    -ExpectedAccountId $ExpectedAccountId `
    -ExpectedRdsInstanceClass $ExpectedRdsInstanceClass `
    -LeasePurpose $LeasePurpose `
    -MaximumLeaseMinutes $MaximumLeaseMinutes `
    -PollSeconds $PollSeconds `
    -TimeoutSeconds $TimeoutSeconds

if ($Mode -ne "Watchdog") {
    $result | ConvertTo-Json -Depth 20
}
