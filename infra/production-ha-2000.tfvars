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
vpc_cidr           = "10.1.0.0/16"
az_count           = 2
enable_nat_gateway = true

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
ecs_desired_count     = 2
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
