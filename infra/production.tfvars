# ============================================================================
# Production Environment Configuration
# ============================================================================

project     = "schoolpilot"
environment = "production"
aws_region  = "us-east-1"

# Networking
vpc_cidr = "10.1.0.0/16"
az_count = 2
# Canonical Terraform-managed production baseline: ECS tasks remain private and
# NAT remains enabled. Future public-ECS and NAT-removal values belong in their
# separately reviewed phase plans/PRs and must not be preloaded here.
ecs_tasks_in_public_subnets = false
enable_nat_gateway          = true

# Database — pilot-cost posture for confirmed onboarding while schools are pending
db_instance_class        = "db.t4g.medium"
db_multi_az              = false
db_allocated_storage     = 100
db_max_allocated_storage = 1000
db_name                  = "schoolpilot"
db_username              = "schoolpilot"

# Redis — staged value: switch to cache.t4g.micro only after the manual snapshot,
# 800-device load, endurance, and subsequent automated-snapshot gates pass.
redis_node_type     = "cache.t4g.small"
redis_replica_count = 0

# ECS — scheduler work remains isolated; API runs single-task in pilot mode
ecs_desired_count = 1
# Six 512/2048 live API tasks are pre-warmed for the weekday arrival wave. The
# ordinary minimum remains one, and target tracking may scale up to eight. The
# live emergency revision remains selected independently because ECS task
# definitions are deliberately ignored by this staged Terraform profile.
enable_api_arrival_capacity     = true
api_arrival_min_capacity        = 6
api_max_capacity                = 8
api_arrival_scale_up_schedule   = "cron(45 5 ? * MON-FRI *)"
api_arrival_scale_down_schedule = "cron(0 10 ? * MON-FRI *)"
api_arrival_schedule_timezone   = "America/New_York"
ecs_cpu                         = 512
ecs_memory                      = 1024
worker_desired_count            = 1
worker_cpu                      = 256
worker_memory                   = 512
db_pool_max                     = 20
scheduler_db_pool_max           = 5
# Staged value: switch to false only after five stable live school days.
enable_container_insights = true

# Shared-school-IP WAF capacity: device ingest is isolated from all other API traffic.
waf_api_rate_limit           = 50000
waf_device_ingest_rate_limit = 100000
waf_rate_rule_action         = "block"

# Domain — auto-creates ACM cert, DNS records, and derives app URLs
# Accessible at school-pilot.net + www.school-pilot.net
domain = "school-pilot.net"
# Public OAuth identifier (not a secret). Pin it in the production profile so
# Terraform-generated task definitions cannot clear Google sign-in.
google_client_id = "562964657318-l7k0b7iuh0e16m88nqqvngs83eh3ddki.apps.googleusercontent.com"
# Canonical production baseline. Commit false only in the separately reviewed
# Route 53 phase after public-ECS and NAT-removal acceptance.
route53_measure_latency = true

# Alerts
alerts_sns_topic_arn = "arn:aws:sns:us-east-1:135775632425:schoolpilot-production-alerts"

# Existing SecureString parameters for optional runtime secrets that must not
# remain as plaintext ECS task environment values.
anthropic_api_key_parameter_arn  = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/ANTHROPIC_API_KEY"
telegram_bot_token_parameter_arn = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/TELEGRAM_BOT_TOKEN"
