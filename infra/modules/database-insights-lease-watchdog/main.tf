locals {
  schedule_group_name             = "${var.name_prefix}-db-insights-leases"
  restore_role_name               = "${var.name_prefix}-db-insights-restore"
  automation_role_name            = "${var.name_prefix}-db-insights-restore-automation"
  automation_document_name        = "${var.name_prefix}-db-insights-restore-v2"
  automation_failure_rule_name    = "${var.name_prefix}-db-insights-restore-failed"
  restore_dlq_name                = "${var.name_prefix}-db-insights-restore-dlq"
  db_instance_identifier          = element(reverse(split(":", var.db_instance_arn)), 0)
  restore_schedule_name           = "db-insights-restore-${substr(sha256("${var.aws_account_id}|${var.aws_region}|${local.db_instance_identifier}"), 0, 24)}"
  restore_schedule_arn            = "arn:aws:scheduler:${var.aws_region}:${var.aws_account_id}:schedule/${local.schedule_group_name}/${local.restore_schedule_name}"
  automation_definition_arn       = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:automation-definition/${local.automation_document_name}:1"
  automation_execution_source_arn = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:automation-execution/*"
  automation_contract_version     = "ssm-rds-monitoring-restore-v2"
  posture_encoding_version        = "rds-preserved-monitoring-posture-json-v1"
  alarm_actions                   = compact([var.alerts_sns_topic_arn])

  automation_restore_script = file("${path.module}/restore_exact_monitoring_posture.py")

  automation_document = {
    schemaVersion = "0.3"
    description   = "Durably restore and verify the exact SchoolPilot production Database Insights Standard/7 posture."
    assumeRole    = "{{ AutomationAssumeRole }}"
    parameters = {
      AutomationAssumeRole = { type = "String" }
      DBInstanceIdentifier = {
        type          = "String"
        allowedValues = [local.db_instance_identifier]
      }
      ExpectedDBInstanceArn = {
        type          = "String"
        allowedValues = [var.db_instance_arn]
      }
      ExpectedDatabaseResourceId = { type = "String" }
      ExpectedDBInstanceClass    = { type = "String", allowedValues = [var.expected_db_instance_class] }
      ExpectedEngineVersion      = { type = "String" }
      PreservedMonitoringPostureEncodingVersion = {
        type          = "String"
        allowedValues = [local.posture_encoding_version]
      }
      ExpectedPreservedMonitoringPostureJson = {
        type           = "String"
        allowedPattern = "^\\{.+\\}$"
      }
      ExpectedPreservedMonitoringPostureSha256 = {
        type           = "String"
        allowedPattern = "^[0-9a-f]{64}$"
      }
      RestoreScheduleName = {
        type          = "String"
        allowedValues = [local.restore_schedule_name]
      }
      RestoreScheduleGroupName = {
        type          = "String"
        allowedValues = [local.schedule_group_name]
      }
      FailureQueueUrl = {
        type          = "String"
        allowedValues = [aws_sqs_queue.restore_dlq.url]
      }
      AutomationDocumentContentSha256 = {
        type           = "String"
        allowedPattern = "^[0-9a-f]{64}$"
      }
      LeaseIdSha256 = {
        type           = "String"
        allowedPattern = "^[0-9a-f]{64}$"
      }
      RestoreMode = {
        type          = "String"
        allowedValues = ["scheduled", "manual"]
      }
      ExpiresAtUtc = { type = "String" }
    }
    mainSteps = [
      {
        name           = "RestoreExactPosture"
        action         = "aws:executeScript"
        timeoutSeconds = 600
        onFailure      = "step:PublishRestoreFailure"
        nextStep       = "FinishRestoreSuccess"
        inputs = {
          Runtime = "python3.11"
          Handler = "handler"
          Script  = local.automation_restore_script
          InputPayload = {
            dbInstanceIdentifier                      = "{{ DBInstanceIdentifier }}"
            expectedDbInstanceArn                     = "{{ ExpectedDBInstanceArn }}"
            expectedDatabaseResourceId                = "{{ ExpectedDatabaseResourceId }}"
            expectedDbInstanceClass                   = "{{ ExpectedDBInstanceClass }}"
            expectedEngineVersion                     = "{{ ExpectedEngineVersion }}"
            preservedMonitoringPostureEncodingVersion = "{{ PreservedMonitoringPostureEncodingVersion }}"
            expectedPreservedMonitoringPostureJson    = "{{ ExpectedPreservedMonitoringPostureJson }}"
            expectedPreservedMonitoringPostureSha256  = "{{ ExpectedPreservedMonitoringPostureSha256 }}"
            restoreScheduleName                       = "{{ RestoreScheduleName }}"
            restoreScheduleGroupName                  = "{{ RestoreScheduleGroupName }}"
            automationContractVersion                 = local.automation_contract_version
            automationDocumentName                    = local.automation_document_name
            automationDocumentVersion                 = "1"
            automationDocumentContentSha256           = "{{ AutomationDocumentContentSha256 }}"
            leaseIdSha256                             = "{{ LeaseIdSha256 }}"
            expiresAtUtc                              = "{{ ExpiresAtUtc }}"
            restoreMode                               = "{{ RestoreMode }}"
            maximumEventAgeInSeconds                  = 60
          }
        }
      },
      {
        name           = "FinishRestoreSuccess"
        action         = "aws:executeScript"
        timeoutSeconds = 30
        onFailure      = "Abort"
        isEnd          = true
        inputs = {
          Runtime = "python3.11"
          Handler = "handler"
          Script  = "def handler(events, context):\n    return {'verified': True}\n"
        }
      },
      {
        name           = "PublishRestoreFailure"
        action         = "aws:executeAwsApi"
        timeoutSeconds = 60
        onFailure      = "Abort"
        nextStep       = "FailRestoreAutomation"
        inputs = {
          Service     = "sqs"
          Api         = "SendMessage"
          QueueUrl    = "{{ FailureQueueUrl }}"
          MessageBody = "database_insights_restore_automation_failed"
        }
      },
      {
        name           = "FailRestoreAutomation"
        action         = "aws:executeScript"
        timeoutSeconds = 30
        onFailure      = "Abort"
        isEnd          = true
        inputs = {
          Runtime = "python3.11"
          Handler = "handler"
          Script  = "def handler(events, context):\n    raise RuntimeError('database insights restoration failed')\n"
        }
      }
    ]
  }

  restore_dlq_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.restore_dlq.arn
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "AcceptFailedAutomationEvents"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.restore_dlq.arn
        Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.automation_failure.arn } }
      }
    ]
  })

  restore_assume_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SchedulerOnly"
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = aws_scheduler_schedule_group.restore.arn }
      }
    }]
  })

  automation_assume_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SsmAutomationOnly"
      Effect    = "Allow"
      Principal = { Service = "ssm.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = local.automation_execution_source_arn }
      }
    }]
  })

  restore_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StartExactRestoreAutomation"
        Effect   = "Allow"
        Action   = "ssm:StartAutomationExecution"
        Resource = local.automation_definition_arn
      },
      {
        Sid      = "PassExactRestoreAutomationRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.automation.arn
        Condition = {
          StringEquals = { "iam:PassedToService" = "ssm.amazonaws.com" }
        }
      },
      {
        Sid      = "PublishFailedInvocationToEncryptedDlq"
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.restore_dlq.arn
      }
    ]
  })

  automation_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ModifyExactDatabaseInsightsPosture"
        Effect   = "Allow"
        Action   = "rds:ModifyDBInstance"
        Resource = var.db_instance_arn
      },
      {
        Sid      = "DescribeDatabaseForExactVerification"
        Effect   = "Allow"
        Action   = "rds:DescribeDBInstances"
        Resource = "*"
        Condition = {
          StringEquals = { "aws:RequestedRegion" = var.aws_region }
        }
      },
      {
        Sid    = "ManageExactRestoreSchedule"
        Effect = "Allow"
        Action = [
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
          "scheduler:UpdateSchedule",
        ]
        Resource = local.restore_schedule_arn
      },
      {
        Sid      = "PassExactSchedulerRoleForDisarm"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.restore.arn
        Condition = {
          StringEquals = { "iam:PassedToService" = "scheduler.amazonaws.com" }
        }
      },
      {
        Sid      = "PublishRestoreFailureDirectly"
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.restore_dlq.arn
      }
    ]
  })
}

resource "aws_scheduler_schedule_group" "restore" {
  name = local.schedule_group_name

  tags = {
    Name    = local.schedule_group_name
    Purpose = "Bounded Database Insights restoration"
  }
}

resource "aws_sqs_queue" "restore_dlq" {
  name                      = local.restore_dlq_name
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = {
    Name    = local.restore_dlq_name
    Purpose = "Failed Database Insights restoration schedules or automations"
  }
}

resource "aws_cloudwatch_event_rule" "automation_failure" {
  name        = local.automation_failure_rule_name
  description = "Route terminal failures of the exact Database Insights restoration Automation to the alarmed DLQ."
  state       = "ENABLED"
  event_pattern = jsonencode({
    source        = ["aws.ssm"]
    "detail-type" = ["EC2 Automation Execution Status-change Notification"]
    detail = {
      Definition = [local.automation_document_name]
      Status     = ["Failed", "TimedOut", "Canceled"]
    }
  })
}

resource "aws_cloudwatch_event_target" "automation_failure_dlq" {
  rule      = aws_cloudwatch_event_rule.automation_failure.name
  target_id = "database-insights-automation-failure"
  arn       = aws_sqs_queue.restore_dlq.arn
}

resource "aws_sqs_queue_policy" "restore_dlq" {
  queue_url = aws_sqs_queue.restore_dlq.id
  policy    = local.restore_dlq_policy
}

resource "aws_iam_role" "automation" {
  name               = local.automation_role_name
  assume_role_policy = local.automation_assume_policy

  tags = {
    Name    = local.automation_role_name
    Purpose = "Durable Database Insights restoration convergence verifier"
  }
}

resource "aws_iam_role_policy" "automation" {
  name   = "database-insights-restore-automation"
  role   = aws_iam_role.automation.id
  policy = local.automation_policy
}

resource "aws_ssm_document" "restore" {
  name            = local.automation_document_name
  document_type   = "Automation"
  document_format = "JSON"
  content         = jsonencode(local.automation_document)

  tags = {
    Name    = local.automation_document_name
    Purpose = "Durable Database Insights restoration convergence verifier"
  }
}

resource "aws_iam_role" "restore" {
  name               = local.restore_role_name
  assume_role_policy = local.restore_assume_policy

  tags = {
    Name    = local.restore_role_name
    Purpose = "Launch recurring bounded Database Insights restoration Automation"
  }
}

resource "aws_iam_role_policy" "restore" {
  name   = "database-insights-restore"
  role   = aws_iam_role.restore.id
  policy = local.restore_policy
}

resource "aws_cloudwatch_metric_alarm" "restore_dlq" {
  alarm_name          = "${var.name_prefix}-scale-db-insights-restore-dlq"
  alarm_description   = "A durable Database Insights restoration schedule or SSM Automation failed; block progression and restore Standard/7 manually."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  period              = 60
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    QueueName = aws_sqs_queue.restore_dlq.name
  }
}
