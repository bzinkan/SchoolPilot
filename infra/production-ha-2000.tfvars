# ============================================================================
# Production HA Scale-Up Profile
# ============================================================================
#
# Use these values when broad ClassPilot onboarding is ready to resume and the
# 500/1,000/2,000 active-device load gate is being prepared.

project     = "schoolpilot"
environment = "production"
aws_region  = "us-east-1"

# Networking
vpc_cidr                    = "10.1.0.0/16"
az_count                    = 2
ecs_tasks_in_public_subnets = false
enable_nat_gateway          = true

# Database — standard HA posture for the 2,000 active-device gate
db_instance_class        = "db.t4g.large"
db_multi_az              = true
db_allocated_storage     = 100
db_max_allocated_storage = 1000
db_name                  = "schoolpilot"
db_username              = "schoolpilot"

# Redis
redis_node_type     = "cache.t4g.small"
redis_replica_count = 1

# ECS — scheduler work runs in the singleton worker, so the API can scale out safely
ecs_desired_count           = 2
enable_api_arrival_capacity = false
ecs_cpu                     = 512
ecs_memory                  = 1024
worker_desired_count        = 1
worker_cpu                  = 256
worker_memory               = 512
db_pool_max                 = 20
scheduler_db_pool_max       = 5
enable_container_insights   = true

# Shared-school-IP WAF capacity remains compatible with the launch profile.
waf_api_rate_limit           = 50000
waf_device_ingest_rate_limit = 100000
waf_rate_rule_action         = "block"

# Domain — auto-creates ACM cert, DNS records, and derives app URLs
# Accessible at school-pilot.net + www.school-pilot.net
domain                  = "school-pilot.net"
route53_measure_latency = true

# Alerts
alerts_sns_topic_arn = "arn:aws:sns:us-east-1:135775632425:schoolpilot-production-alerts"

# Existing SecureString parameters for optional runtime secrets that must not
# remain as plaintext ECS task environment values.
anthropic_api_key_parameter_arn  = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/ANTHROPIC_API_KEY"
telegram_bot_token_parameter_arn = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/TELEGRAM_BOT_TOKEN"
