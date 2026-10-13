# Optional remote load-generator custody. No application secrets or database
# access: its task role can only download this campaign's inputs and upload
# results. Existing API/worker resources are unchanged by this file.
variable "enable_staging_load_generator" {
  type        = bool
  default     = false
  description = "Create isolated campaign artifact storage/task IAM only for synthetic staging"
  validation {
    condition     = !var.enable_staging_load_generator || (var.environment == "staging" && can(regex("^classpilot-staging-[a-z0-9][a-z0-9-]{1,100}$", var.staging_load_run_id)))
    error_message = "Load generator resources require staging and an explicit bounded classpilot-staging campaign ID."
  }
}

variable "staging_load_run_id" {
  type        = string
  default     = ""
  description = "One approved synthetic campaign; each profile uses a fresh subrun directory"
}

locals {
  staging_load_bucket_name = "schoolpilot-staging-load-${data.aws_caller_identity.current.account_id}"
  staging_load_prefix      = "runs/${var.staging_load_run_id}"
}

resource "aws_s3_bucket" "staging_load" {
  count         = var.enable_staging_load_generator ? 1 : 0
  bucket        = local.staging_load_bucket_name
  force_destroy = true
  tags          = { Name = local.staging_load_bucket_name, Campaign = var.staging_load_run_id }
  lifecycle {
    precondition {
      condition     = var.environment == "staging" && data.aws_caller_identity.current.account_id == "135775632425"
      error_message = "Synthetic load artifact custody is restricted to the reviewed staging account."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "staging_load" {
  count                   = var.enable_staging_load_generator ? 1 : 0
  bucket                  = aws_s3_bucket.staging_load[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "staging_load" {
  count  = var.enable_staging_load_generator ? 1 : 0
  bucket = aws_s3_bucket.staging_load[0].id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "staging_load" {
  count  = var.enable_staging_load_generator ? 1 : 0
  bucket = aws_s3_bucket.staging_load[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "staging_load" {
  count  = var.enable_staging_load_generator ? 1 : 0
  bucket = aws_s3_bucket.staging_load[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "staging_load" {
  count      = var.enable_staging_load_generator ? 1 : 0
  bucket     = aws_s3_bucket.staging_load[0].id
  depends_on = [aws_s3_bucket_versioning.staging_load]
  rule {
    id     = "expire-private-campaign-artifacts"
    status = "Enabled"
    filter { prefix = "runs/" }
    expiration { days = 1 }
    noncurrent_version_expiration { noncurrent_days = 1 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
  rule {
    id     = "remove-expired-campaign-markers"
    status = "Enabled"
    filter { prefix = "runs/" }
    expiration { expired_object_delete_marker = true }
  }
}

resource "aws_s3_bucket_policy" "staging_load" {
  count  = var.enable_staging_load_generator ? 1 : 0
  bucket = aws_s3_bucket.staging_load[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "RequireTLS"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.staging_load[0].arn, "${aws_s3_bucket.staging_load[0].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_iam_role" "staging_load_generator" {
  count = var.enable_staging_load_generator ? 1 : 0
  name  = "${local.name}-load-generator"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "staging_load_generator" {
  count = var.enable_staging_load_generator ? 1 : 0
  name  = "campaign-artifacts-only"
  role  = aws_iam_role.staging_load_generator[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadExactCampaignInputs"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.staging_load[0].arn}/${local.staging_load_prefix}/*/inputs/*"
      },
      {
        Sid      = "WriteExactCampaignResults"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.staging_load[0].arn}/${local.staging_load_prefix}/*/results/*"
      },
    ]
  })
}

output "staging_load_bucket" {
  value = try(aws_s3_bucket.staging_load[0].bucket, null)
}

output "staging_load_generator_task_role_arn" {
  value = try(aws_iam_role.staging_load_generator[0].arn, null)
}
