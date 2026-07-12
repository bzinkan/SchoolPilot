# ============================================================================
# SSM Parameter Store — Runtime Secret Ownership Boundary
# ============================================================================
#
# Application credential values are rotated out-of-band and are intentionally
# absent from Terraform configuration, plans, and state. These historical
# resources remain as forget-only declarations so the first reviewed apply after
# this change detaches their existing state bindings without deleting the live
# SecureStrings. Keep these blocks permanently: a workspace that upgrades later
# must receive the same non-destructive migration.

removed {
  from = aws_ssm_parameter.database_url

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.session_secret

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.jwt_secret

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.student_token_secret

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.google_client_secret

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.google_oauth_encryption_key

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.sendgrid_api_key

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.stripe_secret_key

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.stripe_webhook_secret

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.openai_api_key

  lifecycle {
    destroy = false
  }
}

# REDIS_URL is topology-derived from the Terraform-managed replication group and
# contains no independently rotated application credential, so it remains owned.
resource "aws_ssm_parameter" "redis_url" {
  name  = "/${var.project}/${var.environment}/REDIS_URL"
  type  = "SecureString"
  value = var.redis_url
  tags  = { Name = "${local.name}-redis-url" }
}
