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
