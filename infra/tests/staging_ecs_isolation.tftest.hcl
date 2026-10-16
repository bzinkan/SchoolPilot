mock_provider "aws" {
  override_during = plan
  mock_resource "aws_ssm_parameter" {
    defaults = {
      arn = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/staging/REDIS_URL"
    }
  }
}

variables {
  project                                = "schoolpilot"
  environment                            = "staging"
  aws_region                             = "us-east-1"
  aws_account_id                         = "000000000000"
  vpc_id                                 = "vpc-00000000"
  task_subnet_ids                        = ["subnet-00000001", "subnet-00000002"]
  alb_target_group_arn                   = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000"
  ecr_repository_url                     = "000000000000.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api"
  container_port                         = 4000
  ecs_security_group_id                  = "sg-00000000"
  desired_count                          = 0
  cpu                                    = 1024
  memory                                 = 2048
  worker_desired_count                   = 0
  worker_cpu                             = 512
  worker_memory                          = 1024
  db_pool_max                            = 20
  scheduler_db_pool_max                  = 5
  rls_enabled_tables                     = "students"
  redis_url                              = "rediss://cache.invalid:6379"
  public_base_url                        = "https://staging.school-pilot.net"
  cors_allowlist                         = "https://staging.school-pilot.net"
  cookie_domain                          = ""
  cookie_name                            = "schoolpilot.staging.sid"
  provider_secrets_enabled               = false
  staging_classpilot_reliability_enabled = true
  api_autoscaling_suspended              = true
}

run "stopped_bootstrap_has_isolated_auth_and_no_provider_credentials" {
  command = plan
  module { source = "./modules/ecs" }
  assert {
    condition = toset([for secret in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : secret.name]) == toset([
      "DATABASE_URL", "REDIS_URL", "SESSION_SECRET", "JWT_SECRET", "STUDENT_TOKEN_SECRET", "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY"
    ])
    error_message = "Staging must inject only fresh internal credentials and topology, never provider credentials."
  }
  assert {
    condition     = alltrue([for secret in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : contains(split("/", secret.valueFrom), "staging")])
    error_message = "Every injected staging secret must have staging scope."
  }
  assert {
    condition = alltrue([
      for container in [jsondecode(aws_ecs_task_definition.api.container_definitions)[0], jsondecode(aws_ecs_task_definition.worker.container_definitions)[0]] :
      { for item in container.environment : item.name => item.value }["COOKIE_NAME"] == "schoolpilot.staging.sid" &&
      { for item in container.environment : item.name => item.value }["COOKIE_DOMAIN"] == "" &&
      { for item in container.environment : item.name => item.value }["CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1"] == "true" &&
      { for item in container.environment : item.name => item.value }["NODE_EXTRA_CA_CERTS"] == "/app/rds-ca.pem"
    ])
    error_message = "Both staging roles must share isolated cookies and reviewed active-capture capabilities."
  }
  assert {
    condition = (aws_ecs_service.api.desired_count == 0 && aws_ecs_service.worker.desired_count == 0 &&
      aws_appautoscaling_target.api.suspended_state[0].dynamic_scaling_in_suspended &&
      aws_appautoscaling_target.api.suspended_state[0].dynamic_scaling_out_suspended &&
    aws_appautoscaling_target.api.suspended_state[0].scheduled_scaling_suspended)
    error_message = "Bootstrap must stay stopped, and capacity tests must not silently autoscale."
  }
}

run "capacity_templates_pin_the_same_reviewed_digest" {
  command = plan
  module { source = "./modules/ecs" }
  variables {
    desired_count        = 3
    worker_desired_count = 1
    api_image_digest     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition = alltrue([
      for container in [jsondecode(aws_ecs_task_definition.api.container_definitions)[0], jsondecode(aws_ecs_task_definition.worker.container_definitions)[0]] :
      container.image == "000000000000.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ])
    error_message = "Serving API and worker must use the identical immutable candidate."
  }
}

run "serving_staging_rejects_a_mutable_bootstrap_image" {
  command = plan
  module { source = "./modules/ecs" }
  variables {
    desired_count        = 3
    worker_desired_count = 1
  }
  expect_failures = [aws_ecs_task_definition.api]
}
