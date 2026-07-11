# ============================================================================
# CDN Module — S3 + CloudFront for React Frontend
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
  # This is intentionally an unqualified same-context label key. AWS WAF
  # resolves unqualified LABEL matches against labels added in the same web
  # ACL; a fully qualified web-ACL prefix contains the account and ACL name,
  # not a rule-name namespace. See:
  # https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-label-match-examples.html
  device_ingest_label      = "device-ingest"
  device_ingest_path_regex = "^/api/(classpilot/)?device/(heartbeat|screenshot)$"
}

# --- S3 Bucket for Frontend ---

resource "aws_s3_bucket" "frontend" {
  bucket        = "${local.name}-frontend"
  force_destroy = var.environment != "production"

  tags = { Name = "${local.name}-frontend" }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

# --- CloudFront Origin Access Control ---

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.name}-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# --- S3 Bucket Policy (CloudFront only) ---

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFront"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.frontend.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
        }
      }
    }]
  })
}

# --- CloudFront Function: SPA route rewrite (default/S3 behavior only) ---

resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${local.name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  comment = "Rewrite extensionless SPA routes to /index.html (S3 behavior only)"
  code    = file("${path.module}/spa-rewrite.js")
}

# --- CloudFront Distribution ---

resource "aws_wafv2_web_acl" "main" {
  provider = aws.us_east_1

  name        = "${local.name}-cloudfront-waf"
  description = "Managed WAF protections for SchoolPilot CloudFront"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        # ClassPilot screenshot uploads are base64 JSON bodies and exceed the
        # managed common-rule body-size threshold; Express/auth still enforce
        # route size and identity checks before the upload is accepted.
        rule_action_override {
          name = "SizeRestrictions_BODY"

          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # Provider 5.100 cannot represent NOT(POST AND path) at this nesting depth.
  # Classify exact ingest requests once, then let both rate rules consume the
  # resulting same-context label without weakening the general API contract.
  rule {
    name     = "DeviceIngestClassifier"
    priority = 25

    action {
      count {}
    }

    statement {
      and_statement {
        statement {
          byte_match_statement {
            search_string = "POST"
            field_to_match {
              method {}
            }
            positional_constraint = "EXACTLY"
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }

        statement {
          regex_match_statement {
            regex_string = local.device_ingest_path_regex
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    rule_label {
      name = local.device_ingest_label
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-device-ingest-classifier"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "DeviceIngestRateLimit"
    priority = 30

    action {
      dynamic "block" {
        for_each = var.rate_rule_action == "block" ? [1] : []
        content {}
      }

      dynamic "count" {
        for_each = var.rate_rule_action == "count" ? [1] : []
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.device_ingest_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300

        scope_down_statement {
          label_match_statement {
            scope = "LABEL"
            key   = local.device_ingest_label
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-device-ingest-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "ApiRateLimit"
    priority = 40

    action {
      dynamic "block" {
        for_each = var.rate_rule_action == "block" ? [1] : []
        content {}
      }

      dynamic "count" {
        for_each = var.rate_rule_action == "count" ? [1] : []
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.api_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string = "/api/"
                field_to_match {
                  uri_path {}
                }
                positional_constraint = "STARTS_WITH"
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              not_statement {
                statement {
                  label_match_statement {
                    scope = "LABEL"
                    key   = local.device_ingest_label
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-api-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-waf"
    sampled_requests_enabled   = true
  }

  tags = { Name = "${local.name}-cloudfront-waf" }
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  comment             = "${local.name} frontend"
  price_class         = "PriceClass_100" # US, Canada, Europe
  web_acl_id          = aws_wafv2_web_acl.main.arn

  aliases = var.domain_aliases

  # S3 origin for frontend static files
  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # ALB origin for API calls
  origin {
    domain_name = var.api_domain
    origin_id   = "alb-api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = var.api_origin_protocol_policy
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default behavior → S3 (frontend)
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    # SPA deep links rewrite to /index.html here, scoped to the S3 behavior —
    # NOT via distribution-wide custom_error_response, which masked /api/*
    # errors as 200 + HTML.
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # /api/* → ALB (no caching)
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "alb-api"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Origin", "X-School-Id", "X-Kiosk-Pin", "Content-Type"]
      cookies { forward = "all" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  # /health → ALB
  ordered_cache_behavior {
    path_pattern           = "/health"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "alb-api"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  # /ws → ALB (WebSocket)
  ordered_cache_behavior {
    path_pattern           = "/ws"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "alb-api"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies { forward = "all" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  # /gopilot-socket → ALB (Socket.io)
  ordered_cache_behavior {
    path_pattern           = "/gopilot-socket/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "alb-api"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies { forward = "all" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.certificate_arn == ""
    acm_certificate_arn            = var.certificate_arn != "" ? var.certificate_arn : null
    ssl_support_method             = var.certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = var.certificate_arn != "" ? "TLSv1.2_2021" : null
  }

  tags = { Name = "${local.name}-cdn" }
}
