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
  name             = "${var.project}-${var.environment}"
  has_domain       = var.domain != ""
  frontend_domains = local.has_domain ? [for domain in module.dns[0].all_domains : domain if domain != module.dns[0].api_origin_domain] : []
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

  project            = var.project
  environment        = var.environment
  vpc_cidr           = var.vpc_cidr
  az_count           = var.az_count
  enable_nat_gateway = var.enable_nat_gateway
}

module "ecr" {
  source = "./modules/ecr"

  project     = var.project
  environment = var.environment
}

module "rds" {
  source = "./modules/rds"

  project               = var.project
  environment           = var.environment
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  db_instance_class     = var.db_instance_class
  db_name               = var.db_name
  db_username           = var.db_username
  multi_az              = var.db_multi_az
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  db_apply_immediately  = var.db_apply_immediately
  ecs_security_group_id = aws_security_group.ecs_tasks.id
}

module "redis" {
  source = "./modules/redis"

  project               = var.project
  environment           = var.environment
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  node_type             = var.redis_node_type
  replica_count         = var.redis_replica_count
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
  enable_https      = local.has_domain
  certificate_arn   = local.has_domain ? module.dns[0].certificate_arn : ""
  health_check_path = "/livez"
}

module "ecs" {
  source = "./modules/ecs"

  project               = var.project
  environment           = var.environment
  aws_region            = var.aws_region
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  alb_target_group_arn  = module.alb.target_group_arn
  ecr_repository_url    = module.ecr.repository_url
  container_port        = 4000
  ecs_security_group_id = aws_security_group.ecs_tasks.id

  # Environment variables for the API
  database_url         = var.database_url
  redis_url            = module.redis.redis_url
  session_secret       = var.session_secret
  jwt_secret           = var.jwt_secret
  student_token_secret = var.student_token_secret

  # Auto-derive URLs from domain, with manual override
  public_base_url = local.has_domain ? "https://${module.dns[0].primary_domain}" : var.public_base_url
  cors_allowlist  = local.has_domain ? "https://${module.dns[0].primary_domain}" : var.cors_allowlist
  cookie_domain   = local.has_domain ? ".${var.domain}" : var.cookie_domain

  # Google OAuth
  google_client_id            = var.google_client_id
  google_client_secret        = var.google_client_secret
  google_oauth_encryption_key = var.google_oauth_encryption_key

  # Optional services
  sendgrid_api_key      = var.sendgrid_api_key
  stripe_secret_key     = var.stripe_secret_key
  stripe_webhook_secret = var.stripe_webhook_secret
  openai_api_key        = var.openai_api_key

  # Existing SecureString parameters managed outside Terraform tfvars.
  anthropic_api_key_parameter_arn  = var.anthropic_api_key_parameter_arn
  telegram_bot_token_parameter_arn = var.telegram_bot_token_parameter_arn

  # Scaling
  desired_count         = var.ecs_desired_count
  cpu                   = var.ecs_cpu
  memory                = var.ecs_memory
  worker_desired_count  = var.worker_desired_count
  worker_cpu            = var.worker_cpu
  worker_memory         = var.worker_memory
  db_pool_max           = var.db_pool_max
  scheduler_db_pool_max = var.scheduler_db_pool_max
  rls_enabled_tables    = var.rls_enabled_tables
}

module "cdn" {
  source = "./modules/cdn"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  project                    = var.project
  environment                = var.environment
  domain_name                = local.has_domain ? module.dns[0].primary_domain : ""
  domain_aliases             = local.frontend_domains
  api_domain                 = local.has_domain ? module.dns[0].api_origin_domain : module.alb.alb_dns_name
  certificate_arn            = local.has_domain ? module.dns[0].certificate_arn : ""
  api_origin_protocol_policy = local.has_domain ? "https-only" : "http-only"
}

# ============================================================================
# Route 53 records → CloudFront
# (Defined here to avoid circular dependency between DNS and CDN modules)
# ============================================================================

resource "aws_route53_record" "cloudfront_a" {
  for_each = local.has_domain ? toset(local.frontend_domains) : toset([])

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
  for_each = local.has_domain ? toset(local.frontend_domains) : toset([])

  zone_id = module.dns[0].zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = module.cdn.cloudfront_domain
    zone_id                = module.cdn.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "api_origin_a" {
  count = local.has_domain ? 1 : 0

  zone_id = module.dns[0].zone_id
  name    = module.dns[0].api_origin_domain
  type    = "A"

  alias {
    name                   = module.alb.alb_dns_name
    zone_id                = module.alb.alb_zone_id
    evaluate_target_health = true
  }
}
