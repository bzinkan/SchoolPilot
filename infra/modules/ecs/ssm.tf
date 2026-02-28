# ============================================================================
# SSM Parameter Store — Secrets for ECS Task Definition
# SecureString parameters are encrypted at rest with the AWS-managed SSM key.
# ECS injects these into the container at startup via "secrets" / "valueFrom".
# ============================================================================

resource "aws_ssm_parameter" "database_url" {
  name  = "/${var.project}/${var.environment}/DATABASE_URL"
  type  = "SecureString"
  value = var.database_url
  tags  = { Name = "${local.name}-database-url" }
}

resource "aws_ssm_parameter" "redis_url" {
  name  = "/${var.project}/${var.environment}/REDIS_URL"
  type  = "SecureString"
  value = var.redis_url
  tags  = { Name = "${local.name}-redis-url" }
}

resource "aws_ssm_parameter" "session_secret" {
  name  = "/${var.project}/${var.environment}/SESSION_SECRET"
  type  = "SecureString"
  value = var.session_secret
  tags  = { Name = "${local.name}-session-secret" }
}

resource "aws_ssm_parameter" "jwt_secret" {
  name  = "/${var.project}/${var.environment}/JWT_SECRET"
  type  = "SecureString"
  value = var.jwt_secret
  tags  = { Name = "${local.name}-jwt-secret" }
}

resource "aws_ssm_parameter" "student_token_secret" {
  name  = "/${var.project}/${var.environment}/STUDENT_TOKEN_SECRET"
  type  = "SecureString"
  value = var.student_token_secret
  tags  = { Name = "${local.name}-student-token-secret" }
}

resource "aws_ssm_parameter" "google_client_secret" {
  name  = "/${var.project}/${var.environment}/GOOGLE_CLIENT_SECRET"
  type  = "SecureString"
  value = var.google_client_secret
  tags  = { Name = "${local.name}-google-client-secret" }
}

resource "aws_ssm_parameter" "google_oauth_encryption_key" {
  name  = "/${var.project}/${var.environment}/GOOGLE_OAUTH_ENCRYPTION_KEY"
  type  = "SecureString"
  value = var.google_oauth_encryption_key
  tags  = { Name = "${local.name}-google-oauth-encryption-key" }
}

resource "aws_ssm_parameter" "sendgrid_api_key" {
  name  = "/${var.project}/${var.environment}/SENDGRID_API_KEY"
  type  = "SecureString"
  value = var.sendgrid_api_key
  tags  = { Name = "${local.name}-sendgrid-api-key" }
}

resource "aws_ssm_parameter" "stripe_secret_key" {
  name  = "/${var.project}/${var.environment}/STRIPE_SECRET_KEY"
  type  = "SecureString"
  value = var.stripe_secret_key
  tags  = { Name = "${local.name}-stripe-secret-key" }
}

resource "aws_ssm_parameter" "stripe_webhook_secret" {
  name  = "/${var.project}/${var.environment}/STRIPE_WEBHOOK_SECRET"
  type  = "SecureString"
  value = var.stripe_webhook_secret
  tags  = { Name = "${local.name}-stripe-webhook-secret" }
}

resource "aws_ssm_parameter" "openai_api_key" {
  name  = "/${var.project}/${var.environment}/OPENAI_API_KEY"
  type  = "SecureString"
  value = var.openai_api_key
  tags  = { Name = "${local.name}-openai-api-key" }
}
