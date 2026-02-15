# ============================================================================
# DNS Module — ACM Certificate + DNS Validation
# ============================================================================

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

locals {
  name = "${var.project}-${var.environment}"

  # Production gets apex + www; staging gets staging.domain
  is_production  = var.environment == "production"
  primary_domain = local.is_production ? var.domain : "${var.environment}.${var.domain}"
  all_domains    = local.is_production ? [var.domain, "www.${var.domain}"] : [local.primary_domain]
}

# --- Look up existing hosted zone ---

data "aws_route53_zone" "main" {
  name         = var.domain
  private_zone = false
}

# --- ACM Certificate (us-east-1, required for CloudFront) ---

resource "aws_acm_certificate" "cloudfront" {
  provider = aws.us_east_1

  domain_name               = local.all_domains[0]
  subject_alternative_names = length(local.all_domains) > 1 ? slice(local.all_domains, 1, length(local.all_domains)) : []
  validation_method         = "DNS"

  tags = { Name = "${local.name}-cloudfront-cert" }

  lifecycle {
    create_before_destroy = true
  }
}

# --- DNS validation records ---

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.record]

  allow_overwrite = true
}

# --- Wait for certificate validation ---

resource "aws_acm_certificate_validation" "cloudfront" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}
