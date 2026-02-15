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

output "rds_secret_arn" {
  description = "Secrets Manager ARN for RDS master password"
  value       = module.rds.master_user_secret_arn
}
