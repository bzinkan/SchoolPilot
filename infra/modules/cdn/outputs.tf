output "bucket_name" {
  value = aws_s3_bucket.frontend.id
}

output "bucket_arn" {
  value = aws_s3_bucket.frontend.arn
}

output "distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.main.domain_name
}

output "cloudfront_hosted_zone_id" {
  value = aws_cloudfront_distribution.main.hosted_zone_id
}

output "web_acl_dimension_name" {
  description = "CloudWatch WebACL dimension value (the Web ACL resource name, not its visibility metric name)"
  value       = aws_wafv2_web_acl.main.name
}

output "api_rate_limit_metric_name" {
  value = "${local.name}-api-rate-limit"
}

output "device_ingest_rate_limit_metric_name" {
  value = "${local.name}-device-ingest-rate-limit"
}
