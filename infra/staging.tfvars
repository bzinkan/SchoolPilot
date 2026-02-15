# ============================================================================
# Staging Environment Configuration
# ============================================================================

project     = "schoolpilot"
environment = "staging"
aws_region  = "us-east-1"

# Networking
vpc_cidr = "10.0.0.0/16"
az_count = 2

# Database — start small for testing
db_instance_class = "db.t4g.micro"
db_name           = "schoolpilot"
db_username       = "schoolpilot"

# Redis
redis_node_type = "cache.t4g.micro"

# ECS — minimal for staging
ecs_desired_count = 1
ecs_cpu           = 256
ecs_memory        = 512

# Domain — auto-creates ACM cert, DNS records, and derives app URLs
# Staging will be accessible at staging.school-pilot.net
domain = "school-pilot.net"
