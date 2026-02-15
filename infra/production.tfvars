# ============================================================================
# Production Environment Configuration
# ============================================================================

project     = "schoolpilot"
environment = "production"
aws_region  = "us-east-1"

# Networking
vpc_cidr = "10.1.0.0/16"
az_count = 2

# Database — start small, scale up later
db_instance_class = "db.t4g.micro"
db_name           = "schoolpilot"
db_username       = "schoolpilot"

# Redis
redis_node_type = "cache.t4g.micro"

# ECS — single task to start, scale up later
ecs_desired_count = 1
ecs_cpu           = 256
ecs_memory        = 512

# Domain — auto-creates ACM cert, DNS records, and derives app URLs
# Accessible at school-pilot.net + www.school-pilot.net
domain = "school-pilot.net"
