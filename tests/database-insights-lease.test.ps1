#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$leaseScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\database-insights-lease.ps1"))
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($leaseScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Unable to parse the Database Insights lease helper." }
$functionNames = @(
    "Get-DatabaseInsightsValue", "Get-DatabaseInsightsTextSha256", "Get-DatabaseInsightsFileSha256",
    "Assert-DatabaseInsightsSha256", "Resolve-DatabaseInsightsReceiptPath", "Set-DatabaseInsightsPrivateAcl", "Assert-DatabaseInsightsPrivateAcl",
    "Write-DatabaseInsightsPrivateJson", "Test-DatabaseInsightsEmptyObject", "Get-DatabaseInsightsCallerAccount",
    "Get-DatabaseInsightsPosture", "Assert-DatabaseInsightsPosture", "Set-DatabaseInsightsPosture",
    "Test-DatabaseInsightsIntegerValue", "Get-DatabaseInsightsPreservedMonitoringPosture", "Get-DatabaseInsightsPreservedMonitoringPostureJson",
    "Assert-DatabaseInsightsPreservedMonitoringPostureEnvelope",
    "Get-DatabaseInsightsPreservedMonitoringPostureSha256",
    "Assert-DatabaseInsightsPreservedMonitoringPosture", "Assert-DatabaseInsightsLeaseIdentity",
    "Wait-DatabaseInsightsPosture", "Get-DatabaseInsightsDurableRestoreGuardBinding",
    "Get-DatabaseInsightsDurableRestoreGuardBindingSha256",
    "Get-DatabaseInsightsObjectPropertyNames", "Test-DatabaseInsightsExactStrings",
    "Get-DatabaseInsightsNormalizedScriptSha256",
    "Assert-DatabaseInsightsDurableRestoreInfrastructure",
    "Get-DatabaseInsightsDurableRestoreSchedule", "Get-DatabaseInsightsActiveRestoreAutomations",
    "Read-DatabaseInsightsBoundRestoreTargetInput",
    "Wait-DatabaseInsightsRestoreAutomationsQuiescent", "Start-DatabaseInsightsBoundRestoreAutomation",
    "Wait-DatabaseInsightsBoundRestoreAutomation", "Assert-DatabaseInsightsDurableRestoreSchedule",
    "New-DatabaseInsightsDurableRestoreSchedule", "Disable-DatabaseInsightsDurableRestoreSchedule",
    "Remove-DatabaseInsightsDurableRestoreSchedule",
    "Read-DatabaseInsightsLeaseReceipt", "Write-DatabaseInsightsLeaseStatus",
    "Read-DatabaseInsightsLeaseStatus", "Get-DatabaseInsightsWatchdogPath", "Get-DatabaseInsightsReceiptExpirationText",
    "Get-DatabaseInsightsTimestampText",
    "Write-DatabaseInsightsWatchdogHeartbeat", "Read-DatabaseInsightsWatchdogHeartbeat",
    "Get-DatabaseInsightsLeaseMutexName", "Invoke-WithDatabaseInsightsLeaseMutex",
    "Start-DatabaseInsightsLeaseWatchdog", "Assert-DatabaseInsightsReceiptBinding",
    "Restore-DatabaseInsightsLease", "Invoke-DatabaseInsightsLeaseWatchdog", "Invoke-DatabaseInsightsLease"
)
foreach ($name in $functionNames) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing lease helper function $name." }
    Invoke-Expression $definition.Extent.Text
}

$script:DatabaseInsightsLeaseVersion = "database-insights-monitoring-lease-v3"
$script:DatabaseInsightsAdvancedRetentionDays = 465
$script:DatabaseInsightsStandardRetentionDays = 7
$script:DatabaseInsightsWatchdogHeartbeatStaleSeconds = 90
$script:DatabaseInsightsWatchdogPollSeconds = 30
$script:DatabaseInsightsDurableRestoreGuardVersion = "aws-scheduler-ssm-recurring-restore-v2"
$script:DatabaseInsightsDurableRestoreAutomationVersion = "ssm-rds-monitoring-restore-v2"
$script:DatabaseInsightsPreservedMonitoringPostureEncodingVersion = "rds-preserved-monitoring-posture-json-v1"
$script:DatabaseInsightsSupportedCloudWatchLogExports = @("iam-db-auth-error", "postgresql", "upgrade")
$script:DatabaseInsightsDurableRestoreTargetArn = "arn:aws:scheduler:::aws-sdk:ssm:startAutomationExecution"
$script:DatabaseInsightsDurableRestoreMaximumEventAgeSeconds = 60
$script:DatabaseInsightsDurableRestoreMaximumRetryAttempts = 0
$script:DatabaseInsightsDurableRestoreCadenceMinutes = 15
$script:DatabaseInsightsDurableRestoreDocumentVersion = "1"
$script:DatabaseInsightsDurableRestoreFailureRetentionSeconds = 1209600
$script:DatabaseInsightsRepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$script:MockMode = "standard"
$script:MockRetention = 7
$script:MockClass = "db.t4g.medium"
$script:MockAccount = "135775632425"
$script:MockStatus = "available"
$script:MockPending = $false
$script:MockParameterStatus = "in-sync"
$script:MockPerformanceInsightsKmsKeyId = "arn:aws:kms:us-east-1:135775632425:key/00000000-0000-0000-0000-000000000001"
$script:MockMonitoringInterval = 0
$script:MockMonitoringRoleArn = ""
$script:MockLogExports = @()
$script:FailAdvanced = $false
$script:FailRestore = $false
$script:FailScheduleCreate = $false
$script:FailRestoreInfrastructure = $false
$script:FailRestoreQueueEncryption = $false
$script:FailRestoreQueueRetention = $false
$script:FailRestoreQueuePolicyExtra = $false
$script:FailRestoreAlarm = $false
$script:FailRestoreEventPatternExtra = $false
$script:FailRestoreEventTargetExtra = $false
$script:FailRestoreQueueTlsPrincipal = $false
$script:FailRestorePermissionsBoundary = $false
$script:FailRestoreIamStatementExtra = $false
$script:FailRestoreAlarmUnit = $false
$script:FailRestoreDocument = $false
$script:FailAutomationAfterMutation = $false
$script:MockAutomationExecutions = @()
$script:MockAutomationExecutionPages = $null
$script:AutomationDescribeCalls = [Collections.Generic.List[string]]::new()
$script:SleepCalls = [Collections.Generic.List[int]]::new()
$script:ModifyCalls = [Collections.Generic.List[string]]::new()
$script:OperationCalls = [Collections.Generic.List[string]]::new()
$script:MockSchedule = $null
$script:MockBoundExecution = $null

function Start-Sleep {
    param([int]$Seconds)
    $script:SleepCalls.Add($Seconds)
}

function Get-TestRestoreAutomationDocument {
    $restoreScript = [IO.File]::ReadAllText((Join-Path $script:DatabaseInsightsRepositoryRoot `
        "infra/modules/database-insights-lease-watchdog/restore_exact_monitoring_posture.py"))
    if ($script:FailRestoreDocument) { $restoreScript = $restoreScript.Replace("+ 480", "+ 479") }
    return [ordered]@{
        schemaVersion="0.3"
        description="Durably restore and verify the exact SchoolPilot production Database Insights Standard/7 posture."
        assumeRole="{{ AutomationAssumeRole }}"
        parameters=[ordered]@{
            AutomationAssumeRole=[ordered]@{type="String"}
            DBInstanceIdentifier=[ordered]@{type="String";allowedValues=@("schoolpilot-production-db")}
            ExpectedDBInstanceArn=[ordered]@{type="String";allowedValues=@("arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db")}
            ExpectedDatabaseResourceId=[ordered]@{type="String"}
            ExpectedDBInstanceClass=[ordered]@{type="String";allowedValues=@("db.t4g.medium")}
            ExpectedEngineVersion=[ordered]@{type="String"}
            PreservedMonitoringPostureEncodingVersion=[ordered]@{type="String";allowedValues=@("rds-preserved-monitoring-posture-json-v1")}
            ExpectedPreservedMonitoringPostureJson=[ordered]@{type="String";allowedPattern='^\{.+\}$'}
            ExpectedPreservedMonitoringPostureSha256=[ordered]@{type="String";allowedPattern='^[0-9a-f]{64}$'}
            RestoreScheduleName=[ordered]@{type="String";allowedValues=@("db-insights-restore-e29866227184b29a3b050565")}
            RestoreScheduleGroupName=[ordered]@{type="String";allowedValues=@("schoolpilot-production-db-insights-leases")}
            FailureQueueUrl=[ordered]@{type="String";allowedValues=@("https://sqs.us-east-1.amazonaws.com/135775632425/schoolpilot-production-db-insights-restore-dlq")}
            AutomationDocumentContentSha256=[ordered]@{type="String";allowedPattern='^[0-9a-f]{64}$'}
            LeaseIdSha256=[ordered]@{type="String";allowedPattern='^[0-9a-f]{64}$'}
            ExpiresAtUtc=[ordered]@{type="String"}
            RestoreMode=[ordered]@{type="String";allowedValues=@("scheduled","manual")}
        }
        mainSteps=@(
            [ordered]@{
                name="RestoreExactPosture";action="aws:executeScript";timeoutSeconds=600
                onFailure="step:PublishRestoreFailure";nextStep="FinishRestoreSuccess"
                inputs=[ordered]@{Runtime="python3.11";Handler="handler";Script=$restoreScript;InputPayload=[ordered]@{
                    dbInstanceIdentifier="{{ DBInstanceIdentifier }}"
                    expectedDbInstanceArn="{{ ExpectedDBInstanceArn }}"
                    expectedDatabaseResourceId="{{ ExpectedDatabaseResourceId }}"
                    expectedDbInstanceClass="{{ ExpectedDBInstanceClass }}"
                    expectedEngineVersion="{{ ExpectedEngineVersion }}"
                    preservedMonitoringPostureEncodingVersion="{{ PreservedMonitoringPostureEncodingVersion }}"
                    expectedPreservedMonitoringPostureJson="{{ ExpectedPreservedMonitoringPostureJson }}"
                    expectedPreservedMonitoringPostureSha256="{{ ExpectedPreservedMonitoringPostureSha256 }}"
                    restoreScheduleName="{{ RestoreScheduleName }}"
                    restoreScheduleGroupName="{{ RestoreScheduleGroupName }}"
                    automationContractVersion="ssm-rds-monitoring-restore-v2"
                    automationDocumentName="schoolpilot-production-db-insights-restore-v2"
                    automationDocumentVersion="1"
                    automationDocumentContentSha256="{{ AutomationDocumentContentSha256 }}"
                    leaseIdSha256="{{ LeaseIdSha256 }}";expiresAtUtc="{{ ExpiresAtUtc }}"
                    restoreMode="{{ RestoreMode }}";maximumEventAgeInSeconds=60
                }}
            },
            [ordered]@{
                name="FinishRestoreSuccess";action="aws:executeScript";timeoutSeconds=30;onFailure="Abort";isEnd=$true
                inputs=[ordered]@{Runtime="python3.11";Handler="handler";
                    Script="def handler(events, context):`n    return {'verified': True}`n"}
            },
            [ordered]@{
                name="PublishRestoreFailure";action="aws:executeAwsApi";timeoutSeconds=60;onFailure="Abort"
                nextStep="FailRestoreAutomation"
                inputs=[ordered]@{Service="sqs";Api="SendMessage";QueueUrl="{{ FailureQueueUrl }}";
                    MessageBody="database_insights_restore_automation_failed"}
            },
            [ordered]@{
                name="FailRestoreAutomation";action="aws:executeScript";timeoutSeconds=30;onFailure="Abort";isEnd=$true
                inputs=[ordered]@{Runtime="python3.11";Handler="handler";
                    Script="def handler(events, context):`n    raise RuntimeError('database insights restoration failed')`n"}
            }
        )
    }
}

function Invoke-DatabaseInsightsAwsJson {
    param([string[]]$Arguments)
    $service = $Arguments[0]
    $operation = $Arguments[1]
    if ($service -eq "sts" -and $operation -eq "get-caller-identity") {
        return [pscustomobject]@{Account=$script:MockAccount;Arn="arn:aws:iam::$($script:MockAccount):user/test"}
    }
    if ($service -eq "rds" -and $operation -eq "describe-db-instances") {
        $pending = if ($script:MockPending) { [pscustomobject]@{DBInstanceClass="db.t4g.large"} } else { [pscustomobject]@{} }
        return [pscustomobject]@{DBInstances=@([pscustomobject]@{
            DBInstanceIdentifier="schoolpilot-production-db"
            DBInstanceArn="arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db"
            DbiResourceId="db-JX7VX4P2ZHF5JXA6N5EREVL54I"
            DBInstanceStatus=$script:MockStatus
            DBInstanceClass=$script:MockClass
            Engine="postgres"
            EngineVersion="16.4"
            DatabaseInsightsMode=$script:MockMode
            PerformanceInsightsEnabled=$true
            PerformanceInsightsRetentionPeriod=$script:MockRetention
            PerformanceInsightsKMSKeyId=$script:MockPerformanceInsightsKmsKeyId
            MonitoringInterval=$script:MockMonitoringInterval
            MonitoringRoleArn=$script:MockMonitoringRoleArn
            EnabledCloudwatchLogsExports=$script:MockLogExports
            PendingModifiedValues=$pending
            DBParameterGroups=@([pscustomobject]@{DBParameterGroupName="default.postgres16";ParameterApplyStatus=$script:MockParameterStatus})
        })}
    }
    if ($service -eq "rds" -and $operation -eq "modify-db-instance") {
        $mode = $Arguments[[Array]::IndexOf($Arguments,"--database-insights-mode") + 1]
        $retention = [int]$Arguments[[Array]::IndexOf($Arguments,"--performance-insights-retention-period") + 1]
        $script:ModifyCalls.Add("$mode/$retention")
        $script:OperationCalls.Add("rds/$mode/$retention")
        if ($mode -eq "advanced" -and $script:FailAdvanced) { throw "simulated advanced provider failure with raw detail" }
        if ($mode -eq "standard" -and $script:FailRestore) { throw "simulated restore provider failure with raw detail" }
        $script:MockMode = $mode
        $script:MockRetention = $retention
        return [pscustomobject]@{DBInstance=[pscustomobject]@{DBInstanceIdentifier="schoolpilot-production-db"}}
    }
    if ($service -eq "scheduler" -and $operation -eq "get-schedule-group") {
        return [pscustomobject]@{
            Arn="arn:aws:scheduler:us-east-1:135775632425:schedule-group/schoolpilot-production-db-insights-leases"
            Name="schoolpilot-production-db-insights-leases";State="ACTIVE"
        }
    }
    if ($service -eq "iam" -and $operation -eq "get-role") {
        $roleName = $Arguments[[Array]::IndexOf($Arguments,"--role-name") + 1]
        $isAutomation = $roleName -eq "schoolpilot-production-db-insights-restore-automation"
        $servicePrincipal = if ($isAutomation) { "ssm.amazonaws.com" } else { "scheduler.amazonaws.com" }
        $sid = if ($isAutomation) { "SsmAutomationOnly" } else { "SchedulerOnly" }
        $sourceArn = if ($isAutomation) {
            "arn:aws:ssm:us-east-1:135775632425:automation-execution/*"
        } else {
            "arn:aws:scheduler:us-east-1:135775632425:schedule-group/schoolpilot-production-db-insights-leases"
        }
        $role = [pscustomobject]@{
            Arn="arn:aws:iam::135775632425:role/$roleName"
            AssumeRolePolicyDocument=[pscustomobject]@{
                Version="2012-10-17";Statement=@([pscustomobject]@{
                    Sid=$sid;Effect="Allow";Action="sts:AssumeRole"
                    Principal=[pscustomobject]@{Service=$servicePrincipal}
                    Condition=[pscustomobject]@{
                        StringEquals=[pscustomobject]@{"aws:SourceAccount"="135775632425"}
                        ArnLike=[pscustomobject]@{"aws:SourceArn"=$sourceArn}
                    }
                })
            }
        }
        if ($script:FailRestorePermissionsBoundary) {
            $role | Add-Member -NotePropertyName PermissionsBoundary -NotePropertyValue ([pscustomobject]@{
                PermissionsBoundaryArn="arn:aws:iam::aws:policy/AdministratorAccess"
            })
        }
        return [pscustomobject]@{Role=$role}
    }
    if ($service -eq "iam" -and $operation -eq "list-attached-role-policies") {
        return [pscustomobject]@{AttachedPolicies=@();IsTruncated=$false}
    }
    if ($service -eq "iam" -and $operation -eq "list-role-policies") {
        $roleName = $Arguments[[Array]::IndexOf($Arguments,"--role-name") + 1]
        $policyName = if ($roleName -eq "schoolpilot-production-db-insights-restore-automation") {
            "database-insights-restore-automation"
        } else { "database-insights-restore" }
        return [pscustomobject]@{PolicyNames=@($policyName);IsTruncated=$false}
    }
    if ($service -eq "iam" -and $operation -eq "get-role-policy") {
        $policyName = $Arguments[[Array]::IndexOf($Arguments,"--policy-name") + 1]
        if ($policyName -eq "database-insights-restore-automation") {
            $modifyStatement = [pscustomobject]@{Sid="ModifyExactDatabaseInsightsPosture";Effect="Allow";Action="rds:ModifyDBInstance";
                Resource="arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db"}
            if ($script:FailRestoreIamStatementExtra) {
                $modifyStatement | Add-Member -NotePropertyName Condition -NotePropertyValue ([pscustomobject]@{
                    StringEquals=[pscustomobject]@{"aws:RequestedRegion"="us-east-1"}
                })
            }
            return [pscustomobject]@{PolicyDocument=[pscustomobject]@{
                Version="2012-10-17";Statement=@(
                    $modifyStatement,
                    [pscustomobject]@{Sid="DescribeDatabaseForExactVerification";Effect="Allow";Action="rds:DescribeDBInstances";
                        Resource="*";Condition=[pscustomobject]@{StringEquals=[pscustomobject]@{"aws:RequestedRegion"="us-east-1"}}},
                    [pscustomobject]@{Sid="ManageExactRestoreSchedule";Effect="Allow";
                        Action=@("scheduler:DeleteSchedule","scheduler:GetSchedule","scheduler:UpdateSchedule");
                        Resource="arn:aws:scheduler:us-east-1:135775632425:schedule/schoolpilot-production-db-insights-leases/db-insights-restore-e29866227184b29a3b050565"},
                    [pscustomobject]@{Sid="PassExactSchedulerRoleForDisarm";Effect="Allow";Action="iam:PassRole";
                        Resource="arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore";
                        Condition=[pscustomobject]@{StringEquals=[pscustomobject]@{"iam:PassedToService"="scheduler.amazonaws.com"}}},
                    [pscustomobject]@{Sid="PublishRestoreFailureDirectly";Effect="Allow";Action="sqs:SendMessage";
                        Resource="arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq"}
                )
            }}
        }
        $startAction = if ($script:FailRestoreInfrastructure) {
            @("ssm:StartAutomationExecution", "ssm:DeleteDocument")
        } else { "ssm:StartAutomationExecution" }
        $startStatement = [pscustomobject]@{Sid="StartExactRestoreAutomation";Effect="Allow";Action=$startAction;
            Resource='arn:aws:ssm:us-east-1:135775632425:automation-definition/schoolpilot-production-db-insights-restore-v2:1'}
        if ($script:FailRestoreIamStatementExtra) {
            $startStatement | Add-Member -NotePropertyName Condition -NotePropertyValue ([pscustomobject]@{
                StringEquals=[pscustomobject]@{"aws:RequestedRegion"="us-east-1"}
            })
        }
        return [pscustomobject]@{PolicyDocument=[pscustomobject]@{
            Version="2012-10-17";Statement=@(
                $startStatement,
                [pscustomobject]@{Sid="PassExactRestoreAutomationRole";Effect="Allow";Action="iam:PassRole";
                    Resource="arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore-automation";
                    Condition=[pscustomobject]@{StringEquals=[pscustomobject]@{"iam:PassedToService"="ssm.amazonaws.com"}}},
                [pscustomobject]@{Sid="PublishFailedInvocationToEncryptedDlq";Effect="Allow";Action="sqs:SendMessage";
                    Resource="arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq"}
            )
        }}
    }
    if ($service -eq "ssm" -and $operation -eq "get-document") {
        $document = Get-TestRestoreAutomationDocument
        return [pscustomobject]@{Name="schoolpilot-production-db-insights-restore-v2";DocumentVersion="1";
            DocumentType="Automation";DocumentFormat="JSON";Status="Active";
            Content=($document | ConvertTo-Json -Depth 50 -Compress)}
    }
    if ($service -eq "ssm" -and $operation -eq "start-automation-execution") {
        $script:OperationCalls.Add("ssm/start")
        if ($script:FailRestore) { throw "simulated manual Automation start failure with raw detail" }
        $parameters = $Arguments[[Array]::IndexOf($Arguments,"--parameters") + 1] | ConvertFrom-Json -Depth 30
        foreach ($parameter in $parameters.PSObject.Properties) {
            if (@($parameter.Value).Count -ne 1 -or
                [string]::IsNullOrWhiteSpace([string]@($parameter.Value)[0])) {
                throw "AWS SSM rejects missing, empty, or multi-valued String parameters"
            }
        }
        if (@($parameters.RestoreMode).Count -ne 1 -or [string]$parameters.RestoreMode[0] -cne "manual") {
            throw "manual restore mode was not bound"
        }
        $executionId = [Guid]::NewGuid().ToString()
        $status = "Success"
        if ($script:FailAutomationAfterMutation) {
            $script:OperationCalls.Add("ssm/rds/standard/7-started")
            $status = "Failed"
        }
        else {
            $script:OperationCalls.Add("ssm/rds/standard/7")
            $script:MockMode = "standard"
            $script:MockRetention = 7
            if ($null -ne $script:MockSchedule -and $script:MockSchedule.State -ceq "ENABLED") {
                $script:OperationCalls.Add("ssm/scheduler/disable")
                $script:MockSchedule.State = "DISABLED"
            }
            $script:OperationCalls.Add("ssm/delivery-grace")
            $script:OperationCalls.Add("ssm/scheduler/delete")
            $script:MockSchedule = $null
        }
        $script:MockBoundExecution = [pscustomobject]@{
            AutomationExecutionId=$executionId
            DocumentName="schoolpilot-production-db-insights-restore-v2"
            DocumentVersion="1"
            AutomationExecutionStatus=$status
        }
        return [pscustomobject]@{AutomationExecutionId=$executionId}
    }
    if ($service -eq "ssm" -and $operation -eq "get-automation-execution") {
        if ($null -eq $script:MockBoundExecution) { throw "simulated missing Automation execution" }
        return [pscustomobject]@{AutomationExecution=$script:MockBoundExecution}
    }
    if ($service -eq "ssm" -and $operation -eq "describe-automation-executions") {
        $filters = $Arguments[[Array]::IndexOf($Arguments, "--filters") + 1] | ConvertFrom-Json -Depth 10
        if (@($filters).Count -ne 1 -or [string]$filters[0].Key -cne "DocumentNamePrefix" -or
            @($filters[0].Values).Count -ne 1 -or
            [string]$filters[0].Values[0] -cne "schoolpilot-production-db-insights-restore-v") {
            throw "restore Automation fencing did not span every versioned document"
        }
        $nextTokenIndex = [Array]::IndexOf($Arguments, "--next-token")
        $nextToken = if ($nextTokenIndex -ge 0) { [string]$Arguments[$nextTokenIndex + 1] } else { "" }
        $script:AutomationDescribeCalls.Add($nextToken)
        if ($null -ne $script:MockAutomationExecutionPages) {
            $pageIndex = if ([string]::IsNullOrEmpty($nextToken)) { 0 } elseif ($nextToken -match '^page-([0-9]+)$') {
                [int]$Matches[1]
            } else { throw "unexpected mock Automation page token" }
            if ($pageIndex -ge @($script:MockAutomationExecutionPages).Count) {
                throw "unexpected mock Automation page index"
            }
            return $script:MockAutomationExecutionPages[$pageIndex]
        }
        return [pscustomobject]@{AutomationExecutionMetadataList=@($script:MockAutomationExecutions)}
    }
    if ($service -eq "events" -and $operation -eq "describe-rule") {
        $pattern = [ordered]@{source=@("aws.ssm");"detail-type"=@("EC2 Automation Execution Status-change Notification");
            detail=[ordered]@{Definition=@("schoolpilot-production-db-insights-restore-v2");Status=@("Failed","TimedOut","Canceled")}}
        if ($script:FailRestoreEventPatternExtra) { $pattern["resources"] = @("*") }
        return [pscustomobject]@{Arn="arn:aws:events:us-east-1:135775632425:rule/schoolpilot-production-db-insights-restore-failed";
            Name="schoolpilot-production-db-insights-restore-failed";State="ENABLED";
            EventPattern=($pattern | ConvertTo-Json -Depth 10 -Compress)}
    }
    if ($service -eq "events" -and $operation -eq "list-targets-by-rule") {
        $target = [pscustomobject]@{Id="database-insights-automation-failure";
            Arn="arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq"}
        if ($script:FailRestoreEventTargetExtra) {
            $target | Add-Member -NotePropertyName Input -NotePropertyValue "{}"
        }
        return [pscustomobject]@{Targets=@($target)}
    }
    if ($service -eq "sqs" -and $operation -eq "get-queue-url") {
        return [pscustomobject]@{QueueUrl="https://sqs.us-east-1.amazonaws.com/135775632425/schoolpilot-production-db-insights-restore-dlq"}
    }
    if ($service -eq "sqs" -and $operation -eq "get-queue-attributes") {
        $sseEnabled = if ($script:FailRestoreQueueEncryption) { "false" } else { "true" }
        $messageRetention = if ($script:FailRestoreQueueRetention) { "60" } else { "1209600" }
        $queuePolicyObject = [ordered]@{Version="2012-10-17";Statement=@(
            [ordered]@{Sid="DenyInsecureTransport";Effect="Deny";Principal=[ordered]@{AWS="*"};Action="sqs:*";
                Resource="arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq";
                Condition=[ordered]@{Bool=[ordered]@{"aws:SecureTransport"="false"}}},
            [ordered]@{Sid="AcceptFailedAutomationEvents";Effect="Allow";Principal=[ordered]@{Service="events.amazonaws.com"};
                Action="sqs:SendMessage";Resource="arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq";
                Condition=[ordered]@{ArnEquals=[ordered]@{"aws:SourceArn"="arn:aws:events:us-east-1:135775632425:rule/schoolpilot-production-db-insights-restore-failed"}}}
        )}
        if ($script:FailRestoreQueueTlsPrincipal) {
            $queuePolicyObject.Statement[0].Principal.AWS = "arn:aws:iam::135775632425:root"
        }
        if ($script:FailRestoreQueuePolicyExtra) { $queuePolicyObject["Id"] = "unexpected" }
        $queuePolicy = $queuePolicyObject | ConvertTo-Json -Depth 20 -Compress
        return [pscustomobject]@{Attributes=[pscustomobject]@{
            QueueArn="arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq"
            SqsManagedSseEnabled=$sseEnabled;MessageRetentionPeriod=$messageRetention;ApproximateNumberOfMessages="0"
            ApproximateNumberOfMessagesNotVisible="0";ApproximateNumberOfMessagesDelayed="0"
            Policy=$queuePolicy
        }}
    }
    if ($service -eq "cloudwatch" -and $operation -eq "describe-alarms") {
        $alarmTopic = if ($script:FailRestoreAlarm) {
            "arn:aws:sns:us-east-1:135775632425:unexpected-topic"
        } else {
            "arn:aws:sns:us-east-1:135775632425:schoolpilot-production-alerts"
        }
        $alarm = [pscustomobject]@{
            AlarmName="schoolpilot-production-scale-db-insights-restore-dlq";ActionsEnabled=$true
            Namespace="AWS/SQS";MetricName="ApproximateNumberOfMessagesVisible"
            ComparisonOperator="GreaterThanThreshold";Threshold=0;EvaluationPeriods=1;DatapointsToAlarm=1
            Period=60;Statistic="Maximum";TreatMissingData="notBreaching"
            AlarmActions=@($alarmTopic);OKActions=@($alarmTopic)
            Dimensions=@([pscustomobject]@{Name="QueueName";Value="schoolpilot-production-db-insights-restore-dlq"})
        }
        if ($script:FailRestoreAlarmUnit) { $alarm | Add-Member -NotePropertyName Unit -NotePropertyValue "Seconds" }
        return [pscustomobject]@{MetricAlarms=@($alarm)}
    }
    if ($service -eq "scheduler" -and $operation -eq "create-schedule") {
        $script:OperationCalls.Add("scheduler/create")
        if ($script:FailScheduleCreate) { throw "simulated schedule create failure with raw detail" }
        if ($null -ne $script:MockSchedule) { throw "simulated schedule conflict with raw detail" }
        $name = $Arguments[[Array]::IndexOf($Arguments,"--name") + 1]
        $group = $Arguments[[Array]::IndexOf($Arguments,"--group-name") + 1]
        $region = $Arguments[[Array]::IndexOf($Arguments,"--region") + 1]
        $target = $Arguments[[Array]::IndexOf($Arguments,"--target") + 1] | ConvertFrom-Json -Depth 20
        $flexible = $Arguments[[Array]::IndexOf($Arguments,"--flexible-time-window") + 1] | ConvertFrom-Json -Depth 10
        $script:MockSchedule = [pscustomobject]@{
            Arn="arn:aws:scheduler:$region`:$($script:MockAccount):schedule/$group/$name"
            Name=$name;GroupName=$group
            CreationDate=[DateTimeOffset]::UtcNow;LastModificationDate=[DateTimeOffset]::UtcNow
            Description=$Arguments[[Array]::IndexOf($Arguments,"--description") + 1]
            ScheduleExpression=$Arguments[[Array]::IndexOf($Arguments,"--schedule-expression") + 1]
            StartDate=$Arguments[[Array]::IndexOf($Arguments,"--start-date") + 1]
            ScheduleExpressionTimezone=$Arguments[[Array]::IndexOf($Arguments,"--schedule-expression-timezone") + 1]
            FlexibleTimeWindow=$flexible;Target=$target
            ActionAfterCompletion=$Arguments[[Array]::IndexOf($Arguments,"--action-after-completion") + 1]
            State=$Arguments[[Array]::IndexOf($Arguments,"--state") + 1]
        }
        return [pscustomobject]@{ScheduleArn=$script:MockSchedule.Arn}
    }
    if ($service -eq "scheduler" -and $operation -eq "update-schedule") {
        if ($null -eq $script:MockSchedule) { throw "simulated missing schedule" }
        $script:OperationCalls.Add("scheduler/disable")
        $script:MockSchedule.State=$Arguments[[Array]::IndexOf($Arguments,"--state") + 1]
        return [pscustomobject]@{ScheduleArn=$script:MockSchedule.Arn}
    }
    if ($service -eq "scheduler" -and $operation -eq "list-schedules") {
        $schedules = if ($null -eq $script:MockSchedule) { @() } else { @([pscustomobject]@{
            Arn=$script:MockSchedule.Arn;Name=$script:MockSchedule.Name;GroupName=$script:MockSchedule.GroupName;State=$script:MockSchedule.State
        }) }
        return [pscustomobject]@{Schedules=$schedules}
    }
    if ($service -eq "scheduler" -and $operation -eq "get-schedule") {
        if ($null -eq $script:MockSchedule) { throw "simulated missing schedule" }
        return $script:MockSchedule
    }
    if ($service -eq "scheduler" -and $operation -eq "delete-schedule") {
        $script:OperationCalls.Add("scheduler/delete")
        $script:MockSchedule = $null
        return [pscustomobject]@{}
    }
    throw "Unexpected mock AWS request: $service $operation"
}

function Start-DatabaseInsightsLeaseWatchdog {
    param(
        [string]$ReceiptPath, [string]$ReceiptSha256, $Receipt, [string]$Region,
        [string]$ExpectedAccountId, [string]$ExpectedClass, [string]$LeasePurpose,
        [int]$PollSeconds, [int]$TimeoutSeconds
    )
    $watchdogPath = Get-DatabaseInsightsWatchdogPath $ReceiptPath
    Write-DatabaseInsightsWatchdogHeartbeat $watchdogPath $Receipt $ReceiptSha256 "armed"
    return [ordered]@{
        processId=4242
        heartbeatSha256=Get-DatabaseInsightsFileSha256 $watchdogPath
        state="armed"
    }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-db-insights-lease-$([Guid]::NewGuid().ToString('N'))"
[void][IO.Directory]::CreateDirectory($tempRoot)
$assertions = 0
try {
    foreach ($malformedAcl in @(
        [ordered]@{name='empty DACL';empty=$true;type=[Security.AccessControl.AccessControlType]::Allow;rights=[Security.AccessControl.FileSystemRights]::FullControl},
        [ordered]@{name='insufficient rights';empty=$false;type=[Security.AccessControl.AccessControlType]::Allow;rights=[Security.AccessControl.FileSystemRights]::ReadData},
        [ordered]@{name='deny-only DACL';empty=$false;type=[Security.AccessControl.AccessControlType]::Deny;rights=[Security.AccessControl.FileSystemRights]::FullControl}
    )) {
        $malformedAclPath = Join-Path $tempRoot `
            "malformed-private-acl-$([Guid]::NewGuid().ToString('N')).json"
        try {
            [IO.File]::WriteAllText($malformedAclPath, '{}', [Text.UTF8Encoding]::new($false))
            $current = [Security.Principal.WindowsIdentity]::GetCurrent()
            $item = Get-Item -LiteralPath $malformedAclPath
            $security = [IO.FileSystemAclExtensions]::GetAccessControl(
                $item, [Security.AccessControl.AccessControlSections]::Access
            )
            $security.SetAccessRuleProtection($true, $false)
            foreach ($existingRule in @($security.GetAccessRules(
                    $true, $true, [Security.Principal.SecurityIdentifier]
                ))) {
                [void]$security.RemoveAccessRuleSpecific($existingRule)
            }
            if (-not [bool]$malformedAcl.empty) {
                $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                    $current.User,
                    $malformedAcl.rights,
                    [Security.AccessControl.InheritanceFlags]::None,
                    [Security.AccessControl.PropagationFlags]::None,
                    $malformedAcl.type
                ))
            }
            [IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
            $malformedRejected = $false
            try { Assert-DatabaseInsightsPrivateAcl -Path $malformedAclPath }
            catch { $malformedRejected = $true }
            Assert-Condition $malformedRejected `
                "The Database Insights private ACL validator must reject a $($malformedAcl.name)."
            $assertions++
        }
        finally {
            if (Test-Path -LiteralPath $malformedAclPath) {
                Set-DatabaseInsightsPrivateAcl -Path $malformedAclPath
                Remove-Item -LiteralPath $malformedAclPath -Force
            }
        }
    }

    $receiptPath = Join-Path $tempRoot "diagnostic-lease.json"
    $acquired = Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" $receiptPath "" "us-east-1" `
        "135775632425" "db.t4g.medium" "diagnostic" 90 1 60
    Assert-Condition ($acquired.state -eq "active" -and $script:MockMode -eq "advanced" -and
        $script:MockRetention -eq 465 -and $script:ModifyCalls[0] -eq "advanced/465") `
        "Acquire must move the exact medium instance from Standard/7 to Advanced/465."
    $assertions++
    Assert-Condition ($script:OperationCalls[0] -eq "scheduler/create" -and
        $script:OperationCalls[1] -eq "rds/advanced/465" -and
        $null -ne $script:MockSchedule) `
        "Acquire must create and verify the AWS-native restore schedule before the first RDS mutation."
    $assertions++
    Assert-Condition ((Test-Path $receiptPath) -and (Test-Path "$receiptPath.status.json") -and
        $acquired.receiptSha256 -eq (Get-DatabaseInsightsFileSha256 $receiptPath)) `
        "Acquire must produce an immutable hash-bound receipt and separate status journal."
    $assertions++
    Assert-Condition ((Test-Path "$receiptPath.watchdog.json") -and
        [string]$acquired.receiptPathSha256 -eq (Get-DatabaseInsightsTextSha256 ([IO.Path]::GetFullPath($receiptPath))) -and
        [string]$acquired.statusPathSha256 -eq (Get-DatabaseInsightsTextSha256 ([IO.Path]::GetFullPath("$receiptPath.status.json"))) -and
        [string]$acquired.watchdogPathSha256 -eq (Get-DatabaseInsightsTextSha256 ([IO.Path]::GetFullPath("$receiptPath.watchdog.json"))) -and
        $acquired.rawPathsPersisted -eq $false) `
        "Acquire must bind the private watchdog and expose only path hashes."
    $assertions++
    $acquiredJson = $acquired | ConvertTo-Json -Depth 20 -Compress
    Assert-Condition (
        [string]$acquired.durableRestoreGuardVersion -eq "aws-scheduler-ssm-recurring-restore-v2" -and
        [string]$acquired.durableRestoreGuardBindingSha256 -match '^[0-9a-f]{64}$' -and
        [string]$acquired.durableRestoreScheduleArnSha256 -match '^[0-9a-f]{64}$' -and
        [string]$acquired.durableRestoreTargetRoleArnSha256 -match '^[0-9a-f]{64}$' -and
        [string]$acquired.durableRestoreDeadLetterQueueArnSha256 -match '^[0-9a-f]{64}$' -and
        [string]$acquired.durableRestoreAutomationDefinitionArnSha256 -match '^[0-9a-f]{64}$' -and
        [string]$acquired.durableRestoreAutomationRoleArnSha256 -match '^[0-9a-f]{64}$' -and
        [string]$acquired.durableRestoreAutomationFailureRuleArnSha256 -match '^[0-9a-f]{64}$' -and
        [string]$acquired.durableRestoreAutomationDocumentVersion -eq "1" -and
        [string]$acquired.durableRestoreAutomationDocumentContentSha256 -match '^[0-9a-f]{64}$' -and
        [string]$acquired.durableRestoreGuardState -eq "armed" -and
        -not $acquiredJson.Contains("db-insights-restore-") -and
        -not $acquiredJson.Contains("schedule/") -and
        -not $acquiredJson.Contains(":role/") -and
        -not $acquiredJson.Contains(":sqs:")
    ) "Public lease evidence must prove the durable guard using hashes without exposing raw AWS identities."
    $assertions++
    $privateAcquiredReceipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -Depth 40
    $privateTargetInput = [string]$privateAcquiredReceipt.durableRestoreGuard.targetInput | ConvertFrom-Json -Depth 30
    Assert-Condition ($privateAcquiredReceipt.schemaVersion -eq 3 -and
        $privateAcquiredReceipt.leaseVersion -ceq "database-insights-monitoring-lease-v3" -and
        $privateAcquiredReceipt.durableRestoreGuard.version -ceq `
            "aws-scheduler-ssm-recurring-restore-v2" -and
        $privateAcquiredReceipt.durableRestoreGuard.automationVersion -ceq `
            "ssm-rds-monitoring-restore-v2") `
        "Acquire must seal only the receipt-schema-3 lease-v3 / guard-v2 / Automation-v2 contract."
    $assertions++
    $expectedPreservedMonitoringPostureJson = [ordered]@{
        version = "rds-preserved-monitoring-posture-json-v1"
        performanceInsightsKmsKeyId = $script:MockPerformanceInsightsKmsKeyId
        monitoringInterval = 0
        monitoringRoleArn = $null
        enabledCloudwatchLogsExports = @()
    } | ConvertTo-Json -Depth 10 -Compress
    $expectedPreservedMonitoringPostureSha256 = Get-DatabaseInsightsTextSha256 `
        $expectedPreservedMonitoringPostureJson
    $emptyOrAmbiguousTargetParameters = @(
        $privateTargetInput.Parameters.PSObject.Properties | Where-Object {
            @($_.Value).Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]@($_.Value)[0])
        }
    )
    Assert-Condition ($privateAcquiredReceipt.durableRestoreGuard.targetArn -ceq 'arn:aws:scheduler:::aws-sdk:ssm:startAutomationExecution' -and
        $privateAcquiredReceipt.durableRestoreGuard.scheduleExpression -ceq 'rate(15 minutes)' -and
        $privateAcquiredReceipt.durableRestoreGuard.actionAfterCompletion -ceq 'NONE' -and
        $privateAcquiredReceipt.durableRestoreGuard.maximumEventAgeInSeconds -eq 60 -and
        $privateAcquiredReceipt.durableRestoreGuard.maximumRetryAttempts -eq 0 -and
        $privateTargetInput.DocumentName -ceq 'schoolpilot-production-db-insights-restore-v2' -and
        $privateTargetInput.DocumentVersion -ceq '1' -and
        @($privateTargetInput.Parameters.DBInstanceIdentifier).Count -eq 1 -and
        $privateTargetInput.Parameters.DBInstanceIdentifier[0] -ceq 'schoolpilot-production-db' -and
        $privateTargetInput.Parameters.ExpectedDBInstanceClass[0] -ceq 'db.t4g.medium' -and
        $privateTargetInput.Parameters.RestoreMode[0] -ceq 'scheduled' -and
        @($privateTargetInput.Parameters.PreservedMonitoringPostureEncodingVersion).Count -eq 1 -and
        $privateTargetInput.Parameters.PreservedMonitoringPostureEncodingVersion[0] -ceq `
            'rds-preserved-monitoring-posture-json-v1' -and
        @($privateTargetInput.Parameters.ExpectedPreservedMonitoringPostureJson).Count -eq 1 -and
        $privateTargetInput.Parameters.ExpectedPreservedMonitoringPostureJson[0] -ceq `
            $expectedPreservedMonitoringPostureJson -and
        @($privateTargetInput.Parameters.ExpectedPreservedMonitoringPostureSha256).Count -eq 1 -and
        $privateTargetInput.Parameters.ExpectedPreservedMonitoringPostureSha256[0] -ceq `
            $expectedPreservedMonitoringPostureSha256 -and
        $emptyOrAmbiguousTargetParameters.Count -eq 0 -and
        -not $privateTargetInput.Parameters.PSObject.Properties['ExpectedMonitoringRoleArn'] -and
        -not $privateTargetInput.Parameters.PSObject.Properties['ExpectedLogExportsJson'] -and
        $privateTargetInput.Parameters.AutomationAssumeRole[0] -ceq
            'arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore-automation' -and
        $privateTargetInput.Parameters.AutomationDocumentContentSha256[0] -ceq
            $privateAcquiredReceipt.durableRestoreGuard.automationDocumentContentSha256) `
        "The recurring Scheduler target must launch the exact versioned SSM restoration verifier with its content hash."
    $assertions++
    $preservedEnvelope = Assert-DatabaseInsightsPreservedMonitoringPostureEnvelope `
        $privateTargetInput.Parameters.ExpectedPreservedMonitoringPostureJson[0] `
        $privateTargetInput.Parameters.ExpectedPreservedMonitoringPostureSha256[0]
    Assert-Condition ($preservedEnvelope.posture.monitoringInterval -eq 0 -and
        $null -eq $preservedEnvelope.posture.monitoringRoleArn -and
        @($preservedEnvelope.posture.enabledCloudwatchLogsExports).Count -eq 0) `
        "Standard/7 must encode absent Enhanced Monitoring role as explicit null and empty log exports as []."
    $assertions++
    $enabledPosture = [ordered]@{
        performanceInsightsKmsKeyId = $script:MockPerformanceInsightsKmsKeyId
        monitoringInterval = 60
        monitoringRoleArn = "arn:aws:iam::135775632425:role/rds-monitoring-role"
        enabledCloudwatchLogsExports = @("upgrade", "postgresql", "upgrade")
    }
    $enabledEnvelopeJson = Get-DatabaseInsightsPreservedMonitoringPostureJson $enabledPosture
    $enabledEnvelope = Assert-DatabaseInsightsPreservedMonitoringPostureEnvelope `
        $enabledEnvelopeJson (Get-DatabaseInsightsTextSha256 $enabledEnvelopeJson)
    Assert-Condition ($enabledEnvelope.posture.monitoringInterval -eq 60 -and
        $enabledEnvelope.posture.monitoringRoleArn -ceq "arn:aws:iam::135775632425:role/rds-monitoring-role" -and
        (@($enabledEnvelope.posture.enabledCloudwatchLogsExports) | ConvertTo-Json -Compress) -ceq `
            '["postgresql","upgrade"]') `
        "Enabled Enhanced Monitoring and multiple log exports must round-trip through one canonical envelope."
    $assertions++
    foreach ($malformedPosture in @(
        [ordered]@{Name="numeric KMS identity";Posture=[ordered]@{
            performanceInsightsKmsKeyId=123;monitoringInterval=0;monitoringRoleArn=$null
            enabledCloudwatchLogsExports=@()
        }},
        [ordered]@{Name="fractional monitoring interval";Posture=[ordered]@{
            performanceInsightsKmsKeyId=$script:MockPerformanceInsightsKmsKeyId;monitoringInterval=0.5
            monitoringRoleArn=$null;enabledCloudwatchLogsExports=@()
        }},
        [ordered]@{Name="boolean monitoring interval";Posture=[ordered]@{
            performanceInsightsKmsKeyId=$script:MockPerformanceInsightsKmsKeyId;monitoringInterval=$false
            monitoringRoleArn=$null;enabledCloudwatchLogsExports=@()
        }},
        [ordered]@{Name="numeric monitoring role";Posture=[ordered]@{
            performanceInsightsKmsKeyId=$script:MockPerformanceInsightsKmsKeyId;monitoringInterval=60
            monitoringRoleArn=123;enabledCloudwatchLogsExports=@()
        }},
        [ordered]@{Name="scalar log export";Posture=[ordered]@{
            performanceInsightsKmsKeyId=$script:MockPerformanceInsightsKmsKeyId;monitoringInterval=0
            monitoringRoleArn=$null;enabledCloudwatchLogsExports="postgresql"
        }},
        [ordered]@{Name="non-string log export";Posture=[ordered]@{
            performanceInsightsKmsKeyId=$script:MockPerformanceInsightsKmsKeyId;monitoringInterval=0
            monitoringRoleArn=$null;enabledCloudwatchLogsExports=@(123)
        }}
    )) {
        $malformedPostureRejected = $false
        try { [void](Get-DatabaseInsightsPreservedMonitoringPosture $malformedPosture.Posture) }
        catch { $malformedPostureRejected = $_.Exception.Message -match 'unsupported value type' }
        Assert-Condition $malformedPostureRejected `
            "The primary lease boundary must reject a $($malformedPosture.Name) before canonicalization."
        $assertions++
    }
    $enabledInitialPosture = $privateAcquiredReceipt.initialPosture | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $enabledInitialPosture.monitoringInterval = 60
    $enabledInitialPosture.monitoringRoleArn = "arn:aws:iam::135775632425:role/rds-monitoring-role"
    $enabledInitialPosture.enabledCloudwatchLogsExports = @("upgrade", "postgresql")
    $enabledBinding = Get-DatabaseInsightsDurableRestoreGuardBinding `
        $enabledInitialPosture "135775632425" "us-east-1" "schoolpilot-production-db" `
        ([Guid]::NewGuid().ToString("N")) ([DateTimeOffset]::Parse($privateAcquiredReceipt.expiresAtUtc)) `
        ([string]$privateAcquiredReceipt.durableRestoreGuard.automationDocumentContentSha256)
    $enabledTarget = Read-DatabaseInsightsBoundRestoreTargetInput $enabledBinding
    $enabledTargetEnvelope = Assert-DatabaseInsightsPreservedMonitoringPostureEnvelope `
        ([string]$enabledTarget.Parameters.ExpectedPreservedMonitoringPostureJson[0]) `
        ([string]$enabledTarget.Parameters.ExpectedPreservedMonitoringPostureSha256[0])
    Assert-Condition ($enabledTargetEnvelope.posture.monitoringInterval -eq 60 -and
        $enabledTargetEnvelope.posture.monitoringRoleArn -ceq `
            "arn:aws:iam::135775632425:role/rds-monitoring-role" -and
        @($enabledTargetEnvelope.posture.enabledCloudwatchLogsExports).Count -eq 2) `
        "An enabled monitoring posture must remain a one-value, canonical SSM restore contract."
    $assertions++

    $foreignRolePosture = $enabledInitialPosture | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $foreignRolePosture.monitoringRoleArn = "arn:aws:iam::000000000000:role/rds-monitoring-role"
    $foreignRoleRejected = $false
    try { [void](Get-DatabaseInsightsDurableRestoreGuardBinding `
        $foreignRolePosture "135775632425" "us-east-1" "schoolpilot-production-db" `
        ([Guid]::NewGuid().ToString("N")) ([DateTimeOffset]::Parse($privateAcquiredReceipt.expiresAtUtc)) `
        ([string]$privateAcquiredReceipt.durableRestoreGuard.automationDocumentContentSha256)) }
    catch { $foreignRoleRejected = $_.Exception.Message -match 'outside the bound AWS account' }
    Assert-Condition $foreignRoleRejected `
        "An enabled monitoring role must remain in the same partition and account as the bound database."
    $assertions++

    $malformedEnvelopes = @(
        [ordered]@{Name="missing key";Json=$expectedPreservedMonitoringPostureJson.Replace(',"monitoringRoleArn":null', '')},
        [ordered]@{Name="extra key";Json=$expectedPreservedMonitoringPostureJson.TrimEnd('}') + ',"extra":true}'},
        [ordered]@{Name="duplicate key";Json=$expectedPreservedMonitoringPostureJson.Replace(
            '{"version":', '{"version":"rds-preserved-monitoring-posture-json-v1","version":')},
        [ordered]@{Name="role with disabled monitoring";Json=$expectedPreservedMonitoringPostureJson.Replace(
            '"monitoringRoleArn":null', '"monitoringRoleArn":"arn:aws:iam::135775632425:role/rds-monitoring-role"')},
        [ordered]@{Name="duplicate exports";Json=$enabledEnvelopeJson.Replace(
            '["postgresql","upgrade"]', '["postgresql","postgresql","upgrade"]')},
        [ordered]@{Name="unsupported export";Json=$expectedPreservedMonitoringPostureJson.Replace(
            '"enabledCloudwatchLogsExports":[]', '"enabledCloudwatchLogsExports":["audit"]')}
    )
    foreach ($malformedEnvelope in $malformedEnvelopes) {
        $malformedEnvelopeRejected = $false
        try { [void](Assert-DatabaseInsightsPreservedMonitoringPostureEnvelope $malformedEnvelope.Json) }
        catch { $malformedEnvelopeRejected = $true }
        Assert-Condition $malformedEnvelopeRejected `
            "The canonical posture decoder must reject a $($malformedEnvelope.Name)."
        $assertions++
    }
    $tamperedEnvelopeHashRejected = $false
    try { [void](Assert-DatabaseInsightsPreservedMonitoringPostureEnvelope `
        $expectedPreservedMonitoringPostureJson ('0' * 64)) }
    catch { $tamperedEnvelopeHashRejected = $_.Exception.Message -match 'hash' }
    Assert-Condition $tamperedEnvelopeHashRejected `
        "The canonical posture decoder must reject a JSON/hash mismatch."
    $assertions++

    foreach ($badValues in @(@(), @(""), @($expectedPreservedMonitoringPostureJson, $expectedPreservedMonitoringPostureJson))) {
        $badBinding = $privateAcquiredReceipt.durableRestoreGuard | ConvertTo-Json -Depth 40 | ConvertFrom-Json -Depth 40
        $badTarget = [string]$badBinding.targetInput | ConvertFrom-Json -Depth 30
        $badTarget.Parameters.ExpectedPreservedMonitoringPostureJson = $badValues
        $badBinding.targetInput = $badTarget | ConvertTo-Json -Depth 30 -Compress
        $badParameterRejected = $false
        try { [void](Read-DatabaseInsightsBoundRestoreTargetInput $badBinding) }
        catch { $badParameterRejected = $_.Exception.Message -match 'missing, empty, or ambiguous' }
        Assert-Condition $badParameterRejected `
            "Every SSM target parameter must contain exactly one nonempty string."
        $assertions++
    }
    $reviewedAutomation = Get-TestRestoreAutomationDocument
    Assert-Condition (@($reviewedAutomation.mainSteps).Count -eq 4 -and
        $reviewedAutomation.mainSteps[0].name -ceq "RestoreExactPosture" -and
        $reviewedAutomation.mainSteps[0].onFailure -ceq "step:PublishRestoreFailure" -and
        $reviewedAutomation.mainSteps[0].nextStep -ceq "FinishRestoreSuccess" -and
        $null -eq (Get-DatabaseInsightsValue $reviewedAutomation.mainSteps[0] "isEnd" $null) -and
        $reviewedAutomation.mainSteps[1].isEnd -eq $true -and
        $reviewedAutomation.mainSteps[2].name -ceq "PublishRestoreFailure" -and
        $reviewedAutomation.mainSteps[2].nextStep -ceq "FailRestoreAutomation" -and
        $reviewedAutomation.mainSteps[3].name -ceq "FailRestoreAutomation" -and
        $reviewedAutomation.mainSteps[3].isEnd -eq $true) `
        "Automation success and failure topology must route restore failures through direct DLQ publication and a terminal failed step."
    $assertions++
    $terminalAutomationHistory = @(
        1..50 | ForEach-Object {
            [pscustomobject]@{
                AutomationExecutionId=("{0:x8}-0000-0000-0000-000000000000" -f $_)
                DocumentName='schoolpilot-production-db-insights-restore-v2'
                DocumentVersion='1'
                AutomationExecutionStatus='Success'
            }
        }
    )
    $laterTerminalAutomation = [pscustomobject]@{
        AutomationExecutionId='00000033-0000-0000-0000-000000000000'
        DocumentName='schoolpilot-production-db-insights-restore-v2';DocumentVersion='1'
        AutomationExecutionStatus='Failed'
    }
    $otherGenerationActiveAutomation = [pscustomobject]@{
        AutomationExecutionId='00000034-0000-0000-0000-000000000000'
        DocumentName='schoolpilot-production-db-insights-restore-v1';DocumentVersion='1'
        AutomationExecutionStatus='InProgress'
    }
    $laterActiveAutomation = [pscustomobject]@{
        AutomationExecutionId='00000035-0000-0000-0000-000000000000'
        DocumentName='schoolpilot-production-db-insights-restore-v2';DocumentVersion='1'
        AutomationExecutionStatus='InProgress'
    }
    $script:MockAutomationExecutionPages = @(
        [pscustomobject]@{AutomationExecutionMetadataList=$terminalAutomationHistory;NextToken='page-1'},
        [pscustomobject]@{AutomationExecutionMetadataList=@(
            $laterTerminalAutomation, $otherGenerationActiveAutomation, $laterActiveAutomation
        )}
    )
    $describeCallsBeforePagination = $script:AutomationDescribeCalls.Count
    $activeAfterLongHistory = @(Get-DatabaseInsightsActiveRestoreAutomations `
        $privateAcquiredReceipt.durableRestoreGuard)
    Assert-Condition ($activeAfterLongHistory.Count -eq 2 -and
        @($activeAfterLongHistory.AutomationExecutionId) -contains $otherGenerationActiveAutomation.AutomationExecutionId -and
        @($activeAfterLongHistory.AutomationExecutionId) -contains $laterActiveAutomation.AutomationExecutionId -and
        $script:AutomationDescribeCalls.Count -eq $describeCallsBeforePagination + 2) `
        "Quiescence must inspect every explicit page and block on active executions across legacy and current versioned restore documents."
    $assertions++

    $script:MockAutomationExecutionPages = @(
        [pscustomobject]@{AutomationExecutionMetadataList=@([pscustomobject]@{
            AutomationExecutionId='00000039-0000-0000-0000-000000000000'
            DocumentName='schoolpilot-production-db-insights-restore-v2-copy';DocumentVersion='1'
            AutomationExecutionStatus='InProgress'
        })}
    )
    $invalidFamilyMemberRejected = $false
    try { [void](Get-DatabaseInsightsActiveRestoreAutomations `
        $privateAcquiredReceipt.durableRestoreGuard) }
    catch { $invalidFamilyMemberRejected = $_.Exception.Message -match 'invalid document family member' }
    Assert-Condition $invalidFamilyMemberRejected `
        "The all-version restore barrier must fail closed on malformed document-family members."
    $assertions++

    $script:MockAutomationExecutionPages = @(
        [pscustomobject]@{AutomationExecutionMetadataList=@([pscustomobject]@{
            AutomationExecutionId='00000040-0000-0000-0000-000000000000';
            DocumentName='schoolpilot-production-db-insights-restore-v2';DocumentVersion='1';
            AutomationExecutionStatus='Success'
        });NextToken='page-1'},
        [pscustomobject]@{AutomationExecutionMetadataList=@([pscustomobject]@{
            AutomationExecutionId='00000041-0000-0000-0000-000000000000';
            DocumentName='schoolpilot-production-db-insights-restore-v2';DocumentVersion='1';
            AutomationExecutionStatus='Success'
        });NextToken='page-1'}
    )
    $paginationCycleRejected = $false
    try { [void](Get-DatabaseInsightsActiveRestoreAutomations $privateAcquiredReceipt.durableRestoreGuard) }
    catch { $paginationCycleRejected = $_.Exception.Message -match 'pagination cycle' }
    Assert-Condition $paginationCycleRejected `
        "Automation execution pagination must reject a repeated continuation token."
    $assertions++

    $duplicateAutomation = [pscustomobject]@{
        AutomationExecutionId='00000050-0000-0000-0000-000000000000'
        DocumentName='schoolpilot-production-db-insights-restore-v2';DocumentVersion='1'
        AutomationExecutionStatus='Success'
    }
    $script:MockAutomationExecutionPages = @(
        [pscustomobject]@{AutomationExecutionMetadataList=@($duplicateAutomation);NextToken='page-1'},
        [pscustomobject]@{AutomationExecutionMetadataList=@($duplicateAutomation)}
    )
    $duplicateAutomationRejected = $false
    try { [void](Get-DatabaseInsightsActiveRestoreAutomations $privateAcquiredReceipt.durableRestoreGuard) }
    catch { $duplicateAutomationRejected = $_.Exception.Message -match 'missing or duplicate identity' }
    Assert-Condition $duplicateAutomationRejected `
        "Automation execution pagination must reject duplicate execution identities across pages."
    $assertions++
    $script:MockAutomationExecutionPages = $null
    $receiptAcl = Get-Acl -LiteralPath $receiptPath
    $statusAcl = Get-Acl -LiteralPath "$receiptPath.status.json"
    Assert-Condition ($receiptAcl.AreAccessRulesProtected -and $statusAcl.AreAccessRulesProtected) `
        "Lease receipt and journal must have protected private ACLs."
    $assertions++
    $leaseSource = [IO.File]::ReadAllText($leaseScript)
    $protectStagingIndex = $leaseSource.IndexOf('Set-DatabaseInsightsPrivateAcl -Path $stagingDirectory', [StringComparison]::Ordinal)
    $writeSensitiveIndex = $leaseSource.IndexOf('[IO.File]::WriteAllText(', $protectStagingIndex, [StringComparison]::Ordinal)
    Assert-Condition ($protectStagingIndex -ge 0 -and $writeSensitiveIndex -gt $protectStagingIndex -and
        @(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter '*.private.*').Count -eq 0) `
        "Private JSON must protect an empty staging directory before writing sensitive bytes and leave no staging artifacts."
    $assertions++

    $statusPath = "$receiptPath.status.json"
    $statusSentinelTime = [DateTime]::UtcNow.AddMinutes(-10)
    (Get-Item -LiteralPath $statusPath).LastWriteTimeUtc = $statusSentinelTime
    $statusBeforeValidate = [IO.File]::ReadAllText($statusPath)
    $statusHashBeforeValidate = Get-DatabaseInsightsFileSha256 $statusPath
    $statusMtimeBeforeValidate = (Get-Item -LiteralPath $statusPath).LastWriteTimeUtc
    $validated = Invoke-DatabaseInsightsLease "Validate" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
        "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60
    Assert-Condition ($validated.state -eq "active_validated" -and $script:ModifyCalls.Count -eq 1) `
        "Validate must prove the active lease without another RDS mutation."
    $assertions++
    Assert-Condition ($validated.durableRestoreGuardVersion -eq "aws-scheduler-ssm-recurring-restore-v2" -and
        $validated.durableRestoreGuardBindingSha256 -eq $acquired.durableRestoreGuardBindingSha256 -and
        $validated.durableRestoreAutomationDefinitionArnSha256 -eq $acquired.durableRestoreAutomationDefinitionArnSha256 -and
        $validated.durableRestoreAutomationRoleArnSha256 -eq $acquired.durableRestoreAutomationRoleArnSha256 -and
        $validated.durableRestoreAutomationFailureRuleArnSha256 -eq $acquired.durableRestoreAutomationFailureRuleArnSha256 -and
        $validated.durableRestoreAutomationDocumentVersion -eq "1" -and
        $validated.durableRestoreAutomationDocumentContentSha256 -eq $acquired.durableRestoreAutomationDocumentContentSha256 -and
        $validated.durableRestoreGuardState -eq "armed") `
        "Validate must independently verify the exact live AWS-native restore schedule."
    $assertions++
    Assert-Condition ([string]$validated.watchdogHeartbeatSha256 -match '^[0-9a-f]{64}$' -and
        [string]$validated.watchdogState -match '^(armed|monitoring)$' -and
        $validated.rawPathsPersisted -eq $false) `
        "Validate must prove a fresh identity-bound watchdog without exposing private paths."
    $assertions++
    Assert-Condition (
        [IO.File]::ReadAllText($statusPath) -ceq $statusBeforeValidate -and
        (Get-DatabaseInsightsFileSha256 $statusPath) -ceq $statusHashBeforeValidate -and
        (Get-Item -LiteralPath $statusPath).LastWriteTimeUtc -eq $statusMtimeBeforeValidate
    ) "Validate must be strictly read-only and leave the lease journal content, hash, and mtime unchanged."
    $assertions++
    $receiptForDurableGuard = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -Depth 40
    $secondLeaseBinding = Get-DatabaseInsightsDurableRestoreGuardBinding `
        $receiptForDurableGuard.initialPosture $receiptForDurableGuard.accountId $receiptForDurableGuard.region `
        $receiptForDurableGuard.dbInstanceIdentifier ([Guid]::NewGuid().ToString("N")) `
        ([DateTimeOffset]::Parse($receiptForDurableGuard.expiresAtUtc))
    Assert-Condition ($secondLeaseBinding.scheduleName -eq $receiptForDurableGuard.durableRestoreGuard.scheduleName -and
        $secondLeaseBinding.description -ne $receiptForDurableGuard.durableRestoreGuard.description) `
        "One deterministic schedule name must serialize all hosts by DB identity while the description binds one immutable lease."
    $assertions++
    $legacyUnsafeReceipt = $receiptForDurableGuard | ConvertTo-Json -Depth 40 | ConvertFrom-Json -Depth 40
    $legacyUnsafeReceipt.PSObject.Properties.Remove("durableRestoreGuard")
    $legacyUnsafeRejected = $false
    try {
        [void](Assert-DatabaseInsightsReceiptBinding $legacyUnsafeReceipt "us-east-1" "135775632425" `
            "schoolpilot-production-db" "db.t4g.medium" "diagnostic")
    }
    catch { $legacyUnsafeRejected = $_.Exception.Message -match "durable restore guard binding" }
    Assert-Condition $legacyUnsafeRejected `
        "Receipts missing the AWS-native durable guard must be ineligible."
    $assertions++
    $legacyV2Receipt = $receiptForDurableGuard | ConvertTo-Json -Depth 40 | ConvertFrom-Json -Depth 40
    $legacyV2Receipt.schemaVersion = 2
    $legacyV2Receipt.leaseVersion = "database-insights-monitoring-lease-v2"
    $legacyV2Path = Join-Path $tempRoot "historical-lease-v2.json"
    Write-DatabaseInsightsPrivateJson $legacyV2Path $legacyV2Receipt
    $legacyV2Rejected = $false
    try { [void](Read-DatabaseInsightsLeaseReceipt $legacyV2Path `
        (Get-DatabaseInsightsFileSha256 $legacyV2Path)) }
    catch { $legacyV2Rejected = $_.Exception.Message -match 'unsupported identity' }
    Assert-Condition $legacyV2Rejected `
        "Historical receipt-schema-2 / lease-v2 artifacts must be rejected without translation."
    $assertions++
    $originalDurableRole = $script:MockSchedule.Target.RoleArn
    $script:MockSchedule.Target.RoleArn = "arn:aws:iam::135775632425:role/unexpected-restore-role"
    $durableDriftRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Validate" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
            "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $durableDriftRejected = $_.Exception.Message -match "does not match its immutable lease binding" }
    Assert-Condition $durableDriftRejected `
        "Validate must fail closed when the durable schedule target, role, DLQ, retry, or expiry binding drifts."
    $assertions++
    $script:MockSchedule.Target.RoleArn = $originalDurableRole
    $script:MockSchedule.Target | Add-Member -NotePropertyName SqsParameters -NotePropertyValue ([pscustomobject]@{})
    $scheduleTargetShapeRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Validate" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
            "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $scheduleTargetShapeRejected = $_.Exception.Message -match "immutable lease binding" }
    Assert-Condition $scheduleTargetShapeRejected `
        "Validate must reject unexpected Scheduler target behavior even when bound values still match."
    $assertions++
    $script:MockSchedule.Target.PSObject.Properties.Remove("SqsParameters")
    $script:MockSchedule | Add-Member -NotePropertyName KmsKeyArn -NotePropertyValue `
        "arn:aws:kms:us-east-1:135775632425:key/ffffffff-ffff-ffff-ffff-ffffffffffff"
    $scheduleEncryptionDriftRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Validate" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
            "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $scheduleEncryptionDriftRejected = $_.Exception.Message -match "immutable lease binding" }
    Assert-Condition $scheduleEncryptionDriftRejected `
        "Validate must reject a customer-managed Scheduler KMS key not bound by the immutable receipt."
    $assertions++
    $script:MockSchedule.PSObject.Properties.Remove("KmsKeyArn")
    $savedDurableSchedule = $script:MockSchedule
    $script:MockSchedule = $null
    $missingDurableRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Validate" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
            "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $missingDurableRejected = $_.Exception.Message -match "schedule is missing" }
    Assert-Condition $missingDurableRejected `
        "Validate must reject an Advanced lease whose AWS-native restore schedule disappeared."
    $assertions++
    $script:MockSchedule = $savedDurableSchedule
    $watchdogPath = "$receiptPath.watchdog.json"
    $staleWatchdog = Get-Content -LiteralPath $watchdogPath -Raw | ConvertFrom-Json -Depth 20
    $staleWatchdog.observedAtUtc = [DateTimeOffset]::UtcNow.AddMinutes(-5).ToString("o")
    Write-DatabaseInsightsPrivateJson $watchdogPath $staleWatchdog
    $staleWatchdogRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Validate" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
            "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $staleWatchdogRejected = $_.Exception.Message -match "not fresh and active" }
    Assert-Condition $staleWatchdogRejected `
        "Validate must fail closed when the detached watchdog heartbeat is stale."
    $assertions++
    $receiptForWatchdog = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -Depth 40
    Write-DatabaseInsightsWatchdogHeartbeat $watchdogPath $receiptForWatchdog $acquired.receiptSha256 "monitoring"
    $script:MockMonitoringInterval = 60
    $script:MockMonitoringRoleArn = "arn:aws:iam::135775632425:role/unexpected-rds-monitoring-role"
    $monitoringDriftRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Validate" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
            "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $monitoringDriftRejected = $_.Exception.Message -match "encryption, Enhanced Monitoring, or log-export posture changed" }
    Assert-Condition $monitoringDriftRejected `
        "Validate must reject PI KMS, Enhanced Monitoring, or CloudWatch log-export drift."
    $assertions++
    $script:MockMonitoringInterval = 0
    $script:MockMonitoringRoleArn = ""
    $wrongPurposeRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Validate" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
            "us-east-1" "135775632425" "db.t4g.medium" "certification" 90 1 60 | Out-Null
    }
    catch { $wrongPurposeRejected = $_.Exception.Message -match "different account, region, instance, class, or posture" }
    Assert-Condition $wrongPurposeRejected "A diagnostic monitoring lease must not be replayed as a certification lease."
    $assertions++

    $originalReceipt = [IO.File]::ReadAllText($receiptPath)
    [IO.File]::AppendAllText($receiptPath, " ")
    $tamperRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Validate" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
            "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $tamperRejected = $_.Exception.Message -match "changed after capture" }
    Assert-Condition $tamperRejected "A modified lease receipt must fail before evidence collection."
    $assertions++
    [IO.File]::WriteAllText($receiptPath, $originalReceipt, [Text.UTF8Encoding]::new($false))
    Set-DatabaseInsightsPrivateAcl $receiptPath

    $restored = Invoke-DatabaseInsightsLease "Restore" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
        "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60
    Assert-Condition ($restored.state -eq "restored" -and $script:MockMode -eq "standard" -and
        $script:MockRetention -eq 7 -and $script:ModifyCalls.Count -eq 1 -and
        $null -eq $script:MockSchedule -and $script:OperationCalls[-1] -eq "ssm/scheduler/delete") `
        "Restore must delegate exact Standard/7 convergence and guard removal to the bound SSM Automation."
    $assertions++
    $startOperationIndex = $script:OperationCalls.IndexOf("ssm/start")
    $standardOperationIndex = $script:OperationCalls.IndexOf("ssm/rds/standard/7")
    $disableOperationIndex = $script:OperationCalls.IndexOf("ssm/scheduler/disable")
    $graceOperationIndex = $script:OperationCalls.IndexOf("ssm/delivery-grace")
    $deleteOperationIndex = $script:OperationCalls.IndexOf("ssm/scheduler/delete")
    Assert-Condition ($startOperationIndex -ge 0 -and $standardOperationIndex -gt $startOperationIndex -and
        $disableOperationIndex -gt $standardOperationIndex -and $graceOperationIndex -gt $disableOperationIndex -and
        $deleteOperationIndex -gt $graceOperationIndex -and
        $script:OperationCalls -notcontains "rds/standard/7" -and
        $script:OperationCalls -notcontains "scheduler/disable" -and
        $script:OperationCalls -notcontains "scheduler/delete" -and
        $restored.durableRestoreGuardState -eq "removed") `
        "Local Restore must perform no direct RDS/Scheduler mutation; SSM must converge posture before disarm, delivery grace, and deletion."
    $assertions++
    $modifyCountAfterRestore = $script:ModifyCalls.Count
    [void](Invoke-DatabaseInsightsLease "Restore" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
        "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60)
    Assert-Condition ($script:ModifyCalls.Count -eq $modifyCountAfterRestore) `
        "Repeated or concurrent restoration must be idempotent and avoid another RDS mutation."
    $assertions++

    $newGenerationExpirationRaw = [DateTimeOffset]::UtcNow.AddMinutes(30).UtcDateTime.Ticks
    $newGenerationExpiration = [DateTimeOffset]::new([DateTime]::new(
        $newGenerationExpirationRaw - ($newGenerationExpirationRaw % [TimeSpan]::TicksPerSecond),
        [DateTimeKind]::Utc
    ))
    $newGenerationBinding = Get-DatabaseInsightsDurableRestoreGuardBinding `
        $privateAcquiredReceipt.initialPosture $privateAcquiredReceipt.accountId $privateAcquiredReceipt.region `
        $privateAcquiredReceipt.dbInstanceIdentifier ([Guid]::NewGuid().ToString("N")) $newGenerationExpiration
    [void](New-DatabaseInsightsDurableRestoreSchedule $newGenerationBinding)
    $script:MockMode = "advanced"; $script:MockRetention = 465
    $oldGenerationStartCount = @($script:OperationCalls | Where-Object { $_ -ceq "ssm/start" }).Count
    $oldGenerationModifyCount = $script:ModifyCalls.Count
    foreach ($attempt in 1..2) {
        $oldGenerationRejected = $false
        try {
            Invoke-DatabaseInsightsLease "Restore" "schoolpilot-production-db" $receiptPath $acquired.receiptSha256 `
                "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
        }
        catch { $oldGenerationRejected = $_.Exception.Message -match "progression are blocked" }
        Assert-Condition $oldGenerationRejected `
            "Every delayed old-host restore must reject a newer fixed-name lease generation."
        $assertions++
    }
    Assert-Condition ($script:MockMode -ceq "advanced" -and $script:MockRetention -eq 465 -and
        $script:ModifyCalls.Count -eq $oldGenerationModifyCount -and
        @($script:OperationCalls | Where-Object { $_ -ceq "ssm/start" }).Count -eq $oldGenerationStartCount -and
        $null -ne $script:MockSchedule -and $script:MockSchedule.Description -ceq $newGenerationBinding.description) `
        "Cross-host old receipts must perform zero direct or SSM mutation against a newer Advanced generation."
    $assertions++
    $script:MockSchedule = $null
    $script:MockMode = "standard"; $script:MockRetention = 7

    $transitionalPosture = Get-DatabaseInsightsPosture "us-east-1" "schoolpilot-production-db"
    $transitionalPosture.status = "modifying"
    $transitionalPosture.pendingModifiedValuesAbsent = $false
    $transitionalPosture.parameterApplyStatuses = @("applying")
    [void](Assert-DatabaseInsightsLeaseIdentity $transitionalPosture `
        $privateAcquiredReceipt.initialPosture "schoolpilot-production-db" "db.t4g.medium")
    Assert-Condition $true `
        "Restoration identity checks must allow transitional status, pending values, and parameter application."
    $assertions++
    $transitionalPosture.performanceInsightsKmsKeyId = `
        "arn:aws:kms:us-east-1:135775632425:key/ffffffff-ffff-ffff-ffff-ffffffffffff"
    $transitionalMonitoringDriftRejected = $false
    try {
        [void](Assert-DatabaseInsightsLeaseIdentity $transitionalPosture `
            $privateAcquiredReceipt.initialPosture "schoolpilot-production-db" "db.t4g.medium")
    }
    catch { $transitionalMonitoringDriftRejected = $_.Exception.Message -match "posture changed" }
    Assert-Condition $transitionalMonitoringDriftRejected `
        "Transitional restoration must still reject immutable or preserved monitoring-posture drift."
    $assertions++

    $resumablePath = Join-Path $tempRoot "resumable-disarm.json"
    $resumableLease = Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" $resumablePath "" `
        "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60
    $resumableReceipt = Get-Content -LiteralPath $resumablePath -Raw | ConvertFrom-Json -Depth 40
    $script:MockSchedule.State = "DISABLED"
    Write-DatabaseInsightsLeaseStatus "$resumablePath.status.json" $resumableLease.receiptSha256 `
        "restore_guard_disabled" (Get-DatabaseInsightsPosture "us-east-1" "schoolpilot-production-db")
    $disableCountBeforeResume = @($script:OperationCalls | Where-Object { $_ -ceq "scheduler/disable" }).Count
    $script:FailRestoreDocument = $true
    $resumedRestore = Invoke-DatabaseInsightsLease "Restore" "schoolpilot-production-db" $resumablePath `
        $resumableLease.receiptSha256 "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60
    $script:FailRestoreDocument = $false
    $disableCountAfterResume = @($script:OperationCalls | Where-Object { $_ -ceq "scheduler/disable" }).Count
    Assert-Condition ($resumedRestore.state -ceq "restored" -and $null -eq $script:MockSchedule -and
        $script:MockMode -ceq "standard" -and $script:MockRetention -eq 7 -and
        $disableCountAfterResume -eq $disableCountBeforeResume) `
        "A retry must resume from an exact DISABLED guard without requiring live SSM or disabling twice."
    $assertions++

    Write-DatabaseInsightsLeaseStatus "$resumablePath.status.json" $resumableLease.receiptSha256 `
        "restore_guard_delete_authorized" $resumedRestore.posture
    $modifyCountBeforeMissingResume = $script:ModifyCalls.Count
    $script:FailRestoreDocument = $true
    $resumedAfterDelete = Invoke-DatabaseInsightsLease "Restore" "schoolpilot-production-db" $resumablePath `
        $resumableLease.receiptSha256 "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60
    $script:FailRestoreDocument = $false
    $resumedAfterDeleteStatus = Get-Content -LiteralPath "$resumablePath.status.json" -Raw | ConvertFrom-Json -Depth 20
    Assert-Condition ($resumedAfterDelete.state -ceq "restored" -and
        $script:ModifyCalls.Count -eq $modifyCountBeforeMissingResume -and
        $resumedAfterDeleteStatus.state -ceq "restored") `
        "A crash after guard deletion must resume from delete-authorized evidence and preserve terminal restoration."
    $assertions++

    $restoredStatus = Get-Content -LiteralPath "$receiptPath.status.json" -Raw | ConvertFrom-Json -Depth 20
    Assert-Condition ($restoredStatus.state -eq "restored" -and $restoredStatus.rawErrorPersisted -eq $false -and
        $restoredStatus.receiptSha256 -eq $acquired.receiptSha256) `
        "Restoration must seal a sanitized receipt-bound terminal journal."
    $assertions++

    foreach ($infrastructureFailure in @(
        [ordered]@{Name="execution role";Flag="FailRestoreInfrastructure"},
        [ordered]@{Name="DLQ encryption";Flag="FailRestoreQueueEncryption"},
        [ordered]@{Name="DLQ failure-signal retention";Flag="FailRestoreQueueRetention"},
        [ordered]@{Name="DLQ policy property set";Flag="FailRestoreQueuePolicyExtra"},
        [ordered]@{Name="DLQ TLS principal";Flag="FailRestoreQueueTlsPrincipal"},
        [ordered]@{Name="failure event property set";Flag="FailRestoreEventPatternExtra"},
        [ordered]@{Name="failure target property set";Flag="FailRestoreEventTargetExtra"},
        [ordered]@{Name="role permissions boundary";Flag="FailRestorePermissionsBoundary"},
        [ordered]@{Name="IAM statement property set";Flag="FailRestoreIamStatementExtra"},
        [ordered]@{Name="failure alarm";Flag="FailRestoreAlarm"},
        [ordered]@{Name="failure alarm unit";Flag="FailRestoreAlarmUnit"},
        [ordered]@{Name="automation document";Flag="FailRestoreDocument"}
    )) {
        $script:MockMode = "standard"; $script:MockRetention = 7
        Set-Variable -Scope Script -Name $infrastructureFailure.Flag -Value $true
        $infrastructureFailurePath = Join-Path $tempRoot "infrastructure-$($infrastructureFailure.Flag).json"
        $modifyCountBeforeInfrastructureFailure = $script:ModifyCalls.Count
        $infrastructureFailureRejected = $false
        try {
            Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" $infrastructureFailurePath "" "us-east-1" `
                "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
        }
        catch { $infrastructureFailureRejected = $_.Exception.Message -match "before RDS mutation" }
        $infrastructureFailureStatus = Get-Content -LiteralPath "$infrastructureFailurePath.status.json" -Raw | ConvertFrom-Json -Depth 20
        Assert-Condition ($infrastructureFailureRejected -and
            $script:ModifyCalls.Count -eq $modifyCountBeforeInfrastructureFailure -and
            $null -eq $script:MockSchedule -and $infrastructureFailureStatus.state -eq "acquire_failed_unmutated") `
            "Drifted $($infrastructureFailure.Name) infrastructure must block the lease before any RDS mutation."
        $assertions++
        Set-Variable -Scope Script -Name $infrastructureFailure.Flag -Value $false
    }

    $script:MockMode = "standard"; $script:MockRetention = 7; $script:FailScheduleCreate = $true
    $scheduleFailurePath = Join-Path $tempRoot "schedule-failure.json"
    $modifyCountBeforeScheduleFailure = $script:ModifyCalls.Count
    $scheduleFailureRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" $scheduleFailurePath "" "us-east-1" `
            "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $scheduleFailureRejected = $_.Exception.Message -match "before RDS mutation" }
    $scheduleFailureStatus = Get-Content -LiteralPath "$scheduleFailurePath.status.json" -Raw | ConvertFrom-Json -Depth 20
    Assert-Condition ($scheduleFailureRejected -and $script:ModifyCalls.Count -eq $modifyCountBeforeScheduleFailure -and
        $null -eq $script:MockSchedule -and $scheduleFailureStatus.state -eq "acquire_failed_unmutated" -and
        $scheduleFailureStatus.rawErrorPersisted -eq $false) `
        "A durable-schedule creation failure must fail closed before any RDS mutation and persist only sanitized evidence."
    $assertions++
    $script:FailScheduleCreate = $false

    $script:MockMode = "standard"; $script:MockRetention = 7; $script:FailAdvanced = $true
    $failedAcquirePath = Join-Path $tempRoot "failed-acquire.json"
    $acquireRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" $failedAcquirePath "" "us-east-1" `
            "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $acquireRejected = $_.Exception.Message -match "captured Standard/7 posture was restored" }
    Assert-Condition ($acquireRejected -and $script:MockMode -eq "standard" -and $script:MockRetention -eq 7) `
        "A failed Advanced acquisition must restore Standard/7 before returning failure."
    $assertions++
    $failedAcquireStatus = Get-Content -LiteralPath "$failedAcquirePath.status.json" -Raw | ConvertFrom-Json -Depth 20
    $failedAcquireJson = $failedAcquireStatus | ConvertTo-Json -Depth 20 -Compress
    Assert-Condition ($failedAcquireStatus.state -eq "acquire_failed_restored" -and
        $failedAcquireStatus.failureStage -eq "acquire" -and
        [string]$failedAcquireStatus.discardedMessageSha256 -match '^[0-9a-f]{64}$' -and
        $failedAcquireStatus.rawErrorPersisted -eq $false -and
        -not $failedAcquireJson.Contains("raw detail")) `
        "Acquisition failure evidence must be sanitized while proving restoration."
    $assertions++
    $script:FailAdvanced = $false

    $restoreFailurePath = Join-Path $tempRoot "restore-failure.json"
    $restoreFailureLease = Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" $restoreFailurePath "" "us-east-1" `
        "135775632425" "db.t4g.medium" "certification" 600 1 60
    $script:FailRestore = $true
    $restoreRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Restore" "schoolpilot-production-db" $restoreFailurePath $restoreFailureLease.receiptSha256 `
            "us-east-1" "135775632425" "db.t4g.medium" "certification" 600 1 60 | Out-Null
    }
    catch { $restoreRejected = $_.Exception.Message -match "progression are blocked" }
    Assert-Condition ($restoreRejected -and $script:MockMode -eq "advanced" -and $script:MockRetention -eq 465) `
        "A failed restoration must fail closed and leave no false restored claim."
    $assertions++
    $restoreFailureStatus = Get-Content -LiteralPath "$restoreFailurePath.status.json" -Raw | ConvertFrom-Json -Depth 20
    Assert-Condition ($restoreFailureStatus.state -eq "restore_automation_starting" -and
        $restoreFailureStatus.failureStage -eq "restore" -and
        $restoreFailureStatus.rawErrorPersisted -eq $false) `
        "A manual Automation start failure must preserve its pre-mutation journal, remain sanitized, and be explicit."
    $assertions++
    $script:FailRestore = $false
    [void](Invoke-DatabaseInsightsLease "Restore" "schoolpilot-production-db" $restoreFailurePath $restoreFailureLease.receiptSha256 `
        "us-east-1" "135775632425" "db.t4g.medium" "certification" 600 1 60)

    $automationFailurePath = Join-Path $tempRoot "automation-failure-after-mutation.json"
    $automationFailureLease = Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" `
        $automationFailurePath "" "us-east-1" "135775632425" "db.t4g.medium" "certification" 600 1 60
    $script:FailAutomationAfterMutation = $true
    $directMutationCountBeforeAutomationFailure = $script:ModifyCalls.Count
    $automationFailureRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Restore" "schoolpilot-production-db" $automationFailurePath `
            $automationFailureLease.receiptSha256 "us-east-1" "135775632425" "db.t4g.medium" `
            "certification" 600 1 60 | Out-Null
    }
    catch { $automationFailureRejected = $_.Exception.Message -match "progression are blocked" }
    $automationFailureStatus = Get-Content -LiteralPath "$automationFailurePath.status.json" -Raw | ConvertFrom-Json -Depth 20
    Assert-Condition ($automationFailureRejected -and $script:MockMode -eq "advanced" -and
        $script:MockRetention -eq 465 -and $null -ne $script:MockSchedule -and
        $script:MockSchedule.State -ceq "ENABLED" -and
        $script:ModifyCalls.Count -eq $directMutationCountBeforeAutomationFailure -and
        $automationFailureStatus.state -ceq "restore_automation_started" -and
        $script:OperationCalls -contains "ssm/rds/standard/7-started") `
        "A failed SSM restore after RDS mutation begins must leave the recurring guard enabled and retryable without any local mutation."
    $assertions++
    $script:FailAutomationAfterMutation = $false
    [void](Invoke-DatabaseInsightsLease "Restore" "schoolpilot-production-db" $automationFailurePath `
        $automationFailureLease.receiptSha256 "us-east-1" "135775632425" "db.t4g.medium" `
        "certification" 600 1 60)

    $expiredWatchdogPath = Join-Path $tempRoot "expired-watchdog.json"
    $expiredReceipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -Depth 40
    $expiredReceipt.leaseId = [Guid]::NewGuid().ToString("N")
    $expiredReceipt.capturedAtUtc = [DateTimeOffset]::UtcNow.AddMinutes(-2).ToString("o")
    $expiredRaw = [DateTimeOffset]::UtcNow.AddMinutes(-1).UtcDateTime.Ticks
    $expiredExpiration = [DateTimeOffset]::new([DateTime]::new(
        $expiredRaw - ($expiredRaw % [TimeSpan]::TicksPerSecond), [DateTimeKind]::Utc
    ))
    $expiredReceipt.expiresAtUtc = $expiredExpiration.ToString("o")
    $expiredReceipt.durableRestoreGuard = Get-DatabaseInsightsDurableRestoreGuardBinding `
        $expiredReceipt.initialPosture $expiredReceipt.accountId $expiredReceipt.region `
        $expiredReceipt.dbInstanceIdentifier $expiredReceipt.leaseId $expiredExpiration
    Write-DatabaseInsightsPrivateJson $expiredWatchdogPath $expiredReceipt -Immutable
    $expiredReceiptSha = Get-DatabaseInsightsFileSha256 $expiredWatchdogPath
    $script:MockMode = "advanced"; $script:MockRetention = 465
    Write-DatabaseInsightsLeaseStatus "$expiredWatchdogPath.status.json" $expiredReceiptSha "active" `
        (Get-DatabaseInsightsPosture "us-east-1" "schoolpilot-production-db")
    [void](New-DatabaseInsightsDurableRestoreSchedule $expiredReceipt.durableRestoreGuard)
    [void](Invoke-DatabaseInsightsLease "Watchdog" "schoolpilot-production-db" $expiredWatchdogPath $expiredReceiptSha `
        "us-east-1" "135775632425" "db.t4g.medium" "diagnostic" 90 1 60)
    $expiredHeartbeat = Read-DatabaseInsightsWatchdogHeartbeat "$expiredWatchdogPath.watchdog.json" `
        $expiredReceipt $expiredReceiptSha
    Assert-Condition ($script:MockMode -eq "standard" -and $script:MockRetention -eq 7 -and
        [string]$expiredHeartbeat.state -eq "restored") `
        "An expired detached watchdog must restore the exact captured Standard/7 posture."
    $assertions++

    $script:MockRetention = 465
    $wrongInitialPath = Join-Path $tempRoot "wrong-initial.json"
    $wrongInitialRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" $wrongInitialPath "" "us-east-1" `
            "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $wrongInitialRejected = $_.Exception.Message -match "exact healthy Database Insights standard/7 posture" }
    Assert-Condition ($wrongInitialRejected -and -not (Test-Path $wrongInitialPath)) `
        "Acquire must reject and avoid mutating a non-Standard/7 starting posture."
    $assertions++
    $script:MockRetention = 7

    $script:MockParameterStatus = "pending-reboot"
    $pendingRebootPath = Join-Path $tempRoot "pending-reboot.json"
    $pendingRebootRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" $pendingRebootPath "" "us-east-1" `
            "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $pendingRebootRejected = $_.Exception.Message -match "exact healthy Database Insights standard/7 posture" }
    Assert-Condition ($pendingRebootRejected -and -not (Test-Path $pendingRebootPath)) `
        "Acquire must reject a pending-reboot parameter posture."
    $assertions++
    $script:MockParameterStatus = "in-sync"

    $script:MockAccount = "000000000000"
    $wrongAccountPath = Join-Path $tempRoot "wrong-account.json"
    $wrongAccountRejected = $false
    try {
        Invoke-DatabaseInsightsLease "Acquire" "schoolpilot-production-db" $wrongAccountPath "" "us-east-1" `
            "135775632425" "db.t4g.medium" "diagnostic" 90 1 60 | Out-Null
    }
    catch { $wrongAccountRejected = $_.Exception.Message -match "not the expected" }
    Assert-Condition ($wrongAccountRejected -and -not (Test-Path $wrongAccountPath)) `
        "Acquire must reject the wrong AWS account before reading or mutating RDS."
    $assertions++
}
finally {
    if ($env:SCHOOLPILOT_KEEP_TEST_ARTIFACTS -eq "1") { Write-Host "Kept lease test artifacts: $tempRoot" }
    elseif (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

& python (Join-Path $PSScriptRoot "database-insights-restore-automation.test.py")
if ($LASTEXITCODE -ne 0) { throw "Database Insights restore Automation semantic tests failed." }

Write-Host "Database Insights monitoring lease tests passed ($assertions assertions)."
