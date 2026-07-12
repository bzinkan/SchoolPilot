# ============================================================================
# Scale-readiness CloudWatch alarms
# ============================================================================

locals {
  alarm_prefix     = "${local.name}-scale"
  alarm_actions    = compact([var.alerts_sns_topic_arn])
  alarm_ok_actions = compact([var.alerts_sns_topic_arn])
}

# Preserve the existing alarm instances when Container Insights gating adds count.
moved {
  from = aws_cloudwatch_metric_alarm.api_running_tasks
  to   = aws_cloudwatch_metric_alarm.api_running_tasks[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.worker_running_tasks
  to   = aws_cloudwatch_metric_alarm.worker_running_tasks[0]
}

# ElastiCache publishes node metrics by CacheClusterId, so preserve the first
# node's existing alarms while adding one alarm instance per configured node.
moved {
  from = aws_cloudwatch_metric_alarm.redis_cpu
  to   = aws_cloudwatch_metric_alarm.redis_cpu[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.redis_memory
  to   = aws_cloudwatch_metric_alarm.redis_memory[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.redis_evictions
  to   = aws_cloudwatch_metric_alarm.redis_evictions[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.redis_connections
  to   = aws_cloudwatch_metric_alarm.redis_connections[0]
}

resource "aws_cloudwatch_metric_alarm" "alb_p95_latency" {
  alarm_name          = "${local.alarm_prefix}-alb-p95-latency"
  alarm_description   = "ALB target response p95 is above the 2,000-device load gate."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.5
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  period              = 60
  extended_statistic  = "p95"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    LoadBalancer = module.alb.alb_arn_suffix
    TargetGroup  = module.alb.target_group_arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name          = "${local.alarm_prefix}-alb-target-5xx"
  alarm_description   = "ALB target 5xx responses are above the production gate."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 5
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    LoadBalancer = module.alb.alb_arn_suffix
    TargetGroup  = module.alb.target_group_arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_4xx" {
  alarm_name          = "${local.alarm_prefix}-alb-4xx"
  alarm_description   = "ALB 4xx responses spiked; verify WAF/auth/client behavior."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_4XX_Count"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 100
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    LoadBalancer = module.alb.alb_arn_suffix
    TargetGroup  = module.alb.target_group_arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "waf_device_ingest_blocks" {
  provider = aws.us_east_1

  alarm_name          = "${local.alarm_prefix}-waf-device-ingest-blocks"
  alarm_description   = "WAF blocked a heartbeat or screenshot upload; valid school traffic must not hit this threshold."
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    WebACL = module.cdn.web_acl_dimension_name
    Rule   = module.cdn.device_ingest_rate_limit_metric_name
  }
}

resource "aws_cloudwatch_metric_alarm" "waf_api_blocks" {
  provider = aws.us_east_1

  alarm_name          = "${local.alarm_prefix}-waf-api-blocks"
  alarm_description   = "WAF blocked non-device-ingest API traffic at the per-IP threshold."
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    WebACL = module.cdn.web_acl_dimension_name
    Rule   = module.cdn.api_rate_limit_metric_name
  }
}

resource "aws_cloudwatch_metric_alarm" "api_cpu" {
  alarm_name          = "${local.alarm_prefix}-api-cpu"
  alarm_description   = "API ECS CPU is high."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 75
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    ClusterName = module.ecs.cluster_name
    ServiceName = module.ecs.service_name
  }
}

resource "aws_cloudwatch_metric_alarm" "api_memory" {
  alarm_name          = "${local.alarm_prefix}-api-memory"
  alarm_description   = "API ECS memory is high."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 75
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    ClusterName = module.ecs.cluster_name
    ServiceName = module.ecs.service_name
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_healthy_hosts" {
  alarm_name          = "${local.alarm_prefix}-api-healthy-hosts"
  alarm_description   = "The API target group has no healthy host, independent of Container Insights."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  period              = 60
  statistic           = "Minimum"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    LoadBalancer = module.alb.alb_arn_suffix
    TargetGroup  = module.alb.target_group_arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "api_running_tasks" {
  count = var.enable_container_insights ? 1 : 0

  alarm_name          = "${local.alarm_prefix}-api-running-tasks"
  alarm_description   = "API ECS running task count is below the current desired count, including scheduled arrival capacity."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 2
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  metric_query {
    id          = "shortfall"
    expression  = "desired - running"
    label       = "Desired API tasks minus running API tasks"
    return_data = true
  }

  metric_query {
    id          = "desired"
    return_data = false

    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "DesiredTaskCount"
      period      = 60
      stat        = "Average"

      dimensions = {
        ClusterName = module.ecs.cluster_name
        ServiceName = module.ecs.service_name
      }
    }
  }

  metric_query {
    id          = "running"
    return_data = false

    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "RunningTaskCount"
      period      = 60
      stat        = "Average"

      dimensions = {
        ClusterName = module.ecs.cluster_name
        ServiceName = module.ecs.service_name
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_running_tasks" {
  count = var.enable_container_insights ? 1 : 0

  alarm_name          = "${local.alarm_prefix}-worker-running-tasks"
  alarm_description   = "Scheduler worker ECS running task count dropped below one."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 2
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    ClusterName = module.ecs.cluster_name
    ServiceName = module.ecs.worker_service_name
  }
}

resource "aws_cloudwatch_metric_alarm" "scheduler_worker_heartbeat" {
  alarm_name          = "${local.alarm_prefix}-scheduler-worker-heartbeat"
  alarm_description   = "Scheduler worker heartbeat is missing."
  namespace           = "SchoolPilot/Scheduler"
  metric_name         = "WorkerHeartbeat"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 2
  period              = 300
  statistic           = "Sum"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    Environment = var.environment
    Service     = "scheduler-worker"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.alarm_prefix}-rds-cpu"
  alarm_description   = "RDS CPU is above the 2,000-device load gate."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 65
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    DBInstanceIdentifier = "${local.name}-db"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${local.alarm_prefix}-rds-connections"
  alarm_description   = "RDS connection count is high; evaluate pool settings before scaling API tasks further."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 150
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    DBInstanceIdentifier = "${local.name}-db"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_freeable_memory" {
  alarm_name          = "${local.alarm_prefix}-rds-freeable-memory"
  alarm_description   = "RDS freeable memory dropped below 512 MiB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  comparison_operator = "LessThanThreshold"
  threshold           = 536870912
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Minimum"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    DBInstanceIdentifier = "${local.name}-db"
  }
}

# Alarm on sustained growth rather than a static amount of residual swap. Three
# one-minute increases above 16 MiB within five minutes indicate continuing
# memory pressure while avoiding noise from small page-accounting changes.
resource "aws_cloudwatch_metric_alarm" "rds_swap_usage" {
  alarm_name          = "${local.alarm_prefix}-rds-swap-usage"
  alarm_description   = "RDS swap usage is growing by more than 16 MiB per minute."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 16777216
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  metric_query {
    id          = "swap"
    return_data = false

    metric {
      namespace   = "AWS/RDS"
      metric_name = "SwapUsage"
      period      = 60
      stat        = "Maximum"

      dimensions = {
        DBInstanceIdentifier = "${local.name}-db"
      }
    }
  }

  metric_query {
    id          = "growth"
    expression  = "DIFF(swap)"
    label       = "SwapUsage one-minute growth"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu_credit_balance" {
  alarm_name          = "${local.alarm_prefix}-rds-cpu-credit-balance"
  alarm_description   = "RDS burst CPU credit balance is low."
  namespace           = "AWS/RDS"
  metric_name         = "CPUCreditBalance"
  comparison_operator = "LessThanThreshold"
  threshold           = 24
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  period              = 300
  statistic           = "Minimum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    DBInstanceIdentifier = "${local.name}-db"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu_surplus_credits_charged" {
  alarm_name          = "${local.alarm_prefix}-rds-cpu-surplus-credits-charged"
  alarm_description   = "RDS unlimited-mode surplus CPU credits incurred a charge."
  namespace           = "AWS/RDS"
  metric_name         = "CPUSurplusCreditsCharged"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 300
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    DBInstanceIdentifier = "${local.name}-db"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${local.alarm_prefix}-rds-free-storage"
  alarm_description   = "RDS free storage is low."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  comparison_operator = "LessThanThreshold"
  threshold           = 21474836480
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    DBInstanceIdentifier = "${local.name}-db"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_read_iops" {
  alarm_name          = "${local.alarm_prefix}-rds-read-iops"
  alarm_description   = "RDS read IOPS are elevated; inspect heartbeat and dashboard query plans."
  namespace           = "AWS/RDS"
  metric_name         = "ReadIOPS"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 3000
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    DBInstanceIdentifier = "${local.name}-db"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_write_iops" {
  alarm_name          = "${local.alarm_prefix}-rds-write-iops"
  alarm_description   = "RDS write IOPS are elevated; inspect heartbeat ingestion."
  namespace           = "AWS/RDS"
  metric_name         = "WriteIOPS"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 3000
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    DBInstanceIdentifier = "${local.name}-db"
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  count = var.redis_replica_count + 1

  alarm_name          = count.index == 0 ? "${local.alarm_prefix}-redis-cpu" : format("%s-%03d", "${local.alarm_prefix}-redis-cpu", count.index + 1)
  alarm_description   = "Redis CPU is high."
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    CacheClusterId = module.redis.member_clusters[count.index]
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  count = var.redis_replica_count + 1

  alarm_name          = count.index == 0 ? "${local.alarm_prefix}-redis-memory" : format("%s-%03d", "${local.alarm_prefix}-redis-memory", count.index + 1)
  alarm_description   = "Redis memory usage is high."
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    CacheClusterId = module.redis.member_clusters[count.index]
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_evictions" {
  count = var.redis_replica_count + 1

  alarm_name          = count.index == 0 ? "${local.alarm_prefix}-redis-evictions" : format("%s-%03d", "${local.alarm_prefix}-redis-evictions", count.index + 1)
  alarm_description   = "Redis evictions are occurring."
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    CacheClusterId = module.redis.member_clusters[count.index]
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu_credit_balance" {
  count = var.redis_replica_count + 1

  alarm_name          = count.index == 0 ? "${local.alarm_prefix}-redis-cpu-credit-balance" : format("%s-%03d", "${local.alarm_prefix}-redis-cpu-credit-balance", count.index + 1)
  alarm_description   = "Redis burst CPU credit balance is low."
  namespace           = "AWS/ElastiCache"
  metric_name         = "CPUCreditBalance"
  comparison_operator = "LessThanThreshold"
  threshold           = 10
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  period              = 300
  statistic           = "Minimum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    CacheClusterId = module.redis.member_clusters[count.index]
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_rejected_connections" {
  count = var.redis_replica_count + 1

  alarm_name          = count.index == 0 ? "${local.alarm_prefix}-redis-rejected-connections" : format("%s-%03d", "${local.alarm_prefix}-redis-rejected-connections", count.index + 1)
  alarm_description   = "Redis rejected one or more client connections."
  namespace           = "AWS/ElastiCache"
  metric_name         = "RejectedConnections"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    CacheClusterId = module.redis.member_clusters[count.index]
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_connections" {
  count = var.redis_replica_count + 1

  alarm_name          = count.index == 0 ? "${local.alarm_prefix}-redis-connections" : format("%s-%03d", "${local.alarm_prefix}-redis-connections", count.index + 1)
  alarm_description   = "Redis connection count is high."
  namespace           = "AWS/ElastiCache"
  metric_name         = "CurrConnections"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 500
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    CacheClusterId = module.redis.member_clusters[count.index]
  }
}

resource "aws_cloudwatch_metric_alarm" "websocket_errors" {
  alarm_name          = "${local.alarm_prefix}-websocket-errors"
  alarm_description   = "WebSocket error rate is elevated."
  namespace           = "SchoolPilot/WebSocket"
  metric_name         = "WebSocketError"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    Environment = var.environment
    Service     = "api"
  }
}

resource "aws_cloudwatch_metric_alarm" "websocket_disconnects" {
  alarm_name          = "${local.alarm_prefix}-websocket-disconnects"
  alarm_description   = "WebSocket disconnect rate is elevated; compare against active ClassPilot device count."
  namespace           = "SchoolPilot/WebSocket"
  metric_name         = "WebSocketDisconnect"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 500
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    Environment = var.environment
    Service     = "api"
  }
}

resource "aws_route53_health_check" "schoolpilot_public_health" {
  count             = local.has_domain ? 1 : 0
  fqdn              = var.domain
  port              = 443
  type              = "HTTPS"
  resource_path     = "/health"
  request_interval  = 30
  failure_threshold = 3
  measure_latency   = var.route53_measure_latency

  tags = {
    Name = "${local.alarm_prefix}-public-health"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_metric_alarm" "synthetic_public_health" {
  count               = local.has_domain ? 1 : 0
  alarm_name          = "${local.alarm_prefix}-synthetic-public-health"
  alarm_description   = "External Route53 synthetic check for the public /health endpoint is failing."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 3
  period              = 60
  statistic           = "Minimum"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    HealthCheckId = aws_route53_health_check.schoolpilot_public_health[0].id
  }
}
