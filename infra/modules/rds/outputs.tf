output "endpoint" {
  value     = aws_db_instance.main.endpoint
  sensitive = true
}

output "database_url" {
  description = "Full PostgreSQL connection string"
  value       = "postgresql://${var.db_username}:${urlencode(jsondecode(data.aws_secretsmanager_secret_version.rds_password.secret_string)["password"])}@${aws_db_instance.main.endpoint}/${var.db_name}?sslmode=require"
  sensitive   = true
}

output "security_group_id" {
  value = aws_security_group.rds.id
}

output "master_user_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the master password"
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}
