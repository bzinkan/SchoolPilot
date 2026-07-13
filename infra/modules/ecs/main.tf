# ============================================================================
# ECS Module — Fargate Service
# ============================================================================

locals {
  name = "${var.project}-${var.environment}"
  application_secret_parameter_names = [
    "DATABASE_URL",
    "SESSION_SECRET",
    "JWT_SECRET",
    "STUDENT_TOKEN_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_OAUTH_ENCRYPTION_KEY",
    "SENDGRID_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]
  application_secret_parameter_arns = {
    for name in local.application_secret_parameter_names :
    name => "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project}/${var.environment}/${name}"
  }
  expected_google_oauth_previous_encryption_key_parameter_arn = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project}/${var.environment}/GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS"
  google_oauth_previous_encryption_key_parameter_arn_valid = (
    var.google_oauth_previous_encryption_key_parameter_arn == "" ||
    var.google_oauth_previous_encryption_key_parameter_arn == local.expected_google_oauth_previous_encryption_key_parameter_arn
  )
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "APP_ENV", value = var.environment },
    { name = "PGSSLMODE", value = "require" },
    { name = "PUBLIC_BASE_URL", value = var.public_base_url },
    { name = "CORS_ALLOWLIST", value = var.cors_allowlist },
    { name = "COOKIE_DOMAIN", value = var.cookie_domain },
    { name = "GOOGLE_CLIENT_ID", value = var.google_client_id },
    { name = "RUN_MIGRATIONS_ON_STARTUP", value = "false" },
    { name = "DB_POOL_MAX", value = tostring(var.db_pool_max) },
    { name = "SCHEDULER_DB_POOL_MAX", value = tostring(var.scheduler_db_pool_max) },
    { name = "RLS_GUC_ENABLED", value = "true" },
    { name = "RLS_ENABLED_TABLES", value = var.rls_enabled_tables },
  ]
  optional_common_secrets = concat(
    var.anthropic_api_key_parameter_arn != "" ? [
      { name = "ANTHROPIC_API_KEY", valueFrom = var.anthropic_api_key_parameter_arn },
    ] : [],
    var.telegram_bot_token_parameter_arn != "" ? [
      { name = "TELEGRAM_BOT_TOKEN", valueFrom = var.telegram_bot_token_parameter_arn },
    ] : [],
    var.google_oauth_previous_encryption_key_parameter_arn != "" ? [
      {
        name      = "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS"
        valueFrom = var.google_oauth_previous_encryption_key_parameter_arn
      },
    ] : []
  )
  common_secrets = concat([
    { name = "DATABASE_URL", valueFrom = local.application_secret_parameter_arns["DATABASE_URL"] },
    { name = "REDIS_URL", valueFrom = aws_ssm_parameter.redis_url.arn },
    { name = "SESSION_SECRET", valueFrom = local.application_secret_parameter_arns["SESSION_SECRET"] },
    { name = "JWT_SECRET", valueFrom = local.application_secret_parameter_arns["JWT_SECRET"] },
    { name = "STUDENT_TOKEN_SECRET", valueFrom = local.application_secret_parameter_arns["STUDENT_TOKEN_SECRET"] },
    { name = "GOOGLE_CLIENT_SECRET", valueFrom = local.application_secret_parameter_arns["GOOGLE_CLIENT_SECRET"] },
    { name = "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY", valueFrom = local.application_secret_parameter_arns["GOOGLE_OAUTH_ENCRYPTION_KEY"] },
    { name = "SENDGRID_API_KEY", valueFrom = local.application_secret_parameter_arns["SENDGRID_API_KEY"] },
    { name = "STRIPE_SECRET_KEY", valueFrom = local.application_secret_parameter_arns["STRIPE_SECRET_KEY"] },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = local.application_secret_parameter_arns["STRIPE_WEBHOOK_SECRET"] },
  ], local.optional_common_secrets)
}

# --- CloudWatch Log Group ---

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}-api"
  retention_in_days = var.environment == "production" ? 30 : 7

  tags = { Name = "${local.name}-api-logs" }
}

# --- ECS Cluster ---

resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"

  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }

  tags = { Name = "${local.name}-cluster" }
}

# --- IAM Roles ---

# Task execution role (ECR pull, CloudWatch logs)
resource "aws_iam_role" "ecs_execution" {
  name = "${local.name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow reading SSM parameters for ECS secrets injection
resource "aws_iam_role_policy" "ecs_secrets" {
  name = "${local.name}-ecs-secrets"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = ["arn:aws:ssm:${var.aws_region}:*:parameter/${var.project}/${var.environment}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = ["*"]
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

# Task role (what the container itself can do)
resource "aws_iam_role" "ecs_task" {
  name = "${local.name}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

# --- Task Definition ---

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  # NOTE: the LIVE task definition is managed out-of-band via the AWS CLI
  # (aws_ecs_service ignores task_definition changes); this template is
  # bootstrap-only and is far leaner than the running revision. Do not
  # terraform-apply this module expecting it to update production config.
  container_definitions = jsonencode([{
    name  = "api"
    image = "${var.ecr_repository_url}:latest"

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    environment = concat(local.common_environment, [
      { name = "PORT", value = tostring(var.container_port) },
      { name = "SCHEDULER_ENABLED", value = "false" },
    ])

    secrets = local.common_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:${var.container_port}/livez || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }])

  lifecycle {
    precondition {
      condition     = local.google_oauth_previous_encryption_key_parameter_arn_valid
      error_message = "The previous Google OAuth encryption key ARN must be empty or the exact environment-scoped GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS SSM parameter ARN."
    }
  }

  tags = { Name = "${local.name}-api" }
}

# --- ECS Service ---

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.task_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = var.assign_task_public_ip
  }

  load_balancer {
    target_group_arn = var.alb_target_group_arn
    container_name   = "api"
    container_port   = var.container_port
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Allow external changes (e.g., deploy script updating task definition)
  lifecycle {
    # Deployments and Application Auto Scaling own these runtime fields. Keep
    # Terraform focused on the reviewed task/network/capacity contracts rather
    # than fighting a legitimate scale event on the next plan.
    ignore_changes = [task_definition, desired_count]
  }

  tags = { Name = "${local.name}-api" }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-scheduler-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name    = "scheduler-worker"
    image   = "${var.ecr_repository_url}:latest"
    command = ["node", "dist/worker.js"]

    environment = concat(local.common_environment, [
      { name = "SCHEDULER_ENABLED", value = "true" },
    ])

    secrets = local.common_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "scheduler-worker"
      }
    }
  }])

  lifecycle {
    precondition {
      condition     = local.google_oauth_previous_encryption_key_parameter_arn_valid
      error_message = "The previous Google OAuth encryption key ARN must be empty or the exact environment-scoped GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS SSM parameter ARN."
    }
  }

  tags = { Name = "${local.name}-scheduler-worker" }
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name}-scheduler-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.task_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = var.assign_task_public_ip
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = { Name = "${local.name}-scheduler-worker" }
}

# --- Auto Scaling ---

resource "aws_appautoscaling_target" "api" {
  max_capacity       = var.api_max_capacity
  min_capacity       = var.desired_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"

  lifecycle {
    precondition {
      condition     = var.desired_count <= var.api_max_capacity
      error_message = "The ordinary API minimum cannot exceed api_max_capacity."
    }

    precondition {
      condition     = !var.enable_api_arrival_capacity || var.api_arrival_min_capacity <= var.api_max_capacity
      error_message = "The API arrival minimum cannot exceed api_max_capacity."
    }

    precondition {
      condition     = !var.enable_api_arrival_capacity || var.desired_count <= var.api_arrival_min_capacity
      error_message = "The ordinary API minimum cannot exceed the enabled arrival minimum."
    }
  }
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# CPU target tracking cannot react before a short morning reconnect wave. Keep
# the measured arrival floor warm during the weekday arrival window, then
# restore the ordinary minimum and let target tracking scale in. Target
# tracking continues to operate up to the configured maximum in both windows.
resource "aws_appautoscaling_scheduled_action" "api_arrival_scale_up" {
  count = var.enable_api_arrival_capacity ? 1 : 0

  name               = "${local.name}-api-arrival-scale-up"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  schedule           = var.api_arrival_scale_up_schedule
  timezone           = var.api_arrival_schedule_timezone

  scalable_target_action {
    min_capacity = var.api_arrival_min_capacity
  }
}

resource "aws_appautoscaling_scheduled_action" "api_arrival_scale_down" {
  count = var.enable_api_arrival_capacity ? 1 : 0

  name               = "${local.name}-api-arrival-scale-down"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  schedule           = var.api_arrival_scale_down_schedule
  timezone           = var.api_arrival_schedule_timezone

  scalable_target_action {
    min_capacity = var.desired_count
  }
}
