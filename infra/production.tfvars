# ============================================================================
# Production Environment Configuration
# ============================================================================

project     = "schoolpilot"
environment = "production"
aws_region  = "us-east-1"

# Networking
vpc_cidr           = "10.1.0.0/16"
az_count           = 2
enable_nat_gateway = true

# Database — pilot-cost posture for confirmed onboarding while schools are pending
db_instance_class        = "db.t4g.medium"
db_multi_az              = false
db_allocated_storage     = 100
db_max_allocated_storage = 1000
db_name                  = "schoolpilot"
db_username              = "schoolpilot"

# Redis
redis_node_type     = "cache.t4g.small"
redis_replica_count = 0

# ECS — scheduler work remains isolated; API runs single-task in pilot mode
ecs_desired_count     = 1
ecs_cpu               = 512
ecs_memory            = 1024
worker_desired_count  = 1
worker_cpu            = 256
worker_memory         = 512
db_pool_max           = 20
scheduler_db_pool_max = 5

# Domain — auto-creates ACM cert, DNS records, and derives app URLs
# Accessible at school-pilot.net + www.school-pilot.net
domain = "school-pilot.net"

# Existing SecureString parameters for optional runtime secrets that must not
# remain as plaintext ECS task environment values.
anthropic_api_key_parameter_arn  = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/ANTHROPIC_API_KEY"
telegram_bot_token_parameter_arn = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/TELEGRAM_BOT_TOKEN"
