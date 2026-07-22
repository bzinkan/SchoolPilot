mock_provider "aws" {
  override_during = plan

  mock_resource "aws_scheduler_schedule_group" {
    defaults = {
      arn = "arn:aws:scheduler:us-east-1:135775632425:schedule-group/schoolpilot-production-db-insights-leases"
    }
  }

  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-1:135775632425:schoolpilot-production-db-insights-restore-dlq"
      id  = "https://sqs.us-east-1.amazonaws.com/135775632425/schoolpilot-production-db-insights-restore-dlq"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore"
      id  = "schoolpilot-production-db-insights-restore"
    }
  }

  mock_resource "aws_cloudwatch_event_rule" {
    defaults = {
      arn = "arn:aws:events:us-east-1:135775632425:rule/schoolpilot-production-db-insights-restore-failed"
    }
  }
}

run "durable_restore_is_exact_encrypted_and_alerted" {
  command = plan

  module {
    source = "./modules/database-insights-lease-watchdog"
  }

  variables {
    name_prefix          = "schoolpilot-production"
    aws_region           = "us-east-1"
    aws_account_id       = "135775632425"
    db_instance_arn      = "arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db"
    alerts_sns_topic_arn = "arn:aws:sns:us-east-1:135775632425:schoolpilot-production-alerts"
  }

  override_resource {
    target          = aws_iam_role.restore
    override_during = plan
    values = {
      arn = "arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore"
      id  = "schoolpilot-production-db-insights-restore"
    }
  }

  override_resource {
    target          = aws_iam_role.automation
    override_during = plan
    values = {
      arn = "arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore-automation"
      id  = "schoolpilot-production-db-insights-restore-automation"
    }
  }

  assert {
    condition = (
      aws_scheduler_schedule_group.restore.name == "schoolpilot-production-db-insights-leases" &&
      aws_sqs_queue.restore_dlq.sqs_managed_sse_enabled &&
      aws_sqs_queue.restore_dlq.message_retention_seconds == 1209600
    )
    error_message = "The durable restore group must use the deterministic name and its DLQ must remain encrypted with maximum retention."
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.restore.policy).Statement) == 3 &&
      one([
        for statement in jsondecode(aws_iam_role_policy.restore.policy).Statement : statement
        if statement.Sid == "StartExactRestoreAutomation"
      ]).Action == "ssm:StartAutomationExecution" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.restore.policy).Statement : statement
        if statement.Sid == "StartExactRestoreAutomation"
      ]).Resource == "arn:aws:ssm:us-east-1:135775632425:automation-definition/schoolpilot-production-db-insights-restore-v2:1" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.restore.policy).Statement : statement
        if statement.Sid == "PassExactRestoreAutomationRole"
      ]).Resource == "arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore-automation" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.restore.policy).Statement : statement
        if statement.Sid == "PassExactRestoreAutomationRole"
      ]).Condition.StringEquals["iam:PassedToService"] == "ssm.amazonaws.com"
    )
    error_message = "The Scheduler role may only launch the exact durable Automation, pass its exact role, and publish launch failures."
  }

  assert {
    condition = one([
      for statement in jsondecode(aws_iam_role_policy.restore.policy).Statement : statement
      if statement.Sid == "PublishFailedInvocationToEncryptedDlq"
      ]).Action == "sqs:SendMessage" && one([
      for statement in jsondecode(aws_iam_role_policy.restore.policy).Statement : statement
      if statement.Sid == "PublishFailedInvocationToEncryptedDlq"
    ]).Resource == aws_sqs_queue.restore_dlq.arn
    error_message = "The Scheduler role may publish failed invocations only to the dedicated encrypted DLQ."
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.automation.policy).Statement) == 5 &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "ModifyExactDatabaseInsightsPosture"
      ]).Action == "rds:ModifyDBInstance" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "ModifyExactDatabaseInsightsPosture"
      ]).Resource == "arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "DescribeDatabaseForExactVerification"
      ]).Action == "rds:DescribeDBInstances" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "DescribeDatabaseForExactVerification"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-1" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "ManageExactRestoreSchedule"
      ]).Action == ["scheduler:DeleteSchedule", "scheduler:GetSchedule", "scheduler:UpdateSchedule"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "ManageExactRestoreSchedule"
      ]).Resource == "arn:aws:scheduler:us-east-1:135775632425:schedule/schoolpilot-production-db-insights-leases/db-insights-restore-e29866227184b29a3b050565" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "PassExactSchedulerRoleForDisarm"
      ]).Resource == "arn:aws:iam::135775632425:role/schoolpilot-production-db-insights-restore" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "PassExactSchedulerRoleForDisarm"
      ]).Condition.StringEquals["iam:PassedToService"] == "scheduler.amazonaws.com" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "PublishRestoreFailureDirectly"
      ]).Action == "sqs:SendMessage" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.automation.policy).Statement : statement
        if statement.Sid == "PublishRestoreFailureDirectly"
      ]).Resource == aws_sqs_queue.restore_dlq.arn
    )
    error_message = "The Automation role must be limited to exact RDS mutation, region-scoped verification, exact guard-generation reads, and direct failure publication."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.restore_dlq.metric_name == "ApproximateNumberOfMessagesVisible" &&
      aws_cloudwatch_metric_alarm.restore_dlq.threshold == 0 &&
      aws_cloudwatch_metric_alarm.restore_dlq.unit == null &&
      aws_cloudwatch_metric_alarm.restore_dlq.treat_missing_data == "notBreaching" &&
      length(aws_cloudwatch_metric_alarm.restore_dlq.alarm_actions) == 1 &&
      contains(aws_cloudwatch_metric_alarm.restore_dlq.alarm_actions, "arn:aws:sns:us-east-1:135775632425:schoolpilot-production-alerts") &&
      length(aws_cloudwatch_metric_alarm.restore_dlq.ok_actions) == 1 &&
      contains(aws_cloudwatch_metric_alarm.restore_dlq.ok_actions, "arn:aws:sns:us-east-1:135775632425:schoolpilot-production-alerts")
    )
    error_message = "Any durable restore failure must alarm the existing operational SNS topic."
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role.restore.assume_role_policy).Statement) == 1 &&
      one([
        for statement in jsondecode(aws_iam_role.restore.assume_role_policy).Statement : statement
        if statement.Sid == "SchedulerOnly"
      ]).Principal.Service == "scheduler.amazonaws.com" &&
      one([
        for statement in jsondecode(aws_iam_role.restore.assume_role_policy).Statement : statement
        if statement.Sid == "SchedulerOnly"
      ]).Condition.StringEquals["aws:SourceAccount"] == "135775632425" &&
      one([
        for statement in jsondecode(aws_iam_role.restore.assume_role_policy).Statement : statement
        if statement.Sid == "SchedulerOnly"
      ]).Condition.ArnLike["aws:SourceArn"] == "arn:aws:scheduler:us-east-1:135775632425:schedule-group/schoolpilot-production-db-insights-leases"
    )
    error_message = "Only AWS Scheduler may assume the durable restore role."
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role.automation.assume_role_policy).Statement) == 1 &&
      jsondecode(aws_iam_role.automation.assume_role_policy).Statement[0].Principal.Service == "ssm.amazonaws.com" &&
      jsondecode(aws_iam_role.automation.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "135775632425" &&
      jsondecode(aws_iam_role.automation.assume_role_policy).Statement[0].Condition.ArnLike["aws:SourceArn"] == "arn:aws:ssm:us-east-1:135775632425:automation-execution/*"
    )
    error_message = "Only account-bound SSM Automation executions may assume the verifier role."
  }

  assert {
    condition = (
      aws_ssm_document.restore.document_type == "Automation" &&
      aws_ssm_document.restore.name == "schoolpilot-production-db-insights-restore-v2" &&
      jsondecode(aws_ssm_document.restore.content).schemaVersion == "0.3" &&
      length(jsondecode(aws_ssm_document.restore.content).mainSteps) == 4 &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].name == "RestoreExactPosture" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].action == "aws:executeScript" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].timeoutSeconds == 600 &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].onFailure == "step:PublishRestoreFailure" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].nextStep == "FinishRestoreSuccess" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.InputPayload.automationContractVersion == "ssm-rds-monitoring-restore-v2" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.InputPayload.automationDocumentVersion == "1" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.InputPayload.restoreMode == "{{ RestoreMode }}" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.InputPayload.preservedMonitoringPostureEncodingVersion == "{{ PreservedMonitoringPostureEncodingVersion }}" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.InputPayload.expectedPreservedMonitoringPostureJson == "{{ ExpectedPreservedMonitoringPostureJson }}" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.InputPayload.expectedPreservedMonitoringPostureSha256 == "{{ ExpectedPreservedMonitoringPostureSha256 }}" &&
      toset(keys(jsondecode(aws_ssm_document.restore.content).parameters)) == toset([
        "AutomationAssumeRole",
        "AutomationDocumentContentSha256",
        "DBInstanceIdentifier",
        "ExpectedDBInstanceArn",
        "ExpectedDBInstanceClass",
        "ExpectedDatabaseResourceId",
        "ExpectedEngineVersion",
        "ExpectedPreservedMonitoringPostureJson",
        "ExpectedPreservedMonitoringPostureSha256",
        "ExpiresAtUtc",
        "FailureQueueUrl",
        "LeaseIdSha256",
        "PreservedMonitoringPostureEncodingVersion",
        "RestoreMode",
        "RestoreScheduleGroupName",
        "RestoreScheduleName",
      ]) &&
      jsondecode(aws_ssm_document.restore.content).parameters.PreservedMonitoringPostureEncodingVersion.allowedValues[0] == "rds-preserved-monitoring-posture-json-v1" &&
      !contains(keys(jsondecode(aws_ssm_document.restore.content).parameters), "ExpectedPerformanceInsightsKmsKeyId") &&
      !contains(keys(jsondecode(aws_ssm_document.restore.content).parameters), "ExpectedMonitoringInterval") &&
      !contains(keys(jsondecode(aws_ssm_document.restore.content).parameters), "ExpectedMonitoringRoleArn") &&
      !contains(keys(jsondecode(aws_ssm_document.restore.content).parameters), "ExpectedLogExportsJson") &&
      toset(jsondecode(aws_ssm_document.restore.content).parameters.RestoreMode.allowedValues) == toset(["manual", "scheduled"]) &&
      strcontains(jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.Script, "PendingModifiedValues") &&
      strcontains(jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.Script, "time.monotonic()") &&
      strcontains(jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.Script, "scheduler.get_schedule") &&
      strcontains(jsondecode(aws_ssm_document.restore.content).mainSteps[0].inputs.Script, "leaseIdSha256") &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[1].name == "FinishRestoreSuccess" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[1].isEnd &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[2].name == "PublishRestoreFailure" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[2].nextStep == "FailRestoreAutomation" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[2].inputs.MessageBody == "database_insights_restore_automation_failed" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[3].name == "FailRestoreAutomation" &&
      jsondecode(aws_ssm_document.restore.content).mainSteps[3].isEnd
    )
    error_message = "The bounded Automation must generation-check the recurring guard, restore Standard/7 idempotently, verify convergence, publish failure directly, and terminate failed executions explicitly."
  }

  assert {
    condition = (
      jsondecode(aws_cloudwatch_event_rule.automation_failure.event_pattern).detail.Definition[0] == "schoolpilot-production-db-insights-restore-v2" &&
      toset(jsondecode(aws_cloudwatch_event_rule.automation_failure.event_pattern).detail.Status) == toset(["Failed", "TimedOut", "Canceled"])
    )
    error_message = "The secondary EventBridge failure route must match only the exact Automation and canonical terminal failure statuses."
  }

  assert {
    condition = (
      length(jsondecode(aws_sqs_queue_policy.restore_dlq.policy).Statement) == 2 &&
      jsondecode(aws_sqs_queue_policy.restore_dlq.policy).Statement[0].Effect == "Deny" &&
      jsondecode(aws_sqs_queue_policy.restore_dlq.policy).Statement[0].Principal.AWS == "*" &&
      jsondecode(aws_sqs_queue_policy.restore_dlq.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false" &&
      one([
        for statement in jsondecode(aws_sqs_queue_policy.restore_dlq.policy).Statement : statement
        if statement.Sid == "AcceptFailedAutomationEvents"
      ]).Principal.Service == "events.amazonaws.com" &&
      one([
        for statement in jsondecode(aws_sqs_queue_policy.restore_dlq.policy).Statement : statement
        if statement.Sid == "AcceptFailedAutomationEvents"
      ]).Condition.ArnEquals["aws:SourceArn"] == "arn:aws:events:us-east-1:135775632425:rule/schoolpilot-production-db-insights-restore-failed" &&
      aws_cloudwatch_event_target.automation_failure_dlq.arn == aws_sqs_queue.restore_dlq.arn
    )
    error_message = "The durable restore DLQ must reject unencrypted transport and receive only exact Automation failures."
  }
}
