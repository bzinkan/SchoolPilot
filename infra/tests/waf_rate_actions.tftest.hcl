mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "000000000000"
      arn        = "arn:aws:iam::000000000000:user/terraform-test"
      user_id    = "terraform-test"
    }
  }

  mock_data "aws_region" {
    defaults = {
      name = "us-east-1"
    }
  }

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = {
      id   = "pl-00000000000000000"
      name = "com.amazonaws.global.cloudfront.origin-facing"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b"]
    }
  }
}

mock_provider "aws" {
  alias           = "us_east_1"
  override_during = plan
}

run "block_mode_renders_both_rate_rules" {
  command = plan

  module {
    source = "./modules/cdn"
  }

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    project          = "schoolpilot"
    environment      = "test"
    domain_name      = "schoolpilot.invalid"
    api_domain       = "api.schoolpilot.invalid"
    certificate_arn  = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
    rate_rule_action = "block"
  }

  assert {
    condition = alltrue([
      for rule in aws_wafv2_web_acl.main.rule :
      length(rule.action[0].block) == 1 && length(rule.action[0].count) == 0
      if contains(["DeviceIngestRateLimit", "ApiRateLimit"], rule.name)
    ])
    error_message = "Both WAF rate rules must render BLOCK in block mode."
  }

  assert {
    condition     = output.web_acl_dimension_name == "schoolpilot-test-cloudfront-waf"
    error_message = "The WAF alarm dimension must use the Web ACL resource name, not the visibility metric name."
  }

  assert {
    condition = alltrue([
      for rule in aws_wafv2_web_acl.main.rule :
      strcontains(jsonencode(rule.statement), "\"key\":\"device-ingest\"")
      if contains(["DeviceIngestRateLimit", "ApiRateLimit"], rule.name)
    ])
    error_message = "Both rate rules must consume the unqualified same-Web-ACL device-ingest label."
  }

  assert {
    condition = alltrue([
      for rule in aws_wafv2_web_acl.main.rule :
      one([for classifier in aws_wafv2_web_acl.main.rule : classifier.priority if classifier.name == "DeviceIngestClassifier"]) < rule.priority
      if contains(["DeviceIngestRateLimit", "ApiRateLimit"], rule.name)
    ])
    error_message = "The classifier must run before both rules that consume its label."
  }
}

run "count_mode_renders_both_rate_rules" {
  command = plan

  module {
    source = "./modules/cdn"
  }

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    project          = "schoolpilot"
    environment      = "test"
    domain_name      = "schoolpilot.invalid"
    api_domain       = "api.schoolpilot.invalid"
    certificate_arn  = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
    rate_rule_action = "count"
  }

  assert {
    condition = alltrue([
      for rule in aws_wafv2_web_acl.main.rule :
      length(rule.action[0].block) == 0 && length(rule.action[0].count) == 1
      if contains(["DeviceIngestRateLimit", "ApiRateLimit"], rule.name)
    ])
    error_message = "Both WAF rate rules must render COUNT in count mode."
  }
}

run "rejects_any_other_rate_rule_action" {
  command = plan

  module {
    source = "./modules/cdn"
  }

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    project          = "schoolpilot"
    environment      = "test"
    domain_name      = "schoolpilot.invalid"
    api_domain       = "api.schoolpilot.invalid"
    certificate_arn  = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
    rate_rule_action = "allow"
  }

  expect_failures = [var.rate_rule_action]
}
