# ============================================================================
# ElastiCache Module — Redis
# ============================================================================

locals {
  name = "${var.project}-${var.environment}"
}

# --- Security Group ---

resource "aws_security_group" "redis" {
  name_prefix = "${local.name}-redis-"
  vpc_id      = var.vpc_id
  description = "Allow Redis from ECS tasks"

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.ecs_security_group_id]
    description     = "Redis from ECS"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-redis-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Subnet Group ---

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-redis"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "${local.name}-redis-subnet-group" }
}

# --- ElastiCache Serverless (cost-effective for variable load) ---

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name}-redis"
  description          = "SchoolPilot Redis for WebSocket pub/sub and sessions"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.node_type

  num_cache_clusters = 1

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = false

  automatic_failover_enabled = false

  snapshot_retention_limit = var.environment == "production" ? 3 : 0

  tags = { Name = "${local.name}-redis" }
}
