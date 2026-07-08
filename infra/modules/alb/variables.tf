variable "project" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "enable_https" { type = bool }
variable "certificate_arn" { type = string }
variable "health_check_path" { type = string }

variable "allowed_ingress_cidr_blocks" {
  description = "CIDR blocks allowed to reach the ALB listeners"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "allowed_ingress_prefix_list_ids" {
  description = "Managed prefix list IDs allowed to reach the ALB listeners"
  type        = list(string)
  default     = []
}

variable "enable_access_logs" {
  description = "Enable ALB access logs"
  type        = bool
  default     = false
}

variable "access_logs_bucket" {
  description = "S3 bucket name for ALB access logs"
  type        = string
  default     = ""
}

variable "access_logs_prefix" {
  description = "S3 prefix for ALB access logs"
  type        = string
  default     = ""
}
