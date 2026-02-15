# ============================================================================
# RDS Module — PostgreSQL Database
# ============================================================================

locals {
  name = "${var.project}-${var.environment}"
}

# --- Security Group ---

resource "aws_security_group" "rds" {
  name_prefix = "${local.name}-rds-"
  vpc_id      = var.vpc_id
  description = "Allow PostgreSQL from ECS tasks"

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.ecs_security_group_id]
    description     = "PostgreSQL from ECS"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-rds-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Subnet Group ---

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "${local.name}-db-subnet-group" }
}

# --- RDS Instance ---

resource "aws_db_instance" "main" {
  identifier = "${local.name}-db"

  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.db_instance_class

  db_name  = var.db_name
  username = var.db_username
  manage_master_user_password = true

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az            = var.environment == "production"
  publicly_accessible = false

  backup_retention_period = var.environment == "production" ? 14 : 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  deletion_protection = var.environment == "production"
  skip_final_snapshot = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${local.name}-final-snapshot" : null

  performance_insights_enabled = true

  tags = { Name = "${local.name}-db" }
}

# --- Read managed password from Secrets Manager ---

data "aws_secretsmanager_secret_version" "rds_password" {
  secret_id = aws_db_instance.main.master_user_secret[0].secret_arn
}
