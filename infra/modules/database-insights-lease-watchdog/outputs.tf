output "schedule_group_name" {
  value = aws_scheduler_schedule_group.restore.name
}

output "restore_role_arn" {
  value = aws_iam_role.restore.arn
}

output "restore_dlq_arn" {
  value = aws_sqs_queue.restore_dlq.arn
}

output "automation_document_name" {
  value = aws_ssm_document.restore.name
}

output "automation_document_version" {
  value = aws_ssm_document.restore.document_version
}

output "automation_document_content_sha256" {
  value = sha256(aws_ssm_document.restore.content)
}

output "automation_role_arn" {
  value = aws_iam_role.automation.arn
}

output "automation_failure_rule_arn" {
  value = aws_cloudwatch_event_rule.automation_failure.arn
}
