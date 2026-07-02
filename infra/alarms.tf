# ============================================================================
# Scale-readiness CloudWatch alarms
# ============================================================================

locals {
  alarm_prefix     = "${local.name}-scale"
  alarm_actions    = compact([var.alerts_sns_topic_arn])
  alarm_ok_actions = compact([var.alerts_sns_topic_arn])
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

resource "aws_cloudwatch_metric_alarm" "api_running_tasks" {
  alarm_name          = "${local.alarm_prefix}-api-running-tasks"
  alarm_description   = "API ECS running task count dropped below desired minimum."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  comparison_operator = "LessThanThreshold"
  threshold           = var.ecs_desired_count
  evaluation_periods  = 2
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    ClusterName = module.ecs.cluster_name
    ServiceName = module.ecs.service_name
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_running_tasks" {
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
  comparison_operator = "GreaterThanThreshold"
  threshold           = 250
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
  alarm_name          = "${local.alarm_prefix}-redis-cpu"
  alarm_description   = "Redis CPU is high."
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 70
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    ReplicationGroupId = "${local.name}-redis"
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name          = "${local.alarm_prefix}-redis-memory"
  alarm_description   = "Redis memory usage is high."
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 70
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    ReplicationGroupId = "${local.name}-redis"
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_evictions" {
  alarm_name          = "${local.alarm_prefix}-redis-evictions"
  alarm_description   = "Redis evictions are occurring."
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 2
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_ok_actions

  dimensions = {
    ReplicationGroupId = "${local.name}-redis"
  }
}

resource "aws_cloudwatch_metric_alarm" "redis_connections" {
  alarm_name          = "${local.alarm_prefix}-redis-connections"
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
    ReplicationGroupId = "${local.name}-redis"
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
