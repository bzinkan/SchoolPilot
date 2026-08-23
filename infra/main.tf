# ============================================================================
# SchoolPilot Infrastructure — Main Configuration
# ============================================================================

terraform {
  # `removed { lifecycle { destroy = false } }` is required for the one-time
  # non-destructive credential state detachment.
  required_version = ">= 1.7, < 2.0"

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

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

locals {
  name                   = "${var.project}-${var.environment}"
  has_domain             = var.domain != ""
  frontend_domains       = local.has_domain ? [for domain in module.dns[0].all_domains : domain if domain != module.dns[0].api_origin_domain] : []
  alb_access_logs_bucket = "${local.name}-alb-access-logs-${data.aws_caller_identity.current.account_id}"
  database_capacity      = jsondecode(file("${path.module}/../src/config/databaseCapacity.json"))
  rls_registry           = jsondecode(file("${path.module}/../src/config/rlsRegistry.json"))
  rls_post_expand_tables = local.rls_registry.inventories.schoolPilot270PostExpand.tables
  rls_configured_tables  = [for table in split(",", var.rls_enabled_tables) : trimspace(table) if trimspace(table) != ""]
}

check "database_capacity_contract" {
  assert {
    condition = (
      var.api_max_capacity == local.database_capacity.apiMaxTasks &&
      var.worker_desired_count == local.database_capacity.workerTasks &&
      var.db_pool_max == local.database_capacity.api.main &&
      var.scheduler_db_pool_max == local.database_capacity.worker.scheduler &&
      (
        var.api_max_capacity * (
          local.database_capacity.api.main +
          local.database_capacity.api.session +
          local.database_capacity.api.scheduler +
          local.database_capacity.api.schedulerLock
        ) +
        var.worker_desired_count * (
          local.database_capacity.worker.main +
          local.database_capacity.worker.session +
          local.database_capacity.worker.scheduler +
          local.database_capacity.worker.schedulerLock
        )
      ) <= local.database_capacity.reviewedDatabaseConnectionLimit *
      (1 - local.database_capacity.minimumHeadroomPercent / 100)
    )
    error_message = "Terraform task counts and pool limits must match src/config/databaseCapacity.json and retain reviewed headroom."
  }
}

check "rls_registry_contract" {
  assert {
    condition = (
      local.rls_registry.inventories.historicalObservedProduction.count == 72 &&
      length(local.rls_registry.inventories.historicalObservedProduction.tables) == 72 &&
      local.rls_registry.inventories.schoolPilot270PostExpand.count == 75 &&
      length(local.rls_post_expand_tables) == 75 &&
      length(local.rls_configured_tables) > 0 &&
      length(local.rls_configured_tables) == length(toset(local.rls_configured_tables)) &&
      length(setsubtract(
        toset(local.rls_configured_tables),
        toset(local.rls_post_expand_tables)
      )) == 0
    )
    error_message = "RLS_ENABLED_TABLES must contain only tables in src/config/rlsRegistry.json; the registry preserves the observed 72-table audit snapshot and the 75-table post-expand inventory."
  }
}

# ALB access logs let us identify source IPs and paths for target 4xx spikes.
resource "aws_s3_bucket" "alb_access_logs" {
  bucket        = local.alb_access_logs_bucket
  force_destroy = var.environment != "production"

  tags = { Name = local.alb_access_logs_bucket }
}

resource "aws_s3_bucket_public_access_block" "alb_access_logs" {
  bucket = aws_s3_bucket.alb_access_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_access_logs" {
  bucket = aws_s3_bucket.alb_access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_access_logs" {
  bucket = aws_s3_bucket.alb_access_logs.id

  rule {
    id     = "expire-alb-access-logs"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 90
    }
  }
}

resource "aws_s3_bucket_policy" "alb_access_logs" {
  bucket = aws_s3_bucket.alb_access_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowElasticLoadBalancingAccessLogs"
      Effect = "Allow"
      Principal = {
        Service = "logdelivery.elasticloadbalancing.amazonaws.com"
      }
      Action   = "s3:PutObject"
      Resource = "${aws_s3_bucket.alb_access_logs.arn}/alb/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
    }]
  })
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

module "turn" {
  count  = var.enable_classpilot_turn && local.has_domain ? 1 : 0
  source = "./modules/turn"

  project              = var.project
  environment          = var.environment
  aws_region           = var.aws_region
  vpc_id               = module.vpc.vpc_id
  public_subnet_ids    = module.vpc.public_subnet_ids
  route53_zone_id      = module.dns[0].zone_id
  domain               = var.domain
  tls_email            = var.classpilot_turn_tls_email
  instance_type        = var.classpilot_turn_instance_type
  relay_port_min       = var.classpilot_turn_relay_port_min
  relay_port_max       = var.classpilot_turn_relay_port_max
  alerts_sns_topic_arn = var.alerts_sns_topic_arn
}

check "classpilot_turn_activation" {
  assert {
    condition = !var.enable_classpilot_turn || (
      local.has_domain &&
      length(module.vpc.public_subnet_ids) >= 2 &&
      can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.classpilot_turn_tls_email))
    )
    error_message = "ClassPilot TURN requires a managed domain, two public subnets, and an operational TLS email."
  }
}

module "alb" {
  source = "./modules/alb"

  project                         = var.project
  environment                     = var.environment
  vpc_id                          = module.vpc.vpc_id
  public_subnet_ids               = module.vpc.public_subnet_ids
  enable_https                    = local.has_domain
  certificate_arn                 = local.has_domain ? module.dns[0].certificate_arn : ""
  health_check_path               = "/livez"
  enable_http_ingress             = false
  allowed_ingress_cidr_blocks     = []
  allowed_ingress_prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]
  enable_access_logs              = true
  access_logs_bucket              = aws_s3_bucket.alb_access_logs.id
  access_logs_prefix              = "alb"

  depends_on = [aws_s3_bucket_policy.alb_access_logs]
}

module "ecs" {
  source = "./modules/ecs"

  project               = var.project
  environment           = var.environment
  aws_region            = var.aws_region
  aws_account_id        = data.aws_caller_identity.current.account_id
  vpc_id                = module.vpc.vpc_id
  task_subnet_ids       = var.ecs_tasks_in_public_subnets ? module.vpc.public_subnet_ids : module.vpc.private_subnet_ids
  assign_task_public_ip = var.ecs_tasks_in_public_subnets
  alb_target_group_arn  = module.alb.target_group_arn
  ecr_repository_url    = module.ecr.repository_url
  container_port        = 4000
  ecs_security_group_id = aws_security_group.ecs_tasks.id

  # Runtime topology for the API. Rotated application credentials are externally
  # managed SecureStrings referenced by deterministic ARN inside the ECS module.
  redis_url = module.redis.redis_url

  # Auto-derive URLs from domain, with manual override
  public_base_url = local.has_domain ? "https://${module.dns[0].primary_domain}" : var.public_base_url
  cors_allowlist  = local.has_domain ? "https://${module.dns[0].primary_domain}" : var.cors_allowlist
  cookie_domain   = local.has_domain ? ".${var.domain}" : var.cookie_domain

  # Google OAuth
  google_client_id                                   = var.google_client_id
  google_oauth_previous_encryption_key_parameter_arn = var.google_oauth_previous_encryption_key_parameter_arn

  # Optional services
  # Existing SecureString parameters managed outside Terraform tfvars.
  anthropic_api_key_parameter_arn  = var.anthropic_api_key_parameter_arn
  telegram_bot_token_parameter_arn = var.telegram_bot_token_parameter_arn
  classpilot_turn_hosts            = try(join(",", module.turn[0].hostnames), "")
  classpilot_turn_rest_secret_arn  = try(module.turn[0].rest_secret_arn, "")

  # Scaling
  desired_count                   = var.ecs_desired_count
  enable_api_arrival_capacity     = var.enable_api_arrival_capacity
  api_max_capacity                = var.api_max_capacity
  api_arrival_min_capacity        = var.api_arrival_min_capacity
  api_arrival_scale_up_schedule   = var.api_arrival_scale_up_schedule
  api_arrival_scale_down_schedule = var.api_arrival_scale_down_schedule
  api_arrival_schedule_timezone   = var.api_arrival_schedule_timezone
  cpu                             = var.ecs_cpu
  memory                          = var.ecs_memory
  worker_desired_count            = var.worker_desired_count
  worker_cpu                      = var.worker_cpu
  worker_memory                   = var.worker_memory
  enable_container_insights       = var.enable_container_insights
  db_pool_max                     = var.db_pool_max
  scheduler_db_pool_max           = var.scheduler_db_pool_max
  rls_enabled_tables              = var.rls_enabled_tables
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
  api_rate_limit             = var.waf_api_rate_limit
  device_ingest_rate_limit   = var.waf_device_ingest_rate_limit
  rate_rule_action           = var.waf_rate_rule_action
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
