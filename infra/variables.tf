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
  default     = "activity_log,audit_logs,block_lists,bus_routes,classpilot_ai_decisions,classpilot_classroom_states,classpilot_command_targets,classpilot_commands,classroom_course_students,classroom_courses,daily_usage,dashboard_tabs,devices,dismissal_sessions,email_alerts,email_scan_log,error_logs,evidence_artifacts,family_groups,flight_paths,grades,groups,heartbeats,homerooms,import_runs,mailpilot_watches,messages,parent_student,passes,security_events,settings,student_attendance,student_groups,student_safety_cases,student_timeline_events,students,subgroups,teacher_students,teaching_sessions,walker_zones"
}

# --- Domain & DNS ---

variable "domain" {
  description = "Root domain (e.g., school-pilot.net). Set to enable Route 53 + ACM auto-setup."
  type        = string
  default     = ""
}

# --- Application Secrets ---

variable "database_url" {
  description = "Full PostgreSQL connection string"
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Express session secret"
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT signing secret"
  type        = string
  sensitive   = true
}

variable "student_token_secret" {
  description = "Student device token secret"
  type        = string
  sensitive   = true
  default     = ""
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

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "google_oauth_encryption_key" {
  description = "Google OAuth token encryption key"
  type        = string
  sensitive   = true
  default     = ""
}

# --- Optional Services ---

variable "sendgrid_api_key" {
  description = "SendGrid API key for email"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_secret_key" {
  description = "Stripe secret key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_webhook_secret" {
  description = "Stripe webhook signing secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "openai_api_key" {
  description = "OpenAI API key for AI content classification"
  type        = string
  sensitive   = true
  default     = ""
}
