variable "name_prefix" {
  description = "Project/environment prefix used for durable lease resources"
  type        = string
}

variable "aws_region" {
  description = "AWS region containing the exact RDS instance"
  type        = string
}

variable "aws_account_id" {
  description = "AWS account containing the exact RDS instance"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be an exact 12-digit account ID."
  }
}

variable "db_instance_arn" {
  description = "Exact RDS DB instance ARN that the recurring bounded restore may modify"
  type        = string
}

variable "expected_db_instance_class" {
  description = "Exact DB instance class the durable restoration Automation must verify"
  type        = string
  default     = "db.t4g.medium"

  validation {
    condition     = var.expected_db_instance_class == "db.t4g.medium"
    error_message = "The reviewed durable restoration Automation is bound to db.t4g.medium."
  }
}

variable "alerts_sns_topic_arn" {
  description = "Optional existing operational SNS topic for DLQ alarms"
  type        = string
  default     = ""
}
