# ============================================================================
# ALB Module — Application Load Balancer
# ============================================================================

locals {
  name = "${var.project}-${var.environment}"
}

# --- Security Group ---

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  vpc_id      = var.vpc_id
  description = "Allow HTTP/HTTPS inbound"

  dynamic "ingress" {
    for_each = var.enable_http_ingress ? [1] : []

    content {
      from_port       = 80
      to_port         = 80
      protocol        = "tcp"
      cidr_blocks     = var.allowed_ingress_cidr_blocks
      prefix_list_ids = var.allowed_ingress_prefix_list_ids
      description     = "HTTP from approved origins"
    }
  }

  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    cidr_blocks     = var.allowed_ingress_cidr_blocks
    prefix_list_ids = var.allowed_ingress_prefix_list_ids
    description     = "HTTPS from approved origins"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-alb-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

# --- ALB ---

resource "aws_lb" "main" {
  name               = "${local.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = var.environment == "production"

  dynamic "access_logs" {
    for_each = var.enable_access_logs ? [1] : []

    content {
      bucket  = var.access_logs_bucket
      prefix  = var.access_logs_prefix
      enabled = true
    }
  }

  tags = { Name = "${local.name}-alb" }
}

# --- Target Group ---

resource "aws_lb_target_group" "api" {
  name                 = "${local.name}-api-tg"
  port                 = 4000
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 300

  health_check {
    enabled             = true
    path                = var.health_check_path
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  # Enable sticky sessions for WebSocket/Socket.io
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = true
  }

  tags = { Name = "${local.name}-api-tg" }
}

# --- HTTP Listener (redirect to HTTPS) ---

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = var.enable_https ? "redirect" : "forward"

    dynamic "redirect" {
      for_each = var.enable_https ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }

    # If no cert, forward directly (for initial testing)
    target_group_arn = var.enable_https ? null : aws_lb_target_group.api.arn
  }
}

# --- HTTPS Listener ---

resource "aws_lb_listener" "https" {
  count = var.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
