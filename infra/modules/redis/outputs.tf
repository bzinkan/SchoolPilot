output "endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "redis_url" {
  value     = "redis://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  sensitive = true
}

output "security_group_id" {
  value = aws_security_group.redis.id
}
