# ============================================================================
# SchoolPilot Infrastructure — Main Configuration
# ============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment after first apply to enable remote state
  # backend "s3" {
  #   bucket         = "schoolpilot-terraform-state"
  #   key            = "infra/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "schoolpilot-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "SchoolPilot"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# For CloudFront ACM certificate (must be us-east-1)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "SchoolPilot"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# ============================================================================
# Data Sources
# ============================================================================

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name       = "${var.project}-${var.environment}"
  has_domain = var.domain != ""
}

# ============================================================================
# Shared Security Group for ECS tasks
# Created here to break circular dependency:
# ECS needs RDS/Redis URLs, RDS/Redis need ECS SG for ingress rules
# ============================================================================

resource "aws_security_group" "ecs_tasks" {
  name_prefix = "${local.name}-ecs-"
  vpc_id      = module.vpc.vpc_id
  description = "Security group for ECS Fargate tasks"

  ingress {
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [module.alb.security_group_id]
    description     = "API port from ALB"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-ecs-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

# ============================================================================
# Modules
# ============================================================================

module "vpc" {
  source = "./modules/vpc"

  project     = var.project
  environment = var.environment
  vpc_cidr    = var.vpc_cidr
  az_count    = var.az_count
}

module "ecr" {
  source = "./modules/ecr"

  project     = var.project
  environment = var.environment
}

module "rds" {
  source = "./modules/rds"

  project            = var.project
  environment        = var.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  db_instance_class  = var.db_instance_class
  db_name            = var.db_name
  db_username        = var.db_username
  ecs_security_group_id = aws_security_group.ecs_tasks.id
}

module "redis" {
  source = "./modules/redis"

  project            = var.project
  environment        = var.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  node_type          = var.redis_node_type
  ecs_security_group_id = aws_security_group.ecs_tasks.id
}

module "dns" {
  count  = local.has_domain ? 1 : 0
  source = "./modules/dns"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  project     = var.project
  environment = var.environment
  domain      = var.domain
}

module "alb" {
  source = "./modules/alb"

  project           = var.project
  environment       = var.environment
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  certificate_arn   = ""
  health_check_path = "/health"
}

module "ecs" {
  source = "./modules/ecs"

  project            = var.project
  environment        = var.environment
  aws_region         = var.aws_region
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  alb_target_group_arn = module.alb.target_group_arn
  ecr_repository_url = module.ecr.repository_url
  container_port     = 4000
  ecs_security_group_id = aws_security_group.ecs_tasks.id

  # Environment variables for the API
  database_url         = module.rds.database_url
  redis_url            = module.redis.redis_url
  session_secret       = var.session_secret
  jwt_secret           = var.jwt_secret
  student_token_secret = var.student_token_secret

  # Auto-derive URLs from domain, with manual override
  public_base_url = local.has_domain ? "https://${module.dns[0].primary_domain}/api" : var.public_base_url
  cors_allowlist  = local.has_domain ? "https://${module.dns[0].primary_domain}" : var.cors_allowlist
  cookie_domain   = local.has_domain ? ".${var.domain}" : var.cookie_domain

  # Google OAuth
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
  google_oauth_encryption_key = var.google_oauth_encryption_key

  # Optional services
  sendgrid_api_key   = var.sendgrid_api_key
  stripe_secret_key  = var.stripe_secret_key
  stripe_webhook_secret = var.stripe_webhook_secret

  # Scaling
  desired_count = var.ecs_desired_count
  cpu           = var.ecs_cpu
  memory        = var.ecs_memory
}

module "cdn" {
  source = "./modules/cdn"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  project         = var.project
  environment     = var.environment
  domain_name     = local.has_domain ? module.dns[0].primary_domain : ""
  api_domain      = module.alb.alb_dns_name
  certificate_arn = local.has_domain ? module.dns[0].certificate_arn : ""
}

# ============================================================================
# Route 53 records → CloudFront
# (Defined here to avoid circular dependency between DNS and CDN modules)
# ============================================================================

resource "aws_route53_record" "cloudfront_a" {
  for_each = local.has_domain ? toset(module.dns[0].all_domains) : toset([])

  zone_id = module.dns[0].zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = module.cdn.cloudfront_domain
    zone_id                = module.cdn.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "cloudfront_aaaa" {
  for_each = local.has_domain ? toset(module.dns[0].all_domains) : toset([])

  zone_id = module.dns[0].zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = module.cdn.cloudfront_domain
    zone_id                = module.cdn.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
}
