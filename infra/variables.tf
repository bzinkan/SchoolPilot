# ============================================================================
# SchoolPilot Infrastructure — Variables
# ============================================================================

# --- General ---

variable "project" {
  description = "Project name used for resource naming"
  type        = string
  default     = "schoolpilot"
}

variable "environment" {
  description = "Environment (staging, production)"
  type        = string
  default     = "production"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

# --- Networking ---

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.1.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones"
  type        = number
  default     = 2
}

variable "enable_nat_gateway" {
  description = "Create one NAT gateway per AZ for private ECS egress"
  type        = bool
  default     = true
}

variable "ecs_tasks_in_public_subnets" {
  description = "Place ECS API and worker tasks in public subnets with public IPv4 addresses"
  type        = bool
  default     = false
}

# --- Database ---

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.medium"
}

variable "db_multi_az" {
  description = "Enable RDS Multi-AZ standby"
  type        = bool
  default     = true
}

variable "db_allocated_storage" {
  description = "Initial RDS storage in GB"
  type        = number
  default     = 100
}

variable "db_max_allocated_storage" {
  description = "Maximum RDS autoscaled storage in GB"
  type        = number
  default     = 1000
}

variable "db_apply_immediately" {
  description = "Apply RDS instance modifications immediately instead of waiting for the maintenance window"
  type        = bool
  default     = false
}

variable "db_name" {
  description = "Database name"
  type        = string
  default     = "schoolpilot"
}

variable "db_username" {
  description = "Database master username"
  type        = string
  default     = "schoolpilot"
}

# --- Redis ---

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_replica_count" {
  description = "Number of Redis replicas for automatic failover"
  type        = number
  default     = 1
}

# --- ECS / Fargate ---

variable "ecs_desired_count" {
  description = "Number of Fargate tasks"
  type        = number
  default     = 2
}

variable "enable_api_arrival_capacity" {
  description = "Temporarily raise the API autoscaling minimum to two during the weekday school-arrival window"
  type        = bool
  default     = false
}

variable "api_arrival_scale_up_schedule" {
  description = "Application Auto Scaling cron expression for the weekday API arrival-capacity increase"
  type        = string
  default     = "cron(0 6 ? * MON-FRI *)"
}

variable "api_arrival_scale_down_schedule" {
  description = "Application Auto Scaling cron expression that restores the ordinary API minimum"
  type        = string
  default     = "cron(0 10 ? * MON-FRI *)"
}

variable "api_arrival_schedule_timezone" {
  description = "IANA time zone used by the API arrival-capacity schedules"
  type        = string
  default     = "America/New_York"
}

variable "ecs_cpu" {
  description = "Fargate task CPU (256, 512, 1024, 2048, 4096)"
  type        = number
  default     = 512
}

variable "ecs_memory" {
  description = "Fargate task memory in MB"
  type        = number
  default     = 1024
}

variable "worker_desired_count" {
  description = "Number of scheduler worker tasks"
  type        = number
  default     = 1
}

variable "worker_cpu" {
  description = "Scheduler worker Fargate CPU"
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Scheduler worker memory in MB"
  type        = number
  default     = 512
}

variable "enable_container_insights" {
  description = "Enable ECS Container Insights and its task-count alarms"
  type        = bool
  default     = true
}

variable "db_pool_max" {
  description = "Maximum Postgres connections per API task"
  type        = number
  default     = 20
}

variable "scheduler_db_pool_max" {
  description = "Maximum Postgres connections for scheduler worker"
  type        = number
  default     = 5
}

variable "rls_enabled_tables" {
  description = "Comma-separated tenant table allowlist for PostgreSQL RLS"
  type        = string
  default     = "activity_log,audit_logs,block_lists,bus_routes,chat_messages,classpilot_active_hands,classpilot_ai_decisions,classpilot_classroom_states,classpilot_command_targets,classpilot_commands,classpilot_coverage_assignments,classpilot_coverage_scope_group_members,classpilot_coverage_scope_groups,classpilot_scheduled_conflicts,classpilot_session_students,classpilot_session_usage,classpilot_supervision_contexts,classpilot_supervision_students,classroom_course_students,classroom_courses,daily_usage,dashboard_tabs,devices,dismissal_sessions,email_alerts,email_scan_log,error_logs,evidence_artifacts,family_groups,flight_paths,google_roster_connectors,grades,groups,heartbeats,homerooms,import_runs,mailpilot_watches,messages,parent_student,passes,security_events,settings,student_attendance,student_groups,student_safety_cases,student_timeline_events,students,subgroups,teacher_students,teaching_sessions,walker_zones"
}

variable "alerts_sns_topic_arn" {
  description = "SNS topic ARN for production CloudWatch alarm and OK notifications"
  type        = string
  default     = ""
}

variable "waf_api_rate_limit" {
  description = "Maximum non-device-ingest API requests allowed per source IP in a five-minute WAF window"
  type        = number
  default     = 50000

  validation {
    condition     = var.waf_api_rate_limit >= 100
    error_message = "waf_api_rate_limit must be at least 100 requests per five minutes."
  }
}

variable "waf_device_ingest_rate_limit" {
  description = "Maximum heartbeat and screenshot POST requests allowed per source IP in a five-minute WAF window"
  type        = number
  default     = 100000

  validation {
    condition     = var.waf_device_ingest_rate_limit >= 100
    error_message = "waf_device_ingest_rate_limit must be at least 100 requests per five minutes."
  }
}

variable "waf_rate_rule_action" {
  description = "Action for both WAF rate-limit rules; use count only for a reviewed emergency rollback"
  type        = string
  default     = "block"

  validation {
    condition     = contains(["block", "count"], var.waf_rate_rule_action)
    error_message = "waf_rate_rule_action must be either block or count."
  }
}

# --- Domain & DNS ---

variable "domain" {
  description = "Root domain (e.g., school-pilot.net). Set to enable Route 53 + ACM auto-setup."
  type        = string
  default     = ""
}

variable "route53_measure_latency" {
  description = "Enable Route 53 health-check latency measurement; keep true until the separate off-hours disable phase"
  type        = bool
  default     = true
}

variable "public_base_url" {
  description = "Public API URL (e.g., https://api.classpilot.net)"
  type        = string
  default     = ""
}

variable "cors_allowlist" {
  description = "Comma-separated list of allowed CORS origins"
  type        = string
  default     = ""
}

variable "cookie_domain" {
  description = "Session cookie domain (e.g., .classpilot.net)"
  type        = string
  default     = ""
}

# --- Google OAuth ---

variable "google_client_id" {
  description = "Google OAuth client ID"
  type        = string
  default     = ""
}

variable "google_oauth_previous_encryption_key_parameter_arn" {
  description = "Optional ARN for the externally managed /<project>/<environment>/GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS SecureString"
  type        = string
  default     = ""
}

variable "anthropic_api_key_parameter_arn" {
  description = "Existing SecureString SSM parameter ARN for ANTHROPIC_API_KEY"
  type        = string
  default     = ""
}

variable "telegram_bot_token_parameter_arn" {
  description = "Existing SecureString SSM parameter ARN for TELEGRAM_BOT_TOKEN"
  type        = string
  default     = ""
}
