variable "project" { type = string }
variable "environment" { type = string }
variable "aws_region" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "alb_target_group_arn" { type = string }
variable "ecr_repository_url" { type = string }
variable "container_port" { type = number }
variable "ecs_security_group_id" { type = string }

variable "desired_count" { type = number }
variable "cpu" { type = number }
variable "memory" { type = number }

# App environment variables
variable "database_url" {
  type      = string
  sensitive = true
}
variable "redis_url" {
  type      = string
  sensitive = true
}
variable "session_secret" {
  type      = string
  sensitive = true
}
variable "jwt_secret" {
  type      = string
  sensitive = true
}
variable "student_token_secret" {
  type      = string
  sensitive = true
  default   = ""
}
variable "public_base_url" {
  type    = string
  default = ""
}
variable "cors_allowlist" {
  type    = string
  default = ""
}
variable "cookie_domain" {
  type    = string
  default = ""
}
variable "google_client_id" {
  type    = string
  default = ""
}
variable "google_client_secret" {
  type      = string
  sensitive = true
  default   = ""
}
variable "google_oauth_encryption_key" {
  type      = string
  sensitive = true
  default   = ""
}
variable "sendgrid_api_key" {
  type      = string
  sensitive = true
  default   = ""
}
variable "stripe_secret_key" {
  type      = string
  sensitive = true
  default   = ""
}
variable "stripe_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""
}
variable "openai_api_key" {
  type      = string
  sensitive = true
  default   = ""
}
