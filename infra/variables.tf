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
  default     = "staging"
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
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones"
  type        = number
  default     = 2
}

# --- Database ---

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.medium"
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

# --- Domain & DNS ---

variable "domain" {
  description = "Root domain (e.g., school-pilot.net). Set to enable Route 53 + ACM auto-setup."
  type        = string
  default     = ""
}

# --- Application Secrets ---

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
