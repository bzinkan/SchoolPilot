variable "project" { type = string }
variable "environment" { type = string }
variable "vpc_cidr" { type = string }
variable "az_count" { type = number }
variable "enable_nat_gateway" {
  type    = bool
  default = true
}
