mock_provider "aws" {
  override_during = plan

  mock_resource "aws_ssm_parameter" {
    defaults = {
      arn  = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/REDIS_URL"
      name = "/schoolpilot/test/REDIS_URL"
    }
  }
}

run "runtime_secret_arns_are_stable_without_values" {
  command = plan

  module {
    source = "./modules/ecs"
  }

  variables {
    project               = "schoolpilot"
    environment           = "test"
    aws_region            = "us-east-1"
    aws_account_id        = "000000000000"
    vpc_id                = "vpc-00000000"
    task_subnet_ids       = ["subnet-00000001", "subnet-00000002"]
    alb_target_group_arn  = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000"
    ecr_repository_url    = "000000000000.dkr.ecr.us-east-1.amazonaws.com/test"
    container_port        = 4000
    ecs_security_group_id = "sg-00000000"
    desired_count         = 1
    cpu                   = 512
    memory                = 1024
    worker_desired_count  = 1
    worker_cpu            = 256
    worker_memory         = 512
    db_pool_max           = 18
    scheduler_db_pool_max = 3
    rls_enabled_tables    = "students"
    redis_url             = "rediss://cache.invalid:6379"
    public_base_url       = "https://schoolpilot.invalid"
    cors_allowlist        = "https://schoolpilot.invalid"
    cookie_domain         = ".schoolpilot.invalid"
    google_client_id      = "test-client-id"
  }

  assert {
    condition = alltrue([
      for secret in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets :
      secret.valueFrom == {
        DATABASE_URL                      = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/DATABASE_URL"
        REDIS_URL                         = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/REDIS_URL"
        SESSION_SECRET                    = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/SESSION_SECRET"
        JWT_SECRET                        = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/JWT_SECRET"
        STUDENT_TOKEN_SECRET              = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/STUDENT_TOKEN_SECRET"
        GOOGLE_CLIENT_SECRET              = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/GOOGLE_CLIENT_SECRET"
        GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/GOOGLE_OAUTH_ENCRYPTION_KEY"
        SENDGRID_API_KEY                  = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/SENDGRID_API_KEY"
        STRIPE_SECRET_KEY                 = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/STRIPE_SECRET_KEY"
        STRIPE_WEBHOOK_SECRET             = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/STRIPE_WEBHOOK_SECRET"
      }[secret.name]
    ])
    error_message = "API runtime secret ARNs must remain identical after state detachment."
  }

  assert {
    condition = !contains(
      [for secret in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : secret.name],
      "OPENAI_API_KEY"
    )
    error_message = "The unused OpenAI key must not be injected into runtime task definitions."
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets ==
      jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets
    )
    error_message = "API and worker must use the same detached runtime secret ARN set."
  }

  assert {
    condition = !contains(
      [for secret in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : secret.name],
      "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS"
    )
    error_message = "Previous PIN key injection must default off."
  }
}

run "previous_pin_key_is_arn_only_and_temporary" {
  command = plan

  module {
    source = "./modules/ecs"
  }

  variables {
    project                                            = "schoolpilot"
    environment                                        = "test"
    aws_region                                         = "us-east-1"
    aws_account_id                                     = "000000000000"
    vpc_id                                             = "vpc-00000000"
    task_subnet_ids                                    = ["subnet-00000001", "subnet-00000002"]
    alb_target_group_arn                               = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000"
    ecr_repository_url                                 = "000000000000.dkr.ecr.us-east-1.amazonaws.com/test"
    container_port                                     = 4000
    ecs_security_group_id                              = "sg-00000000"
    desired_count                                      = 1
    cpu                                                = 512
    memory                                             = 1024
    worker_desired_count                               = 1
    worker_cpu                                         = 256
    worker_memory                                      = 512
    db_pool_max                                        = 18
    scheduler_db_pool_max                              = 3
    rls_enabled_tables                                 = "students"
    redis_url                                          = "rediss://cache.invalid:6379"
    google_oauth_previous_encryption_key_parameter_arn = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS"
  }

  assert {
    condition = one([
      for secret in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : secret.valueFrom
      if secret.name == "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS"
    ]) == "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS"
    error_message = "Previous PIN key must be injected only by its external SecureString ARN."
  }
}

run "previous_pin_key_rejects_wrong_environment_arn" {
  command = plan

  module {
    source = "./modules/ecs"
  }

  variables {
    project                                            = "schoolpilot"
    environment                                        = "test"
    aws_region                                         = "us-east-1"
    aws_account_id                                     = "000000000000"
    vpc_id                                             = "vpc-00000000"
    task_subnet_ids                                    = ["subnet-00000001", "subnet-00000002"]
    alb_target_group_arn                               = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000"
    ecr_repository_url                                 = "000000000000.dkr.ecr.us-east-1.amazonaws.com/test"
    container_port                                     = 4000
    ecs_security_group_id                              = "sg-00000000"
    desired_count                                      = 1
    cpu                                                = 512
    memory                                             = 1024
    worker_desired_count                               = 1
    worker_cpu                                         = 256
    worker_memory                                      = 512
    db_pool_max                                        = 18
    scheduler_db_pool_max                              = 3
    rls_enabled_tables                                 = "students"
    redis_url                                          = "rediss://cache.invalid:6379"
    google_oauth_previous_encryption_key_parameter_arn = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/production/GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS"
  }

  expect_failures = [
    aws_ecs_task_definition.api,
    aws_ecs_task_definition.worker,
  ]
}
