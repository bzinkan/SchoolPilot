variable "enabled" {
  type = bool
}

variable "has_managed_domain" {
  type = bool
}

variable "public_subnet_count" {
  type = number
}

variable "tls_email" {
  type      = string
  sensitive = true
}

resource "terraform_data" "activation" {
  input = var.enabled

  lifecycle {
    precondition {
      condition = !var.enabled || (
        var.has_managed_domain &&
        var.public_subnet_count >= 2 &&
        can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$", var.tls_email))
      )
      error_message = "ClassPilot TURN requires a managed domain, two public subnets, and an operational TLS email."
    }
  }
}
