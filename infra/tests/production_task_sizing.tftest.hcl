mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:user/test", user_id = "test" }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-1" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/test", id = "test" }
  }
  mock_resource "aws_ssm_parameter" {
    defaults = { arn = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/production/REDIS_URL", name = "/schoolpilot/production/REDIS_URL" }
  }
}

variables {
  project               = "schoolpilot"
  environment           = "production"
  aws_region            = "us-east-1"
  aws_account_id        = "000000000000"
  vpc_id                = "vpc-00000000000000000"
  task_subnet_ids       = ["subnet-00000000000000000"]
  alb_target_group_arn  = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000"
  ecr_repository_url    = "000000000000.dkr.ecr.us-east-1.amazonaws.com/test"
  container_port        = 4000
  ecs_security_group_id = "sg-00000000000000000"
  desired_count         = 1
  cpu                   = 1024
  memory                = 2048
  worker_desired_count  = 1
  worker_cpu            = 512
  worker_memory         = 1024
  db_pool_max           = 16
  scheduler_db_pool_max = 5
  rls_enabled_tables    = "students"
  redis_url             = "rediss://test.invalid:6379"
}

run "production_accepts_the_reviewed_task_sizes" {
  command = plan
  module {
    source = "./modules/ecs"
  }
  assert {
    condition = (
      aws_ecs_task_definition.api.cpu == "1024" &&
      aws_ecs_task_definition.api.memory == "2048" &&
      aws_ecs_task_definition.worker.cpu == "512" &&
      aws_ecs_task_definition.worker.memory == "1024"
    )
    error_message = "The production template must render the reviewed API 1024/2048 and worker 512/1024 task sizes."
  }
}

run "production_rejects_an_api_below_the_reviewed_size" {
  command = plan
  module {
    source = "./modules/ecs"
  }
  variables {
    cpu = 512
  }
  expect_failures = [aws_ecs_task_definition.api]
}

run "production_rejects_a_worker_below_the_reviewed_size" {
  command = plan
  module {
    source = "./modules/ecs"
  }
  variables {
    worker_cpu    = 256
    worker_memory = 512
  }
  expect_failures = [aws_ecs_task_definition.worker]
}

run "non_production_environments_keep_their_own_sizes" {
  command = plan
  module {
    source = "./modules/ecs"
  }
  variables {
    environment   = "staging"
    cpu           = 256
    memory        = 512
    worker_cpu    = 256
    worker_memory = 512
  }
  assert {
    condition     = aws_ecs_task_definition.api.cpu == "256" && aws_ecs_task_definition.worker.memory == "512"
    error_message = "The reviewed production floor must not apply to other environments."
  }
}
