output "hostnames" {
  description = "Both ClassPilot TURN DNS hostnames, in stable order"
  value       = local.hostnames
}

output "elastic_ips" {
  description = "Elastic IP addresses assigned to the two TURN nodes"
  value       = [for key in sort(keys(local.nodes)) : aws_eip.turn[key].public_ip]
}

output "rest_secret_arn" {
  description = "Secrets Manager ARN containing the shared coturn REST secret"
  value       = aws_cloudformation_stack.rest_secret.outputs["SecretArn"]
}

output "dashboard_name" {
  description = "CloudWatch dashboard covering TURN and Live View ICE telemetry"
  value       = aws_cloudwatch_dashboard.turn.dashboard_name
}
