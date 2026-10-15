mock_provider "aws" { override_during = plan }
mock_provider "aws" {
  alias           = "us_east_1"
  override_during = plan
}

run "same_origin_api_and_sockets_filter_sibling_session_cookies" {
  command = plan
  module { source = "./modules/cdn" }
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  variables {
    project                = "schoolpilot"
    environment            = "staging"
    domain_name            = "staging.school-pilot.net"
    api_domain             = "api-origin.staging.school-pilot.net"
    certificate_arn        = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
    forwarded_cookie_names = ["schoolpilot.staging.sid", "AWSALB", "AWSALBCORS"]
  }
  assert {
    condition = alltrue([
      for behavior in aws_cloudfront_distribution.main.ordered_cache_behavior :
      behavior.target_origin_id == "alb-api" && behavior.max_ttl == 0 &&
      behavior.forwarded_values[0].cookies[0].forward == "whitelist" &&
      toset(behavior.forwarded_values[0].cookies[0].whitelisted_names) == toset(["schoolpilot.staging.sid", "AWSALB", "AWSALBCORS"])
      if contains(["/api/*", "/ws", "/gopilot-socket/*"], behavior.path_pattern)
    ])
    error_message = "Same-origin staging API/socket routes must never forward the production session cookie or cache responses."
  }
  assert {
    condition     = one([for behavior in aws_cloudfront_distribution.main.ordered_cache_behavior : toset(behavior.forwarded_values[0].headers) == toset(["*"]) if behavior.path_pattern == "/api/*"])
    error_message = "The staging route must forward CSRF, enrollment, capability and authorization headers."
  }
}
