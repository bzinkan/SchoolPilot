# ============================================================================
# SchoolPilot Infrastructure — Outputs
# ============================================================================

output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "ecr_repository_url" {
  description = "ECR repository URL for docker push"
  value       = module.ecr.repository_url
}

output "alb_dns_name" {
  description = "ALB DNS name (API endpoint)"
  value       = module.alb.alb_dns_name
}

output "rds_endpoint" {
  description = "RDS endpoint"
  value       = module.rds.endpoint
  sensitive   = true
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  value       = module.redis.endpoint
}

output "frontend_bucket" {
  description = "S3 bucket for frontend static files"
  value       = module.cdn.bucket_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = module.cdn.distribution_id
}

output "cloudfront_domain" {
  description = "CloudFront domain name"
  value       = module.cdn.cloudfront_domain
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = module.ecs.cluster_name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = module.ecs.service_name
}

output "site_url" {
  description = "Live site URL"
  value       = var.domain != "" ? "https://${module.dns[0].primary_domain}" : "https://${module.cdn.cloudfront_domain}"
}

output "classpilot_turn_hostnames" {
  description = "ClassPilot TURN nodes; empty until the dark infrastructure flag is enabled"
  value       = try(module.turn[0].hostnames, [])
}

output "classpilot_turn_elastic_ips" {
  description = "Elastic IPs for the ClassPilot TURN nodes"
  value       = try(module.turn[0].elastic_ips, [])
}

output "classpilot_turn_rest_secret_arn" {
  description = "ARN only; the generated TURN REST secret never enters Terraform state"
  value       = try(module.turn[0].rest_secret_arn, null)
}

output "classpilot_turn_dashboard_name" {
  description = "CloudWatch dashboard for identifier-free TURN and Live View telemetry"
  value       = try(module.turn[0].dashboard_name, null)
}

output "database_insights_restore_schedule_group" {
  description = "AWS Scheduler group used for bounded Database Insights restoration leases"
  value       = try(module.database_insights_lease_watchdog[0].schedule_group_name, null)
}

output "database_insights_restore_role_arn" {
  description = "Least-privilege role assumed by Database Insights restoration schedules"
  value       = try(module.database_insights_lease_watchdog[0].restore_role_arn, null)
}

output "database_insights_restore_dlq_arn" {
  description = "Encrypted dead-letter queue for failed Database Insights restoration schedules"
  value       = try(module.database_insights_lease_watchdog[0].restore_dlq_arn, null)
}

output "database_insights_restore_automation_document" {
  description = "SSM Automation document that waits for and verifies exact Database Insights restoration"
  value       = try(module.database_insights_lease_watchdog[0].automation_document_name, null)
}

output "database_insights_restore_automation_document_version" {
  description = "Pinned numeric version of the production Database Insights restoration Automation"
  value       = try(module.database_insights_lease_watchdog[0].automation_document_version, null)
}

output "database_insights_restore_automation_document_content_sha256" {
  description = "SHA-256 of the exact production Database Insights restoration Automation content"
  value       = try(module.database_insights_lease_watchdog[0].automation_document_content_sha256, null)
}

output "database_insights_restore_automation_role_arn" {
  description = "Least-privilege role assumed by the durable restoration Automation"
  value       = try(module.database_insights_lease_watchdog[0].automation_role_arn, null)
}

output "database_insights_restore_failure_rule_arn" {
  description = "EventBridge rule routing restoration Automation failures to the encrypted alarmed DLQ"
  value       = try(module.database_insights_lease_watchdog[0].automation_failure_rule_arn, null)
}

