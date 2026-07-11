variable "project" { type = string }
variable "environment" { type = string }
variable "domain_name" { type = string }
variable "domain_aliases" {
  type    = list(string)
  default = []
}
variable "api_domain" { type = string }
variable "certificate_arn" { type = string }
variable "api_origin_protocol_policy" {
  type    = string
  default = "https-only"
}
variable "api_rate_limit" {
  type    = number
  default = 50000
}
variable "device_ingest_rate_limit" {
  type    = number
  default = 100000
}
variable "rate_rule_action" {
  type    = string
  default = "block"

  validation {
    condition     = contains(["block", "count"], var.rate_rule_action)
    error_message = "rate_rule_action must be either block or count."
  }
}
