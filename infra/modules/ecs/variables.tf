variable "project" { type = string }
variable "environment" { type = string }
variable "aws_region" { type = string }
variable "aws_account_id" { type = string }
variable "vpc_id" { type = string }
variable "task_subnet_ids" { type = list(string) }
variable "assign_task_public_ip" {
  type    = bool
  default = false
}
variable "alb_target_group_arn" { type = string }
variable "ecr_repository_url" { type = string }
variable "container_port" { type = number }
variable "ecs_security_group_id" { type = string }

variable "desired_count" { type = number }
variable "enable_api_arrival_capacity" {
  type    = bool
  default = false
}
variable "api_max_capacity" {
  type    = number
  default = 6
}
variable "api_arrival_min_capacity" {
  type    = number
  default = 2
}
variable "api_arrival_scale_up_schedule" {
  type    = string
  default = "cron(0 6 ? * MON-FRI *)"
}
variable "api_arrival_scale_down_schedule" {
  type    = string
  default = "cron(0 10 ? * MON-FRI *)"
}
variable "api_arrival_schedule_timezone" {
  type    = string
  default = "America/New_York"
}
variable "cpu" { type = number }
variable "memory" { type = number }
variable "worker_desired_count" { type = number }
variable "worker_cpu" { type = number }
variable "worker_memory" { type = number }
variable "enable_container_insights" {
  type    = bool
  default = true
}
variable "db_pool_max" { type = number }
variable "scheduler_db_pool_max" { type = number }
variable "rls_enabled_tables" { type = string }

# App environment variables
variable "redis_url" {
  type      = string
  sensitive = true
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
variable "google_oauth_previous_encryption_key_parameter_arn" {
  type    = string
  default = ""
}
variable "anthropic_api_key_parameter_arn" {
  type    = string
  default = ""
}
variable "gemini_api_key_parameter_arn" {
  type    = string
  default = ""
}
variable "telegram_bot_token_parameter_arn" {
  type    = string
  default = ""
}
variable "classpilot_turn_hosts" {
  type    = string
  default = ""
}
variable "classpilot_turn_rest_secret_arn" {
  type    = string
  default = ""
}
variable "classpilot_turn_secret_access_arn" {
  description = "Optional TURN REST secret ARN granted to the ECS execution role without injecting it into bootstrap task definitions"
  type        = string
  default     = ""
}

variable "mydesk_attachments_bucket_name" {
  type    = string
  default = ""
}
variable "mydesk_attachments_bucket_arn" {
  type    = string
  default = ""
}
variable "mydesk_enabled_school_ids" {
  description = "Comma-separated approved pilot school UUIDs; empty disables the feature but leaves cleanup bucket configuration intact"
  type        = string
  default     = ""
}
variable "mydesk_seating_enabled_school_ids" {
  description = "Comma-separated reviewed seating-chart pilot school UUIDs; base My Desk admission is also required"
  type        = string
  default     = ""
}
variable "mydesk_ai_import_enabled_school_ids" {
  description = "Reviewed teacher-started AI paperwork import school UUIDs; base My Desk admission is also required"
  type        = string
  default     = ""
}
variable "mydesk_ai_import_model" {
  type    = string
  default = "claude-sonnet-5"
}
variable "mydesk_ai_import_teacher_daily_pages" {
  type    = number
  default = 100
}
variable "mydesk_ai_import_school_daily_pages" {
  type    = number
  default = 500
}
