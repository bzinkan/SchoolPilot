output "certificate_arn" {
  description = "Validated ACM certificate ARN (us-east-1, for CloudFront)"
  value       = aws_acm_certificate_validation.cloudfront.certificate_arn
}

output "primary_domain" {
  description = "Primary domain for this environment"
  value       = local.primary_domain
}

output "all_domains" {
  description = "All domains for this environment"
  value       = local.all_domains
}

output "zone_id" {
  value = data.aws_route53_zone.main.zone_id
}
