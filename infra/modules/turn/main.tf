locals {
  name          = "${var.project}-${var.environment}-classpilot-turn"
  alarm_actions = compact([var.alerts_sns_topic_arn])
  nodes = {
    a = 0
    b = 1
  }
  hostnames = [for key in sort(keys(local.nodes)) : "turn-${key}.${var.domain}"]
  turn_availability_zones = toset([
    for subnet in data.aws_subnet.turn : subnet.availability_zone
  ])
}

data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

data "aws_subnet" "turn" {
  for_each = {
    for key, index in local.nodes : key => var.public_subnet_ids[index]
  }
  id = each.value
}

# CloudFormation generates the REST secret inside AWS. Terraform records only
# its ARN, never the secret value, in state or plans.
resource "aws_cloudformation_stack" "rest_secret" {
  name = "${local.name}-secret"
  template_body = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Resources = {
      TurnRestSecret = {
        Type                = "AWS::SecretsManager::Secret"
        DeletionPolicy      = "Retain"
        UpdateReplacePolicy = "Retain"
        Properties = {
          Name        = "/${var.project}/${var.environment}/CLASSPILOT_TURN_REST_SECRET"
          Description = "Shared coturn REST authentication secret for ClassPilot"
          GenerateSecretString = {
            ExcludePunctuation = true
            PasswordLength     = 64
          }
        }
      }
    }
    Outputs = {
      SecretArn = { Value = { Ref = "TurnRestSecret" } }
    }
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_security_group" "turn" {
  name_prefix = "${local.name}-"
  description = "Public TURN and TURNS traffic for ClassPilot Live View"
  vpc_id      = var.vpc_id

  ingress {
    description = "TURN UDP"
    from_port   = 3478
    to_port     = 3478
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "TURN TCP"
    from_port   = 3478
    to_port     = 3478
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "TURNS TCP"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "TURN relay UDP range"
    from_port   = var.relay_port_min
    to_port     = var.relay_port_max
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "TURN relay TCP range"
    from_port   = var.relay_port_min
    to_port     = var.relay_port_max
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_iam_role" "turn" {
  name = local.name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.turn.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "turn" {
  name = "${local.name}-runtime"
  role = aws_iam_role.turn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOnlyTurnSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_cloudformation_stack.rest_secret.outputs["SecretArn"]
      },
      {
        Sid      = "Route53CertificateValidation"
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/${var.route53_zone_id}"
      },
      {
        Sid      = "Route53CertificateValidationRead"
        Effect   = "Allow"
        Action   = ["route53:GetChange", "route53:ListHostedZones"]
        Resource = "*"
      },
      {
        Sid    = "TurnOperationalTelemetry"
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "turn" {
  name = local.name
  role = aws_iam_role.turn.name
}

resource "aws_eip" "turn" {
  for_each = local.nodes
  domain   = "vpc"
  tags     = { Name = "${local.name}-${each.key}" }
}

resource "aws_route53_record" "turn" {
  for_each = local.nodes
  zone_id  = var.route53_zone_id
  name     = "turn-${each.key}.${var.domain}"
  type     = "A"
  ttl      = 60
  records  = [aws_eip.turn[each.key].public_ip]
}

resource "aws_instance" "turn" {
  for_each                    = local.nodes
  ami                         = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type               = var.instance_type
  subnet_id                   = var.public_subnet_ids[each.value]
  vpc_security_group_ids      = [aws_security_group.turn.id]
  iam_instance_profile        = aws_iam_instance_profile.turn.name
  associate_public_ip_address = true
  monitoring                  = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted   = true
    volume_size = 16
    volume_type = "gp3"
  }

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    aws_region       = var.aws_region
    hostname         = "turn-${each.key}.${var.domain}"
    public_ip        = aws_eip.turn[each.key].public_ip
    realm            = var.domain
    relay_port_min   = var.relay_port_min
    relay_port_max   = var.relay_port_max
    rest_secret_arn  = aws_cloudformation_stack.rest_secret.outputs["SecretArn"]
    tls_email        = var.tls_email
    metric_namespace = "SchoolPilot/ClassPilotTURN"
    node_name        = each.key
    certificate_refresh_script_base64 = base64encode(replace(
      replace(file("${path.module}/refresh-certificate.sh"), "\r\n", "\n"),
      "\r",
      "\n",
    ))
    relay_metrics_script_base64 = base64encode(replace(
      replace(file("${path.module}/relay-metrics.py"), "\r\n", "\n"),
      "\r",
      "\n",
    ))
  })

  lifecycle {
    precondition {
      condition     = length(var.public_subnet_ids) >= 2
      error_message = "ClassPilot TURN requires public subnets in at least two availability zones."
    }
    precondition {
      condition     = length(local.turn_availability_zones) == 2
      error_message = "ClassPilot TURN nodes must resolve to two distinct availability zones."
    }
    precondition {
      condition     = var.relay_port_min >= 1024 && var.relay_port_max >= var.relay_port_min
      error_message = "The TURN relay range must be ordered and use non-privileged ports."
    }
  }

  depends_on = [aws_route53_record.turn]
  tags = {
    Name = "${local.name}-${each.key}"
    Role = "classpilot-turn"
  }
}

resource "aws_eip_association" "turn" {
  for_each      = local.nodes
  allocation_id = aws_eip.turn[each.key].id
  instance_id   = aws_instance.turn[each.key].id
}

resource "aws_cloudwatch_metric_alarm" "authentication_failures" {
  alarm_name          = "${local.name}-authentication-failures"
  alarm_description   = "TURN authentication failures exceeded the bounded five-minute operational threshold."
  namespace           = "SchoolPilot/ClassPilotTURN"
  metric_name         = "AuthenticationFailureCount"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 25
  evaluation_periods  = 1
  period              = 300
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "node_status" {
  for_each = local.nodes

  alarm_name          = "${local.name}-${each.key}-status-check"
  alarm_description   = "A ClassPilot TURN node failed an EC2 instance or system status check."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  period              = 60
  statistic           = "Maximum"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  dimensions = {
    InstanceId = aws_instance.turn[each.key].id
  }
}

resource "aws_cloudwatch_metric_alarm" "ice_success_rate" {
  alarm_name          = "${local.name}-ice-success-rate"
  alarm_description   = "Live View ICE success fell below 70 percent for at least ten reported attempts."
  comparison_operator = "LessThanThreshold"
  threshold           = 70
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "success"
    return_data = false
    metric {
      namespace   = "SchoolPilot/ClassPilotTURN"
      metric_name = "IceSuccessCount"
      period      = 300
      stat        = "Sum"
      dimensions = {
        Environment = var.environment
      }
    }
  }

  metric_query {
    id          = "failure"
    return_data = false
    metric {
      namespace   = "SchoolPilot/ClassPilotTURN"
      metric_name = "IceFailureCount"
      period      = 300
      stat        = "Sum"
      dimensions = {
        Environment = var.environment
      }
    }
  }

  metric_query {
    id          = "rate"
    expression  = "IF((FILL(success,0)+FILL(failure,0))>=10,100*FILL(success,0)/(FILL(success,0)+FILL(failure,0)),100)"
    label       = "ICE success percent"
    return_data = true
  }
}

resource "aws_cloudwatch_dashboard" "turn" {
  dashboard_name = "${local.name}-operations"
  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title   = "TURN allocations, relay bytes, and authentication failures"
          view    = "timeSeries"
          region  = var.aws_region
          period  = 300
          stacked = false
          metrics = [
            ["SchoolPilot/ClassPilotTURN", "AllocationCount", { stat = "Sum" }],
            [".", "RelayBytes", { stat = "Sum", yAxis = "right" }],
            [".", "AuthenticationFailureCount", { stat = "Sum" }]
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title   = "Live View ICE outcomes and relay fallback"
          view    = "timeSeries"
          region  = var.aws_region
          period  = 300
          stacked = false
          metrics = [
            ["SchoolPilot/ClassPilotTURN", "IceSuccessCount", "Environment", var.environment, { stat = "Sum" }],
            [".", "IceFailureCount", ".", ".", { stat = "Sum" }],
            [".", "RelayFallbackCount", ".", ".", { stat = "Sum" }]
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Live View ICE connection time"
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          metrics = [
            ["SchoolPilot/ClassPilotTURN", "IceConnectionTimeMs", "Environment", var.environment, { stat = "p95" }]
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "TURN node network throughput"
          view   = "timeSeries"
          region = var.aws_region
          period = 300
          metrics = [
            for pair in setproduct(sort(keys(local.nodes)), ["net_bytes_sent", "net_bytes_recv"]) :
            ["SchoolPilot/ClassPilotTURN", pair[1], "Node", pair[0], { stat = "Sum" }]
          ]
        }
      }
    ]
  })
}
