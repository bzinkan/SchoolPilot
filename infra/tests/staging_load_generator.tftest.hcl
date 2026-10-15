mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "135775632425" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"] }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::schoolpilot-staging-load-135775632425" }
  }
}
mock_provider "aws" {
  alias           = "us_east_1"
  override_during = plan
}

variables {
  environment                   = "staging"
  staging_bootstrap             = true
  ecs_desired_count             = 0
  worker_desired_count          = 0
  cookie_name                   = "schoolpilot.staging.sid"
  enable_staging_load_generator = true
  staging_load_run_id           = "classpilot-staging-20261013-0d1060d261d5"
}

run "generator_has_private_ephemeral_artifacts_and_no_application_secret_access" {
  command = plan
  assert {
    condition = (aws_s3_bucket.staging_load[0].bucket == "schoolpilot-staging-load-135775632425" &&
      aws_s3_bucket_public_access_block.staging_load[0].block_public_acls &&
      aws_s3_bucket_public_access_block.staging_load[0].block_public_policy &&
      aws_s3_bucket_public_access_block.staging_load[0].ignore_public_acls &&
    aws_s3_bucket_public_access_block.staging_load[0].restrict_public_buckets)
    error_message = "Remote load artifacts must stay in the reviewed private staging bucket."
  }
  assert {
    condition = (length(jsondecode(aws_iam_role_policy.staging_load_generator[0].policy).Statement) == 2 &&
      jsondecode(aws_iam_role_policy.staging_load_generator[0].policy).Statement[0].Action == ["s3:GetObject"] &&
      jsondecode(aws_iam_role_policy.staging_load_generator[0].policy).Statement[0].Resource == "arn:aws:s3:::schoolpilot-staging-load-135775632425/runs/classpilot-staging-20261013-0d1060d261d5/*/inputs/*" &&
      jsondecode(aws_iam_role_policy.staging_load_generator[0].policy).Statement[1].Action == ["s3:PutObject"] &&
    jsondecode(aws_iam_role_policy.staging_load_generator[0].policy).Statement[1].Resource == "arn:aws:s3:::schoolpilot-staging-load-135775632425/runs/classpilot-staging-20261013-0d1060d261d5/*/results/*")
    error_message = "Generator task IAM must be only campaign inputs GET and results PUT, without SSM, application credentials or other campaign access."
  }
  assert {
    condition = (aws_s3_bucket_versioning.staging_load[0].versioning_configuration[0].status == "Enabled" &&
      one(aws_s3_bucket_server_side_encryption_configuration.staging_load[0].rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256" &&
      one([for rule in aws_s3_bucket_lifecycle_configuration.staging_load[0].rule : rule.expiration[0].days if rule.id == "expire-private-campaign-artifacts"]) == 1 &&
    jsondecode(aws_s3_bucket_policy.staging_load[0].policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false")
    error_message = "Artifact custody must retain encryption, TLS enforcement and one-day expiry."
  }
}

run "production_cannot_enable_synthetic_generator_resources" {
  command = plan
  variables {
    environment          = "production"
    staging_bootstrap    = false
    worker_desired_count = 1
    ecs_cpu              = 1024
    ecs_memory           = 2048
    worker_cpu           = 512
    worker_memory        = 1024
  }
  expect_failures = [var.enable_staging_load_generator]
}

run "default_has_no_remote_generator_resources" {
  command = plan
  variables { enable_staging_load_generator = false }
  assert {
    condition     = length(aws_s3_bucket.staging_load) == 0 && length(aws_iam_role.staging_load_generator) == 0
    error_message = "The optional load tooling must not appear in ordinary staging or production plans."
  }
}
