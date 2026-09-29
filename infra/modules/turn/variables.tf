variable "project" { type = string }
variable "environment" { type = string }
variable "aws_region" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" {
  type = list(string)
  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "ClassPilot TURN requires at least two public subnets."
  }
}
variable "route53_zone_id" { type = string }
variable "domain" { type = string }
variable "tls_email" {
  type      = string
  sensitive = true
}
variable "alerts_sns_topic_arn" {
  type    = string
  default = ""
}
variable "instance_type" {
  type    = string
  default = "t3.small"
}
variable "relay_port_min" {
  type    = number
  default = 49152
}
variable "relay_port_max" {
  type    = number
  default = 49252
}

variable "parked" {
  description = "Keep both legacy coturn nodes stopped while Terraform retains every TURN resource. false allows a deliberate, reviewed restart."
  type        = bool
  default     = false
}

variable "ami_id" {
  description = "Pinned AMI for the coturn nodes. null reads Canonical's moving Ubuntu 24.04 parameter, for new environments only."
  type        = string
  default     = null

  validation {
    condition     = var.ami_id == null || can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "ami_id must be null or a verified AMI ID such as ami-0123456789abcdef0."
  }
}
