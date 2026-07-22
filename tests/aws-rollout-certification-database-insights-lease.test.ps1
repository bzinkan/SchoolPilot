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
    "Get-CertificationTextSha256", "ConvertTo-CertificationComparableJson", "Assert-CertificationSha256", "Assert-CertificationEvidenceReference",
    "Assert-CertificationPrivateFileAcl", "ConvertTo-CertificationUtcTimestamp", "Get-CertificationDatabaseInsightsLease",
    "Assert-CertificationDatabaseInsightsLeaseCommandResult"
)) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing supervisor function $name." }
    Invoke-Expression $definition.Extent.Text
}

$script:RequiredDatabaseInsightsLeaseVersion = "database-insights-monitoring-lease-v2"
$script:RequiredDatabaseInsightsDurableRestoreGuardVersion = "aws-scheduler-ssm-recurring-restore-v1"
$script:RequiredDatabaseInsightsDurableRestoreAutomationVersion = "ssm-rds-monitoring-restore-v1"
$databaseResourceId = "db-JX7VX4P2ZHF5JXA6N5EREVL54I"
$leaseId = "0123456789abcdef0123456789abcdef"
$historyIdentity = [ordered]@{DatabaseResourceId=$databaseResourceId;EngineVersion="16.4"}

function Set-TestPrivateAcl {
    param([string]$Path)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $discarded = & icacls.exe $Path /inheritance:r /grant:r "$identity`:(F)" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not apply test ACL." }
}

function Write-TestLeaseReceipt {
    param([string]$Path)
    $preservedMonitoringPosture = [ordered]@{
        performanceInsightsKmsKeyId="arn:aws:kms:us-east-1:135775632425:key/00000000-0000-0000-0000-000000000001"
        monitoringInterval=60
        monitoringRoleArn="arn:aws:iam::135775632425:role/rds-monitoring-role"
        enabledCloudwatchLogsExports=@("postgresql","upgrade")
    }
    $preservedMonitoringPostureSha256 = Get-CertificationTextSha256 `
        ($preservedMonitoringPosture | ConvertTo-Json -Depth 10 -Compress)
    $expirationRawTicks = [DateTimeOffset]::UtcNow.AddHours(6).UtcDateTime.Ticks
    $expiration = [DateTimeOffset]::new([DateTime]::new(
        $expirationRawTicks - ($expirationRawTicks % [TimeSpan]::TicksPerSecond), [DateTimeKind]::Utc
    ))
    $databaseIdentitySha256 = Get-CertificationTextSha256 "135775632425|us-east-1|schoolpilot-production-db"
    $scheduleName = "db-insights-restore-$($databaseIdentitySha256.Substring(0, 24))"
    $leaseIdSha256 = Get-CertificationTextSha256 $leaseId
    $descriptionBindingSha256 = Get-CertificationTextSha256 `
        "135775632425|us-east-1|schoolpilot-production-db|$($expiration.ToString('o'))|$leaseIdSha256"
    $automationDocumentContentSha256 = "b" * 64
    $automationDocumentName = "schoolpilot-production-db-insights-restore-v1"
    $automationDocumentVersion = "1"
    $automationRoleArn = "arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore-automation"
    $targetInput = [ordered]@{
        DocumentName = $automationDocumentName
        DocumentVersion = $automationDocumentVersion
        Parameters = [ordered]@{
            AutomationAssumeRole = @($automationRoleArn)
            DBInstanceIdentifier = @("schoolpilot-production-db")
            ExpectedDBInstanceArn = @("arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db")
            ExpectedDatabaseResourceId = @($databaseResourceId)
            ExpectedDBInstanceClass = @("db.t4g.medium")
            ExpectedEngineVersion = @("16.4")
            ExpectedPerformanceInsightsKmsKeyId = @($preservedMonitoringPosture.performanceInsightsKmsKeyId)
            ExpectedMonitoringInterval = @("60")
            ExpectedMonitoringRoleArn = @($preservedMonitoringPosture.monitoringRoleArn)
            ExpectedLogExportsJson = @((@($preservedMonitoringPosture.enabledCloudwatchLogsExports) |
                ConvertTo-Json -Compress -AsArray))
            FailureQueueUrl = @("https://sqs.us-east-1.amazonaws.com/135775632425/schoolpilot-production-db-insights-restore-dlq")
            RestoreScheduleName = @($scheduleName)
            RestoreScheduleGroupName = @("schoolpilot-production-db-insights-leases")
            AutomationDocumentContentSha256 = @($automationDocumentContentSha256)
            LeaseIdSha256 = @($leaseIdSha256)
            ExpiresAtUtc = @($expiration.ToString("o"))
            RestoreMode = @("scheduled")
        }
    } | ConvertTo-Json -Depth 20 -Compress
    $durableGuard = [ordered]@{
        version=$script:RequiredDatabaseInsightsDurableRestoreGuardVersion
        accountId="135775632425";region="us-east-1";dbInstanceIdentifier="schoolpilot-production-db"
        dbInstanceArn="arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db"
        expiresAtUtc=$expiration.ToString("o");scheduleName=$scheduleName
        scheduleGroupName="schoolpilot-production-db-insights-leases"
        scheduleArn="arn:aws:scheduler:us-east-1:135775632425:schedule/schoolpilot-production-db-insights-leases/$scheduleName"
        scheduleExpression="rate(15 minutes)";scheduleStartAtUtc=$expiration.ToString("o")
        scheduleExpressionTimezone="UTC";actionAfterCompletion="NONE";state="ENABLED"
        description="SchoolPilot db-insights restore v2 lease=$leaseIdSha256 binding=$descriptionBindingSha256"
        targetArn="arn:aws:scheduler:::aws-sdk:ssm:startAutomationExecution"
        automationVersion=$script:RequiredDatabaseInsightsDurableRestoreAutomationVersion
        automationDocumentName=$automationDocumentName
        automationDocumentVersion=$automationDocumentVersion
        automationDocumentContentSha256=$automationDocumentContentSha256
        automationDefinitionArn="arn:aws:ssm:us-east-1:135775632425:automation-definition/schoolpilot-production-db-insights-restore-v1:1"
        automationRoleArn=$automationRoleArn
        automationFailureRuleArn="arn:aws:events:us-east-1:135775632425:rule/schoolpilot-production-db-insights-restore-failed"
        targetRoleArn="arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore"
        deadLetterQueueArn="arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq"
        targetInput=$targetInput
        maximumEventAgeInSeconds=60;maximumRetryAttempts=0
    }
    $durableGuard["bindingSha256"] = Get-CertificationTextSha256 ($durableGuard | ConvertTo-Json -Depth 20 -Compress)
    $receipt = [ordered]@{
        schemaVersion=2;type="database_insights_monitoring_lease"
        leaseVersion=$script:RequiredDatabaseInsightsLeaseVersion;leaseId=$leaseId;leasePurpose="certification"
        capturedAtUtc=[DateTimeOffset]::UtcNow.AddMinutes(-5).ToString("o")
        expiresAtUtc=$expiration.ToString("o")
        accountId="135775632425";region="us-east-1";dbInstanceIdentifier="schoolpilot-production-db"
        expectedRdsInstanceClass="db.t4g.medium"
        initialPosture=[ordered]@{
            dbInstanceIdentifier="schoolpilot-production-db"
            dbInstanceArn="arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db"
            databaseResourceId=$databaseResourceId;status="available";instanceClass="db.t4g.medium"
            engine="postgres";engineVersion="16.4";databaseInsightsMode="standard"
            performanceInsightsEnabled=$true;performanceInsightsRetentionPeriod=7
            performanceInsightsKmsKeyId=$preservedMonitoringPosture.performanceInsightsKmsKeyId
            monitoringInterval=$preservedMonitoringPosture.monitoringInterval
            monitoringRoleArn=$preservedMonitoringPosture.monitoringRoleArn
            enabledCloudwatchLogsExports=$preservedMonitoringPosture.enabledCloudwatchLogsExports
            pendingModifiedValuesAbsent=$true;parameterApplyStatuses=@("in-sync")
        }
        requestedPosture=[ordered]@{
            databaseInsightsMode="advanced";performanceInsightsEnabled=$true
            performanceInsightsRetentionPeriod=465
            preservedMonitoringPostureSha256=$preservedMonitoringPostureSha256
        }
        durableRestoreGuard=$durableGuard
    }
    [IO.File]::WriteAllText($Path, ($receipt | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    Set-TestPrivateAcl $Path
}

function Save-TestLeaseReceipt {
    param([string]$Path, $Receipt)
    [IO.File]::WriteAllText($Path, ($Receipt | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    Set-TestPrivateAcl $Path
}

function Get-TestConfig {
    param([string]$Path, [string]$Sha256)
    return [pscustomobject]@{
        deadlineUtc=[DateTimeOffset]::UtcNow.AddHours(2).ToString("o")
        databaseInsightsLease=[pscustomobject]@{
            version=$script:RequiredDatabaseInsightsLeaseVersion
            receiptPath=$Path
            receiptSha256=$Sha256
        }
    }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-cert-dbi-lease-$([Guid]::NewGuid().ToString('N'))"
[void][IO.Directory]::CreateDirectory($tempRoot)
$assertions = 0
try {
    $receiptPath = Join-Path $tempRoot "certification-lease.json"
    Write-TestLeaseReceipt $receiptPath
    $config = Get-TestConfig $receiptPath (Get-CertificationSha256 $receiptPath)
    $leaseBundle = Get-CertificationDatabaseInsightsLease $config $historyIdentity "db.t4g.medium"
    $binding = $leaseBundle.Public
    Assert-Condition ($binding.version -eq $script:RequiredDatabaseInsightsLeaseVersion -and
        $binding.leasePurpose -eq "certification" -and
        $binding.databaseResourceIdSha256 -eq (Get-CertificationTextSha256 $databaseResourceId) -and
        $binding.initialPosture.performanceInsightsRetentionPeriod -eq 7 -and
        $binding.requestedPosture.performanceInsightsRetentionPeriod -eq 465 -and
        $binding.durableRestoreGuard.version -eq $script:RequiredDatabaseInsightsDurableRestoreGuardVersion -and
        $binding.durableRestoreGuard.bindingSha256 -match '^[0-9a-f]{64}$') `
        "Certification must bind the exact Standard/7 to Advanced/465 lease."
    $assertions++
    $bindingJson = $binding | ConvertTo-Json -Depth 30 -Compress
    Assert-Condition (-not $bindingJson.Contains($leaseId) -and -not $bindingJson.Contains($databaseResourceId) -and
        -not $bindingJson.Contains($receiptPath) -and
        -not $bindingJson.Contains("arn:aws:kms") -and -not $bindingJson.Contains("rds-monitoring-role") -and
        $binding.leaseIdSha256 -eq (Get-CertificationTextSha256 $leaseId)) `
        "Sealed certification evidence must expose only lease, path, database, KMS, and role identity hashes."
    $assertions++

    $commandContract = [pscustomobject]@{
        DatabaseInsightsLease = $binding
        DatabaseInsightsLeaseReceipt = $leaseBundle.Receipt
        HistoryFallbackQueryIdentity = [ordered]@{engineVersion="16.4"}
    }
    $statusPath = "$receiptPath.status.json"
    $validated = Assert-CertificationDatabaseInsightsLeaseCommandResult ([pscustomobject]@{
        receiptPathSha256=Get-CertificationTextSha256 $receiptPath
        receiptSha256=$binding.receipt.sha256
        statusPathSha256=Get-CertificationTextSha256 $statusPath
        watchdogPathSha256=Get-CertificationTextSha256 "$receiptPath.watchdog.json"
        watchdogHeartbeatSha256="a"*64;watchdogState="monitoring"
        durableRestoreGuardVersion=$binding.durableRestoreGuard.version
        durableRestoreGuardBindingSha256=$binding.durableRestoreGuard.bindingSha256
        durableRestoreScheduleArnSha256=$binding.durableRestoreGuard.scheduleArnSha256
        durableRestoreTargetRoleArnSha256=$binding.durableRestoreGuard.targetRoleArnSha256
        durableRestoreDeadLetterQueueArnSha256=$binding.durableRestoreGuard.deadLetterQueueArnSha256
        durableRestoreAutomationDefinitionArnSha256=$binding.durableRestoreGuard.automationDefinitionArnSha256
        durableRestoreAutomationRoleArnSha256=$binding.durableRestoreGuard.automationRoleArnSha256
        durableRestoreAutomationFailureRuleArnSha256=$binding.durableRestoreGuard.automationFailureRuleArnSha256
        durableRestoreAutomationDocumentVersion=$binding.durableRestoreGuard.automationDocumentVersion
        durableRestoreAutomationDocumentContentSha256=$binding.durableRestoreGuard.automationDocumentContentSha256
        durableRestoreGuardState="armed"
        rawPathsPersisted=$false;state="active_validated"
    }) $commandContract Validate
    Assert-Condition ($validated.state -eq "active_validated" -and $validated.nonMutating -eq $true) `
        "Certification lease validation must be represented as a non-mutating observation."
    $assertions++
    $wrongDurableResultRejected = $false
    try {
        Assert-CertificationDatabaseInsightsLeaseCommandResult ([pscustomobject]@{
            receiptPathSha256=Get-CertificationTextSha256 $receiptPath;receiptSha256=$binding.receipt.sha256
            statusPathSha256=Get-CertificationTextSha256 $statusPath
            watchdogPathSha256=Get-CertificationTextSha256 "$receiptPath.watchdog.json"
            watchdogHeartbeatSha256="a"*64;watchdogState="monitoring";rawPathsPersisted=$false
            state="active_validated";durableRestoreGuardVersion=$binding.durableRestoreGuard.version
            durableRestoreGuardBindingSha256=$binding.durableRestoreGuard.bindingSha256
            durableRestoreScheduleArnSha256="f"*64
            durableRestoreTargetRoleArnSha256=$binding.durableRestoreGuard.targetRoleArnSha256
            durableRestoreDeadLetterQueueArnSha256=$binding.durableRestoreGuard.deadLetterQueueArnSha256
            durableRestoreAutomationDefinitionArnSha256=$binding.durableRestoreGuard.automationDefinitionArnSha256
            durableRestoreAutomationRoleArnSha256=$binding.durableRestoreGuard.automationRoleArnSha256
            durableRestoreAutomationFailureRuleArnSha256=$binding.durableRestoreGuard.automationFailureRuleArnSha256
            durableRestoreAutomationDocumentVersion=$binding.durableRestoreGuard.automationDocumentVersion
            durableRestoreAutomationDocumentContentSha256=$binding.durableRestoreGuard.automationDocumentContentSha256
            durableRestoreGuardState="armed"
        }) $commandContract Validate | Out-Null
    }
    catch { $wrongDurableResultRejected = $_.Exception.Message -match "exact AWS-native restore schedule" }
    Assert-Condition $wrongDurableResultRejected `
        "Certification must reject helper evidence for a different durable schedule identity."
    $assertions++

    $restoredPosture = [ordered]@{
        dbInstanceIdentifier="schoolpilot-production-db";databaseResourceId=$databaseResourceId
        status="available";instanceClass="db.t4g.medium";engine="postgres";engineVersion="16.4"
        databaseInsightsMode="standard";performanceInsightsEnabled=$true
        performanceInsightsRetentionPeriod=7;pendingModifiedValuesAbsent=$true
        performanceInsightsKmsKeyId="arn:aws:kms:us-east-1:135775632425:key/00000000-0000-0000-0000-000000000001"
        monitoringInterval=60;monitoringRoleArn="arn:aws:iam::135775632425:role/rds-monitoring-role"
        enabledCloudwatchLogsExports=@("postgresql","upgrade")
        parameterApplyStatuses=@("in-sync")
    }
    $restored = Assert-CertificationDatabaseInsightsLeaseCommandResult ([pscustomobject]@{
        receiptPathSha256=Get-CertificationTextSha256 $receiptPath
        receiptSha256=$binding.receipt.sha256
        statusPathSha256=Get-CertificationTextSha256 $statusPath
        watchdogPathSha256=Get-CertificationTextSha256 "$receiptPath.watchdog.json"
        durableRestoreGuardVersion=$binding.durableRestoreGuard.version
        durableRestoreGuardBindingSha256=$binding.durableRestoreGuard.bindingSha256
        durableRestoreGuardState="removed"
        rawPathsPersisted=$false;state="restored";posture=$restoredPosture
    }) $commandContract Restore
    $restoredJson = $restored | ConvertTo-Json -Depth 30 -Compress
    Assert-Condition ($restored.state -eq "restored" -and
        $restored.observedPosture.performanceInsightsRetentionPeriod -eq 7 -and
        $restored.observedPosture.databaseResourceIdSha256 -eq (Get-CertificationTextSha256 $databaseResourceId) -and
        -not $restoredJson.Contains($databaseResourceId)) `
        "Restoration evidence must prove exact Standard/7 while redacting the native database ID."
    $assertions++

    foreach ($invalidRestore in @(
        [ordered]@{Name="advanced";Property="databaseInsightsMode";Value="advanced"},
        [ordered]@{Name="retention";Property="performanceInsightsRetentionPeriod";Value=465},
        [ordered]@{Name="resource";Property="databaseResourceId";Value="db-AAAAAAAAAAAAAAAAAAAA"},
        [ordered]@{Name="PI KMS key";Property="performanceInsightsKmsKeyId";Value="arn:aws:kms:us-east-1:135775632425:key/ffffffff-ffff-ffff-ffff-ffffffffffff"},
        [ordered]@{Name="Enhanced Monitoring role";Property="monitoringRoleArn";Value="arn:aws:iam::135775632425:role/unexpected-role"},
        [ordered]@{Name="log exports";Property="enabledCloudwatchLogsExports";Value=@("postgresql")},
        [ordered]@{Name="pending";Property="pendingModifiedValuesAbsent";Value=$false}
    )) {
        $candidate = [ordered]@{}
        foreach ($key in $restoredPosture.Keys) { $candidate[$key] = $restoredPosture[$key] }
        $candidate[$invalidRestore.Property] = $invalidRestore.Value
        $rejected = $false
        try {
            Assert-CertificationDatabaseInsightsLeaseCommandResult ([pscustomobject]@{
                receiptPathSha256=Get-CertificationTextSha256 $receiptPath
                receiptSha256=$binding.receipt.sha256
                statusPathSha256=Get-CertificationTextSha256 $statusPath
                watchdogPathSha256=Get-CertificationTextSha256 "$receiptPath.watchdog.json"
                durableRestoreGuardVersion=$binding.durableRestoreGuard.version
                durableRestoreGuardBindingSha256=$binding.durableRestoreGuard.bindingSha256
                durableRestoreGuardState="removed"
                rawPathsPersisted=$false;state="restored";posture=$candidate
            }) $commandContract Restore | Out-Null
        }
        catch { $rejected = $_.Exception.Message -match "exact healthy Standard/7" }
        Assert-Condition $rejected "Restoration must reject an invalid $($invalidRestore.Name) posture."
        $assertions++
    }

    $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json -Depth 30
    $receipt.leasePurpose = "diagnostic"
    Save-TestLeaseReceipt $receiptPath $receipt
    $wrongPurposeRejected = $false
    try { Get-CertificationDatabaseInsightsLease (Get-TestConfig $receiptPath (Get-CertificationSha256 $receiptPath)) $historyIdentity "db.t4g.medium" | Out-Null }
    catch { $wrongPurposeRejected = $_.Exception.Message -match "certification-purpose" }
    Assert-Condition $wrongPurposeRejected "A diagnostic lease must not seed certification."
    $assertions++

    Write-TestLeaseReceipt $receiptPath
    $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json -Depth 30
    $receipt.PSObject.Properties.Remove("durableRestoreGuard")
    Save-TestLeaseReceipt $receiptPath $receipt
    $missingDurableGuardRejected = $false
    try { Get-CertificationDatabaseInsightsLease (Get-TestConfig $receiptPath (Get-CertificationSha256 $receiptPath)) $historyIdentity "db.t4g.medium" | Out-Null }
    catch { $missingDurableGuardRejected = $_.Exception.Message -match "certification-purpose" }
    Assert-Condition $missingDurableGuardRejected `
        "Historical monitoring-lease receipts without the AWS-native restore guard must not seed certification."
    $assertions++

    Write-TestLeaseReceipt $receiptPath
    $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json -Depth 30
    $receipt.durableRestoreGuard.targetRoleArn = "arn:aws:iam::135775632425:role/unexpected-restore-role"
    Save-TestLeaseReceipt $receiptPath $receipt
    $durableGuardTamperRejected = $false
    try { Get-CertificationDatabaseInsightsLease (Get-TestConfig $receiptPath (Get-CertificationSha256 $receiptPath)) $historyIdentity "db.t4g.medium" | Out-Null }
    catch { $durableGuardTamperRejected = $_.Exception.Message -match "certification-purpose" }
    Assert-Condition $durableGuardTamperRejected `
        "Certification must independently reject a receipt whose durable restore target binding drifted."
    $assertions++

    Write-TestLeaseReceipt $receiptPath
    $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json -Depth 30
    $receipt.initialPosture.databaseResourceId = "db-AAAAAAAAAAAAAAAAAAAA"
    Save-TestLeaseReceipt $receiptPath $receipt
    $wrongResourceRejected = $false
    try { Get-CertificationDatabaseInsightsLease (Get-TestConfig $receiptPath (Get-CertificationSha256 $receiptPath)) $historyIdentity "db.t4g.medium" | Out-Null }
    catch { $wrongResourceRejected = $_.Exception.Message -match "certification-purpose" }
    Assert-Condition $wrongResourceRejected "The lease must bind the same native RDS resource as the query identity."
    $assertions++

    Write-TestLeaseReceipt $receiptPath
    $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json -Depth 30
    $receipt.initialPosture.performanceInsightsRetentionPeriod = 14
    Save-TestLeaseReceipt $receiptPath $receipt
    $wrongInitialRetentionRejected = $false
    try { Get-CertificationDatabaseInsightsLease (Get-TestConfig $receiptPath (Get-CertificationSha256 $receiptPath)) $historyIdentity "db.t4g.medium" | Out-Null }
    catch { $wrongInitialRetentionRejected = $_.Exception.Message -match "Standard/7" }
    Assert-Condition $wrongInitialRetentionRejected "The lease must restore the exact original seven-day retention."
    $assertions++

    Write-TestLeaseReceipt $receiptPath
    $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json -Depth 30
    $receipt.requestedPosture.performanceInsightsRetentionPeriod = 7
    Save-TestLeaseReceipt $receiptPath $receipt
    $wrongAdvancedRetentionRejected = $false
    try { Get-CertificationDatabaseInsightsLease (Get-TestConfig $receiptPath (Get-CertificationSha256 $receiptPath)) $historyIdentity "db.t4g.medium" | Out-Null }
    catch { $wrongAdvancedRetentionRejected = $_.Exception.Message -match "Advanced/465" }
    Assert-Condition $wrongAdvancedRetentionRejected "The evidence lease must use Advanced mode with 465-day retention."
    $assertions++

    Write-TestLeaseReceipt $receiptPath
    $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json -Depth 30
    $receipt.expiresAtUtc = [DateTimeOffset]::UtcNow.AddMinutes(30).ToString("o")
    Save-TestLeaseReceipt $receiptPath $receipt
    $shortLeaseRejected = $false
    try { Get-CertificationDatabaseInsightsLease (Get-TestConfig $receiptPath (Get-CertificationSha256 $receiptPath)) $historyIdentity "db.t4g.medium" | Out-Null }
    catch { $shortLeaseRejected = $_.Exception.Message -match "stage deadline" }
    Assert-Condition $shortLeaseRejected "A lease that expires before stage finalization must fail closed."
    $assertions++

    Write-TestLeaseReceipt $receiptPath
    $recordedHash = Get-CertificationSha256 $receiptPath
    [IO.File]::AppendAllText($receiptPath, " ")
    $tamperRejected = $false
    try { Get-CertificationDatabaseInsightsLease (Get-TestConfig $receiptPath $recordedHash) $historyIdentity "db.t4g.medium" | Out-Null }
    catch { $tamperRejected = $_.Exception.Message -match "changed after its hash" }
    Assert-Condition $tamperRejected "Lease receipt tampering after hash capture must be rejected."
    $assertions++

    Write-TestLeaseReceipt $receiptPath
    $historicalVersionRejected = $false
    $oldConfig = Get-TestConfig $receiptPath (Get-CertificationSha256 $receiptPath)
    $oldConfig.databaseInsightsLease.version = "database-insights-monitoring-lease-v1"
    try { Get-CertificationDatabaseInsightsLease $oldConfig $historyIdentity "db.t4g.medium" | Out-Null }
    catch { $historicalVersionRejected = $_.Exception.Message -match "reviewed Database Insights" }
    Assert-Condition $historicalVersionRejected "Historical lease schemas must not enter a fresh certification chain."
    $assertions++
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

Write-Host "AWS rollout certification Database Insights lease tests passed ($assertions assertions)."
