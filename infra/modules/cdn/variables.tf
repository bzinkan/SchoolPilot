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
