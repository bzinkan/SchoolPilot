mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:user/test", user_id = "test" }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-1" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"] }
  }
  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-00000000000000000", name = "com.amazonaws.global.cloudfront.origin-facing" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/test", id = "test" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::schoolpilot-test-mydesk-attachments", id = "schoolpilot-test-mydesk-attachments" }
  }
  mock_resource "aws_ssm_parameter" {
    defaults = { arn = "arn:aws:ssm:us-east-1:000000000000:parameter/schoolpilot/test/REDIS_URL", name = "/schoolpilot/test/REDIS_URL" }
  }
}
mock_provider "aws" {
  alias           = "us_east_1"
  override_during = plan
}

run "observed_mydesk_rls_baseline_is_registry_valid" {
  command = plan
  variables {
    environment        = "test"
    rls_enabled_tables = join(",", jsondecode(file("../src/config/rlsRegistry.json")).inventories.mydeskImportsPostExpand.tables)
  }
  assert {
    condition = (
      length(local.rls_configured_tables) == 109 &&
      toset(local.rls_configured_tables) == toset(local.rls_registry.inventories.mydeskImportsPostExpand.tables) &&
      length(setsubtract(toset(local.rls_configured_tables), toset(local.rls_post_expand_tables))) == 0
    )
    error_message = "The admitted 109-table My Desk baseline must be accepted without changing historical inventories or the generic default."
  }
}

run "historical_workspace_rls_inventory_is_registry_valid" {
  command = plan
  variables {
    environment        = "test"
    rls_enabled_tables = join(",", jsondecode(file("../src/config/rlsRegistry.json")).inventories.schoolDisciplinePostExpand.tables)
  }
  assert {
    condition = (
      length(local.rls_configured_tables) == 114 &&
      toset(local.rls_configured_tables) == toset(local.rls_registry.inventories.schoolDisciplinePostExpand.tables) &&
      length(setsubtract(toset(local.rls_configured_tables), toset(local.rls_post_expand_tables))) == 0
    )
    error_message = "The historical 114-table workspace inventory must remain accepted without rewriting its registry snapshot."
  }
}

run "student_information_rls_target_is_registry_valid" {
  command = plan
  variables {
    environment        = "test"
    rls_enabled_tables = join(",", jsondecode(file("../src/config/rlsRegistry.json")).inventories.studentInformationPostExpand.tables)
  }
  assert {
    condition = (
      length(local.rls_configured_tables) == 119 &&
      length(setsubtract(toset(local.rls_configured_tables), toset(local.rls_post_expand_tables))) == 0
    )
    error_message = "The registered 119-table target must be accepted without claiming live production admission."
  }
}
run "teacher_preferences_rls_target_is_registry_valid" {
  command = plan
  variables {
    environment        = "test"
    rls_enabled_tables = join(",", jsondecode(file("../src/config/rlsRegistry.json")).inventories.classpilotTeacherPreferencesPostExpand.tables)
  }
  assert {
    condition = (
      length(local.rls_configured_tables) == 120 &&
      length(setsubtract(toset(local.rls_configured_tables), toset(local.rls_post_expand_tables))) == 0
    )
    error_message = "The registered preference-table target must be accepted without pre-admitting it in production."
  }
}

run "paperwork_processing_rls_target_is_registry_valid" {
  command = plan
  variables {
    environment                    = "test"
    rls_enabled_tables             = join(",", jsondecode(file("../src/config/rlsRegistry.json")).inventories.importProcessingStagesPostExpand.tables)
    mydesk_import_pipeline_version = 2
    mydesk_import_pipeline_width   = 1
  }
  assert {
    condition = (
      length(local.rls_configured_tables) == 121 &&
      toset(local.rls_configured_tables) == toset(local.rls_post_expand_tables)
    )
    error_message = "The reviewed processing-stage target must be accepted without pre-admitting it in production."
  }
}

run "unregistered_rls_table_is_rejected" {
  command = plan
  variables {
    environment        = "test"
    rls_enabled_tables = join(",", concat(jsondecode(file("../src/config/rlsRegistry.json")).inventories.studentInformationPostExpand.tables, ["unreviewed_fixture_table"]))
  }
  expect_failures = [check.rls_registry_contract]
}

run "notebook_bucket_is_private_encrypted_and_tls_only" {
  command = plan
  variables {
    environment = "test"
  }
  assert {
    condition = (
      aws_s3_bucket.mydesk_attachments.bucket == "schoolpilot-test-mydesk-attachments" &&
      !aws_s3_bucket.mydesk_attachments.force_destroy &&
      aws_s3_bucket_public_access_block.mydesk_attachments.block_public_acls &&
      aws_s3_bucket_public_access_block.mydesk_attachments.block_public_policy &&
      aws_s3_bucket_public_access_block.mydesk_attachments.ignore_public_acls &&
      aws_s3_bucket_public_access_block.mydesk_attachments.restrict_public_buckets &&
      one(aws_s3_bucket_ownership_controls.mydesk_attachments.rule).object_ownership == "BucketOwnerEnforced" &&
      one(one(aws_s3_bucket_server_side_encryption_configuration.mydesk_attachments.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    )
    error_message = "My Desk content must remain private, ACL-free, encrypted, and protected from force destruction."
  }
  assert {
    condition = (
      jsondecode(aws_s3_bucket_policy.mydesk_attachments.policy).Statement[0].Effect == "Deny" &&
      jsondecode(aws_s3_bucket_policy.mydesk_attachments.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false" &&
      length(one(aws_s3_bucket_lifecycle_configuration.mydesk_attachments.rule).expiration) == 0
    )
    error_message = "Require TLS and leave live-note retention to the explicit application lifecycle."
  }
}

run "disabled_features_retains_bucket_and_narrow_worker_cleanup_permissions" {
  command = plan
  module {
    source = "./modules/ecs"
  }
  variables {
    project                        = "schoolpilot"
    environment                    = "test"
    aws_region                     = "us-east-1"
    aws_account_id                 = "000000000000"
    vpc_id                         = "vpc-00000000000000000"
    task_subnet_ids                = ["subnet-00000000000000000"]
    alb_target_group_arn           = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000"
    ecr_repository_url             = "000000000000.dkr.ecr.us-east-1.amazonaws.com/test"
    container_port                 = 4000
    ecs_security_group_id          = "sg-00000000000000000"
    desired_count                  = 1
    cpu                            = 256
    memory                         = 512
    worker_desired_count           = 1
    worker_cpu                     = 256
    worker_memory                  = 512
    db_pool_max                    = 16
    scheduler_db_pool_max          = 5
    rls_enabled_tables             = "students"
    redis_url                      = "rediss://test.invalid:6379"
    mydesk_storage_enabled         = true
    mydesk_attachments_bucket_name = "schoolpilot-test-mydesk-attachments"
    mydesk_attachments_bucket_arn  = "arn:aws:s3:::schoolpilot-test-mydesk-attachments"
    mydesk_mode                    = "off"
  }
  assert {
    condition = alltrue([
      for definition in [aws_ecs_task_definition.api, aws_ecs_task_definition.worker] :
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_ATTACHMENTS_BUCKET"]) == "schoolpilot-test-mydesk-attachments" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_MODE"]) == "off" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_SEATING_MODE"]) == "off" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_AI_IMPORT_MODE"]) == "off" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "STUDENT_INFORMATION_AI_IMPORT_MODE"]) == "off" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_AI_IMPORT_MODEL"]) == "claude-opus-5-5" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_IMPORT_PIPELINE_VERSION"]) == "1" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_IMPORT_PIPELINE_WIDTH"]) == "2" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES"]) == "100" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES"]) == "500"
    ])
    error_message = "Disabling My Desk must retain object storage configuration in both API and cleanup worker."
  }
  assert {
    condition = (
      jsondecode(aws_iam_role_policy.mydesk_attachments[0].policy).Statement[0].Resource == "arn:aws:s3:::schoolpilot-test-mydesk-attachments/mydesk/*" &&
      toset(jsondecode(aws_iam_role_policy.mydesk_attachments[0].policy).Statement[0].Action) == toset(["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]) &&
      jsondecode(aws_iam_role_policy.mydesk_attachments[0].policy).Statement[1].Resource == "arn:aws:s3:::schoolpilot-test-mydesk-attachments" &&
      toset(jsondecode(aws_iam_role_policy.mydesk_attachments[0].policy).Statement[1].Condition.StringLike["s3:prefix"]) == toset(["mydesk/", "mydesk/*"])
    )
    error_message = "The shared task role must only read/write/delete notebook objects and list the notebook prefix."
  }
}

run "global_features_reach_both_services_without_school_lists" {
  command = plan
  module {
    source = "./modules/ecs"
  }
  variables {
    project                            = "schoolpilot"
    environment                        = "test"
    aws_region                         = "us-east-1"
    aws_account_id                     = "000000000000"
    vpc_id                             = "vpc-00000000000000000"
    task_subnet_ids                    = ["subnet-00000000000000000"]
    alb_target_group_arn               = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000"
    ecr_repository_url                 = "000000000000.dkr.ecr.us-east-1.amazonaws.com/test"
    container_port                     = 4000
    ecs_security_group_id              = "sg-00000000000000000"
    desired_count                      = 1
    cpu                                = 256
    memory                             = 512
    worker_desired_count               = 1
    worker_cpu                         = 256
    worker_memory                      = 512
    db_pool_max                        = 16
    scheduler_db_pool_max              = 5
    rls_enabled_tables                 = "students,import_processing_stages"
    redis_url                          = "rediss://test.invalid:6379"
    mydesk_storage_enabled             = true
    mydesk_attachments_bucket_name     = "schoolpilot-test-mydesk-attachments"
    mydesk_attachments_bucket_arn      = "arn:aws:s3:::schoolpilot-test-mydesk-attachments"
    mydesk_mode                        = "on"
    mydesk_seating_mode                = "on"
    mydesk_ai_import_mode              = "on"
    student_information_ai_import_mode = "on"
    mydesk_import_pipeline_version     = 2
    mydesk_import_pipeline_width       = 1
  }
  assert {
    condition = alltrue([
      for definition in [aws_ecs_task_definition.api, aws_ecs_task_definition.worker] :
      alltrue([for name in ["MYDESK_MODE", "MYDESK_SEATING_MODE", "MYDESK_AI_IMPORT_MODE", "STUDENT_INFORMATION_AI_IMPORT_MODE"] :
        one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == name]) == "on"
      ]) &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_IMPORT_PIPELINE_VERSION"]) == "2" &&
      one([for entry in jsondecode(definition.container_definitions)[0].environment : entry.value if entry.name == "MYDESK_IMPORT_PIPELINE_WIDTH"]) == "1" &&
      length([for entry in jsondecode(definition.container_definitions)[0].environment : entry.name if can(regex("^MYDESK_.*ENABLED_SCHOOL_IDS$", entry.name))]) == 0
    ])
    error_message = "All eligible schools must receive the same feature modes in API and worker with no school allowlists."
  }
}
run "paperwork_pipeline_requires_stage_admission" {
  command = plan
  variables {
    environment                    = "test"
    mydesk_import_pipeline_version = 2
  }
  expect_failures = [var.mydesk_import_pipeline_version]
}
run "paperwork_pipeline_rejects_unknown_version" {
  command = plan
  variables {
    environment                    = "test"
    mydesk_import_pipeline_version = 3
  }
  expect_failures = [var.mydesk_import_pipeline_version]
}
run "paperwork_pipeline_rejects_fractional_width" {
  command = plan
  variables {
    environment                  = "test"
    mydesk_import_pipeline_width = 1.5
  }
  expect_failures = [var.mydesk_import_pipeline_width]
}
run "seating_cannot_enable_without_notebook" {
  command = plan
  variables {
    environment         = "test"
    mydesk_mode         = "off"
    mydesk_seating_mode = "on"
  }
  expect_failures = [var.mydesk_seating_mode]
}
run "imports_reject_invalid_mode" {
  command = plan
  variables {
    environment           = "test"
    mydesk_mode           = "on"
    mydesk_ai_import_mode = "true"
  }
  expect_failures = [var.mydesk_ai_import_mode]
}
run "contact_imports_require_base_mode" {
  command = plan
  variables {
    environment                        = "test"
    mydesk_mode                        = "off"
    student_information_ai_import_mode = "on"
  }
  expect_failures = [var.student_information_ai_import_mode]
}
run "contact_imports_do_not_require_discipline_imports" {
  command = plan
  variables {
    environment                        = "test"
    mydesk_mode                        = "on"
    mydesk_ai_import_mode              = "off"
    student_information_ai_import_mode = "on"
  }
}
